// Shared live-block logic for Overview / Protocol. Fixtures = the block 52,919,775 reads printed in spec v6.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OVERVIEW_KEYS, PROTOCOL_KEYS, USE_KEYS, deriveSubset, keysForPage, overviewStrip, snapshotLine, subsetCalls, useStrip } from "../live-logic.mjs";
import { GETTERS } from "../../token/config.js";

const u = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");
const E18 = 10n ** 18n;
const SNAP = { block: 52_919_775, timestamp: 1761092897 };

test("subsetCalls returns only requested getters, all pinned to the same block, never an invented key", () => {
  const calls = subsetCalls("0x327a1df", OVERVIEW_KEYS);
  assert.deepEqual(calls.map((c) => c.key).sort(), [...OVERVIEW_KEYS].sort());
  assert.ok(calls.every((c) => c.blockTag === "0x327a1df"));
  assert.equal(subsetCalls("0x1", ["notAGetter"]).length, 0);
  for (const k of [...OVERVIEW_KEYS, ...PROTOCOL_KEYS]) assert.ok(k in GETTERS, `${k} is a spec v6 getter`);
  assert.equal(subsetCalls("0x1", PROTOCOL_KEYS).length, PROTOCOL_KEYS.length);
});

test("overview strip reads supply, emitted, cap and block; a getter not requested shows a dash, never a number", () => {
  const d = deriveSubset({ totalSupply: u(8_400_000n * E18), T: u(0), maxSupply: u(21_000_000n * E18) }, SNAP);
  assert.equal(overviewStrip(d), "Total supply 8,400,000 PSRE · Emitted through rewards 0 PSRE · Cap 21,000,000 PSRE · Block 52,919,775");
  assert.equal(d.treasury, "—");
  assert.equal(d.epoch, "—");
  assert.equal(d.emissionsLine, "Zero PSRE has been released so far.");
});

test("protocol subset derives treasury, reserve, split and epoch state from the pinned block", () => {
  const r = {
    totalSupply: u(8_400_000n * E18), T: u(0), maxSupply: u(21_000_000n * E18), emissionReserve: u(12_600_000n * E18),
    remainingMintable: u(12_600_000n * E18), remainingEmission: u(12_600_000n * E18), sEmission: u(12_600_000n * E18),
    treasuryBalance: u(4_000_000n * E18 + 3_000_000_000_000n), partnerSplit: u(7n * 10n ** 17n), currentScarcityCap: u(12_600n * E18),
    currentEpochId: u(26), epochDuration: u(604800), genesisTimestamp: u(1776829977), lastFinalizedEpoch: u(7), firstEpochFinalized: u(1),
    enginePaused: u(0), psrePaused: u(0), activeVaultCount: u(0), vaultCount: u(0), totalPSREStaked: u(0),
    paramTimelock: u(172800), upgradeTimelock: u(604800), pendingUpgrade: u(0), upgradeTimestamp: u(0),
  };
  const d = deriveSubset(r, SNAP);
  assert.equal(d.treasury, "4,000,000");
  assert.equal(d.reserveRemaining, "12,600,000");
  assert.equal(d.partnerShare, "70%");
  assert.equal(d.stakerShare, "30%");
  assert.equal(d.partnersLive, "0");
  assert.equal(d.engineStatus, "active");
  assert.equal(d.paramTimelockHours, 48);
  assert.equal(d.upgradeTimelockDays, 7);
  assert.equal(d.founder, "—"); // not requested on the Protocol page
});

test("snapshot line: fresh shows block + time + endpoint; stale says so and keeps the last block", () => {
  const d = deriveSubset({ totalSupply: u(0) }, SNAP);
  assert.match(snapshotLine(d, "prospereum rpc proxy", false), /^Block 52,919,775, \d\d:\d\d UTC · via prospereum rpc proxy$/);
  assert.match(snapshotLine(d, "x", true), /^Stale — last successful snapshot: block 52,919,775, 2025-10-22 \d\d:\d\d UTC$/);
});

test("use page: USE_KEYS are spec v6 getters; keysForPage maps the data-live-keys values; the strip reads live / all-time vault counts", () => {
  for (const k of USE_KEYS) assert.ok(k in GETTERS, `${k} is a spec v6 getter`);
  assert.deepEqual(keysForPage("use"), USE_KEYS);
  assert.deepEqual(keysForPage("protocol"), PROTOCOL_KEYS);
  assert.deepEqual(keysForPage("overview"), OVERVIEW_KEYS);
  assert.deepEqual(keysForPage("anything-else"), OVERVIEW_KEYS);
  assert.equal(subsetCalls("0x1", USE_KEYS).length, 2);
  const zero = deriveSubset({ activeVaultCount: u(0), vaultCount: u(0) }, SNAP);
  assert.equal(useStrip(zero), "No partner vault is live yet · 0 created all-time · Block 52,919,775");
  assert.equal(zero.treasury, "—");
  const some = deriveSubset({ activeVaultCount: u(3), vaultCount: u(5) }, SNAP);
  assert.equal(useStrip(some), "Partner vaults live 3 · created all-time 5 · Block 52,919,775");
});
