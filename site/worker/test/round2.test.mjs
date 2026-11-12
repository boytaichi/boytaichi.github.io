// Kin PR #1 round 2 (2026-11-12) — Worker findings: 1 (vault verdict cache keyed by (vault, blockTag)),
// 5 (exact calldata length per selector), 6 (Origin required on POST), 7 (JSON-RPC envelope + response-id validation),
// 8 (64 KiB limit counted in bytes: Content-Length first, then a byte-counting stream read).
// Run from site/worker: node --test test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle, validateRequest, verifyVault, validateEnv, vaultVerdictKey, readBodyBounded, MemoryCache, CONTRACTS, LIMITS, PUBLIC_ERRORS } from "../src/index.js";
import { env, req, upstream, upstreamError, upstreamEnvelope, word, addrWord, encodeAggregate, SITE } from "./helpers.mjs";
import { FACTORY_GETTERS, VAULT_GETTERS } from "../../pages/partners/config.js";
import { calldataBytesFor, argWordsFor, staticPairs, VAULT_SELECTOR_ARG_WORDS } from "../../pages/shared/call-manifest.mjs";
import { buildCalls } from "../../pages/token/token-logic.mjs";

const BLOCK_A = "0x3276f9f";
const BLOCK_B = "0x3276fa0";
const VAULT = "0xaaaa000000000000000000000000000000000001";
const TOTAL_SUPPLY = { to: CONTRACTS.PSRE, data: "0x18160ddd" };
const BALANCE_OF = { to: CONTRACTS.PSRE, data: "0x70a08231" + addrWord("0xc59816CAC94A969E50EdFf7CF49ce727aec1489F") };
const call = (c, tag = BLOCK_A, id = 1) => ({ jsonrpc: "2.0", id, method: "eth_call", params: [c, tag] });
const chainId = (extra = {}) => ({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [], ...extra });

// --- finding 1: verdict cache keyed by (vault, blockTag) --------------------------------------------------------
test("round 2 #1 — the same vault verified at two blocks gets two verdicts: active at block A, decommissioned at block B; the A verdict never admits a B call", async () => {
  const calls = [];
  // factory.vaultActive(VAULT) is true at BLOCK_A and false at BLOCK_B (decommissioned between the two blocks)
  const chain = upstream((body) => {
    const [{ to, data }, tag] = body.params;
    if (to === CONTRACTS.FACTORY && data.startsWith(FACTORY_GETTERS.vaultActive)) return word(tag === BLOCK_A ? 1 : 0);
    return word(7);
  }, calls);
  const vaultCache = new MemoryCache();
  const deps = { fetch: chain, cache: new MemoryCache(), vaultCache };
  const a = await handle(req(call({ to: VAULT, data: VAULT_GETTERS.owner }, BLOCK_A)), env, deps);
  assert.equal(a.status, 200, "active at A");
  const b = await handle(req(call({ to: VAULT, data: VAULT_GETTERS.owner }, BLOCK_B)), env, deps);
  assert.equal(b.status, 400, "decommissioned at B — not served from A's verdict");
  assert.match((await b.json()).error.message, /not a registered partner vault/);
  // one factory verification per (vault, block), not per vault
  const verifications = calls.filter((x) => x.body.params[0].data.startsWith(FACTORY_GETTERS.vaultActive));
  assert.deepEqual(verifications.map((x) => x.body.params[1]), [BLOCK_A, BLOCK_B]);
  assert.equal(vaultCache.size, 2);
  assert.notEqual(vaultVerdictKey(VAULT, BLOCK_A), vaultVerdictKey(VAULT, BLOCK_B));
  assert.notEqual(vaultVerdictKey(VAULT, BLOCK_A), vaultVerdictKey(VAULT, { blockHash: "0x" + "ab".repeat(32) }));
  // a repeat at A is a cache hit (no new verification); the direct helper agrees per block
  await handle(req(call({ to: VAULT, data: VAULT_GETTERS.owner }, BLOCK_A)), env, deps);
  assert.equal(calls.filter((x) => x.body.params[0].data.startsWith(FACTORY_GETTERS.vaultActive)).length, 2);
  const config = validateEnv(env).config;
  assert.equal(await verifyVault(VAULT, BLOCK_A, config, deps), true);
  assert.equal(await verifyVault(VAULT, BLOCK_B, config, deps), false);
});

// --- finding 5: exact calldata length ---------------------------------------------------------------------------
test("round 2 #5 — the manifest annotates every selector with its argument word count; balanceOf/vaultActive take 1 word, every other page getter 0", () => {
  for (const { target, selector, argWords } of staticPairs()) {
    const expected = selector === "0x70a08231" || selector === FACTORY_GETTERS.vaultActive ? 1 : 0;
    assert.equal(argWords, expected, `${target} ${selector}`);
    assert.equal(calldataBytesFor(target, selector), 4 + 32 * expected);
  }
  for (const sel of Object.values(VAULT_GETTERS)) assert.equal(VAULT_SELECTOR_ARG_WORDS[sel], 0);
  assert.equal(argWordsFor(VAULT, VAULT_GETTERS.owner), 0);
  assert.equal(calldataBytesFor(CONTRACTS.PSRE, "0xa9059cbb"), null); // not admitted → no length
  // every call the Token page builds has exactly the admitted length
  for (const c of buildCalls(BLOCK_A)) assert.equal((c.data.length - 2) / 2, calldataBytesFor(c.to, c.data.slice(0, 10)), c.key);
});

test("round 2 #5 — trailing bytes are rejected (direct call, Multicall inner call, vault getter); exact lengths are accepted; a missing argument word is rejected", async () => {
  const calls = [];
  const deps = { fetch: upstream(word(1), calls), cache: new MemoryCache(), vaultCache: new MemoryCache() };
  // exact
  assert.equal(validateRequest(call(TOTAL_SUPPLY)).ok, true);
  assert.equal(validateRequest(call(BALANCE_OF)).ok, true);
  assert.equal(validateRequest(call({ to: CONTRACTS.FACTORY, data: FACTORY_GETTERS.vaultActive + addrWord(VAULT) })).ok, true);
  // one trailing byte / one trailing word on a no-arg getter
  for (const data of ["0x18160ddd00", "0x18160ddd" + "00".repeat(32), "0x18160ddd" + "ff".repeat(32)]) {
    const r = await handle(req(call({ to: CONTRACTS.PSRE, data })), env, deps);
    assert.equal(r.status, 400, data);
    const body = await r.json();
    assert.equal(body.error.code, -32602);
    assert.match(body.error.message, /calldata length not allowed: 0x18160ddd takes 0 argument word\(s\), 4 bytes/);
  }
  // balanceOf(address): 36 bytes exactly — a 37th byte, a second word, or no word at all are all rejected
  for (const data of [BALANCE_OF.data + "00", BALANCE_OF.data + "00".repeat(32), "0x70a08231", "0x70a08231" + "00".repeat(31)]) {
    const r = validateRequest(call({ to: CONTRACTS.PSRE, data }));
    assert.equal(r.ok, false, data);
    assert.match(r.error.body.error.message, /calldata length not allowed|4-byte selector/);
  }
  // vault getter with a trailing word on a registered vault: rejected before any factory verification
  const v = await handle(req(call({ to: VAULT, data: VAULT_GETTERS.ecosystemBalance + "00".repeat(32) })), env, deps);
  assert.equal(v.status, 400);
  assert.match((await v.json()).error.message, /calldata length not allowed/);
  // Multicall3 inner call with trailing bytes rejects the whole aggregate; exact inner calls pass
  const bad = encodeAggregate([TOTAL_SUPPLY, { to: CONTRACTS.REWARD_ENGINE, data: "0x2bc80f3a" + "00".repeat(32) }]);
  const m = validateRequest(call({ to: CONTRACTS.MULTICALL3, data: bad }));
  assert.equal(m.ok, false);
  assert.match(m.error.body.error.message, /calldata length not allowed: 0x2bc80f3a/);
  const good = encodeAggregate([TOTAL_SUPPLY, BALANCE_OF, { to: CONTRACTS.FACTORY, data: FACTORY_GETTERS.vaultActive + addrWord(VAULT) }]);
  assert.equal(validateRequest(call({ to: CONTRACTS.MULTICALL3, data: good })).ok, true);
  assert.equal(calls.length, 0, "nothing rejected for length reached the upstream");
});

// --- finding 6: Origin required on POST -------------------------------------------------------------------------
test("round 2 #6 — POST /rpc without an Origin header → 403; foreign Origin → 403; the site origin → 200; GET …/health stays originless; preflight unchanged", async () => {
  const calls = [];
  const deps = { fetch: upstream("0x2105", calls), cache: new MemoryCache() };
  const originless = new Request("https://prospereum.io/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(chainId()) });
  const r = await handle(originless, env, deps);
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { error: PUBLIC_ERRORS.ORIGIN_NOT_ALLOWED });
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), null);
  const empty = await handle(req(chainId(), { origin: "" }), env, deps);
  assert.equal(empty.status, 403);
  const nullOrigin = await handle(req(chainId(), { origin: "null" }), env, deps); // sandboxed iframe / file: pages send "null"
  assert.equal(nullOrigin.status, 403);
  const foreign = await handle(req(chainId(), { origin: "https://evil.example" }), env, deps);
  assert.equal(foreign.status, 403);
  const nearMiss = await handle(req(chainId(), { origin: "https://prospereum.io." }), env, deps);
  assert.equal(nearMiss.status, 403);
  assert.equal(calls.length, 0, "no rejected request reached the upstream");
  const ok = await handle(req(chainId()), env, deps); // helpers.req sets origin: SITE
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("Access-Control-Allow-Origin"), SITE);
  const health = await handle(new Request("https://prospereum.io/rpc/health", { method: "GET" }), env, deps);
  assert.equal(health.status, 200);
  const pre = await handle(new Request("https://prospereum.io/rpc", { method: "OPTIONS", headers: { origin: SITE } }), env, deps);
  assert.equal(pre.status, 204);
});

// --- finding 7: JSON-RPC envelope + response id -------------------------------------------------------------------
test("round 2 #7 — a request without jsonrpc \"2.0\" is -32600; it never reaches the upstream", async () => {
  const calls = [];
  const deps = { fetch: upstream("0x2105", calls), cache: new MemoryCache() };
  for (const body of [{ id: 1, method: "eth_chainId", params: [] }, chainId({ jsonrpc: "1.0" }), chainId({ jsonrpc: 2 }), chainId({ jsonrpc: "2.0 " })]) {
    const r = await handle(req(body), env, deps);
    assert.equal(r.status, 400, JSON.stringify(body));
    const j = await r.json();
    assert.equal(j.error.code, -32600);
    assert.match(j.error.message, /jsonrpc must be "2.0"/);
    assert.equal(j.id, 1);
  }
  assert.equal(calls.length, 0);
  assert.equal(validateRequest(chainId()).ok, true);
});

test("round 2 #7 — upstream envelope: wrong id, missing/wrong jsonrpc, both result and error, neither, bad error shape → 502 generic and never cached; a matching envelope is served and cached", async () => {
  const cases = [
    ["id off by one", (id) => ({ jsonrpc: "2.0", id: id + 1, result: "0x2105" })],
    ["id as string", (id) => ({ jsonrpc: "2.0", id: String(id), result: "0x2105" })],
    ["id null", () => ({ jsonrpc: "2.0", id: null, result: "0x2105" })],
    ["id missing", () => ({ jsonrpc: "2.0", result: "0x2105" })],
    ["jsonrpc 1.0", (id) => ({ jsonrpc: "1.0", id, result: "0x2105" })],
    ["result AND error", (id) => ({ jsonrpc: "2.0", id, result: "0x2105", error: { code: 1, message: "x" } })],
    ["neither result nor error", (id) => ({ jsonrpc: "2.0", id })],
    ["error without code", (id) => ({ jsonrpc: "2.0", id, error: { message: "x" } })],
    ["error code not integer", (id) => ({ jsonrpc: "2.0", id, error: { code: 1.5, message: "x" } })],
    ["error message not string", (id) => ({ jsonrpc: "2.0", id, error: { code: 1, message: 7 } })],
    ["error null", (id) => ({ jsonrpc: "2.0", id, error: null })],
    ["error array", (id) => ({ jsonrpc: "2.0", id, error: [1, "x"] })],
  ];
  for (const [name, build] of cases) {
    const cache = new MemoryCache();
    const r = await handle(req(chainId()), env, { fetch: upstreamEnvelope(build), cache });
    assert.equal(r.status, 502, name);
    const j = await r.json();
    assert.equal(j.error.message, PUBLIC_ERRORS.UPSTREAM_INVALID, name);
    assert.equal(j.error.code, -32000, name);
    assert.equal(cache.size, 0, `${name}: not cached`);
    // and the next request is a MISS again (nothing poisoned the cache)
    const again = await handle(req(chainId()), env, { fetch: upstream("0x2105"), cache });
    assert.equal(again.headers.get("X-Prospereum-Cache"), "MISS", name);
  }
  // a well-formed error envelope is forwarded (sanitised); a well-formed result is cached
  const cache = new MemoryCache();
  const e = await handle(req(chainId()), env, { fetch: upstreamError({ code: -32005, message: "limit" }), cache });
  assert.equal(e.status, 200);
  assert.deepEqual((await e.json()).error, { code: -32005, message: PUBLIC_ERRORS.UPSTREAM_RPC_ERROR });
  assert.equal(cache.size, 0);
  const ok = await handle(req(chainId()), env, { fetch: upstream("0x2105"), cache });
  assert.equal(ok.status, 200);
  assert.equal(cache.size, 1);
  // the Worker sends a fresh id per upstream call and the stub must echo it: two calls, two different ids
  const seen = [];
  await handle(req(chainId()), env, { fetch: upstream("0x2105", seen), cache: new MemoryCache() });
  await handle(req(chainId()), env, { fetch: upstream("0x2105", seen), cache: new MemoryCache() });
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0].body.id, seen[1].body.id);
  for (const s of seen) assert.equal(s.body.jsonrpc, "2.0");
});

// --- finding 8: body limit in bytes -----------------------------------------------------------------------------
test("round 2 #8 — a multibyte body whose UTF-16 length is under 64 KiB but whose byte length is over → 413; the same JSON at exactly the byte limit → 200", async () => {
  const deps = { fetch: upstream("0x2105"), cache: new MemoryCache() };
  const frame = (pad) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [], pad });
  const overhead = Buffer.byteLength(frame(""), "utf8");
  // "é" is 1 UTF-16 code unit but 2 UTF-8 bytes: 40,000 of them → 40,000 + overhead code units (< 65,536) but 80,000 + overhead bytes
  const multibyte = frame("é".repeat(40_000));
  assert.ok(multibyte.length < LIMITS.MAX_BODY_BYTES, "UTF-16 length is under the limit");
  assert.ok(Buffer.byteLength(multibyte, "utf8") > LIMITS.MAX_BODY_BYTES, "byte length is over the limit");
  const r = await handle(req(multibyte), env, deps);
  assert.equal(r.status, 413);
  assert.equal((await r.json()).error.message, PUBLIC_ERRORS.BODY_TOO_LARGE);
  // exactly at the limit in bytes (with 2-byte characters) → accepted; one more byte → 413
  const room = LIMITS.MAX_BODY_BYTES - overhead; // bytes available for the pad
  const exact = frame("é".repeat(Math.floor(room / 2)) + (room % 2 ? "a" : ""));
  assert.equal(Buffer.byteLength(exact, "utf8"), LIMITS.MAX_BODY_BYTES);
  const okRes = await handle(req(exact), env, deps);
  assert.equal(okRes.status, 200);
  const over = frame("é".repeat(Math.floor(room / 2)) + (room % 2 ? "aa" : "a"));
  assert.equal(Buffer.byteLength(over, "utf8"), LIMITS.MAX_BODY_BYTES + 1);
  assert.equal((await handle(req(over), env, deps)).status, 413);
});

test("round 2 #8 — Content-Length over the limit is rejected before a single byte is read; a stream that lies about Content-Length is cut off by the byte counter; non-numeric Content-Length is rejected", async () => {
  let reads = 0;
  const stream = (chunks) => ({
    getReader: () => ({
      read: async () => { reads++; const value = chunks.shift(); return value === undefined ? { done: true } : { done: false, value }; },
      cancel: async () => {},
    }),
  });
  const declaredOver = { headers: new Headers({ "content-length": String(LIMITS.MAX_BODY_BYTES + 1) }), body: stream([new Uint8Array(10)]) };
  assert.deepEqual(await readBodyBounded(declaredOver), { tooLarge: true });
  assert.equal(reads, 0, "no read past an over-limit Content-Length");
  const nonNumeric = { headers: new Headers({ "content-length": "12abc" }), body: stream([new Uint8Array(10)]) };
  assert.deepEqual(await readBodyBounded(nonNumeric), { tooLarge: true });
  assert.equal(reads, 0);
  // declared small, actually large: 3 chunks of 32 KiB → cut off after the chunk that crosses the limit, the rest never read
  reads = 0;
  const lying = { headers: new Headers({ "content-length": "10" }), body: stream([new Uint8Array(32 * 1024), new Uint8Array(32 * 1024), new Uint8Array(32 * 1024), new Uint8Array(32 * 1024)]) };
  assert.deepEqual(await readBodyBounded(lying), { tooLarge: true });
  assert.equal(reads, 3, "stopped at the chunk that crossed the limit");
  // exactly at the limit, chunked, is read in full and decoded as UTF-8
  const bytes = new TextEncoder().encode("é".repeat(LIMITS.MAX_BODY_BYTES / 2));
  const atLimit = { headers: new Headers({ "content-length": String(bytes.byteLength) }), body: stream([bytes.slice(0, 1000), bytes.slice(1000)]) };
  const got = await readBodyBounded(atLimit);
  assert.equal(got.text, "é".repeat(LIMITS.MAX_BODY_BYTES / 2));
  // a body stream that throws → unreadable (400 parse error in handle)
  const broken = { headers: new Headers(), body: { getReader: () => ({ read: async () => { throw new Error("reset"); }, cancel: async () => {} }) } };
  assert.deepEqual(await readBodyBounded(broken), { unreadable: true });
  // no body at all → empty text (then a parse error in handle, never a crash)
  assert.deepEqual(await readBodyBounded({ headers: new Headers(), body: null }), { text: "" });
  const noBody = await handle(new Request("https://prospereum.io/rpc", { method: "POST", headers: { origin: SITE } }), env, { fetch: upstream("0x2105") });
  assert.equal(noBody.status, 400);
  assert.equal((await noBody.json()).error.code, -32700);
});
