#!/usr/bin/env node
/**
 * Summarize a release directory into one manifest and one checksum file.
 *
 * The per-artifact reports say what each package is; this says what is in the
 * release. Every entry is measured from the bytes on disk, so the manifest
 * cannot describe a file that was not built.
 *
 * Usage: node scripts/release/release-manifest.mjs --dir <out> [--version <v>]
 */
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function fail(message) {
  console.error(`release-manifest: ${message}`)
  process.exit(1)
}

const directory = path.resolve(arg('dir') ?? '')
if (!directory || !existsSync(directory)) fail('--dir must name the release output directory')

const INSTALLERS = new Set(['.msi', '.deb', '.pkg', '.dmg'])
const ARCHIVES = new Set(['.zip', '.tar.gz', '.tgz'])
const SIGNATURES = new Set(['.sha256'])

async function hash(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

async function collect(base, prefix = '') {
  const entries = []
  for (const entry of await readdir(base, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      // The unpacked trees are inputs to the installers, not deliverables.
      if (entry.name.startsWith('gateway-') || entry.name.startsWith('.') || entry.name === 'winget') continue
      entries.push(...await collect(path.join(base, entry.name), relative))
      continue
    }
    const full = path.join(base, entry.name)
    const info = await stat(full)
    const extension = ['.tar.gz', '.tgz'].find(candidate => entry.name.endsWith(candidate)) ?? path.extname(entry.name)
    entries.push({
      file: relative,
      kind: INSTALLERS.has(extension) ? 'installer' : ARCHIVES.has(extension) ? 'archive' : SIGNATURES.has(extension) ? 'checksum' : 'other',
      bytes: info.size,
      sha256: await hash(full),
    })
  }
  return entries.sort((a, b) => a.file.localeCompare(b.file))
}

const files = await collect(directory)
if (files.length === 0) fail(`no files under ${directory}`)

const version = arg('version') ?? (/gateway-(\d+\.\d+\.\d+[^/]*)-/.exec(files.map(file => file.file).join(' '))?.[1] ?? 'unversioned')

// The install trees carry the only statement about whether the artifact is
// self-contained; quote it rather than inferring from the file name.
const trees = []
for (const entry of await readdir(directory, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith('gateway-')) continue
  const manifestPath = path.join(directory, entry.name, 'install-manifest.json')
  if (!existsSync(manifestPath)) continue
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  trees.push({
    tree: entry.name,
    platform: manifest.platform,
    arch: manifest.arch,
    sourceSha: manifest.source_sha,
    runtime: manifest.runtime,
  })
}

const manifest = {
  name: 'Gateway',
  version,
  generatedAt: new Date().toISOString(),
  files,
  trees,
}
await writeFile(path.join(directory, 'RELEASE.json'), `${JSON.stringify(manifest, null, 2)}\n`)
await writeFile(
  path.join(directory, 'SHA256SUMS'),
  files.filter(file => file.kind !== 'checksum').map(file => `${file.sha256}  ${file.file}`).join('\n') + '\n',
)
console.log(JSON.stringify({ manifest: path.join(directory, 'RELEASE.json'), checksums: path.join(directory, 'SHA256SUMS'), files: files.length, trees: trees.length }, null, 2))
