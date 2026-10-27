/**
 * Live proof for durable sessions. Run with:
 *
 *   bun scripts/gateway-durable-live.ts
 *
 * It runs entirely in a fresh ISOLATED `CLAUDE_CONFIG_DIR` (a mkdtemp directory)
 * and never touches a real leaf family or an existing session. It drives real
 * child processes through the real transport and prints the exact lines:
 *
 *   (a) a child registers a durable matriarch and exits  -> the registration
 *       survives and the listing renders the exact `[closed]` block.
 *   (b) a second real child sends to the closed peer     -> the exact queued
 *       line, and the mailbox holds the record.
 *   (c) `open` with a launcher that spawns a real process -> the CAS lock was
 *       held at launch, the generation advanced, the pid is alive, the pipe is
 *       present, and the outcome is `opened: ...`.
 *   (d) the reopened matriarch merges the mailbox         -> the record is in its
 *       inbox and the mailbox is gone.
 *
 * NOT part of this proof: the Windows Terminal spawn. `launchDurableSession`
 * opens a tab and is replaced here by a launcher that starts a real node
 * process; the argv it would pass is covered by the `durableLaunchArgs` unit
 * test. This script proves the session lifecycle, not the terminal.
 *
 * The script is self-dispatching: the parent mode above spawns itself with a
 * role argument for each child.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GatewaySessionTransport, listGatewayPeers } from '../src/utils/gatewaySessionTransport.ts'
import {
  leafFamilyPaths, requestDurablePeerOpen, resolveDurableIdentity,
} from '../src/utils/gatewaySessionDurability.ts'
import { formatGatewayPeerLine } from '../src/utils/gatewaySessionProtocol.ts'

const LIVE_CWD = process.platform === 'win32' ? 'C:\\live-proof' : '/live-proof'
const LIVE_ROUTE = { provider: 'liveproof', number: 1, baseUrl: 'http://127.0.0.1:9' }

type Role = 'register' | 'sender' | 'matriarch'

async function fileExists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch { return false }
}

// ---------------------------------------------------------------------------
// Child modes
// ---------------------------------------------------------------------------

async function runRegister(configHome: string, sessions: string, sessionId: string): Promise<void> {
  const transport = new GatewaySessionTransport({
    directory: sessions, sessionId, name: 'LiveProof', cwd: LIVE_CWD, route: LIVE_ROUTE,
  })
  // The production path: durability is resolved from the leaf-family index,
  // where the session's own id is authoritative, and applied before publish.
  transport.setDurable(await resolveDurableIdentity(sessionId, configHome))
  await transport.start()
  // A durable entry survives close; exit the process afterwards.
  await transport.close()
  process.exit(0)
}

async function runSender(configHome: string, sessions: string, targetId: string): Promise<void> {
  const transport = new GatewaySessionTransport({
    directory: sessions, sessionId: crypto.randomUUID(), name: 'LiveSender', cwd: LIVE_CWD, route: LIVE_ROUTE,
  })
  await transport.start()
  try {
    const receipt = await transport.send(targetId, 'while you are away', 'while away')
    // Flush before exiting; process.exit would otherwise be free to truncate
    // an async write to a pipe.
    await new Promise<void>(resolve => process.stdout.write(`SEND ${JSON.stringify(receipt)}\n`, () => resolve()))
  } finally {
    await transport.close()
  }
  process.exit(0)
}

async function runMatriarch(
  configHome: string,
  sessions: string,
  sessionId: string,
  familyId: string,
  generation: number,
): Promise<void> {
  const transport = new GatewaySessionTransport({
    directory: sessions, sessionId, name: 'LiveProof', cwd: LIVE_CWD, route: LIVE_ROUTE, durable: true, durableFamilyId: familyId,
  })
  await transport.start()
  // `start()` merges any mailbox into the ordinary inbox before the
  // registration becomes addressable again. Record what the reopened session
  // actually sees, then write the host claim the open request waits on.
  const statePath = join(configHome, 'live-proof-matriarch.json')
  await writeFile(statePath, JSON.stringify({
    pid: process.pid,
    inbox: transport.inbox(),
    mailboxGone: !(await fileExists(join(sessions, `${sessionId}.mailbox`))),
  }, null, 2))
  await writeFile(leafFamilyPaths(configHome, familyId).hostClaim, JSON.stringify({
    matriarchSessionId: sessionId, pid: process.pid, generation,
  }))
  process.stdout.write(`MATRIARCH ${process.pid} ${generation}\n`)
  // Stay alive so the open request finds a live pid and a present pipe.
  await new Promise<void>(() => {})
}

// ---------------------------------------------------------------------------
// Parent
// ---------------------------------------------------------------------------

function spawnChild(args: string[], env: NodeJS.ProcessEnv): {
  child: ChildProcess
  done: Promise<{ code: number | null; stdout: string; stderr: string }>
} {
  const script = fileURLToPath(import.meta.url)
  const child = spawn(process.execPath, [script, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stdout = ''
  let stderr = ''
  child.stdout!.on('data', chunk => { stdout += String(chunk) })
  child.stderr!.on('data', chunk => { stderr += String(chunk) })
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
    child.once('close', code => resolve({ code, stdout, stderr }))
  })
  return { child, done }
}

/** Poll until `fileExists` is true or the deadline passes. */
async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fileExists(path)) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
}

async function main(): Promise<void> {
  const role = process.argv[2] as Role | undefined
  if (role === 'register' || role === 'sender' || role === 'matriarch') {
    const [, , , configHome, sessions, a, b, c] = process.argv
    if (role === 'register') return runRegister(configHome!, sessions!, a!)
    if (role === 'sender') return runSender(configHome!, sessions!, a!)
    return runMatriarch(configHome!, sessions!, a!, b!, Number(c))
  }
  return runParent()
}

async function runParent(): Promise<void> {
  const configHome = await mkdtemp(join(tmpdir(), 'gateway-durable-live-'))
  const sessions = join(configHome, 'gateway-sessions')
  // The isolated home for this process AND every child. Reaping reads the
  // family record from here, so it must be the same home for all of them.
  process.env.CLAUDE_CONFIG_DIR = configHome
  const trace: string[] = []
  const say = (line: string) => { trace.push(line); process.stdout.write(`${line}\n`) }

  const familyId = crypto.randomUUID()
  const sessionId = crypto.randomUUID()
  const claimPath = leafFamilyPaths(configHome, familyId).hostClaim
  let matriarchChild: ChildProcess | undefined
  let matriarchDone: Promise<{ code: number | null; stdout: string; stderr: string }> | undefined

  try {
    // --- (a) a real child registers a durable matriarch and exits ----------
    await mkdir(join(configHome, 'leaf-families', 'index'), { recursive: true })
    await writeFile(leafFamilyPaths(configHome, familyId).familyRecord, JSON.stringify({
      rootSessionId: sessionId, members: [], nextNumber: 1, returnedContextIds: [], version: 1,
    }))
    await writeFile(claimPath, JSON.stringify({ matriarchSessionId: sessionId, pid: 1, generation: 1 }))

    const env = { ...process.env, CLAUDE_CONFIG_DIR: configHome }
    const registered = await spawnChild(['register', configHome, sessions, sessionId], env).done
    if (registered.code !== 0) throw new Error(`register child exited ${registered.code}: ${registered.stderr}`)
    const registrationPath = join(sessions, `${sessionId}.json`)
    if (!(await fileExists(registrationPath))) throw new Error('the durable registration did not survive the child exit')
    say('(a) registration survived the child exit')

    const listed = (await listGatewayPeers(sessions)).find(peer => peer.sessionId === sessionId)
    if (!listed) throw new Error('the closed durable peer is not listed')
    const closedRow = formatGatewayPeerLine(listed)
    const expectedRow = [
      '[closed] LiveProof',
      '    name: LiveProof',
      `    id: ${sessionId}`,
      `    cwd: ${LIVE_CWD}`,
      `    durable: closed - no process; mail queues to ${sessionId}.mailbox`,
      `    route: ${LIVE_ROUTE.provider}#${LIVE_ROUTE.number} declared, unprobed`,
      `    to use: gateway-peers open ${sessionId} | gateway-peers send JSON {"toSessionId":"${sessionId}","text":"...","summary":"..."}`,
    ].join('\n')
    if (closedRow !== expectedRow) throw new Error(`closed row mismatch:\n--- got ---\n${closedRow}\n--- want ---\n${expectedRow}`)
    say('(a) exact closed row:\n' + closedRow)

    // --- (b) a real second child sends to the closed peer ------------------
    const sender = await spawnChild(['sender', configHome, sessions, sessionId], env).done
    if (sender.code !== 0) throw new Error(`sender child exited ${sender.code}: ${sender.stderr}`)
    const sendLine = sender.stdout.split('\n').find(line => line.startsWith('SEND '))
    if (!sendLine) throw new Error(`sender produced no SEND line: ${sender.stdout}`)
    const receipt = JSON.parse(sendLine.slice(5)) as { closed?: boolean; state?: string; message?: string }
    const expectedQueued = `queued: peer ${sessionId} is closed; held in ${sessionId}.mailbox, merged at its next open. Request an open with: gateway-peers open ${sessionId}`
    if (receipt.closed !== true || receipt.state !== 'queued' || receipt.message !== expectedQueued) {
      throw new Error(`queued line mismatch: ${sendLine}`)
    }
    const mailboxPath = join(sessions, `${sessionId}.mailbox`)
    const mailbox = JSON.parse(await readFile(mailboxPath, 'utf8')) as { records: Array<{ message: { toSessionId: string; text: string }; state: string }> }
    if (mailbox.records.length !== 1 || mailbox.records[0]!.message.toSessionId !== sessionId || mailbox.records[0]!.message.text !== 'while you are away') {
      throw new Error(`mailbox does not hold the record: ${JSON.stringify(mailbox)}`)
    }
    say('(b) exact queued line:\n' + expectedQueued)
    say('(b) mailbox held 1 record')

    // --- (c) open, with a launcher that starts a real process --------------
    let casHeld = false
    const baseline = 1
    const outcome = await requestDurablePeerOpen(sessions, sessionId, {
      configHome,
      postOpenTimeoutMs: 30_000,
      pollMs: 50,
      launcher: async ({ familyId: launchedFamilyId }) => {
        // The open lock is beside the family record and is held while the
        // launcher runs. Its presence is the CAS this request won.
        casHeld = existsSync(leafFamilyPaths(configHome, launchedFamilyId).openLock)
        const started = spawnChild(['matriarch', configHome, sessions, sessionId, launchedFamilyId, String(baseline + 1)], env)
        matriarchChild = started.child
        matriarchDone = started.done
        return { ok: true }
      },
    })
    if (outcome.state !== 'opened') throw new Error(`open did not report opened: ${JSON.stringify(outcome)}`)
    if (!casHeld) throw new Error('the open lock was not held when the launcher ran')
    if (outcome.generation !== baseline + 1) throw new Error(`generation did not advance: ${outcome.generation}`)
    if (!(outcome.pid > 0)) throw new Error(`opened pid is not alive: ${outcome.pid}`)
    say('(c) CAS lock held at launch: true')
    say(`(c) opened: ${sessionId} (pid ${outcome.pid}, generation ${outcome.generation})`)

    // --- (d) the reopened matriarch merged the mailbox ---------------------
    const statePath = join(configHome, 'live-proof-matriarch.json')
    if (!(await waitFor(statePath, 10_000))) throw new Error('the matriarch did not report its merged inbox')
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      pid: number; mailboxGone: boolean; inbox: Array<{ state: string; message: { toSessionId: string; text: string } }>
    }
    if (state.pid !== outcome.pid) throw new Error(`reported pid ${state.pid} != opened pid ${outcome.pid}`)
    if (!state.mailboxGone) throw new Error('the mailbox still exists after the merge')
    if (state.inbox.length !== 1 || state.inbox[0]!.message.toSessionId !== sessionId || state.inbox[0]!.message.text !== 'while you are away') {
      throw new Error(`the merged inbox does not hold the record: ${JSON.stringify(state.inbox)}`)
    }
    say('(d) reopened matriarch inbox holds the record (1), mailbox gone: true')

    say('')
    say('PASS: durable lifecycle proven end to end (WT spawn not part of this proof)')
    process.exitCode = 0
  } catch (error) {
    say(`FAIL: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  } finally {
    // Stop the reopened process before removing the isolated home, so Windows
    // is not asked to delete files a live process still holds.
    if (matriarchChild && matriarchChild.exitCode === null) {
      matriarchChild.kill()
      await matriarchDone?.catch(() => {})
    }
    // Best-effort teardown; the temp home is isolated, so this only removes our
    // own artifacts. Never touches a real family.
    await rm(configHome, { recursive: true, force: true }).catch(() => {})
  }
}

void main()
