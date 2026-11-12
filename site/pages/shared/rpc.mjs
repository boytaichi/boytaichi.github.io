// prospereum.io — shared JSON-RPC client + endpoint fallback for the live pages (Kin PR #1 finding 3).
// Pure ES module: `fetch` is injected so the fallback logic is unit-tested in Node (shared/test/rpc.test.mjs).
//
// Rule: an endpoint is only "used" if it (1) answers eth_chainId with the expected chain AND (2) completes the whole
// pinned-block snapshot. A rejected (4xx/allowlist), rate-limited (429), malformed (non-hex result) or timed-out
// read anywhere in the snapshot moves on to the next endpoint; the page shows the first complete snapshot, or stale.

const HEX_QUANTITY = /^0x([1-9a-f][0-9a-f]*|0)$/i;
const HEX_BYTES = /^0x([0-9a-f]{2})*$/i;

export class RpcError extends Error {
  constructor(endpoint, kind, detail) {
    super(`${endpoint.name}: ${kind}${detail ? ` (${detail})` : ""}`);
    this.endpoint = endpoint.name;
    this.kind = kind; // http | rejected | rate-limited | rpc-error | malformed | timeout | network
  }
}

/** Shape check per method so a malformed upstream answer is treated as a failed read, never rendered. */
export function validResult(method, result) {
  if (method === "eth_chainId" || method === "eth_blockNumber") return typeof result === "string" && HEX_QUANTITY.test(result);
  if (method === "eth_call") return typeof result === "string" && HEX_BYTES.test(result);
  if (method === "eth_getBlockByNumber") return !!result && typeof result === "object" && typeof result.timestamp === "string" && HEX_QUANTITY.test(result.timestamp);
  return false;
}

/**
 * Build an `rpc(endpoint, method, params)` function over `fetchImpl` (window.fetch in the browser, a stub in tests).
 * Resolves { result, upstream } or throws RpcError. Every request is bounded by `timeoutMs`.
 */
export function makeRpc(fetchImpl, { timeoutMs = 10_000 } = {}) {
  let id = 1;
  return async function rpc(endpoint, method, params) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let res;
    try {
      res = await fetchImpl(endpoint.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
        signal: controller ? controller.signal : undefined,
      });
    } catch (e) {
      throw new RpcError(endpoint, e && e.name === "AbortError" ? "timeout" : "network");
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (res.status === 429) throw new RpcError(endpoint, "rate-limited");
    let j = null;
    try {
      j = await res.json();
    } catch {
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
