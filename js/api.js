// ScanDeals – Datenzugriff und reine Hilfsfunktionen
export const OFF_FIELDS = 'code,product_name,product_name_de,brands,quantity,image_front_small_url';
export const OFF_FIELDS_DETAIL = OFF_FIELDS + ',nutriments,nutrition_data_per,serving_size,serving_quantity';
export const PRODUCT_HOSTS = [
  'https://world.openfoodfacts.org',
  'https://world.openproductsfacts.org',
  'https://world.openbeautyfacts.org',
];
export const PRICES_URL = 'https://prices.openfoodfacts.org/api/v1/prices';
export const TIMEOUT_MS = 12000;
const MAX_AGE_MONTHS = 12;

export async function fetchJson(url, timeout = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
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
      const err = new Error('Zeitüberschreitung');
      err.timeout = true;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeProduct(p) {
  if (!p || !p.code) return null;
  const name = (p.product_name_de || p.product_name || '').trim();
  const brand = String(p.brands || '').split(',')[0].trim();
  return {
    code: String(p.code),
    name: name || 'Unbenanntes Produkt',
    brand,
    quantity: (p.quantity || '').trim(),
    image: p.image_front_small_url || '',
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

/** Nährwerte aus einem OFF-Produkt; null, wenn nichts Brauchbares vorhanden ist. */
export function extractNutrition(p) {
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

/** Deutsche Zahlenformatierung für Nährwert-Zellen; null/undefined → „–“. */
export function formatNutrient(row, v) {
  if (v === null || v === undefined) return '–';
  if (row.key === 'energy') {
    const part = (x, u) => (x === null ? '' : `${Math.round(x).toLocaleString('de-DE')} ${u}`);
    return [part(v.kj, 'kJ'), part(v.kcal, 'kcal')].filter(Boolean).join(' / ');
  }
  if (v > 0 && v < 0.1) return '< 0,1 g';
  return `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(v)} g`;
}

/** Produkt per Barcode; null wenn in keiner Datenbank gefunden. */
export async function getProduct(code) {
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

export async function searchProducts(q) {
  const url = `${PRODUCT_HOSTS[0]}/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=20&fields=${OFF_FIELDS}&countries_tags_en=germany`;
  const data = await fetchJson(url);
  return ((data && data.products) || []).map(normalizeProduct).filter(Boolean);
}

export async function getPrices(code) {
  const data = await fetchJson(`${PRICES_URL}?product_code=${encodeURIComponent(code)}&order_by=-date&size=100`);
  return (data && data.items) || [];
}

// ---------- reine Funktionen ----------

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
export function aggregatePrices(items, { includeOld = false, now = new Date() } = {}) {
  const groups = new Map();
  for (const it of items || []) {
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
