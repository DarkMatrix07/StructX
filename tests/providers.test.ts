import { describe, expect, it } from 'vitest';
import { DEFAULT_MODELS, detectProvider } from '../src/providers/factory';

describe('provider detection', () => {
  it('honors explicit openrouter provider over other configured keys', () => {
    const detected = detectProvider({
      provider: 'openrouter',
      anthropicApiKey: 'sk-ant-test',
      openrouterApiKey: 'sk-or-test',
    });

    expect(detected).toEqual({ provider: 'openrouter', apiKey: 'sk-or-test' });
  });

  it('uses Gemini 2.5 Flash for OpenRouter defaults', () => {
    expect(DEFAULT_MODELS.openrouter).toEqual({
      analysis: 'google/gemini-2.5-flash',
      classifier: 'google/gemini-2.5-flash',
      answer: 'google/gemini-2.5-flash',
    });
  });
});
