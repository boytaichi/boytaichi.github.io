#!/usr/bin/env node
// prospereum.io — run the Worker's handle() behind a plain Node HTTP server (Kin PR #1 round 2 finding 3).
// Run from worker/:  node scripts/dev-shim.mjs --site-origin http://127.0.0.1:8787 --upstream http://127.0.0.1:8788 [--port 8789]
// This is the OFFLINE path of the preview gate: no wrangler, no workerd, no network. It exercises the same exported
// handle() the Worker tests exercise, with the same bindings validated the same way (DEV_ALLOW_NO_RATE_LIMIT="true"
// stands in for the Cloudflare rate-limit binding, exactly as for local `wrangler dev`). Limitation (documented in
// DEPLOY.md §2): the platform pieces — routes, the rate-limit binding, cf-connecting-ip, isolate lifecycle — are not
// exercised here; the wrangler mode of preview-gate.mjs covers them under workerd.
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { handle, MemoryCache } from "../src/index.js";

/** Bindings for a local run: the three vars from wrangler.toml plus the two the caller chooses. */
export function shimEnv({ siteOrigin, upstreamUrl, upstreamName = "stub upstream (preview gate)", cacheTtl = "60" }) {
  return { SITE_ORIGIN: siteOrigin, UPSTREAM_URL: upstreamUrl, UPSTREAM_NAME: upstreamName, CACHE_TTL_SECONDS: cacheTtl, DEV_ALLOW_NO_RATE_LIMIT: "true" };
}

/** Node IncomingMessage → fetch Request (body streamed, so the Worker's byte-counting reader sees real chunks). */
function toRequest(req, origin) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const url = origin + req.url;
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, { method: req.method, headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: "half" });
}

/** Start the shim on 127.0.0.1:`port` (0 = any free port). Resolves { server, port, url }. */
export function startShim(env, port = 0) {
  const cache = new MemoryCache();
  const server = createServer(async (req, res) => {
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const response = await handle(toRequest(req, origin), env, { cache });
      const body = Buffer.from(await response.arrayBuffer());
      const headers = {};
      response.headers.forEach((v, k) => { headers[k] = v; });
      headers["content-length"] = body.byteLength;
      res.writeHead(response.status, headers);
      res.end(body);
    } catch {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "shim failure" }));
    }
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
  const siteOrigin = opt("--site-origin", null);
  const upstreamUrl = opt("--upstream", null);
  if (!siteOrigin || !upstreamUrl) {
    console.error("usage: node scripts/dev-shim.mjs --site-origin http://127.0.0.1:8787 --upstream http://127.0.0.1:8788 [--port 8789]");
    process.exit(2);
  }
  const { url } = await startShim(shimEnv({ siteOrigin, upstreamUrl }), Number(opt("--port", 8789)));
  console.log(`worker shim at ${url}/rpc  (SITE_ORIGIN ${siteOrigin}; upstream ${upstreamUrl})`);
}
