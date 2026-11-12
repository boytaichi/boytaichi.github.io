// prospereum.io — canonical ABI result check (Kin PR #1 round 3 finding 1). Pure: no DOM, no network, no Node APIs.
//
// A getter result is accepted only when it is the CANONICAL ABI encoding of the getter's declared return type(s)
// (shared/call-manifest.mjs RETURN_TYPES). Word count alone is not enough: a full-length blob with a bool word of
// 0x02, an address word with dirty high bytes, a uint24 that overflows its width, a static return with trailing words,
// or an address[] whose offset is not 0x20 / whose length word disagrees with the words that follow is UNDECODABLE,
// so the whole snapshot fails for that endpoint and withFallback() moves on (shared/rpc.mjs requireDecodable).
//
// Supported types — exactly what the pages read today; anything else throws at manifest load, never at render time:
//   bool            one word, 0 or 1 (upper 31 bytes zero, last byte 0x00 or 0x01)
//   address         one word, upper 12 bytes zero
//   uint256         one word, any value
//   uintN (N<256)   one word, value fits N bits (N a multiple of 8): upper (256−N)/4 hex digits zero
//   address[]       offset word == 0x20, length word L, then exactly L address words; total == 2 + L words, no trailing data
// Static types compose as a tuple: exactly one word per type, no trailing words. A dynamic type stands alone.

const HEX_BYTES = /^0x([0-9a-f]{2})*$/i;
const UINT_N = /^uint(\d+)$/;
const ZERO_WORD_OFFSET_20 = "0".repeat(62) + "20";

/** True when `type` is one the checker understands. */
export function isSupportedType(type) {
  if (type === "bool" || type === "address" || type === "address[]") return true;
  const m = UINT_N.exec(type);
  if (!m) return false;
  const n = Number(m[1]);
  return n >= 8 && n <= 256 && n % 8 === 0;
}

/** Validate a declared return-type list; throws on an unsupported type or an invalid combination (manifest load time). */
export function assertReturnTypes(types, label = "getter") {
  if (!Array.isArray(types) || types.length === 0) throw new Error(`${label}: return types must be a non-empty array`);
  for (const t of types) if (!isSupportedType(t)) throw new Error(`${label}: unsupported return type ${t}`);
  const dynamic = types.filter((t) => t.endsWith("[]"));
  if (dynamic.length > 0 && types.length !== 1) throw new Error(`${label}: a dynamic return type must stand alone`);
  return types;
}

/** Minimum ABI words a result of `types` carries: one per static type; the two head words for an address[] (an empty list). */
export function minWords(types) {
  return types.length === 1 && types[0] === "address[]" ? 2 : types.length;
}

/** Split a hex result into 32-byte words, or null when it is not hex / not word-aligned. */
export function splitWords(hex) {
  if (typeof hex !== "string" || !HEX_BYTES.test(hex)) return null;
  const body = hex.slice(2).toLowerCase();
  if (body.length % 64 !== 0) return null;
  const out = [];
  for (let i = 0; i < body.length; i += 64) out.push(body.slice(i, i + 64));
  return out;
}

/** Is `word` (64 lower-case hex digits) the canonical encoding of one static `type`? Returns null when it is, else the reason. */
export function staticWordFault(type, word) {
  if (type === "bool") return /^0{63}[01]$/.test(word) ? null : "bool word is not 0 or 1";
  if (type === "address") return /^0{24}/.test(word) ? null : "address word has non-zero high bytes";
  const m = UINT_N.exec(type);
  const n = Number(m[1]);
  if (n === 256) return null;
  const zeroDigits = (256 - n) / 4;
  return new RegExp(`^0{${zeroDigits}}`).test(word) ? null : `${type} value does not fit ${n} bits`;
}

/**
 * Check that `hex` is the canonical ABI encoding of `types`.
 * Returns { ok: true, words } (the word strings) or { ok: false, reason, words } — never throws on bad data.
 */
export function checkCanonical(types, hex) {
  const words = splitWords(hex);
  if (words === null) return { ok: false, reason: "not word-aligned hex", words: null };
  if (types.length === 1 && types[0] === "address[]") {
    if (words.length < 2) return { ok: false, reason: `${words.length} word(s), need 2`, words };
    if (words[0] !== ZERO_WORD_OFFSET_20) return { ok: false, reason: "address[] offset word is not 0x20", words };
    const lengthWord = BigInt("0x" + words[1]);
    // the length can never exceed the words available; compare in BigInt so an absurd length word cannot wrap
    if (lengthWord > BigInt(words.length - 2)) return { ok: false, reason: `address[] length ${lengthWord} exceeds the ${words.length - 2} word(s) that follow`, words };
    const len = Number(lengthWord);
    if (words.length !== 2 + len) return { ok: false, reason: `address[] carries ${words.length - 2} word(s) after the head, length word says ${len}`, words };
    for (let i = 0; i < len; i++) {
      const fault = staticWordFault("address", words[2 + i]);
      if (fault) return { ok: false, reason: `address[] element ${i}: ${fault}`, words };
    }
    return { ok: true, words };
  }
  if (words.length !== types.length) return { ok: false, reason: `${words.length} word(s), need ${types.length}`, words };
  for (let i = 0; i < types.length; i++) {
    const fault = staticWordFault(types[i], words[i]);
    if (fault) return { ok: false, reason: types.length === 1 ? fault : `word ${i}: ${fault}`, words };
  }
  return { ok: true, words };
}

/** Decode a canonical address[] result into lower-cased addresses, or null when it is not canonical. */
export function decodeCanonicalAddressArray(hex) {
  const c = checkCanonical(["address[]"], hex);
  if (!c.ok) return null;
  return c.words.slice(2).map((w) => "0x" + w.slice(24));
}
