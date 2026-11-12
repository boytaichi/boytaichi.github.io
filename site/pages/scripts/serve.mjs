#!/usr/bin/env node
// prospereum.io — serve the pages tree exactly as checked out (Kin PR #1 round 2 finding 3: exact-head preview gate).
// Run from pages/:  node scripts/serve.mjs [--port 8787] [--root .]      (prints the origin; Ctrl-C to stop)
// No dependencies, no rewriting, no caching: every byte served is the byte on disk, so verify-deploy.mjs --exact can
// compare the served routes against the artifact. Directory URLs serve index.html (GitHub Pages / Cloudflare do the same).
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".txt": "text/plain; charset=utf-8", ".ico": "image/x-icon" };

/** Map a request path to a file under `root`, or null (outside the tree, missing, or a directory without index.html). */
export function resolveFile(root, urlPath) {
  const clean = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  let target = path.resolve(root, "." + clean);
  if (!target.startsWith(path.resolve(root))) return null;
  if (clean.endsWith("/") || (existsSync(target) && statSync(target).isDirectory())) target = path.join(target, "index.html");
  if (!existsSync(target) || statSync(target).isDirectory()) return null;
  return target;
}

/** Start a static server for `root` on 127.0.0.1:`port` (0 = any free port). Resolves { server, port, origin }. */
export function startStaticServer(root, port = 0) {
  const server = createServer((req, res) => {
    const target = resolveFile(root, req.url);
    if (!target) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("not found");
    }
    const body = readFileSync(target);
    res.writeHead(200, { "content-type": TYPES[path.extname(target)] || "application/octet-stream", "content-length": body.byteLength, "cache-control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : body);
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
  const root = path.resolve(opt("--root", path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")));
  const { origin } = await startStaticServer(root, Number(opt("--port", 8787)));
  console.log(`serving ${root} at ${origin}`);
}
