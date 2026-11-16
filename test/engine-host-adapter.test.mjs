/**
 * Offline checks for the Host adapters.
 *
 * This is where the end-to-end run actually failed — a child created without a
 * model, and a failed turn downgraded into "no JSON" — so the behaviours are
 * pinned here with fakes instead of costing a model call each time.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'

import {
  createAgentRuntime,
  createChildProcess,
  resolveChildAgentOptions,
  usageTokensOf,
} from '../src/engine/host-adapter.mjs'

test('child options inherit the parent request, then its options', () => {
  // The committed request wins: it reflects a model switched mid-session.
  const switched = resolveChildAgentOptions({
    session: { requestHeader: () => ({ config: { provider: 'cpa', model: 'gpt-6.1-terra', reasoningEffort: 'high' } }) },
    options: { provider: 'stale', model: 'old-model', maxTokens: 4096, subagentDepth: 2 },
  })
  assert.equal(switched.provider, 'cpa')
  assert.equal(switched.model, 'gpt-6.1-terra')
  assert.equal(switched.reasoningEffort, 'high')
  assert.equal(switched.maxTokens, 4096, 'maxTokens is the parent option that still applies')
  assert.equal(switched.subagentDepth, 3, 'depth increments per generation')

  // No committed request: fall back to the parent's own options.
  const fallback = resolveChildAgentOptions({
    session: { requestHeader: () => undefined },
    options: { provider: 'p', model: 'm' },
  })
  assert.equal(fallback.provider, 'p')
  assert.equal(fallback.model, 'm')
  assert.equal(fallback.subagentDepth, 1)

  // Nothing anywhere: omit the fields rather than pass undefined through.
  const bare = resolveChildAgentOptions({})
  assert.equal('provider' in bare, false)
  assert.equal('model' in bare, false)
  assert.equal(bare.subagentDepth, 1)
})

/** A context that records listeners and lets a test fire them. */
function fakeCtx() {
  const listeners = new Map()
  return {
    listeners,
    on(event, handler) {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    emit(event, ...args) {
      listeners.get(event)?.(...args)
    },
  }
}

/** Build a runtime over fakes; `onIdle` runs inside `whenIdle`. */
function fixture({ onIdle, agentOptions, usageSink } = {}) {
  const ctx = fakeCtx()
  const sections = []
  const tools = []
  const directories = []
  const turns = []
  const disposed = []
  let child

  const agents = {
    async create(options) {
      const agent = {
        id: options.sessionId,
        followup(message) {
          turns.push(message)
        },
        whenIdle: async () => {
          if (onIdle !== undefined) onIdle(ctx, options.sessionId, turns.length)
        },
      }
      const agentCtx = {
        systemPrompt: { section: (section) => { sections.push(section); return () => {} } },
        tools: { register: (definition) => { tools.push(definition); return () => {} } },
        get: (name) => (name === 'workingDirectory'
          ? { set: async (agent2, path) => { directories.push(path) } }
          : undefined),
      }
      child = agent
      await options.setup?.(agentCtx, agent)
      return { agent, dispose: async () => { disposed.push(options.sessionId) } }
    },
  }

  const runtime = createAgentRuntime({
    ctx,
    agents,
    subagents: { sendMessage: async () => { throw new Error('sendMessage must not be used when followup exists') } },
    parentAgent: { id: 'parent-session' },
    cwd: '/work/project',
    agentOptions,
    usageSink,
  })
  return { ctx, runtime, sections, tools, directories, turns, disposed, get child() { return child } }
}

test('a failed turn surfaces as the real error, not an empty reply', async () => {
  const kit = fixture({
    onIdle: (ctx, sessionId) => {
      ctx.emit('session/event', { id: sessionId }, {
        type: 'turn/end',
        data: { reason: { kind: 'error', error: { message: 'has no provider/model' } } },
      })
    },
  })
  const handle = await kit.runtime.createActor({ sessionId: 'sess-1', name: '甲', persona: undefined })

  await assert.rejects(
    () => kit.runtime.sendTurn(handle, { text: '# Task\n你好' }),
    /has no provider\/model/,
  )
  kit.runtime.close()
})

test('an aborted turn is reported as aborted', async () => {
  const kit = fixture({
    onIdle: (ctx, sessionId) => {
      ctx.emit('session/event', { id: sessionId }, {
        type: 'turn/end',
        data: { reason: { kind: 'aborted', reason: { kind: 'user' } } },
      })
    },
  })
  const handle = await kit.runtime.createActor({ sessionId: 'sess-2', name: '乙' })
  await assert.rejects(() => kit.runtime.sendTurn(handle, { text: 'x' }), /aborted/)
  kit.runtime.close()
})

test('a stale turn error does not leak into the next turn', async () => {
  let fail = true
  const kit = fixture({
    onIdle: (ctx, sessionId) => {
      if (!fail) return
      ctx.emit('session/event', { id: sessionId }, {
        type: 'turn/end',
        data: { reason: { kind: 'error', error: { message: 'first turn broke' } } },
      })
    },
  })
  const handle = await kit.runtime.createActor({ sessionId: 'sess-3', name: '丙' })
  await assert.rejects(() => kit.runtime.sendTurn(handle, { text: 'one' }), /first turn broke/)
  fail = false
  await kit.runtime.sendTurn(handle, { text: 'two' })
  kit.runtime.close()
})

test('the persona becomes a prompt section with text and no interpolation', async () => {
  const kit = fixture()
  await kit.runtime.createActor({
    sessionId: 'sess-4',
    name: '审阅员',
    persona: { system: '你独立复核。保留 {{raw}} 字样。' },
  })
  assert.equal(kit.sections.length, 1)
  const section = kit.sections[0]
  assert.equal(section.name, 'zcode-actor-persona')
  // `text` is what the assembler reads; `content` was silently ignored before.
  assert.match(section.text, /独立复核/)
  assert.equal(section.content, undefined)
  assert.equal(section.interpolate, false, 'a persona containing {{...}} must not be templated')
  // The child is bound to the workflow's workspace.
  assert.deepEqual(kit.directories, ['/work/project'])
  kit.runtime.close()
})

test('the captured result is validated against the current schema', async () => {
  const kit = fixture()
  const handle = await kit.runtime.createActor({ sessionId: 'sess-5', name: '丁' })
  const definition = kit.tools.find((tool) => tool.name === 'structured_output')
  assert.ok(definition !== undefined)

  // No schema for this turn yet: the tool refuses.
  assert.match(definition.execute({ json: '{"score":1}' }).error.message, /does not expect/)

  await kit.runtime.sendTurn(handle, {
    text: '打分',
    schema: { type: 'object', properties: { score: { type: 'number' } }, required: ['score'] },
  })

  const bad = definition.execute({ json: '{"score":"高"}' })
  assert.match(bad.error.message, /does not match the schema/)
  assert.match(bad.error.message, /score/)

  const good = definition.execute({ json: '{"score":88}' })
  assert.deepEqual(good, { accepted: true })

  const reply = await kit.runtime.readReply({ sessionId: 'sess-5' })
  assert.deepEqual(reply, { structured: true, value: { score: 88 } })
  kit.runtime.close()
})

test('turns travel through followup, never through sendMessage', async () => {
  const kit = fixture()
  const handle = await kit.runtime.createActor({ sessionId: 'sess-6', name: '戊' })
  await kit.runtime.sendTurn(handle, { text: '# Task\n做点事' })
  assert.equal(kit.turns.length, 1)
  // The message is a real user message with an id, so the inbox accepts it.
  assert.equal(kit.turns[0].role, 'user')
  assert.equal(typeof kit.turns[0].id, 'string')
  assert.deepEqual(kit.turns[0].content, [{ type: 'text', text: '# Task\n做点事' }])
  kit.runtime.close()
})

test('usage: totalTokens wins, otherwise the four buckets are summed', () => {
  assert.equal(usageTokensOf({ usage: { totalTokens: 42, inputTokens: 1 } }), 42)
  assert.equal(usageTokensOf({ usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 } }), 17)
  assert.equal(usageTokensOf({ usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: 1, cacheWriteTokens: 2 } }), 10)
  assert.equal(usageTokensOf({ usage: {} }), 0)
  assert.equal(usageTokensOf({}), 0)
})

test('usage: every assistant message reports its delta to the sink', async () => {
  const reported = []
  const kit = fixture({ usageSink: (event) => reported.push(event) })
  const handle = await kit.runtime.createActor({ sessionId: 'sess-usage', name: '甲' })
  kit.ctx.emit('session/event', { id: 'sess-usage' }, {
    type: 'assistant/message',
    data: { message: { usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 3 } } },
  })
  kit.ctx.emit('session/event', { id: 'sess-usage' }, {
    type: 'assistant/message',
    data: { message: { usage: { totalTokens: 7 } } },
  })
  assert.deepEqual(reported, [
    { sessionId: 'sess-usage', tokens: 123 },
    { sessionId: 'sess-usage', tokens: 7 },
  ])
  kit.runtime.close()
  assert.ok(handle !== undefined)
})

test('createChildProcess: absorbs async EPIPE stream errors without crashing host', async () => {
  let writes = 0
  const stdin = new Writable({
    write(_chunk, _encoding, callback) {
      writes += 1
      callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    },
  })
  const stdout = new PassThrough()
  const child = createChildProcess({
    subprocess: {
      spawn: () => ({ stdin, stdout, done: new Promise(() => {}), terminate() {} }),
    },
    cwd: '/work/project',
  })

  // First write triggers an async EPIPE on the stream; our error listener must
  // handle it rather than letting EventEmitter throw an uncaughtException.
  child.send({ kind: 'ping' })
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(writes, 1)

  // Once the stream has errored, subsequent writes short-circuit cleanly.
  assert.equal(child.send({ kind: 'pong' }), false)
  assert.equal(writes, 1)

  stdout.emit('error', new Error('read reset'))
  stdout.destroy()
})

test('createChildProcess: skips writing after child exits or closes stdin', async () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  let finishDone
  const done = new Promise((resolve) => {
    finishDone = resolve
  })
  const child = createChildProcess({
    subprocess: {
      spawn: () => ({ stdin, stdout, done, terminate() {} }),
    },
    cwd: '/work/project',
  })

  assert.equal(child.send({ kind: 'start' }), true)
  stdin.destroy()
  finishDone({ exitCode: 0 })
  await new Promise((resolve) => setTimeout(resolve, 5))

  assert.equal(child.send({ kind: 'response', id: 'r1', ok: false }), false)
})
