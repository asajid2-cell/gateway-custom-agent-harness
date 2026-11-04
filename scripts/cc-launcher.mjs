#!/usr/bin/env node
/**
 * The POSIX launcher: the macOS/Linux counterpart to scripts/cc.ps1.
 *
 * cc.ps1 is the whole launcher on Windows - there is no other one - and it does
 * four things that are not the harness's business: it resolves the model and its
 * native effort default from the shared catalogue, it rebuilds the compiled
 * harness when the source is newer, it starts the model gateway and waits for it
 * to become healthy, and it runs the harness against that gateway with the
 * environment the gateway routes expect. This file is the same four things for
 * the platforms cc.ps1 cannot run on, reached through scripts/cc.
 *
 * What is deliberately NOT here:
 *
 *  - keysafe. cc.ps1 starts the gateway through a keysafe child that injects
 *    every vault record into the gateway's environment. keysafe is DPAPI and
 *    Windows-only, and gateway-keysafe.mjs already degrades cleanly off Windows
 *    (a plain `node <gateway>` spawn that inherits the environment). So on POSIX
 *    the environment IS the source of truth: keys reach the gateway through
 *    ~/.claude/gateway.env (mode 600), loaded here and handed only to the
 *    gateway child - never to the harness, which has no use for a provider key.
 *
 *  - a Windows Job Object. The containment equivalent is a process group: the
 *    supervisor is spawned detached (its own session/group on POSIX) and every
 *    descendant inherits that group, so one killpg on the way out reaps the
 *    supervisor and the gateway together. See killGroup.
 *
 * The catalogue, the policy file, and the state files under ~/.claude are the
 * SAME files cc.ps1 reads, so the two launchers cannot disagree about a model's
 * effort ladder or a saved order.
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import { randomUUID } from 'node:crypto'

const ScriptsDir = dirname(fileURLToPath(import.meta.url))
const Root = dirname(ScriptsDir)
const LaunchDirectory = process.cwd()
const Home = homedir()
const ClaudeHome = process.env.CLAUDE_CONFIG_DIR || join(Home, '.claude')

const POSIX = process.platform !== 'win32'

function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function readJson(path) {
  const text = readText(path)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function which(command) {
  const path = process.env.PATH || ''
  for (const dir of path.split(':')) {
    if (!dir) continue
    const candidate = join(dir, command)
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // keep looking
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Model and effort resolution, from the same catalogue cc.ps1 reads.
// ---------------------------------------------------------------------------

const CatalogPath = join(ScriptsDir, 'effort-capabilities.json')
const Catalog = readJson(CatalogPath)
if (!Catalog) {
  throw new Error(`Effort capability catalog is missing: ${CatalogPath}`)
}

const ModelAliases = {}
for (const [canonical, aliases] of Object.entries(Catalog.gatewayModelAliases || {})) {
  for (const alias of aliases || []) {
    if (alias) ModelAliases[String(alias)] = canonical
  }
}

function resolveGatewayModel(value) {
  if (ModelAliases[value]) return ModelAliases[value]
  if (value.startsWith('claude-opencode-')) return 'gateway-opencode-' + value.slice('claude-opencode-'.length)
  if (value.startsWith('opencode-go/')) return 'gateway-opencode-' + value.slice('opencode-go/'.length)
  return value
}

function effortLevels(model) {
  for (const [name, levels] of Object.entries(Catalog.gatewayAliases || {})) {
    if (name.toLowerCase() === model.toLowerCase()) return levels || []
  }
  return []
}

const StoredDefaultModel = (() => {
  const stored = (readText(join(ClaudeHome, 'gateway-default-model.txt')) || '').trim()
  return stored.startsWith('gateway-') ? stored : null
})()

let RequestedModel = process.env.MODEL_GATEWAY_DEFAULT || StoredDefaultModel || 'gateway-gpt-luna'
let Model = resolveGatewayModel(RequestedModel)

const PinnedEffortDefaults = (() => {
  const stored = readJson(join(ClaudeHome, 'gateway-effort-defaults.json'))
  const out = {}
  if (stored && typeof stored === 'object') {
    for (const [name, value] of Object.entries(stored)) {
      if (typeof value === 'string' && value) out[name] = value
    }
  }
  return out
})()

function defaultEffortFor(model) {
  if (!model) return null
  const levels = effortLevels(model)
  if (levels.length === 0) return null
  const pinned = PinnedEffortDefaults[model]
  if (pinned && levels.includes(pinned)) return pinned
  if (levels.includes('medium')) return 'medium'
  if (levels.includes('high')) return 'high'
  return String(levels[0])
}

function assertEffortSupported(model, effort) {
  if (!effort || effort.toLowerCase() === 'ultracode') return
  const levels = effortLevels(model)
  if (levels.length === 0) {
    throw new Error(`Model ${model} takes no effort parameter, so --effort ${effort} cannot be applied.`)
  }
  if (!levels.includes(effort)) {
    throw new Error(`Effort '${effort}' is not supported by ${model}. Supported: ${levels.join(', ')}, ultracode`)
  }
}

let Effort = process.env.MODEL_GATEWAY_EFFORT || null
let EffortWasExplicit = Boolean(process.env.MODEL_GATEWAY_EFFORT)
const KeepGatewayLogs = process.env.MODEL_GATEWAY_KEEP_LOGS === '1'
const GatewayToken = 'local-gateway'

// ---------------------------------------------------------------------------
// Argument handling. `cc zenith` is resolved before any gateway work so a
// refusal costs nothing but a file read.
// ---------------------------------------------------------------------------

let ClaudeArgs = process.argv.slice(2)

if (ClaudeArgs.length > 0 && ClaudeArgs[0] === 'zenith') {
  ClaudeArgs = resolveZenith(ClaudeArgs.slice(1))
}

function resolveZenith(rest) {
  let mode = 'claim'
  let purpose = ''
  const passThrough = []
  for (let i = 0; i < rest.length; i++) {
    const arg = String(rest[i])
    if (arg === '--status') { mode = 'status'; continue }
    if (arg === '--take') { mode = 'take'; continue }
    if (arg === '--share') { mode = 'share'; continue }
    if (arg === '--purpose') {
      if (i + 1 >= rest.length) throw new Error('cc zenith: --purpose needs a value.')
      purpose = String(rest[++i])
      continue
    }
    if (arg.startsWith('--purpose=')) { purpose = arg.slice('--purpose='.length); continue }
    passThrough.push(arg)
  }

  const claimPath = join(ClaudeHome, 'zenith.json')
  let held = false
  let session = ''
  let alive = false
  const claim = readJson(claimPath)
  if (claim && claim.zenithSessionId) {
    held = true
    session = String(claim.zenithSessionId)
    // A pid whose process is gone is not a holder; only the pid is checked,
    // the same conservative check zenithRole makes.
    try {
      process.kill(Number(claim.pid), 0)
      alive = true
    } catch {
      alive = false
    }
  }

  if (mode === 'status') {
    if (!held) process.stdout.write('Zenith is unheld; a session can take the role.\n')
    else if (alive) process.stdout.write(`Zenith is held by ${session}, which is still running.\n`)
    else process.stdout.write(`Zenith is held by ${session}, whose process is gone; cc zenith would replace it.\n`)
    process.exit(0)
  }
  if (mode === 'share') {
    mode = 'none'
  } else if (held && alive && mode !== 'take') {
    throw new Error(`cc zenith: the role is held by ${session}, which is still running. Displacing a live Zenith is your decision, not a launch side effect - end it, run 'cc zenith --take' to replace it, or 'cc zenith --share' to work alongside it.`)
  }
  if (mode !== 'none') {
    if (held && !alive) process.stderr.write(`cc zenith: replacing the claim of ${session}, whose process is gone.\n`)
    process.env.CC_ZENITH = '1'
    if (mode === 'take') process.env.CC_ZENITH_MODE = 'take'
    if (purpose) process.env.CC_ZENITH_PURPOSE = purpose
  }
  return passThrough
}

// --settings may be an inline JSON object or a path; it is merged into a scoped
// settings file handed to the harness, and stripped from the forwarded args.
const CallerSettings = {}
const forwarded = []
let afterDoubleDash = false
for (let i = 0; i < ClaudeArgs.length; i++) {
  const arg = String(ClaudeArgs[i])
  if (afterDoubleDash) { forwarded.push(arg); continue }
  if (arg === '--') { afterDoubleDash = true; forwarded.push(arg); continue }

  let settingsValue = null
  if (arg === '--settings') {
    if (i + 1 >= ClaudeArgs.length) throw new Error('--settings needs a file path or JSON object.')
    settingsValue = String(ClaudeArgs[++i])
  } else if (arg.startsWith('--settings=')) {
    settingsValue = arg.slice('--settings='.length)
  } else {
    forwarded.push(arg)
  }

  if (settingsValue !== null) {
    let text = settingsValue.trim()
    if (!text.startsWith('{')) {
      const settingsPath = isAbsolute(settingsValue) ? settingsValue : join(LaunchDirectory, settingsValue)
      const fromFile = readText(settingsPath)
      if (fromFile === null) throw new Error(`Could not read Claude --settings file '${settingsValue}'.`)
      text = fromFile
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new Error(`Could not parse Claude --settings value '${settingsValue}': ${error.message}`)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Claude --settings value '${settingsValue}' must contain a JSON object.`)
    }
    Object.assign(CallerSettings, parsed)
  }
}
ClaudeArgs = forwarded

// Explicit --model/--effort outrank inherited launcher defaults.
let explicitModel = null
let explicitEffort = null
for (let i = 0; i < ClaudeArgs.length; i++) {
  const arg = String(ClaudeArgs[i])
  if (arg === '--') break
  if (arg === '--model') { explicitModel = String(ClaudeArgs[++i] ?? ''); continue }
  if (arg.startsWith('--model=')) { explicitModel = arg.slice('--model='.length); continue }
  if (arg === '--effort') { explicitEffort = String(ClaudeArgs[++i] ?? ''); continue }
  if (arg.startsWith('--effort=')) { explicitEffort = arg.slice('--effort='.length) }
}
if (explicitModel !== null) {
  if (!explicitModel.trim()) throw new Error('--model needs a non-empty model name.')
  RequestedModel = explicitModel
  Model = resolveGatewayModel(RequestedModel)
}
if (explicitEffort !== null) {
  if (!explicitEffort.trim()) throw new Error('--effort needs a non-empty effort level.')
  Effort = explicitEffort
  EffortWasExplicit = true
}
if (EffortWasExplicit && Effort) {
  assertEffortSupported(Model, Effort)
} else if (!Effort) {
  Effort = defaultEffortFor(Model)
}

// A `--print` with no prompt argument and no redirected stdin is refused rather
// than left to hang on an empty pipe, matching the launcher on Windows. The same
// positional scan decides whether a fresh launch is bare-interactive below.
const ValueOptions = new Set(['--model', '--output-format', '--input-format', '--settings', '--effort', '--max-turns', '--fallback-model', '--agent', '--append-system-prompt', '--system-prompt', '--mcp-config'])
function hasPositionalArgument(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i])
    if (ValueOptions.has(arg) && i + 1 < args.length) { i++; continue }
    if (arg && !arg.startsWith('-')) return true
  }
  return false
}
const PrintRequested = ClaudeArgs.some(a => a === '--print' || a === '-p' || a.startsWith('--print='))
if (PrintRequested && !hasPositionalArgument(ClaudeArgs) && process.stdin.isTTY) {
  throw new Error('cc: --print requires a prompt argument or redirected stdin. Invoke cc without --print for the interactive REPL.')
}

// ---------------------------------------------------------------------------
// Harness artifact: rebuild when the source is newer than the bundle.
// ---------------------------------------------------------------------------

const ClaudeRunner = process.env.CC_CLAUDE_RUNNER_OVERRIDE || which('bun') || which('bun.exe')
const ClaudeScript = process.env.CC_CLAUDE_SCRIPT_OVERRIDE
  ? resolve(process.env.CC_CLAUDE_SCRIPT_OVERRIDE)
  : join(Root, 'dist', 'cli.js')

function newestMtime(paths) {
  let newest = 0
  const visit = p => {
    let st
    try { st = statSync(p) } catch { return }
    if (st.isDirectory()) {
      for (const entry of readdirSync(p)) visit(join(p, entry))
    } else if (st.mtimeMs > newest) {
      newest = st.mtimeMs
    }
  }
  for (const p of paths) visit(p)
  return newest
}

function artifactFresh() {
  if (!existsSync(ClaudeScript)) return false
  const inputs = [
    join(Root, 'src'),
    join(Root, 'scripts', 'build.ts'),
    join(ScriptsDir, 'effort-capabilities.json'),
    join(ScriptsDir, 'effort-capabilities.mjs'),
    join(Root, 'package.json'),
    join(Root, 'bun.lock'),
    join(Root, 'bun.lockb'),
    join(Root, 'tsconfig.json'),
  ]
  const latest = newestMtime(inputs)
  if (latest === 0) return false
  return statSync(ClaudeScript).mtimeMs >= latest
}

// A packaged tree has a compiled artifact and no build inputs. Archive tools
// may rewrite manifest mtimes so package.json/bun.lock look newer than
// dist/cli.js; rebuilding there would fail with no src/ to build. Only a tree
// that carries the build sources may decide the artifact is stale.
function isSourceCheckout() {
  return existsSync(join(Root, 'src')) && existsSync(join(Root, 'scripts', 'build.ts'))
}

function initializeArtifact() {
  if (!isSourceCheckout()) {
    if (!existsSync(ClaudeScript)) {
      throw new Error(`The compiled harness is missing: ${ClaudeScript}`)
    }
    return
  }
  if (artifactFresh()) return
  if (process.env.CC_CLAUDE_SCRIPT_OVERRIDE) {
    throw new Error('Selected candidate is missing or stale; build it explicitly before launch.')
  }
  if (!ClaudeRunner) {
    throw new Error('bun is required to rebuild the harness. Install bun or set CC_CLAUDE_RUNNER_OVERRIDE.')
  }
  process.stderr.write('cc: the compiled harness is stale; rebuilding before launch...\n')
  const build = spawnSync(ClaudeRunner, ['run', 'build'], { cwd: Root, stdio: ['ignore', 'inherit', 'inherit'], timeout: 600000 })
  if (build.error) throw new Error(`Claude harness build could not start: ${build.error.message}`)
  if (build.status !== 0) throw new Error(`Claude harness build failed with exit code ${build.status}.`)
}

if (ClaudeArgs.includes('--prewarm')) {
  if (ClaudeArgs.length !== 1) throw new Error('--prewarm must be used alone.')
  initializeArtifact()
  process.exit(0)
}

// ---------------------------------------------------------------------------
// CODEX_HOME, resolved at launch rather than trusted from a stale shell.
// ---------------------------------------------------------------------------

function resolveCodexHome() {
  const tandem = process.env.TANDEM_GATEWAY_CODEX_HOME
  if (tandem) {
    const selected = resolve(tandem)
    if (!existsSync(selected)) throw new Error(`Tandem Gateway account home does not exist: ${selected}`)
    return selected
  }
  const accountsRoot = join(Home, '.codex-accounts')
  let account = 'default'
  const selectionPath = join(accountsRoot, 'current.txt')
  const raw = readText(selectionPath)
  if (raw !== null) account = raw.trim()
  if (!account || account === 'default') return join(Home, '.codex')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(account)) {
    throw new Error(`Invalid selected Codex account name: ${account}`)
  }
  const selected = join(accountsRoot, account)
  if (!existsSync(selected)) throw new Error(`Selected Codex account home does not exist: ${selected}`)
  return selected
}
process.env.CODEX_HOME = resolveCodexHome()

// ---------------------------------------------------------------------------
// Gateway keys: the environment is the source of truth on POSIX.
// ---------------------------------------------------------------------------

const GATEWAY_KEY_RE = /^(DEEPSEEK_API_KEY|AMD_API_KEY|COMMANDCODE_API_KEY|OPENCODE_API_KEY)(?:[2-9]|[1-9][0-9]+)?$/

function loadGatewayEnv() {
  const env = { ...process.env }
  const envPath = process.env.MODEL_GATEWAY_ENV_FILE || join(ClaudeHome, 'gateway.env')
  const text = readText(envPath)
  if (text === null) return { env, loaded: 0 }
  let loaded = 0
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    env[match[1]] = value
    if (GATEWAY_KEY_RE.test(match[1])) loaded++
  }
  return { env, loaded }
}

// ---------------------------------------------------------------------------
// Gateway lifecycle.
// ---------------------------------------------------------------------------

function freeLoopbackPort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = net.createServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolvePort(port))
    })
  })
}

function portOccupied(port) {
  return new Promise(resolvePort => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = result => { socket.destroy(); resolvePort(result) }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(500, () => done(false))
  })
}

async function waitForHealth(port, process_, deadlineMs) {
  const started = Date.now()
  while (Date.now() - started < deadlineMs) {
    if (process_.exitCode !== null) return { healthy: false, exited: true, elapsedMs: Date.now() - started }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })
      if (res.ok) {
        const body = await res.json().catch(() => null)
        if (body && body.status === 'ok') return { healthy: true, elapsedMs: Date.now() - started }
      }
    } catch {
      // still binding
    }
    await new Promise(r => setTimeout(r, 250))
  }
  return { healthy: false, exited: false, elapsedMs: Date.now() - started }
}

/**
 * Kill a whole process group and wait for it.
 *
 * The POSIX equivalent of the Windows job object: the supervisor is spawned as
 * its own group leader, the gateway inherits that group, and a negative pid
 * signals every member. Windows kills the chain when the job handle closes even
 * if the launcher dies first; POSIX cannot match that (no PDEATHSIG on macOS),
 * so the guarantee here holds on every exit path the launcher can trap - normal
 * return and SIGINT/SIGTERM - and a SIGKILL of the launcher can still orphan the
 * group. The supervisor's own restart loop is what keeps the gateway up during a
 * session; this is only the teardown.
 */
function killGroup(pid) {
  if (!pid) return
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try {
      process.kill(-pid, signal)
    } catch {
      try { process.kill(pid, signal) } catch { return }
    }
    const deadline = Date.now() + (signal === 'SIGTERM' ? 5000 : 2000)
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0)
      } catch {
        return
      }
      spawnSync('sleep', ['0.1'])
    }
  }
}

// ---------------------------------------------------------------------------
// Launch.
// ---------------------------------------------------------------------------

if (!existsSync(join(ScriptsDir, 'model-gateway.mjs'))) {
  throw new Error(`Model gateway is missing: ${join(ScriptsDir, 'model-gateway.mjs')}`)
}
if (!existsSync(join(ScriptsDir, 'gateway-supervisor.mjs'))) {
  throw new Error(`Model gateway supervisor is missing: ${join(ScriptsDir, 'gateway-supervisor.mjs')}`)
}

initializeArtifact()

// `cc login` is a CLI subcommand, not a session. The harness fast-paths it and
// must see the operator's arguments unchanged: starting a gateway and appending
// session flags made the installer path fail on every invocation.
if (ClaudeArgs[0] === 'login') {
  if (!ClaudeRunner) {
    throw new Error('bun is required to run the harness. Install bun or set CC_CLAUDE_RUNNER_OVERRIDE.')
  }
  const result = spawnSync(ClaudeRunner, ['--no-install', ClaudeScript, ...ClaudeArgs], { stdio: 'inherit' })
  if (result.error) throw new Error(`Could not run the harness: ${result.error.message}`)
  process.exit(result.status ?? 1)
}

const port = (await portOccupied(4011)) ? await freeLoopbackPort() : 4011
const logDir = mkdtempSync(join(tmpdir(), 'model-gateway-'))
const stdoutLog = join(logDir, 'gateway.out.log')
const stderrLog = join(logDir, 'gateway.err.log')

const { env: gatewayEnvBase, loaded: keysLoaded } = loadGatewayEnv()

/**
 * The code default is the cleanroom bundled vault. A machine that already has
 * the legacy external store must keep using it, so the launcher sets the
 * explicit external flag itself when it finds one. This is the "our cc sets the
 * flag" half of the rule: nothing changes for an existing setup, and a fresh
 * machine stays on the bundled default.
 *
 * The legacy store is platform-specific: gateway.env keys on POSIX (the file
 * this launcher already loads) and ~/.keysafe/*.cred on Windows. A POSIX
 * ~/.keysafe directory is deliberately NOT consulted - keysafe.ps1 is
 * Windows-only, so a copy of that directory cannot be the external provider on
 * Linux or macOS.
 */
function legacyExternalStorePresent() {
  if (keysLoaded > 0) return true
  if (process.platform !== 'win32') return false
  try {
    return readdirSync(join(Home, '.keysafe')).some(entry => entry.endsWith('.cred'))
  } catch {
    return false
  }
}

if (!process.env.GATEWAY_CREDENTIALS_MODE) {
  // Inherited by both the supervisor and the harness, so the gateway and the
  // /login UI cannot disagree about which store holds the keys. Resolve it
  // explicitly: an unset value must mean the cleanroom default, never a
  // fall-through to the legacy branch.
  process.env.GATEWAY_CREDENTIALS_MODE = legacyExternalStorePresent() ? 'external' : 'bundled'
}

const gatewayEnv = { ...gatewayEnvBase, CLAUDE_CODE_GATEWAY_PORT: String(port) }
if (process.env.GATEWAY_CREDENTIALS_MODE) {
  gatewayEnv.GATEWAY_CREDENTIALS_MODE = process.env.GATEWAY_CREDENTIALS_MODE
}

let gatewayProcess = null
let exitCode = 1
let preserveLogs = false

function cleanup() {
  if (gatewayProcess) killGroup(gatewayProcess.pid)
  if (!KeepGatewayLogs && !preserveLogs) {
    try { rmSync(logDir, { recursive: true, force: true }) } catch {}
  } else {
    process.stderr.write(`cc gateway stdout log=${stdoutLog}\ncc gateway stderr log=${stderrLog}\n`)
  }
}
process.on('SIGINT', () => { cleanup(); process.exit(130) })
process.on('SIGTERM', () => { cleanup(); process.exit(143) })
// A terminal that goes away - the window closed, the ssh dropped, screen or
// tmux quit - sends SIGHUP, and on Windows the job object reaped the gateway on
// exactly that event. Without this trap the launcher outlives its terminal and
// leaves the gateway holding its port, which is what a closed screen session was
// observed doing. A session that really must outlive its terminal can setsid or
// launch from a detached context (no controlling terminal, no SIGHUP).
process.on('SIGHUP', () => { cleanup(); process.exit(129) })

try {
  process.stderr.write(`cc: starting the model gateway on port ${port}${keysLoaded ? ` (${keysLoaded} key(s) from gateway.env)` : ''}...\n`)
  const outFd = openSync(stdoutLog, 'a')
  const errFd = openSync(stderrLog, 'a')
  gatewayProcess = spawn(process.execPath, [join(ScriptsDir, 'gateway-supervisor.mjs'), '--port', String(port)], {
    cwd: Root,
    env: gatewayEnv,
    // stdin stays a pipe we hold open: when this launcher dies the pipe closes,
    // the supervisor sees EOF and takes the gateway down with it (its POSIX
    // parent-death watchdog). stdout/stderr go to the log files.
    stdio: ['pipe', outFd, errFd],
    // Own session/group: the whole backend chain dies with one killpg.
    detached: POSIX,
  })
  closeSync(outFd)
  closeSync(errFd)

  const health = await waitForHealth(port, gatewayProcess, 15000)
  if (!health.healthy) {
    preserveLogs = true
    const reason = health.exited
      ? `Model gateway backend exited (code ${gatewayProcess.exitCode}) after ${health.elapsedMs}ms without becoming healthy.`
      : `Model gateway did not become healthy within 15 seconds (waited ${health.elapsedMs}ms).`
    throw new Error(`${reason} Gateway logs: ${stdoutLog} ${stderrLog}`)
  }

  // Harness environment: strip any inherited Anthropic/provider env, then set the
  // gateway route. Provider keys stay in the gateway child only.
  const harnessEnv = { ...process.env }
  for (const name of Object.keys(harnessEnv)) {
    if (GATEWAY_KEY_RE.test(name)) delete harnessEnv[name]
  }
  const inherited = [
    'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  ]
  for (const name of inherited) delete harnessEnv[name]

  Object.assign(harnessEnv, {
    CLAUDE_CODE_GATEWAY_BASE_URL: `http://127.0.0.1:${port}`,
    CLAUDE_CODE_GATEWAY_TOKEN: GatewayToken,
    CLAUDE_CODE_USE_GATEWAY: '1',
    CLAUDE_GATEWAY_ALLOW_LOOPBACK: '1',
    MODEL_GATEWAY_MODEL: Model,
    CLAUDE_CODE_SUBAGENT_MODEL: Model,
    TANDEM_GATEWAY_PROVENANCE_SOURCE: 'cc',
    TANDEM_GATEWAY_PROVENANCE_PROVIDER: 'cc-gateway',
    TANDEM_GATEWAY_PROVENANCE_MODEL: Model,
    TANDEM_GATEWAY_PROVENANCE_EFFORT: Effort || '',
    TANDEM_GATEWAY_PROVENANCE_CWD: LaunchDirectory,
    TANDEM_GATEWAY_PROVENANCE_LAUNCH_NONCE: process.env.TANDEM_BRANCH_PROVIDER_LAUNCH_NONCE || '',
    MODEL_GATEWAY_DEFAULT_MODEL: 'gateway-gpt-6-sol',
    MODEL_GATEWAY_OPUS_MODEL: 'gateway-gpt-astra',
    MODEL_GATEWAY_FAST_MODEL: 'gateway-ds-flash',
    MODEL_GATEWAY_SUBAGENT_MODEL: 'gateway-ds-4.1-flash',
    DISABLE_CLAUDE_CODE_SM_COMPACT: '1',
    CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: '1',
    CLAUDE_CODE_WORKFLOWS: 'true',
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
    MODEL_GATEWAY_LOG_TIMING: '1',
    MODEL_GATEWAY_EFFORT_CAPABILITIES: JSON.stringify(Catalog.gatewayAliases || {}),
    MODEL_GATEWAY_MODEL_OPTIONS: JSON.stringify(orderedModelOptions()),
    MODEL_GATEWAY_EFFORT_DEFAULTS: Object.keys(PinnedEffortDefaults).length ? JSON.stringify(PinnedEffortDefaults) : '{}',
    MODEL_GATEWAY_CODEX_TOOL_MODE: process.env.MODEL_GATEWAY_CODEX_TOOL_MODE || 'balanced',
    CLAUDE_CODE_GATEWAY_PROVENANCE: JSON.stringify({
      source: 'cc',
      provider: 'cc-gateway',
      model_actual: Model,
      effort_actual: Effort,
      cwd_actual: LaunchDirectory,
      launch_nonce: process.env.TANDEM_BRANCH_PROVIDER_LAUNCH_NONCE || '',
    }),
  })
  if (process.env.CC_DISABLE_MEMORY_TELEMETRY !== '1') {
    const memoryDir = join(Home, 'Library', 'Application Support', 'Gateway', 'memory')
    harnessEnv.GATEWAY_MEMORY_TELEMETRY_DIR = memoryDir
    try { spawnSync('mkdir', ['-p', memoryDir]) } catch {}
  }
  if (!process.env.CLAUDE_CODE_TRUST_CWD) harnessEnv.CLAUDE_CODE_TRUST_CWD = '1'
  if (process.env.MODEL_GATEWAY_CAPTURE_EVENT_SHAPE === '1') harnessEnv.MODEL_GATEWAY_LOG_EVENT_SHAPE = '1'

  // Scoped settings: caller settings merged, modelOverrides cleared so inherited
  // Anthropic overrides cannot leak in, workflows enabled.
  CallerSettings.modelOverrides = {}
  CallerSettings.enableWorkflows = true
  CallerSettings.workflowKeywordTriggerEnabled = true
  const settingsPath = join(logDir, 'cc-gateway-settings.json')
  writeFileSync(settingsPath, JSON.stringify(CallerSettings), { mode: 0o600 })

  const isResume = ClaudeArgs.some(a => a === '--resume' || a === '-r' || a === '--continue' || a === '-c' || a.startsWith('--resume='))
  const hasEffortArg = ClaudeArgs.some(a => a === '--effort' || a.startsWith('--effort='))

  // A fresh interactive session is minted an id before the harness starts, so a
  // crash can be recovered: the retry relaunches with --resume <id> instead of
  // opening a second, unrelated conversation. Print launches and launches that
  // carry a positional prompt are left alone - print is a single turn, and
  // resuming a prompt-carrying launch would replay the prompt.
  const hasSessionIdArg = ClaudeArgs.some(a => a === '--session-id' || a.startsWith('--session-id='))
  let mintedSessionId = null
  if (!isResume && !hasSessionIdArg && !PrintRequested && !hasPositionalArgument(ClaudeArgs)) {
    mintedSessionId = randomUUID()
    ClaudeArgs.push('--session-id', mintedSessionId)
  }

  const finalArgs = [...ClaudeArgs, '--dangerously-skip-permissions']
  if (!hasEffortArg && Effort && (EffortWasExplicit || !isResume) && (EffortWasExplicit || CallerSettings.ultracode !== true)) {
    finalArgs.push('--effort', Effort)
  }
  finalArgs.push('--settings', settingsPath)

  // The retry resumes the very session that crashed: the minted --session-id is
  // rewritten to --resume in place. A resumed launch already carries --resume.
  const retryArgs = mintedSessionId
    ? finalArgs.map(a => (a === '--session-id' ? '--resume' : a))
    : finalArgs

  const attempts = isResume || mintedSessionId ? 1 : 0
  process.stderr.write('cc: launching the session...\n')
  for (let attempt = 0; attempt <= attempts; attempt++) {
    // --no-install must precede the script path; Bun silently ignores it after
    // it. A missing external then fails clearly instead of fetching latest.
    const result = spawnSync(ClaudeRunner, ['--no-install', ClaudeScript, ...(attempt === 0 ? finalArgs : retryArgs)], {
      cwd: LaunchDirectory,
      stdio: 'inherit',
      env: harnessEnv,
    })
    exitCode = result.status ?? 1
    if (result.error) {
      process.stderr.write(`cc: could not start the harness: ${result.error.message}\n`)
      break
    }
    if (exitCode !== 0 && exitCode !== 130 && attempt < attempts) {
      process.stderr.write(`cc: Claude exited unexpectedly with code ${exitCode}; restarting the resumed session once...\n`)
      spawnSync('sleep', ['0.5'])
      continue
    }
    break
  }
} finally {
  cleanup()
}

process.exit(exitCode)

/**
 * The model picker's saved order, applied to the catalogue before it is exported.
 * Ids the catalogue no longer offers are dropped; routes added since the file was
 * written keep their catalogue position at the bottom.
 */
function orderedModelOptions() {
  const options = Array.isArray(Catalog.gatewayModelOptions) ? [...Catalog.gatewayModelOptions] : []
  const stored = readJson(join(ClaudeHome, 'gateway-model-order.json'))
  if (!Array.isArray(stored) || stored.length === 0) return options
  const byValue = new Map(options.map(o => [String(o.value), o]))
  const leading = []
  const placed = new Set()
  for (const id of stored) {
    if (typeof id !== 'string' || !byValue.has(id) || placed.has(id)) continue
    leading.push(byValue.get(id))
    placed.add(id)
  }
  if (leading.length === 0) return options
  return [...leading, ...options.filter(o => !placed.has(String(o.value)))]
}
