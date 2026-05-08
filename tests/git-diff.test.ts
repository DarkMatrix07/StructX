import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';
import { initializeDatabase } from '../src/db/connection';
import { ingestDirectory } from '../src/ingest/ingester';
import { diffEntities, gitChangedFiles } from '../src/git/diff';

const cleanup: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const repo of cleanup.splice(0)) {
    rmSync(repo, { recursive: true, force: true });
  }
});

// Spin up a real git repo with two commits and run StructX against it,
// then verify diffEntities maps the second commit's changes back to the
// indexed graph entities. This is the only way to test the git layer
// honestly — mocking execSync wouldn't catch the path-normalization
// bugs we'd actually hit on Windows.
function makeGitRepo(): { repo: string } {
  const repo = mkdtempSync(join(tmpdir(), 'structx-git-test-'));
  cleanup.push(repo);

  execSync('git init -q', { cwd: repo });
  execSync('git config user.email t@e.st', { cwd: repo });
  execSync('git config user.name Test', { cwd: repo });
  // Disable hooks to keep the test deterministic on machines with global
  // commit hooks (e.g. linters).
  execSync('git config core.hooksPath /dev/null', { cwd: repo });

  // Initial commit — one file with one function.
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'auth.ts'), `export function login(user: string): boolean { return user.length > 0; }\n`);
  execSync('git add -A && git commit -q -m initial', { cwd: repo });

  // Second commit — modify auth.ts AND add tasks.ts.
  writeFileSync(join(repo, 'src', 'auth.ts'),
    `export function login(user: string): boolean { return user.length > 3; }\n` +
    `export function logout(): void {}\n`,
  );
  writeFileSync(join(repo, 'src', 'tasks.ts'),
    `export interface Task { id: string }\nexport function createTask(): Task { return { id: 'x' }; }\n`,
  );
  execSync('git add -A && git commit -q -m second', { cwd: repo });

  return { repo };
}

describe('git diff integration', () => {
  it('maps changed files since HEAD~1 to indexed functions / types', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { repo } = makeGitRepo();

    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    const result = diffEntities(db, repo, 'HEAD~1');

    // Both files show up as changed.
    expect(result.changedFiles.map(f => f.path).sort()).toEqual(['src/auth.ts', 'src/tasks.ts']);
    expect(result.changedFiles.find(f => f.path === 'src/tasks.ts')?.status).toBe('added');
    expect(result.changedFiles.find(f => f.path === 'src/auth.ts')?.status).toBe('modified');

    // Functions added/changed.
    const fnNames = result.functions.map(f => f.name).sort();
    expect(fnNames).toContain('login');
    expect(fnNames).toContain('logout');
    expect(fnNames).toContain('createTask');

    // Type added.
    expect(result.types.map(t => t.name)).toContain('Task');

    db.close();
  });

  it('throws a clear error when the git ref does not exist', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { repo } = makeGitRepo();
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));

    expect(() => gitChangedFiles(repo, 'definitely-not-a-real-branch'))
      .toThrow(/not found|bad revision|unknown revision/i);

    db.close();
  });
});
