import type { LLMProvider } from './interface';
import { AnthropicProvider } from './anthropic';
import { GeminiProvider } from './gemini';
import { OpenRouterProvider } from './openrouter';

export type ProviderName = 'anthropic' | 'gemini' | 'openrouter';

export function createProvider(provider: ProviderName, apiKey: string): LLMProvider {
  switch (provider) {
    case 'anthropic':
      return new AnthropicProvider(apiKey);
    case 'gemini':
      return new GeminiProvider(apiKey);
    case 'openrouter':
      return new OpenRouterProvider(apiKey);
  }
}

export function detectProvider(keys: {
  anthropicApiKey?: string;
  geminiApiKey?: string;
  openrouterApiKey?: string;
  provider?: ProviderName | null;
}): { provider: ProviderName; apiKey: string } | null {
  if (keys.provider === 'anthropic' && keys.anthropicApiKey) {
    return { provider: 'anthropic', apiKey: keys.anthropicApiKey };
  }
  if (keys.provider === 'gemini' && keys.geminiApiKey) {
    return { provider: 'gemini', apiKey: keys.geminiApiKey };
  }
  if (keys.provider === 'openrouter' && keys.openrouterApiKey) {
    return { provider: 'openrouter', apiKey: keys.openrouterApiKey };
  }

  if (keys.anthropicApiKey) {
    return { provider: 'anthropic', apiKey: keys.anthropicApiKey };
  }
  if (keys.geminiApiKey) {
    return { provider: 'gemini', apiKey: keys.geminiApiKey };
  }
  if (keys.openrouterApiKey) {
    return { provider: 'openrouter', apiKey: keys.openrouterApiKey };
  }
  return null;
}

/** Default models per provider for each role */
export const DEFAULT_MODELS: Record<ProviderName, { analysis: string; classifier: string; answer: string }> = {
  anthropic: {
    analysis: 'claude-haiku-4-5-20251001',
    classifier: 'claude-haiku-4-5-20251001',
    answer: 'claude-sonnet-4-5-20250929',
  },
  gemini: {
    analysis: 'gemini-2.0-flash',
    classifier: 'gemini-2.0-flash',
    answer: 'gemini-2.5-pro-preview-06-05',
  },
  openrouter: {
    analysis: 'google/gemini-2.5-flash',
    classifier: 'google/gemini-2.5-flash',
    answer: 'google/gemini-2.5-flash',
  },
};
