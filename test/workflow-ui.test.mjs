/**
 * The workflow panel's visual contract, without a browser.
 *
 * These tests render the real Client components into a plain element tree and
 * assert on what a reader would see: which stations are visible, which phase is
 * folded, which role pills exist, what an artifact tile previews. They also
 * cover the `/cancel` route, because a stop button that talks to a missing
 * handler is worse than no button.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { registerRunRoutes } from '../index.mjs'

const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')

/** Load client.js with a minimal React stub, returning its exports. */
function loadClient({ openInitial = false } = {}) {
  let loaded
  const react = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat() }
    },
    useState: (initial) => [initial === false ? openInitial : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  }
  const window = { __ModuleLoader__: { load({ factory }) { loaded = factory(() => react) } } }
  const previous = globalThis.window
  globalThis.window = window
  try {
    new Function('window', 'fetch', clientSource)(window, async () => ({ json: async () => ({ ok: true, value: { runs: [] } }) }))
  } finally {
    globalThis.window = previous
  }
  return loaded
}

/** Walk an element tree, invoking function components. */
function walk(node, visit) {
  if (node === null || node === undefined || node === false) return
  if (Array.isArray(node)) {
    for (const entry of node) walk(entry, visit)
    return
  }
  if (typeof node === 'function') {
    walk(node({}), visit)
    return
  }
  if (typeof node === 'object') {
    visit(node)
    if (typeof node.type === 'function') {
      walk(node.type(node.props ?? {}), visit)
      return
    }
    walk(node.children ?? node.props?.children, visit)
  }
}

function textOf(node) {
  let out = ''
  walk(node, (element) => {
    const children = element.children ?? element.props?.children
    const list = Array.isArray(children) ? children : [children]
    for (const child of list) {
      if (typeof child === 'string' || typeof child === 'number') out += `${child} `
    }
  })
  return out
}

function byTestId(node, id) {
  const found = []
  walk(node, (element) => {
    if (element.props?.['data-testid'] === id) found.push(element)
  })
  return found
}

const NODE_A = {
  siteId: 'ask#1', ordinal: 1, kind: 'ask', roleKey: 'actor#1', state: 'settled',
  typed: true, instructions: '请调研洪水信号', result: '{"n":1}', durationMs: 1200,
}

function phase(overrides) {
  return {
    id: 'P0', ordinal: 1, title: '调研', status: 'completed',
    settledCount: 1, observedCount: 1, totalCount: 1, rounds: 1,
    roles: [], nodes: [], ...overrides,
  }
}

const ROLE_A = { key: 'actor#1', kind: 'actor', siteId: 'actor#1', name: '调研员', total: 1, settled: 1, failed: 0, running: 0, state: 'completed' }

test('station diagram: a pending phase is still a station; completed folds, running opens', () => {
  const client = loadClient()
  const phases = [
    phase({ id: 'P0', title: '调研', status: 'completed', roles: [ROLE_A], nodes: [NODE_A] }),
    phase({
      id: 'P1', title: '施工', status: 'running', settledCount: 1, observedCount: 3,
      roles: [{ key: 'actor#2', kind: 'actor', siteId: 'actor#2', name: '工程师', total: 3, settled: 1, failed: 0, running: 2, state: 'running' }],
      nodes: [{ ...NODE_A, siteId: 'ask#2', roleKey: 'actor#2' }],
    }),
    phase({ id: 'P2', title: '验收', status: 'pending', settledCount: 0, observedCount: 0, roles: [] }),
  ]
  const tree = client.__internals.PhaseTimeline({ phases })
  const text = textOf(tree)
  // All three stations are visible, including the one that has not started.
  assert.match(text, /调研/)
  assert.match(text, /施工/)
  assert.match(text, /验收/)
  assert.match(text, /1\/3/)
  // The completed phase is folded: its role pill is not rendered yet.
  assert.equal(text.includes('调研员'), false)
  // The running phase is open: its role pill is visible.
  assert.match(text, /工程师/)

  const toggles = byTestId(tree, 'phase-toggle')
  assert.equal(toggles.length, 3)
  assert.equal(toggles[0].props['aria-expanded'], false)
  assert.equal(toggles[1].props['aria-expanded'], true)
  // The lamp state is machine-readable, which is what the CSS keys off.
  assert.equal(toggles[0].props['data-phase-status'], 'completed')
})

test('station diagram: a single completed phase opens, but only shows role pills', () => {
  const client = loadClient()
  const tree = client.__internals.PhaseTimeline({
    phases: [phase({ roles: [ROLE_A], nodes: [NODE_A] })],
  })
  assert.equal(byTestId(tree, 'phase-toggle')[0].props['aria-expanded'], true)
  const text = textOf(tree)
  // The role pill is visible; the raw prompt is not — drilling in is a second click.
  assert.match(text, /调研员/)
  assert.equal(text.includes('请调研洪水信号'), false)
})

test('station diagram: the avatar cluster caps at three and reports the rest', () => {
  const client = loadClient()
  const roles = ['甲', '乙', '丙', '丁', '戊'].map((name, index) => ({
    key: `actor#${index}`, kind: 'actor', siteId: `actor#${index}`, name,
    total: 1, settled: 1, failed: 0, running: 0, state: 'completed',
  }))
  const tree = client.__internals.AvatarCluster({ roles })
  assert.match(textOf(tree), /\+2/)
  const svgs = []
  walk(tree, (element) => { if (element.type === 'svg') svgs.push(element) })
  // Three robots + three check badges.
  assert.equal(svgs.length, 6)
})

test('station diagram: drilling into an actor shows the node input, result and structured badge', () => {
  const client = loadClient()
  const tree = client.__internals.RolePill({
    phase: { id: 'P0', nodes: [NODE_A] },
    role: ROLE_A,
    open: true,
    onToggle: () => {},
  })
  const text = textOf(tree)
  assert.match(text, /ask#1/)
  assert.match(text, /结构化/)
  assert.match(text, /请调研洪水信号/)
  assert.match(text, /复制/)
})

test('station diagram: the default open rule follows run state, not a constant', () => {
  const client = loadClient()
  const { defaultPhaseOpen } = client.__internals
  assert.equal(defaultPhaseOpen({ status: 'running' }, false), true)
  assert.equal(defaultPhaseOpen({ status: 'failed' }, false), true)
  assert.equal(defaultPhaseOpen({ status: 'completed' }, false), false)
  assert.equal(defaultPhaseOpen({ status: 'completed' }, true), true)
  assert.equal(defaultPhaseOpen({ status: 'pending' }, true), false)
})

test('artifacts: a metrics tile previews its report chips', () => {
  const client = loadClient()
  const artifact = {
    id: 'kpi', kind: 'metrics', title: 'S4 施工进度', version: 2, primary: true,
    reports: [
      { item: { label: '校验中', value: 0 } },
      { item: { label: '施工中', value: 1 } },
      { item: { label: '通过', value: 1 } },
    ],
  }
  const text = textOf(client.__internals.ArtifactTile({ artifact, active: false, onOpen: () => {} }))
  assert.match(text, /校验中/)
  assert.match(text, /施工中/)
  assert.match(text, /S4 施工进度/)
  // The primary badge is on the tile.
  assert.match(text, /主产物/)
})

test('artifacts: a tile with no data shows the dashed empty state', () => {
  const client = loadClient()
  const artifact = { id: 'rule-bot', kind: 'board', title: '规则 Bot 验证', itemCount: 0, version: 1, reports: [] }
  assert.equal(client.__internals.EMPTY_ARTIFACT(artifact), true)
  const text = textOf(client.__internals.ArtifactTile({ artifact, active: false, onOpen: () => {} }))
  assert.match(text, /暂无数据/)
})

test('artifacts: markdown and file tiles excerpt their body or path', () => {
  const client = loadClient()
  const md = textOf(client.__internals.ArtifactTile({
    artifact: { id: 'report', kind: 'markdown', title: '复核结论', version: 1, body: '# 复核结论\n\n- 3 个用例通过' },
    active: false, onOpen: () => {},
  }))
  assert.match(md, /3 个用例通过/)
  const file = textOf(client.__internals.ArtifactCard({
    artifact: { id: 'log', kind: 'file', version: 1, sourcePath: 'out/pytest.txt', itemCount: 2048 },
  }))
  assert.match(file, /out\/pytest\.txt/)
  assert.match(file, /v1/)
})

test('header: a running run offers stop, a finished one does not; the summary is compact', () => {
  const client = loadClient()
  const base = {
    runId: 'r1', workflowId: 'S4修复：洪水重构', status: 'running', durationMs: 65_000,
    maxConcurrency: 20, resumeCount: 2, resumedFrom: 'dwfrun-parent', spentTokens: 94_267_841,
    resolvedModel: 'GLM-5.3-Flash', settledSteps: 8, totalSteps: 9, artifactCount: 2,
    actors: [{ siteId: 'actor#1' }], phases: [{ roles: [{ kind: 'actor', state: 'running' }] }],
  }
  const running = client.__internals.RunHeader({ trace: base, onRefresh: () => {}, onCancel: () => {} })
  const text = textOf(running)
  assert.match(text, /S4修复：洪水重构/)
  assert.match(text, /运行中/)
  assert.match(text, /最大并发数 20/g)
  assert.match(text, /续跑 ×2/)
  assert.match(text, /GLM-5\.3-Flash/)
  assert.match(text, /8\/9 步/)
  assert.match(text, /94\.3M tokens/)
  assert.match(text, /2 个产物/)
  assert.match(text, /1 个子代理工作中/)
  assert.match(text, /调整自 run dwfrun-parent/)
  assert.equal(byTestId(running, 'run-stop').length, 1)

  const done = client.__internals.RunHeader({ trace: { ...base, status: 'completed', spentTokens: 0 } })
  assert.equal(byTestId(done, 'run-stop').length, 0)
  // Zero tokens is not displayed at all — the panel never shows a fabricated 0.
  assert.equal(textOf(done).includes('tokens'), false)
})

test('cancel route: stops a live run, refuses a settled one, reports an unknown one', async () => {
  const routes = new Map()
  const aborts = []
  const ctx = {
    inject: (deps, callback) => callback({
      get: (name) => (name === 'connection'
        ? { fetch: { register: (definition) => { routes.set(definition.path, definition); return () => {} } } }
        : undefined),
      effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    }),
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  }
  const store = {
    listRuns: async () => ({ runs: [] }),
    readRun: async (runId) => {
      if (runId === 'missing') throw new Error(`no run ${runId}`)
      return { status: 'completed' }
    },
  }
  const activeRuns = new Map()
  registerRunRoutes(ctx, store, { activeRuns })

  const cancel = routes.get('/api/dsh-workflow-zcode/cancel')
  assert.ok(cancel !== undefined, 'the cancel route must be registered')
  const call = async (body) => {
    const response = await cancel.fetch(new Request('http://local/cancel', {
      method: 'POST',
      body: JSON.stringify(body),
    }))
    return JSON.parse(await response.text())
  }

  activeRuns.set('live-1', { abort: (reason) => aborts.push(reason) })
  const stopped = await call({ runId: 'live-1' })
  assert.deepEqual(stopped, { ok: true, value: { cancelled: true, runId: 'live-1' } })
  assert.deepEqual(aborts, ['cancelled by user'])

  const settled = await call({ runId: 'done-1' })
  assert.equal(settled.ok, false)
  assert.equal(settled.error.code, 'not-running')

  const unknown = await call({ runId: 'missing' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'unknown-run')

  const bad = await call({})
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'bad-request')
})

test('integration: a real projected run drills down to its real nodes', async () => {
  const { openJournal } = await import('../src/engine/journal.mjs')
  const { createTraceStore } = await import('../src/engine/trace-projection.mjs')
  const journal = openJournal()
  try {
    journal.createRun({
      id: 'r-int', parentSessionId: 's', cwd: '/w', name: 'integration',
      plan: { phases: ['施工'] }, capsMaxConcurrency: 3,
    })
    journal.putActor({ runId: 'r-int', siteId: 'actor#1', ordinal: 1, name: '工程师' })
    journal.putNode({
      runId: 'r-int', siteId: 'ask#1', ordinal: 1, kind: 'ask',
      actorSiteId: 'actor#1', inputHash: 'h1', status: 'completed', result: { score: 42 },
      stats: { phase: '施工', typed: true, instructions: '请审阅洪水信号' },
    })
    journal.putNode({
      runId: 'r-int', siteId: 'world#1', ordinal: 1, kind: 'world-run', inputHash: 'h2',
      status: 'completed', result: { exitCode: 0 },
      input: JSON.stringify({ op: 'run', args: ['python3', ['-c', 'print(42)']] }),
      stats: { phase: '施工' },
    })
    journal.appendEvent('r-int', 'phase-entered', { title: '施工' })
    journal.settleRun('r-int', { status: 'completed', result: {} })

    const trace = await createTraceStore(journal).readRun('r-int')
    // The projection itself must carry the nodes: the panel reads them per phase.
    assert.equal(trace.phases[0].nodes.length, 2)

    const client = loadClient()
    const timeline = client.__internals.PhaseTimeline({ phases: trace.phases, traceNodes: trace.nodes })
    const text = textOf(timeline)
    assert.match(text, /工程师/)
    assert.match(text, /工作区命令/)

    const actorRole = trace.phases[0].roles.find((role) => role.kind === 'actor')
    const worldRole = trace.phases[0].roles.find((role) => role.kind === 'world')
    assert.ok(actorRole !== undefined && worldRole !== undefined)

    const actorText = textOf(client.__internals.RolePill({
      phase: trace.phases[0], role: actorRole, open: true, onToggle: () => {}, traceNodes: trace.nodes,
    }))
    assert.match(actorText, /ask#1/)
    assert.match(actorText, /请审阅洪水信号/)
    assert.match(actorText, /42/)

    const worldText = textOf(client.__internals.RolePill({
      phase: trace.phases[0], role: worldRole, open: true, onToggle: () => {}, traceNodes: trace.nodes,
    }))
    // A workspace node is identified by its command, not by an internal site id.
    assert.match(worldText, /python3/)
    assert.match(worldText, /结果/)
  } finally {
    journal.close()
  }
})

/* ------------------------------------------------ session scope & roster */

test('scope: a session panel defaults to that session, never to everything', () => {
  const client = loadClient()
  const { defaultScopeFor } = client.__internals
  assert.equal(defaultScopeFor('sess-1'), 'session')
  assert.equal(defaultScopeFor(''), 'all')
  assert.equal(defaultScopeFor(undefined), 'all')
})

test('scope: the request body never drops a session filter', () => {
  const client = loadClient()
  const { runsQueryFor } = client.__internals
  assert.deepEqual(runsQueryFor('session', 'sess-1', undefined), { sessionId: 'sess-1' })
  // Even if a caller passes an empty id, session scope must not become "all".
  assert.deepEqual(runsQueryFor('session', '', '/repo'), {})
  assert.deepEqual(runsQueryFor('cwd', 'sess-1', '/repo'), { cwd: '/repo' })
  assert.deepEqual(runsQueryFor('all', 'sess-1', '/repo'), {})
})

test('scope chips render 当前会话 / 当前目录 / 全部 with the active one pressed', () => {
  const client = loadClient()
  const { ScopeChips } = client.__internals
  const tree = walk(client.__internals.ScopeChips({ scope: 'session', onChange: () => {}, cwdAvailable: true }), () => {})
  const text = textOf(client.__internals.ScopeChips({ scope: 'session', onChange: () => {}, cwdAvailable: true }))
  assert.match(text, /当前会话/)
  assert.match(text, /当前目录/)
  assert.match(text, /全部/)
  const buttons = []
  walk(client.__internals.ScopeChips({ scope: 'session', onChange: () => {}, cwdAvailable: false }), (node) => {
    if (node?.props?.['data-scope'] !== undefined) buttons.push(node)
  })
  assert.deepEqual(buttons.map((node) => node.props['data-scope']), ['session', 'all'])
  assert.equal(buttons[0].props['aria-pressed'], true)
})

test('scope: resolveSessionCwd reads the session store defensively', () => {
  const client = loadClient()
  const { resolveSessionCwd } = client.__internals
  const ctx = {
    get: (name) => (name === 'sessions'
      ? { list: { getSnapshot: () => ({ byId: { 's1': { cwd: '/repo/a' } } }) } }
      : undefined),
  }
  assert.equal(resolveSessionCwd(ctx, 's1'), '/repo/a')
  assert.equal(resolveSessionCwd(ctx, 'missing'), undefined)
  assert.equal(resolveSessionCwd(undefined, 's1'), undefined)
})

test('roster: merges declared and created actors and opens a subagent transcript', () => {
  const client = loadClient()
  const { SubAgentRoster } = client.__internals
  const opened = []
  const trace = {
    actors: [
      { siteId: 'actor#1', name: '甲', model: 'cpa/gpt-6', tokens: 1200, nodes: 3, sessionId: 'sess-child-1' },
    ],
    declaredActors: [{ siteId: 'actor#2', name: '乙' }],
    phases: [{ roles: [{ kind: 'actor', siteId: 'actor#1', state: 'running' }] }],
  }
  const tree = SubAgentRoster({ trace, onOpen: (actor) => opened.push(actor) })
  const text = textOf(tree)
  assert.match(text, /SubAgent 2/)
  assert.match(text, /甲/)
  assert.match(text, /乙/)
  assert.match(text, /cpa\/gpt-6/)
  assert.match(text, /尚未创建/)

  let row
  walk(tree, (node) => {
    if (node?.props?.['data-subagent-id'] === 'sess-child-1') row = node
  })
  assert.ok(row !== undefined, 'the created actor row must be clickable')
  row.props.onClick()
  assert.equal(opened.length, 1)
  assert.equal(opened[0].sessionId, 'sess-child-1')
})

test('run header: configuration/resume actions, concurrency pill and change log', () => {
  const client = loadClient()
  const { RunHeader } = client.__internals
  const trace = {
    runId: 'dwfrun-new', workflowId: '演示', status: 'failed', maxConcurrency: 20,
    spentTokens: 3456, durationMs: 1000, resumeCount: 0, resumedFrom: 'dwfrun-old',
    actors: [{ siteId: 'actor#1' }], phases: [], artifacts: [], nodes: [],
    configEvents: [{ at: Date.now(), changes: [{ label: '最大并发数', from: 13, to: 20 }] }],
  }
  const tree = RunHeader({ trace, onConfigure: () => {}, onResume: () => {}, onCancel: () => {} })
  const text = textOf(tree)
  assert.match(text, /配置/)
  assert.match(text, /续跑/)
  assert.doesNotMatch(text, /停止运行/)
  assert.match(text, /最大并发数 20/g)
  assert.match(text, /调整自 run dwfrun-old/)
  assert.match(text, /最大并发数 13 → 20/)
  assert.equal(byTestId(tree, 'run-configure').length, 1)
  assert.equal(byTestId(tree, 'run-resume').length, 1)
})

test('config dialog: stepper plus a graceful model fallback', () => {
  const client = loadClient()
  const { ConfigDialog } = client.__internals
  const tree = ConfigDialog({
    trace: { maxConcurrency: 13, subagentModel: '会话模型' },
    sessionId: 's1', ctx: { get: () => undefined }, onClose: () => {}, onApply: () => {},
  })
  const text = textOf(tree)
  assert.match(text, /运行配置/)
  assert.match(text, /最大并发数/)
  assert.match(text, /跟随会话模型/)
  assert.match(text, /未检测到模型目录服务/)
  assert.equal(byTestId(tree, 'concurrency-value')[0].children.join(''), '13')
  assert.equal(byTestId(tree, 'config-apply').length, 1)

  // A pinned model must remain visible before the directory loads; otherwise
  // the select falls back to the first option and lies about the route.
  const pinnedTree = ConfigDialog({
    trace: { maxConcurrency: 13, subagentModel: 'cpa/gpt-6.1' },
    sessionId: 's1', ctx: { get: () => undefined }, onClose: () => {}, onApply: () => {},
  })
  const values = []
  walk(pinnedTree, (node) => { if (node.type === 'option') values.push(node.props.value) })
  assert.ok(values.includes('cpa/gpt-6.1'))
})

test('subagent navigation: preferred path, plain-session fallback, failure', async () => {
  const client = loadClient()
  const { openSubagentSession } = client.__internals

  const calls = []
  const sessions = {
    async refreshSubagents(parent) { calls.push(['refresh', parent]) },
    subagentAddress: () => ({ parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable' }),
    openSubagent: (address) => calls.push(['openSubagent', address]),
    open: (id) => calls.push(['open', id]),
  }
  const layout = { selectPanel: (value) => calls.push(['panel', value]), beginNavigation: () => ({ aborted: false }) }
  assert.equal(await openSubagentSession({ sessions, layout }, 'parent', 'child'), 'subagent')
  assert.deepEqual(calls[0], ['refresh', 'parent'])
  assert.equal(calls.some(([kind]) => kind === 'openSubagent'), true)

  const legacy = []
  assert.equal(await openSubagentSession({ sessions: { open: (id) => legacy.push(id) } }, 'parent', 'child'), 'session')
  assert.deepEqual(legacy, ['child'])

  assert.equal(await openSubagentSession({ sessions: { openSubagent() { throw new Error('gone') }, refreshSubagents() {} } }, 'p', 'c'), false)
})


test('scope: the full page falls back to the session store current id', () => {
  const client = loadClient()
  const { currentSessionIdFrom } = client.__internals
  assert.equal(currentSessionIdFrom({ get: () => ({ list: { getSnapshot: () => ({ currentSessionId: 'cur-1' }) } }) }), 'cur-1')
  assert.equal(currentSessionIdFrom({
    get: () => ({ list: { getSnapshot: () => ({ byId: { a: { id: 'a', retainedBy: { mainView: 1 } } } }) } }),
  }), 'a')
  assert.equal(currentSessionIdFrom({ get: () => undefined }), undefined)
})


test('timeline: coloured rail segments and no P0/P1 prefixes', () => {
  const client = loadClient()
  const { PhaseTimeline } = client.__internals
  const phases = [
    { id: 'P0', title: '规格', status: 'completed', settledCount: 2, observedCount: 2, roles: [], nodes: [] },
    { id: 'P1', title: '施工', status: 'running', settledCount: 1, observedCount: 2, roles: [], nodes: [] },
  ]
  const tree = PhaseTimeline({ phases, traceNodes: [] })
  const text = textOf(tree)
  assert.doesNotMatch(text, /P0|P1/)
  const segments = []
  walk(tree, (node) => {
    if (node?.props?.['data-rail-segment'] !== undefined) segments.push(node.props['data-rail-segment'])
  })
  assert.deepEqual(segments, ['completed', 'running'])
})

test('avatar: running and failed states carry visible badges', () => {
  const client = loadClient()
  const { Avatar } = client.__internals
  const running = Avatar({ name: '甲', size: 20, state: 'running' })
  const failed = Avatar({ name: '乙', size: 20, state: 'failed' })
  const states = []
  walk(running, (node) => { if (node?.props?.['data-avatar-state'] !== undefined) states.push(node.props['data-avatar-state']) })
  walk(failed, (node) => { if (node?.props?.['data-avatar-state'] !== undefined) states.push(node.props['data-avatar-state']) })
  assert.deepEqual(states, ['running', 'failed'])
})


test('right tab forwards the session id into the scoped page', () => {
  const client = loadClient()
  const { WorkflowRightTab, WorkflowPage } = client.__internals
  const tree = WorkflowRightTab({ sessionId: 'sess-9' })
  assert.equal(tree.type, WorkflowPage)
  assert.equal(tree.props.sessionId, 'sess-9')
  assert.equal(tree.props.compact, true)
})


test('roster: uncreated actors are disabled; failed navigation is reported', async () => {
  const client = loadClient()
  const { SubAgentRoster, openSubagentFromRoster } = client.__internals
  const trace = {
    actors: [{ siteId: 'actor#1', name: '甲', sessionId: 'sess-1', nodes: 1, tokens: 10 }],
    declaredActors: [{ siteId: 'actor#2', name: '乙' }],
    phases: [{ roles: [] }],
  }
  const tree = SubAgentRoster({ trace, onOpen: async () => true })
  const rows = []
  walk(tree, (node) => {
    if (node?.props?.['data-subagent-id'] !== undefined) rows.push(node)
  })
  const created = rows.find((row) => row.props['data-subagent-id'] === 'sess-1')
  const pending = rows.find((row) => row.props['data-subagent-id'] === 'actor#2')
  assert.equal(created.props.disabled, false)
  assert.equal(pending.props.disabled, true)
  assert.equal(pending.props['data-subagent-disabled'], true)
  assert.match(pending.props.title, /尚未创建子代理会话/)

  assert.equal(await openSubagentFromRoster({ sessionId: undefined }, async () => true), 'disabled')
  assert.equal(await openSubagentFromRoster({ sessionId: 'sess-1' }, async () => false), 'failed')
  assert.equal(await openSubagentFromRoster({ sessionId: 'sess-1' }, async () => 'subagent'), 'subagent')
})


test('right tab seat injects the plugin context when the Host passes only sessionId', async () => {
  const client = loadClient()
  const registered = []
  const deferred = []
  const ctx = {
    slots: {
      inject(name, register) { return register() },
      register(definition, component) { registered.push({ definition, component }); return () => {} },
    },
    get: () => undefined,
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    inject(deps, callback) { deferred.push({ deps, callback }); return () => {} },
  }
  client.apply(ctx)
  const rightCtx = {
    get: (name) => (name === 'sidebarRightTabs' ? { register() { return () => {} } } : undefined),
    slots: ctx.slots,
    effect: ctx.effect,
  }
  deferred[0].callback(rightCtx)

  const body = registered.find((row) => row.definition.name === 'sidebar.right.pane.tab')
  const element = body.component({ sessionId: 'sess-7' })
  assert.equal(element.type, client.__internals.WorkflowRightTab)
  assert.equal(element.props.ctx, ctx)
  const page = element.type(element.props)
  assert.equal(page.props.ctx, ctx)
  assert.equal(page.props.sessionId, 'sess-7')
})

test('run card exposes delete action only for settled runs and forwards the runId', () => {
  const client = loadClient()
  const { RunCard } = client.__internals
  const deleted = []
  const settled = RunCard({
    run: { runId: 'r-done', workflowId: 'demo', status: 'failed', durationMs: 1200 },
    active: false, onSelect: () => {}, onDelete: (id) => deleted.push(id),
  })
  let deleteButton
  walk(settled, (node) => {
    if (node?.props?.['data-run-delete'] === 'r-done') deleteButton = node
  })
  assert.ok(deleteButton !== undefined, 'settled run should offer a delete action')
  deleteButton.props.onClick({ stopPropagation() {} })
  assert.deepEqual(deleted, ['r-done'])

  const live = RunCard({
    run: { runId: 'r-live', workflowId: 'demo', status: 'running', durationMs: 500 },
    active: true, onSelect: () => {}, onDelete: (id) => deleted.push(id),
  })
  let liveDeleteButton
  walk(live, (node) => {
    if (node?.props?.['data-run-delete'] !== undefined) liveDeleteButton = node
  })
  assert.equal(liveDeleteButton, undefined)
})
