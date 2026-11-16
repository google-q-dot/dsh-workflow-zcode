/**
 * `input_hash` — the determinism guard recorded on every journal node.
 *
 * ZCode defines this as `inputHash = fnv1a(canonicalJson(x))` (`a4 = Obn∘yS`).
 * The two details that make a rewritten implementation disagree with the
 * origin are both preserved here:
 *
 * 1. `fnv1a` folds BOTH halves of every UTF-16 code unit
 *    (`charCodeAt(i) & 255`, then `charCodeAt(i) >> 8 & 255`). It is NOT a
 *    hash over UTF-8 bytes; hashing the UTF-8 encoding disagrees on any
 *    non-ASCII input.
 * 2. `canonicalJson` writes the literal `null` where `JSON.stringify`
 *    produced `undefined`, and DROPS object keys whose value is `undefined`
 *    rather than writing them as null. Arrays and objects therefore differ
 *    in how they treat a hole.
 *
 * The hash is a guard, not a key: replay compares it to prove the script is
 * deterministic, and a mismatch fails the run instead of appending a row.
 *
 * @module dsh-workflow-zcode/engine/input-hash
 */

/**
 * Serialise a value with recursively sorted object keys.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    const text = JSON.stringify(value)
    return text === undefined ? 'null' : text
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
  }
  const source = /** @type {Record<string, unknown>} */ (value)
  const parts = []
  for (const key of Object.keys(source).sort()) {
    const entry = source[key]
    // `undefined` values are dropped from objects, unlike array holes.
    if (entry !== undefined) parts.push(`${JSON.stringify(key)}:${canonicalJson(entry)}`)
  }
  return `{${parts.join(',')}}`
}

/**
 * 32-bit FNV-1a over UTF-16 code units, as lower-case zero-padded hex.
 *
 * @param {string} text
 * @returns {string}
 */
export function fnv1a(text) {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index) & 255
    hash ^= (text.charCodeAt(index) >> 8) & 255
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * The journal's input fingerprint.
 *
 * @param {unknown} value
 * @returns {string} eight lower-case hex digits
 */
export function inputHash(value) {
  return fnv1a(canonicalJson(value))
}

/**
 * The input a node is fingerprinted from.
 *
 * The origin records `{op, args}` for world reads and leaves `input_json`
 * NULL for ask/report/artifact sites, so the fingerprint input is caller
 * shaped: world sites pass their own `{op, args}`, and every other site passes
 * whatever identity that call has. `input_json` truncation at 4 KiB is a
 * storage concern and never touches the hash input.
 *
 * The hash must cover the CALL'S INPUT, not just its position. Hashing
 * `{siteId, ordinal}` alone would mean a rewritten prompt still hits the replay
 * cache — the exact drift the guard exists to catch.
 *
 * @param {object} input
 * @param {string} input.kind node kind
 * @param {unknown} [input.payload] world-style `{op, args}` payload
 * @param {unknown} [input.marker] the packed input for non-world sites
 * @returns {{ hash: string, stored: string | null, truncated: boolean }}
 */
export function nodeInput({ kind, payload, marker }) {
  const value = kind === 'world-read' || kind === 'world-run'
    ? (payload ?? { op: null, args: null })
    : (marker ?? { kind })
  const hash = inputHash(value)
  const serialised = JSON.stringify(value)
  // ask/report/artifact sites store NULL input_json, as the origin does.
  const stores = kind === 'world-read' || kind === 'world-run'
  if (!stores) return { hash, stored: null, truncated: false }
  const limit = 4096
  if (serialised.length <= limit) return { hash, stored: serialised, truncated: false }
  return { hash, stored: serialised.slice(0, limit), truncated: true }
}
