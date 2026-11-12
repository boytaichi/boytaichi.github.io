// prospereum.io — shared JSON-RPC client + endpoint fallback for the live pages (Kin PR #1 finding 3; round 2 findings 2, 9; round 3 findings 1, 5).
// Pure ES module: `fetch` is injected so the fallback logic is unit-tested in Node (shared/test/rpc.test.mjs).
//
// Rule: an endpoint is only "used" if it (1) answers eth_chainId with the expected chain AND (2) completes the whole
// pinned-block snapshot. A rejected (4xx/allowlist), rate-limited (429), malformed (non-hex result), UNDECODABLE
// (not the canonical ABI encoding of the getter's declared return types — round 2 #2, round 3 #1) or timed-out read
// anywhere in the snapshot moves on to the next endpoint; the page shows the first complete snapshot, or stale, or "—"
// when every endpoint failed. A snapshot is never committed with a partial number.
// Response envelope (round 3 #5): like the Worker, the browser accepts an answer only when `jsonrpc` is "2.0", `id`
// equals the id it sent, exactly one of `result` / `error` is present and an error is { code: integer, message: string };
// anything else is `malformed` and the endpoint is abandoned.
import { checkCanonical } from "./abi.mjs";

const HEX_QUANTITY = /^0x([1-9a-f][0-9a-f]*|0)$/i;
const HEX_BYTES = /^0x([0-9a-f]{2})*$/i;

export class RpcError extends Error {
  constructor(endpoint, kind, detail) {
    super(`${endpoint.name}: ${kind}${detail ? ` (${detail})` : ""}`);
    this.endpoint = endpoint.name;
    this.kind = kind; // http | rejected | rate-limited | rpc-error | malformed | undecodable | timeout | network
  }
}

/** Shape check per method so a malformed upstream answer is treated as a failed read, never rendered. */
export function validResult(method, result) {
  if (method === "eth_chainId" || method === "eth_blockNumber") return typeof result === "string" && HEX_QUANTITY.test(result);
  if (method === "eth_call") return typeof result === "string" && HEX_BYTES.test(result);
  if (method === "eth_getBlockByNumber") return !!result && typeof result === "object" && typeof result.timestamp === "string" && HEX_QUANTITY.test(result.timestamp);
  return false;
}

/** Number of whole 32-byte ABI words in an eth_call result, or null when it is not hex / not word-aligned. */
export function abiWords(result) {
  if (typeof result !== "string" || !HEX_BYTES.test(result)) return null;
  const hex = result.length - 2;
  return hex % 64 === 0 ? hex / 64 : null;
}

/**
 * Round 2 #2 / round 3 #1: a getter's result must be the CANONICAL encoding of its declared return types.
 * `call.types` (from shared/call-manifest.mjs RETURN_TYPES) drives the check: bool words must be 0 or 1, address
 * words must have zero high bytes, a uintN must fit its width, a static return has exactly one word per type, and an
 * address[] has offset 0x20, a length word and exactly that many address words — no trailing data. An empty "0x"
 * (reverted / wrong contract), a short word, a non-aligned blob or any non-canonical word throws
 * RpcError("undecodable") so the WHOLE snapshot fails for this endpoint and withFallback() moves on. A call without
 * `types` falls back to the round-2 minimum word count (`call.words`, default 1). Returns the result unchanged when it decodes.
 */
export function requireDecodable(endpoint, call, result) {
  if (Array.isArray(call.types)) {
    const c = checkCanonical(call.types, result);
    if (!c.ok) throw new RpcError(endpoint, "undecodable", `${call.key}: ${c.reason}`);
    return result;
  }
  const need = call.words ?? 1;
  const got = abiWords(result);
  if (got === null) throw new RpcError(endpoint, "undecodable", `${call.key}: not word-aligned hex`);
  if (got < need) throw new RpcError(endpoint, "undecodable", `${call.key}: ${got} word(s), need ${need}`);
  return result;
}

/** JSON-RPC error object shape (round 3 #5, mirrors the Worker): a plain object with an integer `code` and a string `message`. */
export function validErrorObject(e) {
  return !!e && typeof e === "object" && !Array.isArray(e) && Number.isInteger(e.code) && typeof e.message === "string";
}

/**
 * Validate a JSON-RPC response envelope against the id that was sent (round 3 #5). Returns null when the envelope is
 * acceptable, else the reason. Exactly one of `result` / `error` must be present; `error` must be { integer code, string message }.
 */
export function envelopeFault(j, sentId) {
  if (!j || typeof j !== "object" || Array.isArray(j)) return "not an object";
  if (j.jsonrpc !== "2.0") return 'jsonrpc is not "2.0"';
  if (j.id !== sentId) return "response id does not match the request";
  const hasResult = "result" in j;
  const hasError = "error" in j;
  if (hasResult && hasError) return "both result and error";
  if (!hasResult && !hasError) return "neither result nor error";
  if (hasError && !validErrorObject(j.error)) return "error is not { code: integer, message: string }";
  return null;
}

/**
 * Run a page's call list against ONE endpoint, sequentially, every call at its own pinned blockTag, and require every
 * result to be canonical for its declared types (round 2 #2, round 3 #1). Resolves { results: key → hex, upstream } or
 * throws the first RpcError — a snapshot is all-or-nothing per endpoint.
 */
export async function readCalls(rpc, endpoint, calls) {
  const results = {};
  let upstream = null;
  for (const c of calls) {
    const { result, upstream: up } = await rpc(endpoint, "eth_call", [{ to: c.to, data: c.data }, c.blockTag]);
    results[c.key] = requireDecodable(endpoint, c, result);
    if (up) upstream = up;
  }
  return { results, upstream };
}

/**
 * Build an `rpc(endpoint, method, params)` function over `fetchImpl` (window.fetch in the browser, a stub in tests).
 * Resolves { result, upstream } or throws RpcError. Every request is bounded by `timeoutMs` — the timer covers the
 * connection, the headers AND the body parse (round 2 #9): a response whose body stalls times out like a stalled connect.
 */
export function makeRpc(fetchImpl, { timeoutMs = 10_000 } = {}) {
  let id = 1;
  return async function rpc(endpoint, method, params) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    let timedOut = false;
    let fireTimeout;
    const deadline = new Promise((_, reject) => { fireTimeout = () => { timedOut = true; if (controller) controller.abort(); reject(new RpcError(endpoint, "timeout")); }; });
    deadline.catch(() => {}); // the rejection is consumed through Promise.race below; never an unhandled rejection
    const timer = setTimeout(fireTimeout, timeoutMs);
    const sentId = id++;
    try {
      let res;
      try {
        res = await Promise.race([
          fetchImpl(endpoint.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: sentId, method, params }),
            signal: controller ? controller.signal : undefined,
          }),
          deadline,
        ]);
      } catch (e) {
        if (e instanceof RpcError) throw e;
        throw new RpcError(endpoint, timedOut || (e && e.name === "AbortError") ? "timeout" : "network");
      }
      if (res.status === 429) throw new RpcError(endpoint, "rate-limited");
      let j = null;
      try {
        j = await Promise.race([res.json(), deadline]); // the same deadline: a stalled body is a timeout, not a hang
      } catch (e) {
        if (e instanceof RpcError) throw e;
        if (timedOut || (e && e.name === "AbortError")) throw new RpcError(endpoint, "timeout");
        j = null;
      }
      if (!res.ok) {
        // a 4xx from the proxy carries a JSON-RPC error (allowlist / shape rejection): surface it, then fall through
        if (j && typeof j === "object" && validErrorObject(j.error)) throw new RpcError(endpoint, "rejected", j.error.message);
        throw new RpcError(endpoint, "http", String(res.status));
      }
      if (j === null) throw new RpcError(endpoint, "malformed", "not json");
      // Round 3 #5: the envelope must be a JSON-RPC 2.0 answer to THIS request — otherwise it is malformed, never rendered.
      const fault = envelopeFault(j, sentId);
      if (fault) throw new RpcError(endpoint, "malformed", fault);
      if ("error" in j) throw new RpcError(endpoint, "rpc-error", j.error.message);
      if (!validResult(method, j.result)) throw new RpcError(endpoint, "malformed", method);
      return { result: j.result, upstream: typeof res.headers?.get === "function" ? res.headers.get("X-Prospereum-Upstream") : null };
    } finally {
      clearTimeout(timer); // cleared only after the body is parsed (or the call failed)
    }
  };
}

/**
 * Try each endpoint in order: chainId must match, then `snapshot(endpoint)` must complete. Any throw moves to the
 * next endpoint. Returns { endpoint, value } for the first complete snapshot, or null when every endpoint failed.
 */
export async function withFallback(endpoints, chainIdHex, rpc, snapshot, log = () => {}) {
  for (const endpoint of endpoints) {
    try {
      const { result } = await rpc(endpoint, "eth_chainId", []);
      if (result !== chainIdHex) {
        log(`${endpoint.name}: wrong network endpoint (${result})`);
        continue;
      }
      const value = await snapshot(endpoint);
      return { endpoint, value };
    } catch (err) {
      log(String(err));
    }
  }
  return null;
}
