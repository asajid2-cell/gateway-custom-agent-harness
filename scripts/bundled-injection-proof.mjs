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
 *
 * The "gateway" is a stub that writes {present, length, sha256 prefix} for each
 * gateway variable and its own ppid. No key value is ever written or printed.
 *
 * Phase E (supervisor restart-count across a reload) needs the supervisor's own
 * log contract; it is reported as SKIP until that is supplied.
 *
 * Exit codes: 0 all assertions pass, 1 a real failure, 2 the branch does not
 * have the bundled code yet (run it after auth/core merges into this branch).
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const VAULT_MODULE = path.join(ROOT, 'scripts', 'keysafe-vault.mjs')
const LAUNCH_MODULE = path.join(ROOT, 'scripts', 'gateway-keysafe.mjs')
const LAUNCH_SCRIPT = path.join(ROOT, 'scripts', 'gateway-vault-launch.mjs')
const STALE = 'STALE_SENTINEL_MUST_NOT_SURVIVE'
const WATCHED = ['DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'AMD_API_KEY', 'COMMANDCODE_API_KEY']

const results = []
const record = (item, status, evidence) => results.push({ item, status, evidence })
const sha12 = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 12)

function finish(asJson) {
  const failed = results.filter(result => result.status === 'FAIL').length
  if (asJson) {
    console.log(JSON.stringify({ pass: results.length - failed, fail: failed, results }, null, 2))
  } else {
    const width = Math.max(...results.map(result => result.item.length), 8)
    for (const result of results) {
      console.log(`${result.item.padEnd(width)} | ${result.status.padEnd(6)} | ${result.evidence}`)
    }
    console.log(`\n${results.length - failed}/${results.length} PASS, ${failed} FAIL`)
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

async function main() {
  const argv = process.argv.slice(2)
  const asJson = argv.includes('--json')
  const keep = argv.includes('--keep')

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

    record('supervisor restart count across a reload', 'SKIP',
      'needs the supervisor log contract; supply the runbook for phase E')
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
