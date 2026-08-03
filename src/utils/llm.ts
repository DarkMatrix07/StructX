// Unified LLM client. StructX talks to Anthropic directly, Google Gemini
// directly, or any OpenAI-compatible endpoint (OpenRouter, Together, local
// servers) through a single `complete()` interface. All model-specific
// tuning (max_tokens, temperature defaults, system-message placement) lives
// behind this boundary so the analyzer/classifier/answerer don't need to
// know the provider.

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';

export type LlmProvider = 'anthropic' | 'gemini' | 'openrouter';

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
  // Exact charge for this call, when the provider reports one. OpenRouter
  // returns `usage.cost` on every response (streaming included), which beats
  // estimating from a local price table — that table cannot know the hundreds
  // of models OpenRouter routes to, and silently fell back to $1/$5 per M,
  // overstating a real mistral-small run by ~37x. Undefined for providers
  // that do not report cost; callers fall back to estimateCost then.
  costUsd?: number;
}

export interface LlmClient {
  provider: LlmProvider;
  complete(req: LlmCompleteRequest): Promise<LlmCompleteResponse>;
  // Streaming variant — invokes onChunk for each text delta as the model
  // generates, then resolves with the full final text and usage. Implementers
  // should accumulate the chunks themselves and return the same text the
  // non-streaming `complete` would have returned.
  streamComplete(req: LlmCompleteRequest, onChunk: (chunk: string) => void): Promise<LlmCompleteResponse>;
}

export function createLlmClient(cfg: LlmClientConfig): LlmClient {
  if (cfg.provider === 'openrouter') {
    return new OpenRouterClient(cfg);
  }
  if (cfg.provider === 'gemini') {
    return new GeminiClient(cfg);
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

  async streamComplete(req: LlmCompleteRequest, onChunk: (chunk: string) => void): Promise<LlmCompleteResponse> {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: req.prompt },
    ];
    if (req.assistantPriorTurn && req.retryUserMessage) {
      messages.push({ role: 'assistant', content: req.assistantPriorTurn });
      messages.push({ role: 'user', content: req.retryUserMessage });
    }

    const stream = this.client.messages.stream({
      model: req.model,
      max_tokens: req.maxTokens,
      ...(req.system ? { system: req.system } : {}),
      messages,
    });

    let fullText = '';
    stream.on('text', (delta: string) => {
      fullText += delta;
      onChunk(delta);
    });

    const finalMessage = await stream.finalMessage();
    return {
      text: fullText,
      inputTokens: finalMessage.usage?.input_tokens ?? 0,
      outputTokens: finalMessage.usage?.output_tokens ?? 0,
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
    const reportedCost = (response.usage as { cost?: number } | undefined)?.cost;
    return {
      text,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      ...(typeof reportedCost === 'number' ? { costUsd: reportedCost } : {}),
    };
  }

  async streamComplete(req: LlmCompleteRequest, onChunk: (chunk: string) => void): Promise<LlmCompleteResponse> {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    messages.push({ role: 'user', content: req.prompt });
    if (req.assistantPriorTurn && req.retryUserMessage) {
      messages.push({ role: 'assistant', content: req.assistantPriorTurn });
      messages.push({ role: 'user', content: req.retryUserMessage });
    }

    const stream = await this.client.chat.completions.create({
      model: req.model,
      max_tokens: req.maxTokens,
      messages,
      stream: true,
      // OpenRouter usage stats only arrive on the final chunk when this is set.
      stream_options: { include_usage: true },
    });

    let fullText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd: number | undefined;
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? '';
      if (delta) {
        fullText += delta;
        onChunk(delta);
      }
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
        outputTokens = chunk.usage.completion_tokens ?? outputTokens;
        // Exactly one frame in the stream carries usage; it includes cost.
        const reported = (chunk.usage as { cost?: number }).cost;
        if (typeof reported === 'number') costUsd = reported;
      }
    }

    return { text: fullText, inputTokens, outputTokens, ...(costUsd !== undefined ? { costUsd } : {}) };
  }
}

// Gemini lives behind a different SDK (REST + Google's wrapper) but the
// shape we need is identical: send a system prompt + a user turn (and
// optionally an assistant retry turn), get text + token counts back.
class GeminiClient implements LlmClient {
  provider: LlmProvider = 'gemini';
  private genAI: GoogleGenerativeAI;

  constructor(cfg: LlmClientConfig) {
    this.genAI = new GoogleGenerativeAI(cfg.apiKey);
  }

  async complete(req: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    const model = this.genAI.getGenerativeModel({
      model: req.model,
      ...(req.system ? { systemInstruction: req.system } : {}),
      generationConfig: {
        maxOutputTokens: req.maxTokens,
      },
    });

    // Gemini uses 'model' instead of 'assistant' for prior turns.
    const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [
      { role: 'user', parts: [{ text: req.prompt }] },
    ];
    if (req.assistantPriorTurn && req.retryUserMessage) {
      contents.push({ role: 'model', parts: [{ text: req.assistantPriorTurn }] });
      contents.push({ role: 'user', parts: [{ text: req.retryUserMessage }] });
    }

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

  async streamComplete(req: LlmCompleteRequest, onChunk: (chunk: string) => void): Promise<LlmCompleteResponse> {
    const model = this.genAI.getGenerativeModel({
      model: req.model,
      ...(req.system ? { systemInstruction: req.system } : {}),
      generationConfig: {
        maxOutputTokens: req.maxTokens,
      },
    });

    const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [
      { role: 'user', parts: [{ text: req.prompt }] },
    ];
    if (req.assistantPriorTurn && req.retryUserMessage) {
      contents.push({ role: 'model', parts: [{ text: req.assistantPriorTurn }] });
      contents.push({ role: 'user', parts: [{ text: req.retryUserMessage }] });
    }

    const result = await model.generateContentStream({ contents });
    let fullText = '';
    for await (const chunk of result.stream) {
      const delta = chunk.text();
      if (delta) {
        fullText += delta;
        onChunk(delta);
      }
    }

    // Final aggregated response carries the usage metadata.
    const finalResponse = await result.response;
    const usage = finalResponse.usageMetadata;
    return {
      text: fullText,
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
    };
  }
}
