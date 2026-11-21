/**
 * Contract tests for the optional `zcodeWorkflow` service: compact replies,
 * session scoping, precise cancellation, configure-without-resume, delete
 * guards, and registration on the Cordis context.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openJournal, RUN_STATUS } from '../src/engine/journal.mjs'
import {
  createWorkflowControlService,
  WorkflowServiceError,
  ZCODE_SERVICE_NAME,
  ZCODE_SERVICE_VERSION,
} from '../src/engine/control-service.mjs'
import { apply } from '../index.mjs'

function seed(journal, { status = RUN_STATUS.running, sessionId = 'sess-1', nodes = 3, script = 'return 1' } = {}) {
  const runId = 'dwfrun-test'
  journal.createRun({
    id: runId,
    parentSessionId: sessionId,
    cwd: '/tmp/work',
    name: 'demo',
    scriptText: script,
    scriptHash: 'hash',
    plan: { source: script, phases: ['P1'], actors: [{ id: 'a', name: 'Alice' }], maxConcurrency: 3 },
    args: {},
    capsMaxConcurrency: 3,
  })
  journal.markRunning(runId)
  journal.putActor({ runId, siteId: 'a', ordinal: 0, name: 'Alice', resolvedModel: 'p/m', sessionId: 'sess-dwf-a', tokens: 42 })
  for (let index = 0; index < nodes; index += 1) {
    journal.putNode({
      runId,
      siteId: 'a',
      ordinal: index,
      kind: 'ask',
      actorSiteId: 'a',
      actorOrdinal: 0,
      actorSeq: index + 1,
      inputHash: `h${index}`,
      input: JSON.stringify({ prompt: 'x'.repeat(2000) }),
      status: index === nodes - 1 ? 'completed' : 'completed',
      result: { text: 'y'.repeat(500) },
      stats: { phase: 'P1', instructions: 'i'.repeat(5000) },
      messageBoundary: index + 1,
    })
  }
  journal.appendEvent(runId, 'phase-entered', { title: 'P1' })
  journal.putArtifact({ runId, artifactId: 'art1', kind: 'markdown', title: 'Report', body: '#'.repeat(5000), itemCount: 1 })
  if (status !== RUN_STATUS.running) {
    journal.settleRun(runId, { status, failure: status === RUN_STATUS.failed ? { message: 'boom' } : undefined })
  }
  return runId
}

function build({ journal, active = true, configure, launcher } = {}) {
  const controllers = new Map()
  if (active) controllers.set('dwfrun-test', { abort: (reason) => { controllers.get('dwfrun-test').reason = reason } })
  let configured
  const service = createWorkflowControlService({
    journal,
    activeRuns: controllers,
    launcher: { resume: launcher ?? (async (runId) => ({ runId, resumed: true })) },
    configure: configure ?? (async (runId, overrides) => {
      configured = overrides
      return { changed: true, changes: ['maxConcurrency'], maxConcurrency: overrides.maxConcurrency }
    }),
    sessionPolicy: { get: (id) => id === 'sess-auto', set: (_id, value) => value },
  })
  return { service, controllers, configured: () => configured }
}

test('listRuns is scoped, compact, and never leaks the script', async () => {
  const journal = openJournal({ file: ':memory:' })
  const runId = seed(journal)
  const { service } = build({ journal })

  const own = await service.listRuns({ sessionId: 'sess-1' })
  assert.equal(own.runs.length, 1)
  assert.equal(own.runs[0].runId, runId)
  assert.equal(own.runs[0].phase, 'P1')
  assert.equal(own.runs[0].nodeStats.total, 3)
  assert.equal('script' in own.runs[0], false)

  assert.equal((await service.listRuns({ sessionId: 'someone-else' })).runs.length, 0)
  assert.equal((await service.listRuns({ sessionId: 'sess-1', status: 'failed' })).runs.length, 0)
  assert.ok(JSON.stringify(own).length < 2000)

  const detail = await service.getRun({ runId, sessionId: 'sess-1' })
  assert.equal(detail.script, undefined, 'script is opt-in')
  assert.equal(detail.trace, undefined, 'trace is opt-in')
  assert.equal(detail.nodes[0].instructions, undefined, 'node instructions stay out')
  assert.equal(JSON.stringify(detail.artifacts).includes('body'), false)
  assert.ok(JSON.stringify(detail).length < 5000, 'compact detail stays small')
  assert.equal(detail.actors[0].sessionId, 'sess-dwf-a')

  const full = await service.getRun({ runId, sessionId: 'sess-1', includeScript: true, includeTrace: true })
  assert.equal(full.script, 'return 1')
  assert.ok(Array.isArray(full.trace))
  journal.close()
})

test('getRun caps nodes and reports truncation', async () => {
  const journal = openJournal({ file: ':memory:' })
  const runId = seed(journal, { nodes: 30 })
  const { service } = build({ journal })
  const detail = await service.getRun({ runId, sessionId: 'sess-1', maxNodes: 10 })
  assert.equal(detail.nodes.length, 10)
  assert.equal(detail.nodesTruncated, true)
  assert.equal(detail.nodeStats.total, 30)
  journal.close()
})

test('cancelRun aborts exactly the live run and refuses a foreign session', async () => {
  const journal = openJournal({ file: ':memory:' })
  const runId = seed(journal)
  const { service, controllers } = build({ journal })

  await assert.rejects(
    service.cancelRun({ runId, sessionId: 'sess-other' }),
    (error) => error instanceof WorkflowServiceError && error.code === 'WORKFLOW_FORBIDDEN',
  )
  const value = await service.cancelRun({ runId, sessionId: 'sess-1' })
  assert.equal(value.cancelled, true)
  assert.match(controllers.get(runId).reason, /workflow service/)
  journal.close()
})

test('late cancel is WORKFLOW_NOT_RUNNING, not a fake success', async () => {
  const journal = openJournal({ file: ':memory:' })
  const runId = seed(journal, { status: RUN_STATUS.completed })
  const { service } = build({ journal, active: false })
  await assert.rejects(
    service.cancelRun({ runId, sessionId: 'sess-1' }),
    (error) => error.code === 'WORKFLOW_NOT_RUNNING',
  )
  journal.close()
})

test('configureRun updates settings only and never resumes', async () => {
  const journal = openJournal({ file: ':memory:' })
  const runId = seed(journal, { status: RUN_STATUS.failed })
  let resumed = false
  const { service, configured } = build({ journal, active: false, launcher: async () => { resumed = true } })
  const value = await service.configureRun({ runId, sessionId: 'sess-1', maxConcurrency: 5 })
  assert.equal(value.changed, true)
  assert.equal(value.resumed, false)
  assert.deepEqual(configured(), { maxConcurrency: 5 })
  assert.equal(resumed, false, 'configure must not start work')
  journal.close()
})

test('configureRun rejects a running run and a completed run', async () => {
  const journal = openJournal({ file: ':memory:' })
  const running = seed(journal)
  const { service } = build({ journal })
  await assert.rejects(service.configureRun({ runId: running, sessionId: 'sess-1', maxConcurrency: 5 }), (error) => error.code === 'WORKFLOW_BAD_STATE')
  journal.settleRun(running, { status: RUN_STATUS.completed })
  await assert.rejects(service.configureRun({ runId: running, sessionId: 'sess-1', maxConcurrency: 5 }), (error) => error.code === 'WORKFLOW_BAD_STATE')
  journal.close()
})

test('deleteRun refuses a live run and removes a settled one', async () => {
  const journal = openJournal({ file: ':memory:' })
  const runId = seed(journal, { status: RUN_STATUS.completed })
  const { service } = build({ journal, active: false })
  const deleted = await service.deleteRun({ runId, sessionId: 'sess-1' })
  assert.equal(deleted.deleted, true)
  assert.equal(journal.getRun(runId), undefined)
  journal.close()
})

test('session policy reads, sets, and rejects a bad session', async () => {
  const journal = openJournal({ file: ':memory:' })
  seed(journal)
  const { service } = build({ journal, active: false })
  assert.equal((await service.getSessionPolicy({ sessionId: 'sess-auto' })).autoApprove, true)
  assert.equal((await service.setSessionPolicy({ sessionId: 'sess-1', autoApprove: true })).autoApprove, true)
  await assert.rejects(service.getSessionPolicy({}), (error) => error.code === 'WORKFLOW_BAD_REQUEST')
  journal.close()
})

test('apply() provides zcodeWorkflow with a version and disposes with the journal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zcode-service-'))
  const provided = new Map()
  const tools = []
  const disposers = []
  const ctx = {
    tools: { register: (definition) => { tools.push(definition.name); return () => {} } },
    on: () => () => {},
    effect(fn) { disposers.push(fn()); return () => {} },
    inject() { return () => {} },
    provide(name, value) { provided.set(name, value); return () => {} },
    get: () => undefined,
  }
  apply(ctx, { journalFile: join(root, 'runs.db'), projectWorkflowDir: join(root, 'workflows') })
  assert.ok(provided.has(ZCODE_SERVICE_NAME))
  const service = provided.get(ZCODE_SERVICE_NAME)
  assert.equal(service.version, ZCODE_SERVICE_VERSION)
  assert.equal(typeof service.getRun, 'function')
  assert.equal(typeof service.cancelRun, 'function')
  assert.equal(tools.includes('run_zcode_workflow'), true)
  for (const dispose of disposers.reverse()) {
    try { await dispose?.() } catch {}
  }
  await rm(root, { recursive: true, force: true })
})
