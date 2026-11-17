/**
 * Read-only projection of the journal for the sidebar panel.
 *
 * The panel is a station diagram: a header, a vertical timeline of phases, and
 * a grid of artifacts. Three rules shape this projection:
 *
 * 1. **A phase that has not run yet is still a station.** The script's declared
 *    phases (`dwf_run.plan_json.phases`) are merged with the observed
 *    `phase-entered` events, so the reader sees the whole line, not only the
 *    part the run has reached.
 * 2. **A workspace step is labelled by what it ran.** `world.run("python3", …)`
 *    renders as a command, never as an anonymous subagent.
 * 3. **Nothing is invented.** Every field below comes from a journal row or a
 *    plan stored at run creation; a missing value is omitted by `jsonSafe`.
 *
 * @module dsh-workflow-zcode/engine/trace-projection
 */

import { jsonSafe } from './json.mjs'

const WORLD_KINDS = new Set(['world-run', 'world-read'])

/** Human-readable label for one world operation. */
export function worldCommandLabel(node) {
  const input = node.input ?? {}
  const op = typeof input.op === 'string' ? input.op : 'world'
  const args = Array.isArray(input.args) ? input.args : []
  if (op === 'run') {
    const command = typeof args[0] === 'string' ? args[0] : 'command'
    const rest = Array.isArray(args[1]) ? args[1].map((value) => String(value)) : []
    return [command, ...rest].join(' ')
  }
  if (op === 'files.read') return `read ${args[0] ?? ''}`.trim()
  if (op === 'files.glob') return `glob ${args[0] ?? ''}`.trim()
  if (op === 'files.grep') return `grep ${args[0] ?? ''}`.trim()
  if (op.startsWith('git.')) return op
  return op
}

const stateOf = (status) => {
  if (status === 'completed') return 'settled'
  if (status === 'failed') return 'failed'
  return 'running'
}

/** The result preview a collapsed card shows before it is expanded. */
function previewOf(result) {
  if (result === undefined) return undefined
  if (typeof result === 'string') return result.slice(0, 240)
  try {
    return JSON.stringify(result).slice(0, 240)
  } catch {
    return String(result).slice(0, 240)
  }
}

/**
 * Phase identity normalisation.
 *
 * A phase name may be computed at run time (`"Phase 1 · " + sceneId`), so the
 * plan entry is `undefined` while the event carries the real title. Null plan
 * entries are therefore placeholders to be bound in observation order.
 */
function planTitleOf(entry) {
  if (typeof entry === 'string') return entry.trim() === '' ? null : entry
  if (entry !== null && typeof entry === 'object') {
    const value = entry.name ?? entry.title ?? entry.id
    return typeof value === 'string' && value.trim() !== '' ? value : null
  }
  return null
}

/** One role bucket inside a phase: an actor, or the workspace command group. */
function bucketOf(node) {
  return WORLD_KINDS.has(node.kind) ? '__world__' : (node.actorSiteId ?? '__unknown__')
}

function roleState(settled, failed, running, total) {
  if (failed > 0) return 'failed'
  if (running > 0) return 'running'
  if (total > 0 && settled === total) return 'completed'
  return 'pending'
}

/**
 * @param {object} journal an open journal
 * @returns {object} the read-only store the Host routes serve
 */
export function createTraceStore(journal) {
  /** Build the ordered phase list: planned + observed, with nodes attached. */
  function buildPhases(run, nodes, actors) {
    const phaseEvents = journal.listEventsOfType(run.id, 'phase-entered')
    const observedTitles = phaseEvents
      .map((event) => (typeof event.payload?.title === 'string' ? event.payload.title : null))

    const planPhases = Array.isArray(run.plan?.phases) ? run.plan.phases : []
    const entries = planPhases.map((entry, index) => ({
      id: `P${index}`,
      title: planTitleOf(entry),
      ordinal: index + 1,
      planned: true,
      observed: false,
    }))

    // Bind observed titles to the plan. A runtime-computed name has a null
    // placeholder; consuming it in order keeps the plan's station sequence.
    for (const title of observedTitles) {
      if (title !== null && entries.some((entry) => entry.title === title)) continue
      const placeholder = entries.find((entry) => entry.title === null && entry.observed === false)
      if (placeholder !== undefined) {
        placeholder.title = title ?? '(未命名阶段)'
        placeholder.observed = true
        continue
      }
      entries.push({
        id: `P${entries.length}`,
        title: title ?? '(未命名阶段)',
        ordinal: entries.length + 1,
        planned: false,
        observed: true,
        unphased: true,
      })
    }
    for (const entry of entries) {
      if (entry.observed === false && entry.title !== null
        && observedTitles.includes(entry.title)) entry.observed = true
    }


    // A node can carry a phase the plan never declared (older runs stored no
    // plan); keep it visible rather than dropping the work.
    for (const node of nodes) {
      const title = node.phase
      if (title === null || title === undefined) continue
      if (entries.some((entry) => entry.title === title)) continue
      entries.push({ id: `P${entries.length}`, title, ordinal: entries.length + 1, planned: false, observed: true })
    }

    // Work that ran before the first `phase(...)` has no phase title. Dropping
    // it would hide real calls from the timeline AND under-count `M/N steps`,
    // so it gets its own station at the end of the line.
    const unphased = nodes.filter((node) => node.phase === null || node.phase === undefined)
    if (unphased.length > 0) {
      entries.push({
        id: `P${entries.length}`,
        title: '未分阶段',
        ordinal: entries.length + 1,
        planned: false,
        observed: true,
        unphased: true,
      })
    }

    // A dynamic `phase(expr)` compiles to an anonymous placeholder. Only the
    // ones the run ACTUALLY reached became stations; the remaining placeholders
    // (conditional branches, retry paths, later phases of a long run) must not
    // render as a row of `(未命名阶段)`. Static named phases stay as pending
    // stations even when unobserved.
    const visibleEntries = entries.filter((entry) => !(entry.title === null && entry.observed === false))

    const actorBySite = new Map(actors.map((actor) => [actor.siteId, actor]))
    const lastObservedIndex = visibleEntries.reduce((last, entry, index) => (entry.observed ? index : last), -1)
    const runRunning = run.status === 'running' || run.status === 'pending'

    return visibleEntries.map((entry, index) => {
      const phaseNodes = entry.unphased === true
        ? nodes.filter((node) => node.phase === null || node.phase === undefined)
        : nodes.filter((node) => node.phase === entry.title)
      const settled = phaseNodes.filter((node) => node.state === 'settled').length
      const failed = phaseNodes.filter((node) => node.state === 'failed').length
      const running = phaseNodes.filter((node) => node.state === 'running').length

      let status
      if (failed > 0) status = 'failed'
      else if (running > 0) status = 'running'
      else if (entry.observed === false) status = 'pending'
      else if (runRunning && index === lastObservedIndex) status = 'running'
      else status = 'completed'

      const buckets = new Map()
      for (const node of phaseNodes) {
        const key = bucketOf(node)
        if (!buckets.has(key)) {
          const actor = actorBySite.get(key)
          buckets.set(key, {
            key,
            kind: key === '__world__' ? 'world' : 'actor',
            siteId: key === '__world__' || key === '__unknown__' ? null : key,
            name: key === '__world__'
              ? '工作区命令'
              : (actor?.name ?? (key === '__unknown__' ? '未指派' : key)),
            model: actor?.resolvedModel ?? null,
            total: 0,
            settled: 0,
            failed: 0,
            running: 0,
          })
        }
        const bucket = buckets.get(key)
        bucket.total += 1
        if (node.state === 'settled') bucket.settled += 1
        if (node.state === 'failed') bucket.failed += 1
        if (node.state === 'running') bucket.running += 1
      }
      const roles = [...buckets.values()].map((bucket) => ({
        ...bucket,
        state: roleState(bucket.settled, bucket.failed, bucket.running, bucket.total),
      }))

      return {
        id: entry.id,
        ordinal: entry.ordinal,
        title: entry.title ?? '(未命名阶段)',
        status,
        planned: entry.planned,
        settledCount: settled,
        observedCount: phaseNodes.length,
        totalCount: phaseNodes.length,
        rounds: Math.max(1, observedTitles.filter((title) => title === entry.title).length),
        actors: roles.filter((role) => role.kind === 'actor').map((role) => role.siteId),
        roles,
        // The drill-down reads the phase's own nodes. Keeping them only on the
        // top-level list made every role pill open an empty list.
        nodes: phaseNodes,
      }
    })
  }

  return {
    async listRuns({ parentSessionId, cwd, limit = 64 } = {}) {
      const runs = journal.listRuns({ parentSessionId, cwd, limit }).map((run) => {
        const nodes = journal.listNodes(run.id)
        const asks = nodes.filter((node) => node.kind === 'ask')
        return {
          runId: run.id,
          workflowId: run.name ?? 'zcode-workflow',
          status: run.status,
          // Scope fields: the panel groups by them and the routes filter on them.
          parentSessionId: run.parentSessionId ?? null,
          cwd: run.cwd ?? null,
          maxConcurrency: run.capsMaxConcurrency ?? 0,
          subagentModel: run.plan?.subagentModel?.label ?? null,
          description: run.plan?.description ?? null,
          startedAt: run.timeCreated,
          updatedAt: run.timeUpdated,
          durationMs: (run.status === 'running' || run.status === 'pending')
            ? Math.max(0, Date.now() - run.timeCreated)
            : Math.max(0, run.timeUpdated - run.timeCreated),
          phases: journal.listEvents(run.id).filter((event) => event.type === 'phase-entered').length,
          nodes: asks.length,
          worldSteps: nodes.filter((node) => WORLD_KINDS.has(node.kind)).length,
          ...(run.failure?.message === undefined ? {} : { failure: String(run.failure.message).slice(0, 200) }),
          resumeCount: run.resumeCount ?? 0,
        }
      })
      // The route serialises this: a single `undefined` key would be rejected
      // by the transport as "not lossless JSON".
      return jsonSafe({ runs })
    },

    /** Remove one settled run (used by the panel's cleanup action). */
    async deleteRun(runId) {
      return journal.deleteRun(runId)
    },

    async readRun(runId) {
      const run = journal.getRun(runId)
      if (run === undefined) throw new Error(`no run ${runId}`)
      const nodes = journal.listNodes(runId)
      const actors = journal.listActors(runId)
      const events = journal.listEvents(runId)
      const artifacts = journal.listArtifacts(runId)

      const actorNameOf = (siteId) => actors.find((actor) => actor.siteId === siteId)?.name ?? null
      const actorModelOf = (siteId) => actors.find((actor) => actor.siteId === siteId)?.resolvedModel ?? null

      const reports = events
        .filter((event) => event.type === 'report')
        // `tag` is the field the older panel reads; `artifactId` is the same
        // value under the name the new cards use.
        .map((event) => {
          const artifactId = event.payload?.artifactId ?? null
          return { tag: artifactId, artifactId, item: event.payload?.item }
        })

      const projectedNodes = nodes
        .filter((node) => node.kind === 'ask' || WORLD_KINDS.has(node.kind))
        .map((node) => {
          const typed = node.stats?.typed === true
          const isWorld = WORLD_KINDS.has(node.kind)
          return {
            siteId: node.siteId,
            ordinal: node.ordinal,
            kind: node.kind,
            roleKey: bucketOf(node),
            actorSiteId: node.actorSiteId,
            actorName: node.actorSiteId === null ? null : actorNameOf(node.actorSiteId),
            actorModel: node.actorSiteId === null ? null : actorModelOf(node.actorSiteId),
            actorOrdinal: node.actorOrdinal,
            phase: node.stats?.phase ?? null,
            state: stateOf(node.status),
            typed,
            hasSchema: typed,
            // The FULL task prompt is stored in `stats.instructions`; the head
            // is only for the collapsed row, so the detail view is not truncated.
            instructions: node.stats?.instructions ?? node.stats?.instructionsHead ?? '',
            instructionsHead: node.stats?.instructionsHead
              ?? (isWorld ? worldCommandLabel(node) : ''),
            ...(node.stats?.instructionsTruncated === true ? { instructionsTruncated: true } : {}),
            ...(isWorld ? { worldCommand: worldCommandLabel(node) } : {}),
            startedAt: node.timeCreated,
            finishedAt: node.timeUpdated,
            durationMs: Math.max(0, node.timeUpdated - node.timeCreated),
            // Omitted rather than set to undefined: an `error: undefined` key is
            // not lossless JSON and would fail the transport's validation.
            ...(node.result === undefined ? {} : { result: JSON.stringify(node.result, null, 2) }),
            ...(node.result === undefined ? {} : { resultPreview: previewOf(node.result) }),
            ...(node.error?.message === undefined ? {} : { error: node.error.message }),
            sequence: node.ordinal,
          }
        })

      const phases = buildPhases(run, projectedNodes, actors)
      const phaseOfActor = new Map()
      for (const phase of phases) {
        for (const role of phase.roles) {
          if (role.kind === 'actor' && !phaseOfActor.has(role.siteId)) phaseOfActor.set(role.siteId, phase.title)
        }
      }

      const settledSteps = phases.reduce((sum, phase) => sum + phase.settledCount, 0)
      const totalSteps = phases.reduce((sum, phase) => sum + phase.observedCount, 0)
      const firstModel = actors.find((actor) => typeof actor.resolvedModel === 'string' && actor.resolvedModel !== '')?.resolvedModel ?? null

      const configEvents = events
        .filter((event) => event.type === 'run-configured')
        .map((event) => ({ at: event.time, ...event.payload }))

      return jsonSafe({
        runId: run.id,
        workflowId: run.name ?? 'zcode-workflow',
        status: run.status,
        parentSessionId: run.parentSessionId ?? null,
        cwd: run.cwd ?? null,
        description: run.plan?.description ?? null,
        subagentModel: run.plan?.subagentModel?.label ?? null,
        // Actors the script DECLARED, even if the run never created them (a
        // pending phase). The roster merges these with created actors.
        declaredActors: (Array.isArray(run.plan?.actors) ? run.plan.actors : []).map((actor) => ({
          siteId: actor.id ?? actor.siteId ?? null,
          name: actor.name ?? null,
          persona: actor.persona ?? null,
        })),
        configEvents,
        startedAt: run.timeCreated,
        finishedAt: run.timeUpdated,
        durationMs: (run.status === 'running' || run.status === 'pending')
          ? Math.max(0, Date.now() - run.timeCreated)
          : Math.max(0, run.timeUpdated - run.timeCreated),
        maxConcurrency: run.capsMaxConcurrency ?? 0,
        resumedFrom: run.resumedFrom ?? null,
        resumeCount: run.resumeCount ?? 0,
        ...(run.timeLastResumed === undefined ? {} : { lastResumedAt: run.timeLastResumed }),
        spentTokens: run.spentTokens ?? 0,
        sourcePath: run.plan?.sourcePath ?? null,
        resolvedModel: firstModel,
        settledSteps,
        totalSteps,
        artifactCount: artifacts.length,
        phases,
        actors: actors.map((actor) => ({
          siteId: actor.siteId,
          name: actor.name,
          ordinal: actor.ordinal,
          persona: actor.persona,
          model: actor.resolvedModel,
          sessionId: actor.sessionId,
          tokens: actor.tokens ?? 0,
          phase: phaseOfActor.get(actor.siteId) ?? null,
          startedAt: run.timeCreated,
          finishedAt: run.timeUpdated,
          nodes: projectedNodes.filter((node) => node.actorSiteId === actor.siteId).length,
          durationMs: projectedNodes
            .filter((node) => node.actorSiteId === actor.siteId)
            .reduce((sum, node) => sum + (node.durationMs ?? 0), 0),
        })),
        nodes: projectedNodes,
        reports,
        artifacts: artifacts.map((artifact) => ({
          id: artifact.artifactId,
          op: artifact.kind,
          kind: artifact.kind,
          title: artifact.title,
          description: artifact.description,
          contentType: artifact.contentType,
          sourcePath: artifact.sourcePath,
          version: artifact.version,
          primary: artifact.primary,
          itemCount: artifact.itemCount,
          spec: artifact.spec,
          ...(artifact.body === null || artifact.body === undefined ? {} : { body: artifact.body }),
          // Which reports fed this artifact, so a dashboard can be inspected
          // without the panel knowing anything about its spec.
          reports: reports.filter((report) => report.artifactId === artifact.artifactId),
        })),
        ...(run.failure?.message === undefined ? {} : { error: run.failure.message }),
      })
    },
  }
}