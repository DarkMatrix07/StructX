import * as path from 'path';
import * as fs from 'fs';
import type Database from 'better-sqlite3';
import { createProject } from '../ingest/parser';
import { ingestSingleFile, removeFileFromGraph } from '../ingest/ingester';
import { ALWAYS_SKIP_DIRS, loadIgnoreMatcher, isIngestableTsFile } from '../ingest/scanner';
import { resolveNullCallees, rebuildAllFtsIndexes } from '../db/queries';
import { logger } from '../utils/logger';

interface WatchOptions {
  diffThreshold: number;
  // Time of quiet (no new events for any file) before a flush fires.
  quietMs?: number;
  // Maximum time to hold events from the first one in a burst before forcing
  // a flush. Prevents starvation under sustained churn (e.g. git checkout).
  maxHoldMs?: number;
}

interface FlushOutcome {
  path: string;
  status: 'new' | 'changed' | 'removed' | 'unchanged' | 'parse-failed' | 'failed';
  result?: ReturnType<typeof ingestSingleFile>;
}

// Watch the repo for TypeScript file changes and keep the graph hot.
// Returns a stop() function so callers (CLI, tests) can shut the watcher down.
//
// Design: events from fs.watch are deduplicated into a pending Set, then
// flushed in a single SQLite transaction once the event stream goes quiet
// (default 80ms) or has been held too long (default 500ms). This handles
// both the common single-save case and bursts (git checkout, codemods,
// formatter runs) with the same code path.
export async function watchDirectory(
  db: Database.Database,
  repoPath: string,
  opts: WatchOptions,
): Promise<() => Promise<void>> {
  const project = createProject(repoPath);
  const matcher = loadIgnoreMatcher(repoPath);

  const quietMs = opts.quietMs ?? 80;
  const maxHoldMs = opts.maxHoldMs ?? 500;

  // Pending paths to ingest on the next flush. Set dedupes multiple events
  // for the same file (a save can fire 2-3 events on Windows).
  const pending = new Set<string>();
  let flushTimer: NodeJS.Timeout | null = null;
  let firstEventAt = 0;
  let flushing = false;

  function shouldIgnore(absPath: string): boolean {
    const rel = path.relative(repoPath, absPath).split(path.sep).join('/');
    if (!rel) return true;
    // Hard backstop: never touch these directories regardless of .gitignore.
    for (const seg of rel.split('/')) {
      if (ALWAYS_SKIP_DIRS.has(seg)) return true;
    }
    return matcher.ignores(rel);
  }

  function scheduleFlush() {
    if (flushTimer) clearTimeout(flushTimer);
    // Each new event resets the quiet timer, but never past the max-hold cap
    // measured from the FIRST event in the current burst. Without this cap,
    // a sustained stream of events (e.g. a slow `npm install` regenerating
    // .ts every ~50ms) could indefinitely starve the flush.
    const elapsed = firstEventAt ? Date.now() - firstEventAt : 0;
    const wait = elapsed + quietMs > maxHoldMs
      ? Math.max(10, maxHoldMs - elapsed)
      : quietMs;
    flushTimer = setTimeout(flush, wait);
  }

  function handleEvent(absPath: string) {
    if (!isIngestableTsFile(absPath)) return;
    if (shouldIgnore(absPath)) return;
    if (pending.size === 0) firstEventAt = Date.now();
    pending.add(absPath);
    scheduleFlush();
  }

  function flush() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (flushing) {
      // A flush is already running synchronously — it will pick up anything
      // added in the meantime when it finishes. Nothing to do.
      return;
    }
    if (pending.size === 0) { firstEventAt = 0; return; }

    flushing = true;
    const paths = [...pending];
    pending.clear();
    firstEventAt = 0;

    const start = Date.now();
    const outcomes: FlushOutcome[] = [];

    // One outer transaction wraps every per-file ingest. Better-sqlite3
    // converts the inner db.transaction() calls to SAVEPOINTs, so a single
    // file's parse failure rolls back only that file's changes; siblings in
    // the same batch are kept on commit.
    try {
      db.transaction(() => {
        for (const absPath of paths) {
          try {
            if (!fs.existsSync(absPath)) {
              const removed = removeFileFromGraph(db, repoPath, absPath);
              outcomes.push({ path: absPath, status: removed ? 'removed' : 'unchanged' });
              continue;
            }
            const r = ingestSingleFile(db, project, repoPath, absPath, opts.diffThreshold);
            outcomes.push({ path: absPath, status: r.status, result: r });
          } catch (err: any) {
            const rel = path.relative(repoPath, absPath).split(path.sep).join('/');
            logger.warn(`Failed to ingest ${rel}: ${err.message}`);
            outcomes.push({ path: absPath, status: 'failed' });
          }
        }
      })();

      // Single post-process for the whole batch.
      try {
        resolveNullCallees(db);
        rebuildAllFtsIndexes(db);
      } catch (err: any) {
        logger.warn(`Post-process failed: ${err.message}`);
      }
    } finally {
      flushing = false;
    }

    logFlush(outcomes, Date.now() - start, repoPath);

    // If new events arrived while we were flushing, kick off another cycle.
    if (pending.size > 0) scheduleFlush();
  }

  // fs.watch with recursive:true works on macOS/Windows natively, and on Linux
  // since Node 20. If the platform doesn't support it, fall back to a flat
  // watch on the repo root (good enough for shallow projects, and we surface
  // a warning so users know to upgrade Node).
  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(repoPath, { recursive: true, persistent: true }, (_eventType, filename) => {
      if (!filename) return;
      handleEvent(path.resolve(repoPath, filename));
    });
  } catch (err: any) {
    logger.warn(`Recursive fs.watch unavailable (${err.message}); falling back to non-recursive.`);
    watcher = fs.watch(repoPath, { persistent: true }, (_eventType, filename) => {
      if (!filename) return;
      handleEvent(path.resolve(repoPath, filename));
    });
  }

  watcher.on('error', (err) => logger.warn(`Watcher error: ${err.message}`));

  console.log(`\nWatching ${repoPath} for changes. Press Ctrl+C to stop.\n`);

  // Stop function — closes watcher, drains any pending events into one final
  // flush so the on-disk graph is consistent before the process exits.
  return async () => {
    watcher.close();
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (pending.size > 0) flush();
  };
}

// Burst-aware logging: single-file flushes preserve the detailed v1 line
// (`+ src/foo.ts — 3 fns, 1 types, 0 routes, 2 consts (4 queued)`); multi-file
// flushes collapse into a one-line burst summary (`↻ 50 files (12 added, 38
// changed) in 480ms`).
function logFlush(outcomes: FlushOutcome[], elapsedMs: number, repoPath: string): void {
  const visible = outcomes.filter(o => o.status !== 'unchanged');
  if (visible.length === 0) return;

  if (visible.length === 1) {
    const o = visible[0];
    const rel = path.relative(repoPath, o.path).split(path.sep).join('/');
    if (o.status === 'removed') { console.log(`  − ${rel}`); return; }
    if (o.status === 'parse-failed') { console.log(`  ! ${rel} (parse failed)`); return; }
    if (o.status === 'failed') { console.log(`  ! ${rel} (failed)`); return; }
    if (!o.result) return;
    const tag = o.status === 'new' ? '+' : '~';
    const queuedNote = o.result.queued > 0 ? ` (${o.result.queued} queued)` : '';
    console.log(
      `  ${tag} ${rel} — ${o.result.functions} fns, ${o.result.types} types, ${o.result.routes} routes, ${o.result.constants} consts${queuedNote}`,
    );
    return;
  }

  // Burst summary — count by status and print one line.
  const counts = { new: 0, changed: 0, removed: 0, parseFailed: 0, failed: 0 };
  for (const o of visible) {
    if (o.status === 'new') counts.new++;
    else if (o.status === 'changed') counts.changed++;
    else if (o.status === 'removed') counts.removed++;
    else if (o.status === 'parse-failed') counts.parseFailed++;
    else if (o.status === 'failed') counts.failed++;
  }
  const parts: string[] = [];
  if (counts.new) parts.push(`${counts.new} added`);
  if (counts.changed) parts.push(`${counts.changed} changed`);
  if (counts.removed) parts.push(`${counts.removed} removed`);
  if (counts.parseFailed) parts.push(`${counts.parseFailed} parse-failed`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  console.log(`  ↻ ${visible.length} files (${parts.join(', ')}) in ${elapsedMs}ms`);
}
