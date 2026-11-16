/**
 * Offline checks for the actor pool. A fake runtime stands in for the model:
 * it records turns per session, so queueing, context accumulation, schema
 * handling and the repair loop are all observable without spending a request.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createActorPool,
  mintActorSessionId,
  parseJsonReply,
  ResultNotSubmitted,
  validate,
  wrapSchema,
} from '../src/engine/actor-pool.mjs'

/** A runtime that answers each turn from a script and records what it saw. */
function fakeRuntime(responder) {
  const sessions = new Map()
  const handles = []
  const created = []
  let inFlight = 0
  let maxInFlight = 0
  const runtime = {
    sessions,
    handles,
    created,
    get maxInFlight() {
      return maxInFlight
    },
    async createActor({ sessionId, name, persona }) {
      created.push(sessionId)
      const handle = { sessionId, name, persona, history: [], replies: [], schemas: [] }
      sessions.set(sessionId, handle)
      handles.push(handle)
      return handle
    },
    async resumeActor({ sessionId, name }) {
      if (runtime.rejectResume === true) {
        const error = new Error('session not found')
        error.code = 'actor_session_missing'
        throw error
      }
      const handle = { sessionId, name, history: [], replies: [] }
      sessions.set(sessionId, handle)
      handles.push(handle)
      return handle
    },
    async sendTurn(handle, turn) {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      // A turn on one session must never overlap another turn on it.
      assert.equal(handle.busy, undefined, 'two turns overlapped on one actor session')
      handle.busy = true
      try {
        handle.history.push(turn.text)
        handle.schemas.push(turn.schema)
        // Yield so an overlapping caller would be caught by the assertion above.
        await new Promise((resolve) => setTimeout(resolve, 1))
        handle.replies.push(await responder(handle, turn.text))
      } finally {
        handle.busy = undefined
        inFlight -= 1
      }
    },
    async readReply(handle) {
      return handle.replies[handle.replies.length - 1]
    },
    async dispose(handle) {
      handle.disposed = true
    },
  }
  return runtime
}

test('actor pool: the session id follows the origin formula', () => {
  assert.equal(
    mintActorSessionId('dwfrun-db94922c', 'actor#4', 29),
    'sess_dwf-dwfrun-db94922c-actor_4_29',
  )
  // Underscores double first, so the original survives a round trip.
  assert.equal(mintActorSessionId('a_b', 'ask#1', 1), 'sess_dwf-a__b-ask_1_1')
})

test('actor pool: one persistent session accumulates context across asks', async () => {
  const runtime = fakeRuntime((handle) => `turn ${handle.history.length}`)
  const pool = createActorPool({ runId: 'run-1', cwd: '/w', runtime })

  const first = await pool.ask({ siteId: 'actor#1', ordinal: 1, name: '审阅员', instructions: '第一件事' })
  const second = await pool.ask({ siteId: 'actor#1', ordinal: 1, name: '审阅员', instructions: '第二件事' })

  assert.equal(first, 'turn 1')
  assert.equal(second, 'turn 2')
  assert.equal(runtime.handles.length, 1, 'a named actor must reuse its session')
  const handle = runtime.handles[0]
  assert.equal(handle.history.length, 2, 'the second ask lands on the same session')
  assert.equal(handle.sessionId, mintActorSessionId('run-1', 'actor#1', 1))
})

test('actor pool: asks on one actor never overlap', async () => {
  const runtime = fakeRuntime((handle) => `ok ${handle.history.length}`)
  const pool = createActorPool({ runId: 'run-1', cwd: '/w', runtime })

  // Fired together: the queue must serialize them.
  const results = await Promise.all([
    pool.ask({ siteId: 'actor#1', ordinal: 1, name: 'a', instructions: '1' }),
    pool.ask({ siteId: 'actor#1', ordinal: 1, name: 'a', instructions: '2' }),
    pool.ask({ siteId: 'actor#1', ordinal: 1, name: 'a', instructions: '3' }),
  ])

  assert.deepEqual(results, ['ok 1', 'ok 2', 'ok 3'])
  assert.equal(runtime.maxInFlight, 1, 'the pool must keep one turn in flight per actor')
  assert.equal(runtime.handles.length, 1)
})

test('actor pool: different actors run concurrently and get their own sessions', async () => {
  const runtime = fakeRuntime((handle) => handle.name)
  const pool = createActorPool({ runId: 'run-1', cwd: '/w', runtime })

  const [a, b] = await Promise.all([
    pool.ask({ siteId: 'actor#1', ordinal: 1, name: '甲', instructions: 'x' }),
    pool.ask({ siteId: 'actor#2', ordinal: 1, name: '乙', instructions: 'y' }),
  ])
  assert.equal(a, '甲')
  assert.equal(b, '乙')
  assert.equal(runtime.handles.length, 2)
  assert.notEqual(runtime.handles[0].sessionId, runtime.handles[1].sessionId)
  assert.deepEqual(pool.list().map((actor) => actor.name).sort(), ['乙', '甲'])
})

test('actor pool: a rejected ask does not poison the queue', async () => {
  let call = 0
  const runtime = fakeRuntime(() => {
    call += 1
    if (call === 1) throw new Error('模型超时')
    return 'recovered'
  })
  const pool = createActorPool({ runId: 'run-1', cwd: '/w', runtime })

  await assert.rejects(
    () => pool.ask({ siteId: 'actor#1', ordinal: 1, name: 'a', instructions: '一' }),
    /模型超时/,
  )
  const second = await pool.ask({ siteId: 'actor#1', ordinal: 1, name: 'a', instructions: '二' })
  assert.equal(second, 'recovered')
})

test('actor pool: the persona is installed at creation, never repeated per turn', async () => {
  const runtime = fakeRuntime(() => 'ok')
  const pool = createActorPool({ runId: 'run-1', cwd: '/w', runtime })
  await pool.ask({
    siteId: 'actor#1',
    ordinal: 1,
    name: '审阅员',
    persona: { system: '你独立复核别人的结论。' },
    instructions: '请审阅',
  })
  await pool.ask({
    siteId: 'actor#1',
    ordinal: 1,
    name: '审阅员',
    persona: { system: '你独立复核别人的结论。' },
    instructions: '再看一次',
  })

  const handle = runtime.handles[0]
  // Standing instructions belong to the child's context, not to each message.
  assert.deepEqual(handle.persona, { system: '你独立复核别人的结论。' })
  for (const text of handle.history) {
    assert.equal(text.includes('# Role'), false, 'the persona must not be re-injected per turn')
    assert.match(text, /^# Task/)
  }
})

test('actor pool: the schema travels structurally with each turn', async () => {
  const runtime = fakeRuntime(() => '{"value": 1}')
  const pool = createActorPool({ runId: 'run-1', cwd: '/w', runtime })
  await pool.ask({
    siteId: 'ask#1',
    ordinal: 1,
    name: 'a',
    instructions: '给个数',
    schema: { type: 'number' },
  })
  // The adapter registers structured_output from this schema; wrapping is the
  // pool's job so the child can always answer with an object.
  assert.deepEqual(runtime.handles[0].schemas[0], {
    type: 'object',
    properties: { value: { type: 'number' } },
    required: ['value'],
    additionalProperties: false,
  })
})

test('actor pool: a tool-captured result skips parsing entirely', async () => {
  const runtime = fakeRuntime(() => ({ structured: true, value: { score: 95 } }))
  const pool = createActorPool({ runId: 'run-1', cwd: '/w', runtime })
  const value = await pool.ask({
    siteId: 'ask#1',
    ordinal: 1,
    name: 'a',
    instructions: '评分',
    schema: { type: 'object', properties: { score: { type: 'number' } }, required: ['score'] },
  })
  assert.deepEqual(value, { score: 95 })
  assert.equal(runtime.handles[0].history.length, 1, 'no repair turn was needed')

  // A tool result that violates the schema still gets exactly one repair turn.
  let call = 0
  const bad = fakeRuntime(() => {
    call += 1
    return call === 1 ? { structured: true, value: { score: 'high' } } : { structured: true, value: { score: 88 } }
  })
  const pool2 = createActorPool({ runId: 'run-1', cwd: '/w', runtime: bad })
  const repaired = await pool2.ask({
    siteId: 'ask#1',
    ordinal: 1,
    name: 'a',
    instructions: '评分',
    schema: { type: 'object', properties: { score: { type: 'number' } }, required: ['score'] },
  })
  assert.deepEqual(repaired, { score: 88 })
  assert.equal(call, 2)
})

test('actor pool: object schemas validate directly, scalars wrap and unwrap', async () => {
  const runtime = fakeRuntime(() => '{"score": 88, "approved": true}')
  const pool = createActorPool({ runId: 'run-1', cwd: '/w', runtime })

  const verdict = await pool.ask({
    siteId: 'ask#1',
    ordinal: 1,
    name: '评审',
    instructions: '评分',
    schema: {
      type: 'object',
      properties: { score: { type: 'number' }, approved: { type: 'boolean' } },
      required: ['score', 'approved'],
    },
  })
  assert.deepEqual(verdict, { score: 88, approved: true })
  // The prompt tells the child the exact schema it must satisfy.
  assert.match(runtime.handles[0].history[0], /single JSON object/)
  assert.match(runtime.handles[0].history[0], /"score"/)

  const scalarRuntime = fakeRuntime(() => '{"value": "结论"}')
  const scalarPool = createActorPool({ runId: 'run-1', cwd: '/w', runtime: scalarRuntime })
  const answer = await scalarPool.ask({
    siteId: 'ask#2',
    ordinal: 1,
    name: '回答',
    instructions: '给结论',
    schema: { type: 'string' },
  })
  // `ask<string>` must come back as a string, not as `{ value: ... }`.
  assert.equal(answer, '结论')
})

test('actor pool: prose around JSON is accepted, a bad answer gets one repair turn', async () => {
  let call = 0
  const runtime = fakeRuntime(() => {
    call += 1
    if (call === 1) return '我认为结果是 {"score": 70} 大概这样'
    return '```json\n{"score": 70}\n```'
  })
  const pool = createActorPool({ runId: 'run-1', cwd: '/w', runtime })
  const value = await pool.ask({
    siteId: 'ask#1',
    ordinal: 1,
    name: '评审',
    instructions: '评分',
    schema: { type: 'object', properties: { score: { type: 'number' } }, required: ['score'] },
  })
  assert.deepEqual(value, { score: 70 })
  assert.equal(call, 1, 'valid JSON embedded in prose needs no repair')

  call = 0
  const stubborn = fakeRuntime(() => {
    call += 1
    return call === 1 ? '完全不是 JSON' : '{"score": 91}'
  })
  const repairPool = createActorPool({ runId: 'run-1', cwd: '/w', runtime: stubborn })
  const repaired = await repairPool.ask({
    siteId: 'ask#1',
    ordinal: 1,
    name: '评审',
    instructions: '评分',
    schema: { type: 'object', properties: { score: { type: 'number' } }, required: ['score'] },
  })
  assert.deepEqual(repaired, { score: 91 })
  assert.equal(call, 2, 'exactly one repair turn')
  assert.match(stubborn.handles[0].history[1], /# Correction/)
})

test('actor pool: two unusable answers fail with ResultNotSubmitted', async () => {
  const runtime = fakeRuntime(() => '仍然不是 JSON')
  const pool = createActorPool({ runId: 'run-1', cwd: '/w', runtime })
  await assert.rejects(
    () => pool.ask({
      siteId: 'ask#1',
      ordinal: 1,
      name: '评审',
      instructions: '评分',
      schema: { type: 'object', properties: { score: { type: 'number' } } },
    }),
    (error) => error instanceof ResultNotSubmitted,
  )
  assert.equal(runtime.handles[0].history.length, 2, 'original ask plus one repair')
})

test('actor pool: schema violations trigger repair and then fail loudly', async () => {
  const runtime = fakeRuntime(() => '{"score": "很高"}')
  const pool = createActorPool({ runId: 'run-1', cwd: '/w', runtime })
  await assert.rejects(
    () => pool.ask({
      siteId: 'ask#1',
      ordinal: 1,
      name: '评审',
      instructions: '评分',
      schema: { type: 'object', properties: { score: { type: 'number' } }, required: ['score'] },
    }),
    (error) => error instanceof ResultNotSubmitted && Array.isArray(error.violations),
  )
})

test('actor pool: the subagent ceiling is enforced', async () => {
  const runtime = fakeRuntime(() => 'ok')
  const pool = createActorPool({ runId: 'run-1', cwd: '/w', runtime, maxTotalAgents: 1 })
  await pool.ask({ siteId: 'actor#1', ordinal: 1, name: 'a', instructions: 'x' })
  await assert.rejects(
    () => pool.ask({ siteId: 'actor#2', ordinal: 1, name: 'b', instructions: 'y' }),
    /subagent ceiling/,
  )
})

test('actor pool: dispose tears down every child', async () => {
  const runtime = fakeRuntime(() => 'ok')
  const pool = createActorPool({ runId: 'run-1', cwd: '/w', runtime })
  await pool.ask({ siteId: 'actor#1', ordinal: 1, name: 'a', instructions: 'x' })
  await pool.ask({ siteId: 'actor#2', ordinal: 1, name: 'b', instructions: 'y' })
  await pool.dispose()
  assert.equal(runtime.handles.every((handle) => handle.disposed === true), true)
  assert.deepEqual(pool.list(), [])
})

test('actor pool: the schema subset validator catches the shapes the compiler emits', () => {
  assert.deepEqual(validate({ a: 1 }, { type: 'object', properties: { a: { type: 'number' } } }), [])
  assert.equal(validate({ a: '1' }, { type: 'object', properties: { a: { type: 'number' } } }).length, 1)
  assert.equal(validate({}, { type: 'object', required: ['a'] })[0], 'result.a is required')
  assert.equal(validate([1, 'x'], { type: 'array', items: { type: 'number' } }).length, 1)
  assert.equal(validate('c', { enum: ['a', 'b'] }).length, 1)
  assert.equal(validate(2.5, { type: 'integer' }).length, 1)
  assert.equal(validate(2, { type: 'integer' }).length, 0)
  assert.equal(validate({ x: 1 }, { oneOf: [{ type: 'object', required: ['x'] }] }).length, 0)
})

test('actor pool: wrapSchema leaves an object schema alone', () => {
  const objectSchema = { type: 'object', properties: { a: { type: 'string' } } }
  const kept = wrapSchema(objectSchema)
  assert.equal(kept.wrapped, false)
  assert.equal(kept.schema, objectSchema)
  assert.deepEqual(kept.unwrap({ a: 'x' }), { a: 'x' })

  const wrapped = wrapSchema({ type: 'string' })
  assert.equal(wrapped.wrapped, true)
  assert.deepEqual(wrapped.schema.required, ['value'])
  assert.equal(wrapped.unwrap({ value: 'hi' }), 'hi')
})

test('actor pool: parseJsonReply prefers a fence, then the first brace pair', () => {
  assert.deepEqual(parseJsonReply('```json\n{"a":1}\n```'), { ok: true, value: { a: 1 } })
  assert.deepEqual(parseJsonReply('前缀 {"a":1} 后缀'), { ok: true, value: { a: 1 } })
  assert.equal(parseJsonReply('没有结构').ok, false)
  assert.equal(parseJsonReply(undefined).ok, false)
})


test('rehydrate: a rebuilt actor gets a NEW session and says which one it replaced', async () => {
  const runtime = fakeRuntime(() => 'ok')
  runtime.rejectResume = true
  const events = []
  const recorded = 'sess_dwf-run-1-actor_1_1'
  const pool = createActorPool({
    runId: 'run-1', cwd: '/w', runtime,
    resumeSessions: new Map([['actor#1@1', recorded]]),
    allowRehydrate: true,
    onEvent: (event) => events.push(event),
  })

  await pool.ask({ siteId: 'actor#1', ordinal: 1, name: '甲', instructions: '一' })

  const rehydrated = events.find((event) => event.type === 'actor-rehydrated')
  assert.ok(rehydrated !== undefined)
  // Reusing the dead id would mint a new session under an old identity, which
  // makes the journal claim a continuity that did not happen.
  assert.notEqual(rehydrated.sessionId, recorded)
  assert.equal(rehydrated.previousSessionId, recorded)
  assert.equal(runtime.created[0], rehydrated.sessionId)
  // The fresh id still ends in the actor's identity so it stays traceable.
  assert.match(rehydrated.sessionId, /^sess_dwf-run-1-actor_1_1/)
})
