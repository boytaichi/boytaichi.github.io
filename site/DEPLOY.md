# prospereum.io — deploy one-pager (release candidate rc1, 31 Oct 2026)

Baselines: Site Decision Sheet v2 (25 Oct) rows 1, 2, 6, 7; Token Page Spec v6 §6; SDK Spec v4. Nothing below needs a new host, account or spend. Deploy and DNS are Kin's and Jason's; Fire's part ends at the zip (or the branch + PR once `boytaichi` has read access to `wealthhealthai/prospereum-website`).

## 1. Static host (sheet row 1: GitHub Pages from `prospereum-website`, GitHub Actions, Cloudflare in front)

- Contents of `pages/` are the site root: `/` (index.html), `/token/`, `/partners/`, `/use/`, `/protocol/`, `/about/`, `shared/`, `site.css`. Plain HTML + ES modules — **no build step, no bundler, no web fonts, no third-party loads** (row 7). Copy the tree as-is; keep directory URLs with trailing slash (every internal link is `/x/`).
- Leave out of the published tree: `*/test/`, `scripts/`, `README.md` (harmless if served; nothing in them is secret).
- The existing team password gate stays as it is (footer link only, untouched).
- Cloudflare in front: cache HTML short (≤ 5 min) so a copy fix shows the same hour; `shared/*.mjs` and `site.css` can be cached longer — they are versioned by deploy, not by filename.
- Analytics: Cloudflare Web Analytics on the zone only (row 7). Nothing else is loaded; the pages set no cookies and write no storage.

## 2. RPC Worker (`worker/`, sheet row 2) — the only thing with a secret

- Cloudflare Worker `prospereum-rpc`, `wrangler.toml` as shipped. Route `prospereum.io/rpc` on the site zone (or a dedicated `rpc.prospereum.io` — pick one; the pages try `/rpc` first and fall back to the public endpoints in Token Page Spec v6 §6 order).
- **Secret, server-side only:** `wrangler secret put UPSTREAM_URL` — the keyed Base-mainnet RPC URL (Alchemy free tier or equivalent). It never appears in `wrangler.toml`, the pages, the repository or a log. The page shows only `UPSTREAM_NAME`.
- Vars (in `wrangler.toml`): `SITE_ORIGIN=https://prospereum.io` (CORS allow-origin; change if the site is previewed on another origin), `UPSTREAM_NAME` (display string), `CACHE_TTL_SECONDS=60`. Rate limit binding: 60 requests / 10 s per IP.
- Verify before pointing the pages at it: `node --test test/worker.test.mjs` (11 tests, no install), then one live `eth_call` of `totalSupply()` through the route and one disallowed selector → 403.

## 3. DNS (unchanged)

- `prospereum.io` and `www` already resolve through Cloudflare to GitHub Pages; no record changes for the pages. The Worker is a route on the same zone (no DNS) unless `rpc.prospereum.io` is chosen — then one proxied `AAAA 100::` / Worker custom domain for it.
- `partnerships@` is **not** published anywhere on the site until its MX exists (row 6); the pages point to Partners & Developers instead.

## 4. After deploy — verify (ten minutes)

Steps 1, 5 and the Worker route run as one command from `pages/`: `node scripts/verify-deploy.mjs https://prospereum.io --rpc https://<worker-host>/rpc` (read-only; exits 1 on the first failing group). Steps 2–4 and 6 stay manual / local.

1. Six URLs answer 200 with the shared nav/footer: `/`, `/token/`, `/partners/`, `/use/`, `/protocol/`, `/about/`. (Locally: `node --test test/site.test.mjs` from `pages/` does the same against a static serve.)
2. Token page: every figure fills within ~5 s from one block; the block number and "refreshed every minute" line show; pull the network cable or block `/rpc` → the page shows "Stale — last successful snapshot", never a typed number.
3. Overview live strip (total supply / emitted / cap / block) and the Protocol and Use live blocks fill from the same block as the Token page.
4. Browser dev-tools → Application: no cookies, no localStorage/sessionStorage writes; Network: only same-origin requests, `/rpc` (or the public fallbacks) and Cloudflare Web Analytics.
5. Footer sentence verbatim on every page (row 6): "PSRE is a utility token used within the Prospereum protocol. This site is for informational purposes only and does not constitute financial or investment advice. Published by WealthHealth AI, Inc."
6. Copy: `node scripts/copy-drift.mjs` from `pages/` passes on the deployed tree (69 sentences of Site Copy v1 verbatim; three listed deviations).

## 5. What is deliberately not live yet

- Treasury Safe **address** on the Token page (balance only) — Jason's decision (Site Copy decision 3).
- Partner list reads "No partner vault is live yet" until the first PartnerVault exists — a chain fact, not a placeholder.
- The PSRE-native migration (Kin's batch; 7-day timelocks; Shu + Jason sign) changes contract addresses in `token/config.js` / `partners/config.js` only after it executes — a one-line config change per address, then the same verification.
