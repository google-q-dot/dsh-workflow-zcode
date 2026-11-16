/**
 * The parent↔child wire: one JSON object per line over stdio.
 *
 * Both sides are strict about this format because the child is a separate
 * process: a decoded message is the only state they share, so the vocabulary
 * stays small and every message is validated on arrival.
 *
 * Parent → child
 *   { kind: 'start',    code, args }            run the lowered script
 *   { kind: 'response', id, ok, value|error }   answer one child request
 *   { kind: 'cancel',   reason }                stop this run
 *
 * Child → parent
 *   { kind: 'request',  id, type, siteId, … }   ask / world-read / publish-artifact
 *   { kind: 'event',    type, … }               phase / log / report / declare-artifact / actor
 *   { kind: 'complete', ok, value|error }       the script settled
 *
 * @module dsh-workflow-zcode/engine/protocol
 */

/** Request types the child may raise. */
export const REQUEST = Object.freeze({
  ask: 'ask',
  worldRead: 'world-read',
  publishArtifact: 'publish-artifact',
})

/** Event types the child may emit. */
export const EVENT = Object.freeze({
  phase: 'phase',
  log: 'log',
  report: 'report',
  declareArtifact: 'declare-artifact',
  actor: 'actor',
})

/**
 * Encode one message as a single NDJSON line.
 *
 * @param {object} message
 * @returns {string}
 */
export function encode(message) {
  // A newline inside a string is escaped by JSON.stringify, so one line stays
  // one message even when a prompt contains line breaks.
  return `${JSON.stringify(message)}\n`
}

/**
 * Decode one NDJSON line, returning undefined for a blank or malformed line
 * instead of throwing: a stray log line on the wire must not kill the run.
 *
 * @param {string} line
 * @returns {object | undefined}
 */
export function decode(line) {
  const text = line.trim()
  if (text === '') return undefined
  try {
    const value = JSON.parse(text)
    if (value === null || typeof value !== 'object') return undefined
    return value
  } catch {
    return undefined
  }
}

/**
 * Build a handler for a line-oriented reader (`readline`), whose callback
 * receives a line WITHOUT its newline. Buffering here would silently swallow
 * every message, so this path only decodes.
 *
 * @param {(message: object) => void} onMessage
 * @returns {(line: string) => void}
 */
export function createLineHandler(onMessage) {
  return (line) => {
    const message = decode(line)
    if (message !== undefined) onMessage(message)
  }
}

/**
 * Split an incoming byte stream into decoded messages.
 *
 * @param {(message: object) => void} onMessage
 * @returns {(chunk: Buffer | string) => void} a push-style feed
 */
export function createDecoder(onMessage) {
  let buffer = ''
  return (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      const message = decode(line)
      if (message !== undefined) onMessage(message)
      index = buffer.indexOf('\n')
    }
    // A partial line stays buffered until its newline arrives.
    if (buffer.length > 64 * 1024 * 1024) {
      buffer = ''
      onMessage({ kind: 'protocol-error', reason: 'unterminated line exceeded 64 MiB' })
    }
  }
}
