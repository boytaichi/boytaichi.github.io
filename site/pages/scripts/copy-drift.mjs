#!/usr/bin/env node
// Copy-drift check: every sentence of the accepted Site Copy & IA v1 (§2.1–2.6) must appear, verbatim, in the page
// that carries it. Run from pages/: `node scripts/copy-drift.mjs` (exit 1 on drift; `--verbose` lists every sentence).
// Deliberate deviations (live-data placeholders, link wording) are listed in scripts/copy-drift.allow.json with a reason;
// an allow entry that no longer matches any missing sentence is reported as stale so the list cannot rot.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verbose = process.argv.includes("--verbose");
const COPY = path.resolve(root, "../baseline/Prospereum_Site_Copy_IA_2026-10-21_v1.md");
const ALLOW = path.join(root, "scripts/copy-drift.allow.json");

// page → the §2 sections it must carry
// Token (§2.4) and Partners (§2.6) are NOT checked against Site Copy v1: their copy is governed by the later accepted
// baselines — Token Page Spec v6 (23 Oct, "v6 of Section 3 of the Site Copy and IA document", every number a live read)
// and Partners & Developers SDK Spec v4 (21 Oct) — which rewrote those two sections. The pages carry those documents.
export const MAP = {
  "index.html": ["2.1", "2.5"],
  "about/index.html": ["2.2"],
  "protocol/index.html": ["2.3"],
  "use/index.html": ["2.5"],
  "token/index.html": [],
  "partners/index.html": [],
};

export function normalise(s) {
  return s
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?)])/g, "$1")
    .trim()
    .toLowerCase();
}

/** Markdown section body → list of sentences (markdown markers stripped, arrows/labels removed). */
export function sentencesOf(md) {
  const out = [];
  for (let line of md.split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    line = line.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "");
    line = line.replace(/\*\*(.+?)\*\*/g, "$1"); // bold markers
    line = line.replace(/^(Headline|Sub-headline|Closing line|Three doors|Three facts|What you can do with it|Where it comes from|What PSRE is not|The whole mechanism|Three rules that keep it honest|Allocation at launch|Live strip \([^)]*\)|Live \([^)]*\)|For brands|For customers|Audit|Rules nobody can change|Contracts on Base \(chain ID 8453\))\s*:?\s*/i, (m) => (/^(For brands|For customers|Audit|Rules nobody can change)/i.test(m) ? "" : ""));
    line = line.replace(/\s*→\s*.*$/, ""); // door arrows ("→ How you earn it") are nav, not copy
    for (const s of line.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)) {
      const t = s.trim();
      if (t.length > 2) out.push(t);
    }
  }
  return out;
}

export function sections(copyMd) {
  const res = {};
  const re = /^### (2\.\d) .*$/gm;
  const idx = [];
  let m;
  while ((m = re.exec(copyMd))) idx.push({ id: m[1], start: m.index + m[0].length });
  for (let i = 0; i < idx.length; i++) {
    const end = i + 1 < idx.length ? copyMd.indexOf("### ", idx[i].start) : copyMd.indexOf("\n## 3.", idx[i].start);
    res[idx[i].id] = copyMd.slice(idx[i].start, end < 0 ? undefined : end);
  }
  return res;
}

export function pageText(html) {
  return normalise(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&middot;/g, "·")
      .replace(/&times;/g, "×"),
  );
}

export function check({ copyMd, pages, allow }) {
  const secs = sections(copyMd);
  const report = { pages: {}, missing: 0, allowed: 0, checked: 0, staleAllow: [] };
  const usedAllow = new Set();
  for (const [file, ids] of Object.entries(pages)) {
    const text = pageText(ids.html);
    const missing = [];
    const allowedHere = [];
    for (const id of ids.sections) {
      for (const s of sentencesOf(secs[id] ?? "")) {
        report.checked++;
        const n = normalise(s);
        if (text.includes(n)) continue;
        const a = allow.find((e) => e.page === file && normalise(e.sentence) === n);
        if (a) {
          usedAllow.add(a);
          allowedHere.push({ section: id, sentence: s, reason: a.reason });
          report.allowed++;
        } else {
          missing.push({ section: id, sentence: s });
          report.missing++;
        }
      }
    }
    report.pages[file] = { missing, allowed: allowedHere };
  }
  report.staleAllow = allow.filter((e) => !usedAllow.has(e));
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const copyMd = readFileSync(COPY, "utf8");
  const allow = JSON.parse(readFileSync(ALLOW, "utf8"));
  const pages = {};
  for (const [file, secs] of Object.entries(MAP)) pages[file] = { html: readFileSync(path.join(root, file), "utf8"), sections: secs };
  const r = check({ copyMd, pages, allow });
  for (const [file, p] of Object.entries(r.pages)) {
    console.log(`${file}: ${p.missing.length} missing, ${p.allowed.length} allowed deviation(s)`);
    for (const m of p.missing) console.log(`  MISSING §${m.section}: ${m.sentence}`);
    if (verbose) for (const a of p.allowed) console.log(`  allowed §${a.section}: ${a.sentence}  — ${a.reason}`);
  }
  for (const s of r.staleAllow) console.log(`  STALE allow entry (${s.page}): ${s.sentence}`);
  console.log(`copy-drift: ${r.checked} sentences checked, ${r.missing} missing, ${r.allowed} allowed, ${r.staleAllow.length} stale allow entries`);
  process.exit(r.missing || r.staleAllow.length ? 1 : 0);
}
