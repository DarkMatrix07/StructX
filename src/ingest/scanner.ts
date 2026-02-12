import * as fs from 'fs';
import * as path from 'path';

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.structx', 'coverage', '.next', 'build', 'out']);
const TS_EXTENSIONS = new Set(['.ts', '.tsx']);

export function scanDirectory(rootPath: string): string[] {
  const results: string[] = [];
  walk(rootPath, results);
  return results.sort();
}

function walk(dir: string, results: string[]): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        walk(fullPath, results);
      }
      continue;
    }

    if (!entry.isFile()) continue;

    const ext = path.extname(entry.name);
    if (!TS_EXTENSIONS.has(ext)) continue;

    // Skip declaration files
    if (entry.name.endsWith('.d.ts')) continue;

    results.push(fullPath);
  }
}
