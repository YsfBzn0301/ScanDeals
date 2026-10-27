import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { createHandler } from "../src/index.js";

const ORIGIN = "https://ysfbzn0301.github.io";
const ENV = { ALLOWED_ORIGINS: `${ORIGIN},http://localhost:8080`, MODEL: "claude-opus-5-5", ANTHROPIC_API_KEY: "test-key" };
const IMG = Buffer.from("fake-jpeg-bytes-for-test").toString("base64");

const GOOD = {
  is_product: true, name: "Logitech MX Master 3S", brand: "Logitech", model: "MX Master 3S",
  category: "Computermaus", confidence: 0.98, search_query: "Logitech MX Master 3S", barcode: null,
};

function clientReturning(response, calls = []) {
  return () => ({ beta: { messages: { create: async (args) => { calls.push(args); return response; } } } });
}
function clientThrowing(err) {
  return () => ({ beta: { messages: { create: async () => { throw err; } } } });
}
function req(path, { method = "POST", origin = ORIGIN, body, headers = {} } = {}) {
  const h = { ...headers };
  if (origin) h.Origin = origin;
  return new Request("https://worker.test" + path, {
    method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}
const textResp = (obj) => ({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: JSON.stringify(obj) }] });

test("OPTIONS: erlaubter Origin -> 204 mit CORS", async () => {
  const res = await createHandler(clientReturning(null))(req("/identify", { method: "OPTIONS" }), ENV);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
});

test("OPTIONS: fremder Origin -> 403", async () => {
  const res = await createHandler(clientReturning(null))(req("/identify", { method: "OPTIONS", origin: "https://evil.example" }), ENV);
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
});

test("POST mit fremdem Origin -> 403 ohne CORS-Header", async () => {
  const res = await createHandler(clientReturning(textResp(GOOD)))(req("/identify", { origin: "https://evil.example", body: { image: IMG } }), ENV);
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
});

test("POST ohne Origin -> 403", async () => {
  const res = await createHandler(clientReturning(textResp(GOOD)))(req("/identify", { origin: null, body: { image: IMG } }), ENV);
  assert.equal(res.status, 403);
});

test("Origin wird exakt verglichen (Präfix reicht nicht)", async () => {
  const res = await createHandler(clientReturning(textResp(GOOD)))(req("/health", { method: "GET", origin: ORIGIN + ".evil.com" }), ENV);
  assert.equal(res.status, 403);
});

test("/health -> ok, model, configured", async () => {
  const res = await createHandler()(req("/health", { method: "GET" }), ENV);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, model: "claude-opus-5-5", configured: true, features: { ai: true, prices: false } });
  const res2 = await createHandler()(req("/health", { method: "GET" }), { ...ENV, ANTHROPIC_API_KEY: undefined });
  assert.equal((await res2.json()).configured, false);
});

test("Unbekannter Pfad -> 404", async () => {
  const res = await createHandler()(req("/nope", { method: "GET" }), ENV);
  assert.equal(res.status, 404);
});

test("Body zu groß -> 413", async () => {
  const big = JSON.stringify({ image: "A".repeat(1.6 * 1024 * 1024) });
  const res = await createHandler(clientReturning(textResp(GOOD)))(req("/identify", { body: big }), ENV);
  assert.equal(res.status, 413);
});

test("Ungültiges Base64 -> 400", async () => {
  const h = createHandler(clientReturning(textResp(GOOD)));
  for (const image of ["das ist kein base64!!", "abc", 123, undefined]) {
    const res = await h(req("/identify", { body: { image } }), ENV);
    assert.equal(res.status, 400, String(image));
  }
  const res = await h(req("/identify", { body: "{kaputt" }), ENV);
  assert.equal(res.status, 400);
});

test("Erfolg: Aufruf gemäß Spec und normalisierte Antwort", async () => {
  const calls = [];
  const res = await createHandler(clientReturning(textResp({ ...GOOD, confidence: 7, name: "x".repeat(500), barcode: "4006381333931" }), calls))(
    req("/identify", { body: { image: IMG, hint: "mouse" } }), ENV);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  const data = await res.json();
  assert.equal(data.confidence, 1);
  assert.equal(data.name.length, 200);
  assert.equal(data.barcode, "4006381333931");
  assert.equal(data.is_product, true);
  const c = calls[0];
  assert.equal(c.model, "claude-opus-5-5");
  assert.deepEqual(c.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(c.fallbacks, "default");
  assert.equal(c.output_config.effort, "low");
  assert.equal(c.output_config.format.type, "json_schema");
  assert.equal(c.messages[0].content[0].source.data, IMG);
  assert.match(c.messages[0].content[1].text, /mouse/);
});

test("Ungültiger Barcode wird zu null, fehlende Felder werden bereinigt", async () => {
  const res = await createHandler(clientReturning(textResp({ ...GOOD, barcode: "12ab", confidence: -3 })))(req("/identify", { body: { image: IMG } }), ENV);
  const data = await res.json();
  assert.equal(data.barcode, null);
  assert.equal(data.confidence, 0);
});

test("refusal -> 422", async () => {
  const res = await createHandler(clientReturning({ stop_reason: "refusal", content: [] }))(req("/identify", { body: { image: IMG } }), ENV);
  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), { error: "Bild konnte nicht analysiert werden" });
});

test("Kaputtes JSON vom Modell -> 502", async () => {
  const res = await createHandler(clientReturning({ stop_reason: "end_turn", content: [{ type: "text", text: "kein json" }] }))(req("/identify", { body: { image: IMG } }), ENV);
  assert.equal(res.status, 502);
});

test("Rate-Limit: 21. Anfrage pro IP -> 429, andere IP ok", async () => {
  const h = createHandler(clientReturning(textResp(GOOD)));
  const r = (ip) => h(req("/identify", { body: { image: IMG }, headers: { "CF-Connecting-IP": ip } }), ENV);
  for (let i = 0; i < 20; i++) assert.equal((await r("1.2.3.4")).status, 200);
  assert.equal((await r("1.2.3.4")).status, 429);
  assert.equal((await r("5.6.7.8")).status, 200);
});

test("Fehlerklassen-Mapping mit echten SDK-Klassen, ohne Detail-Leak", async () => {
  const cases = [
    [new Anthropic.AuthenticationError(401, {}, "SECRET sk-ant-123", new Headers()), 500, "Server-Schlüssel ungültig"],
    [new Anthropic.RateLimitError(429, {}, "SECRET sk-ant-123", new Headers()), 429, null],
    [new Anthropic.InternalServerError(500, {}, "SECRET sk-ant-123", new Headers()), 502, null],
    [new Anthropic.BadRequestError(400, {}, "SECRET sk-ant-123", new Headers()), 502, null],
    [new Error("SECRET sk-ant-123"), 500, null],
  ];
  for (const [err, status, msg] of cases) {
    const res = await createHandler(clientThrowing(err))(req("/identify", { body: { image: IMG } }), ENV);
    assert.equal(res.status, status, err.constructor.name);
    const text = await res.text();
    assert.ok(!text.includes("SECRET") && !text.includes("sk-ant"));
    if (msg) assert.equal(JSON.parse(text).error, msg);
  }
});

test("Fehlender Server-Key -> 500 ohne Aufruf", async () => {
  const res = await createHandler(clientReturning(textResp(GOOD)))(req("/identify", { body: { image: IMG } }), { ...ENV, ANTHROPIC_API_KEY: "" });
  assert.equal(res.status, 500);
});
