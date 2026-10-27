// Limit pro Gerät (und pro IP) für echte Suchen mit dem Server-Schlüssel.
// Im KV landen nur gekürzte SHA-256-Hashes, nie Roh-Geräte-IDs oder IPs.
export const TTL_S = 40 * 24 * 3600;
const ID_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,64})$/i;

// -> { id } | { invalid: true } | { id: null }
export function pickDeviceId(request) {
  const raw = request.headers.get("X-Device-Id");
  if (raw === null || raw.trim() === "") return { id: null };
  const v = raw.trim();
  return ID_RE.test(v) ? { id: v.toLowerCase() } : { invalid: true };
}

function envInt(v, def) {
  if (v === undefined || v === null || String(v).trim() === "") return def;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
}

export function deviceConfig(env) {
  return {
    enabled: Boolean(env?.USAGE && typeof env.USAGE.get === "function"),
    deviceLimit: envInt(env?.SERP_DEVICE_LIMIT, 10),
    deviceWarn: envInt(env?.SERP_DEVICE_WARN, 2),
    ipLimit: envInt(env?.SERP_IP_LIMIT, 30),
  };
}

export async function hashId(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export const monthOf = (d) => d.toISOString().slice(0, 7);
export function resetsOf(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

// Zählerschlüssel (gehasht) für Gerät und IP; null, wenn es keine ID/IP gibt oder das Limit aus ist.
export async function usageKeys(cfg, deviceId, ip, now) {
  const m = monthOf(now);
  const hasIp = ip && ip !== "unknown";
  return {
    dev: cfg.enabled && cfg.deviceLimit > 0 && deviceId ? `dev:${await hashId(deviceId)}:${m}` : null,
    ip: cfg.enabled && cfg.ipLimit > 0 && hasIp ? `ip:${await hashId(ip)}:${m}` : null,
  };
}

async function readCount(kv, key) {
  if (!key) return 0;
  try {
    const n = parseInt(await kv.get(key), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function deviceObject(cfg, used, now) {
  const left = Math.max(0, cfg.deviceLimit - used);
  return { limit: cfg.deviceLimit, used, left, warn: left > 0 && left <= cfg.deviceWarn, exhausted: left <= 0, resets: resetsOf(now) };
}

// -> { keys, devUsed, ipUsed, device (Objekt|null), deviceBlocked, ipBlocked }
export async function readUsage(env, deviceId, ip, now) {
  const cfg = deviceConfig(env);
  const keys = await usageKeys(cfg, deviceId, ip, now);
  const devUsed = await readCount(env?.USAGE, keys.dev);
  const ipUsed = await readCount(env?.USAGE, keys.ip);
  return {
    cfg,
    keys,
    devUsed,
    ipUsed,
    device: keys.dev ? deviceObject(cfg, devUsed, now) : null,
    deviceBlocked: Boolean(keys.dev) && devUsed >= cfg.deviceLimit,
    ipBlocked: Boolean(keys.ip) && ipUsed >= cfg.ipLimit,
  };
}

// Best effort; KV ist eventuell konsistent, Rennen werden toleriert.
export async function bumpUsage(env, usage) {
  const bump = async (key, cur) => {
    if (!key) return;
    try {
      await env.USAGE.put(key, String(cur + 1), { expirationTtl: TTL_S });
    } catch {
      /* ignorieren */
    }
  };
  await bump(usage.keys.dev, usage.devUsed);
  await bump(usage.keys.ip, usage.ipUsed);
}
