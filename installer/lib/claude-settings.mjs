/**
 * Pure merge of the kit's Claude Code settings into an existing settings.json.
 * No I/O here so it can be unit tested. Guarantees:
 *  - never removes or rewrites keys it does not own (permissions, theme, plugins, ...)
 *  - idempotent: running twice yields the same result and no duplicate hooks
 *  - the RTK hook is only added when `opts.rtk` is true
 */
export function fill(str, vars) {
  return String(str).replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? String(vars[k]) : `{{${k}}}`));
}

const normUrl = (u) => String(u ?? '').replace(/\/+$/, '').replace('localhost', '127.0.0.1');
const sameUrl = (a, b) => normUrl(a) === normUrl(b);

export function mergeSettings(existing, tpl, opts) {
  const out = structuredClone(existing ?? {});
  const changes = [];
  const warnings = [];

  const vars = {
    BASE_URL: opts.baseUrl,
    GATEWAY_KEY: opts.gatewayKey,
    MAIN_COMBO: opts.mainCombo,
    FAST_COMBO: opts.fastCombo,
    CONTEXT_TOKENS: opts.contextTokens,
  };

  out.env = { ...(out.env ?? {}) };
  for (const [k, v] of Object.entries(tpl.env)) {
    const val = fill(v, vars);
    const same = k === 'ANTHROPIC_BASE_URL' && out.env[k] !== undefined && sameUrl(out.env[k], val);
    if (out.env[k] !== val && !same) {
      if (out.env[k] !== undefined && k === 'ANTHROPIC_BASE_URL') {
        warnings.push(`env.ANTHROPIC_BASE_URL was ${out.env[k]}, now ${val} (original kept in the backup file)`);
      }
      out.env[k] = val;
      changes.push(`env.${k}`);
    }
  }

  if (out.env.ANTHROPIC_API_KEY) {
    warnings.push('env.ANTHROPIC_API_KEY is set and can conflict with ANTHROPIC_AUTH_TOKEN; remove it if requests fail.');
  }
  if (typeof out.model === 'string' && out.model && out.model !== opts.mainCombo) {
    warnings.push(`top-level "model" is "${out.model}". ANTHROPIC_MODEL normally wins, but if /model shows it, delete that key.`);
  }

  if (opts.rtk) {
    out.hooks = { ...(out.hooks ?? {}) };
    const pre = Array.isArray(out.hooks.PreToolUse) ? [...out.hooks.PreToolUse] : [];
    const has = pre.some((e) => (e?.hooks ?? []).some((h) => typeof h?.command === 'string' && h.command.includes('rtk hook')));
    if (!has) {
      pre.push(structuredClone(tpl.rtkHook));
      changes.push('hooks.PreToolUse[rtk]');
    }
    out.hooks.PreToolUse = pre;
  }

  if (opts.bypassPermissions) {
    out.permissions = { ...(out.permissions ?? {}) };
    if (out.permissions.defaultMode !== 'bypassPermissions') {
      out.permissions.defaultMode = 'bypassPermissions';
      changes.push('permissions.defaultMode=bypassPermissions');
    }
    if (out.skipDangerousModePermissionPrompt !== true) {
      out.skipDangerousModePermissionPrompt = true;
      changes.push('skipDangerousModePermissionPrompt');
    }
  }

  return { merged: out, changes, warnings };
}

/** Return the gateway token from an existing settings object if it targets `baseUrl`. */
export function existingGatewayToken(settings, baseUrl) {
  const env = settings?.env ?? {};
  if (env.ANTHROPIC_AUTH_TOKEN && sameUrl(env.ANTHROPIC_BASE_URL, baseUrl)) return env.ANTHROPIC_AUTH_TOKEN;
  return null;
}
