import * as fs from 'fs';
import * as path from 'path';
import ignore, { type Ignore } from 'ignore';

// Always-skipped directories. Acts as a safety floor when no .gitignore exists,
// and as a hard backstop for paths we never want to ingest even if a project's
// .gitignore is unusually permissive (e.g. `!node_modules/foo`).
const ALWAYS_SKIP_DIRS = new Set(['node_modules', '.git', '.structx']);
const TS_EXTENSIONS = new Set(['.ts', '.tsx']);

export function scanDirectory(rootPath: string): string[] {
  const ig = loadGitignore(rootPath);
  const results: string[] = [];
  walk(rootPath, rootPath, ig, results);
  return results.sort();
}

// Loads .gitignore from the repo root and merges in StructX-specific defaults so
// projects without a .gitignore still get sensible exclusions. Nested .gitignore
// files are intentionally not loaded yet — root-level handling covers ~95% of
// real-world cases without the complexity of per-directory rule stacks.
function loadGitignore(rootPath: string): Ignore {
  const ig = ignore();

  // Defaults that apply even when the project has no .gitignore. These mirror
  // common JS/TS build outputs so first-time `structx setup` on a fresh checkout
  // doesn't try to ingest dist/ or coverage/.
  ig.add(['dist', 'build', 'out', '.next', 'coverage', '.cache']);

  const gitignorePath = path.join(rootPath, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    try {
      ig.add(fs.readFileSync(gitignorePath, 'utf-8'));
    } catch {
      // unreadable .gitignore — fall through with defaults only
    }
  }

  return ig;
}

function walk(rootPath: string, dir: string, ig: Ignore, results: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (ALWAYS_SKIP_DIRS.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    // ignore expects POSIX-style relative paths — convert backslashes on Windows.
    const relPath = path.relative(rootPath, fullPath).split(path.sep).join('/');
    // Empty relPath would mean the root itself; skip the gitignore check then.
    const relForCheck = entry.isDirectory() ? `${relPath}/` : relPath;
    if (relPath && ig.ignores(relForCheck)) continue;

    if (entry.isDirectory()) {
      walk(rootPath, fullPath, ig, results);
      continue;
    }

    if (!entry.isFile()) continue;

    const ext = path.extname(entry.name);
    if (!TS_EXTENSIONS.has(ext)) continue;
    if (entry.name.endsWith('.d.ts')) continue;

    results.push(fullPath);
  }
}
