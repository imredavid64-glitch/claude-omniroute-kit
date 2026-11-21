import readline from 'node:readline';

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n) => (s) => (tty ? `\x1b[${n}m${s}\x1b[0m` : String(s));
export const bold = c(1);
export const dim = c(2);
export const red = c(31);
export const green = c(32);
export const yellow = c(33);
export const cyan = c(36);

export const ui = {
  yes: false, // --yes: never prompt, take defaults
  step(n, t) {
    console.log(`\n${bold(cyan(`[${n}]`))} ${bold(t)}`);
  },
  ok(m) {
    console.log(`  ${green('+')} ${m}`);
  },
  info(m) {
    console.log(`  ${dim('-')} ${m}`);
  },
  warn(m) {
    console.log(`  ${yellow('!')} ${m}`);
  },
  fail(m) {
    console.log(`  ${red('x')} ${m}`);
  },
};

export function interactive() {
  return !ui.yes && Boolean(process.stdin.isTTY);
}

/** Prompt for a line. Returns `def` immediately when not interactive. */
export async function ask(question, { def = '', secret = false } = {}) {
  if (!interactive()) return def;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl.stdoutMuted = false;
  const write = rl._writeToOutput.bind(rl);
  rl._writeToOutput = (s) => {
    if (rl.stdoutMuted) return; // hide typed secret characters
    write(s);
  };
  return new Promise((resolve) => {
    rl.question(`  ${question} `, (answer) => {
      rl.close();
      if (secret) process.stdout.write('\n');
      resolve(answer.trim() || def);
    });
    rl.stdoutMuted = secret;
  });
}

export async function confirm(question, def = true) {
  if (!interactive()) return def;
  const a = (await ask(`${question} [${def ? 'Y/n' : 'y/N'}]`)).toLowerCase();
  if (!a) return def;
  return a.startsWith('y');
}
