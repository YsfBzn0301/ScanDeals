// ScanDeals – Bottom Sheet (Spring, Pointer-Drag + rAF, Snap-Punkte halb/voll)
import { SPRING, EASE_OUT, haptic, isReduced, liquidSwap } from './motion.js';

const HALF_VISIBLE = 0.6; // Anteil der Viewport-Höhe im halben Zustand

let sheet, scrim, body, head, content, backBtn, closeBtn;
let state = 'closed'; // closed | opening | half | full | closing
let H = 0;            // Höhe des Sheets in px
let anim = null;
let scrimAnim = null;
let opts = { onUserClose() {}, onBack() {} };
let lastFocus = null;
let drag = null;
let pendingY = null;
let raf = 0;

const pts = () => ({ full: 0, half: Math.max(0, H - window.innerHeight * HALF_VISIBLE), closed: H + 12 });
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function setAppInert(on) { const a = document.getElementById('app'); if (a) a.inert = on; }
function measure() { H = sheet.offsetHeight; }

function currentY() {
  const m = new DOMMatrixReadOnly(getComputedStyle(sheet).transform);
  return m.m42;
}
function setY(y) {
  sheet.style.transform = `translate3d(0,${y}px,0)`;
  const p = pts();
  const prog = clamp((p.closed - y) / Math.max(1, p.closed - p.half), 0, 1);
  scrim.style.opacity = String(prog);
}
function stopAnim() {
  if (!anim) return;
  const y = currentY();
  anim.cancel();
  anim = null;
  sheet.style.transform = `translate3d(0,${y}px,0)`;
  if (scrimAnim) { scrimAnim.cancel(); scrimAnim = null; }
  setY(y);
}

function animateTo(target, name) {
  const from = currentY();
  if (anim) { anim.cancel(); anim = null; }
  const prog = (y) => { const p = pts(); return clamp((p.closed - y) / Math.max(1, p.closed - p.half), 0, 1); };
  const p0 = prog(from), p1 = prog(target);
  if (scrimAnim) scrimAnim.cancel();
  if (isReduced()) {
    setY(target);
    finish(target, name);
    return Promise.resolve();
  }
  anim = sheet.animate(
    [{ transform: `translate3d(0,${from}px,0)` }, { transform: `translate3d(0,${target}px,0)` }],
    { duration: SPRING.duration, easing: SPRING.easing, fill: 'forwards' },
  );
  scrimAnim = scrim.animate([{ opacity: p0 }, { opacity: p1 }], { duration: 320, easing: EASE_OUT, fill: 'forwards' });
  const a = anim, s = scrimAnim;
  return a.finished.then(() => {
    if (anim !== a) return;
    setY(target);
    a.cancel(); s.cancel();
    anim = null; scrimAnim = null;
    finish(target, name);
  }, () => {});
}

function finish(target, name) {
  if (name === 'closed') {
    state = 'closed';
    sheet.hidden = true;
    scrim.hidden = true;
    sheet.classList.remove('is-full');
  } else {
    state = name;
    sheet.classList.toggle('is-full', name === 'full');
  }
}

function snapName(y) {
  const p = pts();
  return y <= (p.full + p.half) / 2 ? 'full' : 'half';
}

// ---------- Drag ----------
function onDown(e) {
  if (state === 'closed' || state === 'closing') return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const handle = e.target.closest('.sheet-bar, .sheet-head');
  const inBody = e.target.closest('.sheet-body') && state !== 'full';
  if (!handle && !inBody) return;
  stopAnim();
  drag = { id: e.pointerId, y0: e.clientY, pos0: currentY(), moved: false, samples: [[performance.now(), e.clientY]] };
}
function onMove(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const dy = e.clientY - drag.y0;
  if (!drag.moved) {
    if (Math.abs(dy) < 6) return;
    drag.moved = true;
    try { sheet.setPointerCapture(e.pointerId); } catch { /* ignorieren */ }
    sheet.classList.add('dragging');
  }
  const now = performance.now();
  drag.samples.push([now, e.clientY]);
  while (drag.samples.length > 2 && now - drag.samples[0][0] > 100) drag.samples.shift();
  let y = drag.pos0 + dy;
  if (y < 0) y = y / 4; // Gummiband oben
  pendingY = y;
  if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (pendingY != null) setY(pendingY); });
}
function onUp(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag;
  drag = null;
  sheet.classList.remove('dragging');
  if (!d.moved) return;
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
  const y = pendingY != null ? pendingY : currentY();
  pendingY = null;
  setY(y);
  // unterdrückt den Klick nach einem Drag
  const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
  sheet.addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => sheet.removeEventListener('click', swallow, true), 60);
  const s = d.samples;
  const v = s.length > 1 ? (s[s.length - 1][1] - s[0][1]) / Math.max(1, s[s.length - 1][0] - s[0][0]) : 0; // px/ms
  const proj = y + v * 220;
  const p = pts();
  const cand = [['full', p.full], ['half', p.half], ['closed', p.closed]];
  cand.sort((a, b) => Math.abs(a[1] - proj) - Math.abs(b[1] - proj));
  const [name, target] = cand[0];
  if (name === 'closed') { userClose(); return; }
  const changed = name !== state;
  state = name;
  sheet.classList.toggle('is-full', name === 'full');
  if (changed) haptic(6);
  animateTo(target, name);
}

function userClose() {
  closeSheet().then(() => {});
  opts.onUserClose();
}

// ---------- API ----------
export function initSheet(o) {
  opts = { ...opts, ...o };
  sheet = document.getElementById('sheet');
  scrim = document.getElementById('scrim');
  body = document.getElementById('sheet-body');
  head = document.getElementById('sheet-head');
  content = document.getElementById('sheet-content');
  backBtn = document.getElementById('sheet-back');
  closeBtn = document.getElementById('sheet-close');
  sheet.addEventListener('pointerdown', onDown);
  sheet.addEventListener('pointermove', onMove);
  sheet.addEventListener('pointerup', onUp);
  sheet.addEventListener('pointercancel', onUp);
  scrim.addEventListener('click', userClose);
  closeBtn.addEventListener('click', userClose);
  backBtn.addEventListener('click', () => opts.onBack());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) userClose(); });
  window.addEventListener('resize', () => {
    if (state === 'closed') return;
    measure();
    const p = pts();
    if (!anim) setY(state === 'full' ? p.full : p.half);
  });
}

export const isOpen = () => state !== 'closed' && state !== 'closing';
export const getSnap = () => (state === 'full' ? 'full' : 'half');
export const getBody = () => body;

export function openSheet(snap = 'half') {
  if (isOpen()) { snapTo(snap); return Promise.resolve(); }
  lastFocus = document.activeElement;
  setAppInert(true);
  sheet.hidden = false;
  scrim.hidden = false;
  measure();
  const p = pts();
  setY(p.closed);
  scrim.style.opacity = '0';
  state = snap;
  sheet.classList.toggle('is-full', snap === 'full');
  // Layout erzwingen, dann animieren
  void sheet.offsetHeight;
  const done = animateTo(snap === 'full' ? p.full : p.half, snap);
  sheet.focus({ preventScroll: true });
  return done;
}

export function snapTo(snap) {
  if (!isOpen() || snap === state) return;
  const p = pts();
  state = snap;
  sheet.classList.toggle('is-full', snap === 'full');
  haptic(6);
  animateTo(snap === 'full' ? p.full : p.half, snap);
}

export function closeSheet() {
  if (!isOpen()) return Promise.resolve();
  state = 'closing';
  setAppInert(false);
  const r = animateTo(pts().closed, 'closed');
  try { if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true }); } catch { /* ignorieren */ }
  return r;
}

/** Setzt Kopf + Inhalt; mit Liquid-Fade, wenn animate=true. */
export function setContent(headHtml, bodyHtml, { animate = true, back = false, onInsert } = {}) {
  const insert = () => {
    head.innerHTML = headHtml;
    body.innerHTML = bodyHtml;
    body.scrollTop = 0;
    backBtn.hidden = !back;
    if (onInsert) onInsert(head, body);
  };
  if (!animate) { insert(); return Promise.resolve(); }
  return liquidSwap(content, insert);
}
