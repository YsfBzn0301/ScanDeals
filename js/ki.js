// ScanDeals – Live-KI-Sitzung: Objekterkennung (COCO-SSD), Tracking-Overlay, Vorschlags-Badge, Claude-Anfrage
import { loadDetector, detect, pickBest, onlyPersons, labelDe, Stabilizer, iou } from './vision.js';
import { Overlay } from './overlay.js';
import { identifyProduct } from './api.js';
import { getAiEndpoint } from './config.js';
import { haptic, isReduced, sleep } from './motion.js';

const BASE_INTERVAL = 350;
const SLOW_MS = 250;
const STABLE_MS = 1000;     // so lange stabil, bevor Claude gefragt wird
const LOST_MS = 1800;       // so lange darf das Objekt fehlen, bis das Badge verschwindet
const IGNORE_MS = 5000;     // verworfenes Objekt ignorieren

const $ = (s) => document.getElementById(s);
let o = {};                 // Optionen: video, shouldRun, setHint, onConfirm
let el = {};
let overlay = null;
let running = false;
let timer = 0;
let interval = BASE_INTERVAL;
let modelState = 'none';    // none | loading | ready | failed
let stab = new Stabilizer(3);
let misses = 0;
let objSeq = 0;
let obj = null;             // aktuelles Objekt {id, cls, score, bbox, stableSince, state, result, thumb, ctrl, requested, lostAt}
let ignored = new Map();    // Klasse → Zeitstempel bis wann ignoriert
let lastDet = null;
let pctAnim = 0;
let instant = false;
let lastPersonHint = -1e9;
const RING_C = 2 * Math.PI * 22;

const trunc = (s, n = 120) => String(s ?? '').trim().slice(0, n);

export function initKi(opts) {
  o = opts;
  el = {
    badge: $('ai-badge'), kicker: $('ab-kicker'), name: $('ab-name'), sub: $('ab-sub'), setup: $('ab-setup'),
    pct: $('ab-pct'), ring: $('ab-ring-fg'), go: $('ab-go'), x: $('ab-x'), re: $('ab-re'), goLabel: $('ab-go-label'),
    load: $('vf-load'), canvas: $('overlay'),
  };
  el.ring.style.strokeDasharray = RING_C.toFixed(1);
  el.ring.style.strokeDashoffset = RING_C.toFixed(1);
  el.go.addEventListener('click', confirm);
  el.x.addEventListener('click', dismiss);
  el.re.addEventListener('click', () => { if (obj) analyse(obj, true); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && running) schedule(0); });
}

// ---------- Lebenszyklus ----------
export function start() {
  if (running) return;
  running = true;
  if (!overlay) overlay = new Overlay(el.canvas, o.video);
  interval = BASE_INTERVAL;
  stab.reset(); misses = 0;
  if (modelState !== 'ready') {
    modelState = 'loading';
    el.load.dataset.show = '1';
    loadDetector().then(() => {
      modelState = 'ready';
      el.load.dataset.show = '0';
      if (running) schedule(0);
    }).catch(() => {
      modelState = 'failed';
      el.load.dataset.show = '0';
      o.setHint('Objekterkennung nicht verfügbar – Barcode-Scan läuft weiter.', 'warn', 4000);
    });
  } else schedule(0);
}

export function stop() {
  running = false;
  clearTimeout(timer); timer = 0;
  el.load.dataset.show = '0';
  if (obj && obj.ctrl) obj.ctrl.abort();
  obj = null; lastDet = null;
  stab.reset(); misses = 0;
  if (overlay) overlay.clear();
  hideBadge();
}

const schedule = (ms) => { clearTimeout(timer); if (running && modelState === 'ready') timer = setTimeout(tick, ms); };

// ---------- Erkennungs-Takt ----------
async function tick() {
  timer = 0;
  if (!running) return;
  if (document.hidden || !o.shouldRun()) { schedule(interval); return; }   // keine Inferenz bei unsichtbarem Tab / offenem Sheet
  const v = o.video;
  if (v.readyState < 2) { schedule(100); return; }
  const t0 = performance.now();
  let dets = [];
  try { dets = await detect(v); } catch { dets = []; }
  if (!running) return;
  const dur = performance.now() - t0;
  interval = dur > SLOW_MS ? Math.min(1200, interval * 1.4) : Math.max(BASE_INTERVAL, interval * 0.9);
  handle(dets);
  schedule(Math.max(40, interval - dur));
}

const isIgnored = (cls) => (ignored.get(cls) || 0) > performance.now();

function handle(dets) {
  const now = performance.now();
  const best = pickBest(dets, isIgnored);
  if (!best) {
    misses++;
    if (misses >= 2) { stab.reset(); }
    if (misses >= 2) { overlay.setTarget(null); lastDet = null; }
    if (obj && now - obj.lastSeen > LOST_MS) {
      if (obj.ctrl) obj.ctrl.abort();
      obj = null; hideBadge();
    }
    if (!obj && misses >= 2 && onlyPersons(dets) && now - lastPersonHint > 3500) {
      lastPersonHint = now;
      o.setHint('Halte ein Produkt vor die Kamera', 'warn', 3000);
    }
    return;
  }
  misses = 0;
  const stable = stab.push(best);
  const changed = obj && (obj.cls !== best.class || iou(obj.bbox, best.bbox) < 0.2);
  const label = `${labelDe(best.class)} · ${Math.round(best.score * 100)} %`;
  lastDet = best;

  if (!stable) {
    // noch unsicher: Box zeigen (ohne Badge), Tracking beginnt
    if (!obj || changed) overlay.setTarget({ bbox: best.bbox, label, objId: objSeq + 1 });
    else overlay.setTarget({ bbox: best.bbox, label, objId: obj.id });
    return;
  }

  if (!obj || changed) {
    if (obj && obj.ctrl) obj.ctrl.abort();
    obj = { id: ++objSeq, cls: best.class, score: best.score, bbox: best.bbox, stableSince: now, lastSeen: now, state: 'coco', result: null, thumb: '', ctrl: null, requested: false };
    overlay.setTarget({ bbox: best.bbox, label, objId: obj.id });
    overlay.pulse();
    haptic([10]);
    o.setHint('Objekt erkannt', 'obj', 1800);
    showBadgeFor(obj);
  } else {
    obj.bbox = best.bbox; obj.score = best.score; obj.lastSeen = now;
    overlay.setTarget({ bbox: best.bbox, label: obj.result && obj.state !== 'coco' ? labelFor(obj) : label, objId: obj.id });
    if (obj.state === 'coco') setPct(obj.score, false);
  }
  const ep = getAiEndpoint();
  if (ep && !obj.requested && now - obj.stableSince >= STABLE_MS) analyse(obj, false);
}

function labelFor(ob) {
  const r = ob.result;
  return r ? `${trunc(r.name, 40)} · ${Math.round(r.confidence * 100)} %` : '';
}

// ---------- Claude-Anfrage ----------
function capture(bbox, maxEdge, quality) {
  const v = o.video;
  const vw = v.videoWidth, vh = v.videoHeight;
  if (!vw || !vh) return null;
  const px = bbox[2] * 0.15, py = bbox[3] * 0.15;
  const sx = Math.max(0, bbox[0] - px), sy = Math.max(0, bbox[1] - py);
  const sw = Math.min(vw - sx, bbox[2] + 2 * px), sh = Math.min(vh - sy, bbox[3] + 2 * py);
  if (sw < 8 || sh < 8) return null;
  const sc = Math.min(1, maxEdge / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * sc)); c.height = Math.max(1, Math.round(sh * sc));
  c.getContext('2d').drawImage(v, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}

async function analyse(ob, manual) {
  const ep = getAiEndpoint();
  if (!ep || !ob) return;
  if (ob.ctrl) ob.ctrl.abort();
  const ctrl = new AbortController();
  ob.ctrl = ctrl; ob.requested = true; ob.state = 'analysing'; ob.note = '';
  renderBadge(ob);
  try {
    const full = capture(ob.bbox, 768, 0.8);
    if (!full) throw new Error('Kein Bild');
    ob.thumb = capture(ob.bbox, 160, 0.7) || '';
    const image = full.slice(full.indexOf(',') + 1);
    const r = await identifyProduct(ep, { image, hint: ob.cls }, { timeout: 20000, signal: ctrl.signal });
    if (obj !== ob || ctrl.signal.aborted) return;
    const res = sanitize(r);
    if (!res.is_product || !res.name) {
      ob.state = 'coco'; ob.note = 'Kein kaufbares Produkt erkannt – zeige Gratis-Ergebnis.';
    } else {
      ob.result = res;
      ob.state = res.confidence < 0.5 ? 'unsure' : 'claude';
      overlay.pulse(); haptic([10]);
    }
  } catch (e) {
    if (obj !== ob || (e && e.aborted)) return;
    ob.state = 'coco';
    ob.note = e && e.timeout ? 'KI-Server antwortet nicht – zeige Gratis-Ergebnis.' : 'KI-Erkennung fehlgeschlagen – zeige Gratis-Ergebnis.';
  }
  if (obj === ob) renderBadge(ob);
}

function sanitize(r) {
  const conf = Math.min(1, Math.max(0, Number(r && r.confidence) || 0));
  const bc = r && r.barcode != null ? String(r.barcode).replace(/\s/g, '') : '';
  return {
    is_product: !(r && r.is_product === false),
    name: trunc(r && r.name, 120),
    brand: trunc(r && r.brand, 60),
    model: trunc(r && r.model, 80),
    category: trunc(r && r.category, 60),
    search_query: trunc((r && r.search_query) || (r && r.name), 160),
    confidence: conf,
    barcode: /^\d{8,14}$/.test(bc) ? bc : null,
  };
}

// ---------- Badge ----------
function setText(node, text) {
  if (node.textContent === text) return;
  const id = (node._t = (node._t || 0) + 1);
  if (isReduced() || instant || el.badge.dataset.show !== '1') { node.textContent = text; return; }
  node.classList.add('swap');
  setTimeout(() => { if (node._t !== id) return; node.textContent = text; node.classList.remove('swap'); }, 110);
}

function setPct(v, animate = true) {
  const to = Math.round(Math.min(1, Math.max(0, v)) * 100);
  cancelAnimationFrame(pctAnim);
  const from = animate ? 0 : (parseInt(el.pct.dataset.v || '0', 10) || 0);
  const paint = (n) => {
    el.pct.textContent = `${Math.round(n)} %`;
    el.pct.dataset.v = String(Math.round(n));
    el.ring.style.strokeDashoffset = (RING_C * (1 - n / 100)).toFixed(1);
  };
  if (isReduced() || !animate) { paint(to); return; }
  const t0 = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - t0) / 700);
    paint(from + (to - from) * (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p)));
    if (p < 1) pctAnim = requestAnimationFrame(step);
  };
  pctAnim = requestAnimationFrame(step);
}

function showBadgeFor(ob) {
  const wasShown = el.badge.dataset.show === '1';
  el.badge.dataset.show = '1';
  el.badge.inert = false;
  el.badge.setAttribute('aria-hidden', 'false');
  instant = !wasShown;
  renderBadge(ob, true);
  instant = false;
}

function hideBadge() {
  el.badge.dataset.show = '0';
  el.badge.inert = true;
  el.badge.setAttribute('aria-hidden', 'true');
  el.badge.dataset.state = '';
}

function renderBadge(ob, countIn = false) {
  const free = !getAiEndpoint();
  const st = ob.state;
  el.badge.dataset.state = st;
  const coco = labelDe(ob.cls);
  if (st === 'analysing') {
    setText(el.kicker, 'KI analysiert');
    setText(el.name, 'Analysiere …');
    setText(el.sub, `Lokal erkannt: ${coco}`);
    setPct(ob.score, countIn);
    el.goLabel.textContent = 'Preise vergleichen';
  } else if (st === 'claude') {
    const r = ob.result;
    setText(el.kicker, 'Erkannt');
    setText(el.name, r.name);
    setText(el.sub, [r.brand, r.category].filter(Boolean).join(' · ') || 'KI-Erkennung');
    setPct(r.confidence, true);
    el.goLabel.textContent = 'Preise vergleichen';
  } else if (st === 'unsure') {
    const r = ob.result;
    setText(el.kicker, 'Unsicher');
    setText(el.name, r.name);
    setText(el.sub, [r.brand, r.category].filter(Boolean).join(' · ') || 'Bitte Treffer prüfen');
    setPct(r.confidence, true);
    el.goLabel.textContent = 'Trotzdem suchen';
  } else {
    setText(el.kicker, 'Erkannt');
    setText(el.name, coco);
    setText(el.sub, ob.note || (free ? 'Allgemeine Kategorie – für genaue Modelle' : 'Allgemeine Kategorie'));
    setPct(ob.score, countIn);
    el.goLabel.textContent = 'Preise vergleichen';
  }
  el.setup.hidden = !(free && st === 'coco');
  el.re.hidden = free || st === 'analysing';
}

// ---------- Aktionen ----------
function dismiss() {
  if (!obj) return;
  haptic(8);
  ignored.set(obj.cls, performance.now() + IGNORE_MS);
  if (obj.ctrl) obj.ctrl.abort();
  obj = null; stab.reset();
  overlay.setTarget(null);
  hideBadge();
}

async function confirm() {
  if (!obj) return;
  const ob = obj;
  haptic(10);
  if (ob.ctrl) ob.ctrl.abort();
  running = false; clearTimeout(timer);
  const r = ob.result && (ob.state === 'claude' || ob.state === 'unsure') ? ob.result : null;
  const thumb = ob.thumb || capture(ob.bbox, 160, 0.7) || '';
  const payload = r
    ? { query: r.search_query || r.name, name: r.name, brand: r.brand, model: r.model, category: r.category, confidence: r.confidence, barcode: r.barcode, thumb, source: 'claude' }
    : { query: labelDe(ob.cls), name: labelDe(ob.cls), brand: '', model: '', category: 'Allgemeine Kategorie', confidence: ob.score, barcode: null, thumb, source: 'coco' };
  // Übergang: Box zoomt zum Badge, Badge füllt sich
  const cr = el.canvas.getBoundingClientRect(), br = el.badge.getBoundingClientRect();
  el.badge.classList.add('confirming');
  await Promise.race([overlay.zoomTo([br.left - cr.left, br.top - cr.top, br.width, br.height], 420), sleep(600)]);
  el.badge.classList.remove('confirming');
  o.onConfirm(payload);
}
