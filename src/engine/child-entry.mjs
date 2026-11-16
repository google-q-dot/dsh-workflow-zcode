/**
 * The sandbox child process: where a lowered ZCode script actually runs.
 *
 * It is a separate process with its own realm. The script sees only the seven
 * `__zcode*` hooks the compiler lowered into it, plus `__zcodeArgs`; there is
 * no `require`, no `process`, no filesystem and no network in its context. The
 * single way out is `__host`, which posts a line to the parent and awaits the
 * matching response — so every effect (subagent call, world read, artifact
 * publish) is decided by the parent, under the Session's own policy.
 *
 * Determinism is enforced here rather than trusted: `Date.now()`, `new Date()`
 * with no arguments, and `Math.random()` all throw. Replay compares
 * `input_hash` per node, which only means something if a rerun of the same
 * script takes the same path.
 *
 * @module dsh-workflow-zcode/engine/child-entry
 */

// The desktop Host is Electron: the parent passes ELECTRON_RUN_AS_NODE=1 so this
// file runs under Node semantics. Clearing it here keeps every child process
// this sandbox later spawns (world.run) from inheriting the flag.
if (process.env.ELECTRON_RUN_AS_NODE !== undefined) delete process.env.ELECTRON_RUN_AS_NODE

import vm from 'node:vm'
import { createInterface } from 'node:readline'
import { createLineHandler, encode } from './protocol.mjs'

const write = (message) => process.stdout.write(encode(message))

/** id → { resolve, reject } for requests awaiting a parent response. */
const inflight = new Map()
let requestSeq = 0
let failures = 0

function request(payload) {
  requestSeq += 1
  const id = `r${requestSeq}`
  write({ kind: 'request', id, ...payload })
  return new Promise((resolve, reject) => {
    inflight.set(id, { resolve, reject })
  })
}

/** Post a fire-and-forget event. */
function emit(payload) {
  write({ kind: 'event', ...payload })
}

/**
 * Build the object that becomes the script's global scope.
 *
 * Everything the script can reach is defined here; nothing is inherited from
 * this module's scope, so a script cannot see `inflight`, `write` or anything
 * else the child needs for itself.
 */
function createScope(args, askSchemas, runMeta) {
  const actors = new Map()
  let actorSeq = 0
  // Frozen identity, built once. `resumedFrom` is omitted (not empty) when this
  // run did not come from another one, so `'resumedFrom' in run` is meaningful.
  const runInfo = Object.freeze({
    id: String(runMeta?.id ?? ''),
    ...(typeof runMeta?.resumedFrom === 'string' && runMeta.resumedFrom !== ''
      ? { resumedFrom: runMeta.resumedFrom }
      : {}),
  })

  const createActor = (...raw) => {
    // `agent(name)` or `agent(name, persona)`; both are already lowered.
    const name = typeof raw[0] === 'string' ? raw[0] : undefined
    const persona = typeof raw[0] === 'object' && raw[0] !== null ? raw[0] : raw[1]
    actorSeq += 1
    const siteId = `actor#${actorSeq}`
    actors.set(siteId, { siteId, name, persona })
    emit({ type: 'actor', siteId, name: name ?? null, persona: persona ?? null })
    return Object.freeze({ __zcodeActor: true, siteId, name })
  }

  const ask = (siteId, actor, instructions) => {
    if (actor === null || typeof actor !== 'object' || actor.__zcodeActor !== true) {
      return Promise.reject(new Error('workflow ask(): the receiver is not an actor created by agent()'))
    }
    // The schema belongs to the ASK SITE, decided at compile time, so it travels
    // with the request instead of being guessed by the host.
    const entry = askSchemas !== null && typeof askSchemas === 'object' ? askSchemas[siteId] : undefined
    return request({
      type: 'ask',
      siteId,
      actorSiteId: actor.siteId,
      instructions,
      ...(entry === undefined ? {} : { schema: entry }),
    })
  }

  const readWorld = (siteId, op, callArgs) => request({
    type: 'world-read',
    siteId,
    op,
    args: Array.isArray(callArgs) ? callArgs : [],
  })

  const report = (item, artifactId) => {
    emit({ type: 'report', item, artifactId: artifactId === undefined ? null : artifactId })
  }

  /**
   * CONTENT (`file`, `markdown`) is an effect: async, awaitable, rejectable.
   * PRESET (`chart`, `table`, `metrics`, `board`) is a DECLARATION — the facade
   * has no `await` for it and no rejection channel, so it must travel as an
   * ordered event (a request would reorder it behind `report()` calls and could
   * let an item arrive before its declaration).
   */
  const artifact = (op, artifactId, ...rest) => {
    if (op === 'file' || op === 'markdown') {
      return request({ type: 'publish-artifact', op, artifactId, args: rest })
    }
    emit({ type: 'declare-artifact', op, artifactId, spec: rest[0] })
    return undefined
  }

  const phase = (title) => emit({ type: 'phase', title: String(title) })

  const log = (message) => emit({ type: 'log', message: String(message) })

  // The guard: clock reads and unseeded randomness make a rerun diverge, and a
  // diverged rerun cannot be compared against the journal.
  const RealDate = Date
  const GuardedDate = new Proxy(RealDate, {
    apply() {
      throw new Error('Date() is unavailable inside a workflow: the clock would break determinism')
    },
    construct(target, callArgs) {
      if (callArgs.length === 0) {
        throw new Error('new Date() is unavailable inside a workflow: the clock would break determinism')
      }
      return Reflect.construct(target, callArgs)
    },
    get(target, property, receiver) {
      if (property === 'now') {
        return () => {
          throw new Error('Date.now() is unavailable inside a workflow: the clock would break determinism')
        }
      }
      return Reflect.get(target, property, receiver)
    },
  })

  const GuardedMath = Object.create(Math)
  Object.defineProperty(GuardedMath, 'random', {
    value() {
      throw new Error('Math.random() is unavailable inside a workflow: unseeded randomness would break determinism')
    },
    enumerable: false,
  })

  return {
    __zcodeCreateActor: createActor,
    __zcodeAsk: ask,
    __zcodeReadWorld: readWorld,
    __zcodeReport: report,
    __zcodeArtifact: artifact,
    __zcodePhase: phase,
    __zcodeLog: log,
    __zcodeArgs: Object.freeze(args ?? {}),
    run: runInfo,
    Date: GuardedDate,
    Math: GuardedMath,
    // A script may narrate to stderr; it never reaches the model or the panel.
    console: Object.freeze({
      log: (...parts) => process.stderr.write(`${parts.map(String).join(' ')}\n`),
      warn: (...parts) => process.stderr.write(`${parts.map(String).join(' ')}\n`),
      error: (...parts) => process.stderr.write(`${parts.map(String).join(' ')}\n`),
    }),
  }
}

async function executeWorkflow(code, args, askSchemas, runMeta) {
  const scope = createScope(args, askSchemas, runMeta)
  const context = vm.createContext(scope, {
    name: 'zcode-workflow',
    codeGeneration: { strings: false, wasm: false },
  })
  // The body is wrapped so `return` works at top level, exactly as the lowered
  // text expects.
  const script = new vm.Script(`(async () => {\n${code}\n})()`, {
    filename: 'zcode-workflow.mjs',
  })
  const started = Date.now()
  const promise = script.runInContext(context, { timeout: 60_000 })
  const value = await promise
  return { value: value === undefined ? null : value, durationMs: Date.now() - started }
}

/**
 * Shape a thrown value for the wire.
 *
 * The value came out of another realm, so `instanceof Error` is false there and
 * must not be trusted: reading `message`/`name` off any object keeps the real
 * message instead of degrading to `String(error)`, which prepends "Error: ".
 *
 * @param {unknown} error
 * @returns {{ name: string, message: string, stack?: string, code?: unknown, violations?: unknown }}
 */
function describeError(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') {
    const shaped = { name: typeof error.name === 'string' ? error.name : 'Error', message: error.message }
    if (typeof error.stack === 'string') shaped.stack = error.stack
    if (error.code !== undefined) shaped.code = error.code
    if (error.violations !== undefined) shaped.violations = error.violations
    return shaped
  }
  return { name: 'Error', message: String(error) }
}

/** Held while a script runs: a pending promise alone does not keep Node alive. */
let keepAlive

const finish = (message) => {
  if (keepAlive !== undefined) {
    clearInterval(keepAlive)
    keepAlive = undefined
  }
  write({ kind: 'complete', ...message })
  // Give stdout a turn to flush before the process ends.
  process.stdout.write('', () => process.exit(failures > 0 ? 1 : 0))
}

const handle = createLineHandler((message) => {
  if (message.kind === 'response') {
    const entry = inflight.get(message.id)
    if (entry === undefined) return
    inflight.delete(message.id)
    if (message.ok === true) entry.resolve(message.value)
    else {
      const error = new Error(message.error?.message ?? 'the workflow host refused this request')
      if (message.error?.code !== undefined) error.code = message.error.code
      if (message.error?.violations !== undefined) error.violations = message.error.violations
      entry.reject(error)
    }
    return
  }
  if (message.kind === 'start') {
    keepAlive ??= setInterval(() => {}, 1 << 30)
    executeWorkflow(message.code, message.args, message.askSchemas, message.run).then(
      (result) => finish({ ok: true, value: result.value, durationMs: result.durationMs }),
      (error) => {
        failures += 1
        finish({ ok: false, error: describeError(error) })
      },
    )
    return
  }
  if (message.kind === 'cancel') {
    failures += 1
    for (const [, entry] of inflight) {
      entry.reject(new Error(message.reason === undefined ? 'the run was cancelled' : String(message.reason)))
    }
    inflight.clear()
    finish({ ok: false, error: { name: 'Cancelled', message: 'the run was cancelled' } })
  }
})

createInterface({ input: process.stdin }).on('line', handle)

// The parent going away means nobody can answer requests: fail loudly rather
// than hanging on a promise that can never settle.
process.stdin.on('end', () => {
  if (inflight.size === 0) return
  for (const [, entry] of inflight) entry.reject(new Error('the workflow host disconnected'))
  inflight.clear()
})
