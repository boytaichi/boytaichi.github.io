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
import { FOOTER_SENTENCE, NAV, PAGES, navHtml } from "../shared/chrome.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pageFiles = Object.entries(PAGES).map(([dir, href]) => ({ dir, href, file: path.join(root, dir, "index.html") }));

test("every page has the shared nav (with aria-current on itself) and the verbatim footer sentence", () => {
  for (const { href, file } of pageFiles) {
    const html = readFileSync(file, "utf8");
    assert.ok(html.includes(navHtml(href)), `${path.relative(root, file)} nav`);
    assert.ok(html.includes(`<footer>\n<p>${FOOTER_SENTENCE}</p>\n</footer>`), `${path.relative(root, file)} footer`);
    assert.ok(html.includes('<link rel="stylesheet" href="') && html.includes("site.css"), `${path.relative(root, file)} site.css`);
  }
  assert.equal(NAV.length, 6);
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

function serve() {
  const server = createServer((req, res) => {
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
