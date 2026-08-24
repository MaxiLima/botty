import { describe, expect, it } from 'vitest';
import { llmAuthCheck, nodeVersionOk } from '../src/commands/doctor.js';

describe('nodeVersionOk', () => {
  it('accepts the minimum and above', () => {
    expect(nodeVersionOk('22.12.0')).toBe(true);
    expect(nodeVersionOk('22.13.1')).toBe(true);
    expect(nodeVersionOk('23.0.0')).toBe(true);
  });

  it('rejects below the minimum', () => {
    expect(nodeVersionOk('22.11.9')).toBe(false);
    expect(nodeVersionOk('20.19.0')).toBe(false);
  });
});

describe('llmAuthCheck', () => {
  it('warns that a bare API key disables claude.ai connectors, outside a Claude Code session', () => {
    const r = llmAuthCheck({ ANTHROPIC_API_KEY: 'sk-ant-x' }, false);
    expect(r.state).toBe('warn');
    expect(r.detail).toMatch(/disables the claude\.ai/);
  });

  it('inside a Claude Code shell with a login, reports the key is stripped and login is used', () => {
    const r = llmAuthCheck({ ANTHROPIC_API_KEY: 'sk-ant-x', CLAUDECODE: '1' }, true);
    expect(r.state).toBe('ok');
    expect(r.detail).toMatch(/stripped/);
    expect(r.detail).toMatch(/Claude Code login/);
  });

  it('inside a Claude Code shell without a login, warns real-LLM calls will fail', () => {
    const r = llmAuthCheck({ ANTHROPIC_API_KEY: 'sk-ant-x', CLAUDECODE: '1' }, false);
    expect(r.state).toBe('warn');
    expect(r.detail).toMatch(/no Claude Code login/);
  });

  it('reports ok when a Claude Code login is present and no env key is set', () => {
    const r = llmAuthCheck({}, true);
    expect(r.state).toBe('ok');
    expect(r.detail).toMatch(/resolves it ambiently/);
  });

  it('warns when neither an env key nor a login is present', () => {
    const r = llmAuthCheck({}, false);
    expect(r.state).toBe('warn');
    expect(r.detail).toMatch(/no ANTHROPIC_\* env var/);
  });

  it('AUTH_TOKEN counts the same as API_KEY', () => {
    const r = llmAuthCheck({ ANTHROPIC_AUTH_TOKEN: 'tok' }, false);
    expect(r.state).toBe('warn');
    expect(r.detail).toMatch(/disables the claude\.ai/);
  });
});
