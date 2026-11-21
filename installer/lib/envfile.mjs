import crypto from 'node:crypto';
import fs from 'node:fs';
import { writeSecretFile } from './run.mjs';

export function genSecrets() {
  const r = (n) => crypto.randomBytes(n);
  return {
    JWT_SECRET: r(48).toString('base64'),
    API_KEY_SECRET: r(32).toString('hex'),
    STORAGE_ENCRYPTION_KEY: r(32).toString('hex'),
    STORAGE_ENCRYPTION_KEY_VERSION: 'v1',
    INITIAL_PASSWORD: r(12).toString('base64url'),
  };
}

export function parseEnv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

export function readEnvFile(file) {
  try {
    return parseEnv(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function writeEnvFile(file, obj) {
  const body = Object.entries(obj)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  writeSecretFile(file, `# Written by claude-omniroute-kit. Contains secrets, do not share or commit.\n# BACK UP THIS FILE: losing STORAGE_ENCRYPTION_KEY makes stored provider credentials unreadable.\n${body}\n`);
}
