/**
 * Read-only / controlled JSON service for workflow runs.
 *
 * The sidebar panel reaches the engine through seven private HTTP routes. That
 * is fine for the UI, but an external MCP client needs the same facts without a
 * browser: which runs exist, where each run is, which actor sessions it owns,
 * what it spent, and how to stop exactly one run. This module is the public
 * contract between `dsh-workflow-zcode` and any other plugin (notably
 * `dsh-mcp-bridge`).
 *
 * Two rules keep it safe:
 *
 * 1. **No engine internals.** Every method takes and returns plain JSON; the
 *    journal row, the controller map and the launcher stay in `index.mjs`.
 * 2. **Compact by default.** A long run's script, node instructions and trace
 *    are diagnostics; `getRun` omits them unless the caller explicitly asks.
 *
 * @module dsh-workflow-zcode/engine/control-service
 */

/** Service name registered on the Cordis context. */
export const ZCODE_SERVICE_NAME = 'zcodeWorkflow'

/** Contract version advertised to `dsh-mcp-bridge`. */
export const ZCODE_SERVICE_VERSION = '0.2.3'

/** A failure the bridge can translate into a stable MCP error code. */
export class WorkflowServiceError extends Error {
  /**
   * @param {string} code - stable machine-readable code (`WORKFLOW_*`).
   * @param {string} message - human-readable explanation.
   */
  constructor(code, message) {
    super(message)
    this.name = 'WorkflowServiceError'
    this.code = code
  }
}

const RUNNING = new Set(['pending', 'running'])
const MAX_LIMIT = 100

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clampInt(value, fallback, min, max) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(number)))
}

function previewOf(value, limit = 240) {
  if (value === undefined || value === null) return undefined
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return text.length <= limit ? text : `${text.slice(0, limit)}… (${text.length - limit} more characters)`
  } catch {
    return String(value).slice(0, limit)
  }
}

function phaseOf(events, nodes) {
  const entered = events.filter((event) => event.type === 'phase-entered' && typeof event.payload?.title === 'string')
  if (entered.length > 0) return entered[entered.length - 1].payload.title
  const running = nodes.filter((node) => node.status === 'running' && typeof node.stats?.phase === 'string')
  return running.length > 0 ? running[running.length - 1].stats.phase : null
}

function nodeStatsOf(nodes) {
  return {
    total: nodes.length,
    completed: nodes.filter((node) => node.status === 'completed').length,
    running: nodes.filter((node) => node.status === 'running').length,
    failed: nodes.filter((node) => node.status === 'failed').length,
  }
}

function runSummary(run, phase, nodeStats) {
  return {
    runId: run.id,
    name: run.name ?? 'zcode-workflow',
    status: run.status,
    parentSessionId: run.parentSessionId ?? null,
    cwd: run.cwd ?? null,
    phase,
    nodeStats,
    spentTokens: run.spentTokens ?? 0,
    createdAt: run.timeCreated,
    updatedAt: run.timeUpdated,
    durationMs: RUNNING.has(run.status)
      ? Math.max(0, Date.now() - run.timeCreated)
      : Math.max(0, run.timeUpdated - run.timeCreated),
    resumeCount: run.resumeCount ?? 0,
    ...(typeof run.failure?.message === 'string' ? { error: String(run.failure.message).slice(0, 300) } : {}),
  }
}

/**
 * Build the service object.
 *
 * @param {object} deps - engine bindings.
 * @param {object} deps.journal - open run journal.
 * @param {Map<string, {abort: Function}>} [deps.activeRuns] - live run controllers.
 * @param {{resume?: Function}} [deps.launcher] - starts a resume (engine closure).
 * @param {Function} [deps.configure] - updates plan/caps only; must NOT start a run.
 * @param {{get: Function, set: Function}} [deps.sessionPolicy] - journal-backed policy.
 * @param {string} [deps.version] - advertised contract version.
 * @returns {object} the `zcodeWorkflow` service.
 */
export function createWorkflowControlService({
  journal,
  activeRuns = new Map(),
  launcher = {},
  configure,
  sessionPolicy,
  version = ZCODE_SERVICE_VERSION,
} = {}) {
  if (journal === undefined || journal === null) throw new TypeError('createWorkflowControlService needs a journal')

  const runOrThrow = (runId) => {
    if (typeof runId !== 'string' || runId.trim() === '') throw new WorkflowServiceError('WORKFLOW_BAD_REQUEST', 'runId is required')
    const run = journal.getRun(runId.trim())
    if (run === undefined) throw new WorkflowServiceError('WORKFLOW_RUN_NOT_FOUND', `no run \`${runId}\` in this journal`)
    return run
  }

  const scoped = (run, sessionId) => {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      throw new WorkflowServiceError('WORKFLOW_BAD_REQUEST', 'sessionId is required for this workflow operation')
    }
    if (run.parentSessionId !== null && run.parentSessionId !== undefined && run.parentSessionId !== sessionId) {
      throw new WorkflowServiceError('WORKFLOW_FORBIDDEN', `run \`${run.id}\` belongs to another session`)
    }
    return run
  }

  const rows = (run) => {
    const nodes = journal.listNodes(run.id)
    const events = journal.listEvents(run.id)
    return { nodes, events }
  }

  const service = {
    name: ZCODE_SERVICE_NAME,
    version,
    available: true,

    /** Compact run list, optionally scoped to one owning session. */
    async listRuns({ sessionId, cwd, limit = 20, status } = {}) {
      const bounded = clampInt(limit, 20, 1, MAX_LIMIT)
      const runs = journal.listRuns({
        ...(typeof sessionId === 'string' && sessionId.trim() !== '' ? { parentSessionId: sessionId.trim() } : {}),
        ...(typeof cwd === 'string' && cwd.trim() !== '' ? { cwd: cwd.trim() } : {}),
        limit: bounded,
      })
      const filtered = typeof status === 'string' && status !== '' ? runs.filter((run) => run.status === status) : runs
      return {
        runs: filtered.slice(0, bounded).map((run) => {
          const { nodes, events } = rows(run)
          return runSummary(run, phaseOf(events, nodes), nodeStatsOf(nodes))
        }),
      }
    },

    /**
     * One run's progress. `includeScript` / `includeTrace` are the only ways to
     * get the large diagnostics; everything else is compact by construction.
     */
    async getRun({ runId, sessionId, includeScript = false, includeTrace = false, maxNodes = 50, maxEvents = 50 } = {}) {
      const run = scoped(runOrThrow(runId), sessionId)
      const { nodes, events } = rows(run)
      const actors = journal.listActors(run.id)
      const artifacts = journal.listArtifacts(run.id)
      const nodeLimit = clampInt(maxNodes, 50, 1, 500)
      const eventLimit = clampInt(maxEvents, 50, 1, 500)
      const shownNodes = nodes.slice(-nodeLimit)
      const summary = runSummary(run, phaseOf(events, nodes), nodeStatsOf(nodes))
      const phases = []
      for (const event of events) {
        if (event.type !== 'phase-entered' || typeof event.payload?.title !== 'string') continue
        if (phases[phases.length - 1] !== event.payload.title) phases.push(event.payload.title)
      }
      return {
        ...summary,
        phases,
        nodes: shownNodes.map((node) => ({
          siteId: node.siteId,
          ordinal: node.ordinal,
          kind: node.kind,
          actorSiteId: node.actorSiteId,
          status: node.status,
          phase: typeof node.stats?.phase === 'string' ? node.stats.phase : null,
          startedAt: node.timeCreated,
          finishedAt: node.timeUpdated,
          durationMs: Math.max(0, node.timeUpdated - node.timeCreated),
          ...(node.result === undefined ? {} : { resultPreview: previewOf(node.result) }),
          ...(typeof node.error?.message === 'string' ? { error: node.error.message.slice(0, 300) } : {}),
        })),
        nodesTruncated: nodes.length > shownNodes.length,
        actors: actors.map((actor) => {
          const own = nodes.filter((node) => node.actorSiteId === actor.siteId)
          return {
            siteId: actor.siteId,
            ordinal: actor.ordinal,
            name: actor.name,
            sessionId: actor.sessionId,
            model: actor.resolvedModel,
            tokens: actor.tokens ?? 0,
            phase: own.find((node) => typeof node.stats?.phase === 'string')?.stats.phase ?? null,
            nodes: nodeStatsOf(own),
          }
        }),
        artifacts: artifacts.map((artifact) => ({
          id: artifact.artifactId,
          kind: artifact.kind,
          title: artifact.title,
          version: artifact.version,
          primary: artifact.primary,
          itemCount: artifact.itemCount,
          sourcePath: artifact.sourcePath,
        })),
        ...(includeScript === true && typeof run.scriptText === 'string' ? { script: run.scriptText } : {}),
        ...(includeTrace === true
          ? {
              trace: events.slice(-eventLimit).map((event) => ({
                sequence: event.sequence,
                type: event.type,
                at: event.time,
                payload: previewOf(event.payload, 500),
              })),
            }
          : {}),
      }
    },

    /** Compact progress for every active run of one session (for MCP waits). */
    async progress({ sessionId, limit = 5 } = {}) {
      if (typeof sessionId !== 'string' || sessionId.trim() === '') {
        throw new WorkflowServiceError('WORKFLOW_BAD_REQUEST', 'sessionId is required')
      }
      const bounded = clampInt(limit, 5, 1, 20)
      const runs = journal.listRuns({ parentSessionId: sessionId.trim(), limit: 64 })
        .filter((run) => RUNNING.has(run.status))
        .slice(0, bounded)
      return {
        runs: runs.map((run) => {
          const { nodes, events } = rows(run)
          return runSummary(run, phaseOf(events, nodes), nodeStatsOf(nodes))
        }),
      }
    },

    /** Abort one live run without touching its parent session. */
    async cancelRun({ runId, sessionId } = {}) {
      const run = scoped(runOrThrow(runId), sessionId)
      const controller = activeRuns.get(run.id)
      if (controller === undefined) {
        throw new WorkflowServiceError('WORKFLOW_NOT_RUNNING', `run \`${run.id}\` is ${run.status}; only a running or pending run can be stopped`)
      }
      controller.abort('cancelled through the workflow service')
      return { runId: run.id, status: 'cancelling', cancelled: true }
    },

    /** Resume a failed/cancelled run; optional overrides are applied first. */
    async resumeRun({ runId, sessionId, allowRehydrate = false, maxConcurrency, subagentModel } = {}) {
      const run = scoped(runOrThrow(runId), sessionId)
      if (launcher?.resume === undefined) {
        throw new WorkflowServiceError('WORKFLOW_UNAVAILABLE', 'resume is not available in this composition')
      }
      const value = await launcher.resume(run.id, {
        allowRehydrate: allowRehydrate === true,
        ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
        ...(subagentModel === undefined ? {} : { subagentModel }),
      })
      return { ...value, runId: value?.runId ?? run.id }
    },

    /** Update plan/caps only. Never starts a run. */
    async configureRun({ runId, sessionId, maxConcurrency, subagentModel } = {}) {
      const run = scoped(runOrThrow(runId), sessionId)
      if (configure === undefined) {
        throw new WorkflowServiceError('WORKFLOW_UNAVAILABLE', 'configuration is not available in this composition')
      }
      if (RUNNING.has(run.status)) {
        throw new WorkflowServiceError('WORKFLOW_BAD_STATE', `run \`${run.id}\` is ${run.status}; stop it before changing settings`)
      }
      if (run.status === 'completed') {
        throw new WorkflowServiceError('WORKFLOW_BAD_STATE', `run \`${run.id}\` completed; start a new workflow instead of rewriting it`)
      }
      const value = await configure(run.id, {
        ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
        ...(subagentModel === undefined ? {} : { subagentModel }),
      })
      return { runId: run.id, ...value, resumed: false }
    },

    /** Remove one settled run and its journal rows. */
    async deleteRun({ runId, sessionId } = {}) {
      const run = scoped(runOrThrow(runId), sessionId)
      if (activeRuns.has(run.id)) {
        throw new WorkflowServiceError('WORKFLOW_RUNNING', `run \`${run.id}\` is still running`)
      }
      if (RUNNING.has(run.status)) {
        throw new WorkflowServiceError('WORKFLOW_RUNNING', `run \`${run.id}\` is ${run.status}`)
      }
      const deleted = journal.deleteRun(run.id)
      return { runId: run.id, deleted: Boolean(deleted) }
    },

    /** Whether a session auto-approves the next workflow execution. */
    async getSessionPolicy({ sessionId } = {}) {
      if (typeof sessionId !== 'string' || sessionId.trim() === '') {
        throw new WorkflowServiceError('WORKFLOW_BAD_REQUEST', 'sessionId is required')
      }
      const autoApprove = sessionPolicy?.get === undefined ? false : Boolean(await sessionPolicy.get(sessionId.trim()))
      return { sessionId: sessionId.trim(), autoApprove }
    },

    /** Set (or clear) the session's workflow auto-execution policy. */
    async setSessionPolicy({ sessionId, autoApprove } = {}) {
      if (typeof sessionId !== 'string' || sessionId.trim() === '') {
        throw new WorkflowServiceError('WORKFLOW_BAD_REQUEST', 'sessionId is required')
      }
      if (typeof autoApprove !== 'boolean') {
        throw new WorkflowServiceError('WORKFLOW_BAD_REQUEST', 'autoApprove must be a boolean')
      }
      if (sessionPolicy?.set === undefined) {
        throw new WorkflowServiceError('WORKFLOW_UNAVAILABLE', 'session policy is not available in this composition')
      }
      const value = Boolean(await sessionPolicy.set(sessionId.trim(), autoApprove))
      return { sessionId: sessionId.trim(), autoApprove: value }
    },
  }

  return service
}
