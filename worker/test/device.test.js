import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../src/index.js";

const ORIGIN = "https://ysfbzn0301.github.io";
const SERVER_KEY = "serverkey" + "A".repeat(20);
const USER_KEY = "userkey" + "B".repeat(20);
const DEV = "123e4567-e89b-12d3-a456-426614174000";
const IP = "203.0.113.7";
const ACCOUNT = {
  plan_name: "Free", searches_per_month: 1000, total_searches_left: 900, this_month_usage: 100,
  last_hour_searches: 1, account_rate_limit_per_hour: 50, plan_renewal_date: "2026-11-01",
};
const SHOP = { shopping_results: [{ title: "Monster Energy Ultra 0,5 l", price: "1,49 €", extracted_price: 1.49, link: "https://a.example/m", source: "Rewe" }] };
const Q = "/shopping?q=monster%20energy%20ultra";

function memKV() {
  const m = new Map();
  const opts = [];
  return {
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v, o) { m.set(k, v); opts.push(o); },
    m, opts,
  };
}
function memCache() {
  const m = new Map();
  return {
    async match(r) { const v = m.get(r.url); return v ? v.clone() : undefined; },
    async put(r, v) { m.set(r.url, v); },
  };
}
function net() {
  const calls = { account: 0, search: 0 };
  const fetch = async (url) => {
    if (new URL(url).pathname === "/account.json") { calls.account++; return new Response(JSON.stringify(ACCOUNT)); }
    calls.search++;
    return new Response(JSON.stringify(SHOP));
  };
  return { fetch, calls };
}
function setup({ now = "2026-10-15T12:00:00Z", cache = memCache(), kv = memKV(), env = {} } = {}) {
  const n = net();
  const clock = { t: now };
  const h = createHandler(undefined, { fetch: n.fetch, cache, now: () => new Date(clock.t) });
  const E = { ALLOWED_ORIGINS: ORIGIN, SERPAPI_KEY: SERVER_KEY, USAGE: kv, ...env };
  const get = (path, { dev = DEV, ip = IP, key, env: e = E } = {}) => {
    const headers = { Origin: ORIGIN };
    if (dev) headers["X-Device-Id"] = dev;
    if (ip) headers["CF-Connecting-IP"] = ip;
    if (key) headers["X-SerpApi-Key"] = key;
    return h(new Request("https://worker.test" + path, { headers }), e);
  };
  return { n, kv, get, clock, cache, E };
}
const uq = (i) => `/shopping?q=produkt%20nummer%20${i}`;

test("Zählt nur echte Suchen; Cache-Treffer und cached_only zählen nicht; device-Objekt", async () => {
  const s = setup();
  const miss = await (await s.get(Q + "&cached_only=1")).json();
  assert.equal(miss.cached, false);
  assert.equal(s.n.calls.search, 0);
  assert.equal(s.kv.m.size, 0);
  const r1 = await (await s.get(Q)).json();
  assert.equal(r1.cached, false);
  assert.deepEqual(r1.quota.device, { limit: 10, used: 1, left: 9, warn: false, exhausted: false, resets: "2026-11-01" });
  assert.equal(s.kv.m.size, 2);
  assert.ok(s.kv.opts.every((o) => o.expirationTtl === 40 * 24 * 3600));
  const r2 = await (await s.get(Q)).json(); // Cache-Treffer
  assert.equal(r2.cached, true);
  assert.equal(r2.quota.device.used, 1);
  const r3 = await (await s.get(Q + "&cached_only=1")).json();
  assert.equal(r3.cached, true);
  assert.equal(r3.quota.device.used, 1);
  assert.equal(s.n.calls.search, 1);
  assert.deepEqual([...s.kv.m.values()], ["1", "1"]);
});

test("Hashing: keine Roh-ID/IP im KV-Schlüssel oder in Antworten", async () => {
  const s = setup();
  const res = await s.get(Q);
  const text = await res.text();
  assert.ok(!text.includes(DEV) && !text.includes(IP));
  const keys = [...s.kv.m.keys()];
  assert.equal(keys.length, 2);
  for (const k of keys) {
    assert.ok(!k.includes(DEV) && !k.includes(IP) && !k.includes("123e4567"));
    assert.match(k, /^(dev|ip):[0-9a-f]{32}:2026-10$/);
  }
  assert.ok(keys.some((k) => k.startsWith("dev:")) && keys.some((k) => k.startsWith("ip:")));
});

test("Gerätelimit: Sperre ohne SerpApi-Aufruf, warn bei <= 2, Monatswechsel", async () => {
  const s = setup();
  let last;
  for (let i = 0; i < 10; i++) last = await (await s.get(uq(i))).json();
  assert.equal(last.quota.device.exhausted, true);
  assert.equal(last.quota.device.left, 0);
  const warnRes = await (await s.get(uq(7) + "&cached_only=1")).json();
  assert.equal(warnRes.quota.device.used, 10);
  assert.equal(s.n.calls.search, 10);
  const blocked = await s.get(uq(99));
  assert.equal(blocked.status, 429);
  const b = await blocked.json();
  assert.equal(b.code, "device_limit");
  assert.equal(b.error, "Dein monatliches Limit für Echtzeit-Suchen ist erreicht");
  assert.equal(b.quota.device.exhausted, true);
  assert.equal(b.quota.device.resets, "2026-11-01");
  assert.equal(s.n.calls.search, 10);
  // cached_only wird nicht gesperrt
  assert.equal((await (await s.get(uq(99) + "&cached_only=1")).json()).cached, false);
  // Neuer Monat
  s.clock.t = "2026-11-02T00:00:00Z";
  const ok = await s.get(uq(99));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).quota.device.used, 1);
});

test("Warnung: device.warn bei <= SERP_DEVICE_WARN übrig", async () => {
  const s = setup({ env: { SERP_DEVICE_LIMIT: "4", SERP_DEVICE_WARN: "2" } });
  const w = [];
  for (let i = 0; i < 4; i++) w.push((await (await s.get(uq(i))).json()).quota.device);
  assert.deepEqual(w.map((d) => d.warn), [false, true, true, false]);
  assert.deepEqual(w.map((d) => d.left), [3, 2, 1, 0]);
});

test("IP-Limit: Sperre auch mit anderer Geräte-ID und ohne Geräte-ID", async () => {
  const s = setup({ env: { SERP_IP_LIMIT: "3", SERP_DEVICE_LIMIT: "100" } });
  await s.get(uq(1), { dev: DEV });
  await s.get(uq(2), { dev: "a".repeat(32) });
  await s.get(uq(3), { dev: null });
  const r = await s.get(uq(4), { dev: "b".repeat(40) });
  assert.equal(r.status, 429);
  const j = await r.json();
  assert.equal(j.code, "device_limit");
  assert.equal(j.error, "Limit für dieses Netzwerk erreicht");
  assert.equal(s.n.calls.search, 3);
});

test("Fehlende Geräte-ID: nur IP-Limit greift, device null", async () => {
  const s = setup();
  const r = await (await s.get(Q, { dev: null })).json();
  assert.equal(r.quota.device, null);
  assert.deepEqual([...s.kv.m.keys()].map((k) => k.split(":")[0]), ["ip"]);
});

test("Ungültige Geräte-ID -> 400", async () => {
  const s = setup();
  for (const bad of ["abc", "not-a-uuid-at-all", "g".repeat(32), "a".repeat(65), "<script>"]) {
    const r = await s.get(Q, { dev: bad });
    assert.equal(r.status, 400, bad);
    assert.deepEqual(await r.json(), { error: "Ungültige Geräte-ID" });
  }
  assert.equal(s.n.calls.search, 0);
  assert.equal((await s.get("/shopping/quota", { dev: "x" })).status, 400);
  assert.equal((await s.get(Q, { dev: "A".repeat(32) })).status, 200); // Großbuchstaben ok
});

test("Eigener Schlüssel zählt nicht und hat kein Gerätelimit", async () => {
  const s = setup({ env: { SERP_DEVICE_LIMIT: "1" } });
  await s.get(Q); // verbraucht das Limit
  assert.equal((await s.get(uq(2))).status, 429);
  const r = await s.get(uq(2), { key: USER_KEY });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.quota.device, null);
  assert.equal(j.quota.key_source, "user");
  assert.deepEqual([...s.kv.m.values()], ["1", "1"]);
  const qq = await (await s.get("/shopping/quota", { key: USER_KEY })).json();
  assert.equal(qq.device, null);
});

test("/shopping/quota liefert device-Stand", async () => {
  const s = setup();
  await s.get(Q);
  const q = await (await s.get("/shopping/quota")).json();
  assert.equal(q.key_source, "server");
  assert.deepEqual(q.device, { limit: 10, used: 1, left: 9, warn: false, exhausted: false, resets: "2026-11-01" });
});

test("Fehlendes Binding: Limit aus, health-Flag false; mit Binding true", async () => {
  const s = setup();
  const noKv = { ...s.E, USAGE: undefined };
  for (let i = 0; i < 12; i++) assert.equal((await s.get(uq(i), { env: noKv })).status, 200);
  const j = await (await s.get(uq(1) + "&cached_only=1", { env: noKv })).json();
  assert.equal(j.quota, undefined);
  const q = await (await s.get("/shopping/quota", { env: noKv })).json();
  assert.equal(q.device, null);
  const h1 = await (await s.get("/health", { env: noKv })).json();
  const h2 = await (await s.get("/health")).json();
  assert.equal(h1.features.device_limit, false);
  assert.equal(h2.features.device_limit, true);
});

test("Limit 0 = aus", async () => {
  const s = setup({ env: { SERP_DEVICE_LIMIT: "0", SERP_IP_LIMIT: "0" } });
  for (let i = 0; i < 12; i++) assert.equal((await s.get(uq(i))).status, 200);
  assert.equal(s.kv.m.size, 0);
  assert.equal((await (await s.get("/shopping/quota")).json()).device, null);
  const s2 = setup({ env: { SERP_DEVICE_LIMIT: "0", SERP_IP_LIMIT: "50" } });
  const r = await (await s2.get(Q)).json();
  assert.equal(r.quota.device, null);
  assert.deepEqual([...s2.kv.m.keys()].map((k) => k.split(":")[0]), ["ip"]);
});

test("CORS: Allow-Headers enthält X-Device-Id", async () => {
  const s = setup();
  const res = await s.get("/shopping", { dev: null });
  assert.match(res.headers.get("Access-Control-Allow-Headers"), /X-Device-Id/);
  const pre = await createHandler()(new Request("https://worker.test/shopping", { method: "OPTIONS", headers: { Origin: ORIGIN } }), s.E);
  assert.match(pre.headers.get("Access-Control-Allow-Headers"), /X-Device-Id/);
});
