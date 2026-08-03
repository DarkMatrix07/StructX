import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase } from '../src/db/connection';
import { ingestDirectory } from '../src/ingest/ingester';
import { findRoutePathsTo, getDeadFunctions } from '../src/db/queries';
import { impactAnalysis } from '../src/query/retriever';

const cleanup: string[] = [];

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of cleanup.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows file lock */ }
  }
});

// The dominant Express idiom: routes registered at module scope with inline
// arrow handlers. Before 3.4.0 none of these produced a function row, so the
// whole controller layer was invisible to the graph.
function writeExpressApp(): string {
  const repo = mkdtempSync(join(tmpdir(), 'structx-inline-'));
  cleanup.push(repo);
  mkdirSync(join(repo, 'src'), { recursive: true });

  writeFileSync(join(repo, 'src', 'service.ts'), `
export function getArticles(query: unknown): string[] {
  return ['a'];
}

export function createArticle(input: string): string {
  return input;
}
`);
  writeFileSync(join(repo, 'src', 'controller.ts'), `
import { getArticles, createArticle } from './service';

declare const router: {
  get(p: string, ...h: unknown[]): void;
  post(p: string, ...h: unknown[]): void;
};
declare const auth: { optional: unknown; required: unknown };

router.get('/articles', auth.optional, async (req: any, res: any) => {
  const result = getArticles(req.query);
  res.json(result);
});

router.post('/articles', auth.required, async (req: any, res: any) => {
  const created = createArticle(req.body);
  res.json(created);
});
`);
  return repo;
}

describe('inline Express route handlers', () => {
  it('extracts inline handlers as functions named by method and path', () => {
    const repo = writeExpressApp();
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    const names = (db.prepare('SELECT name FROM functions ORDER BY name').all() as Array<{ name: string }>)
      .map(r => r.name);
    expect(names).toContain('GET /articles');
    expect(names).toContain('POST /articles');

    db.close();
  });

  it('links each route to its inline handler', () => {
    const repo = writeExpressApp();
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    const rows = db.prepare(`
      SELECT r.method, r.path, f.name AS handler
        FROM routes r JOIN functions f ON f.id = r.handler_function_id
       ORDER BY r.method
    `).all() as Array<{ method: string; path: string; handler: string }>;

    expect(rows).toEqual([
      { method: 'GET', path: '/articles', handler: 'GET /articles' },
      { method: 'POST', path: '/articles', handler: 'POST /articles' },
    ]);

    db.close();
  });

  it('records the calls made inside an inline handler', () => {
    const repo = writeExpressApp();
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    const callees = (db.prepare(`
      SELECT r.callee_name FROM relationships r
        JOIN functions f ON f.id = r.caller_function_id
       WHERE f.name = 'GET /articles' AND r.relation_type = 'calls'
    `).all() as Array<{ callee_name: string }>).map(r => r.callee_name);

    expect(callees).toContain('getArticles');
    db.close();
  });

  it('traces an endpoint to a service function — the Express case that used to return nothing', () => {
    const repo = writeExpressApp();
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    const paths = findRoutePathsTo(db, 'createArticle');
    expect(paths).toHaveLength(1);
    expect(paths[0].method).toBe('POST');
    expect(paths[0].path).toBe('/articles');
    expect(paths[0].callPath.map(s => s.name)).toEqual(['POST /articles', 'createArticle']);

    db.close();
  });

  it('reports the endpoint in impact analysis', () => {
    const repo = writeExpressApp();
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    const impact = impactAnalysis(db, 'getArticles');
    expect(impact.routes.map(r => `${r.method} ${r.path}`)).toContain('GET /articles');
    db.close();
  });

  it('never reports a route handler as dead code', () => {
    const repo = writeExpressApp();
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    // Handlers have no callers by construction — an HTTP request is an
    // inbound edge the graph cannot see. Reporting them as removable would
    // advise deleting the API.
    const dead = getDeadFunctions(db, 100).map(f => f.name);
    expect(dead).not.toContain('GET /articles');
    expect(dead).not.toContain('POST /articles');

    db.close();
  });

  it('attributes handler calls to the handler, not the enclosing function', () => {
    const repo = mkdtempSync(join(tmpdir(), 'structx-inline-nested-'));
    cleanup.push(repo);
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'setup.ts'), `
export function helper(): string { return 'x'; }

declare const app: { get(p: string, h: unknown): void };

export function registerRoutes(): void {
  app.get('/thing', (req: any, res: any) => {
    res.json(helper());
  });
}
`);
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    const callersOfHelper = (db.prepare(`
      SELECT f.name FROM relationships r
        JOIN functions f ON f.id = r.caller_function_id
       WHERE r.callee_name = 'helper'
    `).all() as Array<{ name: string }>).map(r => r.name);

    // The handler owns the call; registerRoutes merely registers it.
    expect(callersOfHelper).toContain('GET /thing');
    expect(callersOfHelper).not.toContain('registerRoutes');

    db.close();
  });
});
