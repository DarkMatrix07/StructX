import OpenAI from 'openai';
import type { LLMProvider, LLMMessage, LLMResponse } from './interface';

export class OpenRouterProvider implements LLMProvider {
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL: 'https://openrouter.ai/api/v1',
    });
  }

  async chat(opts: {
    model: string;
    maxTokens: number;
    messages: LLMMessage[];
    system?: string;
  }): Promise<LLMResponse> {
    const messages: OpenAI.ChatCompletionMessageParam[] = [];

    if (opts.system) {
      messages.push({ role: 'system', content: opts.system });
    }

    for (const m of opts.messages) {
      messages.push({ role: m.role, content: m.content });
    }

    const response = await this.client.chat.completions.create({
      model: opts.model,
      max_tokens: opts.maxTokens,
      messages,
    });

    const text = response.choices[0]?.message?.content ?? '';

    return {
      text,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    };
  }
}
