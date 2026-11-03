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

function serve() {
  const server = createServer((req, res) => {
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

const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));

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
      const args = [
        "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
        "--disable-component-update", "--disable-extensions", `--user-data-dir=${tmpProfile}`,
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', "--enable-logging=stderr", "--v=0",
        "--virtual-time-budget=3000", "--timeout=8000", "--dump-dom", `http://127.0.0.1:${port}${href}`,
      ];
      // async spawn: the static server lives in this process, so a sync spawn would starve it (empty DOM).
      let stdout = "", stderr = "";
      try {
        ({ stdout, stderr } = await execFileP(CHROME, args, { encoding: "utf8", timeout: 40_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 }));
      } catch (e) {
        assert.fail(`${href}: chrome did not finish (${e.code ?? e.message})`);
      }
      assert.ok(stdout.includes("</html>"), `${href} rendered`);
      assert.ok(stdout.includes(FOOTER_SENTENCE.slice(0, 40)), `${href} footer in DOM`);
      const jsErrors = stderr.split("\n").filter((l) => /CONSOLE\(\d+\)/.test(l) && /Uncaught|SyntaxError|ReferenceError|Failed to resolve module|Failed to load resource/.test(l));
      assert.deepEqual(jsErrors, [], `${href} console errors`);
    }
  } finally {
    server.close();
    rmSync(tmpProfile, { recursive: true, force: true });
  }
});
