// Fixtures = the reads at block 52,919,775 printed in Token page spec v6 §3–§4.
import { test } from "node:test";
import assert from "node:assert/strict";
import { backlog, buildCalls, derive, fmtPct, fmtPsre, statusCopy } from "../token-logic.mjs";
import { ADDR, GETTERS } from "../config.js";

const u = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");
const E18 = 10n ** 18n;
const SNAP = { block: 52_919_775, timestamp: 1776829977 + 27 * 604800 - 3 * 86400 }; // 3 days before the end of epoch 26
const live = {
  totalSupply: u(8_400_000n * E18), T: u(0), maxSupply: u(21_000_000n * E18), remainingEmission: u(12_600_000n * E18),
  remainingMintable: u(12_600_000n * E18), sEmission: u(12_600_000n * E18), emissionReserve: u(12_600_000n * E18),
  treasuryBalance: u(4_000_000n * E18 + 3_000_000_000_000n), founderBalance: u(4_200_000n * E18),
  activeVaultCount: u(0), vaultCount: u(0), poolBalance: u(199_999_900_000_000_000_000_000n), poolFee: u(10000),
  partnerSplit: u(7n * 10n ** 17n), psreSplit: u(E18), lpSplit: u(0), totalPSREStaked: u(0), currentScarcityCap: u(12_600n * E18),
  currentEpochId: u(26), epochDuration: u(604800), genesisTimestamp: u(1776829977), lastFinalizedEpoch: u(7), firstEpochFinalized: u(1),
  enginePaused: u(0), psrePaused: u(0), pendingUpgrade: u(0), upgradeTimestamp: u(0),
  pendingAlphaBase: u(0) + u(0).slice(2), pendingE0: u(0) + u(0).slice(2), pendingPartnerSplit: u(0) + u(0).slice(2), pendingTierParams: u(0) + u(0).slice(2),
  paramTimelock: u(172800), upgradeTimelock: u(604800),
};

test("every getter in spec v6 is in every refresh, pinned to one blockTag", () => {
  const calls = buildCalls("0x327a1df");
  assert.equal(calls.length, Object.keys(GETTERS).length);
  assert.ok(calls.every((c) => c.blockTag === "0x327a1df"));
  const treasury = calls.find((c) => c.key === "treasuryBalance");
  assert.equal(treasury.to, ADDR.PSRE.toLowerCase());
  assert.equal(treasury.data, "0x70a08231" + ADDR.TREASURY_SAFE.toLowerCase().slice(2).padStart(64, "0"));
});

test("formats: thousands separators, whole PSRE, two-decimal pool balance, percents", () => {
  assert.equal(fmtPsre(8_400_000n * E18), "8,400,000");
  assert.equal(fmtPsre(4_000_000n * E18 + 3_000_000_000_000n), "4,000,000"); // rounded to whole PSRE (row 4)
  assert.equal(fmtPsre(199_999_900_000_000_000_000_000n, 2), "199,999.90");
  assert.equal(fmtPct(7n * 10n ** 17n), "70%");
  assert.equal(fmtPct(E18 - 7n * 10n ** 17n), "30%");
  assert.equal(fmtPct(0n), "0%");
});

test("backlog branches on firstEpochFinalized", () => {
  assert.deepEqual(backlog(26n, 7n, true), { count: 18, range: [8, 25] });
  assert.deepEqual(backlog(26n, 0n, false), { count: 26, range: [0, 25] });
  assert.deepEqual(backlog(8n, 7n, true), { count: 0, range: null });
});

test("derive at block 52,919,775 reproduces the spec's printed values and the fixed copy", () => {
  const d = derive(live, SNAP);
  assert.equal(d.totalSupply, "8,400,000");
  assert.equal(d.released, "0");
  assert.equal(d.emissionsLine, "Zero PSRE has been released so far.");
  assert.equal(d.treasury, "4,000,000");
  assert.equal(d.founder, "4,200,000");
  assert.equal(d.partnersLive, "0");
  assert.equal(d.poolBalance, "199,999.90");
  assert.equal(d.poolFee, "1%");
  assert.equal(d.partnerShare, "70%");
  assert.equal(d.stakerShare, "30%");
  assert.equal(d.epoch, "26");
  assert.equal(d.epochDuration, "7 days");
  assert.equal(d.epochStart, "2026-10-21 03:52 UTC");
  assert.equal(d.epochEnd, "2026-10-28 03:52 UTC");
  assert.equal(d.nextBoundarySeconds, 3 * 86400);
  assert.equal(d.lastFinalized, "7");
  assert.deepEqual(d.backlog, { count: 18, range: [8, 25] });
  assert.equal(d.engineStatus, "active");
  assert.equal(d.transfers, "normal");
  assert.equal(d.upgrade, "none");
  assert.deepEqual(d.queued, []);
  assert.equal(d.reserveMismatch, null);
  assert.equal(statusCopy(d), "Epochs are seven days long and close on the clock. Finalization, which computes and releases any reward for a closed epoch, is triggered by partner activity or by a keeper. With no partner vaults yet, 18 closed epochs are awaiting finalization. Finalization is pending and must be completed before the first partner joins. Zero PSRE has been released so far.");
});

test("emissions line and backlog sentence move with T() and the backlog; a reverted getter renders as — not 0", () => {
  const d = derive({ ...live, T: u(12_600n * E18), lastFinalizedEpoch: u(25) }, SNAP);
  assert.equal(d.emissionsLine, "12,600 PSRE released through Proof of Prosperity so far.");
  assert.ok(!statusCopy(d).includes("awaiting finalization"));
  const r = derive({ ...live, currentScarcityCap: "0x" }, SNAP);
  assert.equal(r.scarcityCap, "—");
  const q = derive({ ...live, pendingPartnerSplit: u(75n * 10n ** 16n) + u(1_800_000_000).slice(2) }, SNAP);
  assert.equal(q.queued.length, 1);
  assert.equal(q.queued[0].group, "partner share");
  const f = derive({ ...live, firstEpochFinalized: u(0), lastFinalizedEpoch: u(0) }, SNAP);
  assert.equal(f.lastFinalized, "none yet");
  assert.equal(f.backlog.count, 26);
});

// Kin PR #1 round 2 finding 2: every call carries the minimum ABI words its result must decode to (live-read on Base, block 0x35f8d43).
test("round 2 #2 — buildCalls annotates result words: the four pending (value, readyAt) getters need 2, every other getter 1; derive reads exactly those words", () => {
  const calls = buildCalls("0x1");
  const two = calls.filter((c) => c.words === 2).map((c) => c.key).sort();
  assert.deepEqual(two, ["pendingAlphaBase", "pendingE0", "pendingPartnerSplit", "pendingTierParams"]);
  assert.ok(calls.filter((c) => c.words === 1).length === calls.length - 4);
  assert.ok(calls.every((c) => Number.isInteger(c.words) && c.words >= 1));
  // the fixture used throughout this file matches the annotation: one word per key, two for the pending getters
  for (const c of calls) assert.equal((live[c.key].length - 2) / 64, c.words, c.key);
});
