import type { LLMProvider } from '../providers/interface';
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
  provider: LLMProvider
): Promise<AnswerResult> {
  const startTime = Date.now();

  const response = await provider.chat({
    model,
    maxTokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `${context}\n\nQuestion: ${question}`,
      },
    ],
  });

  const responseTimeMs = Date.now() - startTime;

  return {
    answer: response.text,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    cost: estimateCost(model, response.inputTokens, response.outputTokens),
    responseTimeMs,
  };
}
