import { z } from 'zod/v3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  directLookup, relationshipQuery, semanticSearch, patternQuery,
  impactAnalysis, routeQuery, routeKeywordQuery, typeQuery, fileQuery, listQuery,
  domainQuery,
} from '../query/retriever';
import {
  getStats, getFullOverview,
  getCachedAskResponse, insertCachedAskResponse, insertQaRun,
  getFunctionsByName,
} from '../db/queries';
import { classifyQuestionWithUsage } from '../query/classifier';
import { buildContext } from '../query/context-builder';
import { generateAnswer } from '../query/answerer';
import { getGraphFingerprint, makeAskCacheKey } from '../query/ask-cache';
import { loadConfig, getStructXDir, getLlmConfig } from '../config';
import { getDb, resolveRepoPath, StructxNotInitializedError } from './db-pool';
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
  const rows = getFunctionsByName(db, name);
  if (rows.length === 0) return ctx;
  return {
    ...ctx,
    functions: ctx.functions.map((fn: any, i: number) => rows[i] ? { ...fn, body: rows[i].body } : fn),
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
  // ── 1. structx_search ──────────────────────────────────────────────────
  server.registerTool('structx_search', {
    description: 'Search the code graph by keywords. Returns matching functions, types, routes, and constants. Pure graph query — no LLM cost.',
    inputSchema: SearchArgs,
  }, async (args: any) => withDb(defaultRepo, args.repo_path, (db) => {
    const ctx = limitContext(args.mode === 'broad'
      ? patternQuery(db, args.keywords)
      : semanticSearch(db, args.keywords), args.limit);
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
    description: 'Compute the transitive impact of changing a function: every direct and indirect caller via recursive traversal.',
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

  // ── 10. structx_ask ────────────────────────────────────────────────────
  server.registerTool('structx_ask', {
    description: 'Full natural-language Q&A over the code graph. Costs LLM tokens. Honors the SHA256-keyed ask cache so identical questions are instant.',
    inputSchema: AskArgs,
  }, async (args: any) => withDbAsync(defaultRepo, args.repo_path, async (db, repo) => {
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
      case 'direct': retrieved = directLookup(db, classification.functionName || ''); break;
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
    const answerResult = await generateAnswer(args.question, context, config.answerModel, getLlmConfig(config), answerMaxTokens);

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
  }));
}
