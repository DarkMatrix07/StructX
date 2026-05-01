import { GoogleGenerativeAI } from '@google/generative-ai';
import type { LLMProvider, LLMMessage, LLMResponse } from './interface';

export class GeminiProvider implements LLMProvider {
  private genAI: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  async chat(opts: {
    model: string;
    maxTokens: number;
    messages: LLMMessage[];
    system?: string;
  }): Promise<LLMResponse> {
    const model = this.genAI.getGenerativeModel({
      model: opts.model,
      ...(opts.system ? { systemInstruction: opts.system } : {}),
      generationConfig: {
        maxOutputTokens: opts.maxTokens,
      },
    });

    // Build Gemini contents from messages
    const contents = opts.messages.map(m => ({
      role: m.role === 'assistant' ? 'model' as const : 'user' as const,
      parts: [{ text: m.content }],
    }));

    const result = await model.generateContent({ contents });
    const response = result.response;
    const text = response.text();
    const usage = response.usageMetadata;

    return {
      text,
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
    };
  }
}
