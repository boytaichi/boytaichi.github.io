#!/usr/bin/env node
// prospereum.io — a stub Base JSON-RPC node for the preview gate (Kin PR #1 round 2 finding 3). No network, no key.
// Run from worker/:  node scripts/stub-upstream.mjs [--port 8788]      (prints the URL; Ctrl-C to stop)
// Answers exactly the four methods the Worker forwards, echoes the request id (the Worker checks it — round 2 #7):
//   eth_chainId → 0x2105 (Base)   eth_blockNumber → BLOCK   eth_getBlockByNumber → a fixed header
//   eth_call → one 32-byte word (7); factory.vaultActive(any) → true
// Anything else → JSON-RPC -32601, so a method that should never reach the upstream shows up as an error, not a result.
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const STUB_BLOCK = "0x3276f9f";
export const STUB_WORD = "0x" + (7).toString(16).padStart(64, "0");
const VAULT_ACTIVE = "0x6f8d34f0";
const TRUE_WORD = "0x" + "1".padStart(64, "0");
const HEADER = { number: STUB_BLOCK, hash: "0x" + "ab".repeat(32), parentHash: "0x" + "cd".repeat(32), timestamp: "0x68f7a2b1" };

export function stubAnswer(body) {
  const id = body && body.id !== undefined ? body.id : null;
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") return { jsonrpc: "2.0", id, error: { code: -32600, message: "invalid request" } };
  switch (body.method) {
    case "eth_chainId": return reply("0x2105");
    case "eth_blockNumber": return reply(STUB_BLOCK);
    case "eth_getBlockByNumber": return reply(HEADER);
    case "eth_call": {
      const data = (body.params?.[0]?.data ?? "").toLowerCase();
      return reply(data.startsWith(VAULT_ACTIVE) ? TRUE_WORD : STUB_WORD);
    }
    default: return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } };
  }
}

/** Start the stub on 127.0.0.1:`port` (0 = any free port). Resolves { server, port, url, calls } (calls = every request body seen). */
export function startStubUpstream(port = 0) {
  const calls = [];
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405);
      return res.end();
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        body = null;
      }
      calls.push(body);
      const out = JSON.stringify(stubAnswer(body));
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(out) });
      res.end(out);
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}`, calls }));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--port");
  const { url } = await startStubUpstream(i >= 0 ? Number(process.argv[i + 1]) : 8788);
  console.log(`stub upstream (Base-shaped, block ${STUB_BLOCK}) at ${url}`);
}
