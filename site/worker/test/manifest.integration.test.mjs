// Kin PR #1 finding 2 (blocker) — acceptance: every call the pages make is generated from the PAGE code
// (token-logic buildCalls, live-logic subsetCalls, partners-logic factoryCalls/vaultActiveCall/vaultCalls) and replayed
// through the Worker's handle() at one pinned block against a stubbed upstream. Every page call must be accepted.
// Negative cases: an unregistered vault address with a vault selector, and an unknown selector, are rejected.
// Run from site/worker: node --test test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle, validateRequest, MemoryCache, CONTRACTS } from "../src/index.js";
import { env, req, upstream, word, addrWord, encodeAggregate } from "./helpers.mjs";
import { buildCalls } from "../../pages/token/token-logic.mjs";
import { OVERVIEW_KEYS, PROTOCOL_KEYS, USE_KEYS, subsetCalls } from "../../pages/shared/live-logic.mjs";
import { factoryCalls, vaultActiveCall, vaultCalls } from "../../pages/partners/partners-logic.mjs";
import { FACTORY_GETTERS, VAULT_GETTERS } from "../../pages/partners/config.js";
import { GETTERS } from "../../pages/token/config.js";
import { STATIC_ALLOWLIST, VAULT_SELECTORS, staticPairs } from "../../pages/shared/call-manifest.mjs";

const BLOCK = "0x3276f9f"; // one pinned block for the whole replay
const VAULT_A = "0xaaaa000000000000000000000000000000000001"; // "registered": factory.vaultActive → true
const VAULT_B = "0xbbbb000000000000000000000000000000000002"; // registered but decommissioned: vaultActive → false
const STRANGER = "0xcccc000000000000000000000000000000000003"; // never created by the factory

/** Stub Base: answers the factory registry and every getter with a plausible word; records every upstream call. */
function stubChain(calls = []) {
  const vaultActiveSel = FACTORY_GETTERS.vaultActive;
  return upstream((body) => {
    if (body.method === "eth_chainId") return "0x2105";
    if (body.method === "eth_blockNumber") return BLOCK;
    if (body.method === "eth_getBlockByNumber") return { number: BLOCK, hash: "0x" + "ab".repeat(32), parentHash: "0x" + "cd".repeat(32), timestamp: "0x68f7a2b1" };
    const [{ to, data }] = body.params;
    if (to === CONTRACTS.FACTORY && data.startsWith(vaultActiveSel)) return word(data.slice(10) === addrWord(VAULT_A) ? 1 : 0);
    if (to === CONTRACTS.FACTORY && data === FACTORY_GETTERS.getAllVaults) return "0x" + word(0x20).slice(2) + word(2).slice(2) + addrWord(VAULT_A) + addrWord(VAULT_B);
    return word(7);
  }, calls);
}

/** The page call manifests, generated from the page code at BLOCK. */
function pageManifests() {
  return {
    token: buildCalls(BLOCK),
    protocol: subsetCalls(BLOCK, PROTOCOL_KEYS),
    overview: subsetCalls(BLOCK, OVERVIEW_KEYS),
    use: subsetCalls(BLOCK, USE_KEYS),
    partnersFactory: [...factoryCalls(BLOCK), vaultActiveCall(VAULT_A, BLOCK), vaultActiveCall(VAULT_B, BLOCK)],
    partnersVault: vaultCalls(VAULT_A, BLOCK),
  };
}

async function replay(call, deps) {
  const res = await handle(req({ jsonrpc: "2.0", id: call.key, method: "eth_call", params: [{ to: call.to, data: call.data }, call.blockTag] }), env, deps);
  const body = await res.json();
  return { status: res.status, body };
}

test("manifest: the static allowlist is derived from the page configs (every GETTERS / FACTORY_GETTERS pair, nothing else)", () => {
  const expected = new Set();
  const addr = (k) => ({ PSRE: CONTRACTS.PSRE, REWARD_ENGINE: CONTRACTS.REWARD_ENGINE, FACTORY: CONTRACTS.FACTORY, STAKING_VAULT: CONTRACTS.STAKING_VAULT, POOL: CONTRACTS.POOL })[k];
  for (const [c, s] of Object.values(GETTERS)) expected.add(`${addr(c)} ${s.toLowerCase()}`);
  for (const s of Object.values(FACTORY_GETTERS)) expected.add(`${CONTRACTS.FACTORY} ${s.toLowerCase()}`);
  const actual = new Set(staticPairs().map((p) => `${p.target} ${p.selector}`));
  assert.deepEqual([...actual].sort(), [...expected].sort());
  assert.deepEqual([...VAULT_SELECTORS].sort(), Object.values(VAULT_GETTERS).map((s) => s.toLowerCase()).sort());
  // Kin's exact rejected pairs from the 2026-11-12 addendum are now admitted (addresses lower-cased).
  const pairs = [
    [CONTRACTS.PSRE, "0x5c975abb"],
    [CONTRACTS.REWARD_ENGINE, "0x1f6d3480"], [CONTRACTS.REWARD_ENGINE, "0x5c975abb"], [CONTRACTS.REWARD_ENGINE, "0x95e93245"], [CONTRACTS.REWARD_ENGINE, "0x921bd6f0"],
    [CONTRACTS.REWARD_ENGINE, "0x94ea60ba"], [CONTRACTS.REWARD_ENGINE, "0x80327e37"], [CONTRACTS.REWARD_ENGINE, "0xc472d77a"], [CONTRACTS.REWARD_ENGINE, "0x0db7e096"],
    [CONTRACTS.STAKING_VAULT, "0x156ea9c4"], [CONTRACTS.STAKING_VAULT, "0x6e0a0c8a"], [CONTRACTS.STAKING_VAULT, "0x205d1034"],
    [CONTRACTS.FACTORY, "0x97331bf9"], [CONTRACTS.FACTORY, "0x6f8d34f0"], [CONTRACTS.FACTORY, "0x4821577a"],
  ];
  for (const [t, s] of pairs) assert.ok(STATIC_ALLOWLIST[t]?.has(s), `${t} ${s} admitted`);
  for (const s of ["0x8da5cb5b", "0x2c71f81a", "0xb2cfd893", "0x1e08f98c"]) assert.ok(VAULT_SELECTORS.has(s), `vault selector ${s}`);
  // psreSplit / lpSplit live on the StakingVault (page config), not on the RewardEngine.
  assert.equal(STATIC_ALLOWLIST[CONTRACTS.REWARD_ENGINE].has("0x156ea9c4"), false);
  assert.equal(STATIC_ALLOWLIST[CONTRACTS.STAKING_VAULT].has("0x156ea9c4"), true);
});

test("integration: every page call (token 33, protocol, overview, use, partners factory + per-vault) is accepted by handle() at one pinned block", async () => {
  const calls = [];
  const deps = { fetch: stubChain(calls), cache: new MemoryCache(), vaultCache: new MemoryCache() };
  const m = pageManifests();
  assert.equal(m.token.length, 33);
  assert.equal(m.partnersVault.length, Object.keys(VAULT_GETTERS).length);
  let total = 0;
  for (const [page, list] of Object.entries(m)) {
    assert.ok(list.length > 0, page);
    for (const c of list) {
      const { status, body } = await replay(c, deps);
      assert.equal(status, 200, `${page}.${c.key} → ${status} ${body.error?.message ?? ""}`);
      assert.equal(body.id, c.key);
      assert.ok(typeof body.result === "string" && body.result.startsWith("0x"), `${page}.${c.key} result`);
      assert.equal(body.error, undefined);
      total++;
    }
  }
  // the page's non-call reads at the same block
  for (const [method, params] of [["eth_chainId", []], ["eth_blockNumber", []], ["eth_getBlockByNumber", [BLOCK, false]]]) {
    const res = await handle(req({ jsonrpc: "2.0", id: method, method, params }), env, deps);
    assert.equal(res.status, 200, method);
  }
  // every upstream eth_call went out at the pinned block (incl. the factory verification of VAULT_A)
  for (const u of calls.filter((x) => x.body.method === "eth_call")) assert.equal(u.body.params[1], BLOCK);
  const verifications = calls.filter((x) => x.body.method === "eth_call" && x.body.params[0].to === CONTRACTS.FACTORY && x.body.params[0].data === FACTORY_GETTERS.vaultActive + addrWord(VAULT_A));
  assert.ok(verifications.length >= 1, "the Worker verified VAULT_A against the factory upstream");
  assert.ok(total >= 33 + PROTOCOL_KEYS.length + OVERVIEW_KEYS.length + USE_KEYS.length + 6 + 4, `replayed ${total} calls`);
});

test("integration: the Token page's 33 getters as ONE Multicall3.aggregate are accepted; aggregate with a vault inner call needs the vault registered", async () => {
  const deps = { fetch: stubChain(), cache: new MemoryCache(), vaultCache: new MemoryCache() };
  const agg = encodeAggregate(buildCalls(BLOCK).map((c) => ({ to: c.to, data: c.data })));
  const r = await handle(req({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: CONTRACTS.MULTICALL3, data: agg }, BLOCK] }), env, deps);
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  const withVault = encodeAggregate([{ to: CONTRACTS.FACTORY, data: FACTORY_GETTERS.activeVaultCount }, { to: VAULT_A, data: VAULT_GETTERS.ecosystemBalance }]);
  assert.equal((await handle(req({ jsonrpc: "2.0", id: 2, method: "eth_call", params: [{ to: CONTRACTS.MULTICALL3, data: withVault }, BLOCK] }), env, deps)).status, 200);
  const withStranger = encodeAggregate([{ to: CONTRACTS.FACTORY, data: FACTORY_GETTERS.activeVaultCount }, { to: STRANGER, data: VAULT_GETTERS.ecosystemBalance }]);
  const s = await handle(req({ jsonrpc: "2.0", id: 3, method: "eth_call", params: [{ to: CONTRACTS.MULTICALL3, data: withStranger }, BLOCK] }), env, deps);
  assert.equal(s.status, 400);
  assert.match((await s.json()).error.message, /not a registered partner vault/);
});

test("negative: an unregistered or decommissioned vault address with a vault selector is rejected (400, -32602); a registered one is admitted; verdicts are cached briefly and bounded", async () => {
  const calls = [];
  const vaultCache = new MemoryCache(() => Date.now(), 4);
  const deps = { fetch: stubChain(calls), cache: new MemoryCache(), vaultCache };
  for (const sel of Object.values(VAULT_GETTERS)) {
    const a = await replay({ key: "a", to: VAULT_A, data: sel, blockTag: BLOCK }, deps);
    assert.equal(a.status, 200, `registered vault ${sel}`);
    const b = await replay({ key: "b", to: VAULT_B, data: sel, blockTag: BLOCK }, deps);
    assert.equal(b.status, 400, `decommissioned vault ${sel}`);
    assert.equal(b.body.error.code, -32602);
    const s = await replay({ key: "s", to: STRANGER, data: sel, blockTag: BLOCK }, deps);
    assert.equal(s.status, 400, `stranger ${sel}`);
    assert.match(s.body.error.message, /not a registered partner vault/);
  }
  // one factory verification per address (then cached), not one per call
  const verifications = calls.filter((x) => x.body.method === "eth_call" && x.body.params[0].data.startsWith(FACTORY_GETTERS.vaultActive));
  assert.equal(verifications.length, 3);
  assert.ok(vaultCache.size <= 4);
  // the stub never served a stranger's getter: nothing with STRANGER as `to` reached the upstream
  assert.equal(calls.filter((x) => x.body.method === "eth_call" && x.body.params[0].to === STRANGER).length, 0);
});

test("negative: a vault selector on a registered vault at a block where the factory says inactive is rejected; verification failure fails closed (502)", async () => {
  const deps = { fetch: stubChain(), cache: new MemoryCache(), vaultCache: new MemoryCache() };
  const inactive = await replay({ key: "x", to: VAULT_B, data: VAULT_GETTERS.owner, blockTag: BLOCK }, deps);
  assert.equal(inactive.status, 400);
  const down = { fetch: async () => { throw new Error("ECONNREFUSED"); }, cache: new MemoryCache(), vaultCache: new MemoryCache() };
  const r = await replay({ key: "y", to: VAULT_A, data: VAULT_GETTERS.owner, blockTag: BLOCK }, down);
  assert.equal(r.status, 502);
  assert.equal(r.body.error.message, "upstream unavailable");
});

test("negative: an unknown selector on an allowed contract, a vault selector on a protocol contract, and a known selector on a stranger are all rejected without touching the upstream", async () => {
  const calls = [];
  const deps = { fetch: stubChain(calls), cache: new MemoryCache(), vaultCache: new MemoryCache() };
  for (const [to, data] of [
    [CONTRACTS.PSRE, "0xa9059cbb"], // transfer(address,uint256)
    [CONTRACTS.REWARD_ENGINE, "0x8da5cb5b"], // owner() is a vault selector, not an engine getter
    [CONTRACTS.FACTORY, "0xdeadbeef"],
    [STRANGER, "0x18160ddd"], // totalSupply() on an unknown address
    [STRANGER, "0xdeadbeef"],
  ]) {
    const r = await replay({ key: "n", to, data, blockTag: BLOCK }, deps);
    assert.equal(r.status, 400, `${to} ${data}`);
    assert.equal(r.body.error.code, -32602);
    assert.equal(validateRequest({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, BLOCK] }).ok, false);
  }
  assert.equal(calls.length, 0);
});
