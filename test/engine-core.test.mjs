/**
 * Offline checks for the engine core: the input hash, the journal, and the
 * sandbox child protocol. None of these need a Harness runtime.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { canonicalJson, fnv1a, inputHash, nodeInput } from '../src/engine/input-hash.mjs'
import { ARTIFACT_KIND, NODE_KIND, NODE_STATUS, openJournal, RUN_STATUS } from '../src/engine/journal.mjs'
import { decode, encode } from '../src/engine/protocol.mjs'

/**
 * The reference implementation transcribed from `docs/WORKFLOW-DESIGN.md` §8.B,
 * which was read out of the shipped ZCode bundle. Kept verbatim so the module
 * is checked against the origin's algorithm rather than against itself.
 */
const reference = {
  canonicalJson(value) {
    if (value === null || typeof value !== 'object') {
      const text = JSON.stringify(value)
      return text === undefined ? 'null' : text
    }
    if (Array.isArray(value)) return `[${value.map(reference.canonicalJson).join(',')}]`
    const parts = []
    for (const key of Object.keys(value).sort()) {
      const entry = value[key]
      if (entry !== undefined) parts.push(`${JSON.stringify(key)}:${reference.canonicalJson(entry)}`)
    }
    return `{${parts.join(',')}}`
  },
  fnv1a(text) {
    let hash = 2166136261
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index) & 255
      hash ^= (text.charCodeAt(index) >> 8) & 255
      hash = Math.imul(hash, 16777619)
    }
    return (hash >>> 0).toString(16).padStart(8, '0')
  },
  hash(value) {
    return reference.fnv1a(reference.canonicalJson(value))
  },
}

test('input hash: agrees with the documented origin algorithm', () => {
  const samples = [
    null,
    true,
    42,
    'plain',
    '中文与 emoji 🚀',
    { b: 2, a: 1 },
    { undef: undefined, kept: 1 },
    [1, undefined, 'x'],
    { op: 'files.read', args: ['/tmp/a.txt', null] },
    { nested: { z: [1, 2, { y: 'w' }], a: null } },
  ]
  for (const sample of samples) {
    assert.equal(inputHash(sample), reference.hash(sample), `hash mismatch for ${JSON.stringify(sample)}`)
  }
})

test('input hash: folds UTF-16 code units, not UTF-8 bytes', () => {
  // Hashing the UTF-8 encoding instead would produce a different digest; this
  // pins the code-unit behaviour the origin has.
  const text = '中文'
  assert.equal(fnv1a(text), reference.fnv1a(text))
  assert.notEqual(fnv1a(text), fnv1a(Buffer.from(text, 'utf8').toString('latin1')))
  assert.equal(fnv1a(text).length, 8)
  assert.match(fnv1a(text), /^[0-9a-f]{8}$/)
})

test('input hash: object keys sort and undefined values disappear', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }))
  assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}')
  // An array hole becomes the literal null, unlike an object key.
  assert.equal(canonicalJson([undefined]), '[null]')
  assert.equal(canonicalJson(undefined), 'null')
})

test('node input: world sites store input_json, others store NULL', () => {
  const world = nodeInput({
    kind: NODE_KIND.worldRun,
    payload: { op: 'run', args: ['python3', '-V'] },
  })
  assert.equal(world.hash, reference.hash({ op: 'run', args: ['python3', '-V'] }))
  assert.equal(typeof world.stored, 'string')
  assert.equal(world.truncated, false)

  const ask = nodeInput({ kind: NODE_KIND.ask, marker: { siteId: 'ask#1' } })
  assert.equal(ask.stored, null)

  const huge = nodeInput({
    kind: NODE_KIND.worldRead,
    payload: { op: 'files.read', args: ['x'.repeat(9000)] },
  })
  assert.equal(huge.truncated, true)
  assert.equal(huge.stored.length, 4096)
  // Truncation is storage-only: the hash still covers the whole input.
  assert.equal(huge.hash, reference.hash({ op: 'files.read', args: ['x'.repeat(9000)] }))
})

test('journal: a run keeps its script, args and status', async () => {
  const journal = openJournal()
  try {
    const run = journal.createRun({
      id: 'run-1',
      parentSessionId: 'sess-A',
      cwd: '/work/project',
      name: 'demo',
      scriptText: 'phase("一")',
      scriptHash: 'abc123',
      args: { topic: '测试' },
      capsMaxConcurrency: 13,
    })
    assert.equal(run.status, RUN_STATUS.pending)
    assert.equal(run.parentSessionId, 'sess-A')
    assert.deepEqual(run.args, { topic: '测试' })
    assert.equal(run.capsMaxConcurrency, 13)

    journal.settleRun('run-1', { status: RUN_STATUS.failed, failure: { message: 'boom' }, spentTokens: 7 })
    const settled = journal.getRun('run-1')
    assert.equal(settled.status, RUN_STATUS.failed)
    assert.deepEqual(settled.failure, { message: 'boom' })
    assert.equal(settled.spentTokens, 7)
  } finally {
    journal.close()
  }
})

test('journal: runs are isolated by session and by workspace', () => {
  const journal = openJournal()
  try {
    journal.createRun({ id: 'a', parentSessionId: 'sess-A', cwd: '/w1', name: 'a', capsMaxConcurrency: 1 })
    journal.createRun({ id: 'b', parentSessionId: 'sess-B', cwd: '/w1', name: 'b', capsMaxConcurrency: 1 })
    journal.createRun({ id: 'c', parentSessionId: 'sess-B', cwd: '/w2', name: 'c', capsMaxConcurrency: 1 })

    assert.deepEqual(journal.listRuns({ parentSessionId: 'sess-A' }).map((run) => run.id), ['a'])
    assert.deepEqual(journal.listRuns({ parentSessionId: 'sess-B' }).map((run) => run.id).sort(), ['b', 'c'])
    assert.deepEqual(journal.listRuns({ cwd: '/w1' }).map((run) => run.id).sort(), ['a', 'b'])
    // No scope means every run, which the caller must justify before using.
    assert.equal(journal.listRuns().length, 3)
  } finally {
    journal.close()
  }
})

test('journal: nodes upsert on (run_id, site_id, ordinal) and record the hash', () => {
  const journal = openJournal()
  try {
    journal.createRun({ id: 'run-1', parentSessionId: 'sess-A', cwd: '/w', name: 'n', capsMaxConcurrency: 4 })
    const started = journal.putNode({
      runId: 'run-1',
      siteId: 'ask#1',
      ordinal: 1,
      kind: NODE_KIND.ask,
      actorSiteId: 'actor#1',
      actorOrdinal: 1,
      actorSeq: 1,
      inputHash: 'deadbeef',
      status: NODE_STATUS.running,
    })
    assert.equal(started.status, NODE_STATUS.running)
    assert.equal(started.inputHash, 'deadbeef')

    const settled = journal.putNode({
      runId: 'run-1',
      siteId: 'ask#1',
      ordinal: 1,
      kind: NODE_KIND.ask,
      status: NODE_STATUS.completed,
      inputHash: 'deadbeef',
      result: { ok: true },
      stats: { durationMs: 12 },
    })
    assert.equal(settled.status, NODE_STATUS.completed)
    assert.deepEqual(settled.result, { ok: true })
    assert.equal(journal.listNodes('run-1').length, 1)
    assert.equal(journal.findNode('run-1', 'ask#1', 1).status, NODE_STATUS.completed)
  } finally {
    journal.close()
  }
})

test('journal: actors and artifacts round-trip, versions and primary survive', () => {
  const journal = openJournal()
  try {
    journal.createRun({ id: 'run-1', parentSessionId: 'sess-A', cwd: '/w', name: 'n', capsMaxConcurrency: 4 })
    const actor = journal.putActor({
      runId: 'run-1',
      siteId: 'actor#1',
      ordinal: 1,
      name: '审阅员',
      persona: { system: '独立审阅' },
      resolvedModel: 'provider/model',
      sessionId: 'sess_dwf-run-1-actor_1_1',
    })
    assert.equal(actor.name, '审阅员')
    assert.deepEqual(actor.persona, { system: '独立审阅' })
    assert.equal(actor.sessionId, 'sess_dwf-run-1-actor_1_1')

    journal.putArtifact({
      runId: 'run-1',
      artifactId: 'report',
      kind: ARTIFACT_KIND.markdown,
      title: '结论',
      contentType: 'text/markdown',
      body: '# 结论',
      version: 2,
      primary: true,
    })
    const published = journal.listArtifacts('run-1')
    assert.equal(published.length, 1)
    assert.equal(published[0].version, 2)
    assert.equal(published[0].primary, true)
    assert.equal(published[0].body, '# 结论')
  } finally {
    journal.close()
  }
})

test('journal: events number per run from zero and page by sequence', () => {
  const journal = openJournal()
  try {
    journal.createRun({ id: 'run-1', parentSessionId: 'sess-A', cwd: '/w', name: 'n', capsMaxConcurrency: 2 })
    assert.equal(journal.appendEvent('run-1', 'phase-entered', { title: '一' }), 0)
    assert.equal(journal.appendEvent('run-1', 'log', { message: 'hi' }), 1)
    assert.equal(journal.appendEvent('run-1', 'report', { item: { a: 1 } }), 2)

    const all = journal.listEvents('run-1')
    assert.deepEqual(all.map((event) => event.sequence), [0, 1, 2])
    assert.deepEqual(all[0].payload, { title: '一' })
    const tail = journal.listEvents('run-1', { afterSequence: 2 })
    assert.deepEqual(tail.map((event) => event.sequence), [2])
  } finally {
    journal.close()
  }
})

test('journal: persists to a file and reloads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-journal-'))
  const file = join(directory, 'nested', 'runs.db')
  try {
    const first = openJournal({ file })
    first.createRun({ id: 'run-1', parentSessionId: 'sess-A', cwd: '/w', name: 'n', capsMaxConcurrency: 2 })
    first.putArtifact({ runId: 'run-1', artifactId: 'r', kind: ARTIFACT_KIND.markdown, body: '#x' })
    first.close()

    const second = openJournal({ file })
    assert.equal(second.listRuns({ parentSessionId: 'sess-A' }).length, 1)
    assert.equal(second.listArtifacts('run-1')[0].body, '#x')
    second.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('protocol: one message per line, blank and broken lines are skipped', () => {
  const line = encode({ kind: 'event', message: 'a\nb' })
  assert.equal(line.endsWith('\n'), true)
  // The embedded newline is escaped, so exactly one real newline terminates the message.
  assert.equal(line.split('\n').length, 2)
  assert.equal(line.slice(0, -1).includes('\n'), false)
  assert.deepEqual(decode(line), { kind: 'event', message: 'a\nb' })
  assert.equal(decode('   '), undefined)
  assert.equal(decode('{not json'), undefined)
  assert.equal(decode('"a string"'), undefined)
})

/** Spawn the sandbox child and drive it like the parent will. */
function startChild() {
  const entry = fileURLToPath(new URL('../src/engine/child-entry.mjs', import.meta.url))
  const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'] })
  const messages = []
  const waiters = []
  const errors = []
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = decode(line)
    if (message === undefined) return
    messages.push(message)
    for (const waiter of waiters.splice(0)) waiter()
  })
  child.stderr.on('data', (chunk) => errors.push(String(chunk)))
  const next = async (predicate) => {
    for (;;) {
      const found = messages.find(predicate)
      if (found !== undefined) {
        messages.splice(messages.indexOf(found), 1)
        return found
      }
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting; saw ${JSON.stringify(messages)}`)), 5000)
        waiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }
  return {
    child,
    next,
    errors,
    send(message) {
      child.stdin.write(encode(message))
    },
    async stop() {
      child.kill()
      await new Promise((resolve) => child.once('exit', resolve))
    },
  }
}

test('child sandbox: runs lowered hooks, asks the parent and settles', async () => {
  const sandbox = startChild()
  try {
    sandbox.send({
      kind: 'start',
      args: { topic: '演示' },
      code: `
        __zcodePhase('阶段一')
        const reviewer = __zcodeCreateActor('审阅员', { system: '独立审阅' })
        const verdict = await __zcodeAsk('ask#1', reviewer, '请审阅')
        __zcodeLog('拿到 ' + verdict.score)
        __zcodeReport({ score: verdict.score }, 'board')
        const doc = await __zcodeArtifact('markdown', 'report', '# 结论')
        return { verdict, doc, topic: __zcodeArgs.topic }
      `,
    })

    const actor = await sandbox.next((message) => message.type === 'actor')
    assert.equal(actor.siteId, 'actor#1')
    assert.equal(actor.name, '审阅员')

    const ask = await sandbox.next((message) => message.type === 'ask')
    assert.equal(ask.siteId, 'ask#1')
    assert.equal(ask.actorSiteId, 'actor#1')
    assert.equal(ask.instructions, '请审阅')
    sandbox.send({ kind: 'response', id: ask.id, ok: true, value: { score: 80 } })

    const report = await sandbox.next((message) => message.type === 'report')
    assert.deepEqual(report.item, { score: 80 })
    assert.equal(report.artifactId, 'board')

    const artifact = await sandbox.next((message) => message.type === 'publish-artifact')
    assert.equal(artifact.op, 'markdown')
    assert.equal(artifact.artifactId, 'report')
    assert.equal(artifact.args[0], '# 结论')
    sandbox.send({ kind: 'response', id: artifact.id, ok: true, value: { id: 'report', version: 1 } })

    const complete = await sandbox.next((message) => message.kind === 'complete')
    assert.equal(complete.ok, true)
    assert.equal(complete.value.topic, '演示')
    assert.deepEqual(complete.value.verdict, { score: 80 })
    assert.deepEqual(complete.value.doc, { id: 'report', version: 1 })
  } finally {
    await sandbox.stop()
  }
})

test('child sandbox: preset artifacts are emitted synchronously, content ones await', async () => {
  // The facade returns void for chart/table/metrics/board: no await, no
  // rejection channel. They must therefore travel as ordered events, while
  // file/markdown stay requests the script can catch.
  const sandbox = startChild()
  try {
    sandbox.send({
      kind: 'start',
      code: `
        __zcodeArtifact('table', 'rows', { columns: [] })
        __zcodeArtifact('chart', 'trend', { x: 'day', y: 'score' })
        const returned = __zcodeArtifact('metrics', 'kpi', { metrics: [] })
        const doc = await __zcodeArtifact('markdown', 'report', '# 结论文本')
        return { returned: returned === undefined ? null : returned, doc }
      `,
    })

    const table = await sandbox.next((message) => message.type === 'declare-artifact')
    assert.equal(table.op, 'table')
    assert.equal(table.artifactId, 'rows')
    assert.deepEqual(table.spec, { columns: [] })

    const chart = await sandbox.next((message) => message.type === 'declare-artifact')
    assert.equal(chart.op, 'chart')

    const metrics = await sandbox.next((message) => message.type === 'declare-artifact')
    assert.equal(metrics.op, 'metrics')

    const request = await sandbox.next((message) => message.type === 'publish-artifact')
    assert.equal(request.op, 'markdown')
    sandbox.send({ kind: 'response', id: request.id, ok: true, value: { id: 'report', version: 1 } })

    const complete = await sandbox.next((message) => message.kind === 'complete')
    assert.equal(complete.ok, true)
    // A preset returns nothing at all, matching the void facade signature.
    assert.equal(complete.value.returned, null)
    assert.deepEqual(complete.value.doc, { id: 'report', version: 1 })
  } finally {
    await sandbox.stop()
  }
})

test('child sandbox: the clock and unseeded randomness are refused', async () => {
  const sandbox = startChild()
  try {
    sandbox.send({
      kind: 'start',
      code: `
        const results = {}
        try { Date.now() } catch (error) { results.now = error.message }
        try { new Date() } catch (error) { results.blank = error.message }
        try { Date() } catch (error) { results.call = error.message }
        try { Math.random() } catch (error) { results.random = error.message }
        results.fixed = new Date(0).toISOString()
        return results
      `,
    })
    const complete = await sandbox.next((message) => message.kind === 'complete')
    assert.equal(complete.ok, true)
    assert.match(complete.value.now, /Date\.now\(\) is unavailable/)
    assert.match(complete.value.blank, /new Date\(\) is unavailable/)
    assert.match(complete.value.call, /Date\(\) is unavailable/)
    assert.match(complete.value.random, /Math\.random\(\) is unavailable/)
    // A seeded date is still allowed: it is deterministic input, not a clock read.
    assert.equal(complete.value.fixed, '1970-01-01T00:00:00.000Z')
  } finally {
    await sandbox.stop()
  }
})

test('child sandbox: an ask the parent refuses rejects inside the script', async () => {
  const sandbox = startChild()
  try {
    sandbox.send({
      kind: 'start',
      code: `
        const actor = __zcodeCreateActor('审阅员')
        try { await __zcodeAsk('ask#1', actor, '请审阅') } catch (error) { return { message: error.message, code: error.code } }
        return { message: 'no error' }
      `,
    })
    const ask = await sandbox.next((message) => message.type === 'ask')
    sandbox.send({
      kind: 'response',
      id: ask.id,
      ok: false,
      error: { message: 'the subagent call was cancelled', code: 'cancelled' },
    })
    const complete = await sandbox.next((message) => message.kind === 'complete')
    assert.equal(complete.ok, true)
    assert.equal(complete.value.message, 'the subagent call was cancelled')
    assert.equal(complete.value.code, 'cancelled')
  } finally {
    await sandbox.stop()
  }
})

test('child sandbox: a throwing script reports a structured failure', async () => {
  const sandbox = startChild()
  try {
    sandbox.send({ kind: 'start', code: 'throw new Error("脚本炸了")' })
    const complete = await sandbox.next((message) => message.kind === 'complete')
    assert.equal(complete.ok, false)
    assert.equal(complete.error.message, '脚本炸了')
    assert.equal(complete.error.name, 'Error')
  } finally {
    await sandbox.stop()
  }
})

test('child sandbox: executes real compiler lowering end to end', async () => {
  // This is the seam most likely to drift: the compiler emits `__zcode*` calls
  // and the sandbox must provide exactly those. Compiling here means the test
  // breaks if either side renames a hook.
  const { compile } = await import('../src/compiler.mjs')
  const { createRequire } = await import('node:module')
  let ts
  for (const base of [import.meta.url, join(tmpdir(), 'noop/package.json')]) {
    try {
      ts = createRequire(base)('typescript')
      break
    } catch {
      // typescript may be absent in a bare checkout
    }
  }
  if (ts === undefined) {
    assert.ok(true, 'typescript is not installed; skipping the lowering integration case')
    return
  }

  const facade = await readFileOrThrow(new URL('../facade.d.ts', import.meta.url))
  const compiled = compile({
    body: `
      interface Verdict { approved: boolean; score: number }
      phase("复核")
      const reviewer = agent("审阅员", { system: "独立复核" })
      const verdict = await reviewer.ask<Verdict>("请审阅这段方案")
      log("得分 " + verdict.score)
      return verdict
    `,
    facade,
    ts,
  })
  assert.equal(compiled.ok, true, JSON.stringify(compiled.diagnostics))
  // The lowered text must not still mention the source-level hooks.
  assert.equal(/\bphase\(/.test(compiled.code), false)
  assert.match(compiled.code, /__zcodePhase/)
  assert.match(compiled.code, /__zcodeAsk/)

  const sandbox = startChild()
  try {
    sandbox.send({ kind: 'start', args: {}, code: compiled.code })
    const ask = await sandbox.next((message) => message.type === 'ask')
    assert.equal(ask.instructions, '请审阅这段方案')
    sandbox.send({ kind: 'response', id: ask.id, ok: true, value: { approved: true, score: 91 } })
    const complete = await sandbox.next((message) => message.kind === 'complete')
    assert.equal(complete.ok, true, JSON.stringify(complete.error))
    assert.deepEqual(complete.value, { approved: true, score: 91 })
  } finally {
    await sandbox.stop()
  }
})

async function readFileOrThrow(url) {
  const { readFile } = await import('node:fs/promises')
  return readFile(url, 'utf8')
}
