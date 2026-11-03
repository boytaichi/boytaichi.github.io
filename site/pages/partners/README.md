# partners/ — Partners & Developers page (SDK spec v4 §1–§3, sheet v2 layout)

Static, read-only. Same `site.css`, same endpoints and addresses as `../token/` (re-exported from `token/config.js`).

- `index.html` — §1 "Where you can use it" copy (live partner list), §2 "Two vaults, one number", contracts table (rendered from `config.js` CONTRACTS with the per-contract BaseScan wording), documents, the nine-step SDK flow, reads, error cases, code samples (JSON-RPC via the Worker proxy; viem for register / batch buy + credit / first credit / claim + withdraw / reward), rules, test environment. Placeholders from the spec kept verbatim: `[contact address pending mailbox]`, `[link pending public PDF export]`, the entry-minimum bracket pending the architecture decision.
- `config.js` — factory + vault selectors (keccak via js-sha3 0.9.3; `activeVaultCount`/`vaultCount` cross-check token/config.js). Provisional until the pinned ABI package.
- `partners-logic.mjs` — pure: `livePartnerList` (§1 build rule: `getAllVaults()` filtered by `vaultActive`), `batchConversion` (step-3 integer formula + residue), `mayClaim` (claimVault authorization), `tierOf` (R/sumR vs thresholds), `finalizationsOnNextCall` (backlog × AUTO_FINALIZE_MAX_EPOCHS), decoders incl. `address[]`, `partnersHeadline`.
- `partners.js` — browser glue: chainId check, one `eth_blockNumber` per refresh, headline = `activeVaultCount()`, list enumerated only when `vaultCount() > 0`, per-vault `ecosystemBalance` + `getCustomerVaultCount`, 60 s refresh + focus, "Stale — …" on failure. No writes, no cookies, no storage.
- Tests: `node --test partners/test/partners-logic.test.mjs` from `site/pages/` (7 tests).
