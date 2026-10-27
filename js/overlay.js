// ScanDeals – Canvas-Overlay: Bounding-Box, Tracking-Punkte, Label (requestAnimationFrame, 60 fps)
import { isReduced } from './motion.js';

const CYAN = [0, 229, 255];
const PURPLE = [168, 85, 247];
const mix = (t) => CYAN.map((c, i) => Math.round(c + (PURPLE[i] - c) * t));
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Relative Feature-Punkte (stabil pro Objekt) + Mesh-Kanten. */
function buildMesh(seed) {
  const r = rng(seed * 9301 + 49297);
  const pts = [[0, 0], [.5, 0], [1, 0], [1, .5], [1, 1], [.5, 1], [0, 1], [0, .5]];
  const inner = 3 + Math.floor(r() * 2);
  for (let i = 0; i < inner; i++) pts.push([.2 + r() * .6, .2 + r() * .6]);
  const edges = [];
  for (let i = 0; i < 8; i++) edges.push([i, (i + 1) % 8]);
  for (let i = 8; i < pts.length; i++) {
    const d = [];
    for (let j = 0; j < 8; j++) d.push([j, (pts[j][0] - pts[i][0]) ** 2 + (pts[j][1] - pts[i][1]) ** 2]);
    d.sort((a, b) => a[1] - b[1]);
    edges.push([i, d[0][0]], [i, d[1][0]]);
    if (i + 1 < pts.length) edges.push([i, i + 1]);
  }
  return { pts, edges, phase: pts.map(() => r() * 6.28) };
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export class Overlay {
  constructor(canvas, video) {
    this.canvas = canvas;
    this.video = video;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cw = 0; this.ch = 0;
    this.target = null;   // {bbox (Videopixel), label, objId}
    this.cur = null;      // aktuelle (geglättete) Box in Canvas-CSS-Pixeln
    this.alpha = 0;
    this.pulseT = -1e9;
    this.zoom = null;
    this.mesh = null; this.meshId = -1;
    this.raf = 0; this.last = 0;
    this._frame = this._frame.bind(this);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
  }

  resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.cw = w; this.ch = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
  }

  /** Ziel setzen (Detection-Ergebnis) – die Box folgt per Lerp. null = ausblenden. */
  setTarget(t) {
    this.target = t;
    if (t && t.objId !== this.meshId) { this.mesh = buildMesh(t.objId + 1); this.meshId = t.objId; }
    this._kick();
  }
  setLabel(label) { if (this.target) this.target.label = label; }
  pulse() { this.pulseT = performance.now(); this._kick(); }

  /** Box „zoomt“ zum Zielrechteck (Canvas-CSS-Pixel) und blendet aus. */
  zoomTo(rect, ms = 420) {
    if (!this.cur || isReduced()) { this.clear(); return Promise.resolve(); }
    return new Promise((resolve) => {
      this.zoom = { t0: performance.now(), ms, from: this.cur.slice(), to: rect, done: resolve };
      this._kick();
    });
  }

  clear() {
    this.target = null; this.cur = null; this.alpha = 0;
    if (this.zoom) { const d = this.zoom.done; this.zoom = null; d(); }
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
  destroy() { this.clear(); if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; this.ro.disconnect(); }

  _kick() { if (!this.raf) { this.last = performance.now(); this.raf = requestAnimationFrame(this._frame); } }

  _toCanvas(b) {
    const vw = this.video.videoWidth || 640, vh = this.video.videoHeight || 480;
    const s = Math.max(this.cw / vw, this.ch / vh);
    return [b[0] * s + (this.cw - vw * s) / 2, b[1] * s + (this.ch - vh * s) / 2, b[2] * s, b[3] * s];
  }

  _frame(now) {
    this.raf = 0;
    const dt = Math.min(0.05, Math.max(0.001, (now - this.last) / 1000));
    this.last = now;
    if (!this.cw) this.resize();
    const k = 1 - Math.exp(-dt * 14);

    if (this.zoom) {
      const z = this.zoom;
      const p = Math.min(1, (now - z.t0) / z.ms), e = easeInOut(p);
      this.cur = z.from.map((v, i) => v + (z.to[i] - v) * e);
      this.alpha = 1 - e * 0.85;
      if (p >= 1) { const d = z.done; this.zoom = null; this.target = null; this.cur = null; this.alpha = 0; d(); }
    } else if (this.target) {
      const t = this._toCanvas(this.target.bbox);
      if (!this.cur) this.cur = [t[0] - t[2] * 0.09, t[1] - t[3] * 0.09, t[2] * 1.18, t[3] * 1.18]; // „Einrasten“
      for (let i = 0; i < 4; i++) this.cur[i] += (t[i] - this.cur[i]) * k;
      this.alpha += (1 - this.alpha) * (1 - Math.exp(-dt * 9));
    } else if (this.cur) {
      this.alpha -= dt * 3.2;
      if (this.alpha <= 0) { this.alpha = 0; this.cur = null; }
    }

    this._draw(now / 1000);
    if (this.cur || this.target || this.zoom) this.raf = requestAnimationFrame(this._frame);
  }

  _draw(t) {
    const { ctx, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.cw, this.ch);
    if (!this.cur || this.alpha <= 0.01) return;
    let [x, y, w, h] = this.cur;
    if (w < 20 || h < 20) return;
    // Puls (Erkennung): kurzes Aufpoppen + stärkeres Glühen
    const pp = Math.max(0, 1 - (performance.now() - this.pulseT) / 650);
    const sc = 1 + 0.045 * Math.sin(pp * Math.PI);
    const cx = x + w / 2, cy = y + h / 2;
    w *= sc; h *= sc; x = cx - w / 2; y = cy - h / 2;
    const glow = 10 + 14 * pp;
    const reduced = isReduced();

    ctx.save();
    ctx.globalAlpha = this.alpha;
    const g = ctx.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, '#00E5FF'); g.addColorStop(1, '#A855F7');

    // zarte Füllung
    roundRect(ctx, x, y, w, h, 14);
    const fill = ctx.createLinearGradient(x, y, x + w, y + h);
    fill.addColorStop(0, rgba(CYAN, 0.07)); fill.addColorStop(1, rgba(PURPLE, 0.09));
    ctx.fillStyle = fill; ctx.fill();

    // Mesh
    const m = this.mesh;
    if (m) {
      const P = m.pts.map((p, i) => {
        const j = i >= 8 && !reduced ? 1.6 : 0;
        return [x + p[0] * w + Math.sin(t * 1.3 + m.phase[i]) * j, y + p[1] * h + Math.cos(t * 1.1 + m.phase[i]) * j];
      });
      ctx.lineWidth = 1;
      ctx.strokeStyle = rgba(mix(0.5), 0.32);
      ctx.beginPath();
      for (const [a, b] of m.edges) { ctx.moveTo(P[a][0], P[a][1]); ctx.lineTo(P[b][0], P[b][1]); }
      ctx.stroke();
      ctx.shadowColor = rgba(CYAN, 0.9);
      ctx.shadowBlur = 8;
      for (let i = 0; i < P.length; i++) {
        const pulse = reduced ? 0.5 : 0.5 + 0.5 * Math.sin(t * 3.2 + m.phase[i]);
        const r = (i < 8 ? 2.1 : 2.6) + pulse * 1.3;
        ctx.fillStyle = rgba(mix(i / P.length), 0.55 + pulse * 0.45);
        ctx.beginPath(); ctx.arc(P[i][0], P[i][1], r, 0, 6.2832); ctx.fill();
      }
      ctx.shadowBlur = 0;
    }

    // Eck-Klammern
    const arm = Math.max(10, Math.min(28, w * 0.26, h * 0.26));
    const R = Math.min(12, arm * 0.6);
    ctx.lineWidth = 3.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = g; ctx.shadowColor = rgba(CYAN, 0.85); ctx.shadowBlur = glow;
    ctx.beginPath();
    ctx.moveTo(x, y + arm); ctx.lineTo(x, y + R); ctx.arcTo(x, y, x + R, y, R); ctx.lineTo(x + arm, y);
    ctx.moveTo(x + w - arm, y); ctx.lineTo(x + w - R, y); ctx.arcTo(x + w, y, x + w, y + R, R); ctx.lineTo(x + w, y + arm);
    ctx.moveTo(x + w, y + h - arm); ctx.lineTo(x + w, y + h - R); ctx.arcTo(x + w, y + h, x + w - R, y + h, R); ctx.lineTo(x + w - arm, y + h);
    ctx.moveTo(x + arm, y + h); ctx.lineTo(x + R, y + h); ctx.arcTo(x, y + h, x, y + h - R, R); ctx.lineTo(x, y + h - arm);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Label-Chip
    const label = this.target && this.target.label;
    if (label && !this.zoom) {
      ctx.font = '600 13px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      const tw = ctx.measureText(label).width;
      const cw = tw + 24, chh = 26;
      let lx = Math.min(Math.max(8, x), this.cw - cw - 8);
      let ly = y - chh - 8;
      if (ly < 8) ly = Math.min(y + 8, this.ch - chh - 8);
      roundRect(ctx, lx, ly, cw, chh, 13);
      ctx.fillStyle = 'rgba(10,12,18,.72)'; ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,.2)'; ctx.stroke();
      ctx.fillStyle = '#00E5FF';
      ctx.beginPath(); ctx.arc(lx + 11, ly + chh / 2, 3, 0, 6.2832); ctx.fill();
      ctx.fillStyle = '#F2F5F8'; ctx.textBaseline = 'middle';
      ctx.fillText(label, lx + 19, ly + chh / 2 + 0.5);
    }
    ctx.restore();
  }
}
