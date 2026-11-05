#!/usr/bin/env node
/**
 * Package a staged artifact into something a person can install.
 *
 * `stage-artifact.mjs` produces a directory that runs, but it runs only on a
 * machine that already has bun, and a directory is not a release. This takes
 * that directory and:
 *
 *   1. embeds a bun runtime at `runtime/bun[.exe]` (the launchers prefer it),
 *   2. writes `install-manifest.json` naming the exact build,
 *   3. writes the platform archive (zip on Windows, tar.gz elsewhere).
 *
 * The platform-specific installers (MSI, deb, pkg) are built from the same
 * tree by their own scripts; this is the one step they all share.
 *
 * Usage:
 *   node scripts/release/package-release.mjs --stage <dir> --out <dir>
 *     [--platform win32|darwin|linux] [--arch x64|arm64]
 *     [--version <v>] [--sha <sha>] [--runtime <bun-binary>]
 *     [--runtime-url <url>] [--no-runtime] [--format zip|tar.gz|none]
 *
 * Prints one JSON object on stdout.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmod, cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))

function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function fail(message) {
  console.error(`package-release: ${message}`)
  process.exit(1)
}

const stage = path.resolve(arg('stage') ?? '')
if (!stage || !existsSync(path.join(stage, 'stage-report.json'))) {
  fail('--stage must name a directory containing stage-report.json (run stage-artifact first)')
}
const report = JSON.parse(await readFile(path.join(stage, 'stage-report.json'), 'utf8'))
const platform = arg('platform') ?? report.platform
const arch = arg('arch') ?? report.arch
const sha = arg('sha') ?? report.sha
const version = arg('version') ?? JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')).version
const out = path.resolve(arg('out') ?? path.join(ROOT, 'release-out'))
const wantRuntime = !process.argv.includes('--no-runtime')
const format = arg('format') ?? (platform === 'win32' ? 'zip' : 'tar.gz')

// A stager run on a different host is a mistake worth naming: the node_modules
// in it are native to that host, and every smoke row it passed proves the wrong
// platform.
if (report.platform !== platform || report.arch !== arch) {
  fail(`stage-report is ${report.platform}-${report.arch}, not ${platform}-${arch}`)
}

// This is the download pin, not a claim about what was embedded: `--runtime`
// can supply any binary. The version that reaches the manifest is read back
// from the binary itself.
const BUN_DOWNLOAD_VERSION = process.env.GATEWAY_BUN_VERSION ?? '1.4.0'
const BUN_ASSETS = {
  'win32-x64': { asset: 'bun-windows-x64.zip', binary: 'bun.exe' },
  'win32-arm64': { asset: 'bun-windows-aarch64.zip', binary: 'bun.exe' },
  'darwin-x64': { asset: 'bun-darwin-x64.zip', binary: 'bun' },
  'darwin-arm64': { asset: 'bun-darwin-aarch64.zip', binary: 'bun' },
  'linux-x64': { asset: 'bun-linux-x64.zip', binary: 'bun' },
  'linux-arm64': { asset: 'bun-linux-aarch64.zip', binary: 'bun' },
}

const name = `gateway-${version}-${platform}-${arch}`
const tree = path.join(out, name)

// On Windows, `tar` on PATH may be the MSYS/GNU one, which reads `C:\...` as a
// remote host ("Cannot connect to C:"). System32 ships bsdtar, which reads and
// writes zip and gzip and has no remote syntax.
const TAR = process.platform === 'win32'
  ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  : 'tar'

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim().slice(0, 500)}`)
  }
  return result
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

async function walk(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walk(full))
    else if (entry.isFile()) files.push(full)
  }
  return files
}

// --- the tree --------------------------------------------------------------
await mkdir(out, { recursive: true })
await rm(tree, { recursive: true, force: true })
await cp(stage, tree, { recursive: true })
// The stage report describes the staging host, not the install. Keep it as
// provenance but stop calling it a report about this package.
const installManifest = {
  name: 'Gateway',
  package: name,
  version,
  // MSI/deb want a numeric version; keep the human one too.
  numeric_version: version.replace(/^v/, '').split('-')[0],
  source_sha: sha,
  platform,
  arch,
  entrypoints: { unix: 'scripts/cc', windows: 'scripts/cc.cmd' },
}

// --- the runtime -----------------------------------------------------------
let runtime = null
if (wantRuntime) {
  const key = `${platform}-${arch}`
  const spec = BUN_ASSETS[key]
  if (!spec) fail(`no bun asset for ${key}; known: ${Object.keys(BUN_ASSETS).join(', ')}`)
  const destination = path.join(tree, 'runtime', spec.binary)
  await mkdir(path.dirname(destination), { recursive: true })
  const provided = arg('runtime')
  if (provided) {
    await cp(path.resolve(provided), destination)
  } else {
    const cache = path.join(out, '.cache')
    await mkdir(cache, { recursive: true })
    const archive = path.join(cache, spec.asset)
    if (!existsSync(archive)) {
      const url = arg('runtime-url') ?? `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_DOWNLOAD_VERSION}/${spec.asset}`
      process.stderr.write(`package-release: downloading ${url}\n`)
      const response = await fetch(url, { redirect: 'follow' })
      if (!response.ok) fail(`bun download failed: HTTP ${response.status}`)
      await writeFile(archive, Buffer.from(await response.arrayBuffer()))
    }
    const extract = path.join(cache, `${key}-extract`)
    await mkdir(extract, { recursive: true })
    // GNU tar cannot read zip (bsdtar can, and is what Windows ships). Use
    // unzip where it exists so the same script runs on a Linux build host.
    if (spawnSync('unzip', ['-v'], { encoding: 'utf8' }).status === 0) {
      run('unzip', ['-q', '-o', archive, '-d', extract])
    } else {
      run(TAR, ['-xf', archive, '-C', extract])
    }
    // The archive nests the binary under a directory named for the target
    // (`bun-windows-x64/bun.exe`, `bun-linux-x64/bun`, ...). Find it rather
    // than predicting the spelling.
    let found = null
    for (const entry of await walk(extract)) {
      if (path.basename(entry) === spec.binary) {
        found = entry
        break
      }
    }
    if (!found) fail(`bun archive did not contain ${spec.binary}`)
    await cp(found, destination)
    if (platform !== 'win32') await chmod(destination, 0o755)
  }
  const info = await stat(destination)
  // Read the version back from the binary. A literal default here once made
  // the manifest claim 1.4.0 while `--runtime` had embedded 1.4.3, and both
  // numbers appeared in the same object.
  const bunVersion = spawnSync(destination, ['--version'], { encoding: 'utf8' })
  if (bunVersion.status !== 0) fail(`bundled runtime failed --version: ${bunVersion.stderr || bunVersion.stdout}`)
  runtime = {
    version: bunVersion.stdout.trim(),
    binary: `runtime/${spec.binary}`,
    bytes: info.size,
    sha256: await sha256(destination),
  }

  // Prove the branch that matters: on a PATH with no bun anywhere, the
  // packaged launcher must still reach the harness. `login --status` goes
  // through ClaudeRunner and exits without starting a gateway.
  //
  // The environment must be a scratch home, not the builder's: `login --status`
  // reads the credential store, and reading the operator's live config would
  // make the reported mode a statement about this machine rather than the
  // artifact (and a reachable store can be written).
  const scratch = path.join(os.tmpdir(), `package-proof-${process.pid}`)
  await rm(scratch, { recursive: true, force: true })
  await mkdir(scratch, { recursive: true })
  const bare = {
    ...process.env,
    HOME: scratch,
    USERPROFILE: scratch,
    CLAUDE_CONFIG_DIR: scratch,
    PATH: platform === 'win32'
      ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
      : '/usr/bin:/bin',
  }
  for (const name of [
    'CC_CLAUDE_RUNNER_OVERRIDE',
    'CC_CLAUDE_SCRIPT_OVERRIDE',
    'GATEWAY_CREDENTIALS_MODE',
    'GATEWAY_KEYSAFE_MODE',
    'GATEWAY_OAUTH_MODE',
    'GATEWAY_SETTINGS',
    'MODEL_GATEWAY_ENV_FILE',
    'MODEL_GATEWAY_KEYSAFE_HOME',
  ]) {
    delete bare[name]
  }
  const launcher = path.join(tree, 'scripts', 'cc-launcher.mjs')
  const launched = spawnSync(process.execPath, [launcher, 'login', '--status'], { cwd: tree, encoding: 'utf8', timeout: 120_000, env: bare })
  await rm(scratch, { recursive: true, force: true })
  if (launched.status !== 0) fail(`bundled-runtime launcher failed: ${launched.stderr || launched.stdout}`)
  let mode
  try {
    mode = JSON.parse(launched.stdout).mode
  } catch {
    fail(`bundled-runtime launcher did not print login status: ${launched.stdout.slice(0, 300)}`)
  }
  if (mode !== 'bundled') fail(`a clean home resolved credential mode "${mode}", expected bundled`)
  runtime.proof = { bun: bunVersion.stdout.trim(), loginStatus: mode, pathWithoutBun: true, cleanHome: true }
}

// `present` is the answer to "does this artifact need bun on the target?"; a
// release note can read it instead of guessing from the file extension.
await writeFile(
  path.join(tree, 'install-manifest.json'),
  `${JSON.stringify(
    {
      ...installManifest,
      runtime: runtime
        ? { present: true, bun: runtime.version, binary: runtime.binary, bytes: runtime.bytes, sha256: runtime.sha256, proof: runtime.proof }
        : { present: false, note: 'this artifact requires bun on the target' },
    },
    null,
    2,
  )}\n`,
)

// --- archive ---------------------------------------------------------------
const archives = []
if (format !== 'none') {
  const archivePath = path.join(out, `${name}.${format}`)
  if (format === 'zip') {
    // `-a` picks the container from the extension; bsdtar writes zip and gzip.
    run(TAR, ['-a', '-c', '-f', archivePath, '-C', tree, '.'])
  } else {
    run(TAR, ['-czf', archivePath, '-C', tree, '.'])
  }
  archives.push({ file: path.basename(archivePath), format, bytes: (await stat(archivePath)).size, sha256: await sha256(archivePath) })
}

const result = {
  package: name,
  tree,
  version,
  numericVersion: version.replace(/^v/, '').split('-')[0],
  platform,
  arch,
  sourceSha: sha,
  files: report.files,
  bytes: report.bytes,
  runtime,
  archives,
}
await writeFile(path.join(tree, 'package-report.json'), `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify(result, null, 2))
