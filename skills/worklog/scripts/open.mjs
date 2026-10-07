// skills/worklog/scripts/open.mjs — opens a report in the default browser.
//   node open.mjs <path>
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  process.stderr.write('usage: open.mjs <path>\n');
  process.exit(1);
}

const isWsl = (() => {
  try { return /microsoft/i.test(readFileSync('/proc/version', 'utf8')); } catch { return false; }
})();

const [cmd, ...args] =
  process.platform === 'darwin' ? ['open', path] :
  isWsl ? ['explorer.exe', execFileSync('wslpath', ['-w', path], { encoding: 'utf8' }).trim()] :
  ['xdg-open', path];

spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', (err) => {
  process.stderr.write(`ccworklog open: ${err.message}\n`);
  process.exit(1);
}).unref();
