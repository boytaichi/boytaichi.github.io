// prospereum.io — shared browser glue for the Overview strip and the Protocol live block (read-only; spec v6 §6 rules).
// Same endpoint order, chainId check, one eth_blockNumber per refresh, every eth_call pinned to that block, 60 s refresh,
// "Stale — last successful snapshot" on failure. Pages declare their getters with `data-live-keys="overview|protocol|use"`.
// Endpoint fallback (Kin PR #1 finding 3): the complete pinned-block snapshot is attempted per endpoint (shared/rpc.mjs);
// an undecodable getter result fails the snapshot for that endpoint (round 2 #2) — "—" only when every endpoint failed.
import { CHAIN_ID_HEX, ENDPOINTS, REFRESH_MS } from "../token/config.js";
import { deriveSubset, keysForPage, overviewStrip, partnerListLine, snapshotLine, subsetCalls, useStrip } from "./live-logic.mjs";
import { makeRpc, readCalls, withFallback } from "./rpc.mjs";

let last = null;
const rpc = makeRpc((...a) => fetch(...a));

function keysFor(root) {
  return keysForPage(root.dataset.liveKeys || "overview");
}

/** The page's subset snapshot at one block through one endpoint; throws on any failed or undecodable read. */
async function snapshot(endpoint, keys) {
  const { result: bn } = await rpc(endpoint, "eth_blockNumber", []);
  const { result: block } = await rpc(endpoint, "eth_getBlockByNumber", [bn, false]);
  const { results, upstream } = await readCalls(rpc, endpoint, subsetCalls(bn, keys));
  return { d: deriveSubset(results, { block: Number(bn), timestamp: Number(block.timestamp) }), upstream };
}

async function refresh(root) {
  const keys = keysFor(root);
  const got = await withFallback(ENDPOINTS, CHAIN_ID_HEX, rpc, (e) => snapshot(e, keys), (m) => console.warn(m));
  if (!got) return fail(root, "no endpoint completed the snapshot");
  const { endpoint, value: { d, upstream } } = got;
  last = { d, endpoint: upstream ? `${endpoint.name} → ${upstream}` : endpoint.name };
  render(root, last, false);
}

function fail(root, reason) {
  if (last) return render(root, last, true);
  for (const el of root.querySelectorAll("[data-v]")) el.textContent = "—";
  for (const el of root.querySelectorAll("[data-snapshot]")) el.textContent = reason || "—";
  for (const el of document.querySelectorAll("[data-partner-list]")) el.textContent = partnerListLine(null);
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
  // Kin PR #1 finding 9: the partner empty state is rendered from the pinned snapshot (activeVaultCount), never hard-coded.
  for (const el of document.querySelectorAll("[data-partner-list]")) el.textContent = partnerListLine(d);
}

document.addEventListener("DOMContentLoaded", () => {
  const root = document.querySelector("[data-live]");
  if (!root) return;
  refresh(root);
  setInterval(() => refresh(root), REFRESH_MS);
  window.addEventListener("focus", () => refresh(root));
});
