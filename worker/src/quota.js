// Kontingent-Abfrage über die SerpApi Account API (zählt nicht zum Kontingent).
// Schlüssel werden hier nie geloggt, zurückgegeben oder in Cache-Schlüssel aufgenommen.
export const ACCOUNT_URL = "https://serpapi.com/account.json";
export const ACCOUNT_TIMEOUT_MS = 8_000;
export const QUOTA_TTL_S = 300;
export const QUOTA_CACHE_URL = "https://scandeals-cache.invalid/quota:server";
const KEY_RE = /^[A-Za-z0-9]{20,100}$/;

export class QuotaError extends Error {
  constructor(kind) {
    super(kind);
    this.kind = kind; // "auth" | "http" | "timeout"
  }
}

// -> { key, source } | { invalid: true } | { key: null, source: null }
export function pickKey(request, env) {
  const raw = request.headers.get("X-SerpApi-Key");
  if (raw !== null && raw.trim() !== "") {
    const k = raw.trim();
    return KEY_RE.test(k) ? { key: k, source: "user" } : { invalid: true };
  }
  if (env?.SERPAPI_KEY) return { key: env.SERPAPI_KEY, source: "server" };
  return { key: null, source: null };
}

function envNum(v, def, min = 0) {
  if (v === undefined || v === null || String(v).trim() === "") return def;
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : def;
}

const int = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : null);

// Nur bekannte Felder übernehmen (nie api_key o. ä. durchreichen).
export function pickAccount(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const perMonth = int(body.searches_per_month);
  const left = int(body.total_searches_left) ?? int(body.plan_searches_left);
  if (left === null) return null;
  const used = int(body.this_month_usage);
  const renewal = typeof body.plan_renewal_date === "string" && /^\d{4}-\d{2}-\d{2}/.test(body.plan_renewal_date.trim())
    ? body.plan_renewal_date.trim().slice(0, 10)
    : null;
  return {
    plan_name: typeof body.plan_name === "string" ? body.plan_name.slice(0, 60) : null,
    per_month: perMonth,
    left,
    used: used !== null ? used : perMonth !== null ? Math.max(0, perMonth - left) : null,
    hourly_limit: int(body.account_rate_limit_per_hour),
    hourly_used: int(body.last_hour_searches),
    renews: renewal,
  };
}

// raw (pickAccount) -> Antwortobjekt
export function computeQuota(raw, env, keySource) {
  const reserve = envNum(env?.SERP_RESERVE, 0);
  const pct = envNum(env?.SERP_WARN_PERCENT, 20);
  const min = envNum(env?.SERP_WARN_MIN, 25);
  const left = Math.max(0, raw.left - reserve);
  const threshold = Math.max(min, Math.ceil(((raw.per_month ?? 0) * pct) / 100));
  return {
    key_source: keySource,
    plan_name: raw.plan_name,
    per_month: raw.per_month,
    left,
    used: raw.used,
    hourly_limit: raw.hourly_limit,
    hourly_used: raw.hourly_used,
    renews: raw.renews,
    warn: left > 0 && left <= threshold,
    exhausted: left <= 0,
  };
}

export async function fetchAccount(fetchFn, key) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ACCOUNT_TIMEOUT_MS);
  try {
    let res;
    let body = null;
    try {
      res = await fetchFn(`${ACCOUNT_URL}?${new URLSearchParams({ api_key: key })}`, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: ctrl.signal,
      });
      body = JSON.parse(await res.text());
    } catch {
      if (ctrl.signal.aborted) throw new QuotaError("timeout");
      if (!res) throw new QuotaError("http");
      body = null;
    }
    const err = body && typeof body.error === "string" ? body.error : "";
    if (res.status === 401 || res.status === 403 || /invalid api key/i.test(err)) throw new QuotaError("auth");
    const raw = res.ok && !err ? pickAccount(body) : null;
    if (!raw) throw new QuotaError("http");
    return raw;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Cache (nur Server-Schlüssel) ----------

export async function readServerQuota(cache) {
  try {
    const hit = cache && (await cache.match(new Request(QUOTA_CACHE_URL)));
    if (!hit) return null;
    const j = await hit.json();
    return j && j.raw && typeof j.at === "number" ? j : null;
  } catch {
    return null;
  }
}

export async function writeServerQuota(cache, raw, at = Date.now()) {
  if (!cache) return;
  try {
    const ttl = Math.max(1, QUOTA_TTL_S - Math.floor((Date.now() - at) / 1000));
    await cache.put(
      new Request(QUOTA_CACHE_URL),
      new Response(JSON.stringify({ raw, at }), {
        headers: { "Content-Type": "application/json", "Cache-Control": `public, s-maxage=${ttl}` },
      }),
    );
  } catch {
    /* Cache ist optional */
  }
}

export function decrement(raw) {
  return { ...raw, left: Math.max(0, raw.left - 1), used: raw.used === null ? null : raw.used + 1 };
}
