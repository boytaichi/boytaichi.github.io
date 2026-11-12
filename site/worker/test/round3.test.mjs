// Kin PR #1 round 3 (2026-11-12) — Worker finding 4: `params` must be absent or an array (absent only for the no-param
// methods; any non-array → -32602, never coerced to []), and the request envelope may carry only jsonrpc / id / method /
// params (any extra member → -32600).
// Run from site/worker: node --test test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle, validateRequest, CONTRACTS } from "../src/index.js";
import { env, req, upstream, word } from "./helpers.mjs";

const BLOCK = "0x3276f9f";
const TOTAL_SUPPLY = { to: CONTRACTS.PSRE, data: "0x18160ddd" };
const run = async (body, deps) => {
  const r = await handle(req(body), env, deps ?? { fetch: upstream(word(1)) });
  return { status: r.status, body: await r.json() };
};

test("round 3 #4 — params as object / string / number / null / true → -32602 (400) on every method; absent params on eth_chainId / eth_blockNumber → OK; absent on eth_call / eth_getBlockByNumber → -32602", async () => {
  for (const method of ["eth_chainId", "eth_blockNumber", "eth_call", "eth_getBlockByNumber"]) {
    for (const params of [{}, { to: CONTRACTS.PSRE }, "[]", 0, 1, null, true]) {
      const calls = [];
      const { status, body } = await run({ jsonrpc: "2.0", id: 5, method, params }, { fetch: upstream(word(1), calls) });
      assert.equal(status, 400, `${method} params=${JSON.stringify(params)}`);
      assert.equal(body.error.code, -32602, `${method} params=${JSON.stringify(params)}`);
      assert.match(body.error.message, /params must be an array/, method);
      assert.equal(body.id, 5);
      assert.equal(calls.length, 0, "never reaches the upstream");
    }
  }
  // absent params: fine for the no-param methods, -32602 for the ones that need arguments
  const calls = [];
  const deps = { fetch: upstream((b) => (b.method === "eth_chainId" ? "0x2105" : "0x3276f9f"), calls) };
  const c = await run({ jsonrpc: "2.0", id: 1, method: "eth_chainId" }, deps);
  assert.equal(c.status, 200);
  assert.equal(c.body.result, "0x2105");
  const b = await run({ jsonrpc: "2.0", id: 2, method: "eth_blockNumber" }, deps);
  assert.equal(b.status, 200);
  for (const method of ["eth_call", "eth_getBlockByNumber"]) {
    const { status, body } = await run({ jsonrpc: "2.0", id: 3, method }, deps);
    assert.equal(status, 400, method);
    assert.equal(body.error.code, -32602, method);
    assert.match(body.error.message, /needs params/, method);
  }
  assert.equal(calls.length, 2, "only the two no-param calls reached the upstream");
  // and the direct validator agrees
  assert.equal(validateRequest({ jsonrpc: "2.0", id: 1, method: "eth_chainId" }).ok, true);
  assert.equal(validateRequest({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: null }).error.body.error.code, -32602);
  assert.equal(validateRequest({ jsonrpc: "2.0", id: 1, method: "eth_call", params: { to: CONTRACTS.PSRE, data: "0x18160ddd" } }).error.body.error.code, -32602);
  assert.equal(validateRequest({ jsonrpc: "2.0", id: 1, method: "eth_call" }).error.body.error.code, -32602);
  // an explicit empty array on the no-param methods stays accepted (what the pages send)
  assert.equal(validateRequest({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }).ok, true);
});

test("round 3 #4 — any member beyond jsonrpc / id / method / params → -32600 (400), never forwarded; the exact four-member envelope the pages send is accepted", async () => {
  const extras = [
    { foo: 1 },
    { extra: "x" },
    { meta: { a: 1 } },
    { jsonrpc2: "2.0" },
    { Params: [] }, // case matters: not the `params` member
    { __proto__: null, hack: true },
    { "": 1 },
  ];
  for (const extra of extras) {
    for (const base of [
      { jsonrpc: "2.0", id: 9, method: "eth_chainId", params: [] },
      { jsonrpc: "2.0", id: 9, method: "eth_call", params: [TOTAL_SUPPLY, BLOCK] },
    ]) {
      const calls = [];
      const { status, body } = await run({ ...base, ...extra }, { fetch: upstream(word(1), calls) });
      assert.equal(status, 400, `${base.method} + ${JSON.stringify(Object.keys(extra))}`);
      assert.equal(body.error.code, -32600, `${base.method} + ${JSON.stringify(Object.keys(extra))}`);
      assert.match(body.error.message, /request member not accepted/);
      assert.equal(body.id, 9);
      assert.equal(calls.length, 0, "never reaches the upstream");
    }
  }
  // the extra-member check runs after the jsonrpc check and before the method check, so the error class is stable
  const noVersion = validateRequest({ id: 1, method: "eth_chainId", params: [], foo: 1 });
  assert.match(noVersion.error.body.error.message, /jsonrpc must be/);
  const badMethod = validateRequest({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [], foo: 1 });
  assert.equal(badMethod.error.body.error.code, -32600);
  // a long member name is truncated in the message (nothing echoed at length)
  const long = validateRequest({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [], ["x".repeat(500)]: 1 });
  assert.ok(long.error.body.error.message.length < 80);
  // the exact envelopes the pages send are accepted and served
  const calls = [];
  const deps = { fetch: upstream((b) => (b.method === "eth_chainId" ? "0x2105" : word(1)), calls) };
  const a = await run({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }, deps);
  assert.equal(a.status, 200);
  const b = await run({ jsonrpc: "2.0", id: 2, method: "eth_call", params: [TOTAL_SUPPLY, BLOCK] }, deps);
  assert.equal(b.status, 200);
  assert.equal(b.body.result, word(1));
  // an id-less envelope (a JSON-RPC notification shape) still has only accepted members
  const n = await run({ jsonrpc: "2.0", method: "eth_chainId", params: [] }, deps);
  assert.equal(n.status, 200);
  assert.equal(n.body.id, null);
});
