import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_PORT, SIM_PORT } from '@botty/shared';
import { parseConfig } from '../src/config.js';

describe('parseConfig', () => {
  it('defaults: help command, standard ports, ~/.botty', () => {
    const c = parseConfig([], {});
    expect(c.command).toBe('help');
    expect(c.port).toBe(AGENT_PORT);
    expect(c.simPort).toBe(SIM_PORT);
    expect(c.dataDir).toBe(path.join(os.homedir(), '.botty'));
    expect(c.mode).toBe('sim');
    expect(c.agentUrl).toBe(`http://127.0.0.1:${AGENT_PORT}`);
    expect(c.simUrl).toBe(`http://localhost:${SIM_PORT}`);
  });

  it('parses command and positional args', () => {
    const c = parseConfig(['logs', 'sim', '-f'], {});
    expect(c.command).toBe('logs');
    expect(c.args).toEqual(['sim']);
    expect(c.follow).toBe(true);
  });

  it('resolves gui/web aliases to open', () => {
    expect(parseConfig(['gui'], {}).command).toBe('open');
    expect(parseConfig(['web'], {}).command).toBe('open');
  });

  it('flags win over env vars', () => {
    const c = parseConfig(['start', '--port', '5820', '--sim-port', '5821'], {
      AGENT_PORT: '4820',
      BOTTY_SIM_PORT: '4821',
    });
    expect(c.port).toBe(5820);
    expect(c.simPort).toBe(5821);
    expect(c.simUrl).toBe('http://localhost:5821');
  });

  it('env vars win over defaults', () => {
    const c = parseConfig(['start'], { AGENT_PORT: '5820', BOTTY_DATA_DIR: '/tmp/x', BOTTY_MODE: 'real' });
    expect(c.port).toBe(5820);
    expect(c.dataDir).toBe('/tmp/x');
    expect(c.mode).toBe('real');
  });

  it('explicit BOTTY_SIM_URL is respected over the derived one', () => {
    const c = parseConfig(['start', '--sim-port', '5821'], { BOTTY_SIM_URL: 'http://elsewhere:9' });
    expect(c.simUrl).toBe('http://elsewhere:9');
  });

  it('--mock-llm flag or env enables mock', () => {
    expect(parseConfig(['start', '--mock-llm'], {}).mockLlm).toBe(true);
    expect(parseConfig(['start'], { BOTTY_MOCK_LLM: '1' }).mockLlm).toBe(true);
    expect(parseConfig(['start'], { BOTTY_MOCK_LLM: '0' }).mockLlm).toBe(false);
  });

  it('rejects unknown commands and flags, bad ports, missing values', () => {
    expect(() => parseConfig(['frobnicate'], {})).toThrow(/unknown command/);
    expect(() => parseConfig(['start', '--frob'], {})).toThrow(/unknown flag/);
    expect(() => parseConfig(['start', '--port', 'abc'], {})).toThrow(/--port must be a number/);
    expect(() => parseConfig(['start', '--port'], {})).toThrow(/requires a value/);
    expect(() => parseConfig(['start', '--port', '--mock-llm'], {})).toThrow(/requires a value/);
  });

  it('-h/--help and -V/--version override the command', () => {
    expect(parseConfig(['start', '--help'], {}).command).toBe('help');
    expect(parseConfig(['start', '-V'], {}).command).toBe('version');
  });
});
