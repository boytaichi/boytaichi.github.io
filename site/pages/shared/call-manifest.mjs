// prospereum.io — the ONE capability manifest shared by the pages and the RPC Worker (Kin PR #1 finding 2; round 2 finding 5).
//
// The pages' typed constants (token/config.js GETTERS, partners/config.js FACTORY_GETTERS / VAULT_GETTERS) are the
// source of truth; this module derives from them (a) every static (contract, selector) pair the pages call and
// (b) the selectors the pages call on dynamic PartnerVault targets, each annotated with its ARGUMENT WORD COUNT so
// the Worker admits calldata of exactly 4 + 32·n bytes and nothing longer (Kin round 2 finding 5). The Worker imports
// this module for its allowlist, so a getter added to a page config is admitted by the Worker in the same commit.
// Pure constants + pure functions: no DOM, no network, no Node APIs (served to browsers and bundled into the Worker).
import { ADDR, CHAIN_ID_HEX, GETTERS } from "../token/config.js";
import { FACTORY_GETTERS, VAULT_GETTERS } from "../partners/config.js";

export { CHAIN_ID_HEX };

const lower = (a) => a.toLowerCase();

/**
 * Argument word counts (Kin round 2 finding 5). A page getter's calldata is the 4-byte selector plus exactly one
 * 32-byte word per argument. Token-page GETTERS carry their single address argument as the third tuple element
 * (balanceOf(address)); the factory and per-vault getters are annotated here by name. Anything not listed takes 0.
 */
const FACTORY_ARG_WORDS = Object.freeze({ vaultActive: 1 }); // vaultActive(address) → bool
const VAULT_ARG_WORDS = Object.freeze({}); // owner(), ecosystemBalance(), cumS(), getCustomerVaultCount(): no arguments

/** Lower-cased addresses of every contract the pages read (the Worker compares lower-cased). */
export const CONTRACTS = {
  PSRE: lower(ADDR.PSRE),
  REWARD_ENGINE: lower(ADDR.REWARD_ENGINE),
  FACTORY: lower(ADDR.FACTORY),
  STAKING_VAULT: lower(ADDR.STAKING_VAULT),
  POOL: lower(ADDR.POOL),
  MULTICALL3: lower(ADDR.MULTICALL3),
};

/** Lower-cased contract address → selector → argument word count. Built alongside STATIC_ALLOWLIST from the same lines. */
export const STATIC_ARG_WORDS = {};

/**
 * Static allowlist: lower-cased contract address → Set of 4-byte selectors (lower-cased), derived from the page
 * getters. Every entry traces to a page config line; nothing is typed here.
 */
export const STATIC_ALLOWLIST = (() => {
  const out = {};
  const add = (addr, sel, argWords) => {
    const a = lower(addr);
    const s = lower(sel);
    (out[a] ??= new Set()).add(s);
    const words = STATIC_ARG_WORDS[a] ??= {};
    if (words[s] !== undefined && words[s] !== argWords) throw new Error(`call manifest: ${a} ${s} declared with ${words[s]} and ${argWords} argument words`);
    words[s] = argWords;
  };
  for (const [contract, selector, argAddr] of Object.values(GETTERS)) add(ADDR[contract], selector, argAddr ? 1 : 0);
  for (const [name, selector] of Object.entries(FACTORY_GETTERS)) add(ADDR.FACTORY, selector, FACTORY_ARG_WORDS[name] ?? 0);
  return out;
})();

/** Selectors the Partners page calls on a PartnerVault returned by the factory (dynamic targets). */
export const VAULT_SELECTORS = new Set(Object.values(VAULT_GETTERS).map(lower));
/** Selector → argument word count for the per-vault getters. */
export const VAULT_SELECTOR_ARG_WORDS = Object.fromEntries(Object.entries(VAULT_GETTERS).map(([name, sel]) => [lower(sel), VAULT_ARG_WORDS[name] ?? 0]));

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

/** Argument word count of an admitted (target, selector), or null when the pair is not in the manifest. */
export function argWordsFor(target, selector) {
  const cls = classifyCall(target, selector);
  if (cls === "static") return STATIC_ARG_WORDS[lower(target)][lower(selector)];
  if (cls === "vault") return VAULT_SELECTOR_ARG_WORDS[lower(selector)];
  return null;
}

/** Exact calldata length in bytes the Worker admits for (target, selector): 4 + 32·n, or null when not admitted (Kin round 2 finding 5). */
export function calldataBytesFor(target, selector) {
  const n = argWordsFor(target, selector);
  return n === null ? null : 4 + 32 * n;
}

/** Flat list of every static (target, selector) pair, for tests and docs. */
export function staticPairs() {
  const out = [];
  for (const [target, sels] of Object.entries(STATIC_ALLOWLIST)) for (const selector of sels) out.push({ target, selector, argWords: STATIC_ARG_WORDS[target][selector] });
  return out;
}
