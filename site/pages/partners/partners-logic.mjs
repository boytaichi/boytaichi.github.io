// prospereum.io — Partners & Developers page, pure logic (SDK spec v4 §1 build rule, §3.2–3.4).
// No IO. Everything here is unit-tested in test/partners-logic.test.mjs. Amounts are BigInt in base units
// (PSRE 18 decimals, USDC 6 decimals).

export const PSRE_DECIMALS = 18n;
export const USDC_DECIMALS = 6n;

/** §1 build rule: the live partner list = getAllVaults() filtered by factory.vaultActive(vault) === true. */
export function livePartnerList(allVaults, activeFlags) {
  if (allVaults.length !== activeFlags.length) throw new Error("vaults/flags length mismatch");
  return allVaults.filter((_, i) => activeFlags[i] === true);
}

/** §3.4 step 3: creditPSRE = owedUSDC × psreOut ÷ usdcAmountIn, integer arithmetic; the batch residue stays in the PartnerVault. */
export function batchConversion({ usdcAmountIn, psreOut, credits }) {
  if (typeof usdcAmountIn !== "bigint" || typeof psreOut !== "bigint") throw new TypeError("BigInt required");
  if (usdcAmountIn <= 0n || psreOut <= 0n) throw new RangeError("batch amounts must be positive");
  let total = 0n;
  const out = credits.map((c) => {
    if (typeof c.owedUsdc !== "bigint" || c.owedUsdc < 0n) throw new RangeError("owedUsdc must be a non-negative BigInt");
    const creditPsre = (c.owedUsdc * psreOut) / usdcAmountIn; // floor
    total += creditPsre;
    return { ...c, creditPsre };
  });
  const owedTotal = credits.reduce((s, c) => s + c.owedUsdc, 0n);
  if (owedTotal > usdcAmountIn) throw new RangeError("credits owe more USDC than the batch bought");
  const residue = psreOut - total; // ≥ 0 by construction; kept in the vault, never invented
  return { credits: out, totalCredited: total, residue };
}

/** §3.2 claimVault authorization. intendedCustomer = zero address → only the PartnerVault owner may claim. */
export const ZERO = "0x0000000000000000000000000000000000000000";
const eq = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
export function mayClaim({ intendedCustomer, caller, vaultOwner, alreadyClaimed = false }) {
  if (alreadyClaimed) return { ok: false, reason: "already claimed" };
  if (eq(caller, vaultOwner)) return { ok: true, by: "owner" };
  if (!eq(intendedCustomer, ZERO) && eq(caller, intendedCustomer)) return { ok: true, by: "intended customer" };
  return { ok: false, reason: eq(intendedCustomer, ZERO) ? "platform-managed vault: only the PartnerVault owner may claim" : "caller is neither the intended customer nor the owner" };
}

/** §3.3: tier derived off-chain as R/sumR against silverThreshold (0.5%) and goldThreshold (2.0%), all 1e18-scaled. */
export function tierOf({ R, sumR, silverThreshold, goldThreshold }) {
  if (sumR === 0n) return { share: 0n, tier: "bronze" };
  const share = (R * 10n ** 18n) / sumR; // 1e18 = 100 %
  if (share >= goldThreshold) return { share, tier: "gold" };
  if (share >= silverThreshold) return { share, tier: "silver" };
  return { share, tier: "bronze" };
}

/** §3.5 error-case helper: how many finalizations the next createVault()/buy() pays for (AUTO_FINALIZE_MAX_EPOCHS = 10). */
export function finalizationsOnNextCall({ currentEpochId, lastFinalizedEpoch, max = 10n }) {
  const closedUnfinalized = currentEpochId - 1n - lastFinalizedEpoch; // epochs lastFinalized+1 … current−1 are closed
  if (closedUnfinalized <= 0n) return 0n;
  return closedUnfinalized < max ? closedUnfinalized : max;
}

/** Formats a 1e18-scaled share as a percentage string with 2 decimals (display only). */
export function pct18(x) {
  const bp = (x * 10000n) / 10n ** 18n; // basis points
  const whole = bp / 100n;
  const frac = bp % 100n;
  return `${whole}.${frac.toString().padStart(2, "0")}%`;
}

/** Decodes a uint256 / bool / address eth_call result. */
export function decodeUint(hex) {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]*$/.test(hex) || hex.length < 66) return null;
  return BigInt(hex.slice(0, 66));
}
export function decodeBool(hex) {
  const v = decodeUint(hex);
  return v === null ? null : v === 1n;
}
/** address[] ABI decoding: offset word, length word, then one word per address. */
export function decodeAddressArray(hex) {
  if (typeof hex !== "string" || !hex.startsWith("0x") || (hex.length - 2) % 64 !== 0 || hex.length < 130) return null;
  const words = [];
  for (let i = 2; i < hex.length; i += 64) words.push(hex.slice(i, i + 64));
  const offset = Number(BigInt("0x" + words[0])) / 32;
  const len = Number(BigInt("0x" + words[offset]));
  const out = [];
  for (let i = 0; i < len; i++) {
    const w = words[offset + 1 + i];
    if (!w) return null;
    out.push("0x" + w.slice(24));
  }
  return out;
}

/** §1 copy rule for the headline: live count from activeVaultCount(), never vaultCount(). */
export function partnersHeadline(activeVaultCount) {
  if (activeVaultCount === null || activeVaultCount === undefined) return "Partners, announced as they launch.";
  if (activeVaultCount === 0n) return "Partners, announced as they launch. None live yet.";
  return `${activeVaultCount} partner${activeVaultCount === 1n ? "" : "s"} live on Base.`;
}
