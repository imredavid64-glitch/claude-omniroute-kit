import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mergeSettings, existingGatewayToken, fill } from '../installer/lib/claude-settings.mjs';
import { uniqueModels, candidates, finalMembers, spec, connectedProviders } from '../installer/lib/combos.mjs';
import { parseJsonLoose } from '../installer/lib/run.mjs';
import { parseEnv, genSecrets } from '../installer/lib/envfile.mjs';
import { extractKey } from '../installer/lib/gateway.mjs';
import { nodeOk } from '../installer/lib/steps.mjs';
import { launcherSource } from '../installer/lib/autostart.mjs';
import { loadConfig, KIT_DIR } from '../installer/lib/ctx.mjs';
import { scanDir } from '../tools/scan-secrets.mjs';

const cfg = loadConfig();
const opts = { baseUrl: 'http://127.0.0.1:20128', gatewayKey: 'TESTKEY', mainCombo: 'unlimited', fastCombo: 'unlimited-fast', contextTokens: 1000000, rtk: true, bypassPermissions: false };

test('settings merge preserves unrelated user keys', () => {
  const existing = { theme: 'light', permissions: { allow: ['Read'] }, enabledPlugins: { x: true }, env: { FOO: 'bar' }, hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'lint' }] }] } };
  const { merged } = mergeSettings(existing, cfg.claudeSettings, opts);
  assert.equal(merged.theme, 'light');
  assert.deepEqual(merged.permissions, { allow: ['Read'] });
  assert.deepEqual(merged.enabledPlugins, { x: true });
  assert.equal(merged.env.FOO, 'bar');
  assert.equal(merged.hooks.PreToolUse.length, 2);
  assert.equal(merged.env.ANTHROPIC_AUTH_TOKEN, 'TESTKEY');
  assert.equal(merged.env.ANTHROPIC_MODEL, 'unlimited');
  assert.equal(merged.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1000000');
});

test('settings merge is idempotent and never duplicates the hook', () => {
  const once = mergeSettings({}, cfg.claudeSettings, opts).merged;
  const twice = mergeSettings(once, cfg.claudeSettings, opts);
  assert.deepEqual(twice.merged, once);
  assert.equal(twice.changes.length, 0);
  assert.equal(once.hooks.PreToolUse.length, 1);
});

test('no RTK hook unless rtk is present', () => {
  const { merged } = mergeSettings({}, cfg.claudeSettings, { ...opts, rtk: false });
  assert.equal(merged.hooks, undefined);
});

test('bypassPermissions is opt-in only', () => {
  assert.equal(mergeSettings({}, cfg.claudeSettings, opts).merged.permissions, undefined);
  const on = mergeSettings({}, cfg.claudeSettings, { ...opts, bypassPermissions: true }).merged;
  assert.equal(on.permissions.defaultMode, 'bypassPermissions');
});

test('merge does not mutate its input and warns on conflicts', () => {
  const existing = { env: { ANTHROPIC_API_KEY: 'x', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, model: 'opus' };
  const copy = structuredClone(existing);
  const r = mergeSettings(existing, cfg.claudeSettings, opts);
  assert.deepEqual(existing, copy);
  assert.ok(r.warnings.length >= 3);
});

test('existingGatewayToken only matches the same base url', () => {
  const s = { env: { ANTHROPIC_BASE_URL: 'http://localhost:20128/', ANTHROPIC_AUTH_TOKEN: 'abc' } };
  assert.equal(existingGatewayToken(s, 'http://127.0.0.1:20128'), 'abc');
  assert.equal(existingGatewayToken(s, 'http://127.0.0.1:9999'), null);
  assert.equal(existingGatewayToken({}, 'http://127.0.0.1:20128'), null);
});

test('localhost and 127.0.0.1 count as the same base url (no churn, no false warning)', () => {
  const existing = { env: { ANTHROPIC_BASE_URL: 'http://localhost:20128' } };
  const r = mergeSettings(existing, cfg.claudeSettings, opts);
  assert.equal(r.merged.env.ANTHROPIC_BASE_URL, 'http://localhost:20128');
  assert.ok(!r.changes.includes('env.ANTHROPIC_BASE_URL'));
  assert.ok(!r.warnings.some((w) => w.includes('ANTHROPIC_BASE_URL')));
  const other = mergeSettings({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } }, cfg.claudeSettings, opts);
  assert.ok(other.warnings.some((w) => w.includes('ANTHROPIC_BASE_URL')));
});

test('fill leaves unknown placeholders visible', () => assert.equal(fill('{{A}}-{{B}}', { A: 1 }), '1-{{B}}'));

test('combo template: every member has a provider, models are unique within a combo, main has a keyless tail', () => {
  for (const c of cfg.combos.combos) {
    const ids = c.members.map((m) => m.model);
    assert.equal(new Set(ids).size, ids.length, `${c.name} has duplicate members`);
    for (const m of c.members) assert.ok(m.provider, `${m.model} missing provider`);
  }
  const main = cfg.combos.combos.find((c) => c.role === 'main');
  assert.ok(main.members.some((m) => m.keyless), 'a zero-signup fallback must exist');
  assert.ok(!JSON.stringify(cfg.combos).includes('kimi-coding'), 'banned provider must not appear');
});

test('candidates/finalMembers: keyless kept, unconnected dropped, order preserved', () => {
  const members = cfg.combos.combos[0].members;
  const kept = candidates(members, new Set(['groq']));
  assert.ok(kept.every((m) => m.keyless || m.provider === 'groq'));
  assert.equal(candidates(members, null).length, members.length);
  const results = new Map(kept.map((m, i) => [m.model, { ok: i % 2 === 0 }]));
  const fin = finalMembers(members, results);
  assert.deepEqual(fin.map((m) => m.model), kept.filter((_, i) => i % 2 === 0).map((m) => m.model));
  assert.equal(spec(fin).split(',').length, fin.length);
  assert.ok(uniqueModels(cfg.combos.combos).length < cfg.combos.combos.reduce((n, c) => n + c.members.length, 0));
});

test('connectedProviders tolerates several response shapes and inactive rows', () => {
  assert.deepEqual([...connectedProviders([{ provider: 'groq' }, { providerId: 'nvidia', isActive: false }, { provider: 'codex' }])], ['groq', 'codex']);
  assert.deepEqual([...connectedProviders({ connections: [{ provider: 'claude' }] })], ['claude']);
  assert.equal(connectedProviders(null), null);
  assert.equal(connectedProviders({ nope: 1 }), null);
});

test('parseJsonLoose skips banners/warnings and trailing log lines', () => {
  const out = '\x1b[36m  banner\x1b[0m\n  warn: something\n{"combos":[{"name":"a"}]}\n  done';
  assert.deepEqual(parseJsonLoose(out), { combos: [{ name: 'a' }] });
  assert.deepEqual(parseJsonLoose('x\n[1,2]'), [1, 2]);
  assert.equal(parseJsonLoose('no json here'), null);
});

test('secrets: fresh, long, distinct; env parser round-trips', () => {
  const a = genSecrets();
  const b = genSecrets();
  assert.equal(a.STORAGE_ENCRYPTION_KEY.length, 64);
  assert.notEqual(a.STORAGE_ENCRYPTION_KEY, b.STORAGE_ENCRYPTION_KEY);
  assert.ok(a.INITIAL_PASSWORD.length >= 12);
  const parsed = parseEnv('# c\nA=1\nB="two"\n  C = three  \n');
  assert.deepEqual(parsed, { A: '1', B: 'two', C: 'three' });
});

test('extractKey finds the key in common response shapes', () => {
  assert.equal(extractKey({ key: 'k'.repeat(20) }), 'k'.repeat(20));
  assert.equal(extractKey({ data: { apiKey: 'a'.repeat(30) } }), 'a'.repeat(30));
  assert.equal(extractKey({ key: 'short' }), null);
  assert.equal(extractKey(null), null);
});

test('node version gate matches OmniRoute engines (>=22.22.2 <23 || >=24 <27)', () => {
  for (const [v, want] of [['22.22.1', false], ['22.22.2', true], ['22.23.0', true], ['23.1.0', false], ['24.0.0', true], ['26.9.9', true], ['27.0.0', false], ['20.19.0', false]]) assert.equal(nodeOk(v), want, v);
});

test('launcher is valid JS and embeds the entry path safely', () => {
  const src = launcherSource({ entry: 'C:\\x y\\omniroute\\bin\\o.mjs', port: 20128 });
  fs.writeFileSync(path.join(KIT_DIR, 'test', '.launcher.tmp.mjs'), src);
  assert.ok(src.includes('"C:\\\\x y\\\\omniroute\\\\bin\\\\o.mjs"'));
  fs.rmSync(path.join(KIT_DIR, 'test', '.launcher.tmp.mjs'));
});

test('the shipped kit contains no credentials or personal identifiers', () => {
  const { findings } = scanDir(KIT_DIR);
  assert.deepEqual(findings, []);
});

test('scanner actually detects planted secrets (self-test)', () => {
  const dir = fs.mkdtempSync(path.join(KIT_DIR, '.scan-selftest-'));
  try {
    // Built at runtime so the shipped source contains no secret-shaped literal.
    const planted = [`token ${['sk', 'abcdefghijklmnopqrstuvwx'].join('-')}`, `mail ${['me', 'example.com'].join('@')}`, `id ${['123e4567', 'e89b', '12d3', 'a456', '426614174000'].join('-')}`].join('\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), planted);
    const kinds = scanDir(dir).findings.map((f) => f.kind);
    assert.ok(kinds.includes('sk-style key') && kinds.includes('email address') && kinds.includes('UUID (connection/account id)'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
