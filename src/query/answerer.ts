import Anthropic from '@anthropic-ai/sdk';
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
  apiKey: string
): Promise<AnswerResult> {
  const client = new Anthropic({ apiKey });
  const startTime = Date.now();

  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `${context}\n\nQuestion: ${question}`,
      },
    ],
  });

  const responseTimeMs = Date.now() - startTime;

  const answer = response.content
    .filter(block => block.type === 'text')
    .map(block => (block as any).text)
    .join('');

  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;

  return {
    answer,
    inputTokens,
    outputTokens,
    cost: estimateCost(model, inputTokens, outputTokens),
    responseTimeMs,
  };
}
