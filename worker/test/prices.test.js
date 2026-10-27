import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../src/index.js";
import { parsePrice, parseDate, extractList, normalizeEntries, extractQty, buildSearchTerm, scoreMatch } from "../src/prices.js";

const ORIGIN = "https://ysfbzn0301.github.io";
const STORES = [
  { slug: "lidl", name: "Lidl" },
  { slug: "aldi_sud", name: "Aldi Süd" },
  { slug: "globus", name: "Globus" },
];
const ENV = {
  ALLOWED_ORIGINS: `${ORIGIN},http://localhost:8080`,
  OPE_API_KEY: "ope-secret-key",
  OPE_STORES: JSON.stringify(STORES),
};
const now = () => new Date().toISOString();

function req(path, { origin = ORIGIN, method = "GET", headers = {} } = {}) {
  const h = { ...headers };
  if (origin) h.Origin = origin;
  return new Request("https://worker.test" + path, { method, headers: h });
}
const jres = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
// fetch-Mock: map slug -> Antwort (Body oder Funktion oder Response)
function mockFetch(bySlug, calls = []) {
  return async (url, init) => {
    calls.push({ url: String(url), init });
    const m = String(url).match(/\/v1\/([^/]+)\/products\/query/);
    const v = bySlug[m ? m[1] : String(url)];
    if (typeof v === "function") return v(url, init);
    if (v instanceof Response) return v;
    if (v === undefined) return jres([]);
    return jres(v);
  };
}
function memCache() {
  const m = new Map();
  return {
    m,
    match: async (r) => (m.has(r.url) ? m.get(r.url).clone() : undefined),
    put: async (r, res) => void m.set(r.url, res),
  };
}
const handler = (bySlug, extra = {}) => createHandler(undefined, { fetch: mockFetch(bySlug, extra.calls), cache: extra.cache ?? null });
const get = (h, qs, env = ENV, o) => h(req("/prices?" + qs, o), env);

test("Hilfsfunktionen: Preise parsen", () => {
  assert.equal(parsePrice("1,99 €"), 1.99);
  assert.equal(parsePrice("€ 2.49"), 2.49);
  assert.equal(parsePrice("1.299,00 EUR"), 1299);
  assert.equal(parsePrice("1,299.50"), 1299.5);
  assert.equal(parsePrice(3.5), 3.5);
  assert.equal(parsePrice({ amount: "0,99" }), 0.99);
  assert.equal(parsePrice("kostenlos"), null);
  assert.equal(parsePrice(0), null);
  assert.equal(parsePrice(-2), null);
  assert.equal(parsePrice(null), null);
});

test("Hilfsfunktionen: Datum (ISO, Unix s und ms)", () => {
  const iso = "2026-10-20T10:00:00Z";
  assert.equal(parseDate(iso), Date.parse(iso));
  assert.equal(parseDate(1760954400), 1760954400 * 1000);
  assert.equal(parseDate(1760954400000), 1760954400000);
  assert.equal(parseDate("1760954400"), 1760954400000);
  assert.equal(parseDate("quatsch"), null);
  assert.equal(parseDate(5), null);
});

test("Hilfsfunktionen: Mengen", () => {
  assert.deepEqual(extractQty("Nutella 450 g"), { value: 450, unit: "g" });
  assert.deepEqual(extractQty("Milch 1,5 l"), { value: 1500, unit: "ml" });
  assert.deepEqual(extractQty("Cola 6 x 0,5 l"), { value: 3000, unit: "ml" });
  assert.deepEqual(extractQty("Mehl 1kg"), { value: 1000, unit: "g" });
  assert.deepEqual(extractQty("Eier 10 Stück"), { value: 10, unit: "pc" });
  assert.deepEqual(extractQty("Saft 33cl"), { value: 330, unit: "ml" });
  assert.equal(extractQty("Nutella"), null);
});

test("Hilfsfunktionen: Suchbegriff ohne doppelte Marke und ohne Menge", () => {
  assert.equal(buildSearchTerm("Nutella 450 g", "Ferrero"), "Ferrero Nutella");
  assert.equal(buildSearchTerm("Ferrero Nutella", "ferrero"), "Ferrero Nutella");
  assert.equal(buildSearchTerm("Milch", ""), "Milch");
  assert.ok(buildSearchTerm("x".repeat(30) + " " + "y".repeat(100), "").length <= 80);
});

test("Antwortformen: Array, data/results/products/items/prices, verschachtelt", () => {
  const e = { name: "Nutella 450 g", price: 2.99 };
  assert.equal(extractList([e]).length, 1);
  for (const k of ["data", "results", "products", "items", "prices", "DATA"]) assert.equal(extractList({ [k]: [e] }).length, 1, k);
  assert.equal(extractList({ data: { items: [e, e] } }).length, 2);
  assert.equal(extractList({ foo: 1 }).length, 0);
  assert.equal(extractList(null).length, 0);
  assert.equal(extractList("text").length, 0);
});

test("Feldnamen-Varianten, Währung, Bild, URL", () => {
  const out = normalizeEntries({
    results: [
      { productname: "Nutella 450g", current_price: "2,99 €", scraped_at: "2026-10-20", link: "https://shop.example/n", img: "https://shop.example/n.png" },
      { title: "Duplo", amount: 1.5, currency_code: "chf", href: "javascript:alert(1)" },
      { name: "Ohne Preis" },
      { price: 3 },
      { name: "Preis kaputt", price: "gratis" },
    ],
  });
  assert.equal(out.length, 2);
  const n = out.find((x) => x.name === "Nutella 450g");
  assert.equal(n.price, 2.99);
  assert.equal(n.currency, "EUR");
  assert.equal(n.url, "https://shop.example/n");
  assert.equal(n.image, "https://shop.example/n.png");
  const d = out.find((x) => x.name === "Duplo");
  assert.equal(d.currency, "CHF");
  assert.equal(d.url, "");
});

test("Verschachtelte Historie je Produkt", () => {
  const out = normalizeEntries([
    { name: "Nutella 450 g", url: "https://s.example/n", history: [{ price: 3.49, date: "2026-10-10" }, { price: 2.99, date: "2026-10-25" }] },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].price, 2.99);
  assert.equal(out[0].url, "https://s.example/n");
});

test("/prices: Array-Antwort, Struktur, sortiert günstig -> teuer", async () => {
  const h = handler({
    lidl: [{ product_name: "Ferrero Nutella 450 g", price: "3,49 €", date: "2026-10-26T08:00:00Z", url: "https://lidl.example/n" }],
    aldi_sud: { data: [{ name: "Nutella Nuss-Nougat-Creme 450g Ferrero", price: 2.79, timestamp: 1761465600 }] },
    globus: { results: [{ title: "Nutella 450 g", value: "2,99", updated_at: "2026-10-26" }] },
  });
  const res = await get(h, "q=nutella&brand=ferrero&qty=450%20g");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  const d = await res.json();
  assert.deepEqual(d.query, { q: "nutella", brand: "ferrero", qty: "450 g" });
  assert.ok(d.fetched_at);
  assert.deepEqual(d.errors, []);
  assert.deepEqual(d.results.map((r) => r.store), ["Aldi Süd", "Globus", "Lidl"]);
  const lidl = d.results.find((r) => r.store_slug === "lidl");
  assert.equal(lidl.price, 3.49);
  assert.equal(lidl.currency, "EUR");
  assert.equal(lidl.url, "https://lidl.example/n");
  assert.equal(lidl.same_size, true);
  assert.equal(lidl.date, "2026-10-26T08:00:00.000Z");
  assert.equal(lidl.image, null);
  assert.ok(lidl.score >= 0.45 && lidl.score <= 1);
  assert.equal(d.results[0].date, new Date(1761465600 * 1000).toISOString());
});

test("OPE-Aufruf: URL, Header, Datumsbereich, Suchbegriff ohne Menge", async () => {
  const calls = [];
  await get(handler({}, { calls }), "q=Nutella%20450%20g&brand=Ferrero&qty=450%20g");
  assert.equal(calls.length, 3);
  const u = new URL(calls[0].url);
  assert.equal(u.origin + u.pathname, "https://openpricengine.com/api/v1/lidl/products/query");
  assert.equal(u.searchParams.get("productname"), "Ferrero Nutella");
  assert.equal(u.searchParams.get("currency"), "Default");
  const end = new Date();
  const start = new Date(Date.now() - 14 * 86400_000);
  assert.equal(u.searchParams.get("end_date"), end.toISOString().slice(0, 10));
  assert.equal(u.searchParams.get("start_date"), start.toISOString().slice(0, 10));
  assert.equal(calls[0].init.headers.Authorization, "ope-secret-key");
  assert.equal(calls[0].init.headers.accept, "application/json");
});

test("OPE_BASE ist überschreibbar", async () => {
  const calls = [];
  await get(handler({}, { calls }), "q=nutella", { ...ENV, OPE_BASE: "https://ope.example/api/" });
  assert.ok(calls[0].url.startsWith("https://ope.example/api/lidl/products/query"));
});

test("Historie: pro Produktname der neueste Eintrag", async () => {
  const h = handler({
    lidl: [
      { name: "Nutella 450 g", price: 1.99, date: "2026-10-12" },
      { name: "Nutella 450 g", price: 2.99, date: "2026-10-26" },
      { name: "Nutella 450 g", price: 3.99, date: "2026-10-19" },
    ],
  });
  const d = await (await get(h, "q=nutella&qty=450g")).json();
  assert.equal(d.results.length, 1);
  assert.equal(d.results[0].price, 2.99);
});

test("Abgleich: richtiges Produkt gewinnt", async () => {
  const h = handler({
    lidl: [
      { name: "Ferrero Duplo 5er", price: 1.0, date: "2026-10-26" },
      { name: "Nutella Brotaufstrich 450 g", price: 3.5, date: "2026-10-26" },
      { name: "Haribo Goldbären 450 g", price: 0.99, date: "2026-10-26" },
    ],
  });
  const d = await (await get(h, "q=nutella&brand=ferrero&qty=450%20g")).json();
  assert.equal(d.results.length, 1);
  assert.equal(d.results[0].product_name, "Nutella Brotaufstrich 450 g");
});

test("Abgleich: falsche Größe wird markiert, unbekannte Größe ist null", async () => {
  const h = handler({
    lidl: [{ name: "Nutella 825 g", price: 5.5, date: "2026-10-26" }],
    aldi_sud: [{ name: "Nutella Glas", price: 3.2, date: "2026-10-26" }],
    globus: [{ name: "Nutella 450 g", price: 3.0, date: "2026-10-26" }],
  });
  const d = await (await get(h, "q=nutella&qty=450%20g")).json();
  const by = Object.fromEntries(d.results.map((r) => [r.store_slug, r]));
  assert.equal(by.lidl.same_size, false);
  assert.equal(by.aldi_sud.same_size, null);
  assert.equal(by.globus.same_size, true);
  assert.ok(by.globus.score > by.lidl.score);
});

test("Abgleich: zu schwacher Treffer fliegt raus", async () => {
  const h = handler({ lidl: [{ name: "Milka Alpenmilch Schokolade 100 g", price: 1.19, date: "2026-10-26" }] });
  const d = await (await get(h, "q=nutella&brand=ferrero")).json();
  assert.deepEqual(d.results, []);
  assert.deepEqual(d.errors, []);
});

test("Abgleich: Umlaute und Satzzeichen werden normalisiert", () => {
  const { score } = scoreMatch({ name: "Haselnuss-Müsli (Bio)" }, { q: "haselnuss muesli bio", brand: "", qty: "" });
  assert.ok(score >= 0.9);
});

test("Laden-Fehler -> errors, andere Läden liefern weiter", async () => {
  const h = handler({
    lidl: new Response("boom SECRET", { status: 500 }),
    aldi_sud: () => {
      throw new Error("netzwerk SECRET");
    },
    globus: [{ name: "Nutella 450 g", price: 3, date: "2026-10-26" }],
  });
  const res = await get(h, "q=nutella");
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes("SECRET") && !text.includes("ope-secret-key"));
  const d = JSON.parse(text);
  assert.deepEqual(d.errors, ["Lidl", "Aldi Süd"]);
  assert.equal(d.results.length, 1);
});

test("Kaputtes JSON / unerwartetes Format eines Ladens -> errors bzw. leer", async () => {
  const h = handler({ lidl: new Response("<html>", { status: 200 }), aldi_sud: "irgendein string", globus: 42 });
  const d = await (await get(h, "q=nutella")).json();
  assert.deepEqual(d.errors, ["Lidl"]);
  assert.deepEqual(d.results, []);
});

test("Timeout pro Laden -> errors", async () => {
  const h = handler({
    lidl: (url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted")))),
    globus: [{ name: "Nutella 450 g", price: 3, date: "2026-10-26" }],
  });
  const t0 = Date.now();
  const res = await get(h, "q=nutella", { ...ENV, OPE_STORES: JSON.stringify([STORES[0], STORES[2]]) });
  assert.ok(Date.now() - t0 < 12_000);
  const d = await res.json();
  assert.deepEqual(d.errors, ["Lidl"]);
  assert.equal(d.results.length, 1);
});

test("Fehlender OPE_API_KEY -> 503", async () => {
  const calls = [];
  const res = await get(handler({}, { calls }), "q=nutella", { ...ENV, OPE_API_KEY: undefined });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "Tagespreise sind nicht eingerichtet" });
  assert.equal(calls.length, 0);
});

test("401/403 von OPE -> 502 ohne Details", async () => {
  for (const status of [401, 403]) {
    const h = handler({ lidl: new Response("SECRET ope-secret-key", { status }), aldi_sud: [], globus: [] });
    const res = await get(h, "q=nutella");
    assert.equal(res.status, 502);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { error: "API-Schlüssel ungültig oder abgelaufen" });
    assert.ok(!text.includes("SECRET") && !text.includes("ope-secret-key"));
  }
});

test("429 von allen Läden -> 429, von einem -> 200 mit errors", async () => {
  const all = handler({ lidl: new Response("", { status: 429 }), aldi_sud: new Response("", { status: 429 }), globus: new Response("", { status: 429 }) });
  assert.equal((await get(all, "q=nutella")).status, 429);
  const one = handler({ lidl: new Response("", { status: 429 }) });
  const res = await get(one, "q=nutella");
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).errors, ["Lidl"]);
});

test("Eingabevalidierung", async () => {
  const h = handler({});
  for (const qs of ["", "q=a", "q=" + "x".repeat(121), "q=nutella&brand=" + "b".repeat(61), "q=nutella&qty=" + "1".repeat(61)]) {
    assert.equal((await get(h, qs)).status, 400, qs);
  }
  assert.equal((await get(h, "q=" + "x".repeat(120))).status, 200);
  assert.equal((await h(req("/prices?q=nutella", { method: "POST" }), ENV)).status, 405);
});

test("Strings werden gekürzt, nur http(s)-URLs", async () => {
  const h = handler({
    lidl: [{ name: "Nutella " + "x".repeat(500), price: 3, url: "ftp://x.example/a", image: "data:image/png;base64,AAAA", date: "2026-10-26" }],
  });
  const d = await (await get(h, "q=nutella")).json();
  assert.ok(d.results[0].product_name.length <= 200);
  assert.equal(d.results[0].url, null);
  assert.equal(d.results[0].image, null);
});

test("Cache: zweiter Aufruf kommt aus dem Cache, Schlüssel normiert", async () => {
  const calls = [];
  const cache = memCache();
  const h = handler({ lidl: [{ name: "Nutella 450 g", price: 3, date: "2026-10-26" }] }, { calls, cache });
  const r1 = await get(h, "q=Nutella&brand=Ferrero&qty=450%20g");
  assert.equal(r1.status, 200);
  assert.equal(calls.length, 3);
  const stored = [...cache.m.values()][0];
  assert.match(stored.headers.get("Cache-Control"), /s-maxage=21600/);
  const r2 = await get(h, "q=nutella&brand=ferrero&qty=450%20G", ENV, { origin: "http://localhost:8080" });
  assert.equal(r2.status, 200);
  assert.equal(calls.length, 3);
  assert.equal(r2.headers.get("Access-Control-Allow-Origin"), "http://localhost:8080");
  assert.equal((await r2.json()).results[0].price, 3);
});

test("Cache: Fehlerantworten und komplette Ausfälle werden nicht gecacht, Teilausfälle kurz", async () => {
  const cache = memCache();
  await get(handler({ lidl: new Response("", { status: 401 }) }, { cache }), "q=nutella");
  assert.equal(cache.m.size, 0);
  await get(handler({ lidl: new Response("", { status: 500 }), aldi_sud: new Response("", { status: 500 }), globus: new Response("", { status: 500 }) }, { cache }), "q=nutella");
  assert.equal(cache.m.size, 0);
  await get(handler({ lidl: new Response("", { status: 500 }), globus: [{ name: "Nutella", price: 2, date: "2026-10-26" }] }, { cache }), "q=nutella");
  assert.equal(cache.m.size, 1);
  assert.match([...cache.m.values()][0].headers.get("Cache-Control"), /s-maxage=900/);
});

test("Kaputter Cache stört nicht", async () => {
  const cache = { match: async () => { throw new Error("x"); }, put: async () => { throw new Error("y"); } };
  const res = await get(handler({ lidl: [{ name: "Nutella", price: 2, date: "2026-10-26" }] }, { cache }), "q=nutella");
  assert.equal(res.status, 200);
});

test("Debug: raw nur mit OPE_DEBUG=true", async () => {
  const body = [{ name: "Nutella", price: 2, foo: "bar" }];
  const h = handler({ lidl: body });
  const off = await (await get(h, "q=nutella&raw=1")).json();
  assert.equal("raw" in off, false);
  const on = await (await get(h, "q=nutella&raw=1", { ...ENV, OPE_DEBUG: "true" })).json();
  assert.deepEqual(on.raw.lidl, body);
  assert.deepEqual(Object.keys(on.raw).sort(), ["aldi_sud", "globus", "lidl"]);
  const noRaw = await (await get(h, "q=nutella", { ...ENV, OPE_DEBUG: "true" })).json();
  assert.equal("raw" in noRaw, false);
});

test("OPE_STORES: ungültig -> Standardläden", async () => {
  const calls = [];
  await get(handler({}, { calls }), "q=nutella", { ...ENV, OPE_STORES: "kein json" });
  assert.deepEqual(calls.map((c) => c.url.match(/v1\/([^/]+)\//)[1]).sort(), ["aldi_sud", "alnatura", "globus", "lidl"]);
});

test("/prices/stores: Antwort unverändert, Fallback bei 404", async () => {
  const payload = { Germany: ["aldi_sud", "lidl"], weird: [1, 2] };
  const urls = [];
  const f = async (u) => { urls.push(String(u)); return jres(payload); };
  const res = await createHandler(undefined, { fetch: f, cache: null })(req("/prices/stores", { origin: null }), ENV);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), payload);
  assert.deepEqual(urls, ["https://openpricengine.com/api/v1/stores/countries"]);

  const urls2 = [];
  const f2 = async (u) => { urls2.push(String(u)); return String(u).endsWith("/stores/countries") ? new Response("", { status: 404 }) : jres(["de"]); };
  const res2 = await createHandler(undefined, { fetch: f2, cache: null })(req("/prices/stores"), ENV);
  assert.deepEqual(await res2.json(), ["de"]);
  assert.equal(urls2[1], "https://openpricengine.com/api/v1/countries_tracked");
});

test("/prices/stores: ohne Key 503, 401 -> 502, fremder Origin 403", async () => {
  const h = createHandler(undefined, { fetch: async () => new Response("SECRET", { status: 401 }), cache: null });
  assert.equal((await h(req("/prices/stores"), { ...ENV, OPE_API_KEY: "" })).status, 503);
  const r = await h(req("/prices/stores"), ENV);
  assert.equal(r.status, 502);
  assert.ok(!(await r.text()).includes("SECRET"));
  assert.equal((await h(req("/prices/stores", { origin: "https://evil.example" }), ENV)).status, 403);
});

test("CORS: /prices ohne Origin nur im Debug-Modus, fremder Origin 403, OPTIONS ok", async () => {
  const h = handler({});
  const none = await get(h, "q=nutella", ENV, { origin: null });
  assert.equal(none.status, 403);
  const debug = await get(h, "q=nutella", { ...ENV, OPE_DEBUG: "true" }, { origin: null });
  assert.equal(debug.status, 200);
  assert.equal(debug.headers.get("Access-Control-Allow-Origin"), null);
  const evil = await get(h, "q=nutella", ENV, { origin: "https://evil.example" });
  assert.equal(evil.status, 403);
  assert.equal(evil.headers.get("Access-Control-Allow-Origin"), null);
  const opt = await h(req("/prices", { method: "OPTIONS" }), ENV);
  assert.equal(opt.status, 204);
});

test("/health features", async () => {
  const h = createHandler(undefined, { cache: null });
  const a = await (await h(req("/health"), { ...ENV, ANTHROPIC_API_KEY: "k" })).json();
  assert.deepEqual(a.features, { ai: true, prices: true, shopping: false });
  const b = await (await h(req("/health"), { ...ENV, OPE_API_KEY: undefined })).json();
  assert.deepEqual(b.features, { ai: false, prices: false, shopping: false });
  assert.ok(!JSON.stringify(a).includes("ope-secret-key"));
});

test("Rate-Limit gilt auch für /prices", async () => {
  const h = handler({});
  const r = () => get(h, "q=nutella", ENV, { headers: { "CF-Connecting-IP": "9.9.9.9" } });
  for (let i = 0; i < 20; i++) assert.equal((await r()).status, 200);
  assert.equal((await r()).status, 429);
});
