import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase } from '../src/db/connection';
import { ingestDirectory } from '../src/ingest/ingester';
import {
  findCallPaths, findRoutePathsTo, semanticQuery, semanticFacets,
  updateSemanticFields, getFunctionByName,
} from '../src/db/queries';

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

// A small but realistic app: endpoint -> controller -> service -> repository.
function writeApp(): string {
  const repo = mkdtempSync(join(tmpdir(), 'structx-path-'));
  cleanup.push(repo);
  mkdirSync(join(repo, 'src'), { recursive: true });

  writeFileSync(join(repo, 'src', 'repository.ts'), `
export function chargeCard(amount: number): string {
  return 'charged:' + amount;
}

export function auditLog(message: string): string {
  return message;
}
`);
  writeFileSync(join(repo, 'src', 'service.ts'), `
import { chargeCard, auditLog } from './repository';

export function processPayment(amount: number): string {
  auditLog('starting');
  return chargeCard(amount);
}

export function unrelated(): string {
  return 'nothing';
}
`);
  writeFileSync(join(repo, 'src', 'orders.controller.ts'), `
import { processPayment } from './service';

@Controller('orders')
export class OrdersController {
  @Post('checkout')
  checkout(amount: number): string {
    return processPayment(amount);
  }
}
`);
  return repo;
}

describe('structx_path — call chain tracing', () => {
  it('finds the chain between two functions', () => {
    const repo = writeApp();
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    const paths = findCallPaths(db, 'OrdersController.checkout', 'chargeCard');
    expect(paths.length).toBeGreaterThan(0);

    const names = paths[0].steps.map(s => s.name);
    expect(names).toEqual(['OrdersController.checkout', 'processPayment', 'chargeCard']);
    expect(paths[0].depth).toBe(2);
    // Locations come through so an agent can open the right file.
    expect(paths[0].steps[2].filePath).toBe('src/repository.ts');

    db.close();
  });

  it('returns nothing when no chain exists', () => {
    const repo = writeApp();
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    expect(findCallPaths(db, 'unrelated', 'chargeCard')).toHaveLength(0);
    db.close();
  });

  it('respects the depth cap', () => {
    const repo = writeApp();
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    // The real chain is 2 hops; a 1-hop budget must not find it.
    expect(findCallPaths(db, 'OrdersController.checkout', 'chargeCard', 1)).toHaveLength(0);
    db.close();
  });

  it('traces from HTTP endpoints to a deep function', () => {
    const repo = writeApp();
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    const routePaths = findRoutePathsTo(db, 'chargeCard');
    expect(routePaths).toHaveLength(1);
    expect(routePaths[0].method).toBe('POST');
    expect(routePaths[0].path).toBe('/orders/checkout');
    expect(routePaths[0].callPath.map(s => s.name)).toEqual([
      'OrdersController.checkout', 'processPayment', 'chargeCard',
    ]);

    db.close();
  });

  it('terminates on cyclic call graphs', () => {
    const repo = mkdtempSync(join(tmpdir(), 'structx-cycle-'));
    cleanup.push(repo);
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'cycle.ts'), `
export function a(): number { return b(); }
export function b(): number { return a(); }
export function target(): number { return 1; }
`);
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    // Must return (not hang or blow the stack) even though a <-> b is a cycle.
    expect(findCallPaths(db, 'a', 'target')).toHaveLength(0);
    db.close();
  });
});

describe('structx_query — semantic filtering', () => {
  function analyzedRepo() {
    const repo = writeApp();
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    // Stand in for the LLM analysis pass.
    const label = (name: string, domain: string, complexity: string, effects: string[]) => {
      const fn = getFunctionByName(db, name);
      if (!fn) throw new Error(`fixture missing function ${name}`);
      updateSemanticFields(db, fn.id, {
        purpose: `${name} purpose`,
        behavior_summary: `${name} behavior`,
        side_effects_json: JSON.stringify(effects),
        domain,
        complexity,
      });
    };
    label('chargeCard', 'database', 'high', ['writes to DB', 'calls payment API']);
    label('auditLog', 'logging', 'low', ['writes to DB']);
    label('processPayment', 'api', 'medium', ['calls payment API']);
    return db;
  }

  it('filters by domain', () => {
    const db = analyzedRepo();
    const rows = semanticQuery(db, { domain: 'database' });
    expect(rows.map(r => r.name)).toEqual(['chargeCard']);
    db.close();
  });

  it('filters by side effect substring across functions', () => {
    const db = analyzedRepo();
    const rows = semanticQuery(db, { sideEffect: 'writes to DB' });
    expect(rows.map(r => r.name).sort()).toEqual(['auditLog', 'chargeCard']);
    db.close();
  });

  it('combines filters conjunctively', () => {
    const db = analyzedRepo();
    const rows = semanticQuery(db, { sideEffect: 'writes to DB', complexity: 'high' });
    expect(rows.map(r => r.name)).toEqual(['chargeCard']);
    db.close();
  });

  it('honours the limit and reports facets', () => {
    const db = analyzedRepo();
    expect(semanticQuery(db, { analyzedOnly: true, limit: 2 })).toHaveLength(2);

    const facets = semanticFacets(db);
    expect(facets.analyzed).toBe(3);
    expect(facets.domains.map(d => d.value).sort()).toEqual(['api', 'database', 'logging']);
    expect(facets.complexities.map(d => d.value).sort()).toEqual(['high', 'low', 'medium']);
    db.close();
  });

  it('treats an unmatched filter as empty rather than erroring', () => {
    const db = analyzedRepo();
    expect(semanticQuery(db, { domain: 'nonexistent-domain' })).toHaveLength(0);
    db.close();
  });
});
