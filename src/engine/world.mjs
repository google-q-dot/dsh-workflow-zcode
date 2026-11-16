/**
 * `world.*` — the workspace surface a workflow script may read.
 *
 * ZCode lets a script read the repository (`files.*`, `git.*`) and run a
 * whitelisted command (`world.run`) while keeping it read-only. Two rules make
 * that safe here:
 *
 * 1. **No shell, ever.** Every operation becomes an argv array. `world.run`
 *    requires a compile-time string literal command, and runtime values travel
 *    inside the args array, so a script cannot assemble a command line.
 * 2. **The Session's policy decides.** `exec` is injected by the host, which
 *    confines the argv through `ctx.sandbox` before spawning. This module never
 *    spawns anything itself, which is what makes it testable and what keeps the
 *    policy in one place.
 *
 * Limits mirror the origin (`.recon`): 2000 glob files, 2000 grep hits and
 * 256 KiB of grep output, 512 KiB of diff, 100 log entries, 256 KiB per
 * stream from `world.run`, and a 300 s default timeout. Exceeding a limit
 * rejects; it never silently truncates a result the script then reasons about.
 *
 * @module dsh-workflow-zcode/engine/world
 */

import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Hard limits, copied from the origin's world-read implementation. */
export const WORLD_LIMITS = Object.freeze({
  globFiles: 2000,
  grepHits: 2000,
  grepBytes: 256 * 1024,
  diffBytes: 512 * 1024,
  logEntries: 100,
  runStreamBytes: 256 * 1024,
  runTimeoutMs: 300_000,
  readBytes: 256 * 1024,
})

/** Every world failure carries a stable code so the script can branch on it. */
export class WorldError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'WorldError'
    this.code = code
  }
}

const fail = (code, message) => {
  throw new WorldError(code, message)
}

/** Translate one shell-style glob into an anchored regex. */
function globToRegExp(pattern) {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        // `**/` matches zero or more directories; `**` alone matches anything.
        if (pattern[index + 2] === '/') {
          source += '(?:.*/)?'
          index += 2
        } else {
          source += '.*'
          index += 1
        }
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (character === '?') {
      source += '[^/]'
      continue
    }
    if ('\\^$.|+()[]{}'.includes(character)) {
      source += `\\${character}`
      continue
    }
    source += character
  }
  return new RegExp(`^${source}$`, 'u')
}

/**
 * Build the world reader for one run.
 *
 * @param {object} input
 * @param {string} input.cwd absolute workspace directory
 * @param {(argv: readonly string[], options: { timeoutMs?: number }) => Promise<{ exitCode: number|null, stdout: string, stderr: string, timedOut?: boolean }>} input.exec
 * @returns {World}
 */
export function createWorld({ cwd, exec }) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
    throw new TypeError('world: cwd must be an absolute directory')
  }
  if (typeof exec !== 'function') {
    throw new TypeError('world: exec must be provided by the host')
  }

  /**
   * Lexical containment. Necessary but NOT sufficient: a symlink inside the
   * workspace can point anywhere, so every read also passes `insideReal`.
   */
  const inside = (path) => {
    const absolute = isAbsolute(path) ? path : resolve(cwd, path)
    const rel = relative(cwd, absolute)
    if (rel.startsWith('..') || rel === '..' || rel.includes(`..${sep}`)) {
      fail('outside_workspace', `world read refused: ${path} is outside the workspace`)
    }
    return absolute
  }

  /** The workspace root with symlinks resolved, resolved once. */
  let realRootPromise
  const realRoot = () => {
    realRootPromise ??= realpath(cwd)
    return realRootPromise
  }

  /**
   * Physical containment: resolve the workspace and the target, then require the
   * target to stay under it. This is what stops `link -> /etc` from reading
   * outside the workspace while looking like a local path.
   */
  const insideReal = async (path) => {
    const lexical = inside(path)
    let resolved
    try {
      resolved = await realpath(lexical)
    } catch {
      // A missing path has no symlink to follow; the caller's own stat/read
      // reports the absence with a better message.
      return lexical
    }
    const root = await realRoot()
    const rel = relative(root, resolved)
    if (rel.startsWith('..') || rel === '..' || rel.includes(`..${sep}`)) {
      fail('outside_workspace', `world read refused: ${path} resolves outside the workspace`)
    }
    return resolved
  }

  const walk = async (root, pattern, matches, limit) => {
    const pending = [root]
    while (pending.length > 0) {
      if (matches.length >= limit) return
      const directory = pending.pop()
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (matches.length >= limit) return
        if (entry.name === '.git' || entry.name === 'node_modules') continue
        const absolute = join(directory, entry.name)
        if (entry.isDirectory()) {
          pending.push(absolute)
          continue
        }
        if (!entry.isFile()) continue
        const rel = relative(cwd, absolute).split(sep).join('/')
        if (pattern.test(rel)) matches.push(rel)
      }
    }
  }

  const runGit = async (argv, limitBytes) => {
    const result = await exec(['git', ...argv], { timeoutMs: WORLD_LIMITS.runTimeoutMs })
    if (result.timedOut === true) fail('timed_out', `git ${argv.join(' ')} timed out`)
    // A non-zero exit is a value, not a failure: `git log` in a fresh repo exits 0
    // with no output, and a missing ref exits 128 with a message worth showing.
    if (result.stdout.length > limitBytes) {
      fail('output_too_large', `git ${argv.join(' ')} produced more than ${limitBytes} bytes`)
    }
    return result
  }

  return {
    cwd,

    async read(path, { maxBytes = WORLD_LIMITS.readBytes } = {}) {
      const absolute = await insideReal(path)
      // Check the size BEFORE reading: reading a 2 GiB file to discover it is
      // too big is how a workflow takes the whole Host down.
      const info = await stat(absolute)
      if (!info.isFile()) fail('not_a_file', `files.read: ${path} is not a file`)
      if (info.size > maxBytes) {
        fail('output_too_large', `files.read: ${path} is ${info.size} bytes; the limit is ${maxBytes}`)
      }
      const text = await readFile(absolute, 'utf8')
      if (Buffer.byteLength(text, 'utf8') > maxBytes) {
        fail('output_too_large', `files.read exceeded ${maxBytes} bytes; read a range instead`)
      }
      // Report the path relative to the RESOLVED root: on macOS `/var` is a
      // symlink to `/private/var`, so a lexical base would produce `../../..`.
      // The facade declares `read(): Promise<string>`; returning an object here
      // would typecheck as a string and then explode at run time.
      return text
    },

    async glob(pattern, { limit = WORLD_LIMITS.globFiles } = {}) {
      const bounded = Math.max(1, Math.min(WORLD_LIMITS.globFiles, limit))
      const matcher = globToRegExp(pattern)
      const matches = []
      await walk(cwd, matcher, matches, bounded + 1)
      // A partial view is worse than an error: the origin rejects so the author
      // narrows the pattern instead of reasoning about a truncated listing.
      if (matches.length > bounded) {
        fail('output_too_large', `files.glob matched more than ${bounded} files; narrow the pattern`)
      }
      return matches.sort()
    },

    async grep(pattern, glob) {
      const bounded = WORLD_LIMITS.grepHits
      // `glob` is a path filter, exactly as the facade declares it.
      const matcher = typeof glob === 'string' && glob !== '' ? globToRegExp(glob) : globToRegExp('**/*')
      const files = []
      await walk(cwd, matcher, files, WORLD_LIMITS.globFiles)
      const hits = []
      let bytes = 0
      for (const file of files) {
        if (hits.length >= bounded) break
        if (bytes >= WORLD_LIMITS.grepBytes) break
        const absolute = join(cwd, file)
        let info
        try {
          info = await stat(absolute)
        } catch {
          continue
        }
        // Skip oversized files instead of pulling them into memory: grep is a
        // scan, so one huge file must not decide the peak footprint.
        if (!info.isFile() || info.size > WORLD_LIMITS.readBytes) continue
        let text
        try {
          text = await readFile(absolute, 'utf8')
        } catch {
          continue
        }
        if (text.includes('\u0000')) continue
        const lines = text.split('\n')
        for (let index = 0; index < lines.length; index += 1) {
          if (hits.length >= bounded) break
          if (!lines[index].includes(pattern)) continue
          const hit = { path: file, line: index + 1, text: lines[index] }
          bytes += hit.text.length
          hits.push(hit)
          if (bytes >= WORLD_LIMITS.grepBytes) break
        }
      }
      // Same rule as glob: reject rather than hand back a partial search.
      if (hits.length >= bounded || bytes >= WORLD_LIMITS.grepBytes) {
        fail('output_too_large', `files.grep exceeded its limit (${bounded} hits or ${WORLD_LIMITS.grepBytes} bytes); narrow the pattern`)
      }
      return hits
    },

    async changedFiles(base) {
      const argv = ['status', '--porcelain']
      if (typeof base === 'string' && base !== '') argv.push(base)
      const result = await runGit(argv, WORLD_LIMITS.diffBytes)
      // Porcelain lines are `<XY> <path>`: the two status columns are positions,
      // so the path is sliced from the RAW line. Trimming first would eat the
      // leading space of an unstaged change and shear the first path character.
      // The facade declares `changedFiles(): Promise<string[]>`.
      return result.stdout
        .split('\n')
        .filter((line) => line.length > 3)
        .map((line) => line.slice(3).trim())
        .filter((line) => line !== '')
    },

    async gitStatus() {
      // Porcelain v1 parsed into the documented shape, because the facade's
      // GitStatus is what a script branches on.
      const result = await runGit(['status', '--porcelain', '--branch'], WORLD_LIMITS.diffBytes)
      if (result.exitCode !== 0) {
        fail('not_a_repository', result.stderr.trim() === '' ? 'git status failed' : result.stderr.trim())
      }
      const status = { clean: true, staged: [], unstaged: [], untracked: [] }
      for (const line of result.stdout.split('\n')) {
        if (line === '') continue
        if (line.startsWith('## ')) {
          const branch = line.slice(3).split('...')[0].trim()
          if (branch !== '' && !branch.startsWith('HEAD')) status.branch = branch
          continue
        }
        const [indexFlag, workFlag] = [line[0], line[1]]
        const path = line.slice(3).trim()
        if (path === '') continue
        if (indexFlag === '?') status.untracked.push(path)
        else if (indexFlag !== ' ') status.staged.push(path)
        else if (workFlag !== ' ') status.unstaged.push(path)
      }
      status.clean = status.staged.length === 0 && status.unstaged.length === 0 && status.untracked.length === 0
      return status
    },

    async gitDiff(base, path) {
      const argv = ['diff', '--no-color']
      if (typeof base === 'string' && base !== '') argv.push(base)
      if (typeof path === 'string' && path !== '') argv.push('--', await insideReal(path))
      const result = await runGit(argv, WORLD_LIMITS.diffBytes)
      if (result.exitCode !== 0) {
        fail('git_failed', result.stderr.trim() === '' ? 'git diff failed' : result.stderr.trim())
      }
      return result.stdout
    },

    async gitLog(count = WORLD_LIMITS.logEntries) {
      const bounded = Math.max(1, Math.min(WORLD_LIMITS.logEntries, count))
      const result = await runGit(
        ['log', `-n${bounded}`, '--pretty=format:%H%x09%an%x09%aI%x09%s'],
        WORLD_LIMITS.diffBytes,
      )
      if (result.exitCode !== 0) {
        fail('git_failed', result.stderr.trim() === '' ? 'git log failed' : result.stderr.trim())
      }
      // GitCommit: { hash, subject, author, date } with an ISO 8601 date.
      return result.stdout.split('\n').filter((line) => line !== '').map((line) => {
        const [hash, author, date, subject] = line.split('\t')
        return { hash, subject, author, date }
      })
    },

    /**
     * Run one whitelisted command. `command` must be a bare executable name or
     * an absolute path; the args array is passed through untouched.
     */
    async run(command, args = [], { timeoutMs = WORLD_LIMITS.runTimeoutMs } = {}) {
      if (typeof command !== 'string' || command === '') {
        fail('invalid_command', 'world.run requires a command name')
      }
      if (command.includes(' ') || command.includes('/') && !isAbsolute(command)) {
        fail('invalid_command', `world.run refuses a command that is not a bare name or absolute path: ${command}`)
      }
      const argv = [command, ...(Array.isArray(args) ? args.map((value) => String(value)) : [])]
      const bounded = Math.max(1, Math.min(WORLD_LIMITS.runTimeoutMs, timeoutMs))
      const result = await exec(argv, { timeoutMs: bounded })
      if (result.timedOut === true) fail('timed_out', `world.run ${command} timed out after ${bounded} ms`)
      // The origin rejects an oversized output rather than truncating it; a
      // silently shortened string is worse than an error because the script
      // would reason about data it never received.
      if (result.truncated === true) {
        fail('output_too_large', `world.run ${command} produced more output than the transport keeps`)
      }
      if (result.stdout.length > WORLD_LIMITS.runStreamBytes) {
        fail('output_too_large', `world.run stdout exceeded ${WORLD_LIMITS.runStreamBytes} bytes`)
      }
      if (result.stderr.length > WORLD_LIMITS.runStreamBytes) {
        fail('output_too_large', `world.run stderr exceeded ${WORLD_LIMITS.runStreamBytes} bytes`)
      }
      // A non-zero exit is a normal value the script may branch on.
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      }
    },
  }
}

/**
 * @typedef {ReturnType<typeof createWorld>} World
 */
