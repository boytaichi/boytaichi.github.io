// Site integration checks (run from pages/: `node --test test/site.test.mjs`).
//  1. every page carries the shared nav + footer exactly (shared/chrome.mjs);
//  2. every internal link / script / stylesheet on every page resolves to a file in this tree;
//  3. every page serves 200 from a static server and loads in headless Chrome with no console error
//     (network calls to RPC endpoints are expected to fail offline → the pages must degrade to "—", not throw).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileP = promisify(execFile);
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { FOOTER_SENTENCE, NAV, PAGES, STANDALONE, navHtml } from "../shared/chrome.mjs";
import { returnTypesFor } from "../shared/call-manifest.mjs";
import { pageText } from "../scripts/copy-drift.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pageFiles = Object.entries(PAGES).map(([dir, href]) => ({ dir, href, file: path.join(root, dir, "index.html") }));
/** Pages with the shared chrome that are not nav entries (the branded 404). */
const standaloneFiles = STANDALONE.map((f) => ({ href: null, file: path.join(root, f) }));
const SITE_ORIGIN = "https://prospereum.io";

test("every page has the shared nav (with aria-current on itself) and the verbatim footer sentence", () => {
  for (const { href, file } of [...pageFiles, ...standaloneFiles]) {
    const html = readFileSync(file, "utf8");
    assert.ok(html.includes(navHtml(href)), `${path.relative(root, file)} nav`);
    assert.ok(html.includes(`<footer>\n<p>${FOOTER_SENTENCE}</p>\n</footer>`), `${path.relative(root, file)} footer`);
    assert.ok(html.includes('<link rel="stylesheet" href="') && html.includes("site.css"), `${path.relative(root, file)} site.css`);
  }
  assert.equal(NAV.length, 6);
});

test("one <h1> per page, each page's own (site QA 2026-11-25 C2: Partners carried two, and /use/ shared its H1 with /partners/)", () => {
  const h1s = new Map();
  for (const { href, file } of [...pageFiles, ...standaloneFiles]) {
    const html = readFileSync(file, "utf8");
    const found = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim());
    assert.equal(found.length, 1, `${path.relative(root, file)}: ${found.length} <h1>`);
    assert.ok(!h1s.has(found[0]), `${path.relative(root, file)} repeats the H1 of ${h1s.get(found[0])}: "${found[0]}"`);
    h1s.set(found[0], href ?? path.relative(root, file));
  }
  assert.equal(h1s.get("Where you can use it"), "/use/");
  assert.equal(h1s.get("Partners & Developers"), "/partners/");
});

test("every page carries canonical, Open Graph and favicon metadata that agree with its title, description and route (site QA 2026-11-25 §6)", () => {
  for (const { href, file } of pageFiles) {
    const html = readFileSync(file, "utf8");
    const rel = path.relative(root, file);
    const title = html.match(/<title>(.*?)<\/title>/)[1];
    const desc = html.match(/<meta name="description" content="(.*?)">/)[1];
    const meta = (prop) => (html.match(new RegExp(`<meta property="${prop}" content="(.*?)">`)) || [])[1];
    assert.equal((html.match(/<link rel="canonical" href="(.*?)">/) || [])[1], SITE_ORIGIN + href, `${rel} canonical`);
    assert.equal(meta("og:url"), SITE_ORIGIN + href, `${rel} og:url`);
    assert.equal(meta("og:title"), title, `${rel} og:title`);
    assert.equal(meta("og:description"), desc, `${rel} og:description`);
    assert.equal(meta("og:type"), "website", `${rel} og:type`);
    assert.equal(meta("og:site_name"), "Prospereum", `${rel} og:site_name`);
    assert.ok(html.includes('<meta name="twitter:card" content="summary">'), `${rel} twitter:card`);
    assert.ok(html.includes('<link rel="icon" href="/favicon.svg" type="image/svg+xml">'), `${rel} favicon link`);
    assert.equal((html.match(/<link rel="canonical"/g) || []).length, 1, `${rel} one canonical`);
  }
  assert.ok(readFileSync(path.join(root, "favicon.svg"), "utf8").startsWith("<svg "), "favicon.svg is an SVG");
});

test("robots.txt points at the sitemap; sitemap.xml lists exactly the six page routes on the production origin; 404.html is branded and root-absolute", () => {
  const robots = readFileSync(path.join(root, "robots.txt"), "utf8");
  assert.match(robots, /^User-agent: \*\nAllow: \/\n/m);
  assert.ok(robots.includes(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`), "robots.txt sitemap line");
  const sitemap = readFileSync(path.join(root, "sitemap.xml"), "utf8");
  const locs = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
  assert.deepEqual(locs, Object.values(PAGES).map((href) => SITE_ORIGIN + href));
  const nf = readFileSync(path.join(root, "404.html"), "utf8");
  assert.ok(nf.includes('<link rel="stylesheet" href="/site.css">'), "404 stylesheet root-absolute (served at any path)");
  assert.ok(nf.includes('<meta name="robots" content="noindex">'), "404 noindex");
  assert.ok(!/(href|src)="\.\.?\//.test(nf), "404.html has no relative link");
  for (const m of nf.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const target = resolveLocal(m[1], path.join(root, "404.html"));
    if (target) assert.ok(existsSync(target), `404.html → ${m[1]}`);
  }
});

/** UK spellings the site does not use: one convention (US, after the contract terms finalizeEpoch / finalization) — site QA 2026-11-25 C1. */
const UK_SPELLINGS = /\b(decentralis\w*|centralis\w*|cancell(ed|ing)|labell(ed|ing)|finalis\w*|authoris\w*|optimis\w*|recognis\w*|organis\w*|tokenis\w*|utilis\w*|minimis\w*|customis\w*|initialis\w*|normalis\w*|serialis\w*|capitalis\w*|modell(ed|ing)|travell(ed|ing)|behaviour\w*|colour\w*|favour\w*|honour\w*|licence|defence|centre|programme|catalogue|dialogue|analyse[sd]?)\b/i;

test("visible page text uses US spelling throughout (site QA 2026-11-25 C1)", () => {
  const hits = [];
  for (const { file } of [...pageFiles, ...standaloneFiles]) {
    const m = pageText(readFileSync(file, "utf8")).match(UK_SPELLINGS);
    if (m) hits.push(`${path.relative(root, file)}: ${m[0]}`);
  }
  assert.deepEqual(hits, []);
});

/** Resolve an href/src found on `file` to a path in the tree, or null for external / anchor / mailto. */
function resolveLocal(ref, file) {
  if (/^(https?:|mailto:|#|data:)/.test(ref)) return null;
  const clean = ref.split("#")[0].split("?")[0];
  if (!clean) return null;
  let target = clean.startsWith("/") ? path.join(root, clean) : path.resolve(path.dirname(file), clean);
  if (clean.endsWith("/") || (existsSync(target) && statSync(target).isDirectory())) target = path.join(target, "index.html");
  return target;
}

test("every internal href / src / stylesheet on every page resolves to a file", () => {
  const missing = [];
  for (const { file } of pageFiles) {
    const html = readFileSync(file, "utf8");
    for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const target = resolveLocal(m[1], file);
      if (target && !existsSync(target)) missing.push(`${path.relative(root, file)} → ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

/** Unresolved-placeholder patterns no published page may carry (the same list .github/workflows/pr-checks.yml greps for). */
export const PLACEHOLDER_PATTERNS = [/\[(today|contact address|link pending)[^\]]*\]/i, /class="pending"/, /coming[\s-]soon/i, /\bTBD\b/, /\bTODO\b/, /lorem ipsum/i, /published with/i, /to be published/i, /when the first partner/i];

test("no published page carries an unresolved placeholder (bracketed pending text, class=\"pending\", \"coming soon\", TBD/TODO) or a forward-looking release promise (\"published with\", \"to be published\", \"when the first partner\") — Kin PR #1 addendum + round 2 finding 4 + round 3 finding 3", () => {
  const hits = [];
  for (const { file } of pageFiles) {
    const html = readFileSync(file, "utf8");
    for (const re of PLACEHOLDER_PATTERNS) {
      const m = html.match(re);
      if (m) hits.push(`${path.relative(root, file)}: ${m[0]}`);
    }
  }
  assert.deepEqual(hits, []);
});

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

/**
 * Layout probe (Kin PR #1 finding 10). Headless Chrome will not open a window narrower than 500px, so the real header of
 * index.html + site.css is loaded in an <iframe> of the width under test — an iframe is its own viewport, so the
 * phone media query is evaluated at exactly that width. The frame measures every nav link's rect and hit-tests its
 * centre with elementFromPoint, then writes the JSON into the parent's #out (same origin) for --dump-dom.
 */
const NAV_PROBE_PATH = "/__nav-probe.html";
const NAV_FRAME_PATH = "/__nav-frame.html";
function navProbeHtml(width, height) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><iframe src="${NAV_FRAME_PATH}" style="width:${width}px;height:${height}px;border:0;display:block"></iframe><pre id="out"></pre></body></html>`;
}
function navFrameHtml() {
  const home = readFileSync(path.join(root, "index.html"), "utf8");
  const header = home.match(/<header class="top">[\s\S]*?<\/header>/)[0];
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/site.css"></head><body>${header}<script>
  const links = [...document.querySelectorAll('nav a')].map((a) => { const r = a.getBoundingClientRect(); return { text: a.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; });
  const hit = links.map((l) => { const el = document.elementFromPoint((l.left + l.right) / 2, (l.top + l.bottom) / 2); return !!(el && el.closest('nav a') && el.closest('nav a').textContent === l.text); });
  parent.document.getElementById('out').textContent = JSON.stringify({ viewport: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, links, hit });
  <\/script></body></html>`;
}

/**
 * Canonical answers for the pages' own calls (round 3 #1 shapes, as shared/test/rpc.test.mjs canonicalFor): the return
 * types come from the shared manifest by (target, selector), so every getter decodes and the page renders a full snapshot.
 */
const STUB_BLOCK = "0x3276f9f";
const word = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");
function stubRpc(body) {
  const id = body && body.id !== undefined ? body.id : null;
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  if (!body || body.jsonrpc !== "2.0") return { jsonrpc: "2.0", id, error: { code: -32600, message: "invalid request" } };
  switch (body.method) {
    case "eth_chainId": return reply("0x2105");
    case "eth_blockNumber": return reply(STUB_BLOCK);
    case "eth_getBlockByNumber": return reply({ number: STUB_BLOCK, hash: "0x" + "ab".repeat(32), parentHash: "0x" + "cd".repeat(32), timestamp: "0x68f7a2b1" });
    case "eth_call": {
      const { to, data } = body.params[0];
      const types = returnTypesFor(to, data.slice(0, 10)) || ["uint256"];
      if (types.length === 2) return reply(word(0) + word(0).slice(2));
      const t = types[0];
      if (t === "bool" || t === "address") return reply(word(0));
      if (t === "uint24") return reply(word(10000));
      if (t === "address[]") return reply(word(32) + word(0).slice(2));
      return reply(word(7));
    }
    default: return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } };
  }
}

/**
 * Page probe (same idea as the nav probe): the real page is loaded in an <iframe> of the exact width so its media queries
 * run at that width; the frame is the page's own index.html served at `<dir>/__frame.html` (relative module paths still
 * resolve) with a script appended that runs `measureJs(document, window)` after `load` — i.e. after the page's module
 * scripts — and writes the JSON into the parent's #out for --dump-dom.
 */
function frameProbeHtml(url, width, height) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><iframe id="f" src="${url}__frame.html" style="width:${width}px;height:${height}px;border:0;display:block"></iframe><pre id="out"></pre></body></html>`;
}
function framedPageHtml(file, measureJs) {
  return readFileSync(file, "utf8").replace("</body>", `<script>window.addEventListener('load', () => { setTimeout(() => { parent.document.getElementById('out').textContent = JSON.stringify((${measureJs})(document, window)); }, 300); });<\/script></body>`);
}
const FRAME_PROBE_PATH = "/__frame-probe.html";
const FRAME_SUFFIX = "/__frame.html";
let frameMeasureJs = "() => ({})";

function serve({ rpc = false } = {}) {
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/rpc" && rpc) {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = null; }
        const out = JSON.stringify(stubRpc(body));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(out);
      });
      return;
    }
    if (req.url.startsWith(FRAME_PROBE_PATH)) {
      const q = new URL(req.url, "http://x").searchParams;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(frameProbeHtml(q.get("url"), Number(q.get("w") || 390), Number(q.get("h") || 844)));
    }
    if (req.url.endsWith(FRAME_SUFFIX)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(framedPageHtml(path.join(root, req.url.slice(0, -FRAME_SUFFIX.length), "index.html"), frameMeasureJs));
    }
    if (req.url.startsWith(NAV_PROBE_PATH)) {
      const q = new URL(req.url, "http://x").searchParams;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(navProbeHtml(Number(q.get("w") || 390), Number(q.get("h") || 844)));
    }
    if (req.url === NAV_FRAME_PATH) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(navFrameHtml());
    }
    const target = resolveLocal(req.url, path.join(root, "index.html"));
    if (!target || !existsSync(target) || statSync(target).isDirectory()) {
      res.writeHead(404);
      return res.end("not found");
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(target)] || "application/octet-stream" });
    res.end(readFileSync(target));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => existsSync(p));
const CHROME_BASE_ARGS = [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
  "--disable-component-update", "--disable-extensions", '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', "--enable-logging=stderr", "--v=0",
];

/** Dump the DOM of `url` in headless Chrome at `width`×`height`; returns { stdout, stderr }. */
async function chromeDom(url, tmpProfile, width, height) {
  const args = [...CHROME_BASE_ARGS, `--user-data-dir=${tmpProfile}`, `--window-size=${width},${height}`, "--virtual-time-budget=3000", "--timeout=8000", "--dump-dom", url];
  try {
    return await execFileP(CHROME, args, { encoding: "utf8", timeout: 40_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    assert.fail(`${url}: chrome did not finish (${e.code ?? e.message})`);
  }
}

test("static serve: every page answers 200; headless Chrome loads each with zero console errors", { skip: CHROME ? false : "no Chrome on this machine" }, async () => {
  const { server, port } = await serve();
  const tmpProfile = mkdtempSync(path.join(os.tmpdir(), "psre-chrome-"));
  try {
    for (const { href } of pageFiles) {
      const res = await fetch(`http://127.0.0.1:${port}${href}`);
      assert.equal(res.status, 200, href);
      assert.match(res.headers.get("content-type"), /text\/html/);
    }
    // One headless Chrome run per page: network blocked except the local server (RPC fetches fail fast → pages degrade to "—"),
    // throwaway profile, hard --timeout so a hung refresh loop cannot stall the suite. stderr carries CONSOLE(n) lines.
    for (const { href } of pageFiles) {
      // async spawn: the static server lives in this process, so a sync spawn would starve it (empty DOM).
      const { stdout, stderr } = await chromeDom(`http://127.0.0.1:${port}${href}`, tmpProfile, 1280, 900);
      assert.ok(stdout.includes("</html>"), `${href} rendered`);
      assert.ok(stdout.includes(FOOTER_SENTENCE.slice(0, 40)), `${href} footer in DOM`);
      const jsErrors = stderr.split("\n").filter((l) => /CONSOLE\(\d+\)/.test(l) && /Uncaught|SyntaxError|ReferenceError|Failed to resolve module|Failed to load resource/.test(l));
      assert.deepEqual(jsErrors, [], `${href} console errors`);
    }
    // Use page offline: the partner line must be a dash, never the typed empty state (Kin PR #1 finding 9)
    const use = await chromeDom(`http://127.0.0.1:${port}/use/`, tmpProfile, 1280, 900);
    assert.match(use.stdout, /<p data-partner-list="">—<\/p>/, "use page partner line stays — without a snapshot");
  } finally {
    server.close();
    rmSync(tmpProfile, { recursive: true, force: true });
  }
});

test("phone width (390px): the six nav links fit inside the viewport, do not overlap, no horizontal scroll, and each is hit-testable at its centre (Kin PR #1 finding 10)", { skip: CHROME ? false : "no Chrome on this machine" }, async () => {
  const { server, port } = await serve();
  const tmpProfile = mkdtempSync(path.join(os.tmpdir(), "psre-chrome-nav-"));
  try {
    for (const [width, height, oneRow] of [[390, 844, false], [360, 780, false], [1280, 900, true]]) {
      const { stdout } = await chromeDom(`http://127.0.0.1:${port}${NAV_PROBE_PATH}?w=${width}&h=${height}`, tmpProfile, Math.max(width, 500) + 40, height + 40);
      const m = stdout.match(/<pre id="out">([\s\S]*?)<\/pre>/);
      assert.ok(m && m[1].trim(), `${width}px probe output`);
      const out = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
      assert.equal(out.viewport, width, `${width}px: the frame viewport is exactly ${width}px`);
      assert.equal(out.links.length, NAV.length, `${width}px: six links`);
      assert.ok(out.scrollWidth <= out.viewport, `${width}px: no horizontal scroll (${out.scrollWidth} > ${out.viewport})`);
      for (const l of out.links) {
        assert.ok(l.left >= 0 && l.right <= out.viewport, `${width}px: "${l.text}" inside the viewport (${l.left}–${l.right})`);
        assert.ok(l.height >= (oneRow ? 16 : 24) && l.width > 0, `${width}px: "${l.text}" has a tappable box (${l.height}px high)`);
      }
      for (let i = 0; i < out.links.length; i++) for (let j = i + 1; j < out.links.length; j++) {
        const a = out.links[i], b = out.links[j];
        const overlap = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        assert.ok(!overlap, `${width}px: "${a.text}" overlaps "${b.text}"`);
      }
      assert.ok(out.hit.every(Boolean), `${width}px: every link is the element at its own centre`);
      const rows = new Set(out.links.map((l) => Math.round(l.top)));
      if (oneRow) assert.equal(rows.size, 1, "desktop: one row");
      else assert.ok(rows.size >= 2, "phone: links wrap onto more than one row");
    }
  } finally {
    server.close();
    rmSync(tmpProfile, { recursive: true, force: true });
  }
});

test("Token page with a canonical snapshot: every span that carries a key is filled, duplicates identical, none left at \"—\" (site QA 2026-11-25 A1)", { skip: CHROME ? false : "no Chrome on this machine" }, async () => {
  const { server, port } = await serve({ rpc: true });
  const tmpProfile = mkdtempSync(path.join(os.tmpdir(), "psre-chrome-token-"));
  try {
    const { stdout } = await chromeDom(`http://127.0.0.1:${port}/token/`, tmpProfile, 1280, 900);
    assert.match(stdout, /Block 52,916,127, 15:11 UTC · via prospereum rpc proxy/, "snapshot line rendered from the stub block");
    const byKey = new Map();
    for (const m of stdout.matchAll(/<(?:span|small) data-v="([^"]+)"[^>]*>([^<]*)<\/(?:span|small)>/g)) {
      if (!byKey.has(m[1])) byKey.set(m[1], []);
      byKey.get(m[1]).push(m[2].trim());
    }
    const dupes = [...byKey].filter(([, v]) => v.length > 1).map(([k]) => k);
    assert.ok(dupes.includes("epochEnd") && dupes.includes("lpSplit"), `keys that appear twice on the page: ${dupes.join(", ")}`);
    for (const [k, values] of byKey) {
      assert.equal(new Set(values).size, 1, `${k}: every span shows the same value (${values.join(" | ")})`);
      if (k !== "backlogRange") assert.notEqual(values[0], "—", `${k} filled`);
    }
  } finally {
    server.close();
    rmSync(tmpProfile, { recursive: true, force: true });
  }
});

test("Partners page layout at 1440 and 390: contracts-table headers keep a gap, the address wraps at most once, no horizontal scroll, the empty state is prose (site QA 2026-11-25 R1/R2)", { skip: CHROME ? false : "no Chrome on this machine" }, async () => {
  const { server, port } = await serve({ rpc: true });
  const tmpProfile = mkdtempSync(path.join(os.tmpdir(), "psre-chrome-partners-"));
  frameMeasureJs = `(d, w) => {
    const textRect = (el) => { const r = d.createRange(); r.selectNodeContents(el); const b = r.getBoundingClientRect(); return { text: el.textContent.trim(), left: b.left, right: b.right, top: b.top, bottom: b.bottom }; };
    const ths = [...d.querySelectorAll('#contracts thead th')].map((th) => ({ ...textRect(th), visible: th.getBoundingClientRect().width > 0 }));
    const addrs = [...d.querySelectorAll('#contracts td.mono')].map((td) => { const t = textRect(td); return { lines: Math.round((t.bottom - t.top) / parseFloat(w.getComputedStyle(td).lineHeight)), right: t.right }; }); // the text's own box, not the row height
    const empty = d.querySelector('#partners li');
    return { viewport: w.innerWidth, scrollWidth: d.documentElement.scrollWidth, rows: d.querySelectorAll('#contracts tbody tr').length, ths, addrs, emptyText: empty && empty.textContent, emptyFont: empty && w.getComputedStyle(empty).fontFamily, h1: d.querySelectorAll('h1').length };
  }`;
  try {
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      const q = `url=${encodeURIComponent("/partners/")}&w=${width}&h=${height}`;
      const { stdout } = await chromeDom(`http://127.0.0.1:${port}${FRAME_PROBE_PATH}?${q}`, tmpProfile, Math.max(width, 500) + 40, height + 40);
      const m = stdout.match(/<pre id="out">([\s\S]*?)<\/pre>/);
      assert.ok(m && m[1].trim(), `${width}px probe output`);
      const out = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
      assert.equal(out.viewport, width, `${width}px: frame viewport`);
      assert.ok(out.scrollWidth <= out.viewport, `${width}px: no horizontal scroll (${out.scrollWidth} > ${out.viewport})`);
      assert.equal(out.h1, 1, `${width}px: one h1`);
      assert.equal(out.rows, 5, `${width}px: five contract rows`);
      assert.ok(out.addrs.every((a) => a.right <= out.viewport), `${width}px: address cells inside the viewport`);
      const maxLines = width >= 1024 ? 1 : 2;
      for (const a of out.addrs) assert.ok(a.lines >= 1 && a.lines <= maxLines, `${width}px: address on ${a.lines} line(s), limit ${maxLines}`);
      if (width >= 1024) {
        assert.equal(out.ths.length, 4);
        for (let i = 0; i + 1 < out.ths.length; i++) {
          const a = out.ths[i], b = out.ths[i + 1];
          const sameRow = a.top < b.bottom && b.top < a.bottom;
          assert.ok(!sameRow || b.left - a.right >= 8, `${width}px: header "${a.text}" and "${b.text}" keep a gap (${(b.left - a.right).toFixed(1)}px)`);
        }
      } else {
        assert.ok(out.ths.every((t) => !t.visible), `${width}px: header row hidden, rows stacked with labels`);
      }
      assert.match(out.emptyText || "", /^No partner vault is live yet\./, `${width}px: empty state rendered from the snapshot`);
      assert.doesNotMatch(out.emptyFont || "", /mono|Menlo/i, `${width}px: empty state in the prose font (${out.emptyFont})`);
    }
  } finally {
    server.close();
    rmSync(tmpProfile, { recursive: true, force: true });
  }
});
