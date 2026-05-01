// Unified LLM client. StructX talks to Anthropic directly or to any
// OpenAI-compatible endpoint (OpenRouter, Together, local servers) through a
// single `complete()` interface. All model-specific tuning (max_tokens,
// max_output_tokens, temperature defaults) lives behind this boundary so the
// analyzer/classifier/answerer don't need to know the provider.

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

export type LlmProvider = 'anthropic' | 'openrouter';

export interface LlmClientConfig {
  provider: LlmProvider;
  apiKey: string;
  baseURL?: string;
}

export interface LlmCompleteRequest {
  model: string;
  prompt: string;
  maxTokens: number;
  system?: string;
  // Optional follow-up turn for retry-on-validation flows.
  assistantPriorTurn?: string;
  retryUserMessage?: string;
}

export interface LlmCompleteResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmClient {
  provider: LlmProvider;
  complete(req: LlmCompleteRequest): Promise<LlmCompleteResponse>;
}

export function createLlmClient(cfg: LlmClientConfig): LlmClient {
  if (cfg.provider === 'openrouter') {
    return new OpenRouterClient(cfg);
  }
  return new AnthropicClient(cfg);
}

class AnthropicClient implements LlmClient {
  provider: LlmProvider = 'anthropic';
  private client: Anthropic;

  constructor(cfg: LlmClientConfig) {
    this.client = new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseURL });
  }

  async complete(req: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: req.prompt },
    ];
    if (req.assistantPriorTurn && req.retryUserMessage) {
      messages.push({ role: 'assistant', content: req.assistantPriorTurn });
      messages.push({ role: 'user', content: req.retryUserMessage });
    }

    const response = await this.client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens,
      ...(req.system ? { system: req.system } : {}),
      messages,
    });

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as { text: string }).text)
      .join('');

    return {
      text,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    };
  }
}

class OpenRouterClient implements LlmClient {
  provider: LlmProvider = 'openrouter';
  private client: OpenAI;

  constructor(cfg: LlmClientConfig) {
    this.client = new OpenAI({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL ?? 'https://openrouter.ai/api/v1',
      // Headers OpenRouter uses for attribution; harmless on other gateways.
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/structx/structx',
        'X-Title': 'StructX',
      },
    });
  }

  async complete(req: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    messages.push({ role: 'user', content: req.prompt });
    if (req.assistantPriorTurn && req.retryUserMessage) {
      messages.push({ role: 'assistant', content: req.assistantPriorTurn });
      messages.push({ role: 'user', content: req.retryUserMessage });
    }

    const response = await this.client.chat.completions.create({
      model: req.model,
      max_tokens: req.maxTokens,
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
