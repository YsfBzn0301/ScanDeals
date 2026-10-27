// Tagespreise über die Open Price Engine (OPE). Das Antwortformat der API ist nicht dokumentiert,
// deshalb wird tolerant normalisiert (siehe extractList / normalizeEntry).

export const DEFAULT_OPE_BASE = "https://openpricengine.com/api/v1";
export const DEFAULT_STORES = [
  { slug: "aldi_sud", name: "Aldi Süd" },
  { slug: "lidl", name: "Lidl" },
  { slug: "globus", name: "Globus" },
  { slug: "alnatura", name: "Alnatura" },
];
export const MIN_SCORE = 0.45;
export const STORE_TIMEOUT_MS = 10_000;
export const CACHE_TTL_S = 6 * 3600;
export const CACHE_TTL_PARTIAL_S = 15 * 60;
const MAX_STR = 200;
const MAX_ENTRIES = 500;
const MAX_BODY_CHARS = 5_000_000;
const LIST_KEYS = ["data", "results", "products", "items", "prices"];
const HISTORY_KEYS = ["history", "price_history", "prices", "data", "items"];
const NAME_KEYS = ["product_name", "productname", "name", "title", "product"];
const PRICE_KEYS = ["price", "current_price", "product_price", "value", "amount"];
const DATE_KEYS = ["date", "scraped_at", "timestamp", "created_at", "updated_at", "day"];
const URL_KEYS = ["url", "link", "product_url", "href"];
const CURRENCY_KEYS = ["currency", "currency_code"];
const IMAGE_KEYS = ["image", "image_url", "img"];

export class OpeError extends Error {
  constructor(kind) {
    super(kind);
    this.kind = kind; // "auth" | "rate" | "http" | "format" | "timeout"
  }
}

// ---------- Konfiguration ----------

export function parseStores(raw) {
  try {
    const list = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (Array.isArray(list)) {
      const out = list
        .filter((s) => s && typeof s.slug === "string" && /^[A-Za-z0-9_.-]{1,60}$/.test(s.slug))
        .map((s) => ({ slug: s.slug, name: typeof s.name === "string" && s.name.trim() ? s.name.trim().slice(0, 60) : s.slug }))
        .slice(0, 20);
      if (out.length) return out;
    }
  } catch {
    /* Standard verwenden */
  }
  return DEFAULT_STORES;
}

export function opeBase(env) {
  const b = typeof env?.OPE_BASE === "string" && /^https:\/\//.test(env.OPE_BASE.trim()) ? env.OPE_BASE.trim() : DEFAULT_OPE_BASE;
  return b.replace(/\/+$/, "");
}

// ---------- Text- und Mengenhilfen ----------

export function normText(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const UNIT_RE = "kilogramm|kg|gramm|gr|mg|g|ml|cl|dl|liter|ltr|l|stueck|stk|st";
// Mengen wie "450 g", "0,5 l", "6 x 0,5 l", "6x500ml"
const QTY_RE = new RegExp(`(?:(\\d{1,3})\\s*x\\s*)?(\\d+(?:[.,]\\d+)?)\\s*(${UNIT_RE})(?![a-z0-9])`, "g");

function qtyPrep(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss");
}

// Wie QTY_RE, aber für den Originaltext (Groß-/Kleinschreibung bleibt erhalten)
const QTY_TERM_RE = new RegExp(`(?:\\d{1,3}\\s*x\\s*)?\\d+(?:[.,]\\d+)?\\s*(?:${UNIT_RE}|stück)(?![A-Za-zÄÖÜäöüß0-9])`, "gi");

const UNIT_BASE = {
  kg: ["g", 1000], kilogramm: ["g", 1000], g: ["g", 1], gr: ["g", 1], gramm: ["g", 1], mg: ["g", 0.001],
  l: ["ml", 1000], ltr: ["ml", 1000], liter: ["ml", 1000], dl: ["ml", 100], cl: ["ml", 10], ml: ["ml", 1],
  stk: ["pc", 1], st: ["pc", 1], stueck: ["pc", 1],
};

// -> {value, unit} in Basiseinheit (g, ml, pc) oder null
export function extractQty(text) {
  const s = qtyPrep(text);
  QTY_RE.lastIndex = 0;
  let m;
  while ((m = QTY_RE.exec(s))) {
    const [base, factor] = UNIT_BASE[m[3]];
    const num = parseFloat(m[2].replace(",", "."));
    if (!Number.isFinite(num) || num <= 0) continue;
    const mult = m[1] ? parseInt(m[1], 10) : 1;
    return { value: num * factor * mult, unit: base };
  }
  return null;
}

function stripQty(text) {
  return qtyPrep(text).replace(QTY_RE, " ");
}

const STOP = new Set(["und", "mit", "der", "die", "das", "von", "vom", "the", "and", "in", "im", "fuer", "ohne"]);
function tokens(s) {
  return [...new Set(normText(s).split(" ").filter((t) => t && !STOP.has(t) && (t.length > 1 || /\d/.test(t))))];
}

// ---------- Suchbegriff ----------

export function buildSearchTerm(q, brand) {
  const strip = (t) => String(t ?? "").replace(QTY_TERM_RE, " ").replace(/\s+/g, " ").trim();
  const cleanQ = strip(q);
  const cleanBrand = strip(brand);
  let term = cleanQ;
  if (cleanBrand) {
    const nq = ` ${normText(cleanQ)} `;
    const nb = normText(cleanBrand);
    term = nb && nq.includes(` ${nb} `) ? cleanQ : `${cleanBrand} ${cleanQ}`;
  }
  term = term.replace(/\s+/g, " ").trim();
  if (term.length > 80) term = term.slice(0, 80).replace(/\s+\S*$/, "").trim() || term.slice(0, 80);
  return term;
}

// ---------- Tolerante Normalisierung ----------

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

function lowerKeys(o) {
  const m = {};
  for (const k of Object.keys(o)) m[k.toLowerCase()] = o[k];
  return m;
}

function pick(m, keys) {
  for (const k of keys) {
    const v = m[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function looksLikeEntry(o) {
  const m = lowerKeys(o);
  return pick(m, NAME_KEYS) !== undefined || pick(m, PRICE_KEYS) !== undefined;
}

// Antwort -> Array roher Einträge
export function extractList(body, depth = 0) {
  if (Array.isArray(body)) return body;
  if (!isObj(body) || depth > 2) return [];
  const m = lowerKeys(body);
  for (const k of LIST_KEYS) {
    const v = m[k];
    if (Array.isArray(v)) return v;
    if (isObj(v)) {
      const inner = extractList(v, depth + 1);
      if (inner.length) return inner;
    }
  }
  return looksLikeEntry(body) ? [body] : [];
}

export function parsePrice(v, depth = 0) {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 && v < 100000 ? v : null;
  if (isObj(v) && depth < 2) {
    const inner = pick(lowerKeys(v), ["amount", "value", "price"]);
    return inner === undefined ? null : parsePrice(inner, depth + 1);
  }
  if (typeof v !== "string") return null;
  const m = v.match(/\d[\d.,]*/);
  if (!m) return null;
  let s = m[0].replace(/[.,]+$/, "");
  const lastC = s.lastIndexOf(",");
  const lastD = s.lastIndexOf(".");
  if (lastC >= 0 && lastD >= 0) {
    // letztes Trennzeichen ist das Dezimaltrennzeichen
    s = lastC > lastD ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lastC >= 0) {
    s = s.replace(/,(?=.*,)/g, "").replace(",", ".");
  } else if (lastD >= 0) {
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
    else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\.(?=.*\.)/g, "");
  }
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 && n < 100000 ? n : null;
}

// -> ms seit Epoche oder null
export function parseDate(v) {
  let ms = null;
  if (typeof v === "number" && Number.isFinite(v)) ms = v < 1e11 ? v * 1000 : v;
  else if (typeof v === "string" && v.trim()) {
    const t = v.trim();
    if (/^\d{9,13}(\.\d+)?$/.test(t)) {
      const n = parseFloat(t);
      ms = n < 1e11 ? n * 1000 : n;
    } else {
      const p = Date.parse(t);
      if (Number.isFinite(p)) ms = p;
    }
  }
  if (ms === null) return null;
  const lo = Date.UTC(2000, 0, 1);
  const hi = Date.now() + 3 * 86400_000;
  return ms >= lo && ms <= hi ? ms : null;
}

export function cut(v) {
  return typeof v === "string" ? v.trim().slice(0, MAX_STR) : "";
}

export function httpUrl(v) {
  if (typeof v !== "string") return "";
  const t = v.trim();
  if (t.length > 1000) return "";
  try {
    const u = new URL(t);
    return u.protocol === "http:" || u.protocol === "https:" ? t.slice(0, MAX_STR * 5) : "";
  } catch {
    return "";
  }
}

function currencyOf(v) {
  if (typeof v !== "string") return "";
  const t = v.trim();
  if (t === "€") return "EUR";
  if (t === "$") return "USD";
  if (t === "£") return "GBP";
  return /^[A-Za-z]{3}$/.test(t) ? t.toUpperCase() : "";
}

// Einzelnen Eintrag normalisieren; kann mehrere Einträge liefern (verschachtelte Preis-Historie).
function normalizeEntry(raw, parent, depth = 0) {
  if (!isObj(raw)) return [];
  const m = lowerKeys(raw);
  const nameV = pick(m, NAME_KEYS);
  const name = cut(typeof nameV === "string" ? nameV : "") || (parent ? parent.name : "");
  if (!name) return [];
  const ctx = {
    name,
    url: httpUrl(pick(m, URL_KEYS)) || parent?.url || "",
    image: httpUrl(pick(m, IMAGE_KEYS)) || parent?.image || "",
    currency: currencyOf(pick(m, CURRENCY_KEYS)) || parent?.currency || "",
  };
  const price = parsePrice(pick(m, PRICE_KEYS));
  if (price !== null) {
    const priceStr = pick(m, PRICE_KEYS);
    let currency = ctx.currency;
    if (!currency && typeof priceStr === "string") currency = /\$/.test(priceStr) ? "USD" : /£/.test(priceStr) ? "GBP" : "";
    const ms = parseDate(pick(m, DATE_KEYS));
    return [{ name, price, currency: currency || "EUR", ms, url: ctx.url, image: ctx.image }];
  }
  // Kein Preis: evtl. Produkt mit verschachtelter Historie
  if (depth < 2) {
    for (const k of HISTORY_KEYS) {
      if (Array.isArray(m[k])) {
        return m[k].slice(0, MAX_ENTRIES).flatMap((e) => normalizeEntry(e, ctx, depth + 1));
      }
    }
  }
  return [];
}

// Antwort -> {name, price, currency, ms, url, image}[] (pro Produktname nur der neueste Eintrag)
export function normalizeEntries(body) {
  const list = extractList(body).slice(0, MAX_ENTRIES);
  const latest = new Map();
  for (const raw of list) {
    for (const e of normalizeEntry(raw, null)) {
      const key = normText(e.name);
      if (!key) continue;
      const cur = latest.get(key);
      if (!cur || (e.ms ?? -Infinity) > (cur.ms ?? -Infinity)) latest.set(key, e);
    }
  }
  return [...latest.values()];
}

// ---------- Abgleich ----------

export function scoreMatch(entry, { q, brand, qty }) {
  const qt = tokens(stripQty(`${q} ${brand}`));
  const nt = tokens(stripQty(entry.name));
  if (!qt.length || !nt.length) return { score: 0, same_size: null };
  const nset = new Set(nt);
  const common = qt.filter((t) => nset.has(t)).length;
  const recall = common / qt.length;
  const precision = common / nt.length;
  let score = 0.75 * recall + 0.25 * precision;

  const bt = tokens(brand);
  if (bt.length && bt.every((t) => nset.has(t))) score += 0.15;

  let same_size = null;
  const a = extractQty(qty) || extractQty(q);
  const b = extractQty(entry.name);
  if (a && b && a.unit === b.unit) {
    same_size = Math.abs(a.value - b.value) <= Math.max(a.value, b.value) * 0.01;
    score += same_size ? 0.15 : -0.1;
  }
  return { score: Math.min(1, Math.max(0, score)), same_size };
}

export function bestMatch(entries, query) {
  let best = null;
  for (const e of entries) {
    const { score, same_size } = scoreMatch(e, query);
    if (score + 1e-9 < MIN_SCORE) continue;
    if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && e.price < best.entry.price)) {
      best = { entry: e, score, same_size };
    }
  }
  return best;
}

// ---------- OPE-Aufrufe ----------

async function opeGet(fetchFn, url, apiKey, timeoutMs = STORE_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetchFn(url, {
        method: "GET",
        headers: { Authorization: apiKey, accept: "application/json" },
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new OpeError(ctrl.signal.aborted ? "timeout" : "http");
    }
    if (res.status === 401 || res.status === 403) throw new OpeError("auth");
    if (res.status === 429) throw new OpeError("rate");
    if (res.status === 404) throw new OpeError("notfound");
    if (!res.ok) throw new OpeError("http");
    let text;
    try {
      text = await res.text();
    } catch {
      throw new OpeError(ctrl.signal.aborted ? "timeout" : "http");
    }
    if (text.length > MAX_BODY_CHARS) throw new OpeError("format");
    try {
      return JSON.parse(text);
    } catch {
      throw new OpeError("format");
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchStoresList(fetchFn, env) {
  const base = opeBase(env);
  try {
    return await opeGet(fetchFn, `${base}/stores/countries`, env.OPE_API_KEY);
  } catch (e) {
    if (e instanceof OpeError && e.kind === "notfound") {
      return opeGet(fetchFn, `${base}/countries_tracked`, env.OPE_API_KEY);
    }
    throw e;
  }
}

const ymd = (d) => d.toISOString().slice(0, 10);

// Gibt {results, errors, raw, fatal} zurück; fatal = "auth" | "rate" | null
export async function lookupPrices(fetchFn, env, { q, brand, qty }, { debugRaw = false, now = new Date() } = {}) {
  const stores = parseStores(env.OPE_STORES);
  const base = opeBase(env);
  const term = buildSearchTerm(q, brand);
  const end = ymd(now);
  const start = ymd(new Date(now.getTime() - 14 * 86400_000));
  const query = { q, brand, qty };

  const settled = await Promise.all(
    stores.map(async (store) => {
      const url =
        `${base}/${encodeURIComponent(store.slug)}/products/query?productname=${encodeURIComponent(term)}` +
        `&start_date=${start}&end_date=${end}&currency=Default`;
      try {
        const body = await opeGet(fetchFn, url, env.OPE_API_KEY);
        return { store, body };
      } catch (e) {
        return { store, error: e instanceof OpeError ? e.kind : "http" };
      }
    }),
  );

  const results = [];
  const errors = [];
  const raw = {};
  let auth = false;
  let rate = false;
  for (const s of settled) {
    if (s.error) {
      if (s.error === "auth") auth = true;
      if (s.error === "rate") rate = true;
      errors.push(s.store.name);
      continue;
    }
    if (debugRaw) raw[s.store.slug] = s.body;
    const best = bestMatch(normalizeEntries(s.body), query);
    if (!best) continue;
    const e = best.entry;
    results.push({
      store: s.store.name,
      store_slug: s.store.slug,
      product_name: e.name,
      price: Math.round(e.price * 100) / 100,
      currency: e.currency,
      date: e.ms === null ? null : new Date(e.ms).toISOString(),
      url: e.url || null,
      image: e.image || null,
      score: Math.round(best.score * 100) / 100,
      same_size: best.same_size,
    });
  }
  results.sort((a, b) => a.price - b.price);
  const fatal = auth ? "auth" : rate && errors.length === stores.length ? "rate" : null;
  return { results, errors, raw, fatal, term };
}
