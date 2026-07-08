/**
 * setup-notifier — one-time macOS notification setup:
 *   1. Builds the "Botty" identity app (~/.botty/Botty.app) via osacompile,
 *      sets bundle id io.maxolabs.botty + name Botty, ad-hoc codesigns it.
 *   2. Launches it once so it registers with Notification Center (accept the
 *      permission prompt / enable "Botty" in System Settings → Notifications).
 *   3. Reminds about terminal-notifier (primary delivery path).
 *
 *   npm run setup:notifier -w @botty/agent
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from '../env.js';

if (process.platform !== 'darwin') {
  console.error('macOS only');
  process.exit(1);
}

const appPath = join(loadEnv().dataDir, 'Botty.app');
const work = mkdtempSync(join(tmpdir(), 'botty-notifier-'));
const script = join(work, 'botty.applescript');
writeFileSync(
  script,
  [
    'on run argv',
    '  if (count of argv) >= 2 then',
    '    display notification (item 2 of argv) with title (item 1 of argv)',
    '  else',
    '    display notification "Botty instalado como identidad de notificaciones" with title "Botty"',
    '  end if',
    '  delay 1',
    'end run',
    '',
  ].join('\n'),
);

rmSync(appPath, { recursive: true, force: true });
execFileSync('osacompile', ['-o', appPath, script]);
const plist = join(appPath, 'Contents/Info.plist');
execFileSync('plutil', ['-replace', 'CFBundleIdentifier', '-string', 'io.maxolabs.botty', plist]);
execFileSync('plutil', ['-replace', 'CFBundleName', '-string', 'Botty', plist]);
execFileSync('codesign', ['-f', '-s', '-', appPath]);
execFileSync('open', [appPath]);
rmSync(work, { recursive: true, force: true });

console.log(`Botty.app built at ${appPath} and launched.`);
console.log('Next steps:');
console.log('  1. Accept the notification permission prompt (or enable "Botty" in');
console.log('     System Settings → Notifications, style Banners/Alerts).');
console.log('  2. brew install terminal-notifier, `open` its .app once, and enable it');
console.log('     in Notifications too — it is the primary delivery path; with the');
console.log('     Botty identity authorized, banners show as "Botty".');
