// PreisFuchs – App-Logik (Routing, Rendering, Verlauf)
import {
  getProduct, searchProducts, getPrices, aggregatePrices, formatPrice, formatDate, relativeDate,
  mapsLinkForBranch, mapsLinkAllBranches, onlineSearchLinks, reportPriceLink,
} from './api.js';
import { startScanner, stopScanner } from './scanner.js';

const $ = (s) => document.querySelector(s);
const view = $('#view');
const HISTORY_KEY = 'preisfuchs.history';
let userPos = null;
let navToken = 0;

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '');

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
function clearHistory() { try { localStorage.removeItem(HISTORY_KEY); } catch {} }

// ---------- Hilfen ----------
const thumb = (p) => p.image
  ? `<img class="thumb" src="${esc(safeUrl(p.image))}" alt="" loading="lazy">`
  : `<span class="thumb" aria-hidden="true">🛒</span>`;

function productItem(p) {
  const sub = [p.brand, p.quantity].filter(Boolean).join(' · ');
  return `<li><a class="item" href="#/produkt/${esc(encodeURIComponent(p.code))}">
    ${thumb(p)}<span><span class="t">${esc(p.name)}</span><br><span class="s">${esc(sub || p.code)}</span></span></a></li>`;
}

const skeleton = () => `<div class="skeleton" aria-label="Lädt …"><div class="sk"></div><div class="sk"></div><div class="sk"></div></div>`;

function errorView(msg, retry) {
  view.innerHTML = `<div class="card error"><p><strong>Das hat leider nicht geklappt.</strong></p><p>${esc(msg)}</p>
    <button class="btn accent" id="retry" type="button">Erneut versuchen</button></div>`;
  $('#retry').onclick = retry;
}
const errText = (e) => !navigator.onLine ? 'Du bist offline.' : e && e.timeout ? 'Der Server antwortet nicht (Zeitüberschreitung).' : 'Die Daten konnten nicht geladen werden.';

// ---------- Views ----------
function homeView() {
  const h = loadHistory();
  view.innerHTML = `
    <div class="card"><strong>Preise vergleichen in Sekunden.</strong>
      <p class="muted" style="margin:.3rem 0 0">Suche ein Produkt oder scanne den Barcode – PreisFuchs zeigt dir die günstigsten gemeldeten Preise.</p></div>
    ${h.length ? `<h2>Zuletzt angesehen</h2><ul class="list">${h.map(productItem).join('')}</ul>
      <p><button class="chip" id="clear-hist" type="button">Verlauf löschen</button></p>` : ''}`;
  const c = $('#clear-hist');
  if (c) c.onclick = () => { clearHistory(); homeView(); };
}

async function searchView(q, token) {
  $('#q').value = q;
  view.innerHTML = `<h2>Suche: „${esc(q)}“</h2>${skeleton()}`;
  try {
    const list = await searchProducts(q);
    if (token !== navToken) return;
    view.innerHTML = `<h2>Ergebnisse für „${esc(q)}“</h2>` + (list.length
      ? `<ul class="list">${list.map(productItem).join('')}</ul>`
      : `<div class="card empty"><div class="big">🔍</div><p><strong>Nichts gefunden.</strong></p>
         <p class="muted">Versuche einen anderen Suchbegriff oder scanne den Barcode.</p></div>`);
  } catch (e) {
    if (token === navToken) errorView(errText(e), () => searchView(q, token));
  }
}

function priceRowHtml(r, best) {
  const when = r.date ? `Stand: ${esc(formatDate(r.date))} (${esc(relativeDate(r.date))})` : '';
  const brandForMaps = r.brand || r.name;
  let actions = '';
  if (r.type === 'ONLINE') {
    const u = safeUrl(r.url);
    if (u) actions = `<a class="btn small accent" href="${esc(u)}" target="_blank" rel="noopener">Zum Shop</a>`;
  } else {
    const hasPos = r.lat != null && r.lon != null;
    actions = (hasPos ? `<a class="btn small" data-act="branch" href="${esc(mapsLinkForBranch(r.lat, r.lon))}" target="_blank" rel="noopener">📍 Filiale der Meldung</a>` : '')
      + `<a class="btn small" data-act="all" href="${esc(mapsLinkAllBranches(brandForMaps, userPos))}" target="_blank" rel="noopener">🗺️ Alle Filialen in Google Maps</a>`;
  }
  return `<article class="card price-row${best ? ' best' : ''}">
    <div class="pr-top">
      <div><div class="pr-name">${esc(r.name)}</div>
        <div>${best ? '<span class="badge">Bestpreis</span>' : ''}${r.discounted ? '<span class="badge deal">Angebot</span>' : ''}${r.isOld ? '<span class="badge old">älter als 12 Monate</span>' : ''}</div></div>
      <div class="pr-price">${esc(formatPrice(r.price, r.currency))}${r.discounted && r.priceWithout ? `<s>${esc(formatPrice(r.priceWithout, r.currency))}</s>` : ''}</div>
    </div>
    <div class="pr-meta">${r.type === 'ONLINE' ? 'Online' : esc(r.city || 'Ladengeschäft')}${when ? ' · ' + when : ''}</div>
    ${actions ? `<div class="actions">${actions}</div>` : ''}
  </article>`;
}

function onlineSection(product) {
  const links = onlineSearchLinks(product.name + (product.brand && !product.name.includes(product.brand) ? ' ' + product.brand : ''), product.code);
  return `<h2>Weitere Preise online prüfen</h2><div class="chips">${links.map((l) =>
    `<a class="chip" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`).join('')}</div>`;
}

async function productView(code, token) {
  view.innerHTML = skeleton();
  try {
    const [product, items] = await Promise.all([
      getProduct(code),
      getPrices(code).catch((e) => { if (!navigator.onLine) throw e; return null; }),
    ]);
    if (token !== navToken) return;
    const p = product || { code, name: 'Unbekanntes Produkt', brand: '', quantity: '', image: '' };
    if (product) saveHistory(p);
    renderProduct(p, items, false, token);
  } catch (e) {
    if (token === navToken) errorView(errText(e), () => productView(code, token));
  }
}

function renderProduct(p, items, includeOld, token) {
  const head = `<div class="card product-head">${thumb(p)}<div><h1>${esc(p.name)}</h1>
    <div class="muted">${esc([p.brand, p.quantity].filter(Boolean).join(' · '))}</div><div class="code">Barcode ${esc(p.code)}</div></div></div>`;
  let body;
  if (items === null) {
    body = `<div class="card empty" style="margin-top:14px"><p><strong>Preise gerade nicht verfügbar.</strong></p><p class="muted">Prüfe die Online-Links unten.</p></div>`;
  } else {
    const { rows, hiddenOld } = aggregatePrices(items, { includeOld });
    const toolbar = `<div class="toolbar">
      <button class="btn small" id="geo" type="button">${userPos ? '📍 Standort aktiv' : '📍 Standort nutzen'}</button>
      ${hiddenOld || includeOld ? `<label class="toggle"><input type="checkbox" id="old" ${includeOld ? 'checked' : ''}> ältere anzeigen${!includeOld ? ` (${hiddenOld})` : ''}</label>` : ''}</div>`;
    if (rows.length) {
      body = `<h2>Preise (${rows.length} ${rows.length === 1 ? 'Händler' : 'Händler'})</h2>${toolbar}${rows.map((r, i) => priceRowHtml(r, i === 0)).join('')}`;
    } else {
      body = `${items.length ? toolbar : ''}<div class="card empty" style="margin-top:14px"><div class="big">🦊</div>
        <p><strong>Noch keine aktuellen Preise gemeldet.</strong></p>
        <p class="muted">Für dieses Produkt gibt es noch keine ${items.length ? 'aktuellen ' : ''}Preise in der Community-Datenbank. Schau online nach – oder melde selbst einen Preis.</p>
        <a class="btn accent" href="${esc(reportPriceLink(p.code))}" target="_blank" rel="noopener">Preis selbst melden</a></div>`;
    }
  }
  view.innerHTML = head + body + onlineSection(p)
    + (items && items.length ? `<p class="muted" style="margin-top:16px"><a href="${esc(reportPriceLink(p.code))}" target="_blank" rel="noopener">Preis selbst melden</a></p>` : '');
  const old = $('#old');
  if (old) old.onchange = () => renderProduct(p, items, old.checked, token);
  const geo = $('#geo');
  if (geo) geo.onclick = () => {
    if (!navigator.geolocation) { geo.textContent = 'Standort nicht verfügbar'; return; }
    geo.textContent = 'Standort wird ermittelt …';
    navigator.geolocation.getCurrentPosition(
      (pos) => { userPos = { lat: +pos.coords.latitude.toFixed(4), lon: +pos.coords.longitude.toFixed(4) }; renderProduct(p, items, includeOld, token); },
      () => { geo.textContent = 'Standort verweigert'; },
      { timeout: 10000, maximumAge: 300000 },
    );
  };
}

// ---------- Routing ----------
function route() {
  navToken++;
  const token = navToken;
  stopScannerUI();
  const hash = location.hash || '#/';
  const m = hash.match(/^#\/(suche|produkt)\/(.+)$/);
  $('#back').hidden = !m;
  window.scrollTo(0, 0);
  if (m) {
    const arg = decodeURIComponent(m[2]);
    return m[1] === 'suche' ? searchView(arg, token) : productView(arg, token);
  }
  $('#q').value = '';
  homeView();
}

function submitQuery(raw) {
  const q = raw.trim();
  if (!q) return;
  const digits = q.replace(/[\s-]/g, '');
  location.hash = /^\d{8,14}$/.test(digits) ? `#/produkt/${digits}` : `#/suche/${encodeURIComponent(q)}`;
}

$('#search-form').addEventListener('submit', (e) => { e.preventDefault(); submitQuery($('#q').value); $('#q').blur(); });
$('#back').addEventListener('click', () => { if (history.length > 1) history.back(); else location.hash = '#/'; });
window.addEventListener('hashchange', route);

// ---------- Scanner-UI ----------
const overlay = $('#scanner');
const msg = $('#scan-msg');
function stopScannerUI() { stopScanner(); overlay.hidden = true; document.body.style.overflow = ''; }
$('#scan-btn').addEventListener('click', async () => {
  overlay.hidden = false;
  document.body.style.overflow = 'hidden';
  msg.className = 'scan-msg';
  msg.textContent = 'Halte den Barcode in den Rahmen';
  try {
    const code = await startScanner($('#video'));
    stopScannerUI();
    location.hash = `#/produkt/${encodeURIComponent(code)}`;
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    msg.className = 'scan-msg err';
    msg.textContent = e.message || 'Scan fehlgeschlagen.';
  }
});
$('#scan-cancel').addEventListener('click', stopScannerUI);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) stopScannerUI(); });

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
