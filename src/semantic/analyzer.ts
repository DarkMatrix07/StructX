import type Database from 'better-sqlite3';
import { createLlmClient, type LlmClient, type LlmClientConfig } from '../utils/llm';
import type { FunctionRow } from '../db/queries';
import {
  getFunctionById, getCallees, getCallersByName,
  updateSemanticFields, getCachedResponse, insertCachedResponse,
  updateAnalysisStatus, rebuildFtsIndex, rebuildAllFtsIndexes,
  getAllTypes, updateTypePurpose,
  getAllRoutes, updateRoutePurpose,
  getAllFileSummaries, getAllFiles, updateFileSummaryPurpose,
} from '../db/queries';
import {
  buildBatchPrompt, hashFunctionCacheKey,
  buildTypeAnalysisPrompt, buildRouteAnalysisPrompt, buildFileSummaryPrompt,
  type PromptFunction
} from './prompt';
import { validateSemanticResponse, type SemanticResult } from './validator';
import { resolveCost } from '../utils/tokens';
import { logger } from '../utils/logger';
import { normalizeRepoPath } from '../utils/paths';

type LlmSource = LlmClientConfig | LlmClient;

function resolveLlmClient(source: LlmSource): LlmClient {
  if (typeof (source as LlmClient).complete === 'function') {
    return source as LlmClient;
  }
  return createLlmClient(source as LlmClientConfig);
}

export interface AnalyzeResult {
  analyzed: number;
  cached: number;
  failed: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  // True when the LLM provider returned a fatal billing/auth error
  // (e.g. 402 insufficient credits, 401 invalid key). Callers MUST stop
  // the outer batch loop — there is no point in spending more time
  // hammering an endpoint that will keep rejecting every call.
  aborted?: boolean;
  abortReason?: string;
}

// Detect provider errors that mean every subsequent call will also fail.
// Battle-tested case: tRPC analyze on an out-of-credit OpenRouter key
// emitted 1100 doomed requests before reporting "Failed: 1100" with no
// actionable message. Now we trip the abort flag on the first 402/401
// and the CLI surfaces the reason cleanly.
export function isFatalProviderError(err: any): { fatal: boolean; reason: string } {
  const status = err?.status ?? err?.code;
  const message: string = err?.message ?? String(err ?? '');
  if (status === 402 || /insufficient credits|payment required/i.test(message)) {
    return { fatal: true, reason: 'Provider returned 402 — out of credits. Top up at the provider dashboard or switch providers in .structx/config.json.' };
  }
  if (status === 401 || /invalid api key|authentication/i.test(message)) {
    return { fatal: true, reason: 'Provider authentication failed (401). Check the API key in .structx/config.json or env (ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENROUTER_API_KEY).' };
  }
  return { fatal: false, reason: '' };
}

export async function analyzeBatch(
  db: Database.Database,
  queueItems: Array<{ id: number; function_id: number }>,
  model: string,
  llmConfig: LlmSource,
): Promise<AnalyzeResult> {
  const client = resolveLlmClient(llmConfig);
  const result: AnalyzeResult = { analyzed: 0, cached: 0, failed: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0 };

  // Build prompt functions from queue items
  const promptFunctions: PromptFunction[] = [];
  const functionMap = new Map<string, { queueId: number; functionId: number; cacheKey: string }>();

  for (const item of queueItems) {
    const fn = getFunctionById(db, item.function_id);
    if (!fn) {
      updateAnalysisStatus(db, item.id, 'failed');
      result.failed++;
      continue;
    }

    // Get file path for location
    const file = db.prepare('SELECT path FROM files WHERE id = ?').get(fn.file_id) as any;
    const location = file ? `${file.path}:${fn.start_line}` : `unknown:${fn.start_line}`;

    // Get calls
    const callees = getCallees(db, fn.id);
    const callers = getCallersByName(db, fn.name);

    promptFunctions.push({
      function_name: fn.name,
      location,
      signature: fn.signature,
      code: fn.body,
      calls: callees.map(c => c.callee_name),
      called_by: callers.map(c => {
        const callerFn = getFunctionById(db, c.caller_function_id);
        return callerFn?.name || 'unknown';
      }),
    });

    functionMap.set(fn.name, {
      queueId: item.id,
      functionId: fn.id,
      cacheKey: hashFunctionCacheKey(fn.code_hash, model),
    });
  }

  if (promptFunctions.length === 0) return result;

  // Per-function cache lookup — keyed by (code_hash, model, prompt_version) so cache hits
  // survive different batch compositions.
  const uncachedFunctions: PromptFunction[] = [];

  for (const pf of promptFunctions) {
    const mapping = functionMap.get(pf.function_name)!;
    const cached = getCachedResponse(db, mapping.functionId, mapping.cacheKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached.response_json);
        updateAnalysisStatus(db, mapping.queueId, 'done');
        applySemanticResult(db, mapping.functionId, parsed);
        result.cached++;
      } catch {
        uncachedFunctions.push(pf);
      }
    } else {
      uncachedFunctions.push(pf);
    }
  }

  // If everything was cached, done
  if (uncachedFunctions.length === 0) {
    return result;
  }

  // Build prompt for uncached functions only
  const batchPrompt = buildBatchPrompt(uncachedFunctions);

  // Call LLM
  let responseText: string;
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    const out = await client.complete({
      model,
      prompt: batchPrompt,
      maxTokens: uncachedFunctions.length * 200,
    });
    responseText = out.text;
    inputTokens = out.inputTokens;
    outputTokens = out.outputTokens;
    result.totalInputTokens += inputTokens;
    result.totalOutputTokens += outputTokens;
    result.totalCost += resolveCost(model, inputTokens, outputTokens, out.costUsd);
  } catch (err: any) {
    const fatal = isFatalProviderError(err);
    if (fatal.fatal) {
      // Don't keep retrying — every subsequent call hits the same wall.
      // Mark this batch's items as failed so they re-enqueue on next run,
      // signal abort to the CLI loop, and surface the actionable reason.
      logger.error(fatal.reason);
      for (const pf of uncachedFunctions) {
        const mapping = functionMap.get(pf.function_name);
        if (mapping) {
          updateAnalysisStatus(db, mapping.queueId, 'failed');
          result.failed++;
        }
      }
      result.aborted = true;
      result.abortReason = fatal.reason;
      return result;
    }
    logger.error(`LLM API call failed: ${err.message}`);
    for (const pf of uncachedFunctions) {
      const mapping = functionMap.get(pf.function_name);
      if (mapping) {
        updateAnalysisStatus(db, mapping.queueId, 'failed');
        result.failed++;
      }
    }
    return result;
  }

  // Validate response
  let validation = validateSemanticResponse(responseText);

  // Retry once on failure
  if (!validation.valid && validation.results.length === 0) {
    logger.warn(`Validation failed, retrying. Errors: ${validation.errors.join('; ')}`);
    try {
      const retry = await client.complete({
        model,
        prompt: batchPrompt,
        maxTokens: uncachedFunctions.length * 200,
        assistantPriorTurn: responseText,
        retryUserMessage: `Your previous response had JSON errors: ${validation.errors.join('; ')}. Please respond with ONLY a valid JSON array.`,
      });
      result.totalInputTokens += retry.inputTokens;
      result.totalOutputTokens += retry.outputTokens;
      result.totalCost += resolveCost(model, retry.inputTokens, retry.outputTokens, retry.costUsd);

      validation = validateSemanticResponse(retry.text);
      if (validation.valid || validation.results.length > 0) {
        responseText = retry.text;
      }
    } catch (retryErr: any) {
      logger.error(`Retry failed: ${retryErr.message}`);
    }
  }

  // Apply results
  for (const semanticResult of validation.results) {
    const mapping = functionMap.get(semanticResult.function_name);
    if (!mapping) {
      logger.warn(`No mapping found for function: ${semanticResult.function_name}`);
      continue;
    }

    applySemanticResult(db, mapping.functionId, semanticResult);
    updateAnalysisStatus(db, mapping.queueId, 'done');

    // Cache the result keyed per-function so subsequent runs hit even if batched differently.
    insertCachedResponse(
      db, mapping.functionId, mapping.cacheKey, model,
      inputTokens, outputTokens, result.totalCost,
      JSON.stringify(semanticResult)
    );

    result.analyzed++;
  }

  // Mark any unmatched as failed
  for (const pf of uncachedFunctions) {
    const mapping = functionMap.get(pf.function_name);
    if (!mapping) continue;
    const matched = validation.results.some(r => r.function_name === pf.function_name);
    if (!matched) {
      updateAnalysisStatus(db, mapping.queueId, 'failed');
      result.failed++;
    }
  }

  return result;
}

function applySemanticResult(db: Database.Database, functionId: number, result: SemanticResult): void {
  updateSemanticFields(db, functionId, {
    purpose: result.purpose,
    behavior_summary: result.behavior,
    side_effects_json: JSON.stringify(result.side_effects),
    domain: result.domain,
    complexity: result.complexity,
  });
}

export function rebuildSearchIndex(db: Database.Database): void {
  rebuildAllFtsIndexes(db);
}

export interface SimpleAnalyzeResult {
  analyzed: number;
  failed: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  aborted?: boolean;
  abortReason?: string;
}

export async function analyzeTypes(
  db: Database.Database,
  model: string,
  llmConfig: LlmSource,
): Promise<SimpleAnalyzeResult> {
  const client = resolveLlmClient(llmConfig);
  const result: SimpleAnalyzeResult = { analyzed: 0, failed: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0 };

  const types = getAllTypes(db).filter(t => !t.semantic_analyzed_at);
  if (types.length === 0) return result;

  // Process in batches of 10
  for (let i = 0; i < types.length; i += 10) {
    const batch = types.slice(i, i + 10);
    const prompt = buildTypeAnalysisPrompt(batch.map(t => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      full_text: t.full_text,
    })));

    try {
      const { text, inputTokens, outputTokens, costUsd } = await client.complete({
        model,
        prompt,
        maxTokens: batch.length * 100,
      });

      result.totalInputTokens += inputTokens;
      result.totalOutputTokens += outputTokens;
      result.totalCost += resolveCost(model, inputTokens, outputTokens, costUsd);

      const cleaned = text.replace(/^```json?\s*/m, '').replace(/```\s*$/m, '').trim();
      const parsed = JSON.parse(cleaned) as Array<{ id?: number; name: string; purpose: string }>;

      for (const item of parsed) {
        const typeRow = typeof item.id === 'number'
          ? batch.find(t => t.id === item.id)
          : batch.find(t => t.name === item.name);
        if (typeRow) {
          updateTypePurpose(db, typeRow.id, item.purpose);
          result.analyzed++;
        }
      }
    } catch (err: any) {
      const fatal = isFatalProviderError(err);
      if (fatal.fatal) {
        logger.error(fatal.reason);
        result.failed += batch.length;
        result.aborted = true;
        result.abortReason = fatal.reason;
        return result;
      }
      logger.error(`Type analysis failed: ${err.message}`);
      result.failed += batch.length;
    }
  }

  return result;
}

export async function analyzeRoutes(
  db: Database.Database,
  model: string,
  llmConfig: LlmSource,
): Promise<SimpleAnalyzeResult> {
  const client = resolveLlmClient(llmConfig);
  const result: SimpleAnalyzeResult = { analyzed: 0, failed: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0 };

  const routes = getAllRoutes(db).filter(r => !r.semantic_analyzed_at);
  if (routes.length === 0) return result;

  for (let i = 0; i < routes.length; i += 10) {
    const batch = routes.slice(i, i + 10);
    const prompt = buildRouteAnalysisPrompt(batch.map(r => ({
      method: r.method,
      path: r.path,
      handler_body: r.handler_body,
    })));

    try {
      const { text, inputTokens, outputTokens, costUsd } = await client.complete({
        model,
        prompt,
        maxTokens: batch.length * 100,
      });

      result.totalInputTokens += inputTokens;
      result.totalOutputTokens += outputTokens;
      result.totalCost += resolveCost(model, inputTokens, outputTokens, costUsd);

      const cleaned = text.replace(/^```json?\s*/m, '').replace(/```\s*$/m, '').trim();
      const parsed = JSON.parse(cleaned) as Array<{ method: string; path: string; purpose: string }>;

      for (const item of parsed) {
        const routeRow = batch.find(r => r.method === item.method && r.path === item.path);
        if (routeRow) {
          updateRoutePurpose(db, routeRow.id, item.purpose);
          result.analyzed++;
        }
      }
    } catch (err: any) {
      const fatal = isFatalProviderError(err);
      if (fatal.fatal) {
        logger.error(fatal.reason);
        result.failed += batch.length;
        result.aborted = true;
        result.abortReason = fatal.reason;
        return result;
      }
      logger.error(`Route analysis failed: ${err.message}`);
      result.failed += batch.length;
    }
  }

  return result;
}

export async function analyzeFileSummaries(
  db: Database.Database,
  model: string,
  llmConfig: LlmSource,
): Promise<SimpleAnalyzeResult> {
  const client = resolveLlmClient(llmConfig);
  const result: SimpleAnalyzeResult = { analyzed: 0, failed: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0 };

  const summaries = getAllFileSummaries(db).filter(s => !s.semantic_analyzed_at);
  if (summaries.length === 0) return result;

  const allFiles = getAllFiles(db);
  const fileMap = new Map(allFiles.map(f => [f.id, f.path]));

  for (let i = 0; i < summaries.length; i += 10) {
    const batch = summaries.slice(i, i + 10);
    const prompt = buildFileSummaryPrompt(batch.map(s => {
      let exports: string[] = [];
      try { if (s.exports_json) exports = JSON.parse(s.exports_json); } catch {}
      return {
        id: s.id,
        path: fileMap.get(s.file_id) || 'unknown',
        exports,
        function_count: s.function_count,
        type_count: s.type_count,
        route_count: s.route_count,
        loc: s.loc,
      };
    }));

    try {
      const { text, inputTokens, outputTokens, costUsd } = await client.complete({
        model,
        prompt,
        maxTokens: batch.length * 100,
      });

      result.totalInputTokens += inputTokens;
      result.totalOutputTokens += outputTokens;
      result.totalCost += resolveCost(model, inputTokens, outputTokens, costUsd);

      const cleaned = text.replace(/^```json?\s*/m, '').replace(/```\s*$/m, '').trim();
      const parsed = JSON.parse(cleaned) as Array<{ id?: number; path: string; purpose: string }>;

      for (const item of parsed) {
        const normalizedPath = normalizeRepoPath(item.path);
        const summaryRow = typeof item.id === 'number'
          ? batch.find(s => s.id === item.id)
          : batch.find(s => normalizeRepoPath(fileMap.get(s.file_id) || '') === normalizedPath);
        if (summaryRow) {
          updateFileSummaryPurpose(db, summaryRow.id, item.purpose);
          result.analyzed++;
        }
      }
    } catch (err: any) {
      const fatal = isFatalProviderError(err);
      if (fatal.fatal) {
        logger.error(fatal.reason);
        result.failed += batch.length;
        result.aborted = true;
        result.abortReason = fatal.reason;
        return result;
      }
      logger.error(`File summary analysis failed: ${err.message}`);
      result.failed += batch.length;
    }
  }

  return result;
}
