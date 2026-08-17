/**
 * wpfs — a tiny Streamable-HTTP MCP server exposing the WordPress
 * wp-content volume (list/read/write/delete over Wasmer S3).
 *
 * mcp-js bridges it into the sandbox, so run_js code can compose file
 * operations in JavaScript: await mcp.callTool("wpfs", "wp_read", {...}).
 * Runs inside the ted container (started by start.sh); credentials stay
 * in WP_S3_* env vars server-side.
 */
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { wpList, wpRead, wpWrite, wpDelete } from './wp-s3.js';

const OPCACHE_NOTE =
  ' Note: PHP opcache may keep executing old/deleted files until the Wasmer app is redeployed.';

function buildServer(): McpServer {
  const server = new McpServer({ name: 'wpfs', version: '1.0.0' });

  const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
  const err = (e: unknown) => ({
    content: [{ type: 'text' as const, text: (e as Error).message }],
    isError: true,
  });

  server.tool(
    'wp_list',
    'List files on the WordPress wp-content volume by prefix (e.g. "mu-plugins/", "plugins/"). Works even when the site is down.',
    { prefix: z.string().describe('Path prefix relative to wp-content/') },
    async ({ prefix }) => {
      try { return text(await wpList(prefix)); } catch (e) { return err(e); }
    },
  );

  server.tool(
    'wp_read',
    'Read a file from the WordPress wp-content volume.',
    { path: z.string().describe('Path relative to wp-content/') },
    async ({ path }) => {
      try { return text(await wpRead(path)); } catch (e) { return err(e); }
    },
  );

  server.tool(
    'wp_write',
    'Write a file to the WordPress wp-content volume. Never write mu-plugins without validating PHP syntax first — a syntax error takes down the whole site.' + OPCACHE_NOTE,
    {
      path: z.string().describe('Path relative to wp-content/'),
      content: z.string().describe('File content'),
    },
    async ({ path, content }) => {
      try { return text(await wpWrite(path, content)); } catch (e) { return err(e); }
    },
  );

  server.tool(
    'wp_delete',
    'Delete a file from the WordPress wp-content volume.' + OPCACHE_NOTE,
    { path: z.string().describe('Path relative to wp-content/') },
    async ({ path }) => {
      try { return text(await wpDelete(path)); } catch (e) { return err(e); }
    },
  );

  return server;
}

export function startWpfsMcp(port: number): http.Server {
  const httpServer = http.createServer(async (req, res) => {
    try {
      if (!req.url?.startsWith('/mcp')) {
        res.writeHead(404).end('not found');
        return;
      }
      // Stateless: a fresh server + transport per request.
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = buildServer();
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      console.error('[wpfs-mcp] request error:', (e as Error).message);
      if (!res.headersSent) res.writeHead(500).end('internal error');
    }
  });
  httpServer.listen(port, () => {
    console.log(`[wpfs-mcp] listening on :${port}`);
  });
  return httpServer;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startWpfsMcp(Number(process.env.WPFS_MCP_PORT ?? 8790));
}
