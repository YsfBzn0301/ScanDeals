import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../src/index.js";
import { computeQuota, pickAccount, pickKey } from "../src/quota.js";

const ORIGIN = "https://ysfbzn0301.github.io";
const SERVER_KEY = "serverkey" + "A".repeat(20);
const USER_KEY = "userkey" + "B".repeat(20);
const ENV = { ALLOWED_ORIGINS: ORIGIN, SERPAPI_KEY: SERVER_KEY };

const ACCOUNT = {
  api_key: "LEAK" + SERVER_KEY, account_email: "leak@example.com", plan_name: "Free Plan", searches_per_month: 250,
  plan_searches_left: 100, extra_credits: 0, total_searches_left: 100, this_month_usage: 150,
  last_hour_searches: 3, account_rate_limit_per_hour: 50, plan_renewal_date: "2026-11-01T00:00:00Z",
};
const SHOP = { shopping_results: [{ title: "Monster Energy Ultra 0,5 l", price: "1,49 €", extracted_price: 1.49, link: "https://a.example/m", source: "Rewe" }] };

function memCache() {
  const m = new Map();
  return {
    async match(r) { const v = m.get(r.url); return v ? v.clone() : undefined; },
    async put(r, v) { m.set(r.url, v); },
    keys: () => [...m.keys()],
  };
}
// Mock: account.json und search.json getrennt, alle Aufrufe protokolliert
function net({ account = ACCOUNT, accountStatus = 200, shop = SHOP, shopStatus = 200 } = {}) {
  const calls = { account: [], search: [] };
  const fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/account.json") {
      calls.account.push(u);
      return new Response(JSON.stringify(typeof account === "function" ? account(u) : account), { status: accountStatus });
    }
    calls.search.push(u);
    return new Response(JSON.stringify(shop), { status: shopStatus });
  };
  return { fetch, calls };
}
const get = (h, path, { headers = {}, env = ENV } = {}) =>
  h(new Request("https://worker.test" + path, { headers: { Origin: ORIGIN, ...headers } }), env);
const mk = (n, cache = null) => createHandler(undefined, { fetch: n.fetch, cache });
const Q = "/shopping?q=monster%20energy%20ultra";

test("computeQuota: warn, exhausted, Reserve, Schwelle", () => {
  const raw = (left, per = 250) => ({ plan_name: "P", per_month: per, left, used: per - left, hourly_limit: 50, hourly_used: 1, renews: null });
  const c = (left, env = {}, per) => computeQuota(raw(left, per), env, "server");
  assert.equal(c(100).warn, false);
  assert.equal(c(50).warn, true); // 20 % von 250 = 50
  assert.equal(c(51).warn, false);
  assert.equal(c(1).warn, true);
  assert.equal(c(0).warn, false);
  assert.equal(c(0).exhausted, true);
  assert.equal(c(30, {}, 100).warn, false); // max(25, 20) = 25
  assert.equal(c(25, {}, 100).warn, true);
  assert.equal(c(5, { SERP_RESERVE: "5" }).exhausted, true);
  assert.equal(c(5, { SERP_RESERVE: "5" }).left, 0);
  assert.equal(c(3, { SERP_RESERVE: "5" }).left, 0);
  assert.equal(c(40, { SERP_RESERVE: "5" }).left, 35);
  assert.equal(c(60, { SERP_WARN_PERCENT: "50" }).warn, true);
  assert.equal(c(60, { SERP_WARN_MIN: "70", SERP_WARN_PERCENT: "0" }).warn, true);
  assert.equal(c(10, { SERP_WARN_PERCENT: "kaputt", SERP_WARN_MIN: "" }).warn, true); // Defaults
});

test("pickAccount: nur bekannte Felder, plan_searches_left als Rückfall", () => {
  const a = pickAccount({ ...ACCOUNT, total_searches_left: undefined });
  assert.equal(a.left, 100);
  assert.equal(a.renews, "2026-11-01");
  assert.ok(!JSON.stringify(a).includes("LEAK"));
  assert.deepEqual(Object.keys(a).sort(), ["hourly_limit", "hourly_used", "left", "per_month", "plan_name", "renews", "used"]);
  assert.equal(pickAccount({ ...ACCOUNT, plan_renewal_date: null }).renews, null);
  assert.equal(pickAccount({ foo: 1 }), null);
});

test("/shopping/quota: Form, kein Key-Leak, 5 min Cache für Server-Schlüssel", async () => {
  const n = net();
  const cache = memCache();
  const h = mk(n, cache);
  const res = await get(h, "/shopping/quota");
  const text = await res.text();
  assert.equal(res.status, 200);
  for (const bad of ["LEAK", SERVER_KEY, "leak@example.com", "api_key"]) assert.ok(!text.includes(bad), bad);
  assert.deepEqual(JSON.parse(text), {
    key_source: "server", plan_name: "Free Plan", per_month: 250, left: 100, used: 150,
    hourly_limit: 50, hourly_used: 3, renews: "2026-11-01", warn: false, exhausted: false, device: null,
  });
  assert.equal(n.calls.account[0].searchParams.get("api_key"), SERVER_KEY);
  await get(h, "/shopping/quota");
  assert.equal(n.calls.account.length, 1);
  assert.deepEqual(cache.keys(), ["https://scandeals-cache.invalid/quota:server"]);
});

test("/shopping/quota: ungültiger Schlüssel -> 502", async () => {
  const n = net({ account: { error: "Invalid API key. Your API key should be here: https://serpapi.com/manage-api-key" }, accountStatus: 401 });
  const res = await get(mk(n), "/shopping/quota");
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "SerpApi-Schlüssel ungültig" });
});

test("Eigener Schlüssel: Vorrang, nicht gecacht, nicht zurückgegeben, ohne Server-Key nutzbar", async () => {
  const n = net();
  const cache = memCache();
  const h = mk(n, cache);
  const res = await get(h, "/shopping/quota", { headers: { "X-SerpApi-Key": USER_KEY } });
  const text = await res.text();
  assert.equal(JSON.parse(text).key_source, "user");
  assert.ok(!text.includes(USER_KEY));
  assert.equal(n.calls.account[0].searchParams.get("api_key"), USER_KEY);
  await get(h, "/shopping/quota", { headers: { "X-SerpApi-Key": USER_KEY } });
  assert.equal(n.calls.account.length, 2); // nicht gecacht
  assert.deepEqual(cache.keys(), []);

  const s = await get(h, Q, { headers: { "X-SerpApi-Key": USER_KEY } });
  const st = await s.text();
  assert.equal(s.status, 200);
  assert.ok(!st.includes(USER_KEY));
  assert.equal(JSON.parse(st).quota.key_source, "user");
  assert.equal(n.calls.search.at(-1).searchParams.get("api_key"), USER_KEY);
  assert.ok(!cache.keys().some((k) => k.includes(USER_KEY)));
  for (const k of cache.keys()) assert.ok(!k.includes("quota"));

  // ohne Server-Key
  const n2 = net();
  const env2 = { ALLOWED_ORIGINS: ORIGIN };
  assert.equal((await get(mk(n2), Q, { env: env2 })).status, 503);
  const ok = await get(mk(n2), Q, { env: env2, headers: { "X-SerpApi-Key": USER_KEY } });
  assert.equal(ok.status, 200);
  assert.equal((await get(mk(n2), "/shopping/quota", { env: env2 })).status, 503);
});

test("Ungültiges Header-Format -> 400 ohne Aufruf", async () => {
  const n = net();
  for (const k of ["kurz", "x".repeat(101), "abc def ghi jkl mno pqr", "a".repeat(19) + "-"]) {
    for (const p of [Q, "/shopping/quota"]) {
      const res = await get(mk(n), p, { headers: { "X-SerpApi-Key": k } });
      assert.equal(res.status, 400);
      assert.ok(!(await res.text()).includes(k));
    }
  }
  assert.equal(n.calls.account.length + n.calls.search.length, 0);
  assert.equal(pickKey(new Request("https://x", { headers: { "X-SerpApi-Key": USER_KEY } }), {}).source, "user");
});

test("CORS: Allow-Headers enthält X-SerpApi-Key", async () => {
  const res = await createHandler()(new Request("https://worker.test/shopping", { method: "OPTIONS", headers: { Origin: ORIGIN } }), ENV);
  assert.equal(res.status, 204);
  assert.match(res.headers.get("Access-Control-Allow-Headers"), /X-SerpApi-Key/);
  assert.match(res.headers.get("Access-Control-Allow-Headers"), /Content-Type/);
});

test("cached_only: Miss ohne SerpApi-Aufruf, Hit mit cached:true", async () => {
  const n = net();
  const cache = memCache();
  const h = mk(n, cache);
  const miss = await get(h, Q + "&cached_only=1");
  assert.equal(miss.status, 200);
  assert.deepEqual(await miss.json(), { cached: false });
  assert.equal(n.calls.account.length + n.calls.search.length, 0);

  const first = await (await get(h, Q)).json();
  assert.equal(first.cached, false);
  assert.equal(n.calls.search.length, 1);
  const before = n.calls.account.length;
  const hit = await (await get(h, Q + "&cached_only=1")).json();
  assert.equal(hit.cached, true);
  assert.equal(hit.results.length, 1);
  assert.equal(n.calls.search.length, 1);
  assert.equal(n.calls.account.length, before);
  // normaler Aufruf trifft ebenfalls den Cache
  assert.equal((await (await get(h, Q)).json()).cached, true);
  assert.equal(n.calls.search.length, 1);
});

test("exhausted: 429 ohne Suche (auch mit Reserve)", async () => {
  const n = net({ account: { ...ACCOUNT, total_searches_left: 0 } });
  const res = await get(mk(n), Q);
  assert.equal(res.status, 429);
  const j = await res.json();
  assert.equal(j.code, "quota_exhausted");
  assert.equal(j.error, "Monatliches Suchkontingent aufgebraucht");
  assert.equal(j.quota.exhausted, true);
  assert.equal(n.calls.search.length, 0);

  const n2 = net({ account: { ...ACCOUNT, total_searches_left: 5 } });
  const r2 = await get(mk(n2), Q, { env: { ...ENV, SERP_RESERVE: "5" } });
  assert.equal(r2.status, 429);
  assert.equal(n2.calls.search.length, 0);
});

test("Dekrement: quota in Antwort, Cache-Wert sinkt, warn wird erreicht", async () => {
  const n = net({ account: { ...ACCOUNT, total_searches_left: 51, this_month_usage: 199 } });
  const cache = memCache();
  const h = mk(n, cache);
  const a = await (await get(h, Q)).json();
  assert.equal(a.quota.left, 50);
  assert.equal(a.quota.used, 200);
  assert.equal(a.quota.warn, true);
  const q = await (await get(h, "/shopping/quota")).json();
  assert.equal(q.left, 50);
  assert.equal(n.calls.account.length, 1);
  await get(h, "/shopping?q=andere%20suche");
  assert.equal((await (await get(h, "/shopping/quota")).json()).left, 49);
});

test("Kontingent-Abruf scheitert: Suche läuft trotzdem, quota null", async () => {
  const n = net({ account: {}, accountStatus: 500 });
  const j = await (await get(mk(n), Q)).json();
  assert.equal(j.results.length, 1);
  assert.equal(j.quota, null);
  assert.equal(n.calls.search.length, 1);
});

test("SerpApi 'run out of searches' -> 429 quota_exhausted", async () => {
  const n = net({ shop: { error: "Your account has run out of searches." } });
  const res = await get(mk(n), Q);
  assert.equal(res.status, 429);
  assert.equal((await res.json()).code, "quota_exhausted");
});
