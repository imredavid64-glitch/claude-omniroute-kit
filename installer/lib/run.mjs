import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const isWin = process.platform === 'win32';

const quote = (a) => (/[\s"&|<>^]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : String(a));

/**
 * Run a command and capture output. On Windows, anything that is not node itself
 * goes through the shell so .cmd shims (npm, claude, ...) resolve.
 * Never throws; inspect `.code` / `.timedOut`.
 */
export function run(cmd, args = [], { input, env, timeout = 120000, cwd, inherit = false } = {}) {
  return new Promise((resolve) => {
    const useShell = isWin && cmd !== process.execPath;
    // Pass ONE pre-quoted command string when a shell is involved (avoids Node's DEP0190).
    const child = useShell
      ? spawn([quote(cmd), ...args.map(quote)].join(' '), {
          env: { ...process.env, ...env },
          cwd,
          shell: true,
          stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        })
      : spawn(cmd, args, {
          env: { ...process.env, ...env },
          cwd,
          stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout);
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(e.message), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
    if (!inherit) {
      if (input !== undefined) child.stdin.write(input);
      child.stdin.end();
    }
  });
}

export function which(cmd) {
  const r = spawnSync(isWin ? 'where' : 'which', [cmd], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
export const stripAnsi = (s) => String(s).replace(ANSI, '');

/** Parse JSON out of CLI output that has an ANSI banner/warnings before the payload. */
export function parseJsonLoose(text) {
  const s = stripAnsi(text);
  const starts = [s.indexOf('{'), s.indexOf('[')].filter((i) => i >= 0);
  if (!starts.length) return null;
  let body = s.slice(Math.min(...starts));
  for (let i = 0; i < 40 && body; i++) {
    try {
      return JSON.parse(body);
    } catch {
      const nl = body.lastIndexOf('\n');
      if (nl < 0) return null;
      body = body.slice(0, nl); // drop trailing log lines and retry
    }
  }
  return null;
}

export function writeSecretFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o600 });
  if (!isWin) fs.chmodSync(file, 0o600);
}
