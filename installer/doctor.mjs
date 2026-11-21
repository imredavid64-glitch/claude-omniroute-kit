#!/usr/bin/env node
/** Read-only health check. Never changes configuration. */
import fs from 'node:fs';
import path from 'node:path';
import { makeCtx } from './lib/ctx.mjs';
import { ui } from './lib/ui.mjs';
import { run, which } from './lib/run.mjs';
import { Gateway } from './lib/gateway.mjs';
import { resolveOmniroute } from './lib/omni.mjs';
import { readEnvFile } from './lib/envfile.mjs';

const ctx = makeCtx(process.argv.slice(2));
let bad = 0;
const check = (ok, good, badMsg) => (ok ? ui.ok(good) : (bad++, ui.fail(badMsg)));

ui.step('doctor', 'claude-omniroute-kit health');
const o = resolveOmniroute();
check(Boolean(o), `OmniRoute ${o?.version}`, 'OmniRoute is not installed');

let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(path.join(ctx.claudeDir, 'settings.json'), 'utf8'));
} catch {
  /* handled below */
}
const env = settings.env ?? {};
check(Boolean(env.ANTHROPIC_BASE_URL && env.ANTHROPIC_AUTH_TOKEN), `Claude Code points at ${env.ANTHROPIC_BASE_URL}`, 'Claude Code settings.json has no ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN (run the installer)');

const base = env.ANTHROPIC_BASE_URL ?? ctx.base;
const gw = new Gateway(base);
gw.key = env.ANTHROPIC_AUTH_TOKEN ?? '';
check(await gw.healthy(), `Gateway healthy at ${base}`, `Gateway not answering at ${base}. Start it: node "${path.join(ctx.dataDir, 'kit-launch.mjs')}"`);

if (await gw.healthy()) {
  check(await gw.keyWorks(gw.key), 'Gateway API key accepted', 'Gateway rejected the key in settings.json (re-run: node installer/install.mjs --only key,claude)');
  const unauth = await gw.req('/v1/models', { auth: 'none', timeout: 8000 });
  check(unauth.status === 401 || unauth.status === 403, 'Unauthenticated requests are refused', `Gateway answered HTTP ${unauth.status} WITHOUT a key: anyone who can reach this port can spend your credentials`);
  for (const name of [env.ANTHROPIC_MODEL, env.ANTHROPIC_SMALL_FAST_MODEL].filter(Boolean)) {
    const r = await gw.probeTool(name, { timeout: 90000 });
    check(r.ok, `${name}: tool call OK (${r.ms}ms)`, `${name}: ${r.kind} ${r.detail ?? ''} (re-probe: node installer/install.mjs --only combos)`);
  }
}

const dataEnv = readEnvFile(path.join(ctx.dataDir, '.env'));
check(Boolean(dataEnv.STORAGE_ENCRYPTION_KEY), 'Storage encryption key present', 'STORAGE_ENCRYPTION_KEY missing: provider credentials are stored unencrypted');

if (which('rtk')) {
  const g = await run('rtk', ['gain'], { timeout: 20000 });
  check(g.code === 0, 'RTK works (rtk gain)', 'rtk on PATH but `rtk gain` fails (wrong rtk?)');
  const hooked = JSON.stringify(settings.hooks ?? {}).includes('rtk hook');
  check(hooked, 'RTK Bash hook configured', 'RTK installed but hook missing from settings.json');
} else ui.info('RTK not installed (optional)');

console.log(bad ? `\n${bad} problem(s) found.` : '\nAll checks passed.');
process.exit(bad ? 1 : 0);
