/**
 * Offline checks for the workspace reader and the artifact publisher. Both are
 * pure given an injected `exec` and an in-memory journal, so they need neither
 * a Harness runtime nor a real subagent.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWorld, WORLD_LIMITS, WorldError } from '../src/engine/world.mjs'
import { ARTIFACT_LIMITS, ArtifactFatalError, ArtifactRejected, createArtifactPublisher } from '../src/engine/artifacts.mjs'
import { ARTIFACT_KIND, openJournal } from '../src/engine/journal.mjs'

/** Build a temp workspace with a few files and a directory. */
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'zcode-world-'))
  await mkdir(join(root, 'src', 'nested'), { recursive: true })
  await writeFile(join(root, 'README.md'), '# 标题\n包含 needle 的行\n')
  await writeFile(join(root, 'src', 'a.mjs'), 'export const a = 1\n')
  await writeFile(join(root, 'src', 'nested', 'b.mjs'), 'export const b = 2 // needle\n')
  await writeFile(join(root, 'notes.txt'), 'needle 第一次\nneedle 第二次\n')
  return root
}

/** A fake host executor that records argv and returns canned results. */
function fakeExec(handler = () => ({ exitCode: 0, stdout: '', stderr: '' })) {
  const calls = []
  const exec = async (argv, options) => {
    calls.push({ argv, options })
    return handler(argv, options)
  }
  return { exec, calls }
}

test('world: reads inside the workspace and refuses escapes', async () => {
  const root = await workspace()
  try {
    const { exec } = fakeExec()
    const world = createWorld({ cwd: root, exec })
    // The facade declares `read(): Promise<string>`.
    const read = await world.read('README.md')
    assert.equal(typeof read, 'string')
    assert.match(read, /needle/)

    await assert.rejects(
      () => world.read('../outside.txt'),
      (error) => error instanceof WorldError && error.code === 'outside_workspace',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('world: a symlink pointing outside the workspace is refused', async () => {
  const root = await workspace()
  const outside = await mkdtemp(join(tmpdir(), 'zcode-outside-'))
  try {
    await writeFile(join(outside, 'secret.txt'), 'TOP SECRET')
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'))

    const world = createWorld({ cwd: root, exec: fakeExec().exec })
    // Lexically this is a workspace path; physically it is not.
    await assert.rejects(
      () => world.read('link.txt'),
      (error) => error instanceof WorldError && error.code === 'outside_workspace',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('world: an oversized file is refused before it is read', async () => {
  const root = await workspace()
  try {
    await writeFile(join(root, 'big.txt'), 'x'.repeat(4096))
    const world = createWorld({ cwd: root, exec: fakeExec().exec })
    await assert.rejects(
      () => world.read('big.txt', { maxBytes: 1024 }),
      (error) => error instanceof WorldError && error.code === 'output_too_large' && /4096 bytes/.test(error.message),
    )
    // The guard is a size check, not a length check: a small file still reads.
    const small = await world.read('big.txt', { maxBytes: 8192 })
    assert.equal(small.length, 4096)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('world: glob matches paths and honours ** separators', async () => {
  const root = await workspace()
  try {
    const world = createWorld({ cwd: root, exec: fakeExec().exec })
    assert.deepEqual(await world.glob('**/*.mjs'), ['src/a.mjs', 'src/nested/b.mjs'])
    assert.deepEqual(await world.glob('*.md'), ['README.md'])
    assert.deepEqual(await world.glob('src/nested/*.mjs'), ['src/nested/b.mjs'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('world: grep reports line numbers and stops at the byte ceiling', async () => {
  const root = await workspace()
  try {
    const world = createWorld({ cwd: root, exec: fakeExec().exec })
    const hits = await world.grep('needle')
    // Four matching lines across three files: notes.txt has two.
    assert.equal(hits.length, 4)
    // One hit per matching line; GrepMatch is {path, line, text}.
    assert.deepEqual([...new Set(hits.map((hit) => hit.path))].sort(), ['README.md', 'notes.txt', 'src/nested/b.mjs'])
    assert.equal(hits.find((hit) => hit.path === 'notes.txt').line, 1)
    assert.equal(hits[0].text.includes('needle'), true)

    // The second argument narrows by path glob, as the facade declares.
    const narrowed = await world.grep('needle', 'src/**/*.mjs')
    assert.equal(narrowed.length, 1)
    assert.equal(narrowed[0].path, 'src/nested/b.mjs')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('world: git operations pass argv without a shell and parse the log', async () => {
  const root = await workspace()
  try {
    const { exec, calls } = fakeExec((argv) => {
      if (argv.includes('log')) {
        return { exitCode: 0, stdout: 'abc123\t张三\t2026-11-15\t首次提交\ndef456\t李四\t2026-11-14\t修复', stderr: '' }
      }
      if (argv.includes('--porcelain')) {
        return { exitCode: 0, stdout: ' M src/a.mjs\n?? notes.txt\n', stderr: '' }
      }
      return { exitCode: 0, stdout: 'diff --git a/x b/x', stderr: '' }
    })
    const world = createWorld({ cwd: root, exec })

    assert.deepEqual(await world.changedFiles(), ['src/a.mjs', 'notes.txt'])

    const log = await world.gitLog(5)
    assert.equal(log.length, 2)
    assert.equal(log[0].hash, 'abc123')
    assert.equal(log[0].subject, '首次提交')
    assert.equal(log[1].author, '李四')

    const diff = await world.gitDiff(undefined, 'src/a.mjs')
    assert.match(diff, /diff --git/)
    // Every call is an argv array: no shell string ever reaches the host.
    for (const call of calls) assert.equal(Array.isArray(call.argv), true)
    assert.deepEqual(calls.find((call) => call.argv.includes('log')).argv.slice(0, 2), ['git', 'log'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('world: a non-zero exit is a value, a timeout and an oversized stream are not', async () => {
  const root = await workspace()
  try {
    const okWorld = createWorld({
      cwd: root,
      exec: fakeExec(() => ({ exitCode: 2, stdout: 'out', stderr: 'boom' })).exec,
    })
    const result = await okWorld.run('python3', ['-c', 'x'])
    assert.equal(result.exitCode, 2)
    assert.equal(result.stderr, 'boom')

    const slow = createWorld({
      cwd: root,
      exec: fakeExec(() => ({ exitCode: null, stdout: '', stderr: '', timedOut: true })).exec,
    })
    await assert.rejects(
      () => slow.run('sleep', ['10']),
      (error) => error instanceof WorldError && error.code === 'timed_out',
    )

    const noisy = createWorld({
      cwd: root,
      exec: fakeExec(() => ({ exitCode: 0, stdout: 'x'.repeat(WORLD_LIMITS.runStreamBytes + 1), stderr: '' })).exec,
    })
    await assert.rejects(
      () => noisy.run('cat'),
      (error) => error instanceof WorldError && error.code === 'output_too_large',
    )

    // A lossy transport read must fail, never masquerade as complete output.
    const lossy = createWorld({
      cwd: root,
      exec: fakeExec(() => ({ exitCode: 0, stdout: 'partial', stderr: '', truncated: true })).exec,
    })
    await assert.rejects(
      () => lossy.run('cat'),
      (error) => error instanceof WorldError && error.code === 'output_too_large',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('world: world.run refuses a shell-shaped command', async () => {
  const root = await workspace()
  try {
    const world = createWorld({ cwd: root, exec: fakeExec().exec })
    await assert.rejects(
      () => world.run('bash -c "rm -rf /"', []),
      (error) => error instanceof WorldError && error.code === 'invalid_command',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function publisherFixture() {
  const journal = openJournal()
  journal.createRun({ id: 'run-1', parentSessionId: 'sess-A', cwd: '/w', name: 'n', capsMaxConcurrency: 2 })
  const publisher = createArtifactPublisher({ runId: 'run-1', cwd: process.cwd(), journal })
  return { journal, publisher }
}

test('artifacts: a preset declared twice is a no-op, a different spec fails the run', () => {
  const { journal, publisher } = publisherFixture()
  try {
    publisher.declare(ARTIFACT_KIND.chart, 'trend', { title: '趋势', x: 'day', y: 'score' })
    // Identical spec: explicitly a no-op.
    publisher.declare(ARTIFACT_KIND.chart, 'trend', { title: '趋势', x: 'day', y: 'score' })
    assert.equal(journal.listArtifacts('run-1').length, 1)

    assert.throws(
      () => publisher.declare(ARTIFACT_KIND.chart, 'trend', { title: '趋势', x: 'day', y: 'other' }),
      (error) => error instanceof ArtifactFatalError && /different spec/.test(error.message),
    )
    assert.throws(
      () => publisher.declare(ARTIFACT_KIND.table, 'trend', { columns: [] }),
      (error) => error instanceof ArtifactFatalError && /already declared as chart/.test(error.message),
    )
  } finally {
    journal.close()
  }
})

test('artifacts: markdown versions increment and bad bodies are rejected catchably', async () => {
  const { journal, publisher } = publisherFixture()
  try {
    const first = await publisher.publishMarkdown('report', '# 第一版')
    assert.equal(first.version, 1)
    const second = await publisher.publishMarkdown('report', '# 第二版', { primary: true })
    assert.equal(second.version, 2)
    assert.equal(second.bytes, Buffer.byteLength('# 第二版'))

    await assert.rejects(
      () => publisher.publishMarkdown('empty', '   '),
      (error) => error instanceof ArtifactRejected && error.code === 'empty_content',
    )
    await assert.rejects(
      () => publisher.publishMarkdown('huge', 'x'.repeat(ARTIFACT_LIMITS.markdownBytes + 1)),
      (error) => error instanceof ArtifactRejected && error.code === 'too_large',
    )

    const snapshot = publisher.snapshot()
    assert.equal(snapshot.primaryMarkdown, '# 第二版')
    assert.equal(snapshot.artifacts.find((artifact) => artifact.id === 'report').version, 2)
  } finally {
    journal.close()
  }
})

test('artifacts: file publishing copies now and refuses escapes and empties', async () => {
  const root = await workspace()
  const journal = openJournal()
  try {
    journal.createRun({ id: 'run-1', parentSessionId: 'sess-A', cwd: root, name: 'n', capsMaxConcurrency: 2 })
    const publisher = createArtifactPublisher({ runId: 'run-1', cwd: root, journal })

    const published = await publisher.publishFile('doc', 'README.md', { title: '交付' })
    assert.equal(published.kind, ARTIFACT_KIND.file)
    assert.equal(published.contentType, 'text/markdown')
    assert.equal(published.version, 1)

    await writeFile(join(root, 'empty.txt'), '')
    await assert.rejects(
      () => publisher.publishFile('e', 'empty.txt'),
      (error) => error instanceof ArtifactRejected && error.code === 'empty_content',
    )
    await assert.rejects(
      () => publisher.publishFile('outside', '../escape.txt'),
      (error) => error instanceof ArtifactRejected && error.code === 'outside_workspace',
    )
    await assert.rejects(
      () => publisher.publishFile('missing', 'nope.txt'),
      (error) => error instanceof ArtifactRejected && error.code === 'not_found',
    )
  } finally {
    journal.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('artifacts: reports are capped and cannot target a content artifact', () => {
  const { journal, publisher } = publisherFixture()
  try {
    publisher.declare(ARTIFACT_KIND.metrics, 'kpi', { metrics: [] })
    const entry = publisher.report({ score: 80 }, 'kpi')
    assert.equal(entry.tag, 'kpi')
    assert.equal(entry.total, 1)

    assert.throws(
      () => publisher.report('x'.repeat(ARTIFACT_LIMITS.reportBytes + 1), null),
      (error) => error instanceof ArtifactFatalError && /limit is/.test(error.message),
    )
    // Reporting to an id nobody declared is allowed: the tag is recorded and the
    // panel shows an undrawable item rather than failing a run that otherwise
    // produced its deliverable.
    const untagged = publisher.report({ a: 1 }, 'not-declared-as-preset')
    assert.equal(untagged.tag, 'not-declared-as-preset')
  } finally {
    journal.close()
  }
})

test('artifacts: only the first primary wins and ids are validated', async () => {
  const { journal, publisher } = publisherFixture()
  try {
    await publisher.publishMarkdown('a', '# a', { primary: true })
    const second = await publisher.publishMarkdown('b', '# b', { primary: true })
    assert.equal(second.version, 1)
    const snapshot = publisher.snapshot()
    assert.equal(snapshot.artifacts.filter((artifact) => artifact.primary).length, 1)

    await assert.rejects(
      () => publisher.publishMarkdown('bad id!', '# x'),
      (error) => error instanceof ArtifactFatalError && /artifact ids/.test(error.message),
    )
  } finally {
    journal.close()
  }
})


test('artifacts: a published file is snapshotted, so editing it later changes nothing', async () => {
  const root = await workspace()
  const journal = openJournal()
  try {
    journal.createRun({ id: 'run-1', parentSessionId: 'sess-A', cwd: root, name: 'n', capsMaxConcurrency: 2 })
    const snapshots = join(root, '.snapshots')
    const publisher = createArtifactPublisher({ runId: 'run-1', cwd: root, journal, snapshotRoot: snapshots })

    const published = await publisher.publishFile('doc', 'README.md')
    const snapshotPath = journal.listArtifacts('run-1')[0].spec.snapshot
    const original = await readFile(snapshotPath, 'utf8')
    assert.match(original, /# 标题/)

    // The workspace copy changes; the published version must not.
    await writeFile(join(root, 'README.md'), '# 改写后的内容\n')
    const afterEdit = await readFile(snapshotPath, 'utf8')
    assert.equal(afterEdit, original)
    assert.equal(published.version, 1)
  } finally {
    journal.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('artifacts: a later version keeps the version history and never clears primary', async () => {
  const root = await workspace()
  const journal = openJournal()
  try {
    journal.createRun({ id: 'run-1', parentSessionId: 'sess-A', cwd: root, name: 'n', capsMaxConcurrency: 2 })
    const publisher = createArtifactPublisher({
      runId: 'run-1', cwd: root, journal, snapshotRoot: join(root, '.snapshots'),
    })

    await publisher.publishMarkdown('report', '# 第一版', { primary: true })
    // A second publish without `primary` must not undo the earlier claim.
    await publisher.publishMarkdown('report', '# 第二版')

    const head = journal.listArtifacts('run-1').find((artifact) => artifact.artifactId === 'report')
    assert.equal(head.version, 2)
    assert.equal(head.body, '# 第二版')
    assert.equal(head.primary, true, 'primary names the deliverable, not the newest write')

    const versions = journal.listArtifactVersions('run-1', 'report')
    assert.deepEqual(versions.map((version) => version.version), [1, 2])
    // Version 1 still says what it said.
    assert.equal(versions[0].body, '# 第一版')
  } finally {
    journal.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('artifacts: reports are rebuildable from the journal after a restart', async () => {
  const { journal } = publisherFixture()
  try {
    const first = createArtifactPublisher({ runId: 'run-1', cwd: process.cwd(), journal })
    first.declare(ARTIFACT_KIND.metrics, 'kpi', { metrics: [] })
    first.report({ score: 61 }, 'kpi')
    journal.appendEvent('run-1', 'report', { artifactId: 'kpi', item: { score: 61 } })
    journal.appendEvent('run-1', 'report', { artifactId: 'kpi', item: { score: 74 } })

    // A brand-new publisher has an empty in-memory ledger, like a restarted Host.
    const second = createArtifactPublisher({ runId: 'run-1', cwd: process.cwd(), journal })
    assert.deepEqual(second.snapshot().reports, [
      { artifactId: 'kpi', item: { score: 61 } },
      { artifactId: 'kpi', item: { score: 74 } },
    ])
  } finally {
    journal.close()
  }
})


test('artifacts: a resumed publisher rebuilds what the run already published', async () => {
  const root = await workspace()
  const journal = openJournal()
  try {
    journal.createRun({ id: 'run-1', parentSessionId: 'sess-A', cwd: root, name: 'n', capsMaxConcurrency: 2 })
    const first = createArtifactPublisher({
      runId: 'run-1', cwd: root, journal, snapshotRoot: join(root, '.snap'),
    })
    await first.publishMarkdown('report', '# 第一版', { primary: true })
    first.declare(ARTIFACT_KIND.metrics, 'kpi', { metrics: [] })

    // A second publisher stands in for a resumed attempt: it starts with no
    // memory, so everything must come back from the journal.
    const second = createArtifactPublisher({
      runId: 'run-1', cwd: root, journal, snapshotRoot: join(root, '.snap'),
    })
    // A second primary is impossible: the seeded id already holds the flag.
    await second.publishMarkdown('other', '# 另一个', { primary: true })
    const primaries = journal.listArtifacts('run-1').filter((artifact) => artifact.primary === true)
    assert.equal(primaries.length, 1, 'a run must have exactly one primary artifact')
    assert.equal(primaries[0].artifactId, 'report')

    // Re-declaring a taken id with another type is still fatal after a restart.
    assert.throws(
      () => second.declare(ARTIFACT_KIND.chart, 'kpi', { x: 'a', y: 'b' }),
      (error) => error instanceof ArtifactFatalError && /already declared as metrics/.test(error.message),
    )
  } finally {
    journal.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('artifacts: the per-run id ceiling counts artifacts from earlier attempts', async () => {
  const root = await workspace()
  const journal = openJournal()
  try {
    journal.createRun({ id: 'run-1', parentSessionId: 'sess-A', cwd: root, name: 'n', capsMaxConcurrency: 2 })
    // Fill the run's budget as an earlier attempt would have.
    for (let index = 0; index < ARTIFACT_LIMITS.idsPerRun; index += 1) {
      journal.putArtifact({ runId: 'run-1', artifactId: `a${index}`, kind: ARTIFACT_KIND.markdown, body: '#x' })
    }
    const resumed = createArtifactPublisher({
      runId: 'run-1', cwd: root, journal, snapshotRoot: join(root, '.snap'),
    })
    await assert.rejects(
      () => resumed.publishMarkdown('fresh', '# 新的'),
      (error) => error instanceof ArtifactFatalError && /at most 32 artifacts/.test(error.message),
    )
  } finally {
    journal.close()
    await rm(root, { recursive: true, force: true })
  }
})
