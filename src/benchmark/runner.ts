import type Database from 'better-sqlite3';
import type { StructXConfig } from '../config';
import { getLlmConfig } from '../config';
import { BENCHMARK_QUESTIONS } from './questions';
import { runBaseline } from './baseline';
import { classifyQuestion } from '../query/classifier';
import { directLookup, relationshipQuery, semanticSearch, domainQuery, impactAnalysis } from '../query/retriever';
import { buildContext } from '../query/context-builder';
import { generateAnswer } from '../query/answerer';
import { insertQaRun } from '../db/queries';
import { logger } from '../utils/logger';

export interface BenchmarkRunResult {
  question: string;
  structx: {
    answer: string;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    responseTimeMs: number;
    functionsRetrieved: number;
    graphQueryTimeMs: number;
  } | null;
  traditional: {
    answer: string;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    responseTimeMs: number;
    filesAccessed: number;
  } | null;
}

export async function runBenchmark(
  db: Database.Database,
  config: StructXConfig,
  questions?: string[]
): Promise<BenchmarkRunResult[]> {
  const questionList = questions || BENCHMARK_QUESTIONS;
  const results: BenchmarkRunResult[] = [];

  for (let i = 0; i < questionList.length; i++) {
    const question = questionList[i];
    console.log(`\n[${i + 1}/${questionList.length}] "${question}"`);

    const result: BenchmarkRunResult = { question, structx: null, traditional: null };

    // Run StructX agent
    try {
      console.log('  Running StructX agent...');
      const classification = await classifyQuestion(question, config.classifierModel, getLlmConfig(config));

      const graphQueryStart = Date.now();
      let retrieved;
      switch (classification.strategy) {
        case 'direct':
          retrieved = directLookup(db, classification.functionName || '');
          break;
        case 'relationship':
          retrieved = relationshipQuery(db, classification.functionName || '', classification.direction || 'callers');
          break;
        case 'semantic':
          retrieved = semanticSearch(db, classification.keywords);
          break;
        case 'domain':
          retrieved = domainQuery(db, classification.domain || 'other');
          break;
        case 'impact':
          retrieved = impactAnalysis(db, classification.functionName || '');
          break;
        default:
          retrieved = semanticSearch(db, classification.keywords);
      }
      const graphQueryTimeMs = Date.now() - graphQueryStart;

      const context = buildContext(retrieved, question);
      const answerResult = await generateAnswer(question, context, config.answerModel, getLlmConfig(config));

      result.structx = {
        answer: answerResult.answer,
        inputTokens: answerResult.inputTokens,
        outputTokens: answerResult.outputTokens,
        cost: answerResult.cost,
        responseTimeMs: answerResult.responseTimeMs,
        functionsRetrieved: retrieved.functions.length,
        graphQueryTimeMs,
      };

      insertQaRun(db, {
        mode: 'structx',
        question,
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

      console.log(`  StructX: ${answerResult.inputTokens} in / ${answerResult.outputTokens} out | $${answerResult.cost.toFixed(4)} | ${answerResult.responseTimeMs}ms`);
    } catch (err: any) {
      logger.error(`StructX agent failed: ${err.message}`);
      console.log(`  StructX: FAILED - ${err.message}`);
    }

    // Run Traditional agent
    try {
      console.log('  Running Traditional agent...');
      const baseline = await runBaseline(question, config.repoPath, config.answerModel, getLlmConfig(config));

      result.traditional = {
        answer: baseline.answer,
        inputTokens: baseline.inputTokens,
        outputTokens: baseline.outputTokens,
        cost: baseline.cost,
        responseTimeMs: baseline.responseTimeMs,
        filesAccessed: baseline.filesAccessed,
      };

      insertQaRun(db, {
        mode: 'traditional',
        question,
        input_tokens: baseline.inputTokens,
        output_tokens: baseline.outputTokens,
        total_tokens: baseline.inputTokens + baseline.outputTokens,
        cost_usd: baseline.cost,
        response_time_ms: baseline.responseTimeMs,
        files_accessed: baseline.filesAccessed,
        functions_retrieved: null,
        graph_query_time_ms: null,
        answer_text: baseline.answer,
      });

      console.log(`  Traditional: ${baseline.inputTokens} in / ${baseline.outputTokens} out | $${baseline.cost.toFixed(4)} | ${baseline.responseTimeMs}ms`);
    } catch (err: any) {
      logger.error(`Traditional agent failed: ${err.message}`);
      console.log(`  Traditional: FAILED - ${err.message}`);
    }

    results.push(result);
  }

  return results;
}
