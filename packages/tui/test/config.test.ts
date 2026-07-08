import { describe, expect, it } from 'vitest';
import { AGENT_PORT } from '@botty/shared';
import { parseConfig } from '../src/config.js';

describe('parseConfig', () => {
  it('defaults to loopback on the agent default port', () => {
    const c = parseConfig([], {});
    expect(c.baseUrl).toBe(`http://127.0.0.1:${AGENT_PORT}`);
    expect(c.wsUrl).toBe(`ws://127.0.0.1:${AGENT_PORT}/ws`);
  });

  it('respects AGENT_PORT env override', () => {
    const c = parseConfig([], { AGENT_PORT: '5820' });
    expect(c.baseUrl).toBe('http://127.0.0.1:5820');
  });

  it('uses BOTTY_URL and strips trailing slash', () => {
    const c = parseConfig([], { BOTTY_URL: 'https://example.test:9999/' });
    expect(c.baseUrl).toBe('https://example.test:9999');
    expect(c.wsUrl).toBe('wss://example.test:9999/ws');
  });

  it('flags win over BOTTY_URL', () => {
    const c = parseConfig(['--port', '5820'], { BOTTY_URL: 'http://elsewhere:1' });
    expect(c.baseUrl).toBe('http://127.0.0.1:5820');
  });

  it('accepts --host and --port together', () => {
    const c = parseConfig(['--host', 'localhost', '--port', '4820'], {});
    expect(c.baseUrl).toBe('http://localhost:4820');
    expect(c.wsUrl).toBe('ws://localhost:4820/ws');
  });

  it('rejects a non-numeric --port', () => {
    expect(() => parseConfig(['--port', 'abc'], {})).toThrow('--port must be a number');
  });

  it('rejects a flag without a value', () => {
    expect(() => parseConfig(['--host'], {})).toThrow('--host requires a value');
  });
});
