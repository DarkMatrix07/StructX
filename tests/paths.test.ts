import { describe, expect, it } from 'vitest';
import { normalizeRepoPath, formatLocation } from '../src/utils/paths';

describe('path normalization', () => {
  it('uses forward-slash repo paths at boundaries', () => {
    expect(normalizeRepoPath('.\\src\\index.ts')).toBe('src/index.ts');
    expect(formatLocation('src\\query\\retriever.ts', 12)).toBe('src/query/retriever.ts:12');
  });
});
