export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LLMResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LLMProvider {
  chat(opts: {
    model: string;
    maxTokens: number;
    messages: LLMMessage[];
    system?: string;
  }): Promise<LLMResponse>;
}
