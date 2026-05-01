import Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
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
import { estimateCost } from '../utils/tokens';
import { logger } from '../utils/logger';

export interface AnalyzeResult {
  analyzed: number;
  cached: number;
  failed: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
}

export async function analyzeBatch(
  db: Database.Database,
  queueItems: Array<{ id: number; function_id: number }>,
  model: string,
  apiKey: string
): Promise<AnalyzeResult> {
  const client = new Anthropic({ apiKey });
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
    const response = await client.messages.create({
      model,
      max_tokens: uncachedFunctions.length * 200,
      messages: [{ role: 'user', content: batchPrompt }],
    });

    responseText = response.content
      .filter(block => block.type === 'text')
      .map(block => (block as any).text)
      .join('');

    inputTokens = response.usage?.input_tokens ?? 0;
    outputTokens = response.usage?.output_tokens ?? 0;
    result.totalInputTokens += inputTokens;
    result.totalOutputTokens += outputTokens;
    result.totalCost += estimateCost(model, inputTokens, outputTokens);
  } catch (err: any) {
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
      const retryResponse = await client.messages.create({
        model,
        max_tokens: uncachedFunctions.length * 200,
        messages: [
          { role: 'user', content: batchPrompt },
          { role: 'assistant', content: responseText },
          { role: 'user', content: `Your previous response had JSON errors: ${validation.errors.join('; ')}. Please respond with ONLY a valid JSON array.` },
        ],
      });

      const retryText = retryResponse.content
        .filter(block => block.type === 'text')
        .map(block => (block as any).text)
        .join('');

      result.totalInputTokens += retryResponse.usage?.input_tokens ?? 0;
      result.totalOutputTokens += retryResponse.usage?.output_tokens ?? 0;
      result.totalCost += estimateCost(model, retryResponse.usage?.input_tokens ?? 0, retryResponse.usage?.output_tokens ?? 0);

      validation = validateSemanticResponse(retryText);
      if (validation.valid || validation.results.length > 0) {
        responseText = retryText;
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
}

export async function analyzeTypes(
  db: Database.Database,
  model: string,
  apiKey: string
): Promise<SimpleAnalyzeResult> {
  const client = new Anthropic({ apiKey });
  const result: SimpleAnalyzeResult = { analyzed: 0, failed: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0 };

  const types = getAllTypes(db).filter(t => !t.semantic_analyzed_at);
  if (types.length === 0) return result;

  // Process in batches of 10
  for (let i = 0; i < types.length; i += 10) {
    const batch = types.slice(i, i + 10);
    const prompt = buildTypeAnalysisPrompt(batch.map(t => ({
      name: t.name,
      kind: t.kind,
      full_text: t.full_text,
    })));

    try {
      const response = await client.messages.create({
        model,
        max_tokens: batch.length * 100,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = response.content
        .filter(block => block.type === 'text')
        .map(block => (block as any).text)
        .join('');

      result.totalInputTokens += response.usage?.input_tokens ?? 0;
      result.totalOutputTokens += response.usage?.output_tokens ?? 0;
      result.totalCost += estimateCost(model, response.usage?.input_tokens ?? 0, response.usage?.output_tokens ?? 0);

      const cleaned = text.replace(/^```json?\s*/m, '').replace(/```\s*$/m, '').trim();
      const parsed = JSON.parse(cleaned) as Array<{ name: string; purpose: string }>;

      for (const item of parsed) {
        const typeRow = batch.find(t => t.name === item.name);
        if (typeRow) {
          updateTypePurpose(db, typeRow.id, item.purpose);
          result.analyzed++;
        }
      }
    } catch (err: any) {
      logger.error(`Type analysis failed: ${err.message}`);
      result.failed += batch.length;
    }
  }

  return result;
}

export async function analyzeRoutes(
  db: Database.Database,
  model: string,
  apiKey: string
): Promise<SimpleAnalyzeResult> {
  const client = new Anthropic({ apiKey });
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
      const response = await client.messages.create({
        model,
        max_tokens: batch.length * 100,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = response.content
        .filter(block => block.type === 'text')
        .map(block => (block as any).text)
        .join('');

      result.totalInputTokens += response.usage?.input_tokens ?? 0;
      result.totalOutputTokens += response.usage?.output_tokens ?? 0;
      result.totalCost += estimateCost(model, response.usage?.input_tokens ?? 0, response.usage?.output_tokens ?? 0);

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
      logger.error(`Route analysis failed: ${err.message}`);
      result.failed += batch.length;
    }
  }

  return result;
}

export async function analyzeFileSummaries(
  db: Database.Database,
  model: string,
  apiKey: string
): Promise<SimpleAnalyzeResult> {
  const client = new Anthropic({ apiKey });
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
        path: fileMap.get(s.file_id) || 'unknown',
        exports,
        function_count: s.function_count,
        type_count: s.type_count,
        route_count: s.route_count,
        loc: s.loc,
      };
    }));

    try {
      const response = await client.messages.create({
        model,
        max_tokens: batch.length * 100,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = response.content
        .filter(block => block.type === 'text')
        .map(block => (block as any).text)
        .join('');

      result.totalInputTokens += response.usage?.input_tokens ?? 0;
      result.totalOutputTokens += response.usage?.output_tokens ?? 0;
      result.totalCost += estimateCost(model, response.usage?.input_tokens ?? 0, response.usage?.output_tokens ?? 0);

      const cleaned = text.replace(/^```json?\s*/m, '').replace(/```\s*$/m, '').trim();
      const parsed = JSON.parse(cleaned) as Array<{ path: string; purpose: string }>;

      for (const item of parsed) {
        const summaryRow = batch.find(s => fileMap.get(s.file_id) === item.path);
        if (summaryRow) {
          updateFileSummaryPurpose(db, summaryRow.id, item.purpose);
          result.analyzed++;
        }
      }
    } catch (err: any) {
      logger.error(`File summary analysis failed: ${err.message}`);
      result.failed += batch.length;
    }
  }

  return result;
}
