// node --test partners/test/partners-logic.test.mjs  (run from site/pages/)
import test from "node:test";
import assert from "node:assert/strict";
import {
  ZERO, batchConversion, decodeAddressArray, decodeBool, decodeUint, factoryCalls, finalizationsOnNextCall, livePartnerList, mayClaim, partnersHeadline, pct18, tierOf, vaultActiveCall, vaultCalls,
} from "../partners-logic.mjs";
import { ADDR, FACTORY_GETTERS, VAULT_GETTERS } from "../config.js";
import { STATIC_ALLOWLIST, VAULT_SELECTORS, classifyCall } from "../../shared/call-manifest.mjs";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const OWNER = "0x9999999999999999999999999999999999999999";

test("live partner list filters by vaultActive, never vaultCount (§1 build rule)", () => {
  assert.deepEqual(livePartnerList([A, B], [true, false]), [A]);
  assert.deepEqual(livePartnerList([], []), []);
  assert.throws(() => livePartnerList([A], []), /mismatch/);
});

test("batch conversion: integer floor per credit, residue kept, never invented (§3.4 step 3)", () => {
  const r = batchConversion({ usdcAmountIn: 1_000_000_000n /* 1,000 USDC */, psreOut: 123_456_789_012_345_678_901n, credits: [{ id: "a", owedUsdc: 333_333_333n }, { id: "b", owedUsdc: 666_666_667n }] });
  assert.equal(r.credits[0].creditPsre, (333_333_333n * 123_456_789_012_345_678_901n) / 1_000_000_000n);
  assert.equal(r.totalCredited + r.residue, 123_456_789_012_345_678_901n);
  assert.ok(r.residue >= 0n && r.residue < 2n * 123_456_789_012_345_678_901n / 1_000_000_000n + 2n);
  assert.throws(() => batchConversion({ usdcAmountIn: 1n, psreOut: 1n, credits: [{ owedUsdc: 2n }] }), /owe more/);
  assert.throws(() => batchConversion({ usdcAmountIn: 1, psreOut: 1n, credits: [] }), TypeError);
  assert.throws(() => batchConversion({ usdcAmountIn: 0n, psreOut: 1n, credits: [] }), RangeError);
});

test("claimVault authorization (§3.2): intended customer or owner; address(0) → owner only; one-time", () => {
  assert.deepEqual(mayClaim({ intendedCustomer: A, caller: A, vaultOwner: OWNER }), { ok: true, by: "intended customer" });
  assert.deepEqual(mayClaim({ intendedCustomer: A, caller: OWNER, vaultOwner: OWNER }), { ok: true, by: "owner" });
  assert.equal(mayClaim({ intendedCustomer: A, caller: B, vaultOwner: OWNER }).ok, false);
  assert.match(mayClaim({ intendedCustomer: ZERO, caller: A, vaultOwner: OWNER }).reason, /platform-managed/);
  assert.equal(mayClaim({ intendedCustomer: ZERO, caller: OWNER, vaultOwner: OWNER }).ok, true);
  assert.equal(mayClaim({ intendedCustomer: A, caller: A, vaultOwner: OWNER, alreadyClaimed: true }).ok, false);
  assert.equal(mayClaim({ intendedCustomer: A.toUpperCase().replace("0X", "0x"), caller: A, vaultOwner: OWNER }).ok, true);
});

test("tier derivation R/sumR vs 0.5 % / 2.0 % (§3.3) and pct18", () => {
  const th = { silverThreshold: 5n * 10n ** 15n, goldThreshold: 2n * 10n ** 16n };
  assert.equal(tierOf({ R: 1n, sumR: 1000n, ...th }).tier, "bronze"); // 0.1 %
  assert.equal(tierOf({ R: 5n, sumR: 1000n, ...th }).tier, "silver"); // 0.5 %
  assert.equal(tierOf({ R: 19n, sumR: 1000n, ...th }).tier, "silver");
  assert.equal(tierOf({ R: 20n, sumR: 1000n, ...th }).tier, "gold"); // 2.0 %
  assert.deepEqual(tierOf({ R: 0n, sumR: 0n, ...th }), { share: 0n, tier: "bronze" });
  assert.equal(pct18(5n * 10n ** 15n), "0.50%");
  assert.equal(pct18(7n * 10n ** 17n), "70.00%");
});

test("finalizations paid by the next createVault()/buy() (§3.5): 18-epoch backlog → 10 then 8", () => {
  assert.equal(finalizationsOnNextCall({ currentEpochId: 26n, lastFinalizedEpoch: 7n }), 10n);
  assert.equal(finalizationsOnNextCall({ currentEpochId: 26n, lastFinalizedEpoch: 17n }), 8n);
  assert.equal(finalizationsOnNextCall({ currentEpochId: 26n, lastFinalizedEpoch: 25n }), 0n);
});

test("decoders", () => {
  assert.equal(decodeUint("0x" + "0".repeat(63) + "7"), 7n);
  assert.equal(decodeUint("0x12"), null);
  assert.equal(decodeBool("0x" + "0".repeat(63) + "1"), true);
  assert.equal(decodeBool("0x" + "0".repeat(64)), false);
  const w = (n) => n.toString(16).padStart(64, "0");
  const addr = (a) => a.slice(2).toLowerCase().padStart(64, "0");
  assert.deepEqual(decodeAddressArray("0x" + w(32) + w(2) + addr(A) + addr(B)), [A, B]);
  assert.deepEqual(decodeAddressArray("0x" + w(32) + w(0)), []);
  assert.equal(decodeAddressArray("0x" + w(32) + w(3) + addr(A)), null);
  assert.equal(decodeAddressArray("0xabc"), null);
});

test("headline uses the live active count only", () => {
  assert.equal(partnersHeadline(null), "Partners, announced as they launch.");
  assert.equal(partnersHeadline(0n), "Partners, announced as they launch. None live yet.");
  assert.equal(partnersHeadline(1n), "1 partner live on Base.");
  assert.equal(partnersHeadline(3n), "3 partners live on Base.");
});

test("call builders (Kin PR #1 finding 2): factory reads, vaultActive(vault) and per-vault reads are pinned to one block and every pair is in the shared manifest", () => {
  const f = factoryCalls("0x327a1df");
  assert.deepEqual(f.map((c) => c.key), ["activeVaultCount", "vaultCount", "maxPartners", "getAllVaults"]);
  assert.ok(f.every((c) => c.to === ADDR.FACTORY.toLowerCase() && c.blockTag === "0x327a1df" && c.data === FACTORY_GETTERS[c.key]));
  const va = vaultActiveCall(A.toUpperCase().replace("0X", "0x"), "0x327a1df");
  assert.equal(va.data, FACTORY_GETTERS.vaultActive + A.slice(2).padStart(64, "0"));
  assert.equal(va.to, ADDR.FACTORY.toLowerCase());
  const v = vaultCalls(A, "0x327a1df");
  assert.deepEqual(v.map((c) => c.key).sort(), Object.keys(VAULT_GETTERS).sort());
  assert.ok(v.every((c) => c.to === A && c.blockTag === "0x327a1df" && VAULT_SELECTORS.has(c.data)));
  for (const c of [...f, va]) assert.equal(classifyCall(c.to, c.data.slice(0, 10)), "static", c.key);
  for (const c of v) assert.equal(classifyCall(c.to, c.data), "vault", c.key);
  assert.ok(STATIC_ALLOWLIST[ADDR.FACTORY.toLowerCase()].has(FACTORY_GETTERS.getAllVaults));
});

// Kin PR #1 round 2 finding 2: result-word minimums on every Partners call (the page refuses a snapshot that does not decode).
test("round 2 #2 — factory / vaultActive / vault calls carry result-word minimums: getAllVaults needs the two head words (an empty list), the rest one", () => {
  const f = factoryCalls("0x1");
  assert.deepEqual(Object.fromEntries(f.map((c) => [c.key, c.words])), { activeVaultCount: 1, vaultCount: 1, maxPartners: 1, getAllVaults: 2 });
  assert.equal(vaultActiveCall("0x" + "aa".repeat(20), "0x1").words, 1);
  for (const c of vaultCalls("0x" + "aa".repeat(20), "0x1")) assert.equal(c.words, 1, c.key);
  // an empty address[] is exactly two words (offset 0x20, length 0) — decodes to []; one word is undecodable (null)
  const empty = "0x" + (32).toString(16).padStart(64, "0") + "0".repeat(64);
  assert.deepEqual(decodeAddressArray(empty), []);
  assert.equal(decodeAddressArray("0x" + (32).toString(16).padStart(64, "0")), null);
  assert.equal(decodeUint("0x"), null);
});
