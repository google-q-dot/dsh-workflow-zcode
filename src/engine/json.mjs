/**
 * Make a value strictly, losslessly JSON-able.
 *
 * The Host validates a tool's return value and rejects anything that would not
 * survive a JSON round trip ("value is not lossless JSON"). A plain object with
 * `{ title: undefined }` looks harmless — `JSON.stringify` silently drops the
 * key — but the check is stricter than `JSON.stringify`, so every such key has
 * to go before the value leaves the tool.
 *
 * Handled here: `undefined` (dropped from objects, `null` in arrays), `NaN` and
 * `±Infinity` (null), `BigInt` (decimal string), functions and symbols
 * (dropped), cycles (`[circular]`).
 *
 * @module dsh-workflow-zcode/engine/json
 */

const CIRCULAR = '[circular]'

/**
 * @param {unknown} value
 * @returns {unknown} a value that survives `JSON.parse(JSON.stringify(...))` unchanged
 */
export function jsonSafe(value) {
  return walk(value, new WeakSet())
}

function walk(value, seen) {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') return Number.isFinite(value) ? value : null
  if (type === 'bigint') return value.toString()
  if (type === 'undefined' || type === 'function' || type === 'symbol') return undefined
  if (type !== 'object') return String(value)

  if (seen.has(value)) return CIRCULAR
  seen.add(value)

  if (Array.isArray(value)) {
    const out = value.map((entry) => {
      const cleaned = walk(entry, seen)
      // A hole becomes null so indices stay stable.
      return cleaned === undefined ? null : cleaned
    })
    seen.delete(value)
    return out
  }

  // Dates and other exotic objects degrade to their string form rather than
  // leaking a prototype the receiving side cannot rebuild.
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    if (value instanceof Date) {
      seen.delete(value)
      return value.toISOString()
    }
    const cleaned = walk({ ...value }, seen)
    seen.delete(value)
    return cleaned
  }

  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    const cleaned = walk(entry, seen)
    // The whole point: an undefined value must remove the KEY, not become null.
    if (cleaned !== undefined) out[key] = cleaned
  }
  seen.delete(value)
  return out
}