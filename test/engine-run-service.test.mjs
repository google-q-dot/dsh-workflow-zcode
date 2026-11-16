/**
 * Offline integration checks for the run service.
 *
 * Everything below the model is real here — the journal, the artifact
 * publisher, the world reader and the actor pool — and only the sandboxed
 * child and the subagent turns are faked. That makes the seams that actually
 * break (ordinals, hashes, settlement on failure, artifact publishing)
 * observable without a network call.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ARTIFACT_KIND, NODE_KIND, openJournal, RUN_STATUS } from '../src/engine/journal.mjs'
import { createArtifactPublisher } from '../src/engine/artifacts.mjs'
import { createWorld } from '../src/engine/world.mjs'
import { createActorPool } from '../src/engine/actor-pool.mjs'
import { executeRun, worldOperation } from '../src/engine/run-service.mjs'

/**
 * A child that speaks the same NDJSON protocol as `child-entry.mjs`, but whose
 * script is a plain async function in the test.
 */
function createFakeChild(script) {
  let parentHandler
  const pending = new Map()
  let seq = 0
  let exitResolve
  const exited = new Promise((resolve) => {
    exitResolve = resolve
  })

  const deliver = (message) => parentHandler?.(message)

  const request = (payload) => new Promise((resolve, reject) => {
    seq += 1
    const id = `r${seq}`
    pending.set(id, { resolve, reject })
    deliver({ kind: 'request', id, ...payload })
  })
  const event = (payload) => deliver({ kind: 'event', ...payload })
  const complete = (payload) => deliver({ kind: 'complete', ...payload })

  const child = {
    /** Parent → child. */
    send(message) {
      if (message.kind === 'response') {
        const entry = pending.get(message.id)
        if (entry === undefined) return
        pending.delete(message.id)
        if (message.ok === true) entry.resolve(message.value)
        else entry.reject(Object.assign(new Error(message.error?.message ?? 'refused'), {
          code: message.error?.code,
        }))
        return
      }
      if (message.kind === 'start') {
        Promise.resolve()
          .then(() => script({ request, event, complete, args: message.args, askSchemas: message.askSchemas }))
          .then(
            (value) => complete({ ok: true, value: value === undefined ? null : value }),
            (error) => complete({
              ok: false,
              error: { name: error?.name ?? 'Error', message: error?.message ?? String(error) },
            }),
          )
      }
    },
    onMessage(handler) {
      parentHandler = handler
    },
    waitForExit() {
      return exited
    },
    terminate() {
      exitResolve(1)
    },
    exit(code = 0) {
      exitResolve(code)
    },
  }
  return child
}

/** A fake subagent runtime whose replies come from a scripted responder. */
function fakeRuntime(responder) {
  const sessions = new Map()
  const created = []
  return {
    sessions,
    created,
    async createActor({ sessionId, name, persona }) {
      created.push({ sessionId, name, persona })
      const handle = { sessionId, name, history: [], replies: [] }
      sessions.set(sessionId, handle)
      return handle
    },
    async sendTurn(handle, text) {
      handle.history.push(text)
      handle.replies.push(await responder(handle, text))
    },
    async readReply(handle) {
      return handle.replies[handle.replies.length - 1]
    },
    async dispose() {},
  }
}

async function fixture({ script, responder = () => 'ok', exec } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'zcode-run-'))
  await writeFile(join(root, 'notes.md'), '# 笔记\n内容\n')
  const journal = openJournal()
  journal.createRun({
    id: 'run-1',
    parentSessionId: 'sess-parent',
    cwd: root,
    name: 'demo',
    scriptText: 'phase("一")',
    scriptHash: 'hash',
    capsMaxConcurrency: 4,
  })
  const artifacts = createArtifactPublisher({ runId: 'run-1', cwd: root, journal })
  const runtime = fakeRuntime(responder)
  const actors = createActorPool({ runId: 'run-1', cwd: root, runtime })
  const world = createWorld({
    cwd: root,
    exec: exec ?? (async () => ({ exitCode: 0, stdout: 'world-out', stderr: '' })),
  })
  const child = createFakeChild(script)
  const cleanup = async () => {
    journal.close()
    await rm(root, { recursive: true, force: true })
  }
  return { root, journal, artifacts, actors, world, child, runtime, cleanup }
}

test('run service: a completing run records nodes, events and artifacts', async () => {
  const kit = await fixture({
    script: async ({ request, event, complete }) => {
      event({ type: 'phase', title: '阶段一' })
      const verdict = await request({ type: 'ask', siteId: 'ask#1', actorSiteId: 'actor#1', instructions: '评分', schema: { type: 'string' } })
      const run = await request({ type: 'world-read', siteId: 'world#1', op: 'run', args: ['python3', ['-V']] })
      event({ type: 'report', item: { verdict }, artifactId: 'kpi' })
      const doc = await request({ type: 'publish-artifact', op: 'markdown', artifactId: 'report', args: ['# 结论'] })
      complete({ ok: true, value: { verdict, run, doc } })
    },
    responder: () => '{"value": "通过"}',
  })
  try {
    const outcome = await executeRun({
      journal: kit.journal,
      runId: 'run-1',
      script: 'ignored',
      args: {},
      cwd: kit.root,
      child: kit.child,
      actors: kit.actors,
      world: kit.world,
      artifacts: kit.artifacts,
      actorDeclarations: new Map([['actor#1', { name: '审阅员', persona: { system: '独立审阅' } }]]),
    })

    assert.equal(outcome.status, RUN_STATUS.completed)
    assert.deepEqual(outcome.value.verdict, '通过')
    assert.equal(outcome.value.run.stdout, 'world-out')
    assert.deepEqual(outcome.value.doc, { id: 'report', version: 1, kind: 'markdown', bytes: Buffer.byteLength('# 结论') })

    const settled = kit.journal.getRun('run-1')
    assert.equal(settled.status, RUN_STATUS.completed)
    assert.deepEqual(settled.result, { value: outcome.value })

    const nodes = kit.journal.listNodes('run-1')
    const ask = nodes.find((node) => node.kind === NODE_KIND.ask)
    assert.equal(ask.status, 'completed')
    assert.equal(ask.siteId, 'ask#1')
    assert.equal(ask.ordinal, 1)
    // An ask node stores NULL input_json but always carries a hash.
    assert.equal(ask.input, undefined)
    assert.match(ask.inputHash, /^[0-9a-f]{8}$/)

    const world = nodes.find((node) => node.kind === NODE_KIND.worldRun)
    assert.equal(world.siteId, 'world#1')
    assert.deepEqual(world.input, { op: 'run', args: ['python3', ['-V']] })

    // Settlement is recorded too: a status change with no event leaves an
    // operator unable to explain the outcome.
    assert.deepEqual(
      kit.journal.listEvents('run-1').map((event) => event.type),
      ['phase-entered', 'report', 'run-settled'],
    )
    const settledEvent = kit.journal.listEvents('run-1').find((event) => event.type === 'run-settled')
    assert.equal(settledEvent.payload.status, RUN_STATUS.completed)
    assert.deepEqual(kit.artifacts.snapshot().artifacts.map((artifact) => artifact.id), ['report'])
    assert.equal(kit.artifacts.snapshot().artifacts[0].body, '# 结论')
  } finally {
    await kit.cleanup()
  }
})

test('run service: one actor keeps its session; ask and actor ordinals differ', async () => {
  const kit = await fixture({
    script: async ({ request, complete }) => {
      const first = await request({ type: 'ask', siteId: 'ask#1', actorSiteId: 'actor#1', instructions: '一' })
      const second = await request({ type: 'ask', siteId: 'ask#1', actorSiteId: 'actor#1', instructions: '二' })
      complete({ ok: true, value: [first, second] })
    },
    responder: (handle) => `第 ${handle.history.length} 轮`,
  })
  try {
    const outcome = await executeRun({
      journal: kit.journal,
      runId: 'run-1',
      script: 'x',
      args: {},
      cwd: kit.root,
      child: kit.child,
      actors: kit.actors,
      world: kit.world,
      artifacts: kit.artifacts,
    })
    assert.deepEqual(outcome.value, ['第 1 轮', '第 2 轮'])
    // Both asks belong to ask#1, so its ordinals are 1 and 2.
    assert.deepEqual(
      kit.journal.listNodes('run-1').filter((node) => node.siteId === 'ask#1').map((node) => node.ordinal),
      [1, 2],
    )
    // But there is exactly ONE actor session, proven by two turns on one handle.
    assert.equal(kit.runtime.sessions.size, 1)
    assert.equal([...kit.runtime.sessions.values()][0].history.length, 2)
  } finally {
    await kit.cleanup()
  }
})

test('run service: actors are journaled with their session before disposal', async () => {
  const kit = await fixture({
    script: async ({ request, complete }) => {
      await request({ type: 'ask', siteId: 'ask#1', actorSiteId: 'actor#1', instructions: '一' })
      await request({ type: 'ask', siteId: 'ask#2', actorSiteId: 'actor#2', instructions: '二' })
      complete({ ok: true, value: 'ok' })
    },
    responder: () => 'ok',
  })
  try {
    const outcome = await executeRun({
      journal: kit.journal,
      runId: 'run-1',
      script: 'x',
      args: {},
      cwd: kit.root,
      child: kit.child,
      actors: kit.actors,
      world: kit.world,
      artifacts: kit.artifacts,
      actorDeclarations: new Map([['actor#1', { name: '甲', persona: { system: '甲设定' } }]]),
    })

    // Counted before disposal: reading the emptied pool afterwards reported
    // "0 subagents" for a run that used several.
    assert.equal(outcome.agentsStarted, 2)

    const actors = kit.journal.listActors('run-1')
    assert.equal(actors.length, 2)
    const first = actors.find((actor) => actor.siteId === 'actor#1')
    // The session id is what resume reattaches to, so it must be persisted.
    assert.match(first.sessionId, /^sess_dwf-run-1-actor_1_1$/)
    assert.deepEqual(first.persona, { system: '甲设定' })

    // Node rows name the exact actor instance that was called.
    const ask = kit.journal.listNodes('run-1').find((node) => node.siteId === 'ask#1')
    assert.equal(ask.actorSiteId, 'actor#1')
    assert.equal(ask.actorOrdinal, 1)

    // The pool disposed its children: no session write lock survives the run.
    assert.equal([...kit.runtime.sessions.values()].every((handle) => handle.disposed !== false), true)
  } finally {
    await kit.cleanup()
  }
})

test('run service: a failed script is persisted, not dropped', async () => {
  const kit = await fixture({
    script: async ({ event, complete }) => {
      event({ type: 'phase', title: '阶段一' })
      complete({ ok: false, error: { name: 'WorkflowError', message: '子代理结果不合格', code: 'result_not_submitted' } })
    },
  })
  try {
    const outcome = await executeRun({
      journal: kit.journal,
      runId: 'run-1',
      script: 'x',
      args: {},
      cwd: kit.root,
      child: kit.child,
      actors: kit.actors,
      world: kit.world,
      artifacts: kit.artifacts,
    })
    assert.equal(outcome.status, RUN_STATUS.failed)
    assert.equal(outcome.error.message, '子代理结果不合格')

    // The whole point: the run row and its history survive the failure.
    const run = kit.journal.getRun('run-1')
    assert.equal(run.status, RUN_STATUS.failed)
    assert.equal(run.failure.message, '子代理结果不合格')
    assert.equal(run.failure.code, 'result_not_submitted')
    assert.equal(kit.journal.listEvents('run-1')[0].type, 'phase-entered')
  } finally {
    await kit.cleanup()
  }
})

test('run service: a world failure is catchable inside the script', async () => {
  const kit = await fixture({
    script: async ({ request, complete }) => {
      try {
        await request({ type: 'world-read', siteId: 'world#1', op: 'files.read', args: ['missing.txt'] })
        complete({ ok: true, value: 'no error' })
      } catch (error) {
        complete({ ok: true, value: `caught: ${error.message.slice(0, 20)}` })
      }
    },
  })
  try {
    const outcome = await executeRun({
      journal: kit.journal,
      runId: 'run-1',
      script: 'x',
      args: {},
      cwd: kit.root,
      child: kit.child,
      actors: kit.actors,
      world: kit.world,
      artifacts: kit.artifacts,
    })
    assert.equal(outcome.status, RUN_STATUS.completed)
    assert.match(outcome.value, /^caught: /)
    // The failed read is still journaled as failed.
    const node = kit.journal.listNodes('run-1').find((entry) => entry.siteId === 'world#1')
    assert.equal(node.status, 'failed')
    // The failure reason is kept on the node, so a panel can explain it later.
    assert.match(node.error.message, /missing\.txt/)
  } finally {
    await kit.cleanup()
  }
})

test('run service: cancelling settles the run as cancelled', async () => {
  const kit = await fixture({
    script: async ({ request }) => {
      await request({ type: 'ask', siteId: 'ask#1', actorSiteId: 'actor#1', instructions: '很慢' })
    },
    responder: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return 'done'
    },
  })
  try {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 10)
    const outcome = await executeRun({
      journal: kit.journal,
      runId: 'run-1',
      script: 'x',
      args: {},
      cwd: kit.root,
      child: kit.child,
      actors: kit.actors,
      world: kit.world,
      artifacts: kit.artifacts,
      signal: controller.signal,
    })
    assert.equal(outcome.status, RUN_STATUS.cancelled)
    assert.equal(kit.journal.getRun('run-1').status, RUN_STATUS.cancelled)
  } finally {
    await kit.cleanup()
  }
})

test('run service: a child that dies without a result still settles the run', async () => {
  const kit = await fixture({ script: async () => {} })
  try {
    const promise = executeRun({
      journal: kit.journal,
      runId: 'run-1',
      script: 'x',
      args: {},
      cwd: kit.root,
      child: kit.child,
      actors: kit.actors,
      world: kit.world,
      artifacts: kit.artifacts,
    })
    kit.child.exit(3)
    const outcome = await promise
    assert.equal(outcome.status, RUN_STATUS.failed)
    assert.equal(outcome.error.code, 'child_exited')
    assert.match(outcome.error.message, /exit code 3/)
  } finally {
    await kit.cleanup()
  }
})

test('run service: a preset artifact is declared and fed by report', async () => {
  const kit = await fixture({
    script: async ({ request, event, complete }) => {
      await request({ type: 'publish-artifact', op: 'metrics', artifactId: 'kpi', args: [{ metrics: [{ key: 'score' }] }] })
      event({ type: 'report', item: { score: 77 }, artifactId: 'kpi' })
      complete({ ok: true, value: 'ok' })
    },
  })
  try {
    const outcome = await executeRun({
      journal: kit.journal,
      runId: 'run-1',
      script: 'x',
      args: {},
      cwd: kit.root,
      child: kit.child,
      actors: kit.actors,
      world: kit.world,
      artifacts: kit.artifacts,
    })
    assert.equal(outcome.status, RUN_STATUS.completed)
    const artifact = kit.artifacts.snapshot().artifacts[0]
    assert.equal(artifact.kind, ARTIFACT_KIND.metrics)
    assert.deepEqual(kit.artifacts.snapshot().reports, [{ artifactId: 'kpi', item: { score: 77 } }])
  } finally {
    await kit.cleanup()
  }
})

test('run service: worldOperation maps facade names onto the reader', async () => {
  const calls = []
  const world = {
    read: (...args) => calls.push(['read', ...args]),
    glob: (pattern) => calls.push(['glob', pattern]),
    grep: (...args) => calls.push(['grep', ...args]),
    gitDiff: (...args) => calls.push(['diff', ...args]),
    gitLog: (count) => calls.push(['log', count]),
    changedFiles: (base) => calls.push(base === undefined ? ['changed'] : ['changed', base]),
    gitStatus: () => calls.push(['status']),
    run: (command, args) => calls.push(['run', command, args]),
  }
  // Argument positions follow the facade: read(path), glob(pattern),
  // grep(pattern, glob?), diff(base?, path?), log(count?), changedFiles(base?).
  worldOperation(world, 'files.read', ['a.txt'])
  worldOperation(world, 'files.glob', ['**/*.mjs'])
  worldOperation(world, 'files.grep', ['needle', 'src/**'])
  worldOperation(world, 'git.diff', ['main', 'x'])
  worldOperation(world, 'git.log', [3])
  worldOperation(world, 'git.changedFiles', ['main'])
  worldOperation(world, 'git.status', [])
  worldOperation(world, 'run', ['python3', ['-V'], { timeoutMs: 1000 }])
  assert.deepEqual(calls, [
    ['read', 'a.txt'],
    ['glob', '**/*.mjs'],
    ['grep', 'needle', 'src/**'],
    ['diff', 'main', 'x'],
    ['log', 3],
    ['changed', 'main'],
    ['status'],
    ['run', 'python3', ['-V']],
  ])
  assert.throws(() => worldOperation(world, 'nope', []), (error) => error.code === 'unsupported_world_op')
})


test('run service: the full task prompt is kept, not just the head', async () => {
  const longPrompt = `请审阅以下内容：${'x'.repeat(5000)}`
  const kit = await fixture({
    script: async ({ request, complete }) => {
      await request({ type: 'ask', siteId: 'ask#1', actorSiteId: 'actor#1', instructions: longPrompt })
      complete({ ok: true, value: 'ok' })
    },
    responder: () => 'ok',
  })
  try {
    await executeRun({
      journal: kit.journal, runId: 'run-1', script: 'x', args: {}, cwd: kit.root,
      child: kit.child, actors: kit.actors, world: kit.world, artifacts: kit.artifacts,
    })
    const node = kit.journal.listNodes('run-1').find((entry) => entry.siteId === 'ask#1')
    assert.equal(node.stats.instructions.length, longPrompt.length, 'the detail view needs the whole prompt')
    assert.equal(node.stats.instructionsHead.length, 240, 'the collapsed row keeps its teaser')
    assert.equal(node.stats.instructionsTruncated, undefined)
    assert.equal(node.stats.instructions.startsWith('请审阅以下内容：'), true)
  } finally {
    await kit.cleanup()
  }
})

test('run service: an oversized prompt is bounded and flagged', async () => {
  const huge = 'y'.repeat(20000)
  const kit = await fixture({
    script: async ({ request, complete }) => {
      await request({ type: 'ask', siteId: 'ask#1', actorSiteId: 'actor#1', instructions: huge })
      complete({ ok: true, value: 'ok' })
    },
    responder: () => 'ok',
  })
  try {
    await executeRun({
      journal: kit.journal, runId: 'run-1', script: 'x', args: {}, cwd: kit.root,
      child: kit.child, actors: kit.actors, world: kit.world, artifacts: kit.artifacts,
    })
    const node = kit.journal.listNodes('run-1').find((entry) => entry.siteId === 'ask#1')
    assert.equal(node.stats.instructions.length, 8192)
    assert.equal(node.stats.instructionsTruncated, true)
  } finally {
    await kit.cleanup()
  }
})


test('run service: the runtime actor name and persona beat the static declaration', async () => {
  const kit = await fixture({
    script: async ({ event, request, complete }) => {
      // A helper-created actor: only the runtime event knows its real identity.
      event({ type: 'actor', siteId: 'actor#1', name: '运行时工程师', persona: { system: '运行时人格' } })
      const value = await request({ type: 'ask', siteId: 'ask#1', actorSiteId: 'actor#1', instructions: '施工' })
      complete({ ok: true, value })
    },
    responder: () => 'ok',
  })
  try {
    await executeRun({
      journal: kit.journal,
      runId: 'run-1',
      script: 'ignored',
      args: {},
      cwd: kit.root,
      child: kit.child,
      actors: kit.actors,
      world: kit.world,
      artifacts: kit.artifacts,
      // Stale/incorrect static declaration must lose to the runtime one.
      actorDeclarations: new Map([['actor#1', { name: '静态名', persona: { system: '静态人格' } }]]),
    })
    assert.equal(kit.runtime.created.length, 1)
    assert.equal(kit.runtime.created[0].name, '运行时工程师')
    assert.deepEqual(kit.runtime.created[0].persona, { system: '运行时人格' })
  } finally {
    await kit.cleanup()
  }
})

test('run service: without an actor event the static declaration is still used', async () => {
  const kit = await fixture({
    script: async ({ request, complete }) => {
      const value = await request({ type: 'ask', siteId: 'ask#1', actorSiteId: 'actor#1', instructions: '施工' })
      complete({ ok: true, value })
    },
    responder: () => 'ok',
  })
  try {
    await executeRun({
      journal: kit.journal,
      runId: 'run-1',
      script: 'ignored',
      args: {},
      cwd: kit.root,
      child: kit.child,
      actors: kit.actors,
      world: kit.world,
      artifacts: kit.artifacts,
      actorDeclarations: new Map([['actor#1', { name: '静态名', persona: { system: '静态人格' } }]]),
    })
    assert.equal(kit.runtime.created[0].name, '静态名')
    assert.deepEqual(kit.runtime.created[0].persona, { system: '静态人格' })
  } finally {
    await kit.cleanup()
  }
})


test('run service: token usage settles on the run and on each actor', async () => {
  const kit = await fixture({
    script: async ({ request, complete }) => {
      const value = await request({ type: 'ask', siteId: 'ask#1', actorSiteId: 'actor#1', instructions: '施工' })
      complete({ ok: true, value })
    },
    responder: () => 'ok',
  })
  // The pool mints this id for actor#1@1; the adapter reports usage per session.
  const usage = {
    total: 456,
    bySession: new Map([['sess_dwf-run-1-actor_1_1', 456]]),
  }
  try {
    await executeRun({
      journal: kit.journal,
      runId: 'run-1',
      script: 'ignored',
      args: {},
      cwd: kit.root,
      child: kit.child,
      actors: kit.actors,
      world: kit.world,
      artifacts: kit.artifacts,
      usage,
    })
    assert.equal(kit.journal.getRun('run-1').spentTokens, 456)
    const actor = kit.journal.listActors('run-1')[0]
    assert.equal(actor.tokens, 456)
  } finally {
    await kit.cleanup()
  }
})

test('run service: late reply after abort and child exit never writes to dead child', async () => {
  let turnEntered
  const entered = new Promise((resolve) => {
    turnEntered = resolve
  })
  let rejectTurn
  const turnPromise = new Promise((_, reject) => {
    rejectTurn = reject
  })

  const kit = await fixture({
    script: async ({ request, complete }) => {
      const value = await request({ type: 'ask', siteId: 'ask#1', actorSiteId: 'actor#1', instructions: '耗时任务' })
      complete({ ok: true, value })
    },
    responder: () => {
      turnEntered()
      return turnPromise
    },
  })

  const originalSend = kit.child.send.bind(kit.child)
  let closed = false
  const lateResponses = []
  kit.child.send = (message) => {
    if (closed && message.kind === 'response') {
      lateResponses.push(message)
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    }
    return originalSend(message)
  }

  const controller = new AbortController()
  try {
    const runPromise = executeRun({
      journal: kit.journal,
      runId: 'run-1',
      script: 'ignored',
      args: {},
      cwd: kit.root,
      child: kit.child,
      actors: kit.actors,
      world: kit.world,
      artifacts: kit.artifacts,
      actorDeclarations: new Map([['actor#1', { name: '执行者', persona: { system: '干活' } }]]),
      signal: controller.signal,
    })

    await entered
    controller.abort()
    closed = true
    kit.child.exit(143)

    const outcome = await runPromise
    assert.equal(outcome.status, RUN_STATUS.cancelled)

    // Simulate the subagent turn failing several ticks later: handleRequest's
    // catch block calls reply(), which must drop the message rather than calling send().
    rejectTurn(new Error('late failure after pipe close'))
    await new Promise((resolve) => setTimeout(resolve, 15))
    assert.deepEqual(lateResponses, [])
  } finally {
    await kit.cleanup()
  }
})

test('run service: reply swallows synchronous send errors before exit settles', async () => {
  const kit = await fixture({
    script: async ({ request, complete }) => {
      const value = await request({ type: 'ask', siteId: 'ask#1', actorSiteId: 'actor#1', instructions: '测试' })
      complete({ ok: true, value })
    },
    responder: () => 'ok',
  })

  const originalSend = kit.child.send.bind(kit.child)
  kit.child.send = (message) => {
    if (message.kind === 'response') {
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    }
    return originalSend(message)
  }

  try {
    const runPromise = executeRun({
      journal: kit.journal,
      runId: 'run-1',
      script: 'ignored',
      args: {},
      cwd: kit.root,
      child: kit.child,
      actors: kit.actors,
      world: kit.world,
      artifacts: kit.artifacts,
      actorDeclarations: new Map([['actor#1', { name: '甲' }]]),
    })
    // Wait a tick for response write to fail harmlessly, then close child so run exits.
    await new Promise((resolve) => setTimeout(resolve, 15))
    kit.child.exit(1)
    const outcome = await runPromise
    assert.equal(outcome.status, RUN_STATUS.failed)
  } finally {
    await kit.cleanup()
  }
})
