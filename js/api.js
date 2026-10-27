// ScanDeals – Datenzugriff und reine Hilfsfunktionen
export const OFF_FIELDS = 'code,product_name,product_name_de,brands,quantity,image_front_small_url';
export const OFF_FIELDS_DETAIL = OFF_FIELDS + ',nutriments,nutrition_data_per,serving_size,serving_quantity';
// API v3.6 (Produktabruf per Barcode); nutrition = neue Nährwert-Struktur, selected_images = Bild-URLs
export const API_V3_BASE = 'https://world.openfoodfacts.org/api/v3.6/product';
export const OFF_FIELDS_V3 = 'code,product_name,product_name_de,brands,quantity,serving_size,serving_quantity,serving_quantity_unit,nutrition,selected_images,image_front_small_url';
export const V3_TIMEOUT_MS = 8000;
export const PRODUCT_HOSTS = [
  'https://world.openfoodfacts.org',
  'https://world.openproductsfacts.org',
  'https://world.openbeautyfacts.org',
];
export const PRICES_URL = 'https://prices.openfoodfacts.org/api/v1/prices';
export const TIMEOUT_MS = 12000;
const MAX_AGE_MONTHS = 12;

export async function fetchJson(url, timeout = TIMEOUT_MS, signal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) {
      const err = new Error('HTTP ' + res.status);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } catch (e) {
    if (e && e.name === 'AbortError') {
      const err = new Error(signal && signal.aborted ? 'Abgebrochen' : 'Zeitüberschreitung');
      err.timeout = !(signal && signal.aborted);
      err.aborted = !!(signal && signal.aborted);
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Frontbild: v3 selected_images.front.best (200/400/100) → image_front_small_url → leer. */
function frontImage(p) {
  const best = p && p.selected_images && p.selected_images.front && p.selected_images.front.best;
  if (best && typeof best === 'object') {
    for (const size of ['200', '400', '100']) {
      if (typeof best[size] === 'string' && best[size]) return best[size];
    }
  }
  return typeof p.image_front_small_url === 'string' ? p.image_front_small_url : '';
}

export function normalizeProduct(p) {
  if (!p || !p.code) return null;
  const name = (p.product_name_de || p.product_name || '').trim();
  const brand = String(p.brands || '').split(',')[0].trim();
  return {
    code: String(p.code),
    name: name || 'Unbenanntes Produkt',
    brand,
    quantity: String(p.quantity || '').trim(),
    image: frontImage(p),
    nutrition: extractNutrition(p),
  };
}

// ---------- Nährwerte ----------
const NUTRI_ROWS = [
  ['fat', 'Fett', 0], ['saturated-fat', 'davon gesättigte Fettsäuren', 1],
  ['carbohydrates', 'Kohlenhydrate', 0], ['sugars', 'davon Zucker', 1],
  ['fiber', 'Ballaststoffe', 0], ['proteins', 'Eiweiß', 0], ['salt', 'Salz', 0],
];

function nutriNum(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}
function macroVal(n, max) { return n !== null && n >= 0 && n <= max ? n : null; }

/** Nährwerte aus einem OFF-Produkt (API v3.6 `nutrition` oder altes v2 `nutriments`); null, wenn nichts Brauchbares da ist. */
export function extractNutrition(p) {
  if (!p || typeof p !== 'object') return null;
  if (p.nutrition && typeof p.nutrition === 'object') {
    const v3 = extractNutritionV3(p);
    if (v3) return v3;
  }
  return extractNutritionV2(p);
}

/** Altes v2-Format (`nutriments` mit *_100g / *_serving). */
function extractNutritionV2(p) {
  const n = p && typeof p === 'object' ? p.nutriments : null;
  if (!n || typeof n !== 'object') return null;
  const isMl = /(^|[\d\s.,])\s*(ml|cl|l)\s*\.?$/i.test(String(p.quantity || '').trim());
  const sq = nutriNum(p.serving_quantity);
  const maxS = sq !== null && sq > 0 ? sq : 1000; // Portion kann nicht mehr Makros enthalten als ihre Menge
  const rows = [];
  // Energie
  const energy = (suffix, max) => {
    const kcal = macroVal(nutriNum(n['energy-kcal' + suffix]), 9 * max);
    let kj = nutriNum(n['energy-kj' + suffix]);
    if (kj === null) kj = nutriNum(n['energy' + suffix]);
    kj = macroVal(kj, 38 * max);
    return kcal === null && kj === null ? null : { kj, kcal };
  };
  const e100 = energy('_100g', 100), eS = energy('_serving', maxS);
  if (e100 || eS) rows.push({ key: 'energy', label: 'Energie', unit: 'kJ/kcal', per100: e100, perServing: eS, indent: false });
  for (const [key, label, ind] of NUTRI_ROWS) {
    const a = macroVal(nutriNum(n[key + '_100g']), 100);
    const b = macroVal(nutriNum(n[key + '_serving']), maxS);
    if (a !== null || b !== null) rows.push({ key, label, unit: 'g', per100: a, perServing: b, indent: !!ind });
  }
  if (!rows.length) return null;
  const hasServing = rows.some((r) => r.perServing !== null);
  return {
    per: isMl ? '100ml' : '100g',
    serving: hasServing ? String(p.serving_size || '').trim() : '',
    rows,
  };
}

// ---------- Nährwerte: API v3.6 (nutrition.aggregated_set / input_sets) ----------
const KJ_PER_KCAL = 4.184;
const MODIFIERS = ['<', '<=', '~', '>=', '>'];
const MASS_FACTOR = new Map([['', 1], ['g', 1], ['mg', 1e-3], ['µg', 1e-6], ['μg', 1e-6], ['ug', 1e-6], ['mcg', 1e-6], ['kg', 1000]]);
const SOURCE_RANK = { manufacturer: 0, packaging: 1 };

function v3Raw(nut) {
  if (!nut || typeof nut !== 'object') return null;
  const v = nutriNum(nut.value);
  if (v !== null) return v;
  const c = nutriNum(nut.value_computed);
  if (c !== null) return c;
  // Notfalls den eingegebenen Text lesen, z. B. "0,5" oder "< 0.1"
  if (typeof nut.value_string === 'string') {
    const m = nut.value_string.replace(',', '.').match(/-?\d+(?:\.\d+)?/);
    if (m) return nutriNum(m[0]);
  }
  return null;
}
function v3Mod(nut) { return MODIFIERS.includes(nut && nut.modifier) ? nut.modifier : undefined; }
function unitOf(nut) { return String(nut.unit == null ? '' : nut.unit).trim().toLowerCase(); }

/** Masse in g; normalized = Einheiten bereits normalisiert (aggregated_set). Nutzer-Einheiten (input_sets) werden umgerechnet, unbekannte (dv, %, …) verworfen. */
function v3Mass(nut, normalized) {
  const v = v3Raw(nut);
  if (v === null) return null;
  if (normalized) return { n: v, mod: v3Mod(nut) };
  const f = MASS_FACTOR.get(unitOf(nut));
  return f === undefined ? null : { n: v * f, mod: v3Mod(nut) };
}

function v3Energy(nuts, normalized, max) {
  let kj = null, kcal = null, mod;
  for (const id of ['energy-kj', 'energy', 'energy-kcal']) {
    const nut = nuts[id];
    const v = v3Raw(nut);
    if (v === null) continue;
    let kind = id === 'energy-kcal' ? 'kcal' : 'kj';
    if (!normalized) {
      const u = unitOf(nut);
      if (u === 'kcal') kind = 'kcal';
      else if (u === 'kj') kind = 'kj';
      else if (u !== '') continue;
    }
    if (kind === 'kj' && kj === null) { kj = v; mod = mod || v3Mod(nut); }
    else if (kind === 'kcal' && kcal === null) { kcal = v; mod = mod || v3Mod(nut); }
  }
  if (kcal === null && kj !== null) kcal = Math.round(kj / KJ_PER_KCAL);
  else if (kj === null && kcal !== null) kj = Math.round(kcal * KJ_PER_KCAL);
  kcal = macroVal(kcal, 9 * max);
  kj = macroVal(kj, 38 * max);
  return kcal === null && kj === null ? null : { value: { kj, kcal }, mod };
}

/** Liest einen Nährwertsatz → Map key → {value, mod}; max = größte plausible Menge in g. */
function v3ReadSet(set, normalized, max) {
  const nuts = set && typeof set.nutrients === 'object' && set.nutrients ? set.nutrients : {};
  const out = new Map();
  const e = v3Energy(nuts, normalized, max);
  if (e) out.set('energy', e);
  for (const [key] of NUTRI_ROWS) {
    let m = v3Mass(nuts[key], normalized);
    if (m === null && key === 'salt') {
      const na = v3Mass(nuts.sodium, normalized);
      if (na) m = { n: na.n * 2.5, mod: na.mod };
    }
    const n = m ? macroVal(m.n, max) : null;
    if (n !== null) out.set(key, { value: n, mod: m.mod });
  }
  return out;
}

function setRank(s) { return SOURCE_RANK[s && s.source] ?? 2; }
function usableSets(p, pred) {
  const sets = p.nutrition && Array.isArray(p.nutrition.input_sets) ? p.nutrition.input_sets : [];
  return sets.filter((s) => s && typeof s === 'object' && (s.preparation === undefined || s.preparation === null || s.preparation === 'as_sold') && pred(s))
    .sort((a, b) => setRank(a) - setRank(b)); // Array.sort ist stabil
}

function fmtQty(q) { return String(Math.round(q * 100) / 100).replace('.', ','); }

function extractNutritionV3(p) {
  const nu = p.nutrition;
  const isMl = /(^|[\d\s.,])\s*(ml|cl|l)\s*\.?$/i.test(String(p.quantity || '').trim());
  let per = isMl ? '100ml' : '100g';
  // pro 100 g/ml
  let base = null;
  const agg = nu.aggregated_set;
  if (agg && typeof agg === 'object') {
    const m = v3ReadSet(agg, true, 100);
    if (m.size) {
      base = m;
      if (agg.per === '100g' || agg.per === '100ml') per = agg.per;
    }
  }
  if (!base) {
    for (const s of usableSets(p, (x) => x.per === '100g' || x.per === '100ml')) {
      const m = v3ReadSet(s, false, 100);
      if (m.size) { base = m; per = s.per; break; }
    }
  }
  // pro Portion
  let serv = null, label = '', computed = false;
  for (const s of usableSets(p, (x) => x.per === 'serving')) {
    const pq = nutriNum(s.per_quantity);
    const m = v3ReadSet(s, false, pq !== null && pq > 0 ? pq : 1000);
    if (!m.size) continue;
    serv = m;
    if (pq !== null && pq > 0 && typeof s.per_unit === 'string' && s.per_unit.trim()) label = `${fmtQty(pq)} ${s.per_unit.trim()}`;
    break;
  }
  if (!serv && base) {
    const sq = nutriNum(p.serving_quantity);
    const su = String(p.serving_quantity_unit == null ? '' : p.serving_quantity_unit).trim().toLowerCase();
    if (sq !== null && sq > 0 && (su === '' || su === 'g' || su === 'ml')) {
      const f = sq / 100;
      const r3 = (x) => (x === null ? null : Math.round(x * f * 1000) / 1000);
      serv = new Map();
      for (const [k, { value, mod }] of base) {
        const v = k === 'energy' ? { kj: r3(value.kj), kcal: r3(value.kcal) } : r3(value);
        serv.set(k, { value: v, mod });
      }
      computed = true;
      label = String(p.serving_size || '').trim() || `${fmtQty(sq)} ${su || (isMl ? 'ml' : 'g')}`;
    }
  }
  const rows = [];
  const add = (key, lbl, unit, indent) => {
    const a = base && base.get(key), b = serv && serv.get(key);
    if (!a && !b) return;
    const row = { key, label: lbl, unit, per100: a ? a.value : null, perServing: b ? b.value : null, indent };
    if (a && a.mod) row.per100Mod = a.mod;
    if (b && b.mod) row.perServingMod = b.mod;
    rows.push(row);
  };
  add('energy', 'Energie', 'kJ/kcal', false);
  for (const [key, lbl, ind] of NUTRI_ROWS) add(key, lbl, 'g', !!ind);
  if (!rows.length) return null;
  const hasServing = rows.some((r) => r.perServing !== null);
  const res = { per, serving: hasServing ? (label || String(p.serving_size || '').trim()) : '', rows };
  if (hasServing && computed) res.servingComputed = true;
  return res;
}

/** Deutsche Zahlenformatierung für Nährwert-Zellen; null/undefined → „–“. mod = optionaler Modifier (<, <=, ~, >=, >). */
export function formatNutrient(row, v, mod) {
  if (v === null || v === undefined) return '–';
  const sym = mod ? ({ '<=': '≤', '>=': '≥' }[mod] || mod) + ' ' : '';
  if (row.key === 'energy') {
    const part = (x, u) => (x === null ? '' : `${Math.round(x).toLocaleString('de-DE')} ${u}`);
    return sym + [part(v.kj, 'kJ'), part(v.kcal, 'kcal')].filter(Boolean).join(' / ');
  }
  if (mod) return `${sym}${new Intl.NumberFormat('de-DE', { maximumFractionDigits: v < 1 ? 2 : 1 }).format(v)} g`;
  if (v > 0 && v < 0.1) return '< 0,1 g';
  return `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(v)} g`;
}

/**
 * Produkt per Barcode über OFF API v3.6. 404 / status "failure" → null (echtes „nicht gefunden“).
 * Netzwerkfehler, Timeout, 5xx oder unerwartetes Format → Ausnahme (getProduct fällt dann auf v2 zurück).
 */
export async function getProductV3(code) {
  let data;
  try {
    data = await fetchJson(`${API_V3_BASE}/${encodeURIComponent(code)}?product_type=all&lc=de&cc=de&fields=${OFF_FIELDS_V3}`, V3_TIMEOUT_MS);
  } catch (e) {
    if (e && e.status === 404) return null;
    throw e;
  }
  const ok = ['success', 'success_with_warnings', 'success_with_errors'];
  if (!data || typeof data !== 'object' || typeof data.status !== 'string') throw new Error('Unerwartetes Antwortformat (v3.6)');
  if (data.status === 'failure') return null;
  if (!ok.includes(data.status) || !data.product || typeof data.product !== 'object') throw new Error('Unerwartetes Antwortformat (v3.6)');
  return normalizeProduct({ ...data.product, code: data.product.code || code });
}

/** Produkt per Barcode; null wenn in keiner Datenbank gefunden. v3.6, bei technischen Fehlern Fallback auf v2. */
export async function getProduct(code) {
  try {
    return await getProductV3(code);
  } catch {
    return getProductV2(code);
  }
}

/** Bisheriger Abruf über API v2 (drei Hosts); Fallback für getProduct. */
export async function getProductV2(code) {
  let lastErr = null;
  let anySuccess = false;
  for (const host of PRODUCT_HOSTS) {
    try {
      const data = await fetchJson(`${host}/api/v2/product/${encodeURIComponent(code)}.json?fields=${OFF_FIELDS_DETAIL}`);
      anySuccess = true;
      if (data && data.status === 1 && data.product) {
        return normalizeProduct({ code, ...data.product, code: data.product.code || code });
      }
    } catch (e) {
      lastErr = e;
      if (e.status === 404) anySuccess = true;
    }
  }
  if (!anySuccess && lastErr) throw lastErr;
  return null;
}

// Volltextsuche: v2/v3 bieten keine (laut OFF-Doku, ref-cheatsheet), daher weiter die klassische Suche /cgi/search.pl.
export async function searchProducts(q) {
  const url = `${PRODUCT_HOSTS[0]}/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=20&fields=${OFF_FIELDS}&countries_tags_en=germany`;
  const data = await fetchJson(url);
  return ((data && data.products) || []).map(normalizeProduct).filter(Boolean);
}

/**
 * Preise zu einem Barcode (Open Prices API v1). Duplikate werden serverseitig
 * (duplicate_of__isnull=true) und zur Sicherheit clientseitig ausgeblendet.
 * Mit {lat, lon, radiusKm} nur Preise an OSM-Orten im Umkreis (greift nur, wenn alle drei gesetzt sind).
 */
export async function getPrices(code, { lat, lon, radiusKm, signal } = {}) {
  let url = `${PRICES_URL}?product_code=${encodeURIComponent(code)}&duplicate_of__isnull=true&order_by=-date&size=100`;
  if (isFinite(lat) && isFinite(lon) && isFinite(radiusKm) && lat !== null && lon !== null && radiusKm !== null) {
    url += `&lat=${roundCoord(lat)}&lon=${roundCoord(lon)}&radius_km=${encodeURIComponent(radiusKm)}`;
  }
  const data = await fetchJson(url, TIMEOUT_MS, signal);
  return dropDuplicates((data && data.items) || []);
}

// ---------- reine Funktionen ----------

export const roundCoord = (v) => Math.round(Number(v) * 1000) / 1000;

/** Verwirft als Duplikat markierte Preise (duplicate_of gesetzt). */
export function dropDuplicates(items) {
  return (Array.isArray(items) ? items : []).filter((it) => it && it.duplicate_of == null);
}

/** Führt Preislisten zusammen; gleiche Preis-`id` nur einmal (erste Fundstelle gewinnt), Duplikate verworfen. */
export function mergePrices(...lists) {
  const seen = new Set();
  const out = [];
  for (const it of dropDuplicates([].concat(...lists.map((l) => l || [])))) {
    if (it.id != null) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
    }
    out.push(it);
  }
  return out;
}

/** Luftlinie in km (Haversine); NaN bei ungültigen Koordinaten. */
export function haversineKm(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some((v) => v == null || v === '' || !isFinite(Number(v)))) return NaN;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** „850 m“ unter 1 km, sonst „1,2 km“ (ab 10 km ohne Nachkommastelle). */
export function formatDistance(km) {
  if (!isFinite(km) || km < 0) return '';
  if (km < 1) return `${Math.max(10, Math.round((km * 1000) / 10) * 10)} m`.replace(/^1000 m$/, '1,0 km');
  if (km < 10) return `${(Math.round(km * 10) / 10).toFixed(1).replace('.', ',')} km`;
  return `${Math.round(km)} km`;
}

/** Nur https-URLs (Logos); sonst leer. */
export function safeHttps(u) {
  return /^https:\/\/[^\s"'<>]+$/i.test(u || '') ? u : '';
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export function retailerName(item) {
  const l = (item && item.location) || {};
  return (l.osm_brand || l.osm_name || hostOf(l.website_url) || 'Unbekannter Händler').trim();
}

function monthsAgo(now, n) {
  const d = new Date(now);
  d.setMonth(d.getMonth() - n);
  return d;
}

/**
 * Gruppiert pro Händler (neuester Preis), blendet ggf. Einträge > 12 Monate aus,
 * sortiert günstig → teuer. Rückgabe: {rows, hiddenOld}
 */
export function aggregatePrices(items, { includeOld = false, now = new Date(), userPos = null, maxKm = null } = {}) {
  const groups = new Map();
  const hasPos = !!userPos && isFinite(userPos.lat) && isFinite(userPos.lon);
  for (const it of items || []) {
    if (it && it.duplicate_of != null) continue;
    if (maxKm != null) {
      // „In der Nähe“: nur OSM-Orte mit Koordinaten innerhalb des Radius
      const l = it && it.location;
      if (!hasPos || !l || l.type === 'ONLINE') continue;
      const d = haversineKm(userPos.lat, userPos.lon, l.osm_lat, l.osm_lon);
      if (!isFinite(d) || d > maxKm) continue;
    }
    const price = Number(it && it.price);
    if (!it || !isFinite(price) || it.price === null || it.price === '') continue;
    const key = retailerName(it).toLowerCase();
    const ts = Date.parse(it.date) || 0;
    const cur = groups.get(key);
    if (!cur || ts > cur.ts) groups.set(key, { it, ts, price });
  }
  const limit = monthsAgo(now, MAX_AGE_MONTHS).getTime();
  const all = [...groups.values()].map(({ it, ts, price }) => {
    const l = it.location || {};
    return {
      name: retailerName(it),
      brand: l.osm_brand || '',
      price,
      currency: it.currency || 'EUR',
      date: it.date || '',
      ts,
      discounted: !!it.price_is_discounted && it.price_without_discount != null,
      priceWithout: it.price_without_discount != null ? Number(it.price_without_discount) : null,
      type: l.type === 'ONLINE' ? 'ONLINE' : 'OSM',
      city: [l.osm_address_postcode, l.osm_address_city].filter(Boolean).join(' '),
      lat: l.osm_lat, lon: l.osm_lon,
      logo: safeHttps(l.osm_brand_logo_url),
      distanceKm: hasPos && l.type !== 'ONLINE' ? haversineKm(userPos.lat, userPos.lon, l.osm_lat, l.osm_lon) : NaN,
      url: l.website_url || '',
      isOld: ts < limit,
    };
  });
  const hiddenOld = all.filter(r => r.isOld).length;
  const rows = (includeOld ? all : all.filter(r => !r.isOld))
    .sort((a, b) => a.price - b.price || b.ts - a.ts);
  return { rows, hiddenOld };
}

export function formatPrice(value, currency = 'EUR') {
  try {
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(value);
  } catch {
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value);
  }
}

export function formatDate(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function relativeDate(dateStr, now = new Date()) {
  const d = new Date(dateStr);
  if (isNaN(d)) return '';
  const days = Math.floor((now - d) / 86400000);
  if (days <= 0) return 'heute';
  if (days === 1) return 'gestern';
  if (days < 30) return `vor ${days} Tagen`;
  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? 'vor 1 Monat' : `vor ${months} Monaten`;
  const years = Math.floor(days / 365);
  return years === 1 ? 'vor 1 Jahr' : `vor ${years} Jahren`;
}

// ---------- Link-Builder ----------

export function mapsLinkForBranch(lat, lon) {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
}

export function mapsLinkAllBranches(brand, userPos) {
  if (userPos && isFinite(userPos.lat) && isFinite(userPos.lon)) {
    return `https://www.google.com/maps/search/${encodeURIComponent(brand)}/@${userPos.lat},${userPos.lon},13z`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(brand + ' Filiale')}`;
}

export function onlineSearchLinks(name, code) {
  const q = encodeURIComponent((name || code || '').trim());
  const c = encodeURIComponent(code || name || '');
  return [
    { label: 'MediaMarkt', url: `https://www.mediamarkt.de/de/search.html?query=${q}` },
    { label: 'Saturn', url: `https://www.saturn.de/de/search.html?query=${q}` },
    { label: 'Amazon.de', url: `https://www.amazon.de/s?k=${q}` },
    { label: 'eBay', url: `https://www.ebay.de/sch/i.html?_nkw=${q}` },
    { label: 'idealo', url: `https://www.idealo.de/preisvergleich/MainSearchProductCategory.html?q=${q}` },
    { label: 'Google Shopping', url: `https://www.google.com/search?tbm=shop&q=${q}` },
    { label: 'geizhals.de', url: `https://geizhals.de/?fs=${q}` },
    ...(code && name ? [{ label: 'Barcode ' + code + ' (Google Shopping)', url: `https://www.google.com/search?tbm=shop&q=${c}` }] : []),
  ];
}

/**
 * KI-Produkterkennung über den eigenen Worker: POST {endpoint}/identify.
 * Liefert {is_product, name, brand, model, category, confidence, search_query, barcode}.
 */
export async function identifyProduct(endpoint, { image, hint } = {}, { timeout = 20000, signal } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  try {
    const res = await fetch(`${endpoint}/identify`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(hint ? { image, hint } : { image }),
    });
    let data = null;
    try { data = await res.json(); } catch { /* kein JSON */ }
    if (!res.ok) {
      const err = new Error((data && typeof data.error === 'string' && data.error) || 'HTTP ' + res.status);
      err.status = res.status;
      throw err;
    }
    if (!data || typeof data !== 'object') throw new Error('Ungültige Antwort');
    return data;
  } catch (e) {
    if (e && e.name === 'AbortError') {
      const err = new Error(signal && signal.aborted ? 'Abgebrochen' : 'Zeitüberschreitung');
      err.timeout = !(signal && signal.aborted);
      err.aborted = !!(signal && signal.aborted);
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export function reportPriceLink(code) {
  return `https://prices.openfoodfacts.org/prices/add/single?code=${encodeURIComponent(code)}`;
}
