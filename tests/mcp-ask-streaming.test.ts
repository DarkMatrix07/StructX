import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Mock the unified LLM client at the module level so structx_ask never
// reaches a real provider during this test. The factory below returns a
// fake LlmClient whose streamComplete fires three text chunks and returns
// final usage; complete() also returns a deterministic answer in case the
// non-streaming path is exercised. Other code paths that touch llm (the
// classifier) are bypassed by using a fast-path question.
vi.mock('../src/utils/llm', () => {
  const fakeClient = {
    provider: 'anthropic' as const,
    async complete(_req: any) {
      return { text: 'one-shot answer.', inputTokens: 100, outputTokens: 50 };
    },
    async streamComplete(_req: any, onChunk: (chunk: string) => void) {
      const chunks = ['Streaming ', 'fake answer ', 'in three parts.'];
      for (const c of chunks) {
        onChunk(c);
        // Yield a tick so the SDK has a chance to flush each notification
        // separately rather than batching three into one.
        await new Promise(r => setImmediate(r));
      }
      return {
        text: chunks.join(''),
        inputTokens: 200,
        outputTokens: 30,
      };
    },
  };
  return {
    createLlmClient: () => fakeClient,
    // No-op LlmProvider type re-export for any consumers.
  };
});

import { initializeDatabase } from '../src/db/connection';
import { ingestDirectory } from '../src/ingest/ingester';
import { closeAllDbs } from '../src/mcp/db-pool';
import { registerTools } from '../src/mcp/tools';

const cleanup: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  closeAllDbs();
  for (const repo of cleanup.splice(0)) {
    rmSync(repo, { recursive: true, force: true });
  }
});

function createIndexedRepo(): { repo: string } {
  const repo = mkdtempSync(join(tmpdir(), 'structx-stream-test-'));
  cleanup.push(repo);
  mkdirSync(join(repo, 'src'), { recursive: true });
  // Fast-path classifier ("what does X do") avoids any LLM call for
  // classification, isolating this test to the answerer streaming path.
  writeFileSync(join(repo, 'src', 'sample.ts'), `
export function calculateInvoice(input: number): number {
  return input + input * 0.2;
}
`);
  // Persist a config so loadConfig resolves without env vars set.
  mkdirSync(join(repo, '.structx'), { recursive: true });
  writeFileSync(join(repo, '.structx', 'config.json'), JSON.stringify({
    repoPath: repo,
    provider: 'anthropic',
    anthropicApiKey: 'test-key',
    answerModel: 'claude-haiku-4-5-20251001',
    classifierModel: 'claude-haiku-4-5-20251001',
    analysisModel: 'claude-haiku-4-5-20251001',
    answerMaxTokens: 256,
  }));
  const db = initializeDatabase(join(repo, '.structx', 'db.sqlite'));
  ingestDirectory(db, repo, 0.2);
  db.close();
  return { repo };
}

describe('structx_ask streaming via MCP progressToken', () => {
  it('emits one progress notification per chunk and returns the assembled answer', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { repo } = createIndexedRepo();

    const server = new McpServer({ name: 'structx-stream-test', version: '0.0.0' });
    registerTools(server, repo);
    const client = new Client({ name: 'structx-stream-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const progressEvents: Array<{ progress: number; message?: string }> = [];

    try {
      const resp = await client.callTool({
        name: 'structx_ask',
        arguments: { question: 'what does calculateInvoice do?' },
      }, undefined, {
        // The SDK forwards onprogress notifications from the server to this
        // callback. Each call corresponds to one notifications/progress
        // emitted by the streaming handler.
        onprogress: (params: any) => {
          progressEvents.push({ progress: params.progress, message: params.message });
        },
      });

      // The streaming path mocked above sends 3 chunks, so we expect 3
      // progress events with monotonically growing cumulative lengths.
      expect(progressEvents).toHaveLength(3);
      expect(progressEvents[0].message).toBe('Streaming ');
      expect(progressEvents[1].message).toBe('fake answer ');
      expect(progressEvents[2].message).toBe('in three parts.');
      const lengths = progressEvents.map(e => e.progress);
      expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
      expect(lengths[0]).toBe('Streaming '.length);
      expect(lengths[2]).toBe('Streaming fake answer in three parts.'.length);

      // The final tool response carries the full assembled answer.
      const text = (resp.content[0] as any).text;
      expect(text).toBe('Streaming fake answer in three parts.');
      const struct = resp.structuredContent as any;
      expect(struct.answer).toBe('Streaming fake answer in three parts.');
      expect(struct.cached).toBe(false);
      expect(struct.outputTokens).toBe(30);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  it('uses the non-streaming path when no progressToken is provided', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { repo } = createIndexedRepo();

    const server = new McpServer({ name: 'structx-stream-test', version: '0.0.0' });
    registerTools(server, repo);
    const client = new Client({ name: 'structx-stream-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const progressEvents: any[] = [];

    try {
      const resp = await client.callTool({
        name: 'structx_ask',
        arguments: { question: 'what does calculateInvoice do?' },
      });
      // No onprogress callback was passed — the server should never emit
      // progress notifications, and the answer should come from the
      // non-streaming complete() path (different mock token counts).
      expect(progressEvents).toHaveLength(0);
      expect((resp.content[0] as any).text).toBe('one-shot answer.');
      expect((resp.structuredContent as any).outputTokens).toBe(50);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
});
