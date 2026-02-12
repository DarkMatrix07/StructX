import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

export function getDbPath(structxDir: string): string {
  return path.join(structxDir, 'db.sqlite');
}

export function openDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function initializeDatabase(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = openDatabase(dbPath);
  runMigrations(db);
  return db;
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
}
