import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools';
import { closeAllDbs, setReadonly } from './db-pool';
import { logger } from '../utils/logger';

export interface RunMcpServerOptions {
  // When true, all DB connections are opened readonly and structx_ask is
  // disabled. Used for shared-repo deployments where the MCP server should
  // never mutate the graph.
  readonly?: boolean;
}

// Start the StructX MCP server on stdio. Resolves once the parent client
// disconnects. All logs go to stderr; stdout is reserved for MCP JSON-RPC
// frames and any non-protocol bytes there would corrupt the stream.
export async function runMcpServer(defaultRepo: string, opts: RunMcpServerOptions = {}): Promise<void> {
  setReadonly(!!opts.readonly);
  const server = new McpServer({
    name: 'structx',
    version: '3.3.0',
  });

  registerTools(server, defaultRepo);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info(`StructX MCP server ready (default repo: ${defaultRepo}${opts.readonly ? ', readonly' : ''})`);

  await new Promise<void>((resolve) => {
    let closed = false;
    const previousOnClose = server.server.onclose;
    const shutdown = async (reason: string) => {
      if (closed) return;
      closed = true;
      logger.info(`MCP server shutting down (${reason})`);
      closeAllDbs();
      try { await server.close(); } catch {}
      resolve();
    };

    server.server.onclose = () => {
      previousOnClose?.();
      void shutdown('transport closed');
    };

    // StdioServerTransport does not close itself on stdin end, so explicitly
    // close the server and flush pooled DB handles.
    process.stdin.once('end', () => void shutdown('stdin ended'));
    process.stdin.once('close', () => void shutdown('stdin closed'));
  });
}
