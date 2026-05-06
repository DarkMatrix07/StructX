import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
}));

vi.mock('../src/utils/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/llm')>();
  return {
    ...actual,
    createLlmClient: vi.fn(() => ({
      provider: 'openrouter',
      complete: mocks.complete,
    })),
  };
});

import { generateAnswer } from '../src/query/answerer';

describe('answer generation', () => {
  it('passes the configured answer token budget to the LLM client', async () => {
    mocks.complete.mockResolvedValueOnce({
      text: 'answer',
      inputTokens: 10,
      outputTokens: 4,
    });

    const result = await generateAnswer(
      'what changed?',
      'Context',
      'anthropic/claude-haiku-4.5',
      { provider: 'openrouter', apiKey: 'test-key' },
      256,
    );

    expect(result.answer).toBe('answer');
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({
      maxTokens: 256,
    }));
  });
});
