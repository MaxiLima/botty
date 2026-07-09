import { describe, expect, it } from 'vitest';
import type { WsEvent } from '@botty/shared';
import { createBus } from '../../src/bus/index.js';
import { Db } from '../../src/db/index.js';
import { createLlm } from '../../src/llm/index.js';
import { createMemory } from '../../src/memory/index.js';
import { createChat } from '../../src/chat/index.js';
import { parseHeartbeat } from '../../src/config/parse.js';
import type { McpConfig } from '../../src/config/mcp.js';
import { createMcpConnections } from '../../src/mcp/connections.js';
import { createPendingActionQueue } from '../../src/mcp/pending.js';
import { createMcpToolsFactory } from '../../src/mcp/tools.js';
import { createFixtureMcpServer } from '../mcp/fixture.js';

/**
 * End-to-end through the real chat service (mock LLM's `!tool <name> <json>`
 * trigger — see llm/mock.ts): an action-mode external tool call must land as
 * a pending_actions row + action.pending broadcast, and must NOT touch the
 * fixture MCP server (consent-gated tools never execute mid-turn).
 */
async function setup() {
  const db = new Db(':memory:');
  const bus = createBus();
  const events: WsEvent[] = [];
  bus.onBroadcast((e) => events.push(e));
  const llm = await createLlm({ env: { mockLlm: true }, db, bus });
  const config = {
    persona: () => '# PERSONA\nYou are botty.',
    heartbeat: () => parseHeartbeat('', 'sim'),
  };
  const memory = createMemory({ db, config });

  const fixture = createFixtureMcpServer('demo');
  const mcpConfig: McpConfig = {
    servers: {
      demo: { type: 'stdio', command: 'node', args: [], env: {}, tools: { echo: 'read', send: 'action' } },
    },
  };
  const connections = createMcpConnections({ getConfig: () => mcpConfig, transportFactory: fixture.transportFactory });
  const pending = createPendingActionQueue({ db, bus, connections });
  const mcpTools = createMcpToolsFactory({ config: { mcp: () => mcpConfig }, connections, pending });

  const chat = createChat({ db, bus, llm, memory, mcpTools });

  return {
    db,
    events,
    chat,
    fixture,
    async cleanup() {
      await connections.closeAll();
      await fixture.close();
    },
  };
}

describe('mock !tool trigger — external action tool through the real chat service', () => {
  it('queues a pending action and broadcasts action.pending instead of executing', async () => {
    const h = await setup();
    try {
      const { done } = await h.chat.handleUserMessage(
        `!tool demo_send ${JSON.stringify({ to: 'ana', text: 'standup at 10' })}`,
      );
      const turn = await done;
      expect(turn).not.toBeNull();
      expect(turn!.content).toContain('"queued":true');

      // Never executed the real tool mid-turn.
      expect(h.fixture.calls).toHaveLength(0);

      const rows = h.db.listPendingActions('pending');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.server).toBe('demo');
      expect(rows[0]!.tool).toBe('send');

      expect(h.events.some((e) => e.type === 'action.pending' && e.payload.action.id === rows[0]!.id)).toBe(true);
    } finally {
      await h.cleanup();
    }
  });

  it('a read external tool executes for real through the fixture', async () => {
    const h = await setup();
    try {
      const { done } = await h.chat.handleUserMessage(`!tool demo_echo ${JSON.stringify({ message: 'hi' })}`);
      const turn = await done;
      expect(turn!.content).toContain('echo: hi');
      expect(h.fixture.calls).toEqual([{ tool: 'echo', args: { message: 'hi' } }]);
      expect(h.db.listPendingActions('pending')).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  });
});
