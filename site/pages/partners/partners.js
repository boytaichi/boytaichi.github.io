// prospereum.io — Partners & Developers page browser glue. Plain ES module, read-only, no cookies, no storage.
// Live partner list per spec v4 §1 build rule: getAllVaults() filtered by vaultActive(vault); headline = activeVaultCount().
// One eth_blockNumber per refresh; every eth_call pinned to that block; a failed refresh keeps the last snapshot.
import { ADDR, BASESCAN, CHAIN_ID_HEX, CONTRACTS, ENDPOINTS, FACTORY_GETTERS, REFRESH_MS, VAULT_GETTERS } from "./config.js";
import { decodeAddressArray, decodeBool, decodeUint, livePartnerList, partnersHeadline } from "./partners-logic.mjs";

let rpcId = 1;
let last = null;

async function rpc(endpoint, method, params) {
  const res = await fetch(endpoint.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }) });
  if (!res.ok) throw new Error(`${endpoint.name}: HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`${endpoint.name}: ${j.error.message || "rpc error"}`);
  return j.result;
}
async function pickEndpoint() {
  for (const e of ENDPOINTS) {
    try {
      if ((await rpc(e, "eth_chainId", [])) === CHAIN_ID_HEX) return e;
    } catch (err) {
      console.warn(String(err));
    }
  }
  return null;
}
const call = (e, to, data, block) => rpc(e, "eth_call", [{ to, data }, block]);
const addrWord = (a) => a.slice(2).toLowerCase().padStart(64, "0");

async function refresh() {
  const e = await pickEndpoint();
  if (!e) return fail("wrong network endpoint");
  try {
    const bn = await call_block(e);
    const active = decodeUint(await call(e, ADDR.FACTORY, FACTORY_GETTERS.activeVaultCount, bn));
    const allTime = decodeUint(await call(e, ADDR.FACTORY, FACTORY_GETTERS.vaultCount, bn));
    const maxPartners = decodeUint(await call(e, ADDR.FACTORY, FACTORY_GETTERS.maxPartners, bn));
    let vaults = [];
    if (allTime !== null && allTime > 0n) {
      const all = decodeAddressArray(await call(e, ADDR.FACTORY, FACTORY_GETTERS.getAllVaults, bn)) ?? [];
      const flags = [];
      for (const v of all) flags.push(decodeBool(await call(e, ADDR.FACTORY, FACTORY_GETTERS.vaultActive + addrWord(v), bn)) === true);
      vaults = livePartnerList(all, flags);
    }
    const rows = [];
    for (const v of vaults) {
      const eco = decodeUint(await call(e, v, VAULT_GETTERS.ecosystemBalance, bn));
      const cvs = decodeUint(await call(e, v, VAULT_GETTERS.getCustomerVaultCount, bn));
      rows.push({ vault: v, eco, cvs });
    }
    last = { bn, active, allTime, maxPartners, rows, endpoint: e.name, at: new Date() };
    render(last, false);
  } catch (err) {
    console.warn(String(err));
    fail(String(err));
  }
}
async function call_block(e) {
  return rpc(e, "eth_blockNumber", []);
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
