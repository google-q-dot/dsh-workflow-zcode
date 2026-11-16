/**
 * The actor pool: long-lived subagents with accumulating context.
 *
 * ZCode's `agent()` is a synchronous handle whose `ask()` runs one turn on a
 * **persistent** session, so the second ask already knows what the first one
 * said — that context accumulation is the point of a named actor, not a
 * side effect. A fresh one-shot child per ask would silently lose it.
 *
 * Two invariants make this pool match the origin:
 *
 * 1. **One session per actor ref.** The session id is derived from
 *    `runId` + `siteId@ordinal`, so a resumed run reattaches to the same
 *    conversation instead of starting a new one.
 * 2. **Single-flight per actor.** Asks on one actor queue FIFO and never
 *    overlap: two concurrent turns on one session would interleave, which is
 *    what the origin forbids by pumping each actor's queue one ask at a time.
 *
 * The pool talks to the runtime through a small injected interface
 * (`createActor` / `sendTurn` / `readReply`) so the queue, the schema handling
 * and the repair loop are all testable without a model call.
 *
 * The persona is handed to `createActor` ONCE and never concatenated into a
 * turn: the production adapter installs it as a system-prompt section on the
 * child's own context, which is where DSH expects standing instructions to live.
 * Repeating `# Role` in every user message would (a) duplicate the prompt on
 * every turn and (b) make the transcript unreadable.
 *
 * @module dsh-workflow-zcode/engine/actor-pool
 */

/** Raised when a typed ask cannot produce a schema-valid answer. */
export class ResultNotSubmitted extends Error {
  constructor(message, { violations } = {}) {
    super(message)
    this.name = 'ResultNotSubmitted'
    this.code = 'result_not_submitted'
    if (violations !== undefined) this.violations = violations
  }
}

const sanitize = (value) => String(value).replace(/_/gu, '__').replace(/[^A-Za-z0-9.-]/gu, '_')

/**
 * The origin's actor session id: `sess_dwf-<runId>-<siteId@ordinal>`, with `_`
 * doubled first and every other unsafe character folded to `_`.
 *
 * @param {string} runId
 * @param {string} siteId
 * @param {number} ordinal
 * @returns {string}
 */
export function mintActorSessionId(runId, siteId, ordinal) {
  return `sess_dwf-${sanitize(runId)}-${sanitize(`${siteId}@${ordinal}`)}`
}

/** Wrap a non-object schema so the child can still answer with an object. */
export function wrapSchema(schema) {
  if (schema !== undefined && schema !== null && typeof schema === 'object' && schema.type === 'object') {
    return { schema, unwrap: (value) => value, wrapped: false }
  }
  return {
    schema: {
      type: 'object',
      properties: { value: schema ?? {} },
      required: ['value'],
      additionalProperties: false,
    },
    unwrap: (value) => (value === null || typeof value !== 'object' ? value : value.value),
    wrapped: true,
  }
}

const typeOf = (value) => {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

const matchesType = (value, type) => {
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value)
  if (type === 'null') return value === null
  return typeOf(value) === type
}

/**
 * Validate against the JSON Schema subset the compiler can emit.
 *
 * A full validator is not needed and would be a lie about what is enforced: the
 * compiler only produces `type` / `properties` / `required` / `items` / `enum` /
 * `const` / `oneOf`. Anything else is ignored rather than silently "passing".
 *
 * @param {unknown} value
 * @param {object} schema
 * @param {string} [path]
 * @returns {string[]} human-readable violations, empty when valid
 */
export function validate(value, schema, path = '') {
  const at = path === '' ? 'result' : path
  if (schema === null || typeof schema !== 'object') return []
  const violations = []

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((type) => matchesType(value, type))) {
      violations.push(`${at} must be ${types.join(' or ')}; received ${typeOf(value)}`)
      return violations
    }
  }
  if (schema.const !== undefined && value !== schema.const) {
    violations.push(`${at} must equal ${JSON.stringify(schema.const)}`)
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => entry === value)) {
    violations.push(`${at} must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}`)
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    const matched = schema.oneOf.filter((candidate) => validate(value, candidate, at).length === 0)
    if (matched.length === 0) violations.push(`${at} does not match any allowed shape`)
  }
  if (Array.isArray(schema.required) && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required) {
      if (!(key in value)) violations.push(`${at}.${key} is required`)
    }
  }
  if (schema.properties !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (key in value) violations.push(...validate(value[key], sub, `${at}.${key}`))
    }
  }
  if (schema.items !== undefined && Array.isArray(value)) {
    value.forEach((entry, index) => {
      violations.push(...validate(entry, schema.items, `${at}[${index}]`))
    })
  }
  return violations
}

/** Pull the JSON out of a reply that may be wrapped in prose or a code fence. */
export function parseJsonReply(text) {
  if (typeof text !== 'string') return { ok: false, reason: 'the subagent returned no text' }
  const trimmed = text.trim()
  const fenced = /```(?:json)?\s*\n?([\s\S]*?)```/u.exec(trimmed)
  const candidates = [fenced?.[1], trimmed]
  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) candidates.push(trimmed.slice(firstBrace, lastBrace + 1))
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.trim() === '') continue
    try {
      return { ok: true, value: JSON.parse(candidate) }
    } catch {
      // try the next candidate
    }
  }
  return { ok: false, reason: 'the subagent did not answer with JSON' }
}

/**
 * Create the pool for one run.
 *
 * @param {object} input
 * @param {string} input.runId
 * @param {string} input.cwd
 * @param {number} [input.maxTotalAgents] hard ceiling on agents created by this run
 * @param {number} [input.maxConcurrency] simultaneous subagent turns (a semaphore)
 * @param {object} input.runtime injected `{ createActor, sendTurn, readReply, dispose }`
 * @param {(event: object) => void} [input.onEvent]
 * @returns {ActorPool}
 */
export function createActorPool({
  runId,
  cwd,
  maxTotalAgents = 200,
  maxConcurrency = 13,
  runtime,
  onEvent = () => {},
  /** ref → sessionId recorded by an earlier attempt, for resume. */
  resumeSessions,
  /** Degrade to a fresh session when the recorded one is gone. */
  allowRehydrate = false,
}) {
  /** ref → actor state, where ref is `siteId@ordinal`. */
  const actors = new Map()
  /** ref → tail of that actor's FIFO, registered synchronously in `ask`. */
  const queues = new Map()
  let created = 0

  /**
   * Cross-actor semaphore.
   *
   * `maxTotalAgents` bounds how many agents a run may EVER create; it says
   * nothing about how many model turns are in flight at once. The origin's
   * `最大并发数` is the second number, and it has to be enforced here: a fan-out
   * of twenty asks would otherwise start twenty children at once.
   */
  const limit = Math.max(1, Math.min(64, Number.isFinite(maxConcurrency) ? Math.floor(maxConcurrency) : 13))
  let active = 0
  let peak = 0
  const waiters = []
  const acquire = () => {
    if (active < limit) {
      active += 1
      peak = Math.max(peak, active)
      return Promise.resolve()
    }
    return new Promise((resolve) => waiters.push(resolve))
  }
  const release = () => {
    const next = waiters.shift()
    if (next !== undefined) {
      // Hand the slot straight over: active stays at the limit, no window for a
      // newcomer to jump the queue and overshoot.
      next()
      return
    }
    active -= 1
  }
  const withSlot = async (fn) => {
    await acquire()
    try {
      return await fn()
    } finally {
      release()
    }
  }

  const notify = (event) => {
    try {
      onEvent(event)
    } catch {
      // a broken observer must not fail the run
    }
  }

  const actorFor = async ({ siteId, ordinal, name, persona }) => {
    const ref = `${siteId}@${ordinal}`
    const existing = actors.get(ref)
    if (existing !== undefined) return existing

    if (created >= maxTotalAgents) {
      throw new Error(`this run reached its subagent ceiling (${maxTotalAgents} agents)`)
    }
    created += 1

    const recordedSessionId = resumeSessions?.get(ref)
    const sessionId = recordedSessionId ?? mintActorSessionId(runId, siteId, ordinal)

    let handle
    if (recordedSessionId !== undefined && typeof runtime.resumeActor === 'function') {
      try {
        // Reattach: the actor's earlier turns are part of what a replay means.
        handle = await runtime.resumeActor({ sessionId: recordedSessionId, cwd, name, persona })
      } catch (error) {
        if (allowRehydrate !== true) {
          throw new Error(
            `the subagent session for ${ref} could not be resumed (${error instanceof Error ? error.message : String(error)}). `
            + 'Pass allow_rehydrate to continue with a fresh session, which loses that actor\'s earlier turns.',
          )
        }
        // The recorded id belongs to a session that no longer exists: reusing it
        // would mint a NEW session under an OLD identity and make the journal
        // lie about which conversation the actor actually continued.
        const fresh = `${mintActorSessionId(runId, siteId, ordinal)}-h${Date.now().toString(36)}`
        handle = await runtime.createActor({ sessionId: fresh, cwd, name, persona })
        notify({
          type: 'actor-rehydrated',
          siteId,
          ordinal,
          previousSessionId: recordedSessionId,
          sessionId: fresh,
        })
      }
    } else {
      handle = await runtime.createActor({ sessionId, cwd, name, persona })
    }
    const actor = {
      ref,
      siteId,
      ordinal,
      // The runtime owns identity: a child may rename itself or resolve a
      // persona the AST could not know (a computed name inside a loop). Fall
      // back to the declaration only when the runtime has nothing to say.
      name: handle?.name ?? name ?? null,
      persona: handle?.persona ?? persona ?? null,
      model: handle?.model ?? null,
      sessionId: handle?.sessionId ?? sessionId,
      handle,
      asks: 0,
    }
    actors.set(ref, actor)
    // Reattaching to an existing actor is not a creation: the event name is what
    // an operator reads to decide whether a resume kept or rebuilt the child.
    notify({
      type: recordedSessionId === undefined ? 'actor-created' : 'actor-resumed',
      siteId,
      ordinal,
      name: actor.name,
      sessionId: actor.sessionId,
      ...(recordedSessionId === undefined ? {} : { previousSessionId: recordedSessionId }),
    })
    return actor
  }

  const runOneAsk = async (actor, { instructions, schema }) => {
    const prompt = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
    const wrapped = schema === undefined ? undefined : wrapSchema(schema)

    const buildText = (repair) => {
      const parts = [`# Task\n${prompt}`]
      if (wrapped !== undefined) {
        // The schema also travels structurally to the adapter, which registers a
        // `structured_output` tool for this turn. This prose is the fallback the
        // repair loop relies on when the child answers in plain text instead.
        parts.push(
          '# Output\nAnswer with a single JSON object and nothing else. It must satisfy this schema:\n'
          + JSON.stringify(wrapped.schema),
        )
      }
      if (repair !== undefined) parts.push(`# Correction\nThe previous answer was rejected: ${repair}`)
      return parts.join('\n\n')
    }

    /**
     * One turn. A reply that arrived through the `structured_output` tool is
     * already an object; anything else is text to be parsed.
     */
    const ask = async (repair) => withSlot(async () => {
      await runtime.sendTurn(actor.handle, {
        text: buildText(repair),
        ...(wrapped === undefined ? {} : { schema: wrapped.schema }),
      })
      const reply = await runtime.readReply(actor.handle)
      if (reply !== null && typeof reply === 'object' && reply.structured === true) {
        return { structured: true, value: reply.value }
      }
      return { structured: false, text: reply }
    })

    const first = await ask()
    if (wrapped === undefined) return first.structured === true ? first.value : first.text

    // Tool capture wins: it was validated against the same schema by the child's
    // own tool contract, so there is nothing to parse or repair.
    if (first.structured === true) {
      const violations = validate(first.value, wrapped.schema)
      if (violations.length === 0) return wrapped.unwrap(first.value)
      const retryStructured = await ask(violations.join('; '))
      if (retryStructured.structured === true && validate(retryStructured.value, wrapped.schema).length === 0) {
        return wrapped.unwrap(retryStructured.value)
      }
      throw new ResultNotSubmitted('the subagent submitted a result that does not match its schema', { violations })
    }

    const parsed = parseJsonReply(first.text)
    if (parsed.ok === false) {
      // One repair turn, mirroring the origin's single nudge, then fail.
      const retry = await ask(parsed.reason)
      const second = retry.structured === true
        ? { ok: true, value: retry.value }
        : parseJsonReply(retry.text)
      if (second.ok === false) {
        throw new ResultNotSubmitted(`the subagent did not submit a structured result: ${second.reason}`)
      }
      const violations = validate(second.value, wrapped.schema)
      if (violations.length > 0) {
        throw new ResultNotSubmitted('the subagent submitted a result that does not match its schema', {
          violations,
        })
      }
      return wrapped.unwrap(second.value)
    }

    const violations = validate(parsed.value, wrapped.schema)
    if (violations.length === 0) return wrapped.unwrap(parsed.value)

    const retry = await ask(violations.join('; '))
    const second = retry.structured === true
      ? { ok: true, value: retry.value }
      : parseJsonReply(retry.text)
    if (second.ok === false) {
      throw new ResultNotSubmitted('the subagent did not resubmit a structured result', { violations })
    }
    const secondViolations = validate(second.value, wrapped.schema)
    if (secondViolations.length > 0) {
      throw new ResultNotSubmitted('the subagent could not produce a matching result', {
        violations: secondViolations,
      })
    }
    return wrapped.unwrap(second.value)
  }

  return {
    /** Create (or reuse) the actor and enqueue one ask on it. */
    ask({ siteId, ordinal, name, persona, instructions, schema }) {
      const ref = `${siteId}@${ordinal}`
      // The queue is registered SYNCHRONOUSLY, before any await: two asks issued
      // back to back for the same brand-new actor must serialize, and reading the
      // actor's own tail later would let both start at once.
      const previous = queues.get(ref) ?? Promise.resolve()
      const queued = previous.then(async () => {
        const actor = await actorFor({ siteId, ordinal, name, persona })
        actor.asks += 1
        const startedAt = Date.now()
        notify({ type: 'ask-start', siteId, ordinal, name: actor.name })
        try {
          const value = await runOneAsk(actor, { instructions, schema })
          notify({ type: 'ask-end', siteId, ordinal, ok: true, durationMs: Date.now() - startedAt })
          return value
        } catch (error) {
          notify({
            type: 'ask-end',
            siteId,
            ordinal,
            ok: false,
            durationMs: Date.now() - startedAt,
            message: error instanceof Error ? error.message : String(error),
          })
          throw error
        }
      })
      // A rejected ask must not poison the queue for the next one.
      queues.set(ref, queued.catch(() => {}))
      return queued
    },

    /** Live scheduler counters (used by tests and the run summary). */
    stats() {
      return { active, peak, limit, created, waiting: waiters.length }
    },

    /** Every actor this run created, for the journal and the panel. */
    list() {
      return [...actors.values()].map((actor) => ({
        siteId: actor.siteId,
        ordinal: actor.ordinal,
        name: actor.name,
        persona: actor.persona,
        sessionId: actor.sessionId,
        model: actor.model,
        asks: actor.asks,
      }))
    },

    /** Tear down every child session this run owned. */
    async dispose() {
      const handles = [...actors.values()]
      actors.clear()
      queues.clear()
      for (const actor of handles) {
        try {
          await runtime.dispose(actor.handle)
        } catch {
          // disposal is best effort: one stuck child must not strand the rest
        }
      }
    },
  }
}

/**
 * @typedef {ReturnType<typeof createActorPool>} ActorPool
 */
