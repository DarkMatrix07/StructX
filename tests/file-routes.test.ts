import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase } from '../src/db/connection';
import { ingestDirectory } from '../src/ingest/ingester';
import { fileBasedRoutePath } from '../src/ingest/route-extractor';
import { findRoutePathsTo } from '../src/db/queries';

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

describe('fileBasedRoutePath', () => {
  it('maps framework conventions to URL paths', () => {
    // Next.js App Router
    expect(fileBasedRoutePath('/repo/app/api/users/[id]/route.ts')).toBe('/api/users/:id');
    expect(fileBasedRoutePath('/repo/apps/web/app/api/health/route.ts')).toBe('/api/health');
    // Route groups are organisational, not part of the URL.
    expect(fileBasedRoutePath('/repo/app/(marketing)/api/leads/route.ts')).toBe('/api/leads');
    // Catch-all segments.
    expect(fileBasedRoutePath('/repo/app/api/docs/[...slug]/route.ts')).toBe('/api/docs/*');
    // Next.js Pages API — the filename is the last segment.
    expect(fileBasedRoutePath('/repo/pages/api/users/[id].ts')).toBe('/api/users/:id');
    expect(fileBasedRoutePath('/repo/pages/api/health.ts')).toBe('/api/health');
    expect(fileBasedRoutePath('/repo/pages/api/index.ts')).toBe('/api');
    // SvelteKit
    expect(fileBasedRoutePath('/repo/src/routes/users/+server.ts')).toBe('/users');
    // Medusa v2
    expect(fileBasedRoutePath('/repo/src/api/admin/orders/route.ts')).toBe('/admin/orders');
    // Windows separators
    expect(fileBasedRoutePath('C:\\repo\\app\\api\\ping\\route.ts')).toBe('/api/ping');
  });

  it('returns null for files that are not route modules', () => {
    expect(fileBasedRoutePath('/repo/src/service.ts')).toBeNull();
    expect(fileBasedRoutePath('/repo/app/page.tsx')).toBeNull();
    expect(fileBasedRoutePath('/repo/src/utils/router.ts')).toBeNull();
  });
});

describe('file-based route extraction', () => {
  it('extracts verb exports from an App Router route module and links them', () => {
    const repo = mkdtempSync(join(tmpdir(), 'structx-filerts-'));
    cleanup.push(repo);
    mkdirSync(join(repo, 'app', 'api', 'users', '[id]'), { recursive: true });
    mkdirSync(join(repo, 'lib'), { recursive: true });

    writeFileSync(join(repo, 'lib', 'db.ts'), `
export function findUser(id: string): string { return id; }
export function deleteUser(id: string): string { return id; }
`);
    writeFileSync(join(repo, 'app', 'api', 'users', '[id]', 'route.ts'), `
import { findUser, deleteUser } from '../../../../lib/db';

export async function GET(req: Request): Promise<string> {
  return findUser('1');
}

export const DELETE = async (req: Request): Promise<string> => {
  return deleteUser('1');
};
`);

    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    const routes = (db.prepare('SELECT method, path, handler_name, handler_function_id FROM routes ORDER BY method')
      .all() as Array<{ method: string; path: string; handler_name: string; handler_function_id: number | null }>);

    expect(routes.map(r => `${r.method} ${r.path}`)).toEqual([
      'DELETE /api/users/:id',
      'GET /api/users/:id',
    ]);
    // Both handlers resolved to real function rows.
    expect(routes.every(r => r.handler_function_id !== null)).toBe(true);

    // And the endpoint trace reaches the data layer.
    const paths = findRoutePathsTo(db, 'findUser');
    expect(paths).toHaveLength(1);
    expect(paths[0].method).toBe('GET');
    expect(paths[0].callPath.map(s => s.name)).toEqual(['GET', 'findUser']);

    db.close();
  });

  it('treats a Pages API default export as a route', () => {
    const repo = mkdtempSync(join(tmpdir(), 'structx-pagesapi-'));
    cleanup.push(repo);
    mkdirSync(join(repo, 'pages', 'api'), { recursive: true });
    writeFileSync(join(repo, 'pages', 'api', 'health.ts'), `
export default function handler(req: any, res: any): void {
  res.json({ ok: true });
}
`);
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    const routes = (db.prepare('SELECT method, path FROM routes').all() as Array<{ method: string; path: string }>);
    expect(routes).toEqual([{ method: 'ALL', path: '/api/health' }]);

    db.close();
  });

  it('does not invent routes for ordinary modules', () => {
    const repo = mkdtempSync(join(tmpdir(), 'structx-noroutes-'));
    cleanup.push(repo);
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'util.ts'), `
export function GET(): string { return 'not a route'; }
`);
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    // A function called GET outside a route module is just a function.
    expect((db.prepare('SELECT COUNT(*) c FROM routes').get() as { c: number }).c).toBe(0);
    db.close();
  });
});
