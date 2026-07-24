import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CliConfig } from '../config.js';
import { ownership, repoRoot, stopOwned } from '../procs.js';
import type { ProcName } from '../procs.js';
import { startDaemon } from './start.js';

function git(args: string[]): string {
  // stderr piped, not inherited: expected failures (e.g. the ff-only probe)
  // must not splat git's "fatal:" over the CLI's own message.
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Did the incoming diff touch dependency manifests? */
export function needsInstall(changed: string[]): boolean {
  return changed.some((f) => f === 'package-lock.json' || f === 'package.json' || f.endsWith('/package.json'));
}

/** Did the incoming diff touch what the web build compiles (web sources or the shared contracts)? */
export function needsWebBuild(changed: string[]): boolean {
  return changed.some(
    (f) => (f.startsWith('packages/web/') && !f.startsWith('packages/web/dist/')) || f.startsWith('packages/shared/'),
  );
}

/**
 * Update the checkout to the latest upstream commit and restart what this CLI
 * was running. Phase 1 is a repo install, so "latest version" = the tracked
 * branch's upstream head: fetch → ff-only merge → npm install / web rebuild
 * when the diff calls for it. Owned processes are stopped first (they run the
 * old code from memory until restarted) and restarted at the end — foreign
 * processes are never touched, and the web dist is not rebuilt while a foreign
 * agent may be serving it.
 */
export async function update(cfg: CliConfig): Promise<void> {
  if (!fs.existsSync(path.join(repoRoot, '.git'))) {
    throw new Error(`${repoRoot} is not a git checkout — phase-1 installs update via git.`);
  }
  let upstream: string;
  try {
    upstream = git(['rev-parse', '--abbrev-ref', '@{upstream}']);
  } catch {
    throw new Error('current branch tracks no upstream — set one (git branch -u origin/main) or update manually.');
  }

  console.log(`fetching ${upstream}…`);
  git(['fetch', '--quiet']);
  const oldHead = git(['rev-parse', 'HEAD']);
  const newHead = git(['rev-parse', '@{upstream}']);
  if (oldHead === newHead) {
    console.log(`already up to date (${oldHead.slice(0, 7)}).`);
    return;
  }

  const changed = git(['diff', '--name-only', `${oldHead}..${newHead}`]).split('\n').filter(Boolean);
  const count = git(['rev-list', '--count', `${oldHead}..${newHead}`]);

  // Stop what we own before swapping the code under it; foreign listeners are
  // reported and left alone (and block the web rebuild — they may be serving dist).
  const stopped: ProcName[] = [];
  let foreignAgent = false;
  for (const name of ['agent', 'sim'] as ProcName[]) {
    const o = ownership(cfg, name);
    if (o.state === 'owned') {
      await stopOwned(cfg, name);
      stopped.push(name);
      console.log(`stopped ${name} (restarted after the update).`);
    } else if (o.state === 'foreign') {
      if (name === 'agent') foreignAgent = true;
      console.log(`${name} has a foreign listener (pid ${o.pid}, not started by botty) — leaving it running.`);
    }
  }

  try {
    try {
      git(['merge', '--ff-only', newHead]);
    } catch {
      throw new Error(
        `cannot fast-forward ${oldHead.slice(0, 7)} → ${newHead.slice(0, 7)} — local commits or conflicting ` +
          `changes in ${repoRoot}. Resolve manually (git pull), then re-run \`botty update\`.`,
      );
    }

    if (needsInstall(changed)) {
      console.log('dependency manifests changed — running npm install…');
      const res = spawnSync('npm', ['install'], { cwd: repoRoot, stdio: 'inherit' });
      if (res.status !== 0) throw new Error('npm install failed — fix it and re-run `botty update`.');
    }

    if (needsWebBuild(changed)) {
      if (foreignAgent) {
        console.log(
          'web UI changed but a foreign agent may be serving packages/web/dist — skipping the rebuild. ' +
            'Run `npm run build -w @botty/web` once that agent is stopped.',
        );
      } else {
        console.log('web UI changed — rebuilding…');
        const res = spawnSync('npm', ['run', 'build', '-w', '@botty/web'], { cwd: repoRoot, stdio: 'inherit' });
        if (res.status !== 0) throw new Error('web build failed — fix it and re-run `botty update`.');
      }
    }
  } catch (err) {
    // Don't leave the daemon down on a failed update: the old code is still on
    // disk (ff-merge is all-or-nothing), so bring back what we stopped.
    if (stopped.length > 0) {
      console.error('update failed — restarting the daemon on the previous version…');
      await startDaemon(cfg).catch((e) => console.error(`restart failed too: ${(e as Error).message}`));
    }
    throw err;
  }

  if (stopped.length > 0) await startDaemon(cfg);
  console.log(
    `updated ${oldHead.slice(0, 7)} → ${newHead.slice(0, 7)} (${count} commit${count === '1' ? '' : 's'})` +
      `${stopped.length > 0 ? ' — daemon restarted' : ''}.`,
  );
}
