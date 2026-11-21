#!/usr/bin/env node
/**
 * Maintainer tool: compare (or update) config/combos.json against the combos on a running
 * OmniRoute. Only ordered model ids are read; connection ids, account labels and keys are
 * never copied.
 *
 *   node tools/refresh-combos-from-live.mjs --check   # diff only (default)
 *   node tools/refresh-combos-from-live.mjs --write   # rewrite member order/membership
 *
 * Uses the gateway key from ~/.claude/settings.json. Members that are new get provider "unknown"
 * and must be classified by hand before sharing; the scanner will flag nothing here, so review.
 */
import fs from 'node:fs';
import path from 'node:path';
import { makeCtx, KIT_DIR } from '../installer/lib/ctx.mjs';
import { omni, resolveOmniroute } from '../installer/lib/omni.mjs';
import { parseJsonLoose } from '../installer/lib/run.mjs';

const ctx = makeCtx(process.argv.slice(2));
ctx.omniroute = resolveOmniroute();
const settings = JSON.parse(fs.readFileSync(path.join(ctx.claudeDir, 'settings.json'), 'utf8'));
ctx.key = settings.env?.ANTHROPIC_AUTH_TOKEN;
ctx.base = settings.env?.ANTHROPIC_BASE_URL ?? ctx.base;

const live = parseJsonLoose((await omni(ctx, ['--output', 'json', 'combo', 'list'])).stdout)?.combos ?? [];
const file = path.join(KIT_DIR, 'config', 'combos.json');
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
let drift = 0;

for (const c of cfg.combos) {
  const l = live.find((x) => x.name === c.name);
  if (!l) {
    console.log(`${c.name}: not present on the live gateway`);
    drift++;
    continue;
  }
  const liveModels = l.models.map((m) => m.model);
  const tplModels = c.members.map((m) => m.model);
  const same = liveModels.length === tplModels.length && liveModels.every((m, i) => m === tplModels[i]);
  console.log(`${c.name}: ${same ? 'matches' : 'DIFFERS'} (live ${liveModels.length}, kit ${tplModels.length})`);
  if (!same) {
    drift++;
    for (const m of liveModels.filter((m) => !tplModels.includes(m))) console.log(`   + only live: ${m}`);
    for (const m of tplModels.filter((m) => !liveModels.includes(m))) console.log(`   - only kit : ${m}`);
    if (process.argv.includes('--write')) {
      const byModel = new Map(c.members.map((m) => [m.model, m]));
      c.members = liveModels.map((m) => byModel.get(m) ?? { model: m, provider: 'unknown', note: 'NEW: classify provider before sharing' });
    }
  }
}
if (process.argv.includes('--write') && drift) {
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
  console.log('config/combos.json updated; re-run tools/scan-secrets.mjs');
}
process.exit(drift && !process.argv.includes('--write') ? 1 : 0);
