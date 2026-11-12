/**
 * prospereum.io RPC proxy — Cloudflare Worker (module syntax, no dependencies).
 * Baseline: Site Decision Sheet v2 (2026-10-25) row 2; Token page spec v6 §6; Kin's acceptance tests (2026-10-25);
 * Kin's PR #1 review (2026-11-11/12) findings 2, 4, 6, 7, 8, 11; round 2 (2026-11-12) findings 1, 5, 6, 7, 8.
 *
 * Rules implemented (sheet v2 row 2):
 *  (a) methods eth_call, eth_chainId, eth_blockNumber, eth_getBlockByNumber only
 *  (b) eth_call allowlisted by contract address AND 4-byte selector; Multicall3 aggregate/aggregate3/tryAggregate
 *      decoded and every inner (target, selector) validated against the same allowlist
 *      — the allowlist is DERIVED from the pages' own call manifest (pages/shared/call-manifest.mjs), so the Worker
 *        admits exactly what the pages call (Kin #2). Dynamic PartnerVault targets are admitted for the per-vault
 *        selectors only after an upstream factory.vaultActive(target) read at the same pinned block says true
 *        (short bounded cache of verdicts keyed by (vault, blockTag) — round 2 #1); arbitrary addresses are never admitted.
 *      — calldata must be exactly 4 + 32·n bytes for the selector's n argument words (manifest annotation; round 2 #5):
 *        trailing bytes are rejected, direct and inside a Multicall.
 *  (c) eth_call requires an explicit block tag (hex number or {blockHash}); "latest"/"pending"/"safe"/"finalized"
 *      are rejected, so a stale "latest" can never be cached; EIP-1898 requireCanonical is rejected (Kin #8)
 *      eth_getBlockByNumber: concrete hex number only, header-only (second param === false)
 *  (d) cache key = method + SHA-256 of the normalized params, JSON-RPC id excluded; caller's id preserved; bounded
 *      LRU cache (Kin #4); only validated upstream results are cached (Kin #7)
 *  (e) upstream identity in the `X-Prospereum-Upstream` response header (exposed via CORS), JSON-RPC body untouched
 *  (f) CORS restricted to the site origin; POST /rpc REQUIRES an Origin header equal to SITE_ORIGIN (originless or
 *      foreign → 403; round 2 #6; GET …/health stays originless); per-IP rate limit MANDATORY in production (fail
 *      closed without the binding unless DEV_ALLOW_NO_RATE_LIMIT="true"); provider URL / key never logged
 *  Limits (Kin #4): request body ≤ MAX_BODY_BYTES counted in BYTES — Content-Length first, then a byte-counting read
 *      of the body stream that aborts past the limit (round 2 #8); direct calldata ≤ MAX_CALLDATA_BYTES; Multicall
 *      calldata ≤ MAX_MULTICALL_CALLDATA_BYTES with ≤ MAX_INNER_CALLS inner calls of ≤ MAX_INNER_CALLDATA_BYTES each.
 *  Bindings (Kin #6): SITE_ORIGIN, UPSTREAM_URL, CACHE_TTL_SECONDS, RATE_LIMITER are validated on every request;
 *      a bad binding answers 503 with a fixed public message and nothing else. GET …/health probes config +
 *      one allowed and one rejected call shape without touching the upstream.
 *  Upstream (Kin #7, round 2 #7): timeout, HTTP status check, JSON-RPC envelope validation (jsonrpc === "2.0",
 *      response id === the id we sent, exactly one of result/error, error = { integer code, string message }),
 *      per-method result validation, fixed public error messages; an envelope mismatch is 502 and never cached;
 *      nothing from the upstream reaches a response except a validated result or a sanitised error.
 *  Request envelope (round 2 #7; round 3 #4): `jsonrpc` must be "2.0" and the envelope may carry ONLY `jsonrpc`,
 *      `id`, `method`, `params` (any other member → -32600); `params` must be absent or an array — absent only for the
 *      no-param methods; an object / string / number / null `params` → -32602 (never coerced to []).
 *  Allowlist rejection → HTTP 400 with JSON-RPC -32602 (Kin #11: DEPLOY.md aligned to this).
 *  Kin #1 (2026-10-25): JSON-RPC batches are rejected (one request per call).
 */
import { CONTRACTS, FACTORY_REGISTRY, STATIC_ALLOWLIST, VAULT_SELECTORS, addrWord, calldataBytesFor, classifyCall } from "../../pages/shared/call-manifest.mjs";

export { CONTRACTS, STATIC_ALLOWLIST, VAULT_SELECTORS };
/** @deprecated name kept for older imports; the allowlist is derived from the page manifest. */
export const ALLOWLIST = STATIC_ALLOWLIST;

export const ALLOWED_METHODS = new Set(["eth_call", "eth_chainId", "eth_blockNumber", "eth_getBlockByNumber"]);

// --- limits (Kin #4) ------------------------------------------------------------------------------------------
export const LIMITS = Object.freeze({
  MAX_BODY_BYTES: 64 * 1024, // the largest page request (33-call aggregate) is ~11 KB
  MAX_CALLDATA_BYTES: 4 + 32 * 8, // a direct getter: selector + up to 8 words
  MAX_MULTICALL_CALLDATA_BYTES: 32 * 1024,
  MAX_INNER_CALLS: 64,
  MAX_INNER_CALLDATA_BYTES: 4 + 32 * 8,
  MAX_CACHE_ENTRIES: 1024,
  MAX_VAULT_CACHE_ENTRIES: 256,
  VAULT_VERDICT_TTL_SECONDS: 60,
  UPSTREAM_TIMEOUT_MS: 10_000,
  MAX_CACHE_TTL_SECONDS: 3600,
});

// Multicall3 selectors whose calldata is decoded and validated inner by inner.
const MULTICALL_SELECTORS = {
  "0x252dba42": "aggregate", // aggregate((address,bytes)[])
  "0x82ad56cb": "aggregate3", // aggregate3((address,bool,bytes)[])
  "0xbce38bd7": "tryAggregate", // tryAggregate(bool,(address,bytes)[])
};

const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;
const JSONRPC_SERVER_ERROR = -32000;

const HEX_QUANTITY = /^0x([1-9a-f][0-9a-f]*|0)$/;
const HEX_HASH = /^0x[0-9a-f]{64}$/;
const HEX_ADDRESS = /^0x[0-9a-f]{40}$/;
const HEX_BYTES = /^0x([0-9a-f]{2})*$/;

/** Fixed public messages (Kin #6/#7): nothing variable from the environment or the upstream is ever interpolated. */
export const PUBLIC_ERRORS = Object.freeze({
  MISCONFIGURED: "service misconfigured",
  UPSTREAM_UNAVAILABLE: "upstream unavailable",
  UPSTREAM_INVALID: "upstream returned an invalid response",
  UPSTREAM_RPC_ERROR: "upstream rpc error",
  EXECUTION_REVERTED: "execution reverted",
  RATE_LIMITED: "rate limited",
  BODY_TOO_LARGE: "request body too large",
  ORIGIN_NOT_ALLOWED: "origin not allowed",
});

export function rpcError(id, code, message, status = 400) {
  return { status, body: { jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message } } };
}

// --- bindings (Kin #6) -----------------------------------------------------------------------------------------
/**
 * Validate the bindings the Worker depends on. Returns { ok: true, config } or { ok: false }.
 * Deliberately returns no reason: the public response must not say which binding is wrong (operators read wrangler).
 */
export function validateEnv(env) {
  if (!env || typeof env !== "object") return { ok: false };
  const siteOrigin = typeof env.SITE_ORIGIN === "string" ? env.SITE_ORIGIN : "";
  let origin;
  try {
    const u = new URL(siteOrigin);
    if (!/^https?:$/.test(u.protocol) || u.origin !== siteOrigin) return { ok: false };
    origin = u.origin;
  } catch {
    return { ok: false };
  }
  try {
    const u = new URL(typeof env.UPSTREAM_URL === "string" ? env.UPSTREAM_URL : "");
    if (!/^https?:$/.test(u.protocol)) return { ok: false };
  } catch {
    return { ok: false };
  }
  const ttlRaw = env.CACHE_TTL_SECONDS === undefined ? "60" : env.CACHE_TTL_SECONDS;
  if (!/^\d{1,4}$/.test(String(ttlRaw))) return { ok: false };
  const ttl = Number(ttlRaw);
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > LIMITS.MAX_CACHE_TTL_SECONDS) return { ok: false };
  const devNoRateLimit = env.DEV_ALLOW_NO_RATE_LIMIT === "true";
  const limiter = env.RATE_LIMITER && typeof env.RATE_LIMITER.limit === "function" ? env.RATE_LIMITER : null;
  if (!limiter && !devNoRateLimit) return { ok: false };
  const upstreamName = typeof env.UPSTREAM_NAME === "string" && env.UPSTREAM_NAME.length <= 80 ? env.UPSTREAM_NAME : "upstream";
  return { ok: true, config: { siteOrigin: origin, upstreamUrl: env.UPSTREAM_URL, ttl, limiter, upstreamName } };
}

// --- request validation ---------------------------------------------------------------------------------------
/** The only members a JSON-RPC 2.0 request envelope may carry (round 3 #4): anything else is -32600. */
const REQUEST_MEMBERS = new Set(["jsonrpc", "id", "method", "params"]);
const NO_PARAM_METHODS = new Set(["eth_chainId", "eth_blockNumber"]);

/**
 * Validate one JSON-RPC request. Returns { ok: true, normalized, vaultTargets } or { ok: false, error }.
 * `vaultTargets` lists dynamic PartnerVault addresses that still need factory verification (handle() does that).
 */
export function validateRequest(req) {
  if (Array.isArray(req)) return { ok: false, error: rpcError(null, JSONRPC_INVALID_REQUEST, "batch requests are not accepted; send one request per call") };
  if (!req || typeof req !== "object") return { ok: false, error: rpcError(null, JSONRPC_INVALID_REQUEST, "invalid request") };
  const { id, method, params } = req;
  if (id !== undefined && id !== null && typeof id !== "number" && !(typeof id === "string" && id.length <= 64)) return { ok: false, error: rpcError(null, JSONRPC_INVALID_REQUEST, "id must be a number or a short string") };
  if (req.jsonrpc !== "2.0") return { ok: false, error: rpcError(id, JSONRPC_INVALID_REQUEST, 'jsonrpc must be "2.0"') }; // round 2 #7
  for (const k of Object.keys(req)) if (!REQUEST_MEMBERS.has(k)) return { ok: false, error: rpcError(id, JSONRPC_INVALID_REQUEST, `request member not accepted: ${k.slice(0, 32)}`) }; // round 3 #4
  if (typeof method !== "string" || !ALLOWED_METHODS.has(method)) return { ok: false, error: rpcError(id, JSONRPC_METHOD_NOT_FOUND, "method not allowed") };
  // Round 3 #4: params is absent (no-param methods only) or an array; anything else is -32602, never coerced to [].
  const hasParams = Object.prototype.hasOwnProperty.call(req, "params");
  if (hasParams && !Array.isArray(params)) return { ok: false, error: rpcError(id, JSONRPC_INVALID_PARAMS, "params must be an array") };
  if (!hasParams && !NO_PARAM_METHODS.has(method)) return { ok: false, error: rpcError(id, JSONRPC_INVALID_PARAMS, `${method} needs params`) };
  const p = hasParams ? params : [];

  if (method === "eth_chainId" || method === "eth_blockNumber") {
    if (p.length !== 0) return { ok: false, error: rpcError(id, JSONRPC_INVALID_PARAMS, `${method} takes no params`) };
    return { ok: true, normalized: { method, params: [] }, vaultTargets: [] };
  }

  if (method === "eth_getBlockByNumber") {
    // Kin #2: concrete block number only, header only.
    if (p.length !== 2) return { ok: false, error: rpcError(id, JSONRPC_INVALID_PARAMS, "eth_getBlockByNumber needs [blockNumber, false]") };
    const [block, full] = p;
    if (typeof block !== "string" || block.length > 20 || !HEX_QUANTITY.test(block.toLowerCase())) {
      return { ok: false, error: rpcError(id, JSONRPC_INVALID_PARAMS, "block must be a concrete hex number (no latest/pending/safe/finalized/earliest)") };
    }
    if (full !== false) return { ok: false, error: rpcError(id, JSONRPC_INVALID_PARAMS, "full transaction objects are not served (second param must be false)") };
    return { ok: true, normalized: { method, params: [block.toLowerCase(), false] }, vaultTargets: [] };
  }

  // eth_call
  if (p.length !== 2) return { ok: false, error: rpcError(id, JSONRPC_INVALID_PARAMS, "eth_call needs [callObject, blockTag]") };
  const [call, tag] = p;
  if (!call || typeof call !== "object" || Array.isArray(call)) return { ok: false, error: rpcError(id, JSONRPC_INVALID_PARAMS, "call object required") };
  for (const k of Object.keys(call)) if (!["to", "data", "input", "from"].includes(k)) return { ok: false, error: rpcError(id, JSONRPC_INVALID_PARAMS, `call field not accepted: ${k.slice(0, 32)}`) };
  const to = typeof call.to === "string" && call.to.length === 42 ? call.to.toLowerCase() : "";
  const rawData = typeof call.data === "string" ? call.data : typeof call.input === "string" ? call.input : "";
  if (!HEX_ADDRESS.test(to)) return { ok: false, error: rpcError(id, JSONRPC_INVALID_PARAMS, "call needs a `to` address and 4-byte selector in `data`") };
  // Length limits are checked BEFORE the regex so a huge string costs nothing (Kin #4).
  const maxBytes = to === CONTRACTS.MULTICALL3 ? LIMITS.MAX_MULTICALL_CALLDATA_BYTES : LIMITS.MAX_CALLDATA_BYTES;
  if (rawData.length > 2 + 2 * maxBytes) return { ok: false, error: rpcError(id, JSONRPC_INVALID_PARAMS, "calldata too long") };
  const data = rawData.toLowerCase();
  if (!HEX_BYTES.test(data) || data.length < 10) return { ok: false, error: rpcError(id, JSONRPC_INVALID_PARAMS, "call needs a `to` address and 4-byte selector in `data`") };
  if (call.from !== undefined && call.from !== "0x0000000000000000000000000000000000000000") return { ok: false, error: rpcError(id, JSONRPC_INVALID_PARAMS, "from must be absent or the zero address") };

  const blockTag = normalizeBlockTag(tag);
  if (!blockTag.ok) return { ok: false, error: rpcError(id, JSONRPC_INVALID_PARAMS, blockTag.reason) };

  const inner = decodeCalls(to, data);
  if (!inner.ok) return { ok: false, error: rpcError(id, JSONRPC_INVALID_PARAMS, inner.reason) };
  const vaultTargets = new Set();
  for (const { target, selector, bytes } of inner.calls) {
    const cls = classifyCall(target, selector);
    if (cls !== "static" && cls !== "vault") return { ok: false, error: rpcError(id, JSONRPC_INVALID_PARAMS, `call not allowed: ${target} ${selector}`) };
    // Round 2 #5: exactly 4 + 32·n bytes for the selector's n argument words; trailing bytes are rejected.
    const want = calldataBytesFor(target, selector);
    if (bytes !== want) return { ok: false, error: rpcError(id, JSONRPC_INVALID_PARAMS, `calldata length not allowed: ${selector} takes ${(want - 4) / 32} argument word(s), ${want} bytes`) };
    if (cls === "vault") vaultTargets.add(target);
  }
  return { ok: true, normalized: { method, params: [{ to, data }, blockTag.tag] }, vaultTargets: [...vaultTargets] };
}

function normalizeBlockTag(tag) {
  const bad = (reason) => ({ ok: false, reason });
  if (typeof tag === "string") {
    const t = tag.toLowerCase();
    if (t.length <= 20 && HEX_QUANTITY.test(t)) return { ok: true, tag: t };
    return bad("eth_call needs an explicit block number (hex) or {blockHash}; latest/pending/safe/finalized are not served");
  }
  if (tag && typeof tag === "object" && !Array.isArray(tag)) {
    const keys = Object.keys(tag);
    if (keys.includes("requireCanonical")) return bad("requireCanonical is not served (Kin #8): pin by block number or a plain {blockHash}");
    if (keys.length === 1 && typeof tag.blockHash === "string" && HEX_HASH.test(tag.blockHash.toLowerCase())) return { ok: true, tag: { blockHash: tag.blockHash.toLowerCase() } };
    if (keys.length === 1 && typeof tag.blockNumber === "string" && tag.blockNumber.length <= 20 && HEX_QUANTITY.test(tag.blockNumber.toLowerCase())) return { ok: true, tag: tag.blockNumber.toLowerCase() };
  }
  return bad("eth_call needs an explicit block number (hex) or {blockHash}; latest/pending/safe/finalized are not served");
}

/** Expand a call into the list of (target, selector, bytes) it executes: itself, or every inner call of a Multicall3 aggregate. */
export function decodeCalls(to, data) {
  const selector = data.slice(0, 10);
  if (to !== CONTRACTS.MULTICALL3) return { ok: true, calls: [{ target: to, selector, bytes: (data.length - 2) / 2 }] };
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
  const count = hex.length / 64;
  return {
    hex,
    word: (i) => {
      if (i < 0 || i >= count) throw new Error("offset outside calldata");
      return hex.slice(i * 64, i * 64 + 64);
    },
  };
}
const toInt = (w) => {
  const n = BigInt("0x" + w);
  if (n > 0xffffffffn) throw new Error("offset too large");
  return Number(n);
};
const checkInner = (bytesLen, count) => {
  if (count > LIMITS.MAX_INNER_CALLS) throw new Error(`more than ${LIMITS.MAX_INNER_CALLS} inner calls`);
  if (bytesLen < 4) throw new Error("inner calldata shorter than a selector");
  if (bytesLen > LIMITS.MAX_INNER_CALLDATA_BYTES) throw new Error("inner calldata too long");
};
/** aggregate((address target, bytes callData)[]) — tuple array at head position `headIndex`. */
function decodeAggregate(data, headIndex) {
  const { word } = words(data);
  const arrOffset = toInt(word(headIndex)) / 32;
  const len = toInt(word(arrOffset));
  if (len > LIMITS.MAX_INNER_CALLS) throw new Error(`more than ${LIMITS.MAX_INNER_CALLS} inner calls`);
  const base = arrOffset + 1;
  const out = [];
  for (let i = 0; i < len; i++) {
    const tupleOffset = base + toInt(word(base + i)) / 32;
    const targetWord = word(tupleOffset);
    if (!/^0{24}/.test(targetWord)) throw new Error("target word not an address");
    const target = "0x" + targetWord.slice(24);
    const bytesOffset = tupleOffset + toInt(word(tupleOffset + 1)) / 32;
    const bytesLen = toInt(word(bytesOffset));
    checkInner(bytesLen, len);
    const selector = "0x" + word(bytesOffset + 1).slice(0, 8);
    out.push({ target, selector, bytes: bytesLen });
  }
  return out;
}
/** aggregate3((address target, bool allowFailure, bytes callData)[]) */
function decodeAggregate3(data) {
  const { word } = words(data);
  const arrOffset = toInt(word(0)) / 32;
  const len = toInt(word(arrOffset));
  if (len > LIMITS.MAX_INNER_CALLS) throw new Error(`more than ${LIMITS.MAX_INNER_CALLS} inner calls`);
  const base = arrOffset + 1;
  const out = [];
  for (let i = 0; i < len; i++) {
    const tupleOffset = base + toInt(word(base + i)) / 32;
    const targetWord = word(tupleOffset);
    if (!/^0{24}/.test(targetWord)) throw new Error("target word not an address");
    const target = "0x" + targetWord.slice(24);
    const bytesOffset = tupleOffset + toInt(word(tupleOffset + 2)) / 32;
    const bytesLen = toInt(word(bytesOffset));
    checkInner(bytesLen, len);
    const selector = "0x" + word(bytesOffset + 1).slice(0, 8);
    out.push({ target, selector, bytes: bytesLen });
  }
  return out;
}

// --- cache (Kin #4) --------------------------------------------------------------------------------------------
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Cache key from the normalized request — method + SHA-256 of the params; the JSON-RPC id is not part of it (rule d). */
export async function cacheKey(normalized) {
  return `${normalized.method}:${await sha256Hex(JSON.stringify(normalized.params))}`;
}

/** Bounded in-memory LRU with TTL (per isolate). Production may swap in KV via deps.cache with the same get/put. */
export class MemoryCache {
  constructor(now = () => Date.now(), maxEntries = LIMITS.MAX_CACHE_ENTRIES) {
    this.map = new Map();
    this.now = now;
    this.maxEntries = maxEntries;
  }
  get size() {
    return this.map.size;
  }
  async get(key) {
    const e = this.map.get(key);
    if (!e) return null;
    if (e.expires <= this.now()) {
      this.map.delete(key);
      return null;
    }
    this.map.delete(key); // refresh recency
    this.map.set(key, e);
    return e.value;
  }
  async put(key, value, ttlSeconds) {
    if (this.map.has(key)) this.map.delete(key);
    while (this.map.size >= this.maxEntries) this.map.delete(this.map.keys().next().value); // evict least recently used
    this.map.set(key, { value, expires: this.now() + ttlSeconds * 1000 });
  }
}

// --- upstream (Kin #7) -----------------------------------------------------------------------------------------
function validUpstreamResult(method, result) {
  if (method === "eth_chainId" || method === "eth_blockNumber") return typeof result === "string" && result.length <= 20 && HEX_QUANTITY.test(result);
  if (method === "eth_call") return typeof result === "string" && result.length <= 2 + 2 * 64 * 1024 && HEX_BYTES.test(result);
  if (method === "eth_getBlockByNumber") {
    if (result === null) return true; // unknown block: a legitimate null
    if (!result || typeof result !== "object" || Array.isArray(result)) return false;
    return ["number", "hash", "timestamp", "parentHash"].every((k) => typeof result[k] === "string") && HEX_QUANTITY.test(result.number) && HEX_QUANTITY.test(result.timestamp) && HEX_HASH.test(result.hash);
  }
  return false;
}

/** Only these fields of a block header are forwarded (the page reads `timestamp`); nothing else from upstream passes. */
const BLOCK_FIELDS = ["number", "hash", "parentHash", "timestamp", "baseFeePerGas", "gasLimit", "gasUsed", "miner", "stateRoot", "transactionsRoot", "receiptsRoot"];
function sanitiseBlock(b) {
  if (b === null) return null;
  const out = {};
  for (const k of BLOCK_FIELDS) if (typeof b[k] === "string" && b[k].length <= 66 && /^0x[0-9a-f]*$/i.test(b[k])) out[k] = b[k];
  return out;
}

/** Map a (shape-validated) upstream JSON-RPC error to a fixed public one: the integer code is kept, the message is canned. */
function sanitiseError(e) {
  return { code: e.code, message: /revert/i.test(e.message) ? PUBLIC_ERRORS.EXECUTION_REVERTED : PUBLIC_ERRORS.UPSTREAM_RPC_ERROR };
}

/** JSON-RPC error object shape (round 2 #7): a plain object with an integer `code` and a string `message`. */
function validErrorObject(e) {
  return !!e && typeof e === "object" && !Array.isArray(e) && Number.isInteger(e.code) && typeof e.message === "string";
}

let upstreamIdCounter = 0;
/** A fresh request id per upstream call so the response id can be matched (round 2 #7); wraps well inside 2^53. */
function nextUpstreamId() {
  upstreamIdCounter = (upstreamIdCounter % 1_000_000_000) + 1;
  return upstreamIdCounter;
}

/**
 * One upstream JSON-RPC call. Resolves { ok: true, result } | { ok: true, error } (sanitised) | { ok: false, kind }
 * with kind "unavailable" (network/timeout/HTTP) or "invalid" (shape). Nothing from the upstream is thrown or logged.
 * Envelope (round 2 #7): jsonrpc === "2.0", id === the id sent, exactly one of result/error, error shape — else "invalid".
 */
async function callUpstream(config, method, params, deps) {
  const upstreamFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? LIMITS.UPSTREAM_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const id = nextUpstreamId();
  let text;
  try {
    const r = await upstreamFetch(config.upstreamUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: controller.signal,
    });
    if (!r || r.status !== 200) return { ok: false, kind: "unavailable" };
    text = await r.text();
  } catch {
    return { ok: false, kind: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
  if (typeof text !== "string" || text.length > 256 * 1024) return { ok: false, kind: "invalid" };
  let up;
  try {
    up = JSON.parse(text);
  } catch {
    return { ok: false, kind: "invalid" };
  }
  if (!up || typeof up !== "object" || Array.isArray(up) || up.jsonrpc !== "2.0") return { ok: false, kind: "invalid" };
  if (up.id !== id) return { ok: false, kind: "invalid" }; // response to some other request (or none): never trusted, never cached
  const hasResult = "result" in up;
  const hasError = "error" in up;
  if (hasResult === hasError) return { ok: false, kind: "invalid" }; // exactly one of result / error
  if (hasError) return validErrorObject(up.error) ? { ok: true, error: sanitiseError(up.error) } : { ok: false, kind: "invalid" };
  if (!validUpstreamResult(method, up.result)) return { ok: false, kind: "invalid" };
  return { ok: true, result: method === "eth_getBlockByNumber" ? sanitiseBlock(up.result) : up.result };
}

// --- dynamic PartnerVault verification (Kin #2b; round 2 #1) ----------------------------------------------------
const vaultVerdicts = new MemoryCache(() => Date.now(), LIMITS.MAX_VAULT_CACHE_ENTRIES);

/** Verdict cache key: the vault AND the pinned block (round 2 #1) — a vault decommissioned between blocks is never admitted from a stale verdict. */
export function vaultVerdictKey(vault, blockTag) {
  return `${vault}@${typeof blockTag === "string" ? blockTag : `hash:${blockTag.blockHash}`}`;
}

/**
 * Is `vault` a factory-registered, active PartnerVault at `blockTag`? One upstream eth_call to
 * factory.vaultActive(vault) at the same pinned block; verdicts (true/false) are cached briefly and bounded, keyed by
 * (vault, blockTag) so a verdict from one block never answers for another (round 2 #1).
 * Resolves true | false | null (null = could not verify: upstream unavailable/invalid → the request fails closed).
 */
export async function verifyVault(vault, blockTag, config, deps) {
  const cache = deps.vaultCache ?? vaultVerdicts;
  const key = vaultVerdictKey(vault, blockTag);
  const hit = await cache.get(key);
  if (hit !== null) return hit.active;
  const up = await callUpstream(config, "eth_call", [{ to: FACTORY_REGISTRY.address, data: FACTORY_REGISTRY.vaultActive + addrWord(vault) }, blockTag], deps);
  if (!up.ok || up.error) return null;
  const active = /^0x0{63}1$/.test(up.result);
  await cache.put(key, { active }, LIMITS.VAULT_VERDICT_TTL_SECONDS);
  return active;
}

// --- HTTP -------------------------------------------------------------------------------------------------------
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
 * Read the request body counting BYTES (round 2 #8): Content-Length is checked first (over the limit → rejected before
 * any read), then the stream is consumed chunk by chunk and cancelled the moment the byte count passes `max`.
 * `text().length` (UTF-16 code units) is never used. Resolves { text } | { tooLarge: true } | { unreadable: true }.
 */
export async function readBodyBounded(request, max = LIMITS.MAX_BODY_BYTES) {
  const declared = request.headers.get("content-length");
  if (declared !== null && declared !== "" && (!/^\d{1,15}$/.test(declared) || Number(declared) > max)) return { tooLarge: true };
  if (!request.body) return { text: "" };
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) return { unreadable: true };
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        return { tooLarge: true };
      }
      chunks.push(value);
    }
  } catch {
    return { unreadable: true };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return { text: new TextDecoder("utf-8").decode(bytes) };
}

/** Health probe shapes: one call the pages make, one call the allowlist must refuse. Neither touches the upstream. */
export const HEALTH_PROBES = Object.freeze({
  allowed: { jsonrpc: "2.0", id: "health", method: "eth_call", params: [{ to: CONTRACTS.PSRE, data: "0x18160ddd" }, "0x1"] }, // PSRE.totalSupply()
  rejected: { jsonrpc: "2.0", id: "health", method: "eth_call", params: [{ to: CONTRACTS.PSRE, data: "0xa9059cbb" }, "0x1"] }, // PSRE.transfer(address,uint256)
});

/** GET …/health (Kin #6): bindings valid + allowed shape accepted + rejected shape refused, with no upstream call. */
export function healthResponse(env) {
  const v = validateEnv(env);
  if (!v.ok) return json({ ok: false, error: PUBLIC_ERRORS.MISCONFIGURED }, 503, {});
  const allowed = validateRequest(HEALTH_PROBES.allowed).ok === true;
  const rejected = validateRequest(HEALTH_PROBES.rejected).ok === false;
  const ok = allowed && rejected;
  return json({ ok, config: true, allowedShapeAccepted: allowed, rejectedShapeRefused: rejected, upstream: v.config.upstreamName, rateLimiter: !!v.config.limiter }, ok ? 200 : 500, {});
}

/**
 * Handle one request. `deps` lets tests inject the upstream fetch, caches and the timeout; in production all come
 * from the platform. Returns a Response; the upstream URL and key never appear in any response, log line or error.
 */
export async function handle(request, env, deps = {}) {
  const url = new URL(request.url);
  if (request.method === "GET" && /\/health\/?$/.test(url.pathname)) return healthResponse(env);

  const v = validateEnv(env);
  if (!v.ok) return json({ error: PUBLIC_ERRORS.MISCONFIGURED }, 503, { Vary: "Origin" });
  const { siteOrigin, ttl, limiter, upstreamName } = v.config;

  const origin = request.headers.get("origin") || "";
  const cors = corsHeaders(origin, siteOrigin);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return json({ error: "POST only" }, 405, cors);
  // Round 2 #6: a POST must carry Origin === SITE_ORIGIN; originless and foreign-origin requests are both 403.
  if (origin !== siteOrigin) return json({ error: PUBLIC_ERRORS.ORIGIN_NOT_ALLOWED }, 403, cors);

  if (limiter) {
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    let success = false;
    try {
      ({ success } = await limiter.limit({ key: ip }));
    } catch {
      success = false; // a failing limiter fails closed
    }
    if (!success) return json(rpcError(null, JSONRPC_SERVER_ERROR, PUBLIC_ERRORS.RATE_LIMITED).body, 429, { ...cors, "retry-after": "10" });
  }

  // Body size (Kin #4; round 2 #8): Content-Length first, then the bytes actually read, counted as bytes.
  const read = await readBodyBounded(request, LIMITS.MAX_BODY_BYTES);
  if (read.tooLarge) return json(rpcError(null, JSONRPC_INVALID_REQUEST, PUBLIC_ERRORS.BODY_TOO_LARGE).body, 413, cors);
  if (read.unreadable) return json(rpcError(null, JSONRPC_PARSE_ERROR, "parse error").body, 400, cors);
  const text = read.text;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json(rpcError(null, JSONRPC_PARSE_ERROR, "parse error").body, 400, cors);
  }
  const r = validateRequest(body);
  if (!r.ok) return json(r.error.body, r.error.status, cors);
  const id = body.id === undefined ? null : body.id;
  const base = { ...cors, "X-Prospereum-Upstream": upstreamName };

  // Kin #2b: dynamic PartnerVault targets must be factory-registered at the same pinned block.
  for (const vault of r.vaultTargets) {
    const active = await verifyVault(vault, r.normalized.params[1], v.config, deps);
    if (active === null) return json(rpcError(id, JSONRPC_SERVER_ERROR, PUBLIC_ERRORS.UPSTREAM_UNAVAILABLE).body, 502, base);
    if (!active) return json(rpcError(id, JSONRPC_INVALID_PARAMS, `call not allowed: ${vault} is not a registered partner vault`).body, 400, cors);
  }

  const key = await cacheKey(r.normalized);
  const cache = deps.cache ?? new MemoryCache();
  const cached = await cache.get(key);
  if (cached) return json({ jsonrpc: "2.0", id, ...cached }, 200, { ...base, "X-Prospereum-Cache": "HIT" });

  const up = await callUpstream(v.config, r.normalized.method, r.normalized.params, deps);
  if (!up.ok) {
    const msg = up.kind === "invalid" ? PUBLIC_ERRORS.UPSTREAM_INVALID : PUBLIC_ERRORS.UPSTREAM_UNAVAILABLE;
    return json(rpcError(id, JSONRPC_SERVER_ERROR, msg).body, 502, base);
  }
  const payload = up.error ? { error: up.error } : { result: up.result };
  if (!up.error) await cache.put(key, payload, ttl); // only validated results are cached (Kin #7)
  return json({ jsonrpc: "2.0", id, ...payload }, 200, { ...base, "X-Prospereum-Cache": "MISS" });
}

const isolateCache = new MemoryCache();

export default {
  async fetch(request, env) {
    return handle(request, env, { cache: isolateCache });
  },
};
