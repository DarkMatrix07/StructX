import { describe, expect, it } from 'vitest';
import { fitContextToBudget } from '../src/query/context-builder';

describe('context budget', () => {
  it('drops bulky details before hard truncating', () => {
    const context = [
      '1. GET /items',
      '   Location: src/routes.ts:1',
      `   Handler body: ${'x'.repeat(8000)}`,
      '2. interface Large',
      '   Definition:',
      'type Large = ' + 'y'.repeat(8000),
    ].join('\n');

    const fitted = fitContextToBudget(context, 200);

    expect(fitted).not.toContain('Handler body:');
    expect(fitted).not.toContain('Definition:');
    expect(fitted).toContain('Context truncated');
  });
});
