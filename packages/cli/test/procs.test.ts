import { describe, expect, it } from 'vitest';
import { commandLooksLikeBotty, parsePidfile } from '../src/procs.js';

describe('parsePidfile', () => {
  it('parses a valid pidfile', () => {
    expect(parsePidfile('{"pid":123,"port":4820,"startedAt":"2026-07-18T00:00:00Z"}')).toEqual({
      pid: 123,
      port: 4820,
      startedAt: '2026-07-18T00:00:00Z',
    });
  });

  it('rejects garbage, missing/invalid pids, missing port', () => {
    expect(parsePidfile('not json')).toBeNull();
    expect(parsePidfile('{}')).toBeNull();
    expect(parsePidfile('{"pid":"123","port":4820}')).toBeNull();
    expect(parsePidfile('{"pid":-1,"port":4820}')).toBeNull();
    expect(parsePidfile('{"pid":1.5,"port":4820}')).toBeNull();
    expect(parsePidfile('{"pid":123}')).toBeNull();
  });

  it('tolerates a missing startedAt', () => {
    expect(parsePidfile('{"pid":123,"port":4820}')?.startedAt).toBe('');
  });
});

describe('commandLooksLikeBotty', () => {
  it('matches the tsx wrapper we spawn (absolute entry path)', () => {
    expect(
      commandLooksLikeBotty('agent', 'node /repo/node_modules/.bin/tsx /repo/packages/agent/src/index.ts'),
    ).toBe(true);
    expect(commandLooksLikeBotty('sim', 'node /repo/node_modules/.bin/tsx /repo/packages/sim/src/index.ts')).toBe(true);
  });

  it('never claims an unrelated process (pid reuse guard)', () => {
    expect(commandLooksLikeBotty('agent', '/usr/bin/some-daemon --port 4820')).toBe(false);
    expect(commandLooksLikeBotty('agent', 'npm run -w @botty/sim start')).toBe(false);
    expect(commandLooksLikeBotty('sim', 'npm run -w @botty/agent start')).toBe(false);
  });
});
