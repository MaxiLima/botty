import { describe, expect, it } from 'vitest';
import type { WsEvent } from '@botty/shared';
import { createBus } from '../../src/bus/index.js';
import { Db } from '../../src/db/index.js';
import type { McpConfig } from '../../src/config/mcp.js';
import { createMcpConnections } from '../../src/mcp/connections.js';
import { createPendingActionQueue } from '../../src/mcp/pending.js';
import { createMcpToolsFactory } from '../../src/mcp/tools.js';
import { createFixtureMcpServer } from './fixture.js';

function setup(cfgOverride?: McpConfig) {
  const db = new Db(':memory:');
  const bus = createBus();
  const events: WsEvent[] = [];
  bus.onBroadcast((e) => events.push(e));
  const fixture = createFixtureMcpServer('demo');
  const config: McpConfig = cfgOverride ?? {
    servers: {
      demo: {
        type: 'stdio',
        command: 'node',
        args: [],
        env: {},
        tools: { echo: 'read', send: 'action' },
      },
    },
  };
  let current = config;
  const connections = createMcpConnections({ getConfig: () => current, transportFactory: fixture.transportFactory });
  const pending = createPendingActionQueue({ db, bus, connections });
  const getMcpChatTools = createMcpToolsFactory({ config: { mcp: () => current }, connections, pending });
  return {
    db,
    bus,
    events,
    fixture,
    connections,
    pending,
    getMcpChatTools,
    setConfig(next: McpConfig) {
      current = next;
    },
    async cleanup() {
      await connections.closeAll();
      await fixture.close();
    },
  };
}

describe('createMcpToolsFactory', () => {
  it('builds one ChatToolSpec per allowlisted tool, named <server>_<tool>', async () => {
    const h = setup();
    try {
      const tools = await h.getMcpChatTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['demo_echo', 'demo_send']);
    } finally {
      await h.cleanup();
    }
  });

  it('fetches the live description + input schema from tools/list and appends it as text', async () => {
    const h = setup();
    try {
      const tools = await h.getMcpChatTools();
      const echo = tools.find((t) => t.name === 'demo_echo')!;
      expect(echo.description).toContain('Echoes the message back');
      expect(echo.description).toContain('Input schema (JSON Schema):');
      expect(echo.description).toContain('message');
      expect(Object.keys(echo.inputSchema)).toContain('message');
    } finally {
      await h.cleanup();
    }
  });

  it('action tools carry the consent-gated note in their description and queue: summarize prefix', async () => {
    const h = setup();
    try {
      const tools = await h.getMcpChatTools();
      const send = tools.find((t) => t.name === 'demo_send')!;
      expect(send.description).toContain('consent-gated');
      expect(send.description).toContain('does NOT execute immediately');
      expect(send.summarize({ to: 'ana', text: 'hi' })).toMatch(/^queue: demo\.send/);
    } finally {
      await h.cleanup();
    }
  });

  it('read tool execute() calls straight through connections.callTool and returns content', async () => {
    const h = setup();
    try {
      const tools = await h.getMcpChatTools();
      const echo = tools.find((t) => t.name === 'demo_echo')!;
      const result = await echo.execute({ message: 'hi' });
      expect(result).toEqual({ content: 'echo: hi' });
      expect(h.fixture.calls).toEqual([{ tool: 'echo', args: { message: 'hi' } }]);
    } finally {
      await h.cleanup();
    }
  });

  it('action tool execute() enqueues a pending action and never calls the server directly', async () => {
    const h = setup();
    try {
      const tools = await h.getMcpChatTools('turn-1');
      const send = tools.find((t) => t.name === 'demo_send')!;
      const result = await send.execute({ to: 'ana', text: 'hi' });
      expect(result.queued).toBe(true);
      expect(typeof result.actionId).toBe('string');
      expect(result.note).toMatch(/awaiting user approval/);
      expect(h.fixture.calls).toHaveLength(0); // never executes mid-turn

      const action = h.db.getPendingAction(result.actionId as string)!;
      expect(action.server).toBe('demo');
      expect(action.tool).toBe('send');
      expect(action.sourceTurnId).toBe('turn-1');
      expect(h.events.some((e) => e.type === 'action.pending')).toBe(true);
    } finally {
      await h.cleanup();
    }
  });

  it('an unreachable server still builds tools with a generic description (enqueue still works)', async () => {
    const cfg: McpConfig = {
      servers: {
        ghost: { type: 'stdio', command: 'node', args: [], env: {}, tools: { poke: 'action' } },
      },
    };
    const h = setup(cfg);
    try {
      const tools = await h.getMcpChatTools();
      const poke = tools.find((t) => t.name === 'ghost_poke')!;
      expect(poke.description).toContain('no description reported by the server');
      const result = await poke.execute({});
      expect(result.queued).toBe(true);
    } finally {
      await h.cleanup();
    }
  });

  it('re-derives the tool list per call so a hot-reload allowlist change takes effect next turn', async () => {
    const h = setup();
    try {
      const before = await h.getMcpChatTools();
      expect(before.map((t) => t.name).sort()).toEqual(['demo_echo', 'demo_send']);

      h.setConfig({
        servers: {
          demo: { type: 'stdio', command: 'node', args: [], env: {}, tools: { echo: 'read' } },
        },
      });
      const after = await h.getMcpChatTools();
      expect(after.map((t) => t.name)).toEqual(['demo_echo']);
    } finally {
      await h.cleanup();
    }
  });
});
