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
import { closeAllDbs } from '../src/mcp/db-pool';
import { registerTools } from '../src/mcp/tools';
import { getGraphFingerprint, makeAskCacheKey } from '../src/query/ask-cache';
import { directLookup, impactAnalysis, listQuery, patternQuery, relationshipQuery, typeQuery } from '../src/query/retriever';
import { insertQaRun, insertType, upsertFile } from '../src/db/queries';

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
  closeAllDbs();
  for (const repo of cleanup.splice(0)) {
    rmSync(repo, { recursive: true, force: true });
  }
});

describe('MCP graph tools', () => {
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
    const { repo } = createIndexedRepo();
    const { client, server } = await createMcpClient(repo);

    try {
      const listed = await client.listTools();
      expect(listed.tools.map(t => t.name).sort()).toEqual([
        'structx_ask',
        'structx_file',
        'structx_function',
        'structx_impact',
        'structx_list',
        'structx_overview',
        'structx_relationships',
        'structx_route',
        'structx_search',
        'structx_type',
      ]);
      const functionSchema = listed.tools.find(t => t.name === 'structx_function')?.inputSchema;
      expect(functionSchema?.properties).toHaveProperty('include_body');
      expect(functionSchema?.additionalProperties).toBe(false);

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

    writeProject(repo, 'changed');
    ingestDirectory(db, repo, 0.2);

    const afterHash = getGraphFingerprint(db);
    const afterKey = makeAskCacheKey('what does printInvoice do?', 'answer-model', afterHash);
    db.close();

    expect(afterHash).not.toBe(beforeHash);
    expect(afterKey).not.toBe(beforeKey);
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
