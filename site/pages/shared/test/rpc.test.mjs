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
