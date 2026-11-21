import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ui, ask, confirm, interactive } from './ui.mjs';
import { run, which, parseJsonLoose, writeSecretFile, isWin } from './run.mjs';
import { genSecrets, readEnvFile, writeEnvFile } from './envfile.mjs';
import { Gateway } from './gateway.mjs';
import { omni, resolveOmniroute } from './omni.mjs';
import { uniqueModels, candidates, finalMembers, spec, connectedProviders } from './combos.mjs';
import { mergeSettings, existingGatewayToken } from './claude-settings.mjs';
import { launcherSource, enableAutostart } from './autostart.mjs';
import { TESTED_OMNIROUTE } from './ctx.mjs';

const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const settingsFile = (ctx) => path.join(ctx.claudeDir, 'settings.json');
const readSettings = (ctx) => {
  try {
    return { data: JSON.parse(fs.readFileSync(settingsFile(ctx), 'utf8')), exists: true };
  } catch (e) {
    return e.code === 'ENOENT' ? { data: {}, exists: false } : { data: null, exists: true, error: e.message };
  }
};

export function nodeOk(v) {
  const [maj, min, pat] = v.split('.').map(Number);
  if (maj === 22) return min > 22 || (min === 22 && pat >= 2);
  return maj >= 24 && maj < 27;
}

/* ------------------------------------------------------------------ 1 */
export async function preflight(ctx) {
  ui.step('1/12', 'Preflight');
  if (!nodeOk(process.versions.node)) {
    ui.fail(`Node ${process.versions.node} is not supported by OmniRoute (needs >=22.22.2 <23 or >=24 <27).`);
    throw new Error('unsupported node');
  }
  ui.ok(`Node ${process.versions.node}`);
  if (!which('npm')) {
    ui.fail('npm not found on PATH.');
    throw new Error('npm missing');
  }
  ui.ok('npm found');
  if (which('claude')) {
    ui.ok('Claude Code CLI found');
  } else {
    ui.warn('Claude Code CLI not found.');
    if (await confirm('Install it now (npm i -g @anthropic-ai/claude-code)?', true)) {
      const r = await run('npm', ['install', '-g', '@anthropic-ai/claude-code'], { timeout: 600000 });
      r.code === 0 ? ui.ok('Installed Claude Code') : ui.warn('Install failed; install it yourself later. Continuing.');
    }
  }
}

/* ------------------------------------------------------------------ 2 */
export async function installOmniroute(ctx) {
  ui.step('2/12', 'OmniRoute');
  let o = resolveOmniroute();
  const want = ctx.args['omniroute-version'] ?? TESTED_OMNIROUTE;
  if (o) {
    ui.ok(`OmniRoute ${o.version} already installed`);
    if (o.version !== 'unknown' && o.version !== want && want !== 'latest') {
      ui.warn(`This kit was tested with OmniRoute ${TESTED_OMNIROUTE}. Newer versions usually work; if a step fails, try --omniroute-version ${TESTED_OMNIROUTE}.`);
    }
  } else {
    ui.info(`npm install -g omniroute@${want} (this can take a few minutes)`);
    const r = await run('npm', ['install', '-g', `omniroute@${want}`], { timeout: 900000 });
    if (r.code !== 0) {
      ui.fail(`npm install failed:\n${(r.stderr || r.stdout).slice(-600)}`);
      throw new Error('omniroute install failed');
    }
    o = resolveOmniroute();
    if (!o) throw new Error('omniroute not found after install');
    ui.ok(`Installed OmniRoute ${o.version}`);
  }
  ctx.omniroute = o;
}

/* ------------------------------------------------------------------ 3 */
function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

function tcpReachable(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 1500 });
    s.on('connect', () => (s.destroy(), resolve(true)));
    s.on('timeout', () => (s.destroy(), resolve(false)));
    s.on('error', () => resolve(false));
  });
}

export async function bootGateway(ctx) {
  ui.step('3/12', 'Gateway (fresh secrets, loopback only, API key required)');
  const gw = new Gateway(ctx.base);
  const envFile = path.join(ctx.dataDir, '.env');
  const stateFile = path.join(ctx.dataDir, 'kit-state.json');
  const ours = fs.existsSync(stateFile) && fs.existsSync(envFile);
  const dbExists = fs.existsSync(path.join(ctx.dataDir, 'storage.sqlite'));

  if (ctx.args.adopt) {
    if (!(await gw.healthy())) {
      ui.fail(`--adopt given but nothing answers at ${ctx.base}. Start OmniRoute first.`);
      throw new Error('adopt target down');
    }
    ui.ok(`Adopting the OmniRoute already running at ${ctx.base} (secrets and bind address left untouched)`);
    ctx.state.adopted = true;
    return;
  }

  if (await gw.listening()) {
    if (ours) {
      ui.ok(`Kit-managed gateway already running at ${ctx.base}`);
      return;
    }
    ui.fail(`Something is already listening on port ${ctx.port}.`);
    ui.info('Existing OmniRoute you want to configure:  --adopt --password <dashboard password>');
    ui.info('Side-by-side fresh instance:               --port 20129 --data-dir <new empty dir>');
    throw new Error('port in use');
  }

  if (dbExists && !ours) {
    ui.fail(`${ctx.dataDir} already has a database but no kit-managed .env.`);
    ui.info('Generating new secrets would make the existing credentials undecryptable. Use --adopt, or --data-dir <new dir>.');
    throw new Error('refusing to orphan existing database');
  }

  const prior = readEnvFile(envFile);
  const secrets = prior.STORAGE_ENCRYPTION_KEY ? prior : { ...genSecrets() };
  const env = {
    ...secrets,
    PORT: String(ctx.port),
    OMNIROUTE_PORT: String(ctx.port),
    HOSTNAME: ctx.host,
    HOST: ctx.host,
    OMNIROUTE_SERVER_HOST: ctx.host,
    REQUIRE_API_KEY: 'true',
    ...(ctx.dataDirIsDefault ? {} : { DATA_DIR: ctx.dataDir, OMNIROUTE_DATA_DIR: ctx.dataDir }),
  };
  fs.mkdirSync(ctx.dataDir, { recursive: true });
  writeEnvFile(envFile, env);
  ui.ok(`Wrote ${envFile} (mode 600): fresh JWT/API/storage-encryption secrets + dashboard password`);

  const launcher = path.join(ctx.dataDir, 'kit-launch.mjs');
  writeSecretFile(launcher, launcherSource({ entry: ctx.omniroute.entry, port: ctx.port }));
  ctx.state.launcher = launcher;

  ui.info('Starting gateway...');
  const r = await run(process.execPath, [launcher], { timeout: 30000 });
  if (r.code !== 0) ui.warn(`launcher exited ${r.code}: ${(r.stderr || '').slice(0, 200)}`);
  if (!(await gw.waitHealthy())) {
    ui.fail(`Gateway did not become healthy in 3 minutes. Check ${path.join(ctx.dataDir, 'logs')}, then try: omniroute doctor / omniroute repair`);
    throw new Error('gateway not healthy');
  }
  ui.ok(`Gateway up at ${ctx.base}`);
  fs.writeFileSync(stateFile, JSON.stringify({ port: ctx.port, host: ctx.host, installedAt: new Date().toISOString(), omniroute: ctx.omniroute.version }, null, 2));

  if (ctx.host === '127.0.0.1') {
    const exposed = [];
    for (const ip of lanAddresses()) if (await tcpReachable(ip, ctx.port)) exposed.push(ip);
    exposed.length
      ? ui.warn(`Gateway is reachable on the LAN (${exposed.join(', ')}). The API key is still required, but check OmniRoute's bind setting.`)
      : ui.ok('Verified: not reachable from other network interfaces');
  } else {
    ui.warn('--lan: gateway listens on all interfaces. Keep REQUIRE_API_KEY=true and use a firewall.');
  }
}

/* ------------------------------------------------------------------ 4 */
async function managementPassword(ctx) {
  return (
    ctx.args.password ||
    process.env.OMNIROUTE_PASSWORD ||
    readEnvFile(path.join(ctx.dataDir, '.env')).INITIAL_PASSWORD ||
    (await ask('OmniRoute dashboard password:', { secret: true }))
  );
}

/** Dashboard-session client (management API). Cached on ctx. */
export async function managementGateway(ctx) {
  if (ctx.mgmt) return ctx.mgmt;
  const g = new Gateway(ctx.base);
  const pw = await managementPassword(ctx);
  if (!pw || !(await g.login(pw))) {
    ui.fail('Dashboard login failed (wrong password?). Pass --password <pw>.');
    throw new Error('login failed');
  }
  ctx.mgmt = g;
  return g;
}

export async function getGateway(ctx) {
  if (ctx.gw?.key) return ctx.gw;
  const g = new Gateway(ctx.base);
  const prior = existingGatewayToken(readSettings(ctx).data, ctx.base);
  if (prior && (await g.keyWorks(prior))) {
    g.key = prior;
  } else {
    const m = await managementGateway(ctx);
    const created = await m.createKey('claude-code');
    let key = created.key;
    if (!key) {
      ui.warn(`Could not create a gateway key automatically (HTTP ${created.status}).`);
      ui.info(`Open ${ctx.base}/dashboard (Endpoints page), create/copy an API key, and paste it here.`);
      key = await ask('Gateway API key:', { secret: true });
    }
    if (!key || !(await g.keyWorks(key))) {
      ui.fail('No working gateway API key.');
      throw new Error('no gateway key');
    }
    g.key = key;
    ui.ok('Created gateway API key "claude-code"');
  }
  ctx.gw = g;
  ctx.key = g.key;
  return g;
}

export async function ensureKey(ctx) {
  ui.step('4/12', 'Gateway API key');
  await getGateway(ctx);
  ui.ok('Gateway key verified against /v1/models');
}

/* ------------------------------------------------------------------ 5 */
async function listConnected(ctx) {
  const r = await omni(ctx, ['--output', 'json', 'providers', 'list']);
  return connectedProviders(parseJsonLoose(r.stdout));
}

export async function connectProviders(ctx) {
  ui.step('5/12', 'Providers');
  await getGateway(ctx);
  let connected = (await listConnected(ctx)) ?? new Set();
  const p = ctx.cfg.providers;

  for (const k of p.keyless) {
    if (connected.has(k.id)) {
      ui.ok(`${k.label}: already connected`);
      continue;
    }
    const args =
      k.mode === 'dummy-credential'
        ? ['providers', 'add', k.id, '--credential-stdin', '--yes']
        : ['providers', 'add', k.id, '--allow-no-credential', '--yes'];
    const r = await omni(ctx, args, { input: k.mode === 'dummy-credential' ? k.credential : undefined });
    if (r.code === 0) ui.ok(`${k.label}: connected (no account needed)`);
    else if (k.mode === 'noauth') ui.info(`${k.label}: needs no connection (built in); the probe step will confirm`);
    else ui.warn(`${k.label}: could not add (${(r.stderr || r.stdout).replace(/\s+/g, ' ').slice(-140)})`);
  }

  for (const k of p.apiKey) {
    if (connected.has(k.id)) {
      ui.ok(`${k.label}: already connected`);
      continue;
    }
    let key = process.env[k.env] ?? '';
    if (!key && interactive()) {
      ui.info(`${k.label} (${k.free}). Get a key: ${k.url}`);
      key = await ask(`Paste ${k.label} API key (Enter to skip):`, { secret: true });
    }
    if (!key) {
      ui.info(`${k.label}: skipped (set ${k.env} and re-run with --only providers to add later)`);
      continue;
    }
    const r = await omni(ctx, ['providers', 'add', k.id, '--credential-stdin', '--yes'], { input: key });
    r.code === 0 ? ui.ok(`${k.label}: connected`) : ui.warn(`${k.label}: add failed (${(r.stderr || r.stdout).replace(/\s+/g, ' ').slice(-140)})`);
  }

  if (ctx.args['no-oauth']) {
    ui.info('OAuth providers skipped (--no-oauth)');
  } else {
    connected = (await listConnected(ctx)) ?? connected;
    for (const o of p.oauth) {
      if (connected.has(o.id)) {
        ui.ok(`${o.label}: already connected`);
        continue;
      }
      if (!interactive()) {
        ui.info(`${o.label}: skipped (needs a browser; run again without --yes, or: omniroute providers auth ${o.id})`);
        continue;
      }
      if (o.tos) ui.warn(`${o.label}: routing a consumer subscription through a third-party gateway may breach that provider's terms. Your decision and your account.`);
      if (!(await confirm(`Connect ${o.label}?`, false))) continue;
      const args = ['providers', 'auth', o.id, ...(ctx.args['no-browser'] ? ['--no-browser'] : [])];
      const r = await omni(ctx, args, { inherit: true, timeout: 330000 });
      r.code === 0 ? ui.ok(`${o.label}: connected`) : ui.warn(`${o.label}: not connected (finish it later in the dashboard)`);
    }
  }
}

/* ------------------------------------------------------------------ 6 */
export async function buildCombos(ctx) {
  ui.step('6/12', 'Failover combos (tool-call verified)');
  const gw = await getGateway(ctx);
  const combos = ctx.cfg.combos.combos;
  const connected = await listConnected(ctx);
  const all = uniqueModels(combos);
  const cand = candidates(all, connected);
  ui.info(`${cand.length} candidate models of ${all.length} (connected providers + keyless). Probing each with a real tool call...`);

  const results = new Map();
  for (const m of cand) {
    const r = ctx.args['no-probe'] ? { ok: true, kind: 'skipped', ms: 0 } : await gw.probeTool(m.model, { timeout: Number(ctx.args['probe-timeout'] ?? 60000) });
    results.set(m.model, r);
    (r.ok ? ui.ok : ui.info)(`${r.ok ? 'keep' : 'drop'}  ${m.model}  [${r.kind}${r.ms ? ` ${r.ms}ms` : ''}]${r.ok || !r.detail ? '' : ` ${String(r.detail).replace(/\s+/g, ' ').slice(0, 70)}`}`);
  }

  const built = new Map();
  for (const c of combos) built.set(c.name, finalMembers(c.members, results));
  const main = combos.find((c) => c.role === 'main');
  const fast = combos.find((c) => c.role === 'small-fast');
  if (!built.get(main.name).length) {
    ui.fail('No model passed the tool-call probe, so no combo was created and Claude Code settings will NOT be changed.');
    ui.info('Connect at least one provider (OAuth subscription or a free key from section 5), then re-run:  node installer/install.mjs --only providers,combos,claude');
    ctx.state.abortSettings = true;
    return;
  }
  if (!built.get(fast.name).length) {
    ui.warn(`No fast-model candidates passed; ${fast.name} will reuse the ${main.name} list.`);
    built.set(fast.name, built.get(main.name));
  }

  const existing = parseJsonLoose((await omni(ctx, ['--output', 'json', 'combo', 'list'])).stdout)?.combos ?? [];
  for (const c of combos) {
    const members = built.get(c.name);
    if (existing.some((e) => e.name === c.name)) {
      let d = await omni(ctx, ['combo', 'delete', c.name, '--yes']);
      if (d.code !== 0) d = await omni(ctx, ['combo', 'delete', c.name]);
      if (d.code !== 0) ui.warn(`could not delete old combo ${c.name}: ${(d.stderr || d.stdout).slice(-120)}`);
    }
    const r = await omni(ctx, ['combo', 'create', c.name, '--strategy', c.strategy, '--models', spec(members)]);
    if (r.code !== 0) {
      ui.fail(`create combo ${c.name} failed: ${(r.stderr || r.stdout).replace(/\s+/g, ' ').slice(-200)}`);
      throw new Error('combo create failed');
    }
    ui.ok(`combo "${c.name}": ${members.length} members, first = ${members[0].model}`);
  }
  ctx.state.mainCombo = main.name;
  ctx.state.fastCombo = fast.name;
  ctx.state.firstProvider = built.get(main.name)[0].provider;
}

/* ------------------------------------------------------------------ 7 */
const deepMerge = (a, b) => {
  if (b && typeof b === 'object' && !Array.isArray(b)) {
    const out = { ...(a && typeof a === 'object' && !Array.isArray(a) ? a : {}) };
    for (const [k, v] of Object.entries(b)) out[k] = deepMerge(out[k], v);
    return out;
  }
  return b;
};

export async function applyCompression(ctx) {
  ui.step('7/12', 'Token optimization: OmniRoute compression (conservative)');
  const m = await managementGateway(ctx);
  const before = await m.getCompression();
  if (!before) {
    ui.warn('Could not read /api/settings/compression; skipping (set it in Dashboard > Settings > Compression).');
    return;
  }
  writeSecretFile(path.join(ctx.dataDir, 'compression-settings.bak-pre-kit.json'), JSON.stringify(before));
  const next = deepMerge(before, ctx.cfg.compression.patch);
  const r = await m.putCompression(next);
  if (!r.ok) {
    ui.warn(`PUT /api/settings/compression returned HTTP ${r.status}; skipping.`);
    return;
  }
  const after = await m.getCompression();
  const good = Object.entries(ctx.cfg.compression.expect).every(([k, v]) => after?.[k] === v);
  good ? ui.ok('Compression: lite + session-dedup on; tool-result truncation, caveman and rtk engines off (expect ~9% savings)') : ui.warn('Compression PUT accepted but read-back differs; check the dashboard.');
}

/* ------------------------------------------------------------------ 8 */
export async function installRtk(ctx) {
  ui.step('8/12', 'Token optimization: RTK (Bash output condenser)');
  ctx.state.rtk = false;
  const works = async () => (await run('rtk', ['gain'], { timeout: 20000 })).code === 0;
  if (which('rtk')) {
    if (await works()) {
      ui.ok('RTK present and verified (rtk gain)');
      ctx.state.rtk = true;
      return;
    }
    ui.warn('A different "rtk" is on PATH (crates.io has a same-named crate). Not hooking it.');
    return;
  }
  if (ctx.args['skip-rtk'] || !(await confirm('RTK not installed. Install it (cuts Bash/tool output tokens)?', true))) {
    ui.info('RTK skipped; the Bash hook will not be added.');
    return;
  }
  let r;
  if (isWin) r = await run('winget', ['install', 'rtk-ai.rtk', '--silent', '--accept-package-agreements', '--accept-source-agreements'], { timeout: 600000 });
  else if (which('brew')) r = await run('brew', ['install', 'rtk'], { timeout: 600000 });
  else if (await confirm('No Homebrew. Run the official install script (curl | sh from github.com/rtk-ai/rtk)?', false)) r = await run('sh', ['-c', 'curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh'], { timeout: 600000 });
  else return ui.info('RTK skipped.');
  if (r.code !== 0) {
    ui.warn(`RTK install failed: ${(r.stderr || r.stdout).replace(/\s+/g, ' ').slice(-200)}`);
    return;
  }
  if (which('rtk') && !(await works())) return ui.warn('RTK installed but `rtk gain` failed; hook not added.');
  ui.ok('RTK installed');
  if (!which('rtk')) ui.warn('RTK is not on PATH in this shell yet; open a new terminal before starting Claude Code.');
  ctx.state.rtk = true;
}

/* ------------------------------------------------------------------ 9 */
export async function configureClaude(ctx) {
  ui.step('9/12', 'Claude Code settings');
  if (ctx.state.abortSettings) return ui.warn('Skipped (no working combos).');
  const gw = await getGateway(ctx);
  const cur = readSettings(ctx);
  if (cur.data === null) {
    ui.fail(`${settingsFile(ctx)} is not valid JSON (${cur.error}). Fix it and re-run with --only claude. Nothing was changed.`);
    return;
  }
  const mainCombo = ctx.state.mainCombo ?? 'unlimited';
  const fastCombo = ctx.state.fastCombo ?? 'unlimited-fast';
  const contextTokens = ctx.args['context-tokens'] ?? (ctx.state.firstProvider === 'claude' ? 1000000 : 128000);
  const { merged, changes, warnings } = mergeSettings(cur.data, ctx.cfg.claudeSettings, {
    baseUrl: ctx.base,
    gatewayKey: gw.key,
    mainCombo,
    fastCombo,
    contextTokens,
    rtk: ctx.state.rtk === true || (ctx.state.rtk === undefined && Boolean(which('rtk'))),
    bypassPermissions: Boolean(ctx.args['bypass-permissions']),
  });
  fs.mkdirSync(ctx.claudeDir, { recursive: true });
  if (cur.exists) {
    const bak = `${settingsFile(ctx)}.bak-omniroute-kit-${stamp()}`;
    fs.copyFileSync(settingsFile(ctx), bak);
    ui.ok(`Backed up existing settings to ${path.basename(bak)}`);
  }
  writeSecretFile(settingsFile(ctx), `${JSON.stringify(merged, null, 2)}\n`);
  changes.length ? ui.ok(`Updated: ${changes.join(', ')}`) : ui.ok('Settings already up to date');
  ui.info(`Context window assumption: ${contextTokens} tokens (CLAUDE_CODE_MAX_CONTEXT_TOKENS). ${contextTokens >= 1000000 ? 'Assumes the Claude subscription is first in the combo; if it fails over to a 128K model mid-session you can hit context errors.' : 'Conservative because the first working model is not a 1M-context Claude.'}`);
  warnings.forEach((w) => ui.warn(w));

  if (ctx.state.rtk) {
    const rtkMd = path.join(ctx.claudeDir, 'RTK.md');
    if (!fs.existsSync(rtkMd)) fs.writeFileSync(rtkMd, ctx.cfg.rtkMd);
    const claudeMd = path.join(ctx.claudeDir, 'CLAUDE.md');
    const body = fs.existsSync(claudeMd) ? fs.readFileSync(claudeMd, 'utf8') : '';
    if (!/^@RTK\.md\s*$/m.test(body)) fs.writeFileSync(claudeMd, `${body}${body && !body.endsWith('\n') ? '\n' : ''}@RTK.md\n`);
    ui.ok('RTK.md installed and referenced from CLAUDE.md');
  }
}

/* ------------------------------------------------------------------ 10 */
export async function installPlugins(ctx) {
  ui.step('10/12', 'Optional Claude Code plugins');
  if (!which('claude')) return ui.info('claude CLI not available; skipped.');
  const want = ctx.args.plugins === true;
  for (const p of ctx.cfg.plugins.plugins) {
    if (!want && !(await confirm(`Install plugin ${p.label}?`, false))) continue;
    const r = await run('claude', ['plugin', 'install', p.id], { timeout: 180000 });
    r.code === 0 ? ui.ok(`${p.id} installed`) : ui.warn(`${p.id}: ${(r.stderr || r.stdout).replace(/\s+/g, ' ').slice(-120)}`);
  }
}

/* ------------------------------------------------------------------ 11 */
export async function setupAutostart(ctx) {
  ui.step('11/12', 'Start the gateway at login');
  const launcher = ctx.state.launcher ?? path.join(ctx.dataDir, 'kit-launch.mjs');
  if (ctx.state.adopted || !fs.existsSync(launcher)) return ui.info('Not kit-managed; skipped.');
  if (ctx.args['no-autostart'] || !(await confirm('Start the gateway automatically at login? (Claude Code stops working if the gateway is down)', true))) return ui.info('Autostart skipped. Start manually with: node "' + launcher + '"');
  const r = await enableAutostart({ launcher });
  r.ok ? ui.ok(`Autostart registered: ${r.where}`) : ui.warn(`Autostart registration failed (${r.where}).`);
  if (!isWin) ui.info('macOS/Linux autostart was not exercised during development; verify after a reboot.');
}

/* ------------------------------------------------------------------ 12 */
export async function verify(ctx) {
  ui.step('12/12', 'End-to-end check');
  const gw = await getGateway(ctx);
  let allOk = true;
  for (const name of [ctx.state.mainCombo ?? 'unlimited', ctx.state.fastCombo ?? 'unlimited-fast']) {
    const r = await gw.probeTool(name, { timeout: 90000 });
    r.ok ? ui.ok(`${name}: tool call succeeded via the combo (${r.ms}ms)`) : ((allOk = false), ui.fail(`${name}: ${r.kind} ${r.detail ?? ''}`));
  }
  console.log('');
  console.log(allOk ? 'Setup complete.' : 'Setup finished with problems (see above).');
  console.log(`  Dashboard : ${ctx.base}/dashboard   (password is INITIAL_PASSWORD in ${path.join(ctx.dataDir, '.env')})`);
  console.log(`  Back up   : ${path.join(ctx.dataDir, '.env')}  (encryption key; without it stored credentials are unreadable)`);
  console.log('  Next      : restart Claude Code (open a NEW terminal), then run `claude`.');
  console.log('  Health    : node installer/doctor.mjs     Re-probe/rebuild combos: node installer/install.mjs --only combos');
  return allOk;
}

/* ------------------------------------------------------------------ dry run */
export async function dryRun(ctx) {
  ui.step('dry-run', 'No changes will be made');
  ui.info(`node ${process.versions.node}: ${nodeOk(process.versions.node) ? 'supported' : 'NOT supported'}`);
  const o = resolveOmniroute();
  ui.info(o ? `OmniRoute ${o.version} installed` : `OmniRoute not installed (would run: npm install -g omniroute@${ctx.args['omniroute-version'] ?? TESTED_OMNIROUTE})`);
  const gw = new Gateway(ctx.base);
  ui.info(`port ${ctx.port}: ${(await gw.listening()) ? 'IN USE (installer would stop unless --adopt or another --port)' : 'free'}`);
  const ours = fs.existsSync(path.join(ctx.dataDir, 'kit-state.json'));
  const db = fs.existsSync(path.join(ctx.dataDir, 'storage.sqlite'));
  ui.info(`data dir ${ctx.dataDir}: ${db ? (ours ? 'kit-managed database (would reuse secrets)' : 'EXISTING database not managed by this kit (installer would refuse without --adopt)') : 'empty/new'}`);
  ui.info(`bind: ${ctx.host}, REQUIRE_API_KEY=true, fresh JWT/API/storage-encryption secrets`);
  const all = uniqueModels(ctx.cfg.combos.combos);
  ui.info(`would probe up to ${all.length} models, then build combos: ${ctx.cfg.combos.combos.map((c) => `${c.name}(${c.members.length} template members)`).join(', ')}`);
  const cur = readSettings(ctx);
  if (cur.data) {
    const { changes, warnings } = mergeSettings(cur.data, ctx.cfg.claudeSettings, { baseUrl: ctx.base, gatewayKey: '<new-gateway-key>', mainCombo: 'unlimited', fastCombo: 'unlimited-fast', contextTokens: ctx.args['context-tokens'] ?? '<1000000|128000>', rtk: Boolean(which('rtk')), bypassPermissions: Boolean(ctx.args['bypass-permissions']) });
    ui.info(`${settingsFile(ctx)} would change: ${changes.join(', ') || 'nothing'} (backup first)`);
    warnings.forEach((w) => ui.warn(w));
  } else ui.warn(`${settingsFile(ctx)} is invalid JSON; installer would refuse to touch it.`);
  ui.info(`RTK: ${which('rtk') ? 'present' : 'would offer to install'}`);
}
