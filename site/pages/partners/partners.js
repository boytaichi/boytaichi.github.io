// prospereum.io — Partners & Developers page browser glue. Plain ES module, read-only, no cookies, no storage.
// Live partner list per spec v4 §1 build rule: getAllVaults() filtered by vaultActive(vault); headline = activeVaultCount().
// One eth_blockNumber per refresh; every eth_call pinned to that block; a failed refresh keeps the last snapshot.
// Endpoint fallback (Kin PR #1 finding 3): the complete pinned-block snapshot is attempted per endpoint (shared/rpc.mjs);
// an undecodable factory / vault result fails the snapshot for that endpoint (round 2 #2), never a partial list.
// Call shapes come from partners-logic.mjs (factoryCalls / vaultActiveCall / vaultCalls) — the same builders the Worker
// integration test replays, so the page can only call what the Worker admits (finding 2).
import { ADDR, BASESCAN, CHAIN_ID_HEX, CONTRACTS, ENDPOINTS, REFRESH_MS } from "./config.js";
import { decodeAddressArray, decodeBool, decodeUint, factoryCalls, livePartnerList, partnersHeadline, vaultActiveCall, vaultCalls } from "./partners-logic.mjs";
import { RpcError, makeRpc, readCalls, withFallback } from "../shared/rpc.mjs";

let last = null;
const rpc = makeRpc((...a) => fetch(...a));
/** One call through readCalls: the result must decode (round 2 #2) or the snapshot throws. */
const call = async (e, c) => (await readCalls(rpc, e, [c])).results[c.key];

/** The whole Partners page snapshot at one block through one endpoint; throws on any failed or undecodable read. */
async function snapshot(e) {
  const { result: bn } = await rpc(e, "eth_blockNumber", []);
  const { results: f } = await readCalls(rpc, e, factoryCalls(bn));
  const active = decodeUint(f.activeVaultCount);
  const allTime = decodeUint(f.vaultCount);
  const maxPartners = decodeUint(f.maxPartners);
  let vaults = [];
  if (allTime !== null && allTime > 0n) {
    const all = decodeAddressArray(f.getAllVaults);
    if (all === null) throw new RpcError(e, "undecodable", "getAllVaults: address[] did not decode");
    const flags = [];
    for (const v of all) flags.push(decodeBool(await call(e, vaultActiveCall(v, bn))) === true);
    vaults = livePartnerList(all, flags);
  }
  const rows = [];
  for (const v of vaults) {
    const { results: r } = await readCalls(rpc, e, vaultCalls(v, bn));
    rows.push({ vault: v, eco: decodeUint(r.ecosystemBalance), cvs: decodeUint(r.getCustomerVaultCount) });
  }
  return { bn, active, allTime, maxPartners, rows };
}

async function refresh() {
  const got = await withFallback(ENDPOINTS, CHAIN_ID_HEX, rpc, snapshot, (m) => console.warn(m));
  if (!got) return fail("no endpoint completed the snapshot");
  last = { ...got.value, endpoint: got.endpoint.name, at: new Date() };
  render(last, false);
}

const fmt18 = (x) => (x === null ? "—" : (x / 10n ** 18n).toLocaleString("en-US"));
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function render(s, stale) {
  const q = (sel) => document.querySelector(sel);
  q("#headline").textContent = partnersHeadline(s.active);
  q("#activeCount").textContent = s.active === null ? "—" : s.active.toString();
  q("#allTime").textContent = s.allTime === null ? "—" : s.allTime.toString();
  q("#maxPartners").textContent = s.maxPartners === null ? "—" : s.maxPartners.toString();
  const list = q("#partners");
  list.replaceChildren();
  if (s.rows.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "No partner vault is live yet. Prospereum went live on 22 April 2026, and the first partner integrations are being built now.";
    list.append(li);
  }
  for (const r of s.rows) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = BASESCAN + r.vault;
    a.rel = "noopener";
    a.textContent = short(r.vault);
    li.append("PartnerVault ", a, ` · ecosystem balance ${fmt18(r.eco)} PSRE · ${r.cvs === null ? "—" : r.cvs} customer vaults`);
    list.append(li);
  }
  for (const el of document.querySelectorAll("[data-snapshot]")) {
    el.textContent = `${stale ? "Stale — last successful snapshot: " : ""}block ${BigInt(s.bn).toString()} · ${s.at.toISOString().replace("T", " ").slice(0, 19)} UTC · via ${s.endpoint}`;
  }
}
function fail(msg) {
  if (last) return render(last, true);
  for (const el of document.querySelectorAll("[data-snapshot]")) el.textContent = `Unavailable — ${msg}`;
}

function renderContracts() {
  const tb = document.querySelector("#contracts tbody");
  for (const c of CONTRACTS) {
    const tr = document.createElement("tr");
    const addr = ADDR[c.key];
    const a = document.createElement("a");
    a.href = BASESCAN + addr;
    a.rel = "noopener";
    a.textContent = "BaseScan";
    const tdName = document.createElement("td");
    tdName.textContent = c.name;
    const tdAddr = document.createElement("td");
    tdAddr.className = "mono";
    tdAddr.textContent = addr;
    const tdSrc = document.createElement("td");
    tdSrc.textContent = c.source;
    const tdLink = document.createElement("td");
    tdLink.append(a);
    tr.append(tdName, tdAddr, tdSrc, tdLink);
    tb.append(tr);
  }
}

renderContracts();
refresh();
setInterval(refresh, REFRESH_MS);
addEventListener("focus", refresh);
