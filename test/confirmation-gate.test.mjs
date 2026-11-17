/**
 * Pre-execution confirmation gate checks for `@local/dsh-workflow-zcode`:
 * journal session policy persistence, all four prompt outcomes (allow once,
 * allow session, reject/skip/cancel, custom revision feedback), resume gating,
 * HTTP session-policy route, and sidebar revoke pill.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { openJournal } from '../src/engine/journal.mjs'
import { apply, CONFIRM_OPTIONS, registerRunRoutes, renderEnvelope } from '../index.mjs'

function resolveTypeScript() {
  for (const base of [import.meta.url, join(homedir(), '.dsh/profiles/desktop/package.json')]) {
    try {
      return createRequire(base)('typescript')
    } catch {
      // try the next root
    }
  }
  return undefined
}

const needsTs = resolveTypeScript() === undefined
  ? { skip: 'typescript is not installed for this checkout' }
  : undefined

const SIMPLE_SCRIPT = `
phase('收集')
const worker = agent('analyst', { system: 'analyse carefully' })
return await worker.ask<string>('ping')
`.trim()

function makeHarness({ journalFile, ask, confirmExecution } = {}) {
  const registeredTools = []
  const routes = new Map()
  let spawnCalls = 0
  let actorCreates = 0

  const ctx = {
    tools: {
      register(definition) {
        registeredTools.push(definition)
        return () => {}
      },
    },
    on: () => () => {},
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject(deps, cb) {
      if (Array.isArray(deps) && deps.includes('connection')) cb(ctx)
      return () => {}
    },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route)
          return () => {}
        },
      },
    },
    subprocess: {
      spawn() {
        spawnCalls += 1
        throw new Error('__sandbox_seam__')
      },
    },
    subagents: {
      create() {
        actorCreates += 1
        return {}
      },
    },
    ...(ask === undefined ? {} : { userQuestions: { ask } }),
    get(name) {
      if (name === 'connection') return ctx.connection
      if (name === 'subprocess') return ctx.subprocess
      if (name === 'subagents') return ctx.subagents
      if (name === 'userQuestions') return ctx.userQuestions
      return undefined
    },
  }

  apply(ctx, {
    journalFile,
    ...(confirmExecution === undefined ? {} : { confirmExecution }),
  })

  return {
    ctx,
    routes,
    runTool: registeredTools.find((t) => t.name === 'run_zcode_workflow'),
    resumeTool: registeredTools.find((t) => t.name === 'resume_zcode_workflow'),
    counts: () => ({ spawnCalls, actorCreates }),
  }
}

test('journal: dwf_session_policy persists across reopen and stays safe after close', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-policy-journal-'))
  const file = join(directory, 'runs.db')
  try {
    const first = openJournal({ file })
    assert.equal(first.isSessionAutoApproved('sess-1'), false)
    assert.equal(first.isSessionAutoApproved(''), false)
    assert.equal(first.isSessionAutoApproved(undefined), false)

    assert.equal(first.setSessionAutoApprove('sess-1', true), true)
    assert.equal(first.isSessionAutoApproved('sess-1'), true)
    assert.equal(first.isSessionAutoApproved('sess-2'), false)
    first.close()

    // Reading or mutating after close never throws `statement has been finalized`.
    assert.equal(first.isSessionAutoApproved('sess-1'), false)
    assert.doesNotThrow(() => first.setSessionAutoApprove('sess-1', false))

    const second = openJournal({ file })
    assert.equal(second.isSessionAutoApproved('sess-1'), true)
    assert.equal(second.isSessionAutoApproved('sess-2'), false)
    assert.equal(second.setSessionAutoApprove('sess-1', false), false)
    assert.equal(second.isSessionAutoApproved('sess-1'), false)
    second.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('confirm gate: dry_run, compile error, and bad subagent_model never prompt userQuestions', needsTs, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-confirm-precheck-'))
  const file = join(directory, 'runs.db')
  try {
    let askCount = 0
    const harness = makeHarness({
      journalFile: file,
      ask: async () => {
        askCount += 1
        return { answers: [] }
      },
    })
    const exec = { agent: { id: 'sess-precheck' } }

    const dry = await harness.runTool.execute({ name: 'demo', script: SIMPLE_SCRIPT, dry_run: true }, exec)
    assert.equal(dry.dryRun, true)
    assert.equal(dry.ok, true)

    const compileFail = await harness.runTool.execute({ name: 'bad', script: 'const x: number = "oops"; return x' }, exec)
    assert.match(compileFail.error.message, /did not compile/)

    const modelFail = await harness.runTool.execute({ name: 'badmodel', script: SIMPLE_SCRIPT, subagent_model: 'not-a-pair' }, exec)
    assert.match(modelFail.error.message, /provider\/model/)

    assert.equal(askCount, 0)
    assert.equal(harness.counts().spawnCalls, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('confirm gate: prompt sends workflow details, 3 choices, caller agent & signal, and handles safe code fences', needsTs, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-confirm-prompt-'))
  const file = join(directory, 'runs.db')
  try {
    const requests = []
    const harness = makeHarness({
      journalFile: file,
      ask: async (request) => {
        requests.push(request)
        return { answers: [{ id: 'workflow_execution_confirm', selected: [CONFIRM_OPTIONS.reject] }] }
      },
    })
    const ac = new AbortController()
    const agent = { id: 'sess-prompt' }
    const scriptWithFence = `${SIMPLE_SCRIPT}\n// note: example \`\`\`json fence inside source`

    const result = await harness.runTool.execute({
      name: 'ep01-pipeline',
      script: scriptWithFence,
      max_concurrency: 6,
      subagent_model: 'openai/gpt-5',
      args: { ep: 'ep01' },
    }, { agent, signal: ac.signal })

    assert.equal(requests.length, 1)
    assert.equal(requests[0].agent, agent)
    assert.equal(requests[0].signal, ac.signal)
    assert.equal(requests[0].questions.length, 1)

    const q = requests[0].questions[0]
    assert.equal(q.id, 'workflow_execution_confirm')
    assert.equal(q.multiSelect, false)
    assert.deepEqual(
      q.options.map((o) => o.label),
      [CONFIRM_OPTIONS.once, CONFIRM_OPTIONS.session, CONFIRM_OPTIONS.reject],
    )
    assert.match(q.detail, /ep01-pipeline/)
    assert.match(q.detail, /最大并发 `6`/)
    assert.match(q.detail, /openai\/gpt-5/)
    assert.match(q.detail, /收集/)
    assert.match(q.detail, /analyst/)
    assert.match(q.detail, /~~~~ts/)

    assert.equal(result.executed, false)
    assert.equal(result.confirmation?.decision, 'rejected')
    assert.equal(harness.counts().spawnCalls, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('confirm gate: option 1 allows once and prompts again on the next call', needsTs, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-confirm-once-'))
  const file = join(directory, 'runs.db')
  try {
    let askCount = 0
    const harness = makeHarness({
      journalFile: file,
      ask: async () => {
        askCount += 1
        return { answers: [{ id: 'workflow_execution_confirm', selected: [CONFIRM_OPTIONS.once] }] }
      },
    })
    const exec = { agent: { id: 'sess-once' } }

    const first = await harness.runTool.execute({ name: 'once-wf', script: SIMPLE_SCRIPT }, exec)
    const second = await harness.runTool.execute({ name: 'once-wf', script: SIMPLE_SCRIPT }, exec)

    assert.equal(askCount, 2)
    assert.equal(harness.counts().spawnCalls, 2)
    assert.match(first.error.message, /the workflow sandbox could not start: __sandbox_seam__/)
    assert.match(second.error.message, /the workflow sandbox could not start: __sandbox_seam__/)

    const inspect = openJournal({ file })
    try {
      assert.equal(inspect.isSessionAutoApproved('sess-once'), false)
      assert.equal(inspect.listRuns({ parentSessionId: 'sess-once' }).length, 2)
    } finally {
      inspect.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('confirm gate: option 2 approves session permanently (persisted across reload) without affecting other sessions', needsTs, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-confirm-session-'))
  const file = join(directory, 'runs.db')
  try {
    let askCount = 0
    const seenSessions = []
    const harnessA = makeHarness({
      journalFile: file,
      ask: async (req) => {
        askCount += 1
        seenSessions.push(req.agent.id)
        return { answers: [{ id: 'workflow_execution_confirm', selected: [CONFIRM_OPTIONS.session] }] }
      },
    })

    const sessA = { agent: { id: 'sess-a' } }
    const sessB = { agent: { id: 'sess-b' } }

    // 1st run in sess-a prompts and grants session auto-approve.
    const r1 = await harnessA.runTool.execute({ name: 'w1', script: SIMPLE_SCRIPT }, sessA)
    assert.match(r1.error.message, /__sandbox_seam__/)
    assert.equal(askCount, 1)
    assert.equal(harnessA.counts().spawnCalls, 1)

    // 2nd run in sess-a skips prompt!
    const r2 = await harnessA.runTool.execute({ name: 'w2', script: SIMPLE_SCRIPT }, sessA)
    assert.match(r2.error.message, /__sandbox_seam__/)
    assert.equal(askCount, 1)
    assert.equal(harnessA.counts().spawnCalls, 2)

    // A fresh host/plugin reload still remembers sess-a's approval, while sess-b prompts.
    const harnessReloaded = makeHarness({
      journalFile: file,
      ask: async (req) => {
        askCount += 1
        seenSessions.push(req.agent.id)
        return { answers: [{ id: 'workflow_execution_confirm', selected: [CONFIRM_OPTIONS.once] }] }
      },
    })

    await harnessReloaded.runTool.execute({ name: 'w3', script: SIMPLE_SCRIPT }, sessA)
    assert.equal(askCount, 1, 'sess-a must stay auto-approved after reload')
    assert.equal(harnessReloaded.counts().spawnCalls, 1)

    await harnessReloaded.runTool.execute({ name: 'w4', script: SIMPLE_SCRIPT }, sessB)
    assert.equal(askCount, 2, 'sess-b must still require confirmation')
    assert.deepEqual(seenSessions, ['sess-a', 'sess-b'])

    // Plugin-level `confirmExecution: "never"` bypasses prompting even for fresh sessions.
    const neverHarness = makeHarness({
      journalFile: file,
      confirmExecution: 'never',
      ask: async () => {
        throw new Error('must not ask when confirmExecution === "never"')
      },
    })
    const rNever = await neverHarness.runTool.execute({ name: 'w5', script: SIMPLE_SCRIPT }, { agent: { id: 'sess-c' } })
    assert.match(rNever.error.message, /__sandbox_seam__/)
    assert.equal(neverHarness.counts().spawnCalls, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('confirm gate: reject, skip, cancel, abort, and unavailable errors create zero runs and fail closed', needsTs, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-confirm-decline-'))
  const file = join(directory, 'runs.db')
  try {
    const cases = [
      {
        label: 'rejected',
        ask: async () => ({ answers: [{ id: 'workflow_execution_confirm', selected: [CONFIRM_OPTIONS.reject] }] }),
        check(res) {
          assert.equal(res.executed, false)
          assert.equal(res.confirmation.decision, 'rejected')
          assert.match(renderEnvelope(res), /NOT executed/)
          assert.match(renderEnvelope(res), /do not retry automatically/)
        },
      },
      {
        label: 'skipped',
        ask: async () => ({ answers: [{ id: 'workflow_execution_confirm', selected: [] }] }),
        check(res) {
          assert.equal(res.executed, false)
          assert.equal(res.confirmation.decision, 'skipped')
        },
      },
      {
        label: 'cancelled',
        ask: async () => {
          const err = new Error('closed by user')
          err.code = 'ASK_CANCELLED'
          throw err
        },
        check(res) {
          assert.equal(res.executed, false)
          assert.equal(res.confirmation.decision, 'cancelled')
        },
      },
      {
        label: 'aborted',
        ask: async () => {
          const err = new Error('turn aborted')
          err.code = 'ASK_ABORTED'
          throw err
        },
        check(res) {
          assert.equal(res.executed, false)
          assert.equal(res.confirmation.decision, 'aborted')
        },
      },
      {
        label: 'delegated caller fails closed',
        ask: async () => {
          const err = new Error('delegated')
          err.code = 'DELEGATED_CALLER'
          throw err
        },
        check(res) {
          assert.equal(res.executed, false)
          assert.equal(res.error?.code, 'confirmation_unavailable')
        },
      },
    ]

    for (const entry of cases) {
      const harness = makeHarness({ journalFile: file, ask: entry.ask })
      const res = await harness.runTool.execute({ name: `wf-${entry.label}`, script: SIMPLE_SCRIPT }, { agent: { id: 'sess-decl' } })
      entry.check(res)
      assert.equal(res.runId, undefined, `${entry.label} must not allocate or return a runId`)
      assert.equal(harness.counts().spawnCalls, 0)
      assert.equal(harness.counts().actorCreates, 0)
    }

    const inspect = openJournal({ file })
    try {
      assert.equal(inspect.listRuns({ limit: 50 }).length, 0)
    } finally {
      inspect.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('confirm gate: option 4 custom revision input returns revise decision with feedback and zero side effects', needsTs, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-confirm-revise-'))
  const file = join(directory, 'runs.db')
  try {
    const feedback = '请先只跑第 1 个分镜，不要调用 write_screenplay，并把并发降到 4'
    const harness = makeHarness({
      journalFile: file,
      ask: async () => ({
        answers: [{
          id: 'workflow_execution_confirm',
          selected: [CONFIRM_OPTIONS.once],
          custom: `  ${feedback}  `,
        }],
      }),
    })

    const res = await harness.runTool.execute({ name: 'storyboard-wf', script: SIMPLE_SCRIPT }, { agent: { id: 'sess-rev' } })
    assert.equal(res.executed, false)
    assert.equal(res.runId, undefined)
    assert.deepEqual(res.confirmation, { decision: 'revise', feedback })
    assert.equal(harness.counts().spawnCalls, 0)

    const text = renderEnvelope(res)
    assert.match(text, /NOT executed — user requested modifications/)
    assert.match(text, new RegExp(feedback))
    assert.match(text, /modify the workflow script/)

    const inspect = openJournal({ file })
    try {
      assert.equal(inspect.listRuns({ limit: 50 }).length, 0)
    } finally {
      inspect.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('confirm gate: resume_zcode_workflow confirms before mutating journal and respects session auto-approve', needsTs, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-confirm-resume-'))
  const file = join(directory, 'runs.db')
  try {
    const ts = resolveTypeScript()
    const { compile } = await import('../src/compiler.mjs')
    const { createHash } = await import('node:crypto')
    const facadeText = await readFile(new URL('../facade.d.ts', import.meta.url), 'utf8')
    const compiled = compile({ body: SIMPLE_SCRIPT, facade: facadeText, ts, bodyLineOffset: 0 })
    assert.equal(compiled.ok, true)
    const hash = createHash('sha256').update(compiled.code, 'utf8').digest('hex')

    const seed = openJournal({ file })
    seed.createRun({
      id: 'run-resumable',
      parentSessionId: 'sess-res',
      cwd: directory,
      name: 'res-wf',
      scriptText: compiled.code,
      scriptHash: hash,
      plan: {
        source: SIMPLE_SCRIPT,
        phases: compiled.phases,
        actors: compiled.actors,
        maxConcurrency: 5,
        subagentModel: { mode: 'session', label: '会话模型' },
      },
      args: {},
      capsMaxConcurrency: 5,
    })
    seed.settleRun('run-resumable', { status: 'failed', failure: { message: 'boom' } })
    seed.close()

    // 1. Declining with revision feedback must NOT alter caps, plan, events, or status.
    const reviseHarness = makeHarness({
      journalFile: file,
      ask: async () => ({ answers: [{ id: 'workflow_execution_confirm', selected: [], custom: '改成串行执行' }] }),
    })
    const declined = await reviseHarness.resumeTool.execute(
      { run_id: 'run-resumable', max_concurrency: 12 },
      { agent: { id: 'sess-res' } },
    )
    assert.equal(declined.executed, false)
    assert.equal(declined.runId, 'run-resumable')
    assert.equal(declined.confirmation?.decision, 'revise')
    assert.equal(reviseHarness.counts().spawnCalls, 0)

    const checkMid = openJournal({ file })
    const rowMid = checkMid.getRun('run-resumable')
    assert.equal(rowMid.status, 'failed')
    assert.equal(rowMid.capsMaxConcurrency, 5)
    assert.equal(rowMid.resumeCount, 0)
    assert.equal(checkMid.listEvents('run-resumable').length, 0)
    checkMid.close()

    // 2. Approving session-wide updates plan/caps, marks resumed, and skips prompt next time.
    let resumeAskCount = 0
    const allowHarness = makeHarness({
      journalFile: file,
      ask: async () => {
        resumeAskCount += 1
        return { answers: [{ id: 'workflow_execution_confirm', selected: [CONFIRM_OPTIONS.session] }] }
      },
    })
    const started = await allowHarness.resumeTool.execute(
      { run_id: 'run-resumable', max_concurrency: 8 },
      { agent: { id: 'sess-res' } },
    )
    assert.equal(resumeAskCount, 1)
    assert.equal(allowHarness.counts().spawnCalls, 1)
    assert.match(started.error.message, /__sandbox_seam__/)

    // A second run in the same session now skips confirmation too.
    const followUp = await allowHarness.runTool.execute(
      { name: 'post-resume', script: SIMPLE_SCRIPT },
      { agent: { id: 'sess-res' } },
    )
    assert.equal(resumeAskCount, 1, 'session auto-approve set during resume applies to subsequent runs')
    assert.equal(allowHarness.counts().spawnCalls, 2)
    assert.match(followUp.error.message, /__sandbox_seam__/)

    const checkAfter = openJournal({ file })
    assert.equal(checkAfter.isSessionAutoApproved('sess-res'), true)
    assert.equal(checkAfter.getRun('run-resumable').capsMaxConcurrency, 8)
    assert.equal(checkAfter.getRun('run-resumable').resumeCount, 1)
    checkAfter.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('session-policy route and client revoke pill integrate cleanly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-confirm-route-'))
  const file = join(directory, 'runs.db')
  try {
    const journal = openJournal({ file })
    const routes = new Map()
    const ctx = {
      inject(deps, cb) {
        if (Array.isArray(deps) && deps.includes('connection')) cb(ctx)
        return () => {}
      },
      effect(fn) {
        const dispose = fn()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      connection: {
        fetch: {
          register(route) {
            routes.set(route.path, route)
            return () => {}
          },
        },
      },
      get: (name) => (name === 'connection' ? ctx.connection : undefined),
    }

    registerRunRoutes(ctx, { listRuns: async () => ({ runs: [] }) }, {
      sessionPolicy: {
        get: (sessionId) => journal.isSessionAutoApproved(sessionId),
        set: (sessionId, enabled) => journal.setSessionAutoApprove(sessionId, enabled),
      },
    })

    const policyRoute = routes.get('/api/dsh-workflow-zcode/session-policy')
    assert.ok(policyRoute !== undefined)

    const call = async (body) => {
      const res = await policyRoute.fetch({ json: async () => body })
      return res.json()
    }

    const bad = await call({})
    assert.equal(bad.ok, false)
    assert.equal(bad.error.code, 'bad-request')

    assert.deepEqual(await call({ sessionId: 'sess-ui' }), { ok: true, value: { sessionId: 'sess-ui', autoApprove: false } })
    journal.setSessionAutoApprove('sess-ui', true)
    assert.deepEqual(await call({ sessionId: 'sess-ui' }), { ok: true, value: { sessionId: 'sess-ui', autoApprove: true } })

    // Now test the real client.js WorkflowPage state & revoke pill via a minimal stateful React stub.
    const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
    const stateSlots = []
    let cursor = 0
    const effects = []
    let loaded
    const react = {
      createElement(type, props, ...children) {
        return { type, props: props ?? {}, children: children.flat() }
      },
      useState(initial) {
        const index = cursor
        cursor += 1
        if (!(index in stateSlots)) stateSlots[index] = initial
        return [
          stateSlots[index],
          (next) => {
            stateSlots[index] = typeof next === 'function' ? next(stateSlots[index]) : next
          },
        ]
      },
      useEffect(fn) {
        effects.push(fn)
      },
      useCallback(fn) {
        return fn
      },
    }
    const fetchStub = async (url, init) => {
      if (url === 'api/dsh-workflow-zcode/runs') {
        return { json: async () => ({ ok: true, value: { runs: [] } }) }
      }
      if (url === 'api/dsh-workflow-zcode/session-policy') {
        const payload = await call(JSON.parse(init?.body ?? '{}'))
        return { json: async () => payload }
      }
      throw new Error(`unexpected url ${url}`)
    }
    const prevWindow = globalThis.window
    globalThis.window = { __ModuleLoader__: { load({ factory }) { loaded = factory(() => react) } } }
    try {
      new Function('window', 'fetch', clientSource)(globalThis.window, fetchStub)
    } finally {
      globalThis.window = prevWindow
    }

    const renderPage = () => {
      cursor = 0
      effects.length = 0
      return loaded.__internals.WorkflowPage({ sessionId: 'sess-ui', ctx: { get: () => undefined } })
    }

    // 1st render schedules loadRuns -> triggers loadSessionPolicy -> sets autoApprove = true.
    renderPage()
    for (const effectFn of effects) await effectFn()
    await new Promise((r) => setTimeout(r, 10))

    // Re-render and locate revoke pill.
    const treeWithPill = renderPage()
    const findPill = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return undefined
      if (Array.isArray(node)) {
        for (const item of node) {
          const hit = findPill(item)
          if (hit !== undefined) return hit
        }
        return undefined
      }
      if (node?.props?.['data-testid'] === 'session-auto-approve-pill') return node
      return findPill(node.children ?? node.props?.children)
    }

    const pill = findPill(treeWithPill)
    assert.ok(pill !== undefined, 'session-auto-approve-pill must appear when autoApprove is true')

    // Click the pill to revoke session auto-approve.
    await pill.props.onClick()
    assert.equal(journal.isSessionAutoApproved('sess-ui'), false)

    const treeAfterRevoke = renderPage()
    assert.equal(findPill(treeAfterRevoke), undefined, 'pill disappears once revoked')

    journal.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
