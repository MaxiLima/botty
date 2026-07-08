import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type MacNotifier = (title: string, message: string) => void;

/**
 * Fire a native macOS notification. Preference order (empirical, macOS 15):
 *  1. terminal-notifier — registers and banners reliably once launched/authorized
 *     (Settings → Notifications → terminal-notifier → Allow + Banners/Alerts).
 *  2. botty's compiled applet via `open -a` (~/.botty/botty-notifier.app) —
 *     LaunchServices launch only; raw-executable invocation delivers nothing.
 *  3. osascript display notification (attribution depends on the invoking app).
 * Fire-and-forget; every failure is swallowed — a missed desktop banner must
 * never break a tick.
 */
/** Bundle id of the "Botty" identity app (~/.botty/Botty.app, see setup-notifier). */
export const BOTTY_SENDER_ID = 'io.maxolabs.botty';

function dataDir(): string {
  return process.env.BOTTY_DATA_DIR ?? join(homedir(), '.botty');
}

export const notifyMacos: MacNotifier = (title, message) => {
  if (process.platform !== 'darwin') return;
  // Banner identity: send as "Botty" when the identity app is installed and
  // authorized (npm run setup:notifier); -sender silently no-ops if that app
  // lacks Notification permission, so fall back to plain terminal-notifier.
  const hasBottyIdentity = existsSync(join(dataDir(), 'Botty.app'));
  const args = hasBottyIdentity
    ? ['-sender', BOTTY_SENDER_ID, '-title', title, '-message', message]
    : ['-title', title, '-message', message];
  try {
    execFile('terminal-notifier', args, (err) => {
      if (err) appletFallback(title, message);
    });
  } catch {
    appletFallback(title, message);
  }
};

/**
 * Fallback: botty's compiled applet, launched via LaunchServices (`open -a`)
 * — raw-executable invocation delivers nothing on macOS 15, `open` works.
 */
function appletFallback(title: string, message: string): void {
  const applet = join(dataDir(), 'Botty.app');
  try {
    if (existsSync(applet)) {
      execFile('open', ['-a', applet, '--args', title, message], (err) => {
        if (err) osascriptFallback(title, message);
      });
      return;
    }
  } catch {
    /* fall through */
  }
  osascriptFallback(title, message);
}

function osascriptFallback(title: string, message: string): void {
  try {
    const script = `display notification ${appleScriptString(message)} with title ${appleScriptString(title)}`;
    execFile('osascript', ['-e', script], () => {
      /* swallow */
    });
  } catch {
    /* swallow */
  }
}

function appleScriptString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
