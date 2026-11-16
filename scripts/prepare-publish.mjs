#!/usr/bin/env node
/**
 * Build a publish-ready copy of the plugin for npm and the public GitHub repo.
 *
 * The working checkout must stay installable as the desktop profile's linked
 * `@local/dsh-workflow-zcode` row, so this script NEVER edits the checkout.
 * It copies the publishable files into `dist/publish/<name>` and rewrites the
 * two places that carry the package identity:
 *
 *   - `package.json` `name` (and the public metadata / exports / files list)
 *   - `cordis.patch.yml` row `name`, which the Loader resolves through the
 *     installed profile's node_modules and must therefore equal the npm name.
 *
 * Usage:
 *   node scripts/prepare-publish.mjs --name dsh-workflow-zcode \
 *     --repository https://github.com/google-q-dot/dsh-workflow-zcode [--pack]
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const args = {}
for (let index = 0; index < process.argv.length - 2; index += 1) {
  const arg = process.argv[index + 2]
  if (!arg.startsWith('--')) continue
  const key = arg.slice(2)
  const next = process.argv[index + 3]
  if (next === undefined || next.startsWith('--')) args[key] = true
  else {
    args[key] = next
    index += 1
  }
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const name = typeof args.name === 'string' ? args.name : 'dsh-workflow-zcode'
const repository = typeof args.repository === 'string'
  ? args.repository.replace(/\/$/, '')
  : 'https://github.com/google-q-dot/dsh-workflow-zcode'
const author = typeof args.author === 'string' ? args.author : 'qiaozhao'

if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error(`invalid npm name: ${name}`)
if (name.startsWith('@local/')) throw new Error('the publish name must be a public name, not the local link name')
if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(repository)) throw new Error(`repository must be https://github.com/<owner>/<repo>: ${repository}`)

const out = resolve(root, typeof args.out === 'string' ? args.out : join('dist', 'publish', name))
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

function copy(relative) {
  const source = join(root, relative)
  if (!existsSync(source)) throw new Error(`missing publish file: ${relative}`)
  cpSync(source, join(out, relative), { recursive: true })
}

// Everything the public repo needs. The npm tarball is narrowed by `files`.
for (const entry of ['index.mjs', 'client.js', 'src', 'facade.d.ts', 'cordis.patch.yml', 'locale', 'icon.svg', 'README.md', 'LICENSE', '.gitignore', 'test', 'scripts']) {
  copy(entry)
}

const published = {
  ...pkg,
  name,
  version: pkg.version,
  description: pkg.description,
  license: 'MIT',
  author,
  keywords: ['deepseek-harness', 'dsh', 'dsh-plugin', 'cordis', 'workflow', 'zcode'],
  repository: { type: 'git', url: `git+${repository}.git` },
  homepage: `${repository}#readme`,
  bugs: { url: `${repository}/issues` },
  engines: { node: '>=22', dsh: '>=0.2.1-rc.2 <0.3.0' },
  exports: {
    '.': './index.mjs',
    './client': './client.js',
    './locale/*.json': './locale/*.json',
    './icon': './icon.svg',
    './cordis.patch.yml': './cordis.patch.yml',
    './package.json': './package.json',
  },
  files: [
    'index.mjs',
    'client.js',
    'src/*.mjs',
    'src/engine/*.mjs',
    'facade.d.ts',
    'cordis.patch.yml',
    'locale/*.json',
    'icon.svg',
    'README.md',
    'LICENSE',
  ],
  publishConfig: { access: 'public' },
}
delete published.private
writeFileSync(join(out, 'package.json'), `${JSON.stringify(published, null, 2)}\n`)

const patchPath = join(out, 'cordis.patch.yml')
const patch = readFileSync(patchPath, 'utf8')
const localName = pkg.name
if (!patch.includes(`name: '${localName}'`)) throw new Error(`cordis.patch.yml does not name ${localName}`)
writeFileSync(patchPath, patch.replace(`name: '${localName}'`, `name: '${name}'`))

const readmePath = join(out, 'README.md')
const readme = readFileSync(readmePath, 'utf8')
if (!readme.includes(name)) throw new Error(`README.md does not mention the published name ${name}`)
writeFileSync(readmePath, readme)

// A one-file market entry, ready to upload by hand if needed (dist/ is ignored).
const market = [
  `url: ${repository}`,
  `name: ${repository.split('/').slice(-2).join('/')}`,
  'category: workflow',
  'description:',
  "  en: 'A DeepSeek Harness plugin that runs ZCode .dwf.ts dynamic workflows: TypeScript orchestration, persistent named subagents, sandboxed workspace helpers, a resumable SQLite run journal, and a ZCode-style sidebar panel for live traces, subagent rosters, artifacts, configuration and resume.'",
  "  zh: '在 DeepSeek Harness 中运行 ZCode .dwf.ts 动态工作流：TypeScript 编排、可持续对话的具名子代理、沙箱工作区能力、可续跑的 SQLite 运行日志，以及 ZCode 风格的右侧栏面板（实时轨迹、子代理花名册、产物、配置与续跑）。'",
  '',
].join('\n')
writeFileSync(join(root, 'dist', 'dsh-market-entry.yml'), market)

// Privacy / cleanliness gate over the staged text files.
const banned = [/\/Users\/[A-Za-z0-9._-]+/u, /_authToken/iu, /NPM_TOKEN/u, /BEGIN [A-Z ]*PRIVATE KEY/u]
const offenders = []
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      // The staging script itself contains the scan patterns; never scan it.
      if (entry === 'scripts' || entry === 'node_modules') continue
      walk(full)
      continue
    }
    if (!/\.(?:mjs|js|json|yml|yaml|md|ts|svg|txt)$/u.test(entry)) continue
    const text = readFileSync(full, 'utf8')
    for (const pattern of banned) {
      if (pattern.test(text)) offenders.push(`${full} matches ${pattern}`)
    }
  }
}
walk(out)
if (offenders.length > 0) throw new Error(`privacy scan failed:\n${offenders.join('\n')}`)

console.log(`publish stage: ${out}`)
console.log(`  name: ${name}`)
console.log(`  repository: ${repository}`)
console.log(`  files: ${readdirSync(out).sort().join(', ')}`)

if (args.pack === true) {
  const listing = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: out, encoding: 'utf8' })
  const [summary] = JSON.parse(listing)
  console.log(`  tarball: ${summary.filename}`)
  console.log(`  package size: ${summary.size} bytes, unpacked: ${summary.unpackedSize} bytes, ${summary.entryCount} files`)
  for (const file of summary.files) console.log(`    ${file.path}`)
}
