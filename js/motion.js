// ScanDeals – Motion-Helfer: Spring-Kurven, Count-up, Liquid-Fade, Haptik
export const reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
export const isReduced = () => reducedQuery.matches;

const supportsLinear = (() => {
  try { return CSS.supports('animation-timing-function', 'linear(0, 1)'); } catch { return false; }
})();

/** Gedämpfte Feder → CSS linear()-Easing + passende Dauer (ms). */
export function makeSpring({ stiffness = 210, damping = 20, mass = 1, steps = 36 } = {}) {
  const w = Math.sqrt(stiffness / mass);
  const z = damping / (2 * Math.sqrt(stiffness * mass));
  const wd = w * Math.sqrt(Math.max(1e-6, 1 - z * z));
  const x = (t) => 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + (z * w / wd) * Math.sin(wd * t));
  let T = 0;
  for (let t = 0; t < 3; t += 0.005) if (Math.abs(x(t) - 1) > 0.002) T = t;
  T += 0.01;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const v = i === steps ? 1 : +x((T * i) / steps).toFixed(3);
    pts.push(i && i < steps ? `${v} ${((100 * i) / steps).toFixed(1)}%` : String(v));
  }
  return {
    easing: supportsLinear ? `linear(${pts.join(', ')})` : 'cubic-bezier(.2,.9,.25,1.1)',
    duration: supportsLinear ? Math.round(T * 1000) : 520,
  };
}
export const SPRING = makeSpring();
export const EASE_OUT = 'cubic-bezier(.2,.8,.2,1)';

export function haptic(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch { /* ignorieren */ }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Count-up ----------
const fmtCache = new Map();
function formatter(currency) {
  if (!fmtCache.has(currency)) {
    let f;
    try { f = new Intl.NumberFormat('de-DE', { style: 'currency', currency }); }
    catch { f = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }); }
    fmtCache.set(currency, f);
  }
  return fmtCache.get(currency);
}
const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

/** Zählt den Text von 0 auf `to` hoch (requestAnimationFrame, easeOutExpo). */
export function countUp(el, to, { currency = 'EUR', duration = 700, delay = 0 } = {}) {
  const f = formatter(currency);
  const final = f.format(to);
  if (isReduced() || !isFinite(to)) { el.textContent = final; return; }
  el.textContent = f.format(0);
  let start = 0;
  const step = (now) => {
    if (!el.isConnected) return;
    if (!start) start = now;
    const t = Math.min(1, (now - start) / duration);
    el.textContent = t >= 1 ? final : f.format(to * easeOutExpo(t));
    if (t < 1) requestAnimationFrame(step);
  };
  setTimeout(() => requestAnimationFrame(step), delay);
}

// ---------- Liquid Fade ----------
const OUT = { opacity: 0, filter: 'blur(8px)', transform: 'translate3d(0,-6px,0)' };
const IN0 = { opacity: 0, filter: 'blur(8px)', transform: 'translate3d(0,10px,0)' };
const REST = { opacity: 1, filter: 'blur(0px)', transform: 'translate3d(0,0,0)' };

/** Alter Inhalt blendet mit Blur aus, neuer Inhalt kommt herein. */
export async function liquidSwap(el, html, onInsert, { outMs = 150, inMs = 340 } = {}) {
  const id = (el._swapId = (el._swapId || 0) + 1);
  const insert = () => { if (typeof html === 'function') html(); else el.innerHTML = html; if (onInsert) onInsert(el); };
  if (isReduced() || !el.isConnected) { insert(); return; }
  const out = el.animate([REST, OUT], { duration: outMs, easing: 'ease-in', fill: 'forwards' });
  try { await out.finished; } catch { return; }
  if (el._swapId !== id) { out.cancel(); return; }
  insert();
  const inn = el.animate([IN0, REST], { duration: inMs, easing: EASE_OUT });
  out.cancel();
  try { await inn.finished; } catch { /* abgebrochen */ }
}
