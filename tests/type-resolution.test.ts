import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase } from '../src/db/connection';
import { ingestDirectory } from '../src/ingest/ingester';
import { impactAnalysis } from '../src/query/retriever';

const cleanup: string[] = [];

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of cleanup.splice(0)) {
    // Windows keeps a handle on the SQLite file briefly after close; a failed
    // temp-dir cleanup must not fail the test that just passed.
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ }
  }
});

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'structx-typeres-'));
  cleanup.push(repo);
  mkdirSync(join(repo, 'src'), { recursive: true });
  return repo;
}

// Two files export a function with the SAME name. A third imports one of them
// explicitly — from z-store, the file ingested LAST. Name matching binds
// whichever `save` happens to exist when service.ts is processed, which in
// sorted-file order is a-store's. So the pre-3.4 resolver produces a
// confidently wrong edge here, and only the type checker gets it right.
function writeAmbiguousRepo(repo: string): void {
  writeFileSync(join(repo, 'src', 'a-store.ts'), `
export function save(value: string): string {
  return 'a:' + value;
}
`);
  writeFileSync(join(repo, 'src', 'z-store.ts'), `
export function save(value: string): string {
  return 'z:' + value;
}
`);
  writeFileSync(join(repo, 'src', 'service.ts'), `
import { save } from './z-store';

export function placeOrder(id: string): string {
  return save(id);
}
`);
}

function boundFilePath(db: any, functionId: number | null): string | undefined {
  if (functionId === null) return undefined;
  return (db.prepare(`
    SELECT files.path as path FROM functions
      JOIN files ON files.id = functions.file_id
     WHERE functions.id = ?
  `).get(functionId) as { path: string } | undefined)?.path;
}

function callEdge(db: any, callerName: string, calleeName: string) {
  return db.prepare(`
    SELECT r.callee_function_id, r.callee_decl_file, r.callee_decl_name
      FROM relationships r
      JOIN functions f ON f.id = r.caller_function_id
     WHERE f.name = ? AND r.callee_name = ?
  `).get(callerName, calleeName) as
    { callee_function_id: number | null; callee_decl_file: string | null; callee_decl_name: string | null } | undefined;
}

describe('type-resolved call graph', () => {
  it('binds an ambiguous call to the function that was actually imported', () => {
    const repo = makeRepo();
    writeAmbiguousRepo(repo);
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));

    ingestDirectory(db, repo, 0.3);

    const edge = callEdge(db, 'placeOrder', 'save');
    expect(edge).toBeDefined();
    // The checker recorded which file the call actually targets.
    expect(edge!.callee_decl_file).toBe('src/z-store.ts');
    expect(edge!.callee_decl_name).toBe('save');

    // ...and the edge is bound to that file's `save`, not the other one.
    expect(boundFilePath(db, edge!.callee_function_id)).toBe('src/z-store.ts');

    db.close();
  });

  it('binds the ambiguous call to the wrong function when type resolution is disabled', () => {
    const repo = makeRepo();
    writeAmbiguousRepo(repo);
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));

    ingestDirectory(db, repo, 0.3, { typeResolution: false });

    const edge = callEdge(db, 'placeOrder', 'save');
    expect(edge).toBeDefined();
    expect(edge!.callee_decl_file).toBeNull();

    // Documents the pre-3.4 failure mode this feature exists to fix: with only
    // a name to go on, the edge binds to a-store's `save` purely because that
    // file was ingested first. The call actually targets z-store's.
    expect(boundFilePath(db, edge!.callee_function_id)).toBe('src/a-store.ts');

    db.close();
  });

  it('does not bind calls into node_modules or the standard library', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'src', 'util.ts'), `
export function encode(input: unknown): string {
  return JSON.stringify(input);
}
`);
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    const edge = callEdge(db, 'encode', 'JSON.stringify');
    expect(edge).toBeDefined();
    expect(edge!.callee_decl_file).toBeNull();
    expect(edge!.callee_function_id).toBeNull();

    db.close();
  });

  it('resolves method calls to the declaring class', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'src', 'mailer.ts'), `
export class Mailer {
  send(to: string): string {
    return this.format(to);
  }

  format(to: string): string {
    return 'to:' + to;
  }
}
`);
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    // `this.format(...)` is recorded under the bare property name, since the
    // receiver `this` carries no statically useful identifier.
    const edge = callEdge(db, 'Mailer.send', 'format');
    expect(edge).toBeDefined();
    expect(edge!.callee_decl_name).toBe('Mailer.format');
    expect(edge!.callee_function_id).not.toBeNull();

    db.close();
  });
});

describe('route to handler linking', () => {
  it('links decorator routes to their handler function and reports affected endpoints', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'src', 'session.ts'), `
export function validateSession(token: string): boolean {
  return token.length > 0;
}
`);
    writeFileSync(join(repo, 'src', 'user-controller.ts'), `
import { validateSession } from './session';

@Controller('users')
export class UserController {
  @Get(':id')
  findOne(id: string): string {
    return validateSession(id) ? 'ok' : 'denied';
  }
}
`);
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    const route = db.prepare(`
      SELECT r.path, r.handler_name, r.handler_function_id, f.name as handlerFunction
        FROM routes r LEFT JOIN functions f ON f.id = r.handler_function_id
       WHERE r.path = '/users/:id'
    `).get() as { handler_name: string; handler_function_id: number | null; handlerFunction: string | null } | undefined;

    expect(route).toBeDefined();
    expect(route!.handler_function_id).not.toBeNull();
    expect(route!.handlerFunction).toBe('UserController.findOne');

    // The point of the link: changing validateSession now surfaces the
    // endpoint that depends on it, not just the calling function.
    const impact = impactAnalysis(db, 'validateSession');
    expect(impact.functions.map(f => f.name)).toContain('UserController.findOne');
    expect(impact.routes.map(r => `${r.method} ${r.path}`)).toContain('GET /users/:id');

    db.close();
  });

  it('links express-style routes to a handler defined in another file', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'src', 'handlers.ts'), `
export function listUsers(req: unknown, res: unknown): void {
  void req;
  void res;
}
`);
    writeFileSync(join(repo, 'src', 'routes.ts'), `
import { listUsers } from './handlers';

declare const app: { get(path: string, handler: unknown): void };

export function registerRoutes(): void {
  app.get('/users', listUsers);
}
`);
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    const route = db.prepare(`
      SELECT f.name as handlerFunction FROM routes r
        LEFT JOIN functions f ON f.id = r.handler_function_id
       WHERE r.path = '/users'
    `).get() as { handlerFunction: string | null } | undefined;

    expect(route).toBeDefined();
    expect(route!.handlerFunction).toBe('listUsers');

    db.close();
  });
});
