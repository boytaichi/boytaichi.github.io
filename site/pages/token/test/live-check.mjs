// Manual live check (not a unit test): reads Base mainnet at one block through a public fallback and prints `derive`.
import { buildCalls, derive, statusCopy } from "../token-logic.mjs";
const URL = process.env.RPC || "https://base-rpc.publicnode.com";
let id = 1;
async function rpc(method, params) {
  const r = await fetch(URL, { method: "POST", headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 prospereum-live-check" }, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(JSON.stringify(j.error)); return j.result;
}
const chain = await rpc("eth_chainId", []); if (chain !== "0x2105") throw new Error("wrong network " + chain);
const bn = await rpc("eth_blockNumber", []); const block = await rpc("eth_getBlockByNumber", [bn, false]);
const results = {};
for (const c of buildCalls(bn)) results[c.key] = await rpc("eth_call", [{ to: c.to, data: c.data }, c.blockTag]);
const d = derive(results, { block: Number(bn), timestamp: Number(block.timestamp) });
console.log(JSON.stringify(d, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
console.log(statusCopy(d));
