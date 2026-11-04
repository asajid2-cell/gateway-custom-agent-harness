/**
 * G-012 probe: does the driver (chatgpt.mjs) exit non-zero on its own during
 * ordinary serve-loop teardown?
 *
 * Reproduction only. This file starts the real driver as an OS child over the
 * frozen line-JSON protocol with an isolated HOME/USERPROFILE and profile, and
 * records the exit code plus the FULL stderr for four teardown shapes. It never
 * points at the live Chrome (CHATGPT_CHROME is a non-file, so any attempt to
 * launch a browser throws before touching a display) and never touches the live
 * host.
 */
import { test } from 'bun:test'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'

const DRIVER = 'C:/Users/Ahmed/chatgpt-web/chatgpt.mjs'
const WORK = path.join(os.tmpdir(), `g012-probe-${process.pid}-${Date.now()}`)

interface DriverIO {
  send: (value: unknown) => void
  closeStdin: () => void
  waitLine: (why: string, predicate: (line: any) => boolean, ms?: number) => Promise<any>
  exit: (ms?: number) => Promise<{ code: number | null; signal: string | null; timedOut: boolean }>
  stderr: () => string
  stdout: () => string[]
  kill: () => void
}

interface CaseResult {
  case: string
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  quitAnswered: boolean
  oks: string[]
  errors: string[]
  stderr: string
  stdout: string[]
  elapsedMs: number
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }

function startDriver(dir: string, port: number): DriverIO {
  const home = path.join(dir, 'home')
  const profile = path.join(dir, 'profile')
  fs.mkdirSync(path.join(home, '.chatgpt-web'), { recursive: true })
  fs.mkdirSync(profile, { recursive: true })
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CHATGPT_PROFILE: profile,
    CHATGPT_CDP_PORT: String(port),
    // Not a file: chromePath() throws instead of launching anything.
    CHATGPT_CHROME: 'C:/nonexistent/g012-no-chrome.exe',
  }
  const child = spawn(process.execPath, [DRIVER, 'serve'], {
    cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  const out: string[] = []
  let stderrText = ''
  let buf = ''
  const waiters: Array<{ predicate: (line: any) => boolean; resolve: (line: any) => void; why: string }> = []
  let exitInfo: { code: number | null; signal: string | null; timedOut: boolean } | null = null
  const exitWaiters: Array<(value: { code: number | null; signal: string | null; timedOut: boolean }) => void> = []

  child.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8')
    for (;;) {
      const nl = buf.indexOf('\n')
      if (nl < 0) break
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      out.push(line)
      let parsed: any = undefined
      try { parsed = JSON.parse(line) } catch { parsed = { unparsed: line } }
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        if (waiters[i].predicate(parsed)) {
          const waiter = waiters.splice(i, 1)[0]
          waiter.resolve(parsed)
        }
      }
    }
  })
  child.stderr.on('data', (chunk: Buffer) => { stderrText += chunk.toString('utf8') })
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal, timedOut: false }
    for (const resolve of exitWaiters.splice(0)) resolve(exitInfo)
  })

  return {
    send: value => { child.stdin.write(`${JSON.stringify(value)}\n`) },
    closeStdin: () => { child.stdin.end() },
    waitLine: (why, predicate, ms = 60_000) => new Promise((resolve, reject) => {
      const hit = out.map(line => { try { return JSON.parse(line) } catch { return { unparsed: line } } }).find(predicate)
      if (hit) return resolve(hit)
      const waiter = { predicate, why, resolve: (line: any) => { clearTimeout(timer); resolve(line) } }
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter)
        if (index >= 0) waiters.splice(index, 1)
        reject(new Error(`timed out waiting for ${why}; stdout so far: ${JSON.stringify(out)}; stderr so far: ${JSON.stringify(stderrText)}`))
      }, ms)
      waiters.push(waiter)
    }),
    exit: (ms = 90_000) => new Promise(resolve => {
      if (exitInfo) return resolve(exitInfo)
      const timer = setTimeout(() => {
        const index = exitWaiters.indexOf(waiter)
        if (index >= 0) exitWaiters.splice(index, 1)
        resolve({ code: null, signal: null, timedOut: true })
      }, ms)
      const waiter = (value: { code: number | null; signal: string | null; timedOut: boolean }) => { clearTimeout(timer); resolve(value) }
      exitWaiters.push(waiter)
    }),
    stderr: () => stderrText,
    stdout: () => out.slice(),
    kill: () => { try { child.kill() } catch { /* already gone */ } },
  }
}

async function runCase(name: string, steps: (io: DriverIO) => Promise<{ quitAnswered: boolean }>): Promise<CaseResult> {
  const dir = fs.mkdtempSync(path.join(WORK, `${name}-`))
  const port = await freePort()
  const io = startDriver(dir, port)
  const started = Date.now()
  let quitAnswered = false
  try {
    quitAnswered = (await steps(io)).quitAnswered
  } catch (error) {
    io.kill()
    const exit = await io.exit(10_000)
    return {
      case: name, exitCode: exit.code, signal: exit.signal, timedOut: exit.timedOut, quitAnswered: false,
      oks: [], errors: [`step failure: ${(error as Error).message}`], stderr: io.stderr(), stdout: io.stdout(),
      elapsedMs: Date.now() - started,
    }
  }
  const exit = await io.exit()
  if (exit.timedOut) io.kill()
  const parsed = io.stdout().map(line => { try { return JSON.parse(line) } catch { return { unparsed: line } } })
  return {
    case: name,
    exitCode: exit.code,
    signal: exit.signal,
    timedOut: exit.timedOut,
    quitAnswered,
    oks: parsed.filter(line => line && line.ok === true).map(line => String(line.op ?? line.event ?? 'ok')),
    errors: parsed.filter(line => line && line.ok === false).map(line => `${line.op ?? '?'}: ${line.error ?? line.reason ?? 'no error field'}`),
    stderr: io.stderr(),
    stdout: io.stdout(),
    elapsedMs: Date.now() - started,
  }
}

const results: CaseResult[] = []

test('G-012 probe: driver serve-loop teardown exit codes', async () => {
  fs.mkdirSync(WORK, { recursive: true })

  // (i) quit immediately after ready
  results.push(await runCase('quit-immediate', async io => {
    await io.waitLine('ready', line => line.event === 'ready', 60_000)
    io.send({ op: 'quit' })
    await io.waitLine('quit answer', line => line.op === 'quit' && line.ok === true, 60_000)
    return { quitAnswered: true }
  }))

  // (ii) an unknown op, then quit
  results.push(await runCase('unknown-op', async io => {
    await io.waitLine('ready', line => line.event === 'ready', 60_000)
    io.send({ op: 'bogus-g012', id: 'r1' })
    await io.waitLine('unknown-op answer', line => line.id === 'r1', 60_000)
    io.send({ op: 'quit' })
    await io.waitLine('quit answer', line => line.op === 'quit' && line.ok === true, 60_000)
    return { quitAnswered: true }
  }))

  // (iii) a well-formed op that needs a page, with no browser available
  results.push(await runCase('page-needed-none-available', async io => {
    await io.waitLine('ready', line => line.event === 'ready', 60_000)
    io.send({ op: 'threads', id: 'r2' })
    await io.waitLine('threads answer', line => line.id === 'r2', 120_000)
    io.send({ op: 'quit' })
    await io.waitLine('quit answer', line => line.op === 'quit' && line.ok === true, 60_000)
    return { quitAnswered: true }
  }))

  // (iv) two ops in sequence, then quit
  results.push(await runCase('two-ops-then-quit', async io => {
    await io.waitLine('ready', line => line.event === 'ready', 60_000)
    io.send({ op: 'ping', id: 'a' })
    await io.waitLine('ping a answer', line => line.id === 'a', 60_000)
    io.send({ op: 'ping', id: 'b' })
    await io.waitLine('ping b answer', line => line.id === 'b', 60_000)
    io.send({ op: 'quit' })
    await io.waitLine('quit answer', line => line.op === 'quit' && line.ok === true, 60_000)
    return { quitAnswered: true }
  }))

  // (v) the host-gone shape: stdin EOF with no quit frame (host force-killed)
  results.push(await runCase('host-gone-eof', async io => {
    await io.waitLine('ready', line => line.event === 'ready', 60_000)
    io.closeStdin()
    return { quitAnswered: false }
  }))

  await delay(50)
  console.log(`\n[G-012] ${JSON.stringify(results, null, 2)}\n`)

  for (const result of results) {
    if (result.timedOut) throw new Error(`case ${result.case} never exited within the probe budget`)
  }
}, 180_000)

/** Which termination gives the host's reported code 255 on this Windows/bun? */
test('G-012 probe: termination signatures for a bun child', async () => {
  fs.mkdirSync(WORK, { recursive: true })
  const standin = path.join(WORK, 'standin.mjs')
  fs.writeFileSync(standin, "setInterval(() => {}, 1000)\n")
  const signatures: Array<{ killer: string; code: number | null; signal: string | null }> = []
  for (const killer of ['bun-child.kill', 'taskkill /F', 'powershell Stop-Process -Force']) {
    const child = spawn(process.execPath, [standin], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => {
      child.on('exit', (code, signal) => resolve({ code, signal }))
    })
    await delay(700)
    if (killer === 'bun-child.kill') child.kill()
    else if (killer === 'taskkill /F') spawn('taskkill', ['/PID', String(child.pid), '/F'], { stdio: 'ignore', windowsHide: true })
    else spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Stop-Process -Id ${child.pid} -Force`], { stdio: 'ignore', windowsHide: true })
    const result = await Promise.race([exited, delay(20_000).then(() => ({ code: null, signal: 'NO-EXIT' as string | null }))])
    signatures.push({ killer, ...result })
    try { child.kill() } catch { /* already gone */ }
  }
  console.log(`\n[G-012] termination signatures: ${JSON.stringify(signatures, null, 2)}\n`)
}, 120_000)
