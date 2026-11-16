/**
 * `artifact.*` and `report()` — a run's deliverables.
 *
 * The facade splits the six kinds into two families, and the asymmetry is the
 * whole design:
 *
 * - **CONTENT (`file`, `markdown`) is an effect.** It is async, resolves to an
 *   artifact reference, and can reject — a missing file, a path outside the
 *   workspace, an oversized body. Bytes are copied when published, so editing
 *   the workspace afterwards never rewrites a version, and republishing the same
 *   id mints the next version while keeping the old ones.
 * - **PRESET (`chart`, `table`, `metrics`, `board`) is a declaration.** It is
 *   synchronous, has no rejection channel, and says "items tagged with this id
 *   should be drawn like this". Declaring the same spec twice is a no-op;
 *   declaring a *different* spec for a taken id fails the run, which is why
 *   validation happens here rather than being trusted to the script.
 *
 * @module dsh-workflow-zcode/engine/artifacts
 */

import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { ARTIFACT_KIND } from './journal.mjs'

/** Ceilings from the facade contract. */
export const ARTIFACT_LIMITS = Object.freeze({
  idsPerRun: 32,
  versionsPerId: 16,
  fileBytes: 20 * 1024 * 1024,
  markdownBytes: 256 * 1024,
  titleChars: 120,
  descriptionChars: 500,
  idChars: 64,
  reportBytes: 32 * 1024,
  reportsPerRun: 256,
})

/** Preset kinds declare; content kinds publish. */
export const CONTENT_KINDS = Object.freeze([ARTIFACT_KIND.file, ARTIFACT_KIND.markdown])
export const PRESET_KINDS = Object.freeze([
  ARTIFACT_KIND.chart,
  ARTIFACT_KIND.table,
  ARTIFACT_KIND.metrics,
  ARTIFACT_KIND.board,
])

const ID_PATTERN = /^[A-Za-z0-9_.-]+$/u

/** Path-safe segment for the snapshot store; ids already pass ID_PATTERN. */
const sanitiseSegment = (value) => String(value).replace(/[^A-Za-z0-9_.-]/gu, '_')

/** Content identity for idempotent publishing. */
const digest = (value) => createHash('sha256').update(value).digest('hex')

const CONTENT_TYPE = Object.freeze({
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
})

/** A failure that ends the run rather than being catchable by the script. */
export class ArtifactFatalError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ArtifactError'
    this.code = 'artifact'
  }
}

/** A content-publish failure the script is meant to catch. */
export class ArtifactRejected extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ArtifactRejected'
    this.code = code
  }
}

function contentTypeOf(path) {
  const index = path.lastIndexOf('.')
  if (index === -1) return 'application/octet-stream'
  return CONTENT_TYPE[path.slice(index).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Create the publisher for one run.
 *
 * @param {object} input
 * @param {string} input.runId
 * @param {string} input.cwd absolute workspace directory
 * @param {{ putArtifact: Function, listArtifacts: Function }} input.journal
 * @returns {ArtifactPublisher}
 */
export function createArtifactPublisher({ runId, cwd, journal, snapshotRoot }) {
  // Content artifacts are copied here, under the run id, so a later edit in the
  // workspace cannot silently change what a published version said.
  const snapshots = snapshotRoot ?? join(homedir(), '.dsh', 'zcode-workflow', 'artifacts')
  /** id → declared kind, so one id cannot become two members. */
  const declared = new Map()
  /** id → serialised spec, for the "same spec is a no-op" rule. */
  const specs = new Map()
  /** Report items by artifact id, plus untagged ones. */
  const reports = []
  let reportBytes = 0
  let primaryId
  let seeded = false

  /**
   * Rebuild what this run already published, before the first call.
   *
   * A resume re-executes the script, so without this the publisher would start
   * with an empty `declared` map: the 32-id ceiling could be exceeded, a preset
   * could be re-declared with a different type, and a second `primary: true`
   * would produce two primaries in one run.
   */
  for (const artifact of journal.listArtifacts(runId)) {
    declared.set(artifact.artifactId, artifact.kind)
    if (artifact.spec !== undefined) specs.set(artifact.artifactId, JSON.stringify(artifact.spec))
    if (artifact.primary === true && primaryId === undefined) primaryId = artifact.artifactId
  }

  /**
   * Rebuild the report ledger from the journal the first time it is needed.
   * Without this a resumed run would restart its 256-report / 32 KiB budgets
   * from zero and could publish past ceilings a previous process enforced.
   */
  const seedReports = () => {
    if (seeded) return
    seeded = true
    for (const event of journal.listEventsOfType(runId, 'report')) {
      const entry = event.payload ?? {}
      let bytes = 0
      try {
        bytes = Buffer.byteLength(JSON.stringify(entry.item) ?? '', 'utf8')
      } catch {
        bytes = 0
      }
      reports.push({ tag: entry.artifactId ?? null, item: entry.item, bytes })
      reportBytes += bytes
    }
  }

  const assertId = (id) => {
    if (typeof id !== 'string' || id.length === 0 || id.length > ARTIFACT_LIMITS.idChars || !ID_PATTERN.test(id)) {
      throw new ArtifactFatalError(
        `artifact ids must be 1–${ARTIFACT_LIMITS.idChars} characters from [A-Za-z0-9_.-]; received ${JSON.stringify(id)}`,
      )
    }
  }

  const assertRoom = (id) => {
    if (declared.has(id)) return
    if (declared.size >= ARTIFACT_LIMITS.idsPerRun) {
      throw new ArtifactFatalError(`a run may publish at most ${ARTIFACT_LIMITS.idsPerRun} artifacts`)
    }
  }

  const clampText = (text, limit) => (
    typeof text === 'string' && text.length > limit ? text.slice(0, limit) : text
  )

  /** The version number the next publish of `id` will take, without consuming it. */
  const nextVersionPreview = (id) => {
    const existing = journal.listArtifacts(runId).find((artifact) => artifact.artifactId === id)
    return existing === undefined ? 1 : existing.version + 1
  }

  const nextVersion = (id) => {
    const existing = journal.listArtifacts(runId).find((artifact) => artifact.artifactId === id)
    const version = existing === undefined ? 1 : existing.version + 1
    if (version > ARTIFACT_LIMITS.versionsPerId) {
      throw new ArtifactFatalError(
        `artifact "${id}" already has ${ARTIFACT_LIMITS.versionsPerId} versions; that is the ceiling`,
      )
    }
    return version
  }

  /**
   * The latest published version of `id`, if its content is byte-identical.
   *
   * Resuming re-executes the script, so the same `artifact.markdown("report", …)`
   * runs again. Minting v2 with identical content would turn every resume into
   * noise in the version list; identical content reuses the version it already
   * has.
   */
  const identicalVersion = (id, kind, contentHash) => {
    const versions = journal.listArtifactVersions(runId, id)
    if (versions.length === 0) return undefined
    const latest = versions[versions.length - 1]
    if (latest.kind !== kind || latest.contentHash !== contentHash) return undefined
    return latest
  }

  const markPrimary = (id) => {
    // Only the first artifact marked primary wins, so a run never has two.
    if (primaryId !== undefined) return false
    primaryId = id
    return true
  }

  const inside = (path) => {
    const absolute = isAbsolute(path) ? path : resolve(cwd, path)
    const rel = relative(cwd, absolute)
    if (rel.startsWith('..') || rel === '..' || rel.includes(`..${sep}`)) {
      throw new ArtifactRejected('outside_workspace', `artifact path is outside the workspace: ${path}`)
    }
    return absolute
  }

  return {
    /** Declare one preset artifact. Throws on a conflicting or invalid spec. */
    declare(op, id, spec) {
      assertId(id)
      if (!PRESET_KINDS.includes(op)) {
        throw new ArtifactFatalError(`artifact.${op} is not a preset kind`)
      }
      if (spec === null || typeof spec !== 'object') {
        throw new ArtifactFatalError(`artifact.${op}("${id}") requires a spec object`)
      }
      const serialised = JSON.stringify(spec)
      const previous = declared.get(id)
      if (previous !== undefined) {
        if (previous !== op) {
          throw new ArtifactFatalError(`artifact id "${id}" is already declared as ${previous}; one id belongs to one member`)
        }
        // Same id, same kind: identical spec is an explicit no-op.
        if (specs.get(id) === serialised) return undefined
        throw new ArtifactFatalError(
          `artifact "${id}" was already declared with a different spec; a preset is declared once`,
        )
      }
      assertRoom(id)
      declared.set(id, op)
      specs.set(id, serialised)
      journal.putArtifact({
        runId,
        artifactId: id,
        kind: op,
        title: clampText(spec.title, ARTIFACT_LIMITS.titleChars),
        description: clampText(spec.description, ARTIFACT_LIMITS.descriptionChars),
        spec,
      })
      return undefined
    },

    /** Publish markdown the script assembled itself. */
    async publishMarkdown(id, content, options = {}) {
      assertId(id)
      if (typeof content !== 'string') {
        throw new ArtifactRejected('invalid_content', `artifact.markdown("${id}") requires a string`)
      }
      const bytes = Buffer.byteLength(content, 'utf8')
      if (bytes > ARTIFACT_LIMITS.markdownBytes) {
        throw new ArtifactRejected(
          'too_large',
          `artifact.markdown("${id}") is ${bytes} bytes; the limit is ${ARTIFACT_LIMITS.markdownBytes}`,
        )
      }
      if (content.trim() === '') {
        throw new ArtifactRejected('empty_content', `artifact.markdown("${id}") refused an empty body`)
      }
      assertRoom(id)
      if (declared.get(id) !== undefined && declared.get(id) !== ARTIFACT_KIND.markdown) {
        throw new ArtifactFatalError(`artifact id "${id}" is already declared as ${declared.get(id)}`)
      }
      const markdownHash = digest(content)
      const same = identicalVersion(id, ARTIFACT_KIND.markdown, markdownHash)
      if (same !== undefined) {
        return { id, version: same.version, kind: ARTIFACT_KIND.markdown, bytes, cached: true }
      }
      declared.set(id, ARTIFACT_KIND.markdown)
      const version = nextVersion(id)
      const primary = options.primary === true ? markPrimary(id) : false
      journal.putArtifact({
        runId,
        artifactId: id,
        kind: ARTIFACT_KIND.markdown,
        title: clampText(options.title, ARTIFACT_LIMITS.titleChars),
        description: clampText(options.description, ARTIFACT_LIMITS.descriptionChars),
        contentType: options.contentType ?? 'text/markdown',
        version,
        primary,
        body: content,
        contentHash: markdownHash,
      })
      return { id, version, kind: ARTIFACT_KIND.markdown, bytes }
    },

    /** Publish a workspace file; bytes are copied now, not referenced later. */
    async publishFile(id, path, options = {}) {
      assertId(id)
      if (typeof path !== 'string' || path === '') {
        throw new ArtifactRejected('invalid_path', `artifact.file("${id}") requires a path`)
      }
      const absolute = inside(path)
      let info
      try {
        info = await stat(absolute)
      } catch {
        throw new ArtifactRejected('not_found', `artifact.file("${id}"): ${path} does not exist`)
      }
      if (!info.isFile()) {
        throw new ArtifactRejected('not_a_file', `artifact.file("${id}"): ${path} is not a file`)
      }
      if (info.size === 0) {
        throw new ArtifactRejected('empty_content', `artifact.file("${id}"): ${path} is empty`)
      }
      if (info.size > ARTIFACT_LIMITS.fileBytes) {
        throw new ArtifactRejected(
          'too_large',
          `artifact.file("${id}"): ${path} is ${info.size} bytes; the limit is ${ARTIFACT_LIMITS.fileBytes}`,
        )
      }
      assertRoom(id)
      if (declared.get(id) !== undefined && declared.get(id) !== ARTIFACT_KIND.file) {
        throw new ArtifactFatalError(`artifact id "${id}" is already declared as ${declared.get(id)}`)
      }
      // Read once: the bytes are both the content identity and what gets stored,
      // so the hash can never describe a file that has since changed.
      const bytes = await readFile(absolute)
      const fileHash = digest(bytes)
      const same = identicalVersion(id, ARTIFACT_KIND.file, fileHash)
      if (same !== undefined) {
        return { id, version: same.version, kind: ARTIFACT_KIND.file, bytes: info.size, cached: true }
      }
      const extension = extname(absolute)
      const target = join(snapshots, sanitiseSegment(runId), sanitiseSegment(id), `v${nextVersionPreview(id)}${extension}`)
      if (declared.get(id) !== undefined && declared.get(id) !== ARTIFACT_KIND.file) {
        throw new ArtifactFatalError(`artifact id "${id}" is already declared as ${declared.get(id)}`)
      }
      declared.set(id, ARTIFACT_KIND.file)
      const version = nextVersion(id)
      const primary = options.primary === true ? markPrimary(id) : false
      const contentType = options.contentType ?? contentTypeOf(path)
      // The artifact's own directory is the one to create; `dirname` here would
      // strip it and leave copyFile with a missing parent.
      await mkdir(join(snapshots, sanitiseSegment(runId), sanitiseSegment(id)), { recursive: true })
      await copyFile(absolute, target)
      journal.putArtifact({
        runId,
        artifactId: id,
        kind: ARTIFACT_KIND.file,
        title: clampText(options.title, ARTIFACT_LIMITS.titleChars),
        description: clampText(options.description, ARTIFACT_LIMITS.descriptionChars),
        contentType,
        sourcePath: relative(cwd, absolute).split(sep).join('/'),
        version,
        primary,
        itemCount: info.size,
        spec: { bytes: info.size, contentType, snapshot: target },
        contentHash: fileHash,
      })
      return { id, version, kind: ARTIFACT_KIND.file, bytes: info.size, contentType }
    },

    /** Record one `report()` item, tagged with the artifact it feeds. */
    report(item, artifactId) {
      seedReports()
      const tag = artifactId === null || artifactId === undefined ? null : artifactId
      if (tag !== null) {
        assertId(tag)
        const kind = declared.get(tag)
        if (kind !== undefined && !PRESET_KINDS.includes(kind)) {
          throw new ArtifactFatalError(`report() targeted "${tag}", which is a ${kind} artifact; presets are fed by report()`)
        }
      }
      let serialised
      try {
        serialised = JSON.stringify(item)
      } catch {
        throw new ArtifactFatalError('report() received a value that cannot be serialised')
      }
      if (serialised === undefined) {
        throw new ArtifactFatalError('report() received a value that cannot be serialised')
      }
      const bytes = Buffer.byteLength(serialised, 'utf8')
      if (bytes > ARTIFACT_LIMITS.reportBytes) {
        throw new ArtifactFatalError(`report() item is ${bytes} bytes; the limit is ${ARTIFACT_LIMITS.reportBytes}`)
      }
      if (reports.length >= ARTIFACT_LIMITS.reportsPerRun) {
        throw new ArtifactFatalError(`a run may publish at most ${ARTIFACT_LIMITS.reportsPerRun} reports`)
      }
      reportBytes += bytes
      reports.push({ tag, item, bytes })
      return { tag, bytes, total: reports.length }
    },

    /** Everything this run published, for the return envelope and the panel. */
    snapshot() {
      const artifacts = journal.listArtifacts(runId).map((artifact) => ({
        id: artifact.artifactId,
        kind: artifact.kind,
        title: artifact.title ?? undefined,
        description: artifact.description ?? undefined,
        contentType: artifact.contentType ?? undefined,
        sourcePath: artifact.sourcePath ?? undefined,
        version: artifact.version,
        primary: artifact.primary,
        itemCount: artifact.itemCount ?? undefined,
        spec: artifact.spec,
        ...(artifact.body === null || artifact.body === undefined ? {} : { body: artifact.body }),
      }))
      // The journal is the source of truth for reports: after a restart the
      // in-memory ledger is empty, but the run's reports are not.
      const durableReports = journal.listEventsOfType(runId, 'report').map((event) => ({
        artifactId: event.payload?.artifactId ?? null,
        item: event.payload?.item,
      }))
      const markdown = artifacts.filter((artifact) => artifact.kind === ARTIFACT_KIND.markdown)
      const primary = artifacts.find((artifact) => artifact.primary === true)
      return {
        artifacts,
        reports: durableReports.length > 0
          ? durableReports
          : reports.map((entry) => ({ artifactId: entry.tag, item: entry.item })),
        reportBytes,
        primaryMarkdown: primary?.kind === ARTIFACT_KIND.markdown
          ? primary.body
          : markdown.find((artifact) => artifact.primary === true)?.body,
      }
    },
  }
}

/**
 * @typedef {ReturnType<typeof createArtifactPublisher>} ArtifactPublisher
 */
