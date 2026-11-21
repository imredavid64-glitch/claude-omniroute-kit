import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isWin, run, which } from './run.mjs';
import { readEnvFile } from './envfile.mjs';

/** Locate the globally installed omniroute package (works without it being on PATH). */
export function resolveOmniroute() {
  const r = isWin ? spawnSync('npm root -g', { shell: true, encoding: 'utf8' }) : spawnSync('npm', ['root', '-g'], { encoding: 'utf8' });
  if (r.status === 0) {
    const root = r.stdout.trim().split(/\r?\n/).pop();
    const dir = path.join(root, 'omniroute');
    const pj = path.join(dir, 'package.json');
    if (fs.existsSync(pj)) {
      const pkg = JSON.parse(fs.readFileSync(pj, 'utf8'));
      const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.omniroute;
      if (bin) return { dir, version: pkg.version, entry: path.join(dir, bin) };
    }
  }
  if (which('omniroute')) return { dir: null, version: 'unknown', entry: null };
  return null;
}

/**
 * Run the omniroute CLI against ctx's gateway. The data-dir .env is injected so the CLI
 * sees the same secrets as the server (otherwise it warns that STORAGE_ENCRYPTION_KEY is unset).
 */
export function omni(ctx, args, opts = {}) {
  const env = {
    ...readEnvFile(path.join(ctx.dataDir, '.env')),
    OMNIROUTE_BASE_URL: ctx.base,
    OMNIROUTE_API_KEY: ctx.key ?? '',
    NO_COLOR: '1',
    ...(ctx.dataDirIsDefault ? {} : { DATA_DIR: ctx.dataDir, OMNIROUTE_DATA_DIR: ctx.dataDir }),
    ...opts.env,
  };
  const o = ctx.omniroute;
  if (o?.entry) return run(process.execPath, [o.entry, ...args], { ...opts, env });
  return run('omniroute', args, { ...opts, env });
}
