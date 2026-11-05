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
    // This script's own outputs are not release payload, and hashing the
    // checksum file into the checksum file makes the result self-referential.
    if (entry.name === 'RELEASE.json' || entry.name === 'SHA256SUMS') continue
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

// The version is required rather than inferred. The names are ambiguous by
// design: installers carry the numeric version (`gateway-1.0.0-darwin-arm64
// .pkg`) and archives carry the full one (`gateway-1.0.0-research-linux-x64
// .tar.gz`), so any inference silently picks whichever file sorts first. The
// old fallback was worse than ambiguous - it joined every name into one string
// and reported "1.0.0-research-linux-x64.tar.gz gateway-1.0.0-research-win32".
const version = arg('version')
if (!version) fail('--version is required (the artifact names carry two different versions: numeric and full)')

// The install trees carry the only statement about whether the artifact is
// self-contained; quote it rather than inferring from the file name.
// A release directory keeps the install trees out (they are inputs, hundreds of
// MB each) and copies only their manifests into `manifests/`. When the trees
// are present, read them the same way.
const trees = []
async function addTree(name, manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  // Installer names use the numeric version while archives use the full one;
  // record both so a reader does not have to know that.
  const runtime = manifest.runtime
    ? { ...manifest.runtime, version: manifest.runtime.version ?? manifest.runtime.bun ?? null }
    : null
  trees.push({
    tree: name,
    platform: manifest.platform,
    arch: manifest.arch,
    version: manifest.version ?? null,
    numericVersion: manifest.numeric_version ?? null,
    sourceSha: manifest.source_sha,
    runtime,
  })
}
for (const entry of await readdir(directory, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith('gateway-')) continue
  const manifestPath = path.join(directory, entry.name, 'install-manifest.json')
  if (existsSync(manifestPath)) await addTree(entry.name, manifestPath)
}
const manifestsDirectory = path.join(directory, 'manifests')
if (existsSync(manifestsDirectory)) {
  for (const entry of await readdir(manifestsDirectory)) {
    if (!entry.endsWith('.json')) continue
    await addTree(entry.replace(/\.json$/, ''), path.join(manifestsDirectory, entry))
  }
}
trees.sort((a, b) => `${a.platform}-${a.arch}`.localeCompare(`${b.platform}-${b.arch}`))

// No timestamp: two runs over the same directory must produce the same bytes,
// or the manifest cannot be diffed between builds and a checksum comparison
// says nothing. Version, source SHA and the per-file hashes identify the build.
const manifest = {
  name: 'Gateway',
  version,
  files,
  trees,
}
await writeFile(path.join(directory, 'RELEASE.json'), `${JSON.stringify(manifest, null, 2)}\n`)
await writeFile(
  path.join(directory, 'SHA256SUMS'),
  files.filter(file => file.kind !== 'checksum').map(file => `${file.sha256}  ${file.file}`).join('\n') + '\n',
)
console.log(JSON.stringify({ manifest: path.join(directory, 'RELEASE.json'), checksums: path.join(directory, 'SHA256SUMS'), files: files.length, trees: trees.length }, null, 2))
