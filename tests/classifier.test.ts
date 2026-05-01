import { describe, expect, it } from 'vitest';
import { classifyQuestion, classifyQuestionFastPath } from '../src/query/classifier';
import type { LLMProvider } from '../src/providers/interface';

const failingProvider: LLMProvider = {
  async chat() {
    throw new Error('LLM classifier should not be called for fast-path questions');
  },
};

describe('classifier fast path', () => {
  it('routes direct function explanation without an LLM call', async () => {
    const result = await classifyQuestion('what does login do, and what does it call?', 'model', failingProvider);

    expect(result.strategy).toBe('direct');
    expect(result.functionName).toBe('login');
  });

  it('routes caller questions deterministically', () => {
    const result = classifyQuestionFastPath('what calls validatePassword?');

    expect(result?.strategy).toBe('relationship');
    expect(result?.direction).toBe('callers');
    expect(result?.functionName).toBe('validatePassword');
  });

  it('routes callee questions to direct context with Calls included', () => {
    const result = classifyQuestionFastPath('what does searchTasks call?');

    expect(result?.strategy).toBe('direct');
    expect(result?.functionName).toBe('searchTasks');
  });

  it('routes list and file questions deterministically', () => {
    expect(classifyQuestionFastPath('list all routes')?.listEntity).toBe('routes');

    const file = classifyQuestionFastPath("what's in src\\index.ts?");
    expect(file?.strategy).toBe('file');
    expect(file?.filePath).toBe('src/index.ts');
  });
});
