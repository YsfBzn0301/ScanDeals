// ScanDeals – Konfiguration (KI-Server, Scan-Modus)
export const DEFAULT_AI_ENDPOINT = '';
const EP_KEY = 'scandeals.aiEndpoint';
const MODE_KEY = 'scandeals.mode';
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
