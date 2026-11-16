/**
 * Resume semantics, all offline.
 *
 * A resume re-executes the script; what makes it a resume is that settled
 * effects replay from the journal instead of happening again. These cases pin
 * the three boundaries the design promised: cache hits cost nothing, a drifted
 * input fails the whole run, and sessions/artifacts/reports are not duplicated.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ARTIFACT_KIND, NODE_KIND, NODE_STATUS, openJournal, RUN_STATUS } from '../src/engine/journal.mjs'
import { nodeInput } from '../src/engine/input-hash.mjs'
import { createArtifactPublisher } from '../src/engine/artifacts.mjs'
import { createWorld } from '../src/engine/world.mjs'
import { createActorPool } from '../src/engine/actor-pool.mjs'
import { executeRun } from '../src/engine/run-service.mjs'

/** A child that issues a fixed request script, like a replayed workflow body. */
function createReplayChild(requests) {
  let parentHandler
  const pending = new Map()
  let seq = 0
  let exitResolve
  const exited = new Promise((resolve) => { exitResolve = resolve })
  const deliver = (message) => parentHandler?.(message)
  const request = (payload) => new Promise((resolve, reject) => {
    seq += 1
    const id = `r${seq}`
    pending.set(id, { resolve, reject })
    deliver({ kind: 'request', id, ...payload })
  })

  return {
    send(message) {
      if (message.kind === 'response') {
        const entry = pending.get(message.id)
        if (entry === undefined) return
        pending.delete(message.id)
        if (message.ok === true) entry.resolve(message.value)
        else entry.reject(Object.assign(new Error(message.error?.message ?? 'refused'), { code: message.error?.code }))
        return
      }
      if (message.kind === 'cancel') {
        exitResolve(1)
        return
      }
      if (message.kind === 'start') {
        Promise.resolve()
          .then(async () => {
            const values = []
            for (const step of requests) {
              // Accept both shapes: `{kind:'event', event}` and `{event}`, so a
              // test cannot silently send a request and pass vacuously.
              if (step.kind === 'event' || step.event !== undefined) {
                deliver({ kind: 'event', ...step.event })
                continue
              }
              values.push(await request(step.request))
            }
            deliver({ kind: 'complete', ok: true, value: values })
          })
          .catch((error) => deliver({
            kind: 'complete',
            ok: false,
            error: { name: error?.name ?? 'Error', message: error?.message ?? String(error), code: error?.code },
          }))
      }
    },
    onMessage(handler) { parentHandler = handler },
    waitForExit() { return exited },
    terminate() { exitResolve(1) },
  }
}

function fakeRuntime(responder = () => 'ok') {
  const sessions = new Map()
  const resumed = []
  const created = []
  return {
    sessions, resumed, created,
    async createActor({ sessionId, name }) {
      created.push(sessionId)
      const handle = { sessionId, name, history: [], replies: [] }
      sessions.set(sessionId, handle)
      return handle
    },
    async resumeActor({ sessionId, name }) {
      resumed.push(sessionId)
      if (this.rejectResume === true) {
        const error = new Error('session not found')
        error.code = 'actor_session_missing'
        throw error
      }
      const handle = { sessionId, name, history: [], replies: [] }
      sessions.set(sessionId, handle)
      return handle
    },
    async sendTurn(handle, turn) {
      handle.history.push(turn.text)
      handle.replies.push(await responder(handle))
    },
    async readReply(handle) { return handle.replies[handle.replies.length - 1] },
    async dispose() {},
  }
}

async function fixture({ requests, seed }) {
  const root = await mkdtemp(join(tmpdir(), 'zcode-resume-'))
  await writeFile(join(root, 'notes.md'), '# 笔记\n')
  const journal = openJournal()
  journal.createRun({
    id: 'run-1',
    parentSessionId: 'sess-parent',
    cwd: root,
    name: 'demo',
    scriptText: 'lowered',
    scriptHash: 'hash-1',
    plan: { source: 'phase("一")', askSchemas: [], actors: [], phases: ['一'], artifactSites: [], sites: {} },
    args: {},
    capsMaxConcurrency: 4,
  })
  if (seed !== undefined) seed(journal)
  const artifacts = createArtifactPublisher({ runId: 'run-1', cwd: root, journal, snapshotRoot: join(root, '.snap') })
  const runtime = fakeRuntime()
  const actors = createActorPool({ runId: 'run-1', cwd: root, runtime })
  const world = createWorld({ cwd: root, exec: async () => ({ exitCode: 0, stdout: 'live', stderr: '' }) })
  const child = createReplayChild(requests)
  return { root, journal, artifacts, actors, runtime, world, child,
    async cleanup() { journal.close(); await rm(root, { recursive: true, force: true }) } }
}

const askHash = (actorSiteId, instructions) => nodeInput({
  kind: NODE_KIND.ask, marker: { actorSiteId, instructions },
}).hash

test('resume: an identical input replays from the journal with zero model calls', async () => {
  const kit = await fixture({
    requests: [{ request: { type: 'ask', siteId: 'ask#1', actorSiteId: 'actor#1', instructions: '打分' } }],
    seed(journal) {
      journal.putNode({
        runId: 'run-1', siteId: 'ask#1', ordinal: 1, kind: NODE_KIND.ask,
        actorSiteId: 'actor#1', actorOrdinal: 1,
        inputHash: askHash('actor#1', '打分'),
        status: NODE_STATUS.completed, result: { score: 88 },
      })
    },
  })
  try {
    const outcome = await executeRun({
      journal: kit.journal, runId: 'run-1', script: 'x', args: {}, cwd: kit.root,
      child: kit.child, actors: kit.actors, world: kit.world, artifacts: kit.artifacts, replay: true,
    })
    assert.equal(outcome.status, RUN_STATUS.completed)
    assert.deepEqual(outcome.value, [{ score: 88 }])
    // The whole point: no subagent was created and no turn was sent.
    assert.equal(kit.runtime.created.length, 0)
    assert.equal(kit.runtime.sessions.size, 0)
    assert.equal(kit.journal.listEvents('run-1').some((event) => event.type === 'node-cached'), true)
    // The count is what the tool reports as "replayed N steps".
    assert.equal(outcome.cachedNodes, 1)
    const settledEvent = kit.journal.listEvents('run-1').find((event) => event.type === 'run-settled')
    assert.equal(settledEvent.payload.cachedNodes, 1)
  } finally {
    await kit.cleanup()
  }
})

test('resume: only the unsettled node runs live', async () => {
  const kit = await fixture({
    requests: [
      { request: { type: 'ask', siteId: 'ask#1', actorSiteId: 'actor#1', instructions: '一' } },
      { request: { type: 'ask', siteId: 'ask#2', actorSiteId: 'actor#1', instructions: '二' } },
    ],
    seed(journal) {
      journal.putNode({
        runId: 'run-1', siteId: 'ask#1', ordinal: 1, kind: NODE_KIND.ask,
        actorSiteId: 'actor#1', actorOrdinal: 1,
        inputHash: askHash('actor#1', '一'),
        status: NODE_STATUS.completed, result: 'cached-first',
      })
    },
  })
  kit.runtime.createActor = async ({ sessionId, name }) => {
    const handle = { sessionId, name, history: [], replies: [] }
    kit.runtime.sessions.set(sessionId, handle)
    return handle
  }
  try {
    const outcome = await executeRun({
      journal: kit.journal, runId: 'run-1', script: 'x', args: {}, cwd: kit.root,
      child: kit.child, actors: kit.actors, world: kit.world, artifacts: kit.artifacts, replay: true,
    })
    assert.equal(outcome.status, RUN_STATUS.completed)
    // 'cached-first' came from the journal; the second ask really ran (the fake
    // runtime answers 'ok'), which is what "only the unsettled node runs" means.
    assert.deepEqual(outcome.value, ['cached-first', 'ok'])
    // Exactly one turn was spent: the cached ask never reached the model.
    const handle = [...kit.runtime.sessions.values()][0]
    assert.equal(handle.history.length, 1)
  } finally {
    await kit.cleanup()
  }
})

test('resume: a drifted input fails the whole run instead of re-running it', async () => {
  const kit = await fixture({
    requests: [{ request: { type: 'ask', siteId: 'ask#1', actorSiteId: 'actor#1', instructions: '改了提示词' } }],
    seed(journal) {
      journal.putNode({
        runId: 'run-1', siteId: 'ask#1', ordinal: 1, kind: NODE_KIND.ask,
        actorSiteId: 'actor#1', actorOrdinal: 1,
        inputHash: askHash('actor#1', '原来的提示词'),
        status: NODE_STATUS.completed, result: 'stale',
      })
    },
  })
  try {
    const outcome = await executeRun({
      journal: kit.journal, runId: 'run-1', script: 'x', args: {}, cwd: kit.root,
      child: kit.child, actors: kit.actors, world: kit.world, artifacts: kit.artifacts, replay: true,
    })
    assert.equal(outcome.status, RUN_STATUS.failed)
    assert.equal(outcome.error.code, 'input_hash_mismatch')
    assert.match(outcome.error.message, /not deterministic/)
    // Nothing was executed, and the failure is on the run row.
    assert.equal(kit.runtime.created.length, 0)
    assert.equal(kit.journal.getRun('run-1').status, RUN_STATUS.failed)
  } finally {
    await kit.cleanup()
  }
})

test('resume: a failed node is retried, not skipped', async () => {
  const kit = await fixture({
    requests: [{ request: { type: 'ask', siteId: 'ask#1', actorSiteId: 'actor#1', instructions: '一' } }],
    seed(journal) {
      journal.putNode({
        runId: 'run-1', siteId: 'ask#1', ordinal: 1, kind: NODE_KIND.ask,
        actorSiteId: 'actor#1', actorOrdinal: 1,
        inputHash: askHash('actor#1', '一'),
        status: NODE_STATUS.failed, error: { message: '模型超时' },
      })
    },
  })
  try {
    const outcome = await executeRun({
      journal: kit.journal, runId: 'run-1', script: 'x', args: {}, cwd: kit.root,
      child: kit.child, actors: kit.actors, world: kit.world, artifacts: kit.artifacts, replay: true,
    })
    assert.equal(outcome.status, RUN_STATUS.completed)
    assert.equal([...kit.runtime.sessions.values()][0].history.length, 1, 'the failed node ran again')
    assert.equal(kit.journal.findNode('run-1', 'ask#1', 1).status, NODE_STATUS.completed)
  } finally {
    await kit.cleanup()
  }
})

test('resume: an actor reattaches to the recorded session', async () => {
  const kit = await fixture({
    requests: [{ request: { type: 'ask', siteId: 'ask#1', actorSiteId: 'actor#1', instructions: '一' } }],
    seed(journal) {
      journal.putActor({
        runId: 'run-1', siteId: 'actor#1', ordinal: 1, name: '打分员',
        persona: { system: '你只输出 JSON' }, sessionId: 'sess_dwf-run-1-actor_1_1',
      })
    },
  })
  try {
    const resumeSessions = new Map([['actor#1@1', 'sess_dwf-run-1-actor_1_1']])
    const pool = createActorPool({
      runId: 'run-1', cwd: kit.root, runtime: kit.runtime, resumeSessions,
    })
    await pool.ask({ siteId: 'actor#1', ordinal: 1, name: '打分员', persona: { system: '你只输出 JSON' }, instructions: '一' })
    assert.deepEqual(kit.runtime.resumed, ['sess_dwf-run-1-actor_1_1'])
    assert.equal(kit.runtime.created.length, 0, 'a reattach must not create a second session')
  } finally {
    await kit.cleanup()
  }
})

test('resume: a missing session fails unless rehydration is allowed', async () => {
  const kit = await fixture({ requests: [] })
  kit.runtime.rejectResume = true
  try {
    const resumeSessions = new Map([['actor#1@1', 'sess_gone']])
    const strict = createActorPool({ runId: 'run-1', cwd: kit.root, runtime: kit.runtime, resumeSessions })
    await assert.rejects(
      () => strict.ask({ siteId: 'actor#1', ordinal: 1, name: '甲', instructions: '一' }),
      /could not be resumed/,
    )

    const events = []
    const lenient = createActorPool({
      runId: 'run-1', cwd: kit.root, runtime: kit.runtime, resumeSessions,
      allowRehydrate: true, onEvent: (event) => events.push(event),
    })
    await lenient.ask({ siteId: 'actor#1', ordinal: 1, name: '甲', instructions: '一' })
    // Degrading is allowed but never silent.
    assert.equal(events.some((event) => event.type === 'actor-rehydrated'), true)
    assert.equal(kit.runtime.created.length, 1)
  } finally {
    await kit.cleanup()
  }
})

test('resume: reports are exactly once across attempts', async () => {
  const kit = await fixture({
    requests: [{ event: { type: 'report', item: { score: 74 }, artifactId: 'kpi' } }],
    seed(journal) {
      journal.putNode({
        runId: 'run-1', siteId: 'report:kpi', ordinal: 1, kind: NODE_KIND.report,
        inputHash: nodeInput({ kind: NODE_KIND.report, marker: { artifactId: 'kpi', item: { score: 74 } } }).hash,
        status: NODE_STATUS.completed, artifactId: 'kpi',
      })
      journal.appendEvent('run-1', 'report', { artifactId: 'kpi', item: { score: 74 } })
    },
  })
  try {
    await executeRun({
      journal: kit.journal, runId: 'run-1', script: 'x', args: {}, cwd: kit.root,
      child: kit.child, actors: kit.actors, world: kit.world, artifacts: kit.artifacts, replay: true,
    })
    const reports = kit.journal.listEvents('run-1').filter((event) => event.type === 'report')
    assert.equal(reports.length, 1, 'a replayed report must not append a second event')
  } finally {
    await kit.cleanup()
  }
})

test('resume: identical artifact content reuses its version', async () => {
  const kit = await fixture({ requests: [] })
  try {
    const first = await kit.artifacts.publishMarkdown('report', '# 结论文本')
    const second = await kit.artifacts.publishMarkdown('report', '# 结论文本')
    assert.equal(first.version, 1)
    assert.equal(second.version, 1, 'the same bytes do not mint v2')
    assert.equal(second.cached, true)

    const third = await kit.artifacts.publishMarkdown('report', '# 改写后的文本')
    assert.equal(third.version, 2, 'changed content does mint a new version')
    assert.equal(kit.journal.listArtifactVersions('run-1', 'report').length, 2)
  } finally {
    await kit.cleanup()
  }
})

test('resume: a file artifact is idempotent by bytes, not by path', async () => {
  const kit = await fixture({ requests: [] })
  try {
    const file = join(kit.root, 'notes.md')
    const first = await kit.artifacts.publishFile('doc', 'notes.md')
    const second = await kit.artifacts.publishFile('doc', 'notes.md')
    assert.equal(first.version, 1)
    assert.equal(second.version, 1)

    await writeFile(file, '# 改过了\n')
    const third = await kit.artifacts.publishFile('doc', 'notes.md')
    assert.equal(third.version, 2)
    assert.equal(kit.journal.listArtifacts('run-1').find((entry) => entry.artifactId === 'doc').version, 2)
  } finally {
    await kit.cleanup()
  }
})

test('resume: the run row records how many times it was reopened', async () => {
  const kit = await fixture({ requests: [] })
  try {
    assert.equal(kit.journal.getRun('run-1').resumeCount, 0)
    kit.journal.markResumed('run-1')
    kit.journal.settleRun('run-1', { status: RUN_STATUS.failed, failure: { message: 'again' } })
    kit.journal.markResumed('run-1')
    const run = kit.journal.getRun('run-1')
    assert.equal(run.resumeCount, 2)
    assert.equal(run.status, RUN_STATUS.running)
    // Reopening clears the previous failure: this attempt has not failed yet.
    assert.equal(run.failure, undefined)
    assert.equal(typeof run.timeLastResumed, 'number')
  } finally {
    await kit.cleanup()
  }
})


test('resume: a changed report item is caught by the input hash', async () => {
  const kit = await fixture({
    requests: [{ event: { type: 'report', item: { score: 99 }, artifactId: 'kpi' } }],
    seed(journal) {
      journal.putNode({
        runId: 'run-1', siteId: 'report:kpi', ordinal: 1, kind: NODE_KIND.report,
        // Recorded with a DIFFERENT item than the script now emits.
        inputHash: nodeInput({ kind: NODE_KIND.report, marker: { artifactId: 'kpi', item: { score: 74 } } }).hash,
        status: NODE_STATUS.completed, artifactId: 'kpi',
      })
    },
  })
  try {
    const outcome = await executeRun({
      journal: kit.journal, runId: 'run-1', script: 'x', args: {}, cwd: kit.root,
      child: kit.child, actors: kit.actors, world: kit.world, artifacts: kit.artifacts, replay: true,
    })
    // Silently skipping it would drop a report the script is publishing now.
    assert.equal(outcome.status, RUN_STATUS.failed)
    assert.equal(outcome.error.code, 'input_hash_mismatch')
    assert.equal(kit.journal.listEvents('run-1').filter((event) => event.type === 'report').length, 0)
  } finally {
    await kit.cleanup()
  }
})
