#!/usr/bin/env node
/**
 * Fails (exit 1) if the kit contains anything that looks like a credential or personal data.
 * Run before sharing the kit:  node tools/scan-secrets.mjs [--live]
 *
 * --live additionally loads the AUTHOR's real secrets from this machine (gateway token,
 * dashboard password, JWT/API secrets) and checks they appear nowhere in the kit. The values
 * are never printed, only whether they were found.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = path.join('tools', 'scan-secrets.mjs');

const PATTERNS = [
  ['sk-style key', /\bsk-[A-Za-z0-9_-]{16,}/],
  ['oma_ token', /\boma_[A-Za-z0-9]{12,}/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{8,}/],
  ['long hex (>=32)', /\b[a-f0-9]{32,}\b/i],
  ['long base64 run (>=40)', /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/_-])/],
  ['UUID (connection/account id)', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  // Alphabetic TLD required: "omniroute@3.8.53" is an npm version spec, not an email.
  ['email address', /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b/],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['cookie/session literal', /\b(sessionKey|__Secure-1PSID|refresh_token|access_token)\s*[=:]\s*["']?[A-Za-z0-9._-]{20,}/],
];
const EMAIL_ALLOW = new Set(['noreply@anthropic.com']);
// dist/ holds built binaries; they are built FROM the scanned tree, and CI scans the extracted payload.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

function liveSecrets() {
  const found = [];
  const add = (v) => v && String(v).length >= 8 && found.push(String(v));
  const home = os.homedir();
  try {
    add(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).env?.ANTHROPIC_AUTH_TOKEN);
  } catch {
    /* absent */
  }
  const envFiles = [path.join(home, '.omniroute', '.env')];
  try {
    const root = fs.readdirSync(path.join(process.env.APPDATA ?? '', 'npm', 'node_modules')).includes('omniroute');
    if (root) envFiles.push(path.join(process.env.APPDATA, 'npm', 'node_modules', 'omniroute', '.env'));
  } catch {
    /* not windows / not installed */
  }
  for (const f of envFiles) {
    try {
      for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^(INITIAL_PASSWORD|JWT_SECRET|API_KEY_SECRET|STORAGE_ENCRYPTION_KEY)=(.+)$/);
        if (m && m[2] !== 'CHANGEME') add(m[2].trim());
      }
    } catch {
      /* absent */
    }
  }
  return found;
}

export function scanDir(dir = ROOT, { live = false } = {}) {
  const findings = [];
  const literals = live ? liveSecrets() : [];
  const user = os.userInfo().username;
  for (const file of walk(dir)) {
    const rel = path.relative(dir, file);
    if (rel === SELF) continue;
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const [name, re] of PATTERNS) {
        const m = line.match(re);
        if (!m) continue;
        if (name === 'email address' && EMAIL_ALLOW.has(m[0])) continue;
        findings.push({ file: rel, line: i + 1, kind: name, sample: m[0].slice(0, 6) + '...' });
      }
      if (user && line.toLowerCase().includes(`users\\${user}`.toLowerCase())) findings.push({ file: rel, line: i + 1, kind: 'author home path', sample: '' });
      if (user && user.length > 3 && line.toLowerCase().includes(`/users/${user}`.toLowerCase())) findings.push({ file: rel, line: i + 1, kind: 'author home path', sample: '' });
    });
    for (const lit of literals) if (text.includes(lit)) findings.push({ file: rel, line: 0, kind: 'LIVE SECRET VALUE FOUND', sample: '(value hidden)' });
  }
  return { findings, liveChecked: literals.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const live = process.argv.includes('--live');
  const { findings, liveChecked } = scanDir(ROOT, { live });
  if (live) console.log(`Checked for ${liveChecked} live secret value(s) from this machine (values not shown).`);
  if (findings.length) {
    for (const f of findings) console.log(`${f.file}:${f.line}  ${f.kind}  ${f.sample}`);
    console.log(`\n${findings.length} potential secret(s) found. Do NOT share the kit until resolved.`);
    process.exit(1);
  }
  console.log('Clean: no credentials or personal identifiers found.');
}
