import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig } from '../src/config';

// Verifies that loadConfig resolves provider+apiKey from env vars in the
// documented priority order: ANTHROPIC > GEMINI > OPENROUTER. An explicit
// `provider` field in config.json always wins, regardless of which env vars
// happen to be set.
const cleanup: string[] = [];
const originalEnv = { ...process.env };

beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
});

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  // Restore the original env so unrelated tests don't see our wipes.
  process.env = { ...originalEnv };
});

function makeStructxDir(extraConfig: Record<string, unknown> = {}): string {
  const repo = join(tmpdir(), `structx-providers-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  cleanup.push(repo);
  const structxDir = join(repo, '.structx');
  mkdirSync(structxDir, { recursive: true });
  writeFileSync(join(structxDir, 'config.json'), JSON.stringify({
    repoPath: repo,
    ...extraConfig,
  }));
  return structxDir;
}

describe('provider detection', () => {
  it('honors an explicit provider field over env-var hints', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    const dir = makeStructxDir({ provider: 'openrouter' });

    const config = loadConfig(dir);

    expect(config.provider).toBe('openrouter');
    expect(config.anthropicApiKey).toBe('sk-or-test');
  });

  it('detects Gemini from env when no provider is pinned', () => {
    process.env.GEMINI_API_KEY = 'gem-test';
    const dir = makeStructxDir();

    const config = loadConfig(dir);

    expect(config.provider).toBe('gemini');
    expect(config.anthropicApiKey).toBe('gem-test');
    expect(config.classifierModel).toMatch(/^gemini-/);
    expect(config.answerModel).toMatch(/^gemini-/);
  });

  it('falls back to GOOGLE_API_KEY for Gemini when GEMINI_API_KEY is missing', () => {
    process.env.GOOGLE_API_KEY = 'goog-test';
    const dir = makeStructxDir({ provider: 'gemini' });

    const config = loadConfig(dir);

    expect(config.anthropicApiKey).toBe('goog-test');
  });

  it('prefers Anthropic over Gemini when both env keys are set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.GEMINI_API_KEY = 'gem-test';
    const dir = makeStructxDir();

    const config = loadConfig(dir);

    expect(config.provider).toBe('anthropic');
    expect(config.anthropicApiKey).toBe('sk-ant-test');
  });
});
