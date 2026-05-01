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

  // Gemini
  'gemini-2.0-flash': { input: 0.10, output: 0.40 },
  'gemini-2.5-pro-preview-06-05': { input: 1.25, output: 10.00 },

  // OpenRouter (approximate — varies by underlying model)
  'anthropic/claude-3.5-sonnet': { input: 3.00, output: 15.00 },
};

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
