import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { initializeDatabase } from '../src/db/connection';
import { getAllFiles } from '../src/db/queries';
import { ingestDirectory } from '../src/ingest/ingester';
import { closeAllDbs, setReadonly } from '../src/mcp/db-pool';
import { registerTools } from '../src/mcp/tools';
import { getGraphFingerprint, makeAskCacheKey } from '../src/query/ask-cache';
import { directLookup, directLookupExpanded, impactAnalysis, listQuery, patternQuery, relationshipQuery, typeQuery } from '../src/query/retriever';
import { getDeadFunctions } from '../src/db/queries';
import { buildContext } from '../src/query/context-builder';
import { insertQaRun, insertRoute, insertType, upsertFile } from '../src/db/queries';
import { watchDirectory } from '../src/watch/watcher';
import { openDatabase } from '../src/db/connection';

const cleanup: string[] = [];

function writeProject(repo: string, variant = 'base'): void {
  mkdirSync(join(repo, 'src', 'mcp'), { recursive: true });
  mkdirSync(join(repo, 'src', 'features'), { recursive: true });
  mkdirSync(join(repo, '.claude', 'worktrees', 'agent-a', 'src'), { recursive: true });

  writeFileSync(join(repo, 'src', 'mcp', 'tools.ts'), `
export function registerMcpTools(keyword: string): string {
  const normalized = keyword.trim().toLowerCase();
  return normalized ? \`tool:\${normalized}\` : 'tool:empty';
}

export function callRegisterMcpTools(): string {
  return registerMcpTools('search');
}
`);

  writeFileSync(join(repo, 'src', 'features', 'billing-service.ts'), `
export const BILLING_LIMITS = { maxInvoices: 100, currency: 'USD' };

export interface Invoice {
  subtotal: number;
  total: number;
}

export interface BillingSearchOptions {
  customerId: string;
  limit?: number;
}

export function calculateInvoice(input: number): Invoice {
  const tax = roundCurrency(input * 0.2);
  return { subtotal: input, total: input + tax };
}

export function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

export function printInvoice(): Invoice {
  return calculateInvoice(${variant === 'changed' ? '25' : '10'});
}
`);

  writeFileSync(join(repo, '.claude', 'worktrees', 'agent-a', 'src', 'leaked.ts'), `
export function shouldNotBeIndexed(): string {
  return 'agent scratch';
}
`);
}

function createIndexedRepo(): { repo: string; dbPath: string } {
  const repo = mkdtempSync(join(tmpdir(), 'structx-mcp-test-'));
  cleanup.push(repo);
  writeProject(repo);
  const dbPath = join(repo, '.structx', 'db.sqlite');
  const db = initializeDatabase(dbPath);
  ingestDirectory(db, repo, 0.2);
  db.close();
  return { repo, dbPath };
}

// Poll a condition until it returns truthy or the deadline passes. Used by
// tests that need to wait on async filesystem-driven side effects (the
// watcher's debounced flush) without sleeping for a fixed duration.
async function waitForCondition(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

async function createMcpClient(repo: string): Promise<{ client: Client; server: McpServer }> {
  const server = new McpServer({ name: 'structx-test', version: '0.0.0' });
  registerTools(server, repo);

  const client = new Client({ name: 'structx-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

afterEach(() => {
  vi.restoreAllMocks();
  setReadonly(false);
  closeAllDbs();
  for (const repo of cleanup.splice(0)) {
    rmSync(repo, { recursive: true, force: true });
  }
});

describe('MCP graph tools', () => {
  it('excludes test/benchmark/config files from the default source graph', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // Battle-tested case from hono: 1338 fake "routes" coming from
    // benchmarks/, runtime-tests/, and *.test.ts files polluting the
    // graph. The default source-quality excludes should drop all of
    // these and leave only the genuine production code.
    const repo = mkdtempSync(join(tmpdir(), 'structx-source-quality-test-'));
    cleanup.push(repo);
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, 'benchmarks'), { recursive: true });
    mkdirSync(join(repo, 'runtime-tests'), { recursive: true });
    mkdirSync(join(repo, 'src', '__tests__'), { recursive: true });

    const productionFn = `export function realProduction(): number { return 1; }`;
    writeFileSync(join(repo, 'src', 'real.ts'), productionFn);
    // All of these should be excluded:
    writeFileSync(join(repo, 'src', 'real.test.ts'), `export function tested(): number { return 1; }`);
    writeFileSync(join(repo, 'src', 'real.spec.ts'), `export function spec(): number { return 2; }`);
    writeFileSync(join(repo, 'src', '__tests__', 'helpers.ts'), `export function helper(): number { return 3; }`);
    writeFileSync(join(repo, 'benchmarks', 'fast.ts'), `export function bench(): number { return 4; }`);
    writeFileSync(join(repo, 'runtime-tests', 'lambda.ts'), `export function runtime(): number { return 5; }`);
    writeFileSync(join(repo, 'vite.config.ts'), `export default {};`);

    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);
    const files = getAllFiles(db).map(f => f.path).sort();
    db.close();

    expect(files).toEqual(['src/real.ts']);
  });

  it('excludes monorepo non-library paths (examples/, www/, scripts/, tests/)', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // Battle-tested case from tRPC: examples/ (264 files), www/ (52),
    // packages/tests/ (~280) all polluted the production graph. Library
    // code in packages/ should remain — every other top-level dir on
    // this fixture should drop out.
    const repo = mkdtempSync(join(tmpdir(), 'structx-monorepo-test-'));
    cleanup.push(repo);
    mkdirSync(join(repo, 'packages', 'core', 'src'), { recursive: true });
    mkdirSync(join(repo, 'examples', 'demo-app', 'src'), { recursive: true });
    mkdirSync(join(repo, 'www', 'src'), { recursive: true });
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    mkdirSync(join(repo, 'packages', 'tests', 'src'), { recursive: true });

    writeFileSync(join(repo, 'packages', 'core', 'src', 'lib.ts'), `export function lib(): number { return 1; }`);
    writeFileSync(join(repo, 'examples', 'demo-app', 'src', 'app.ts'), `export function demoApp(): number { return 2; }`);
    writeFileSync(join(repo, 'www', 'src', 'index.ts'), `export function docsSite(): number { return 3; }`);
    writeFileSync(join(repo, 'scripts', 'build.ts'), `export function buildScript(): number { return 4; }`);
    writeFileSync(join(repo, 'packages', 'tests', 'src', 'helpers.ts'), `export function testHelper(): number { return 5; }`);

    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);
    const files = getAllFiles(db).map(f => f.path).sort();
    db.close();

    expect(files).toEqual(['packages/core/src/lib.ts']);
  });

  it('excludes nested e2e/ and sample/ directories at any depth', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // Battle-tested case from NestJS: 18 fake "routes" came from
    // `integration/hello-world/e2e/...`, `sample/01-cats-app/e2e/...`,
    // and `sample/N-foo/e2e/...spec.ts`. Top-level-only patterns (e2e/**)
    // don't catch these — the patterns must be recursive (**/e2e/**).
    const repo = mkdtempSync(join(tmpdir(), 'structx-nested-excludes-test-'));
    cleanup.push(repo);
    mkdirSync(join(repo, 'packages', 'core', 'src'), { recursive: true });
    mkdirSync(join(repo, 'packages', 'core', 'e2e'), { recursive: true });
    mkdirSync(join(repo, 'sample', '01-cats-app', 'src'), { recursive: true });
    mkdirSync(join(repo, 'integration', 'hello-world', 'e2e'), { recursive: true });
    mkdirSync(join(repo, 'src', 'examples'), { recursive: true });

    writeFileSync(join(repo, 'packages', 'core', 'src', 'lib.ts'), `export function lib(): number { return 1; }`);
    writeFileSync(join(repo, 'packages', 'core', 'e2e', 'spec.ts'), `export function nestedE2E(): number { return 2; }`);
    writeFileSync(join(repo, 'sample', '01-cats-app', 'src', 'app.ts'), `export function sample(): number { return 3; }`);
    writeFileSync(join(repo, 'integration', 'hello-world', 'e2e', 'middleware.ts'), `export function deepE2E(): number { return 4; }`);
    writeFileSync(join(repo, 'src', 'examples', 'usage.ts'), `export function srcExample(): number { return 5; }`);

    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);
    const files = getAllFiles(db).map(f => f.path).sort();
    db.close();

    // Only the legitimate library file survives.
    expect(files).toEqual(['packages/core/src/lib.ts']);
  });

  it('excludes auto-generated code (*.generated.ts, Generated.ts, __generated__/)', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // Battle-tested case from Effect-TS: AI-provider OpenAPI clients
    // (Generated.ts files) emitted 330 of the 337 detected "routes"
    // from auto-generated client code. Plus the standard *.generated.ts
    // and __generated__/ conventions used by graphql-codegen, Prisma,
    // tRPC procedure codegen, and others.
    const repo = mkdtempSync(join(tmpdir(), 'structx-codegen-test-'));
    cleanup.push(repo);
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, 'src', '__generated__'), { recursive: true });
    mkdirSync(join(repo, 'src', 'generated'), { recursive: true });

    writeFileSync(join(repo, 'src', 'real.ts'), `export function real(): number { return 1; }`);
    writeFileSync(join(repo, 'src', 'Generated.ts'), `export function generatedClient(): number { return 2; }`);
    writeFileSync(join(repo, 'src', 'schema.generated.ts'), `export function gqlSchema(): number { return 3; }`);
    writeFileSync(join(repo, 'src', 'route.gen.ts'), `export function routeGen(): number { return 4; }`);
    writeFileSync(join(repo, 'src', '__generated__', 'types.ts'), `export function genTypes(): number { return 5; }`);
    writeFileSync(join(repo, 'src', 'generated', 'api.ts'), `export function genApi(): number { return 6; }`);

    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);
    const files = getAllFiles(db).map(f => f.path).sort();
    db.close();

    expect(files).toEqual(['src/real.ts']);
  });

  it('excludes vitest/jest setup files that do not match *.config.ts', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // Battle-tested case from Effect-TS where vitest.workspace.ts /
    // vitest.shared.ts / vitest.setup.ts at the repo root were
    // incorrectly indexed as production source.
    const repo = mkdtempSync(join(tmpdir(), 'structx-vitest-setup-test-'));
    cleanup.push(repo);
    mkdirSync(join(repo, 'src'), { recursive: true });

    writeFileSync(join(repo, 'src', 'real.ts'), `export function real(): number { return 1; }`);
    writeFileSync(join(repo, 'vitest.workspace.ts'), `export default {};`);
    writeFileSync(join(repo, 'vitest.shared.ts'), `export const shared = {};`);
    writeFileSync(join(repo, 'vitest.setup.ts'), `export const setup = () => {};`);
    writeFileSync(join(repo, 'jest.setup.ts'), `export const jestSetup = () => {};`);

    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);
    const files = getAllFiles(db).map(f => f.path).sort();
    db.close();

    expect(files).toEqual(['src/real.ts']);
  });

  it('honors .structxignore overrides to re-enable excluded files', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // For projects that DO want to index tests (e.g. for coverage tooling
    // or when tests are the only source), .structxignore's negation rules
    // apply after the defaults.
    const repo = mkdtempSync(join(tmpdir(), 'structx-override-test-'));
    cleanup.push(repo);
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'real.ts'), `export function real(): number { return 1; }`);
    writeFileSync(join(repo, 'src', 'real.test.ts'), `export function tested(): number { return 1; }`);
    writeFileSync(join(repo, '.structxignore'), '!**/*.test.ts\n');

    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);
    const files = getAllFiles(db).map(f => f.path).sort();
    db.close();

    expect(files).toEqual(['src/real.test.ts', 'src/real.ts']);
  });

  it('does not ingest local agent worktrees or scratch directories', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { dbPath } = createIndexedRepo();
    const db = initializeDatabase(dbPath);
    const files = getAllFiles(db).map(f => f.path).sort();
    db.close();

    expect(files).toEqual([
      'src/features/billing-service.ts',
      'src/mcp/tools.ts',
    ]);
    expect(files.some(f => f.includes('.claude'))).toBe(false);
  });

  it('finds files by path terms in broad search even when FTS metadata is sparse', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { dbPath } = createIndexedRepo();
    const db = initializeDatabase(dbPath);

    const ctx = patternQuery(db, ['mcp', 'tools']);
    db.close();

    expect(ctx.files.map(f => f.path)).toContain('src/mcp/tools.ts');
  });

  it('finds camel-case type names for natural search phrases', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { dbPath } = createIndexedRepo();
    const db = initializeDatabase(dbPath);

    const ctx = typeQuery(db, 'search parameters');
    db.close();

    expect(ctx.types.map(t => t.name)).toContain('BillingSearchOptions');
  });

  it('returns every exact type-name match instead of an arbitrary duplicate', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { dbPath } = createIndexedRepo();
    const db = initializeDatabase(dbPath);
    const fileId = upsertFile(db, 'src/features/alternate-invoice.ts', 'alt-invoice');
    insertType(db, {
      file_id: fileId,
      name: 'Invoice',
      kind: 'interface',
      full_text: 'export interface Invoice { id: string; }',
      is_exported: true,
      start_line: 1,
      end_line: 1,
    });

    const ctx = typeQuery(db, 'Invoice');
    db.close();

    expect(ctx.types).toHaveLength(2);
    expect(ctx.types.map(t => t.location).sort()).toEqual([
      'src/features/alternate-invoice.ts:1',
      'src/features/billing-service.ts:4',
    ]);
  });

  it('indexes class declarations alongside interfaces / type aliases / enums', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // Battle-tested case: hono's class Hono / class RegExpRouter were
    // invisible to structx_type before this fix because the type
    // extractor only looked at interfaces, type aliases, and enums.
    const repo = mkdtempSync(join(tmpdir(), 'structx-classes-test-'));
    cleanup.push(repo);
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'app.ts'), `
export class Hono {
  fetch(req: Request): Response { return new Response(); }
}

export class RegExpRouter extends Hono {
  add(method: string, path: string): void { /* impl */ }
}

export interface RouterOptions {
  caseSensitive: boolean;
}
`);
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    const honoCtx = typeQuery(db, 'Hono');
    const routerCtx = typeQuery(db, 'RegExpRouter');
    const optionsCtx = typeQuery(db, 'RouterOptions');
    db.close();

    expect(honoCtx.types[0]?.name).toBe('Hono');
    expect(honoCtx.types[0]?.kind).toBe('class');
    expect(routerCtx.types[0]?.kind).toBe('class');
    expect(routerCtx.types[0]?.fullText).toContain('extends Hono');
    // Existing interface lookup still works alongside.
    expect(optionsCtx.types[0]?.kind).toBe('interface');
  });

  it('ingests plain JavaScript and JSX files alongside TypeScript', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // Real-world case: most "TypeScript" repos still have a .js entry
    // point, .mjs config, or a few .jsx leftover from a migration.
    // The graph should pick up exported functions from all three.
    const repo = mkdtempSync(join(tmpdir(), 'structx-js-test-'));
    cleanup.push(repo);
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'lib.ts'), `export function tsFunction(): number { return 1; }`);
    writeFileSync(join(repo, 'src', 'helper.js'), `export function jsFunction() { return 2; }`);
    writeFileSync(join(repo, 'src', 'component.jsx'), `export function JsxComponent() { return <div>hi</div>; }`);
    writeFileSync(join(repo, 'src', 'esm.mjs'), `export function mjsFunction() { return 3; }`);
    writeFileSync(join(repo, 'src', 'cjs.cjs'), `module.exports.cjsFunction = function() { return 4; };`);

    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);
    const fns = listQuery(db, 'functions').functions.map(fn => fn.name).sort();
    db.close();

    expect(fns).toContain('tsFunction');
    expect(fns).toContain('jsFunction');
    expect(fns).toContain('JsxComponent');
    expect(fns).toContain('mjsFunction');
  });

  it('resolves method calls (obj.method) to qualified class methods', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // Real-world case: a function holds an instance variable and calls
    // `instance.method()`. The ingester records the relationship as
    // `caller -> "instance.method"`, but the qualified storage is
    // `ClassName.method`. Variables aren't tracked through type
    // inference, so without the second-pass suffix resolver, the call
    // graph would lose every `obj.method` edge to the actual class.
    const repo = mkdtempSync(join(tmpdir(), 'structx-method-resolve-test-'));
    cleanup.push(repo);
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'app.ts'), `
export class Service {
  doWork(): number { return 42; }
}

export function consumer(): number {
  const svc = new Service();
  return svc.doWork();   // → recorded as "svc.doWork", should resolve to Service.doWork
}
`);
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    // The Service.doWork method should now have `consumer` listed as a caller.
    const callers = relationshipQuery(db, 'doWork', 'callers');
    db.close();

    expect(callers.functions.map(fn => fn.name)).toContain('consumer');
  });

  it('captures class extends + interface extends + class implements as type heritage', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const repo = mkdtempSync(join(tmpdir(), 'structx-type-graph-test-'));
    cleanup.push(repo);
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'shapes.ts'), `
export interface Repository<T> { find(id: string): T | undefined; }
export interface CachedRepository<T> extends Repository<T> { cache(): void; }
export abstract class BaseService { abstract run(): void; }
export class UserService extends BaseService implements Repository<unknown> {
  run(): void {}
  find(id: string): unknown { return undefined; }
}
export class TaskService extends BaseService implements Repository<unknown> {
  run(): void {}
  find(id: string): unknown { return undefined; }
}
`);
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    // What classes implement Repository?
    const repoSubtypes = (db.prepare(`
      SELECT t.name, tr.relation_kind FROM type_relationships tr
      JOIN types t ON t.id = tr.subtype_id
      WHERE tr.supertype_name = 'Repository'
      ORDER BY t.name
    `).all() as Array<{ name: string; relation_kind: string }>);
    expect(repoSubtypes.map(s => `${s.name} (${s.relation_kind})`)).toEqual([
      'CachedRepository (extends)',
      'TaskService (implements)',
      'UserService (implements)',
    ]);

    // What does UserService extend / implement?
    const userServiceParents = (db.prepare(`
      SELECT tr.supertype_name, tr.relation_kind FROM type_relationships tr
      JOIN types t ON t.id = tr.subtype_id
      WHERE t.name = 'UserService'
      ORDER BY tr.relation_kind, tr.supertype_name
    `).all() as Array<{ supertype_name: string; relation_kind: string }>);
    expect(userServiceParents.map(p => `${p.relation_kind} ${p.supertype_name}`)).toEqual([
      'extends BaseService',
      'implements Repository',
    ]);

    db.close();
  });

  it('extracts Web Component custom-element registrations as COMPONENT routes', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const repo = mkdtempSync(join(tmpdir(), 'structx-wc-test-'));
    cleanup.push(repo);
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'wc.ts'), `
function Component(opts: { tag: string }): ClassDecorator { return () => {}; }
function customElement(tag: string): ClassDecorator { return () => {}; }

@Component({ tag: 'my-counter' })
export class MyCounter {}

@customElement('my-button')
export class MyButton {}
`);
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    const routes = listQuery(db, 'routes').routes
      .filter(r => r.method === 'COMPONENT')
      .map(r => `${r.path} ${r.handlerName}`)
      .sort();
    db.close();

    expect(routes).toEqual([
      '/my-button MyButton',
      '/my-counter MyCounter',
    ]);
  });

  it('resolves path-aliased imports via tsconfig for decorator enum args', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // Real-world case from immich: `@Controller(RouteKey.Asset)` with
    // `import { RouteKey } from 'src/enum'` — path alias requires
    // tsconfig for ts-morph's TypeChecker to follow. Without the
    // tsconfig discovery added in v3.3, this falls back to the
    // property-name heuristic ('asset' instead of 'assets').
    const repo = mkdtempSync(join(tmpdir(), 'structx-path-alias-test-'));
    cleanup.push(repo);
    mkdirSync(join(repo, 'src', 'enum'), { recursive: true });
    writeFileSync(join(repo, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { baseUrl: './src', paths: { 'src/*': ['./*'] } },
    }));
    writeFileSync(join(repo, 'src', 'enum', 'route-key.ts'), `
export enum RouteKey { Asset = 'assets', User = 'users' }
`);
    writeFileSync(join(repo, 'src', 'controller.ts'), `
import { RouteKey } from 'src/enum/route-key';
function Controller(p: any): ClassDecorator { return () => {}; }
function Get(p?: string): MethodDecorator { return () => {}; }
@Controller(RouteKey.Asset)
export class AssetController { @Get(':id') findOne() {} }
`);

    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);
    const routes = listQuery(db, 'routes').routes.map(r => r.path).sort();
    db.close();

    // Plural form ('assets') means the enum literal value resolved.
    // Without tsconfig support this would fall back to '/asset/:id'.
    expect(routes).toContain('/assets/:id');
  });

  it('resolves enum-member arguments in @Controller decorators', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // Real-world case from immich: all 40 controllers use
    // `@Controller(RouteKey.Asset)` style enum references instead of
    // string literals. When ts-morph can resolve the enum (same-folder
    // import, no tsconfig path aliases), we get the real value
    // (`'assets'`); otherwise the property name is used as a heuristic.
    const repo = mkdtempSync(join(tmpdir(), 'structx-enum-decorator-test-'));
    cleanup.push(repo);
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'enum.ts'), `
export enum RouteKey {
  Asset = 'assets',
  User = 'users',
}
`);
    writeFileSync(join(repo, 'src', 'controllers.ts'), `
import { RouteKey } from './enum';
function Controller(p: any): ClassDecorator { return () => {}; }
function Get(p?: string): MethodDecorator { return () => {}; }

@Controller(RouteKey.Asset)
export class AssetController {
  @Get(':id') findOne() {}
}

@Controller(RouteKey.User)
export class UserController {
  @Get('me') me() {}
}
`);
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);
    const routes = listQuery(db, 'routes').routes.map(r => `${r.method} ${r.path}`).sort();
    db.close();

    // Same-folder import means ts-morph resolves the literal enum values.
    expect(routes).toContain('GET /assets/:id');
    expect(routes).toContain('GET /users/me');
  });

  it('extracts decorator-style routes (NestJS @Controller + @Get/@Post)', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const repo = mkdtempSync(join(tmpdir(), 'structx-decorator-routes-test-'));
    cleanup.push(repo);
    mkdirSync(join(repo, 'src'), { recursive: true });
    // Stub the @Controller / @Get / etc. decorators so the file actually
    // type-checks for ts-morph. We don't need real NestJS — the extractor
    // matches on decorator NAME, so any decorator named Controller / Get
    // / Post / etc. is recognized.
    writeFileSync(join(repo, 'src', 'cats.ts'), `
function Controller(path?: string): ClassDecorator { return () => {}; }
function Get(path?: string): MethodDecorator { return () => {}; }
function Post(path?: string): MethodDecorator { return () => {}; }
function Delete(path?: string): MethodDecorator { return () => {}; }
function Param(name: string): ParameterDecorator { return () => {}; }

@Controller('cats')
export class CatsController {
  @Get()
  findAll(): string { return 'all cats'; }

  @Get(':id')
  findOne(@Param('id') id: string): string { return 'cat ' + id; }

  @Post()
  create(): string { return 'created'; }

  @Delete(':id')
  remove(@Param('id') id: string): string { return 'removed ' + id; }
}

@Controller()
export class HealthController {
  @Get('health')
  health(): string { return 'ok'; }
}
`);
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    const allRoutes = listQuery(db, 'routes');
    db.close();

    const byMethodPath = allRoutes.routes.map(r => `${r.method} ${r.path}`).sort();
    expect(byMethodPath).toEqual([
      'DELETE /cats/:id',
      'GET /cats',          // @Get() under @Controller('cats')
      'GET /cats/:id',
      'GET /health',         // @Controller() (no base) + @Get('health')
      'POST /cats',
    ]);
    // Handler names are class-qualified.
    expect(allRoutes.routes.find(r => r.path === '/cats/:id' && r.method === 'GET')?.handlerName)
      .toBe('CatsController.findOne');
  });

  it('falls back from unqualified to qualified method names in directLookup', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // Simulates an OO codebase where the agent asks for a method by its
    // bare name (`add`) without knowing which class it lives on. Battle-
    // tested case: hono's RegExpRouter.add, LinearRouter.add, etc. The
    // exact lookup misses; the unqualified-fallback should find them all.
    const repo = mkdtempSync(join(tmpdir(), 'structx-unqualified-test-'));
    cleanup.push(repo);
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'routers.ts'), `
export class RegExpRouter {
  add(method: string, path: string): void { /* impl */ }
}

export class LinearRouter {
  add(method: string, path: string): void { /* impl */ }
}

export class TrieRouter {
  add(method: string, path: string): void { /* impl */ }
}
`);
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    const ctx = directLookup(db, 'add');
    db.close();

    const names = ctx.functions.map(fn => fn.name).sort();
    expect(names).toContain('RegExpRouter.add');
    expect(names).toContain('LinearRouter.add');
    expect(names).toContain('TrieRouter.add');
  });

  it('does not collapse duplicate function names to an arbitrary first match', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const repo = mkdtempSync(join(tmpdir(), 'structx-dup-function-test-'));
    cleanup.push(repo);
    mkdirSync(join(repo, 'src', 'a'), { recursive: true });
    mkdirSync(join(repo, 'src', 'b'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a', 'save.ts'), `
export function save(value: string): string {
  return 'a:' + value;
}

export function useSaveA(): string {
  return save('one');
}
`);
    writeFileSync(join(repo, 'src', 'b', 'save.ts'), `
export function save(value: string): string {
  return 'b:' + value;
}

export function useSaveB(): string {
  return save('two');
}
`);
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    const direct = directLookup(db, 'save');
    const callers = relationshipQuery(db, 'save', 'callers');
    const impact = impactAnalysis(db, 'save');
    db.close();

    expect(direct.functions.map(fn => fn.location).sort()).toEqual([
      'src/a/save.ts:2',
      'src/b/save.ts:2',
    ]);
    expect(callers.functions.map(fn => fn.name).sort()).toEqual(['useSaveA', 'useSaveB']);
    expect(impact.functions.map(fn => fn.name).sort()).toEqual(['useSaveA', 'useSaveB']);
  });

  it('directLookup pulls in the bodies of immediate callees for richer context', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // Two-layer fixture: outer() → inner(). The agent asking "what does
    // outer do?" needs to see inner()'s body to reason about the side
    // effects, not just outer()'s shape.
    const repo = mkdtempSync(join(tmpdir(), 'structx-direct-callees-test-'));
    cleanup.push(repo);
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'sample.ts'), `
export function inner(x: number): number {
  return x * 2 + 1;
}

export function outer(x: number): number {
  return inner(x);
}
`);
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    // directLookupExpanded is the answer-flow variant that includes callees;
    // plain directLookup remains a focused single-function lookup.
    const expanded = directLookupExpanded(db, 'outer');
    const focused = directLookup(db, 'outer');
    db.close();

    // The expanded form includes target + callee, both with bodies.
    const names = expanded.functions.map(fn => fn.name);
    expect(names).toContain('outer');
    expect(names).toContain('inner');
    const outer = expanded.functions.find(fn => fn.name === 'outer')!;
    const inner = expanded.functions.find(fn => fn.name === 'inner')!;
    expect(outer.body).toMatch(/return inner\(x\)/);
    expect(inner.body).toMatch(/return x \* 2 \+ 1/);

    // Plain directLookup keeps the focused semantic — target only, no body
    // unless the caller opts in. Preserves the MCP structx_function tool
    // contract where include_body is the explicit opt-in.
    expect(focused.functions.map(fn => fn.name)).toEqual(['outer']);
    expect(focused.functions[0].body).toBeUndefined();
  });

  it('patternQuery includes function bodies when the result set is small', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const repo = mkdtempSync(join(tmpdir(), 'structx-pattern-body-test-'));
    cleanup.push(repo);
    mkdirSync(join(repo, 'src'), { recursive: true });
    // Function NAMES match the FTS tokens directly — FTS5's default
    // unicode61 tokenizer doesn't split camelCase, so we use names that
    // tokenize cleanly (e.g. `authenticate` matches `authenticate`).
    writeFileSync(join(repo, 'src', 'auth.ts'), `
export function authenticate(token: string): boolean {
  return token.startsWith('valid-');
}

export function authorize(role: string): boolean {
  return role === 'admin';
}
`);
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    const ctx = patternQuery(db, ['authenticate', 'authorize']);
    db.close();

    expect(ctx.functions.length).toBeGreaterThan(0);
    expect(ctx.functions.length).toBeLessThanOrEqual(8);
    // At least one matched function carries its body — proves the body
    // gating fired for this narrow result set.
    expect(ctx.functions.some(fn => fn.body && fn.body.length > 0)).toBe(true);
  });

  it('patternQuery still gives bodies to the top FTS matches when the result set is large', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const repo = mkdtempSync(join(tmpdir(), 'structx-pattern-nobody-test-'));
    cleanup.push(repo);
    mkdirSync(join(repo, 'src'), { recursive: true });
    // 12 functions each tokenizing to `pulse` + something — FTS5's default
    // unicode61 tokenizer splits on underscore, so `pulse_alpha` matches
    // `pulse`. With the threshold at 8 functions, none should carry bodies.
    const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta',
      'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu'];
    const fns = words.map((w, i) =>
      `export function pulse_${w}(): number { return ${i}; }`,
    ).join('\n');
    writeFileSync(join(repo, 'src', 'pulses.ts'), fns);
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    const ctx = patternQuery(db, ['pulse']);
    db.close();

    // With 12 matches the full-body gate stays closed for most, but the
    // top-3 FTS matches still carry bodies (fix #7 — prevents the LLM from
    // hallucinating signatures of high-confidence matches).
    expect(ctx.functions.length).toBeGreaterThan(8);
    const withBody = ctx.functions.filter(fn => fn.body);
    const withoutBody = ctx.functions.filter(fn => !fn.body);
    expect(withBody.length).toBe(3);
    expect(withoutBody.length).toBeGreaterThan(0);
  });

  it('honors function list limits above the old internal cap of 50', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const repo = mkdtempSync(join(tmpdir(), 'structx-list-limit-test-'));
    cleanup.push(repo);
    mkdirSync(join(repo, 'src'), { recursive: true });
    const code = Array.from({ length: 75 }, (_, i) => `export function scaleFn${i}(): number { return ${i}; }`).join('\n');
    writeFileSync(join(repo, 'src', 'scale.ts'), code);
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    const all = listQuery(db, 'functions', 100);
    const limited = listQuery(db, 'functions', 25);
    db.close();

    expect(all.functions).toHaveLength(75);
    expect(limited.functions).toHaveLength(25);
  });

  it('exposes compact schemas and body opt-in through a real MCP client', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { repo, dbPath } = createIndexedRepo();
    const db = initializeDatabase(dbPath);
    const routeFileId = upsertFile(db, 'src/routes/tasks.ts', 'route-fixture');
    insertRoute(db, {
      file_id: routeFileId,
      method: 'POST',
      path: '/api/tasks',
      handler_name: 'createTaskHandler',
      handler_body: 'createTaskHandler',
      middleware: null,
      start_line: 10,
      end_line: 20,
    });
    insertRoute(db, {
      file_id: routeFileId,
      method: 'POST',
      path: '/api/tasks/:id/archive',
      handler_name: 'archiveTaskHandler',
      handler_body: 'archiveTaskHandler',
      middleware: null,
      start_line: 30,
      end_line: 40,
    });
    db.close();
    const { client, server } = await createMcpClient(repo);

    try {
      const listed = await client.listTools();
      expect(listed.tools.map(t => t.name).sort()).toEqual([
        'structx_ask',
        'structx_costs',
        'structx_dead_code',
        'structx_file',
        'structx_function',
        'structx_impact',
        'structx_list',
        'structx_overview',
        'structx_pr_impact',
        'structx_relationships',
        'structx_route',
        'structx_search',
        'structx_type',
        'structx_type_graph',
      ]);
      const functionSchema = listed.tools.find(t => t.name === 'structx_function')?.inputSchema;
      expect(functionSchema?.properties).toHaveProperty('include_body');
      expect(functionSchema?.properties).toHaveProperty('response_mode');
      expect(functionSchema?.additionalProperties).toBe(false);
      const routeSchema = listed.tools.find(t => t.name === 'structx_route')?.inputSchema;
      expect(routeSchema?.properties).toHaveProperty('path_match');

      const defaultResult = await client.callTool({
        name: 'structx_function',
        arguments: { name: 'calculateInvoice' },
      });
      expect(defaultResult.content[0]).toMatchObject({ type: 'text' });
      expect(JSON.stringify(defaultResult.structuredContent)).not.toContain('return { subtotal');

      const fullResult = await client.callTool({
        name: 'structx_function',
        arguments: { name: 'calculateInvoice', include_body: true },
      });
      expect(fullResult.content[0]).toMatchObject({ type: 'text' });
      expect(JSON.stringify(fullResult.structuredContent)).toContain('return { subtotal');

      const structuredOnly = await client.callTool({
        name: 'structx_list',
        arguments: { entity: 'functions', response_mode: 'structured' },
      });
      expect((structuredOnly.content[0] as any).text).toMatch(/^Structured results returned/);
      expect((structuredOnly.content[0] as any).text).not.toContain('calculateInvoice');
      expect(JSON.stringify(structuredOnly.structuredContent)).toContain('calculateInvoice');

      const textOnly = await client.callTool({
        name: 'structx_list',
        arguments: { entity: 'functions', response_mode: 'text' },
      });
      expect((textOnly.content[0] as any).text).toContain('calculateInvoice');
      expect(textOnly.structuredContent).toMatchObject({
        omitted: true,
        reason: 'response_mode=text',
      });

      const exactRoute = await client.callTool({
        name: 'structx_route',
        arguments: { path: '/api/tasks', method: 'POST', path_match: 'exact', response_mode: 'structured' },
      });
      expect((exactRoute.structuredContent as any).routes.map((r: any) => r.path)).toEqual(['/api/tasks']);

      const rejected = await client.callTool({
        name: 'structx_search',
        arguments: { keywords: ['mcp'], unexpected: true },
      });
      expect(rejected.isError).toBe(true);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  it('changes ask cache keys when code changes inside the same repo', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { repo, dbPath } = createIndexedRepo();
    const db = initializeDatabase(dbPath);

    const beforeHash = getGraphFingerprint(db);
    const beforeKey = makeAskCacheKey('what does printInvoice do?', 'answer-model', beforeHash);
    const lowBudgetKey = makeAskCacheKey('what does printInvoice do?', 'answer-model', beforeHash, 128);
    const highBudgetKey = makeAskCacheKey('what does printInvoice do?', 'answer-model', beforeHash, 512);

    writeProject(repo, 'changed');
    ingestDirectory(db, repo, 0.2);

    const afterHash = getGraphFingerprint(db);
    const afterKey = makeAskCacheKey('what does printInvoice do?', 'answer-model', afterHash);
    db.close();

    expect(afterHash).not.toBe(beforeHash);
    expect(afterKey).not.toBe(beforeKey);
    expect(lowBudgetKey).not.toBe(highBudgetKey);
  });

  it('disables structx_ask in readonly mode but still serves graph queries', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { repo } = createIndexedRepo();
    setReadonly(true);
    const { client, server } = await createMcpClient(repo);
    try {
      // Graph tool still works in readonly mode.
      const fnCall = await client.callTool({
        name: 'structx_function',
        arguments: { name: 'calculateInvoice', response_mode: 'structured' },
      });
      expect((fnCall.structuredContent as any).functions[0].name).toBe('calculateInvoice');

      // ask is rejected with a clear isError + structured reason.
      const askCall = await client.callTool({
        name: 'structx_ask',
        arguments: { question: 'what does calculateInvoice do?' },
      });
      expect(askCall.isError).toBe(true);
      expect((askCall.structuredContent as any).disabled).toBe(true);
      expect((askCall.structuredContent as any).reason).toBe('readonly');
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  it('reports cost telemetry rolled up from qa_runs and ask_cache', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { repo, dbPath } = createIndexedRepo();
    const db = initializeDatabase(dbPath);
    // Two paid runs (one CLI, one MCP) and one cached run — verifies the
    // cache-hit ratio math and the by-mode roll-up.
    insertQaRun(db, {
      mode: 'structx',
      question: 'first cli question',
      input_tokens: 100, output_tokens: 50, total_tokens: 150,
      cost_usd: 0.001, response_time_ms: 800,
      files_accessed: null, functions_retrieved: 2, graph_query_time_ms: 5,
      answer_text: 'cli answer',
    });
    insertQaRun(db, {
      mode: 'structx-mcp',
      question: 'first mcp question',
      input_tokens: 200, output_tokens: 100, total_tokens: 300,
      cost_usd: 0.003, response_time_ms: 1200,
      files_accessed: null, functions_retrieved: 3, graph_query_time_ms: 8,
      answer_text: 'mcp answer',
    });
    db.close();

    const { client, server } = await createMcpClient(repo);
    try {
      const resp = await client.callTool({
        name: 'structx_costs',
        arguments: { response_mode: 'structured' },
      });
      const stats = resp.structuredContent as any;
      expect(stats.totalRuns).toBe(2);
      expect(stats.totalCostUsd).toBeCloseTo(0.004, 6);
      expect(stats.totalInputTokens).toBe(300);
      expect(stats.totalOutputTokens).toBe(150);
      const modes = stats.byMode.map((m: any) => m.mode).sort();
      expect(modes).toEqual(['structx', 'structx-mcp']);
      const cliMode = stats.byMode.find((m: any) => m.mode === 'structx');
      expect(cliMode.runs).toBe(1);
      expect(cliMode.totalCostUsd).toBeCloseTo(0.001, 6);
      expect(cliMode.p50ResponseTimeMs).toBe(800);
      // recent runs come back newest-first
      expect(stats.recentRuns[0].question).toBe('first mcp question');
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  it('honors the structx_search scope filter to drop unwanted entity kinds', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { repo } = createIndexedRepo();
    const { client, server } = await createMcpClient(repo);
    try {
      // Default (no scope) in broad mode: file matches always populate even
      // without semantic analysis (FTS over file paths). Use that as a stable
      // check that the unscoped path returns at least one kind.
      const broadResp = await client.callTool({
        name: 'structx_search',
        arguments: { keywords: ['mcp', 'tools'], mode: 'broad', response_mode: 'structured' },
      });
      const broadStruct = broadResp.structuredContent as any;
      expect(broadStruct.files.length).toBeGreaterThan(0);

      // scope: ['types'] drops files (and everything else); the type fixture
      // BillingSearchOptions matches semantic search for 'billing'.
      const typesOnly = await client.callTool({
        name: 'structx_search',
        arguments: { keywords: ['BillingSearchOptions'], scope: ['types'], response_mode: 'structured' },
      });
      const typesStruct = typesOnly.structuredContent as any;
      expect(typesStruct.functions).toEqual([]);
      expect(typesStruct.routes).toEqual([]);
      expect(typesStruct.files).toEqual([]);
      expect(typesStruct.constants).toEqual([]);

      // scope=['functions'] on the same broad query strips the files we just
      // saw, even though the underlying retrieval populated them.
      const fnsOnly = await client.callTool({
        name: 'structx_search',
        arguments: { keywords: ['mcp', 'tools'], mode: 'broad', scope: ['functions'], response_mode: 'structured' },
      });
      const fnsStruct = fnsOnly.structuredContent as any;
      expect(fnsStruct.types).toEqual([]);
      expect(fnsStruct.routes).toEqual([]);
      expect(fnsStruct.files).toEqual([]);
      expect(fnsStruct.constants).toEqual([]);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  it('routes tool calls to the right repo when given an explicit repo_path', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // Two indexed repos sharing one MCP server — calls without repo_path
    // should target repo A (the server default), calls with repo_path: B
    // should target repo B, and the two graphs must not bleed into each
    // other. This covers the multi-repo workflow documented in the README.
    const repoA = mkdtempSync(join(tmpdir(), 'structx-multirepo-a-'));
    const repoB = mkdtempSync(join(tmpdir(), 'structx-multirepo-b-'));
    cleanup.push(repoA, repoB);
    mkdirSync(join(repoA, 'src'), { recursive: true });
    mkdirSync(join(repoB, 'src'), { recursive: true });
    writeFileSync(join(repoA, 'src', 'a.ts'), 'export function repoAFn(): number { return 1; }\n');
    writeFileSync(join(repoB, 'src', 'b.ts'), 'export function repoBFn(): string { return "two"; }\n');
    const dbA = initializeDatabase(join(repoA, '.structx', 'db.sqlite'));
    ingestDirectory(dbA, repoA, 0.2);
    dbA.close();
    const dbB = initializeDatabase(join(repoB, '.structx', 'db.sqlite'));
    ingestDirectory(dbB, repoB, 0.2);
    dbB.close();

    const { client, server } = await createMcpClient(repoA);
    try {
      const defaultCall = await client.callTool({
        name: 'structx_function',
        arguments: { name: 'repoAFn', response_mode: 'structured' },
      });
      expect((defaultCall.structuredContent as any).functions.map((fn: any) => fn.name)).toEqual(['repoAFn']);

      const overrideCall = await client.callTool({
        name: 'structx_function',
        arguments: { name: 'repoBFn', repo_path: repoB, response_mode: 'structured' },
      });
      expect((overrideCall.structuredContent as any).functions.map((fn: any) => fn.name)).toEqual(['repoBFn']);

      // Cross-check: looking up repo B's function with no repo_path must miss
      // because the server default is repo A.
      const crossMiss = await client.callTool({
        name: 'structx_function',
        arguments: { name: 'repoBFn', response_mode: 'structured' },
      });
      expect((crossMiss.structuredContent as any).functions).toEqual([]);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  it('serves graph updates from a concurrent structx watch process', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // The MCP server's pooled DB connection and the watcher's connection both
    // talk to the same SQLite file. WAL mode means watcher commits are visible
    // to the MCP reader on the next query — verify that round-trip end-to-end.
    const { repo, dbPath } = createIndexedRepo();
    const watchDb = openDatabase(dbPath);
    const stop = await watchDirectory(watchDb, repo, { diffThreshold: 0.2, quietMs: 30, maxHoldMs: 200 });
    const { client, server } = await createMcpClient(repo);
    try {
      // Drop in a brand-new file after the server is running.
      writeFileSync(join(repo, 'src', 'features', 'live-update.ts'), `
export function liveUpdateProbe(): string {
  return 'visible to mcp';
}
`);

      const found = await waitForCondition(async () => {
        const resp = await client.callTool({
          name: 'structx_function',
          arguments: { name: 'liveUpdateProbe', response_mode: 'structured' },
        });
        return (resp.structuredContent as any).functions.length > 0;
      }, 5000);
      expect(found).toBe(true);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      await stop();
      try { watchDb.close(); } catch {}
    }
  });

  it('emits a definitive empty context message when directLookup misses', () => {
    // Renaming a function leaves the old name absent from the graph. The
    // empty-context message for `direct` strategy should tell the LLM the
    // function definitively does not exist (not "maybe ingest"), so the
    // answer can be confidently negative instead of speculative.
    const empty = { functions: [], types: [], routes: [], files: [], constants: [], strategy: 'direct' };
    const ctx = buildContext(empty as any, 'Does removeTask still exist?');
    expect(ctx).toMatch(/does not contain a function with that exact name/);
    expect(ctx).toMatch(/IS up to date/);
    expect(ctx).not.toMatch(/Run "structx ingest"/);
  });

  it('still suggests ingest for non-direct empty results', () => {
    const empty = { functions: [], types: [], routes: [], files: [], constants: [], strategy: 'pattern' };
    const ctx = buildContext(empty as any, 'how does X work');
    expect(ctx).toMatch(/structx ingest/);
  });

  it('patternQuery includes bodies for the top matches even when total result count is large', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const repo = mkdtempSync(join(tmpdir(), 'structx-pattern-topbody-test-'));
    cleanup.push(repo);
    mkdirSync(join(repo, 'src'), { recursive: true });
    // 12 functions sharing a token — over the 8-function full-body
    // threshold, but the top 3 FTS matches should still carry bodies so
    // the LLM has fidelity for high-confidence matches.
    const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta',
      'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu'];
    const fns = words.map((w, i) =>
      `export function record_${w}(): number { return ${i}; }`,
    ).join('\n');
    writeFileSync(join(repo, 'src', 'records.ts'), fns);
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    const ctx = patternQuery(db, ['record']);
    db.close();

    expect(ctx.functions.length).toBeGreaterThan(8);
    // Top 3 carry bodies; the rest do not.
    const withBody = ctx.functions.filter(fn => fn.body);
    const withoutBody = ctx.functions.filter(fn => !fn.body);
    expect(withBody.length).toBe(3);
    expect(withoutBody.length).toBeGreaterThan(0);
  });

  it('getDeadFunctions surfaces zero-caller exports and skips actively-called ones', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const repo = mkdtempSync(join(tmpdir(), 'structx-dead-test-'));
    cleanup.push(repo);
    mkdirSync(join(repo, 'src'), { recursive: true });
    // `livelyHelper` and `helperOfHelper` are both transitively called from
    // an outer chain that has a function caller. `unusedHelper` and
    // `internalDead` have no callers anywhere and should appear as dead.
    writeFileSync(join(repo, 'src', 'sample.ts'), `
export function helperOfHelper(): number { return 7; }

export function livelyHelper(x: number): number { return x + helperOfHelper(); }

export function entryPoint(): number { return livelyHelper(42); }

// outer() is called by entryPoint, transitively keeping the chain alive.
function outer(): number { return entryPoint(); }

export function publicCaller(): number { return outer(); }

export function unusedHelper(x: number): number { return x * 2; }

function internalDead(): void { /* never called */ }
`);
    const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
    ingestDirectory(db, repo, 0.3);

    const dead = getDeadFunctions(db, 50);
    db.close();

    const names = dead.map(d => d.name);
    // The two genuinely uncalled functions are flagged.
    expect(names).toContain('unusedHelper');
    expect(names).toContain('internalDead');
    // Functions in the active call chain are NOT flagged.
    expect(names).not.toContain('helperOfHelper');
    expect(names).not.toContain('livelyHelper');
    expect(names).not.toContain('entryPoint');
    expect(names).not.toContain('outer');
  });

  it('keeps graph fingerprints stable when only QA run history changes', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { dbPath } = createIndexedRepo();
    const db = initializeDatabase(dbPath);

    const beforeHash = getGraphFingerprint(db);
    insertQaRun(db, {
      mode: 'structx-mcp',
      question: 'cached question',
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      cost_usd: 0.001,
      response_time_ms: 123,
      files_accessed: null,
      functions_retrieved: 1,
      graph_query_time_ms: 2,
      answer_text: 'answer',
    });
    const afterHash = getGraphFingerprint(db);
    db.close();

    expect(afterHash).toBe(beforeHash);
  });
});
