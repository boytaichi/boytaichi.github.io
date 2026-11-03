/**
 * prospereum.io RPC proxy — Cloudflare Worker (module syntax, no dependencies).
 * Baseline: Site Decision Sheet v2 (2026-10-25) row 2; Token page spec v6 §6; Kin's acceptance tests (2026-10-25).
 *
 * Rules implemented (sheet v2 row 2):
 *  (a) methods eth_call, eth_chainId, eth_blockNumber, eth_getBlockByNumber only
 *  (b) eth_call allowlisted by contract address AND 4-byte selector; Multicall3 aggregate/aggregate3/tryAggregate
 *      decoded and every inner (target, selector) validated against the same allowlist
 *  (c) eth_call requires an explicit block tag (hex number or {blockHash}); "latest"/"pending"/"safe"/"finalized"
 *      are rejected, so a stale "latest" can never be cached
 *      eth_getBlockByNumber: concrete hex number only, header-only (second param === false)
 *  (d) cache key = normalized method + params, JSON-RPC id excluded; caller's id preserved; 60 s TTL
 *  (e) upstream identity in the `X-Prospereum-Upstream` response header (exposed via CORS), JSON-RPC body untouched
 *  (f) CORS restricted to the site origin; per-IP rate limit; provider URL / key never logged
 *  Kin #1: JSON-RPC batches are rejected (one request per call) — simplest of the two permitted options.
 *
 * Bindings (wrangler.toml): UPSTREAM_URL (secret, set by Jason), UPSTREAM_NAME (plain text shown to the page),
 * SITE_ORIGIN (e.g. https://prospereum.io), RATE_LIMITER (Cloudflare rate-limiting binding, optional),
 * CACHE_TTL_SECONDS (default 60).
 */

export const ALLOWED_METHODS = new Set(["eth_call", "eth_chainId", "eth_blockNumber", "eth_getBlockByNumber"]);

// Base mainnet, addresses from Token page spec v6 §3/§6 and SDK spec v4. Lower-cased for comparison.
export const CONTRACTS = {
  PSRE: "0x2fe08f304f1af799bc29e3d4e210973291d96702",
  REWARD_ENGINE: "0x9ab37fc6d01b85491ed0863b7f832784be717ef5",
  FACTORY: "0xff84408633f79b8f562314cc5a3bcaeda8f76902",
  STAKING_VAULT: "0x684bea07e979cb5925d546b2e2099aa1c632ed2d",
  POOL: "0x0adc6be14e76b89584216fad4e458df5f996d336",
  MULTICALL3: "0xca11bde05977b3631167028862be2a173976ca11",
};

// Selector allowlist per contract (first four bytes of keccak-256 of the signature; values as confirmed in spec v6).
export const ALLOWLIST = {
  [CONTRACTS.PSRE]: new Set([
    "0x18160ddd", // totalSupply()
    "0x32cb6b0c", // MAX_SUPPLY()
    "0x70a08231", // balanceOf(address)
    "0xf76e95e5", // remainingMintable()
    "0x01ee7232", // EMISSION_RESERVE()
  ]),
  [CONTRACTS.REWARD_ENGINE]: new Set([
    "0x2bc80f3a", // T()
    "0xb547df86", // remainingEmission()
    "0xdebb48da", // S_EMISSION()
    "0xa70b9f0c", // EPOCH_DURATION()
    "0xeacdc5ff", // currentEpochId()
    "0xcacf66ab", // genesisTimestamp()
    "0xc5a3f907", // lastFinalizedEpoch()
    "0xe1005d67", // firstEpochFinalized()
    "0xcf2369b5", // partnerSplit()
    "0x156ea9c4", // psreSplit()
    "0x6e0a0c8a", // lpSplit()
    "0x1de19349", // PARAM_TIMELOCK()
    "0x25ed32ca", // UPGRADE_TIMELOCK()
  ]),
  [CONTRACTS.FACTORY]: new Set([
    "0xda5ef232", // activeVaultCount()
    "0xa7c6a100", // vaultCount()
  ]),
  [CONTRACTS.POOL]: new Set([
    "0xddca3f43", // fee()
  ]),
};

// Multicall3 selectors whose calldata is decoded and validated inner by inner.
const MULTICALL_SELECTORS = {
  "0x252dba42": "aggregate", // aggregate((address,bytes)[])
  "0x82ad56cb": "aggregate3", // aggregate3((address,bool,bytes)[])
  "0xbce38bd7": "tryAggregate", // tryAggregate(bool,(address,bytes)[])
};

const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;
const JSONRPC_SERVER_ERROR = -32000;

const HEX_QUANTITY = /^0x([1-9a-f][0-9a-f]*|0)$/;
const HEX_HASH = /^0x[0-9a-f]{64}$/;
const HEX_ADDRESS = /^0x[0-9a-f]{40}$/;

export function rpcError(id, code, message, status = 400) {
  return { status, body: { jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message } } };
}

/** Validate one JSON-RPC request. Returns { ok: true, normalized } or { ok: false, error }. */
export function validateRequest(req) {
  if (Array.isArray(req)) return { ok: false, error: rpcError(null, JSONRPC_INVALID_REQUEST, "batch requests are not accepted; send one request per call") };
  if (!req || typeof req !== "object") return { ok: false, error: rpcError(null, JSONRPC_INVALID_REQUEST, "invalid request") };
  const { id, method, params } = req;
  if (typeof method !== "string" || !ALLOWED_METHODS.has(method)) return { ok: false, error: rpcError(id, JSONRPC_METHOD_NOT_FOUND, "method not allowed") };
  const p = Array.isArray(params) ? params : [];

  if (method === "eth_chainId" || method === "eth_blockNumber") {
    if (p.length !== 0) return { ok: false, error: rpcError(id, JSONRPC_INVALID_PARAMS, `${method} takes no params`) };
    return { ok: true, normalized: { method, params: [] } };
  }

  if (method === "eth_getBlockByNumber") {
    // Kin #2: concrete block number only, header only.
    if (p.length !== 2) return { ok: false, error: rpcError(id, JSONRPC_INVALID_PARAMS, "eth_getBlockByNumber needs [blockNumber, false]") };
    const [block, full] = p;
    if (typeof block !== "string" || !HEX_QUANTITY.test(block.toLowerCase())) {
      return { ok: false, error: rpcError(id, JSONRPC_INVALID_PARAMS, "block must be a concrete hex number (no latest/pending/safe/finalized/earliest)") };
    }
    if (full !== false) return { ok: false, error: rpcError(id, JSONRPC_INVALID_PARAMS, "full transaction objects are not served (second param must be false)") };
    return { ok: true, normalized: { method, params: [block.toLowerCase(), false] } };
  }

  // eth_call
  if (p.length !== 2) return { ok: false, error: rpcError(id, JSONRPC_INVALID_PARAMS, "eth_call needs [callObject, blockTag]") };
  const [call, tag] = p;
  if (!call || typeof call !== "object") return { ok: false, error: rpcError(id, JSONRPC_INVALID_PARAMS, "call object required") };
  const to = typeof call.to === "string" ? call.to.toLowerCase() : "";
  const data = typeof call.data === "string" ? call.data.toLowerCase() : typeof call.input === "string" ? call.input.toLowerCase() : "";
  if (!HEX_ADDRESS.test(to) || !/^0x([0-9a-f]{2})*$/.test(data) || data.length < 10) return { ok: false, error: rpcError(id, JSONRPC_INVALID_PARAMS, "call needs a `to` address and 4-byte selector in `data`") };
  for (const k of Object.keys(call)) if (!["to", "data", "input", "from"].includes(k)) return { ok: false, error: rpcError(id, JSONRPC_INVALID_PARAMS, `call field not accepted: ${k}`) };
  if (call.from !== undefined && call.from !== "0x0000000000000000000000000000000000000000") return { ok: false, error: rpcError(id, JSONRPC_INVALID_PARAMS, "from must be absent or the zero address") };

  const blockTag = normalizeBlockTag(tag);
  if (!blockTag) return { ok: false, error: rpcError(id, JSONRPC_INVALID_PARAMS, "eth_call needs an explicit block number (hex) or {blockHash}; latest/pending/safe/finalized are not served") };

  const inner = decodeCalls(to, data);
  if (!inner.ok) return { ok: false, error: rpcError(id, JSONRPC_INVALID_PARAMS, inner.reason) };
  for (const { target, selector } of inner.calls) {
    const allowed = ALLOWLIST[target];
    if (!allowed || !allowed.has(selector)) return { ok: false, error: rpcError(id, JSONRPC_INVALID_PARAMS, `call not allowed: ${target} ${selector}`) };
  }
  return { ok: true, normalized: { method, params: [{ to, data }, blockTag] } };
}

function normalizeBlockTag(tag) {
  if (typeof tag === "string") {
    const t = tag.toLowerCase();
    return HEX_QUANTITY.test(t) ? t : null;
  }
  if (tag && typeof tag === "object") {
    if (typeof tag.blockHash === "string" && HEX_HASH.test(tag.blockHash.toLowerCase()) && Object.keys(tag).every((k) => k === "blockHash" || k === "requireCanonical")) {
      return { blockHash: tag.blockHash.toLowerCase() };
    }
    if (typeof tag.blockNumber === "string" && HEX_QUANTITY.test(tag.blockNumber.toLowerCase()) && Object.keys(tag).length === 1) return tag.blockNumber.toLowerCase();
  }
  return null;
}

/** Expand a call into the list of (target, selector) pairs it executes: itself, or every inner call of a Multicall3 aggregate. */
export function decodeCalls(to, data) {
  const selector = data.slice(0, 10);
  if (to !== CONTRACTS.MULTICALL3) return { ok: true, calls: [{ target: to, selector }] };
  const kind = MULTICALL_SELECTORS[selector];
  if (!kind) return { ok: false, reason: `Multicall3 function not allowed: ${selector}` };
  try {
    const calls = kind === "aggregate3" ? decodeAggregate3(data) : kind === "tryAggregate" ? decodeAggregate(data, 1) : decodeAggregate(data, 0);
    if (calls.length === 0) return { ok: false, reason: "empty multicall" };
    for (const c of calls) if (c.target === CONTRACTS.MULTICALL3) return { ok: false, reason: "nested multicall not allowed" };
    return { ok: true, calls };
  } catch (e) {
    return { ok: false, reason: `multicall calldata malformed: ${e.message}` };
  }
}

// --- minimal ABI decoding (words of 32 bytes) -------------------------------------------------------------
function words(data) {
  const hex = data.slice(10); // strip selector
  if (hex.length % 64 !== 0) throw new Error("not word-aligned");
  return { hex, word: (i) => hex.slice(i * 64, i * 64 + 64) };
}
const toInt = (w) => {
  const n = BigInt("0x" + w);
  if (n > 0xffffffffn) throw new Error("offset too large");
  return Number(n);
};
/** aggregate((address target, bytes callData)[]) — tuple array at head position `headIndex`. */
function decodeAggregate(data, headIndex) {
  const { word } = words(data);
  const arrOffset = toInt(word(headIndex)) / 32;
  const len = toInt(word(arrOffset));
  const base = arrOffset + 1;
  const out = [];
  for (let i = 0; i < len; i++) {
    const tupleOffset = base + toInt(word(base + i)) / 32;
    const target = "0x" + word(tupleOffset).slice(24);
    const bytesOffset = tupleOffset + toInt(word(tupleOffset + 1)) / 32;
    const bytesLen = toInt(word(bytesOffset));
    if (bytesLen < 4) throw new Error("inner calldata shorter than a selector");
    const selector = "0x" + word(bytesOffset + 1).slice(0, 8);
    out.push({ target, selector });
  }
  return out;
}
/** aggregate3((address target, bool allowFailure, bytes callData)[]) */
function decodeAggregate3(data) {
  const { word } = words(data);
  const arrOffset = toInt(word(0)) / 32;
  const len = toInt(word(arrOffset));
  const base = arrOffset + 1;
  const out = [];
  for (let i = 0; i < len; i++) {
    const tupleOffset = base + toInt(word(base + i)) / 32;
    const target = "0x" + word(tupleOffset).slice(24);
    const bytesOffset = tupleOffset + toInt(word(tupleOffset + 2)) / 32;
    const bytesLen = toInt(word(bytesOffset));
    if (bytesLen < 4) throw new Error("inner calldata shorter than a selector");
    const selector = "0x" + word(bytesOffset + 1).slice(0, 8);
    out.push({ target, selector });
  }
  return out;
}

/** Cache key from the normalized request — the JSON-RPC id is not part of it (rule d). */
export function cacheKey(normalized) {
  return JSON.stringify([normalized.method, normalized.params]);
}

export function corsHeaders(origin, siteOrigin) {
  const h = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Expose-Headers": "X-Prospereum-Upstream, X-Prospereum-Cache",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin && origin === siteOrigin) h["Access-Control-Allow-Origin"] = siteOrigin;
  return h;
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}

/**
 * Handle one request. `deps` lets tests inject the upstream fetch and a cache; in production both come from the platform.
 * Returns a Response; the upstream URL and key never appear in any response, log line or error message.
 */
export async function handle(request, env, deps = {}) {
  const siteOrigin = env.SITE_ORIGIN;
  const origin = request.headers.get("origin") || "";
  const cors = corsHeaders(origin, siteOrigin);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return json({ error: "POST only" }, 405, cors);
  if (origin && origin !== siteOrigin) return json({ error: "origin not allowed" }, 403, cors);

  if (env.RATE_LIMITER) {
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    if (!success) return json(rpcError(null, JSONRPC_SERVER_ERROR, "rate limited").body, 429, { ...cors, "retry-after": "10" });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(rpcError(null, -32700, "parse error").body, 400, cors);
  }
  const v = validateRequest(body);
  if (!v.ok) return json(v.error.body, v.error.status, cors);
  const id = body.id === undefined ? null : body.id;
  const key = cacheKey(v.normalized);
  const ttl = Number(env.CACHE_TTL_SECONDS || 60);
  const cache = deps.cache ?? new MemoryCache();
  const upstreamName = env.UPSTREAM_NAME || "upstream";

  const cached = await cache.get(key);
  if (cached) {
    return json({ jsonrpc: "2.0", id, ...cached }, 200, { ...cors, "X-Prospereum-Upstream": upstreamName, "X-Prospereum-Cache": "HIT" });
  }

  const upstreamFetch = deps.fetch ?? fetch;
  let up;
  try {
    const r = await upstreamFetch(env.UPSTREAM_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: v.normalized.method, params: v.normalized.params }),
    });
    up = await r.json();
  } catch {
    // Deliberately no detail: the upstream URL must never reach a log line or a response.
    return json(rpcError(id, JSONRPC_SERVER_ERROR, "upstream unavailable").body, 502, { ...cors, "X-Prospereum-Upstream": upstreamName });
  }
  const payload = up && up.error ? { error: up.error } : { result: up ? up.result : null };
  if (!up?.error) await cache.put(key, payload, ttl);
  return json({ jsonrpc: "2.0", id, ...payload }, 200, { ...cors, "X-Prospereum-Upstream": upstreamName, "X-Prospereum-Cache": "MISS" });
}

/** Tiny in-memory cache (per isolate). Production may swap in the Cache API or KV via deps.cache with the same get/put. */
export class MemoryCache {
  constructor(now = () => Date.now()) {
    this.map = new Map();
    this.now = now;
  }
  async get(key) {
    const e = this.map.get(key);
    if (!e) return null;
    if (e.expires <= this.now()) {
      this.map.delete(key);
      return null;
    }
    return e.value;
  }
  async put(key, value, ttlSeconds) {
    this.map.set(key, { value, expires: this.now() + ttlSeconds * 1000 });
  }
}

const isolateCache = new MemoryCache();

export default {
  async fetch(request, env) {
    return handle(request, env, { cache: isolateCache });
  },
};
