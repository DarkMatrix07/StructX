import { estimateTokens, estimateCost } from '../utils/tokens';

export interface CostEstimate {
  totalFunctions: number;
  batches: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCost: number;
  model: string;
}

export function estimateAnalysisCost(
  functionCount: number,
  batchSize: number,
  model: string
): CostEstimate {
  const batches = Math.ceil(functionCount / batchSize);

  // ~400 input tokens per function + 200 overhead per batch
  const inputTokensPerBatch = batchSize * 400 + 200;
  const estimatedInputTokens = batches * inputTokensPerBatch;

  // ~100 output tokens per function
  const estimatedOutputTokens = functionCount * 100;

  const estimatedCost = estimateCost(model, estimatedInputTokens, estimatedOutputTokens);

  return {
    totalFunctions: functionCount,
    batches,
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedCost,
    model,
  };
}

export function formatCostEstimate(estimate: CostEstimate): string {
  return [
    `Functions to analyze: ${estimate.totalFunctions}`,
    `Batches: ${estimate.batches}`,
    `Estimated tokens: ~${(estimate.estimatedInputTokens + estimate.estimatedOutputTokens).toLocaleString()} total`,
    `Estimated cost: $${estimate.estimatedCost.toFixed(4)} (using ${estimate.model})`,
  ].join('\n');
}
