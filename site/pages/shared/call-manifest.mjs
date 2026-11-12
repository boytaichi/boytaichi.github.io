// prospereum.io — the ONE capability manifest shared by the pages and the RPC Worker (Kin PR #1 finding 2).
//
// The pages' typed constants (token/config.js GETTERS, partners/config.js FACTORY_GETTERS / VAULT_GETTERS) are the
// source of truth; this module derives from them (a) every static (contract, selector) pair the pages call and
// (b) the selectors the pages call on dynamic PartnerVault targets. The Worker imports this module for its
// allowlist, so a getter added to a page config is admitted by the Worker in the same commit — they cannot drift.
// Pure constants + pure functions: no DOM, no network, no Node APIs (served to browsers and bundled into the Worker).
import { ADDR, CHAIN_ID_HEX, GETTERS } from "../token/config.js";
import { FACTORY_GETTERS, VAULT_GETTERS } from "../partners/config.js";

export { CHAIN_ID_HEX };

const lower = (a) => a.toLowerCase();

/** Lower-cased addresses of every contract the pages read (the Worker compares lower-cased). */
export const CONTRACTS = {
  PSRE: lower(ADDR.PSRE),
  REWARD_ENGINE: lower(ADDR.REWARD_ENGINE),
  FACTORY: lower(ADDR.FACTORY),
  STAKING_VAULT: lower(ADDR.STAKING_VAULT),
  POOL: lower(ADDR.POOL),
  MULTICALL3: lower(ADDR.MULTICALL3),
};

/**
 * Static allowlist: lower-cased contract address → Set of 4-byte selectors (lower-cased), derived from the page
 * getters. Every entry traces to a page config line; nothing is typed here.
 */
export const STATIC_ALLOWLIST = (() => {
  const out = {};
  const add = (addr, sel) => {
    const a = lower(addr);
    const s = lower(sel);
    (out[a] ??= new Set()).add(s);
  };
  for (const [contract, selector] of Object.values(GETTERS)) add(ADDR[contract], selector);
  for (const selector of Object.values(FACTORY_GETTERS)) add(ADDR.FACTORY, selector);
  return out;
})();

/** Selectors the Partners page calls on a PartnerVault returned by the factory (dynamic targets). */
export const VAULT_SELECTORS = new Set(Object.values(VAULT_GETTERS).map(lower));

/** How the Worker verifies that a dynamic target is a factory-registered, active PartnerVault (same pinned block). */
export const FACTORY_REGISTRY = {
  address: CONTRACTS.FACTORY,
  vaultActive: lower(FACTORY_GETTERS.vaultActive), // vaultActive(address) → bool
  getAllVaults: lower(FACTORY_GETTERS.getAllVaults), // getAllVaults() → address[]
};

/** 32-byte ABI word for an address argument. */
export const addrWord = (a) => a.slice(2).toLowerCase().padStart(64, "0");

/** Classify one (target, selector): "static" (allowed as-is), "vault" (allowed once the target is factory-registered) or null. */
export function classifyCall(target, selector) {
  const t = lower(target);
  const s = lower(selector);
  const allowed = STATIC_ALLOWLIST[t];
  if (allowed) return allowed.has(s) ? "static" : null;
  if (t === CONTRACTS.MULTICALL3) return null;
  return VAULT_SELECTORS.has(s) ? "vault" : null;
}

/** Flat list of every static (target, selector) pair, for tests and docs. */
export function staticPairs() {
  const out = [];
  for (const [target, sels] of Object.entries(STATIC_ALLOWLIST)) for (const selector of sels) out.push({ target, selector });
  return out;
}
