import { describe, expect, it } from 'vitest';
import { isFatalProviderError } from '../src/semantic/analyzer';

// Battle-tested case from tRPC: a 402 mid-batch produced 1100 doomed API
// calls and a confusing "Failed: 1100" with no actionable message. The
// detector below trips on the patterns that mean every subsequent call
// will also fail, so the batch loop can stop and surface the reason.
describe('isFatalProviderError', () => {
  it('trips on OpenAI-style 402 status codes', () => {
    const err = { status: 402, message: 'Insufficient credits' };
    const result = isFatalProviderError(err);
    expect(result.fatal).toBe(true);
    expect(result.reason).toMatch(/credits/i);
  });

  it('trips on the OpenRouter "Insufficient credits" message even without a status code', () => {
    const err = { message: 'AI provider returned error: 402 Insufficient credits' };
    const result = isFatalProviderError(err);
    expect(result.fatal).toBe(true);
  });

  it('trips on 401 authentication failures', () => {
    const err = { status: 401, message: 'Invalid API key' };
    const result = isFatalProviderError(err);
    expect(result.fatal).toBe(true);
    expect(result.reason).toMatch(/authentication/i);
  });

  it('does NOT trip on transient 5xx or rate-limit errors', () => {
    expect(isFatalProviderError({ status: 500, message: 'Internal server error' }).fatal).toBe(false);
    expect(isFatalProviderError({ status: 429, message: 'Rate limited' }).fatal).toBe(false);
    expect(isFatalProviderError({ message: 'ECONNRESET' }).fatal).toBe(false);
  });

  it('does NOT trip on null / undefined errors', () => {
    expect(isFatalProviderError(null).fatal).toBe(false);
    expect(isFatalProviderError(undefined).fatal).toBe(false);
    expect(isFatalProviderError({}).fatal).toBe(false);
  });
});
