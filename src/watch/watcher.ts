import * as path from 'path';
import * as fs from 'fs';
import type Database from 'better-sqlite3';
import type { Ignore } from 'ignore';
import { createProject } from '../ingest/parser';
import { ingestSingleFile, removeFileFromGraph } from '../ingest/ingester';
import { ALWAYS_SKIP_DIRS, loadIgnoreMatcher, isIngestableTsFile } from '../ingest/scanner';
import { resolveNullCallees, rebuildAllFtsIndexes } from '../db/queries';
import { logger } from '../utils/logger';

interface WatchOptions {
  diffThreshold: number;
  postProcessDebounceMs?: number;
  perFileDebounceMs?: number;
}

// Watch the repo for TypeScript file changes and keep the graph hot.
// Returns a stop() function so callers (CLI, tests) can shut the watcher down.
export async function watchDirectory(
  db: Database.Database,
  repoPath: string,
  opts: WatchOptions,
): Promise<() => Promise<void>> {
  const project = createProject(repoPath);
  const matcher = loadIgnoreMatcher(repoPath);

  const postProcessMs = opts.postProcessDebounceMs ?? 300;
  const perFileMs = opts.perFileDebounceMs ?? 80;

  // Per-file debounce: fs.watch can fire multiple events for one save.
  const pendingFileTimers = new Map<string, NodeJS.Timeout>();
  // Batched post-processing (FTS rebuild + cross-file callee resolution).
  let postProcessTimer: NodeJS.Timeout | null = null;
  let dirty = false;

  function schedulePostProcess() {
    dirty = true;
    if (postProcessTimer) clearTimeout(postProcessTimer);
    postProcessTimer = setTimeout(() => {
      postProcessTimer = null;
      if (!dirty) return;
      dirty = false;
      try {
        const resolved = resolveNullCallees(db);
        rebuildAllFtsIndexes(db);
        if (resolved > 0) logger.debug(`Resolved ${resolved} cross-file callees`);
      } catch (err: any) {
        logger.warn(`Post-process failed: ${err.message}`);
      }
    }, postProcessMs);
  }

  function shouldIgnore(absPath: string): boolean {
    const rel = path.relative(repoPath, absPath).split(path.sep).join('/');
    if (!rel) return true;
    // Hard backstop: never touch these directories regardless of .gitignore.
    const segments = rel.split('/');
    for (const seg of segments) {
      if (ALWAYS_SKIP_DIRS.has(seg)) return true;
    }
    // Defer to .gitignore matcher (with built-in defaults).
    return matcher.ignores(rel);
  }

  function handleEvent(absPath: string) {
    if (!isIngestableTsFile(absPath)) return;
    if (shouldIgnore(absPath)) return;

    // Debounce per-file: collapse rapid duplicate events from a single save.
    const existing = pendingFileTimers.get(absPath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      pendingFileTimers.delete(absPath);
      processFile(absPath);
    }, perFileMs);
    pendingFileTimers.set(absPath, timer);
  }

  function processFile(absPath: string) {
    const exists = fs.existsSync(absPath);
    const rel = path.relative(repoPath, absPath).split(path.sep).join('/');

    if (!exists) {
      const removed = removeFileFromGraph(db, repoPath, absPath);
      if (removed) {
        console.log(`  − ${rel}`);
        schedulePostProcess();
      }
      return;
    }

    try {
      const result = ingestSingleFile(db, project, repoPath, absPath, opts.diffThreshold);
      if (result.status === 'unchanged') return;
      if (result.status === 'parse-failed') {
        console.log(`  ! ${rel} (parse failed)`);
        return;
      }
      const tag = result.status === 'new' ? '+' : '~';
      const queuedNote = result.queued > 0 ? ` (${result.queued} queued)` : '';
      console.log(
        `  ${tag} ${rel} — ${result.functions} fns, ${result.types} types, ${result.routes} routes, ${result.constants} consts${queuedNote}`,
      );
      schedulePostProcess();
    } catch (err: any) {
      logger.warn(`Failed to ingest ${rel}: ${err.message}`);
    }
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

  // Stop function — closes watcher, flushes any pending timers, runs final
  // post-process so the on-disk graph is consistent before the process exits.
  return async () => {
    watcher.close();
    for (const timer of pendingFileTimers.values()) clearTimeout(timer);
    pendingFileTimers.clear();
    if (postProcessTimer) {
      clearTimeout(postProcessTimer);
      postProcessTimer = null;
    }
    if (dirty) {
      try {
        resolveNullCallees(db);
        rebuildAllFtsIndexes(db);
      } catch {}
    }
  };
}
