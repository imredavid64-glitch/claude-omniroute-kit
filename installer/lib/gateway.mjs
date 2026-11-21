/** Minimal HTTP client for a local OmniRoute gateway. No dependencies (Node 22+ fetch). */

export function extractKey(j) {
  if (!j || typeof j !== 'object') return null;
  const cands = [j.key, j.apiKey, j.api_key, j.value, j.token, j.data?.key, j.data?.apiKey, j.data?.value, j.result?.key];
  return cands.find((v) => typeof v === 'string' && v.length >= 16) ?? null;
}

const TOOL = {
  name: 'get_time',
  description: 'Get the current time in a timezone.',
  input_schema: { type: 'object', properties: { timezone: { type: 'string' } }, required: ['timezone'] },
};

export class Gateway {
  constructor(base) {
    this.base = base.replace(/\/+$/, '');
    this.cookie = '';
    this.key = '';
  }

  async req(path, { method = 'GET', body, auth = 'key', timeout = 30000, headers = {} } = {}) {
    const h = { ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    if (auth === 'cookie' && this.cookie) h.cookie = this.cookie;
    if (auth === 'key' && this.key) h.authorization = `Bearer ${this.key}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(this.base + path, {
        method,
        headers: h,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* not json */
      }
      return { status: res.status, ok: res.ok, json, text, headers: res.headers };
    } catch (e) {
      return { status: 0, ok: false, json: null, text: String(e?.message ?? e), headers: new Headers() };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Something is accepting HTTP on the port (any status). */
  async listening() {
    return (await this.req('/api/monitoring/health', { auth: 'none', timeout: 3000 })).status > 0;
  }

  async healthy() {
    const r = await this.req('/api/monitoring/health', { auth: 'none', timeout: 3000 });
    return r.status > 0 && r.status < 500;
  }

  async waitHealthy(ms = 180000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await this.healthy()) return true;
      await new Promise((r) => setTimeout(r, 1500));
    }
    return false;
  }

  async login(password) {
    const r = await this.req('/api/auth/login', { method: 'POST', body: { password }, auth: 'none' });
    if (!r.ok) return false;
    const raw = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('set-cookie') ?? ''];
    this.cookie = raw
      .filter(Boolean)
      .map((c) => c.split(';')[0])
      .join('; ');
    return Boolean(this.cookie);
  }

  async createKey(name) {
    const r = await this.req('/api/keys', { method: 'POST', body: { name }, auth: 'cookie' });
    return { key: extractKey(r.json), status: r.status, text: r.text };
  }

  async keyWorks(key) {
    const prev = this.key;
    this.key = key;
    const r = await this.req('/v1/models', { timeout: 15000 });
    this.key = prev;
    return r.ok;
  }

  async getCompression() {
    const r = await this.req('/api/settings/compression', { auth: 'cookie' });
    return r.ok ? r.json : null;
  }

  async putCompression(obj) {
    return this.req('/api/settings/compression', { method: 'PUT', body: obj, auth: 'cookie' });
  }

  /**
   * Does `model` (a provider/model id or a combo name) return a real tool_use block?
   * Claude Code needs tool calls, so a model that only answers in text is useless as a fallback.
   */
  async probeTool(model, { timeout = 60000 } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const t0 = Date.now();
      const r = await this.req('/v1/messages', {
        method: 'POST',
        timeout,
        headers: { 'anthropic-version': '2023-06-01', 'x-api-key': this.key },
        body: {
          model,
          max_tokens: 300,
          messages: [{ role: 'user', content: 'Call the get_time tool with timezone "UTC". Do not answer in text.' }],
          tools: [TOOL],
        },
      });
      const ms = Date.now() - t0;
      if (!r.ok) {
        if (attempt === 0 && [401, 429, 502, 503].includes(r.status)) {
          await new Promise((res) => setTimeout(res, 2500));
          continue;
        }
        return { ok: false, kind: `http-${r.status}`, ms, detail: (r.text || '').slice(0, 140) };
      }
      const blocks = r.json?.content;
      if (!Array.isArray(blocks)) return { ok: false, kind: 'bad-shape', ms, detail: (r.text || '').slice(0, 140) };
      if (blocks.some((b) => b?.type === 'tool_use')) return { ok: true, kind: 'tool_use', ms };
      const txt = blocks.find((b) => b?.type === 'text')?.text ?? '';
      return { ok: false, kind: txt ? 'text-only' : 'empty', ms, detail: txt.slice(0, 100) };
    }
    return { ok: false, kind: 'unreachable', ms: 0 };
  }
}
