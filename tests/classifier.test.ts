import { describe, expect, it } from 'vitest';
import { classifyQuestion, classifyQuestionFastPath } from '../src/query/classifier';
import type { LlmClientConfig } from '../src/utils/llm';

// Sentinel config — fast-path tests should never reach the LLM, so the fact
// that this config has a non-existent base URL is a stronger guarantee than
// a stub provider would be. If the unified client ever does reach out, the
// connection will fail and the test will fail loudly.
const sentinelLlmConfig: LlmClientConfig = {
  provider: 'anthropic',
  apiKey: 'no-llm-call-expected',
  baseURL: 'http://127.0.0.1:1',
};

describe('classifier fast path', () => {
  it('routes direct function explanation without an LLM call', async () => {
    const result = await classifyQuestion('what does login do, and what does it call?', 'model', sentinelLlmConfig);

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

  it('routes concept file questions to focused pattern search instead of listing every file', () => {
    const result = classifyQuestionFastPath('what files implement authentication?');

    expect(result?.strategy).toBe('pattern');
    expect(result?.keywords).toEqual(['authentication']);
  });

  it('routes route concept questions to focused route search instead of listing every route', () => {
    const result = classifyQuestionFastPath('what route creates tasks?');

    expect(result?.strategy).toBe('route');
    expect(result?.keywords).toEqual(['creates', 'tasks']);
  });
});
