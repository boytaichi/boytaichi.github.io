// Run: node --test documents/axia/prospereum/site/worker/test
// Kin's three acceptance tests (2026-10-25) + the sheet v2 row-2 rules. No dependencies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle, validateRequest, decodeCalls, cacheKey, CONTRACTS, MemoryCache } from "../src/index.js";

const SITE = "https://prospereum.io";
const env = { SITE_ORIGIN: SITE, UPSTREAM_URL: "https://base-mainnet.g.alchemy.com/v2/SECRET-KEY-NEVER-SHOWN", UPSTREAM_NAME: "Alchemy (Base mainnet)", CACHE_TTL_SECONDS: "60" };

function req(body, headers = {}) {
  return new Request("https://rpc.prospereum.io/", { method: "POST", headers: { "content-type": "application/json", origin: SITE, ...headers }, body: JSON.stringify(body) });
}
function upstream(result, calls = []) {
  return async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { headers: { "content-type": "application/json" } });
  };
}
const T_CALL = { to: CONTRACTS.REWARD_ENGINE, data: "0x2bc80f3a" }; // RewardEngine.T()
const BLOCK = "0x3276f9f"; // 52,919,775

// --- Kin #1: reject JSON-RPC batches ---------------------------------------------------------------------
test("Kin #1 — a JSON-RPC batch is rejected with -32600 and never reaches upstream", async () => {
  const calls = [];
  const res = await handle(req([{ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }, { jsonrpc: "2.0", id: 2, method: "eth_call", params: [T_CALL, BLOCK] }]), env, { fetch: upstream("0x", calls) });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, -32600);
  assert.match(body.error.message, /batch/);
  assert.equal(calls.length, 0);
});

// --- Kin #2: eth_getBlockByNumber concrete number + header-only ---------------------------------------------
test("Kin #2 — eth_getBlockByNumber accepts a concrete hex number with false; rejects latest/safe/finalized/pending and full=true", async () => {
  const ok = validateRequest({ jsonrpc: "2.0", id: 7, method: "eth_getBlockByNumber", params: [BLOCK, false] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.normalized.params, [BLOCK, false]);
  for (const tag of ["latest", "safe", "finalized", "pending", "earliest", 123, "0x", "0x0g"]) {
    const r = validateRequest({ jsonrpc: "2.0", id: 7, method: "eth_getBlockByNumber", params: [tag, false] });
    assert.equal(r.ok, false, `tag ${tag} must be rejected`);
    assert.equal(r.error.body.error.code, -32602);
  }
  const full = validateRequest({ jsonrpc: "2.0", id: 7, method: "eth_getBlockByNumber", params: [BLOCK, true] });
  assert.equal(full.ok, false);
  assert.match(full.error.body.error.message, /false/);
});

// --- Kin #3: upstream identity header exposed through CORS ---------------------------------------------------
test("Kin #3 — upstream identity is a response header exposed via CORS; the JSON-RPC body is untouched and the key never appears", async () => {
  const calls = [];
  const res = await handle(req({ jsonrpc: "2.0", id: "abc", method: "eth_call", params: [T_CALL, BLOCK] }), env, { fetch: upstream("0x" + "0".repeat(64), calls) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("X-Prospereum-Upstream"), "Alchemy (Base mainnet)");
  assert.match(res.headers.get("Access-Control-Expose-Headers"), /X-Prospereum-Upstream/);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), SITE);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ["id", "jsonrpc", "result"]);
  assert.equal(body.id, "abc"); // caller's id preserved (rule d)
  assert.equal(body.result, "0x" + "0".repeat(64));
  const text = JSON.stringify(body) + [...res.headers].join(" ");
  assert.doesNotMatch(text, /SECRET-KEY|alchemy\.com/);
  assert.equal(calls[0].body.params[1], BLOCK); // the pinned tag went upstream verbatim
});

// --- sheet v2 row 2 (c): explicit block tags only --------------------------------------------------------------
test("eth_call: latest/pending/safe/finalized rejected; hex number and {blockHash} accepted", () => {
  for (const tag of ["latest", "pending", "safe", "finalized", undefined, null, 52919775]) {
    const r = validateRequest({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [T_CALL, tag] });
    assert.equal(r.ok, false, `tag ${tag}`);
  }
  assert.equal(validateRequest({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [T_CALL, BLOCK] }).ok, true);
  const h = validateRequest({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [T_CALL, { blockHash: "0x" + "ab".repeat(32) }] });
  assert.equal(h.ok, true);
  assert.deepEqual(h.normalized.params[1], { blockHash: "0x" + "ab".repeat(32) });
});

// --- sheet v2 row 2 (b): contract + selector allowlist, Multicall3 inner validation -----------------------------
test("allowlist is contract AND selector; a wrong selector on an allowed contract and an allowed selector on a wrong contract are both rejected", () => {
  assert.equal(validateRequest({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: CONTRACTS.PSRE, data: "0x18160ddd" }, BLOCK] }).ok, true);
  assert.equal(validateRequest({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: CONTRACTS.PSRE, data: "0xa9059cbb" }, BLOCK] }).ok, false); // transfer(address,uint256)
  assert.equal(validateRequest({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: "0x" + "11".repeat(20), data: "0x18160ddd" }, BLOCK] }).ok, false);
  assert.equal(validateRequest({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: CONTRACTS.PSRE.toUpperCase().replace("0X", "0x"), data: "0x18160DDD" }, BLOCK] }).ok, true); // case-insensitive
});

/** ABI-encode Multicall3.aggregate((address,bytes)[]) for the test. */
function encodeAggregate(calls) {
  const w = (hex) => hex.padStart(64, "0");
  const num = (n) => w(n.toString(16));
  const head = [num(0x20)];
  const arr = [num(calls.length)];
  const tuples = [];
  let offset = 32 * calls.length;
  for (const c of calls) {
    arr.push(num(offset));
    const sel = c.data.slice(2);
    const t = [w(c.to.slice(2).toLowerCase()), num(0x40), num(sel.length / 2), sel.padEnd(64, "0")];
    tuples.push(t.join(""));
    offset += 32 * t.length;
  }
  return "0x252dba42" + head.join("") + arr.join("") + tuples.join("");
}

test("Multicall3: every inner (target, selector) is validated; one disallowed inner call rejects the whole aggregate; nested multicall rejected", () => {
  const good = encodeAggregate([{ to: CONTRACTS.PSRE, data: "0x18160ddd" }, { to: CONTRACTS.REWARD_ENGINE, data: "0x2bc80f3a" }, { to: CONTRACTS.FACTORY, data: "0xda5ef232" }]);
  const d = decodeCalls(CONTRACTS.MULTICALL3, good);
  assert.equal(d.ok, true);
  assert.deepEqual(d.calls.map((c) => c.selector), ["0x18160ddd", "0x2bc80f3a", "0xda5ef232"]);
  assert.equal(validateRequest({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: CONTRACTS.MULTICALL3, data: good }, BLOCK] }).ok, true);

  const bad = encodeAggregate([{ to: CONTRACTS.PSRE, data: "0x18160ddd" }, { to: CONTRACTS.PSRE, data: "0xa9059cbb" }]);
  const r = validateRequest({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: CONTRACTS.MULTICALL3, data: bad }, BLOCK] });
  assert.equal(r.ok, false);
  assert.match(r.error.body.error.message, /0xa9059cbb/);

  const nested = encodeAggregate([{ to: CONTRACTS.MULTICALL3, data: "0x252dba42" }]);
  assert.equal(validateRequest({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: CONTRACTS.MULTICALL3, data: nested }, BLOCK] }).ok, false);
  assert.equal(validateRequest({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: CONTRACTS.MULTICALL3, data: "0xdeadbeef" }, BLOCK] }).ok, false); // other Multicall3 function
});

// --- sheet v2 row 2 (a), (d), (f) ------------------------------------------------------------------------------
test("methods: only the four; eth_sendRawTransaction / eth_getLogs rejected with -32601", () => {
  for (const m of ["eth_sendRawTransaction", "eth_getLogs", "eth_getBalance", "net_version"]) {
    const r = validateRequest({ jsonrpc: "2.0", id: 1, method: m, params: [] });
    assert.equal(r.ok, false);
    assert.equal(r.error.body.error.code, -32601);
  }
  assert.equal(validateRequest({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }).ok, true);
  assert.equal(validateRequest({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber" }).ok, true);
});

test("cache key excludes the id; a second call with a different id is a HIT with its own id; a different block tag is a MISS", async () => {
  const calls = [];
  const cache = new MemoryCache();
  const f = upstream("0x01", calls);
  const a = await handle(req({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [T_CALL, BLOCK] }), env, { fetch: f, cache });
  const b = await handle(req({ jsonrpc: "2.0", id: 99, method: "eth_call", params: [T_CALL, BLOCK] }), env, { fetch: f, cache });
  const c = await handle(req({ jsonrpc: "2.0", id: 3, method: "eth_call", params: [T_CALL, "0x3276fa0"] }), env, { fetch: f, cache });
  assert.equal(a.headers.get("X-Prospereum-Cache"), "MISS");
  assert.equal(b.headers.get("X-Prospereum-Cache"), "HIT");
  assert.equal((await b.json()).id, 99);
  assert.equal(c.headers.get("X-Prospereum-Cache"), "MISS");
  assert.equal(calls.length, 2);
  assert.equal(cacheKey({ method: "eth_call", params: [T_CALL, BLOCK] }), cacheKey({ method: "eth_call", params: [T_CALL, BLOCK] }));
});

test("cache: entries expire after the TTL; upstream errors are not cached", async () => {
  let now = 1_000_000;
  const cache = new MemoryCache(() => now);
  const calls = [];
  const f = upstream("0x02", calls);
  await handle(req({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), env, { fetch: f, cache });
  now += 61_000;
  const r = await handle(req({ jsonrpc: "2.0", id: 2, method: "eth_chainId", params: [] }), env, { fetch: f, cache });
  assert.equal(r.headers.get("X-Prospereum-Cache"), "MISS");
  assert.equal(calls.length, 2);
  const errUp = async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "execution reverted" } }));
  const e1 = await handle(req({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }), env, { fetch: errUp, cache });
  assert.equal((await e1.json()).error.message, "execution reverted");
  const e2 = await handle(req({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }), env, { fetch: errUp, cache });
  assert.equal(e2.headers.get("X-Prospereum-Cache"), "MISS");
});

test("CORS: foreign origin 403; preflight 204 only for the site origin; GET 405; rate limiter 429", async () => {
  const foreign = await handle(req({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }, { origin: "https://evil.example" }), env, { fetch: upstream("0x2105") });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers.get("Access-Control-Allow-Origin"), null);
  const pre = await handle(new Request("https://rpc.prospereum.io/", { method: "OPTIONS", headers: { origin: SITE } }), env);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("Access-Control-Allow-Origin"), SITE);
  const get = await handle(new Request("https://rpc.prospereum.io/", { method: "GET", headers: { origin: SITE } }), env);
  assert.equal(get.status, 405);
  const limited = await handle(req({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), { ...env, RATE_LIMITER: { limit: async () => ({ success: false }) } }, { fetch: upstream("0x2105") });
  assert.equal(limited.status, 429);
});

test("upstream failure: 502 with a generic message; the upstream URL never leaks", async () => {
  const r = await handle(req({ jsonrpc: "2.0", id: 5, method: "eth_chainId", params: [] }), env, { fetch: async () => { throw new Error("connect ECONNREFUSED alchemy.com"); } });
  assert.equal(r.status, 502);
  const body = await r.json();
  assert.equal(body.id, 5);
  assert.equal(body.error.message, "upstream unavailable");
  assert.doesNotMatch(JSON.stringify(body), /alchemy|SECRET/);
});
