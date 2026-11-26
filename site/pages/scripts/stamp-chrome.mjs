#!/usr/bin/env node
// Stamp the shared nav + footer (shared/chrome.mjs) into every page. Run from pages/: `node scripts/stamp-chrome.mjs`.
// `--check` exits 1 instead of writing when any page differs (used by test/site.test.mjs).
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PAGES, STANDALONE, stamp } from "../shared/chrome.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
let changed = 0;
for (const [dir, href] of Object.entries(PAGES)) {
  const file = path.join(root, dir, "index.html");
  const before = readFileSync(file, "utf8");
  const after = stamp(before, href);
  if (after !== before) {
    changed++;
    if (check) console.error(`chrome drift: ${path.relative(root, file)}`);
    else {
      writeFileSync(file, after);
      console.log(`stamped ${path.relative(root, file)}`);
    }
  }
}
// Standalone pages outside PAGES (no nav entry, no aria-current): the branded 404 that GitHub Pages serves for unknown paths.
for (const file of STANDALONE.map((f) => path.join(root, f))) {
  const before = readFileSync(file, "utf8");
  const after = stamp(before, null);
  if (after !== before) {
    changed++;
    if (check) console.error(`chrome drift: ${path.relative(root, file)}`);
    else {
      writeFileSync(file, after);
      console.log(`stamped ${path.relative(root, file)}`);
    }
  }
}
if (check && changed) process.exit(1);
console.log(check ? "chrome: every page matches shared/chrome.mjs" : `chrome: ${changed} page(s) rewritten`);
