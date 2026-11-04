#!/usr/bin/env node
/**
 * Stage the pinned codex binary for this platform into
 * `resources/codex/<version>/<platform>-<arch>/`, and record its sha256 in
 * `resources/codex/manifest.json`.
 *
 * The release artifact ships that directory beside the executable; the gateway
 * resolves it through scripts/codex-resource.mjs. Run this on each build host,
 * once per platform, with the version the release pins.
 */
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const ASSETS = {
  'win32-x64': { asset: 'codex-x86_64-pc-windows-msvc.exe.zip', binary: 'codex.exe' },
  'darwin-arm64': { asset: 'codex-package-aarch64-apple-darwin.tar.gz', binary: 'codex' },
  'darwin-x64': { asset: 'codex-package-x86_64-apple-darwin.tar.gz', binary: 'codex' },
  'linux-x64': { asset: 'codex-package-x86_64-unknown-linux-musl.tar.gz', binary: 'codex', libc: 'musl' },
  'linux-arm64': { asset: 'codex-package-aarch64-unknown-linux-musl.tar.gz', binary: 'codex', libc: 'musl' },
}

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const version = arg('version', '0.166.0')
const platform = arg('platform', process.platform)
const arch = arg('arch', process.arch)
const key = `${platform}-${arch}`
const spec = ASSETS[key]
if (!spec) {
  console.error(`stage-codex: no pinned asset for ${key}; known: ${Object.keys(ASSETS).join(', ')}`)
  process.exit(2)
}

const dir = path.join(ROOT, 'resources', 'codex', version, key)
const url = `https://github.com/openai/codex/releases/download/rust-v${version}/${spec.asset}`
const work = path.join(os.tmpdir(), `stage-codex-${version}-${key}`)

await mkdir(work, { recursive: true })
await mkdir(dir, { recursive: true })

const archive = path.join(work, spec.asset)
if (!existsSync(archive)) {
  console.log(`stage-codex: ${url}`)
  const download = spawnSync('curl', ['-fL', '--retry', '2', '-o', archive, url], { stdio: ['ignore', 'inherit', 'inherit'] })
  if (download.status !== 0) {
    console.error(`stage-codex: download failed (curl exit ${download.status})`)
    process.exit(1)
  }
}

const bytes = await readFile(archive)
const sha256 = createHash('sha256').update(bytes).digest('hex')

const extractDir = path.join(work, 'x')
await rm(extractDir, { recursive: true, force: true })
await mkdir(extractDir, { recursive: true })
// GNU tar (the one a Windows shell usually finds) cannot read zip, and it reads
// a `C:\...` archive argument as a remote host. Use Windows' own extractor for
// zip and a relative archive path for tar.
const extracted = spec.asset.endsWith('.zip')
  ? spawnSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${extractDir}' -Force`], { stdio: ['ignore', 'inherit', 'inherit'] })
  : spawnSync('tar', ['-xzf', archive, '-C', extractDir], { stdio: ['ignore', 'inherit', 'inherit'] })
if (extracted.status !== 0) {
  console.error(`stage-codex: extraction failed (exit ${extracted.status})`)
  process.exit(1)
}

// The release is a directory: codex-package.json names the entrypoint and the
// exec-server/resources/path directories that must travel with it. Stage the
// whole tree; a release without that manifest still works as a single binary.
// A tarball may keep the tree under one top-level directory.
let packageRoot = extractDir
if (!existsSync(path.join(packageRoot, 'codex-package.json'))) {
  const tops = (await readdir(packageRoot, { withFileTypes: true })).filter(entry => entry.isDirectory())
  if (tops.length === 1 && existsSync(path.join(packageRoot, tops[0].name, 'codex-package.json'))) {
    packageRoot = path.join(packageRoot, tops[0].name)
  }
}
let entrypoint = spec.binary
if (existsSync(path.join(packageRoot, 'codex-package.json'))) {
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'codex-package.json'), 'utf8'))
  if (typeof manifest.entrypoint === 'string' && !manifest.entrypoint.includes('..')) {
    entrypoint = manifest.entrypoint
  }
}

await rm(dir, { recursive: true, force: true })
await mkdir(dir, { recursive: true })
for (const entry of await readdir(packageRoot, { withFileTypes: true })) {
  await cp(path.join(packageRoot, entry.name), path.join(dir, entry.name), { recursive: true })
}

const target = path.join(dir, entrypoint)
if (!existsSync(target)) {
  console.error(`stage-codex: ${entrypoint} not found in ${spec.asset}`)
  process.exit(1)
}
if (platform !== 'win32') await chmod(target, 0o755)

const versionCheck = spawnSync(target, ['--version'], { encoding: 'utf8', timeout: 60_000 })
if (versionCheck.status !== 0) {
  console.error(`stage-codex: staged binary failed --version: ${versionCheck.stderr || versionCheck.stdout}`)
  process.exit(1)
}

/** Content-addressed digest of the staged tree, so an artifact can detect drift. */
async function walkFiles(directory, base = directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walkFiles(full, base))
    else if (entry.isFile()) files.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return files
}

async function treeDigest(directory) {
  const hash = createHash('sha256')
  for (const relative of (await walkFiles(directory)).sort()) {
    hash.update(relative)
    hash.update('\0')
    hash.update(createHash('sha256').update(await readFile(path.join(directory, relative))).digest('hex'))
    hash.update('\n')
  }
  return hash.digest('hex')
}

const treeSha256 = await treeDigest(dir)

// The manifest is the pin: a later run compares the asset hash it would stage
// with this record instead of trusting whatever the URL serves that day.
const manifestPath = path.join(ROOT, 'resources', 'codex', 'manifest.json')
let manifest = { version, entries: {} }
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
} catch {}
manifest.entries ??= {}
const previous = manifest.entries[key]?.sha256
manifest.entries[key] = {
  version,
  asset: spec.asset,
  sha256,
  treeSha256,
  entrypoint,
  ...(spec.libc ? { libc: spec.libc } : {}),
}
await mkdir(path.dirname(manifestPath), { recursive: true })
await writeFile(manifestPath, `${JSON.stringify({ version, entries: manifest.entries }, null, 2)}\n`)

console.log(`stage-codex: ${path.relative(ROOT, target)}`)
console.log(`stage-codex: sha256 ${sha256}${previous ? previous === sha256 ? ' (unchanged)' : ` (was ${previous})` : ''}`)
console.log(`stage-codex: ${versionCheck.stdout.trim()}`)
