/**
 * `dsh-workflow-zcode` — run ZCode dynamic workflows (`.dwf.ts`) on DSH.
 *
 * This plugin is a **self-contained workflow engine**. It does not use
 * `ctx.workflowEngine` (`dsh-workflow-ptc`): the script runs in its own sandbox
 * child process, the journal is a local SQLite database, the subagents are
 * persistent sessions owned by this plugin, and the workspace surface is built
 * on `ctx.sandbox` + `ctx.subprocess`. The engine core lives in `src/engine/`
 * and is deliberately free of DSH imports; `src/engine/host-adapter.mjs` is the
 * only file that talks to the Host.
 *
 * Two model-facing tools:
 *
 * - `run_zcode_workflow` — compile a script or saved `.dwf.ts` file, run it, and
 *   return its value plus the reports and artifacts it published;
 * - `list_zcode_workflows` — list saved workflows visible from this Session.
 *
 * @module dsh-workflow-zcode
 */

import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'

import { compile, loadTypeScript } from './src/compiler.mjs'
import { FRONTMATTER_ERRORS, normalizeFrontmatter, parseFrontmatterYaml, resolveArgs, splitFrontmatter } from './src/frontmatter.mjs'
import { openJournal, RUN_STATUS } from './src/engine/journal.mjs'
import { createArtifactPublisher } from './src/engine/artifacts.mjs'
import { createWorld } from './src/engine/world.mjs'
import { createActorPool } from './src/engine/actor-pool.mjs'
import { executeRun } from './src/engine/run-service.mjs'
import { createAgentRuntime, createChildProcess, createHostExec, resolveChildAgentOptions } from './src/engine/host-adapter.mjs'
import { jsonSafe } from './src/engine/json.mjs'
import { createTraceStore } from './src/engine/trace-projection.mjs'

export const name = 'dsh-workflow-zcode'

/**
 * Everything the engine needs from the Host. All of it is required: without a
 * child-process service there is no sandbox, and without the Agent service there
 * are no subagents, so the plugin stays inactive rather than half-working.
 */
export const inject = {
  tools: { required: true },
  agents: { required: true },
  subagents: { required: true },
  sandbox: { required: true },
  sandboxPolicy: { required: true },
  subprocess: { required: true },
  sessions: { required: false },
  workingDirectory: { required: false },
  connection: { required: false },
  userQuestions: { required: false },
}

const DEFAULTS = {
  runToolName: 'run_zcode_workflow',
  listToolName: 'list_zcode_workflows',
  resumeToolName: 'resume_zcode_workflow',
  typeCheck: true,
  confirmExecution: 'ask',
  maxTotalAgents: 200,
  // The origin's 最大并发数: simultaneous subagent turns, NOT the lifetime
  // agent ceiling. 13 is the dashboard's default; users can change it per run.
  maxConcurrency: 13,
  subagentModel: '',
  globalWorkflowDir: '',
  projectWorkflowDir: '.zcode/workflows',
  journalFile: '',
  snapshotDir: '',
}

/** Build the complete JSON Schema root `tools.register()` expects. */
function toolParameters(properties, required = []) {
  return {
    type: 'object',
    properties,
    ...(required.length === 0 ? {} : { required }),
  }
}

const DESCRIPTION = `Run a ZCode dynamic workflow: a TypeScript orchestration script that fans work out across subagents.

ZCode authoring surface:
- \`agent(name, persona)\` creates a NAMED subagent. Its session persists, so later asks on the same actor accumulate context.
- \`await actor.ask<T>(instructions)\` runs one turn. With a \`T\` declared as a local \`interface\`, the value comes back schema-validated; without \`T\` it is the child's final text.
- \`phase("...")\` declares a phase; \`log("...")\` narrates; \`report(item, artifactId?)\` feeds a declared artifact.
- \`artifact.markdown(id, text, opts?)\` / \`artifact.file(id, path, opts?)\` publish deliverables (awaitable, catchable).
- \`artifact.chart|table|metrics|board(id, spec)\` DECLARE a dashboard fed by report() (synchronous, no await).
- \`world.run(command, args, { timeoutMs })\`, \`files.read/glob/grep\`, \`git.changedFiles/diff/status/log\` read the workspace read-only, without a shell.
- \`args\` holds the validated workflow arguments.

Submit either \`script\` (the body) or \`path\` (a saved \`.dwf.ts\` whose front matter declares the arguments).`

/**
 * Open the journal once per plugin instance. It is the run's source of truth:
 * the sidebar panel, the resume path and the failure history all read it.
 */
function openRunJournal(settings) {
  const file = settings.journalFile !== ''
    ? settings.journalFile
    : join(homedir(), '.dsh', 'zcode-workflow', 'runs.db')
  const journal = openJournal({ file })
  // A previous host process may have died mid-run. Those rows cannot make
  // progress any more; settle them now so the panel stops spinning and resume
  // can pick them up.
  try {
    journal.reconcileInterruptedRuns()
  } catch {
    // a corrupt or locked journal must not prevent the plugin from loading
  }
  return journal
}

export function apply(ctx, config = {}) {
  const merged = { ...DEFAULTS, ...(config ?? {}) }
  const settings = {
    runToolName: String(merged.runToolName),
    listToolName: String(merged.listToolName),
    resumeToolName: String(merged.resumeToolName),
    typeCheck: merged.typeCheck !== false,
    confirmExecution: resolveConfirmExecution(merged.confirmExecution),
    maxTotalAgents: Number(merged.maxTotalAgents ?? 200),
    maxConcurrency: Number(merged.maxConcurrency ?? 13),
    subagentModel: typeof merged.subagentModel === 'string' ? merged.subagentModel : '',
    globalWorkflowDir: merged.globalWorkflowDir || join(homedir(), '.zcode', 'workflows'),
    projectWorkflowDir: merged.projectWorkflowDir || '.zcode/workflows',
    journalFile: typeof merged.journalFile === 'string' ? merged.journalFile : '',
    snapshotDir: typeof merged.snapshotDir === 'string' ? merged.snapshotDir : '',
  }

  const journal = openRunJournal(settings)
  ctx.effect?.(() => () => {
    // Abort first: a controller that is still driving a child would keep
    // writing into a journal we are about to close.
    for (const controller of activeRuns.values()) {
      try {
        controller.abort('the host unloaded the workflow plugin')
      } catch {
        // already settled
      }
    }
    try {
      journal.close()
    } catch {
      // a double close during unload is harmless
    }
  }, 'dsh-workflow-zcode: journal')

  /** runId → controller, so a session stop can cancel exactly its own runs. */
  const activeRuns = new Map()
  /** parentSessionId → Set<runId>, for `workspace/session-stop`. */
  const runsBySession = new Map()

  const trackRun = (runId, parentSessionId, controller) => {
    activeRuns.set(runId, controller)
    if (parentSessionId !== undefined) {
      let set = runsBySession.get(parentSessionId)
      if (set === undefined) {
        set = new Set()
        runsBySession.set(parentSessionId, set)
      }
      set.add(runId)
    }
  }
  const untrackRun = (runId, parentSessionId) => {
    activeRuns.delete(runId)
    const set = runsBySession.get(parentSessionId)
    if (set !== undefined) {
      set.delete(runId)
      if (set.size === 0) runsBySession.delete(parentSessionId)
    }
  }
  const tracking = { trackRun, untrackRun, activeRuns }

  // Archiving or stopping a session must stop the work it started: the subagent
  // sessions this plugin owns hold write locks, and nothing else would end them.
  ctx.on?.('workspace/session-stop', (request) => {
    const sessionId = request?.sessionId ?? request?.session?.id
    const set = runsBySession.get(sessionId)
    if (set === undefined) return
    for (const runId of [...set]) {
      const controller = activeRuns.get(runId)
      if (controller !== undefined) {
        try {
          controller.abort('the owning session was stopped')
        } catch {
          // already settled
        }
      }
    }
  })

  const store = createTraceStore(journal)
  registerRunRoutes(ctx, store, {
    activeRuns,
    sessionPolicy: {
      get: (sessionId) => journal.isSessionAutoApproved(sessionId),
      set: (sessionId, enabled) => journal.setSessionAutoApprove(sessionId, enabled),
    },
    launcher: {
      resume: (runId, overrides) => startResumeFromUi({ ctx, settings, journal, tracking, runId, overrides }),
      configure: (runId, overrides) => configureRunFromUi({ ctx, settings, journal, tracking, runId, overrides }),
    },
  })

  ctx.tools.register(defineRunTool(ctx, settings, journal, { trackRun, untrackRun, activeRuns }))
  ctx.tools.register(defineResumeTool(ctx, settings, journal, { trackRun, untrackRun, activeRuns }))
  ctx.tools.register(defineListTool(ctx, settings))
}

function defineRunTool(ctx, settings, journal, tracking) {
  return {
    name: settings.runToolName,
    description: DESCRIPTION,
    parameters: toolParameters({
      script: {
        type: 'string',
        description: 'The workflow body as TypeScript, without a front-matter block. Provide this or `path`.',
      },
      path: {
        type: 'string',
        description: 'A saved `.dwf.ts` workflow file, relative to the Session working directory or absolute.',
      },
      args: {
        type: 'object',
        additionalProperties: true,
        description: 'Workflow arguments. A saved file rejects unknown, missing and mistyped arguments before the run starts.',
      },
      name: {
        type: 'string',
        description: 'Display name for the run; defaults to the saved file name or `zcode-workflow`.',
      },
      max_total_agents: {
        type: 'number',
        description: 'Optional cap on subagent calls for this run (lifetime ceiling).',
      },
      max_concurrency: {
        type: 'number',
        description: 'Optional simultaneous subagent turns (1-64). Defaults to the plugin setting (13).',
      },
      subagent_model: {
        type: 'string',
        description: 'Optional subagent model as "provider/model", or "session" to follow the calling session model.',
      },
      dry_run: {
        type: 'boolean',
        description: 'Compile and report diagnostics, phases and the subagent/command inventory without running anything.',
      },
    }),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: renderEnvelope(value) }]
      },
    },
    async execute(args, exec) {
      // The Host rejects a return value that is not losslessly JSON; a single
      // `undefined` key anywhere in the envelope would fail the whole call.
      return jsonSafe(await runWorkflowTool(ctx, settings, journal, tracking, args, exec))
    },
  }
}

function defineResumeTool(ctx, settings, journal, tracking) {
  return {
    name: settings.resumeToolName,
    description:
      'Resume a ZCode workflow run that failed or was cancelled, reusing everything it already completed. '
      + 'Nodes whose recorded input still matches are replayed from the journal at zero token cost; '
      + 'subagent sessions are reattached, not recreated. Refuses a run whose script no longer compiles to the recorded hash.',
    parameters: toolParameters({
      run_id: {
        type: 'string',
        description: 'The run id returned by a previous run_zcode_workflow call.',
      },
      allow_rehydrate: {
        type: 'boolean',
        description:
          'Continue with a fresh subagent session when a recorded one is gone. That loses the actor\'s earlier turns, '
          + 'so the default is to fail with actor_session_missing.',
      },
      max_concurrency: {
        type: 'number',
        description: 'Optional new simultaneous-subagent limit for the resumed attempt (1-64).',
      },
      subagent_model: {
        type: 'string',
        description: 'Optional subagent model override for the resumed attempt ("provider/model" or "session").',
      },
    }, ['run_id']),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: renderEnvelope(value) }]
      },
    },
    async execute(args, exec) {
      return jsonSafe(await resumeWorkflowTool(ctx, settings, journal, tracking, args, exec))
    },
  }
}

async function resumeWorkflowTool(ctx, settings, journal, tracking, args, exec) {
  const parentAgent = exec.agent
  if (parentAgent === undefined) {
    return { error: { message: 'resuming a workflow needs a calling agent (exec.agent was undefined)' } }
  }
  const runId = typeof args?.run_id === 'string' ? args.run_id.trim() : ''
  if (runId === '') return { error: { message: 'run_id is required' } }

  const run = journal.getRun(runId)
  if (run === undefined) return { error: { message: `no run \`${runId}\` in this journal` } }
  // Scope: a run belongs to the Session that started it.
  if (run.parentSessionId !== parentAgent.id) {
    return { error: { message: `run \`${runId}\` belongs to another session and cannot be resumed here` } }
  }
  if (run.status !== RUN_STATUS.failed && run.status !== RUN_STATUS.cancelled) {
    return {
      error: {
        message: `run \`${runId}\` is ${run.status}; only a failed or cancelled run can be resumed`,
      },
    }
  }
  if (run.plan === undefined || run.plan === null || typeof run.plan.source !== 'string') {
    return {
      error: {
        message:
          `run \`${runId}\` was recorded before resumable journals existed (no plan); start a new run instead`,
      },
    }
  }
  if (typeof run.scriptHash !== 'string' || run.scriptHash === '') {
    return { error: { message: `run \`${runId}\` has no script hash; it cannot be verified for resume` } }
  }

  const loadedTs = loadTypeScript()
  if (loadedTs.ok !== true) return { error: { message: loadedTs.message } }
  const compiled = compile({ body: run.plan.source, facade: await facadeText(), ts: loadedTs.ts, bodyLineOffset: 0 })
  if (compiled.ok !== true) {
    return {
      error: {
        message: `the recorded script no longer compiles; nothing was resumed.\n${formatDiagnostics(compiled.diagnostics ?? [])}`,
      },
    }
  }
  // The lowered text must be byte-identical: a compiler change that alters
  // lowering would make the recorded nodes mean something different.
  if (scriptHashOf(compiled.code) !== run.scriptHash) {
    return {
      error: {
        name: 'ScriptHashMismatch',
        code: 'script_mismatch',
        message:
          `run \`${runId}\` was recorded with a different lowered script (hash ${run.scriptHash.slice(0, 12)}…); `
          + 'resuming would mix two versions. Start a new run instead.',
      },
    }
  }

  // Per-call overrides become part of the stored plan, exactly like the UI's
  // configure action, so a later resume keeps them. Validate before confirming
  // so an unapproved resume leaves the journal untouched.
  const overrides = {}
  if (args?.max_concurrency !== undefined) overrides.maxConcurrency = args.max_concurrency
  if (typeof args?.subagent_model === 'string' && args.subagent_model.trim() !== '') {
    overrides.subagentModel = args.subagent_model
  }
  let mergedOverrides
  let candidatePlan = run.plan
  if (Object.keys(overrides).length > 0) {
    try {
      mergedOverrides = applyPlanSettings(run.plan, overrides)
    } catch (error) {
      return { error: { message: messageOf(error) } }
    }
    if (mergedOverrides.changes.length > 0) candidatePlan = mergedOverrides.plan
  }

  const confirmation = await confirmWorkflowExecution({
    ctx,
    settings,
    journal,
    exec,
    parentAgent,
    mode: 'resume',
    workflowId: run.name ?? 'zcode-workflow',
    runId,
    resumeCount: run.resumeCount ?? 0,
    sourcePath: candidatePlan.sourcePath ?? null,
    directory: run.cwd,
    description: candidatePlan.description ?? null,
    phases: candidatePlan.phases ?? compiled.phases ?? [],
    actors: candidatePlan.actors ?? compiled.actors ?? [],
    commands: compiled.commands ?? [],
    args: run.args,
    maxConcurrency: candidatePlan.maxConcurrency ?? run.capsMaxConcurrency ?? settings.maxConcurrency,
    subagentModel: candidatePlan.subagentModel ?? resolveSubagentModel(settings.subagentModel),
    source: run.plan.source,
  })
  if (confirmation.approved !== true) return confirmation.result

  let effectivePlan = run.plan
  if (mergedOverrides !== undefined && mergedOverrides.changes.length > 0) {
    effectivePlan = mergedOverrides.plan
    journal.updatePlan(runId, effectivePlan)
    journal.setRunCaps(runId, effectivePlan.maxConcurrency ?? run.capsMaxConcurrency)
    journal.appendEvent(runId, 'run-configured', { at: Date.now(), origin: 'tool', changes: mergedOverrides.changes })
  }

  const actors = journal.listActors(runId)
  const resumeSessions = new Map(
    actors.filter((actor) => typeof actor.sessionId === 'string' && actor.sessionId !== '')
      .map((actor) => [`${actor.siteId}@${actor.ordinal}`, actor.sessionId]),
  )

  journal.markResumed(runId)
  journal.appendEvent(runId, 'run-resumed', {
    resumeCount: run.resumeCount + 1,
    sessions: resumeSessions.size,
  })

  return executeCompiledRun({
    ctx, settings, journal, tracking, exec,
    runId,
    cwd: run.cwd ?? (await workingDirectoryOf(ctx, exec)),
    workflowId: run.name ?? 'zcode-workflow',
    sourcePath: null,
    args: run.args ?? {},
    plan: effectivePlan,
    diagnostics: [],
    replay: true,
    allowRehydrate: args?.allow_rehydrate === true,
    resumeSessions,
  })
}

/**
 * Start a resume from the desktop UI (no model turn involved).
 *
 * The tool path has a calling Agent; a UI click does not, so the parent is
 * looked up by session id and falls back to a minimal identity. Execution is
 * intentionally NOT awaited: the route returns the run id immediately and the
 * panel polls, exactly like a tool-launched run.
 */
async function startResumeFromUi({ ctx, settings, journal, tracking, runId, overrides = {}, parentAgent }) {
  const run = journal.getRun(runId)
  if (run === undefined) throw new Error(`no run \`${runId}\` in this journal`)
  if (run.status !== RUN_STATUS.failed && run.status !== RUN_STATUS.cancelled) {
    throw new Error(`run \`${runId}\` is ${run.status}; only a failed or cancelled run can be resumed`)
  }
  if (run.plan === undefined || run.plan === null || typeof run.plan.source !== 'string') {
    throw new Error(`run \`${runId}\` has no stored plan and cannot be resumed`)
  }
  if (typeof run.scriptHash !== 'string' || run.scriptHash === '') {
    throw new Error(`run \`${runId}\` has no script hash and cannot be resumed`)
  }
  const loadedTs = loadTypeScript()
  if (loadedTs.ok !== true) throw new Error(loadedTs.message)
  const compiled = compile({ body: run.plan.source, facade: await facadeText(), ts: loadedTs.ts, bodyLineOffset: 0 })
  if (compiled.ok !== true) throw new Error('the recorded script no longer compiles')
  if (scriptHashOf(compiled.code) !== run.scriptHash) throw new Error('the recorded script hash no longer matches')

  const { plan, changes } = applyPlanSettings(run.plan, overrides)
  if (changes.length > 0) {
    journal.updatePlan(runId, plan)
    journal.setRunCaps(runId, plan.maxConcurrency ?? run.capsMaxConcurrency)
    journal.appendEvent(runId, 'run-configured', {
      at: Date.now(),
      origin: 'ui',
      changes,
    })
  }

  const actors = journal.listActors(runId)
  const resumeSessions = new Map(
    actors.filter((actor) => typeof actor.sessionId === 'string' && actor.sessionId !== '')
      .map((actor) => [`${actor.siteId}@${actor.ordinal}`, actor.sessionId]),
  )
  const agentsService = ctx.get?.('agents') ?? ctx.agents
  const parent = parentAgent
    ?? agentsService?.get?.(run.parentSessionId)
    ?? { id: run.parentSessionId }
  const directory = run.cwd ?? await workingDirectoryOf(ctx, { agent: parent })

  journal.markResumed(runId)
  journal.appendEvent(runId, 'run-resumed', { resumeCount: run.resumeCount + 1, sessions: resumeSessions.size, origin: 'ui' })

  const execution = executeCompiledRun({
    ctx, settings, journal, tracking,
    exec: { agent: parent },
    runId,
    cwd: directory,
    workflowId: run.name ?? 'zcode-workflow',
    sourcePath: plan.sourcePath ?? null,
    args: run.args ?? {},
    plan,
    diagnostics: [],
    replay: true,
    allowRehydrate: overrides.allowRehydrate === true,
    resumeSessions,
  })
  // The route has already returned; a failure must still land on the run row.
  Promise.resolve(execution).catch((error) => {
    try {
      journal.settleRun(runId, {
        status: RUN_STATUS.failed,
        failure: { message: messageOf(error), code: 'background_resume_failed' },
      })
    } catch {
      // the journal may be closing
    }
  })
  return { runId, resumed: true, planned: true }
}

/**
 * Apply settings from the UI, then continue the work: resume a settled failed
 * run, or relaunch a completed one as a successor (`resumedFrom` lineage).
 */
async function configureRunFromUi({ ctx, settings, journal, tracking, runId, overrides = {} }) {
  const run = journal.getRun(runId)
  if (run === undefined) throw new Error(`no run \`${runId}\` in this journal`)
  if (run.status === 'running' || run.status === 'pending') {
    throw new Error(`run \`${runId}\` is ${run.status}; stop it before changing settings`)
  }
  if (run.plan === undefined || run.plan === null || typeof run.plan.source !== 'string') {
    throw new Error(`run \`${runId}\` has no stored plan and cannot be configured`)
  }
  const { plan, changes } = applyPlanSettings(run.plan, overrides)
  if (changes.length === 0) return { runId, changed: false, changes: [] }

  if (run.status === 'failed' || run.status === 'cancelled') {
    // Resuming the same run: the settings belong to it.
    journal.updatePlan(runId, plan)
    journal.setRunCaps(runId, plan.maxConcurrency ?? run.capsMaxConcurrency)
    journal.appendEvent(runId, 'run-configured', { at: Date.now(), origin: 'ui', changes })
    const resumed = await startResumeFromUi({ ctx, settings, journal, tracking, runId, overrides, parentAgent: undefined })
    return { ...resumed, changes }
  }
  // completed → a NEW successor run. The old run is history: never rewrite its
  // plan/caps, and record the settings change on the run the user will see.
  const newId = `dwfrun-${randomUUID()}`
  journal.createRun({
    id: newId,
    parentSessionId: run.parentSessionId,
    cwd: run.cwd,
    name: run.name,
    scriptText: run.scriptText,
    scriptHash: run.scriptHash,
    plan,
    args: run.args,
    resumedFrom: runId,
    capsMaxConcurrency: plan.maxConcurrency ?? 13,
  })
  journal.appendEvent(newId, 'run-configured', { at: Date.now(), origin: 'ui', changes })
  const agentsService = ctx.get?.('agents') ?? ctx.agents
  const parent = agentsService?.get?.(run.parentSessionId) ?? { id: run.parentSessionId }
  const execution = executeCompiledRun({
    ctx, settings, journal, tracking,
    exec: { agent: parent },
    runId: newId,
    cwd: run.cwd,
    workflowId: run.name ?? 'zcode-workflow',
    sourcePath: plan.sourcePath ?? null,
    args: run.args ?? {},
    plan,
    diagnostics: [],
    replay: false,
  })
  Promise.resolve(execution).catch((error) => {
    try {
      journal.settleRun(newId, {
        status: RUN_STATUS.failed,
        failure: { message: messageOf(error), code: 'background_relaunch_failed' },
      })
    } catch {
      // the journal may be closing
    }
  })
  return { runId: newId, resumedFrom: runId, relaunched: true, changes }
}

function defineListTool(ctx, settings) {
  return {
    name: settings.listToolName,
    description:
      'List saved ZCode workflows (`.dwf.ts`) visible from this Session: the working-directory `.zcode/workflows` '
      + 'directory and the global ZCode workflow directory. Returns each workflow\'s name, description, whenToUse and declared arguments.',
    parameters: toolParameters({
      query: { type: 'string', description: 'Optional case-insensitive filter over the name and description.' },
    }),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        const rows = value?.workflows ?? []
        if (rows.length === 0) {
          const searched = (value?.searchedIn ?? []).map((root) => `- ${root.scope}: ${root.dir}`).join('\n')
          return [{ type: 'text', text: `No saved ZCode workflows were found. Searched:\n${searched}` }]
        }
        const lines = rows.map((row) => {
          const declared = row.args === undefined || Object.keys(row.args).length === 0
            ? ''
            : ` args: ${Object.keys(row.args).join(', ')}`
          return `- ${row.name} — ${row.description}${declared}\n  ${row.path}`
        })
        return [{ type: 'text', text: `Saved ZCode workflows (${rows.length}):\n${lines.join('\n')}` }]
      },
    },
    async execute(args, exec) {
      const directory = await workingDirectoryOf(ctx, exec)
      const roots = workflowRoots(settings, directory)
      const workflows = await scanWorkflows(settings, directory, args?.query)
      return jsonSafe({ workflows, searchedIn: roots })
    },
  }
}

async function runWorkflowTool(ctx, settings, journal, tracking, args, exec) {
  const directory = await workingDirectoryOf(ctx, exec)
  const loaded = await loadSource(settings, args, directory)
  if (loaded.fail !== undefined) return loaded.fail

  const { body, bodyLineOffset, meta, resolvedArgs, sourcePath } = loaded
  const workflowId = args?.name
    ?? (sourcePath === undefined ? 'zcode-workflow' : basename(sourcePath).replace(/\.dwf\.ts$/u, ''))

  const diagnostics = []
  let compiled
  if (settings.typeCheck) {
    const loadedTs = loadTypeScript()
    if (loadedTs.ok !== true) return { error: { message: loadedTs.message } }
    compiled = compile({ body, facade: await facadeText(), ts: loadedTs.ts, bodyLineOffset })
  } else {
    compiled = { ok: true, diagnostics: [], code: body, askSchemas: [], commands: [], phases: [], actors: [], artifacts: [], sites: {} }
  }
  diagnostics.push(...(compiled.diagnostics ?? []))

  if (args?.dry_run === true) {
    // `dryRun` marks this shape for the renderer, and the compile-time artifact
    // SITES are named separately from a run's published artifacts: the same key
    // used for both is what made a dry run print "artifact#1 (undefined)".
    return {
      dryRun: true,
      workflowId,
      sourcePath: sourcePath ?? null,
      ok: compiled.ok,
      phases: compiled.phases ?? [],
      actors: compiled.actors ?? [],
      askSchemas: (compiled.askSchemas ?? []).length,
      commands: compiled.commands ?? [],
      artifactSites: compiled.artifacts ?? [],
      sites: compiled.sites ?? {},
      diagnostics,
    }
  }
  if (compiled.ok !== true) {
    return {
      error: {
        message: `the ZCode workflow ${sourcePath === undefined ? 'script' : `\`${sourcePath}\``} did not compile; nothing was executed.\n${formatDiagnostics(diagnostics)}`,
      },
    }
  }

  const parentAgent = exec.agent
  if (parentAgent === undefined) {
    return { error: { message: 'the ZCode workflow tool needs a calling agent (exec.agent was undefined)' } }
  }

  const runId = `dwfrun-${randomUUID()}`
  const maxConcurrency = resolveMaxConcurrency(settings, args)
  const subagentModel = resolveSubagentModel(
    typeof args?.subagent_model === 'string' && args.subagent_model.trim() !== ''
      ? args.subagent_model
      : settings.subagentModel,
  )
  if (subagentModel.mode === 'invalid') {
    return { error: { message: subagentModel.message } }
  }

  const confirmation = await confirmWorkflowExecution({
    ctx,
    settings,
    journal,
    exec,
    parentAgent,
    mode: 'run',
    workflowId,
    sourcePath: sourcePath ?? null,
    directory,
    description: typeof meta?.description === 'string' ? meta.description : null,
    phases: compiled.phases ?? [],
    actors: compiled.actors ?? [],
    commands: compiled.commands ?? [],
    args: resolvedArgs,
    maxConcurrency,
    subagentModel,
    source: body,
  })
  if (confirmation.approved !== true) return confirmation.result

  const plan = {
    // Everything a later resume needs, stored once so it never depends on the
    // original file still existing or on the caller re-sending the script.
    source: body,
    askSchemas: compiled.askSchemas ?? [],
    actors: compiled.actors ?? [],
    phases: compiled.phases ?? [],
    artifactSites: compiled.artifacts ?? [],
    sites: compiled.sites ?? {},
    // The run row has no source_path column; the plan is the one place that
    // survives a resume, so the panel reads it from there.
    sourcePath: sourcePath ?? null,
    // Human-readable metadata for the run switcher/card, when the file has it.
    description: typeof meta?.description === 'string' ? meta.description : null,
    // Settings survive a resume: the resumed attempt inherits the same window
    // and model unless the caller overrides them explicitly.
    maxConcurrency,
    maxTotalAgents: maxAgentsFor(settings, resolvedArgs),
    subagentModel,
    // The parent's resolved route at creation time. A desktop UI resume has no
    // live model turn, so this is what keeps `session` mode usable when the
    // parent lookup falls back to `{ id }`.
    defaultAgentOptions: resolveChildAgentOptions(parentAgent),
  }

  journal.createRun({
    id: runId,
    parentSessionId: parentAgent.id,
    cwd: directory,
    name: workflowId,
    scriptText: compiled.code,
    scriptHash: scriptHashOf(compiled.code),
    plan,
    args: resolvedArgs,
    capsMaxConcurrency: maxConcurrency,
  })

  return executeCompiledRun({
    ctx, settings, journal, tracking, exec,
    runId, cwd: directory, workflowId, sourcePath, args: resolvedArgs, plan, diagnostics,
    replay: false,
  })
}

/**
 * Persist the actor-pool events that are not already covered by a table row.
 *
 * `actor-created` has a `dwf_actor` row, while `actor-resumed` (reattached) and
 * `actor-rehydrated` (rebuilt after the session was lost) have none — without
 * this sink a resume left no trace of which of the three actually happened.
 */
export function journalEventSink(journal, runId) {
  return (event) => {
    if (event?.type !== 'actor-created' && event?.type !== 'actor-resumed' && event?.type !== 'actor-rehydrated') return
    try {
      journal.appendEvent(runId, event.type, event)
    } catch {
      // the actor row itself is the durable record
    }
  }
}

/**
 * Merge UI settings into a stored plan.
 *
 * Returns the new plan and the human-readable change list the panel shows as
 * `由你调整设置 · HH:MM` / `子代理模型 … → …` / `最大并发数 … → …`.
 */
export function applyPlanSettings(plan, { maxConcurrency, subagentModel } = {}) {
  const next = { ...(plan ?? {}) }
  const changes = []
  if (maxConcurrency !== undefined && maxConcurrency !== null) {
    const value = Math.max(1, Math.min(64, Math.floor(Number(maxConcurrency))))
    if (!Number.isFinite(value)) throw new Error('max_concurrency must be a number')
    const before = Number(next.maxConcurrency ?? 0)
    if (before !== value) {
      next.maxConcurrency = value
      changes.push({ field: 'maxConcurrency', label: '最大并发数', from: before, to: value })
    }
  }
  if (subagentModel !== undefined && subagentModel !== null) {
    const resolved = resolveSubagentModel(String(subagentModel))
    if (resolved.mode === 'invalid') throw new Error(resolved.message)
    const before = next.subagentModel?.label ?? '会话模型'
    if (before !== resolved.label) {
      next.subagentModel = resolved
      changes.push({ field: 'subagentModel', label: '子代理模型', from: before, to: resolved.label })
    }
  }
  return { plan: next, changes }
}

/** The agent options one run's children inherit, including a pinned model. */
export function resolveRunAgentOptions(plan, parentAgent) {
  const live = resolveChildAgentOptions(parentAgent)
  // Stored defaults fill the gaps when a UI resume has only a session id.
  const inherited = { ...(plan?.defaultAgentOptions ?? {}), ...live }
  const pinned = plan?.subagentModel?.mode === 'fixed' ? plan.subagentModel : undefined
  return pinned === undefined ? inherited : { ...inherited, provider: pinned.provider, model: pinned.model }
}

/** The simultaneous-subagent limit for one run: per-call wins, then settings. */
function resolveMaxConcurrency(settings, args) {
  const requested = Number(args?.max_concurrency)
  if (Number.isFinite(requested) && requested >= 1) return Math.min(64, Math.floor(requested))
  const fallback = Number(settings?.maxConcurrency)
  return Number.isFinite(fallback) && fallback >= 1 ? Math.min(64, Math.floor(fallback)) : 13
}

/**
 * Parse `subagent_model`: `"session"` follows the caller, `"provider/model"` pins
 * one. Anything else is reported instead of silently ignored.
 */
function resolveSubagentModel(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '' || text === 'session') return { mode: 'session', label: '会话模型' }
  const slash = text.indexOf('/')
  if (slash <= 0 || slash === text.length - 1) {
    return { mode: 'invalid', message: `subagent_model must be "session" or "provider/model", got "${text}"` }
  }
  return { mode: 'fixed', provider: text.slice(0, slash), model: text.slice(slash + 1), label: text }
}

const CONFIRM_QUESTION_ID = 'workflow_execution_confirm'
const CONFIRM_OPTIONS = Object.freeze({
  once: '允许这一次工作流执行',
  session: '允许这个 Session 的所有工作流自动执行',
  reject: '拒绝执行',
})

function resolveConfirmExecution(value) {
  if (value === false || value === 'never' || value === 'off') return 'never'
  return 'ask'
}

/**
 * Format a compact Markdown summary + source snippet shown inside the pre-run
 * confirmation card so the user can review what will run before approving.
 */
function buildWorkflowConfirmDetail({
  mode,
  workflowId,
  runId,
  resumeCount,
  sourcePath,
  directory,
  description,
  maxConcurrency,
  subagentModel,
  phases,
  actors,
  commands,
  args,
  source,
}) {
  const lines = []
  lines.push(`- **工作流**：\`${workflowId}\`${description ? ` — ${description}` : ''}`)
  lines.push(`- **来源**：${sourcePath ? `\`${sourcePath}\`` : '内联脚本（未落盘）'}`)
  if (mode === 'resume' && runId) {
    lines.push(`- **动作**：续跑运行 \`${runId}\`（已续跑 ${resumeCount ?? 0} 次）`)
  }
  if (directory) lines.push(`- **工作目录**：\`${directory}\``)
  lines.push(`- **并发与模型**：最大并发 \`${maxConcurrency}\` · 子代理模型 \`${subagentModel?.label ?? '会话模型'}\``)

  const phaseList = Array.isArray(phases) ? phases : []
  if (phaseList.length > 0) {
    const names = phaseList.slice(0, 8).map((p) => (
      typeof p === 'string' ? `\`${p}\`` : `\`${p?.name ?? p?.title ?? '(动态阶段)'}\``
    ))
    lines.push(`- **阶段 (${phaseList.length})**：${names.join(' → ')}${phaseList.length > 8 ? ' → …' : ''}`)
  }

  const actorList = Array.isArray(actors) ? actors : []
  if (actorList.length > 0) {
    const names = actorList.slice(0, 8).map((a) => (
      typeof a === 'string' ? `\`${a}\`` : `\`${a?.name ?? a?.id ?? 'subagent'}\``
    ))
    lines.push(`- **子代理 (${actorList.length})**：${names.join('、')}${actorList.length > 8 ? ` 等 ${actorList.length} 个` : ''}`)
  }

  const cmdList = Array.isArray(commands) ? commands : []
  if (cmdList.length > 0) {
    const preview = cmdList.slice(0, 6).map((c) => `\`${c}\``).join('、')
    lines.push(`- **声明命令 (${cmdList.length})**：${preview}${cmdList.length > 6 ? ' 等' : ''}`)
  }

  if (args && typeof args === 'object' && Object.keys(args).length > 0) {
    const serialized = JSON.stringify(args)
    const clipped = serialized.length > 200 ? `${serialized.slice(0, 200)}…` : serialized
    lines.push(`- **输入参数**：\`${clipped}\``)
  }

  if (typeof source === 'string' && source.trim() !== '') {
    const allLines = source.split('\n')
    const maxLines = 48
    const maxChars = 2000
    let body = allLines.slice(0, maxLines).join('\n')
    let truncated = allLines.length > maxLines
    if (body.length > maxChars) {
      body = body.slice(0, maxChars)
      truncated = true
    }
    const fence = body.includes('```') ? '~~~~' : '```'
    lines.push('')
    lines.push(`${fence}ts`)
    lines.push(body)
    if (truncated) lines.push(`// ...（共 ${allLines.length} 行，已截断预览）`)
    lines.push(fence)
  }

  return lines.join('\n')
}

/**
 * Ask the user whether a compiled workflow (new run or resume) should start.
 * Allows once, session-wide auto-approval (persisted in SQLite), rejection,
 * or free-form revision feedback entered in the QuestionFlow input box.
 */
async function confirmWorkflowExecution({
  ctx,
  settings,
  journal,
  exec,
  parentAgent,
  mode,
  workflowId,
  runId,
  resumeCount,
  sourcePath,
  directory,
  description,
  phases,
  actors,
  commands,
  args,
  maxConcurrency,
  subagentModel,
  source,
}) {
  if (settings?.confirmExecution === 'never') return { approved: true, scope: 'config' }
  if (journal?.isSessionAutoApproved?.(parentAgent?.id) === true) {
    return { approved: true, scope: 'session' }
  }

  const userQuestions = ctx?.get?.('userQuestions') ?? ctx?.userQuestions
  if (typeof userQuestions?.ask !== 'function') {
    return { approved: true, scope: 'no-service' }
  }

  const declined = (confirmation) => ({
    approved: false,
    result: {
      workflowId,
      ...(runId === undefined ? {} : { runId }),
      executed: false,
      confirmation,
    },
  })

  const header = mode === 'resume' ? '工作流续跑确认' : '工作流执行确认'
  const actionText = mode === 'resume'
    ? `工作流「${workflowId}」已准备好续跑，请确认是否继续执行（可在下方输入框直接填写修改意见）：`
    : `工作流「${workflowId}」已编译完成，请确认是否开始执行（可在下方输入框直接填写修改意见）：`

  const detail = buildWorkflowConfirmDetail({
    mode,
    workflowId,
    runId,
    resumeCount,
    sourcePath,
    directory,
    description,
    maxConcurrency,
    subagentModel,
    phases,
    actors,
    commands,
    args,
    source,
  })

  let response
  try {
    response = await userQuestions.ask({
      agent: parentAgent,
      ...(exec?.signal === undefined ? {} : { signal: exec.signal }),
      questions: [
        {
          id: CONFIRM_QUESTION_ID,
          header,
          question: actionText,
          detail,
          multiSelect: false,
          options: [
            { label: CONFIRM_OPTIONS.once, description: '仅批准本次工作流运行，下次仍会弹出确认' },
            { label: CONFIRM_OPTIONS.session, description: '批准本次并开启当前会话自动执行，后续不再询问' },
            { label: CONFIRM_OPTIONS.reject, description: '不执行此工作流，等待你的下一步指令' },
          ],
        },
      ],
    })
  } catch (error) {
    const code = error?.code
    if (code === 'ASK_CANCELLED') {
      return declined({ decision: 'cancelled', reason: messageOf(error) })
    }
    if (code === 'ASK_ABORTED') {
      return declined({ decision: 'aborted', reason: messageOf(error) })
    }
    if (code === 'NO_PROVIDER' || code === 'DELEGATED_CALLER' || code === 'CALLER_NOT_LIVE') {
      return {
        approved: false,
        result: {
          workflowId,
          ...(runId === undefined ? {} : { runId }),
          executed: false,
          error: {
            code: 'confirmation_unavailable',
            message: `cannot confirm workflow execution (${code}): ${messageOf(error)}`,
          },
        },
      }
    }
    return {
      approved: false,
      result: {
        workflowId,
        ...(runId === undefined ? {} : { runId }),
        executed: false,
        error: {
          code: 'confirmation_failed',
          message: `workflow confirmation failed: ${messageOf(error)}`,
        },
      },
    }
  }

  const answer = response?.answers?.find((entry) => entry?.id === CONFIRM_QUESTION_ID) ?? response?.answers?.[0]
  const feedback = typeof answer?.custom === 'string' ? answer.custom.trim() : ''
  if (feedback !== '') {
    return declined({ decision: 'revise', feedback })
  }

  const choice = Array.isArray(answer?.selected) ? answer.selected[0] : undefined
  if (choice === CONFIRM_OPTIONS.once) return { approved: true, scope: 'once' }
  if (choice === CONFIRM_OPTIONS.session) {
    journal?.setSessionAutoApprove?.(parentAgent?.id, true)
    return { approved: true, scope: 'session' }
  }
  if (choice === CONFIRM_OPTIONS.reject) return declined({ decision: 'rejected' })
  return declined({ decision: 'skipped' })
}

/**
 * The subagent ceiling for one run.
 *
 * A per-call `max_total_agents` outranks the row config. Kept in one function so
 * a fresh run and a resume can never disagree about the cap.
 */
function maxAgentsFor(settings, args) {
  return Number.isFinite(args?.max_total_agents)
    ? Number(args.max_total_agents)
    : settings.maxTotalAgents
}

/** sha256 of the lowered script: the identity a resume compares against. */
function scriptHashOf(code) {
  return createHash('sha256').update(code, 'utf8').digest('hex')
}

/**
 * Run one already-compiled workflow. Both a fresh run and a resume land here;
 * `replay` is the only difference, and it is decided by the caller.
 */
async function executeCompiledRun({
  ctx, settings, journal, tracking, exec,
  runId, cwd, workflowId, sourcePath, args, plan, diagnostics,
  replay, allowRehydrate = false, resumeSessions,
}) {
  const directory = cwd
  const resolvedArgs = args
  const parentAgent = exec.agent
  const maxTotalAgents = Number(plan.maxTotalAgents ?? maxAgentsFor(settings, resolvedArgs))
  const maxConcurrency = Number(plan.maxConcurrency ?? settings.maxConcurrency ?? 13)

  /**
   * Token ledger shared by the adapter (which sees each assistant message) and
   * the run service (which settles the row). One object per attempt.
   */
  // Resume keeps counting up: start from what earlier attempts already spent.
  const priorActors = typeof journal.listActors === 'function' ? journal.listActors(runId) : []
  const usage = {
    total: Number(journal.getRun(runId)?.spentTokens ?? 0),
    bySession: new Map(
      priorActors
        .filter((actor) => typeof actor.sessionId === 'string' && actor.sessionId !== '')
        .map((actor) => [actor.sessionId, Number(actor.tokens ?? 0)]),
    ),
  }
  const usageSink = ({ sessionId, tokens }) => {
    if (!Number.isFinite(tokens) || tokens <= 0) return
    usage.total += tokens
    usage.bySession.set(sessionId, (usage.bySession.get(sessionId) ?? 0) + tokens)
  }

  // `subagent_model` either pins a provider/model or follows the caller's
  // committed request. Pinning replaces only the model fields; maxTokens and
  // subagentDepth still come from the parent resolution.
  const agentOptions = resolveRunAgentOptions(plan, parentAgent)

  const artifacts = createArtifactPublisher({
    runId,
    cwd: directory,
    journal,
    ...(settings.snapshotDir === '' ? {} : { snapshotRoot: settings.snapshotDir }),
  })

  // Created before anything that observes it: the child spawn, the agent runtime
  // and the world executor all take this one signal.
  const controller = new AbortController()
  const onAbort = () => controller.abort('the calling tool step was cancelled')
  if (exec.signal?.aborted === true) onAbort()
  else exec.signal?.addEventListener('abort', onAbort, { once: true })

  // A child has no model of its own: it inherits the caller's committed request.
  const agentRuntime = createAgentRuntime({
    ctx,
    agents: ctx.get('agents') ?? ctx.agents,
    subagents: ctx.get('subagents') ?? ctx.subagents,
    parentAgent,
    cwd: directory,
    signal: controller.signal,
    agentOptions,
    usageSink,
  })

  tracking.trackRun(runId, parentAgent.id, controller)

  let child
  try {
    child = createChildProcess({
      subprocess: ctx.get('subprocess') ?? ctx.subprocess,
      cwd: directory,
      signal: controller.signal,
    })
  } catch (error) {
    agentRuntime.close?.()
    tracking.untrackRun(runId, parentAgent.id)
    journal.settleRun(runId, {
      status: RUN_STATUS.failed,
      failure: { message: messageOf(error), code: 'child_unavailable' },
    })
    return { error: { message: `the workflow sandbox could not start: ${messageOf(error)}` } }
  }

  const world = createWorld({
    cwd: directory,
    exec: createHostExec({
      sandbox: ctx.get('sandbox') ?? ctx.sandbox,
      sandboxPolicy: ctx.get('sandboxPolicy') ?? ctx.sandboxPolicy,
      subprocess: ctx.get('subprocess') ?? ctx.subprocess,
      session: sessionOf(ctx, parentAgent),
      cwd: directory,
    }),
  })

  const actors = createActorPool({
    runId,
    cwd: directory,
    maxTotalAgents,
    maxConcurrency,
    runtime: agentRuntime,
    ...(resumeSessions === undefined ? {} : { resumeSessions }),
    allowRehydrate,
    // Without this the pool's identity events (notably `actor-rehydrated`)
    // existed only in memory: nothing wrote them to `dwf_event`, so a degraded
    // resume was invisible in the journal and on the panel.
    onEvent: journalEventSink(journal, runId),
  })

  // Declarations are a fallback only: the pool prefers identity reported by the
  // child, which is what a computed name or a loop-created actor actually has.
  const actorDeclarations = new Map(
    (plan.actors ?? []).map((actor) => [
      actor.id ?? actor.siteId,
      { name: actor.name, persona: actor.persona },
    ]),
  )

  try {
    const outcome = await executeRun({
      journal,
      runId,
      script: journal.getRun(runId)?.scriptText ?? '',
      args: resolvedArgs,
      cwd: directory,
      child,
      actors,
      world,
      artifacts,
      askSchemas: Object.fromEntries((plan.askSchemas ?? []).map((entry) => [entry.siteId, entry.schema])),
      actorDeclarations,
      signal: controller.signal,
      replay,
      resumedFrom: journal.getRun(runId)?.resumedFrom,
      usage,
    })

    const snapshot = artifacts.snapshot()
    return {
      workflowId,
      runId,
      status: outcome.status,
      sourcePath: sourcePath ?? null,
      phases: plan.phases ?? [],
      agentsStarted: outcome.agentsStarted ?? 0,
      diagnostics,
      durationMs: outcome.durationMs,
      spentTokens: outcome.spentTokens ?? usage.total,
      ...(replay
        ? {
          resumed: true,
          resumeCount: journal.getRun(runId)?.resumeCount ?? 0,
          cachedNodes: outcome.cachedNodes ?? 0,
        }
        : {}),
      ...(outcome.status === RUN_STATUS.completed ? {} : { error: outcome.error }),
      value: outcome.value,
      reports: snapshot.reports.map((report) => ({ tag: report.artifactId, item: report.item })),
      artifacts: snapshot.artifacts,
      ...(snapshot.primaryMarkdown === undefined ? {} : { primaryMarkdown: snapshot.primaryMarkdown }),
    }
  } finally {
    try {
      child.terminate()
    } catch {
      // already gone
    }
    agentRuntime.close?.()
    exec.signal?.removeEventListener('abort', onAbort)
    tracking.untrackRun(runId, parentAgent.id)
  }
}

/** The live Session for an agent, when the composition exposes them. */
function sessionOf(ctx, agent) {
  try {
    const sessions = ctx.get?.('sessions') ?? ctx.sessions
    if (sessions?.get === undefined) return undefined
    return sessions.get(agent.id) ?? sessions.get?.(agent)
  } catch {
    return undefined
  }
}

/**
 * Publish the run store over the Web carrier so the browser half can read it.
 *
 * The panel predates the SQLite journal and expects a trace shape, so these
 * routes keep that shape and project it from journal rows. That is deliberate:
 * the sidebar keeps working while the engine underneath changes.
 */
function registerRunRoutes(ctx, store, { activeRuns, launcher, sessionPolicy } = {}) {
  ctx.inject?.(['connection'], (connectionCtx) => {
    const connection = connectionCtx.get?.('connection') ?? connectionCtx.connection
    const register = connection?.fetch?.register
    if (typeof register !== 'function') return
    const json = (value) => new Response(JSON.stringify(value), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })
    connectionCtx.effect?.(() => register({
      path: '/api/dsh-workflow-zcode/runs',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = await request.json().catch(() => ({}))
          const parentSessionId = typeof body?.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : undefined
          const cwd = typeof body?.cwd === 'string' && body.cwd !== '' ? body.cwd : undefined
          return json({ ok: true, value: jsonSafe(await store.listRuns({ parentSessionId, cwd })) })
        } catch (error) {
          return json({ ok: false, error: { code: 'list-failed', message: messageOf(error) } })
        }
      },
    }), 'dsh-workflow-zcode: runs route')
    connectionCtx.effect?.(() => register({
      path: '/api/dsh-workflow-zcode/run',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = await request.json().catch(() => ({}))
          const runId = typeof body?.runId === 'string' ? body.runId : ''
          const sessionId = typeof body?.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : undefined
          if (runId === '') {
            return json({ ok: false, error: { code: 'bad-request', message: 'a runId is required' } })
          }
          const value = await store.readRun(runId)
          if (value === undefined) {
            return json({ ok: false, error: { code: 'unknown-run', message: `no run \`${runId}\`` } })
          }
          // Scope check: a session may read only its own runs. The UI always
          // sends its session id; the id alone is not an authorization token.
          if (sessionId !== undefined && value?.parentSessionId !== null && value?.parentSessionId !== undefined && value?.parentSessionId !== sessionId) {
            return json({ ok: false, error: { code: 'forbidden', message: 'this run belongs to another session' } })
          }
          return json({ ok: true, value: jsonSafe(value) })
        } catch (error) {
          return json({ ok: false, error: { code: 'read-failed', message: messageOf(error) } })
        }
      },
    }), 'dsh-workflow-zcode: run route')
    connectionCtx.effect?.(() => register({
      path: '/api/dsh-workflow-zcode/cancel',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = await request.json().catch(() => ({}))
          const runId = typeof body?.runId === 'string' ? body.runId : ''
          if (runId === '') {
            return json({ ok: false, error: { code: 'bad-request', message: 'a runId is required' } })
          }
          const controller = activeRuns?.get(runId)
          if (controller === undefined) {
            // Not in the live map: either it never started here, or it settled
            // already. Say which without pretending the call worked.
            const run = store.readRun === undefined ? undefined : await store.readRun(runId).catch(() => undefined)
            return json({
              ok: false,
              error: {
                code: run === undefined ? 'unknown-run' : 'not-running',
                message: run === undefined
                  ? `no run \`${runId}\` in this journal`
                  : `run \`${runId}\` is ${run.status}; only a running or pending run can be stopped`,
              },
            })
          }
          controller.abort('cancelled by user')
          return json({ ok: true, value: { cancelled: true, runId } })
        } catch (error) {
          return json({ ok: false, error: { code: 'cancel-failed', message: messageOf(error) } })
        }
      },
    }), 'dsh-workflow-zcode: cancel route')

    const launchRoute = (path, label, invoke) => {
      connectionCtx.effect?.(() => register({
        path,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            const body = await request.json().catch(() => ({}))
            const runId = typeof body?.runId === 'string' ? body.runId : ''
            if (runId === '') {
              return json({ ok: false, error: { code: 'bad-request', message: 'a runId is required' } })
            }
            const value = await invoke(runId, body)
            return json({ ok: true, value: jsonSafe(value) })
          } catch (error) {
            return json({ ok: false, error: { code: 'launch-failed', message: messageOf(error) } })
          }
        },
      }), label)
    }

    launchRoute('/api/dsh-workflow-zcode/resume', 'dsh-workflow-zcode: resume route', (runId, body) => {
      if (launcher?.resume === undefined) throw new Error('resume is not available in this composition')
      return launcher.resume(runId, {
        allowRehydrate: body?.allow_rehydrate === true,
        ...(body?.max_concurrency === undefined ? {} : { maxConcurrency: body.max_concurrency }),
        ...(body?.subagent_model === undefined ? {} : { subagentModel: body.subagent_model }),
      })
    })

    launchRoute('/api/dsh-workflow-zcode/configure', 'dsh-workflow-zcode: configure route', (runId, body) => {
      if (launcher?.configure === undefined) throw new Error('configure is not available in this composition')
      return launcher.configure(runId, {
        ...(body?.maxConcurrency === undefined ? {} : { maxConcurrency: body.maxConcurrency }),
        ...(body?.subagentModel === undefined ? {} : { subagentModel: body.subagentModel }),
      })
    })

    connectionCtx.effect?.(() => register({
      path: '/api/dsh-workflow-zcode/delete',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = await request.json().catch(() => ({}))
          const runId = typeof body?.runId === 'string' ? body.runId : ''
          if (runId === '') return json({ ok: false, error: { code: 'bad-request', message: 'a runId is required' } })
          if (activeRuns?.has(runId) === true) {
            return json({ ok: false, error: { code: 'running', message: `run \`${runId}\` is still running` } })
          }
          const run = store.readRun === undefined ? undefined : await store.readRun(runId).catch(() => undefined)
          if (run === undefined) return json({ ok: false, error: { code: 'unknown-run', message: `no run \`${runId}\`` } })
          if (run.status === 'running' || run.status === 'pending') {
            return json({ ok: false, error: { code: 'running', message: `run \`${runId}\` is ${run.status}` } })
          }
          const deleted = store.deleteRun === undefined ? false : await store.deleteRun(runId)
          return json({ ok: true, value: { deleted, runId } })
        } catch (error) {
          return json({ ok: false, error: { code: 'delete-failed', message: messageOf(error) } })
        }
      },
    }), 'dsh-workflow-zcode: delete route')

    connectionCtx.effect?.(() => register({
      path: '/api/dsh-workflow-zcode/session-policy',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = await request.json().catch(() => ({}))
          const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
          if (sessionId === '') {
            return json({ ok: false, error: { code: 'bad-request', message: 'a sessionId is required' } })
          }
          if (typeof body?.autoApprove === 'boolean') {
            if (sessionPolicy?.set === undefined) {
              return json({ ok: false, error: { code: 'unavailable', message: 'session policy is not available' } })
            }
            const autoApprove = Boolean(await sessionPolicy.set(sessionId, body.autoApprove))
            return json({ ok: true, value: { sessionId, autoApprove } })
          }
          const autoApprove = sessionPolicy?.get === undefined ? false : Boolean(await sessionPolicy.get(sessionId))
          return json({ ok: true, value: { sessionId, autoApprove } })
        } catch (error) {
          return json({ ok: false, error: { code: 'session-policy-failed', message: messageOf(error) } })
        }
      },
    }), 'dsh-workflow-zcode: session-policy route')
  })
}

/**
 * Read-only projection of the journal for the existing sidebar panel.
 *
 * The panel was written against the old JSON trace file, which had `runs`,
 * `phases` and `nodes` with a `state` per node. Rather than break it, this
 * adapter reproduces that shape from journal rows and events.
 */
async function facadeText() {
  facadePromise ??= readFile(new URL('./facade.d.ts', import.meta.url), 'utf8')
  return facadePromise
}

let facadePromise

async function loadSource(settings, args, directory) {
  const script = typeof args?.script === 'string' ? args.script : ''
  const pathArg = typeof args?.path === 'string' ? args.path : ''
  if (script === '' && pathArg === '') {
    return { fail: { error: { message: 'provide either `script` or `path`' } } }
  }
  if (script !== '' && pathArg !== '') {
    return { fail: { error: { message: 'provide exactly one of `script` and `path`' } } }
  }

  if (script !== '') {
    if (script.startsWith('/* zcode-workflow')) {
      const split = splitFrontmatter(script)
      if (split.error !== undefined) {
        return { fail: { error: { message: `${split.error}: ${split.message}` } } }
      }
      const parsed = parseFrontmatterYaml(split.block)
      if (parsed.ok !== true) {
        return { fail: { error: { message: `${FRONTMATTER_ERRORS.invalidYaml}: ${parsed.message} (line ${parsed.line})` } } }
      }
      const normalized = normalizeFrontmatter(parsed.value, args?.args)
      if (normalized.ok !== true) {
        return { fail: { error: { message: `${FRONTMATTER_ERRORS.invalidMetadata}: ${normalized.issues.join('; ')}` } } }
      }
      return { body: split.body, bodyLineOffset: split.lineOffset, meta: normalized.meta, resolvedArgs: normalized.args, sourcePath: undefined }
    }
    return { body: script, bodyLineOffset: 0, meta: undefined, resolvedArgs: args?.args ?? {}, sourcePath: undefined }
  }

  const absolute = isAbsolute(pathArg) ? pathArg : resolve(directory, pathArg)
  let text
  try {
    text = await readFile(absolute, 'utf8')
  } catch (error) {
    return { fail: { error: { message: `cannot read the workflow file \`${pathArg}\`: ${messageOf(error)}` } } }
  }
  const split = splitFrontmatter(text)
  if (split.error !== undefined) {
    return { fail: { error: { message: `${pathArg}: ${split.error}: ${split.message}` } } }
  }
  const parsed = parseFrontmatterYaml(split.block)
  if (parsed.ok !== true) {
    return { fail: { error: { message: `${pathArg}: ${FRONTMATTER_ERRORS.invalidYaml}: ${parsed.message} (line ${parsed.line})` } } }
  }
  const normalized = normalizeFrontmatter(parsed.value, args?.args)
  if (normalized.ok !== true) {
    return { fail: { error: { message: `${pathArg}: ${FRONTMATTER_ERRORS.invalidMetadata}: ${normalized.issues.join('; ')}` } } }
  }
  return { body: split.body, bodyLineOffset: split.lineOffset, meta: normalized.meta, resolvedArgs: normalized.args, sourcePath: absolute }
}

function formatDiagnostics(diagnostics) {
  if (diagnostics.length === 0) return ''
  return diagnostics
    .map((diagnostic) => `  ${diagnostic.code} ${diagnostic.line}:${diagnostic.column} ${diagnostic.message}`)
    .join('\n')
}

function renderEnvelope(value) {
  const lines = []
  if (value?.dryRun === true) {
    lines.push(`ZCode workflow "${value.workflowId}" ${value.ok === true ? 'compiled' : 'did NOT compile'} (dry run: nothing was executed)`)
    if (value.sourcePath !== null && value.sourcePath !== undefined) lines.push(`source: ${value.sourcePath}`)
    lines.push(`ok: ${value.ok === true}`)
    const actors = Array.isArray(value.actors) ? value.actors : []
    const phases = Array.isArray(value.phases) ? value.phases : []
    // A phase label may be assembled at run time (`"Phase 1 · " + sceneId`), so a
    // static name is genuinely absent rather than lost: say so instead of
    // printing an empty string.
    const phaseLabels = phases.map((phase) => (
      typeof phase === 'string' ? phase : (phase?.name ?? phase?.title ?? '(runtime label)')
    ))
    lines.push(`phases: ${phases.length}${phases.length === 0 ? '' : ` — ${phaseLabels.join(' · ')}`}`)
    const actorLabels = actors.map((actor) => (
      typeof actor === 'string' ? actor : (actor?.name ?? `${actor?.id ?? '?'} (runtime name)`)
    ))
    lines.push(`subagents: ${actors.length}${actorLabels.length === 0 ? '' : ` — ${actorLabels.join(', ')}`}`)
    lines.push(`typed asks: ${value.askSchemas ?? 0}`)
    lines.push(`world sites: ${value.sites?.worldReads ?? 0}`)
    lines.push(`commands: ${(value.commands ?? []).length}`)
    const declared = Array.isArray(value.artifactSites) ? value.artifactSites : []
    if (declared.length > 0) {
      lines.push(`declared artifacts: ${declared.length} — ${declared.map((site) => `${site.artifactId ?? site.id ?? '?'}(${site.op ?? site.kind ?? '?'})`).join(', ')}`)
    }
    const diagnostics = Array.isArray(value.diagnostics) ? value.diagnostics : []
    if (diagnostics.length === 0) {
      lines.push('diagnostics: none')
    } else {
      lines.push(`diagnostics (${diagnostics.length}):`)
      for (const entry of diagnostics.slice(0, 20)) {
        lines.push(`- ${entry.code} ${entry.line}:${entry.column} ${entry.message}`)
      }
    }
    return lines.join('\n')
  }

  if (value?.confirmation !== undefined) {
    const { decision, feedback, reason } = value.confirmation
    const label = value.workflowId ?? 'workflow'
    const suffix = value.runId === undefined ? '' : ` (run ${value.runId})`
    if (decision === 'revise') {
      lines.push(`ZCode workflow "${label}"${suffix} was NOT executed — user requested modifications before running.`)
      lines.push(`User feedback: ${feedback ?? ''}`)
      lines.push(
        'Action required: modify the workflow script according to the user\'s feedback and validate/run it again.',
      )
      return lines.join('\n')
    }
    const detail = reason ? `${decision}: ${reason}` : decision
    lines.push(`ZCode workflow "${label}"${suffix} was NOT executed — user declined execution (${detail ?? 'rejected'}).`)
    lines.push('Action required: do not retry automatically; wait for the user\'s next instruction.')
    return lines.join('\n')
  }

  // Any error means this call failed, with or without a `status`: a compile
  // failure has no run yet and used to fall through to "finished".
  if (value?.error !== undefined) {
    lines.push(`ZCode workflow "${value.workflowId ?? 'workflow'}" failed: ${value.error?.message ?? 'failed'}`)
    if (value?.runId !== undefined) lines.push(`run: ${value.runId}`)
    if (value?.resumed === true) {
      const reused = value.cachedNodes === undefined ? 0 : value.cachedNodes
      lines.push(`resumed: attempt ${value.resumeCount ?? 1}, ${reused} completed step(s) replayed from the journal (0 model calls for those steps)`)
    }
    const diagnostics = Array.isArray(value.diagnostics) ? value.diagnostics : []
    if (diagnostics.length > 0) {
      lines.push(`diagnostics (${diagnostics.length}):`)
      for (const entry of diagnostics.slice(0, 20)) {
        lines.push(`- ${entry.code} ${entry.line}:${entry.column} ${entry.message}`)
      }
    }
    return lines.join('\n')
  }

  const summary = value?.workflowId === undefined
    ? 'ZCode workflow finished.'
    : `ZCode workflow "${value.workflowId}" finished`
  lines.push(summary + (value?.agentsStarted === undefined ? '' : ` (${value.agentsStarted} subagent(s)).`))
  if (value?.runId !== undefined) lines.push(`run: ${value.runId}`)
  if (value?.resumed === true) {
    // A resumed attempt must be visible as one: the run id is deliberately the
    // same as the original, so nothing else would distinguish them.
    const reused = value.cachedNodes === undefined ? 0 : value.cachedNodes
    // Precise wording: the REPLAYED steps cost nothing; the run may still have
    // called the model for the steps that were not replayable.
    lines.push(`resumed: attempt ${value.resumeCount ?? 1}, ${reused} completed step(s) replayed from the journal (0 model calls for those steps)`)
  }
  if (value?.primaryMarkdown !== undefined && value.primaryMarkdown !== null) {
    lines.push('')
    lines.push(String(value.primaryMarkdown))
  }
  if (Array.isArray(value?.reports) && value.reports.length > 0) {
    lines.push('')
    lines.push(`Reports (${value.reports.length}):`)
    for (const report of value.reports.slice(0, 40)) {
      lines.push(`- ${report.tag === null || report.tag === undefined ? '' : `[${report.tag}] `}${truncate(JSON.stringify(report.item), 400)}`)
    }
    if (value.reports.length > 40) lines.push(`… ${value.reports.length - 40} more`)
  }
  if (Array.isArray(value?.artifacts) && value.artifacts.length > 0) {
    lines.push('')
    lines.push(`Artifacts (${value.artifacts.length}):`)
    for (const artifact of value.artifacts) {
      const size = artifact.itemCount === undefined ? '' : ` ${artifact.itemCount} bytes`
      lines.push(`- ${artifact.id} (${artifact.kind}) v${artifact.version}${size}${artifact.primary === true ? ' [primary]' : ''}`)
    }
  }
  if (value?.value !== undefined) {
    lines.push('')
    lines.push('Return value:')
    lines.push(truncate(JSON.stringify(value.value, null, 2) ?? 'null', 20000))
  }
  return lines.join('\n')
}

function truncate(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… [truncated ${text.length - limit} characters]`
}

function workflowRoots(settings, directory) {
  return [
    { scope: 'project', dir: resolve(directory, settings.projectWorkflowDir) },
    { scope: 'global', dir: settings.globalWorkflowDir },
  ]
}

async function scanWorkflows(settings, directory, query) {
  const roots = workflowRoots(settings, directory)
  const seen = new Set()
  const out = []
  for (const root of roots) {
    let names
    try {
      names = await readdir(root.dir)
    } catch {
      continue
    }
    for (const entry of names.sort()) {
      if (!entry.endsWith('.dwf.ts')) continue
      const absolute = join(root.dir, entry)
      const display = basename(entry, '.dwf.ts')
      if (seen.has(display)) continue
      let info
      try {
        info = await stat(absolute)
        if (!info.isFile()) continue
      } catch {
        continue
      }
      const parsed = await describeWorkflowFile(absolute)
      if (parsed === undefined) continue
      seen.add(display)
      const haystack = `${display} ${parsed.description ?? ''} ${parsed.whenToUse ?? ''}`.toLowerCase()
      if (typeof query === 'string' && query !== '' && !haystack.includes(query.toLowerCase())) continue
      out.push({
        name: display,
        scope: root.scope,
        path: absolute,
        description: parsed.description ?? '',
        whenToUse: parsed.whenToUse,
        args: parsed.args,
      })
    }
  }
  return out
}

async function describeWorkflowFile(absolute) {
  try {
    const text = await readFile(absolute, 'utf8')
    const split = splitFrontmatter(text)
    if (split.error !== undefined) return undefined
    const parsed = parseFrontmatterYaml(split.block)
    if (parsed.ok !== true) return undefined
    const description = typeof parsed.value.description === 'string' ? parsed.value.description.trim() : undefined
    const whenToUse = typeof parsed.value.whenToUse === 'string' ? parsed.value.whenToUse : undefined
    const declared = parsed.value.args
    const args = declared !== null && typeof declared === 'object' && !Array.isArray(declared) ? declared : undefined
    return { description, whenToUse, args }
  } catch {
    return undefined
  }
}

async function workingDirectoryOf(ctx, exec) {
  try {
    const working = ctx?.get?.('workingDirectory') ?? ctx?.workingDirectory
    if (exec?.agent !== undefined && working !== undefined) {
      try {
        const declared = working.get(exec.agent)
        if (typeof declared === 'string' && declared !== '') return declared
      } catch {
        // an unpublished Agent may have no committed directory yet
      }
      const ensured = await working.ensure(exec.agent)
      if (typeof ensured === 'string' && ensured !== '') return ensured
    }
  } catch (error) {
    console.warn(`[workflow-zcode] working directory unavailable: ${messageOf(error)}`)
  }
  return process.cwd()
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

export {
  resolveArgs, splitFrontmatter, parseFrontmatterYaml, normalizeFrontmatter, compile, renderEnvelope,
  CONFIRM_OPTIONS,
  // Exported for the route tests: the cancel/read/list handlers are pure
  // functions of (store, activeRuns), so they can be exercised without a Host.
  registerRunRoutes,
  // Exported for the launch-path tests: these validate before spending a model call.
  startResumeFromUi, configureRunFromUi, resolveMaxConcurrency, resolveSubagentModel,
}
