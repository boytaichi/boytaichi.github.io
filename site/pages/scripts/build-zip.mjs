#!/usr/bin/env node
// Release candidate: chrome check → all tests (incl. copy drift) → zip of pages/ + worker/ with a SHA-256.
// Run from pages/: `node scripts/build-zip.mjs [name]` → ../dist/<name>.zip + <name>.zip.sha256 (default name below).
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pages = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const site = path.resolve(pages, "..");
const name = process.argv[2] ?? `prospereum-site-rc1-${new Date().toISOString().slice(0, 10)}`;
const dist = path.join(site, "dist");
const run = (cmd, cwd) => { console.log(`$ ${cmd}`); execSync(cmd, { cwd, stdio: "inherit" }); };

run("node scripts/stamp-chrome.mjs --check", pages);
run("node --test token/test/token-logic.test.mjs partners/test/partners-logic.test.mjs shared/test/live-logic.test.mjs test/copy-drift.test.mjs test/site.test.mjs", pages);
run("node scripts/copy-drift.mjs", pages);
if (existsSync(path.join(site, "worker/test/worker.test.mjs"))) run("node --test test/worker.test.mjs", path.join(site, "worker"));

mkdirSync(dist, { recursive: true });
const zip = path.join(dist, `${name}.zip`);
rmSync(zip, { force: true });
const commit = (() => { try { return execSync("git rev-parse --short HEAD", { cwd: site }).toString().trim(); } catch { return "n/a"; } })();
writeFileSync(path.join(site, "RELEASE.txt"), `${name}\nbuilt ${new Date().toISOString()}\nworkspace commit ${commit}\ncontents: pages/ (six static pages, shared chrome, tests), worker/ (RPC proxy), DEPLOY.md\n`);
run(`zip -q -r -X "${zip}" pages worker DEPLOY.md RELEASE.txt -x "*/node_modules/*" -x "*/.DS_Store" -x "*/dist/*"`, site);
const sha = createHash("sha256").update(readFileSync(zip)).digest("hex");
writeFileSync(`${zip}.sha256`, `${sha}  ${path.basename(zip)}\n`);
console.log(`\n${path.relative(site, zip)}  ${readFileSync(zip).length} bytes\nSHA-256 ${sha}`);
