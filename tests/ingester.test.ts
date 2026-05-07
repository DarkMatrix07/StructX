import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase } from '../src/db/connection';
import { getFunctionByName, getPendingAnalysis, updateSemanticFields } from '../src/db/queries';
import { ingestDirectory } from '../src/ingest/ingester';

const cleanup: string[] = [];

function writeSource(repo: string, changedValue: number): void {
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'sample.ts'), `
export function kept(): number {
  return 1;
}

export function changed(): number {
  return ${changedValue};
}
`);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('ingester semantic preservation', () => {
  // ts-morph parses two source files end-to-end here — on Windows under load
  // (parallel test workers) this can exceed the 5s default. Give it room.
  it('keeps semantic fields for unchanged functions when another function in the file changes', { timeout: 20000 }, () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const repo = mkdtempSync(join(tmpdir(), 'structx-ingest-test-'));
    cleanup.push(repo);
    writeSource(repo, 1);
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));

    ingestDirectory(db, repo, 0.3);
    const keptBefore = getFunctionByName(db, 'kept');
    const changedBefore = getFunctionByName(db, 'changed');
    expect(keptBefore).toBeDefined();
    expect(changedBefore).toBeDefined();
    updateSemanticFields(db, keptBefore!.id, {
      purpose: 'Keep this semantic metadata.',
      behavior_summary: 'Returns one.',
      side_effects_json: JSON.stringify([]),
      domain: 'utility',
      complexity: 'low',
    });
    updateSemanticFields(db, changedBefore!.id, {
      purpose: 'Changed function metadata.',
      behavior_summary: 'Returns a number.',
      side_effects_json: JSON.stringify([]),
      domain: 'utility',
      complexity: 'low',
    });

    writeSource(repo, 2);
    ingestDirectory(db, repo, 0.3);

    const keptAfter = getFunctionByName(db, 'kept');
    const changedAfter = getFunctionByName(db, 'changed');
    const pendingNames = getPendingAnalysis(db, 10)
      .map(item => db.prepare('SELECT name FROM functions WHERE id = ?').get(item.function_id) as { name: string } | undefined)
      .map(row => row?.name);
    db.close();

    expect(keptAfter?.purpose).toBe('Keep this semantic metadata.');
    expect(keptAfter?.semantic_analyzed_at).toBeTruthy();
    expect(changedAfter?.semantic_analyzed_at).toBeNull();
    expect(pendingNames).toContain('changed');
  });
});
