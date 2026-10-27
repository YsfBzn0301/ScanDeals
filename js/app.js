// ScanDeals – App-Logik (Routing, Scanner-UI, Bottom-Sheet-Ansichten, Verlauf)
import {
  getProduct, searchProducts, getPrices, aggregatePrices, formatPrice, formatDate, relativeDate,
  mapsLinkForBranch, mapsLinkAllBranches, formatNutrient, mergePrices, formatDistance, onlineSearchLinks, reportPriceLink,
  getDailyPrices, getShoppingPrices, getServerHealth, storeLogoUrl,
} from './api.js';
import { openCamera, startBarcodeLoop, stopBarcodeLoop, stopScanner, hasTorch, setTorch } from './scanner.js';
import { getAiEndpoint, getServerEndpoint, setAiEndpoint, normalizeEndpoint, isValidEndpoint, getMode, setMode, MODES } from './config.js';
import { initKi, start as kiStart, stop as kiStop } from './ki.js';
import { initSheet, openSheet, closeSheet, setContent, isOpen, snapTo, getSnap, getBody } from './sheet.js';
import { haptic, countUp, liquidSwap, isReduced, sleep } from './motion.js';
import { runSplash } from './splash.js';

const $ = (s, r = document) => r.querySelector(s);
const HISTORY_KEY = 'scandeals.history';
let userPos = null;
let navToken = 0;
let prevKind = null;
const KI_KEY = 'scandeals.ki';
const RADIUS_KEY = 'scandeals.radiusKm';
const RADII = [5, 10, 25];
const WORKER_DOCS = 'https://github.com/YsfBzn0301/ScanDeals/tree/main/worker';

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
  const c = e.target && e.target.classList;
  if (c && (c.contains('thumb-img') || c.contains('lg-img'))) e.target.remove(); // Händler-Logo: Initial-Kachel bleibt stehen
}, true);
document.addEventListener('load', (e) => {
  if (e.target && e.target.classList && e.target.classList.contains('lg-img')) e.target.classList.add('ok');
}, true);
const settleLogos = (root) => root.querySelectorAll('img.lg-img').forEach((i) => { if (i.complete && i.naturalWidth) i.classList.add('ok'); });

function loadRadius() {
  try { const v = Number(localStorage.getItem(RADIUS_KEY)); return RADII.includes(v) ? v : 10; } catch { return 10; }
}
function saveRadius(v) { try { localStorage.setItem(RADIUS_KEY, String(v)); } catch { /* ignorieren */ } }

/** Runde Händler-Kachel: Logo (falls geladen) über der Initiale bzw. dem Globus (Online). */
function logoTile(r, cls = '') {
  const online = r.type === 'ONLINE';
  const ini = ((r.name || '?').trim().charAt(0) || '?').toUpperCase();
  const img = !online && r.logo ? `<img class="lg-img" src="${esc(r.logo)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : '';
  return `<span class="lg-tile ${cls}" aria-hidden="true">${online ? icon('i-globe') : `<b>${esc(ini)}</b>`}${img}</span>`;
}

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
         <p class="state-s">Versuche einen anderen Suchbegriff oder scanne den Barcode.</p></div>${dailySectionShell('', '--i:1')}`;
    await showSheet(simpleHead('Ergebnisse', `${list.length} ${list.length === 1 ? 'Treffer' : 'Treffer'} für „${q}“`), bodyHtml, {
      onInsert: list.length ? undefined : (h, b) => { loadDaily(b, { q }, token, null, { title: 'Online gefunden', shoppingOnly: true, hideEmpty: true }); },
    });
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
  const dist = isFinite(r.distanceKm) ? `<span class="dist">${icon('i-pin')}${esc(formatDistance(r.distanceKm))}</span>` : '';
  const main = `${logoTile(r)}<div class="pc-l"><span class="pc-name">${esc(r.name)}</span>
      <span class="pc-meta">${esc(place)}${rel ? ` · ${esc(rel)}` : ''}${dist}</span>
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
  const wanted = ['idealo', 'Google Shopping', 'Amazon.de', 'geizhals.de'];
  const all = onlineSearchLinks(p.name + (p.brand && !p.name.includes(p.brand) ? ' ' + p.brand : ''), p.code);
  const links = wanted.map((w) => all.find((l) => l.label === w)).filter(Boolean);
  return `<section class="block stagger" style="--i:6"><h2 class="label">Online weitersuchen</h2><div class="chips">${links.map((l) =>
    `<a class="chip" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}${icon('i-ext')}</a>`).join('')}</div></section>`;
}

// ----- Tagesaktuell online (Google Shopping + Open Price Engine über den eigenen Server) -----
const DP_TITLE = 'Tagesaktuell online';
const DP_VISIBLE = 6;
const SRC_LABEL = { google: 'Google Shopping', ope: 'Open Price Engine' };

/** Platzhalter; bleibt versteckt, bis der Server Echtzeit- oder Tagespreise meldet. */
function dailySectionShell(cls = '', style = '--i:4') {
  return getServerEndpoint() ? `<section class="block dp ${cls}" id="dp-sec" style="${style}" aria-label="${DP_TITLE}" hidden></section>` : '';
}

function dailyCard(r, i) {
  const google = r.source === 'google';
  const rel = !google && r.date ? relativeDate(r.date) : '';
  const badges = (r.sameSize === true ? '<span class="badge same">gleiche Größe</span>' : '')
    + (r.sameSize === false ? '<span class="badge diff">andere Größe</span>' : '')
    + (r.pack > 1 ? `<span class="badge pack">${esc(r.pack)}er-Pack</span>` : '')
    + (r.score != null && isFinite(r.score) && r.score < 0.7 ? '<span class="badge sim">ähnliches Produkt</span>' : '');
  const tile = logoTile({ name: r.store, logo: google ? r.thumbnail : storeLogoUrl(r.store) }, google ? 'prod' : '');
  const was = r.oldPrice && r.oldPrice > r.price ? `<s>${esc(formatPrice(r.oldPrice, r.currency))}</s>` : '';
  const inner = `${tile}<div class="pc-l"><span class="pc-name">${esc(r.store)}</span>
      <span class="pc-meta dp-src"><i class="src-dot ${google ? 'g' : 'o'}" aria-hidden="true"></i>${esc(SRC_LABEL[r.source] || 'Online')}${rel ? ` · ${esc(rel)}` : ''}</span>
      ${r.productName ? `<span class="dp-pn">${esc(r.productName)}</span>` : ''}
      ${r.delivery ? `<span class="dp-dl">${esc(r.delivery)}</span>` : ''}
      <span class="pc-badges">${badges}</span></div>
    <div class="pc-r"><span class="pc-price" data-price="${r.price}" data-cur="${esc(r.currency)}">${esc(formatPrice(r.price, r.currency))}</span>${was}${r.url ? icon('i-ext', 'dp-go') : ''}</div>`;
  const u = safeUrl(r.url);
  const extra = i >= DP_VISIBLE ? ' dp-more' : '';
  return u
    ? `<a class="dcard surface stagger${extra}" style="--i:${Math.min(i, DP_VISIBLE)}" href="${esc(u)}" target="_blank" rel="noopener nofollow"${extra ? ' hidden' : ''}>${inner}</a>`
    : `<div class="dcard surface stagger${extra}" style="--i:${Math.min(i, DP_VISIBLE)}"${extra ? ' hidden' : ''}>${inner}</div>`;
}

function dailyBody(list, active, title = DP_TITLE) {
  const names = [active.shopping && 'Google Shopping', active.prices && 'Open Price Engine'].filter(Boolean).join(' und ');
  const hidden = Math.max(0, list.length - DP_VISIBLE);
  return `<h2 class="label">${esc(title)}</h2>
    ${list.length ? `<div class="dlist">${list.map(dailyCard).join('')}</div>`
      + (hidden ? `<button class="chip dp-all" id="dp-all" type="button" aria-expanded="false">Alle ${list.length} Angebote zeigen${icon('i-chev')}</button>` : '')
      : '<div class="state surface slim"><p class="state-s">Keine Tagespreise gefunden.</p></div>'}
    <p class="hint-s">Preise aus ${esc(names)}, Stand heute. Versandkosten können hinzukommen.</p>`;
}

/** Hero-Zeile: günstigstes Angebot in gleicher Größe, keine Mehrfachpackung. */
const heroCandidate = (list) => list.find((r) => r.sameSize !== false && !(r.pack > 1)) || null;

/**
 * Lädt Echtzeit-/Tagespreise in #dp-sec. Beide Quellen laufen parallel und sind einzeln robust.
 * opts: {title, hideEmpty, onList}. Gibt die gemeinsame Liste zurück ([] bei Fehler/versteckt).
 */
async function loadDaily(b, params, token, st, opts = {}) {
  const sec = $('#dp-sec', b);
  const ep = getServerEndpoint();
  if (!sec || !ep || !(params.q || params.gtin)) return [];
  const live = () => token === navToken && sec.isConnected;
  const title = opts.title || DP_TITLE;
  try {
    const h = await getServerHealth(ep);
    if (!live()) return [];
    const active = { shopping: !!h.shopping, prices: !!h.prices && !!params.q };
    if (opts.shoppingOnly) active.prices = false;
    if (!active.shopping && !active.prices) return [];
    sec.innerHTML = `<h2 class="label">${esc(title)}</h2><div class="skeleton" role="status" aria-label="Lädt …"><div class="sk sk-row"></div><div class="sk sk-row"></div></div>`;
    sec.hidden = false;
    const jobs = [
      active.shopping ? getShoppingPrices(ep, params) : Promise.reject(new Error('aus')),
      active.prices ? getDailyPrices(ep, params) : Promise.reject(new Error('aus')),
    ];
    const [g, o] = await Promise.allSettled(jobs);
    if (!live()) return [];
    const okG = g.status === 'fulfilled', okO = o.status === 'fulfilled';
    if (!okG && !okO) { sec.hidden = true; sec.innerHTML = ''; return []; }
    const list = [...(okG ? g.value : []), ...(okO ? o.value : [])].sort((a, c) => a.price - c.price);
    if (opts.hideEmpty && !list.length) { sec.hidden = true; sec.innerHTML = ''; return []; }
    sec.innerHTML = dailyBody(list, { shopping: okG && active.shopping, prices: okO && active.prices }, title);
    const all = $('#dp-all', sec);
    if (all) all.onclick = () => {
      const more = [...sec.querySelectorAll('.dp-more')];
      more.forEach((c, i) => { c.hidden = false; c.style.setProperty('--i', i); });
      runCountUps(sec);
      all.remove();
      haptic(6);
    };
    runCountUps(sec);
    settleLogos(sec);
    if (st) { st.daily = heroCandidate(list); refreshHeroOnline(b, st); }
    if (opts.onList) opts.onList(list);
    return list;
  } catch {
    if (live()) { sec.hidden = true; sec.innerHTML = ''; }
    return [];
  }
}

function heroOnlineHtml(st, best) {
  const d = st && st.daily;
  if (!d || !best || d.currency !== best.currency || !(d.price < best.price)) return '';
  return `<div class="hero-online">${icon('i-globe')}<span>Online heute: <b>${esc(formatPrice(d.price, d.currency))}</b> bei ${esc(d.store)}</span></div>`;
}

function refreshHeroOnline(b, st) {
  const hero = $('#hero-wrap .hero', b);
  if (!hero) return;
  const old = $('.hero-online', hero);
  if (old) old.remove();
  const html = heroOnlineHtml(st, priceView(st).best);
  if (html) hero.insertAdjacentHTML('beforeend', html);
}

function nutritionTable(nu, mode) {
  const key = mode === 'serving' ? 'perServing' : 'per100';
  return `<table class="nw-table"><tbody>${nu.rows.map((r) =>
    `<tr class="${r.indent ? 'sub' : ''}"><th scope="row">${esc(r.label)}</th><td>${esc(formatNutrient(r, r[key], r[key + 'Mod']))}</td></tr>`).join('')}</tbody></table>`;
}

function nutritionSection(p) {
  const nu = p.nutrition;
  if (!nu || !nu.rows || !nu.rows.length) return '';
  const unit = nu.per === '100ml' ? '100 ml' : '100 g';
  const hasServing = nu.rows.some((r) => r.perServing !== null && r.perServing !== undefined);
  const sLabel = (nu.serving ? `pro Portion (${esc(nu.serving)})` : 'pro Portion') + (nu.servingComputed ? ' <small class="nw-calc">berechnet</small>' : '');
  const head = hasServing
    ? `<div class="seg nw-seg" role="group" aria-label="Bezugsmenge" data-mode="100">
        <span class="seg-thumb" aria-hidden="true"></span>
        <button type="button" data-mode="100" aria-pressed="true">pro ${esc(unit)}</button>
        <button type="button" data-mode="serving" aria-pressed="false">${sLabel}</button></div>`
    : `<p class="nw-ref">pro ${esc(unit)}</p>`;
  return `<section class="block stagger nw" style="--i:5" aria-label="Nährwerte"><h2 class="label">Nährwerte</h2>
    <div class="nw-card surface">${head}<div class="nw-body">${nutritionTable(nu, '100')}</div>
    <p class="nw-src">Quelle: Open Food Facts</p></div></section>`;
}

function wireNutrition(b, p) {
  const seg = $('.nw-seg', b);
  const body = $('.nw-body', b);
  if (!seg || !body) return;
  let mode = '100';
  seg.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn || btn.dataset.mode === mode) return;
    mode = btn.dataset.mode;
    haptic(8);
    seg.dataset.mode = mode;
    seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === btn)));
    liquidSwap(body, nutritionTable(p.nutrition, mode));
  });
}

function footerBlock(p, withReport) {
  return `<div class="foot">${withReport ? `<a class="link" href="${esc(reportPriceLink(p.code))}" target="_blank" rel="noopener">Preis selbst melden</a>` : ''}
    <p>Quelle: Open Prices / Open Food Facts (Community, ODbL). Preise können abweichen.</p></div>`;
}

function heroHtml(best, cheapest, priciest, anim = true, extra = '') {
  const diff = priciest.price - cheapest.price;
  const save = diff > 0.004 ? `bis zu ${esc(formatPrice(diff, cheapest.currency))} günstiger` : 'Einziger aktueller Preis';
  const when = cheapest.date ? relativeDate(cheapest.date) : '';
  return `<section class="hero${anim ? ' stagger' : ''}" style="--i:0" aria-label="Bestpreis">
    <div class="hero-top"><span class="badge best big">Bestpreis</span><span class="hero-when">${esc(when)}</span></div>
    <div class="hero-price" data-price="${best.price}" data-cur="${esc(best.currency)}">${esc(formatPrice(best.price, best.currency))}</div>
    <div class="hero-shop">${logoTile(best, 'sm')}<div class="hero-shop-t">${esc(best.name)}${best.city && best.type !== 'ONLINE' ? `<span> · ${esc(best.city)}</span>` : ''}${isFinite(best.distanceKm) ? `<span class="dist">${icon('i-pin')}${esc(formatDistance(best.distanceKm))}</span>` : ''}</div></div>
    <div class="hero-save">${icon('i-arrow', 'down')}${save}</div>${extra}</section>`;
}

function runCountUps(root, base = 0) {
  root.querySelectorAll('[data-price]').forEach((el, i) => {
    countUp(el, Number(el.dataset.price), { currency: el.dataset.cur || 'EUR', delay: base + (el.classList.contains('hero-price') ? 80 : 120 + i * 40) });
  });
}

async function productView(code, token) {
  const back = ['suche', 'verlauf', 'ki'].includes(prevKind);
  await showSheet(skeletonHead(), skeleton(), { snap: 'half', back });
  try {
    const radius = loadRadius();
    const [product, items, near] = await Promise.all([
      getProduct(code),
      getPrices(code).catch((e) => { if (!navigator.onLine) throw e; return null; }),
      // Standort schon bekannt (nur im Speicher): Preise im Umkreis gleich mitladen
      userPos ? getPrices(code, { ...userPos, radiusKm: radius }).catch(() => null) : null,
    ]);
    if (token !== navToken) return;
    const p = product || { code, name: 'Unbekanntes Produkt', brand: '', quantity: '', image: '' };
    if (product) { saveHistory(p); renderRecent(); }
    renderProduct(p, items, back, near, radius);
  } catch (e) {
    if (token !== navToken) return;
    await showSheet(skeletonHead(), errorBody(errText(e)), {
      back,
      onInsert: (h, b) => { $('#retry', b).onclick = () => productView(code, navToken); },
    });
  }
}

// Standort einmalig anfragen (nur im Speicher halten, nicht persistieren)
function requestPos() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        userPos = { lat: +pos.coords.latitude.toFixed(4), lon: +pos.coords.longitude.toFixed(4) };
        resolve(userPos);
      },
      () => resolve(null),
      { timeout: 10000, maximumAge: 300000 },
    );
  });
}

/** Aktuelle Auswahl (Ort × Alter) aus dem Zustand ableiten. */
function priceView(st) {
  const items = mergePrices(st.items, st.near);
  const o = { userPos, maxKm: st.scope === 'near' ? st.radius : null };
  const current = aggregatePrices(items, { ...o, includeOld: false });
  const all = aggregatePrices(items, { ...o, includeOld: true });
  return {
    current, all, rows: (st.age === 'all' ? all : current).rows,
    best: current.rows[0] || null, hiddenOld: current.hiddenOld,
  };
}

function heroFor(v, anim, st) {
  return v.best ? heroHtml(v.best, v.best, v.current.rows[v.current.rows.length - 1], anim, heroOnlineHtml(st, v.best)) : '';
}

function listContent(st, v, p) {
  if (v.rows.length) return listHtml(v.rows, v.best ? v.best.name : null);
  if (st.scope === 'near') {
    const more = st.radius < 25;
    return `<div class="state surface">${icon('i-pin', 'state-ico')}
      <p class="state-t">Keine Preise im Umkreis von ${st.radius} km</p>
      <p class="state-s">${more ? 'Radius vergrößern?' : 'Wechsle auf „Überall“, um alle Händler zu sehen.'}</p>
      ${more ? '<button class="btn primary" type="button" data-km="25">25 km</button>' : ''}</div>`;
  }
  if (st.age === 'cur' && v.hiddenOld) {
    return `<div class="state surface"><p class="state-t">Keine aktuellen Preise.</p><p class="state-s">Wechsle auf „Alle“, um ältere Meldungen zu sehen.</p></div>`;
  }
  return `<div class="state surface stagger" style="--i:1">${icon('i-bag', 'state-ico')}
    <p class="state-t">Noch keine aktuellen Preise gemeldet.</p>
    <p class="state-s">Für dieses Produkt gibt es noch keine ${st.items.length ? 'aktuellen ' : ''}Preise in der Community-Datenbank. Schau online nach – oder melde selbst einen Preis.</p>
    <a class="btn primary" href="${esc(reportPriceLink(p.code))}" target="_blank" rel="noopener">Preis selbst melden</a></div>`;
}

function toolbarHtml(st, v) {
  const near = st.scope === 'near';
  return `<div class="toolbar stagger" style="--i:1">
    <div class="seg" id="age-seg" role="group" aria-label="Preise filtern" data-mode="cur"${v.hiddenOld ? '' : ' hidden'}>
      <span class="seg-thumb" aria-hidden="true"></span>
      <button type="button" data-mode="cur" aria-pressed="true">Aktuell</button>
      <button type="button" data-mode="all" aria-pressed="false">Alle (inkl. älter)</button></div>
    <div class="scope">
      <div class="seg" id="scope-seg" role="group" aria-label="Ort" data-scope="${near ? 'near' : 'all'}">
        <span class="seg-thumb" aria-hidden="true"></span>
        <button type="button" data-scope="all" aria-pressed="${!near}">Überall</button>
        <button type="button" data-scope="near" aria-pressed="${near}">In der Nähe</button></div>
      <div class="radius${near ? ' open' : ''}" id="radius"><div><div class="radius-in" role="group" aria-label="Umkreis">
        <span class="radius-l">Umkreis</span>${RADII.map((km) => `<button class="chip rad" type="button" data-km="${km}" aria-pressed="${km === st.radius}">${km} km</button>`).join('')}</div></div></div>
      <p class="near-hint" id="near-hint" role="status" hidden></p></div>
    <div class="list-head"><h2 class="label" id="plist-label">Händler${v.best ? ` · ${v.current.rows.length}` : ''}</h2>
      <button class="chip geo${userPos ? ' on' : ''}" id="geo" type="button">${icon('i-pin')}<span>${userPos ? 'Standort aktiv' : 'Standort nutzen'}</span></button></div></div>`;
}

function renderProduct(p, items, back, near = null, radius = 10) {
  let bodyHtml;
  let st = null;
  if (items === null) {
    bodyHtml = `<div class="state surface">${icon('i-alert', 'state-ico')}<p class="state-t">Preise gerade nicht verfügbar.</p>
      <p class="state-s">Prüfe die Online-Links unten.</p></div>${dailySectionShell()}${nutritionSection(p)}${onlineSection(p)}${footerBlock(p, false)}`;
  } else {
    st = { items, near: near || [], nearRadius: near ? radius : 0, radius, scope: 'all', age: 'cur' };
    const v = priceView(st);
    const toolbar = (v.all.rows.length || userPos) ? toolbarHtml(st, v) : '';
    bodyHtml = `<div id="hero-wrap">${heroFor(v, true, st)}</div>${toolbar}`
      + `<div id="plist" class="plist" aria-live="polite">${listContent(st, v, p)}</div>`
      + dailySectionShell() + nutritionSection(p) + onlineSection(p) + footerBlock(p, !!v.best);
  }
  showSheet(productHead(p), bodyHtml, {
    back,
    onInsert: (h, b) => {
      runCountUps(b);
      settleLogos(b);
      wireProductBody(b, p, st);
      if (p.name && p.name !== 'Unbekanntes Produkt') loadDaily(b, { q: p.name, brand: p.brand, qty: p.quantity }, navToken, st);
      else if (/^\d{8,14}$/.test(p.code)) {
        // Unbekanntes Produkt: per GTIN bei Google Shopping suchen, Titel des ersten Treffers als Namensvorschlag
        loadDaily(b, { gtin: p.code }, navToken, st, { shoppingOnly: true, onList: (list) => {
          const gs = list.filter((r) => r.source === 'google' && r.productName);
          const t = (gs.find((r) => !(r.pack > 1)) || gs[0] || {}).productName;
          const box = $('.ph-t', h);
          if (t && box && !$('.ph-guess', box)) box.insertAdjacentHTML('beforeend', `<p class="ph-guess">Möglicherweise: ${esc(t)}</p>`);
        } });
      }
    },
  });
}

function wireProductBody(b, p, st) {
  wireNutrition(b, p);
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
    if (open) setTimeout(() => card.scrollIntoView({ block: 'nearest', behavior: isReduced() ? 'auto' : 'smooth' }), 260);
  };
  if (!st) return;
  const list = $('#plist', b), heroWrap = $('#hero-wrap', b);
  const ageSeg = $('#age-seg', b), scopeSeg = $('#scope-seg', b), radiusBox = $('#radius', b);
  const hint = $('#near-hint', b), geo = $('#geo', b), label = $('#plist-label', b);
  const p0 = p;

  const showHint = (msg) => { if (!hint) return; hint.textContent = msg || ''; hint.hidden = !msg; };
  const setSegUi = (seg, key, val) => {
    seg.dataset[key] = val;
    seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset[key] === val)));
  };
  const geoUi = () => {
    if (!geo) return;
    $('span', geo).textContent = 'Standort aktiv';
    geo.classList.add('on');
    b.querySelectorAll('a[data-act="all"]').forEach((a) => { a.href = mapsLinkAllBranches(a.dataset.brand, userPos); });
  };

  // Liste + Hero gemäß Auswahl neu zeichnen (Liquid-Fade)
  const render = () => {
    if (!b.isConnected || !list) return;
    const v = priceView(st);
    if (ageSeg) {
      ageSeg.hidden = !v.hiddenOld;
      if (!v.hiddenOld && st.age === 'all') { st.age = 'cur'; setSegUi(ageSeg, 'mode', 'cur'); return render(); }
    }
    if (label) label.textContent = `Händler${v.best ? ` · ${v.current.rows.length}` : ''}`;
    liquidSwap(heroWrap, heroFor(v, false, st), () => { runCountUps(heroWrap); settleLogos(heroWrap); });
    liquidSwap(list, listContent(st, v, p0), () => { runCountUps(list); settleLogos(list); });
  };

  // Umkreis-Abruf: entprellt, laufende Anfrage wird abgebrochen. -> 'ok' | 'stale' | 'fail'
  let seq = 0, ctrl = null;
  const loadNear = async (delay = 0) => {
    const my = ++seq;
    if (ctrl) ctrl.abort();
    const c = ctrl = new AbortController();
    if (delay) await sleep(delay);
    if (my !== seq) return 'stale';
    const radius = st.radius;
    try {
      const got = await getPrices(p0.code, { ...userPos, radiusKm: radius, signal: c.signal });
      if (my !== seq) return 'stale';
      st.near = mergePrices(st.near, got);
      st.nearRadius = Math.max(st.nearRadius, radius);
      return 'ok';
    } catch (e) {
      return my !== seq || (e && e.aborted) ? 'stale' : 'fail';
    }
  };

  const setRadiusUi = () => b.querySelectorAll('.chip.rad').forEach((x) => x.setAttribute('aria-pressed', String(Number(x.dataset.km) === st.radius)));
  const applyScope = (next) => {
    st.scope = next;
    if (scopeSeg) setSegUi(scopeSeg, 'scope', next);
    if (radiusBox) radiusBox.classList.toggle('open', next === 'near');
    render();
  };

  const setScope = async (next) => {
    if (next === st.scope) return;
    haptic(8);
    if (next === 'all') { showHint(''); applyScope('all'); return; }
    if (!userPos) {
      showHint('Standort wird ermittelt …');
      const pos = await requestPos();
      if (!b.isConnected) return;
      if (!pos) {
        showHint('Ohne Standort kann ich keine Preise in der Nähe zeigen. Erlaube den Standortzugriff und tippe es noch einmal an.');
        if (geo) $('span', geo).textContent = 'Standort verweigert';
        return;
      }
      geoUi();
    }
    if (st.nearRadius < st.radius) {
      showHint('Preise in der Nähe werden gesucht …');
      const r = await loadNear(0);
      if (!b.isConnected || r === 'stale') return;
      if (r === 'fail') { showHint('Preise in der Nähe konnten nicht geladen werden.'); return; }
    }
    showHint('');
    applyScope('near');
  };

  const setRadius = (km) => {
    if (!RADII.includes(km) || km === st.radius) return;
    haptic(8);
    st.radius = km;
    saveRadius(km);
    setRadiusUi();
    if (st.scope !== 'near') return;
    list.classList.add('is-loading');
    loadNear(250).then((r) => {
      if (!b.isConnected || r === 'stale') return;
      list.classList.remove('is-loading');
      showHint(r === 'fail' ? 'Umkreis konnte nicht aktualisiert werden.' : '');
      render();
    });
  };

  if (ageSeg) {
    ageSeg.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-mode]');
      if (!btn || btn.dataset.mode === st.age) return;
      haptic(8);
      st.age = btn.dataset.mode;
      setSegUi(ageSeg, 'mode', st.age);
      render();
    });
  }
  if (scopeSeg) scopeSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-scope]');
    if (btn) setScope(btn.dataset.scope);
  });
  if (radiusBox) radiusBox.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-km]');
    if (btn) setRadius(Number(btn.dataset.km));
  });
  // Leerzustand: „25 km“
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-km]');
    if (btn) setRadius(Number(btn.dataset.km));
  });

  if (geo) {
    const lbl = $('span', geo);
    geo.onclick = async () => {
      if (!navigator.geolocation) { lbl.textContent = 'Standort nicht verfügbar'; return; }
      lbl.textContent = 'Standort wird ermittelt …';
      const pos = await requestPos();
      if (!b.isConnected) return;
      if (!pos) { lbl.textContent = 'Standort verweigert'; return; }
      geoUi();
      if (st.nearRadius < st.radius) await loadNear(0);
      render(); // Entfernungen einblenden
    };
  }
}

// ----- KI-Treffer -----
const SHOPS = {
  MediaMarkt: ['#E2001A', 'M'], Saturn: ['#F28C00', 'S'], 'Amazon.de': ['#FF9900', 'a'], eBay: ['#3B7DEB', 'e'],
  idealo: ['#3E8BFF', 'i'], 'Google Shopping': ['#34A853', 'G'], 'geizhals.de': ['#E8730C', 'g'],
};
const SHOP_ORDER = Object.keys(SHOPS);

function loadKiMeta(query) {
  try {
    const m = JSON.parse(sessionStorage.getItem(KI_KEY) || 'null');
    if (m && m.query === query) return m;
  } catch { /* ignorieren */ }
  return null;
}
function saveKiMeta(m) {
  try { sessionStorage.setItem(KI_KEY, JSON.stringify(m)); } catch { /* Thumbnail evtl. zu groß */ try { sessionStorage.setItem(KI_KEY, JSON.stringify({ ...m, thumb: '' })); } catch { /* ignorieren */ } }
}
const safeDataImg = (u) => (/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(u || '') ? u : '');

function kiHead(meta, query) {
  const name = meta && meta.name ? meta.name : query;
  const sub = [meta && meta.brand, meta && meta.category].filter(Boolean).join(' · ');
  const conf = meta && isFinite(meta.confidence) ? Math.round(Math.min(1, Math.max(0, meta.confidence)) * 100) : null;
  const img = safeDataImg(meta && meta.thumb);
  const low = meta && meta.confidence < 0.5;
  return `<div class="ph">${img ? `<span class="thumb lg ki-thumb"><img class="thumb-img" src="${esc(img)}" alt="Ausschnitt der Kamera"></span>` : `<span class="thumb lg">${icon('i-spark')}</span>`}
    <div class="ph-t"><h1 id="sheet-title">${esc(name)}</h1>${sub ? `<p class="ph-s">${esc(sub)}</p>` : ''}
    <p class="ph-c"><span class="badge kibadge${low ? ' low' : ''}">${icon('i-spark')}${meta && meta.source === 'claude' ? 'KI-Treffer' : 'Allgemeine Kategorie'}${conf != null ? ` · ${conf} %` : ''}</span></p></div></div>`;
}

function kiView(query, token) {
  const meta = loadKiMeta(query);
  const links = onlineSearchLinks(query).filter((l) => SHOP_ORDER.includes(l.label));
  const shops = links.map((l, i) => {
    const [color, ini] = SHOPS[l.label];
    return `<a class="shop stagger surface" style="--i:${i}; --sc:${color}" href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener">
      <span class="shop-dot" aria-hidden="true">${esc(ini)}</span><span class="shop-n">${esc(l.label)}<small>${esc(query)}</small></span>${icon('i-ext', 'shop-go')}</a>`;
  }).join('');
  const dpMeta = meta && meta.source === 'coco' ? null : { q: (meta && meta.name) || query, brand: (meta && meta.brand) || '' };
  const bodyHtml = `${dpMeta ? dailySectionShell('first', '--i:0') : ''}<section class="block${dpMeta ? '' : ' first'}"><h2 class="label">Preise bei Händlern</h2><div class="shops">${shops}</div>
    <p class="hint-s">Echtzeitpreise der Händler werden auf deren Seiten angezeigt.</p></section>
    <section class="block stagger" style="--i:8"><h2 class="label">Passende Produkte in der Datenbank</h2>
    <div id="ki-db" class="ki-db"><div class="skeleton"><div class="sk sk-row"></div><div class="sk sk-row"></div></div></div></section>
    <div class="foot"><p>Der Treffer stammt aus einer automatischen Bilderkennung und kann abweichen.</p></div>`;
  showSheet(kiHead(meta, query), bodyHtml, { snap: 'full', back: false, onInsert: async (h, b) => {
    const box = $('#ki-db', b);
    if (dpMeta) loadDaily(b, dpMeta, token, null);
    try {
      const list = (await searchProducts(query)).slice(0, 8);
      if (token !== navToken || !box.isConnected) return;
      box.innerHTML = list.length ? `<ul class="list">${list.map(productItem).join('')}</ul>`
        : `<div class="state surface slim"><p class="state-s">Keine passenden Produkte gefunden.</p></div>`;
    } catch (e) {
      if (token !== navToken || !box.isConnected) return;
      box.innerHTML = `<div class="state surface slim"><p class="state-s">${esc(errText(e))}</p></div>`;
    }
  } });
}

// ----- Einstellungen -----
function settingsView() {
  const ep = getAiEndpoint();
  const bodyHtml = `<div class="set">
    <div class="status-row">
      <div id="set-status" class="status-chip"><i></i><span>KI-Erkennung: aus</span></div>
      <div id="set-status-p" class="status-chip"><i></i><span>Tagespreise: aus</span></div>
      <div id="set-status-s" class="status-chip"><i></i><span>Echtzeitpreise: aus</span></div>
    </div>
    <p class="set-p">Ohne eigenen Server erkennt ScanDeals nur allgemeine Kategorien direkt auf dem Handy. Mit einem eigenen Cloudflare Worker erkennt Claude das genaue Produktmodell, und der Server holt Echtzeitpreise aus Google Shopping sowie tagesaktuelle Preise aus Onlineshops – deine Daten laufen dann nur über deinen Server.</p>
    <form id="set-form" autocomplete="off" novalidate>
      <label class="field-l" for="ai-url">ScanDeals-Server (Cloudflare Worker)</label>
      <input id="ai-url" class="field" type="url" inputmode="url" placeholder="https://scandeals-ai.name.workers.dev" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(ep)}">
      <div id="set-result" class="set-result" role="status" aria-live="polite"></div>
      <div class="set-actions">
        <button id="set-test" class="btn glass-btn" type="button">${icon('i-refresh')}Verbindung testen</button>
        <button id="set-save" class="btn primary" type="submit">${icon('i-check')}Speichern</button>
      </div>
      <button id="set-remove" class="chip" type="button" ${ep ? '' : 'hidden'}>${icon('i-close')}Entfernen</button>
    </form>
    <a class="link" href="${esc(WORKER_DOCS)}" target="_blank" rel="noopener">Anleitung: Server einrichten ${icon('i-ext')}</a>
  </div>`;
  showSheet(simpleHead('Einstellungen', 'KI-Erkennung, Echtzeit- und Tagespreise'), bodyHtml, { snap: 'full', onInsert: (h, b) => wireSettings(b) });
}

function wireSettings(b) {
  const input = $('#ai-url', b), res = $('#set-result', b), chip = $('#set-status', b);
  const show = (kind, msg) => { res.className = 'set-result ' + kind; res.textContent = msg; };
  const chipP = $('#set-status-p', b), chipS = $('#set-status-s', b);
  const setChip = (c, label, state) => { // state: true | false | 'busy' | 'down'
    c.classList.toggle('on', state === true);
    c.classList.toggle('busy', state === 'busy');
    $('span', c).textContent = `${label}: ${state === 'busy' ? 'prüfe …' : state === 'down' ? 'nicht erreichbar' : state ? 'aktiv' : 'aus'}`;
  };
  let chipSeq = 0;
  const refreshChip = async (force = false) => {
    const ep = getAiEndpoint();
    $('#set-remove', b).hidden = !ep;
    updateAiState();
    const my = ++chipSeq;
    if (!ep) { setChip(chip, 'KI-Erkennung', false); setChip(chipP, 'Tagespreise', false); setChip(chipS, 'Echtzeitpreise', false); return; }
    setChip(chip, 'KI-Erkennung', 'busy'); setChip(chipP, 'Tagespreise', 'busy'); setChip(chipS, 'Echtzeitpreise', 'busy');
    let h = null;
    try { h = await getServerHealth(ep, { force }); } catch { /* Server nicht erreichbar */ }
    if (my !== chipSeq || !b.isConnected) return;
    setChip(chip, 'KI-Erkennung', h && h.ok ? h.ai : 'down');
    setChip(chipP, 'Tagespreise', h && h.ok ? h.prices : 'down');
    setChip(chipS, 'Echtzeitpreise', h && h.ok ? h.shopping : 'down');
  };
  refreshChip();
  const read = () => normalizeEndpoint(input.value);
  $('#set-test', b).onclick = async () => {
    const url = read();
    if (!isValidEndpoint(url)) { show('err', 'Bitte eine gültige https://-Adresse eintragen.'); return; }
    show('busy', 'Verbindung wird getestet …');
    haptic(8);
    try {
      const d = await getServerHealth(url, { force: true });
      if (d && d.ok) {
        const parts = [`KI ${d.ai ? 'aktiv' : 'aus'}`, `Tagespreise ${d.prices ? 'aktiv' : 'aus'}`, `Echtzeitpreise ${d.shopping ? 'aktiv' : 'aus'}`];
        show('ok', `Verbindung ok${d.model ? ' · Modell ' + d.model : ''}${d.configured === false ? ' · Schlüssel fehlt noch' : ''} · ${parts.join(' · ')}`);
      }
      else show('err', 'Der Server antwortet, ist aber kein ScanDeals-KI-Server.');
    } catch (e) {
      show('err', e && e.timeout ? 'Keine Antwort (Zeitüberschreitung).' : 'Server nicht erreichbar. Prüfe die Adresse und CORS-Einstellungen.');
    }
  };
  $('#set-form', b).onsubmit = (e) => {
    e.preventDefault();
    const url = read();
    if (!url) { setAiEndpoint(''); input.value = ''; show('ok', 'Gratis-Modus aktiv.'); refreshChip(); return; }
    if (!isValidEndpoint(url)) { show('err', 'Bitte eine gültige https://-Adresse eintragen.'); return; }
    setAiEndpoint(url); input.value = url; haptic([12, 40, 18]);
    show('ok', 'Gespeichert.'); refreshChip(true);
  };
  $('#set-remove', b).onclick = () => { setAiEndpoint(''); input.value = ''; show('ok', 'Entfernt – Gratis-Modus aktiv.'); refreshChip(); haptic(8); };
}

function updateAiState() { document.documentElement.classList.toggle('ai-on', !!getAiEndpoint()); }

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
  const m = hash.match(/^#\/(suche|produkt|ki)\/(.+)$/);
  const kind = m ? m[1] : hash === '#/verlauf' ? 'verlauf' : hash === '#/einstellungen' ? 'einstellungen' : 'home';
  if (kind !== 'home') {
    if (['starting', 'scanning', 'hit'].includes(vf.dataset.state)) { endLive(); setVf('paused'); }
    if (m) {
      let arg = m[2];
      try { arg = decodeURIComponent(m[2]); } catch { /* roh lassen */ }
      if (m[1] === 'suche') searchView(arg, token);
      else if (m[1] === 'ki') kiView(arg, token);
      else productView(arg, token);
    } else if (kind === 'einstellungen') settingsView();
    else historyView();
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
$('#settings-btn').addEventListener('click', () => { location.hash = '#/einstellungen'; });
window.addEventListener('hashchange', route);

// ---------- Scanner-UI ----------
const vf = $('#vf');
const video = $('#video');
let scanId = 0;
let torchOn = false;
let hintTimer = 0;

const HINTS = { auto: 'Barcode oder Produkt in den Rahmen halten', barcode: 'Barcode in den Rahmen halten', objekt: 'Halte ein Produkt vor die Kamera' };

/** Hinweis-Pille oben im Viewfinder; kind: '' | 'obj' | 'bar' | 'warn'. Fällt nach ms auf den Standard-Hinweis zurück. */
function setHint(text, kind = '', ms = 0) {
  const h = $('#vf-hint'), t = $('#vf-hint-t');
  clearTimeout(hintTimer);
  if (t.textContent !== text || h.dataset.kind !== kind) {
    t.textContent = text; h.dataset.kind = kind;
    h.classList.remove('bump'); void h.offsetWidth; if (!isReduced()) h.classList.add('bump');
  }
  if (ms) hintTimer = setTimeout(() => setHint(defaultHint()), ms);
}
const defaultHint = () => (vf.dataset.state === 'starting' ? 'Kamera wird gestartet …' : HINTS[getMode()]);

function setVf(state, extra) {
  vf.dataset.state = state;
  if (state === 'paused') $('#start-label').textContent = 'Erneut scannen';
  else if (state === 'idle') $('#start-label').textContent = 'Scannen starten';
  $('#idle-title').textContent = state === 'paused' ? 'Nächster Scan' : 'Produkt scannen';
  setHint(defaultHint());
  if (state === 'error') $('#vf-error-text').textContent = extra || 'Scan fehlgeschlagen.';
  if (state !== 'scanning') { torchOn = false; $('#torch-btn').hidden = true; $('#torch-btn').setAttribute('aria-pressed', 'false'); }
}

const codeLabel = (c) => (/^\d{13}$/.test(c) ? 'EAN' : /^\d{8}$/.test(c) ? 'EAN-8' : /^\d{12}$/.test(c) ? 'UPC' : 'Code') + ' ' + c;

/** Kamera, Barcode-Schleife und KI-Sitzung beenden. */
function endLive() {
  scanId++;
  kiKill();
  stopScanner();
}
const kiKill = () => { kiStop(); };

/** Schaltet Barcode-Schleife/KI gemäß Modus ein oder aus (Kamera bleibt offen und wird geteilt). */
function applyMode() {
  const m = getMode();
  vf.dataset.mode = m;
  $('#mode-seg').dataset.mode = m;
  $('#mode-seg').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.mode === m)));
  if (vf.dataset.state !== 'scanning') return;
  const id = scanId;
  if (m !== 'objekt') {
    startBarcodeLoop(video, (code) => onBarcode(code, id), (msg) => {
      if (id !== scanId) return;
      if (getMode() === 'barcode') setVf('error', msg); else setHint(msg, 'warn', 4000);
    });
  } else stopBarcodeLoop();
  if (m !== 'barcode') kiStart(); else kiKill();
  setHint(defaultHint());
}

async function onBarcode(code, id) {
  if (id !== scanId) return;
  kiKill();
  $('#vf-chip').textContent = codeLabel(code);
  vf.dataset.state = 'hit';
  setHint('Barcode erkannt', 'bar');
  $('#torch-btn').hidden = true;
  haptic([12, 40, 18]);
  video.pause();
  await sleep(isReduced() ? 250 : 800);
  if (id !== scanId) return;
  stopScanner();
  location.hash = `#/produkt/${encodeURIComponent(code)}`;
}

async function startScan() {
  const id = ++scanId;
  setVf('starting');
  haptic(8);
  try {
    await openCamera(video);
    if (id !== scanId) return;
    setVf('scanning');
    $('#torch-btn').hidden = !hasTorch();
    applyMode();
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    if (id === scanId) setVf('error', e.message);
  }
}
function stopScan() {
  endLive();
  setVf('paused');
}
$('#start-btn').addEventListener('click', startScan);
$('#retry-scan').addEventListener('click', startScan);
$('#stop-btn').addEventListener('click', stopScan);
$('#torch-btn').addEventListener('click', async () => {
  const ok = await setTorch(!torchOn);
  if (ok) { torchOn = !torchOn; $('#torch-btn').setAttribute('aria-pressed', String(torchOn)); haptic(8); }
});
$('#mode-seg').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn || !MODES.includes(btn.dataset.mode) || btn.dataset.mode === getMode()) return;
  setMode(btn.dataset.mode);
  haptic(8);
  applyMode();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && ['starting', 'scanning'].includes(vf.dataset.state)) stopScan();
});

// KI-Sitzung: Bestätigung → Route #/ki/… (oder direkt Preisansicht bei Barcode)
initKi({
  video,
  shouldRun: () => vf.dataset.state === 'scanning' && !isOpen() && !document.hidden,
  setHint,
  onConfirm: (p) => {
    stopScan();
    if (p.barcode) { location.hash = `#/produkt/${encodeURIComponent(p.barcode)}`; return; }
    saveKiMeta(p);
    location.hash = `#/ki/${encodeURIComponent(p.query)}`;
  },
});
applyMode();
updateAiState();

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
