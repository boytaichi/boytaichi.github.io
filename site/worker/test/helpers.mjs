// Shared fixtures for the Worker tests: a production-shaped env (rate limiter present) and request/upstream stubs.
export const SITE = "https://prospereum.io";
export const UPSTREAM_SECRET = "https://base-mainnet.g.alchemy.com/v2/SECRET-KEY-NEVER-SHOWN";
export const limiterAlwaysOk = { limit: async () => ({ success: true }) };
export const env = { SITE_ORIGIN: SITE, UPSTREAM_URL: UPSTREAM_SECRET, UPSTREAM_NAME: "Alchemy (Base mainnet)", CACHE_TTL_SECONDS: "60", RATE_LIMITER: limiterAlwaysOk };

export function req(body, headers = {}, url = "https://rpc.prospereum.io/rpc") {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(url, { method: "POST", headers: { "content-type": "application/json", origin: SITE, ...headers }, body: text });
}

/** Upstream stub answering every call with `result` (or a function of the parsed JSON-RPC request). */
export function upstream(result, calls = []) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const r = typeof result === "function" ? result(body) : result;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: r }), { headers: { "content-type": "application/json" } });
  };
}

export const word = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");
export const addrWord = (a) => a.slice(2).toLowerCase().padStart(64, "0");

/** ABI-encode Multicall3.aggregate((address,bytes)[]). */
export function encodeAggregate(calls) {
  const w = (hex) => hex.padStart(64, "0");
  const num = (n) => w(n.toString(16));
  const head = [num(0x20)];
  const arr = [num(calls.length)];
  const tuples = [];
  let offset = 32 * calls.length;
  for (const c of calls) {
    arr.push(num(offset));
    const sel = c.data.slice(2);
    const padded = sel.padEnd(Math.ceil(sel.length / 64) * 64, "0");
    const t = [w(c.to.slice(2).toLowerCase()), num(0x40), num(sel.length / 2), padded];
    tuples.push(t.join(""));
    offset += 32 * (3 + padded.length / 64);
  }
  return "0x252dba42" + head.join("") + arr.join("") + tuples.join("");
}
