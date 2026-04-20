/**
 * Thin wrapper around @modelcontextprotocol/sdk for remote HTTP MCP servers.
 * Opens a connection per call — short-lived sessions are fine for our use
 * (one-shot `tools/list` during health checks, a handful of `tools/call`
 * per Claude turn).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export type McpTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

export type ToolCallResult = {
  content: Array<{ type: string; text?: string } & Record<string, unknown>>;
  isError?: boolean;
};

async function withClient<T>(
  url: string,
  fn: (c: Client) => Promise<T>,
): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: 'ted', version: '0.1.0' });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    try {
      await client.close();
    } catch {
      // ignore close errors
    }
  }
}

export async function listTools(url: string): Promise<McpTool[]> {
  return withClient(url, async (c) => {
    const result = await c.listTools();
    return result.tools as McpTool[];
  });
}

export async function callTool(
  url: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  return withClient(url, async (c) => {
    const result = await c.callTool({ name, arguments: args });
    return result as ToolCallResult;
  });
}
