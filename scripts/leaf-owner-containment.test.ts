import { test, expect, afterEach } from 'bun:test'
import { createServer, type Socket } from 'node:net'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The containment promise, proven against the real watchdog.
 *
 * A partner leaf is bound to its owner by a pipe, not by being its child: the
 * owner serves a secret on a private endpoint and the leaf polls it until the
 * endpoint stops answering, then ends itself. That is the whole reason a partner
 * cannot outlive the leaf that convened it, and until now it has been asserted
 * only by reading the source. These tests run the real `adoptHeadlessLeafOwner`
 * and the real 5s probe in a real child process, with no live gateway, no shared
 * build and no provider - the endpoint on the other end is the only thing faked,
 * because the endpoint's entire contract is "answer the token".
 *
 * Every bound here has the same floor and it is not a tuning choice: the probe
 * interval is `OWNER_PROBE_INTERVAL_MS = 5000` in leafTerminal.ts, so nothing can
 * be observed in less than one interval, and a test bound tighter than that would
 * be testing the bound rather than the watchdog. Each test waits for the probe it
 * is reasoning about - a connection counted by the endpoint, or a connection the
 * owner answered - rather than sleeping for a guessed duration. The one thing
 * taken off the measured path is the harness's own startup: a leaf runs from a
 * bundle, where the shutdown module is already loaded, and `adoptingLeaf`
 * preloads it for that reason.
 *
 * Two things this does NOT prove, both deliberate and both stated rather than
 * implied. It does not prove that a *descendant the leaf never registered* goes
 * with it: the fixture registers its descendant with the same registry a real
 * leaf uses, which is the mechanism under test, and an unregistered process
 * orphaned by a self-terminating leaf is a separate question for the live gate.
 * And it does not cover the interactive leaf's own terminal, only the headless
 * owner binding that a partner is launched with.
 *
 * Windows-gated: the owner endpoint is a named pipe, and the claim that the pipe
 * dies with the process is the point of the third test.
 */

const isWindows = process.platform === 'win32'

/** The product's probe interval. Every bound below is measured in these. */
const PROBE = 5_000
const PROBE_TIMEOUT = 3_000

/**
 * How long the leaf is given, after the probe that should end it, to be gone.
 *
 * Far above the two probes plus the shutdown itself, on purpose: what is
 * asserted is that the leaf exits and that what it owned goes with it, not how
 * quickly a loaded machine gets there. A tighter bound buys no safety - a leaf
 * that was going to hang is still hanging at any of these numbers - and it
 * turns machine load into a red. Measured here: a run that takes 12s alone can
 * take 43s when several suites are competing for the machine.
 */
const EXIT_WINDOW = PROBE * 2 + 20_000

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) { try { cleanup() } catch { /* a cleanup that fails must not fail the test it follows */ } } })

/** Whether a process this test started is still running. */
function isRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** A number a fixture wrote, or undefined while it has not written it yet. */
function published(file: string): number | undefined {
  try {
    const value = Number(readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim())
    return Number.isInteger(value) ? value : undefined
  } catch { return undefined }
}

async function waitFor<T>(check: () => T | undefined, what: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = check()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`waited ${timeoutMs}ms for ${what} and it never happened`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function within<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`waited ${timeoutMs}ms for ${what} and it never happened`)), timeoutMs)),
  ])
}

/**
 * The launch environment of a leaf, minus anything inherited.
 *
 * The suite is often run from inside a session that is itself a leaf, and its
 * environment carries leaf identity. A fixture that inherited it would adopt
 * identity it was not given, so every `GATEWAY_LEAF_*` is stripped and only the
 * values this test means to hand over are put back.
 */
function leafEnv(values: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('GATEWAY_LEAF_') || key === 'GATEWAY_INTERACTIVE_LEAF') delete env[key]
  }
  return { ...env, ...values }
}

/**
 * The owner's end of the pipe.
 *
 * `answering` is mutable so a test can change what the owner says without
 * changing its address: that is the difference between an owner that is gone and
 * an owner that is present and lying, and the two have to be told apart. Set to
 * undefined, the endpoint accepts and never answers - a busy owner.
 */
async function serveOwner(token: string) {
  const endpoint = `\\\\.\\pipe\\gateway-leaf-owner-${randomUUID()}`
  const state: { answering: string | undefined } = { answering: token }
  const sockets: Socket[] = []
  let connections = 0
  const sent: string[] = []
  const server = createServer(socket => {
    connections++
    sockets.push(socket)
    socket.on('error', () => {})
    if (state.answering !== undefined) {
      sent.push(state.answering)
      socket.end(`${state.answering}\n`)
    } else sent.push('(silent)')
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve) })
  const stop = () => { for (const socket of sockets.splice(0)) socket.destroy(); server.close() }
  cleanups.push(stop)
  return { endpoint, token, connections: () => connections, sent: () => sent, answer: (text: string | undefined) => { state.answering = text }, stop }
}

/**
 * A real headless leaf: it adopts the owner binding and then behaves like a
 * session, which means staying alive for its own reasons.
 *
 * That last part is not incidental. `watchLeafOwner`'s timer is unref'd on
 * purpose, so a process whose only work was watching its owner would exit before
 * the watchdog could ever fire - correct for the product, and the reason this
 * fixture holds a ref'd interval the way a real session holds its input loop.
 * It also spawns a descendant and registers it the way a leaf registers what it
 * owns, so the shutdown the watchdog triggers is the one under test rather than
 * a bare `exit`.
 *
 * It preloads the shutdown module before it starts watching, which is what a
 * bundled harness has and what the watchdog's own dynamic import finds there. In
 * source mode that import is a transpile of the whole harness graph, and when
 * several suites are running at once it measured 31s in this window - real work
 * on the machine, but not work this fixture is about. Preloading keeps the
 * fixture measuring the watchdog and the exit, not the build the exit waits on.
 */
function adoptingLeaf(owner: { endpoint: string; token: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'leaf-owner-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const startedFile = join(dir, 'started.txt')
  const exitFile = join(dir, 'exit.txt')
  const cleanupFile = join(dir, 'cleanup.txt')
  const grandchildPidFile = join(dir, 'grandchild.txt')

  const grandchildScript = join(dir, 'grandchild.mjs')
  writeFileSync(grandchildScript, [
    "import { writeFileSync } from 'node:fs'",
    'writeFileSync(process.env.GRANDCHILD_PID_FILE, String(process.pid))',
    'setInterval(() => {}, 1000)',
    '',
  ].join('\n'), 'utf8')

  // The child narrates its own progress to stderr, one line per step, with the
  // milliseconds since it started. A watchdog that fires and a shutdown that
  // never finishes look identical from the parent - the child is simply still
  // there - so the failing case has to say which step it reached. The last
  // mark printed is where it stopped, rather than a duration to be guessed at.
  const childScript = join(dir, 'child.mjs')
  writeFileSync(childScript, [
    "import { writeFileSync } from 'node:fs'",
    "import { spawn, execFile } from 'node:child_process'",
    'const began = Date.now()',
    'const mark = name => console.error(`LEAF ${name} +${Date.now() - began}ms`)',
    'const stamp = (file, text) => { try { writeFileSync(file, String(text)) } catch {} }',
    'stamp(process.env.CHILD_STARTED_FILE, process.pid)',
    "process.on('exit', code => { mark('exit'); stamp(process.env.CHILD_EXIT_FILE, code) })",
    "process.on('unhandledRejection', reason => console.error('UNHANDLED REJECTION', (reason && reason.stack) || reason))",
    "process.on('uncaughtException', error => console.error('UNCAUGHT', (error && error.stack) || error))",
    'setInterval(() => {}, 1000)',
    `const { registerCleanup } = await import(${JSON.stringify(new URL('../src/utils/cleanupRegistry.ts', import.meta.url).href)})`,
    "mark('registry')",
    // See the fixture note: this is the module the watchdog loads when it decides
    // the owner is gone, and loading it here is what a bundle has already done.
    `await import(${JSON.stringify(new URL('../src/utils/gracefulShutdown.ts', import.meta.url).href)})`,
    "mark('shutdown-loaded')",
    `const grandchild = spawn(process.execPath, [${JSON.stringify(grandchildScript)}], { env: process.env, stdio: 'ignore' })`,
    'registerCleanup(async () => {',
    '  stamp(process.env.CHILD_CLEANUP_FILE, "reached")',
    "  await new Promise(resolve => execFile('taskkill.exe', ['/PID', String(grandchild.pid), '/T', '/F'], { windowsHide: true }, () => resolve()))",
    "  mark('descendant-killed')",
    '})',
    `const leaf = await import(${JSON.stringify(new URL('../src/utils/leafTerminal.ts', import.meta.url).href)})`,
    "mark('leaf-imported')",
    'leaf.adoptHeadlessLeafOwner()',
    "mark('owner-watched')",
    // gracefulShutdown sets process.exitCode only after it arms its failsafe, so
    // this line is the boundary between "the shutdown got through its imports"
    // and "it never got that far".
    'const poll = setInterval(() => { if (process.exitCode !== undefined) { clearInterval(poll); mark(`exitCode=${process.exitCode}`) } }, 200)',
    '',
  ].join('\n'), 'utf8')

  const child = spawn(process.execPath, [childScript], {
    env: leafEnv({
      GATEWAY_LEAF_OWNER_ENDPOINT: owner.endpoint,
      GATEWAY_LEAF_OWNER_TOKEN: owner.token,
      GATEWAY_LEAF_SESSION: randomUUID(),
      GATEWAY_LEAF_LABEL: 'partner of a containment test',
      CHILD_STARTED_FILE: startedFile,
      CHILD_EXIT_FILE: exitFile,
      CHILD_CLEANUP_FILE: cleanupFile,
      GRANDCHILD_PID_FILE: grandchildPidFile,
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => { stderr += chunk })
  cleanups.push(() => {
    if (child.exitCode === null && child.pid) {
      execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
    }
  })
  return {
    child,
    stderr: () => stderr,
    started: () => published(startedFile),
    grandchild: () => published(grandchildPidFile),
    /** Whether the shutdown the watchdog asked for reached the cleanup registry. */
    reachedCleanup: () => published(cleanupFile) !== undefined,
    /** The exit code the leaf recorded about itself, or undefined while it has not ended. */
    exitCode: () => published(exitFile),
    /**
     * Resolves when the leaf is gone, and says how it ended.
     *
     * The `exit` event is the obvious channel and not the only one: with several
     * suites competing for the machine, a leaf that has demonstrably ended - its
     * own exit record written, its process no longer running - has been seen
     * while the event had not arrived, which made a leaf that died on schedule
     * read as one that never died. The child's own record plus asking the OS is
     * stronger evidence about a process that has already ended than a
     * convenience event, so whichever of them arrives first settles it.
     */
    exit: new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.on('exit', (code, signal) => resolve({ code, signal }))
      const observed = setInterval(() => {
        const recorded = published(exitFile)
        if (recorded === undefined || (child.pid !== undefined && isRunning(child.pid))) return
        clearInterval(observed)
        resolve({ code: recorded, signal: null })
      }, 200)
      observed.unref?.()
    }),
  }
}

test.skipIf(!isWindows)('a leaf lives while its owner answers the token, and a wrong answer is death', async () => {
  const owner = await serveOwner('the-owner-token')
  const leaf = adoptingLeaf(owner)
  // Starting is asserted separately from probing, so a fixture that never came up
  // is not mistaken for a watchdog that never fired.
  await waitFor(leaf.started, 'the leaf to start', 15_000)

  // Wait for the probe itself, not for a guessed duration: a connection counted
  // here is the watchdog having run, which is the thing being reasoned about.
  await waitFor(() => owner.connections() >= 1 || undefined, 'the leaf to probe its owner', PROBE + 8_000)
  const grandchild = await waitFor(leaf.grandchild, 'the leaf to start the descendant it owns', 5_000)
  expect(leaf.child.exitCode, `a leaf must not end while its owner is answering: ${leaf.stderr()}`).toBe(null)
  expect(isRunning(grandchild)).toBe(true)

  // A live endpoint that answers something else is not the owner. The secret is
  // the identity, so a stranger holding the address cannot keep a leaf alive.
  owner.answer('not-the-owner-token')
  const outcome = await within(leaf.exit, EXIT_WINDOW, 'the leaf to end when its owner stops answering the token')
    .catch((error: Error) => {
      throw new Error(`${error.message} | probes=${owner.connections()} answers=${JSON.stringify(owner.sent())} recordedExit=${leaf.exitCode()} running=${leaf.child.pid !== undefined && isRunning(leaf.child.pid)} reachedCleanup=${leaf.reachedCleanup()} stderr=${JSON.stringify(leaf.stderr())}`)
    })
  // Graceful, not killed: the watchdog asks for a shutdown, and a leaf that died
  // by another route would leave everything it owns behind.
  expect(outcome.code, `the leaf must shut down gracefully, not be killed: ${leaf.stderr()}`).toBe(0)

  // And what it owned went with it, through the registry the shutdown runs.
  await waitFor(() => !isRunning(grandchild) || undefined, 'the descendant the leaf owned to be taken with it', 8_000)
  expect(isRunning(grandchild), 'a leaf that ends must not leave its registered descendant behind').toBe(false)
}, { timeout: 120_000 })

test.skipIf(!isWindows)('a busy owner that cannot answer in time is not read as a dead one', async () => {
  const owner = await serveOwner('the-owner-token')
  // Accepts and never answers: an owner alive and too busy to reply.
  owner.answer(undefined)
  const leaf = adoptingLeaf(owner)

  // Two probes is the smallest amount of evidence that means anything: the first
  // must have timed out (`OWNER_PROBE_TIMEOUT_MS = 3000`) without ending the leaf,
  // and the interval must still be probing after it. A watchdog that read a
  // timeout as death would have ended the leaf and cancelled the interval, so the
  // second connection could not arrive.
  await waitFor(() => owner.connections() >= 2 || undefined, 'a timed-out probe and the next one after it', PROBE * 2 + PROBE_TIMEOUT + 8_000)
  expect(
    leaf.child.exitCode,
    `a busy owner must not take its own leaf down - that would end every partner of a session that merely paused: ${leaf.stderr()}`,
  ).toBe(null)
}, { timeout: 120_000 })

test.skipIf(!isWindows)('an owner that is killed rather than closed still ends its leaf, because the pipe dies with the process', async () => {
  // Served from a separate process, because this test has to kill the owner. The
  // endpoint is the identity precisely because a PID is not: the system reissues
  // a dead process's number, and a reclaimed PID would read as an owner that
  // never died. Here the process is really killed, so the pipe really goes.
  const dir = mkdtempSync(join(tmpdir(), 'leaf-owner-host-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const endpoint = `\\\\.\\pipe\\gateway-leaf-owner-${randomUUID()}`
  const token = 'the-owner-token'
  const servingFile = join(dir, 'serving.txt')
  const answersFile = join(dir, 'answers.txt')
  const hostScript = join(dir, 'owner.mjs')
  writeFileSync(hostScript, [
    "import { createServer } from 'node:net'",
    "import { writeFileSync } from 'node:fs'",
    'let answers = 0',
    'const server = createServer(socket => {',
    '  answers++',
    '  writeFileSync(process.env.OWNER_ANSWERS_FILE, String(answers))',
    "  socket.on('error', () => {})",
    '  socket.end(process.env.OWNER_TOKEN + String.fromCharCode(10))',
    '})',
    'server.listen(process.env.OWNER_ENDPOINT, () => writeFileSync(process.env.OWNER_SERVING_FILE, String(process.pid)))',
    'setInterval(() => {}, 1000)',
    '',
  ].join('\n'), 'utf8')
  const host = spawn(process.execPath, [hostScript], {
    env: leafEnv({ OWNER_ENDPOINT: endpoint, OWNER_TOKEN: token, OWNER_SERVING_FILE: servingFile, OWNER_ANSWERS_FILE: answersFile }),
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  cleanups.push(() => {
    if (host.exitCode === null && host.pid) execFile('taskkill.exe', ['/PID', String(host.pid), '/T', '/F'], { windowsHide: true }, () => {})
  })
  const hostPid = await waitFor(() => published(servingFile), 'the owner endpoint to be served', 10_000)

  const leaf = adoptingLeaf({ endpoint, token })
  // The leaf is alive *because of this pipe* - which is what makes killing the
  // process a test of the pipe rather than of a coincidence.
  await waitFor(() => published(answersFile), 'the owner to answer its leaf', PROBE + 8_000)
  expect(leaf.child.exitCode).toBe(null)

  await new Promise<void>(resolve => {
    execFile('taskkill.exe', ['/PID', String(hostPid), '/T', '/F'], { windowsHide: true }, () => resolve())
  })
  expect(isRunning(hostPid), 'the owner must really be gone, or nothing below is about a dead owner').toBe(false)

  const outcome = await within(leaf.exit, EXIT_WINDOW, 'the leaf to end once its owner process is gone')
    .catch((error: Error) => {
      throw new Error(`${error.message} | answers=${JSON.stringify(published(answersFile))} recordedExit=${leaf.exitCode()} running=${leaf.child.pid !== undefined && isRunning(leaf.child.pid)} reachedCleanup=${leaf.reachedCleanup()} stderr=${JSON.stringify(leaf.stderr())}`)
    })
  expect(outcome.code, `the leaf must shut down gracefully: ${leaf.stderr()}`).toBe(0)
}, { timeout: 120_000 })
