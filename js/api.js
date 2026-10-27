// ScanDeals – Datenzugriff und reine Hilfsfunktionen
export const OFF_FIELDS = 'code,product_name,product_name_de,brands,quantity,image_front_small_url';
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
  };
}

/** Produkt per Barcode; null wenn in keiner Datenbank gefunden. */
export async function getProduct(code) {
  let lastErr = null;
  let anySuccess = false;
  for (const host of PRODUCT_HOSTS) {
    try {
      const data = await fetchJson(`${host}/api/v2/product/${encodeURIComponent(code)}.json?fields=${OFF_FIELDS}`);
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
    { label: 'idealo', url: `https://www.idealo.de/preisvergleich/MainSearchProductCategory.html?q=${q}` },
    { label: 'Google Shopping', url: `https://www.google.com/search?tbm=shop&q=${q}` },
    { label: 'Amazon.de', url: `https://www.amazon.de/s?k=${q}` },
    { label: 'geizhals.de', url: `https://geizhals.de/?fs=${q}` },
    ...(code && name ? [{ label: 'Barcode ' + code + ' (Google Shopping)', url: `https://www.google.com/search?tbm=shop&q=${c}` }] : []),
  ];
}

export function reportPriceLink(code) {
  return `https://prices.openfoodfacts.org/prices/add/single?code=${encodeURIComponent(code)}`;
}
