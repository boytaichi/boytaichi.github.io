// Kin PR #1 findings 4 (limits / bounded cache / mandatory rate limit), 6 (bindings fail closed, health probe),
// 7 (upstream sanitised; only validated results cached), 8 (EIP-1898 requireCanonical rejected), 11 (400 on allowlist rejection).
// Run from site/worker: node --test test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle, validateRequest, validateEnv, healthResponse, cacheKey, LIMITS, MemoryCache, CONTRACTS, PUBLIC_ERRORS } from "../src/index.js";
import { env, req, upstream, upstreamError, upstreamEnvelope, word, encodeAggregate, SITE, UPSTREAM_SECRET } from "./helpers.mjs";

const BLOCK = "0x3276f9f";
const T_CALL = { to: CONTRACTS.REWARD_ENGINE, data: "0x2bc80f3a" };
const call = (c, tag = BLOCK, id = 1) => ({ jsonrpc: "2.0", id, method: "eth_call", params: [c, tag] });
const leak = (s) => /SECRET-KEY|alchemy\.com/.test(s);

// --- Kin #4: limits ---------------------------------------------------------------------------------------------
test("Kin #4 — 1 MiB of trailing calldata is rejected (direct call, Multicall inner call) with 400 and never reaches upstream", async () => {
  const calls = [];
  const deps = { fetch: upstream("0x", calls), cache: new MemoryCache() };
  const big = "0x2bc80f3a" + "00".repeat(1024 * 1024);
  const direct = await handle(req(call({ to: CONTRACTS.REWARD_ENGINE, data: big })), env, deps);
  assert.equal(direct.status, 413); // 1 MiB of hex exceeds the body limit before anything is parsed
  // just over the per-call calldata limit but under the body limit → 400 "calldata too long"
  const over = "0x2bc80f3a" + "00".repeat(LIMITS.MAX_CALLDATA_BYTES);
  const r = await handle(req(call({ to: CONTRACTS.REWARD_ENGINE, data: over })), env, deps);
  assert.equal(r.status, 400);
  assert.match((await r.json()).error.message, /calldata too long/);
  const innerBig = encodeAggregate([{ to: CONTRACTS.REWARD_ENGINE, data: "0x2bc80f3a" + "00".repeat(LIMITS.MAX_INNER_CALLDATA_BYTES) }]);
  const v = validateRequest(call({ to: CONTRACTS.MULTICALL3, data: innerBig }));
  assert.equal(v.ok, false);
  assert.match(v.error.body.error.message, /inner calldata too long/);
  assert.equal(calls.length, 0);
  // exactly at the limit is fine (balanceOf(address) = 36 bytes is the largest page call)
  assert.equal(validateRequest(call({ to: CONTRACTS.PSRE, data: "0x70a08231" + "00".repeat(32) })).ok, true);
});

test("Kin #4 — request body over MAX_BODY_BYTES → 413; more than MAX_INNER_CALLS inner calls → 400; malformed offsets never throw", async () => {
  const deps = { fetch: upstream("0x"), cache: new MemoryCache() };
  const padded = { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [], pad: "x".repeat(LIMITS.MAX_BODY_BYTES) };
  const r = await handle(req(padded), env, deps);
  assert.equal(r.status, 413);
  assert.equal((await r.json()).error.message, PUBLIC_ERRORS.BODY_TOO_LARGE);
  const many = encodeAggregate(Array.from({ length: LIMITS.MAX_INNER_CALLS + 1 }, () => ({ to: CONTRACTS.PSRE, data: "0x18160ddd" })));
  const v = validateRequest(call({ to: CONTRACTS.MULTICALL3, data: many }));
  assert.equal(v.ok, false);
  assert.match(v.error.body.error.message, /inner calls/);
  const ok = encodeAggregate(Array.from({ length: LIMITS.MAX_INNER_CALLS }, () => ({ to: CONTRACTS.PSRE, data: "0x18160ddd" })));
  assert.equal(validateRequest(call({ to: CONTRACTS.MULTICALL3, data: ok })).ok, true);
  // offsets pointing outside the calldata are a malformed multicall, not an exception
  const evil = "0x252dba42" + word(0x20).slice(2) + word(1).slice(2) + word(0xffffff00).slice(2);
  const e = validateRequest(call({ to: CONTRACTS.MULTICALL3, data: evil }));
  assert.equal(e.ok, false);
  assert.match(e.error.body.error.message, /malformed/);
});

test("Kin #4 — the in-isolate cache is bounded: a 10,000-entry probe stays at MAX_CACHE_ENTRIES with LRU eviction; the key is a hash, never raw calldata", async () => {
  const cache = new MemoryCache();
  const deps = { fetch: upstream("0x" + "00".repeat(32)), cache };
  for (let i = 0; i < 10_000; i++) {
    const r = await handle(req(call({ to: CONTRACTS.PSRE, data: "0x70a08231" + i.toString(16).padStart(64, "0") })), env, deps);
    assert.equal(r.status, 200);
  }
  assert.equal(cache.size, LIMITS.MAX_CACHE_ENTRIES);
  // LRU: the most recent entry is a HIT, the first one was evicted
  const last = await handle(req(call({ to: CONTRACTS.PSRE, data: "0x70a08231" + (9999).toString(16).padStart(64, "0") })), env, deps);
  assert.equal(last.headers.get("X-Prospereum-Cache"), "HIT");
  const first = await handle(req(call({ to: CONTRACTS.PSRE, data: "0x70a08231" + (0).toString(16).padStart(64, "0") })), env, deps);
  assert.equal(first.headers.get("X-Prospereum-Cache"), "MISS");
  const key = await cacheKey({ method: "eth_call", params: [{ to: CONTRACTS.PSRE, data: "0x70a08231" + "ab".repeat(32) }, BLOCK] });
  assert.match(key, /^eth_call:[0-9a-f]{64}$/);
  assert.doesNotMatch(key, /abab/);
  for (const k of cache.map.keys()) assert.ok(k.length < 80, "cache keys are fixed-size hashes");
  // direct LRU unit check
  const lru = new MemoryCache(() => 0, 2);
  await lru.put("a", 1, 60); await lru.put("b", 2, 60); await lru.get("a"); await lru.put("c", 3, 60);
  assert.equal(await lru.get("b"), null);
  assert.equal(await lru.get("a"), 1);
  assert.equal(await lru.get("c"), 3);
});

test("Kin #4/#6 — rate limiting is mandatory: no RATE_LIMITER binding → 503 fixed message; DEV_ALLOW_NO_RATE_LIMIT=\"true\" is the only bypass; a throwing limiter fails closed (429)", async () => {
  const { RATE_LIMITER, ...noLimiter } = env;
  const deps = { fetch: upstream("0x2105") };
  const r = await handle(req({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), noLimiter, deps);
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { error: PUBLIC_ERRORS.MISCONFIGURED });
  const dev = await handle(req({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), { ...noLimiter, DEV_ALLOW_NO_RATE_LIMIT: "true" }, deps);
  assert.equal(dev.status, 200);
  const notQuite = await handle(req({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), { ...noLimiter, DEV_ALLOW_NO_RATE_LIMIT: "yes" }, deps);
  assert.equal(notQuite.status, 503);
  const throwing = await handle(req({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), { ...env, RATE_LIMITER: { limit: async () => { throw new Error("binding down"); } } }, deps);
  assert.equal(throwing.status, 429);
});

// --- Kin #6: bindings + health ----------------------------------------------------------------------------------
test("Kin #6 — each required binding is validated at request time; any bad one → 503 with the same fixed message and no detail", async () => {
  const bad = [
    { ...env, SITE_ORIGIN: undefined },
    { ...env, SITE_ORIGIN: "prospereum.io" },
    { ...env, SITE_ORIGIN: "https://prospereum.io/" }, // not an origin (trailing path)
    { ...env, SITE_ORIGIN: "ftp://prospereum.io" },
    { ...env, UPSTREAM_URL: undefined },
    { ...env, UPSTREAM_URL: "not a url" },
    { ...env, CACHE_TTL_SECONDS: "0" },
    { ...env, CACHE_TTL_SECONDS: "abc" },
    { ...env, CACHE_TTL_SECONDS: "99999" },
    { ...env, RATE_LIMITER: {} },
    {},
    null,
  ];
  for (const e of bad) {
    assert.equal(validateEnv(e).ok, false, JSON.stringify(e));
    const r = await handle(req({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), e, { fetch: upstream("0x2105") });
    assert.equal(r.status, 503);
    const text = await r.text();
    assert.equal(text, JSON.stringify({ error: PUBLIC_ERRORS.MISCONFIGURED }));
    assert.ok(!leak(text));
  }
  const good = validateEnv(env);
  assert.equal(good.ok, true);
  assert.equal(good.config.ttl, 60);
  assert.equal(validateEnv({ ...env, CACHE_TTL_SECONDS: undefined }).config.ttl, 60); // default
});

test("Kin #6 — GET …/health exercises one allowed and one rejected call shape without any upstream call; 503 when misconfigured", async () => {
  let upstreamCalls = 0;
  const deps = { fetch: async () => { upstreamCalls++; return new Response("{}"); } };
  const ok = await handle(new Request("https://prospereum.io/rpc/health", { method: "GET" }), env, deps);
  assert.equal(ok.status, 200);
  const text = await ok.text();
  assert.ok(!leak(text));
  assert.deepEqual(JSON.parse(text), { ok: true, config: true, allowedShapeAccepted: true, rejectedShapeRefused: true, upstream: "Alchemy (Base mainnet)", rateLimiter: true });
  assert.equal(upstreamCalls, 0);
  const sub = await handle(new Request("https://rpc.prospereum.io/health", { method: "GET" }), env, deps);
  assert.equal(sub.status, 200);
  const { RATE_LIMITER, ...noLimiter } = env;
  const broken = await handle(new Request("https://prospereum.io/rpc/health", { method: "GET" }), noLimiter, deps);
  assert.equal(broken.status, 503);
  assert.deepEqual(await broken.json(), { ok: false, error: PUBLIC_ERRORS.MISCONFIGURED });
  assert.equal(healthResponse({ ...env, UPSTREAM_URL: "x" }).status, 503);
  // plain GET on the rpc path is still 405 (verify-deploy.mjs contract)
  assert.equal((await handle(new Request("https://prospereum.io/rpc", { method: "GET", headers: { origin: SITE } }), env, deps)).status, 405);
});

// --- Kin #7: upstream sanitised --------------------------------------------------------------------------------
test("Kin #7 — upstream timeout, non-200 status, non-JSON, wrong JSON-RPC shape and malformed results → 502 with fixed messages; nothing cached; nothing leaks", async () => {
  const chainId = () => req({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
  const cases = [
    ["timeout", { fetch: (_, init) => new Promise((_r, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted " + UPSTREAM_SECRET)))), timeoutMs: 20 }, PUBLIC_ERRORS.UPSTREAM_UNAVAILABLE],
    ["http 500", { fetch: async () => new Response("internal " + UPSTREAM_SECRET, { status: 500 }) }, PUBLIC_ERRORS.UPSTREAM_UNAVAILABLE],
    ["http 401", { fetch: upstreamEnvelope((id) => ({ jsonrpc: "2.0", id, result: "0x2105" }), 401) }, PUBLIC_ERRORS.UPSTREAM_UNAVAILABLE],
    ["not json", { fetch: async () => new Response("<html>rate limited " + UPSTREAM_SECRET) }, PUBLIC_ERRORS.UPSTREAM_INVALID],
    ["array body", { fetch: async () => new Response("[]") }, PUBLIC_ERRORS.UPSTREAM_INVALID],
    ["no jsonrpc", { fetch: upstreamEnvelope((id) => ({ id, result: "0x2105" })) }, PUBLIC_ERRORS.UPSTREAM_INVALID],
    ["no result", { fetch: upstreamEnvelope((id) => ({ jsonrpc: "2.0", id })) }, PUBLIC_ERRORS.UPSTREAM_INVALID],
    ["result not hex", { fetch: upstreamEnvelope((id) => ({ jsonrpc: "2.0", id, result: "8453" })) }, PUBLIC_ERRORS.UPSTREAM_INVALID],
    ["result leading zero", { fetch: upstreamEnvelope((id) => ({ jsonrpc: "2.0", id, result: "0x02105" })) }, PUBLIC_ERRORS.UPSTREAM_INVALID],
    ["result object", { fetch: upstreamEnvelope((id) => ({ jsonrpc: "2.0", id, result: { url: UPSTREAM_SECRET } })) }, PUBLIC_ERRORS.UPSTREAM_INVALID],
    ["error not object", { fetch: upstreamEnvelope((id) => ({ jsonrpc: "2.0", id, error: "boom " + UPSTREAM_SECRET })) }, PUBLIC_ERRORS.UPSTREAM_INVALID],
  ];
  for (const [name, deps, msg] of cases) {
    const cache = new MemoryCache();
    const r = await handle(chainId(), env, { ...deps, cache });
    assert.equal(r.status, 502, name);
    const body = await r.json();
    assert.equal(body.error.message, msg, name);
    assert.equal(body.error.code, -32000, name);
    assert.deepEqual(Object.keys(body).sort(), ["error", "id", "jsonrpc"], name);
    assert.equal(cache.size, 0, `${name}: nothing cached`);
    assert.ok(!leak(JSON.stringify(body)), name);
  }
});

test("Kin #7 — upstream JSON-RPC errors are forwarded with a fixed public message (integer code kept, data dropped); eth_call results must be hex bytes; block headers are field-filtered", async () => {
  const cache = new MemoryCache();
  const errUp = upstreamError({ code: 3, message: "execution reverted: nope " + UPSTREAM_SECRET, data: UPSTREAM_SECRET });
  const r = await handle(req(call(T_CALL)), env, { fetch: errUp, cache });
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.deepEqual(b.error, { code: 3, message: PUBLIC_ERRORS.EXECUTION_REVERTED });
  assert.equal(cache.size, 0);
  const other = upstreamError({ code: -32005, message: "invalid api key " + UPSTREAM_SECRET });
  const o = await (await handle(req(call(T_CALL)), env, { fetch: other, cache })).json();
  assert.deepEqual(o.error, { code: -32005, message: PUBLIC_ERRORS.UPSTREAM_RPC_ERROR });
  // round 2 #7: an error object with a non-integer code is an invalid envelope → 502, not a forwarded error
  const badShape = await handle(req(call(T_CALL)), env, { fetch: upstreamError({ code: "x", message: "invalid api key " + UPSTREAM_SECRET }), cache });
  assert.equal(badShape.status, 502);
  assert.equal((await badShape.json()).error.message, PUBLIC_ERRORS.UPSTREAM_INVALID);
  // eth_call result that is not hex bytes → invalid, not cached
  const odd = await handle(req(call(T_CALL)), env, { fetch: upstream("0x123"), cache });
  assert.equal(odd.status, 502);
  assert.equal(cache.size, 0);
  // block header: only known hex fields pass; a stray field carrying the upstream URL is dropped
  const blk = { number: BLOCK, hash: "0x" + "ab".repeat(32), parentHash: "0x" + "cd".repeat(32), timestamp: "0x68f7a2b1", extraData: UPSTREAM_SECRET, miner: "0x" + "11".repeat(20) };
  const hb = await handle(req({ jsonrpc: "2.0", id: 9, method: "eth_getBlockByNumber", params: [BLOCK, false] }), env, { fetch: upstream(blk), cache });
  assert.equal(hb.status, 200);
  const hbody = await hb.json();
  assert.deepEqual(hbody.result, { number: BLOCK, hash: "0x" + "ab".repeat(32), parentHash: "0x" + "cd".repeat(32), timestamp: "0x68f7a2b1", miner: "0x" + "11".repeat(20) });
  assert.ok(!leak(JSON.stringify(hbody)));
  assert.equal(cache.size, 1); // the validated header IS cached
  const missingTs = await handle(req({ jsonrpc: "2.0", id: 9, method: "eth_getBlockByNumber", params: ["0x1", false] }), env, { fetch: upstream({ number: "0x1", hash: "0x" + "ab".repeat(32) }), cache });
  assert.equal(missingTs.status, 502);
});

// --- Kin #8: EIP-1898 requireCanonical -----------------------------------------------------------------------
test("Kin #8 — an EIP-1898 tag with requireCanonical (true or false) is rejected; plain {blockHash} and {blockNumber} still work", () => {
  for (const tag of [{ blockHash: "0x" + "ab".repeat(32), requireCanonical: true }, { blockHash: "0x" + "ab".repeat(32), requireCanonical: false }, { blockNumber: BLOCK, requireCanonical: true }]) {
    const r = validateRequest(call(T_CALL, tag));
    assert.equal(r.ok, false, JSON.stringify(tag));
    assert.match(r.error.body.error.message, /requireCanonical/);
  }
  assert.deepEqual(validateRequest(call(T_CALL, { blockHash: "0x" + "AB".repeat(32) })).normalized.params[1], { blockHash: "0x" + "ab".repeat(32) });
  assert.equal(validateRequest(call(T_CALL, { blockNumber: BLOCK })).normalized.params[1], BLOCK);
  assert.equal(validateRequest(call(T_CALL, { blockHash: "0x" + "ab".repeat(32), extra: 1 })).ok, false);
  assert.equal(validateRequest(call(T_CALL, [BLOCK])).ok, false);
});

// --- Kin #11: the HTTP contract for an allowlist rejection -------------------------------------------------
test("Kin #11 — an allowlist rejection is HTTP 400 with JSON-RPC -32602 (DEPLOY.md §2 says the same)", async () => {
  const r = await handle(req(call({ to: CONTRACTS.PSRE, data: "0xa9059cbb" })), env, { fetch: upstream("0x") });
  assert.equal(r.status, 400);
  const b = await r.json();
  assert.equal(b.error.code, -32602);
  assert.match(b.error.message, /call not allowed/);
});
