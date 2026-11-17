/**
 * The run service: one ZCode workflow run, from submit to settlement.
 *
 * It owns the only mutable thing in the engine — a run's lifecycle — and it is
 * deliberately the only module that knows all four collaborators:
 *
 * - `child`   the sandboxed script process (`child-entry.mjs` over NDJSON)
 * - `actors`  the persistent subagent pool (`actor-pool.mjs`)
 * - `world`   the workspace reader (`world.mjs`)
 * - `artifacts` the deliverable publisher (`artifacts.mjs`)
 *
 * Every request the script makes is answered here, which is where the origin
 * puts its `__host` seam. Two behaviours are load-bearing:
 *
 * 1. **A failure is persisted, not thrown away.** The old implementation
 *    returned early on any non-completed stop reason, so a failed run left no
 *    trace at all — exactly the case a user wants to inspect. Here every path
 *    settles the run row and keeps the node/event history.
 * 2. **Ordinals are per site.** `ask#1` and `ask#2` are separate sites with
 *    independent counters; `(run_id, site_id, ordinal)` is the journal key, and
 *    a replayed run compares `input_hash` per row.
 *
 * @module dsh-workflow-zcode/engine/run-service
 */

import { NODE_KIND, NODE_STATUS, RUN_STATUS } from './journal.mjs'
import { nodeInput } from './input-hash.mjs'
import { REQUEST } from './protocol.mjs'

/** How much of a task prompt is kept for the detail view. */
export const INSTRUCTIONS_LIMIT = 8192

/** Raised when the child reports a script-level failure. */
export class WorkflowFailed extends Error {
  constructor(message, { name, stack, code, violations } = {}) {
    super(message)
    this.name = name ?? 'WorkflowError'
    this.code = code ?? 'workflow_failed'
    if (stack !== undefined) this.stack = stack
    if (violations !== undefined) this.violations = violations
  }
}

/** Raised when the run was cancelled before it settled. */
export class WorkflowCancelled extends Error {
  constructor(message = 'the run was cancelled') {
    super(message)
    this.name = 'WorkflowCancelled'
    this.code = 'cancelled'
  }
}

/**
 * Map one `world-read` request onto the world reader.
 *
 * The script names operations the way the facade does (`files.glob`,
 * `git.changedFiles`), and `run` carries its command first.
 */
export function worldOperation(world, op, args) {
  const callArgs = Array.isArray(args) ? args : []
  switch (op) {
    case 'files.read':
      return world.read(callArgs[0])
    case 'files.glob':
      return world.glob(callArgs[0])
    case 'files.grep':
      // The second argument is a path glob, not an options bag.
      return world.grep(callArgs[0], callArgs[1])
    case 'git.changedFiles':
      return world.changedFiles(callArgs[0])
    case 'git.diff':
      return world.gitDiff(callArgs[0], callArgs[1])
    case 'git.status':
      return world.gitStatus()
    case 'git.log':
      return world.gitLog(callArgs[0])
    case 'run':
      return world.run(callArgs[0], callArgs[1] ?? [], callArgs[2] ?? {})
    default:
      throw Object.assign(new Error(`world read: unsupported operation ${String(op)}`), {
        code: 'unsupported_world_op',
      })
  }
}

/**
 * Execute one run to settlement.
 *
 * @param {object} input
 * @param {object} input.journal
 * @param {string} input.runId
 * @param {string} input.script the lowered script text
 * @param {unknown} input.args workflow arguments handed to the script
 * @param {string} input.cwd
 * @param {object} input.child `{ send, onMessage, waitForExit, terminate }`
 * @param {object} input.actors the actor pool
 * @param {object} input.world the world reader
 * @param {object} input.artifacts the artifact publisher
 * @param {AbortSignal} [input.signal]
 * @param {(event: object) => void} [input.onEvent] live observers (the panel)
 * @returns {Promise<{ status: string, value: unknown, error?: object, artifacts: object[], reports: object[], durationMs: number }>}
 */
export async function executeRun({
  journal,
  runId,
  script,
  args,
  cwd,
  child,
  actors,
  world,
  artifacts,
  askSchemas = {},
  actorDeclarations = new Map(),
  signal,
  onEvent = () => {},
  /** Resume mode: settle cache hits from the journal instead of re-running them. */
  replay = false,
  /** Shared token ledger filled by the agent runtime: `{ total, bySession }`. */
  usage = { total: 0, bySession: new Map() },
  /** The run this one continues, when known. Defaults to the journal row. */
  resumedFrom,
}) {
  const startedAt = Date.now()
  // The row was inserted as `pending` before the sandbox started; from here on
  // it is a live run, and the panel must not keep showing "queued".
  try {
    journal.markRunning?.(runId)
  } catch {
    // an unwritable status must not prevent the script from running
  }
  /** siteId → next ordinal, per site. Ask/report/world sites each count alone. */
  const ordinals = new Map()
  /** actor siteId → next ordinal. An actor's identity is its own counter. */
  const actorOrdinals = new Map()
  const nextOrdinal = (siteId) => {
    const next = (ordinals.get(siteId) ?? 0) + 1
    ordinals.set(siteId, next)
    return next
  }
  const nextActorOrdinal = (siteId) => {
    const next = (actorOrdinals.get(siteId) ?? 0) + 1
    actorOrdinals.set(siteId, next)
    return next
  }
  let phase
  /**
   * Identity the SCRIPT reported for each actor site, keyed by siteId.
   *
   * This outranks the compiler's static declarations: a name computed inside a
   * loop, or an actor created in a branch that the AST counted differently,
   * would otherwise be journaled under the wrong identity.
   */
  const runtimeActors = new Map()

  const emit = (event) => {
    try {
      onEvent(event)
    } catch {
      // an observer must never fail a run
    }
  }
  const record = (type, payload) => {
    try {
      journal.appendEvent(runId, type, payload)
    } catch {
      // the journal is best effort for live observers; settlement still records
    }
  }

  /**
   * Persist one row per actor the pool actually created.
   *
   * `dwf_actor` carries the session id that resume/amend reattach to, so this
   * has to run after creation rather than at the end of the run only: a crash
   * mid-run must still leave a reattachable identity.
   */
  const syncActors = () => {
    let listed
    try {
      listed = actors.list()
    } catch {
      return
    }
    for (const actor of listed) {
      const reported = runtimeActors.get(actor.siteId)
      try {
        journal.putActor({
          runId,
          siteId: actor.siteId,
          ordinal: actor.ordinal,
          name: reported?.name ?? actor.name ?? null,
          persona: reported?.persona ?? actor.persona ?? null,
          resolvedModel: actor.model ?? null,
          sessionId: actor.sessionId ?? null,
          // Per-actor tokens come from the usage ledger the adapter fills on
          // every assistant message; a resumed actor keeps counting up.
          tokens: Number(usage?.bySession?.get(actor.sessionId) ?? 0),
        })
      } catch {
        // an unwritable actor row must not fail a run that is otherwise fine
      }
    }
  }

  // Persist a child the moment the pool creates/resumes it. `ask()` can take
  // minutes, and waiting for it left the panel showing `actor#5` with no way to
  // open the subagent session for that whole time.
  const unsubscribeActorSync = typeof actors.subscribe === 'function'
    ? actors.subscribe((event) => {
      if (event.type === 'actor-created' || event.type === 'actor-resumed' || event.type === 'actor-rehydrated') {
        syncActors()
      }
    })
    : undefined

  /** How many settled nodes this attempt replayed instead of executing. */
  let cachedNodes = 0

  /** Set inside the promise so a request handler can abort the whole run. */
  let abortWith

  /** A replay that finds different input at the same node means the script drifted. */
  const inputHashMismatch = (siteId, ordinal, expected, actual) => {
    const error = {
      name: 'InputHashMismatch',
      code: 'input_hash_mismatch',
      message:
        `the workflow is not deterministic: ${siteId}@${ordinal} was recorded with input hash `
        + `${expected} but this run produced ${actual}. Nothing was re-executed.`,
    }
    emit({ type: 'input-hash-mismatch', siteId, ordinal, expected, actual })
    return error
  }

  const settle = (status, extra) => {
    // A settlement event: without it the journal showed a status change with no
    // record of why, which is exactly what an operator needs after a failure.
    try {
      journal.appendEvent(runId, 'run-settled', {
        status,
        ...(extra?.error?.message === undefined ? {} : { error: String(extra.error.message) }),
        cachedNodes,
      })
    } catch {
      // the row below is the authoritative record
    }
    journal.settleRun(runId, {
      status,
      result: extra.value === undefined ? undefined : { value: extra.value },
      failure: extra.error,
      spentTokens: Number(usage?.total ?? 0),
    })
    return {
      status,
      value: extra.value === undefined ? null : extra.value,
      ...(extra.error === undefined ? {} : { error: extra.error }),
      artifacts: artifacts.snapshot().artifacts,
      reports: artifacts.snapshot().reports,
      durationMs: Date.now() - startedAt,
      spentTokens: Number(usage?.total ?? 0),
    }
  }

  let done = false

  /** Answer one child request; a refusal is a catchable error inside the script. */
  const handleRequest = async (message) => {
    const reply = (payload) => {
      if (done) return
      try {
        child.send({ kind: 'response', id: message.id, ...payload })
      } catch {
        // The child pipe may already be closed when an async turn settles after abort/exit.
      }
    }
    try {
      if (message.type === REQUEST.ask) {
        const siteId = message.siteId
        const ordinal = nextOrdinal(siteId)
        // The packed input of an ask: which actor was addressed and what it was
        // asked. A changed prompt therefore invalidates the cached result.
        const input = nodeInput({
          kind: NODE_KIND.ask,
          marker: { actorSiteId: message.actorSiteId ?? null, instructions: message.instructions ?? null },
        })
        // The panel's detail view needs the whole task, not a 240-character
        // teaser. Stored bounded so one pathological prompt cannot bloat the row.
        const rawInstructions = typeof message.instructions === 'string'
          ? message.instructions
          : JSON.stringify(message.instructions ?? null)
        const instructionsTruncated = rawInstructions.length > INSTRUCTIONS_LIMIT
        const instructions = instructionsTruncated
          ? rawInstructions.slice(0, INSTRUCTIONS_LIMIT)
          : rawInstructions
        const actorSiteId = message.actorSiteId ?? 'actor#1'
        const actorOrdinal = actorOrdinals.get(actorSiteId) ?? nextActorOrdinal(actorSiteId)

        if (replay) {
          const recorded = journal.findNode(runId, siteId, ordinal)
          if (recorded?.status === NODE_STATUS.completed) {
            if (recorded.inputHash !== input.hash) {
              const error = inputHashMismatch(siteId, ordinal, recorded.inputHash, input.hash)
              reply({ ok: false, error: { message: error.message, code: error.code } })
              abortWith?.(error)
              return
            }
            // Cache hit: the model is NOT called again.
            cachedNodes += 1
            journal.appendEvent(runId, 'node-cached', { siteId, ordinal, kind: NODE_KIND.ask })
            emit({ type: 'node-cached', siteId, ordinal, kind: NODE_KIND.ask })
            reply({ ok: true, value: recorded.result ?? null })
            return
          }
        }
        // A node must name the exact actor instance it called, not just the site:
        // `actor#1@2` in a loop is a different subagent from `actor#1@1`.
        journal.putNode({
          runId,
          siteId,
          ordinal,
          kind: NODE_KIND.ask,
          actorSiteId,
          actorOrdinal,
          inputHash: input.hash,
          input: input.stored,
          status: NODE_STATUS.running,
          // `phase` and a prompt head live in stats: the journal has no column for
          // them, and the panel needs both to draw the timeline it always drew.
          stats: {
            phase: phase ?? null,
            instructionsHead: rawInstructions.slice(0, 240),
            instructions,
            ...(instructionsTruncated ? { instructionsTruncated: true } : {}),
            // Whether this call carried a JSON schema: the panel shows a
            // "structured" badge from the record instead of guessing.
            typed: message.schema !== undefined,
          },
        })
        emit({ type: 'node-start', siteId, ordinal, kind: NODE_KIND.ask, phase })
        try {
          // The actor's identity is `actorSiteId@actorOrdinal`; the ask's own
          // ordinal is only the journal key for this call.
          //
          // Runtime identity wins: `agent(named, { system })` may be created
          // inside a helper or a conditional branch, so the static declaration
          // can be missing or stale. The `actor` event carries the real values;
          // the static map is the fallback for a child that never emitted one
          // (older test doubles, or a script that only asks a cached actor).
          const runtimeActor = runtimeActors.get(actorSiteId)
          const declaration = actorDeclarations.get(actorSiteId)
          const value = await actors.ask({
            siteId: actorSiteId,
            ordinal: actorOrdinal,
            name: runtimeActor?.name ?? declaration?.name,
            persona: runtimeActor?.persona ?? declaration?.persona,
            instructions: message.instructions,
            schema: message.schema,
          })
          syncActors()
          journal.putNode({
            runId,
            siteId,
            ordinal,
            kind: NODE_KIND.ask,
            actorSiteId,
            actorOrdinal,
            inputHash: input.hash,
            input: input.stored,
            status: NODE_STATUS.completed,
            result: value,
            stats: {
              phase: phase ?? null,
              instructionsHead: rawInstructions.slice(0, 240),
              instructions,
              ...(instructionsTruncated ? { instructionsTruncated: true } : {}),
              typed: message.schema !== undefined,
            },
          })
          emit({ type: 'node-end', siteId, ordinal, ok: true })
          reply({ ok: true, value })
        } catch (error) {
          syncActors()
          journal.putNode({
            runId,
            siteId,
            ordinal,
            kind: NODE_KIND.ask,
            actorSiteId,
            actorOrdinal,
            inputHash: input.hash,
            input: input.stored,
            status: NODE_STATUS.failed,
            error: { message: error instanceof Error ? error.message : String(error), code: error?.code },
            stats: {
              phase: phase ?? null,
              instructionsHead: rawInstructions.slice(0, 240),
              instructions,
              ...(instructionsTruncated ? { instructionsTruncated: true } : {}),
              typed: message.schema !== undefined,
            },
          })
          emit({ type: 'node-end', siteId, ordinal, ok: false })
          throw error
        }
        return
      }

      if (message.type === REQUEST.worldRead) {
        const siteId = message.siteId
        const ordinal = nextOrdinal(siteId)
        const op = message.op
        const kind = op === 'run' ? NODE_KIND.worldRun : NODE_KIND.worldRead
        const input = nodeInput({ kind, payload: { op, args: message.args } })

        if (replay) {
          const recorded = journal.findNode(runId, siteId, ordinal)
          if (recorded?.status === NODE_STATUS.completed) {
            if (recorded.inputHash !== input.hash) {
              const error = inputHashMismatch(siteId, ordinal, recorded.inputHash, input.hash)
              reply({ ok: false, error: { message: error.message, code: error.code } })
              abortWith?.(error)
              return
            }
            // A world read is replayed from the journal too: re-running a command
            // could observe a different workspace than the original run.
            cachedNodes += 1
            journal.appendEvent(runId, 'node-cached', { siteId, ordinal, kind })
            emit({ type: 'node-cached', siteId, ordinal, kind })
            reply({ ok: true, value: recorded.result ?? null })
            return
          }
        }
        journal.putNode({
          runId, siteId, ordinal, kind,
          inputHash: input.hash, input: input.stored, status: NODE_STATUS.running,
          stats: { phase: phase ?? null },
        })
        emit({ type: 'node-start', siteId, ordinal, kind, phase, op })
        try {
          const value = await worldOperation(world, op, message.args)
          journal.putNode({
            runId, siteId, ordinal, kind,
            inputHash: input.hash, input: input.stored,
            status: NODE_STATUS.completed,
            result: value,
            stats: { phase: phase ?? null, bytes: typeof value?.stdout === 'string' ? value.stdout.length : undefined },
          })
          emit({ type: 'node-end', siteId, ordinal, ok: true })
          reply({ ok: true, value })
        } catch (error) {
          const shaped = { message: error instanceof Error ? error.message : String(error), code: error?.code }
          journal.putNode({
            runId, siteId, ordinal, kind,
            inputHash: input.hash, input: input.stored,
            status: NODE_STATUS.failed,
            error: shaped,
            stats: { phase: phase ?? null },
          })
          emit({ type: 'node-end', siteId, ordinal, ok: false })
          throw error
        }
        return
      }

      if (message.type === REQUEST.publishArtifact) {
        const siteId = `${message.artifactId ?? 'artifact'}`
        const ordinal = nextOrdinal(siteId)
        const input = nodeInput({
          kind: NODE_KIND.artifact,
          marker: { id: message.artifactId, op: message.op, args: message.args },
        })

        if (replay) {
          const recorded = journal.findNode(runId, siteId, ordinal)
          if (recorded?.status === NODE_STATUS.completed) {
            if (recorded.inputHash !== input.hash) {
              const error = inputHashMismatch(siteId, ordinal, recorded.inputHash, input.hash)
              reply({ ok: false, error: { message: error.message, code: error.code } })
              abortWith?.(error)
              return
            }
            cachedNodes += 1
            journal.appendEvent(runId, 'node-cached', { siteId, ordinal, kind: NODE_KIND.artifact })
            reply({ ok: true, value: recorded.result ?? null })
            return
          }
        }
        try {
          let value
          if (message.op === 'markdown') {
            value = await artifacts.publishMarkdown(message.artifactId, message.args[0], message.args[1] ?? {})
          } else if (message.op === 'file') {
            value = await artifacts.publishFile(message.artifactId, message.args[0], message.args[1] ?? {})
          } else {
            artifacts.declare(message.op, message.artifactId, message.args[0])
            value = undefined
          }
          journal.putNode({
            runId, siteId, ordinal, kind: NODE_KIND.artifact,
            inputHash: input.hash, input: input.stored,
            status: NODE_STATUS.completed, artifactId: message.artifactId,
            // The ref is what a replay hands back, so it has to be recorded.
            result: value,
          })
          reply({ ok: true, value: value === undefined ? null : value })
        } catch (error) {
          journal.putNode({
            runId, siteId, ordinal, kind: NODE_KIND.artifact,
            inputHash: input.hash, input: input.stored,
            status: NODE_STATUS.failed, artifactId: message.artifactId,
            error: { message: error instanceof Error ? error.message : String(error), code: error?.code },
          })
          throw error
        }
        return
      }

      reply({ ok: false, error: { message: `unknown request type ${String(message.type)}` } })
    } catch (error) {
      // The script is allowed to catch this: a failed world read or artifact
      // publish is a value the author can branch on, not a dead run.
      reply({
        ok: false,
        error: {
          message: error instanceof Error ? error.message : String(error),
          code: error?.code ?? 'request_failed',
          violations: error?.violations,
        },
      })
    }
  }

  const handleEvent = (message) => {
    if (message.type === 'phase') {
      phase = message.title
      record('phase-entered', { title: message.title })
      emit({ type: 'phase', title: message.title })
      return
    }
    if (message.type === 'log') {
      record('log', { message: message.message })
      emit({ type: 'log', message: message.message })
      return
    }
    if (message.type === 'report') {
      try {
        const siteId = `report:${message.artifactId ?? 'untagged'}`
        const ordinal = nextOrdinal(siteId)
        // The hash is computed before the cache check: a report whose item
        // changed is a different report, and skipping it would silently drop data.
        const reportInput = nodeInput({
          kind: NODE_KIND.report,
          marker: { artifactId: message.artifactId, item: message.item },
        })
        if (replay) {
          const recorded = journal.findNode(runId, siteId, ordinal)
          if (recorded?.status === NODE_STATUS.completed) {
            if (recorded.inputHash !== reportInput.hash) {
              const error = inputHashMismatch(siteId, ordinal, recorded.inputHash, reportInput.hash)
              abortWith?.(error)
              return
            }
            // Exactly-once: a replayed report adds no event and no node.
            cachedNodes += 1
            return
          }
        }
        const entry = artifacts.report(message.item, message.artifactId)
        journal.putNode({
          runId, siteId, ordinal, kind: NODE_KIND.report,
          inputHash: reportInput.hash,
          status: NODE_STATUS.completed,
          artifactId: message.artifactId ?? null,
          stats: { bytes: entry.bytes },
        })
        record('report', { artifactId: message.artifactId, item: message.item })
        emit({ type: 'report', artifactId: message.artifactId, item: message.item })
      } catch (error) {
        // report() has no rejection channel in the facade: a bad report fails
        // the run, which is why it is surfaced as a completion failure.
        throw error
      }
      return
    }
    if (message.type === 'declare-artifact') {
      artifacts.declare(message.op, message.artifactId, message.spec)
      record('artifact-published', { artifactId: message.artifactId })
      return
    }
    if (message.type === 'actor') {
      // The script declared an actor. The DURABLE creation event comes from the
      // pool (`journalEventSink`), which knows the session id — recording it here
      // too produced two `actor-created` rows for one actor.
      runtimeActors.set(message.siteId, { name: message.name ?? null, persona: message.persona ?? null })
      // The actor may already exist in the pool (a helper created it earlier);
      // refresh its row now so the declared name lands before the ask resolves.
      syncActors()
      emit({ type: 'actor', siteId: message.siteId, name: message.name })
    }
  }

  /** Timers that must be cleared however the run ends. */
  const watchdogs = []

  const outcome = await new Promise((resolve) => {
    const finishOnce = (status, extra) => {
      if (done) return
      done = true
      for (const clear of watchdogs) clear()
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      resolve({ status, extra })
    }

    const onAbort = () => {
      try {
        child.send({ kind: 'cancel', reason: 'the calling tool step was cancelled' })
      } catch {
        // the child may already be gone
      }
      try {
        child.terminate()
      } catch {
        // nothing left to stop
      }
      finishOnce(RUN_STATUS.cancelled, { error: { message: 'the run was cancelled', code: 'cancelled' } })
    }
    if (signal?.aborted === true) onAbort()
    else signal?.addEventListener('abort', onAbort)

    child.onMessage((message) => {
      if (done) return
      for (const clear of watchdogs.splice(0)) clear()
      if (message.kind === 'request') {
        void handleRequest(message)
        return
      }
      if (message.kind === 'event') {
        try {
          handleEvent(message)
        } catch (error) {
          finishOnce(RUN_STATUS.failed, {
            error: {
              name: 'ArtifactError',
              message: error instanceof Error ? error.message : String(error),
              code: error?.code ?? 'artifact',
            },
          })
        }
        return
      }
      if (message.kind === 'complete') {
        if (message.ok === true) {
          finishOnce(RUN_STATUS.completed, { value: message.value })
          return
        }
        const error = message.error ?? { message: 'the workflow failed' }
        finishOnce(RUN_STATUS.failed, { error })
        return
      }
      if (message.kind === 'protocol-error') {
        finishOnce(RUN_STATUS.failed, { error: { message: String(message.reason ?? 'protocol error') } })
      }
    })

    // A child that dies without a completion message must still settle the run.
    void child.waitForExit().then((code) => {
      if (done) return
      finishOnce(RUN_STATUS.failed, {
        error: {
          name: 'WorkflowError',
          message: `the workflow process exited without reporting a result (exit code ${String(code)})`,
          code: 'child_exited',
        },
      })
    })

    // Watchdog: a sandbox that never speaks is a wiring fault, and hanging on it
    // costs the user a whole tool-call timeout with no explanation.
    const firstMessage = setTimeout(() => {
      finishOnce(RUN_STATUS.failed, {
        error: {
          name: 'WorkflowError',
          message: 'the workflow sandbox produced no output within 60s; it may have failed to start',
          code: 'child_silent',
        },
      })
    }, 60_000)
    const clearWatchdog = () => clearTimeout(firstMessage)
    watchdogs.push(clearWatchdog)

    abortWith = (error) => {
      try {
        child.send({ kind: 'cancel', reason: 'the replay diverged' })
      } catch {
        // the child may be busy or gone
      }
      try {
        child.terminate()
      } catch {
        // nothing left to stop
      }
      finishOnce(RUN_STATUS.failed, { error })
    }

    try {
      const record = journal.getRun?.(runId)
      const origin = resumedFrom ?? record?.resumedFrom
      child.send({
        kind: 'start',
        code: script,
        args: args ?? {},
        askSchemas,
        // The script's global `run`: id always, origin only when there is one.
        run: {
          id: runId,
          ...(typeof origin === 'string' && origin !== '' ? { resumedFrom: origin } : {}),
        },
      })
    } catch (error) {
      finishOnce(RUN_STATUS.failed, {
        error: { message: error instanceof Error ? error.message : String(error), code: 'child_unavailable' },
      })
    }
  })

  // Disposal runs on EVERY path — completion, failure, cancellation — before
  // the run is settled. A live `AgentHandle` left behind holds a session write
  // lock, so leaking one would block the next run on that Session.
  // Both the count and the journal rows are taken BEFORE disposal: `dispose()`
  // empties the pool, so reading it afterwards reports zero subagents for a run
  // that used several.
  const agentsStarted = actors.list().length
  syncActors()
  unsubscribeActorSync?.()
  try {
    await actors.dispose()
  } catch {
    // best effort: settlement still records the real outcome
  }
  const settled = settle(outcome.status, outcome.extra)
  return { ...settled, agentsStarted, cachedNodes }
}
