#!/usr/bin/env node
import { makeCtx } from './lib/ctx.mjs';
import { ui } from './lib/ui.mjs';
import * as S from './lib/steps.mjs';

const HELP = `claude-omniroute-kit installer

Usage: node installer/install.mjs [options]

  --yes                    Never prompt; use defaults (keyless providers + keys from env vars only)
  --dry-run                Read-only: show what would happen
  --only a,b,c             Run only these steps:
                           preflight,omniroute,gateway,key,providers,combos,compression,rtk,claude,plugins,autostart,verify
  --port N                 Gateway port (default 20128)
  --data-dir DIR           OmniRoute data dir (default ~/.omniroute)
  --adopt                  Configure an OmniRoute that is already running (needs --password)
  --password PW            Dashboard password (adopt / re-runs)
  --lan                    Bind 0.0.0.0 instead of 127.0.0.1 (not recommended)
  --no-oauth               Skip OAuth subscription providers
  --no-browser             OAuth flows print the URL instead of opening a browser
  --no-probe               Skip tool-call probing (not recommended: dead models enter the combos)
  --probe-timeout MS       Per-model probe timeout (default 60000)
  --skip-rtk               Do not install/hook RTK
  --plugins                Install the optional Claude Code plugins without asking
  --no-autostart           Do not register start-at-login
  --context-tokens N       Override CLAUDE_CODE_MAX_CONTEXT_TOKENS
  --bypass-permissions     ALSO set permissions.defaultMode=bypassPermissions (off by default; dangerous)
  --omniroute-version V    npm version/tag of omniroute (default: the tested one)

Provider keys can be supplied via env: GROQ_API_KEY, NVIDIA_API_KEY, OPENROUTER_API_KEY.
`;

const STEPS = {
  preflight: S.preflight,
  omniroute: S.installOmniroute,
  gateway: S.bootGateway,
  key: S.ensureKey,
  providers: S.connectProviders,
  combos: S.buildCombos,
  compression: S.applyCompression,
  rtk: S.installRtk,
  claude: S.configureClaude,
  plugins: S.installPlugins,
  autostart: S.setupAutostart,
  verify: S.verify,
};

const ctx = makeCtx(process.argv.slice(2));
if (ctx.args.help || ctx.args.h) {
  console.log(HELP);
  process.exit(0);
}
ui.yes = Boolean(ctx.args.yes || ctx.args['non-interactive']);

try {
  if (ctx.args['dry-run']) {
    await S.dryRun(ctx);
    process.exit(0);
  }
  const only = ctx.args.only ? String(ctx.args.only).split(',').map((s) => s.trim()) : null;
  if (only) for (const n of only) if (!STEPS[n]) throw new Error(`unknown step "${n}"`);
  // Steps that need ctx.omniroute / a running gateway resolve lazily when run with --only.
  if (only && !only.includes('omniroute')) {
    const { resolveOmniroute } = await import('./lib/omni.mjs');
    ctx.omniroute = resolveOmniroute();
    if (!ctx.omniroute) throw new Error('OmniRoute is not installed; run without --only first.');
  }
  for (const [name, fn] of Object.entries(STEPS)) {
    if (only && !only.includes(name)) continue;
    const r = await fn(ctx);
    if (name === 'verify' && r === false) process.exitCode = 2;
  }
} catch (e) {
  console.error(`\nInstall stopped: ${e.message}`);
  process.exit(1);
}
