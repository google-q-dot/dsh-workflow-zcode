/**
 * Session/cwd isolation, real concurrency limiting, and the UI-facing launch
 * routes. These are the behaviours that decide whether two projects on one
 * machine can share a journal without seeing each other's runs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openJournal, RUN_STATUS } from '../src/engine/journal.mjs'
import { createTraceStore } from '../src/engine/trace-projection.mjs'
import { createActorPool } from '../src/engine/actor-pool.mjs'
import {
  applyPlanSettings, configureRunFromUi, registerRunRoutes, resolveMaxConcurrency,
  resolveRunAgentOptions, resolveSubagentModel, startResumeFromUi,
} from '../index.mjs'

function seed(journal, { id, session, cwd, status = 'completed' }) {
  journal.createRun({ id, parentSessionId: session, cwd, name: id, capsMaxConcurrency: 13, plan: { phases: [] } })
  journal.settleRun(id, { status, result: { value: 1 } })
}

test('projection: listRuns filters by session and by cwd, and reports both', async () => {
  const journal = openJournal()
  try {
    seed(journal, { id: 'a1', session: 'sess-A', cwd: '/repo/a' })
    seed(journal, { id: 'a2', session: 'sess-A', cwd: '/repo/a' })
    seed(journal, { id: 'b1', session: 'sess-B', cwd: '/repo/b' })
    const store = createTraceStore(journal)

    const bySession = await store.listRuns({ parentSessionId: 'sess-A' })
    assert.deepEqual(bySession.runs.map((run) => run.runId).sort(), ['a1', 'a2'])
    assert.equal(bySession.runs[0].parentSessionId, 'sess-A')
    assert.equal(bySession.runs[0].cwd, '/repo/a')

    const byCwd = await store.listRuns({ cwd: '/repo/b' })
    assert.deepEqual(byCwd.runs.map((run) => run.runId), ['b1'])

    const all = await store.listRuns({})
    assert.equal(all.runs.length, 3)
  } finally {
    journal.close()
  }
})

test('routes: /runs forwards sessionId and cwd, and never widens on its own', async () => {
  const routes = new Map()
  const ctx = {
    inject: (deps, callback) => callback({
      get: (name) => (name === 'connection'
        ? { fetch: { register: (definition) => { routes.set(definition.path, definition); return () => {} } } }
        : undefined),
      effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    }),
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  }
  const calls = []
  const store = {
    listRuns: async (query) => { calls.push(query); return { runs: [] } },
    readRun: async () => ({ status: 'completed' }),
    deleteRun: async () => true,
  }
  registerRunRoutes(ctx, store, { activeRuns: new Map() })
  const call = async (path, body) => {
    const route = routes.get(path)
    assert.ok(route !== undefined, `missing route ${path}`)
    const response = await route.fetch(new Request(`http://local${path}`, { method: 'POST', body: JSON.stringify(body) }))
    return JSON.parse(await response.text())
  }

  await call('/api/dsh-workflow-zcode/runs', { sessionId: 'sess-A' })
  assert.deepEqual(calls.at(-1), { parentSessionId: 'sess-A', cwd: undefined })

  await call('/api/dsh-workflow-zcode/runs', { cwd: '/repo/a' })
  assert.deepEqual(calls.at(-1), { parentSessionId: undefined, cwd: '/repo/a' })

  await call('/api/dsh-workflow-zcode/runs', {})
  assert.deepEqual(calls.at(-1), { parentSessionId: undefined, cwd: undefined })
})

test('routes: /resume and /configure hand the run to the launcher', async () => {
  const routes = new Map()
  const ctx = {
    inject: (deps, callback) => callback({
      get: (name) => (name === 'connection'
        ? { fetch: { register: (definition) => { routes.set(definition.path, definition); return () => {} } } }
        : undefined),
      effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    }),
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  }
  const launched = []
  const launcher = {
    resume: async (runId, overrides) => { launched.push({ kind: 'resume', runId, overrides }); return { runId, resumed: true } },
    configure: async (runId, overrides) => { launched.push({ kind: 'configure', runId, overrides }); return { runId, changes: [] } },
  }
  registerRunRoutes(ctx, { listRuns: async () => ({ runs: [] }), readRun: async () => ({ status: 'failed' }), deleteRun: async () => true }, { activeRuns: new Map(), launcher })
  const call = async (path, body) => {
    const response = await routes.get(path).fetch(new Request(`http://local${path}`, { method: 'POST', body: JSON.stringify(body) }))
    return JSON.parse(await response.text())
  }

  const resumed = await call('/api/dsh-workflow-zcode/resume', { runId: 'r1', max_concurrency: 7, subagent_model: 'cpa/gpt-6' })
  assert.equal(resumed.ok, true)
  assert.deepEqual(launched.at(-1), { kind: 'resume', runId: 'r1', overrides: { allowRehydrate: false, maxConcurrency: 7, subagentModel: 'cpa/gpt-6' } })

  const configured = await call('/api/dsh-workflow-zcode/configure', { runId: 'r1', maxConcurrency: 9, subagentModel: 'session' })
  assert.equal(configured.ok, true)
  assert.deepEqual(launched.at(-1), { kind: 'configure', runId: 'r1', overrides: { maxConcurrency: 9, subagentModel: 'session' } })

  const missing = await call('/api/dsh-workflow-zcode/resume', {})
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'bad-request')
})

test('routes: /delete refuses a live run and deletes a settled one', async () => {
  const routes = new Map()
  const ctx = {
    inject: (deps, callback) => callback({
      get: (name) => (name === 'connection'
        ? { fetch: { register: (definition) => { routes.set(definition.path, definition); return () => {} } } }
        : undefined),
      effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    }),
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  }
  const activeRuns = new Map([['live', {}]])
  let deleted = 0
  registerRunRoutes(ctx, {
    listRuns: async () => ({ runs: [] }),
    readRun: async (id) => ({ status: id === 'live' ? 'running' : 'completed' }),
    deleteRun: async () => { deleted += 1; return true },
  }, { activeRuns })
  const call = async (body) => {
    const response = await routes.get('/api/dsh-workflow-zcode/delete').fetch(new Request('http://local/delete', { method: 'POST', body: JSON.stringify(body) }))
    return JSON.parse(await response.text())
  }
  assert.equal((await call({ runId: 'live' })).error.code, 'running')
  const removed = await call({ runId: 'done' })
  assert.equal(removed.ok, true)
  assert.equal(removed.value.deleted, true)
  assert.equal(deleted, 1)
})

test('applyPlanSettings: builds the change list the panel shows', () => {
  const first = applyPlanSettings({ maxConcurrency: 13, subagentModel: { mode: 'session', label: '会话模型' } }, {
    maxConcurrency: 20,
    subagentModel: 'cpa/gpt-6.1',
  })
  assert.equal(first.plan.maxConcurrency, 20)
  assert.equal(first.plan.subagentModel.label, 'cpa/gpt-6.1')
  assert.deepEqual(first.changes.map((change) => change.field), ['maxConcurrency', 'subagentModel'])
  assert.equal(first.changes[0].from, 13)
  assert.equal(first.changes[0].to, 20)

  // No change → no noise in the journal.
  const same = applyPlanSettings(first.plan, { maxConcurrency: 20, subagentModel: 'cpa/gpt-6.1' })
  assert.deepEqual(same.changes, [])

  assert.throws(() => applyPlanSettings({}, { subagentModel: 'not-a-route' }), /session.*provider\/model/)
  // Clamped to the documented range.
  assert.equal(applyPlanSettings({}, { maxConcurrency: 999 }).plan.maxConcurrency, 64)
  assert.equal(applyPlanSettings({}, { maxConcurrency: 0 }).plan.maxConcurrency, 1)
})

test('actor pool: maxConcurrency caps simultaneous turns across actors', async () => {
  let active = 0
  let peak = 0
  const runtime = {
    async createActor({ sessionId }) { return { sessionId, name: null } },
    async sendTurn() {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 15))
    },
    async readReply() {
      active -= 1
      return 'ok'
    },
    async dispose() {},
  }
  const pool = createActorPool({ runId: 'run-cap', cwd: '/w', maxTotalAgents: 200, maxConcurrency: 2, runtime })
  await Promise.all(Array.from({ length: 7 }, (_, index) => pool.ask({
    siteId: `actor#${index + 1}`, ordinal: 1, name: `a${index}`, instructions: 'x',
  })))
  assert.equal(peak, 2, 'never more than the configured window')
  assert.equal(pool.stats().peak, 2)
  assert.equal(pool.stats().created, 7, 'the lifetime ceiling is separate from the window')
})

test('actor pool: maxTotalAgents still caps lifetime creation', async () => {
  const runtime = {
    async createActor({ sessionId }) { return { sessionId } },
    async sendTurn() {},
    async readReply() { return 'ok' },
    async dispose() {},
  }
  const pool = createActorPool({ runId: 'run-total', cwd: '/w', maxTotalAgents: 2, maxConcurrency: 4, runtime })
  await pool.ask({ siteId: 'actor#1', ordinal: 1, instructions: 'x' })
  await pool.ask({ siteId: 'actor#2', ordinal: 1, instructions: 'x' })
  await assert.rejects(() => pool.ask({ siteId: 'actor#3', ordinal: 1, instructions: 'x' }), /ceiling \(2 agents\)/)
})


test('subagent model: a pinned route overrides provider/model but keeps parent limits', () => {
  const parent = {
    id: 'parent',
    session: { requestHeader: () => ({ config: { provider: 'sess-provider', model: 'sess-model', reasoningEffort: 'high' } }) },
    options: { maxTokens: 4096, subagentDepth: 0 },
  }
  const pinned = resolveRunAgentOptions({
    subagentModel: { mode: 'fixed', provider: 'cpa', model: 'gpt-6.1' },
  }, parent)
  assert.equal(pinned.provider, 'cpa')
  assert.equal(pinned.model, 'gpt-6.1')
  assert.equal(pinned.reasoningEffort, 'high', 'other committed fields survive')
  assert.equal(pinned.maxTokens, 4096)

  const follow = resolveRunAgentOptions({ subagentModel: { mode: 'session', label: '会话模型' } }, parent)
  assert.equal(follow.provider, 'sess-provider')
  assert.equal(follow.model, 'sess-model')

  // A desktop resume has only an id; the stored creation-time options apply.
  const fromUi = resolveRunAgentOptions({
    defaultAgentOptions: { provider: 'stored-provider', model: 'stored-model', maxTokens: 2048 },
    subagentModel: { mode: 'session', label: '会话模型' },
  }, { id: 'parent' })
  assert.equal(fromUi.provider, 'stored-provider')
  assert.equal(fromUi.model, 'stored-model')
  assert.equal(fromUi.maxTokens, 2048)
})


test('launch guards: resume/configure refuse the wrong lifecycle state', async () => {
  const journal = openJournal()
  try {
    journal.createRun({ id: 'done', parentSessionId: 's', cwd: '/w', name: 'done', scriptText: 'x', scriptHash: 'h', plan: { source: 'x' }, capsMaxConcurrency: 13 })
    journal.settleRun('done', { status: RUN_STATUS.completed })
    journal.createRun({ id: 'no-plan', parentSessionId: 's', cwd: '/w', name: 'n', capsMaxConcurrency: 13 })
    journal.settleRun('no-plan', { status: RUN_STATUS.failed })

    const base = { ctx: {}, settings: {}, journal, tracking: {} }
    await assert.rejects(() => startResumeFromUi({ ...base, runId: 'missing' }), /no run/)
    await assert.rejects(() => startResumeFromUi({ ...base, runId: 'done' }), /only a failed or cancelled run/)
    await assert.rejects(() => startResumeFromUi({ ...base, runId: 'no-plan' }), /no stored plan/)
    await assert.rejects(() => configureRunFromUi({ ...base, runId: 'no-plan', overrides: { maxConcurrency: 20 } }), /no stored plan/)
    // A pending/running run cannot be reconfigured mid-flight.
    journal.createRun({ id: 'live', parentSessionId: 's', cwd: '/w', name: 'live', capsMaxConcurrency: 13 })
    await assert.rejects(() => configureRunFromUi({ ...base, runId: 'live', overrides: { maxConcurrency: 20 } }), /stop it before changing settings/)
  } finally {
    journal.close()
  }
})


test('run settings: max_concurrency is a window, max_total_agents stays the ceiling', () => {
  assert.equal(resolveMaxConcurrency({ maxConcurrency: 13 }, {}), 13)
  assert.equal(resolveMaxConcurrency({ maxConcurrency: 13 }, { max_concurrency: 4 }), 4)
  assert.equal(resolveMaxConcurrency({ maxConcurrency: 13 }, { max_concurrency: 999 }), 64)
  assert.equal(resolveMaxConcurrency({}, {}), 13)

  assert.deepEqual(resolveSubagentModel('session'), { mode: 'session', label: '会话模型' })
  assert.deepEqual(resolveSubagentModel(''), { mode: 'session', label: '会话模型' })
  assert.equal(resolveSubagentModel('cpa/gpt-6.1').mode, 'fixed')
  assert.equal(resolveSubagentModel('cpa/gpt-6.1').provider, 'cpa')
  assert.equal(resolveSubagentModel('cpa/gpt-6.1').model, 'gpt-6.1')
  assert.equal(resolveSubagentModel('broken').mode, 'invalid')
})


test('routes: /run refuses a run from another session', async () => {
  const routes = new Map()
  const ctx = {
    inject: (deps, callback) => callback({
      get: (name) => (name === 'connection'
        ? { fetch: { register: (definition) => { routes.set(definition.path, definition); return () => {} } } }
        : undefined),
      effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    }),
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  }
  registerRunRoutes(ctx, {
    listRuns: async () => ({ runs: [] }),
    readRun: async (id) => (id === 'r1' ? { runId: 'r1', parentSessionId: 'sess-A', status: 'completed' } : undefined),
    deleteRun: async () => true,
  }, { activeRuns: new Map() })
  const call = async (body) => {
    const response = await routes.get('/api/dsh-workflow-zcode/run').fetch(new Request('http://local/run', { method: 'POST', body: JSON.stringify(body) }))
    return JSON.parse(await response.text())
  }
  assert.equal((await call({ runId: 'r1', sessionId: 'sess-B' })).error.code, 'forbidden')
  assert.equal((await call({ runId: 'r1', sessionId: 'sess-A' })).ok, true)
  assert.equal((await call({ runId: 'missing' })).error.code, 'unknown-run')
})


test('configure a completed run records the change on its successor, never the old run', async () => {
  const journal = openJournal()
  try {
    journal.createRun({
      id: 'old', parentSessionId: 's', cwd: '/w', name: 'old',
      scriptText: 'return 1', scriptHash: 'hash',
      plan: { source: 'return 1', maxConcurrency: 13, subagentModel: { mode: 'session', label: '会话模型' } },
      capsMaxConcurrency: 13,
    })
    journal.settleRun('old', { status: RUN_STATUS.completed })

    const result = await configureRunFromUi({
      ctx: { get: () => undefined },
      settings: { maxConcurrency: 13 },
      journal,
      tracking: { track() {}, untrack() {} },
      runId: 'old',
      overrides: { maxConcurrency: 20, subagentModel: 'cpa/gpt-6.1' },
    })
    assert.notEqual(result.runId, 'old')
    const successor = journal.getRun(result.runId)
    assert.equal(successor.resumedFrom, 'old')
    assert.equal(successor.capsMaxConcurrency, 20)
    assert.equal(successor.plan.maxConcurrency, 20)
    assert.equal(successor.plan.subagentModel.label, 'cpa/gpt-6.1')
    const events = journal.listEventsOfType(result.runId, 'run-configured')
    assert.equal(events.length, 1)
    assert.deepEqual(events[0].payload.changes.map((change) => change.field), ['maxConcurrency', 'subagentModel'])

    // The completed run is history: its plan, caps and events stay untouched.
    const old = journal.getRun('old')
    assert.equal(old.capsMaxConcurrency, 13)
    assert.equal(old.plan.maxConcurrency, 13)
    assert.equal(journal.listEventsOfType('old', 'run-configured').length, 0)
  } finally {
    journal.close()
  }
})

test('configure refuses a completed run without plan.source', async () => {
  const journal = openJournal()
  try {
    journal.createRun({ id: 'legacy', parentSessionId: 's', cwd: '/w', name: 'legacy', capsMaxConcurrency: 13, plan: { maxConcurrency: 13 } })
    journal.settleRun('legacy', { status: RUN_STATUS.completed })
    await assert.rejects(
      () => configureRunFromUi({
        ctx: {}, settings: {}, journal, tracking: {}, runId: 'legacy', overrides: { maxConcurrency: 20 },
      }),
      /has no stored plan and cannot be configured/,
    )
    assert.equal(journal.getRun('legacy').capsMaxConcurrency, 13)
  } finally {
    journal.close()
  }
})
