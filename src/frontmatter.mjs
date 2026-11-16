/**
 * `/* zcode-workflow` front-matter block: detection, YAML-subset parsing,
 * default application, and the four parse errors ZCode reports.
 *
 * ZCode writes saved workflows as `<name>.dwf.ts`, whose first lines are a
 * multi-line block comment opened by `/* zcode-workflow` and closed by `*\/`.
 * The block body is YAML with three keys: `description` (required),
 * `whenToUse` (optional), `args` (optional map of declared arguments).
 *
 * @module dsh-workflow-zcode/frontmatter
 */

const OPEN = '/* zcode-workflow'
const CLOSE = '*/'

/** Codes the parser can report; they mirror ZCode's `parseSavedWorkflow` vocabulary. */
export const FRONTMATTER_ERRORS = {
  missing: 'missing_frontmatter',
  unterminated: 'unterminated_frontmatter',
  invalidYaml: 'invalid_yaml',
  invalidMetadata: 'invalid_metadata',
}

/**
 * Split a source file into its front-matter block and the remaining body.
 *
 * @param {string} source full file text
 * @returns {{ block: string, body: string, lineOffset: number } | { error: string, message: string }}
 */
export function splitFrontmatter(source) {
  if (typeof source !== 'string') {
    return { error: FRONTMATTER_ERRORS.missing, message: 'workflow source must be a string' }
  }
  const text = source.startsWith('\uFEFF') ? source.slice(1) : source
  const head = text.trimStart()
  const indent = text.length - head.length
  if (!head.startsWith(OPEN)) {
    return {
      error: FRONTMATTER_ERRORS.missing,
      message: `a saved workflow file must begin with the \`${OPEN}\` block`,
    }
  }
  const close = text.indexOf(CLOSE, indent + OPEN.length)
  if (close < 0) {
    return {
      error: FRONTMATTER_ERRORS.unterminated,
      message: `the \`${OPEN}\` block is never closed with \`${CLOSE}\``,
    }
  }
  const block = text.slice(indent + OPEN.length, close)
  const body = text.slice(close + CLOSE.length)
  const lineOffset = countNewlines(text.slice(0, close + CLOSE.length))
  return { block, body, lineOffset }
}

function countNewlines(text) {
  let count = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) count += 1
  }
  return count
}

/**
 * Parse the YAML body of a front-matter block.
 *
 * This is a deliberate YAML *subset*: block mapping, 2-space-or-consistent
 * indentation, scalars, and comments. That covers the shape ZCode itself
 * writes (`description`, `whenToUse`, `args.{name}.{type,description,required,default}`)
 * without pulling a YAML dependency into the plugin. Anything outside the
 * subset reports `invalid_yaml` rather than silently mis-reading.
 *
 * @param {string} block the text between `/* zcode-workflow` and `*\/`
 * @returns {{ ok: true, value: Record<string, unknown>, issues: string[] } | { ok: false, message: string, line: number }}
 */
export function parseFrontmatterYaml(block) {
  const rows = []
  for (const raw of block.split(/\r?\n/)) {
    const trimmed = raw.trim()
    if (trimmed === '') continue
    rows.push({ indent: raw.length - raw.trimStart().length, text: trimmed, line: rows.length + 1 })
  }
  const folded = foldContinuations(rows)
  if (folded.error !== undefined) return folded.error
  const entries = folded.entries
  if (entries.length === 0) return { ok: true, value: {}, issues: [] }
  return parseEntries(entries, 0, entries.length, entries[0].indent)
}

/**
 * Join YAML plain-scalar continuation lines onto the key they belong to.
 * A more-indented line without its own `key:` continues the previous scalar;
 * ZCode's own saved workflows wrap long descriptions this way.
 */
function foldContinuations(rows) {
  const entries = []
  let openKey = null
  for (const row of rows) {
    const colon = findKeyColon(row.text)
    if (openKey !== null && colon < 0 && row.indent > openKey.indent) {
      openKey.value = `${openKey.value} ${row.text}`
      continue
    }
    if (openKey !== null && colon >= 0 && row.indent > openKey.indent) {
      // A nested mapping starts here; the scalar stays closed.
      openKey = null
    }
    if (row.text.startsWith('#')) continue
    if (colon < 0) {
      return { error: { ok: false, message: `expected "key: value" at line ${row.line}`, line: row.line } }
    }
    const key = row.text.slice(0, colon).trim()
    if (key === '') return { error: { ok: false, message: `empty key at line ${row.line}`, line: row.line } }
    const entry = {
      key,
      indent: row.indent,
      line: row.line,
      value: row.text.slice(colon + 1).trim(),
      children: [],
    }
    entries.push(entry)
    openKey = entry.value === '' || entry.value.startsWith('#') ? null : entry
  }
  return { entries }
}

function parseEntries(entries, from, to, indent) {
  const value = {}
  let index = from
  while (index < to) {
    const entry = entries[index]
    if (entry.indent < indent) break
    if (entry.indent > indent) {
      return { ok: false, message: `unexpected indentation at line ${entry.line}`, line: entry.line }
    }
    let next = index + 1
    while (next < to && entries[next].indent > indent) next += 1
    if (entry.value === '' || entry.value.startsWith('#')) {
      if (next > index + 1) {
        const nested = parseEntries(entries, index + 1, next, entries[index + 1].indent)
        if (nested.ok !== true) return nested
        value[entry.key] = nested.value
      } else {
        value[entry.key] = null
      }
    } else {
      value[entry.key] = parseScalar(entry.value)
    }
    index = next
  }
  return { ok: true, value, issues: [] }
}

function yamlError(message, line) {
  const failure = new Error(message)
  failure.yamlLine = line
  return failure
}

function findKeyColon(text) {
  let quote = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== '') {
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === ':' && (index + 1 === text.length || /\s/.test(text[index + 1]))) return index
  }
  return -1
}

function parseScalar(text) {
  const value = stripComment(text)
  if (value === '') return null
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null' || value === '~') return null
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10)
  if (/^-?\d*\.\d+$/.test(value)) return Number.parseFloat(value)
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      return JSON.parse(value)
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replaceAll("''", "'")
  }
  return value
}

function stripComment(text) {
  let quote = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== '') {
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#' && (index === 0 || /\s/.test(text[index - 1]))) return text.slice(0, index).trimEnd()
  }
  return text.trim()
}

/** The `args` declaration types ZCode accepts. */
const ARG_TYPES = new Set(['string', 'number', 'boolean', 'integer'])
const ARG_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/**
 * Validate the parsed metadata against ZCode's `ZQe` schema
 * (`description` required; each `args` entry has a type, an optional
 * description, and optional `required`/`default`) and apply defaults.
 *
 * @param {Record<string, unknown>} meta parsed YAML
 * @param {Record<string, unknown>} [supplied] caller-provided argument values
 * @returns {{ ok: true, meta: WorkflowFrontmatter, args: Record<string, unknown> } | { ok: false, issues: string[] }}
 */
export function normalizeFrontmatter(meta, supplied = {}) {
  const issues = []
  const description = typeof meta.description === 'string' ? meta.description.trim() : ''
  if (description === '') issues.push('`description` is required and must be a non-empty string')
  /** @type {string | undefined} */
  let whenToUse
  if (meta.whenToUse !== undefined && meta.whenToUse !== null) {
    if (typeof meta.whenToUse !== 'string') issues.push('`whenToUse` must be a string')
    else whenToUse = meta.whenToUse.trim()
  }

  /** @type {Record<string, WorkflowArgument>} */
  const declarations = {}
  if (meta.args !== undefined && meta.args !== null) {
    if (typeof meta.args !== 'object' || Array.isArray(meta.args)) {
      issues.push('`args` must be a mapping of argument declarations')
    } else {
      for (const [name, raw] of Object.entries(meta.args)) {
        if (!ARG_NAME.test(name)) {
          issues.push(`argument name \`${name}\` is not a valid identifier`)
          continue
        }
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
          issues.push(`argument \`${name}\` must declare a mapping (type/description/required/default)`)
          continue
        }
        const decl = /** @type {Record<string, unknown>} */ (raw)
        const type = typeof decl.type === 'string' ? decl.type : 'string'
        if (!ARG_TYPES.has(type)) {
          issues.push(`argument \`${name}\` has unsupported type \`${type}\` (supported: ${[...ARG_TYPES].join(', ')})`)
          continue
        }
        if (decl.required !== undefined && typeof decl.required !== 'boolean') {
          issues.push(`argument \`${name}\`.required must be a boolean`)
          continue
        }
        declarations[name] = {
          type: /** @type {WorkflowArgumentType} */ (type),
          ...(typeof decl.description === 'string' && decl.description !== '' ? { description: decl.description } : {}),
          ...(decl.required === true ? { required: true } : {}),
          ...(decl.default !== undefined && decl.default !== null ? { default: decl.default } : {}),
        }
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues }

  const resolved = resolveArgs(declarations, supplied)
  if (!resolved.ok) return { ok: false, issues: resolved.issues }
  return {
    ok: true,
    meta: { description, ...(whenToUse === undefined ? {} : { whenToUse }), args: declarations },
    args: resolved.args,
  }
}

/**
 * Apply defaults to caller-supplied values and reject unknown, missing, or
 * mistyped arguments — ZCode refuses all three *before anything runs*.
 *
 * @param {Record<string, WorkflowArgument>} declarations
 * @param {Record<string, unknown>} supplied
 */
export function resolveArgs(declarations, supplied) {
  const issues = []
  if (supplied === undefined || supplied === null) supplied = {}
  if (typeof supplied !== 'object' || Array.isArray(supplied)) {
    return { ok: /** @type {const} */ (false), issues: ['arguments must be an object'] }
  }
  for (const key of Object.keys(supplied)) {
    if (!(key in declarations)) issues.push(`unknown argument \`${key}\``)
  }
  /** @type {Record<string, unknown>} */
  const args = {}
  for (const [name, decl] of Object.entries(declarations)) {
    const raw = /** @type {Record<string, unknown>} */ (supplied)[name]
    if (raw === undefined) {
      if (decl.default !== undefined) args[name] = decl.default
      else if (decl.required) issues.push(`missing required argument \`${name}\``)
      else args[name] = decl.type === 'number' || decl.type === 'integer' ? 0 : decl.type === 'boolean' ? false : ''
      continue
    }
    const check = checkArgType(name, decl.type, raw)
    if (check !== undefined) issues.push(check)
    else args[name] = raw
  }
  if (issues.length > 0) return { ok: /** @type {const} */ (false), issues }
  return { ok: /** @type {const} */ (true), args }
}

function checkArgType(name, type, value) {
  switch (type) {
    case 'string':
      return typeof value === 'string' ? undefined : `argument \`${name}\` must be a string`
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? undefined : `argument \`${name}\` must be a number`
    case 'integer':
      return Number.isInteger(value) ? undefined : `argument \`${name}\` must be an integer`
    case 'boolean':
      return typeof value === 'boolean' ? undefined : `argument \`${name}\` must be a boolean`
    default:
      return `argument \`${name}\` has unsupported type \`${type}\``
  }
}

/**
 * @typedef {'string' | 'number' | 'boolean' | 'integer'} WorkflowArgumentType
 * @typedef {{ type: WorkflowArgumentType, description?: string, required?: boolean, default?: unknown }} WorkflowArgument
 * @typedef {{ description: string, whenToUse?: string, args: Record<string, WorkflowArgument> }} WorkflowFrontmatter
 */
