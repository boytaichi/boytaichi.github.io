import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAP, check, sentencesOf, normalise } from "../scripts/copy-drift.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const copyMd = readFileSync(path.resolve(root, "../baseline/Prospereum_Site_Copy_IA_2026-10-21_v1.md"), "utf8");
const allow = JSON.parse(readFileSync(path.join(root, "scripts/copy-drift.allow.json"), "utf8"));

test("sentence splitter strips markdown labels, bold and door arrows", () => {
  const s = sentencesOf("**Headline:** Rewards that are real.\n\n- **I run a brand.** Replace points. → How you earn it\n1. **A brand joins** by buying. That earns nothing.");
  assert.deepEqual(s, ["Rewards that are real.", "I run a brand.", "Replace points.", "A brand joins by buying.", "That earns nothing."]);
  assert.equal(normalise("It’s  “here” ."), 'it\'s "here".');
});

test("every Site Copy v1 sentence is on its page, or is a listed deviation; no stale allow entry", () => {
  const pages = {};
  for (const [file, sections] of Object.entries(MAP)) pages[file] = { html: readFileSync(path.join(root, file), "utf8"), sections };
  const r = check({ copyMd, pages, allow });
  const missing = Object.entries(r.pages).flatMap(([f, p]) => p.missing.map((m) => `${f} §${m.section}: ${m.sentence}`));
  assert.deepEqual(missing, []);
  assert.deepEqual(r.staleAllow, []);
  assert.ok(r.checked >= 60, `checked ${r.checked}`);
});
