// Echtzeitpreise über SerpApi (Google Shopping). Abgleich und Mengenlogik kommen aus prices.js.
import { scoreMatch, MIN_SCORE, parsePrice, normText, httpUrl, cut } from "./prices.js";

export const SERP_BASE = "https://serpapi.com/search.json";
export const SERP_TIMEOUT_MS = 15_000;
export const DEFAULT_CACHE_HOURS = 12;
export const MAX_RESULTS = 12;
const MAX_TERM = 120;

export class SerpError extends Error {
  constructor(kind) {
    super(kind);
    this.kind = kind; // "auth" | "rate" | "http" | "timeout"
  }
}

export function cacheSeconds(env) {
  const h = parseFloat(env?.SERP_CACHE_HOURS);
  return Math.round((Number.isFinite(h) && h > 0 && h <= 168 ? h : DEFAULT_CACHE_HOURS) * 3600);
}

// ---------- Suchbegriff ----------

export function buildShoppingTerm({ q, brand, qty, gtin }) {
  if (!q) return gtin || "";
  const nq = ` ${normText(q)} `;
  const nb = normText(brand);
  let term = brand && nb && !nq.includes(` ${nb} `) ? `${brand} ${q}` : q;
  const nqty = normText(qty);
  if (qty && nqty && !` ${normText(term)} `.includes(` ${nqty} `)) term += ` ${qty}`;
  term = term.replace(/\s+/g, " ").trim();
  if (term.length > MAX_TERM) term = term.slice(0, MAX_TERM).replace(/\s+\S*$/, "").trim() || term.slice(0, MAX_TERM);
  return term;
}

// ---------- Mehrfachpackungen ----------

// "24 x 0,5 l", "6er Pack", "24er", "Pack of 12", "12-pack" -> Text ohne Packhinweis + Anzahl
export function stripPack(text) {
  let s = String(text ?? "");
  let n = 1;
  const take = (re, idx = 1) => {
    s = s.replace(re, (...m) => {
      const v = parseInt(m[idx], 10);
      if (v > 1 && v <= 999 && n === 1) n = v;
      return " ";
    });
  };
  take(/(?<![\d.,])(\d{1,3})\s*[x×]\s*(?=\d)/gi);
  take(/\bpack\s+of\s+(\d{1,3})\b/gi);
  take(/(?<![\d.,])(\d{1,3})[\s-]*er[\s-]*(?:pack(?:ung)?|set|karton|tray)?(?![a-zäöüß])/gi);
  take(/(?<![\d.,])(\d{1,3})[\s-]*(?:pack|stück-pack)\b/gi);
  return { text: s.replace(/\s+/g, " ").trim(), pack: n };
}

// ---------- Normalisierung ----------

function listsOf(body) {
  const out = [];
  const add = (v) => Array.isArray(v) && out.push(...v);
  add(body.shopping_results);
  add(body.inline_shopping_results);
  if (Array.isArray(body.categorized_shopping_results)) {
    for (const c of body.categorized_shopping_results) if (c && typeof c === "object") add(c.shopping_results);
  }
  return out.filter((r) => r && typeof r === "object" && !Array.isArray(r));
}

// Preis in EUR oder null (andere Währung / unlesbar)
function eurPrice(num, str) {
  if (typeof str === "string" && str.trim()) {
    const t = str.trim();
    const eur = /€|\bEUR\b/i.test(t);
    if (!eur && /[^\d\s.,+\-–ab]|[a-z]/i.test(t.replace(/\b(ab|from)\b/gi, ""))) return null;
  }
  if (typeof num === "number") return Number.isFinite(num) && num > 0 && num < 100000 ? num : null;
  return parsePrice(str);
}

function num(v) {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v.replace(",", ".")) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function normalizeShopping(body) {
  const out = [];
  for (const r of listsOf(body).slice(0, 200)) {
    if (r.second_hand_condition) continue;
    const title = cut(r.title);
    if (!title) continue;
    const price = eurPrice(r.extracted_price, r.price);
    if (price === null) continue;
    const oldRaw = eurPrice(r.extracted_old_price, r.old_price);
    const url = httpUrl(r.link) || httpUrl(r.product_link);
    if (!url) continue;
    out.push({
      source: cut(r.source) || "Händler",
      title,
      price,
      old_price: oldRaw !== null && oldRaw > price ? oldRaw : null,
      url,
      thumbnail: httpUrl(r.thumbnail) || null,
      delivery: cut(r.delivery) || null,
      rating: num(r.rating),
      reviews: num(r.reviews),
    });
  }
  return out;
}

// Bewertung mit Packungslogik: -> {score, same_size, pack}
export function matchOffer(offer, { q, brand, qty }) {
  const t = stripPack(offer.title);
  const quantity = stripPack(qty);
  const query = stripPack(q);
  const queryPack = Math.max(quantity.pack, query.pack);
  const base = scoreMatch({ name: t.text }, { q: query.text, brand, qty: quantity.text });
  let { score, same_size } = base;
  if (t.pack !== queryPack) {
    if (same_size === true) score -= 0.25;
    else if (same_size === null) score -= 0.1;
    same_size = false;
  }
  return { score: Math.min(1, Math.max(0, score)), same_size, pack: t.pack };
}

export function buildResults(offers, query, { skipScore = false } = {}) {
  const best = new Map(); // normierter Händler -> bester Eintrag
  for (const o of offers) {
    let m;
    if (skipScore) m = { score: null, same_size: null, pack: stripPack(o.title).pack };
    else {
      m = matchOffer(o, query);
      if (m.score + 1e-9 < MIN_SCORE) continue;
    }
    const key = normText(o.source) || o.source;
    const cur = best.get(key);
    if (!cur || o.price < cur.o.price) best.set(key, { o, m });
  }
  return [...best.values()]
    .sort((a, b) => a.o.price - b.o.price)
    .slice(0, MAX_RESULTS)
    .map(({ o, m }) => ({
      source: o.source,
      title: o.title,
      price: Math.round(o.price * 100) / 100,
      old_price: o.old_price === null ? null : Math.round(o.old_price * 100) / 100,
      currency: "EUR",
      url: o.url,
      thumbnail: o.thumbnail,
      delivery: o.delivery,
      rating: o.rating,
      reviews: o.reviews,
      score: m.score === null ? null : Math.round(m.score * 100) / 100,
      same_size: m.same_size,
      pack: m.pack,
    }));
}

// ---------- SerpApi-Aufruf ----------

export async function lookupShopping(fetchFn, env, { q, brand, qty, gtin }) {
  const term = buildShoppingTerm({ q, brand, qty, gtin });
  const params = new URLSearchParams({
    engine: "google_shopping",
    q: term,
    api_key: env.SERPAPI_KEY,
    gl: "de",
    hl: "de",
    google_domain: "google.de",
    location: String(env.SERP_LOCATION || "Germany"),
    direct_link: "true",
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SERP_TIMEOUT_MS);
  let res;
  let body = null;
  try {
    try {
      res = await fetchFn(`${SERP_BASE}?${params}`, { method: "GET", headers: { accept: "application/json" }, signal: ctrl.signal });
    } catch {
      throw new SerpError(ctrl.signal.aborted ? "timeout" : "http");
    }
    try {
      body = JSON.parse(await res.text());
    } catch {
      body = null;
    }
  } finally {
    clearTimeout(timer);
  }

  const err = body && typeof body.error === "string" ? body.error : "";
  if (res.status === 401 || res.status === 403 || /invalid api key/i.test(err)) throw new SerpError("auth");
  if (res.status === 429 || /run out of searches|limit/i.test(err)) throw new SerpError("rate");
  if (err) {
    if (/hasn'?t returned any results/i.test(err)) return { term, results: [] };
    throw new SerpError("http");
  }
  if (!res.ok || !body || typeof body !== "object" || Array.isArray(body)) throw new SerpError("http");
  if (body.search_metadata && body.search_metadata.status === "Error") throw new SerpError("http");

  const results = buildResults(normalizeShopping(body), { q: q || "", brand, qty }, { skipScore: !q });
  return { term, results };
}
