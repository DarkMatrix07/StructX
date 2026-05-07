import { createLlmClient, type LlmClientConfig } from '../utils/llm';
import { estimateCost } from '../utils/tokens';

export interface AnswerResult {
  answer: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  responseTimeMs: number;
}

const SYSTEM_PROMPT = `You are a code intelligence assistant. You answer developer questions about a TypeScript codebase using structured context retrieved from a code graph database.

The context may include functions, types (interfaces/type aliases/enums), HTTP routes/endpoints, file summaries, and constants extracted from the codebase.

Rules:
- Answer based ONLY on the provided context
- Be concise and specific
- Reference function names, type names, route paths, and file locations when relevant
- If the context doesn't contain enough information, say so clearly
- Do not make up information not present in the context
- When describing routes, include the HTTP method, path, and handler details
- When describing types, include the full definition when available`;

export async function generateAnswer(
  question: string,
  context: string,
  model: string,
  llmConfig: LlmClientConfig,
  maxTokens = 1024,
): Promise<AnswerResult> {
  const client = createLlmClient(llmConfig);
  const startTime = Date.now();

  const { text, inputTokens, outputTokens } = await client.complete({
    model,
    maxTokens,
    system: SYSTEM_PROMPT,
    prompt: `${context}\n\nQuestion: ${question}`,
  });

  const responseTimeMs = Date.now() - startTime;

  return {
    answer: text,
    inputTokens,
    outputTokens,
    cost: estimateCost(model, inputTokens, outputTokens),
    responseTimeMs,
  };
}

// Streaming variant — fires onChunk for each text delta as the model
// generates, then resolves with the same AnswerResult shape generateAnswer
// returns. Used by the MCP `structx_ask` tool when the caller requested
// progress notifications via _meta.progressToken; otherwise the non-
// streaming generateAnswer path is identical and one fewer round trip.
export async function generateAnswerStreaming(
  question: string,
  context: string,
  model: string,
  llmConfig: LlmClientConfig,
  maxTokens: number,
  onChunk: (chunk: string) => void,
): Promise<AnswerResult> {
  const client = createLlmClient(llmConfig);
  const startTime = Date.now();

  const { text, inputTokens, outputTokens } = await client.streamComplete({
    model,
    maxTokens,
    system: SYSTEM_PROMPT,
    prompt: `${context}\n\nQuestion: ${question}`,
  }, onChunk);

  const responseTimeMs = Date.now() - startTime;

  return {
    answer: text,
    inputTokens,
    outputTokens,
    cost: estimateCost(model, inputTokens, outputTokens),
    responseTimeMs,
  };
}
