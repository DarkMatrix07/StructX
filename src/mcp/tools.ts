import { z } from 'zod/v3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  directLookup, directLookupExpanded, relationshipQuery, semanticSearch, patternQuery,
  impactAnalysis, routeQuery, routeKeywordQuery, typeQuery, fileQuery, listQuery,
  domainQuery,
} from '../query/retriever';
import {
  getStats, getFullOverview,
  getCachedAskResponse, insertCachedAskResponse, insertQaRun,
  getFunctionsByName, getCostStats, getDeadFunctions, getFilePathsByIds,
  getSubtypesOf, getSupertypesOf,
  findCallPaths, findRoutePathsTo, semanticQuery, semanticFacets,
} from '../db/queries';
import { classifyQuestionWithUsage } from '../query/classifier';
import { buildContext } from '../query/context-builder';
import { generateAnswer, generateAnswerStreaming } from '../query/answerer';
import { diffEntities } from '../git/diff';
import { getGraphFingerprint, makeAskCacheKey } from '../query/ask-cache';
import { loadConfig, getStructXDir, getLlmConfig } from '../config';
import { getDb, resolveRepoPath, StructxNotInitializedError, isReadonly } from './db-pool';
import { formatContext, formatFunction, formatType, formatRoute, formatFile } from './format';

// All tool args may include a repo_path that overrides the server's default.
const RepoPath = z.string().optional().describe('Absolute path to the repo. Defaults to the server\'s --repo arg or cwd.');
const Detail = z.enum(['summary', 'full']).optional().describe('summary returns compact structuredContent (default); full returns all retrieved fields.');
const Limit = z.number().int().min(1).max(100).optional().describe('Maximum rows per entity kind in this response.');
const ResponseMode = z.enum(['both', 'text', 'structured']).optional().describe('both returns markdown and structuredContent (default); text keeps markdown and returns only count metadata; structured keeps structuredContent and returns a short text stub.');
const AskMaxTokens = z.number().int().min(64).max(8192).optional().describe('Maximum answer output tokens for this call. Defaults to .structx/config.json answerMaxTokens.');
const SearchArgs = z.object({
  keywords: z.array(z.string()).min(1).describe('Search terms (e.g. ["auth", "login"]). FTS-sanitized internally.'),
  mode: z.enum(['narrow', 'broad']).optional().describe('narrow = fewer high-precision results (default); broad = wider net for cross-cutting concerns.'),
  scope: z.array(z.enum(['functions', 'types', 'routes', 'files', 'constants'])).optional()
    .describe('Restrict results to one or more entity kinds. Omit to search all kinds. Useful when the agent only wants e.g. functions and saving context tokens on the rest.'),
  limit: Limit,
  detail: Detail,
  response_mode: ResponseMode,
  repo_path: RepoPath,
}).strict();
const FunctionArgs = z.object({
  name: z.string().describe('Exact function name.'),
  include_body: z.boolean().optional().describe('Include the full function body in text and structuredContent. Defaults to false.'),
  detail: Detail,
  response_mode: ResponseMode,
  repo_path: RepoPath,
}).strict();
const RelationshipArgs = z.object({
  name: z.string().describe('Exact function name.'),
  direction: z.enum(['callers', 'callees']).describe('callers = who invokes this function; callees = what this function invokes.'),
  limit: Limit,
  detail: Detail,
  response_mode: ResponseMode,
  repo_path: RepoPath,
}).strict();
const ImpactArgs = z.object({
  name: z.string().describe('Exact function name.'),
  limit: Limit,
  detail: Detail,
  response_mode: ResponseMode,
  repo_path: RepoPath,
}).strict();
const RouteArgs = z.object({
  path: z.string().optional().describe('Path or substring (e.g. "/users", "/api"). Matches anywhere in the route path.'),
  method: z.string().optional().describe('HTTP method filter (GET, POST, etc.). Case-insensitive.'),
  path_match: z.enum(['contains', 'exact']).optional().describe('Path matching behavior when path is provided. Defaults to contains.'),
  limit: Limit,
  detail: Detail,
  response_mode: ResponseMode,
  repo_path: RepoPath,
}).strict();
const TypeArgs = z.object({
  name: z.string().describe('Type/interface/enum name.'),
  detail: Detail,
  response_mode: ResponseMode,
  repo_path: RepoPath,
}).strict();
const FileArgs = z.object({
  path: z.string().optional().describe('File path relative to repo (e.g. "src/auth.ts"). Empty = all files summary.'),
  limit: Limit,
  detail: Detail,
  response_mode: ResponseMode,
  repo_path: RepoPath,
}).strict();
const ListArgs = z.object({
  entity: z.enum(['routes', 'types', 'files', 'functions', 'constants']).optional().describe('Kind to enumerate. Omit for a mixed cross-section.'),
  limit: Limit,
  detail: Detail,
  response_mode: ResponseMode,
  repo_path: RepoPath,
}).strict();
const OverviewArgs = z.object({
  max_items: z.number().int().min(1).max(100).optional().describe('Maximum rows per overview section. Defaults to 10.'),
  detail: Detail,
  response_mode: ResponseMode,
  repo_path: RepoPath,
}).strict();
const AskArgs = z.object({
  question: z.string().describe('Natural language question (e.g. "How is authentication handled?").'),
  max_tokens: AskMaxTokens,
  repo_path: RepoPath,
}).strict();
const CostsArgs = z.object({
  recent_limit: z.number().int().min(1).max(100).optional().describe('Number of most-recent runs to include in the response. Defaults to 10.'),
  response_mode: ResponseMode,
  repo_path: RepoPath,
}).strict();
const DeadCodeArgs = z.object({
  limit: z.number().int().min(1).max(200).optional().describe('Maximum dead functions to return. Defaults to 50.'),
  exclude_pattern: z.string().optional().describe('JS regex pattern to exclude from results (e.g. "^register.*Routes" to drop framework setup functions).'),
  exported_only: z.boolean().optional().describe('When true, only include exported functions (the most useful candidates for removal in a library).'),
  response_mode: ResponseMode,
  repo_path: RepoPath,
}).strict();
const PrImpactArgs = z.object({
  ref: z.string().describe('Git ref to diff against. Common: "HEAD~1" (last commit), "main" (PR base), "<sha>" (specific commit).'),
  response_mode: ResponseMode,
  repo_path: RepoPath,
}).strict();
const PathArgs = z.object({
  from: z.string().optional().describe('Starting function name. Omit and pass only `to` to search from every HTTP endpoint instead.'),
  to: z.string().describe('Destination function name — the code you want to know how execution reaches.'),
  max_depth: z.number().int().min(1).max(15).optional().describe('Maximum hops to traverse. Defaults to 8.'),
  limit: z.number().int().min(1).max(25).optional().describe('Maximum distinct paths to return. Defaults to 5.'),
  response_mode: ResponseMode,
  repo_path: RepoPath,
}).strict();
const QueryArgs = z.object({
  domain: z.string().optional().describe('Domain label, e.g. "database", "authentication", "validation". Call with no filters to see available values.'),
  complexity: z.enum(['low', 'medium', 'high']).optional().describe('Complexity band assigned during semantic analysis.'),
  side_effect: z.string().optional().describe('Substring match against recorded side effects, e.g. "write", "network", "console".'),
  exported: z.boolean().optional().describe('Restrict to exported (true) or internal (false) functions.'),
  is_async: z.boolean().optional().describe('Restrict to async (true) or synchronous (false) functions.'),
  name_pattern: z.string().optional().describe('SQL LIKE pattern against the function name, e.g. "handle%".'),
  file_pattern: z.string().optional().describe('SQL LIKE pattern against the file path, e.g. "src/auth/%".'),
  analyzed_only: z.boolean().optional().describe('Only functions that have semantic metadata. Defaults to false.'),
  limit: Limit,
  response_mode: ResponseMode,
  repo_path: RepoPath,
}).strict();
const TypeGraphArgs = z.object({
  name: z.string().describe('Type name (interface / class / type alias).'),
  direction: z.enum(['subtypes', 'supertypes']).describe('subtypes = "what extends/implements this type"; supertypes = "what does this type extend/implement".'),
  response_mode: ResponseMode,
  repo_path: RepoPath,
}).strict();

// Helper: every tool runs through this so we get consistent error handling
// and uniform response shape (markdown text + structured JSON).
function withDb<T>(
  defaultRepo: string,
  repoPath: string | undefined,
  fn: (db: ReturnType<typeof getDb>, repo: string) => T,
): { content: { type: 'text'; text: string }[]; structuredContent?: any; isError?: boolean } {
  const repo = resolveRepoPath(repoPath, defaultRepo);
  try {
    const db = getDb(repo);
    const result = fn(db, repo);
    if (result && typeof result === 'object' && 'content' in result) {
      return result as any;
    }
    return {
      content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
      structuredContent: typeof result === 'object' ? (result as any) : undefined,
    };
  } catch (err: any) {
    if (err instanceof StructxNotInitializedError) {
      return {
        content: [{ type: 'text', text: err.message }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
}

// Same idea for async tools (only structx_ask is async).
async function withDbAsync<T>(
  defaultRepo: string,
  repoPath: string | undefined,
  fn: (db: ReturnType<typeof getDb>, repo: string) => Promise<T>,
): Promise<{ content: { type: 'text'; text: string }[]; structuredContent?: any; isError?: boolean }> {
  const repo = resolveRepoPath(repoPath, defaultRepo);
  try {
    const db = getDb(repo);
    const result = await fn(db, repo);
    if (result && typeof result === 'object' && 'content' in result) {
      return result as any;
    }
    return {
      content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
      structuredContent: typeof result === 'object' ? (result as any) : undefined,
    };
  } catch (err: any) {
    if (err instanceof StructxNotInitializedError) {
      return { content: [{ type: 'text', text: err.message }], isError: true };
    }
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
}

type ResponseModeValue = 'both' | 'text' | 'structured' | undefined;

function toolResponse(
  text: string,
  structuredContent: any,
  responseMode?: ResponseModeValue,
  isError?: boolean,
): { content: { type: 'text'; text: string }[]; structuredContent?: any; isError?: boolean } {
  const response = responseMode === 'structured'
    ? {
      content: [{ type: 'text' as const, text: structuredTextSummary(structuredContent) }],
      structuredContent,
    }
    : responseMode === 'text'
      ? {
        content: [{ type: 'text' as const, text }],
        structuredContent: textOnlyStructuredSummary(structuredContent),
      }
      : {
        content: [{ type: 'text' as const, text }],
        structuredContent,
      };

  return isError ? { ...response, isError: true } : response;
}

function countStructuredContent(structuredContent: any): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const key of ['files', 'functions', 'types', 'routes', 'constants']) {
    if (Array.isArray(structuredContent?.[key])) {
      counts[key] = structuredContent[key].length;
    }
  }
  if (structuredContent?.stats) counts.stats = 1;
  return counts;
}

function formatCounts(counts: Record<string, number>): string {
  const parts = Object.entries(counts).map(([key, value]) => `${key}: ${value}`);
  return parts.length > 0 ? parts.join(', ') : 'no entity rows';
}

function structuredTextSummary(structuredContent: any): string {
  return `Structured results returned (${formatCounts(countStructuredContent(structuredContent))}).`;
}

function textOnlyStructuredSummary(structuredContent: any): any {
  return {
    omitted: true,
    reason: 'response_mode=text',
    counts: countStructuredContent(structuredContent),
  };
}

// Truncate long strings for display in cost tables and other compact lists.
function truncate(s: string | null | undefined, max: number): string {
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// Drop entity kinds that the caller didn't ask for. Keeps the response shape
// stable (every kind still present as an array) so downstream code that
// counts by kind doesn't have to special-case missing fields.
function applyScope(ctx: any, scope?: Array<'functions' | 'types' | 'routes' | 'files' | 'constants'>): any {
  if (!scope || scope.length === 0) return ctx;
  const keep = new Set(scope);
  return {
    ...ctx,
    functions: keep.has('functions') ? ctx.functions : [],
    types: keep.has('types') ? ctx.types : [],
    routes: keep.has('routes') ? ctx.routes : [],
    files: keep.has('files') ? ctx.files : [],
    constants: keep.has('constants') ? ctx.constants : [],
  };
}

function limitContext(ctx: any, limit?: number): any {
  if (!limit) return ctx;
  return {
    ...ctx,
    functions: ctx.functions.slice(0, limit),
    types: ctx.types.slice(0, limit),
    routes: ctx.routes.slice(0, limit),
    files: ctx.files.slice(0, limit),
    constants: ctx.constants.slice(0, limit),
  };
}

function structuredContext(ctx: any, detail?: 'summary' | 'full'): any {
  if (detail === 'full') return ctx;
  return {
    strategy: ctx.strategy,
    functions: ctx.functions.map((fn: any) => ({
      name: fn.name,
      location: fn.location,
      signature: fn.signature,
      purpose: fn.purpose,
      behavior: fn.behavior,
      sideEffects: fn.sideEffects,
      domain: fn.domain,
      complexity: fn.complexity,
      calls: fn.calls,
      calledBy: fn.calledBy,
      ...(fn.body ? { body: fn.body } : {}),
    })),
    types: ctx.types.map((t: any) => ({
      name: t.name,
      kind: t.kind,
      location: t.location,
      isExported: t.isExported,
      purpose: t.purpose,
    })),
    routes: ctx.routes.map((r: any) => ({
      method: r.method,
      path: r.path,
      location: r.location,
      handlerName: r.handlerName,
      middleware: r.middleware,
      purpose: r.purpose,
    })),
    files: ctx.files,
    constants: ctx.constants,
  };
}

function addFunctionBody(db: ReturnType<typeof getDb>, ctx: any, name: string, includeBody?: boolean): any {
  if (!includeBody || ctx.functions.length === 0) return ctx;

  // Match bodies by name+location rather than array index. directLookup falls
  // back to unqualified-name matching (`add` → `RegExpRouter.add`), in which
  // case getFunctionsByName(name) returns nothing and index-zipping silently
  // dropped every body. Look rows up by the resolved names instead.
  const rows = [
    ...getFunctionsByName(db, name),
    ...ctx.functions.flatMap((fn: any) => (fn.name === name ? [] : getFunctionsByName(db, fn.name))),
  ];
  if (rows.length === 0) return ctx;

  const filePaths = getFilePathsByIds(db, rows.map(r => r.file_id));
  const byLocation = new Map<string, string>();
  for (const row of rows) {
    byLocation.set(`${filePaths.get(row.file_id) ?? 'unknown'}:${row.start_line}`, row.body);
  }

  return {
    ...ctx,
    functions: ctx.functions.map((fn: any) => {
      const body = byLocation.get(fn.location);
      return body ? { ...fn, body } : fn;
    }),
  };
}

function formatFunctionResult(fn: any, includeBody?: boolean): string {
  const text = formatFunction(fn);
  if (!includeBody || !fn.body) return text;
  return `${text}\n\nBody:\n\`\`\`ts\n${fn.body}\n\`\`\``;
}

function compactOverview(overview: ReturnType<typeof getFullOverview>, maxItems: number) {
  return {
    stats: overview.stats,
    files: overview.files.slice(0, maxItems).map(f => ({
      path: f.path,
      summary: f.summary ? {
        import_count: f.summary.import_count,
        export_count: f.summary.export_count,
        function_count: f.summary.function_count,
        type_count: f.summary.type_count,
        route_count: f.summary.route_count,
        loc: f.summary.loc,
        purpose: f.summary.purpose,
      } : null,
    })),
    functions: overview.functions.slice(0, maxItems).map(fn => ({
      name: fn.name,
      filePath: fn.filePath,
      start_line: fn.start_line,
      end_line: fn.end_line,
      signature: fn.signature,
      is_exported: fn.is_exported,
      is_async: fn.is_async,
      purpose: fn.purpose,
      domain: fn.domain,
    })),
    types: overview.types.slice(0, maxItems).map(t => ({
      name: t.name,
      kind: t.kind,
      filePath: t.filePath,
      start_line: t.start_line,
      end_line: t.end_line,
      is_exported: t.is_exported,
      purpose: t.purpose,
    })),
    routes: overview.routes.slice(0, maxItems).map(r => ({
      method: r.method,
      path: r.path,
      filePath: r.filePath,
      start_line: r.start_line,
      end_line: r.end_line,
      handler_name: r.handler_name,
      purpose: r.purpose,
    })),
    constants: overview.constants.slice(0, maxItems).map(c => ({
      name: c.name,
      filePath: c.filePath,
      start_line: c.start_line,
      end_line: c.end_line,
      type_annotation: c.type_annotation,
      is_exported: c.is_exported,
    })),
    truncated: {
      files: overview.files.length > maxItems,
      functions: overview.functions.length > maxItems,
      types: overview.types.length > maxItems,
      routes: overview.routes.length > maxItems,
      constants: overview.constants.length > maxItems,
    },
  };
}

export function registerTools(server: McpServer, defaultRepo: string): void {
  // Readonly mode is set on the db-pool before registerTools() is called by
  // the server entry point. We capture it here so individual tool handlers
  // don't have to re-check on every call.
  const readonly = isReadonly();
  // ── 1. structx_search ──────────────────────────────────────────────────
  server.registerTool('structx_search', {
    description: 'Search the code graph by keywords. Returns matching functions, types, routes, and constants. Pure graph query — no LLM cost.',
    inputSchema: SearchArgs,
  }, async (args: any) => withDb(defaultRepo, args.repo_path, (db) => {
    const baseCtx = args.mode === 'broad'
      ? patternQuery(db, args.keywords)
      : semanticSearch(db, args.keywords);
    const scoped = applyScope(baseCtx, args.scope);
    const ctx = limitContext(scoped, args.limit);
    const text = formatContext(ctx, `Search results for: ${args.keywords.join(', ')}`);
    return toolResponse(text, structuredContext(ctx, args.detail), args.response_mode);
  }));

  // ── 2. structx_function ────────────────────────────────────────────────
  server.registerTool('structx_function', {
    description: 'Get full details for a function by exact name: signature, location, purpose, side effects, callers, callees.',
    inputSchema: FunctionArgs,
  }, async (args: any) => withDb(defaultRepo, args.repo_path, (db) => {
    const ctx = addFunctionBody(db, directLookup(db, args.name), args.name, args.include_body);
    if (ctx.functions.length === 0) {
      return toolResponse(`No function named '${args.name}' found.`, structuredContext(ctx, args.detail), args.response_mode);
    }
    const text = ctx.functions.map((fn: any) => formatFunctionResult(fn, args.include_body)).join('\n\n');
    return toolResponse(text, structuredContext(ctx, args.detail), args.response_mode);
  }));

  // ── 3. structx_relationships ──────────────────────────────────────────
  server.registerTool('structx_relationships', {
    description: 'Find what calls a function (callers) or what a function calls (callees). Direct relationships only — use structx_impact for transitive.',
    inputSchema: RelationshipArgs,
  }, async (args: any) => withDb(defaultRepo, args.repo_path, (db) => {
    const ctx = limitContext(relationshipQuery(db, args.name, args.direction), args.limit);
    const header = args.direction === 'callers' ? `Callers of ${args.name}` : `Callees of ${args.name}`;
    return toolResponse(formatContext(ctx, header), structuredContext(ctx, args.detail), args.response_mode);
  }));

  // ── 4. structx_impact ──────────────────────────────────────────────────
  server.registerTool('structx_impact', {
    description: 'Compute the transitive impact of changing a function: every direct and indirect caller via recursive traversal, plus the HTTP endpoints whose handlers sit in that blast radius.',
    inputSchema: ImpactArgs,
  }, async (args: any) => withDb(defaultRepo, args.repo_path, (db) => {
    const ctx = limitContext(impactAnalysis(db, args.name), args.limit);
    return toolResponse(formatContext(ctx, `Impact of changing ${args.name}`), structuredContext(ctx, args.detail), args.response_mode);
  }));

  // ── 5. structx_route ───────────────────────────────────────────────────
  server.registerTool('structx_route', {
    description: 'Find HTTP routes by path pattern and/or method. Both args optional — empty call returns all routes.',
    inputSchema: RouteArgs,
  }, async (args: any) => withDb(defaultRepo, args.repo_path, (db) => {
    const routed = routeQuery(db, args.path ?? null, args.method ?? null);
    const matched = args.path && args.path_match === 'exact'
      ? { ...routed, routes: routed.routes.filter((route: any) => route.path === args.path) }
      : routed;
    const ctx = limitContext(matched, args.limit);
    return toolResponse(formatContext(ctx, 'Routes'), structuredContext(ctx, args.detail), args.response_mode);
  }));

  // ── 6. structx_type ────────────────────────────────────────────────────
  server.registerTool('structx_type', {
    description: 'Find a type, interface, or enum by name. Falls back to FTS search on type names if no exact match.',
    inputSchema: TypeArgs,
  }, async (args: any) => withDb(defaultRepo, args.repo_path, (db) => {
    const ctx = typeQuery(db, args.name);
    if (ctx.types.length === 0) {
      return toolResponse(`No type named '${args.name}' found.`, structuredContext(ctx, args.detail), args.response_mode);
    }
    const text = ctx.types.map(formatType).join('\n\n');
    return toolResponse(text, structuredContext(ctx, args.detail), args.response_mode);
  }));

  // ── 7. structx_file ────────────────────────────────────────────────────
  server.registerTool('structx_file', {
    description: 'Get a file overview (functions, types, routes, constants). Empty path returns summaries for all files.',
    inputSchema: FileArgs,
  }, async (args: any) => withDb(defaultRepo, args.repo_path, (db) => {
    const ctx = limitContext(fileQuery(db, args.path ?? null), args.limit);
    if (args.path && ctx.functions.length === 0 && ctx.types.length === 0 && ctx.routes.length === 0 && ctx.files.length === 0) {
      return toolResponse(`File '${args.path}' not found in graph.`, structuredContext(ctx, args.detail), args.response_mode, true);
    }
    return toolResponse(formatContext(ctx, args.path ? `File: ${args.path}` : 'All files'), structuredContext(ctx, args.detail), args.response_mode);
  }));

  // ── 8. structx_list ────────────────────────────────────────────────────
  server.registerTool('structx_list', {
    description: 'Enumerate one kind of entity. Useful for "what routes exist", "what types are defined", etc.',
    inputSchema: ListArgs,
  }, async (args: any) => withDb(defaultRepo, args.repo_path, (db) => {
    const ctx = limitContext(listQuery(db, args.entity ?? null, args.limit ?? 50), args.limit);
    return toolResponse(formatContext(ctx, args.entity ? `All ${args.entity}` : 'Repo overview'), structuredContext(ctx, args.detail), args.response_mode);
  }));

  // ── 9. structx_overview ────────────────────────────────────────────────
  server.registerTool('structx_overview', {
    description: 'Repo-wide stats plus a truncated cross-section of files, functions, types, routes, and constants.',
    inputSchema: OverviewArgs,
  }, async (args: any) => withDb(defaultRepo, args.repo_path, (db, repo) => {
    const stats = getStats(db);
    const overview = getFullOverview(db);
    const maxItems = args.max_items ?? 10;
    const fullStructured = {
      stats,
      files: overview.files.slice(0, maxItems),
      functions: overview.functions.slice(0, maxItems),
      types: overview.types.slice(0, maxItems),
      routes: overview.routes.slice(0, maxItems),
      constants: overview.constants.slice(0, maxItems),
      truncated: {
        files: overview.files.length > maxItems,
        functions: overview.functions.length > maxItems,
        types: overview.types.length > maxItems,
        routes: overview.routes.length > maxItems,
        constants: overview.constants.length > maxItems,
      },
    };
    const structured = args.detail === 'full' ? fullStructured : compactOverview(overview, maxItems);
    const lines = [
      `# Repo: ${repo}`,
      '',
      `- **Files:** ${stats.totalFiles}`,
      `- **Functions:** ${stats.totalFunctions} (${stats.analyzedFunctions} semantically analyzed, ${stats.pendingAnalysis} pending)`,
      `- **Types:** ${stats.totalTypes}`,
      `- **Routes:** ${stats.totalRoutes}`,
      `- **Constants:** ${stats.totalConstants}`,
      `- **Relationships:** ${stats.totalRelationships}`,
      `- **File summaries:** ${stats.totalFileSummaries}`,
      `- **QA runs logged:** ${stats.totalQaRuns}`,
    ];

    const fileLines = fullStructured.files.map(f => {
      const summary = f.summary ? ` (${f.summary.function_count} fns, ${f.summary.type_count} types, ${f.summary.route_count} routes, ${f.summary.loc} LOC)` : '';
      const purpose = f.summary?.purpose ? ` - ${f.summary.purpose}` : '';
      return `- ${f.path}${summary}${purpose}`;
    });
    const functionLines = fullStructured.functions.map(fn => `- ${fn.name} (${fn.filePath}:${fn.start_line})${fn.purpose ? ` - ${fn.purpose}` : ''}`);
    const typeLines = fullStructured.types.map(t => `- ${t.kind} ${t.name} (${t.filePath}:${t.start_line})${t.purpose ? ` - ${t.purpose}` : ''}`);
    const routeLines = fullStructured.routes.map(r => `- ${r.method.toUpperCase()} ${r.path} (${r.filePath}:${r.start_line})${r.purpose ? ` - ${r.purpose}` : ''}`);
    const constantLines = fullStructured.constants.map(c => `- ${c.name} (${c.filePath}:${c.start_line})`);

    if (fileLines.length > 0) lines.push('', '## Files', ...fileLines);
    if (routeLines.length > 0) lines.push('', '## Routes', ...routeLines);
    if (typeLines.length > 0) lines.push('', '## Types', ...typeLines);
    if (functionLines.length > 0) lines.push('', '## Functions', ...functionLines);
    if (constantLines.length > 0) lines.push('', '## Constants', ...constantLines);
    if (overview.files.length > maxItems || overview.functions.length > maxItems || overview.types.length > maxItems || overview.routes.length > maxItems || overview.constants.length > maxItems) {
      lines.push('', `_Showing first ${maxItems} rows per section._`);
    }

    return toolResponse(lines.join('\n'), structured, args.response_mode);
  }));

  // ── 10. structx_costs ──────────────────────────────────────────────────
  server.registerTool('structx_costs', {
    description: 'Cost telemetry for this repo: total spend, tokens, latency percentiles by mode, ask-cache hit ratio, and recent runs. Pure read — no LLM cost.',
    inputSchema: CostsArgs,
  }, async (args: any) => withDb(defaultRepo, args.repo_path, (db, repo) => {
    const stats = getCostStats(db, args.recent_limit ?? 10);
    const lines = [
      `# Cost telemetry for ${repo}`,
      '',
      `- **Total runs:** ${stats.totalRuns}`,
      `- **Total spend:** $${stats.totalCostUsd.toFixed(4)}`,
      `- **Tokens:** ${stats.totalInputTokens.toLocaleString()} in / ${stats.totalOutputTokens.toLocaleString()} out`,
      `- **Cached responses:** ${stats.cacheHits} (hit ratio ${(stats.cacheHitRatio * 100).toFixed(1)}%)`,
    ];
    if (stats.byMode.length > 0) {
      lines.push('', '## By mode');
      for (const m of stats.byMode) {
        lines.push(
          `- **${m.mode}:** ${m.runs} runs, $${m.totalCostUsd.toFixed(4)}, p50 ${m.p50ResponseTimeMs.toFixed(0)}ms / p95 ${m.p95ResponseTimeMs.toFixed(0)}ms`,
        );
      }
    }
    if (stats.recentRuns.length > 0) {
      lines.push('', '## Recent');
      for (const r of stats.recentRuns) {
        const cost = r.cost_usd != null ? `$${r.cost_usd.toFixed(4)}` : 'cached';
        const tokens = r.total_tokens ?? 0;
        const ms = r.response_time_ms != null ? `${r.response_time_ms}ms` : '—';
        lines.push(`- [${r.mode}] ${cost} · ${tokens} tok · ${ms} · ${truncate(r.question, 60)}`);
      }
    }
    return toolResponse(lines.join('\n'), stats, args.response_mode);
  }));

  // ── 11. structx_dead_code ──────────────────────────────────────────────
  server.registerTool('structx_dead_code', {
    description: 'Find functions with zero inbound references (neither resolved nor name-matched). Useful for pre-refactor cleanup — surface exports nothing else calls.',
    inputSchema: DeadCodeArgs,
  }, async (args: any) => withDb(defaultRepo, args.repo_path, (db) => {
    const all = getDeadFunctions(db, args.limit ?? 50);
    let filtered = all;
    if (args.exported_only) filtered = filtered.filter((f: any) => f.is_exported);
    if (args.exclude_pattern) {
      let re: RegExp | null = null;
      try { re = new RegExp(args.exclude_pattern); } catch { re = null; }
      if (re) filtered = filtered.filter(f => !re!.test(f.name));
    }

    const exported = filtered.filter((f: any) => f.is_exported);
    const internal = filtered.filter((f: any) => !f.is_exported);
    const lines = [`# Dead functions: ${filtered.length}`, ''];
    if (exported.length > 0) {
      lines.push('## Exported (callers may live in another package)');
      for (const f of exported) {
        const purpose = f.purpose ? ` — ${f.purpose}` : '';
        lines.push(`- **${f.name}** \`${f.filePath}:${f.start_line}\`${purpose}`);
      }
      lines.push('');
    }
    if (internal.length > 0) {
      lines.push('## Internal (almost certainly safe to remove)');
      for (const f of internal) {
        const purpose = f.purpose ? ` — ${f.purpose}` : '';
        lines.push(`- **${f.name}** \`${f.filePath}:${f.start_line}\`${purpose}`);
      }
    }
    if (filtered.length === 0) {
      lines.push('_None — every function has at least one caller._');
    }
    return toolResponse(lines.join('\n'), { dead: filtered, exported, internal }, args.response_mode);
  }));

  // ── 12. structx_type_graph ─────────────────────────────────────────────
  server.registerTool('structx_type_graph', {
    description: 'Walk type heritage edges (extends / implements). direction="subtypes" finds classes/interfaces that extend or implement the given type; direction="supertypes" returns the parents of the given type. Closes the type-shaped refactor question gap (e.g. "what classes implement Repository?").',
    inputSchema: TypeGraphArgs,
  }, async (args: any) => withDb(defaultRepo, args.repo_path, (db) => {
    if (args.direction === 'subtypes') {
      const subs = getSubtypesOf(db, args.name);
      const lines: string[] = [`# Subtypes of \`${args.name}\``, ''];
      if (subs.length === 0) lines.push(`_No types extend or implement ${args.name} in the indexed graph._`);
      const extendsList = subs.filter((s: any) => s.relation_kind === 'extends');
      const implementsList = subs.filter((s: any) => s.relation_kind === 'implements');
      if (extendsList.length > 0) {
        lines.push('## extends');
        for (const s of extendsList) lines.push(`- **${s.kind} ${s.name}** \`file_id:${s.file_id}:${s.start_line}\``);
      }
      if (implementsList.length > 0) {
        lines.push('', '## implements');
        for (const s of implementsList) lines.push(`- **${s.kind} ${s.name}** \`file_id:${s.file_id}:${s.start_line}\``);
      }
      return toolResponse(lines.join('\n'), { name: args.name, direction: 'subtypes', subtypes: subs }, args.response_mode);
    }

    const sups = getSupertypesOf(db, args.name);
    const lines: string[] = [`# Supertypes of \`${args.name}\``, ''];
    if (sups.length === 0) lines.push(`_${args.name} does not extend or implement any type in the indexed graph._`);
    for (const s of sups) {
      const resolved = s.resolvedTypeId !== null ? '' : ' _(unresolved — type lives outside the indexed graph)_';
      lines.push(`- **${s.relation_kind} ${s.name}**${resolved}`);
    }
    return toolResponse(lines.join('\n'), { name: args.name, direction: 'supertypes', supertypes: sups }, args.response_mode);
  }));

  // ── 13. structx_pr_impact ─────────────────────────────────────────────
  server.registerTool('structx_pr_impact', {
    description: 'Map files changed since a git ref to indexed graph entities (functions, types, routes). Combine with structx_impact for transitive blast radius. Useful for "what does this PR actually touch" answers.',
    inputSchema: PrImpactArgs,
  }, async (args: any) => withDb(defaultRepo, args.repo_path, (db, repo) => {
    let result;
    try {
      result = diffEntities(db, repo, args.ref);
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
        structuredContent: { ref: args.ref, error: err.message },
        isError: true,
      };
    }

    const lines: string[] = [
      `# Changed since \`${args.ref}\``,
      '',
      `- **Files changed:** ${result.changedFiles.length}`,
      `- **Functions affected:** ${result.functions.length}`,
      `- **Types affected:** ${result.types.length}`,
      `- **Routes affected:** ${result.routes.length}`,
    ];
    if (result.unindexedFiles.length > 0) {
      lines.push(`- **Changed but not indexed:** ${result.unindexedFiles.length} (excluded paths or deleted files)`);
    }
    if (result.functions.length > 0) {
      lines.push('', '## Functions');
      for (const fn of result.functions.slice(0, 50)) {
        lines.push(`- \`[${fn.status}]\` **${fn.name}** \`${fn.file}\``);
      }
      if (result.functions.length > 50) lines.push(`- _… and ${result.functions.length - 50} more_`);
    }
    if (result.types.length > 0) {
      lines.push('', '## Types');
      for (const t of result.types.slice(0, 30)) {
        lines.push(`- \`[${t.status}]\` **${t.kind} ${t.name}** \`${t.file}\``);
      }
    }
    if (result.routes.length > 0) {
      lines.push('', '## Routes');
      for (const r of result.routes.slice(0, 30)) {
        lines.push(`- \`[${r.status}]\` **${r.method} ${r.path}** \`${r.file}\``);
      }
    }

    return toolResponse(lines.join('\n'), result, args.response_mode);
  }));

  // ── 14. structx_path ───────────────────────────────────────────────────
  server.registerTool('structx_path', {
    description: 'Trace the call chain between two points in the graph — "how does execution get from here to there". With `from` and `to`, returns the call paths between two functions. With only `to`, returns the HTTP endpoints that reach it and the chain from each. Pure graph query — no LLM cost.',
    inputSchema: PathArgs,
  }, async (args: any) => withDb(defaultRepo, args.repo_path, (db) => {
    const maxDepth = args.max_depth ?? 8;
    const limit = args.limit ?? 5;

    // Endpoint mode: no `from` given, so start at the API surface.
    if (!args.from) {
      const routePaths = findRoutePathsTo(db, args.to, maxDepth, limit);
      const lines = [`# Endpoints reaching \`${args.to}\``, ''];
      if (routePaths.length === 0) {
        lines.push(`_No indexed HTTP endpoint reaches ${args.to} within ${maxDepth} hops._`);
        lines.push('', 'This means either the function is not called from a route handler, or the handler is an inline arrow function (which has no indexed function row).');
      }
      for (const rp of routePaths) {
        // Inline handlers are named after their route; don't repeat it.
        const [first, ...rest] = rp.callPath;
        const folded = first && first.name === `${rp.method} ${rp.path}`;
        const steps = folded ? rest : rp.callPath;
        lines.push(folded
          ? `### ${rp.method} ${rp.path} \`${first.filePath}:${first.start_line}\``
          : `### ${rp.method} ${rp.path}`);
        lines.push(steps.map((s, i) => `${'  '.repeat(i)}${i > 0 ? '└─ ' : ''}**${s.name}** \`${s.filePath}:${s.start_line}\`${s.purpose ? ` — ${s.purpose}` : ''}`).join('\n'));
        lines.push('');
      }
      return toolResponse(lines.join('\n'), { to: args.to, endpoints: routePaths }, args.response_mode);
    }

    const paths = findCallPaths(db, args.from, args.to, maxDepth, limit);
    const lines = [`# Call paths: \`${args.from}\` → \`${args.to}\``, ''];
    if (paths.length === 0) {
      lines.push(`_No call path found within ${maxDepth} hops._`);
      lines.push('', 'Either no such chain exists, or an edge along it is unresolved (external calls and ambiguous dynamic dispatch are not traversable).');
    }
    for (const p of paths) {
      lines.push(`**${p.depth} hop${p.depth === 1 ? '' : 's'}:**`);
      lines.push(p.steps.map((s, i) => `${'  '.repeat(i)}${i > 0 ? '└─ ' : ''}**${s.name}** \`${s.filePath}:${s.start_line}\`${s.purpose ? ` — ${s.purpose}` : ''}`).join('\n'));
      lines.push('');
    }
    return toolResponse(lines.join('\n'), { from: args.from, to: args.to, paths }, args.response_mode);
  }));

  // ── 15. structx_query ──────────────────────────────────────────────────
  server.registerTool('structx_query', {
    description: 'Filter functions by their semantic properties — domain, side effects, complexity, export status — rather than by keyword. Answers questions like "every exported database function that writes" or "all high-complexity auth code". Requires `structx analyze` to have run. Call with no filters to discover which domains exist. Pure graph query — no LLM cost.',
    inputSchema: QueryArgs,
  }, async (args: any) => withDb(defaultRepo, args.repo_path, (db) => {
    const hasFilter = ['domain', 'complexity', 'side_effect', 'exported', 'is_async', 'name_pattern', 'file_pattern']
      .some(k => args[k] !== undefined);

    // No filters: describe what is available instead of dumping the graph.
    if (!hasFilter) {
      const facets = semanticFacets(db);
      const lines = [
        '# Semantic index',
        '',
        `${facets.analyzed} of ${facets.total} functions have semantic metadata.`,
      ];
      if (facets.analyzed === 0) {
        lines.push('', '_Run `structx analyze .` to populate domain, side-effect and complexity labels — this tool has nothing to filter until then._');
      }
      if (facets.domains.length > 0) {
        lines.push('', '## Domains', ...facets.domains.map(d => `- **${d.value}** — ${d.count}`));
      }
      if (facets.complexities.length > 0) {
        lines.push('', '## Complexity', ...facets.complexities.map(d => `- **${d.value}** — ${d.count}`));
      }
      return toolResponse(lines.join('\n'), facets, args.response_mode);
    }

    const rows = semanticQuery(db, {
      domain: args.domain,
      complexity: args.complexity,
      sideEffect: args.side_effect,
      isExported: args.exported,
      isAsync: args.is_async,
      namePattern: args.name_pattern,
      filePattern: args.file_pattern,
      analyzedOnly: args.analyzed_only,
      limit: args.limit ?? 50,
    });

    const lines = [`# Matching functions: ${rows.length}`, ''];
    for (const fn of rows) {
      let sideEffects: string[] = [];
      try { if (fn.side_effects_json) sideEffects = JSON.parse(fn.side_effects_json); } catch {}
      const tags = [fn.domain, fn.complexity, fn.is_exported ? 'exported' : null, fn.is_async ? 'async' : null]
        .filter(Boolean).join(' · ');
      lines.push(`- **${fn.name}** \`${fn.filePath}:${fn.start_line}\`${tags ? `  _(${tags})_` : ''}`);
      if (fn.purpose) lines.push(`    ${fn.purpose}`);
      if (sideEffects.length > 0) lines.push(`    side effects: ${sideEffects.join(', ')}`);
    }
    if (rows.length === 0) lines.push('_No functions match those filters._');

    return toolResponse(lines.join('\n'), {
      count: rows.length,
      functions: rows.map(fn => ({
        name: fn.name,
        location: `${fn.filePath}:${fn.start_line}`,
        purpose: fn.purpose,
        domain: fn.domain,
        complexity: fn.complexity,
        isExported: !!fn.is_exported,
        isAsync: !!fn.is_async,
        sideEffects: (() => { try { return fn.side_effects_json ? JSON.parse(fn.side_effects_json) : []; } catch { return []; } })(),
      })),
    }, args.response_mode);
  }));

  // ── 16. structx_ask ────────────────────────────────────────────────────
  server.registerTool('structx_ask', {
    description: readonly
      ? 'DISABLED in readonly mode. structx_ask writes to ask_cache and qa_runs. Restart the server without --readonly to enable.'
      : 'Full natural-language Q&A over the code graph. Costs LLM tokens. Honors the SHA256-keyed ask cache so identical questions are instant.',
    inputSchema: AskArgs,
  }, async (args: any, extra: any) => {
    if (readonly) {
      return {
        content: [{ type: 'text' as const, text: 'structx_ask is disabled in readonly mode (server started with --readonly). Use the pure-graph tools (structx_search, structx_function, etc.) or restart the server without --readonly.' }],
        structuredContent: { disabled: true, reason: 'readonly' },
        isError: true,
      };
    }
    // The MCP SDK populates extra._meta.progressToken when the client called
    // callTool with onprogress. We use it as the signal to stream — clients
    // that don't ask for progress get the existing one-shot path with no
    // protocol overhead.
    const progressToken = extra?._meta?.progressToken;
    const sendNotification = extra?.sendNotification;
    return withDbAsync(defaultRepo, args.repo_path, async (db, repo) => {
    const config = loadConfig(getStructXDir(repo));
    const answerMaxTokens = args.max_tokens ?? config.answerMaxTokens;

    // Cache check — same key the CLI uses.
    const graphHash = getGraphFingerprint(db);
    const questionHash = makeAskCacheKey(args.question, config.answerModel, graphHash, answerMaxTokens);
    const cached = getCachedAskResponse(db, questionHash);
    if (cached) {
      return {
        content: [{ type: 'text' as const, text: cached.answer_text + `\n\n_(cached, strategy: ${cached.strategy})_` }],
        structuredContent: {
          answer: cached.answer_text,
          strategy: cached.strategy,
          cached: true,
          inputTokens: cached.input_tokens ?? 0,
          outputTokens: cached.output_tokens ?? 0,
          answerMaxTokens,
          cost: 0,
          graphHash,
        },
      };
    }

    if (!config.anthropicApiKey) {
      return {
        content: [{
          type: 'text' as const,
          text: `API key not set for provider '${config.provider}'. Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY, or add an API key to .structx/config.json.`,
        }],
        structuredContent: { cached: false, provider: config.provider },
        isError: true,
      };
    }

    // Classify
    const classificationResult = await classifyQuestionWithUsage(args.question, config.classifierModel, getLlmConfig(config));
    const classification = classificationResult.classification;

    // Retrieve via the same dispatch as CLI
    const graphQueryStart = Date.now();
    let retrieved;
    switch (classification.strategy) {
      case 'direct': retrieved = directLookupExpanded(db, classification.functionName || ''); break;
      case 'relationship': retrieved = relationshipQuery(db, classification.functionName || '', classification.direction || 'callers'); break;
      case 'semantic': retrieved = semanticSearch(db, classification.keywords); break;
      case 'domain': retrieved = domainQuery(db, classification.domain || 'other'); break;
      case 'impact': retrieved = impactAnalysis(db, classification.functionName || ''); break;
      case 'route':
        retrieved = classification.routePath || classification.keywords.length === 0
          ? routeQuery(db, classification.routePath, classification.routeMethod)
          : routeKeywordQuery(db, classification.keywords, classification.routeMethod);
        break;
      case 'type': retrieved = typeQuery(db, classification.typeName || classification.keywords.join(' ')); break;
      case 'file': retrieved = fileQuery(db, classification.filePath); break;
      case 'list': retrieved = listQuery(db, classification.listEntity); break;
      case 'pattern': retrieved = patternQuery(db, classification.keywords); break;
      default: retrieved = semanticSearch(db, classification.keywords);
    }
    const graphQueryTimeMs = Date.now() - graphQueryStart;

    const context = buildContext(retrieved, args.question);

    // Stream when the client requested progress; otherwise use the one-shot
    // path. Streaming sends one notifications/progress per text delta with
    // the cumulative answer length as `progress` so clients can compute a
    // moving total without re-summing chunks.
    let answerResult;
    if (progressToken !== undefined && sendNotification) {
      let accumulated = '';
      answerResult = await generateAnswerStreaming(
        args.question, context, config.answerModel, getLlmConfig(config), answerMaxTokens,
        (chunk: string) => {
          accumulated += chunk;
          // Fire-and-forget: notification ordering doesn't matter to the
          // final result, and awaiting each one would serialize the stream.
          void sendNotification({
            method: 'notifications/progress',
            params: {
              progressToken,
              progress: accumulated.length,
              message: chunk,
            },
          });
        },
      );
    } else {
      answerResult = await generateAnswer(args.question, context, config.answerModel, getLlmConfig(config), answerMaxTokens);
    }

    const totalInputTokens = classificationResult.inputTokens + answerResult.inputTokens;
    const totalOutputTokens = classificationResult.outputTokens + answerResult.outputTokens;
    const totalCost = classificationResult.cost + answerResult.cost;

    // Cache + log run, same as CLI.
    insertCachedAskResponse(
      db, questionHash, classification.strategy, answerResult.answer,
      config.answerModel, totalInputTokens, totalOutputTokens, totalCost,
    );
    insertQaRun(db, {
      mode: 'structx-mcp',
      question: args.question,
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      total_tokens: totalInputTokens + totalOutputTokens,
      cost_usd: totalCost,
      response_time_ms: answerResult.responseTimeMs,
      files_accessed: null,
      functions_retrieved: retrieved.functions.length,
      graph_query_time_ms: graphQueryTimeMs,
      answer_text: answerResult.answer,
    });

    return {
      content: [{ type: 'text' as const, text: answerResult.answer }],
      structuredContent: {
        answer: answerResult.answer,
        strategy: classification.strategy,
        cached: false,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        classifierInputTokens: classificationResult.inputTokens,
        classifierOutputTokens: classificationResult.outputTokens,
        answerInputTokens: answerResult.inputTokens,
        answerOutputTokens: answerResult.outputTokens,
        answerMaxTokens,
        cost: totalCost,
        classifierCost: classificationResult.cost,
        answerCost: answerResult.cost,
        graphQueryTimeMs,
        graphHash,
      },
    };
    });
  });
}
