/**
 * Compatibility and stability fixes for the ZCode surface.
 *
 * Six behaviours are pinned here: chained `agent(...).ask<T>()`, runtime actor
 * identity, the global `run` object, the `submit_result` alias, the
 * `LocalToolSearch` shim and crash recovery of a journal left by a dead host.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { compile, loadTypeScript } from '../src/compiler.mjs'
import { NODE_STATUS, RUN_STATUS, openJournal } from '../src/engine/journal.mjs'
import { createArtifactPublisher } from '../src/engine/artifacts.mjs'
import { createWorld } from '../src/engine/world.mjs'
import { createActorPool } from '../src/engine/actor-pool.mjs'
import { executeRun } from '../src/engine/run-service.mjs'
import { createAgentRuntime } from '../src/engine/host-adapter.mjs'
import { encode, decode } from '../src/engine/protocol.mjs'

const facade = await readFile(new URL('../facade.d.ts', import.meta.url), 'utf8')
const { ts } = loadTypeScript()

/* ------------------------------------------------------------------ 1. compiler */

test('compiler: an inline chained ask is collected, typed and lowered', () => {
  const result = compile({
    body: `
      interface Score { value: number }
      const first = await agent("内联", { system: "只输出 JSON" }).ask<Score>("打分")
      return first
    `,
    facade,
    ts,
  })
  assert.equal(result.ok, true)
  assert.equal(result.askSchemas.length, 1)
  assert.equal(result.askSchemas[0].siteId, 'ask#1')
  assert.equal(result.askSchemas[0].schema.properties.value.type, 'number')
  // The receiver itself is lowered too, not left as `.ask is not a function`.
  assert.match(result.code, /__zcodeAsk\("ask#1", __zcodeCreateActor\(["']内联["']/)
})

test('compiler: an ask hidden inside a helper function is still a site', () => {
  const result = compile({
    body: `
      interface Verdict { ok: boolean; reasons: string[] }
      const reviewer = (name: string, persona: string, task: string) => agent(name, persona).ask<Verdict>(task)
      const a = await reviewer("甲", "严格", "审阅 A")
      const b = await reviewer("乙", "宽松", "审阅 B")
      return { a, b }
    `,
    facade,
    ts,
  })
  assert.equal(result.ok, true)
  // One SOURCE location: the helper body holds ask#1, so both calls reuse the
  // site (the runtime keys calls by site + ordinal). What matters is that the
  // site exists and its schema was extracted.
  assert.equal(result.askSchemas.length, 1)
  assert.equal(result.askSchemas[0].siteId, 'ask#1')
  assert.equal(result.askSchemas[0].schema.properties.ok.type, 'boolean')
  assert.equal(result.askSchemas[0].schema.properties.reasons.items.type, 'string')
  assert.equal((result.code.match(/__zcodeAsk\("ask#/gu) ?? []).length, 1)
  assert.match(result.code, /const reviewer = \(name, persona, task\) => __zcodeAsk\("ask#1", __zcodeCreateActor\(name, persona\), task\)/)
})

test('compiler: a conditional receiver and array indexing still resolve to Agent.ask', () => {
  const result = compile({
    body: `
      interface N { n: number }
      const pick = true ? agent("甲") : agent("乙")
      const fromConditional = await pick.ask<N>("一")
      const pool = [agent("丙"), agent("丁")]
      const fromIndex = await pool[0].ask<N>("二")
      return { fromConditional, fromIndex }
    `,
    facade,
    ts,
  })
  assert.equal(result.ok, true)
  assert.equal(result.askSchemas.length, 2)
})

test('compiler: a user object with its own ask() is not mistaken for the facade', () => {
  const result = compile({
    body: `
      const mine = { ask: (value: string) => value.toUpperCase() }
      const echoed = mine.ask("你好")
      return echoed
    `,
    facade,
    ts,
  })
  assert.equal(result.ok, true)
  assert.equal(result.askSchemas.length, 0)
  assert.equal(result.code.includes('__zcodeAsk'), false)
  assert.match(result.code, /mine\.ask\(["']你好["']\)/)
})

test('compiler: dynamic actor names never trigger the duplicate-name diagnostic', () => {
  const result = compile({
    body: `
      const named = "运行时-" + String(args.batch)
      const one = await agent(named).ask<string>("一")
      const two = await agent(named).ask<string>("二")
      return { one, two }
    `,
    facade,
    ts,
  })
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics))
  // Only two statically equal literals are a compile-time identity clash.
  assert.equal(result.diagnostics.some((entry) => entry.code === 9005), false)
})

test('compiler: schemas for arrays and literal unions survive the chained form', () => {
  const result = compile({
    body: `
      interface Payload { mode: "fast" | "safe"; items: number[] }
      const value = await agent("甲").ask<Payload>("跑")
      return value
    `,
    facade,
    ts,
  })
  assert.equal(result.ok, true)
  const schema = result.askSchemas[0].schema
  assert.equal(schema.properties.mode.oneOf.length, 2)
  assert.equal(schema.properties.items.type, 'array')
  assert.equal(schema.properties.items.items.type, 'number')
})

/* ------------------------------------------------------------------ 3. run global */

test('facade: the global run object is declared and usable', () => {
  const declared = compile({ body: 'return { id: run.id, from: run.resumedFrom }', facade, ts })
  assert.equal(declared.ok, true, JSON.stringify(declared.diagnostics))
  assert.equal(declared.code.includes('run.id'), true)
})

test('facade: a local const named run shadows the global without being rewritten', () => {
  const result = compile({
    body: `
      const run = await world.run("python3", ["-V"])
      return { code: run.exitCode }
    `,
    facade,
    ts,
  })
  // TypeScript accepts the shadowing; the compiler must not rewrite `run`.
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics))
  assert.match(result.code, /const run = await __zcodeReadWorld/)
  assert.equal(result.code.includes('__zcodeRun'), false)
})

test('child sandbox: run.id and run.resumedFrom are injected and shadowable', async () => {
  const entry = fileURLToPath(new URL('../src/engine/child-entry.mjs', import.meta.url))
  const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'] })
  const messages = []
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = decode(line)
    if (message !== undefined) messages.push(message)
  })
  child.stdin.write(encode({
    kind: 'start',
    code: `
      const local = (() => { const run = { id: "shadow" }; return run.id })()
      return { id: run.id, from: run.resumedFrom ?? null, local }
    `,
    args: {},
    askSchemas: {},
    run: { id: 'run-42', resumedFrom: 'run-1' },
  }))
  const complete = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out: ${JSON.stringify(messages)}`)), 8000)
    const poll = setInterval(() => {
      const found = messages.find((message) => message.kind === 'complete')
      if (found !== undefined) {
        clearTimeout(timer)
        clearInterval(poll)
        resolve(found)
      }
    }, 20)
  })
  child.kill()
  assert.equal(complete.ok, true)
  assert.deepEqual(complete.value, { id: 'run-42', from: 'run-1', local: 'shadow' })
})

test('run service: the start frame carries the run identity and origin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-run-meta-'))
  const journal = openJournal()
  try {
    journal.createRun({
      id: 'run-new', parentSessionId: 's', cwd: directory, name: 'meta',
      scriptText: 'x', scriptHash: 'h', resumedFrom: 'run-origin', capsMaxConcurrency: 1,
      plan: { source: 'x' },
    })
    const sent = []
    let handler
    const child = {
      send(message) {
        sent.push(message)
        if (message.kind === 'start') setTimeout(() => handler({ kind: 'complete', ok: true, value: null }), 0)
      },
      onMessage(next) { handler = next },
      waitForExit() { return new Promise(() => {}) },
      terminate() {},
    }
    const outcome = await executeRun({
      journal, runId: 'run-new', script: 'x', args: {}, cwd: directory, child,
      actors: { ask: async () => undefined, list: () => [], dispose: async () => {} },
      world: createWorld({ cwd: directory, exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }),
      artifacts: createArtifactPublisher({ runId: 'run-new', cwd: directory, journal }),
    })
    assert.equal(outcome.status, RUN_STATUS.completed)
    assert.deepEqual(sent[0].run, { id: 'run-new', resumedFrom: 'run-origin' })
  } finally {
    journal.close()
    await rm(directory, { recursive: true, force: true })
  }
})

/* ------------------------------------------------- 4/5. adapter tools */

/** Build a runtime whose agent setup captures the registered tool definitions. */
function adapterFixture({ resume = false, visibleTools = [], existingLocalSearch = false } = {}) {
  const registered = []
  const toolApi = {
    register: (definition) => { registered.push(definition); return () => {} },
    get: (name) => (existingLocalSearch && name === 'LocalToolSearch' ? { name } : undefined),
    schemas: async () => visibleTools,
  }
  const agentCtx = {
    systemPrompt: { section: () => () => {} },
    tools: toolApi,
    get: () => ({ set: async () => {} }),
  }
  const handle = {
    agent: { id: 'child', followup() {}, whenIdle: async () => {} },
    dispose: async () => {},
  }
  const agents = {
    async create(options) { await options.setup?.(agentCtx, handle.agent); return handle },
    async resume(options) { await options.setup?.(agentCtx, handle.agent); return handle },
  }
  const runtime = createAgentRuntime({
    ctx: { on: () => () => {} },
    agents,
    subagents: { sendMessage: async () => {} },
    parentAgent: { id: 'parent' },
    cwd: '/w',
    agentOptions: { provider: 'p', model: 'm' },
  })
  return { runtime, registered, handle, resume }
}

async function openAdapter(fixtureOptions) {
  const kit = adapterFixture(fixtureOptions)
  const handle = fixtureOptions?.resume === true
    ? await kit.runtime.resumeActor({ sessionId: 'sess-1', cwd: '/w', name: '甲', persona: { system: '严格' } })
    : await kit.runtime.createActor({ sessionId: 'sess-1', name: '甲', persona: { system: '严格' } })
  return { ...kit, handle }
}

test('adapter: submit_result is registered next to structured_output and shares the capture', async () => {
  const { runtime, registered, handle } = await openAdapter()
  const names = registered.map((definition) => definition.name)
  assert.ok(names.includes('structured_output'))
  assert.ok(names.includes('submit_result'))

  await runtime.sendTurn(handle, {
    text: 'x',
    schema: { type: 'object', properties: { score: { type: 'number' } }, required: ['score'], additionalProperties: false },
  })
  const submit = registered.find((definition) => definition.name === 'submit_result')
  const accepted = await submit.execute({ json: '{"score": 91}' }, {})
  assert.deepEqual(accepted, { accepted: true })
  assert.deepEqual(await runtime.readReply(handle), { structured: true, value: { score: 91 } })
})

test('adapter: submit_result also accepts an already-parsed object and rejects a bad shape', async () => {
  const { runtime, registered, handle } = await openAdapter()
  await runtime.sendTurn(handle, { text: 'x', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } })
  const submit = registered.find((definition) => definition.name === 'submit_result')

  const bad = await submit.execute({ json: { ok: 'yes' } }, {})
  assert.match(bad.error.message, /does not match the schema/)

  const good = await submit.execute({ json: { ok: true } }, {})
  assert.deepEqual(good, { accepted: true })
})

test('adapter: resumeActor registers the same tool set', async () => {
  const { registered } = await openAdapter({ resume: true })
  const names = registered.map((definition) => definition.name)
  assert.ok(names.includes('structured_output'))
  assert.ok(names.includes('submit_result'))
  assert.ok(names.includes('LocalToolSearch'))
})

test('adapter: LocalToolSearch matches MCP names case-insensitively with select: prefixes', async () => {
  const { registered } = await openAdapter({
    visibleTools: [
      { name: 'mcp__LibTV__doctor', description: 'check LibTV runtime' },
      { name: 'read', description: 'read a file' },
      { name: 'bash', description: 'run a command' },
    ],
  })
  const search = registered.find((definition) => definition.name === 'LocalToolSearch')
  const result = await search.execute({ query: 'select: MCP__libtv__doctor' }, {})
  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0].name, 'mcp__LibTV__doctor')
  assert.match(result.note, /无需额外加载动作/)
})

test('adapter: LocalToolSearch handles multiple terms separated by 、 and spaces', async () => {
  const { registered } = await openAdapter({
    visibleTools: [
      { name: 'read', description: 'read a file' },
      { name: 'bash', description: 'run a command' },
      { name: 'mcp__LibTV__generate_video', description: 'video' },
    ],
  })
  const search = registered.find((definition) => definition.name === 'LocalToolSearch')
  const result = await search.execute({ query: 'read、bash', max_results: 5 }, {})
  assert.deepEqual(result.matches.map((match) => match.name).sort(), ['bash', 'read'])
})

test('adapter: LocalToolSearch degrades gracefully when enumeration is unavailable', async () => {
  const { registered } = await openAdapter({ visibleTools: undefined })
  const search = registered.find((definition) => definition.name === 'LocalToolSearch')
  // schemas() returns undefined here, so the tool must not throw.
  const result = await search.execute({ query: 'anything' }, {})
  assert.deepEqual(result.matches, [])
  assert.equal(result.enumeration, 'unavailable')
  const rendered = search.output.render({}, result)
  assert.match(rendered[0].text, /无需额外加载动作/)
})

test('adapter: an existing LocalToolSearch is not registered twice', async () => {
  const { registered } = await openAdapter({ existingLocalSearch: true })
  assert.equal(registered.filter((definition) => definition.name === 'LocalToolSearch').length, 0)
})

/* ---------------------------------------------------- 6. journal recovery */

test('journal: a run left pending/running by a dead host is settled as host_restart', async () => {
  const journal = openJournal()
  try {
    journal.createRun({ id: 'r-pending', parentSessionId: 's', cwd: '/w', name: 'pending', capsMaxConcurrency: 1 })
    journal.createRun({ id: 'r-running', parentSessionId: 's', cwd: '/w', name: 'running', capsMaxConcurrency: 1 })
    journal.putNode({
      runId: 'r-running', siteId: 'ask#1', ordinal: 1, kind: 'ask', inputHash: 'h',
      status: NODE_STATUS.running,
    })
    journal.putNode({
      runId: 'r-running', siteId: 'ask#2', ordinal: 1, kind: 'ask', inputHash: 'h2',
      status: NODE_STATUS.completed, result: { ok: true },
    })

    const outcome = journal.reconcileInterruptedRuns()
    assert.deepEqual(outcome, { runs: 2, nodes: 1 })

    for (const id of ['r-pending', 'r-running']) {
      const run = journal.getRun(id)
      assert.equal(run.status, RUN_STATUS.failed)
      assert.equal(run.failure.code, 'host_restart')
      const settled = journal.listEventsOfType(id, 'run-settled')
      assert.equal(settled.length, 1)
      assert.equal(settled[0].payload.code, 'host_restart')
    }
    const runningNode = journal.findNode('r-running', 'ask#1', 1)
    assert.equal(runningNode.status, NODE_STATUS.failed)
    assert.equal(runningNode.error.code, 'host_restart')
    // A completed node keeps its result.
    assert.equal(journal.findNode('r-running', 'ask#2', 1).status, NODE_STATUS.completed)
    // A reconciled run is resumable: failed is exactly what resume accepts.
    assert.equal(journal.getRun('r-running').status, 'failed')
  } finally {
    journal.close()
  }
})

test('journal: every method is safe after close (no "statement has been finalized")', async () => {
  const journal = openJournal()
  journal.createRun({ id: 'r1', parentSessionId: 's', cwd: '/w', name: 'n', capsMaxConcurrency: 1 })
  journal.close()

  // None of these may throw; readers answer with empty values.
  assert.equal(journal.getRun('r1'), undefined)
  assert.deepEqual(journal.listRuns({}), [])
  assert.deepEqual(journal.listNodes('r1'), [])
  assert.deepEqual(journal.listEvents('r1'), [])
  assert.equal(journal.putNode({
    runId: 'r1', siteId: 'ask#9', ordinal: 1, kind: 'ask', inputHash: 'h', status: NODE_STATUS.running,
  }), undefined)
  assert.equal(journal.appendEvent('r1', 'late', {}), undefined)
  assert.equal(journal.reconcileInterruptedRuns().runs, 0)
  // A late async callback must not surface an unhandled rejection either.
  await new Promise((resolve) => {
    setTimeout(() => {
      journal.putNode({ runId: 'r1', siteId: 'ask#10', ordinal: 1, kind: 'ask', inputHash: 'h', status: 'running' })
      resolve()
    }, 5)
  })
  journal.close()
})

test('journal: applying the plugin reconciles runs left by the previous host', async () => {
  const { apply } = await import('../index.mjs')
  const directory = await mkdtemp(join(tmpdir(), 'zcode-reconcile-'))
  const file = join(directory, 'runs.db')
  try {
    const seed = openJournal({ file })
    seed.createRun({ id: 'left-over', parentSessionId: 's', cwd: directory, name: 'left', capsMaxConcurrency: 1 })
    seed.close()

    const registered = []
    apply({
      tools: { register: (definition) => { registered.push(definition); return () => {} } },
      on: () => () => {},
      effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
      inject: () => {},
      get: () => undefined,
    }, { journalFile: file })
    assert.ok(registered.some((definition) => definition.name === 'run_zcode_workflow'))

    const check = openJournal({ file })
    try {
      assert.equal(check.getRun('left-over').status, RUN_STATUS.failed)
      assert.equal(check.getRun('left-over').failure.code, 'host_restart')
    } finally {
      check.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
