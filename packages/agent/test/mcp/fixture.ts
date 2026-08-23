import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import type { McpTransportFactory } from '../../src/mcp/connections.js';

/**
 * A tiny in-process MCP server for tests: an `echo` tool (maps to a `read`
 * chat tool in most tests) and a `send` tool (maps to `action`), plus a
 * `fail` tool that always returns isError so approve()-on-failure paths are
 * exercised without a real external process. Served over InMemoryTransport —
 * connections.ts's transportFactory is injectable exactly for this.
 */
export interface FixtureMcpServer {
  /** Pass as the `transportFactory` option to createMcpConnections(). */
  transportFactory: McpTransportFactory;
  /** Every tool call the fixture received, in order. */
  calls: { tool: string; args: unknown }[];
  close(): Promise<void>;
  /**
   * Simulate a crashed/exited external server: closes the current server-side
   * transport(s) (propagates onclose to the connected client) WITHOUT closing
   * the underlying McpServer object itself, so a subsequent transportFactory()
   * call can still open a fresh linked pair — exactly like a real subprocess
   * dying and the config's `command` being re-spawned on the next connect.
   */
  crash(): Promise<void>;
}

export function createFixtureMcpServer(serverKey: string): FixtureMcpServer {
  const calls: { tool: string; args: unknown }[] = [];
  const server = new McpServer({ name: 'fixture', version: '1.0.0' });

  server.registerTool(
    'echo',
    {
      description: 'Echoes the message back',
      inputSchema: { message: z.string().describe('text to echo') },
    },
    async (args) => {
      calls.push({ tool: 'echo', args });
      return { content: [{ type: 'text' as const, text: `echo: ${args.message}` }] };
    },
  );

  server.registerTool(
    'send',
    {
      description: 'Sends a message to a recipient',
      inputSchema: { to: z.string().describe('recipient'), text: z.string().describe('message body') },
    },
    async (args) => {
      calls.push({ tool: 'send', args });
      return { content: [{ type: 'text' as const, text: `sent to ${args.to}: ${args.text}` }] };
    },
  );

  server.registerTool(
    'fail',
    { description: 'Always fails', inputSchema: { reason: z.string().optional() } },
    async (args) => {
      calls.push({ tool: 'fail', args });
      return { content: [{ type: 'text' as const, text: 'boom: intentional failure' }], isError: true };
    },
  );

  const connections: Promise<void>[] = [];
  const serverTransports: { close(): Promise<void> }[] = [];

  const transportFactory: McpTransportFactory = (key) => {
    if (key !== serverKey) {
      throw new Error(`fixture only serves server "${serverKey}", got a connect for "${key}"`);
    }
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    serverTransports.push(serverTransport);
    connections.push(server.connect(serverTransport));
    return clientTransport;
  };

  return {
    transportFactory,
    calls,
    async close() {
      await Promise.allSettled(connections);
      await server.close().catch(() => {});
      await Promise.allSettled(serverTransports.map((t) => t.close()));
    },
    async crash() {
      const transports = serverTransports.splice(0, serverTransports.length);
      await Promise.allSettled(transports.map((t) => t.close()));
    },
  };
}
