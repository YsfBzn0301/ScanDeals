import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../src/index.js";
import { stripPack, buildShoppingTerm } from "../src/shopping.js";

const ORIGIN = "https://ysfbzn0301.github.io";
const ENV = { ALLOWED_ORIGINS: ORIGIN, SERPAPI_KEY: "serp-secret-key" };

const req = (path, { origin = ORIGIN } = {}) =>
  new Request("https://worker.test" + path, { method: "GET", headers: origin ? { Origin: origin } : {} });

function serp(body, status = 200, calls = []) {
  return async (url, init) => {
    if (String(url).startsWith("https://serpapi.com/account.json")) return new Response("{}", { status: 500 }); // Kontingent unbekannt: Suche läuft trotzdem
    calls.push({ url: new URL(url), init });
    return new Response(JSON.stringify(body), { status });
  };
}
function memCache() {
  const m = new Map();
  return {
    puts: [],
    async match(r) { const v = m.get(r.url); return v ? v.clone() : undefined; },
    async put(r, v) { this.puts.push(v.headers.get("Cache-Control")); m.set(r.url, v); },
  };
}
const make = (fetch, env = ENV, cache = null) => (path, o) => createHandler(undefined, { fetch, cache })(req(path, o), env);

const MONSTER = "monster energy ultra";
const BODY = {
  search_metadata: { status: "Success" },
  shopping_results: [
    { title: "Monster Energy Ultra 0,5 l", price: "1,49 €", extracted_price: 1.49, old_price: "1,79 €", link: "https://a.example/m", source: "Rewe", thumbnail: "https://t.example/1.jpg", delivery: "Versand 3,99 €", rating: 4.5, reviews: 120 },
    { title: "Monster Energy Ultra 0,5 l Dose", price: "1.59 €", link: "https://b.example/m", source: "Rewe" },
    { title: "Monster Energy Ultra 24 x 0,5 l", price: "1.234,56 €", link: "https://c.example/m", source: "Getränke24" },
    { title: "Monster Energy Ultra 0,5 l", price: "$1.20", extracted_price: 1.2, link: "https://d.example/m", source: "US Shop" },
    { title: "Monster Energy Ultra 0,5 l gebraucht", price: "0,99 €", extracted_price: 0.99, link: "https://e.example/m", source: "Ebay", second_hand_condition: "Gebraucht" },
    { title: "Haribo Goldbären 200 g", price: "0,99 €", extracted_price: 0.99, link: "https://f.example/m", source: "Edeka" },
  ],
  inline_shopping_results: [
    { title: "Monster Energy Ultra 0,5 l", price: "1,69 €", product_link: "https://google.example/p", source: "Kaufland" },
  ],
  categorized_shopping_results: [
    { title: "x", shopping_results: [{ title: "Monster Ultra Energy 6er Pack 0,5 l", price: "8,99 €", extracted_price: 8.99, link: "ftp://bad", product_link: "https://google.example/q", source: "Amazon" }] },
  ],
};

test("Erfolg: gemischte Listen, Format, Währung, Gebraucht, Score, pro Händler günstigstes, sortiert", async () => {
  const calls = [];
  const res = await make(serp(BODY, 200, calls))(`/shopping?q=${encodeURIComponent(MONSTER)}&qty=${encodeURIComponent("0,5 l")}`);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.provider, "google_shopping");
  assert.ok(j.fetched_at);
  assert.deepEqual(j.results.map((r) => r.source), ["Rewe", "Kaufland", "Amazon", "Getränke24"]);
  const rewe = j.results[0];
  assert.equal(rewe.price, 1.49);
  assert.equal(rewe.old_price, 1.79);
  assert.equal(rewe.currency, "EUR");
  assert.equal(rewe.url, "https://a.example/m");
  assert.equal(rewe.thumbnail, "https://t.example/1.jpg");
  assert.equal(rewe.delivery, "Versand 3,99 €");
  assert.equal(rewe.same_size, true);
  assert.equal(rewe.pack, 1);
  assert.equal(j.results[1].url, "https://google.example/p");
  // deutsches Preisformat
  const g24 = j.results[3];
  assert.equal(g24.price, 1234.56);
  assert.equal(g24.pack, 24);
  assert.equal(g24.same_size, false);
  const amazon = j.results[2];
  assert.equal(amazon.pack, 6);
  assert.equal(amazon.same_size, false);
  assert.equal(amazon.url, "https://google.example/q");
  // Aufruf
  const u = calls[0].url;
  assert.equal(u.origin + u.pathname, "https://serpapi.com/search.json");
  assert.equal(u.searchParams.get("engine"), "google_shopping");
  assert.equal(u.searchParams.get("q"), "monster energy ultra 0,5 l");
  assert.equal(u.searchParams.get("gl"), "de");
  assert.equal(u.searchParams.get("direct_link"), "true");
  assert.equal(u.searchParams.get("location"), "Germany");
  assert.equal(u.searchParams.get("api_key"), "serp-secret-key");
  assert.ok(calls[0].init.signal);
});

test("Score-Filter und Gebraucht: Haribo/Gebraucht/USD fehlen", async () => {
  const j = await (await make(serp(BODY))(`/shopping?q=${encodeURIComponent(MONSTER)}`)).json();
  const sources = j.results.map((r) => r.source);
  for (const s of ["Edeka", "Ebay", "US Shop"]) assert.ok(!sources.includes(s), s);
  assert.ok(j.results.every((r) => r.score >= 0.45));
});

test("GTIN-Suche ohne q: kein Score-Filter, score null", async () => {
  const calls = [];
  const j = await (await make(serp(BODY, 200, calls))("/shopping?gtin=4000417025005")).json();
  assert.equal(calls[0].url.searchParams.get("q"), "4000417025005");
  assert.ok(j.results.some((r) => r.source === "Edeka"));
  assert.ok(j.results.every((r) => r.score === null && r.same_size === null));
  assert.equal(j.results[0].price, 0.99);
});

test("Validierung", async () => {
  const h = make(serp(BODY));
  assert.equal((await h("/shopping")).status, 400);
  assert.equal((await h("/shopping?gtin=123")).status, 400);
  assert.equal((await h("/shopping?q=a")).status, 400);
  assert.equal((await h("/shopping?q=" + "x".repeat(121))).status, 400);
});

test("Suchbegriff: Marke nicht doppelt, Länge begrenzt", () => {
  assert.equal(buildShoppingTerm({ q: "Monster Energy Ultra", brand: "Monster", qty: "0,5 l" }), "Monster Energy Ultra 0,5 l");
  assert.equal(buildShoppingTerm({ q: "Ultra", brand: "Monster", qty: "" }), "Monster Ultra");
  assert.ok(buildShoppingTerm({ q: "wort ".repeat(40), brand: "", qty: "" }).length <= 120);
});

test("Pack-Erkennung", () => {
  assert.equal(stripPack("Cola 24 x 0,5 l").pack, 24);
  assert.equal(stripPack("Cola 6er Pack").pack, 6);
  assert.equal(stripPack("Cola 24er").pack, 24);
  assert.equal(stripPack("Cola Pack of 12").pack, 12);
  assert.equal(stripPack("Cola 0,5 l").pack, 1);
  assert.equal(stripPack("Nutella 450 g").pack, 1);
});

test("Anfrage mit Pack-Menge: gleiche Packung ist same_size", async () => {
  const body = { shopping_results: [{ title: "Monster Energy Ultra 24 x 0,5 l", price: "30,00 €", link: "https://c.example/m", source: "S" }] };
  const j = await (await make(serp(body))(`/shopping?q=${encodeURIComponent(MONSTER)}&qty=${encodeURIComponent("24 x 0,5 l")}`)).json();
  assert.equal(j.results[0].pack, 24);
  assert.equal(j.results[0].same_size, true);
});

test("Fehler-Mapping ohne Details", async () => {
  const run = async (f) => {
    const res = await make(f)(`/shopping?q=${MONSTER.replace(/ /g, "%20")}`);
    const text = await res.text();
    assert.ok(!text.includes("serp-secret-key"));
    return { status: res.status, body: JSON.parse(text) };
  };
  let r = await run(serp({ error: "Invalid API key. Your API key should be here: https://serpapi.com/manage-api-key" }));
  assert.deepEqual(r, { status: 502, body: { error: "SerpApi-Schlüssel ungültig" } });
  r = await run(serp({ error: "x" }, 401));
  assert.equal(r.body.error, "SerpApi-Schlüssel ungültig");
  r = await run(serp({ error: "Your account has run out of searches." }));
  assert.deepEqual(r, { status: 429, body: { error: "Suchkontingent aufgebraucht", code: "quota_exhausted" } });
  r = await run(serp({}, 429));
  assert.equal(r.status, 429);
  r = await run(serp({ error: "Google hasn't returned any results for this query." }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results, []);
  r = await run(serp({ error: "Something odd with key serp-secret-key" }));
  assert.deepEqual(r, { status: 502, body: { error: "Preissuche momentan nicht erreichbar" } });
  r = await run(async () => { throw new Error("boom serp-secret-key"); });
  assert.equal(r.status, 502);
  r = await run(async () => new Response("<html>", { status: 500 }));
  assert.equal(r.body.error, "Preissuche momentan nicht erreichbar");
});

test("Cache: zweiter Aufruf ohne SerpApi, Fehler nicht gecacht, TTL", async () => {
  const cache = memCache();
  let n = 0;
  const f = async (u) => { if (String(u).includes("account.json")) return new Response("{}", { status: 500 }); n++; return new Response(JSON.stringify(BODY)); };
  const h = make(f, { ...ENV, SERP_CACHE_HOURS: "2" }, cache);
  const a = await (await h("/shopping?q=Monster%20Energy%20Ultra")).json();
  const b = await (await h("/shopping?q=monster%20energy%20ultra")).json();
  assert.equal(n, 1);
  assert.deepEqual({ ...a, cached: undefined, quota: undefined }, { ...b, cached: undefined, quota: undefined });
  assert.equal(b.cached, true);
  assert.equal(cache.puts[0], "public, s-maxage=7200");

  const c2 = memCache();
  await make(serp({ error: "boom" }), ENV, c2)("/shopping?q=abcd");
  assert.equal(c2.puts.length, 0);
  // leere Liste wird gecacht, Default 12 h
  await make(serp({ shopping_results: [] }), ENV, c2)("/shopping?q=abcd");
  assert.deepEqual(c2.puts, ["public, s-maxage=43200"]);
});

test("Origin-Regel, Key und Methode", async () => {
  const ok = serp(BODY);
  assert.equal((await make(ok)("/shopping?q=monster", { origin: null })).status, 403);
  assert.equal((await make(ok)("/shopping?q=monster", { origin: "https://evil.example" })).status, 403);
  assert.equal((await make(ok, { ...ENV, OPE_DEBUG: "true" })("/shopping?q=monster", { origin: null })).status, 200);
  assert.equal((await make(ok, { ...ENV, DEBUG: "true" })("/shopping?q=monster", { origin: null })).status, 200);
  const nokey = await make(ok, { ALLOWED_ORIGINS: ORIGIN })("/shopping?q=monster");
  assert.equal(nokey.status, 503);
  assert.deepEqual(await nokey.json(), { error: "Echtzeitpreise sind nicht eingerichtet" });
  const post = await createHandler(undefined, { fetch: ok, cache: null })(new Request("https://worker.test/shopping?q=x", { method: "POST", headers: { Origin: ORIGIN } }), ENV);
  assert.equal(post.status, 405);
});

test("/health.features.shopping", async () => {
  const h = async (env) => (await createHandler(undefined, { cache: null })(req("/health"), env)).json();
  assert.equal((await h(ENV)).features.shopping, true);
  assert.equal((await h({ ALLOWED_ORIGINS: ORIGIN })).features.shopping, false);
});
