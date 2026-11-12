#!/usr/bin/env node
// Release candidate: chrome check → all tests (incl. copy drift) → zip of pages/ + worker/ with a SHA-256.
// Run from pages/: `node scripts/build-zip.mjs [name]` → ../dist/<name>.zip + <name>.zip.sha256 (default name below).
// RELEASE.txt inside the zip is generated from the EXACT head (`git rev-parse HEAD`, "-dirty" when the checkout has
// uncommitted changes) and written to dist/, never to the tracked site/RELEASE.txt (Kin PR #1 finding 12).
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
run("node --test token/test/token-logic.test.mjs partners/test/partners-logic.test.mjs shared/test/live-logic.test.mjs shared/test/rpc.test.mjs test/copy-drift.test.mjs test/site.test.mjs", pages);
run("node scripts/copy-drift.mjs", pages);
if (existsSync(path.join(site, "worker/test/worker.test.mjs"))) run("node --test test/*.test.mjs", path.join(site, "worker"));

mkdirSync(dist, { recursive: true });
const zip = path.join(dist, `${name}.zip`);
rmSync(zip, { force: true });
const git = (cmd) => { try { return execSync(cmd, { cwd: site, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return null; } };
const head = git("git rev-parse HEAD");
const dirty = (git("git status --porcelain -- .") ?? "") !== "";
const commit = head ? `${head}${dirty ? "-dirty" : ""}` : "n/a (not a git checkout)";
const release = path.join(dist, "RELEASE.txt");
writeFileSync(release, `${name}\nbuilt ${new Date().toISOString()}\ncommit ${commit}\ncontents: pages/ (six static pages, shared chrome, tests), worker/ (RPC proxy), DEPLOY.md\n`);
run(`zip -q -r -X "${zip}" pages worker DEPLOY.md -x "*/node_modules/*" -x "*/.DS_Store" -x "*/dist/*"`, site);
run(`zip -q -j "${zip}" "${release}"`, site);
console.log(`RELEASE.txt → commit ${commit}`);
const sha = createHash("sha256").update(readFileSync(zip)).digest("hex");
writeFileSync(`${zip}.sha256`, `${sha}  ${path.basename(zip)}\n`);
console.log(`\n${path.relative(site, zip)}  ${readFileSync(zip).length} bytes\nSHA-256 ${sha}`);
