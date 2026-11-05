#!/usr/bin/env node
/**
 * Build the per-platform release artifact directory and prove it works.
 *
 * The artifact is self-contained: the compiled harness, the runtime scripts,
 * lockfile-pinned native dependencies, the platform tool resources (codex, and
 * on darwin the Keychain helper), and nothing the bundle does not need.
 *
 * The stage is not finished when the copy is: it starts a supervisor out of the
 * staged tree and requires a healthy /health, and it requires the two launcher
 * negative rows to fail for the right reason. A stage that only survives --version
 * has proved nothing about the thing being shipped.
 *
 * Usage: node scripts/stage-artifact.mjs [--out DIR] [--sha SHA] [--no-smoke]
 * Writes <out>/stage-report.json and prints the same JSON on stdout.
 */
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const sha = arg('sha') ?? spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim()
const out = path.resolve(arg('out') ?? path.join(os.tmpdir(), `stage-${sha.slice(0, 7)}`))
const smoke = !process.argv.includes('--no-smoke')
const platform = process.platform
const arch = process.arch
// Optional: a bun binary to embed at `runtime/bun[.exe]`. Staging does not
// download one, so an artifact cut without this is an artifact that still
// needs bun on the target - and the report says so.
const runtimeSource = arg('runtime')

// The runtime set is explicit on purpose: cc.ps1 dot-sources
// owned-gateway-process.ps1, which no import walk can see, and shipping the
// whole scripts/ directory would drag build-only and test files into the
// artifact.
const RUNTIME_COMMON = [
  'cc-launcher.mjs',
  'gateway-supervisor.mjs',
  'gateway-vault-launch.mjs',
  'gateway-key-inject.mjs',
  'model-gateway.mjs',
  'gateway-keysafe.mjs',
  'keysafe-vault.mjs',
  'codex-quota.mjs',
  'codex-resource.mjs',
  'account-store.mjs',
  'codex-accounts.mjs',
  'anthropic-accounts.mjs',
  'mistral.mjs',
  'commandcode.mjs',
  'effort-capabilities.mjs',
  'effort-capabilities.json',
  'gateway-contract.mjs',
  'opencode-go.mjs',
  'opencode-zen.mjs',
  'quota-cache.mjs',
  'launcher-policy.json',
]
const RUNTIME_PLATFORM = platform === 'win32'
  ? ['cc.ps1', 'owned-gateway-process.ps1']
  : ['cc']

function fail(message) {
  console.error(`stage-artifact: ${message}`)
  process.exit(1)
}

async function digestFile(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex')
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

/** Content-addressed digest of a directory: paths and file bytes, order fixed. */
async function treeDigest(directory) {
  const hash = createHash('sha256')
  for (const relative of await walk(directory)) {
    hash.update(relative)
    hash.update('\0')
    hash.update(await digestFile(path.join(directory, relative)))
    hash.update('\n')
  }
  return hash.digest('hex')
}

/**
 * Every relative import in the staged scripts must resolve inside the artifact.
 *
 * RUNTIME_COMMON is a hand list, and the account modules were added to the
 * gateway without being added to it: staging succeeded, and the supervisor
 * failed at import with a port-shaped error. The health smoke caught it, but
 * only as "did not serve /health". Naming the missing file here makes the
 * failure say what it is.
 */
async function missingRuntimeImports(scriptsDirectory) {
  const missing = new Set()
  for (const entry of await readdir(scriptsDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(mjs|js)$/.test(entry.name)) continue
    const text = await readFile(path.join(scriptsDirectory, entry.name), 'utf8')
    // Static re-exports, plain imports and dynamic imports are three spellings
    // of the same dependency; a walk that knows one of them reports closure
    // for a set that is not closed.
    const patterns = [
      /from\s+['"]\.\/([^'"]+)['"]/g,
      /import\s*\(\s*['"]\.\/([^'"]+)['"]\s*\)/g,
      /export\s+[^;]*?from\s+['"]\.\/([^'"]+)['"]/g,
    ]
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        if (!existsSync(path.join(scriptsDirectory, match[1]))) missing.add(match[1])
      }
    }
  }
  return [...missing].sort()
}

const report = {
  sha,
  platform,
  arch,
  out,
  createdAt: new Date().toISOString(),
  bytes: 0,
  files: 0,
  classes: {},
  sha256: {},
  nodeModules: [],
  smoke: {},
}

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })

// --- harness and manifests -------------------------------------------------
const cli = path.join(ROOT, 'dist', 'cli.js')
if (!existsSync(cli)) fail('dist/cli.js is missing; run the build first')
await cp(cli, path.join(out, 'dist', 'cli.js'), { recursive: true })
for (const name of ['package.json', 'bun.lock']) {
  const source = path.join(ROOT, name)
  if (!existsSync(source)) fail(`${name} is missing; the artifact must pin dependencies`)
  await cp(source, path.join(out, name))
}
report.sha256.cli = await digestFile(path.join(out, 'dist', 'cli.js'))

// --- runtime scripts -------------------------------------------------------
await mkdir(path.join(out, 'scripts'), { recursive: true })
for (const name of [...RUNTIME_COMMON, ...RUNTIME_PLATFORM]) {
  const source = path.join(ROOT, 'scripts', name)
  if (!existsSync(source)) fail(`runtime script is missing: scripts/${name}`)
  await cp(source, path.join(out, 'scripts', name))
}
// cc.cmd in the repository hardcodes the worktree path. The artifact gets a
// shim that resolves its sibling instead.
if (platform === 'win32') {
  await writeFile(
    path.join(out, 'scripts', 'cc.cmd'),
    '@echo off\r\npowershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0cc.ps1" %*\r\nexit /b %ERRORLEVEL%\r\n',
  )
}
if (platform !== 'win32') await chmod(path.join(out, 'scripts', 'cc'), 0o755)

// The runtime list is explicit, so prove it closes before anything runs it.
const missingImports = await missingRuntimeImports(path.join(out, 'scripts'))
if (missingImports.length > 0) {
  fail(`runtime set is incomplete; missing: ${missingImports.join(', ')}`)
}

// --- the runtime (optional) -------------------------------------------------
// The report says whether this artifact is self-contained, because two files
// with the same extension and different requirements is how a release note
// starts lying. `present: false` is a real answer, not a failure.
const runtimeBinary = platform === 'win32' ? 'bun.exe' : 'bun'
let runtime = { present: false, note: 'no runtime embedded; the target must provide bun' }
if (runtimeSource) {
  const source = path.resolve(runtimeSource)
  if (!existsSync(source)) fail(`--runtime does not exist: ${source}`)
  await mkdir(path.join(out, 'runtime'), { recursive: true })
  await cp(source, path.join(out, 'runtime', runtimeBinary))
  if (platform !== 'win32') await chmod(path.join(out, 'runtime', runtimeBinary), 0o755)
  runtime = {
    present: true,
    binary: `runtime/${runtimeBinary}`,
    bytes: (await stat(path.join(out, 'runtime', runtimeBinary))).size,
    sha256: await digestFile(path.join(out, 'runtime', runtimeBinary)),
  }
}
report.runtime = runtime

// --- native dependencies, pinned to bun.lock ------------------------------
const allowlist = JSON.parse(await readFile(path.join(ROOT, 'scripts', 'bundle-allowlist.json'), 'utf8'))
const lockText = await readFile(path.join(ROOT, 'bun.lock'), 'utf8')
const lockVersions = new Map()
for (const match of lockText.matchAll(/^\s*"([^"]+)": \["[^"]+@([^"]+)",/gm)) {
  if (!lockVersions.has(match[1])) lockVersions.set(match[1], match[2])
}

const staged = new Set()
async function collectPackage(name) {
  if (staged.has(name)) return
  const dir = path.join(ROOT, 'node_modules', name)
  if (!existsSync(dir)) fail(`node_modules/${name} is missing; run bun install`)
  const manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'))
  const locked = lockVersions.get(name)
  if (locked && manifest.version !== locked) {
    fail(`${name} is ${manifest.version} on disk but bun.lock pins ${locked}`)
  }
  staged.add(name)
  report.nodeModules.push({ name, version: manifest.version })
  for (const dependency of Object.keys(manifest.dependencies ?? {})) await collectPackage(dependency)
}

for (const name of allowlist.nativePackages) await collectPackage(name)
// sharp's native side is an optional dependency per target, and it is the only
// .node in a correct artifact.
for (const prefix of ['@img/sharp', '@img/sharp-libvips']) {
  const candidate = `${prefix}-${platform === 'win32' ? 'win32' : platform}-${arch}`
  if (existsSync(path.join(ROOT, 'node_modules', candidate))) await collectPackage(candidate)
}

for (const name of [...staged].sort()) {
  await cp(path.join(ROOT, 'node_modules', name), path.join(out, 'node_modules', name), { recursive: true })
}
for (const name of allowlist.buildGeneratedExternals) {
  if (existsSync(path.join(out, 'node_modules', name))) fail(`${name} must never be staged`)
}
for (const name of allowlist.lazyOptional) {
  if (existsSync(path.join(out, 'node_modules', name))) fail(`${name} must never be staged`)
}

// --- platform tool resources ----------------------------------------------
const codexManifestPath = path.join(ROOT, 'resources', 'codex', 'manifest.json')
if (!existsSync(codexManifestPath)) fail('resources/codex/manifest.json is missing; run scripts/stage-codex.mjs')
const codexManifest = JSON.parse(await readFile(codexManifestPath, 'utf8'))
const key = `${platform}-${arch}`
const entry = codexManifest.entries?.[key]
if (!entry) fail(`resources/codex/manifest.json has no entry for ${key}`)
const codexSource = path.join(ROOT, 'resources', 'codex', entry.version, key)
if (!existsSync(codexSource)) fail(`staged codex tree is missing: ${path.relative(ROOT, codexSource)}`)
const codexDigest = await treeDigest(codexSource)
if (entry.treeSha256 && entry.treeSha256 !== codexDigest) {
  fail(`staged codex tree does not match the manifest (${codexDigest} != ${entry.treeSha256}); re-run stage-codex`)
}
await cp(codexSource, path.join(out, 'resources', 'codex', entry.version, key), { recursive: true })
await cp(codexManifestPath, path.join(out, 'resources', 'codex', 'manifest.json'))
report.sha256.codexArchive = entry.sha256
report.sha256.codexTree = codexDigest
report.codex = { version: entry.version, asset: entry.asset, ...(entry.libc ? { libc: entry.libc } : {}) }

if (platform === 'darwin') {
  const helper = path.join(ROOT, 'scripts', 'macos', 'bin', 'keysafe-keychain')
  if (!existsSync(helper)) fail('scripts/macos/bin/keysafe-keychain is missing; run scripts/macos/build-keysafe-keychain.sh')
  await cp(helper, path.join(out, 'scripts', 'macos', 'bin', 'keysafe-keychain'), { recursive: true })
  await chmod(path.join(out, 'scripts', 'macos', 'bin', 'keysafe-keychain'), 0o755)
  report.sha256.keychainHelper = await digestFile(path.join(out, 'scripts', 'macos', 'bin', 'keysafe-keychain'))
}

// --- invariants ------------------------------------------------------------
await assertNoForeignPrebuilds()
async function assertNoForeignPrebuilds() {
  const imgDirs = existsSync(path.join(out, 'node_modules', '@img'))
    ? (await readdir(path.join(out, 'node_modules', '@img'))).sort()
    : []
  const allowed = [...staged].filter(name => name.startsWith('@img/')).map(name => name.slice('@img/'.length)).sort()
  if (JSON.stringify(imgDirs) !== JSON.stringify(allowed)) {
    fail(`@img directory set does not match the allowlist closure: ${imgDirs.join(', ') || '(none)'}`)
  }
  const natives = (await walk(out)).filter(file => file.endsWith('.node'))
  if (natives.length !== 1) fail(`expected exactly one .node in the artifact, found ${natives.length}: ${natives.join(', ')}`)
}

// dist must look newer than the manifests so a source-tree freshness check
// cannot fire on the artifact.
const cliStat = await stat(path.join(out, 'dist', 'cli.js'))
const older = new Date(cliStat.mtimeMs - 60_000)
for (const name of ['package.json', 'bun.lock']) await utimes(path.join(out, name), older, older)

async function measure() {
  let bytes = 0
  const files = await walk(out)
  for (const file of files) bytes += (await stat(path.join(out, file))).size
  report.bytes = bytes
  report.files = files.length
  report.classes = {
    dist: files.filter(file => file.startsWith('dist/')).length,
    manifests: files.filter(file => file === 'package.json' || file === 'bun.lock').length,
    scripts: files.filter(file => file.startsWith('scripts/')).length,
    nodeModules: files.filter(file => file.startsWith('node_modules/')).length,
    resources: files.filter(file => file.startsWith('resources/')).length,
  }
}
await measure()

// --- smoke -----------------------------------------------------------------
async function run(command, args, options = {}) {
  return spawnSync(command, args, { cwd: out, encoding: 'utf8', timeout: 120_000, ...options })
}

/**
 * A clean machine, as far as this process can imitate one. The artifact smoke
 * must exercise the mode it ships: a legacy ~/.keysafe on the build host would
 * otherwise resolve external, because mode lookup reads the real home.
 */
function isolatedEnv(home) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: home, USERPROFILE: home, HOME: home }
  for (const name of [
    'GATEWAY_CREDENTIALS_MODE',
    'GATEWAY_KEYSAFE_MODE',
    'GATEWAY_OAUTH_MODE',
    'MODEL_GATEWAY_ENV_FILE',
    'MODEL_GATEWAY_KEYSAFE_HOME',
  ]) {
    delete env[name]
  }
  return env
}

async function healthSmoke(port, home) {
  const child = spawn(process.execPath, [path.join(out, 'scripts', 'gateway-supervisor.mjs'), '--port', String(port)], {
    cwd: out,
    env: isolatedEnv(home),
    stdio: 'ignore',
    detached: platform !== 'win32',
  })
  const deadline = Date.now() + 45_000
  try {
    while (Date.now() < deadline) {
      const ok = await new Promise(resolve => {
        const request = http.get(`http://127.0.0.1:${port}/health`, response => {
          response.resume()
          resolve(response.statusCode === 200)
        })
        request.on('error', () => resolve(false))
        request.setTimeout(2000, () => {
          request.destroy()
          resolve(false)
        })
      })
      if (ok) return true
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    return false
  } finally {
    try {
      if (platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' })
      else process.kill(-child.pid, 'SIGKILL')
    } catch {}
  }
}

if (smoke) {
  const bun = spawnSync('bun', ['--version'], { encoding: 'utf8' })
  if (bun.status !== 0) fail('bun is required for the artifact smoke')
  const version = await run('bun', ['--no-install', 'dist/cli.js', '--version'])
  if (version.status !== 0) fail(`staged CLI failed --version: ${version.stderr || version.stdout}`)
  report.smoke.version = version.stdout.trim()

  const scratchConfig = path.join(out, '.scratch-config')
  await mkdir(scratchConfig, { recursive: true })
  const status = await run('bun', ['--no-install', 'dist/cli.js', 'login', '--status'], {
    env: isolatedEnv(scratchConfig),
  })
  if (status.status !== 0) fail(`staged CLI failed login --status: ${status.stderr || status.stdout}`)
  const mode = JSON.parse(status.stdout).mode
  if (mode !== 'bundled') fail(`clean-home login --status reported "${mode}", expected bundled`)
  report.smoke.loginStatus = mode

  // sharp is the only native package in the artifact, and a staged copy that
  // cannot dlopen its prebuilt has not been proved by file counts.
  const sharp = await run('bun', ['--no-install', '-e', 'const s = require("sharp"); process.stdout.write(JSON.stringify({ sharp: s.versions.sharp, vips: s.versions.vips }))'])
  if (sharp.status !== 0) fail(`staged sharp failed to load: ${sharp.stderr || sharp.stdout}`)
  report.smoke.sharp = JSON.parse(sharp.stdout)

  const port = 41000 + Math.floor(Math.random() * 2000)
  if (!await healthSmoke(port, scratchConfig)) fail(`staged supervisor did not serve /health on ${port}`)
  report.smoke.health = port

  // Negative 1: manifests newer than dist must not trigger a rebuild. Run it in
  // a copy so the shipped artifact keeps dist newer than the manifests.
  const mtimeCopy = path.join(os.tmpdir(), `stage-mtime-${process.pid}`)
  await rm(mtimeCopy, { recursive: true, force: true })
  await cp(out, mtimeCopy, { recursive: true })
  const now = new Date()
  for (const name of ['package.json', 'bun.lock']) await utimes(path.join(mtimeCopy, name), now, now)
  const prewarm = spawnSync(process.execPath, ['scripts/cc-launcher.mjs', '--prewarm'], {
    cwd: mtimeCopy,
    encoding: 'utf8',
    timeout: 60_000,
    env: isolatedEnv(scratchConfig),
  })
  await rm(mtimeCopy, { recursive: true, force: true })
  if (prewarm.status !== 0) fail(`mtime-inverted prewarm failed: ${prewarm.stderr || prewarm.stdout}`)
  const noise = `${prewarm.stdout}${prewarm.stderr}`
  if (/compiled harness is stale|rebuilding before launch/i.test(noise)) fail('mtime-inverted prewarm attempted a rebuild')
  report.smoke.mtimeInverted = 'ok'

  // Negative 2: a missing dist must be reported, never rebuilt.
  const copy = path.join(os.tmpdir(), `stage-no-dist-${process.pid}`)
  await rm(copy, { recursive: true, force: true })
  await cp(out, copy, { recursive: true })
  await rm(path.join(copy, 'dist'), { recursive: true, force: true })
  const missing = spawnSync(process.execPath, ['scripts/cc-launcher.mjs', '--prewarm'], {
    cwd: copy,
    encoding: 'utf8',
    timeout: 60_000,
    env: isolatedEnv(scratchConfig),
  })
  await rm(copy, { recursive: true, force: true })
  if (missing.status === 0) fail('missing dist/cli.js did not fail the launch')
  if (!/compiled harness is missing/i.test(`${missing.stdout}${missing.stderr}`)) {
    fail(`missing dist produced the wrong error: ${missing.stderr || missing.stdout}`)
  }
  report.smoke.missingDist = 'reported'

  // The runtime preference has two branches, and a row that only says
  // "prewarm ok" proves the wrong one on a host that happens to have bun.
  // With a bundled runtime, run the launcher on a PATH that cannot contain
  // bun: `login --status` goes straight through ClaudeRunner and exits, so the
  // only way to reach the harness is the bundled branch.
  if (runtime.present) {
    const bare = isolatedEnv(scratchConfig)
    bare.PATH = platform === 'win32'
      ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
      : '/usr/bin:/bin'
    delete bare.CC_CLAUDE_RUNNER_OVERRIDE
    delete bare.CC_CLAUDE_SCRIPT_OVERRIDE
    const bunVersion = spawnSync(path.join(out, runtime.binary), ['--version'], { encoding: 'utf8' })
    if (bunVersion.status !== 0) fail(`bundled runtime failed --version: ${bunVersion.stderr || bunVersion.stdout}`)
    const launched = spawnSync(process.execPath, [path.join(out, 'scripts', 'cc-launcher.mjs'), 'login', '--status'], {
      cwd: out,
      encoding: 'utf8',
      timeout: 120_000,
      env: bare,
    })
    if (launched.status !== 0) fail(`bundled-runtime launcher failed: ${launched.stderr || launched.stdout}`)
    let mode
    try {
      mode = JSON.parse(launched.stdout).mode
    } catch {
      fail(`bundled-runtime launcher did not print login status: ${launched.stdout.slice(0, 300)}`)
    }
    report.smoke.runtimeRunner = {
      binary: runtime.binary,
      bun: bunVersion.stdout.trim(),
      loginStatus: mode,
      pathWithoutBun: true,
    }
  }

  if (platform === 'win32') {
    const ps = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(out, 'scripts', 'cc.ps1'), '--prewarm'], {
      cwd: out,
      encoding: 'utf8',
      timeout: 60_000,
      env: isolatedEnv(scratchConfig),
    })
    if (ps.status !== 0) fail(`staged cc.ps1 --prewarm failed: ${ps.stderr || ps.stdout}`)
    report.smoke.ccPrewarm = 'ok'
  }
}

// Whatever the smoke rows did in copies, the shipped tree must end with dist
// newer than the manifests. A fresh-check that fires on the artifact is the
// failure this ordering exists to prevent, and the guard must not be the only
// thing standing between the artifact and a rebuild attempt.
const cliTime = await stat(path.join(out, 'dist', 'cli.js'))
const olderForShip = new Date(cliTime.mtimeMs - 60_000)
for (const name of ['package.json', 'bun.lock']) await utimes(path.join(out, name), olderForShip, olderForShip)
const manifestTime = (await stat(path.join(out, 'package.json'))).mtimeMs
report.invariants = { distNewerThanManifests: cliTime.mtimeMs > manifestTime }
if (!report.invariants.distNewerThanManifests) fail('artifact ordering: dist/cli.js is not newer than package.json')

await rm(path.join(out, '.scratch-config'), { recursive: true, force: true })
await measure()
await writeFile(path.join(out, 'stage-report.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
