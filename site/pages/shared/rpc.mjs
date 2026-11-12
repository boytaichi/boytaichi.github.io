// prospereum.io — shared JSON-RPC client + endpoint fallback for the live pages (Kin PR #1 finding 3; round 2 findings 2, 9).
// Pure ES module: `fetch` is injected so the fallback logic is unit-tested in Node (shared/test/rpc.test.mjs).
//
// Rule: an endpoint is only "used" if it (1) answers eth_chainId with the expected chain AND (2) completes the whole
// pinned-block snapshot. A rejected (4xx/allowlist), rate-limited (429), malformed (non-hex result), UNDECODABLE
// (empty "0x" or fewer ABI words than the getter returns — round 2 #2) or timed-out read anywhere in the snapshot
// moves on to the next endpoint; the page shows the first complete snapshot, or stale, or "—" when every endpoint
// failed. A snapshot is never committed with a partial number.

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
 * Round 2 #2: a getter's result must decode. `call.words` is the minimum number of ABI words the getter returns
 * (1 for a uint/bool/address, 2 for the (value, readyAt) pending getters and for an address[] head). An empty "0x"
 * (reverted / wrong contract), a short word, or a non-aligned blob throws RpcError("undecodable") so the WHOLE
 * snapshot fails for this endpoint and withFallback() moves on. Returns the result unchanged when it decodes.
 */
export function requireDecodable(endpoint, call, result) {
  const need = call.words ?? 1;
  const got = abiWords(result);
  if (got === null) throw new RpcError(endpoint, "undecodable", `${call.key}: not word-aligned hex`);
  if (got < need) throw new RpcError(endpoint, "undecodable", `${call.key}: ${got} word(s), need ${need}`);
  return result;
}

/**
 * Run a page's call list against ONE endpoint, sequentially, every call at its own pinned blockTag, and require every
 * result to decode (round 2 #2). Resolves { results: key → hex, upstream } or throws the first RpcError — a snapshot
 * is all-or-nothing per endpoint.
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
    try {
      let res;
      try {
        res = await Promise.race([
          fetchImpl(endpoint.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
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
        if (j && j.error && typeof j.error.message === "string") throw new RpcError(endpoint, "rejected", j.error.message);
        throw new RpcError(endpoint, "http", String(res.status));
      }
      if (j === null) throw new RpcError(endpoint, "malformed", "not json");
      if (!j || typeof j !== "object") throw new RpcError(endpoint, "malformed");
      if (j.error) throw new RpcError(endpoint, "rpc-error", typeof j.error.message === "string" ? j.error.message : "");
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
