// prospereum.io — Token page pure logic (spec v6 §3–§6). No DOM, no network: testable with `node --test`.
// The browser glue (token.js) builds the call list here, runs it at one pinned block, and renders what `derive` returns.
import { ADDR, GETTERS } from "./config.js";

const E18 = 10n ** 18n;

/** Build the eth_call list for one refresh: every displayed getter, mutable and immutable, at the same blockTag (§6). */
export function buildCalls(blockTag) {
  return Object.entries(GETTERS).map(([key, [contract, selector, argAddr]]) => {
    const data = argAddr ? selector + ADDR[argAddr].toLowerCase().slice(2).padStart(64, "0") : selector;
    return { key, to: ADDR[contract].toLowerCase(), data, blockTag };
  });
}

/** Decode a single uint256 / bool word; empty "0x" (a revert on a getter that does not exist) → null. */
export function word(hex, i = 0) {
  if (!hex || hex === "0x" || hex.length < 2 + 64 * (i + 1)) return null;
  return BigInt("0x" + hex.slice(2 + 64 * i, 2 + 64 * (i + 1)));
}

/** ÷ 1e18 with thousands separators; `decimals` fractional digits (0 = whole PSRE). */
export function fmtPsre(x, decimals = 0) {
  if (x === null) return "—";
  const neg = x < 0n;
  const abs = neg ? -x : x;
  const whole = abs / E18;
  const frac = abs % E18;
  let s = whole.toLocaleString("en-US");
  if (decimals > 0) s += "." + frac.toString().padStart(18, "0").slice(0, decimals);
  return (neg ? "-" : "") + s;
}

/** 1e18-scaled fraction → percent string, e.g. 0.70e18 → "70%". */
export function fmtPct(x) {
  if (x === null) return "—";
  const bp = (x * 10000n) / E18; // basis points
  const p = Number(bp) / 100;
  return (Number.isInteger(p) ? p.toFixed(0) : p.toFixed(2).replace(/0+$/, "")) + "%";
}

export function fmtUtc(unixSeconds) {
  const d = new Date(Number(unixSeconds) * 1000);
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/** Epoch duration display rule (§4): "7 days" when divisible by 86,400, else "N hours". */
export function fmtDuration(seconds) {
  if (seconds === null) return "—";
  const s = Number(seconds);
  if (s % 86400 === 0) return `${s / 86400} day${s / 86400 === 1 ? "" : "s"}`;
  return `${Math.round(s / 3600)} hours`;
}

/** Backlog of epochs awaiting finalization, branched on firstEpochFinalized (§4). */
export function backlog(currentEpochId, lastFinalizedEpoch, firstEpochFinalized) {
  const cur = Number(currentEpochId);
  if (!firstEpochFinalized) return { count: cur, range: cur > 0 ? [0, cur - 1] : null };
  const last = Number(lastFinalizedEpoch);
  const count = Math.max(0, cur - last - 1);
  return { count, range: count > 0 ? [last + 1, cur - 1] : null };
}

/** Everything the page shows, derived from raw results `r` (key → hex) plus the snapshot block + timestamp. */
export function derive(r, snapshot) {
  const u = (k, i = 0) => word(r[k], i);
  const b = (k) => (u(k) === null ? null : u(k) !== 0n);
  const T = u("T");
  const partner = u("partnerSplit");
  const remEm = u("remainingEmission");
  const remMint = u("remainingMintable");
  const curEpoch = u("currentEpochId");
  const dur = u("epochDuration");
  const genesis = u("genesisTimestamp");
  const first = b("firstEpochFinalized");
  const bl = curEpoch === null ? null : backlog(curEpoch, u("lastFinalizedEpoch") ?? 0n, first);
  const epochStart = curEpoch !== null && dur !== null && genesis !== null ? genesis + curEpoch * dur : null;
  const epochEnd = epochStart !== null ? epochStart + dur : null;
  const pendUp = r.pendingUpgrade ? "0x" + r.pendingUpgrade.slice(-40) : null;
  const queued = [];
  for (const [k, label] of [["pendingAlphaBase", "base rate"], ["pendingE0", "epoch ceiling"], ["pendingPartnerSplit", "partner share"], ["pendingTierParams", "tier thresholds and multipliers"]]) {
    const readyAt = u(k, 1);
    if (readyAt !== null && readyAt !== 0n) queued.push({ group: label, value: u(k, 0), readyAt });
  }
  return {
    snapshot,
    totalSupply: fmtPsre(u("totalSupply")),
    released: fmtPsre(T),
    releasedIsZero: T === 0n,
    emissionsLine: T === 0n ? "Zero PSRE has been released so far." : `${fmtPsre(T)} PSRE released through Proof of Prosperity so far.`,
    maxSupply: fmtPsre(u("maxSupply")),
    reserveRemaining: fmtPsre(remEm),
    reserveMismatch: remEm !== null && remMint !== null && remEm !== remMint ? { remainingEmission: remEm.toString(), remainingMintable: remMint.toString() } : null,
    reserveSize: fmtPsre(u("sEmission")),
    treasury: fmtPsre(u("treasuryBalance")),
    founder: fmtPsre(u("founderBalance")),
    partnersLive: u("activeVaultCount")?.toString() ?? "—",
    vaultsAllTime: u("vaultCount")?.toString() ?? "—",
    poolBalance: fmtPsre(u("poolBalance"), 2),
    poolFee: u("poolFee") === null ? "—" : `${Number(u("poolFee")) / 10000}%`,
    partnerShare: fmtPct(partner),
    stakerShare: partner === null ? "—" : fmtPct(E18 - partner),
    psreSplit: fmtPct(u("psreSplit")),
    lpSplit: fmtPct(u("lpSplit")),
    staked: fmtPsre(u("totalPSREStaked")),
    scarcityCap: fmtPsre(u("currentScarcityCap")),
    epoch: curEpoch?.toString() ?? "—",
    epochDuration: fmtDuration(dur),
    epochDurationDays: dur === null ? null : Number(dur) / 86400,
    epochStart: epochStart === null ? "—" : fmtUtc(epochStart),
    epochEnd: epochEnd === null ? "—" : fmtUtc(epochEnd),
    nextBoundarySeconds: epochEnd === null ? null : Number(epochEnd - BigInt(snapshot.timestamp)),
    lastFinalized: first === false ? "none yet" : (u("lastFinalizedEpoch")?.toString() ?? "—"),
    backlog: bl,
    engineStatus: b("enginePaused") === null ? "—" : b("enginePaused") ? "paused" : "active",
    transfers: b("psrePaused") === null ? "—" : b("psrePaused") ? "paused" : "normal",
    upgrade: pendUp === null || /^0x0{40}$/.test(pendUp) ? "none" : `${pendUp} from ${fmtUtc(u("upgradeTimestamp") ?? 0n)}`,
    queued,
    paramTimelockHours: u("paramTimelock") === null ? null : Number(u("paramTimelock")) / 3600,
    upgradeTimelockDays: u("upgradeTimelock") === null ? null : Number(u("upgradeTimelock")) / 86400,
  };
}

/** Fixed copy under the protocol-status block (§4), with the live numbers; backlog sentence suppressed at 0. */
export function statusCopy(d) {
  const days = d.epochDurationDays === null ? "seven" : d.epochDurationDays === 7 ? "seven" : String(d.epochDurationDays);
  const parts = [`Epochs are ${days} days long and close on the clock.`, "Finalization, which computes and releases any reward for a closed epoch, is triggered by partner activity or by a keeper."];
  if (d.backlog && d.backlog.count > 0) {
    parts.push(`With no partner vaults yet, ${d.backlog.count} closed epochs are awaiting finalization.`);
    parts.push("Finalization is pending and must be completed before the first partner joins.");
  }
  parts.push(d.emissionsLine);
  return parts.join(" ");
}
