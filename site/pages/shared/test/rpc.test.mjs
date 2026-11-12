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

/** fetch stub: per-endpoint behaviour keyed by URL; `plan[url](method, params, n)` returns a Response or throws. */
function fakeFetch(plan, log = []) {
  const counts = {};
  return async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    counts[url] = (counts[url] ?? 0) + 1;
    log.push(`${url} ${method}`);
    return plan[url](method, params, counts[url], init);
  };
}
const ok = (result, headers = {}) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200, headers });
const rpcErr = (message) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message } }), { status: 400 });
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
/** A plausible full Token snapshot: one word per getter, two for the pending (value, readyAt) getters. */
const plausible = (method, params) => {
  if (method !== "eth_call") return happy(method, params);
  const c = buildCalls("0x0").find((x) => x.to === params[0].to && x.data === params[0].data);
  return ok(c && c.words === 2 ? twoWords : u(7));
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
  const rpc = makeRpc(fakeFetch({ [A.url]: (m, p) => (m === "eth_call" && p[0].data === "0x32cb6b0c" ? ok("0x") : ok(u(3), { "X-Prospereum-Upstream": "Alchemy" })) }, log)); // maxSupply (2nd call) undecodable
  const calls = buildCalls("0x3276f9f");
  await assert.rejects(readCalls(rpc, A, calls), (e) => e instanceof RpcError && e.kind === "undecodable" && /maxSupply/.test(e.message));
  assert.equal(log.length, 2, "stopped at the undecodable getter");
  const good = makeRpc(fakeFetch({ [A.url]: () => ok(u(3), { "X-Prospereum-Upstream": "Alchemy" }) }));
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
