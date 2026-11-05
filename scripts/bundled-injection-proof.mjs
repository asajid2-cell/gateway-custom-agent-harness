#!/usr/bin/env node
/**
 * Bundled-mode injection proof for the model gateway (Windows lane).
 *
 *   node scripts/bundled-injection-proof.mjs [--keep] [--json]
 *
 * Proves, without a live rig and without printing a secret:
 *
 *   A. A key saved into the bundled vault reaches the gateway child's
 *      environment through `gateway-vault-launch.mjs`.
 *   B. A stale inherited value for the same variable is stripped, so it cannot
 *      impersonate the vault value.
 *   C. The intermediate process is the bundled launcher, not the legacy
 *      powershell/keysafe.ps1 chain (the regression guard for "bundled
 *      accidentally used the external chain").
 *   D. The launcher propagates exit code 75 (GATEWAY_RELOAD_EXIT_CODE).
 *   E. The supervisor counts a deliberate reload as a reload, never a crash,
 *      and resets its restart counter (asserted on its own stderr contract:
 *      `model-gateway supervisor child-exit ... restart=<n>/<limit>` and
 *      `model-gateway supervisor reload-keys requested; restarting with a
 *      fresh <mode> credential chain`).
 *   BONUS. Double Ctrl-C closes a setup dialog and the process actually exits.
 *      This is NOT part of the auth/core injection proof: the fix under test is
 *      8507d9e "Exit when the exit keybinding closes a setup dialog", which
 *      rides along in the merged tree. It is reported separately and SKIPs
 *      when python/pywinpty is unavailable.
 *
 * For A-D the "gateway" is a stub that writes {present, length, sha256 prefix}
 * for each gateway variable and its own ppid. Phase E runs the real supervisor
 * and model gateway on a free loopback port with MODEL_GATEWAY_* cleared, so it
 * never touches the live rig. No key value is ever written or printed.
 *
 * Exit codes: 0 all assertions pass, 1 a real failure, 2 the branch does not
 * have the bundled code yet (run it after auth/core merges into this branch).
 */

import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const VAULT_MODULE = path.join(ROOT, 'scripts', 'keysafe-vault.mjs')
const LAUNCH_MODULE = path.join(ROOT, 'scripts', 'gateway-keysafe.mjs')
const LAUNCH_SCRIPT = path.join(ROOT, 'scripts', 'gateway-vault-launch.mjs')
const SUPERVISOR_SCRIPT = path.join(ROOT, 'scripts', 'gateway-supervisor.mjs')
const GATEWAY_SCRIPT = path.join(ROOT, 'scripts', 'model-gateway.mjs')

// Supervisor log contract (see gateway-supervisor.mjs). Line-anchored on the
// stderr pipe the supervisor writes to; the gateway's own lines share it.
const RELOAD_LINE = /^model-gateway supervisor reload-keys requested; restarting with a fresh (\S+) credential chain$/m
const CHILD_EXIT_LINE = /^model-gateway supervisor child-exit code=(\S+) signal=(\S+) restart=(\d+)\/(\d+) delay_ms=(\d+)$/gm
const LIMIT_LINE = /^model-gateway supervisor restart-limit-exhausted/m
// matchAll needs its own global copy; a global RegExp reused with .test() keeps
// lastIndex state and silently skips matches.
const RELOAD_LINE_ALL = new RegExp(RELOAD_LINE.source, 'gm')
const STALE = 'STALE_SENTINEL_MUST_NOT_SURVIVE'
const WATCHED = ['DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'AMD_API_KEY', 'COMMANDCODE_API_KEY']

const results = []
const record = (item, status, evidence) => results.push({ item, status, evidence })
const sha12 = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 12)

function finish(asJson) {
  const count = status => results.filter(result => result.status === status).length
  const failed = count('FAIL')
  const passed = count('PASS')
  const skipped = count('SKIP')
  if (asJson) {
    console.log(JSON.stringify({ pass: passed, fail: failed, skip: skipped, results }, null, 2))
  } else {
    const width = Math.max(...results.map(result => result.item.length), 8)
    for (const result of results) {
      console.log(`${result.item.padEnd(width)} | ${result.status.padEnd(6)} | ${result.evidence}`)
    }
    console.log(`\n${passed} PASS, ${failed} FAIL, ${skipped} SKIP (${results.length} rows)`)
  }
  return failed ? 1 : 0
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function stubGateway(outFile, mode) {
  return `import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
const watched = ${JSON.stringify(WATCHED)}
const summary = { ppid: process.ppid, argv0: process.argv[1] ?? null }
for (const name of watched) {
  const value = process.env[name]
  summary[name] = value === undefined
    ? { present: false }
    : { present: true, length: value.length, sha12: createHash('sha256').update(value).digest('hex').slice(0, 12) }
}
summary.allGatewayKeys = Object.keys(process.env).filter(key =>
  /(^|_)(API_KEY)(_[0-9]+)?$/.test(key) || /^(OPENCODE|COMMANDCODE)_API_KEY/.test(key))
writeFileSync(${JSON.stringify(outFile)}, JSON.stringify(summary, null, 2))
if (${JSON.stringify(mode)} === 'exit75') process.exit(75)
setTimeout(() => process.exit(0), 4000)
`
}

async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(file)) return true
    await sleep(50)
  }
  return false
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return true
    } catch {}
    await sleep(100)
  }
  console.error(`bundled-injection-proof: timed out waiting for ${label}`)
  return false
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function httpRequest(method, url) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method, timeout: 10000 }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => {
        body += chunk
      })
      response.on('end', () => resolve({ status: response.statusCode, body }))
    })
    request.on('timeout', () => request.destroy(new Error('timeout')))
    request.on('error', reject)
    request.end()
  })
}

function pidListeningOnPort(port) {
  try {
    const script =
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue ` +
      '| Select-Object -First 1 -ExpandProperty OwningProcess'
    const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim()
    return out ? Number(out) : null
  } catch {
    return null
  }
}

function killPid(pid, tree = false) {
  try {
    execFileSync('taskkill', [...(tree ? ['/T'] : []), '/F', '/PID', String(pid)], { stdio: 'ignore' })
  } catch {}
}

/**
 * Raw process-chain evidence for step 11: one line per ancestor, from the
 * gateway child up to the root, plus a compact summary. Read-only; nothing is
 * signalled or terminated.
 */
function processChain(startPid) {
  const script =
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine ' +
    '| ConvertTo-Json -Compress -Depth 3'
  let table = []
  try {
    const raw = execFileSync('powershell', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }).trim()
    const parsed = JSON.parse(raw)
    table = Array.isArray(parsed) ? parsed : [parsed]
  } catch (error) {
    return [`# chain lookup failed: ${String(error.message).slice(0, 160)}`]
  }
  const byPid = new Map(table.map(entry => [entry.ProcessId, entry]))
  const lines = [`# chain for pid=${startPid}`]
  const names = []
  let current = startPid
  const seen = new Set()
  while (current && !seen.has(current) && byPid.has(current)) {
    seen.add(current)
    const entry = byPid.get(current)
    lines.push(
      `pid=${entry.ProcessId} ppid=${entry.ParentProcessId} name=${entry.Name} ` +
      `argv=${entry.CommandLine ?? ''}`,
    )
    names.push(String(entry.Name ?? '').toLowerCase())
    current = entry.ParentProcessId
  }
  lines.push(`# chain: ${names.join(' -> ')}`)
  return lines
}

function childExitLines(log) {
  return [...log.matchAll(CHILD_EXIT_LINE)].map(match => ({
    index: match.index,
    code: match[1],
    signal: match[2],
    restart: Number(match[3]),
    limit: Number(match[4]),
    delay: Number(match[5]),
  }))
}

/**
 * BONUS: drive the real TUI through ConPTY and surface the double-Ctrl-C row.
 * Delegates to scripts/tui-conpty-smoke.py because a PTY needs pywinpty; the
 * row is labelled BONUS and cites 8507d9e, not auth/core.
 */
function ctrlCBonusPhase() {
  const label = 'BONUS double Ctrl-C exits (8507d9e)'
  const harness = path.join(ROOT, 'scripts', 'tui-conpty-smoke.py')
  const built = path.join(ROOT, 'dist', 'cli.js')
  if (!existsSync(harness) || !existsSync(built)) {
    record(label, 'SKIP', `missing ${!existsSync(harness) ? 'tui-conpty-smoke.py' : 'dist/cli.js'}`)
    return
  }
  let stdout = ''
  try {
    stdout = execFileSync('python', [harness, '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 300000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    })
  } catch (error) {
    // A non-zero exit still carries the JSON matrix for a genuine failure; only
    // an absent payload means the harness could not run at all.
    stdout = (error.stdout ?? '').toString()
    if (!stdout.includes('{')) {
      const stderr = String(error.stderr ?? '').trim().split('\n').slice(-2).join(' ')
      record(label, 'SKIP', `harness unavailable: ${stderr || String(error.message).slice(0, 140)}`)
      return
    }
  }
  let parsed = null
  try {
    parsed = JSON.parse(stdout.slice(stdout.indexOf('{')))
  } catch {
    record(label, 'FAIL', 'harness output was not valid JSON')
    return
  }
  const rows = Array.isArray(parsed.results) ? parsed.results : []
  const row = name => rows.find(entry => entry.item === name)
  const exitRow = row('Ctrl-C twice exits')
  const pendingRow = row('Ctrl-C once asks for confirmation')
  const modesRow = row('terminal modes restored')
  record(label, exitRow?.status === 'PASS' ? 'PASS' : 'FAIL',
    `${exitRow?.evidence ?? 'row missing'}; ` +
    `pending=${pendingRow?.status ?? 'n/a'} modes=${modesRow?.status ?? 'n/a'}; ` +
    'fix under test 8507d9e (not auth/core)')
}

/**
 * Phase E: supervisor restart accounting across a deliberate key reload.
 * Sequence: healthy start -> crash the child (restart=1) -> POST reload ->
 * crash again (restart must be 1, not 2). Line-anchored on the supervisor's
 * own stderr contract; no prose heuristics.
 */
async function reloadPhase(env, { vault, vaultDir } = {}) {
  if (!existsSync(SUPERVISOR_SCRIPT) || !existsSync(GATEWAY_SCRIPT)) {
    record('supervisor reload accounting', 'SKIP', 'supervisor/model-gateway not present in this tree')
    return
  }
  const port = await freePort()
  const supEnv = { ...env }
  // Hermetic: never inherit the live rig's gateway configuration.
  for (const name of Object.keys(supEnv)) {
    if (/^MODEL_GATEWAY_(?!SUPERVISOR_)/.test(name)) delete supEnv[name]
  }
  supEnv.MODEL_GATEWAY_SUPERVISOR_RESTART_BASE_MS = '100'
  supEnv.MODEL_GATEWAY_SUPERVISOR_RESTART_MAX_MS = '200'
  supEnv.MODEL_GATEWAY_SUPERVISOR_MAX_RESTARTS = '0'

  let log = ''
  const supervisor = spawn(process.execPath, [SUPERVISOR_SCRIPT, '--port', String(port)], {
    env: supEnv,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  supervisor.stderr.setEncoding('utf8')
  supervisor.stderr.on('data', chunk => {
    log += chunk
  })

  const health = () => httpRequest('GET', `http://127.0.0.1:${port}/health`)
  const healthy = async () => (await health()).status === 200

  try {
    if (!(await waitFor(healthy, 45000, 'initial /health'))) {
      record('supervisor payload boots', 'FAIL', `no /health; log=${log.slice(-300)}`)
      return
    }
    record('supervisor payload boots', 'PASS', `bundled chain, /health 200 on port ${port}`)
    record('clean start has no crash line', childExitLines(log).length === 0 ? 'PASS' : 'FAIL',
      `child-exit lines=${childExitLines(log).length}`)

    const crash = async label => {
      const exitsBefore = childExitLines(log).length
      const pid = pidListeningOnPort(port)
      if (!pid) return { label, pid: null, exitsBefore, counted: false }
      killPid(pid)
      const counted = await waitFor(() => childExitLines(log).length > exitsBefore, 20000,
        `${label} child-exit line`)
      await waitFor(() => {
        const current = pidListeningOnPort(port)
        return current && current !== pid
      }, 20000, `${label} respawn`)
      return { label, pid, exitsBefore, counted }
    }

    // Slot 1 of opencode lives in the vault for the whole run; slot 2 is saved
    // mid-run to prove the reload response reflects a fresh vault read.
    const slot1 = `probe-${createHash('sha256').update(`oc1-${Date.now()}`).digest('hex').slice(0, 32)}`
    await vault.captureSecret('opencode-go', slot1, { vaultDir })

    const reload = async label => {
      const before = log.length
      const pidBefore = pidListeningOnPort(port)
      const response = await httpRequest('POST', `http://127.0.0.1:${port}/gateway/reload-keys`)
      let body = null
      try {
        body = JSON.parse(response.body)
      } catch {}
      await waitFor(() => log.slice(before).match(RELOAD_LINE), 25000, `${label} reload line`)
      // The old process answers /health until it exits a few ms after the 200,
      // so wait for the listener pid to change before trusting health or
      // crashing the child.
      await waitFor(() => {
        const current = pidListeningOnPort(port)
        return current && current !== pidBefore
      }, 25000, `${label} respawned gateway pid`)
      return { status: response.status, body, segment: log.slice(before) }
    }

    // One deliberate crash before the reload, so the reset is meaningful.
    await crash('pre-reload')
    if (!(await waitFor(() => childExitLines(log).length >= 1, 20000, 'first child-exit line'))) {
      record('pre-reload crash counted', 'FAIL', `log=${log.slice(-300)}`)
    } else {
      const first = childExitLines(log)[0]
      record('pre-reload crash counted', first.restart === 1 ? 'PASS' : 'FAIL',
        `child-exit code=${first.code} signal=${first.signal} restart=${first.restart}/${first.limit}`)
    }
    await waitFor(healthy, 45000, '/health after first restart')

    const firstReload = await reload('first')
    record('reload route answers 200', firstReload.status === 200 ? 'PASS' : 'FAIL',
      `HTTP ${firstReload.status} ${JSON.stringify(firstReload.body ?? {}).slice(0, 100)}`)
    const firstMode = firstReload.segment.match(RELOAD_LINE)?.[1]
    record('reload line names the bundled chain', firstMode === 'bundled' ? 'PASS' : 'FAIL',
      firstMode ? `mode=${firstMode}` : `no reload line; got ${firstReload.segment.slice(-200)}`)
    record('reload reports the saved opencode slot',
      Array.isArray(firstReload.body?.available) && firstReload.body.available.includes(1) &&
      !firstReload.body.available.includes(2) ? 'PASS' : 'FAIL',
      `available=${JSON.stringify(firstReload.body?.available ?? null)} (expected [1])`)

    await waitFor(healthy, 45000, '/health after first reload')

    // Mid-run save. `available` is built from process.env + the in-process
    // overlay (sessionOpenCodeCredentials), not by re-reading the vault, so the
    // process that answers the NEXT reload still has the old chain: the new slot
    // appears one generation later, when that reload's respawn has run. Assert
    // the real behaviour and make the lag explicit rather than papering over it.
    const slot2 = `probe-${createHash('sha256').update(`oc2-${Date.now()}`).digest('hex').slice(0, 32)}`
    await vault.captureSecret('opencode-go2', slot2, { vaultDir })
    const secondReload = await reload('second')
    record('reload reports the running chain',
      Array.isArray(secondReload.body?.available) && secondReload.body.available.includes(1) &&
      !secondReload.body.available.includes(2) ? 'PASS' : 'FAIL',
      `available=${JSON.stringify(secondReload.body?.available ?? null)} (the answering process ` +
      'started before the save, so the new slot is not in its env yet)')

    await waitFor(healthy, 45000, '/health after second reload')
    // The chain lives in the respawned process; ask it directly rather than
    // trusting the reload response body.
    const accounts = await httpRequest('GET', `http://127.0.0.1:${port}/gateway/opencode-account`)
    let accountsBody = null
    try {
      accountsBody = JSON.parse(accounts.body)
    } catch {}
    record('next generation serves the new slot',
      accounts.status === 200 && Array.isArray(accountsBody?.available) &&
      accountsBody.available.includes(1) && accountsBody.available.includes(2) ? 'PASS' : 'FAIL',
      `HTTP ${accounts.status} available=${JSON.stringify(accountsBody?.available ?? null)} (expected [1,2])`)

    const thirdReload = await reload('third')
    record('mid-run save lands on the next generation',
      Array.isArray(thirdReload.body?.available) && thirdReload.body.available.includes(1) &&
      thirdReload.body.available.includes(2) ? 'PASS' : 'FAIL',
      `available=${JSON.stringify(thirdReload.body?.available ?? null)} (expected [1,2])`)

    const reloadMatches = [...log.matchAll(RELOAD_LINE_ALL)]
    const lastReloadIndex = reloadMatches.length ? reloadMatches[reloadMatches.length - 1].index : -1
    const tail = lastReloadIndex >= 0 ? log.slice(lastReloadIndex) : ''
    record('reload does not log a crash', tail && !/^model-gateway supervisor child-exit /m.test(tail) ? 'PASS' : 'FAIL',
      `reloads=${reloadMatches.length}, child-exit lines after the last one=` +
      `${(tail.match(/^model-gateway supervisor child-exit /gm) ?? []).length}`)
    record('reload never exhausts the restart limit', !LIMIT_LINE.test(log) ? 'PASS' : 'FAIL',
      `restart-limit-exhausted lines=${(log.match(/^model-gateway supervisor restart-limit-exhausted /gm) ?? []).length}`)

    await waitFor(healthy, 45000, '/health after second reload')
    const postCrash = await crash('post-reload')
    const exits = childExitLines(log)
    const afterReload = exits[exits.length - 1]
    record('restart counter reset by reload',
      exits.length >= 2 && afterReload && afterReload.restart === 1 ? 'PASS' : 'FAIL',
      afterReload
        ? `post-reload kill pid=${postCrash.pid ?? 'none'} counted=${postCrash.counted} ` +
          `restart=${afterReload.restart}/${afterReload.limit} (expected 1), exits=${exits.length}`
        : 'no second child-exit line')
  } finally {
    killPid(supervisor.pid, true)
    await sleep(300)
    killPid(supervisor.pid, true)
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const asJson = argv.includes('--json')
  const keep = argv.includes('--keep')

  // The Ctrl-C row has nothing to do with the vault, and it is the one phase
  // that needs `node_modules` present (the artifact resolves npm packages at
  // runtime). Let it run on its own.
  if (argv.includes('--bonus-only')) {
    ctrlCBonusPhase()
    return finish(asJson)
  }

  // Step-11 evidence capture: raw ancestor chain for a pid or for whoever is
  // listening on --port. Read-only; run it while `cc` is up.
  if (argv.includes('--chain')) {
    const readArg = flag => {
      const index = argv.indexOf(flag)
      return index >= 0 ? argv[index + 1] : undefined
    }
    const port = readArg('--port')
    const pid = readArg('--pid')
    const target = port ? pidListeningOnPort(Number(port)) : pid ? Number(pid) : null
    if (!target) {
      console.error('bundled-injection-proof --chain: pass --port <n> (listener) or --pid <n>')
      return 2
    }
    for (const line of processChain(target)) console.log(line)
    return 0
  }

  for (const [label, file] of [
    ['bundled vault module', VAULT_MODULE],
    ['bundled launch module', LAUNCH_MODULE],
    ['gateway-vault-launch.mjs', LAUNCH_SCRIPT],
  ]) {
    if (!existsSync(file)) {
      console.error(
        `bundled-injection-proof: ${label} is missing (${file}).\n` +
          'This branch predates the bundled injection work; rebranch release/windows on main after auth/core merges.',
      )
      return 2
    }
  }

  const root = mkdtempSync(path.join(os.tmpdir(), 'bundled-injection-proof-'))
  const configDir = path.join(root, '.claude')
  const vaultDir = path.join(configDir, 'keysafe')
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: configDir,
    USERPROFILE: root,
    HOME: root,
    GATEWAY_CREDENTIALS_MODE: 'bundled',
  }
  // Start from a clean gateway-key slate, then plant the stale value that must
  // be stripped. Any other *_API_KEY in the machine environment would make the
  // "no unvaulted gateway keys" assertion ambiguous.
  for (const name of Object.keys(env)) {
    if (/_API_KEY(_[0-9]+)?$/.test(name) || /^(ANTHROPIC|CLAUDE_CODE)_/.test(name)) delete env[name]
  }
  env.DEEPSEEK_API_KEY = STALE

  const secret = `probe-${createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 32)}`
  let launcher = null

  try {
    const vault = await import(pathToFileURL(VAULT_MODULE).href)
    await vault.captureSecret('ds', secret, { vaultDir })
    const stored = await vault.readSecret('ds', { vaultDir })
    record('vault round-trip', stored === secret ? 'PASS' : 'FAIL',
      `captured and re-read ds (${secret.length} chars, sha256 ${sha12(secret)})`)
    const listed = await vault.listSecrets({ vaultDir })
    record('vault record name', listed.length === 1 && listed[0]?.name === 'ds' ? 'PASS' : 'FAIL',
      `listSecrets -> ${JSON.stringify(listed.map(entry => entry.name))}`)
    if (process.platform === 'win32') {
      let aclVersion = null
      try {
        aclVersion = JSON.parse(readFileSync(path.join(vaultDir, 'vault.meta'), 'utf8')).aclVersion
      } catch {}
      record('vault.meta records the DACL pass', aclVersion === 1 ? 'PASS' : 'FAIL',
        `aclVersion=${aclVersion} (expected 1)`)
    }

    const launchModule = await import(pathToFileURL(LAUNCH_MODULE).href)
    const outFile = path.join(root, 'gateway-env.json')
    const stub = path.join(root, 'stub-gateway.mjs')
    writeFileSync(stub, stubGateway(outFile, 'inject'))

    const built = launchModule.buildGatewayLaunch({
      mode: 'bundled',
      gatewayPath: stub,
      gatewayArgs: [],
      nodePath: process.execPath,
      env,
      platform: 'win32',
    })

    const args = built.args.map(String)
    record('launcher is the bundled helper',
      path.basename(args[0] ?? '') === 'gateway-vault-launch.mjs' ? 'PASS' : 'FAIL',
      `file=${path.basename(built.file)} args[0]=${args[0]}`)
    record('launcher is not the external chain',
      !/keysafe\.ps1/i.test(args.join(' ')) && !/powershell/i.test(path.basename(built.file)) ? 'PASS' : 'FAIL',
      `argv=${args.map(arg => path.basename(arg)).join(' ')}`)
    record('runner is process.execPath', args[1] === process.execPath ? 'PASS' : 'FAIL',
      `args[1]=${args[1]}`)

    launcher = spawn(built.file, args, { env: built.env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    launcher.stderr.setEncoding('utf8')
    launcher.stderr.on('data', chunk => {
      stderr += chunk
    })

    if (!(await waitForFile(outFile, 30000))) {
      record('gateway child sees the vault value', 'FAIL', `no summary after 30s; stderr=${stderr.slice(0, 200)}`)
    } else {
      const summary = JSON.parse(readFileSync(outFile, 'utf8'))
      const deepseek = summary.DEEPSEEK_API_KEY ?? { present: false }
      record('gateway child sees the vault value',
        deepseek.present && deepseek.sha12 === sha12(secret) && deepseek.length === secret.length ? 'PASS' : 'FAIL',
        `present=${deepseek.present} length=${deepseek.length ?? 'n/a'} sha12=${deepseek.sha12 ?? 'n/a'} (expected ${sha12(secret)})`)
      record('stale inherited value is stripped',
        deepseek.sha12 !== sha12(STALE) ? 'PASS' : 'FAIL',
        `child value ${deepseek.sha12 === sha12(STALE) ? 'IS' : 'is not'} the stale sentinel`)
      record('gateway sees no unvaulted gateway keys',
        (summary.allGatewayKeys ?? []).length === 1 ? 'PASS' : 'FAIL',
        `gateway-key vars in env: ${JSON.stringify(summary.allGatewayKeys)}`)
      record('gateway parent is the launcher',
        summary.ppid === launcher.pid ? 'PASS' : 'FAIL',
        `gateway ppid=${summary.ppid} launcher pid=${launcher.pid}`)
      record('no powershell in the chain',
        !/powershell/i.test(built.file) ? 'PASS' : 'FAIL',
        `file=${path.basename(built.file)}`)
    }

    await new Promise(resolve => {
      if (launcher.exitCode !== null) return resolve()
      launcher.once('exit', resolve)
      setTimeout(resolve, 15000)
    })

    // D. exit-code propagation (the real gateway uses 75 for a reload).
    const out75 = path.join(root, 'gateway-env-75.json')
    const stub75 = path.join(root, 'stub-gateway-75.mjs')
    writeFileSync(stub75, stubGateway(out75, 'exit75'))
    const built75 = launchModule.buildGatewayLaunch({
      mode: 'bundled',
      gatewayPath: stub75,
      gatewayArgs: [],
      nodePath: process.execPath,
      env,
      platform: 'win32',
    })
    const propagation = spawn(built75.file, built75.args.map(String),
      { env: built75.env, windowsHide: true, stdio: 'ignore' })
    const code = await new Promise(resolve => propagation.once('exit', resolve))
    record('reload exit code propagates', code === 75 ? 'PASS' : 'FAIL',
      `launcher exit=${code} (expected 75)`)

    await reloadPhase(env, { vault, vaultDir })
    ctrlCBonusPhase()
  } finally {
    try {
      if (launcher && launcher.exitCode === null) launcher.kill()
    } catch {}
    if (!keep) rmSync(root, { recursive: true, force: true })
    else console.error(`bundled-injection-proof: kept ${root}`)
  }

  return finish(asJson)
}

const code = await main()
process.exitCode = code
