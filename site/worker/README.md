# prospereum.io RPC proxy (Cloudflare Worker)

Build baseline: Site Decision Sheet v2 (2026-10-25) row 2; Token page spec v6 §6; SDK spec v4 addresses.

- `src/index.js` — the Worker, no dependencies. Allowlist by **contract + selector** (Multicall3 `aggregate` / `aggregate3` / `tryAggregate` decoded, every inner target+selector checked, nesting refused); `eth_call` only with an explicit hex block number or `{blockHash}`; `eth_getBlockByNumber` concrete number + `false` only; batches rejected; cache key = method + params without `id`, caller's `id` preserved, 60 s TTL, upstream errors never cached; upstream identity in `X-Prospereum-Upstream` (exposed via CORS); CORS = site origin only; per-IP rate limit; upstream URL/key never in a response, error or log line.
- `test/worker.test.mjs` — Kin's three acceptance tests + the row-2 rules. Run with `node --test test/worker.test.mjs` (Node ≥ 20, nothing to install). 11/11 on 2026-10-26.
- `wrangler.toml` — route/vars template. `UPSTREAM_URL` is a Worker secret set by Jason (`wrangler secret put UPSTREAM_URL`).

Allowlisted getters (spec v6 §3/§4): PSRE `totalSupply MAX_SUPPLY balanceOf remainingMintable EMISSION_RESERVE`; RewardEngine `T remainingEmission S_EMISSION EPOCH_DURATION currentEpochId genesisTimestamp lastFinalizedEpoch firstEpochFinalized partnerSplit psreSplit lpSplit PARAM_TIMELOCK UPGRADE_TIMELOCK`; PartnerVaultFactory `activeVaultCount vaultCount`; pool `fee`. Adding a getter = one line in `ALLOWLIST` + a test. When the PSRE-native factory goes live its address is swapped in `CONTRACTS.FACTORY` with the ABI pin (spec v6 §6 item 6).

Delivery path: a branch + PR in `prospereum-website` once Fire has GitHub read access; until then this folder (patch-file fallback per sheet v2 row 1).
