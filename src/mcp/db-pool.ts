import * as path from 'path';
import * as fs from 'fs';
import type Database from 'better-sqlite3';
import { openDatabase, getDbPath } from '../db/connection';
import { getStructXDir } from '../config';

// Map from absolute repo path → open Database connection. The MCP server
// process keeps connections alive across tool calls; SQLite WAL handles
// concurrency with a parallel `structx watch` writing to the same file.
const pool = new Map<string, Database.Database>();

// When true, all subsequent getDb() calls open the connection with
// readonly: true. Set once at server startup via setReadonly().
let readonlyMode = false;

export function setReadonly(readonly: boolean): void {
  readonlyMode = readonly;
}

export function isReadonly(): boolean {
  return readonlyMode;
}

export class StructxNotInitializedError extends Error {
  constructor(public repoPath: string) {
    super(`StructX not initialized for ${repoPath}. Run 'structx setup ${repoPath}' first.`);
    this.name = 'StructxNotInitializedError';
  }
}

// Resolve a repo path argument into the canonical absolute form used as the
// pool key. `undefined` falls back to the server's defaultRepo (set at
// startup) which itself defaults to cwd.
export function resolveRepoPath(repoPath: string | undefined, defaultRepo: string): string {
  const target = repoPath ?? defaultRepo;
  return path.resolve(target);
}

// Open or reuse the Database for a repo. Throws StructxNotInitializedError
// when the .structx/db.sqlite file is missing — caller (tool handler) catches
// and converts into a clean MCP error response.
export function getDb(repoPath: string): Database.Database {
  const abs = path.resolve(repoPath);
  const cached = pool.get(abs);
  if (cached) return cached;

  const structxDir = getStructXDir(abs);
  const dbPath = getDbPath(structxDir);
  if (!fs.existsSync(dbPath)) {
    throw new StructxNotInitializedError(abs);
  }
  const db = openDatabase(dbPath, { readonly: readonlyMode });
  pool.set(abs, db);
  return db;
}

// Close all pooled connections. Called on server shutdown.
export function closeAllDbs(): void {
  for (const db of pool.values()) {
    try { db.close(); } catch {}
  }
  pool.clear();
}
