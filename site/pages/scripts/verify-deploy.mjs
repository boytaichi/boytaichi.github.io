#!/usr/bin/env node
// prospereum.io — verify a DEPLOYED origin (DEPLOY.md §4 steps 1, 5 and the Worker route, as a script).
// Run from pages/:  node scripts/verify-deploy.mjs https://prospereum.io [--rpc https://<worker-host>/rpc] [--pinned-block 0x…] [--exact <dir>]
// Read-only, no dependencies, Node 20+. Exit 1 on the first group that fails.
//
// Checks: the six nav pages answer 200 as HTML; each carries the shared nav (all six entries in order) and the
// footer sentence verbatim (shared/chrome.mjs — the same definition stamp-chrome --check enforces locally);
// no page references a non-same-origin script other than Cloudflare Web Analytics (DEPLOY.md §4 step 4, static part);
// with --rpc: GET → 405 "POST only"; GET <rpc>/health → 200 ok:true (bindings valid, one allowed + one rejected shape,
// no upstream call); POST eth_chainId → 200 with result 0x2105 (Base); POST eth_sendRawTransaction → 4xx (a disallowed
// method never reaches the upstream); POST an allowlisted contract with a disallowed selector → 400 / -32602
// (Kin PR #1 finding 11); POST without an Origin header → 403 (round 2 finding 6);
// with --pinned-block 0x…: POST one ALLOWED call (PSRE.totalSupply() at that block) → 200 with a word-aligned result
// and the X-Prospereum-Upstream header (the call went through the allowlist to the upstream and back);
// with --exact <dir> (round 2 finding 3): every publishable file under <dir> (tests, scripts, README excluded — the
// deploy.yml rsync rule) is fetched from the origin and must match the file BYTE FOR BYTE, and each directory route
// (/, /token/, …) must serve its index.html bytes — the served site IS the artifact, not an older deploy.
// Nothing printed is a key or an upstream URL.
import { FOOTER_SENTENCE, NAV, navHtml } from "../shared/chrome.mjs";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const base = (args.find((a) => !a.startsWith("--")) ?? "").replace(/\/$/, "");
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const rpc = opt("--rpc");
const pinnedBlock = opt("--pinned-block");
const exactDir = opt("--exact");
if (!base) {
  console.error("usage: node scripts/verify-deploy.mjs https://<origin> [--rpc https://<worker>/rpc] [--pinned-block 0x…] [--exact <dir>]");
  process.exit(2);
}
if (pinnedBlock !== null && !/^0x([1-9a-f][0-9a-f]*|0)$/.test(pinnedBlock)) {
  console.error("--pinned-block must be a hex block number (e.g. 0x3276f9f)");
  process.exit(2);
}

let failures = 0;
const ok = (l, x = "") => console.log(`  ok   ${l}${x ? "  " + x : ""}`);
const bad = (l, x = "") => { failures++; console.log(`  FAIL ${l}${x ? "  " + x : ""}`); };
const expect = (c, l, x) => (c ? ok(l, x) : bad(l, x));
const decode = (s) => s.replace(/&amp;/g, "&");

console.log(`prospereum.io verify → ${base}${rpc ? `  rpc ${new URL(rpc).host}` : ""}`);

console.log("pages (DEPLOY §4.1, §4.5)");
for (const [href, label] of NAV) {
  let res, html;
  try {
    res = await fetch(base + href, { redirect: "manual" });
    html = await res.text();
  } catch (e) {
    bad(href, String(e));
    continue;
  }
  const type = res.headers.get("content-type") ?? "";
  expect(res.status === 200 && type.includes("text/html"), `${href} 200 html`, `${res.status} ${type.split(";")[0]}`);
  if (res.status !== 200) continue;
  // nav: the exact stamped block for this page must be present (same definition as stamp-chrome --check)
  expect(html.includes(navHtml(href)), `${href} shared nav (6 entries, "${decode(label)}" current)`);
  expect(html.includes(FOOTER_SENTENCE), `${href} footer sentence verbatim`);
  // scripts: same-origin or Cloudflare Web Analytics only
  const srcs = [...html.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/gi)].map((m) => m[1]);
  const foreign = srcs.filter((s) => /^https?:\/\//i.test(s) && !s.startsWith(base + "/") && !/^https:\/\/static\.cloudflareinsights\.com\//.test(s));
  expect(foreign.length === 0, `${href} scripts same-origin (or Cloudflare Web Analytics)`, foreign.length ? foreign.join(",") : `${srcs.length} script tag(s)`);
}

if (rpc) {
  console.log("worker /rpc (DEPLOY §2)");
  const post = (body) => fetch(rpc, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify(body) });
  try {
    const g = await fetch(rpc, { method: "GET", redirect: "manual" });
    expect(g.status === 405, "GET → 405 POST only", String(g.status));
    const c = await post({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
    let j = null; try { j = await c.json(); } catch { j = null; }
    expect(c.status === 200 && j?.result === "0x2105", "eth_chainId → 0x2105 (Base)", `${c.status} ${j?.result ?? j?.error?.message ?? ""}`);
    const d = await post({ jsonrpc: "2.0", id: 2, method: "eth_sendRawTransaction", params: ["0x00"] });
    expect(d.status >= 400 && d.status < 500, "eth_sendRawTransaction → 4xx (disallowed method)", String(d.status));
    const h = await fetch(rpc.replace(/\/$/, "") + "/health", { method: "GET", redirect: "manual" });
    let hj = null; try { hj = await h.json(); } catch { hj = null; }
    expect(h.status === 200 && hj?.ok === true && hj?.allowedShapeAccepted === true && hj?.rejectedShapeRefused === true, "GET /health → 200 ok (bindings valid; allowed + rejected shapes)", `${h.status} ${hj ? JSON.stringify(hj) : ""}`);
    const x = await post({ jsonrpc: "2.0", id: 3, method: "eth_call", params: [{ to: "0x2fE08f304f1Af799Bc29E3D4E210973291d96702", data: "0xa9059cbb" }, "0x1"] });
    let xj = null; try { xj = await x.json(); } catch { xj = null; }
    expect(x.status === 400 && xj?.error?.code === -32602, "disallowed selector → 400 / -32602 (allowlist)", `${x.status} ${xj?.error?.message ?? ""}`);
    // round 2 finding 6: a POST without Origin is refused before anything else
    const o = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "eth_chainId", params: [] }) });
    expect(o.status === 403, "POST without Origin → 403", String(o.status));
    if (pinnedBlock) {
      // one ALLOWED call end to end: PSRE.totalSupply() at the pinned block, through the allowlist to the upstream
      const a = await post({ jsonrpc: "2.0", id: 5, method: "eth_call", params: [{ to: "0x2fE08f304f1Af799Bc29E3D4E210973291d96702", data: "0x18160ddd" }, pinnedBlock] });
      let aj = null; try { aj = await a.json(); } catch { aj = null; }
      const word = typeof aj?.result === "string" && /^0x([0-9a-f]{64})+$/i.test(aj.result);
      expect(a.status === 200 && word && aj.id === 5, `allowed call PSRE.totalSupply() @ ${pinnedBlock} → 200, word-aligned result`, `${a.status} ${aj?.result?.slice(0, 18) ?? aj?.error?.message ?? ""}…`);
      expect(!!a.headers.get("X-Prospereum-Upstream"), "X-Prospereum-Upstream header on the allowed call", a.headers.get("X-Prospereum-Upstream") ?? "(missing)");
    }
  } catch (e) {
    bad("worker reachable", String(e));
  }
}

if (exactDir) {
  console.log(`exact artifact (round 2 finding 3): served bytes == ${exactDir}`);
  const root = path.resolve(exactDir);
  const SKIP = new Set(["test", "scripts", "README.md"]);
  const files = [];
  (function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      if (SKIP.has(name) || name.startsWith(".")) continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  })(root);
  let matched = 0;
  const routes = [];
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    const expectBytes = readFileSync(file);
    const urls = ["/" + rel];
    if (path.basename(rel) === "index.html") urls.push("/" + rel.slice(0, -"index.html".length)); // the directory route
    for (const u of urls) {
      let res, got;
      try {
        res = await fetch(base + u, { redirect: "manual" });
        got = Buffer.from(await res.arrayBuffer());
      } catch (e) {
        bad(u, String(e));
        continue;
      }
      if (res.status === 200 && got.equals(expectBytes)) {
        matched++;
        if (u.endsWith("/")) routes.push(u);
      } else {
        bad(`${u} == ${rel}`, res.status !== 200 ? `HTTP ${res.status}` : `served ${got.byteLength} bytes, file ${expectBytes.byteLength} bytes`);
      }
    }
  }
  expect(files.length > 0, "artifact has files", String(files.length));
  ok(`${matched} served URL(s) byte-identical to the artifact (${files.length} files; routes ${routes.join(" ")})`);
  // nothing in the served tree should be an older artifact's file: the six nav routes were all compared above
  for (const [href] of NAV) expect(routes.includes(href), `${href} served from this artifact`);
}

console.log(failures === 0 ? `\nPASS — ${base}` : `\nFAIL — ${failures} check(s) failed on ${base}`);
process.exit(failures === 0 ? 0 : 1);
