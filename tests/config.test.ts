import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('config loading', () => {
  it('falls back to the structx parent when a persisted repo path is invalid', () => {
    const repo = join(tmpdir(), `structx-config-test-${Date.now()}`);
    cleanup.push(repo);
    const structxDir = join(repo, '.structx');
    mkdirSync(structxDir, { recursive: true });
    writeFileSync(join(structxDir, 'config.json'), JSON.stringify({
      repoPath: 'Z:missing-repo',
      provider: 'openrouter',
    }));

    const config = loadConfig(structxDir);

    expect(config.repoPath).toBe(repo);
    expect(config.provider).toBe('openrouter');
  });

  it('maps legacy queryModel to classifier and answer models when explicit fields are absent', () => {
    const repo = join(tmpdir(), `structx-config-test-${Date.now()}`);
    cleanup.push(repo);
    const structxDir = join(repo, '.structx');
    mkdirSync(structxDir, { recursive: true });
    writeFileSync(join(structxDir, 'config.json'), JSON.stringify({
      repoPath: repo,
      provider: 'openrouter',
      queryModel: 'legacy/query-model',
      analysisModel: 'legacy/analysis-model',
    }));

    const config = loadConfig(structxDir);

    expect(config.analysisModel).toBe('legacy/analysis-model');
    expect(config.classifierModel).toBe('legacy/query-model');
    expect(config.answerModel).toBe('legacy/query-model');
  });

  it('loads a bounded answer token budget with a safe default', () => {
    const repo = join(tmpdir(), `structx-config-test-${Date.now()}`);
    cleanup.push(repo);
    const structxDir = join(repo, '.structx');
    mkdirSync(structxDir, { recursive: true });
    writeFileSync(join(structxDir, 'config.json'), JSON.stringify({
      repoPath: repo,
      provider: 'openrouter',
      answerMaxTokens: 320,
    }));

    expect(loadConfig(structxDir).answerMaxTokens).toBe(320);

    writeFileSync(join(structxDir, 'config.json'), JSON.stringify({
      repoPath: repo,
      provider: 'openrouter',
      answerMaxTokens: 99999,
    }));

    expect(loadConfig(structxDir).answerMaxTokens).toBe(8192);
  });
});
