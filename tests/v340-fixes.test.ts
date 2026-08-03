import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase } from '../src/db/connection';
import { ingestDirectory } from '../src/ingest/ingester';
import { estimateCost } from '../src/utils/tokens';
import { getFunctionByName, updateSemanticFields, semanticQuery } from '../src/db/queries';
import { normalizeSideEffects } from '../src/semantic/validator';

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

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'structx-fixes-'));
  cleanup.push(repo);
  mkdirSync(join(repo, 'src'), { recursive: true });
  return repo;
}

describe('decorator invocations are not call edges', () => {
  it('excludes parameter and method decorators from the call graph', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'src', 'cats.controller.ts'), `
export function Body(): any { return () => {}; }
export function realHelper(id: string): string { return id; }

@Controller('cats')
export class CatsController {
  @Get(':id')
  findOne(@Body() id: string): string {
    return realHelper(id);
  }
}
`);
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    const callees = (db.prepare(`
      SELECT r.callee_name FROM relationships r
        JOIN functions f ON f.id = r.caller_function_id
       WHERE f.name = 'CatsController.findOne' AND r.relation_type = 'calls'
    `).all() as Array<{ callee_name: string }>).map(r => r.callee_name);

    // The genuine call survives; the decorators that merely wire the handler
    // up to the framework do not become dependencies of it.
    expect(callees).toContain('realHelper');
    expect(callees).not.toContain('Body');
    expect(callees).not.toContain('Get');

    db.close();
  });
});

describe('CommonJS export extraction', () => {
  it('extracts exports.foo and module.exports.foo function assignments', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'src', 'util.js'), `
exports.formatName = function (first, last) {
  return first + ' ' + last;
};

module.exports.parseAge = (raw) => {
  return Number(raw);
};

exports.notAFunction = 42;
`);
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    const names = (db.prepare('SELECT name, is_exported FROM functions ORDER BY name')
      .all() as Array<{ name: string; is_exported: number }>);

    expect(names.map(n => n.name)).toEqual(['formatName', 'parseAge']);
    // CommonJS exports are public by definition.
    expect(names.every(n => n.is_exported === 1)).toBe(true);

    db.close();
  });
});

describe('route extraction ignores map/lookup calls', () => {
  it('does not treat map.get("/path") as an HTTP route', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'src', 'server.ts'), `
declare const app: { get(p: string, h: unknown): void; use(p: string, h: unknown): void };
const cache = new Map<string, string>();

export function realHandler(): string { return 'ok'; }

export function setup(): void {
  // A genuine route: path + handler.
  app.get('/users', realHandler);
  // Not routes: a Map lookup and a lookup-table assignment.
  cache.get('/foo/bar');
  cache.set('/alias', '/target');
}
`);
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    const routes = (db.prepare('SELECT method, path FROM routes').all() as Array<{ method: string; path: string }>);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toEqual({ method: 'GET', path: '/users' });

    db.close();
  });
});

describe('NestJS @Controller options form', () => {
  it('reads the path from an object-literal decorator argument', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'src', 'users.controller.ts'), `
@Controller({ path: "/v2/oauth-clients/:clientId/users", version: "2" })
export class OAuthUsersController {
  @Get()
  getManagedUsers(): string { return 'ok'; }

  @Post(':userId')
  updateUser(): string { return 'ok'; }
}
`);
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    const paths = (db.prepare('SELECT method, path FROM routes ORDER BY method')
      .all() as Array<{ method: string; path: string }>);

    // Without object-literal support these collapsed to '/' and '/:userId'.
    expect(paths).toEqual([
      { method: 'GET', path: '/v2/oauth-clients/:clientId/users' },
      { method: 'POST', path: '/v2/oauth-clients/:clientId/users/:userId' },
    ]);

    db.close();
  });
});

describe('side-effect vocabulary', () => {
  it('normalizes the free-text phrasings models actually emit', async () => {
    const { normalizeSideEffects } = await import('../src/semantic/validator');

    // Exact strings observed from mistral-small on a real repo.
    expect(normalizeSideEffects(['DB writes'])).toEqual(['db_write']);
    expect(normalizeSideEffects(['network calls'])).toEqual(['network']);
    expect(normalizeSideEffects(['Network call to logout function'])).toEqual(['network']);
    expect(normalizeSideEffects(['console output'])).toEqual(['console']);
    expect(normalizeSideEffects(['Sends JSON response'])).toEqual(['response']);

    // Already-canonical tags pass through; duplicates collapse.
    expect(normalizeSideEffects(['db_write', 'DB writes'])).toEqual(['db_write']);
    // Unrecognizable prose is dropped rather than polluting the index.
    expect(normalizeSideEffects(['does something vague', 'none', ''])).toEqual([]);
  });

  it('makes --side-effect filtering find every writer, not just one phrasing', () => {
    const repo = makeRepo();
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    writeFileSync(join(repo, 'src', 'x.ts'), 'export function a(): void {}\nexport function b(): void {}\n');
    ingestDirectory(db, repo, 0.3);

    // Simulate two functions the model described with DIFFERENT prose for the
    // same concept — the exact failure that motivated the vocabulary.
    for (const [name, prose] of [['a', 'DB writes'], ['b', 'writes to the database']] as const) {
      const fn = getFunctionByName(db, name);
      expect(fn).toBeDefined();
      updateSemanticFields(db, fn!.id, {
        purpose: 'p', behavior_summary: 'b',
        side_effects_json: JSON.stringify(normalizeSideEffects([prose])),
        domain: 'database', complexity: 'low',
      });
    }

    expect(semanticQuery(db, { sideEffect: 'db_write' }).map((r: any) => r.name).sort()).toEqual(['a', 'b']);
    db.close();
  });
});

describe('cost estimation covers configured OpenRouter defaults', () => {
  it('prices the models OPENROUTER_DEFAULTS actually selects', () => {
    // Before 3.4.0 these fell through to the generic $1/$5 fallback, making
    // structx_costs wrong for anyone on the default OpenRouter config.
    const haiku = estimateCost('anthropic/claude-haiku-4.5', 1_000_000, 1_000_000);
    const sonnet = estimateCost('anthropic/claude-sonnet-4.5', 1_000_000, 1_000_000);
    const unknown = estimateCost('some/unlisted-model', 1_000_000, 1_000_000);

    expect(haiku).toBeCloseTo(0.8 + 4.0, 5);
    expect(sonnet).toBeCloseTo(3.0 + 15.0, 5);
    // The fallback still applies to genuinely unknown models.
    expect(unknown).toBeCloseTo(1.0 + 5.0, 5);
  });
});
