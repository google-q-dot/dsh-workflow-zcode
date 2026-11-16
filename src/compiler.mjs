/**
 * The TypeScript compile + lowering pass that turns a ZCode `.dwf.ts` body
 * into a plain-JavaScript DSH workflow script.
 *
 * The pipeline mirrors ZCode's `analyzeWorkflowScript` → `compileProgram` →
 * `lowering` sequence:
 *
 * 1. wrap the author's body in `async function __workflowScript__() { … }`
 *    beside a virtual `workflow-facade.d.ts`, so the facade names resolve and
 *    `declare`/`export` inside a function body produce their TS1184 error;
 * 2. run the type checker (`getSyntacticDiagnostics` + `getSemanticDiagnostics`);
 * 3. collect call sites in source order and assign ZCode's site ids
 *    (`actor#N`, `ask#N`, `world-read#N`, `report#N`, `artifact#N`);
 * 4. run the cheap authoring diagnostics (9003–9007);
 * 5. transform the wrapper with the TypeScript transformer API and print only
 *    the body — the `lowered` text a runtime executes.
 *
 * TypeScript is an optional peer dependency: the plugin keeps working when it
 * is absent, and `compile()` reports `{ ok: false, code: 'typescript-missing' }`
 * instead of throwing.
 *
 * @module dsh-workflow-zcode/compiler
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

/** Diagnostic codes, mirroring ZCode's 9001–9009 vocabulary. */
export const DIAGNOSTIC = {
  facadeReference: 9001,
  askSchema: 9002,
  worldCommandLiteral: 9003,
  phaseMarker: 9004,
  duplicateActorName: 9005,
  fanoutActorName: 9006,
  artifactId: 9007,
  primaryConflict: 9008,
  artifactHoisting: 9009,
}

const FACADE_FILE = '/virtual/workflow-facade.d.ts'

/** Facade names whose call sites carry a runtime hook. */
const FACADE_MEMBERS = new Set(['agent', 'phase', 'log', 'report', 'artifact', 'files', 'git', 'world'])
const SCRIPT_FILE = '/virtual/workflow-script.ts'

/** Runtime hook names the lowering emits. */
export const HOST_MEMBER = {
  createActor: '__zcodeCreateActor',
  ask: '__zcodeAsk',
  readWorld: '__zcodeReadWorld',
  report: '__zcodeReport',
  artifact: '__zcodeArtifact',
  enterPhase: '__zcodePhase',
  log: '__zcodeLog',
}

const WORLD_OPS = new Map([
  ['glob', 'files.glob'],
  ['read', 'files.read'],
  ['grep', 'files.grep'],
  ['changedFiles', 'git.changedFiles'],
  ['diff', 'git.diff'],
  ['status', 'git.status'],
  ['log', 'git.log'],
  ['run', 'world.run'],
])

/**
 * Load TypeScript, reporting absence as a structured result.
 * @returns {{ ok: true, ts: any } | { ok: false, message: string }}
 */
export function loadTypeScript() {
  try {
    return { ok: true, ts: requireTypeScript() }
  } catch (error) {
    return {
      ok: false,
      message:
        `the ZCode workflow compiler needs the \`typescript\` package to type-check and lower scripts `
        + `(${error instanceof Error ? error.message : String(error)}). Install it in the profile `
        + '(`pnpm add typescript`) or turn off `typeCheck` to run scripts without compile-time diagnostics.',
    }
  }
}

function requireTypeScript() {
  // `createRequire` is the standard way an ESM plugin reaches a CommonJS peer.
  return createRequire(import.meta.url)('typescript')
}

/**
 * Compile a ZCode workflow body into lowerable form.
 *
 * @param {object} input
 * @param {string} input.body the script body (front matter already removed)
 * @param {string} input.facade the facade declaration text
 * @param {any} input.ts the TypeScript module
 * @param {number} [input.bodyLineOffset] lines above the body, for absolute positions
 * @returns {CompileResult}
 */
export function compile({ body, facade, ts, bodyLineOffset = 0 }) {
  const wrapped = `async function __workflowScript__() {\n${body}\n}\nexport {};\n`
  const files = new Map([
    [SCRIPT_FILE, wrapped],
    [FACADE_FILE, facade],
  ])
  // The default lib has to be reachable through the same virtual file names the
  // host answers for, or every global type (Promise, Error, Array…) goes missing.
  const libName = 'lib.es2022.d.ts'
  const libText = readLib(ts, libName)
  if (libText !== undefined) {
    files.set(`/virtual/${libName}`, libText)
    // lib.es2022.d.ts `/// <reference lib="es2021" />`-chains to its
    // predecessors; load the whole family so the chain resolves.
    for (const name of LIB_FAMILY) {
      const text = name === libName ? libText : readLib(ts, name)
      if (text !== undefined) files.set(`/virtual/${name}`, text)
    }
    // The virtual program's roots are the script, the facade and the default
    // lib; the family members it references enter through the host.
  }

  // `lib` is deliberately omitted: the default lib for this target is loaded
  // into the virtual tree instead, and naming it here would make the checker
  // resolve a second copy through a different path.
  const options = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: [],
    skipLibCheck: true,
    noUncheckedIndexedAccess: false,
  }

  const host = {
    getSourceFile: (fileName, languageVersion) => {
      const text = files.get(fileName)
      return text === undefined ? undefined : ts.createSourceFile(fileName, text, languageVersion, true)
    },
    getDefaultLibFileName: () => '/virtual/lib.es2022.d.ts',
    writeFile: () => {},
    getCurrentDirectory: () => '/virtual',
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (fileName) => files.has(fileName),
    readFile: (fileName) => files.get(fileName),
    directoryExists: () => true,
    getDirectories: () => [],
  }

  const roots = [SCRIPT_FILE, FACADE_FILE]
  if (files.has(`/virtual/${libName}`)) roots.push(`/virtual/${libName}`)
  const program = ts.createProgram({ rootNames: roots, options, host })
  const source = program.getSourceFile(SCRIPT_FILE)
  if (source === undefined) {
    return { ok: false, diagnostics: [{ code: 0, message: 'the workflow body produced no source file', line: 1, column: 1 }] }
  }

  /** @type {Diagnostic[]} */
  const diagnostics = []
  for (const diagnostic of [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)]) {
    const mapped = toDiagnostic(ts, diagnostic, source, bodyLineOffset)
    if (mapped !== undefined) diagnostics.push(mapped)
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics }

  const sites = collectSites(ts, source, program)
  const authoring = authoringDiagnostics(ts, source, sites, bodyLineOffset)
  if (authoring.length > 0) return { ok: false, diagnostics: authoring }

  const transformed = lower(ts, source, sites)
  if (transformed === undefined) {
    return { ok: false, diagnostics: [{ code: 0, message: 'lowering produced no output', line: 1, column: 1 }] }
  }

  return {
    ok: true,
    diagnostics: [],
    code: transformed.code,
    sourceMapText: transformed.sourceMap,
    lineOffset: transformed.lineOffset + bodyLineOffset,
    sites: siteSummary(sites),
    askSchemas: collectAskSchemas(ts, source, program, sites),
    commands: sites.worldRuns.map((site) => site.command),
    phases: sites.phases.map((site) => site.name),
    actors: sites.actors.map((site) => ({ id: site.id, name: site.name, persona: site.persona ?? null })),
    artifacts: sites.artifacts.map((site) => ({ id: site.id, op: site.op, artifactId: site.artifactId })),
  }
}

/**
 * Virtual lib files materialized into the program: every `lib.es20*.d.ts`
 * ZCode's compiler option (`lib: ["lib.es2022.d.ts"]`, `types: []`) pulls in,
 * plus the `//#region`-free remainder of that chain. The `lib.es2022*` files
 * themselves are the reference set; the older family files are their
 * `/// <reference lib="…" />` targets.
 */
const LIB_FAMILY = [
  'lib.es5.d.ts',
  'lib.es2015.d.ts',
  'lib.es2015.collection.d.ts',
  'lib.es2015.core.d.ts',
  'lib.es2015.generator.d.ts',
  'lib.es2015.iterable.d.ts',
  'lib.es2015.promise.d.ts',
  'lib.es2015.proxy.d.ts',
  'lib.es2015.reflect.d.ts',
  'lib.es2015.symbol.d.ts',
  'lib.es2015.symbol.wellknown.d.ts',
  'lib.es2016.d.ts',
  'lib.es2016.array.include.d.ts',
  'lib.es2016.intl.d.ts',
  'lib.es2017.d.ts',
  'lib.es2017.arraybuffer.d.ts',
  'lib.es2017.date.d.ts',
  'lib.es2017.intl.d.ts',
  'lib.es2017.object.d.ts',
  'lib.es2017.sharedmemory.d.ts',
  'lib.es2017.string.d.ts',
  'lib.es2017.typedarrays.d.ts',
  'lib.es2018.d.ts',
  'lib.es2018.asyncgenerator.d.ts',
  'lib.es2018.asynciterable.d.ts',
  'lib.es2018.intl.d.ts',
  'lib.es2018.promise.d.ts',
  'lib.es2018.regexp.d.ts',
  'lib.es2019.d.ts',
  'lib.es2019.array.d.ts',
  'lib.es2019.intl.d.ts',
  'lib.es2019.object.d.ts',
  'lib.es2019.string.d.ts',
  'lib.es2019.symbol.d.ts',
  'lib.es2020.d.ts',
  'lib.es2020.bigint.d.ts',
  'lib.es2020.date.d.ts',
  'lib.es2020.intl.d.ts',
  'lib.es2020.number.d.ts',
  'lib.es2020.promise.d.ts',
  'lib.es2020.sharedmemory.d.ts',
  'lib.es2020.string.d.ts',
  'lib.es2020.symbol.wellknown.d.ts',
  'lib.es2021.d.ts',
  'lib.es2021.intl.d.ts',
  'lib.es2021.promise.d.ts',
  'lib.es2021.string.d.ts',
  'lib.es2021.weakref.d.ts',
  'lib.es2022.d.ts',
  'lib.es2022.array.d.ts',
  'lib.es2022.error.d.ts',
  'lib.es2022.intl.d.ts',
  'lib.es2022.object.d.ts',
  'lib.es2022.regexp.d.ts',
  'lib.es2022.string.d.ts',
]

function readLib(ts, name) {
  try {
    const base = ts.getDefaultLibFilePath?.({ target: ts.ScriptTarget.ES2022 })
    if (typeof base !== 'string' || base.length === 0) return undefined
    const directory = base.slice(0, base.lastIndexOf('/'))
    return readFileSync(`${directory}/${name}`, 'utf8')
  } catch {
    return undefined
  }
}

function toDiagnostic(ts, diagnostic, source, bodyLineOffset) {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
  const position = diagnostic.file !== undefined && diagnostic.start !== undefined
    ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
    : undefined
  // The wrapper adds one line before the author's body.
  const line = position === undefined ? 1 : Math.max(1, position.line + bodyLineOffset)
  return {
    code: diagnostic.code,
    message,
    line,
    column: position === undefined ? 1 : position.character + 1,
    source: 'typescript',
  }
}

/**
 * Walk the wrapper body in AST order and record every facade call site with
 * its ZCode site id. Ids are assigned in source order — ZCode keys its journal
 * on them, so the assignment order is part of the contract, not an accident.
 */
export function collectSites(ts, source, program) {
  const checker = program.getTypeChecker()
  const sites = {
    actors: [],
    asks: [],
    worldReads: [],
    worldRuns: [],
    reports: [],
    artifacts: [],
    phases: [],
    logs: [],
    names: new Map(),
  }
  const counters = { actor: 0, ask: 0, 'world-read': 0, report: 0, artifact: 0 }
  const names = sites.names
  let currentPhase

  const walk = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const directName = calleeName(ts, checker, callee)
      if (directName === 'agent') {
        counters.actor += 1
        const id = `actor#${counters.actor}`
        const name = stringLiteral(ts, node.arguments[0])
        if (name !== undefined) {
          const list = names.get(name) ?? []
          list.push(node)
          names.set(name, list)
        }
        sites.actors.push({ id, name, node, phase: currentPhase, persona: personaOf(ts, node.arguments[1]) })
      } else if (directName === 'phase') {
        const name = stringLiteral(ts, node.arguments[0])
        if (name !== undefined) currentPhase = name
        // A phase label may be assembled at run time (`"Phase 1 · " + id`); the
        // origin accepts that, so the static name is only a fast path here.
        sites.phases.push({ name, node, stringy: isStringValued(ts, node.arguments[0]) })
      } else if (directName === 'log') {
        sites.logs.push({ node })
      } else if (directName === 'report') {
        counters.report += 1
        sites.reports.push({
          id: `report#${counters.report}`,
          node,
          artifactId: stringLiteral(ts, node.arguments[1]),
          phase: currentPhase,
        })
      }

      if (ts.isPropertyAccessExpression(callee)) {
        const holder = callee.expression
        const member = callee.name.text
        // `ask` is checked FIRST and independently of the receiver's shape:
        // `agent(...).ask<T>()`, `(cond ? a : b).ask()`, `pool[i].ask()` and
        // `helper().ask()` all have a non-identifier receiver. The facade
        // check below is what keeps a user object's own `.ask()` out.
        if (member === 'ask' && isFacadeAsk(ts, checker, node)) {
          counters.ask += 1
          sites.asks.push({
            id: `ask#${counters.ask}`,
            node,
            typed: node.typeArguments !== undefined && node.typeArguments.length > 0,
            phase: currentPhase,
          })
        } else if (ts.isIdentifier(holder)) {
          const holderName = calleeName(ts, checker, holder)
          if (holderName === 'world' && member === 'run') {
            counters['world-read'] += 1
            const command = stringLiteral(ts, node.arguments[0])
            sites.worldReads.push({ id: `world-read#${counters['world-read']}`, op: 'run', node, command })
            sites.worldRuns.push({ command: command ?? '<non-literal>', node })
          } else if (holderName === 'files' || holderName === 'git') {
            counters['world-read'] += 1
            sites.worldReads.push({
              id: `world-read#${counters['world-read']}`,
              op: `${holderName}.${member}`,
              node,
              command: undefined,
            })
          } else if (holderName === 'artifact') {
            counters.artifact += 1
            sites.artifacts.push({
              id: `artifact#${counters.artifact}`,
              op: member,
              node,
              artifactId: stringLiteral(ts, node.arguments[0]),
              options: node.arguments[node.arguments.length - 1],
            })
          }
        }
      }
    }
    ts.forEachChild(node, walk)
  }

  const wrapper = source.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === '__workflowScript__')
  if (wrapper?.body !== undefined) {
    for (const statement of wrapper.body.statements) walk(statement)
  }
  return sites
}

/**
 * Is this `X.ask(...)` a call into the facade's `Agent.ask`?
 *
 * The name alone is not enough: a script may define its own object with an
 * `ask` method. Two independent checks resolve the callee back to the virtual
 * facade file, and either one is enough:
 *
 * 1. the symbol of the property name (`Agent.ask` from the .d.ts);
 * 2. the resolved signature's declaration — this covers union receivers,
 *    conditional expressions, generic helpers returning `Agent`, and
 *    interfaces that `extend Agent`, where the symbol may resolve to a copy.
 */
function isFacadeAsk(ts, checker, node) {
  if (!ts.isPropertyAccessExpression(node.expression)) return false
  if (node.expression.name.text !== 'ask') return false

  const symbol = checker.getSymbolAtLocation(node.expression.name)
  for (const declaration of symbol?.declarations ?? []) {
    if (declaration.getSourceFile?.().fileName !== FACADE_FILE) continue
    const name = declaration.name?.getText?.()
    if (name === 'ask') return true
  }

  const signature = checker.getResolvedSignature(node)
  const declaration = signature?.getDeclaration?.() ?? signature?.declaration
  if (declaration !== undefined) {
    if (declaration.getSourceFile?.().fileName === FACADE_FILE && declaration.name?.getText?.() === 'ask') {
      return true
    }
  }
  return false
}

/**
 * The facade member a callee identifier refers to, or undefined when the
 * identifier does not resolve into the facade declaration file.
 */
function calleeName(ts, checker, node) {
  if (!ts.isIdentifier(node)) return undefined
  const symbol = checker.getSymbolAtLocation(node)
  if (symbol === undefined) return undefined
  const declaration = symbol.declarations?.[0]
  if (declaration !== undefined && declaration.getSourceFile?.().fileName !== FACADE_FILE) return undefined
  const name = symbol.getName()
  return FACADE_MEMBERS.has(name) ? name : undefined
}

/** Read an actor persona literal: a string, or an object whose `system` is a literal. */
function personaOf(ts, node) {
  if (node === undefined) return null
  const asText = stringLiteral(ts, node)
  if (asText !== undefined) return { system: asText }
  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) continue
      const key = property.name.getText().replace(/^['"]|['"]$/gu, '')
      if (key !== 'system') continue
      const value = stringLiteral(ts, property.initializer)
      if (value !== undefined) return { system: value }
      if (ts.isTemplateExpression(property.initializer)) return { system: property.initializer.getText() }
    }
  }
  return null
}

function stringLiteral(ts, node) {
  if (node === undefined) return undefined
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return undefined
}

function authoringDiagnostics(ts, source, sites, bodyLineOffset) {
  /** @type {Diagnostic[]} */
  const out = []
  const at = (node) => {
    const position = source.getLineAndCharacterOfPosition(node.getStart(source))
    return { line: Math.max(1, position.line + bodyLineOffset), column: position.character + 1 }
  }

  for (const actor of sites.actors) {
    // 9005: two statically-known actors sharing a name.
    if (actor.name === undefined) continue
    const all = sites.names.get(actor.name) ?? []
    if (all.length > 1 && all[0] === actor.node) {
      out.push({
        code: DIAGNOSTIC.duplicateActorName,
        message: `two workflow subagents are named "${actor.name}"; a non-empty name is an identity and must be unique within a run`,
        source: 'workflow',
        ...at(actor.node),
      })
    }
  }

  for (const run of sites.worldRuns) {
    if (run.command !== '<non-literal>') continue
    out.push({
      code: DIAGNOSTIC.worldCommandLiteral,
      message:
        'world.run() requires a compile-time string literal command: the command set is shown to the user '
        + 'before the run and only those commands may execute; pass runtime values inside the args array',
      source: 'workflow',
      ...at(run.node),
    })
  }

  for (const phase of sites.phases) {
    if (phase.name !== undefined && phase.name.trim() !== '') continue
    // A runtime string expression is still a visible label; only a provably
    // non-string argument (a number, an object, a boolean, nothing at all) is a
    // real authoring error.
    if (phase.stringy === true) continue
    out.push({
      code: DIAGNOSTIC.phaseMarker,
      message: 'phase() requires a non-empty string: the phase name is the label the user sees',
      source: 'workflow',
      ...at(phase.node),
    })
  }

  const seenArtifacts = new Map()
  for (const artifact of sites.artifacts) {
    if (artifact.artifactId === undefined || artifact.artifactId === '' || artifact.artifactId.length > 64 || !/^[A-Za-z0-9_.-]+$/.test(artifact.artifactId)) {
      out.push({
        code: DIAGNOSTIC.artifactId,
        message:
          'artifact ids must be compile-time string literals of 1–64 characters from [A-Za-z0-9_.-]; '
          + 'what a run can publish is fixed at submit time',
        source: 'workflow',
        ...at(artifact.node),
      })
      continue
    }
    const previous = seenArtifacts.get(artifact.artifactId)
    if (previous !== undefined && previous !== artifact.op) {
      out.push({
        code: DIAGNOSTIC.artifactId,
        message: `artifact id "${artifact.artifactId}" is used for both ${previous} and ${artifact.op}; one id belongs to one member`,
        source: 'workflow',
        ...at(artifact.node),
      })
    }
    seenArtifacts.set(artifact.artifactId, artifact.op)
  }

  return out
}

/**
 * Whether an expression can produce a string at run time.
 *
 * Deliberately permissive: rejecting a `+` expression or a template literal
 * would fail real workflows that build a phase label from a scene id. Only
 * shapes that can never be a string are refused.
 *
 * @param {any} ts
 * @param {any} node
 * @returns {boolean}
 */
function isStringValued(ts, node) {
  if (node === undefined) return false
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true
  if (ts.isTemplateExpression(node)) return true
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return true
  if (ts.isIdentifier(node)) return true
  if (ts.isPropertyAccessExpression(node)) return true
  if (ts.isCallExpression(node)) return true
  if (ts.isElementAccessExpression(node)) return true
  if (ts.isConditionalExpression(node)) return true
  if (ts.isParenthesizedExpression(node)) return isStringValued(ts, node.expression)
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) return isStringValued(ts, node.expression)
  return false
}

/**
 * The TypeScript transformer: facade calls become `__zcode*` runtime hooks.
 * The returned code is the printed body of the wrapper function, transpiled to
 * JavaScript — the `lowered` text.
 */
export function lower(ts, source, sites) {
  const factory = ts.factory
  const host = (member) => factory.createIdentifier(member)
  const call = (member, args) => factory.createCallExpression(host(member), undefined, args)

  const askSite = new Map(sites.asks.map((site) => [site.node, site.id]))
  const worldSite = new Map(sites.worldReads.map((site) => [site.node, site]))

  const transformer = (context) => {
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression
        if (ts.isIdentifier(callee)) {
          const name = callee.text
          if (name === 'phase') {
            return call(HOST_MEMBER.enterPhase, [node.arguments[0] ?? factory.createStringLiteral('')])
          }
          if (name === 'log') {
            return call(HOST_MEMBER.log, [node.arguments[0] ?? factory.createStringLiteral('')])
          }
          if (name === 'report') {
            const args = [node.arguments[0] ?? factory.createVoidZero()]
            if (node.arguments[1] !== undefined) args.push(node.arguments[1])
            return call(HOST_MEMBER.report, args)
          }
          if (name === 'agent') {
            return call(HOST_MEMBER.createActor, node.arguments.map((argument) => ts.visitNode(argument, visit)))
          }
        }
        if (ts.isPropertyAccessExpression(callee)) {
          const member = callee.name.text
          const siteId = askSite.get(node)
          if (siteId !== undefined) {
            return call(HOST_MEMBER.ask, [
              factory.createStringLiteral(siteId),
              ts.visitNode(callee.expression, visit),
              ...node.arguments.map((argument) => ts.visitNode(argument, visit)),
            ])
          }
          const world = worldSite.get(node)
          if (world !== undefined) {
            return call(HOST_MEMBER.readWorld, [
              factory.createStringLiteral(world.id),
              factory.createStringLiteral(world.op),
              factory.createArrayLiteralExpression(node.arguments.map((argument) => ts.visitNode(argument, visit))),
            ])
          }
          if (ts.isIdentifier(callee.expression) && callee.expression.text === 'artifact') {
            return call(HOST_MEMBER.artifact, [
              factory.createStringLiteral(member),
              ...node.arguments.map((argument) => ts.visitNode(argument, visit)),
            ])
          }
        }
      }
      if (ts.isIdentifier(node) && node.text === 'args') {
        const parent = node.parent
        const isPropertyName = parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.name === node
        if (!isPropertyName) return factory.createIdentifier('__zcodeArgs')
      }
      return ts.visitEachChild(node, visit, context)
    }

    return (root) => ts.visitNode(root, visit)
  }

  const result = ts.transform(source, [transformer], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  })
  try {
    const transformedFile = result.transformed[0]
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: false })
    const printed = printer.printFile(transformedFile)
    const bodyText = extractWrapperBody(ts, transformedFile, printer)
    if (bodyText === undefined) return undefined
    const transpiled = ts.transpileModule(bodyText, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        isolatedModules: false,
        removeComments: false,
        newLine: ts.NewLineKind.LineFeed,
      },
    })
    return { code: transpiled.outputText, sourceMap: undefined, lineOffset: 0, printed }
  } finally {
    result.dispose()
  }
}

function extractWrapperBody(ts, file, printer) {
  for (const statement of file.statements) {
    if (!ts.isFunctionDeclaration(statement) || statement.name?.text !== '__workflowScript__') continue
    if (statement.body === undefined) return undefined
    return statement.body.statements.map((inner) => printer.printNode(ts.EmitHint.Unspecified, inner, file)).join('\n')
  }
  return undefined
}

/**
 * Convert `ask<T>()` type parameters into JSON Schema — the wire contract the
 * runtime validates structured subagent output against.
 */
export function collectAskSchemas(ts, source, program, sites) {
  const checker = program.getTypeChecker()
  /** @type {Map<string, unknown>} */
  const schemas = new Map()
  for (const site of sites.asks) {
    if (site.typed !== true) continue
    // ask<T>() is declared to return Node<T> (a thenable). Read the awaited
    // value type, so the schema describes what `await` actually yields.
    const signature = checker.getResolvedSignature(site.node)
    let type = signature === undefined ? undefined : checker.getAwaitedType(checker.getReturnTypeOfSignature(signature))
    if (type === undefined) {
      const typeNode = site.node.typeArguments[0]
      type = checker.getTypeFromTypeNode(typeNode)
    }
    const schema = typeToSchema(ts, checker, type, new Set())
    if (schema !== undefined) schemas.set(site.id, schema)
  }
  return [...schemas.entries()].map(([siteId, schema]) => ({ siteId, schema }))
}

function typeToSchema(ts, checker, type, seen) {
  if (type === undefined || type === null) return undefined
  if (seen.has(type)) return undefined
  seen.add(type)
  try {
    const flags = type.flags
    if (flags & ts.TypeFlags.String) return { type: 'string' }
    if (flags & ts.TypeFlags.Number) return { type: 'number' }
    if (flags & ts.TypeFlags.Boolean) return { type: 'boolean' }
    if (flags & ts.TypeFlags.StringLiteral) return { type: 'string', const: type.value }
    if (flags & ts.TypeFlags.NumberLiteral) return { type: 'number', const: type.value }
    if (flags & ts.TypeFlags.BooleanLiteral) return { type: 'boolean', const: type.intrinsicName === 'true' }
    if (flags & ts.TypeFlags.Null) return { type: 'null' }
    if (flags & ts.TypeFlags.Undefined) return undefined
    if (flags & ts.TypeFlags.Any) return undefined
    if (flags & ts.TypeFlags.EnumLike) return { type: 'string' }

    if (type.isUnion?.() === true) {
      const members = []
      for (const member of type.types) {
        const schema = typeToSchema(ts, checker, member, seen)
        if (schema !== undefined) members.push(schema)
      }
      if (members.length === 0) return undefined
      if (members.length === 1) return members[0]
      return { oneOf: members }
    }

    const typeArguments = checker.getTypeArguments?.(type) ?? []
    if (typeArguments.length === 1 && isArrayLike(checker, type)) {
      const items = typeToSchema(ts, checker, typeArguments[0], seen)
      return items === undefined ? undefined : { type: 'array', items }
    }
    if (checker.isArrayType?.(type) === true) {
      const element = typeArguments[0]
      const items = typeToSchema(ts, checker, element, seen)
      return items === undefined ? { type: 'array', items: {} } : { type: 'array', items }
    }
    if (type.getNumberIndexType?.() !== undefined && type.getProperties?.().length === 0) {
      const items = typeToSchema(ts, checker, type.getNumberIndexType(), seen)
      return items === undefined ? { type: 'array', items: {} } : { type: 'array', items }
    }

    const properties = checker.getPropertiesOfType(type)
    if (properties.length === 0) return undefined
    const required = []
    const shapeProperties = {}
    for (const property of properties) {
      const declaration = property.valueDeclaration ?? property.declarations?.[0]
      const optional = declaration !== undefined
        && ts.isPropertySignature(declaration)
        && declaration.questionToken !== undefined
      const location = declaration ?? type.symbol?.declarations?.[0]
      if (location === undefined) return undefined
      const propertyType = checker.getTypeOfSymbolAtLocation(property, location)
      const schema = typeToSchema(ts, checker, propertyType, seen)
      if (schema === undefined) return undefined
      shapeProperties[property.getName()] = schema
      if (!optional) required.push(property.getName())
    }
    const shape = { type: 'object', properties: shapeProperties, additionalProperties: false }
    if (required.length > 0) shape.required = required
    return shape
  } finally {
    seen.delete(type)
  }
}

function isArrayLike(checker, type) {
  const symbol = type.getSymbol?.()
  const name = symbol?.getName?.() ?? checker.symbolToString?.(symbol)
  return name === 'Array' || name === 'ReadonlyArray'
}

function siteSummary(sites) {
  return {
    actors: sites.actors.length,
    asks: sites.asks.length,
    worldReads: sites.worldReads.length,
    reports: sites.reports.length,
    artifacts: sites.artifacts.length,
    phases: sites.phases.length,
  }
}

/**
 * @typedef {{ code: number, message: string, line: number, column: number, source?: string }} Diagnostic
 * @typedef {{ ok: true, diagnostics: Diagnostic[], code: string, lineOffset: number, sites: object, askSchemas: Array<{ siteId: string, schema: unknown }>, commands: string[], phases: string[], actors: object[], artifacts: object[] } | { ok: false, diagnostics: Diagnostic[] }} CompileResult
 */
