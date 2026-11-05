#!/usr/bin/env node
/**
 * Build a per-user Windows MSI from a packaged release tree.
 *
 * Per-user on purpose: the install writes only under
 * `%LOCALAPPDATA%\Programs\Gateway`, so it needs no elevation and no admin
 * account, which is the same posture as an npm-local install. An all-users MSI
 * would have to be signed and would put a provider key store in a shared
 * profile.
 *
 * The WiX source is generated rather than checked in: the file list is the
 * product, and a hand-maintained .wxs drifts from the tree on the first file
 * that is added or removed. Component and directory GUIDs are derived from the
 * path, so rebuilding the same tree produces the same package identity.
 *
 * Usage: node scripts/release/build-msi.mjs --tree <dir> --out <dir> [--manufacturer <name>]
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))

function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function fail(message) {
  console.error(`build-msi: ${message}`)
  process.exit(1)
}

const tree = path.resolve(arg('tree') ?? '')
if (!tree || !existsSync(path.join(tree, 'install-manifest.json'))) {
  fail('--tree must name a packaged release tree (install-manifest.json is missing)')
}
const manifest = JSON.parse(await readFile(path.join(tree, 'install-manifest.json'), 'utf8'))
if (manifest.platform !== 'win32') fail(`tree is ${manifest.platform}, not win32`)
const out = path.resolve(arg('out') ?? path.join(ROOT, 'release-out'))
const manufacturer = arg('manufacturer') ?? 'Gateway'
const version = manifest.numeric_version ?? '1.0.0'

// WiX wants x.y.z[.0]; trim or pad to three or four parts of integers.
const parts = String(version).split('.').filter(part => /^[0-9]+$/.test(part))
while (parts.length < 3) parts.push('0')
const msiVersion = parts.slice(0, 3).join('.')

function hex(value, length = 16) {
  return createHash('sha256').update(value).digest('hex').slice(0, length)
}

/** A stable GUID from a path: the same tree always produces the same package. */
function guid(seed) {
  const digest = createHash('sha256').update(`gateway-msi:${seed}`).digest('hex')
  return `{${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}}`.toUpperCase()
}

function identifier(prefix, value) {
  // WiX ids are [A-Za-z0-9_.] and at most 72 characters.
  return `${prefix}_${hex(value, 24)}`
}

function escape(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

async function walk(directory, base = directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walk(full, base))
    else if (entry.isFile()) files.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return files.sort()
}

const files = await walk(tree)
if (files.length === 0) fail('tree has no files')

// --- directory tree --------------------------------------------------------
// One Directory element per distinct parent path, all beneath INSTALLFOLDER.
const directories = new Map([['', 'INSTALLFOLDER']])
function ensureDirectory(relative) {
  if (relative === '' || directories.has(relative)) return directories.get(relative)
  ensureDirectory(path.posix.dirname(relative) === '.' ? '' : path.posix.dirname(relative))
  directories.set(relative, identifier('dir', relative))
  return directories.get(relative)
}
for (const file of files) ensureDirectory(path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file))

// Render nested directories: emit each directory's open tag (from its parent's
// list) then recurse. A flat map cannot express nesting, so rebuild the tree.
const children = new Map()
for (const relative of directories.keys()) {
  if (relative === '') continue
  const parent = path.posix.dirname(relative)
  const key = parent === '.' ? '' : parent
  if (!children.has(key)) children.set(key, [])
  children.get(key).push(relative)
}
function renderDirectories(parent) {
  const lines = []
  for (const relative of (children.get(parent) ?? []).sort()) {
    lines.push(`          <Directory Id="${directories.get(relative)}" Name="${escape(path.posix.basename(relative))}">`)
    lines.push(...renderDirectories(relative))
    lines.push('          </Directory>')
  }
  return lines
}

// --- components ------------------------------------------------------------
const components = []
for (const file of files) {
  const directoryRelative = path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file)
  const absolute = path.join(tree, file)
  components.push(
    [
      `      <Component Id="${identifier('cmp', file)}" Directory="${directories.get(directoryRelative)}" Guid="${guid(file)}">`,
      `        <File Id="${identifier('fil', file)}" Source="${escape(absolute)}" KeyPath="yes" />`,
      '      </Component>',
    ].join('\n'),
  )
}

const upgradeCode = guid('upgrade')
const productCode = guid(`product:${msiVersion}:${manifest.source_sha}`)

const wxs = `<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Package Name="Gateway" Manufacturer="${escape(manufacturer)}" Version="${msiVersion}"
           UpgradeCode="${upgradeCode}" ProductCode="${productCode}" Scope="perUser" Compressed="yes">
    <SummaryInformation Description="Gateway (Claude Code) command line and model gateway" Manufacturer="${escape(manufacturer)}" />
    <!-- Every rebuild of the same version gets a fresh ProductCode (it is
         derived from the source SHA), so the same-version upgrade path has to
         be allowed explicitly. Without it Windows treats the second build of
         1.0.0 as an already-installed product: files land, registration does
         not, and the MSI cannot uninstall what it just installed. -->
    <MajorUpgrade AllowSameVersionUpgrades="yes" DowngradeErrorMessage="A newer version of Gateway is already installed." />
    <MediaTemplate EmbedCab="yes" />
    <StandardDirectory Id="LocalAppDataFolder">
      <Directory Id="ProgramsFolder" Name="Programs">
        <Directory Id="INSTALLFOLDER" Name="Gateway">
${renderDirectories('').join('\n')}
        </Directory>
      </Directory>
    </StandardDirectory>
    <StandardDirectory Id="ProgramMenuFolder">
      <Directory Id="AppProgramsFolder" Name="Gateway" />
    </StandardDirectory>
    <Feature Id="Main" Title="Gateway" Level="1">
      <ComponentGroupRef Id="Files" />
      <ComponentGroupRef Id="Shortcuts" />
    </Feature>
    <ComponentGroup Id="Files">
${components.join('\n')}
    </ComponentGroup>
    <ComponentGroup Id="Shortcuts">
      <Component Id="ShortcutComponent" Directory="AppProgramsFolder" Guid="${guid('shortcut')}">
        <Shortcut Id="AppShortcut" Name="Gateway (cc)" Description="Start a Gateway session"
                  Target="[INSTALLFOLDER]scripts\\cc.cmd" WorkingDirectory="INSTALLFOLDER" />
        <RemoveFolder Id="RemoveAppProgramsFolder" On="uninstall" />
        <RegistryValue Root="HKCU" Key="Software\\Gateway" Name="installed" Type="integer" Value="1" KeyPath="yes" />
      </Component>
    </ComponentGroup>
  </Package>
</Wix>
`

await mkdir(out, { recursive: true })
const wxsPath = path.join(out, `${manifest.package}.wxs`)
await writeFile(wxsPath, wxs)

// --- build -----------------------------------------------------------------
const wix = process.env.WIX_EXE ?? 'wix.exe'
const msiPath = path.join(out, `${manifest.package}.msi`)
const build = spawnSync(wix, ['build', wxsPath, '-o', msiPath, '-arch', manifest.arch === 'arm64' ? 'arm64' : 'x64'], {
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
})
if (build.status !== 0) {
  fail(`wix build failed:\n${(build.stderr || build.stdout || '').trim().slice(0, 4000)}`)
}

const info = await stat(msiPath)
const digest = createHash('sha256').update(await readFile(msiPath)).digest('hex')
console.log(
  JSON.stringify(
    {
      msi: msiPath,
      bytes: info.size,
      sha256: digest,
      version: msiVersion,
      productCode,
      upgradeCode,
      wxs: wxsPath,
      files: files.length,
    },
    null,
    2,
  ),
)
