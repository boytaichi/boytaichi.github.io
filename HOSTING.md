# Hosting (boytaichi/prospereum-site)

Mirror of `wealthhealthai/prospereum-website` pull request #1 (branch `site/rc1`, head `fa9cec7`), published by
GitHub Pages from `.github/workflows/deploy.yml` (test gate → `site/pages` tree without tests/scripts → Pages artifact).
On top of that head: the no-decision fixes from the site QA of 2026-11-25 (`documents/axia/prospereum/redeploy/Site_QA_Report_2026-11-25.md`
in Fire's workspace) — Token page duplicate spans, Partners audit wording, Protocol entry-minimum sentence, metadata, favicon, 404,
robots/sitemap, contracts-table layout, one H1 per page, US spelling. Not yet on `site/rc1` upstream.

- Custom domain: `prospereum.io` (`public/CNAME`, copied into the artifact; set in the repo's Pages settings).
- Root-path preview before the DNS cutover: https://boytaichi.github.io/ (staging mirror `boytaichi/boytaichi.github.io`, no CNAME).
- The Cloudflare Worker in `site/worker/` is not deployed here; the pages fall through to the public Base endpoints
  listed in `site/pages/token/config.js` (see `site/DEPLOY.md` §2). The Vite scaffold at the repo root (`src/`,
  `index.html`, `package.json`, `KIN-HANDOFF.md`) is inherited from the upstream repository and is not what Pages serves.
