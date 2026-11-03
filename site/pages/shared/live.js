// prospereum.io — shared browser glue for the Overview strip and the Protocol live block (read-only; spec v6 §6 rules).
// Same endpoint order, chainId check, one eth_blockNumber per refresh, every eth_call pinned to that block, 60 s refresh,
// "Stale — last successful snapshot" on failure. Pages declare their getters with `data-live-keys="overview|protocol|use"`.
import { CHAIN_ID_HEX, ENDPOINTS, REFRESH_MS } from "../token/config.js";
import { deriveSubset, keysForPage, overviewStrip, snapshotLine, subsetCalls, useStrip } from "./live-logic.mjs";

let last = null;
let rpcId = 1;

async function rpc(endpoint, method, params) {
  const res = await fetch(endpoint.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }) });
  if (!res.ok) throw new Error(`${endpoint.name}: HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`${endpoint.name}: ${j.error.message || "rpc error"}`);
  return { result: j.result, upstream: res.headers.get("X-Prospereum-Upstream") };
}

async function pickEndpoint() {
  for (const e of ENDPOINTS) {
    try {
      const { result } = await rpc(e, "eth_chainId", []);
      if (result === CHAIN_ID_HEX) return e;
      console.warn(`${e.name}: wrong network endpoint (${result})`);
    } catch (err) {
      console.warn(String(err));
    }
  }
  return null;
}

function keysFor(root) {
  return keysForPage(root.dataset.liveKeys || "overview");
}

async function refresh(root) {
  const endpoint = await pickEndpoint();
  if (!endpoint) return fail(root, "wrong network endpoint");
  try {
    const { result: bn } = await rpc(endpoint, "eth_blockNumber", []);
    const { result: block } = await rpc(endpoint, "eth_getBlockByNumber", [bn, false]);
    const results = {};
    let upstream = null;
    for (const c of subsetCalls(bn, keysFor(root))) {
      const { result, upstream: up } = await rpc(endpoint, "eth_call", [{ to: c.to, data: c.data }, c.blockTag]);
      results[c.key] = result;
      if (up) upstream = up;
    }
    const d = deriveSubset(results, { block: Number(bn), timestamp: Number(block.timestamp) });
    last = { d, endpoint: upstream ? `${endpoint.name} → ${upstream}` : endpoint.name };
    render(root, last, false);
  } catch (err) {
    console.warn(String(err));
    fail(root, null);
  }
}

function fail(root, reason) {
  if (last) return render(root, last, true);
  for (const el of root.querySelectorAll("[data-v]")) el.textContent = "—";
  for (const el of root.querySelectorAll("[data-snapshot]")) el.textContent = reason || "—";
}

function render(root, { d, endpoint }, stale) {
  for (const el of root.querySelectorAll("[data-v]")) {
    const k = el.dataset.v;
    if (k === "strip") el.textContent = overviewStrip(d);
    else if (k === "useStrip") el.textContent = useStrip(d);
    else if (k === "emissionsLine") el.textContent = d.emissionsLine;
    else if (k === "paramTimelock") el.textContent = d.paramTimelockHours === null ? "—" : `${d.paramTimelockHours} hours`;
    else if (k === "upgradeTimelock") el.textContent = d.upgradeTimelockDays === null ? "—" : `${d.upgradeTimelockDays} days`;
    else if (k === "backlog") el.textContent = d.backlog ? (d.backlog.count === 0 ? "0, up to date" : String(d.backlog.count)) : "—";
    else el.textContent = d[k] ?? "—";
  }
  for (const el of root.querySelectorAll("[data-snapshot]")) el.textContent = snapshotLine(d, endpoint, stale);
}

document.addEventListener("DOMContentLoaded", () => {
  const root = document.querySelector("[data-live]");
  if (!root) return;
  refresh(root);
  setInterval(() => refresh(root), REFRESH_MS);
  window.addEventListener("focus", () => refresh(root));
});
