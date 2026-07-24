import { describe, expect, it } from 'vitest';
import { needsInstall, needsWebBuild } from '../src/commands/update.js';

describe('needsInstall', () => {
  it('triggers on lockfile and any package.json', () => {
    expect(needsInstall(['package-lock.json'])).toBe(true);
    expect(needsInstall(['package.json'])).toBe(true);
    expect(needsInstall(['packages/agent/package.json'])).toBe(true);
  });

  it('ignores source-only diffs', () => {
    expect(needsInstall(['packages/agent/src/index.ts', 'README.md'])).toBe(false);
    expect(needsInstall([])).toBe(false);
  });
});

describe('needsWebBuild', () => {
  it('triggers on web sources and shared contracts', () => {
    expect(needsWebBuild(['packages/web/src/App.tsx'])).toBe(true);
    expect(needsWebBuild(['packages/web/package.json'])).toBe(true);
    expect(needsWebBuild(['packages/shared/src/api.ts'])).toBe(true);
  });

  it('ignores dist artifacts and non-web packages', () => {
    expect(needsWebBuild(['packages/web/dist/index.html'])).toBe(false);
    expect(needsWebBuild(['packages/agent/src/index.ts', 'docs/SPEC.md'])).toBe(false);
  });
});
