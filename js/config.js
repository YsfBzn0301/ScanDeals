// ScanDeals – Konfiguration (KI-Server, Scan-Modus)
export const DEFAULT_AI_ENDPOINT = '';
const EP_KEY = 'scandeals.aiEndpoint';
const MODE_KEY = 'scandeals.mode';
const SERP_KEY = 'scandeals.serpKey';
export const MODES = ['auto', 'barcode', 'objekt'];

export function normalizeEndpoint(v) {
  return String(v || '').trim().replace(/\/+$/, '');
}
export function isValidEndpoint(v) {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || (u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname));
  } catch { return false; }
}
/** Aktuelle KI-Server-URL (ohne Slash am Ende); leer = Gratis-Modus. */
export function getAiEndpoint() {
  let v = '';
  try { v = localStorage.getItem(EP_KEY) || ''; } catch { /* ignorieren */ }
  return normalizeEndpoint(v || DEFAULT_AI_ENDPOINT);
}
/** Alias: dieselbe URL gilt für KI-Erkennung und Tagespreise (ScanDeals-Server). */
export const getServerEndpoint = getAiEndpoint;
export function setAiEndpoint(v) {
  try {
    const n = normalizeEndpoint(v);
    if (n) localStorage.setItem(EP_KEY, n); else localStorage.removeItem(EP_KEY);
  } catch { /* ignorieren */ }
}
export function getMode() {
  try { const m = localStorage.getItem(MODE_KEY); if (MODES.includes(m)) return m; } catch { /* ignorieren */ }
  return 'auto';
}
export function setMode(m) {
  try { localStorage.setItem(MODE_KEY, m); } catch { /* ignorieren */ }
}

/** Eigener SerpApi-Schlüssel (optional, nur auf diesem Gerät); '' = keiner. */
export const SERP_KEY_RE = /^[A-Za-z0-9]{20,100}$/;
export function getSerpKey() {
  try { const v = (localStorage.getItem(SERP_KEY) || '').trim(); return SERP_KEY_RE.test(v) ? v : ''; } catch { return ''; }
}
export function setSerpKey(v) {
  try {
    const n = String(v || '').trim();
    if (n) localStorage.setItem(SERP_KEY, n); else localStorage.removeItem(SERP_KEY);
  } catch { /* ignorieren */ }
}

/** Anonyme Geräte-ID (für das Limit pro Gerät am Server). Einmal erzeugt, in localStorage; ohne Storage pro Sitzung im Speicher. */
const DEV_KEY = 'scandeals.deviceId';
const DEV_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,64})$/i;
let memDeviceId = '';
function makeDeviceId() {
  try { if (crypto.randomUUID) return crypto.randomUUID(); } catch { /* weiter */ }
  const a = new Uint8Array(16);
  try { crypto.getRandomValues(a); } catch { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256); }
  return [...a].map((x) => x.toString(16).padStart(2, '0')).join('');
}
export function getDeviceId() {
  try { const v = localStorage.getItem(DEV_KEY); if (v && DEV_RE.test(v)) return v; } catch { /* ignorieren */ }
  if (memDeviceId) return memDeviceId;
  const id = makeDeviceId();
  memDeviceId = id;
  try { localStorage.setItem(DEV_KEY, id); } catch { /* nur im Speicher */ }
  return id;
}
