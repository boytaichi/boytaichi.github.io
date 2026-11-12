#!/usr/bin/env node
// prospereum.io — exact-head PREVIEW GATE (Kin PR #1 round 2 finding 3). Run from pages/:
//   node scripts/preview-gate.mjs --worker shim        # offline: pages served from this checkout + the Worker's handle() behind a Node shim
//   node scripts/preview-gate.mjs --worker wrangler    # same pages + the real Worker under `wrangler dev --local` (workerd), stub upstream
// What it proves, for the exact checkout it runs in (no Cloudflare deploy — CI has no token; the Pages project output
// dir is Jason's A3 item): (1) every published file and every directory route is served BYTE-IDENTICAL to the tree
// (verify-deploy.mjs --exact); (2) the six pages carry the shared nav/footer and only same-origin scripts; (3) the
// Worker answers GET /rpc/health 200 ok, refuses a disallowed method / selector / originless POST, and completes ONE
// ALLOWED call (PSRE.totalSupply() at the stub's pinned block) end to end through the allowlist to the stub upstream.
// Exit 1 on any failing check — the CI job `preview` in .github/workflows/pr-checks.yml fails with it.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startStaticServer } from "./serve.mjs";
import { startStubUpstream, STUB_BLOCK } from "../../worker/scripts/stub-upstream.mjs";
import { startShim, shimEnv } from "../../worker/scripts/dev-shim.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pagesRoot = path.resolve(here, "..");
const workerRoot = path.resolve(here, "../../worker");
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const mode = opt("--worker", "shim");
if (!["shim", "wrangler"].includes(mode)) {
  console.error("usage: node scripts/preview-gate.mjs --worker shim|wrangler [--wrangler-timeout-ms 180000]");
  process.exit(2);
}
const wranglerTimeoutMs = Number(opt("--wrangler-timeout-ms", 180_000));

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer();
  s.on("error", reject);
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanup = [];
const stop = async () => { for (const fn of cleanup.reverse()) { try { await fn(); } catch { /* best effort */ } } };
process.on("SIGINT", async () => { await stop(); process.exit(130); });

let code = 1;
try {
  // 1. the pages, exactly as checked out
  const site = await startStaticServer(pagesRoot, 0);
  cleanup.push(() => new Promise((r) => site.server.close(r)));
  console.log(`preview-gate: pages ${site.origin}  (root ${pagesRoot})`);

  // 2. a stub Base node, so the Worker has an upstream without a key or the network
  const stub = await startStubUpstream(0);
  cleanup.push(() => new Promise((r) => stub.server.close(r)));
  console.log(`preview-gate: stub upstream ${stub.url}  (pinned block ${STUB_BLOCK})`);

  // 3. the Worker
  let rpcUrl;
  if (mode === "shim") {
    const shim = await startShim(shimEnv({ siteOrigin: site.origin, upstreamUrl: stub.url }), 0);
    cleanup.push(() => new Promise((r) => shim.server.close(r)));
    rpcUrl = `${shim.url}/rpc`;
    console.log(`preview-gate: worker (handle() behind a Node shim) ${rpcUrl}`);
  } else {
    const port = await freePort();
    const wranglerArgs = ["--yes", "wrangler@3", "dev", "--local", "--port", String(port), "--ip", "127.0.0.1", "--log-level", "info",
      "--var", `SITE_ORIGIN:${site.origin}`, "--var", `UPSTREAM_URL:${stub.url}`, "--var", "DEV_ALLOW_NO_RATE_LIMIT:true"];
    const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", wranglerArgs, { cwd: workerRoot, env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let log = "";
    child.stdout.on("data", (d) => { log += d; });
    child.stderr.on("data", (d) => { log += d; });
    cleanup.push(async () => { try { process.platform === "win32" ? child.kill() : process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ } await sleep(500); try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } });
    rpcUrl = `http://127.0.0.1:${port}/rpc`;
    console.log(`preview-gate: worker (wrangler dev --local, workerd) ${rpcUrl} — waiting for /rpc/health`);
    const deadline = Date.now() + wranglerTimeoutMs;
    let ready = false;
    while (Date.now() < deadline && !ready) {
      if (child.exitCode !== null) break;
      try {
        const r = await fetch(`${rpcUrl}/health`);
        ready = r.status === 200 && (await r.json()).ok === true;
      } catch { /* not up yet */ }
      if (!ready) await sleep(1000);
    }
    if (!ready) {
      console.log(log.split("\n").filter((l) => !/UPSTREAM_URL|SECRET/.test(l)).slice(-40).join("\n"));
      throw new Error(`wrangler dev did not answer /rpc/health within ${wranglerTimeoutMs} ms (exit ${child.exitCode})`);
    }
    console.log("preview-gate: wrangler dev ready");
  }

  // 4. the deployed-origin verifier against this preview: pages + worker + exact-artifact comparison
  const verify = spawn(process.execPath, [path.join(here, "verify-deploy.mjs"), site.origin, "--rpc", rpcUrl, "--pinned-block", STUB_BLOCK, "--exact", pagesRoot], { cwd: pagesRoot, stdio: "inherit" });
  code = await new Promise((resolve) => verify.on("exit", (c) => resolve(c ?? 1)));

  // 5. the allowed call really went through to the upstream (and the disallowed ones never did)
  const upstreamMethods = stub.calls.map((c) => c?.method);
  const sawAllowed = stub.calls.some((c) => c?.method === "eth_call" && c.params?.[0]?.data === "0x18160ddd" && c.params?.[1] === STUB_BLOCK);
  const sawForbidden = upstreamMethods.some((m) => !["eth_call", "eth_chainId", "eth_blockNumber", "eth_getBlockByNumber"].includes(m)) || stub.calls.some((c) => c?.method === "eth_call" && c.params?.[0]?.data === "0xa9059cbb");
  console.log(`preview-gate: upstream saw ${stub.calls.length} call(s): ${[...new Set(upstreamMethods)].join(", ")}`);
  if (!sawAllowed) { console.log("  FAIL the allowed PSRE.totalSupply() call never reached the upstream"); code = 1; } else console.log("  ok   allowed call reached the upstream at the pinned block");
  if (sawForbidden) { console.log("  FAIL a disallowed method / selector reached the upstream"); code = 1; } else console.log("  ok   no disallowed method or selector reached the upstream");
} catch (e) {
  console.error(`preview-gate: ${e.message}`);
  code = 1;
} finally {
  await stop();
}
console.log(code === 0 ? `\nPREVIEW GATE PASS (worker: ${mode})` : `\nPREVIEW GATE FAIL (worker: ${mode})`);
process.exit(code);
