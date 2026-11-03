// prospereum.io — shared read-only "live block" logic for the Overview, Protocol and "Where you can use it" pages. No DOM, no network.
// Reuses the Token page's typed constants and decoding (token/config.js, token/token-logic.mjs) so there is ONE
// set of addresses and selectors on the site. Pages ask for a subset of getters; every call is pinned to one block.
import { buildCalls, derive } from "../token/token-logic.mjs";

/** Getters the Overview live strip needs (site copy §2.1): total supply, emitted to date, cap, block. */
export const OVERVIEW_KEYS = ["totalSupply", "T", "maxSupply"];

/** Getters the Protocol page's live block needs (site copy §2.3 + spec v6 §4): reserve, treasury, split, epoch state. */
export const PROTOCOL_KEYS = [
  "totalSupply", "T", "maxSupply", "emissionReserve", "remainingMintable", "treasuryBalance",
  "remainingEmission", "sEmission", "partnerSplit", "currentScarcityCap", "currentEpochId", "epochDuration",
  "genesisTimestamp", "lastFinalizedEpoch", "firstEpochFinalized", "enginePaused", "psrePaused",
  "activeVaultCount", "vaultCount", "totalPSREStaked", "paramTimelock", "upgradeTimelock", "pendingUpgrade", "upgradeTimestamp",
];

/** Getters the "Where you can use it" page needs (IA v1 §1: PartnerVault count): vaults live, vaults created all-time. */
export const USE_KEYS = ["activeVaultCount", "vaultCount"];

/** Keys for a page's `data-live-keys` value; unknown values fall back to the Overview strip. */
export function keysForPage(which) {
  if (which === "protocol") return PROTOCOL_KEYS;
  if (which === "use") return USE_KEYS;
  return OVERVIEW_KEYS;
}

/** Subset of the Token page's call list, same blockTag for all; unknown keys are ignored (never invented). */
export function subsetCalls(blockTag, keys) {
  const want = new Set(keys);
  return buildCalls(blockTag).filter((c) => want.has(c.key));
}

/**
 * Derive display values from a partial result set. Getters not requested decode as "—" through `derive`
 * (it treats a missing word as a revert), so a page only ever shows what it asked for.
 */
export function deriveSubset(results, snapshot) {
  return derive(results, snapshot);
}

/** The Overview strip, one line (site copy §2.1 "Live strip"). */
export function overviewStrip(d) {
  return `Total supply ${d.totalSupply} PSRE · Emitted through rewards ${d.released} PSRE · Cap ${d.maxSupply} PSRE · Block ${d.snapshot.block.toLocaleString("en-US")}`;
}

/** The "Where you can use it" strip (IA v1 §1 live data). */
export function useStrip(d) {
  const live = d.partnersLive ?? "—";
  const all = d.vaultsAllTime ?? "—";
  if (live === "0") return `No partner vault is live yet · ${all} created all-time · Block ${d.snapshot.block.toLocaleString("en-US")}`;
  return `Partner vaults live ${live} · created all-time ${all} · Block ${d.snapshot.block.toLocaleString("en-US")}`;
}

/** Snapshot caption shared by the live pages. */
export function snapshotLine(d, endpoint, stale) {
  const t = new Date(d.snapshot.timestamp * 1000).toISOString();
  return stale
    ? `Stale — last successful snapshot: block ${d.snapshot.block.toLocaleString("en-US")}, ${t.replace("T", " ").slice(0, 16)} UTC`
    : `Block ${d.snapshot.block.toLocaleString("en-US")}, ${t.slice(11, 16)} UTC · via ${endpoint}`;
}
