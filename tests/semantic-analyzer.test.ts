import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LLMProvider } from '../src/providers/interface';
import { initializeDatabase } from '../src/db/connection';
import { insertType, upsertFile, upsertFileSummary } from '../src/db/queries';
import { analyzeFileSummaries, analyzeTypes } from '../src/semantic/analyzer';

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'structx-test-'));
  const db = initializeDatabase(join(dir, 'db.sqlite'));
  return { dir, db };
}

describe('semantic analyzer entity matching', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const dir of cleanup.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('matches duplicate type names by stable id', async () => {
    const { dir, db } = tempDb();
    cleanup.push(dir);
    const fileA = upsertFile(db, 'src/a.ts', 'a');
    const fileB = upsertFile(db, 'src/b.ts', 'b');
    const typeA = insertType(db, {
      file_id: fileA,
      name: 'MockApp',
      kind: 'interface',
      full_text: 'interface MockApp { a: string }',
      is_exported: true,
      start_line: 1,
      end_line: 1,
    });
    const typeB = insertType(db, {
      file_id: fileB,
      name: 'MockApp',
      kind: 'interface',
      full_text: 'interface MockApp { b: string }',
      is_exported: true,
      start_line: 1,
      end_line: 1,
    });
    const provider: LLMProvider = {
      async chat() {
        return {
          text: JSON.stringify([
            { id: typeA, name: 'MockApp', purpose: 'First mock app type.' },
            { id: typeB, name: 'MockApp', purpose: 'Second mock app type.' },
          ]),
          inputTokens: 10,
          outputTokens: 10,
        };
      },
    };

    const result = await analyzeTypes(db, 'test-model', provider);
    const rows = db.prepare('SELECT id, purpose FROM types ORDER BY id').all() as Array<{ id: number; purpose: string }>;

    expect(result.analyzed).toBe(2);
    expect(rows).toEqual([
      { id: typeA, purpose: 'First mock app type.' },
      { id: typeB, purpose: 'Second mock app type.' },
    ]);
    db.close();
  });

  it('matches file summaries across path separator differences', async () => {
    const { dir, db } = tempDb();
    cleanup.push(dir);
    const fileId = upsertFile(db, 'src\\index.ts', 'hash');
    const summaryId = upsertFileSummary(db, {
      file_id: fileId,
      import_count: 0,
      export_count: 1,
      function_count: 1,
      type_count: 0,
      route_count: 0,
      loc: 20,
      imports_json: JSON.stringify([]),
      exports_json: JSON.stringify(['login']),
    });
    const provider: LLMProvider = {
      async chat() {
        return {
          text: JSON.stringify([
            { path: 'src\\index.ts', purpose: 'Main entry point.' },
          ]),
          inputTokens: 10,
          outputTokens: 10,
        };
      },
    };

    const result = await analyzeFileSummaries(db, 'test-model', provider);
    const row = db.prepare('SELECT purpose FROM file_summaries WHERE id = ?').get(summaryId) as { purpose: string };

    expect(result.analyzed).toBe(1);
    expect(row.purpose).toBe('Main entry point.');
    db.close();
  });
});
