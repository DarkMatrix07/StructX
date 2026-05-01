import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, LLMMessage, LLMResponse } from './interface';

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async chat(opts: {
    model: string;
    maxTokens: number;
    messages: LLMMessage[];
    system?: string;
  }): Promise<LLMResponse> {
    const response = await this.client.messages.create({
      model: opts.model,
      max_tokens: opts.maxTokens,
      messages: opts.messages.map(m => ({ role: m.role, content: m.content })),
      ...(opts.system ? { system: opts.system } : {}),
    });

    const text = response.content
      .filter(block => block.type === 'text')
      .map(block => (block as any).text)
      .join('');

    return {
      text,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    };
  }
}
