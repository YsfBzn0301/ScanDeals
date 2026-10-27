// ScanDeals – App-Logik (Routing, Scanner-UI, Bottom-Sheet-Ansichten, Verlauf)
import {
  getProduct, searchProducts, getPrices, aggregatePrices, formatPrice, formatDate, relativeDate,
  mapsLinkForBranch, mapsLinkAllBranches, onlineSearchLinks, reportPriceLink,
} from './api.js';
import { startScanner, stopScanner, hasTorch, setTorch } from './scanner.js';
import { initSheet, openSheet, closeSheet, setContent, isOpen, snapTo, getSnap, getBody } from './sheet.js';
import { haptic, countUp, liquidSwap, isReduced, sleep } from './motion.js';
import { runSplash } from './splash.js';

const $ = (s, r = document) => r.querySelector(s);
const HISTORY_KEY = 'scandeals.history';
let userPos = null;
let navToken = 0;
let prevKind = null;

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '');
const icon = (id, cls = '') => `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;

// ---------- Verlauf ----------
function loadHistory() {
  try {
    const h = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(h) ? h.filter((p) => p && p.code) : [];
  } catch { return []; }
}
function saveHistory(p) {
  try {
    const h = loadHistory().filter((x) => x.code !== p.code);
    h.unshift({ code: p.code, name: p.name, brand: p.brand, quantity: p.quantity, image: p.image });
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, 10)));
  } catch { /* ignorieren */ }
}
function clearHistory() { try { localStorage.removeItem(HISTORY_KEY); } catch { /* ignorieren */ } }

// ---------- Kleine Bausteine ----------
const thumb = (p, size = '') => `<span class="thumb ${size}">${icon('i-bag')}${
  p.image ? `<img class="thumb-img" src="${esc(safeUrl(p.image))}" alt="" loading="lazy" decoding="async">` : ''}</span>`;

// Defekte Bilder ausblenden (Fehler-Events bubblen nicht → Capture)
document.addEventListener('error', (e) => {
  if (e.target && e.target.classList && e.target.classList.contains('thumb-img')) e.target.remove();
}, true);

const subOf = (p) => [p.brand, p.quantity].filter(Boolean).join(' · ');

function productItem(p, i) {
  return `<li class="stagger" style="--i:${i}"><a class="item" href="#/produkt/${esc(encodeURIComponent(p.code))}">
    ${thumb(p)}<span class="item-t"><span class="t">${esc(p.name)}</span><span class="s">${esc(subOf(p) || p.code)}</span></span>
    ${icon('i-next', 'chev')}</a></li>`;
}

const skeleton = () => `<div class="skeleton" aria-label="Lädt …" role="status">
  <div class="sk sk-hero"></div><div class="sk sk-row"></div><div class="sk sk-row"></div><div class="sk sk-row"></div></div>`;
const skeletonHead = () => `<div class="ph"><span class="thumb lg sk-block"></span><div class="ph-t"><div class="sk-line w70"></div><div class="sk-line w45"></div></div></div><span id="sheet-title" class="sr-only">Lädt</span>`;

const errText = (e) => !navigator.onLine ? 'Du bist offline.'
  : e && e.timeout ? 'Der Server antwortet nicht (Zeitüberschreitung).' : 'Die Daten konnten nicht geladen werden.';

function simpleHead(title, sub) {
  return `<h1 id="sheet-title" class="sh-title">${esc(title)}</h1>${sub ? `<p class="sh-sub">${esc(sub)}</p>` : ''}`;
}

// ---------- Sheet-Ansichten ----------
async function showSheet(headHtml, bodyHtml, { snap, back = false, onInsert, animate } = {}) {
  const wasOpen = isOpen();
  await setContent(headHtml, bodyHtml, { animate: animate ?? wasOpen, back, onInsert });
  if (!wasOpen) openSheet(snap || 'half');
  else if (snap && snap !== getSnap()) snapTo(snap);
}

function errorBody(msg) {
  return `<div class="state surface">${icon('i-alert', 'state-ico')}<p class="state-t">Das hat leider nicht geklappt.</p>
    <p class="state-s">${esc(msg)}</p>
    <button class="btn primary" id="retry" type="button">${icon('i-refresh')}Erneut versuchen</button></div>`;
}

async function searchView(q, token) {
  $('#q').value = q;
  $('#q').dispatchEvent(new Event('input'));
  await showSheet(simpleHead('Suche', `„${q}“`), skeleton(), { snap: 'full', back: false });
  try {
    const list = await searchProducts(q);
    if (token !== navToken) return;
    const bodyHtml = list.length
      ? `<ul class="list">${list.map(productItem).join('')}</ul>`
      : `<div class="state surface">${icon('i-search', 'state-ico')}<p class="state-t">Nichts gefunden.</p>
         <p class="state-s">Versuche einen anderen Suchbegriff oder scanne den Barcode.</p></div>`;
    await showSheet(simpleHead('Ergebnisse', `${list.length} ${list.length === 1 ? 'Treffer' : 'Treffer'} für „${q}“`), bodyHtml);
  } catch (e) {
    if (token !== navToken) return;
    await showSheet(simpleHead('Suche', `„${q}“`), errorBody(errText(e)), {
      onInsert: (h, b) => { $('#retry', b).onclick = () => searchView(q, navToken); },
    });
  }
}

function historyView() {
  const h = loadHistory();
  const bodyHtml = h.length
    ? `<ul class="list">${h.map(productItem).join('')}</ul>
       <p class="center"><button class="chip" id="clear-hist" type="button">Verlauf löschen</button></p>`
    : `<div class="state surface">${icon('i-clock', 'state-ico')}<p class="state-t">Noch nichts gescannt.</p>
       <p class="state-s">Gescannte und angesehene Produkte erscheinen hier.</p></div>`;
  return showSheet(simpleHead('Verlauf', h.length ? `Zuletzt angesehen · ${h.length}` : ''), bodyHtml, {
    snap: 'half',
    onInsert: (hd, b) => {
      const c = $('#clear-hist', b);
      if (c) c.onclick = () => { clearHistory(); renderRecent(); historyView(); };
    },
  });
}

// ----- Preisansicht -----
function productHead(p) {
  return `<div class="ph">${thumb(p, 'lg')}<div class="ph-t"><h1 id="sheet-title">${esc(p.name)}</h1>
    ${subOf(p) ? `<p class="ph-s">${esc(subOf(p))}</p>` : ''}<p class="ph-c">Barcode ${esc(p.code)}</p></div></div>`;
}

function badges(r, best) {
  return `${best ? '<span class="badge best">Bestpreis</span>' : ''}${r.discounted ? '<span class="badge deal">Angebot</span>' : ''}`
    + `${r.type === 'ONLINE' ? '<span class="badge online">Online</span>' : ''}${r.isOld ? '<span class="badge old">älter</span>' : ''}`;
}

function priceRowHtml(r, best, i) {
  const brandForMaps = r.brand || r.name;
  let actions = '';
  if (r.type === 'ONLINE') {
    const u = safeUrl(r.url);
    if (u) actions = `<a class="act primary" href="${esc(u)}" target="_blank" rel="noopener">${icon('i-ext')}Zum Shop</a>`;
  } else {
    const hasPos = r.lat != null && r.lon != null;
    actions = (hasPos ? `<a class="act" data-act="branch" href="${esc(mapsLinkForBranch(r.lat, r.lon))}" target="_blank" rel="noopener">${icon('i-pin')}Filiale der Meldung</a>` : '')
      + `<a class="act" data-act="all" data-brand="${esc(brandForMaps)}" href="${esc(mapsLinkAllBranches(brandForMaps, userPos))}" target="_blank" rel="noopener">${icon('i-map')}Alle Filialen in Google Maps</a>`;
  }
  const place = r.type === 'ONLINE' ? 'Online-Shop' : (r.city || 'Ladengeschäft');
  const rel = r.date ? relativeDate(r.date) : '';
  const was = r.discounted && r.priceWithout ? `<s>${esc(formatPrice(r.priceWithout, r.currency))}</s>` : '';
  const main = `<div class="pc-l"><span class="pc-name">${esc(r.name)}</span>
      <span class="pc-meta">${esc(place)}${rel ? ` · ${esc(rel)}` : ''}</span>
      <span class="pc-badges">${badges(r, best)}</span></div>
    <div class="pc-r"><span class="pc-price" data-price="${r.price}" data-cur="${esc(r.currency)}">${esc(formatPrice(r.price, r.currency))}</span>${was}</div>`;
  const cls = `pcard surface stagger${best ? ' is-best' : ''}`;
  if (!actions) return `<article class="${cls}" style="--i:${i}"><div class="pc-main static">${main}</div></article>`;
  return `<article class="${cls}" style="--i:${i}">
    <button class="pc-main" type="button" aria-expanded="false">${main}${icon('i-chev', 'pc-chev')}</button>
    <div class="pc-more"><div><div class="pc-actions">${r.date ? `<p class="pc-stand">Stand: ${esc(formatDate(r.date))}</p>` : ''}${actions}</div></div></div>
  </article>`;
}

function listHtml(rows, bestName) {
  return rows.map((r, i) => priceRowHtml(r, bestName != null && r.name === bestName, i)).join('');
}

function onlineSection(p) {
  const links = onlineSearchLinks(p.name + (p.brand && !p.name.includes(p.brand) ? ' ' + p.brand : ''), p.code).slice(0, 4);
  return `<section class="block stagger" style="--i:6"><h2 class="label">Online weitersuchen</h2><div class="chips">${links.map((l) =>
    `<a class="chip" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}${icon('i-ext')}</a>`).join('')}</div></section>`;
}

function footerBlock(p, withReport) {
  return `<div class="foot">${withReport ? `<a class="link" href="${esc(reportPriceLink(p.code))}" target="_blank" rel="noopener">Preis selbst melden</a>` : ''}
    <p>Quelle: Open Prices / Open Food Facts (Community, ODbL). Preise können abweichen.</p></div>`;
}

function heroHtml(best, cheapest, priciest) {
  const diff = priciest.price - cheapest.price;
  const save = diff > 0.004 ? `bis zu ${esc(formatPrice(diff, cheapest.currency))} günstiger` : 'Einziger aktueller Preis';
  const when = cheapest.date ? relativeDate(cheapest.date) : '';
  return `<section class="hero stagger" style="--i:0" aria-label="Bestpreis">
    <div class="hero-top"><span class="badge best big">Bestpreis</span><span class="hero-when">${esc(when)}</span></div>
    <div class="hero-price" data-price="${best.price}" data-cur="${esc(best.currency)}">${esc(formatPrice(best.price, best.currency))}</div>
    <div class="hero-shop">${esc(best.name)}${best.city && best.type !== 'ONLINE' ? `<span> · ${esc(best.city)}</span>` : ''}</div>
    <div class="hero-save">${icon('i-arrow', 'down')}${save}</div></section>`;
}

function runCountUps(root, base = 0) {
  root.querySelectorAll('[data-price]').forEach((el, i) => {
    countUp(el, Number(el.dataset.price), { currency: el.dataset.cur || 'EUR', delay: base + (el.classList.contains('hero-price') ? 80 : 120 + i * 40) });
  });
}

async function productView(code, token) {
  const back = prevKind === 'suche' || prevKind === 'verlauf';
  await showSheet(skeletonHead(), skeleton(), { snap: 'half', back });
  try {
    const [product, items] = await Promise.all([
      getProduct(code),
      getPrices(code).catch((e) => { if (!navigator.onLine) throw e; return null; }),
    ]);
    if (token !== navToken) return;
    const p = product || { code, name: 'Unbekanntes Produkt', brand: '', quantity: '', image: '' };
    if (product) { saveHistory(p); renderRecent(); }
    renderProduct(p, items, back);
  } catch (e) {
    if (token !== navToken) return;
    await showSheet(skeletonHead(), errorBody(errText(e)), {
      back,
      onInsert: (h, b) => { $('#retry', b).onclick = () => productView(code, navToken); },
    });
  }
}

function renderProduct(p, items, back) {
  let bodyHtml;
  let current = null, all = null, best = null;
  if (items === null) {
    bodyHtml = `<div class="state surface">${icon('i-alert', 'state-ico')}<p class="state-t">Preise gerade nicht verfügbar.</p>
      <p class="state-s">Prüfe die Online-Links unten.</p></div>${onlineSection(p)}${footerBlock(p, false)}`;
  } else {
    current = aggregatePrices(items, { includeOld: false });
    all = aggregatePrices(items, { includeOld: true });
    best = current.rows[0] || null;
    const toolbar = `<div class="toolbar stagger" style="--i:1">
      ${current.hiddenOld ? `<div class="seg" role="group" aria-label="Preise filtern">
        <span class="seg-thumb" aria-hidden="true"></span>
        <button type="button" data-mode="cur" aria-pressed="true">Aktuell</button>
        <button type="button" data-mode="all" aria-pressed="false">Alle (inkl. älter)</button></div>` : ''}
      <button class="chip geo" id="geo" type="button">${icon('i-pin')}<span>${userPos ? 'Standort aktiv' : 'Standort nutzen'}</span></button></div>`;
    if (best) {
      const rows = current.rows;
      const priciest = rows[rows.length - 1];
      bodyHtml = heroHtml(best, best, priciest)
        + toolbar
        + `<div id="plist" class="plist" aria-live="polite">${listHtml(rows, best.name)}</div>`
        + onlineSection(p) + footerBlock(p, true);
    } else {
      bodyHtml = `${all.rows.length ? toolbar : ''}<div id="plist" class="plist">
        <div class="state surface stagger" style="--i:1">${icon('i-bag', 'state-ico')}
        <p class="state-t">Noch keine aktuellen Preise gemeldet.</p>
        <p class="state-s">Für dieses Produkt gibt es noch keine ${items.length ? 'aktuellen ' : ''}Preise in der Community-Datenbank. Schau online nach – oder melde selbst einen Preis.</p>
        <a class="btn primary" href="${esc(reportPriceLink(p.code))}" target="_blank" rel="noopener">Preis selbst melden</a></div></div>`
        + onlineSection(p) + footerBlock(p, false);
    }
  }
  showSheet(productHead(p), bodyHtml, {
    back,
    onInsert: (h, b) => {
      runCountUps(b);
      wireProductBody(b, p, items, current, all, best);
    },
  });
}

function wireProductBody(b, p, items, current, all, best) {
  const list = $('#plist', b);
  // Karten auf-/zuklappen (smooth height via grid-rows)
  b.onclick = (e) => {
    const btn = e.target.closest('.pc-main:not(.static)');
    if (!btn || !b.contains(btn)) return;
    const card = btn.parentElement;
    const open = !card.classList.contains('open');
    card.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', String(open));
    haptic(8);
    if (open && getSnap() === 'half') snapTo('full');
  };
  // Segment: Aktuell | Alle
  const seg = $('.seg', b);
  if (seg && list) {
    let mode = 'cur';
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-mode]');
      if (!btn || btn.dataset.mode === mode) return;
      mode = btn.dataset.mode;
      haptic(8);
      seg.dataset.mode = mode;
      seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === btn)));
      const rows = (mode === 'all' ? all : current).rows;
      const html = rows.length ? listHtml(rows, best ? best.name : null)
        : `<div class="state surface"><p class="state-t">Keine aktuellen Preise.</p><p class="state-s">Wechsle auf „Alle“, um ältere Meldungen zu sehen.</p></div>`;
      liquidSwap(list, html, () => runCountUps(list));
    });
  }
  const geo = $('#geo', b);
  if (geo) {
    const label = $('span', geo);
    geo.onclick = () => {
      if (!navigator.geolocation) { label.textContent = 'Standort nicht verfügbar'; return; }
      label.textContent = 'Standort wird ermittelt …';
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          userPos = { lat: +pos.coords.latitude.toFixed(4), lon: +pos.coords.longitude.toFixed(4) };
          label.textContent = 'Standort aktiv';
          geo.classList.add('on');
          b.querySelectorAll('a[data-act="all"]').forEach((a) => { a.href = mapsLinkAllBranches(a.dataset.brand, userPos); });
        },
        () => { label.textContent = 'Standort verweigert'; },
        { timeout: 10000, maximumAge: 300000 },
      );
    };
    if (userPos) geo.classList.add('on');
  }
}

// ---------- Zuletzt gescannt ----------
function renderRecent() {
  const h = loadHistory();
  $('#recent-wrap').hidden = !h.length;
  $('#recent').innerHTML = h.map((p) => `<a class="rchip glass" href="#/produkt/${esc(encodeURIComponent(p.code))}">
    ${thumb(p, 'xs')}<span>${esc(p.name)}</span></a>`).join('');
}

// ---------- Routing ----------
function route() {
  navToken++;
  const token = navToken;
  const hash = location.hash || '#/';
  const m = hash.match(/^#\/(suche|produkt)\/(.+)$/);
  const kind = m ? m[1] : hash === '#/verlauf' ? 'verlauf' : 'home';
  if (kind !== 'home') {
    if (['starting', 'scanning', 'hit'].includes(vf.dataset.state)) { stopScanner(); setVf('paused'); }
    if (m) {
      const arg = decodeURIComponent(m[2]);
      (m[1] === 'suche' ? searchView(arg, token) : productView(arg, token));
    } else historyView();
  } else {
    closeSheet();
    $('#q').value = '';
    $('#q').dispatchEvent(new Event('input'));
    renderRecent();
  }
  prevKind = kind;
}

function submitQuery(raw) {
  const q = raw.trim();
  if (!q) return;
  const digits = q.replace(/[\s-]/g, '');
  location.hash = /^\d{8,14}$/.test(digits) ? `#/produkt/${digits}` : `#/suche/${encodeURIComponent(q)}`;
}

const goHome = () => { if (location.hash !== '#/' && location.hash !== '') location.hash = '#/'; };
initSheet({
  onUserClose: goHome,
  onBack: () => { if (history.length > 1) history.back(); else goHome(); },
});

$('#search-form').addEventListener('submit', (e) => { e.preventDefault(); submitQuery($('#q').value); $('#q').blur(); });
$('#q').addEventListener('input', () => { $('#go').classList.toggle('show', !!$('#q').value.trim()); });
$('#history-btn').addEventListener('click', () => { location.hash = '#/verlauf'; });
window.addEventListener('hashchange', route);

// ---------- Scanner-UI ----------
const vf = $('#vf');
const video = $('#video');
let scanId = 0;
let torchOn = false;

function setVf(state, extra) {
  vf.dataset.state = state;
  if (state === 'paused') $('#start-label').textContent = 'Erneut scannen';
  else if (state === 'idle') $('#start-label').textContent = 'Scannen starten';
  $('#idle-title').textContent = state === 'paused' ? 'Bereit zum nächsten Scan' : 'Barcode scannen';
  if (state === 'error') $('#vf-error-text').textContent = extra || 'Scan fehlgeschlagen.';
  if (state !== 'scanning') { torchOn = false; $('#torch-btn').hidden = true; $('#torch-btn').setAttribute('aria-pressed', 'false'); }
}

const codeLabel = (c) => (/^\d{13}$/.test(c) ? 'EAN' : /^\d{8}$/.test(c) ? 'EAN-8' : /^\d{12}$/.test(c) ? 'UPC' : 'Code') + ' ' + c;

async function startScan() {
  const id = ++scanId;
  setVf('starting');
  haptic(8);
  try {
    const code = await startScanner(video, {
      onReady: () => {
        if (id !== scanId) return;
        setVf('scanning');
        $('#torch-btn').hidden = !hasTorch();
      },
    });
    if (id !== scanId) return;
    $('#vf-chip').textContent = codeLabel(code);
    vf.dataset.state = 'hit';
    $('#torch-btn').hidden = true;
    haptic([12, 40, 18]);
    video.pause();
    await sleep(isReduced() ? 250 : 800);
    if (id !== scanId) return;
    stopScanner();
    location.hash = `#/produkt/${encodeURIComponent(code)}`;
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    if (id === scanId) setVf('error', e.message);
  }
}
function stopScan() {
  scanId++;
  stopScanner();
  setVf('paused');
}
$('#start-btn').addEventListener('click', startScan);
$('#retry-scan').addEventListener('click', startScan);
$('#stop-btn').addEventListener('click', stopScan);
$('#torch-btn').addEventListener('click', async () => {
  const ok = await setTorch(!torchOn);
  if (ok) { torchOn = !torchOn; $('#torch-btn').setAttribute('aria-pressed', String(torchOn)); haptic(8); }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && ['starting', 'scanning'].includes(vf.dataset.state)) stopScan();
});

// Tap-Haptik für Buttons
document.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch' && e.target.closest('.btn, .chip, .round-btn, .icon-btn, .rchip')) haptic(8);
}, { passive: true });

// ---------- Offline-Hinweis ----------
function updateOnline() { $('#offline').hidden = navigator.onLine; }
window.addEventListener('online', updateOnline);
window.addEventListener('offline', updateOnline);
updateOnline();

// ---------- Service Worker ----------
try {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }
} catch { /* ignorieren */ }

route();
runSplash($('#hdr-tile'));
