// prospereum.io — Partners & Developers page config (SDK spec v4 §1 build rule, §2 contracts table).
// Reuses the Token page's endpoints and addresses so there is one source of truth for both (token/config.js).
// Selectors below = keccak-256 first four bytes of the signature, computed with js-sha3 0.9.3 on 2026-10-28 from the
// protocol source (wealthhealthai/prospereum-protocol); activeVaultCount()/vaultCount() cross-check against
// token/config.js (0xda5ef232 / 0xa7c6a100). Return types per getter live in shared/call-manifest.mjs RETURN_TYPES.
export { ADDR, BASESCAN, CHAIN_ID_HEX, ENDPOINTS, REFRESH_MS } from "../token/config.js";

export const FACTORY_GETTERS = {
  activeVaultCount: "0xda5ef232", // activeVaultCount() → uint256 — the headline count (§1)
  vaultCount: "0xa7c6a100", // vaultCount() → uint256 — all-time, incl. decommissioned; never the live list
  getAllVaults: "0x97331bf9", // getAllVaults() → address[]
  vaultActive: "0x6f8d34f0", // vaultActive(address) → bool — decommission flag (factory), not the engine's reward-activity flag
  maxPartners: "0x4821577a", // maxPartners() → uint256
};

/** Per-vault reads for a live partner row (PartnerVault). */
export const VAULT_GETTERS = {
  owner: "0x8da5cb5b",
  ecosystemBalance: "0x2c71f81a",
  cumS: "0xb2cfd893",
  getCustomerVaultCount: "0x1e08f98c",
};

/** §2 contracts table (chain ID 8453). "Source on BaseScan" wording per the 2026-10-21 check; re-read BaseScan before changing any row. */
export const CONTRACTS = [
  { name: "PSRE token (ERC-20)", key: "PSRE", source: "Not yet verified (Oct 2026)" },
  { name: "PartnerVaultFactory", key: "FACTORY", source: "Not yet verified (Oct 2026)" },
  { name: "StakingVault", key: "STAKING_VAULT", source: "See BaseScan" },
  { name: "RewardEngine (UUPS proxy)", key: "REWARD_ENGINE", source: "Verified (proxy)" },
  { name: "PSRE/USDC pool (Uniswap v3, 1%)", key: "POOL", source: "Uniswap contract" },
];
