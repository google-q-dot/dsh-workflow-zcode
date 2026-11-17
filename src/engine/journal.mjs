/**
 * The run journal: ZCode's `dwf_*` tables on `node:sqlite`.
 *
 * Why a real database instead of JSON files: the journal is the only thing
 * that makes a run inspectable after the fact and resumable without spending
 * tokens twice. `(run_id, site_id, ordinal)` is the natural key of one call,
 * `input_hash` is the determinism guard carried beside it, and every row is
 * scoped by the owning Session and workspace so one Session's runs never leak
 * into another's list.
 *
 * The table shapes follow `.recon/db/schema.sql` column for column for the four
 * `dwf_*` tables the origin has. `dwf_artifact` is ours: the origin keeps
 * artifacts as `kind='artifact'` nodes plus a pointer, which cannot express
 * versions, a `primary` flag or a preview, so a run's deliverables get their
 * own table here.
 *
 * @module dsh-workflow-zcode/engine/journal
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** Run lifecycle, matching the origin's `dwf_run.status` CHECK list. */
export const RUN_STATUS = Object.freeze({
  pending: 'pending',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
})

/** Node lifecycle. The origin has no 'queued': a node row appears when it dispatches. */
export const NODE_STATUS = Object.freeze({
  running: 'running',
  completed: 'completed',
  failed: 'failed',
})

/** Node kinds, matching the origin's `dwf_node.kind` CHECK list. */
export const NODE_KIND = Object.freeze({
  ask: 'ask',
  worldRead: 'world-read',
  worldRun: 'world-run',
  report: 'report',
  artifact: 'artifact',
})

/** Artifact kinds. Content artifacts preview from stored text; preset ones render from `report()` items. */
export const ARTIFACT_KIND = Object.freeze({
  file: 'file',
  markdown: 'markdown',
  table: 'table',
  metrics: 'metrics',
  board: 'board',
  chart: 'chart',
})

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dwf_run (
  id text primary key,
  parent_session_id text,
  cwd text,
  name text,
  script_text text,
  script_hash text,
  plan_json text,
  args_json text,
  tool_call_id text,
  resumed_from text,
  caps_max_concurrency integer not null,
  spent_tokens integer not null default 0,
  resume_count integer not null default 0,
  time_last_resumed integer,
  status text not null check(status in ('pending','running','completed','failed','cancelled')),
  result_json text,
  failure_json text,
  time_created integer not null,
  time_updated integer not null
);
CREATE INDEX IF NOT EXISTS dwf_run_session ON dwf_run(parent_session_id, time_updated);
CREATE INDEX IF NOT EXISTS dwf_run_cwd ON dwf_run(cwd, time_updated);

CREATE TABLE IF NOT EXISTS dwf_actor (
  id integer primary key autoincrement,
  run_id text not null references dwf_run(id) on delete cascade,
  site_id text not null,
  ordinal integer not null,
  name text,
  persona_json text,
  resolved_model text,
  session_id text,
  tokens integer not null default 0,
  time_created integer not null,
  time_updated integer not null,
  unique(run_id, site_id, ordinal)
);

CREATE TABLE IF NOT EXISTS dwf_node (
  id integer primary key autoincrement,
  run_id text not null references dwf_run(id) on delete cascade,
  site_id text not null,
  ordinal integer not null,
  kind text not null check(kind in ('ask','world-read','world-run','report','artifact')),
  actor_site_id text,
  actor_ordinal integer,
  actor_seq integer,
  input_hash text not null,
  input_json text,
  status text not null check(status in ('running','completed','failed')),
  result_json text,
  error_json text,
  stats_json text,
  message_boundary integer,
  artifact_id text,
  time_created integer not null,
  time_updated integer not null,
  unique(run_id, site_id, ordinal)
);
CREATE INDEX IF NOT EXISTS dwf_node_run ON dwf_node(run_id);
CREATE INDEX IF NOT EXISTS dwf_node_artifact ON dwf_node(run_id, artifact_id);

CREATE TABLE IF NOT EXISTS dwf_artifact (
  id integer primary key autoincrement,
  run_id text not null references dwf_run(id) on delete cascade,
  artifact_id text not null,
  kind text not null check(kind in ('file','markdown','table','metrics','board','chart')),
  title text,
  description text,
  content_type text,
  source_path text,
  spec_json text,
  version integer not null default 1,
  primary_flag integer not null default 0,
  item_count integer,
  body text,
  time_created integer not null,
  time_updated integer not null,
  unique(run_id, artifact_id)
);

CREATE TABLE IF NOT EXISTS dwf_artifact_version (
  id integer primary key autoincrement,
  run_id text not null references dwf_run(id) on delete cascade,
  artifact_id text not null,
  version integer not null,
  kind text not null,
  title text,
  description text,
  content_type text,
  source_path text,
  spec_json text,
  item_count integer,
  body text,
  content_hash text,
  time_created integer not null,
  unique(run_id, artifact_id, version)
);

CREATE TABLE IF NOT EXISTS dwf_event (
  id integer primary key autoincrement,
  run_id text not null references dwf_run(id) on delete cascade,
  sequence integer not null,
  type text not null,
  payload_json text not null,
  time_created integer not null,
  unique(run_id, sequence)
);
CREATE INDEX IF NOT EXISTS dwf_event_run ON dwf_event(run_id, sequence);

CREATE TABLE IF NOT EXISTS dwf_session_policy (
  session_id text primary key,
  auto_approve integer not null default 0,
  time_updated integer not null
);
`

const now = () => Date.now()

/** Add a column when an older database does not have it yet. */
function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all()
  if (columns.some((entry) => entry.name === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}
const json = (value) => (value === undefined ? null : JSON.stringify(value))
const parse = (text) => {
  if (text === null || text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Open (and migrate) the journal.
 *
 * @param {object} [options]
 * @param {string} [options.file] database path, or `:memory:` for tests
 * @returns {Journal}
 */
export function openJournal({ file = ':memory:' } = {}) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)
  // A journal written by an earlier build lacks the resume/version columns; add
  // them in place so an upgrade never requires deleting a user's run history.
  ensureColumn(db, 'dwf_run', 'resume_count', 'integer not null default 0')
  ensureColumn(db, 'dwf_run', 'time_last_resumed', 'integer')
  ensureColumn(db, 'dwf_artifact_version', 'content_hash', 'text')
  // Everything needed to re-run a settled run: resume must not depend on the
  // original file still existing, or on the caller re-sending the script.
  ensureColumn(db, 'dwf_run', 'plan_json', 'text')
  // Actor token usage accumulates over turns; a dedicated column keeps the
  // panel's roster honest without recomputing from events.
  ensureColumn(db, 'dwf_actor', 'tokens', 'integer not null default 0')

  let closed = false

  const statements = {
    insertRun: db.prepare(`INSERT INTO dwf_run
      (id, parent_session_id, cwd, name, script_text, script_hash, plan_json, args_json, tool_call_id,
       resumed_from, caps_max_concurrency, spent_tokens, status, time_created, time_updated)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)`),
    selectRun: db.prepare('SELECT * FROM dwf_run WHERE id = ?'),
    listRunsAll: db.prepare('SELECT * FROM dwf_run ORDER BY time_updated DESC LIMIT ?'),
    listRunsBySession: db.prepare(
      'SELECT * FROM dwf_run WHERE parent_session_id = ? ORDER BY time_updated DESC LIMIT ?',
    ),
    listRunsByCwd: db.prepare('SELECT * FROM dwf_run WHERE cwd = ? ORDER BY time_updated DESC LIMIT ?'),
    listLiveRuns: db.prepare("SELECT * FROM dwf_run WHERE status IN ('pending','running') ORDER BY time_created"),
    failRunningNodes: db.prepare(
      "UPDATE dwf_node SET status = 'failed', error_json = ?, time_updated = ? WHERE run_id = ? AND status = 'running'",
    ),
    setRunStatus: db.prepare(`UPDATE dwf_run
      SET status = ?, result_json = ?, failure_json = ?, spent_tokens = ?, time_updated = ?
      WHERE id = ?`),
    upsertActor: db.prepare(`INSERT INTO dwf_actor
      (run_id, site_id, ordinal, name, persona_json, resolved_model, session_id, tokens, time_created, time_updated)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(run_id, site_id, ordinal) DO UPDATE SET
        name = excluded.name, persona_json = excluded.persona_json,
        resolved_model = excluded.resolved_model, session_id = excluded.session_id,
        tokens = excluded.tokens, time_updated = excluded.time_updated`),
    listActors: db.prepare('SELECT * FROM dwf_actor WHERE run_id = ? ORDER BY id'),
    upsertNode: db.prepare(`INSERT INTO dwf_node
      (run_id, site_id, ordinal, kind, actor_site_id, actor_ordinal, actor_seq, input_hash, input_json,
       status, result_json, error_json, stats_json, message_boundary, artifact_id,
       time_created, time_updated)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(run_id, site_id, ordinal) DO UPDATE SET
        status = excluded.status, result_json = excluded.result_json,
        error_json = excluded.error_json, stats_json = excluded.stats_json,
        message_boundary = excluded.message_boundary, artifact_id = excluded.artifact_id,
        time_updated = excluded.time_updated`),
    listNodes: db.prepare('SELECT * FROM dwf_node WHERE run_id = ? ORDER BY id'),
    findNode: db.prepare('SELECT * FROM dwf_node WHERE run_id = ? AND site_id = ? AND ordinal = ?'),
    upsertArtifact: db.prepare(`INSERT INTO dwf_artifact
      (run_id, artifact_id, kind, title, description, content_type, source_path, spec_json,
       version, primary_flag, item_count, body, time_created, time_updated)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(run_id, artifact_id) DO UPDATE SET
        kind = excluded.kind, title = excluded.title, description = excluded.description,
        content_type = excluded.content_type, source_path = excluded.source_path,
        spec_json = excluded.spec_json, version = excluded.version,
        -- A later version that does not claim primary must NOT clear the flag a
        -- previous version set: primary names the run's deliverable, not the
        -- newest write.
        primary_flag = max(excluded.primary_flag, dwf_artifact.primary_flag),
        item_count = excluded.item_count,
        body = excluded.body, time_updated = excluded.time_updated`),
    insertArtifactVersion: db.prepare(`INSERT INTO dwf_artifact_version
      (run_id, artifact_id, version, kind, title, description, content_type, source_path,
       spec_json, item_count, body, content_hash, time_created)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(run_id, artifact_id, version) DO UPDATE SET
        kind = excluded.kind, title = excluded.title, description = excluded.description,
        content_type = excluded.content_type, source_path = excluded.source_path,
        spec_json = excluded.spec_json, item_count = excluded.item_count,
        body = excluded.body, content_hash = excluded.content_hash`),
    listArtifactVersions: db.prepare(
      'SELECT * FROM dwf_artifact_version WHERE run_id = ? AND artifact_id = ? ORDER BY version',
    ),
    listArtifacts: db.prepare('SELECT * FROM dwf_artifact WHERE run_id = ? ORDER BY id'),
    nextSequence: db.prepare(
      'SELECT coalesce(max(sequence) + 1, 0) AS next FROM dwf_event WHERE run_id = ?',
    ),
    insertEvent: db.prepare(
      'INSERT INTO dwf_event (run_id, sequence, type, payload_json, time_created) VALUES (?,?,?,?,?)',
    ),
    listEvents: db.prepare(
      'SELECT * FROM dwf_event WHERE run_id = ? AND sequence >= ? ORDER BY sequence LIMIT ?',
    ),
    selectSessionPolicy: db.prepare(
      'SELECT auto_approve FROM dwf_session_policy WHERE session_id = ?',
    ),
    upsertSessionPolicy: db.prepare(`INSERT INTO dwf_session_policy
      (session_id, auto_approve, time_updated) VALUES (?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET
        auto_approve = excluded.auto_approve, time_updated = excluded.time_updated`),
  }

  const mapRun = (row) => (row === undefined ? undefined : {
    id: row.id,
    parentSessionId: row.parent_session_id,
    cwd: row.cwd,
    name: row.name,
    scriptText: row.script_text,
    scriptHash: row.script_hash,
    plan: parse(row.plan_json),
    args: parse(row.args_json),
    toolCallId: row.tool_call_id,
    resumedFrom: row.resumed_from,
    capsMaxConcurrency: row.caps_max_concurrency,
    spentTokens: row.spent_tokens,
    resumeCount: row.resume_count ?? 0,
    timeLastResumed: row.time_last_resumed ?? undefined,
    status: row.status,
    result: parse(row.result_json),
    failure: parse(row.failure_json),
    timeCreated: row.time_created,
    timeUpdated: row.time_updated,
  })

  const mapActor = (row) => ({
    siteId: row.site_id,
    ordinal: row.ordinal,
    name: row.name,
    persona: parse(row.persona_json),
    resolvedModel: row.resolved_model,
    sessionId: row.session_id,
    tokens: row.tokens ?? 0,
  })

  const mapNode = (row) => ({
    siteId: row.site_id,
    ordinal: row.ordinal,
    kind: row.kind,
    actorSiteId: row.actor_site_id,
    actorOrdinal: row.actor_ordinal,
    actorSeq: row.actor_seq,
    inputHash: row.input_hash,
    input: parse(row.input_json),
    status: row.status,
    result: parse(row.result_json),
    error: parse(row.error_json),
    stats: parse(row.stats_json),
    messageBoundary: row.message_boundary,
    artifactId: row.artifact_id,
    timeCreated: row.time_created,
    timeUpdated: row.time_updated,
  })

  const mapArtifact = (row) => ({
    artifactId: row.artifact_id,
    kind: row.kind,
    title: row.title,
    description: row.description,
    contentType: row.content_type,
    sourcePath: row.source_path,
    spec: parse(row.spec_json),
    version: row.version,
    primary: row.primary_flag === 1,
    itemCount: row.item_count,
    body: row.body,
  })

  const api = {
    file,

    /** Insert one run row. A duplicate id throws rather than silently reusing. */
    createRun({ id, parentSessionId, cwd, name, scriptText, scriptHash, plan, args, toolCallId, resumedFrom, capsMaxConcurrency = 0 }) {
      const at = now()
      statements.insertRun.run(
        id, parentSessionId ?? null, cwd ?? null, name ?? null, scriptText ?? null,
        scriptHash ?? null, json(plan), json(args), toolCallId ?? null, resumedFrom ?? null,
        capsMaxConcurrency, RUN_STATUS.pending, at, at,
      )
      return this.getRun(id)
    },

    getRun(id) {
      return mapRun(statements.selectRun.get(id))
    },

    /**
     * List runs. Scope wins over breadth: a caller that knows its Session or
     * workspace gets only those runs, never the whole machine's.
     */
    listRuns({ parentSessionId, cwd, limit = 64 } = {}) {
      const bounded = Math.max(1, Math.min(256, Math.floor(limit)))
      const rows = parentSessionId === undefined
        ? (cwd === undefined
          ? statements.listRunsAll.all(bounded)
          : statements.listRunsByCwd.all(cwd, bounded))
        : statements.listRunsBySession.all(parentSessionId, bounded)
      return rows.map(mapRun)
    },

    /**
     * Mark a new attempt as actually executing.
     *
     * `createRun` inserts `pending` (the row exists before the sandbox starts),
     * and nothing else used to move it: a live run stayed "queued" forever in
     * the panel even while nodes and phases were being written. A settled row
     * is never reopened here; only pending/running rows transition.
     */
    markRunning(id) {
      db.prepare(`UPDATE dwf_run SET status = ?, time_updated = ?
        WHERE id = ? AND status IN (?, ?)`)
        .run(RUN_STATUS.running, now(), id, RUN_STATUS.pending, RUN_STATUS.running)
      return this.getRun(id)
    },

    /**
     * Reopen a settled run for resume.
     *
     * The previous failure is cleared because this attempt has not failed yet;
     * the count is what the panel shows as "第 N 次续跑".
     */
    markResumed(id) {
      db.prepare(`UPDATE dwf_run SET status = ?, result_json = NULL, failure_json = NULL,
        resume_count = resume_count + 1, time_last_resumed = ?, time_updated = ? WHERE id = ?`)
        .run(RUN_STATUS.running, now(), now(), id)
      return this.getRun(id)
    },

    settleRun(id, { status, result, failure, spentTokens = 0 }) {
      statements.setRunStatus.run(status, json(result), json(failure), spentTokens, now(), id)
      return this.getRun(id)
    },

    /** Replace the stored plan (used when the UI applies new settings). */
    updatePlan(id, plan) {
      db.prepare('UPDATE dwf_run SET plan_json = ?, time_updated = ? WHERE id = ?').run(json(plan), now(), id)
      return this.getRun(id)
    },

    /** Change the run's recorded concurrency window. */
    setRunCaps(id, capsMaxConcurrency) {
      db.prepare('UPDATE dwf_run SET caps_max_concurrency = ?, time_updated = ? WHERE id = ?')
        .run(Number(capsMaxConcurrency), now(), id)
      return this.getRun(id)
    },

    /** Delete one run and everything hanging off it (FKs cascade). */
    deleteRun(id) {
      const result = db.prepare('DELETE FROM dwf_run WHERE id = ?').run(id)
      return Number(result?.changes ?? 0) > 0
    },

    /**
     * Close out runs a previous host process left behind.
     *
     * SQLite survives a crash; the controllers driving those runs do not. A run
     * stuck in `pending`/`running` would spin in the panel forever and could
     * never be resumed, so on startup every such run (and its running nodes) is
     * settled as `failed` with `code: 'host_restart'`. A `run-settled` event is
     * appended for the same reason a normal failure records one.
     */
    reconcileInterruptedRuns({ code = 'host_restart', reason = 'the host stopped before this run finished; it can be resumed' } = {}) {
      if (closed) return { runs: 0, nodes: 0 }
      const live = statements.listLiveRuns.all()
      let nodes = 0
      for (const row of live) {
        const at = now()
        const failure = json({ code, message: reason })
        const changed = statements.failRunningNodes.run(failure, at, row.id)
        nodes += Number(changed?.changes ?? 0)
        statements.setRunStatus.run('failed', null, failure, 0, at, row.id)
        this.appendEvent(row.id, 'run-settled', { status: 'failed', error: reason, code, reconciled: true })
      }
      return { runs: live.length, nodes }
    },

    putActor({ runId, siteId, ordinal, name, persona, resolvedModel, sessionId, tokens = 0 }) {
      const at = now()
      statements.upsertActor.run(
        runId, siteId, ordinal, name ?? null, json(persona), resolvedModel ?? null,
        sessionId ?? null, Number.isFinite(tokens) ? tokens : 0, at, at,
      )
      return this.listActors(runId).find((actor) => actor.siteId === siteId && actor.ordinal === ordinal)
    },

    listActors(runId) {
      return statements.listActors.all(runId).map(mapActor)
    },

    putNode({ runId, siteId, ordinal, kind, actorSiteId, actorOrdinal, actorSeq, inputHash, input, status, result, error, stats, messageBoundary, artifactId }) {
      const at = now()
      statements.upsertNode.run(
        runId, siteId, ordinal, kind, actorSiteId ?? null, actorOrdinal ?? null, actorSeq ?? null,
        inputHash, input ?? null, status, json(result), json(error), json(stats),
        messageBoundary ?? null, artifactId ?? null, at, at,
      )
      const row = statements.findNode.get(runId, siteId, ordinal)
      return row === undefined ? undefined : mapNode(row)
    },

    listNodes(runId) {
      return statements.listNodes.all(runId).map(mapNode)
    },

    findNode(runId, siteId, ordinal) {
      const row = statements.findNode.get(runId, siteId, ordinal)
      return row === undefined ? undefined : mapNode(row)
    },

    putArtifact({ runId, artifactId, kind, title, description, contentType, sourcePath, spec, version = 1, primary = false, itemCount, body, contentHash }) {
      const at = now()
      // Every publish keeps its own version, so republishing an id cannot erase
      // what an earlier version said.
      statements.insertArtifactVersion.run(
        runId, artifactId, version, kind, title ?? null, description ?? null,
        contentType ?? null, sourcePath ?? null, json(spec), itemCount ?? null,
        body ?? null, contentHash ?? null, at,
      )
      statements.upsertArtifact.run(
        runId, artifactId, kind, title ?? null, description ?? null, contentType ?? null,
        sourcePath ?? null, json(spec), version, primary ? 1 : 0,
        itemCount ?? null, body ?? null, at, at,
      )
      return this.listArtifacts(runId).find((artifact) => artifact.artifactId === artifactId)
    },

    listArtifacts(runId) {
      return statements.listArtifacts.all(runId).map(mapArtifact)
    },

    /** Every published version of one artifact, oldest first. */
    listArtifactVersions(runId, artifactId) {
      return statements.listArtifactVersions.all(runId, artifactId).map((row) => ({
        artifactId: row.artifact_id,
        version: row.version,
        kind: row.kind,
        title: row.title,
        description: row.description,
        contentType: row.content_type,
        sourcePath: row.source_path,
        spec: parse(row.spec_json),
        itemCount: row.item_count,
        body: row.body,
        contentHash: row.content_hash ?? null,
      }))
    },

    /** Events of one type, so durable state can be rebuilt after a restart. */
    listEventsOfType(runId, type, { limit = 500 } = {}) {
      return this.listEvents(runId, { limit }).filter((event) => event.type === type)
    },

    /** Append one event; the sequence is per run and starts at 0. */
    appendEvent(runId, type, payload) {
      const { next } = statements.nextSequence.get(runId)
      const sequence = Number(next ?? 0)
      statements.insertEvent.run(runId, sequence, type, JSON.stringify(payload ?? null), now())
      return sequence
    },

    listEvents(runId, { afterSequence = 0, limit = 500 } = {}) {
      const bounded = Math.max(1, Math.min(500, Math.floor(limit)))
      return statements.listEvents.all(runId, afterSequence, bounded).map((row) => ({
        sequence: row.sequence,
        type: row.type,
        payload: parse(row.payload_json),
        time: row.time_created,
      }))
    },

    /** Whether automatic workflow execution was approved for a session. */
    isSessionAutoApproved(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.trim() === '') return false
      const row = statements.selectSessionPolicy.get(sessionId.trim())
      return Number(row?.auto_approve ?? 0) === 1
    },

    /** Record or revoke session-wide automatic workflow execution approval. */
    setSessionAutoApprove(sessionId, enabled) {
      if (typeof sessionId !== 'string' || sessionId.trim() === '') return false
      const normalized = sessionId.trim()
      const approved = enabled ? 1 : 0
      statements.upsertSessionPolicy.run(normalized, approved, now())
      return approved === 1
    },

    close() {
      if (closed) return
      closed = true
      try {
        db.close()
      } catch {
        // an already-closed handle is not an error during unload
      }
    },
  }

  // Methods that readers expect as a list. After `close()` they answer with an
  // empty result instead of touching a finalized statement, which is what a
  // late async callback would otherwise do.
  const LIST_METHODS = new Set([
    'listRuns', 'listActors', 'listNodes', 'listArtifacts', 'listArtifactVersions',
    'listEvents', 'listEventsOfType', 'listLiveRuns',
  ])

  return new Proxy(api, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value
      if (property === 'close') return value
      return (...args) => {
        if (closed) {
          if (property === 'reconcileInterruptedRuns') return { runs: 0, nodes: 0 }
          if (property === 'isSessionAutoApproved') return false
          return LIST_METHODS.has(property) ? [] : undefined
        }
        return value.apply(target, args)
      }
    },
  })
}

/**
 * @typedef {ReturnType<typeof openJournal>} Journal
 */
