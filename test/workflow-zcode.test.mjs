/**
 * Offline checks for `@local/dsh-workflow-zcode`: front matter, compile
 * diagnostics, lowering, schema emission, and the runtime preamble.
 *
 * Run with `node --test test/`. TypeScript is optional; the compile cases skip
 * when it cannot be resolved from this checkout or the profile.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { normalizeFrontmatter, parseFrontmatterYaml, splitFrontmatter } from '../src/frontmatter.mjs'
import { compile } from '../src/compiler.mjs'

const facadeText = await readFile(new URL('../facade.d.ts', import.meta.url), 'utf8')

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

const ts = resolveTypeScript()
const needsTs = ts === undefined ? { skip: 'typescript is not installed for this checkout' } : undefined

test('front matter: real saved workflow parses with declared defaults', async () => {
  const source = await readFile(join(homedir(), '.zcode/workflows/libtv-cinematic-pipeline.dwf.ts'), 'utf8')
  const split = splitFrontmatter(source)
  assert.equal(split.error, undefined)
  const parsed = parseFrontmatterYaml(split.block)
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.message)
  const normalized = normalizeFrontmatter(parsed.value, { title: '测试项目' })
  assert.equal(normalized.ok, true, normalized.ok ? '' : normalized.issues.join('; '))
  assert.equal(normalized.args.title, '测试项目')
  assert.equal(normalized.args.aspectRatio, '16:9')
  // The installed copy under ~/.zcode/workflows declares 90; the in-repo copy
  // under .zcode/workflows still says 60. The installed one is the benchmark.
  assert.equal(normalized.args.targetDurationSec, 90)
})

test('front matter: folded scalar continuation lines join', () => {
  const parsed = parseFrontmatterYaml('description: 前半句\n  后半句\nwhenToUse: 用得上\n')
  assert.equal(parsed.ok, true)
  assert.equal(parsed.value.description, '前半句 后半句')
})

test('front matter: unknown and mistyped arguments are refused', () => {
  const meta = {
    description: 'd',
    args: {
      count: { type: 'number', default: 3 },
      name: { type: 'string', required: true },
    },
  }
  const unknown = normalizeFrontmatter(meta, { name: 'a', extra: 1 })
  assert.equal(unknown.ok, false)
  assert.match(unknown.issues.join(' '), /unknown argument `extra`/)
  const missing = normalizeFrontmatter(meta, {})
  assert.equal(missing.ok, false)
  assert.match(missing.issues.join(' '), /missing required argument `name`/)
  const mistyped = normalizeFrontmatter(meta, { name: 7 })
  assert.equal(mistyped.ok, false)
  assert.match(mistyped.issues.join(' '), /must be a string/)
})

test('front matter: missing block is reported', () => {
  const split = splitFrontmatter('const x = 1\n')
  assert.equal(split.error, 'missing_frontmatter')
})

test('compile: lowers the ZCode hook surface', needsTs, () => {
  const body = `interface Verdict { approved: boolean; score: number; tags: string[] }
phase("调研")
const reader = agent("审阅员", { system: "独立审阅" })
const verdict = await reader.ask<Verdict>("请审阅")
log("完成")
report({ ok: verdict.approved }, "board")
await artifact.markdown("report", "# 结论")
const diff = await world.run("git", ["status"])
return { verdict, diff }`
  const result = compile({ body, facade: facadeText, ts })
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics))
  assert.equal(result.sites.actors, 1)
  assert.equal(result.sites.asks, 1)
  assert.equal(result.sites.phases, 1)
  assert.match(result.code, /__zcodeCreateActor\("审阅员", \{ system: "独立审阅" \}\)/)
  assert.match(result.code, /__zcodeAsk\("ask#1", reader, "请审阅"\)/)
  assert.match(result.code, /__zcodeReadWorld\("world-read#1", "run", \["git", \["status"\]\]\)/)
  assert.deepEqual(result.commands, ['git'])
  const schema = result.askSchemas.find((entry) => entry.siteId === 'ask#1')
  assert.equal(schema.schema.properties.approved.type, 'boolean')
  assert.deepEqual(schema.schema.required, ['approved', 'score', 'tags'])
})

test('compile: declares inside the body are rejected (TS1184)', needsTs, () => {
  const result = compile({ body: 'declare const x: number\nphase("a")\nawait agent("a").ask("b")', facade: facadeText, ts })
  assert.equal(result.ok, false)
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 1184))
})

test('compile: non-literal world.run command is 9003', needsTs, () => {
  const result = compile({ body: 'const command = "node"\nphase("a")\nawait world.run(command)', facade: facadeText, ts })
  assert.equal(result.ok, false)
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 9003))
})

test('compile: duplicate actor names are 9005', needsTs, () => {
  const result = compile({
    body: 'phase("a")\nconst a = agent("同名")\nconst b = agent("同名")\nawait a.ask("1")\nawait b.ask("2")',
    facade: facadeText,
    ts,
  })
  assert.equal(result.ok, false)
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 9005))
})
test('compile: artifact ids must be literal and in the id alphabet (9007)', needsTs, () => {
  const nonLiteral = compile({
    body: 'const id = "x" + String(Date.now())\nawait artifact.markdown(id, "# 内容")\nreturn 1',
    facade: facadeText,
    ts,
  })
  assert.equal(nonLiteral.ok, false)
  assert.equal(nonLiteral.diagnostics.some((entry) => entry.code === 9007), true, JSON.stringify(nonLiteral.diagnostics))

  const badAlphabet = compile({ body: 'await artifact.markdown("has space", "# 内容")\nreturn 1', facade: facadeText, ts })
  assert.equal(badAlphabet.ok, false)
  assert.equal(badAlphabet.diagnostics.some((entry) => entry.code === 9007), true)

  const fine = compile({ body: 'await artifact.markdown("ok.id-1", "# 内容")\nreturn 1', facade: facadeText, ts })
  assert.equal(fine.ok, true, JSON.stringify(fine.diagnostics))
})

test('compile: a phase label may be assembled at run time (9004 is about non-strings)', needsTs, () => {
  // The shipped libtv workflow builds its phase labels as `"Phase 1 · …" + id`,
  // so rejecting concatenation would fail a real workflow.
  const concatenated = compile({
    body: 'const id = "A"\nphase("Phase 1 · 加载：" + id)\nreturn 1',
    facade: facadeText,
    ts,
  })
  assert.equal(concatenated.ok, true, JSON.stringify(concatenated.diagnostics))
  assert.equal(concatenated.phases.length, 1)

  const template = compile({ body: 'const id = "A"\nphase(`阶段 ${id}`)\nreturn 1', facade: facadeText, ts })
  assert.equal(template.ok, true, JSON.stringify(template.diagnostics))

  // A number can never be a label. With type checking on, TypeScript already
  // rejects it (2345), so 9004 is the belt for a type-erased build rather than
  // the usual path — what matters is that it does not compile.
  const numeric = compile({ body: 'phase(7)\nreturn 1', facade: facadeText, ts })
  assert.equal(numeric.ok, false)
  assert.equal(numeric.diagnostics.length > 0, true)
})

/** A context good enough for `apply`: it records tool registrations only. */
function stubContext() {
  const registered = []
  return {
    registered,
    tools: { register: (definition) => { registered.push(definition); return () => {} } },
    get: () => undefined,
    on: () => () => {},
    effect: (fn) => { fn(); return () => {} },
    inject: () => {},
  }
}

test('tool schemas are object-rooted with declared properties', async () => {
  const { apply } = await import('../index.mjs')
  const ctx = stubContext()
  // The journal is in-memory here: apply must not touch the user's real database.
  apply(ctx, { journalFile: ':memory:' })
  assert.equal(ctx.registered.length, 3)

  for (const definition of ctx.registered) {
    // `ctx.tools.register()` stores `parameters` verbatim. Unlike `defineTool()`
    // it does NOT wrap a bare property map, so every tool must ship the complete
    // object-rooted schema that the model gateway receives.
    assert.equal(definition.parameters?.type, 'object', `${definition.name} needs an object root`)
    assert.equal(Array.isArray(definition.parameters?.required), definition.parameters?.required !== undefined)
    if (definition.parameters.required !== undefined) {
      assert.ok(definition.parameters.required.length > 0, `${definition.name} must not declare an empty required`)
      for (const key of definition.parameters.required) {
        assert.equal(Object.hasOwn(definition.parameters.properties, key), true, `${definition.name} requires unknown ${key}`)
      }
    }
    assert.equal(typeof definition.output.schema, 'object')
    assert.equal(definition.output.schema.type, 'object')
    assert.equal(typeof definition.execute, 'function')
    assert.equal(typeof definition.output.render, 'function')
  }

  const resume = ctx.registered.find((definition) => definition.name === 'resume_zcode_workflow')
  assert.deepEqual(
    Object.keys(resume.parameters.properties).sort(),
    ['allow_rehydrate', 'max_concurrency', 'run_id', 'subagent_model'],
  )
  assert.deepEqual(resume.parameters.required, ['run_id'])

  const run = ctx.registered.find((definition) => definition.name === 'run_zcode_workflow')
  assert.deepEqual(
    Object.keys(run.parameters.properties).sort(),
    ['args', 'dry_run', 'max_concurrency', 'max_total_agents', 'name', 'path', 'script', 'subagent_model'],
  )
  // script/path are an either-or pair enforced by execute(), not JSON Schema.
  assert.equal(run.parameters.required, undefined)
})

test('tool schemas equal what the DSH implicit property-map compiler produces', async () => {
  const { apply } = await import('../index.mjs')
  const ctx = stubContext()
  apply(ctx, { journalFile: ':memory:' })

  // dsh-tools' `parameterSchemaSpecToJsonSchema()` compiles a per-property map
  // into `{ type: 'object', properties, required? }`. Bare register() does not
  // call it, so the shipped schema must be that compiled shape exactly.
  const compile = (definition) => {
    const spec = structuredClone(definition.parameters.properties)
    const required = definition.parameters.required
    if (required !== undefined) {
      for (const key of required) spec[key] = { ...spec[key], required: true }
    }
    return {
      type: 'object',
      properties: Object.fromEntries(Object.entries(spec).map(([key, schema]) => {
        if (schema.required !== true) return [key, schema]
        const { required: _required, ...rest } = schema
        return [key, rest]
      })),
    }
  }
  for (const definition of ctx.registered) {
    const expected = compile(definition)
    const required = definition.parameters.required
    if (required !== undefined) expected.required = required
    assert.deepEqual(definition.parameters, expected, `${definition.name} diverges from the DSH compiler`)
  }
})

test('the tool schema keywords stay inside the supported subset', async () => {
  const { apply } = await import('../index.mjs')
  const ctx = stubContext()
  apply(ctx, { journalFile: ':memory:' })
  const allowed = new Set(['type', 'properties', 'required', 'items', 'enum', 'const', 'oneOf', 'additionalProperties', 'description', 'title', 'default', 'examples'])
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node)) {
      assert.equal(allowed.has(key), true, `unsupported keyword ${key} at ${path}`)
      if (key === 'required') {
        assert.equal(Array.isArray(value), true, `required must be an array at ${path}`)
        for (const name of value) assert.equal(typeof name, 'string', `required entries must be strings at ${path}`)
      } else if (key === 'properties') {
        for (const [name, sub] of Object.entries(value)) walk(sub, `${path}.properties.${name}`)
      } else if (key === 'items') {
        walk(value, `${path}.items`)
      } else if (key === 'oneOf') {
        value.forEach((sub, index) => walk(sub, `${path}.oneOf[${index}]`))
      } else if (typeof value === 'object') {
        walk(value, `${path}.${key}`)
      }
    }
  }
  for (const definition of ctx.registered) {
    walk(definition.parameters, `${definition.name}.parameters`)
    walk(definition.output.schema, `${definition.name}.output`)
  }
})

test('client half: adds one foot-of-sidebar action and one main panel', async () => {
  // The Client bundle is a ModuleLoader factory, not an ES module: evaluate it
  // with a stub `require`/`window` and drive its apply().
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let loaded
  const window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        assert.equal(id, '@local/dsh-workflow-zcode')
        loaded = factory(() => {
          const React = {
            createElement: () => null,
            useState: () => [undefined, () => {}],
            useEffect: () => {},
            useMemo: (fn) => fn(),
            useCallback: (fn) => fn,
          }
          return React
        })
      },
    },
  }
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  globalThis.window = window
  globalThis.fetch = async () => ({ json: async () => ({ ok: true, value: { runs: [] } }) })
  try {
    new Function('window', 'fetch', source)(window, globalThis.fetch)
  } finally {
    globalThis.window = previousWindow
    globalThis.fetch = previousFetch
  }

  assert.ok(loaded !== undefined, 'the client factory must register itself')
  // `slots` only: the panel needs no other Client service, and asking for one
  // this composition lacks would leave the whole module unapplied.
  assert.deepEqual(loaded.inject, ['slots'])

  const injected = []
  const registered = []
  const ctx = {
    slots: {
      inject(name, register) { injected.push(name); return register() },
      register(definition, component) { registered.push({ definition, component }); return () => {} },
    },
    get(key) {
      if (key === 'sidebarRightTabs') return { register() { return () => {} } }
      return undefined
    },
    effect(fn) { fn(); return () => {} },
  }
  const dispose = loaded.apply(ctx)

  // Exactly the additive pair a shipped panel uses; no tab registry, no guide,
  // no `sidebar.right.*` seat.
  assert.deepEqual(injected.sort(), ['main', 'sidebar.footer.action', 'sidebar.right.pane.tab'])
  assert.equal(registered.length, 3)

  const entry = registered.find((row) => row.definition.name === 'sidebar.footer.action')
  assert.equal(entry.definition.id, 'zcode-workflow')
  assert.equal(typeof entry.definition.order, 'number')
  assert.equal(typeof entry.definition.label, 'function')
  assert.equal(typeof entry.component, 'function')
  // A footer action is not a panel entry: it must drive the panel itself.
  assert.equal(typeof entry.definition.inject, 'function')
  const face = entry.definition.inject()
  assert.equal(typeof face.selectPanel, 'function')

  const panel = registered.find((row) => row.definition.name === 'main')
  assert.equal(panel.definition.key, 'zcode-workflow')
  assert.equal(typeof panel.component, 'function')

  // The panel must not carry a tab-type declaration of any kind.
  for (const row of registered) {
    assert.equal('kind' in row.definition, false, 'no tab kind')
    assert.equal('guide' in row.definition, false, 'no guide override')
    assert.equal('priority' in row.definition, false, 'no tab priority')
  }

  assert.equal(typeof dispose, 'function')
  dispose()
})


test('right-column tab type declares its own guide card without taking the guide over', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let loaded
  const window = { __ModuleLoader__: { load({ factory }) { loaded = factory(() => ({ createElement: () => null, useState: () => [null, () => {}], useEffect() {}, useMemo: f => f(), useCallback: f => f })) } } }
  const previous = globalThis.window
  const previousFetch = globalThis.fetch
  globalThis.window = window
  globalThis.fetch = async () => ({ json: async () => ({ ok: true, value: { runs: [] } }) })
  try {
    new Function('window', 'fetch', source)(window, globalThis.fetch)
  } finally {
    globalThis.window = previous
    globalThis.fetch = previousFetch
  }

  const tabTypes = []
  const registered = []
  let opened = 0
  const ctx = {
    slots: {
      inject(_name, register) { return register() },
      register(definition, component) { registered.push({ definition, component }); return () => {} },
    },
    get(key) {
      if (key === 'sidebarRightTabs') return { register(definition) { tabTypes.push(definition); return () => {} } }
      if (key === 'sidebarRight') return { openTab() { opened += 1 } }
      return undefined
    },
    effect(fn) { fn(); return () => {} },
  }
  loaded.apply(ctx)

  assert.equal(tabTypes.length, 1)
  const type = tabTypes[0]

  // The shipped guide owns its own registration: an extension must use its own
  // id/kind, never the guide's, or the Start page disappears.
  assert.equal(type.id, 'zcode-workflow')
  assert.equal(type.kind, 'zcode-workflow')
  assert.notEqual(type.id, '@deepseek-ai/dsh-client-ui-sidebar-right/guide')
  assert.notEqual(type.kind, 'guide')
  assert.equal(type.priority, 'extension')

  // `guide` here DESCRIBES this type's own card; it is not a takeover.
  assert.equal(Array.isArray(type.guide), true)
  assert.equal(type.guide.length, 1)
  // `guide-pins` keys entries by `${kind}:${id}`; a missing id makes the card
  // unpinnable and is a required field of SidebarRightGuideEntry.
  assert.equal(type.guide[0].id, 'zcode-workflow')
  assert.equal(typeof type.guide[0].order, 'number')
  assert.equal(typeof type.guide[0].title, 'function')
  assert.equal(typeof type.guide[0].icon, 'function')

  // The right-column body is registered under the same key.
  const body = registered.find((row) => row.definition.name === 'sidebar.right.pane.tab')
  assert.equal(body.definition.key, 'zcode-workflow')

  // The foot button opens the right column (conversation stays visible) rather
  // than replacing the main column.
  const foot = registered.find((row) => row.definition.name === 'sidebar.footer.action')
  assert.equal(foot.definition.inject().selectPanel(), true)
  assert.equal(opened, 1)
})


test('the dry-run envelope reports compile facts, not published artifacts', async () => {
  const { renderEnvelope } = await import('../index.mjs')
  const text = renderEnvelope({
    dryRun: true,
    workflowId: 'libtv-cinematic-pipeline',
    sourcePath: '/w/libtv.dwf.ts',
    ok: true,
    phases: ['Phase 1', 'Phase 2'],
    actors: [{ id: 'actor#1', name: '导演' }, { id: 'actor#2', name: '监制' }],
    askSchemas: 10,
    commands: [{ command: 'python3' }],
    // Compile-time SITES: they have no kind or version, which is exactly what
    // used to be rendered as "artifact#1 (undefined) vundefined".
    artifactSites: [{ id: 'report', op: 'markdown' }],
    sites: { worldReads: 19 },
    diagnostics: [],
  })
  assert.match(text, /compiled \(dry run: nothing was executed\)/)
  assert.match(text, /ok: true/)
  assert.match(text, /phases: 2 — Phase 1 · Phase 2/)
  assert.match(text, /subagents: 2 — 导演, 监制/)
  assert.match(text, /typed asks: 10/)
  assert.match(text, /world sites: 19/)
  assert.match(text, /declared artifacts: 1 — report\(markdown\)/)
  assert.match(text, /diagnostics: none/)
  assert.equal(/undefined/.test(text), false, 'no undefined placeholder may reach the model')

  // A phase or actor whose label is computed at run time says so, rather than
  // rendering an empty string that reads like data loss.
  const computed = renderEnvelope({
    dryRun: true, workflowId: 'w', ok: true, phases: [{ name: undefined }],
    actors: [{ id: 'actor#1' }], askSchemas: 0, commands: [], artifactSites: [], sites: {}, diagnostics: [],
  })
  assert.match(computed, /phases: 1 — \(runtime label\)/)
  assert.match(computed, /subagents: 1 — actor#1 \(runtime name\)/)
})

test('the dry-run envelope lists diagnostics when compilation failed', async () => {
  const { renderEnvelope } = await import('../index.mjs')
  const text = renderEnvelope({
    dryRun: true,
    workflowId: 'bad',
    ok: false,
    phases: [],
    actors: [],
    askSchemas: 0,
    commands: [],
    artifactSites: [],
    sites: {},
    diagnostics: [{ code: 9003, line: 4, column: 1, message: 'world.run needs a literal command' }],
  })
  assert.match(text, /did NOT compile/)
  assert.match(text, /diagnostics \(1\)/)
  assert.match(text, /9003 4:1 world\.run needs a literal command/)
})

test('a completed run envelope still renders reports and artifacts', async () => {
  const { renderEnvelope } = await import('../index.mjs')
  const text = renderEnvelope({
    workflowId: 'e2e-workflow',
    runId: 'dwfrun-x',
    status: 'completed',
    agentsStarted: 1,
    value: { s1: 74 },
    reports: [{ tag: 'kpi', item: { score: 74 } }],
    artifacts: [{ id: 'report', kind: 'markdown', version: 1, primary: false }],
  })
  assert.match(text, /finished \(1 subagent\(s\)\)/)
  assert.match(text, /Artifacts \(1\)/)
  assert.match(text, /report \(markdown\) v1/)
  assert.match(text, /Reports \(1\)/)
  assert.match(text, /Return value:/)
})

test('a compile failure renders as a failure with its diagnostics', async () => {
  const { renderEnvelope } = await import('../index.mjs')
  // This shape has no `status`: nothing ran. It used to render as "finished",
  // silently dropping both the error and the diagnostics.
  const text = renderEnvelope({
    error: { message: 'the ZCode workflow script did not compile; nothing was executed.' },
    diagnostics: [{ code: 2339, line: 6, column: 10, message: "Property 'text' does not exist on type 'string'" }],
  })
  assert.match(text, /^ZCode workflow "workflow" failed:/)
  assert.match(text, /did not compile/)
  assert.match(text, /diagnostics \(1\)/)
  assert.match(text, /2339 6:10/)
  assert.equal(/finished/.test(text), false)
})

test('a failed run envelope leads with the status and the error', async () => {
  const { renderEnvelope } = await import('../index.mjs')
  const text = renderEnvelope({
    workflowId: 'bad',
    runId: 'dwfrun-y',
    status: 'failed',
    error: { message: 'the subagent turn failed: has no provider/model' },
  })
  assert.match(text, /^ZCode workflow "bad" failed: the subagent turn failed/)
})


/** Load the client module once, without a browser. */
async function loadClientModule() {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let loaded
  const window = {
    __ModuleLoader__: {
      load({ factory }) {
        loaded = factory(() => ({
          createElement: () => null, useState: () => [null, () => {}], useEffect() {},
          useMemo: (fn) => fn(), useCallback: (fn) => fn(),
        }))
      },
    },
  }
  const previousWindow = globalThis.window
  globalThis.window = window
  try {
    new Function('window', 'fetch', source)(window, async () => ({ json: async () => ({ ok: true, value: { runs: [] } }) }))
  } finally {
    globalThis.window = previousWindow
  }
  return loaded
}

test('client helpers: statuses read as Chinese labels with their own dot', async () => {
  const client = await loadClientModule()
  const { statusLabel, statusDot } = client.__internals
  assert.equal(statusLabel('completed'), '已完成')
  assert.equal(statusLabel('failed'), '失败')
  assert.equal(statusLabel('running'), '运行中')
  assert.equal(statusLabel('cancelled'), '已取消')
  // An unknown status degrades to itself rather than to a wrong label.
  assert.equal(statusLabel('weird'), 'weird')
  // Failed and completed are visually distinct.
  assert.notEqual(statusDot('failed'), statusDot('completed'))
})

test('client helpers: a workspace step is titled by its command, not by an actor', async () => {
  const client = await loadClientModule()
  const { nodeTitle, isWorldNode } = client.__internals

  const world = { kind: 'world-run', worldCommand: 'python3 -c print(6*7)', actorName: null }
  assert.equal(isWorldNode(world), true)
  assert.equal(nodeTitle(world), 'python3 -c print(6*7)')

  const ask = { kind: 'ask', actorName: '打分员', siteId: 'ask#1' }
  assert.equal(isWorldNode(ask), false)
  assert.equal(nodeTitle(ask), '打分员')

  // An anonymous actor still must not borrow the workspace wording.
  assert.equal(nodeTitle({ kind: 'ask', actorName: null, actorSiteId: null }), '子代理')
})

test('client helpers: durations and clock stamps are stable', async () => {
  const client = await loadClientModule()
  const { formatDuration, formatClock } = client.__internals
  assert.equal(formatDuration(0), '0 ms')
  assert.equal(formatDuration(999), '999 ms')
  assert.equal(formatDuration(1500), '1.5 s')
  assert.equal(formatDuration(65_000), '1m 5s')
  assert.equal(formatDuration(undefined), '—')
  assert.equal(formatClock(0).length > 0, true)
  assert.equal(formatClock(undefined), '')
})


/** Collect every string in an element tree, invoking function components. */
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node === 'function') return textOf(node({}))
  if (typeof node === 'object') {
    // A component element: render it so hooks-based children (CopyButton,
    // StatusPill) contribute their text too.
    if (typeof node.type === 'function') return textOf(node.type(node.props ?? {}))
    const children = node.children ?? node.props?.children
    return textOf(children)
  }
  return ''
}

/** Load the client with a controllable `useState` initial value. */
async function loadClientForRender({ openInitial = false } = {}) {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let loaded
  const elements = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat() }
    },
    useState: (initial) => [initial === false ? openInitial : initial, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn(),
  }
  const window = { __ModuleLoader__: { load({ factory }) { loaded = factory(() => elements) } } }
  const previous = globalThis.window
  globalThis.window = window
  try {
    new Function('window', 'fetch', source)(window, async () => ({ json: async () => ({ ok: true, value: { runs: [] } }) }))
  } finally {
    globalThis.window = previous
  }
  return loaded
}

test('render: a workspace step shows its command, never an anonymous subagent', async () => {
  const client = await loadClientForRender()
  const { NodeCard } = client.__internals
  const tree = NodeCard({
    node: {
      kind: 'world-run', siteId: 'world#1', worldCommand: 'python3 -c print(6*7)',
      state: 'settled', durationMs: 1200, typed: false,
    },
  })
  const text = textOf(tree)
  assert.match(text, /python3 -c print\(6\*7\)/)
  assert.equal(text.includes('子代理'), false, 'a shell command must not be labelled as an agent')
  // The kind travels with the element so the panel can be styled per kind.
  assert.equal(tree.props['data-node-kind'], 'world-run')
})

test('render: an ask card names its actor and flags a structured call', async () => {
  const client = await loadClientForRender()
  const { NodeCard } = client.__internals
  const text = textOf(NodeCard({
    node: {
      kind: 'ask', siteId: 'ask#1', actorName: '打分员', state: 'settled',
      durationMs: 800, typed: true, resultPreview: '{"score":74}',
    },
  }))
  assert.match(text, /打分员/)
  assert.match(text, /结构化/)
  assert.match(text, /ask#1/)
})

test('render: an expanded node separates the task input from the result', async () => {
  const client = await loadClientForRender({ openInitial: true })
  const { NodeCard } = client.__internals
  const text = textOf(NodeCard({
    node: {
      kind: 'ask', siteId: 'ask#1', actorName: '打分员', state: 'settled',
      durationMs: 800, typed: true, instructions: '请审阅这段方案', result: '{\n  "score": 74\n}',
    },
  }))
  assert.match(text, /任务输入/)
  assert.match(text, /请审阅这段方案/)
  assert.match(text, /结果/)
  assert.match(text, /score/)
  assert.match(text, /复制/)
})

test('render: a failed node shows its error', async () => {
  const client = await loadClientForRender({ openInitial: true })
  const { NodeCard } = client.__internals
  const text = textOf(NodeCard({
    node: { kind: 'ask', siteId: 'ask#1', actorName: '打分员', state: 'failed', error: '模型超时' },
  }))
  assert.match(text, /模型超时/)
})

test('render: an artifact card carries version, primary flag and a preview', async () => {
  const client = await loadClientForRender({ openInitial: true })
  const { ArtifactCard } = client.__internals
  const text = textOf(ArtifactCard({
    artifact: {
      id: 'report', kind: 'markdown', version: 2, primary: true,
      description: '本轮审计摘要', body: '# 复核结论\n\n- 3 个用例通过',
    },
    reports: [{ tag: 'kpi', item: { passed: 3 } }],
  }))
  assert.match(text, /report/)
  assert.match(text, /markdown/)
  assert.match(text, /v2/)
  assert.match(text, /主产物/)
  assert.match(text, /本轮审计摘要/)
  assert.match(text, /3 个用例通过/)
  assert.match(text, /passed/)
})

test('render: an artifact file card exposes its path instead of a body', async () => {
  const client = await loadClientForRender({ openInitial: true })
  const { ArtifactCard } = client.__internals
  const text = textOf(ArtifactCard({
    artifact: { id: 'log', kind: 'file', version: 1, sourcePath: 'out/pytest.txt', itemCount: 2048 },
  }))
  assert.match(text, /out\/pytest\.txt/)
  assert.equal(text.includes('主产物'), false)
})

test('render: a run row shows status label, time and call count; a failure adds a line', async () => {
  const client = await loadClientForRender()
  const { RunCard } = client.__internals
  const healthy = textOf(RunCard({
    run: { runId: 'r1', workflowId: 'code-audit', status: 'completed', durationMs: 4200, nodes: 3, startedAt: 1_700_000_000_000 },
    active: false, onSelect: () => {},
  }))
  assert.match(healthy, /code-audit/)
  assert.match(healthy, /已完成/)
  assert.match(healthy, /3 次调用/)
  // The workflow id must keep its own casing.
  assert.equal(healthy.includes('CODE-AUDIT'), false)

  const failed = textOf(RunCard({
    run: { runId: 'r2', workflowId: 'code-audit', status: 'failed', durationMs: 300, nodes: 1, failure: '子代理没有提交结果' },
    active: true, onSelect: () => {},
  }))
  assert.match(failed, /失败/)
  assert.match(failed, /子代理没有提交结果/)
})

test('render: the compact switcher collapses history into one control', async () => {
  const client = await loadClientForRender()
  const { RunSwitcher } = client.__internals
  const runs = [
    { runId: 'r1', workflowId: 'code-audit', status: 'completed', durationMs: 4200, nodes: 3, resumeCount: 2 },
    { runId: 'r2', workflowId: 'other', status: 'failed', durationMs: 300, nodes: 1 },
  ]
  const text = textOf(RunSwitcher({ runs, selectedId: 'r1', onSelect: () => {} }))
  assert.match(text, /code-audit/)
  assert.match(text, /2 次/)
  // Collapsed: the second run is not rendered until the switcher is opened.
  assert.equal(text.includes('other'), false)
})


test('the run tool reaches the sandbox seam instead of throwing a ReferenceError', async () => {
  const { apply } = await import('../index.mjs')
  const registered = []
  const listeners = []
  const ctx = {
    tools: { register: (definition) => { registered.push(definition); return () => {} } },
    on: (event, handler) => { listeners.push(event); return () => {} },
    effect: (fn) => { fn(); return () => {} },
    inject: () => {},
    get(name) {
      if (name === 'workingDirectory') return { get: () => '/tmp', ensure: async () => '/tmp' }
      if (name === 'agents') return { create: async () => ({ agent: { id: 'child', followup() {}, whenIdle: async () => {} }, dispose: async () => {} }), resume: async () => ({ agent: { id: 'child' }, dispose: async () => {} }) }
      if (name === 'subagents') return { sendMessage: async () => {} }
      if (name === 'sandbox') return { confine: async (argv) => ({ argv }) }
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'read-only', workspaceRoot: '/tmp' }) }
      if (name === 'subprocess') return { spawn() { throw new Error('no subprocess in this test') } }
      return undefined
    },
  }
  apply(ctx, { journalFile: ':memory:' })
  const run = registered.find((definition) => definition.name === 'run_zcode_workflow')
  assert.ok(run !== undefined)

  // A missing spawn is a structured failure. An undeclared identifier anywhere
  // on this path (the `maxTotalAgents` regression) would surface as a thrown
  // ReferenceError instead, which is what this asserts cannot happen.
  const result = await run.execute({ script: 'return 1' }, { agent: { id: 'sess-parent' } })
  assert.equal(typeof result, 'object')
  assert.match(result.error.message, /sandbox could not start/)
  assert.match(result.error.message, /no subprocess in this test/)
})


test('a resumed run says so, and how much it replayed', async () => {
  const { renderEnvelope } = await import('../index.mjs')
  const text = renderEnvelope({
    workflowId: 'resume-probe',
    runId: 'dwfrun-x',
    status: 'failed',
    error: { message: 'deliberate failure' },
    resumed: true,
    resumeCount: 1,
    cachedNodes: 3,
  })
  // The run id is deliberately identical across attempts, so the report itself
  // must carry the distinction.
  assert.match(text, /resumed: attempt 1, 3 completed step\(s\) replayed from the journal \(0 model calls for those steps\)/)
  assert.match(text, /deliberate failure/)

  const fresh = renderEnvelope({
    workflowId: 'resume-probe', runId: 'dwfrun-x', status: 'failed', error: { message: 'x' },
  })
  assert.equal(/resumed:/.test(fresh), false, 'a first attempt must not claim to be a resume')
})


test('resume: an unknown id and a legacy run without a plan are both refused', async () => {
  const { apply } = await import('../index.mjs')
  const { openJournal } = await import('../src/engine/journal.mjs')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const directory = await mkdtemp(join(tmpdir(), 'zcode-resume-legacy-'))
  const file = join(directory, 'runs.db')
  try {
    const seed = openJournal({ file })
    // A run written by an earlier build: failed, but with no stored plan.
    seed.createRun({
      id: 'run-legacy', parentSessionId: 'sess-me', cwd: directory, name: 'legacy',
      scriptText: 'lowered', scriptHash: null, args: {}, capsMaxConcurrency: 1,
    })
    seed.settleRun('run-legacy', { status: 'failed', failure: { message: 'old failure' } })
    seed.close()

    const registered = []
    const ctx = {
      tools: { register: (definition) => { registered.push(definition); return () => {} } },
      on: () => () => {},
      effect: (fn) => { fn(); return () => {} },
      inject: () => {},
      get: () => undefined,
    }
    apply(ctx, { journalFile: file })
    const resume = registered.find((definition) => definition.name === 'resume_zcode_workflow')

    const unknown = await resume.execute({ run_id: 'nope' }, { agent: { id: 'sess-me' } })
    assert.match(unknown.error.message, /no run/)

    const legacy = await resume.execute({ run_id: 'run-legacy' }, { agent: { id: 'sess-me' } })
    assert.match(legacy.error.message, /recorded before resumable journals existed/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('resume: a run from another session is refused', async () => {
  const { apply } = await import('../index.mjs')
  const { openJournal } = await import('../src/engine/journal.mjs')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const directory = await mkdtemp(join(tmpdir(), 'zcode-resume-guard-'))
  const file = join(directory, 'runs.db')
  try {
    const seed = openJournal({ file })
    seed.createRun({
      id: 'run-other', parentSessionId: 'sess-other', cwd: directory, name: 'x',
      scriptText: 'lowered', scriptHash: 'h', plan: { source: 'return 1' },
      args: {}, capsMaxConcurrency: 1,
    })
    seed.settleRun('run-other', { status: 'failed', failure: { message: 'boom' } })
    seed.close()

    const registered = []
    const ctx = {
      tools: { register: (definition) => { registered.push(definition); return () => {} } },
      on: () => () => {},
      effect: (fn) => { fn(); return () => {} },
      inject: () => {},
      get: () => undefined,
    }
    apply(ctx, { journalFile: file })
    const resume = registered.find((definition) => definition.name === 'resume_zcode_workflow')
    const result = await resume.execute({ run_id: 'run-other' }, { agent: { id: 'sess-me' } })
    assert.match(result.error.message, /belongs to another session/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('resume: a completed run cannot be resumed', async () => {
  const { apply } = await import('../index.mjs')
  const { openJournal } = await import('../src/engine/journal.mjs')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const directory = await mkdtemp(join(tmpdir(), 'zcode-resume-done-'))
  const file = join(directory, 'runs.db')
  try {
    const seed = openJournal({ file })
    seed.createRun({
      id: 'run-done', parentSessionId: 'sess-me', cwd: directory, name: 'x',
      scriptText: 'lowered', scriptHash: 'h', plan: { source: 'return 1' },
      args: {}, capsMaxConcurrency: 1,
    })
    seed.settleRun('run-done', { status: 'completed', result: { value: 1 } })
    seed.close()

    const registered = []
    const ctx = {
      tools: { register: (definition) => { registered.push(definition); return () => {} } },
      on: () => () => {},
      effect: (fn) => { fn(); return () => {} },
      inject: () => {},
      get: () => undefined,
    }
    apply(ctx, { journalFile: file })
    const resume = registered.find((definition) => definition.name === 'resume_zcode_workflow')
    const result = await resume.execute({ run_id: 'run-done' }, { agent: { id: 'sess-me' } })
    assert.match(result.error.message, /only a failed or cancelled run can be resumed/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})


test('the pool event sink persists rehydration but ignores per-turn noise', async () => {
  const { journalEventSink } = await import('../index.mjs')
  const { openJournal } = await import('../src/engine/journal.mjs')
  const journal = openJournal()
  try {
    journal.createRun({ id: 'r1', parentSessionId: 's', cwd: '/w', name: 'n', capsMaxConcurrency: 1 })
    const sink = journalEventSink(journal, 'r1')
    sink({ type: 'actor-rehydrated', siteId: 'actor#1', ordinal: 1, previousSessionId: 'old', sessionId: 'new' })
    sink({ type: 'actor-created', siteId: 'actor#1', ordinal: 1 })
    sink({ type: 'actor-resumed', siteId: 'actor#1', ordinal: 1, sessionId: 'same' })
    sink({ type: 'ask-start', siteId: 'ask#1', ordinal: 1 })
    sink({ type: 'ask-end', siteId: 'ask#1', ordinal: 1, ok: true })

    const types = journal.listEvents('r1').map((event) => event.type)
    assert.deepEqual(types, ['actor-rehydrated', 'actor-created', 'actor-resumed'])
    const rehydrated = journal.listEvents('r1')[0]
    assert.equal(rehydrated.payload.sessionId, 'new')
    assert.equal(rehydrated.payload.previousSessionId, 'old')
  } finally {
    journal.close()
  }
})


test('cold start: a late sidebarRightTabs service still registers the tab', async () => {
  const client = await loadClientModule()
  const injected = []
  const registered = []
  const deferred = []
  let disposedHandle = 0

  const ctx = {
    slots: {
      inject(name, register) { injected.push(name); return register() },
      register(definition, component) { registered.push({ definition, component }); return () => {} },
    },
    // On a desktop cold start the sidebar-right plugin has not provided this yet.
    get: () => undefined,
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    inject(deps, callback) {
      deferred.push({ deps, callback })
      return () => { disposedHandle += 1 }
    },
  }
  const dispose = client.apply(ctx)

  // The core surfaces work even while the right column is not ready.
  assert.deepEqual(injected.sort(), ['main', 'sidebar.footer.action'])
  assert.equal(registered.length, 2)
  assert.equal(deferred.length, 1)
  assert.deepEqual(deferred[0].deps, ['sidebarRightTabs'])

  // Nothing may be registered for the right column yet.
  assert.equal(registered.some((row) => row.definition.name === 'sidebar.right.pane.tab'), false)

  // The service appears later: the deferred callback fills both registrations.
  const tabTypes = []
  const rightCtx = {
    get: (name) => (name === 'sidebarRightTabs'
      ? { register(definition) { tabTypes.push(definition); return () => {} } }
      : undefined),
    slots: ctx.slots,
    effect: ctx.effect,
  }
  deferred[0].callback(rightCtx)

  assert.equal(tabTypes.length, 1)
  assert.equal(tabTypes[0].id, 'zcode-workflow')
  assert.equal(tabTypes[0].guide[0].id, 'zcode-workflow')
  assert.equal(injected.includes('sidebar.right.pane.tab'), true)
  const body = registered.find((row) => row.definition.name === 'sidebar.right.pane.tab')
  assert.equal(body.definition.key, 'zcode-workflow')

  // The Host renders this seat with `{ sessionId }` only, so the registered
  // component must be a wrapper that injects the plugin context itself.
  assert.equal(typeof body.component, 'function')
  assert.notEqual(body.component, client.__internals.WorkflowRightTab)

  // The deferred handle is part of the plugin's disposal chain.
  dispose()
  assert.equal(disposedHandle, 1)
})

test('footer selectPanel: an openTab failure falls back to layout, else returns false', async () => {
  const client = await loadClientModule()

  const build = (services) => {
    const registered = []
    const ctx = {
      slots: {
        inject(_name, register) { return register() },
        register(definition, component) { registered.push({ definition, component }); return () => {} },
      },
      get: (name) => services[name],
      effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    }
    client.apply(ctx)
    const foot = registered.find((row) => row.definition.name === 'sidebar.footer.action')
    return foot.definition.inject()
  }

  // openTab throws (no active conversation); the layout service takes over.
  const layoutCalls = []
  const withFallback = build({
    sidebarRight: { openTab() { throw new Error('no active conversation') } },
    layout: { selectPanel: (id) => layoutCalls.push(id) },
  })
  assert.equal(withFallback.selectPanel(), true)
  assert.deepEqual(layoutCalls, ['zcode-workflow'])

  // Nothing usable: report false instead of throwing into React.
  const nothing = build({})
  assert.equal(nothing.selectPanel(), false)

  // openTab itself throwing and no layout service is also a clean false.
  const throwingOnly = build({ sidebarRight: { openTab() { throw new Error('gone') } } })
  assert.equal(throwingOnly.selectPanel(), false)
})


test('warm start: an already-provided sidebarRightTabs registers synchronously', async () => {
  const client = await loadClientModule()
  const tabTypes = []
  const registered = []
  const ctx = {
    slots: {
      inject(name, register) { return register() },
      register(definition, component) { registered.push({ definition, component }); return () => {} },
    },
    get: () => undefined,
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    // Cordis calls the callback right away when every dependency is active.
    inject(deps, callback) {
      assert.deepEqual(deps, ['sidebarRightTabs'])
      return callback({
        get: (name) => (name === 'sidebarRightTabs'
          ? { register(definition) { tabTypes.push(definition); return () => {} } }
          : undefined),
        slots: ctx.slots,
        effect: ctx.effect,
      })
    },
  }
  client.apply(ctx)
  assert.equal(tabTypes.length, 1)
  assert.equal(tabTypes[0].id, 'zcode-workflow')
  // Exactly one body registration: the synchronous path must not also run the
  // no-inject fallback.
  assert.equal(registered.filter((row) => row.definition.name === 'sidebar.right.pane.tab').length, 1)
})
