#!/usr/bin/env node
// prospereum.io — verify a DEPLOYED origin (DEPLOY.md §4 steps 1, 5 and the Worker route, as a script).
// Run from pages/:  node scripts/verify-deploy.mjs https://prospereum.io [--rpc https://<worker-host>/rpc]
// Read-only, no dependencies, Node 20+. Exit 1 on the first group that fails.
//
// Checks: the six nav pages answer 200 as HTML; each carries the shared nav (all six entries in order) and the
// footer sentence verbatim (shared/chrome.mjs — the same definition stamp-chrome --check enforces locally);
// no page references a non-same-origin script other than Cloudflare Web Analytics (DEPLOY.md §4 step 4, static part);
// with --rpc: GET → 405 "POST only"; POST eth_chainId → 200 with result 0x2105 (Base); POST eth_sendRawTransaction
// → 4xx (a disallowed method never reaches the upstream). Nothing printed is a key or an upstream URL.
import { FOOTER_SENTENCE, NAV, navHtml } from "../shared/chrome.mjs";

const args = process.argv.slice(2);
const base = (args.find((a) => !a.startsWith("--")) ?? "").replace(/\/$/, "");
const rpcIdx = args.indexOf("--rpc");
const rpc = rpcIdx >= 0 ? args[rpcIdx + 1] : null;
if (!base) {
  console.error("usage: node scripts/verify-deploy.mjs https://<origin> [--rpc https://<worker>/rpc]");
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
  } catch (e) {
    bad("worker reachable", String(e));
  }
}

console.log(failures === 0 ? `\nPASS — ${base}` : `\nFAIL — ${failures} check(s) failed on ${base}`);
process.exit(failures === 0 ? 0 : 1);
