/** Pure helpers for turning the combo template into the member list for this machine. */

/** Distinct models across all combos, in first-seen order (each is probed once). */
export function uniqueModels(combos) {
  const seen = new Set();
  const out = [];
  for (const c of combos) {
    for (const m of c.members) {
      if (!seen.has(m.model)) {
        seen.add(m.model);
        out.push(m);
      }
    }
  }
  return out;
}

/**
 * Keep members whose provider is connected, plus keyless members.
 * If we could not read the connection list at all (`connected` is null) keep everything
 * and let the probe decide.
 */
export function candidates(members, connected) {
  if (!connected) return members;
  return members.filter((m) => m.keyless || connected.has(m.provider));
}

/** Template order is priority; keep only members that passed their probe. */
export function finalMembers(members, probeResults) {
  return members.filter((m) => probeResults.get(m.model)?.ok);
}

export const spec = (members) => members.map((m) => m.model).join(',');

/** Pull provider ids out of whatever shape `omniroute providers list --json` returns. */
export function connectedProviders(json) {
  if (!json) return null;
  const arr = Array.isArray(json) ? json : (json.connections ?? json.providers ?? json.data ?? json.items ?? null);
  if (!Array.isArray(arr)) return null;
  const set = new Set();
  for (const c of arr) {
    if (c?.isActive === false || c?.active === false) continue;
    const id = c?.provider ?? c?.providerId ?? c?.providerType;
    if (id) set.add(String(id));
  }
  return set;
}
