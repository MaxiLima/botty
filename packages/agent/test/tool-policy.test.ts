import { describe, expect, it } from 'vitest';
import { FILE_MUTATING_TOOLS, chatCanUseTool } from '../src/llm/tool-policy.js';

describe('chat tool-policy safety valve', () => {
  it('removes exactly exec + file mutation from the surface', () => {
    expect([...FILE_MUTATING_TOOLS]).toEqual(['Bash', 'Write', 'Edit', 'NotebookEdit']);
  });

  it('auto-allows whatever survives the disallow list (e.g. a read tool)', async () => {
    const res = await chatCanUseTool('Read', { file_path: '/etc/hosts' }, {
      signal: new AbortController().signal,
    });
    expect(res).toEqual({ behavior: 'allow' });
  });

  it('auto-allows inherited connector/MCP tools too', async () => {
    const res = await chatCanUseTool('mcp__claude_ai_Gmail__search_threads', {}, {
      signal: new AbortController().signal,
    });
    expect(res).toEqual({ behavior: 'allow' });
  });
});
