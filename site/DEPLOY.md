# prospereum.io — deploy one-pager (release candidate rc1, 31 Oct 2026; revised 12 Nov 2026 after Kin's PR #1 review)

Baselines: Site Decision Sheet v2 (25 Oct) rows 1, 2, 6, 7; Token Page Spec v6 §6; SDK Spec v4. Nothing below needs a new host, account or spend. Deploy and DNS are Kin's and Jason's; Fire's part ends at the zip (or the branch + PR once `boytaichi` has read access to `wealthhealthai/prospereum-website`).

## 1. Static host (sheet row 1: GitHub Pages from `prospereum-website`, GitHub Actions, Cloudflare in front)

- Contents of `pages/` are the site root: `/` (index.html), `/token/`, `/partners/`, `/use/`, `/protocol/`, `/about/`, `shared/`, `site.css`. Plain HTML + ES modules — **no build step, no bundler, no web fonts, no third-party loads** (row 7). Copy the tree as-is; keep directory URLs with trailing slash (every internal link is `/x/`).
- Leave out of the published tree: `*/test/`, `scripts/`, `README.md` (harmless if served; nothing in them is secret).
- The existing team password gate stays as it is (footer link only, untouched).
- Cloudflare in front: cache HTML short (≤ 5 min) so a copy fix shows the same hour; `shared/*.mjs` and `site.css` can be cached longer — they are versioned by deploy, not by filename.
- Analytics: Cloudflare Web Analytics on the zone only (row 7). Nothing else is loaded; the pages set no cookies and write no storage.

## 2. RPC Worker (`worker/`, sheet row 2) — the only thing with a secret

- Cloudflare Worker `prospereum-rpc`, `wrangler.toml` as shipped. Routes `prospereum.io/rpc` **and** `prospereum.io/rpc/*` on the site zone (the second serves the health probe), or a dedicated `rpc.prospereum.io` — pick one; the pages try `/rpc` first and fall through to the public endpoints in Token Page Spec v6 §6 order. Fallback covers the **whole** pinned-block snapshot: a rejected, rate-limited, malformed or timed-out read anywhere in a refresh moves the page to the next endpoint (Kin PR #1 finding 3).
- **Allowlist = the pages' own call manifest** (`pages/shared/call-manifest.mjs`, derived from `token/config.js` and `partners/config.js`; the Worker imports it, wrangler bundles it). Adding a getter to a page config admits it in the Worker in the same commit. Dynamic PartnerVault targets are admitted for the four per-vault selectors only after the Worker reads `factory.vaultActive(vault)` upstream at the same pinned block (verdicts cached 60 s, bounded). `worker/test/manifest.integration.test.mjs` replays every page call through the Worker (Kin finding 2).
- **Secret, server-side only:** `wrangler secret put UPSTREAM_URL` — the keyed Base-mainnet RPC URL (Alchemy free tier or equivalent). It never appears in `wrangler.toml`, the pages, the repository, a log or an error: upstream failures answer fixed public messages (`upstream unavailable` / `upstream returned an invalid response`), upstream JSON-RPC errors are reduced to `execution reverted` / `upstream rpc error`, and only validated results are cached (Kin finding 7). The page shows only `UPSTREAM_NAME`.
- Vars (in `wrangler.toml`): `SITE_ORIGIN=https://prospereum.io` (exact origin, CORS allow-origin; change if the site is previewed on another origin), `UPSTREAM_NAME` (display string), `CACHE_TTL_SECONDS=60` (1–3600). Rate-limit binding `RATE_LIMITER`: 60 requests / 10 s per IP — **mandatory**; without it (or with any of the four bindings missing/malformed) every request answers `503 {"error":"service misconfigured"}` (Kin finding 6). `DEV_ALLOW_NO_RATE_LIMIT="true"` is for local `wrangler dev` only.
- Limits (Kin finding 4): request body ≤ 64 KiB; direct calldata ≤ 260 bytes; Multicall3 calldata ≤ 32 KiB with ≤ 64 inner calls of ≤ 260 bytes each; EIP-1898 `requireCanonical` rejected (finding 8); in-isolate cache bounded to 1,024 entries (LRU), keyed by a SHA-256 of the normalised params.
- Verify before pointing the pages at it: `node --test test/*.test.mjs` from `worker/` (27 tests, no install), then `GET https://<worker-host>/rpc/health` → `200 {"ok":true,…}` (checks the bindings and runs one allowed + one rejected call shape without touching the upstream), one live `eth_call` of `totalSupply()` through the route → 200, and one disallowed selector → **HTTP 400 with JSON-RPC error -32602** (finding 11: the allowlist rejection is 400, not 403; 403 is reserved for a foreign `Origin`).

## 3. DNS (unchanged)

- `prospereum.io` and `www` already resolve through Cloudflare to GitHub Pages; no record changes for the pages. The Worker is a route on the same zone (no DNS) unless `rpc.prospereum.io` is chosen — then one proxied `AAAA 100::` / Worker custom domain for it.
- `partnerships@` is **not** published anywhere on the site until its MX exists (row 6); the pages point to Partners & Developers instead.

## 4. After deploy — verify (ten minutes)

Steps 1, 5 and the Worker route run as one command from `pages/`: `node scripts/verify-deploy.mjs https://prospereum.io --rpc https://<worker-host>/rpc` (read-only; exits 1 on the first failing group; includes `GET …/rpc/health`). Steps 2–4 and 6 stay manual / local. Pre-merge, `.github/workflows/pr-checks.yml` runs the chrome check, copy drift, every page test (incl. the headless-Chrome site test with the 390 px nav hit-test) and the Worker suite on every pull request; `deploy.yml` runs the same gate before publishing `main`.

1. Six URLs answer 200 with the shared nav/footer: `/`, `/token/`, `/partners/`, `/use/`, `/protocol/`, `/about/`. (Locally: `node --test test/site.test.mjs` from `pages/` does the same against a static serve.)
2. Token page: every figure fills within ~5 s from one block; the block number and "refreshed every minute" line show; pull the network cable or block `/rpc` → the page shows "Stale — last successful snapshot", never a typed number.
3. Overview live strip (total supply / emitted / cap / block) and the Protocol and Use live blocks fill from the same block as the Token page.
4. Browser dev-tools → Application: no cookies, no localStorage/sessionStorage writes; Network: only same-origin requests, `/rpc` (or the public fallbacks) and Cloudflare Web Analytics.
5. Footer sentence verbatim on every page (row 6): "PSRE is a utility token used within the Prospereum protocol. This site is for informational purposes only and does not constitute financial or investment advice. Published by WealthHealth AI, Inc."
6. Copy: `node scripts/copy-drift.mjs` from `pages/` passes on the deployed tree (69 sentences of Site Copy v1 verbatim; three listed deviations).

## 5. What is deliberately not live yet

- Treasury Safe **address** on the Token page (balance only) — Jason's decision (Site Copy decision 3).
- Partner list on `/use/` is rendered from the pinned snapshot's `activeVaultCount` ("—" until a snapshot exists; the empty state at 0; the count otherwise) — a chain read, never typed (Kin finding 9).
- Partners page: entry-deposit terms, the contact address and the Whitepaper / Partner Guide PDFs are not published yet; the page says so in neutral wording ("published when the first partner vault goes live", "Contact: coming soon") with no bracketed placeholders.
- The PSRE-native migration (Kin's batch; 7-day timelocks; Shu + Jason sign) changes contract addresses in `token/config.js` / `partners/config.js` only after it executes — a one-line config change per address, then the same verification.
