import { describe, expect, it } from 'vitest';
import { createMcpConnections } from '../../src/mcp/connections.js';
import type { McpConfig } from '../../src/config/mcp.js';
import { createFixtureMcpServer } from './fixture.js';

function serverConfig(overrides: Partial<McpConfig['servers'][string]> = {}): McpConfig['servers'][string] {
  return { type: 'stdio', command: 'node', args: [], env: {}, tools: {}, ...overrides };
}

describe('McpConnections', () => {
  it('lazy-connects on first call, caches the client, and lists/calls tools', async () => {
    const fixture = createFixtureMcpServer('demo');
    let cfg: McpConfig = { servers: { demo: serverConfig() } };
    const conns = createMcpConnections({ getConfig: () => cfg, transportFactory: fixture.transportFactory });
    try {
      const tools = await conns.listTools('demo');
      expect(tools.map((t) => t.name).sort()).toEqual(['echo', 'fail', 'send']);
      const echoTool = tools.find((t) => t.name === 'echo')!;
      expect(echoTool.description).toBe('Echoes the message back');
      expect(echoTool.inputSchema).toBeTruthy();

      const result = await conns.callTool('demo', 'echo', { message: 'hi' });
      expect(result).toEqual({ content: 'echo: hi' });
      expect(fixture.calls).toEqual([{ tool: 'echo', args: { message: 'hi' } }]);
    } finally {
      await conns.closeAll();
      await fixture.close();
    }
  });

  it('surfaces a tool-level failure as { error } instead of throwing', async () => {
    const fixture = createFixtureMcpServer('demo');
    const cfg: McpConfig = { servers: { demo: serverConfig() } };
    const conns = createMcpConnections({ getConfig: () => cfg, transportFactory: fixture.transportFactory });
    try {
      const result = await conns.callTool('demo', 'fail', {});
      expect(result).toEqual({ error: 'boom: intentional failure' });
    } finally {
      await conns.closeAll();
      await fixture.close();
    }
  });

  it('an unconfigured server surfaces a readable error, never throws past callTool', async () => {
    const conns = createMcpConnections({ getConfig: () => ({ servers: {} }) });
    const result = await conns.callTool('ghost', 'anything', {});
    expect('error' in result && result.error).toMatch(/not configured: ghost/);
  });

  it('a connect failure (bad transport factory) surfaces as { error }, never throws', async () => {
    const cfg: McpConfig = { servers: { demo: serverConfig() } };
    const conns = createMcpConnections({
      getConfig: () => cfg,
      transportFactory: () => {
        throw new Error('spawn ENOENT');
      },
    });
    const result = await conns.callTool('demo', 'echo', {});
    expect('error' in result && result.error).toMatch(/failed to connect/);
  });

  it('onConfigChanged closes connections whose server was removed or whose config changed', async () => {
    const fixtureA = createFixtureMcpServer('demo');
    let cfg: McpConfig = { servers: { demo: serverConfig({ command: 'node' }) } };
    const conns = createMcpConnections({ getConfig: () => cfg, transportFactory: fixtureA.transportFactory });
    try {
      await conns.callTool('demo', 'echo', { message: 'first' });
      expect(fixtureA.calls).toHaveLength(1);

      // Config changed (different args) → next call must reconnect, not reuse the old client.
      cfg = { servers: { demo: serverConfig({ command: 'node', args: ['--changed'] }) } };
      conns.onConfigChanged(cfg);

      const fixtureB = createFixtureMcpServer('demo');
      const conns2 = createMcpConnections({ getConfig: () => cfg, transportFactory: fixtureB.transportFactory });
      const result = await conns2.callTool('demo', 'echo', { message: 'second' });
      expect(result).toEqual({ content: 'echo: second' });
      await conns2.closeAll();
      await fixtureB.close();
    } finally {
      await conns.closeAll();
      await fixtureA.close();
    }
  });

  it('onConfigChanged is a no-op for a server whose config is unchanged (no reconnect)', async () => {
    const fixture = createFixtureMcpServer('demo');
    const cfg: McpConfig = { servers: { demo: serverConfig() } };
    const conns = createMcpConnections({ getConfig: () => cfg, transportFactory: fixture.transportFactory });
    try {
      await conns.callTool('demo', 'echo', { message: 'a' });
      conns.onConfigChanged(cfg); // identical config → should not close/reconnect
      await conns.callTool('demo', 'echo', { message: 'b' });
      expect(fixture.calls).toHaveLength(2);
    } finally {
      await conns.closeAll();
      await fixture.close();
    }
  });
});
