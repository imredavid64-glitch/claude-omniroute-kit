import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const KIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TESTED_OMNIROUTE = '3.8.53';

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
      out[a.slice(2)] = argv[++i];
    } else {
      out[a.slice(2)] = true;
    }
  }
  return out;
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

export function loadConfig(kitDir = KIT_DIR) {
  const d = (n) => path.join(kitDir, 'config', n);
  return {
    providers: readJson(d('providers.json')),
    combos: readJson(d('combos.json')),
    compression: readJson(d('compression.json')),
    claudeSettings: readJson(d('claude-settings.json')),
    plugins: readJson(d('plugins.json')),
    rtkMd: fs.readFileSync(d('RTK.md'), 'utf8'),
  };
}

export function makeCtx(argv) {
  const args = parseArgs(argv);
  const home = os.homedir();
  const defaultDir = path.join(home, '.omniroute');
  const dataDir = path.resolve(args['data-dir'] ?? process.env.OMNIROUTE_DATA_DIR ?? defaultDir);
  const port = Number(args.port ?? 20128);
  const host = args.lan ? '0.0.0.0' : '127.0.0.1';
  return {
    args,
    home,
    dataDir,
    dataDirIsDefault: dataDir === defaultDir,
    port,
    host,
    base: `http://127.0.0.1:${port}`,
    claudeDir: path.join(home, '.claude'),
    kitDir: KIT_DIR,
    cfg: loadConfig(),
    omniroute: null,
    gw: null,
    key: null,
    state: {},
  };
}
