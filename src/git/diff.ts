// Git-aware impact analysis. Given a ref (commit / branch / tag), return the
// list of TypeScript files that changed since that ref AND map those file
// paths to graph entities — functions, types, routes — that the agent can
// reason about.
//
// This is the "what does this PR actually touch?" tool. Combined with
// structx_impact, an agent can answer "what breaks if I merge this PR?"
// without reading any source.

import { execSync } from 'child_process';
import * as path from 'path';
import type Database from 'better-sqlite3';
import { isIngestableTsFile } from '../ingest/scanner';

export interface ChangedFile {
  path: string;        // repo-relative, normalized to forward slashes
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'other';
}

export interface DiffEntities {
  ref: string;
  changedFiles: ChangedFile[];
  functions: Array<{ name: string; file: string; status: ChangedFile['status'] }>;
  types: Array<{ name: string; kind: string; file: string; status: ChangedFile['status'] }>;
  routes: Array<{ method: string; path: string; file: string; status: ChangedFile['status'] }>;
  unindexedFiles: string[];  // Changed but not in StructX's graph (excluded by source-quality filters)
}

// Wraps `git diff --name-status <ref>` so we don't need to drag in nodegit
// or simple-git. The execSync shape is fine here — git is fast, output is
// small, and any error (not a git repo, ref doesn't exist) bubbles up with
// a useful message we surface to the user.
export function gitChangedFiles(repoRoot: string, ref: string): ChangedFile[] {
  let output: string;
  try {
    output = execSync(`git diff --name-status ${shellEscape(ref)}`, {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    const stderr = err.stderr?.toString() ?? '';
    if (/unknown revision|bad revision|not a git repository/i.test(stderr)) {
      throw new Error(`git ref '${ref}' not found in ${repoRoot}: ${stderr.trim()}`);
    }
    throw new Error(`git diff against '${ref}' failed: ${err.message}`);
  }

  const files: ChangedFile[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const code = parts[0];
    // Rename lines are R<score> <old> <new> — use the new path.
    const filePath = parts[parts.length - 1];
    if (!filePath) continue;
    files.push({
      path: filePath.replace(/\\/g, '/'),
      status: gitStatusToString(code),
    });
  }
  return files;
}

function gitStatusToString(code: string): ChangedFile['status'] {
  if (!code) return 'other';
  const c = code[0];
  if (c === 'A') return 'added';
  if (c === 'M') return 'modified';
  if (c === 'D') return 'deleted';
  if (c === 'R') return 'renamed';
  return 'other';
}

// Refs are user-controlled — escape quote chars just in case. Refs in
// practice are tiny ASCII strings (HEAD~1, main, sha1) so a conservative
// escape is fine.
function shellEscape(s: string): string {
  if (/^[A-Za-z0-9._/~^@:-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// Map changed files to indexed graph entities. Files outside the StructX
// graph (excluded by source-quality filters or never ingested) are
// surfaced separately as `unindexedFiles` so the user can spot them.
export function diffEntities(
  db: Database.Database,
  repoRoot: string,
  ref: string,
): DiffEntities {
  const changedFiles = gitChangedFiles(repoRoot, ref);
  const result: DiffEntities = {
    ref,
    changedFiles,
    functions: [],
    types: [],
    routes: [],
    unindexedFiles: [],
  };

  for (const cf of changedFiles) {
    if (!isIngestableTsFile(path.join(repoRoot, cf.path))) {
      // Non-TS file — silently skip.
      continue;
    }
    const fileRow = db.prepare('SELECT id FROM files WHERE path = ?').get(cf.path) as { id: number } | undefined;
    if (!fileRow) {
      // File changed but isn't in the graph — could be a deleted file or
      // an excluded path. Surface separately so the user knows.
      result.unindexedFiles.push(cf.path);
      continue;
    }
    const fns = db.prepare('SELECT name FROM functions WHERE file_id = ?').all(fileRow.id) as Array<{ name: string }>;
    for (const fn of fns) result.functions.push({ name: fn.name, file: cf.path, status: cf.status });

    const ts = db.prepare('SELECT name, kind FROM types WHERE file_id = ?').all(fileRow.id) as Array<{ name: string; kind: string }>;
    for (const t of ts) result.types.push({ name: t.name, kind: t.kind, file: cf.path, status: cf.status });

    const rs = db.prepare('SELECT method, path FROM routes WHERE file_id = ?').all(fileRow.id) as Array<{ method: string; path: string }>;
    for (const r of rs) result.routes.push({ method: r.method, path: r.path, file: cf.path, status: cf.status });
  }

  return result;
}
