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

  it('a crashed server transport evicts the cached client so the next call reconnects (finding 2)', async () => {
    const fixture = createFixtureMcpServer('demo');
    const cfg: McpConfig = { servers: { demo: serverConfig() } };
    const conns = createMcpConnections({ getConfig: () => cfg, transportFactory: fixture.transportFactory });
    try {
      const first = await conns.callTool('demo', 'echo', { message: 'before crash' });
      expect(first).toEqual({ content: 'echo: before crash' });

      // Simulate the external server dying (subprocess exit / transport close)
      // WITHOUT going through closeAll()/onConfigChanged — nothing in our own
      // code told the connection to drop.
      await fixture.crash();
      // Let the async onclose callback run (InMemoryTransport.close() awaits
      // the other side, then fires onclose — give the microtask queue a beat).
      await new Promise((r) => setTimeout(r, 10));

      // Before the fix, the dead client stayed cached and every subsequent
      // call would hang/fail against a closed transport until agent restart.
      // After the fix, the next call reconnects fresh (transportFactory opens
      // a brand-new linked pair against the still-alive McpServer instance).
      const second = await conns.callTool('demo', 'echo', { message: 'after crash' });
      expect(second).toEqual({ content: 'echo: after crash' });
      expect(fixture.calls.map((c) => c.args)).toEqual([{ message: 'before crash' }, { message: 'after crash' }]);
    } finally {
      await conns.closeAll();
      await fixture.close();
    }
  });

  it('a connect() that never resolves times out instead of hanging the caller (finding 4)', async () => {
    const cfg: McpConfig = { servers: { demo: serverConfig() } };
    const conns = createMcpConnections({
      getConfig: () => cfg,
      // Short override so the test doesn't have to eat the real 10s default.
      connectTimeoutMs: 100,
      transportFactory: () => ({
        // A transport whose start()/connect() handshake never completes —
        // simulates an unreachable/hung server process.
        start: () => new Promise(() => {}),
        close: async () => {},
        send: async () => {},
      }),
    });
    const start = Date.now();
    const result = await conns.callTool('demo', 'echo', {});
    expect('error' in result && result.error).toMatch(/failed to connect/);
    expect('error' in result && result.error).toMatch(/timed out/);
    // Bounded by the (overridden, here very short) connect timeout — nowhere
    // near the MCP SDK's own 60s default request timeout the finding was about.
    expect(Date.now() - start).toBeLessThan(2_000);
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
