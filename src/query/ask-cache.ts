import * as crypto from 'crypto';
import type Database from 'better-sqlite3';

function updateRows(
  hash: crypto.Hash,
  label: string,
  rows: Array<Record<string, unknown>>,
): void {
  hash.update(label);
  hash.update('\n');
  for (const row of rows) {
    hash.update(JSON.stringify(row));
    hash.update('\n');
  }
}

export function getGraphFingerprint(db: Database.Database): string {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify({
    files: countRows(db, 'files'),
    functions: countRows(db, 'functions'),
    relationships: countRows(db, 'relationships'),
    types: countRows(db, 'types'),
    routes: countRows(db, 'routes'),
    constants: countRows(db, 'constants'),
    fileSummaries: countRows(db, 'file_summaries'),
  }));
  hash.update('\n');

  updateRows(hash, 'files', db.prepare(`
    SELECT id, path, content_hash
    FROM files
    ORDER BY path
  `).all() as Array<Record<string, unknown>>);

  updateRows(hash, 'functions', db.prepare(`
    SELECT id, file_id, name, signature, code_hash, start_line, end_line,
           purpose, behavior_summary, side_effects_json, domain, complexity,
           semantic_analyzed_at
    FROM functions
    ORDER BY file_id, start_line, name, id
  `).all() as Array<Record<string, unknown>>);

  updateRows(hash, 'relationships', db.prepare(`
    SELECT caller_function_id, callee_function_id, callee_name, relation_type
    FROM relationships
    ORDER BY caller_function_id, callee_name, relation_type
  `).all() as Array<Record<string, unknown>>);

  for (const [label, sql] of [
    ['types', `
      SELECT file_id, name, kind, start_line, end_line, purpose, semantic_analyzed_at
      FROM types
      ORDER BY file_id, start_line, name
    `],
    ['routes', `
      SELECT file_id, method, path, handler_name, middleware, start_line, end_line,
             purpose, semantic_analyzed_at
      FROM routes
      ORDER BY file_id, start_line, method, path
    `],
    ['constants', `
      SELECT file_id, name, value_text, type_annotation, is_exported, start_line, end_line
      FROM constants
      ORDER BY file_id, start_line, name
    `],
    ['file_summaries', `
      SELECT file_id, import_count, export_count, function_count, type_count,
             route_count, loc, imports_json, exports_json, purpose, semantic_analyzed_at
      FROM file_summaries
      ORDER BY file_id
    `],
  ] as const) {
    try {
      updateRows(hash, label, db.prepare(sql).all() as Array<Record<string, unknown>>);
    } catch {
      // Older databases may not have every table yet. The stats block above
      // still captures the missing-table shape for cache-key separation.
    }
  }

  return hash.digest('hex');
}

function countRows(db: Database.Database, table: string): number {
  try {
    return (db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number }).count;
  } catch {
    return 0;
  }
}

export function makeAskCacheKey(question: string, answerModel: string, graphFingerprint: string): string {
  return crypto.createHash('sha256')
    .update(`${question.toLowerCase().trim()}|${answerModel}|${graphFingerprint}`)
    .digest('hex');
}
