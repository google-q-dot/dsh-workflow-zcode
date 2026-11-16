/**
 * The sidebar panel's data contract. These assertions are what the Client half
 * actually reads, so a journal change that breaks the panel fails here instead
 * of showing an empty pane.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { openJournal } from '../src/engine/journal.mjs'
import { createTraceStore } from '../src/engine/trace-projection.mjs'

function seededJournal() {
  const journal = openJournal()
  journal.createRun({
    id: 'run-1',
    parentSessionId: 'sess-parent',
    cwd: '/w',
    name: 'demo',
    capsMaxConcurrency: 4,
  })
  journal.putActor({ runId: 'run-1', siteId: 'actor#1', ordinal: 1, name: '打分员', persona: null, sessionId: 'sess_a' })
  journal.putNode({
    runId: 'run-1', siteId: 'ask#1', ordinal: 1, kind: 'ask',
    actorSiteId: 'actor#1', actorOrdinal: 1, inputHash: 'aaaa1111',
    status: 'completed', result: { score: 74 },
    stats: { phase: '检查', instructionsHead: '给这个方案打分', typed: true },
  })
  journal.putNode({
    runId: 'run-1', siteId: 'world#1', ordinal: 1, kind: 'world-run',
    inputHash: 'bbbb2222', status: 'completed',
    result: { exitCode: 0, stdout: '42' },
    input: JSON.stringify({ op: 'run', args: ['python3', ['-c', 'print(6*7)']] }),
    stats: { phase: '检查' },
  })
  journal.putArtifact({ runId: 'run-1', artifactId: 'report', kind: 'markdown', body: '# 结果', version: 1 })
  journal.appendEvent('run-1', 'phase-entered', { title: '检查' })
  journal.appendEvent('run-1', 'report', { artifactId: 'kpi', item: { score: 74 } })
  journal.settleRun('run-1', { status: 'completed', result: { value: { s1: 74 } } })
  return journal
}

test('trace projection: the run list carries what the panel shows', () => {
  const journal = seededJournal()
  try {
    const store = createTraceStore(journal)
    return store.listRuns({}).then((value) => {
      assert.equal(value.runs.length, 1)
      const run = value.runs[0]
      assert.equal(run.runId, 'run-1')
      assert.equal(run.workflowId, 'demo')
      assert.equal(run.status, 'completed')
      assert.equal(typeof run.startedAt, 'number')
      assert.equal(typeof run.durationMs, 'number')
      // Ask nodes are the calls the panel counts; world reads are not.
      assert.equal(run.nodes, 1)
      assert.equal(run.phases, 1)
    })
  } finally {
    journal.close()
  }
})

test('trace projection: one run renders phases, actors and node state', async () => {
  const journal = seededJournal()
  try {
    const trace = await createTraceStore(journal).readRun('run-1')
    assert.equal(trace.status, 'completed')
    assert.deepEqual(trace.phases.map((phase) => phase.title), ['检查'])
    assert.equal(trace.actors.length, 1)
    assert.equal(trace.actors[0].name, '打分员')

    const ask = trace.nodes.find((node) => node.siteId === 'ask#1')
    // The panel keys its lamp off `state`.
    assert.equal(ask.state, 'settled')
    assert.equal(ask.actorName, '打分员')
    assert.equal(ask.phase, '检查')
    assert.equal(ask.instructionsHead, '给这个方案打分')
    assert.equal(ask.kind, 'ask')
    // Structured-ness comes from the record, not from a hardcoded false.
    assert.equal(ask.typed, true)
    assert.equal(ask.hasSchema, true)
    assert.match(ask.result, /74/)
    assert.equal(typeof ask.resultPreview, 'string')

    const world = trace.nodes.find((node) => node.siteId === 'world#1')
    assert.equal(world.state, 'settled')
    // A workspace step is labelled by the command it ran, not left anonymous.
    assert.equal(world.kind, 'world-run')
    assert.equal(world.worldCommand, 'python3 -c print(6*7)')
    assert.equal(world.actorName, null)

    // `tag` keeps the existing panel working; `artifactId` is the new name for
    // the same value.
    assert.deepEqual(trace.reports, [{ tag: 'kpi', artifactId: 'kpi', item: { score: 74 } }])
    assert.deepEqual(trace.artifacts.map((artifact) => artifact.id), ['report'])
    // Everything the panel renders must survive JSON.
    assert.deepEqual(JSON.parse(JSON.stringify(trace)), trace)
  } finally {
    journal.close()
  }
})

test('trace projection: a failed run reports its failure and no result', async () => {
  const journal = openJournal()
  try {
    journal.createRun({ id: 'r2', parentSessionId: 's', cwd: '/w', name: 'bad', capsMaxConcurrency: 1 })
    journal.settleRun('r2', { status: 'failed', failure: { message: '子代理没有提交结果', code: 'result_not_submitted' } })
    const trace = await createTraceStore(journal).readRun('r2')
    assert.equal(trace.status, 'failed')
    assert.equal(trace.error, '子代理没有提交结果')
    assert.equal(trace.actors.length, 0)

    await assert.rejects(() => createTraceStore(journal).readRun('missing'), /no run/)
  } finally {
    journal.close()
  }
})

test('trace projection: planned phases that never ran are still stations', async () => {
  const journal = openJournal()
  try {
    journal.createRun({
      id: 'r-phases',
      parentSessionId: 's',
      cwd: '/w',
      name: 'planned',
      capsMaxConcurrency: 7,
      plan: { phases: ['调研', '施工', '验收'], sourcePath: '.zcode/planned.dwf.ts' },
    })
    journal.putActor({ runId: 'r-phases', siteId: 'actor#1', ordinal: 1, name: '调研员', resolvedModel: 'glm-5.3-flash' })
    journal.putNode({
      runId: 'r-phases', siteId: 'ask#1', ordinal: 1, kind: 'ask',
      actorSiteId: 'actor#1', actorOrdinal: 1, inputHash: 'h1', status: 'completed', result: { n: 1 },
      stats: { phase: '调研', typed: true, instructions: '调研一下' },
    })
    journal.appendEvent('r-phases', 'phase-entered', { title: '调研' })
    journal.settleRun('r-phases', { status: 'completed', result: { value: 1 }, spentTokens: 4321 })

    const trace = await createTraceStore(journal).readRun('r-phases')
    // All three stations exist, in plan order, even though only one ran.
    assert.deepEqual(trace.phases.map((phase) => phase.title), ['调研', '施工', '验收'])
    assert.deepEqual(trace.phases.map((phase) => phase.status), ['completed', 'pending', 'pending'])
    assert.equal(trace.phases[1].observedCount, 0)
    assert.equal(trace.phases[1].planned, true)

    // Run-level metadata comes straight from the row, never invented.
    assert.equal(trace.maxConcurrency, 7)
    assert.equal(trace.spentTokens, 4321)
    assert.equal(trace.sourcePath, '.zcode/planned.dwf.ts')
    assert.equal(trace.resolvedModel, 'glm-5.3-flash')
    assert.equal(trace.settledSteps, 1)
    assert.equal(trace.totalSteps, 1)
    assert.equal(trace.artifactCount, 0)
    assert.equal(trace.resumeCount, 0)
  } finally {
    journal.close()
  }
})

test('trace projection: a runtime-computed phase name binds to its plan placeholder', async () => {
  const journal = openJournal()
  try {
    journal.createRun({
      id: 'r-runtime',
      parentSessionId: 's',
      cwd: '/w',
      name: 'runtime',
      // `phase("Phase " + id)` compiles to an unnamed plan entry.
      plan: { phases: [null, '固定阶段'] },
    })
    journal.putNode({
      runId: 'r-runtime', siteId: 'ask#1', ordinal: 1, kind: 'ask', inputHash: 'h2', status: 'completed',
      stats: { phase: 'Phase 1 · 洪水' },
    })
    journal.appendEvent('r-runtime', 'phase-entered', { title: 'Phase 1 · 洪水' })
    journal.settleRun('r-runtime', { status: 'completed', result: {} })

    const trace = await createTraceStore(journal).readRun('r-runtime')
    assert.equal(trace.phases.length, 2)
    assert.equal(trace.phases[0].title, 'Phase 1 · 洪水')
    assert.equal(trace.phases[1].title, '固定阶段')
    assert.equal(trace.phases[0].status, 'completed')
    assert.equal(trace.phases[1].status, 'pending')
  } finally {
    journal.close()
  }
})

test('trace projection: a phase groups actors separately from workspace commands', async () => {
  const journal = openJournal()
  try {
    journal.createRun({ id: 'r-roles', parentSessionId: 's', cwd: '/w', name: 'roles', plan: { phases: ['施工'] } })
    journal.putActor({ runId: 'r-roles', siteId: 'actor#1', ordinal: 1, name: '工程师', resolvedModel: 'glm-5.3-flash' })
    journal.putActor({ runId: 'r-roles', siteId: 'actor#2', ordinal: 1, name: '校验员', resolvedModel: 'glm-5.3-flash' })
    journal.putNode({ runId: 'r-roles', siteId: 'ask#1', ordinal: 1, kind: 'ask', actorSiteId: 'actor#1', inputHash: 'h3', status: 'completed', result: {}, stats: { phase: '施工' } })
    journal.putNode({ runId: 'r-roles', siteId: 'ask#2', ordinal: 1, kind: 'ask', actorSiteId: 'actor#1', inputHash: 'h4', status: 'failed', error: { message: 'x' }, stats: { phase: '施工' } })
    journal.putNode({ runId: 'r-roles', siteId: 'ask#3', ordinal: 1, kind: 'ask', actorSiteId: 'actor#2', inputHash: 'h5', status: 'completed', result: {}, stats: { phase: '施工' } })
    journal.putNode({ runId: 'r-roles', siteId: 'world#1', ordinal: 1, kind: 'world-run', inputHash: 'h6', status: 'completed', result: { exitCode: 0 }, input: JSON.stringify({ op: 'run', args: ['pytest'] }), stats: { phase: '施工' } })
    journal.appendEvent('r-roles', 'phase-entered', { title: '施工' })
    journal.settleRun('r-roles', { status: 'failed', failure: { message: 'x' } })

    const trace = await createTraceStore(journal).readRun('r-roles')
    const phase = trace.phases[0]
    assert.equal(phase.status, 'failed')
    const engineer = phase.roles.find((role) => role.siteId === 'actor#1')
    assert.equal(engineer.kind, 'actor')
    assert.equal(engineer.name, '工程师')
    assert.equal(engineer.total, 2)
    assert.equal(engineer.failed, 1)
    assert.equal(engineer.state, 'failed')
    const world = phase.roles.find((role) => role.kind === 'world')
    assert.equal(world.name, '工作区命令')
    assert.equal(world.total, 1)
    assert.equal(world.state, 'completed')
    // Every node carries the bucket key so the UI can drill into one role.
    assert.equal(trace.nodes.find((node) => node.siteId === 'world#1').roleKey, '__world__')
    assert.equal(trace.nodes.find((node) => node.siteId === 'ask#1').roleKey, 'actor#1')
  } finally {
    journal.close()
  }
})

test('trace projection: resume history reaches the panel', async () => {
  const journal = openJournal()
  try {
    journal.createRun({ id: 'r-resume', parentSessionId: 's', cwd: '/w', name: 'resumed', plan: { phases: [] } })
    journal.settleRun('r-resume', { status: 'failed', failure: { message: 'boom' } })
    journal.markResumed('r-resume')
    const trace = await createTraceStore(journal).readRun('r-resume')
    assert.equal(trace.resumeCount, 1)
    assert.equal(typeof trace.lastResumedAt, 'number')
    assert.equal(trace.status, 'running')
  } finally {
    journal.close()
  }
})

test('trace projection: work before the first phase gets an 未分阶段 station', async () => {
  const journal = openJournal()
  try {
    journal.createRun({
      id: 'r-unphased', parentSessionId: 's', cwd: '/w', name: 'unphased',
      plan: { phases: ['施工'] },
    })
    journal.putNode({
      runId: 'r-unphased', siteId: 'ask#0', ordinal: 1, kind: 'ask', inputHash: 'h0',
      status: 'completed', result: { ok: true }, stats: { instructions: '先做一次检查' },
    })
    journal.putNode({
      runId: 'r-unphased', siteId: 'ask#1', ordinal: 1, kind: 'ask', inputHash: 'h1',
      status: 'completed', result: { ok: true }, stats: { phase: '施工' },
    })
    journal.appendEvent('r-unphased', 'phase-entered', { title: '施工' })
    journal.settleRun('r-unphased', { status: 'completed', result: {} })

    const trace = await createTraceStore(journal).readRun('r-unphased')
    assert.deepEqual(trace.phases.map((phase) => phase.title), ['施工', '未分阶段'])
    assert.equal(trace.phases[1].nodes.length, 1)
    assert.equal(trace.phases[1].settledCount, 1)
    // The header's step counter must include it too.
    assert.equal(trace.settledSteps, 2)
    assert.equal(trace.totalSteps, 2)
  } finally {
    journal.close()
  }
})
