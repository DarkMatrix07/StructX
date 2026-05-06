import * as crypto from 'crypto';
import { z } from 'zod/v3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  directLookup, relationshipQuery, semanticSearch, patternQuery,
  impactAnalysis, routeQuery, typeQuery, fileQuery, listQuery,
  domainQuery,
} from '../query/retriever';
import {
  getStats, getFullOverview, getCachedAskResponse, insertCachedAskResponse, insertQaRun,
} from '../db/queries';
import { classifyQuestion } from '../query/classifier';
import { buildContext } from '../query/context-builder';
import { generateAnswer } from '../query/answerer';
import { loadConfig, getStructXDir, getLlmConfig } from '../config';
import { getDb, resolveRepoPath, StructxNotInitializedError } from './db-pool';
import { formatContext, formatFunction, formatType, formatRoute, formatFile } from './format';

// All tool args may include a repo_path that overrides the server's default.
const RepoPath = z.string().optional().describe('Absolute path to the repo. Defaults to the server\'s --repo arg or cwd.');
const SearchArgs = z.object({
  keywords: z.array(z.string()).min(1).describe('Search terms (e.g. ["auth", "login"]). FTS-sanitized internally.'),
  mode: z.enum(['narrow', 'broad']).optional().describe('narrow = fewer high-precision results (default); broad = wider net for cross-cutting concerns.'),
  repo_path: RepoPath,
}).strict();
const FunctionArgs = z.object({
  name: z.string().describe('Exact function name.'),
  repo_path: RepoPath,
}).strict();
const RelationshipArgs = z.object({
  name: z.string().describe('Exact function name.'),
  direction: z.enum(['callers', 'callees']).describe('callers = who invokes this function; callees = what this function invokes.'),
  repo_path: RepoPath,
}).strict();
const ImpactArgs = FunctionArgs;
const RouteArgs = z.object({
  path: z.string().optional().describe('Path or substring (e.g. "/users", "/api"). Matches anywhere in the route path.'),
  method: z.string().optional().describe('HTTP method filter (GET, POST, etc.). Case-insensitive.'),
  repo_path: RepoPath,
}).strict();
const TypeArgs = z.object({
  name: z.string().describe('Type/interface/enum name.'),
  repo_path: RepoPath,
}).strict();
const FileArgs = z.object({
  path: z.string().optional().describe('File path relative to repo (e.g. "src/auth.ts"). Empty = all files summary.'),
  repo_path: RepoPath,
}).strict();
const ListArgs = z.object({
  entity: z.enum(['routes', 'types', 'files', 'functions', 'constants']).optional().describe('Kind to enumerate. Omit for a mixed cross-section.'),
  repo_path: RepoPath,
}).strict();
const OverviewArgs = z.object({ repo_path: RepoPath }).strict();
const AskArgs = z.object({
  question: z.string().describe('Natural language question (e.g. "How is authentication handled?").'),
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

export function registerTools(server: McpServer, defaultRepo: string): void {
  // ── 1. structx_search ──────────────────────────────────────────────────
  server.registerTool('structx_search', {
    description: 'Search the code graph by keywords. Returns matching functions, types, routes, and constants. Pure graph query — no LLM cost.',
    inputSchema: SearchArgs,
  }, async (args: any) => withDb(defaultRepo, args.repo_path, (db) => {
    const ctx = args.mode === 'broad'
      ? patternQuery(db, args.keywords)
      : semanticSearch(db, args.keywords);
    const text = formatContext(ctx, `Search results for: ${args.keywords.join(', ')}`);
    return { content: [{ type: 'text' as const, text }], structuredContent: ctx };
  }));

  // ── 2. structx_function ────────────────────────────────────────────────
  server.registerTool('structx_function', {
    description: 'Get full details for a function by exact name: signature, location, purpose, side effects, callers, callees.',
    inputSchema: FunctionArgs,
  }, async (args: any) => withDb(defaultRepo, args.repo_path, (db) => {
    const ctx = directLookup(db, args.name);
    if (ctx.functions.length === 0) {
      return { content: [{ type: 'text' as const, text: `No function named '${args.name}' found.` }], structuredContent: ctx };
    }
    const text = formatFunction(ctx.functions[0]);
    return { content: [{ type: 'text' as const, text }], structuredContent: ctx };
  }));

  // ── 3. structx_relationships ──────────────────────────────────────────
  server.registerTool('structx_relationships', {
    description: 'Find what calls a function (callers) or what a function calls (callees). Direct relationships only — use structx_impact for transitive.',
    inputSchema: RelationshipArgs,
  }, async (args: any) => withDb(defaultRepo, args.repo_path, (db) => {
    const ctx = relationshipQuery(db, args.name, args.direction);
    const header = args.direction === 'callers' ? `Callers of ${args.name}` : `Callees of ${args.name}`;
    return { content: [{ type: 'text' as const, text: formatContext(ctx, header) }], structuredContent: ctx };
  }));

  // ── 4. structx_impact ──────────────────────────────────────────────────
  server.registerTool('structx_impact', {
    description: 'Compute the transitive impact of changing a function: every direct and indirect caller via recursive traversal.',
    inputSchema: ImpactArgs,
  }, async (args: any) => withDb(defaultRepo, args.repo_path, (db) => {
    const ctx = impactAnalysis(db, args.name);
    return { content: [{ type: 'text' as const, text: formatContext(ctx, `Impact of changing ${args.name}`) }], structuredContent: ctx };
  }));

  // ── 5. structx_route ───────────────────────────────────────────────────
  server.registerTool('structx_route', {
    description: 'Find HTTP routes by path pattern and/or method. Both args optional — empty call returns all routes.',
    inputSchema: RouteArgs,
  }, async (args: any) => withDb(defaultRepo, args.repo_path, (db) => {
    const ctx = routeQuery(db, args.path ?? null, args.method ?? null);
    return { content: [{ type: 'text' as const, text: formatContext(ctx, 'Routes') }], structuredContent: ctx };
  }));

  // ── 6. structx_type ────────────────────────────────────────────────────
  server.registerTool('structx_type', {
    description: 'Find a type, interface, or enum by name. Falls back to FTS search on type names if no exact match.',
    inputSchema: TypeArgs,
  }, async (args: any) => withDb(defaultRepo, args.repo_path, (db) => {
    const ctx = typeQuery(db, args.name);
    if (ctx.types.length === 0) {
      return { content: [{ type: 'text' as const, text: `No type named '${args.name}' found.` }], structuredContent: ctx };
    }
    const text = ctx.types.map(formatType).join('\n\n');
    return { content: [{ type: 'text' as const, text }], structuredContent: ctx };
  }));

  // ── 7. structx_file ────────────────────────────────────────────────────
  server.registerTool('structx_file', {
    description: 'Get a file overview (functions, types, routes, constants). Empty path returns summaries for all files.',
    inputSchema: FileArgs,
  }, async (args: any) => withDb(defaultRepo, args.repo_path, (db) => {
    const ctx = fileQuery(db, args.path ?? null);
    if (args.path && ctx.functions.length === 0 && ctx.types.length === 0 && ctx.routes.length === 0 && ctx.files.length === 0) {
      return { content: [{ type: 'text' as const, text: `File '${args.path}' not found in graph.` }], structuredContent: ctx, isError: true };
    }
    return { content: [{ type: 'text' as const, text: formatContext(ctx, args.path ? `File: ${args.path}` : 'All files') }], structuredContent: ctx };
  }));

  // ── 8. structx_list ────────────────────────────────────────────────────
  server.registerTool('structx_list', {
    description: 'Enumerate one kind of entity. Useful for "what routes exist", "what types are defined", etc.',
    inputSchema: ListArgs,
  }, async (args: any) => withDb(defaultRepo, args.repo_path, (db) => {
    const ctx = listQuery(db, args.entity ?? null);
    return { content: [{ type: 'text' as const, text: formatContext(ctx, args.entity ? `All ${args.entity}` : 'Repo overview') }], structuredContent: ctx };
  }));

  // ── 9. structx_overview ────────────────────────────────────────────────
  server.registerTool('structx_overview', {
    description: 'Repo-wide stats plus a truncated cross-section of files, functions, types, routes, and constants.',
    inputSchema: OverviewArgs,
  }, async (args: any) => withDb(defaultRepo, args.repo_path, (db, repo) => {
    const stats = getStats(db);
    const overview = getFullOverview(db);
    const maxItems = 20;
    const truncated = {
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

    const fileLines = truncated.files.map(f => {
      const summary = f.summary ? ` (${f.summary.function_count} fns, ${f.summary.type_count} types, ${f.summary.route_count} routes, ${f.summary.loc} LOC)` : '';
      const purpose = f.summary?.purpose ? ` - ${f.summary.purpose}` : '';
      return `- ${f.path}${summary}${purpose}`;
    });
    const functionLines = truncated.functions.map(fn => `- ${fn.name} (${fn.filePath}:${fn.start_line})${fn.purpose ? ` - ${fn.purpose}` : ''}`);
    const typeLines = truncated.types.map(t => `- ${t.kind} ${t.name} (${t.filePath}:${t.start_line})${t.purpose ? ` - ${t.purpose}` : ''}`);
    const routeLines = truncated.routes.map(r => `- ${r.method.toUpperCase()} ${r.path} (${r.filePath}:${r.start_line})${r.purpose ? ` - ${r.purpose}` : ''}`);
    const constantLines = truncated.constants.map(c => `- ${c.name} (${c.filePath}:${c.start_line})`);

    if (fileLines.length > 0) lines.push('', '## Files', ...fileLines);
    if (routeLines.length > 0) lines.push('', '## Routes', ...routeLines);
    if (typeLines.length > 0) lines.push('', '## Types', ...typeLines);
    if (functionLines.length > 0) lines.push('', '## Functions', ...functionLines);
    if (constantLines.length > 0) lines.push('', '## Constants', ...constantLines);
    if (overview.files.length > maxItems || overview.functions.length > maxItems || overview.types.length > maxItems || overview.routes.length > maxItems || overview.constants.length > maxItems) {
      lines.push('', `_Showing first ${maxItems} rows per section._`);
    }

    return { content: [{ type: 'text' as const, text: lines.join('\n') }], structuredContent: truncated };
  }));

  // ── 10. structx_ask ────────────────────────────────────────────────────
  server.registerTool('structx_ask', {
    description: 'Full natural-language Q&A over the code graph. Costs LLM tokens. Honors the SHA256-keyed ask cache so identical questions are instant.',
    inputSchema: AskArgs,
  }, async (args: any) => withDbAsync(defaultRepo, args.repo_path, async (db, repo) => {
    const config = loadConfig(getStructXDir(repo));

    // Cache check — same key the CLI uses.
    const questionHash = crypto.createHash('sha256')
      .update(`${args.question.toLowerCase().trim()}|${config.answerModel}`)
      .digest('hex');
    const cached = getCachedAskResponse(db, questionHash);
    if (cached) {
      return {
        content: [{ type: 'text' as const, text: cached.answer_text + `\n\n_(cached, strategy: ${cached.strategy})_` }],
        structuredContent: { answer: cached.answer_text, strategy: cached.strategy, cached: true, cost: 0 },
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
    const classification = await classifyQuestion(args.question, config.classifierModel, getLlmConfig(config));

    // Retrieve via the same dispatch as CLI
    const graphQueryStart = Date.now();
    let retrieved;
    switch (classification.strategy) {
      case 'direct': retrieved = directLookup(db, classification.functionName || ''); break;
      case 'relationship': retrieved = relationshipQuery(db, classification.functionName || '', classification.direction || 'callers'); break;
      case 'semantic': retrieved = semanticSearch(db, classification.keywords); break;
      case 'domain': retrieved = domainQuery(db, classification.domain || 'other'); break;
      case 'impact': retrieved = impactAnalysis(db, classification.functionName || ''); break;
      case 'route': retrieved = routeQuery(db, classification.routePath, classification.routeMethod); break;
      case 'type': retrieved = typeQuery(db, classification.typeName || classification.keywords.join(' ')); break;
      case 'file': retrieved = fileQuery(db, classification.filePath); break;
      case 'list': retrieved = listQuery(db, classification.listEntity); break;
      case 'pattern': retrieved = patternQuery(db, classification.keywords); break;
      default: retrieved = semanticSearch(db, classification.keywords);
    }
    const graphQueryTimeMs = Date.now() - graphQueryStart;

    const context = buildContext(retrieved, args.question);
    const answerResult = await generateAnswer(args.question, context, config.answerModel, getLlmConfig(config));

    // Cache + log run, same as CLI.
    insertCachedAskResponse(
      db, questionHash, classification.strategy, answerResult.answer,
      config.answerModel, answerResult.inputTokens, answerResult.outputTokens, answerResult.cost,
    );
    insertQaRun(db, {
      mode: 'structx-mcp',
      question: args.question,
      input_tokens: answerResult.inputTokens,
      output_tokens: answerResult.outputTokens,
      total_tokens: answerResult.inputTokens + answerResult.outputTokens,
      cost_usd: answerResult.cost,
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
        inputTokens: answerResult.inputTokens,
        outputTokens: answerResult.outputTokens,
        cost: answerResult.cost,
        graphQueryTimeMs,
      },
    };
  }));
}
