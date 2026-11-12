// prospereum.io — Token page config (spec v6 §3/§6, sheet v2 rows 2/4/5/6).
// The ONLY constants typed into the page: endpoints, contract addresses, selectors. Every number is read.
// Addresses are those in the protocol's deployments.md (wealthhealthai/prospereum-protocol); return types per getter
// live in shared/call-manifest.mjs RETURN_TYPES.
export const CHAIN_ID_HEX = "0x2105"; // Base mainnet 8453

/** Production primary = the Cloudflare Worker proxy (sheet v2 row 2); public endpoints are fallbacks, in this order. */
export const ENDPOINTS = [
  { name: "prospereum rpc proxy", url: "/rpc", proxy: true },
  { name: "mainnet.base.org", url: "https://mainnet.base.org", proxy: false },
  { name: "base-rpc.publicnode.com", url: "https://base-rpc.publicnode.com", proxy: false },
];

export const ADDR = {
  PSRE: "0x2fE08f304f1Af799Bc29E3D4E210973291d96702",
  REWARD_ENGINE: "0x9Ab37Fc6D01B85491Ed0863B7F832784bE717EF5",
  REWARD_ENGINE_IMPL: "0xE194EF5ABB93cb62089FB5a3b407B9B7f38F04f5",
  FACTORY: "0xFF84408633f79b8f562314cC5A3bCaedA8f76902",
  STAKING_VAULT: "0x684BEA07e979CB5925d546b2E2099aA1c632ED2D",
  POOL: "0x0adc6be14e76b89584216fad4e458df5f996d336",
  FOUNDER_SAFE: "0xc59816CAC94A969E50EdFf7CF49ce727aec1489F",
  // Treasury Safe: balance rendered live, address never linked on the public page (sheet v2 row 4; spec v6 §8 item 1).
  TREASURY_SAFE: "0xa9Fde837EBC15BEE101d0D895c41a296Ac2CAfCe",
  MULTICALL3: "0xcA11bde05977b3631167028862bE2a173976CA11",
};

/** Getter → (contract, selector). Selectors are keccak-256 first four bytes, as listed in spec v6 §3–5. */
export const GETTERS = {
  totalSupply: ["PSRE", "0x18160ddd"],
  maxSupply: ["PSRE", "0x32cb6b0c"],
  emissionReserve: ["PSRE", "0x01ee7232"],
  remainingMintable: ["PSRE", "0xf76e95e5"],
  psrePaused: ["PSRE", "0x5c975abb"],
  treasuryBalance: ["PSRE", "0x70a08231", "TREASURY_SAFE"],
  founderBalance: ["PSRE", "0x70a08231", "FOUNDER_SAFE"],
  poolBalance: ["PSRE", "0x70a08231", "POOL"],
  poolFee: ["POOL", "0xddca3f43"],
  T: ["REWARD_ENGINE", "0x2bc80f3a"],
  remainingEmission: ["REWARD_ENGINE", "0xb547df86"],
  sEmission: ["REWARD_ENGINE", "0xdebb48da"],
  partnerSplit: ["REWARD_ENGINE", "0xcf2369b5"],
  currentScarcityCap: ["REWARD_ENGINE", "0x1f6d3480"],
  currentEpochId: ["REWARD_ENGINE", "0xeacdc5ff"],
  epochDuration: ["REWARD_ENGINE", "0xa70b9f0c"],
  genesisTimestamp: ["REWARD_ENGINE", "0xcacf66ab"],
  lastFinalizedEpoch: ["REWARD_ENGINE", "0xc5a3f907"],
  firstEpochFinalized: ["REWARD_ENGINE", "0xe1005d67"],
  enginePaused: ["REWARD_ENGINE", "0x5c975abb"],
  pendingUpgrade: ["REWARD_ENGINE", "0x95e93245"],
  upgradeTimestamp: ["REWARD_ENGINE", "0x921bd6f0"],
  pendingAlphaBase: ["REWARD_ENGINE", "0x94ea60ba"],
  pendingE0: ["REWARD_ENGINE", "0x80327e37"],
  pendingPartnerSplit: ["REWARD_ENGINE", "0xc472d77a"],
  pendingTierParams: ["REWARD_ENGINE", "0x0db7e096"],
  paramTimelock: ["REWARD_ENGINE", "0x1de19349"],
  upgradeTimelock: ["REWARD_ENGINE", "0x25ed32ca"],
  activeVaultCount: ["FACTORY", "0xda5ef232"],
  vaultCount: ["FACTORY", "0xa7c6a100"],
  psreSplit: ["STAKING_VAULT", "0x156ea9c4"],
  lpSplit: ["STAKING_VAULT", "0x6e0a0c8a"],
  totalPSREStaked: ["STAKING_VAULT", "0x205d1034"],
};

export const BASESCAN = "https://basescan.org/address/";
export const REFRESH_MS = 60_000;
