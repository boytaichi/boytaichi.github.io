// Kin PR #1 finding 3 — endpoint fallback covers the WHOLE pinned-block snapshot, not only eth_chainId.
// Run from pages/: node --test shared/test/rpc.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { RpcError, makeRpc, validResult, withFallback } from "../rpc.mjs";
import { CHAIN_ID_HEX, ENDPOINTS } from "../../token/config.js";
import { buildCalls } from "../../token/token-logic.mjs";

const A = { name: "proxy", url: "https://a.example/rpc" };
const B = { name: "public-1", url: "https://b.example" };
const C = { name: "public-2", url: "https://c.example" };
const u = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");

/** The JSON-RPC id of the request being answered: the stubs echo it like a real node (round 3 #5 — a mismatched id is malformed). */
let currentId = 1;
/** fetch stub: per-endpoint behaviour keyed by URL; `plan[url](method, params, n)` returns a Response or throws. */
function fakeFetch(plan, log = []) {
  const counts = {};
  return async (url, init) => {
    const { method, params, id } = JSON.parse(init.body);
    currentId = id;
    counts[url] = (counts[url] ?? 0) + 1;
    log.push(`${url} ${method}`);
    return plan[url](method, params, counts[url], init);
  };
}
const ok = (result, headers = {}) => new Response(JSON.stringify({ jsonrpc: "2.0", id: currentId, result }), { status: 200, headers });
const rpcErr = (message) => new Response(JSON.stringify({ jsonrpc: "2.0", id: currentId, error: { code: -32602, message } }), { status: 400 });
const happy = (method, params) => {
  if (method === "eth_chainId") return ok(CHAIN_ID_HEX);
  if (method === "eth_blockNumber") return ok("0x3276f9f");
  if (method === "eth_getBlockByNumber") return ok({ number: params[0], timestamp: "0x68f7a2b1" });
  return ok(u(7));
};

/** A page-shaped snapshot: block, header, then every Token getter at that block. */
const snapshotOf = (rpc) => async (endpoint) => {
  const { result: bn } = await rpc(endpoint, "eth_blockNumber", []);
  const { result: block } = await rpc(endpoint, "eth_getBlockByNumber", [bn, false]);
  const results = {};
  for (const c of buildCalls(bn)) results[c.key] = (await rpc(endpoint, "eth_call", [{ to: c.to, data: c.data }, c.blockTag])).result;
  return { bn, timestamp: Number(block.timestamp), results };
};

test("chainId succeeds on the first endpoint, then its snapshot fails (allowlist rejection on the 12th getter) → the next endpoint completes the snapshot", async () => {
  const log = [];
  const fetch = fakeFetch({
    [A.url]: (method, params) => {
      if (method === "eth_call" && params[0].data === "0x5c975abb") return rpcErr("call not allowed: psre paused()");
      return happy(method, params);
    },
    [B.url]: happy,
    [C.url]: happy,
  }, log);
  const rpc = makeRpc(fetch);
  const warnings = [];
  const got = await withFallback([A, B, C], CHAIN_ID_HEX, rpc, snapshotOf(rpc), (m) => warnings.push(m));
  assert.equal(got.endpoint, B);
  assert.equal(Object.keys(got.value.results).length, 33);
  assert.equal(got.value.bn, "0x3276f9f");
  assert.ok(log.filter((l) => l.startsWith(A.url)).length > 2, "A was used past chainId before it failed");
  assert.equal(log.filter((l) => l.startsWith(C.url)).length, 0, "C never consulted");
  assert.match(warnings[0], /proxy: rejected \(call not allowed/);
  // a Token-page snapshot never mixes endpoints: every call of the winning snapshot went to B
  assert.ok(log.filter((l) => l.startsWith(B.url)).length === 2 + 1 + 33);
});

test("rate-limited (429), HTTP 5xx, malformed result, non-JSON and timeout mid-snapshot each fall through; wrong chain is skipped; all failing → null", async () => {
  const rpc = (plan) => makeRpc(fakeFetch(plan), { timeoutMs: 30 });
  const cases = {
    "rate-limited": () => new Response("slow down", { status: 429 }),
    http: () => new Response("", { status: 503 }),
    malformed: () => ok("not-hex"),
    "not json": () => new Response("<html>", { status: 200 }),
    timeout: (_m, _p, _n, init) => new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))),
  };
  for (const [kind, failure] of Object.entries(cases)) {
    // A answers chainId, block, header and the first getters, then fails on a later getter (init passed for the timeout case)
    const plan = { [A.url]: (method, params, n, init) => (method === "eth_call" && n > 5 ? failure(method, params, n, init) : happy(method, params)), [B.url]: happy };
    const r = rpc(plan);
    const warnings = [];
    const got = await withFallback([A, B], CHAIN_ID_HEX, r, snapshotOf(r), (m) => warnings.push(m));
    assert.equal(got?.endpoint, B, kind);
    assert.match(warnings[0], new RegExp(`proxy: ${kind.replace(" ", "|")}`), kind);
  }
  const wrong = makeRpc(fakeFetch({ [A.url]: (m, p) => (m === "eth_chainId" ? ok("0x1") : happy(m, p)), [B.url]: happy }));
  const w = [];
  assert.equal((await withFallback([A, B], CHAIN_ID_HEX, wrong, snapshotOf(wrong), (m) => w.push(m))).endpoint, B);
  assert.match(w[0], /wrong network endpoint \(0x1\)/);
  const dead = makeRpc(fakeFetch({ [A.url]: () => { throw new TypeError("Failed to fetch"); }, [B.url]: () => new Response("", { status: 404 }) }));
  assert.equal(await withFallback([A, B], CHAIN_ID_HEX, dead, snapshotOf(dead)), null);
});

test("makeRpc: result shapes are validated per method; the X-Prospereum-Upstream header is surfaced; errors are RpcError with endpoint + kind", async () => {
  const rpc = makeRpc(fakeFetch({ [A.url]: (m, p) => (m === "eth_call" ? ok(u(1), { "X-Prospereum-Upstream": "Alchemy" }) : happy(m, p)) }));
  const r = await rpc(A, "eth_call", [{ to: "0x" + "11".repeat(20), data: "0x18160ddd" }, "0x1"]);
  assert.equal(r.result, u(1));
  assert.equal(r.upstream, "Alchemy");
  await assert.rejects(rpc(A, "eth_getBalance", []), (e) => e instanceof RpcError && e.kind === "malformed" && e.endpoint === "proxy");
  assert.equal(validResult("eth_chainId", "0x2105"), true);
  assert.equal(validResult("eth_chainId", "0x02105"), false);
  assert.equal(validResult("eth_blockNumber", 123), false);
  assert.equal(validResult("eth_call", "0x"), true);
  assert.equal(validResult("eth_call", "0x123"), false);
  assert.equal(validResult("eth_getBlockByNumber", { timestamp: "0x1" }), true);
  assert.equal(validResult("eth_getBlockByNumber", null), false);
});

test("config: the production endpoint order is proxy first, then the public fallbacks", () => {
  assert.equal(ENDPOINTS[0].url, "/rpc");
  assert.equal(ENDPOINTS[0].proxy, true);
  assert.ok(ENDPOINTS.length >= 2 && ENDPOINTS.slice(1).every((e) => e.proxy === false && e.url.startsWith("https://")));
});

// --- Kin PR #1 round 2 finding 2: an undecodable getter result fails the snapshot, never commits a partial one ------
import { abiWords, readCalls, requireDecodable } from "../rpc.mjs";
import { derive } from "../../token/token-logic.mjs";
import { factoryCalls, vaultCalls } from "../../partners/partners-logic.mjs";

/** The page-shaped snapshot as token.js / live.js now run it: readCalls() requires every result to decode. */
const strictSnapshotOf = (rpc) => async (endpoint) => {
  const { result: bn } = await rpc(endpoint, "eth_blockNumber", []);
  const { result: block } = await rpc(endpoint, "eth_getBlockByNumber", [bn, false]);
  const { results, upstream } = await readCalls(rpc, endpoint, buildCalls(bn));
  return { bn, timestamp: Number(block.timestamp), results, upstream };
};
const twoWords = u(0) + u(0).slice(2);
/** A canonical value for one call's declared return types (round 3 #1): bool 0, address 0, uint24 10000, uint256 7; two words for (value, readyAt). */
const canonicalFor = (c) => {
  if (!c) return u(7);
  if (c.types.length === 2) return twoWords;
  const t = c.types[0];
  if (t === "bool" || t === "address") return u(0);
  if (t === "uint24") return u(10000);
  if (t === "address[]") return u(32) + u(0).slice(2);
  return u(7);
};
/** A plausible full Token snapshot: a canonical word per getter, two for the pending (value, readyAt) getters. */
const plausible = (method, params) => {
  if (method !== "eth_call") return happy(method, params);
  const c = buildCalls("0x0").find((x) => x.to === params[0].to && x.data === params[0].data);
  return ok(canonicalFor(c));
};

test("round 2 #2 — one getter undecodable (\"0x\") on endpoint A, decodable on B → B's full snapshot is used; A's partial results are never committed", async () => {
  for (const [label, badResult] of [["empty 0x", "0x"], ["short word", "0x1234"], ["one word where two are needed", u(5)], ["not word-aligned", "0x" + "ab".repeat(33)]]) {
    const log = [];
    const fetch = fakeFetch({
      [A.url]: (method, params) => (method === "eth_call" && params[0].data === "0x94ea60ba" ? ok(badResult) : plausible(method, params)), // pendingAlphaBase
      [B.url]: plausible,
      [C.url]: plausible,
    }, log);
    const rpc = makeRpc(fetch);
    const warnings = [];
    const got = await withFallback([A, B, C], CHAIN_ID_HEX, rpc, strictSnapshotOf(rpc), (m) => warnings.push(m));
    assert.equal(got.endpoint, B, label);
    assert.equal(Object.keys(got.value.results).length, 33, label);
    assert.match(warnings[0], /proxy: undecodable \(pendingAlphaBase/, label);
    assert.equal(log.filter((l) => l.startsWith(C.url)).length, 0, `${label}: C never consulted`);
    // the winning snapshot decodes fully: no "—" anywhere in the derived figures
    const d = derive(got.value.results, { block: Number(got.value.bn), timestamp: got.value.timestamp });
    for (const k of ["totalSupply", "released", "maxSupply", "scarcityCap", "staked", "epoch", "engineStatus", "transfers"]) assert.notEqual(d[k], "—", `${label}: ${k}`);
  }
});

test("round 2 #2 — the same getter undecodable on every endpoint → null (no snapshot): the page renders dashes, never a partial number", async () => {
  const undecodable = (method, params) => (method === "eth_call" && params[0].data === "0x18160ddd" ? ok("0x") : plausible(method, params)); // totalSupply
  const rpc = makeRpc(fakeFetch({ [A.url]: undecodable, [B.url]: undecodable, [C.url]: undecodable }));
  const warnings = [];
  const got = await withFallback([A, B, C], CHAIN_ID_HEX, rpc, strictSnapshotOf(rpc), (m) => warnings.push(m));
  assert.equal(got, null);
  assert.equal(warnings.length, 3);
  for (const w of warnings) assert.match(w, /undecodable \(totalSupply: 0 word\(s\), need 1\)/);
  // what the page shows with no snapshot: derive over nothing is all dashes (the existing "—" rendering for the all-failed case)
  const d = derive({}, { block: 0, timestamp: 0 });
  for (const k of ["totalSupply", "released", "maxSupply", "reserveRemaining", "treasury", "scarcityCap", "epoch", "engineStatus", "transfers", "partnersLive"]) assert.equal(d[k], "—", k);
});

test("round 2 #2 — requireDecodable / abiWords: word counts, the pending getters need two words, the partners calls carry their minimums", () => {
  assert.equal(abiWords("0x"), 0);
  assert.equal(abiWords(u(1)), 1);
  assert.equal(abiWords(twoWords), 2);
  assert.equal(abiWords("0x1234"), null);
  assert.equal(abiWords("0x" + "0".repeat(63)), null);
  assert.equal(abiWords(7), null);
  const calls = buildCalls("0x1");
  for (const c of calls) assert.equal(c.words, ["pendingAlphaBase", "pendingE0", "pendingPartnerSplit", "pendingTierParams"].includes(c.key) ? 2 : 1, c.key);
  const one = calls.find((c) => c.key === "totalSupply");
  const two = calls.find((c) => c.key === "pendingE0");
  assert.equal(requireDecodable(A, one, u(1)), u(1));
  assert.equal(requireDecodable(A, two, twoWords), twoWords);
  assert.throws(() => requireDecodable(A, one, "0x"), (e) => e instanceof RpcError && e.kind === "undecodable" && /totalSupply: 0 word\(s\), need 1/.test(e.message));
  assert.throws(() => requireDecodable(A, two, u(1)), (e) => e.kind === "undecodable" && /pendingE0: 1 word\(s\), need 2/.test(e.message));
  assert.throws(() => requireDecodable(A, one, "0xabc"), (e) => e.kind === "undecodable" && /not word-aligned/.test(e.message));
  // a getter with no annotation needs one word
  assert.throws(() => requireDecodable(A, { key: "x" }, "0x"), (e) => e.kind === "undecodable");
  // partners: getAllVaults needs the two head words (an empty list is exactly two), everything else one
  for (const c of factoryCalls("0x1")) assert.equal(c.words, c.key === "getAllVaults" ? 2 : 1, c.key);
  for (const c of vaultCalls("0x" + "aa".repeat(20), "0x1")) assert.equal(c.words, 1, c.key);
});

test("round 2 #2 — readCalls reads every call at its pinned block against one endpoint, surfaces the upstream header, and throws on the first undecodable result (nothing after it is read)", async () => {
  const log = [];
  const calls = buildCalls("0x3276f9f");
  const byParams = (p) => calls.find((x) => x.to === p[0].to && x.data === p[0].data);
  const rpc = makeRpc(fakeFetch({ [A.url]: (m, p) => (m === "eth_call" && p[0].data === "0x32cb6b0c" ? ok("0x") : ok(canonicalFor(byParams(p)), { "X-Prospereum-Upstream": "Alchemy" })) }, log)); // maxSupply (2nd call) undecodable
  await assert.rejects(readCalls(rpc, A, calls), (e) => e instanceof RpcError && e.kind === "undecodable" && /maxSupply/.test(e.message));
  assert.equal(log.length, 2, "stopped at the undecodable getter");
  const good = makeRpc(fakeFetch({ [A.url]: (m, p) => ok(canonicalFor(byParams(p)), { "X-Prospereum-Upstream": "Alchemy" }) }));
  const { results, upstream } = await readCalls(good, A, calls.filter((c) => c.words === 1));
  assert.equal(Object.keys(results).length, 29);
  assert.equal(upstream, "Alchemy");
});

// --- Kin PR #1 round 2 finding 9: the timeout covers the response body, not only the headers -----------------------
test("round 2 #9 — a response whose json() never resolves times out within timeoutMs (RpcError timeout) and falls through to the next endpoint", async () => {
  const stalled = { ok: true, status: 200, headers: new Headers(), json: () => new Promise(() => {}) }; // headers arrived, body never does
  const rpc = makeRpc(async (url) => (url === A.url ? stalled : happy("eth_chainId", [])), { timeoutMs: 40 });
  const t0 = Date.now();
  await assert.rejects(rpc(A, "eth_chainId", []), (e) => e instanceof RpcError && e.kind === "timeout" && e.endpoint === "proxy");
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1000, `timed out in ${elapsed} ms`);
  // and in the fallback: A stalls its body, B answers → B is used
  const planned = makeRpc(fakeFetch({ [A.url]: (m, p) => (m === "eth_chainId" ? ok(CHAIN_ID_HEX) : stalled), [B.url]: plausible }), { timeoutMs: 40 });
  const warnings = [];
  const got = await withFallback([A, B], CHAIN_ID_HEX, planned, strictSnapshotOf(planned), (m) => warnings.push(m));
  assert.equal(got.endpoint, B);
  assert.match(warnings[0], /proxy: timeout/);
  // a body that parses in time still clears the timer: no stray timeout after success
  const quick = makeRpc(fakeFetch({ [A.url]: happy }), { timeoutMs: 40 });
  const r = await quick(A, "eth_chainId", []);
  assert.equal(r.result, CHAIN_ID_HEX);
  await new Promise((res) => setTimeout(res, 60));
});

// --- Kin PR #1 round 3 finding 1: a full-length but NON-CANONICAL result is undecodable → endpoint fallback -------------
import { checkCanonical, decodeCanonicalAddressArray, isSupportedType, assertReturnTypes, minWords } from "../abi.mjs";
import { RETURN_TYPES, STATIC_RETURN_TYPES, returnTypesFor, staticPairs, VAULT_SELECTOR_RETURN_TYPES } from "../call-manifest.mjs";
import { GETTERS } from "../../token/config.js";
import { FACTORY_GETTERS, VAULT_GETTERS } from "../../partners/config.js";
import { decodeAddressArray, decodeBool } from "../../partners/partners-logic.mjs";

const VAULT1 = "0x" + "aa".repeat(20);
const VAULT2 = "0x" + "bb".repeat(20);
const addrW = (a) => a.slice(2).toLowerCase().padStart(64, "0");
const dirtyAddrW = (a) => "ff" + a.slice(2).toLowerCase().padStart(62, "0"); // high byte set
const arr = (...addrs) => u(32) + u(addrs.length).slice(2) + addrs.map(addrW).join("");

test("round 3 #1 — the manifest annotates every page getter with its return types; the pages' call builders carry them; abi.mjs checks them", () => {
  for (const key of Object.keys(GETTERS)) assert.ok(Array.isArray(RETURN_TYPES.token[key]) && RETURN_TYPES.token[key].length > 0, `token.${key}`);
  for (const key of Object.keys(FACTORY_GETTERS)) assert.ok(Array.isArray(RETURN_TYPES.factory[key]), `factory.${key}`);
  for (const key of Object.keys(VAULT_GETTERS)) assert.ok(Array.isArray(RETURN_TYPES.vault[key]), `vault.${key}`);
  for (const c of buildCalls("0x1")) assert.deepEqual(c.types, RETURN_TYPES.token[c.key], c.key);
  for (const c of factoryCalls("0x1")) assert.deepEqual(c.types, RETURN_TYPES.factory[c.key], c.key);
  for (const c of vaultCalls(VAULT1, "0x1")) assert.deepEqual(c.types, RETURN_TYPES.vault[c.key], c.key);
  // the facts the types encode (live read at Base block 0x35fb235, 2026-11-12; source commit 31eb313)
  assert.deepEqual(RETURN_TYPES.token.psrePaused, ["bool"]);
  assert.deepEqual(RETURN_TYPES.token.enginePaused, ["bool"]);
  assert.deepEqual(RETURN_TYPES.token.firstEpochFinalized, ["bool"]);
  assert.deepEqual(RETURN_TYPES.token.pendingUpgrade, ["address"]);
  assert.deepEqual(RETURN_TYPES.token.poolFee, ["uint24"]);
  for (const k of ["pendingAlphaBase", "pendingE0", "pendingPartnerSplit", "pendingTierParams"]) assert.deepEqual(RETURN_TYPES.token[k], ["uint256", "uint256"], k);
  assert.deepEqual(RETURN_TYPES.factory.getAllVaults, ["address[]"]);
  assert.deepEqual(RETURN_TYPES.factory.vaultActive, ["bool"]);
  assert.deepEqual(RETURN_TYPES.vault.owner, ["address"]);
  // by (target, selector) as the Worker and the tests see it: every static pair carries its types; shared selectors agree
  for (const p of staticPairs()) assert.deepEqual(p.returns, returnTypesFor(p.target, p.selector), `${p.target} ${p.selector}`);
  assert.deepEqual(STATIC_RETURN_TYPES[ADDR_LOWER.PSRE]["0x5c975abb"], ["bool"]);
  assert.deepEqual(STATIC_RETURN_TYPES[ADDR_LOWER.REWARD_ENGINE]["0x5c975abb"], ["bool"]);
  assert.deepEqual(VAULT_SELECTOR_RETURN_TYPES[VAULT_GETTERS.owner], ["address"]);
  assert.equal(returnTypesFor(ADDR_LOWER.PSRE, "0xa9059cbb"), null);
  // minimum words derive from the types
  assert.equal(minWords(["uint256"]), 1);
  assert.equal(minWords(["uint256", "uint256"]), 2);
  assert.equal(minWords(["address[]"]), 2);
  // only checkable types are accepted at manifest load
  assert.ok(["bool", "address", "uint256", "uint24", "uint8", "address[]"].every(isSupportedType));
  assert.ok(!["string", "bytes", "uint7", "uint257", "int256", "uint256[]"].some(isSupportedType));
  assert.throws(() => assertReturnTypes(["string"], "x"), /unsupported return type string/);
  assert.throws(() => assertReturnTypes(["address[]", "uint256"], "x"), /dynamic return type must stand alone/);
  assert.throws(() => assertReturnTypes([], "x"), /non-empty/);
});
import { CONTRACTS as ADDR_LOWER } from "../call-manifest.mjs";

test("round 3 #1 — checkCanonical: bool 0/1 only, address high bytes zero, uintN fits its width, static returns have exactly one word per type, address[] offset/length/elements/no trailing data", () => {
  const okc = (types, hex) => assert.equal(checkCanonical(types, hex).ok, true, `${types} ${hex.slice(0, 20)}`);
  const bad = (types, hex, re) => { const c = checkCanonical(types, hex); assert.equal(c.ok, false, `${types} should fail`); assert.match(c.reason, re); };
  okc(["bool"], u(0)); okc(["bool"], u(1));
  bad(["bool"], u(2), /bool word is not 0 or 1/);
  bad(["bool"], "0x01" + u(1).slice(4), /bool word is not 0 or 1/); // upper byte set, last byte 1
  bad(["bool"], u(1) + u(0).slice(2), /2 word\(s\), need 1/); // trailing word
  okc(["address"], u(0)); okc(["address"], "0x" + addrW(VAULT1));
  bad(["address"], "0x" + dirtyAddrW(VAULT1), /address word has non-zero high bytes/);
  okc(["uint256"], "0x" + "f".repeat(64));
  okc(["uint24"], u(10000)); okc(["uint24"], u(0xffffff));
  bad(["uint24"], u(0x1000000), /uint24 value does not fit 24 bits/);
  okc(["uint8"], u(255)); bad(["uint8"], u(256), /uint8 value does not fit 8 bits/);
  okc(["uint256", "uint256"], twoWords);
  bad(["uint256", "uint256"], u(1), /1 word\(s\), need 2/);
  bad(["uint256", "uint256"], twoWords + u(0).slice(2), /3 word\(s\), need 2/);
  bad(["uint256"], "0x", /0 word\(s\), need 1/);
  bad(["uint256"], "0x1234", /not word-aligned hex/);
  bad(["uint256"], 7, /not word-aligned hex/);
  // address[]
  okc(["address[]"], arr()); okc(["address[]"], arr(VAULT1)); okc(["address[]"], arr(VAULT1, VAULT2));
  assert.deepEqual(decodeCanonicalAddressArray(arr(VAULT1, VAULT2)), [VAULT1, VAULT2]);
  assert.deepEqual(decodeCanonicalAddressArray(arr()), []);
  bad(["address[]"], u(64) + u(0).slice(2) + u(0).slice(2), /offset word is not 0x20/); // offset 0x40
  bad(["address[]"], u(32), /1 word\(s\), need 2/);
  bad(["address[]"], arr(VAULT1) + u(0).slice(2), /carries 2 word\(s\) after the head, length word says 1/); // trailing word
  bad(["address[]"], u(32) + u(2).slice(2) + addrW(VAULT1), /length 2 exceeds the 1 word\(s\) that follow/); // length mismatch (short)
  bad(["address[]"], u(32) + u(1).slice(2) + dirtyAddrW(VAULT1), /element 0: address word has non-zero high bytes/);
  bad(["address[]"], u(32) + "f".repeat(64) + addrW(VAULT1), /exceeds/); // absurd length word never wraps
  assert.equal(decodeCanonicalAddressArray(u(64) + u(0).slice(2) + u(0).slice(2)), null);
  // the partners decoders are canonical too
  assert.equal(decodeBool(u(2)), null);
  assert.equal(decodeBool(u(1)), true);
  assert.equal(decodeBool(u(0)), false);
  assert.equal(decodeAddressArray(u(64) + u(0).slice(2) + u(0).slice(2)), null);
  assert.equal(decodeAddressArray(arr(VAULT1) + u(0).slice(2)), null);
  assert.deepEqual(decodeAddressArray(arr(VAULT1)), [VAULT1]);
});

/** Token-page fallback: endpoint A answers `key` with `badResult`, B is canonical → B's snapshot is used, A's never committed. */
async function tokenFallsThrough(label, selectorData, badResult, reason) {
  const log = [];
  const fetch = fakeFetch({
    [A.url]: (method, params) => (method === "eth_call" && params[0].data === selectorData ? ok(badResult) : plausible(method, params)),
    [B.url]: plausible,
    [C.url]: plausible,
  }, log);
  const rpc = makeRpc(fetch);
  const warnings = [];
  const got = await withFallback([A, B, C], CHAIN_ID_HEX, rpc, strictSnapshotOf(rpc), (m) => warnings.push(m));
  assert.equal(got?.endpoint, B, label);
  assert.equal(Object.keys(got.value.results).length, 33, label);
  assert.match(warnings[0], reason, label);
  assert.equal(log.filter((l) => l.startsWith(C.url)).length, 0, `${label}: C never consulted`);
  const d = derive(got.value.results, { block: Number(got.value.bn), timestamp: got.value.timestamp });
  for (const k of ["totalSupply", "released", "scarcityCap", "engineStatus", "transfers", "upgrade", "poolFee"]) assert.notEqual(d[k], "—", `${label}: ${k}`);
}

test("round 3 #1 — Token page: bool word 0x02 / dirty address high bytes / uint24 overflow / trailing word on endpoint A, canonical on B → B is used", async () => {
  await tokenFallsThrough("bool 0x02 (psrePaused)", "0x5c975abb", u(2), /proxy: undecodable \((psrePaused|enginePaused): bool word is not 0 or 1\)/);
  await tokenFallsThrough("dirty address (pendingUpgrade)", "0x95e93245", "0x" + dirtyAddrW(VAULT1), /proxy: undecodable \(pendingUpgrade: address word has non-zero high bytes\)/);
  await tokenFallsThrough("uint24 overflow (poolFee)", "0xddca3f43", u(0x1000000), /proxy: undecodable \(poolFee: uint24 value does not fit 24 bits\)/);
  await tokenFallsThrough("trailing word (totalSupply)", "0x18160ddd", u(7) + u(0).slice(2), /proxy: undecodable \(totalSupply: 2 word\(s\), need 1\)/);
  await tokenFallsThrough("three words where two are needed (pendingE0)", "0x80327e37", twoWords + u(0).slice(2), /proxy: undecodable \(pendingE0: 3 word\(s\), need 2\)/);
});

/** The Partners page snapshot as partners.js runs it: factory reads, then vaultActive per vault, then per-vault reads. */
const partnersSnapshotOf = (rpc) => async (endpoint) => {
  const { result: bn } = await rpc(endpoint, "eth_blockNumber", []);
  const { results: f } = await readCalls(rpc, endpoint, factoryCalls(bn));
  const all = decodeAddressArray(f.getAllVaults);
  if (all === null) throw new RpcError(endpoint, "undecodable", "getAllVaults: address[] did not decode");
  const flags = [];
  for (const v of all) flags.push(decodeBool((await readCalls(rpc, endpoint, [vaultActiveCall(v, bn)])).results.vaultActive) === true);
  const rows = [];
  for (const v of all.filter((_, i) => flags[i])) rows.push((await readCalls(rpc, endpoint, vaultCalls(v, bn))).results);
  return { bn, all, rows };
};
import { vaultActiveCall } from "../../partners/partners-logic.mjs";
const partnersPlausible = (method, params) => {
  if (method !== "eth_call") return happy(method, params);
  const sel = params[0].data.slice(0, 10);
  if (sel === FACTORY_GETTERS.getAllVaults) return ok(arr(VAULT1));
  if (sel === FACTORY_GETTERS.vaultActive) return ok(u(1));
  if (sel === VAULT_GETTERS.owner) return ok("0x" + addrW(VAULT2));
  return ok(u(7));
};

test("round 3 #1 — Partners page: address[] with wrong offset / trailing words / length mismatch / dirty element, vaultActive 0x02, dirty owner() on A, canonical on B → B is used", async () => {
  const cases = [
    ["wrong offset", FACTORY_GETTERS.getAllVaults, u(64) + u(1).slice(2) + addrW(VAULT1), /getAllVaults: address\[\] offset word is not 0x20/],
    ["trailing words", FACTORY_GETTERS.getAllVaults, arr(VAULT1) + u(0).slice(2), /getAllVaults: address\[\] carries 2 word\(s\) after the head, length word says 1/],
    ["length mismatch", FACTORY_GETTERS.getAllVaults, u(32) + u(2).slice(2) + addrW(VAULT1), /getAllVaults: address\[\] length 2 exceeds/],
    ["dirty element", FACTORY_GETTERS.getAllVaults, u(32) + u(1).slice(2) + dirtyAddrW(VAULT1), /getAllVaults: address\[\] element 0: address word has non-zero high bytes/],
    ["vaultActive 0x02", FACTORY_GETTERS.vaultActive, u(2), /vaultActive: bool word is not 0 or 1/],
    ["dirty owner()", VAULT_GETTERS.owner, "0x" + dirtyAddrW(VAULT2), /owner: address word has non-zero high bytes/],
  ];
  for (const [label, selector, badResult, reason] of cases) {
    const log = [];
    const fetch = fakeFetch({
      [A.url]: (method, params) => (method === "eth_call" && params[0].data.startsWith(selector) ? ok(badResult) : partnersPlausible(method, params)),
      [B.url]: partnersPlausible,
    }, log);
    const rpc = makeRpc(fetch);
    const warnings = [];
    const got = await withFallback([A, B], CHAIN_ID_HEX, rpc, partnersSnapshotOf(rpc), (m) => warnings.push(m));
    assert.equal(got?.endpoint, B, label);
    assert.match(warnings[0], /proxy: undecodable/, label);
    assert.match(warnings[0], reason, label);
    assert.deepEqual(got.value.all, [VAULT1], label);
    assert.equal(got.value.rows.length, 1, label);
    assert.equal(got.value.rows[0].owner, "0x" + addrW(VAULT2), label);
  }
});

test("round 3 #1 — the same non-canonical result on every endpoint → null (no snapshot): dashes, never a partial number", async () => {
  const bad = (method, params) => (method === "eth_call" && params[0].data === "0x5c975abb" ? ok(u(2)) : plausible(method, params));
  const rpc = makeRpc(fakeFetch({ [A.url]: bad, [B.url]: bad, [C.url]: bad }));
  const warnings = [];
  assert.equal(await withFallback([A, B, C], CHAIN_ID_HEX, rpc, strictSnapshotOf(rpc), (m) => warnings.push(m)), null);
  assert.equal(warnings.length, 3);
  for (const w of warnings) assert.match(w, /undecodable \(psrePaused: bool word is not 0 or 1\)/);
  const d = derive({}, { block: 0, timestamp: 0 });
  for (const k of ["totalSupply", "transfers", "engineStatus", "upgrade", "poolFee"]) assert.equal(d[k], k === "upgrade" ? "none" : "—", k);
  // partners: every endpoint returns a mis-offset address[] → null
  const badArr = (m, p) => (m === "eth_call" && p[0].data === FACTORY_GETTERS.getAllVaults ? ok(u(64) + u(0).slice(2) + u(0).slice(2)) : partnersPlausible(m, p));
  const prpc = makeRpc(fakeFetch({ [A.url]: badArr, [B.url]: badArr }));
  assert.equal(await withFallback([A, B], CHAIN_ID_HEX, prpc, partnersSnapshotOf(prpc)), null);
});

// --- Kin PR #1 round 3 finding 5: the browser validates the response envelope like the Worker ----------------------------
import { envelopeFault, validErrorObject } from "../rpc.mjs";

test("round 3 #5 — envelopeFault: jsonrpc must be \"2.0\", id must equal the id sent, exactly one of result/error, error = { integer code, string message }", () => {
  assert.equal(envelopeFault({ jsonrpc: "2.0", id: 7, result: "0x1" }, 7), null);
  assert.equal(envelopeFault({ jsonrpc: "2.0", id: 7, error: { code: -32000, message: "x" } }, 7), null);
  assert.match(envelopeFault({ jsonrpc: "1.0", id: 7, result: "0x1" }, 7), /jsonrpc/);
  assert.match(envelopeFault({ id: 7, result: "0x1" }, 7), /jsonrpc/);
  assert.match(envelopeFault({ jsonrpc: "2.0", id: 8, result: "0x1" }, 7), /id does not match/);
  assert.match(envelopeFault({ jsonrpc: "2.0", id: "7", result: "0x1" }, 7), /id does not match/);
  assert.match(envelopeFault({ jsonrpc: "2.0", result: "0x1" }, 7), /id does not match/);
  assert.match(envelopeFault({ jsonrpc: "2.0", id: 7, result: "0x1", error: { code: 1, message: "" } }, 7), /both result and error/);
  assert.match(envelopeFault({ jsonrpc: "2.0", id: 7 }, 7), /neither result nor error/);
  assert.match(envelopeFault({ jsonrpc: "2.0", id: 7, error: "boom" }, 7), /error is not/);
  assert.match(envelopeFault({ jsonrpc: "2.0", id: 7, error: { code: "x", message: "m" } }, 7), /error is not/);
  assert.match(envelopeFault({ jsonrpc: "2.0", id: 7, error: { code: 1.5, message: "m" } }, 7), /error is not/);
  assert.match(envelopeFault({ jsonrpc: "2.0", id: 7, error: { code: 1 } }, 7), /error is not/);
  assert.match(envelopeFault([{ jsonrpc: "2.0", id: 7, result: "0x1" }], 7), /not an object/);
  assert.match(envelopeFault(null, 7), /not an object/);
  assert.equal(validErrorObject({ code: -32602, message: "no" }), true);
  assert.equal(validErrorObject({ code: "-32602", message: "no" }), false);
  assert.equal(validErrorObject(null), false);
});

test("round 3 #5 — each envelope fault on endpoint A is `malformed` and falls through to B; a mismatched id on A with a good B uses B; a valid error envelope is rpc-error", async () => {
  const faults = {
    "wrong jsonrpc": (res) => ({ ...res, jsonrpc: "1.0" }),
    "missing jsonrpc": (res) => { const { jsonrpc, ...rest } = res; return rest; },
    "mismatched id": (res) => ({ ...res, id: res.id + 1000 }),
    "id as string": (res) => ({ ...res, id: String(res.id) }),
    "missing id": (res) => { const { id, ...rest } = res; return rest; },
    "both result and error": (res) => ({ ...res, error: { code: -32000, message: "x" } }),
    "neither result nor error": (res) => { const { result, ...rest } = res; return rest; },
    "error not an object": (res) => { const { result, ...rest } = res; return { ...rest, error: "boom" }; },
    "error code not an integer": (res) => { const { result, ...rest } = res; return { ...rest, error: { code: "x", message: "m" } }; },
    "error message not a string": (res) => { const { result, ...rest } = res; return { ...rest, error: { code: 1, message: 2 } }; },
    "array envelope": (res) => [res],
  };
  for (const [label, mutate] of Object.entries(faults)) {
    const log = [];
    const fetch = fakeFetch({
      [A.url]: async (method, params, n) => {
        const good = await plausible(method, params).json(); // the canonical answer, id echoed
        return new Response(JSON.stringify(n > 3 ? mutate(good) : good), { status: 200 }); // chainId, block, header fine; the first getter's envelope is faulty
      },
      [B.url]: plausible,
    }, log);
    const rpc = makeRpc(fetch);
    const warnings = [];
    const got = await withFallback([A, B], CHAIN_ID_HEX, rpc, strictSnapshotOf(rpc), (m) => warnings.push(m));
    assert.equal(got?.endpoint, B, label);
    assert.equal(Object.keys(got.value.results).length, 33, label);
    assert.match(warnings[0], /proxy: malformed \((jsonrpc|response id does not match|both result and error|neither result nor error|error is not|not an object)/, label);
    assert.equal(log.filter((l) => l.startsWith(A.url)).length, 4, `${label}: A abandoned at the faulty envelope`);
  }
  // a well-formed error envelope is an rpc-error (not malformed) and still falls through
  const errRpc = makeRpc(fakeFetch({
    [A.url]: (m, p, n) => (n > 3 ? new Response(JSON.stringify({ jsonrpc: "2.0", id: currentId, error: { code: -32000, message: "execution reverted" } }), { status: 200 }) : plausible(m, p)),
    [B.url]: plausible,
  }));
  const w = [];
  assert.equal((await withFallback([A, B], CHAIN_ID_HEX, errRpc, strictSnapshotOf(errRpc), (m) => w.push(m))).endpoint, B);
  assert.match(w[0], /proxy: rpc-error \(execution reverted\)/);
  // direct: the reason is carried on the RpcError
  const direct = makeRpc(fakeFetch({ [A.url]: () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 999999, result: CHAIN_ID_HEX }), { status: 200 }) }));
  await assert.rejects(direct(A, "eth_chainId", []), (e) => e instanceof RpcError && e.kind === "malformed" && /id does not match/.test(e.message));
  // the id sent increments per request and the stub echoes it: two consecutive calls both succeed
  const seq = makeRpc(fakeFetch({ [A.url]: happy }));
  assert.equal((await seq(A, "eth_chainId", [])).result, CHAIN_ID_HEX);
  assert.equal((await seq(A, "eth_blockNumber", [])).result, "0x3276f9f");
});
