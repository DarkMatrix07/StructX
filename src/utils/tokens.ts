// Simple token estimation without external dependencies.
// Rough heuristic: ~4 characters per token for English/code.

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Pricing per million tokens (as of 2025)
const PRICING: Record<string, { input: number; output: number }> = {
  // Anthropic
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
  'claude-sonnet-4-5-20250929': { input: 3.00, output: 15.00 },

  // Gemini (direct API)
  'gemini-2.0-flash': { input: 0.10, output: 0.40 },
  'gemini-2.5-flash': { input: 0.30, output: 2.50 },
  'gemini-2.5-pro': { input: 1.25, output: 10.00 },
  'gemini-2.5-pro-preview-06-05': { input: 1.25, output: 10.00 },

  // OpenRouter (approximate — varies by underlying provider routing).
  // The first two are what OPENROUTER_DEFAULTS actually selects; without
  // them every OpenRouter run silently fell through to the generic fallback
  // below, making `structx_costs` wrong for the default configuration.
  'anthropic/claude-haiku-4.5': { input: 0.80, output: 4.00 },
  'anthropic/claude-sonnet-4.5': { input: 3.00, output: 15.00 },
  'anthropic/claude-3.5-sonnet': { input: 3.00, output: 15.00 },
  'google/gemini-2.0-flash-001': { input: 0.10, output: 0.40 },
};

// Prefer the exact charge a provider reported over our local estimate. The
// price table can only cover models we have hardcoded; OpenRouter alone routes
// to hundreds, and an unknown model silently falls back to $1/$5 per M — which
// overstated a real mistral-small run by ~37x. When the provider tells us what
// it charged, that is the truth.
export function resolveCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  reportedCostUsd?: number,
): number {
  if (typeof reportedCostUsd === 'number' && Number.isFinite(reportedCostUsd)) {
    return reportedCostUsd;
  }
  return estimateCost(model, inputTokens, outputTokens);
}

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const price = PRICING[model] ?? { input: 1.0, output: 5.0 };
  const inputCost = (inputTokens / 1_000_000) * price.input;
  const outputCost = (outputTokens / 1_000_000) * price.output;
  return inputCost + outputCost;
}
