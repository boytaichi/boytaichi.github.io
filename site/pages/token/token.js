// prospereum.io — Token page browser glue (spec v6 §6). Plain ES module, no bundler, no cookies, no storage.
// One eth_blockNumber per refresh; every eth_call pinned to that block; a failed refresh keeps the last snapshot ("Stale — …").
import { ADDR, BASESCAN, CHAIN_ID_HEX, ENDPOINTS, REFRESH_MS } from "./config.js";
import { buildCalls, derive, statusCopy } from "./token-logic.mjs";

let last = null; // last complete snapshot { d, endpoint }
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

async function refresh() {
  const endpoint = await pickEndpoint();
  if (!endpoint) return fail("wrong network endpoint");
  try {
    const { result: bn } = await rpc(endpoint, "eth_blockNumber", []);
    const { result: block } = await rpc(endpoint, "eth_getBlockByNumber", [bn, false]);
    const calls = buildCalls(bn);
    const results = {};
    let upstream = null;
    // Sequential calls, one blockTag for all (§6). Multicall3 is optional and the proxy validates it inner by inner.
    for (const c of calls) {
      const { result, upstream: up } = await rpc(endpoint, "eth_call", [{ to: c.to, data: c.data }, c.blockTag]);
      results[c.key] = result;
      if (up) upstream = up;
    }
    const snapshot = { block: Number(bn), timestamp: Number(block.timestamp) };
    const d = derive(results, snapshot);
    if (d.reserveMismatch) console.warn("remainingEmission ≠ remainingMintable", d.reserveMismatch);
    last = { d, endpoint: upstream ? `${endpoint.name} → ${upstream}` : endpoint.name };
    render(last, false);
  } catch (err) {
    console.warn(String(err));
    fail(null);
  }
}

function fail(reason) {
  if (last) return render(last, true);
  for (const el of document.querySelectorAll("[data-v]")) el.textContent = "—";
  document.getElementById("snapshot").textContent = reason || "—";
}

function link(addr) {
  const a = document.createElement("a");
  a.href = BASESCAN + addr;
  a.rel = "noopener";
  a.textContent = addr;
  return a;
}

function render({ d, endpoint }, stale) {
  const set = (k, v) => { const el = document.querySelector(`[data-v="${k}"]`); if (el) el.textContent = v; };
  for (const k of ["totalSupply", "released", "maxSupply", "reserveRemaining", "reserveSize", "treasury", "founder", "partnersLive", "vaultsAllTime", "poolBalance", "poolFee", "partnerShare", "stakerShare", "psreSplit", "lpSplit", "staked", "scarcityCap", "epoch", "epochDuration", "epochStart", "epochEnd", "lastFinalized", "engineStatus", "transfers", "upgrade"]) set(k, d[k]);
  set("backlog", d.backlog ? (d.backlog.count === 0 ? "0, up to date" : String(d.backlog.count)) : "—");
  set("backlogRange", d.backlog && d.backlog.range ? `epochs ${d.backlog.range[0]}–${d.backlog.range[1]}` : "");
  const snap = `Block ${d.snapshot.block.toLocaleString("en-US")}, ${new Date(d.snapshot.timestamp * 1000).toISOString().slice(11, 16)} UTC · via ${endpoint}`;
  for (const el of document.querySelectorAll("[data-snapshot]")) el.textContent = stale ? `Stale — last successful snapshot: block ${d.snapshot.block.toLocaleString("en-US")}, ${new Date(d.snapshot.timestamp * 1000).toISOString().replace("T", " ").slice(0, 16)} UTC` : snap;
  document.getElementById("statusCopy").textContent = statusCopy(d);
  set("paramTimelock", d.paramTimelockHours === null ? "—" : `${d.paramTimelockHours} hours`);
  set("upgradeTimelock", d.upgradeTimelockDays === null ? "—" : `${d.upgradeTimelockDays} days`);
  const q = document.getElementById("queued");
  q.textContent = d.queued.length ? d.queued.map((x) => `${x.group}: ${x.value} ready ${new Date(Number(x.readyAt) * 1000).toISOString().replace("T", " ").slice(0, 16)} UTC`).join("; ") : "";
  q.closest("tr").hidden = d.queued.length === 0;
  // countdown from the snapshot timestamp, not the client clock (§6)
  const cd = document.getElementById("countdown");
  if (d.nextBoundarySeconds !== null) {
    const s = Math.max(0, d.nextBoundarySeconds);
    cd.textContent = `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h ${Math.floor((s % 3600) / 60)}m after the snapshot block`;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const addrs = document.getElementById("addresses");
  for (const [label, key] of [["PSRE token", "PSRE"], ["PartnerVaultFactory", "FACTORY"], ["StakingVault", "STAKING_VAULT"], ["RewardEngine proxy", "REWARD_ENGINE"], ["Uniswap v3 pool (PSRE/USDC)", "POOL"], ["Founder Safe (2-of-3)", "FOUNDER_SAFE"]]) {
    const li = document.createElement("li");
    li.append(`${label}: `, link(ADDR[key]));
    addrs.append(li);
  }
  refresh();
  setInterval(refresh, REFRESH_MS);
  window.addEventListener("focus", refresh);
});
