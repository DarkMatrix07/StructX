import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { normalizeRepoPath } from '../utils/paths';

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

export function getDbPath(structxDir: string): string {
  return path.join(structxDir, 'db.sqlite');
}

export interface OpenDbOptions {
  // When true, opens with SQLITE_OPEN_READONLY and skips migrations + path
  // normalization (both of which would attempt writes). Used by `structx mcp
  // --readonly` so MCP servers can attach to a graph maintained by another
  // process without risking accidental schema changes.
  readonly?: boolean;
}

export function openDatabase(dbPath: string, opts: OpenDbOptions = {}): Database.Database {
  const db = new Database(dbPath, opts.readonly ? { readonly: true } : undefined);
  if (!opts.readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    // Wait rather than failing instantly when another StructX process holds a
    // write lock — `structx watch` running alongside a manual ingest is a
    // normal setup, and WAL contention there is usually momentary. Anything
    // longer than this is a genuine conflict and surfaces as a clean message.
    db.pragma('busy_timeout = 10000');
    runMigrations(db);
    normalizeExistingFilePaths(db);
  } else {
    // Readonly connections still benefit from foreign_keys ON for joins on
    // tables that reference deleted rows; this pragma is a no-op when the
    // file is opened readonly but harmless to set.
    db.pragma('foreign_keys = ON');
  }
  return db;
}

export function initializeDatabase(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  return openDatabase(dbPath);
}

function runMigrations(db: Database.Database): void {
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');

  // Split on semicolons but keep statements intact
  const statements = schema
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  db.transaction(() => {
    for (const stmt of statements) {
      db.exec(stmt);
    }
  })();

  // Create FTS tables separately (virtual tables can't be in transactions on some builds)
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS functions_fts USING fts5(
        name, purpose, behavior_summary,
        content='functions', content_rowid='id'
      )
    `);
  } catch {
    // FTS table already exists
  }

  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS types_fts USING fts5(
        name, full_text, purpose,
        content='types', content_rowid='id'
      )
    `);
  } catch {}

  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS routes_fts USING fts5(
        path, handler_body, purpose,
        content='routes', content_rowid='id'
      )
    `);
  } catch {}

  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
        purpose, exports_json,
        content='file_summaries', content_rowid='id'
      )
    `);
  } catch {}

  // Ask response cache. Callers compute the key from question + answer model +
  // graph fingerprint so changed code cannot return stale answers.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ask_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_hash TEXT NOT NULL UNIQUE,
      strategy TEXT NOT NULL,
      answer_text TEXT NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cost_usd REAL,
      model TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  migrateTypesKindConstraint(db);

  // v3.4.0 columns. schema.sql uses CREATE TABLE IF NOT EXISTS, which is a
  // no-op on databases that already have these tables — so new columns have
  // to be added explicitly for existing graphs. All three are nullable, so
  // old rows stay valid and simply re-populate on the next ingest.
  addColumnIfMissing(db, 'relationships', 'callee_decl_file', 'TEXT');
  addColumnIfMissing(db, 'relationships', 'callee_decl_name', 'TEXT');
  addColumnIfMissing(db, 'routes', 'handler_function_id', 'INTEGER REFERENCES functions(id) ON DELETE SET NULL');
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_routes_handler_function ON routes(handler_function_id)');
  } catch {}

  // type_relationships was added in v3.3.0. Old DBs migrate idempotently
  // — schema.sql's CREATE IF NOT EXISTS already covers this on first
  // open after upgrade, but we explicitly trip the FTS rebuild so the
  // graph fingerprint changes (invalidating old ask cache) when users
  // first see heritage edges in answers.
  try {
    const exists = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='type_relationships'`
    ).get();
    if (!exists) {
      db.exec(`
        CREATE TABLE type_relationships (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          subtype_id INTEGER NOT NULL REFERENCES types(id) ON DELETE CASCADE,
          supertype_id INTEGER REFERENCES types(id) ON DELETE SET NULL,
          supertype_name TEXT NOT NULL,
          relation_kind TEXT NOT NULL CHECK(relation_kind IN ('extends', 'implements'))
        );
        CREATE INDEX idx_type_relationships_subtype ON type_relationships(subtype_id);
        CREATE INDEX idx_type_relationships_supertype_id ON type_relationships(supertype_id);
        CREATE INDEX idx_type_relationships_supertype_name ON type_relationships(supertype_name);
      `);
    }
  } catch {}
}

// Add a column to an existing table when it isn't there yet. SQLite has no
// `ADD COLUMN IF NOT EXISTS`, so we check PRAGMA table_info first. Silent
// no-op when the table itself doesn't exist yet (fresh DB — schema.sql
// already declares the column).
function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string): void {
  try {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.length === 0) return;
    if (columns.some(c => c.name === column)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch {
    // Best effort — a failed migration leaves the older, still-functional
    // name-matching behavior in place rather than breaking the connection.
  }
}

// SQLite doesn't support ALTER TABLE to change a CHECK constraint, so for
// the `types.kind` column we detect the old constraint (no `class`) and
// rebuild the table with the new one. Idempotent — schemas that already
// allow 'class' are left untouched. Runs once per `openDatabase` and is
// fast (zero rows to copy unless the user actually has types indexed).
function migrateTypesKindConstraint(db: Database.Database): void {
  try {
    const row = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='types'`
    ).get() as { sql: string } | undefined;
    if (!row || row.sql.includes("'class'")) return;

    db.exec('PRAGMA foreign_keys=OFF');
    db.transaction(() => {
      db.exec(`
        CREATE TABLE types_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('interface', 'type_alias', 'enum', 'class')),
          full_text TEXT NOT NULL,
          is_exported BOOLEAN DEFAULT 0,
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          purpose TEXT,
          semantic_analyzed_at DATETIME
        )
      `);
      db.exec(`INSERT INTO types_new SELECT * FROM types`);
      db.exec(`DROP TABLE types`);
      db.exec(`ALTER TABLE types_new RENAME TO types`);
    })();
    db.exec('PRAGMA foreign_keys=ON');

    // FTS index over the recreated table needs a rebuild — the old fts5
    // virtual table tracked the old types rowids.
    try { db.exec("INSERT INTO types_fts(types_fts) VALUES('rebuild')"); } catch {}
  } catch {
    // Best effort. If the migration fails, the worst case is users who
    // haven't analyzed yet keep getting the old constraint; functions and
    // routes are unaffected.
  }
}

function normalizeExistingFilePaths(db: Database.Database): void {
  try {
    const files = db.prepare('SELECT id, path FROM files').all() as Array<{ id: number; path: string }>;
    if (files.length === 0) return;

    const groups = new Map<string, Array<{ id: number; path: string; analyzed: number; functions: number }>>();
    const countFunctions = db.prepare('SELECT COUNT(*) as count FROM functions WHERE file_id = ?');
    const countAnalyzed = db.prepare('SELECT COUNT(*) as count FROM functions WHERE file_id = ? AND semantic_analyzed_at IS NOT NULL');

    for (const file of files) {
      const normalized = normalizeRepoPath(file.path);
      const functions = (countFunctions.get(file.id) as { count: number }).count;
      const analyzed = (countAnalyzed.get(file.id) as { count: number }).count;
      const group = groups.get(normalized) ?? [];
      group.push({ ...file, functions, analyzed });
      groups.set(normalized, group);
    }

    db.transaction(() => {
      for (const [normalized, group] of groups) {
        group.sort((a, b) => b.analyzed - a.analyzed || b.functions - a.functions || a.id - b.id);
        const keeper = group[0];
        const duplicates = group.slice(1);

        for (const duplicate of duplicates) {
          db.prepare('DELETE FROM files WHERE id = ?').run(duplicate.id);
        }

        if (keeper.path !== normalized) {
          db.prepare('UPDATE files SET path = ? WHERE id = ?').run(normalized, keeper.id);
        }
      }
    })();
  } catch {
    // Tables may not exist yet during first-time initialization.
  }
}
