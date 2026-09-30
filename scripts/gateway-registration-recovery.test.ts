import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, rm, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { gatewayRegistrationRetryDelay, useGatewaySession } from '../src/hooks/useGatewaySession.ts'
import {
  GatewaySessionRuntime,
  gatewaySessionCommsProblem,
  gatewaySessionCommsState,
} from '../src/utils/gatewaySessionRuntime.ts'
import {
  GatewaySessionTransport,
  callGatewayPeer,
  listGatewayPeers,
} from '../src/utils/gatewaySessionTransport.ts'
import { isProcessRunning } from '../src/utils/genericProcessUtils.ts'
import { releaseGatewaySessionWriter } from '../src/utils/gatewaySessionOwnership.ts'

/**
 * Sessions that never reach the peer bus.
 *
 * Registration is three claims in a row - the writer lock, the id not already
 * being live, and the publish itself - and each can fail for a reason a person
 * could act on. Every one of them used to fail into a debug log that is a no-op
 * outside debug mode, so a session that never registered was indistinguishable
 * from one that had: the surfaces said "unavailable", and a peer trying to reach
 * it was told the session had exited. These pin the failures that actually
 * happened on this machine, the recovery that now happens instead, and the reason
 * that now survives to be read.
 */

/** A signal-0 probe that answers with the given errno, wherever it is made. */
function answerWith(code: string): typeof process.kill {
  return (() => {
    throw Object.assign(new Error('probe'), { code })
  }) as typeof process.kill
}

/** A config home of its own, restored around one test. */
async function configHome(): Promise<{ directory: string; restore: () => void }> {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-recovery-'))
  const previousDirectory = process.env.CLAUDE_CONFIG_DIR
  const previousGateway = process.env.CLAUDE_CODE_USE_GATEWAY
  process.env.CLAUDE_CONFIG_DIR = directory
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  return {
    directory,
    restore: () => {
      if (previousDirectory === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousDirectory
      if (previousGateway === undefined) delete process.env.CLAUDE_CODE_USE_GATEWAY
      else process.env.CLAUDE_CODE_USE_GATEWAY = previousGateway
    },
  }
}

test('only a process that is provably gone reads as gone', () => {
  // The probe fails two ways that mean opposite things. ESRCH is the proof of
  // exit; EPERM is an elevated process refusing to be signalled, and reading it
  // as gone let a listing delete a live session's registration, which is how a
  // running session became unreachable.
  const original = process.kill
  try {
    process.kill = answerWith('EPERM')
    assert.equal(isProcessRunning(4242), true)
    process.kill = answerWith('EACCES')
    assert.equal(isProcessRunning(4242), true)
    process.kill = answerWith('ESRCH')
    assert.equal(isProcessRunning(4242), false)
  } finally {
    process.kill = original
  }
  assert.equal(isProcessRunning(process.pid), true)
  assert.equal(isProcessRunning(1), false, 'init is never a session to reclaim')
  assert.equal(isProcessRunning(0), false)
})

test('a listing keeps the registration of a live session it cannot probe', { timeout: 30000 }, async () => {
  const { directory, restore } = await configHome()
  // The directory has to be created by a transport: start() is what sets the
  // private ACL the listing validates, and a hand-made directory fails that
  // check for a reason unrelated to what is under test.
  const sessions = join(directory, 'gateway-sessions')
  const seed = new GatewaySessionTransport({ directory: sessions, sessionId: randomUUID(), name: 'Seed', cwd: directory })
  const sessionId = randomUUID()
  try {
    await seed.start()
    await seed.close()
    const runtimeId = randomUUID()
    const path = join(sessions, `${sessionId}.json`)
    await writeFile(path, JSON.stringify({
      peer: {
        protocol: 1, sessionId, runtimeId, name: 'Elevated', cwd: directory, purpose: '', pid: process.pid,
        startedAt: new Date().toISOString(), status: 'idle', endpoint: `\\\\.\\pipe\\gateway-${runtimeId}`,
      },
      token: 'a'.repeat(64),
    }))
    // Old enough that the restart grace window no longer protects it, so the
    // probe's answer is the only thing between it and deletion.
    const stale = new Date(Date.now() - 7_200_000)
    await utimes(path, stale, stale)
    const original = process.kill
    try {
      process.kill = answerWith('EPERM')
      assert.deepEqual(await listGatewayPeers(sessions), [], 'nothing is listening on that endpoint')
      assert.ok((await readFile(path, 'utf8')).includes(sessionId), 'a live session keeps its registration')
      process.kill = answerWith('ESRCH')
      await listGatewayPeers(sessions)
      await assert.rejects(readFile(path), { code: 'ENOENT' }, 'a registration whose process is gone is still let go')
    } finally {
      process.kill = original
    }
  } finally {
    await seed.close()
    restore()
    await rm(directory, { recursive: true, force: true })
  }
})

test('a session blocked by a lock left behind by a gone process recovers, and reports what blocked it', { timeout: 30000 }, async () => {
  const { directory, restore } = await configHome()
  const writers = join(directory, 'gateway-writers')
  await mkdir(writers, { recursive: true })
  const sessionId = randomUUID()
  const lockPath = join(writers, sessionId)
  // A lock left behind by a process that is gone: the directory proper-lockfile
  // creates, with nobody alive to refresh it. Made by hand rather than taken,
  // because a real lock keeps a refresh timer of its own, and the steal below
  // would leave that timer stat-ing a path that no longer exists - a failure
  // that surfaces as an unhandled rejection in whichever test is running when it
  // fires, which is how this test first failed.
  await mkdir(`${lockPath}.lock`)
  let blocked: GatewaySessionRuntime | undefined
  let recovered: GatewaySessionRuntime | undefined
  try {
    // A fresh lock is indistinguishable from a live holder, so the claim is
    // refused - and the refusal is what has to survive for a person to read.
    blocked = new GatewaySessionRuntime(sessionId, directory, 'Blocked session')
    await assert.rejects(blocked.start(new Set()))
    const state = gatewaySessionCommsState(sessionId)
    assert.equal(state.state, 'failed')
    assert.ok(state.state === 'failed' && state.reason.length > 0, 'a failed registration keeps its reason')
    // The reason has to be the claim that was refused, not whatever the
    // teardown that followed it happened to fail at.
    assert.match(state.state === 'failed' ? state.reason : '', /already being held/)
    assert.doesNotMatch(state.state === 'failed' ? state.reason : '', /No live session/)
    assert.equal(gatewaySessionCommsProblem(sessionId), state.state === 'failed' ? state.reason : undefined)
    await blocked.close()
    // The holder is gone and nothing refreshes the lock, so it ages past its own
    // staleness window - the window that made a retry the only way to recover.
    const aged = new Date(Date.now() - 60_000)
    await utimes(`${lockPath}.lock`, aged, aged)
    recovered = new GatewaySessionRuntime(sessionId, directory, 'Recovered session')
    await recovered.start(new Set())
    assert.equal(gatewaySessionCommsState(sessionId).state, 'live')
    assert.equal(gatewaySessionCommsProblem(sessionId), undefined, 'a live session has nothing to report')
    assert.ok((await recovered.list()).some(peer => peer.sessionId === sessionId), 'and it is published on the bus')
  } finally {
    await recovered?.close()
    // A runtime's writer claim is a lease for its whole life, given back when the
    // process cleans up rather than at close, so the test has to release it
    // before removing the directory it points into - for the same reason as
    // above: a claim whose path disappeared reports the loss wherever it lands.
    await releaseGatewaySessionWriter(sessionId).catch(() => {})
    restore()
    await rm(directory, { recursive: true, force: true })
  }
})

test('a session whose fast retries are spent keeps trying and comes back on its own', { timeout: 180000 }, async () => {
  const { directory, restore } = await configHome()
  const sessionId = randomUUID()
  const sessions = join(directory, 'gateway-sessions')
  const writers = join(directory, 'gateway-writers')
  await mkdir(writers, { recursive: true })
  // A real lock, held by a holder that is alive and refreshing it. A hand-made
  // lock would not do: with nobody refreshing it, proper-lockfile reads it as
  // stale 30 seconds in and the fast schedule's last attempt simply steals it,
  // which is the ladder working rather than the recovery under test. A live
  // holder keeps the lock looking held for as long as it is held, so the fast
  // schedule is spent with the blocker still there - the state that used to be
  // permanent.
  const { lock } = await import('../src/utils/lockfile.ts')
  let held: (() => Promise<void>) | undefined = await lock(join(writers, sessionId), { realpath: false, retries: 0 })
  const { getSessionId, getSessionResumeDirectory, switchSession } = await import('../src/bootstrap/state.ts')
  const previousSessionId = getSessionId()
  const previousResumeDirectory = getSessionResumeDirectory()
  switchSession(sessionId as any, null, directory)
  const React = await import('react')
  const { render } = await import('../src/ink.ts')
  const { AppStateProvider } = await import('../src/state/AppState.tsx')
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 30, isTTY: true })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  // The real hook, mounted the way the REPL mounts it. Nothing here stands in
  // for the bus: the lock, the named pipe and the registration are all real, so
  // a session that reappears has genuinely recovered rather than been staged.
  const app = await render(
    React.createElement(AppStateProvider, null, React.createElement(function Harness() {
      useGatewaySession('Blocked session', 'idle', [])
      return null
    })),
    { stdout: stdout as any, stderr: stdout as any, stdin: stdin as any, patchConsole: false, exitOnCtrlC: false },
  )
  try {
    // The fast schedule is spent 42 seconds in, so a moment after that the
    // session is still off the bus - and it stays off the bus forever in the
    // version this test is written against, because the loop gave up there.
    await new Promise(resolve => setTimeout(resolve, 46_000))
    assert.equal(gatewaySessionCommsState(sessionId).state, 'failed', 'the blocked attempt kept its reason')
    assert.ok(!(await listGatewayPeers(sessions)).some(peer => peer.sessionId === sessionId), 'nothing registered it while it was blocked')
    // The blocker clears. A session that is still trying finds the bus on its
    // own; one that gave up never will, and no new process appears to rescue it.
    await held()
    held = undefined
    const deadline = Date.now() + 45_000
    let registered = false
    while (!registered && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 500))
      registered = (await listGatewayPeers(sessions)).some(peer => peer.sessionId === sessionId)
    }
    assert.ok(registered, 'the session registered itself after the blocker cleared, without a restart')
    assert.equal(gatewaySessionCommsProblem(sessionId), undefined, 'and it reads as live once it is')
  } finally {
    app.unmount()
    // A runtime's writer claim is a lease for its whole life, given back when the
    // process cleans up, so the test has to release it before removing the
    // directory it points into - for the same reason as the held lock above: a
    // lease whose path disappeared reports the loss wherever it lands.
    await held?.().catch(() => {})
    await releaseGatewaySessionWriter(sessionId).catch(() => {})
    switchSession(previousSessionId, null, previousResumeDirectory)
    restore()
    await rm(directory, { recursive: true, force: true })
  }
})

test('a session that was never asked to register says so, instead of reading as a broken bus', () => {
  const previous = process.env.CLAUDE_CODE_USE_GATEWAY
  const sessionId = randomUUID()
  try {
    delete process.env.CLAUDE_CODE_USE_GATEWAY
    const state = gatewaySessionCommsState(sessionId)
    assert.equal(state.state, 'disabled')
    assert.match(gatewaySessionCommsProblem(sessionId) ?? '', /CLAUDE_CODE_USE_GATEWAY/)
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_USE_GATEWAY
    else process.env.CLAUDE_CODE_USE_GATEWAY = previous
  }
})

test('registration is retried for longer than a lock can look held', async () => {
  const hook = await readFile(new URL('../src/hooks/useGatewaySession.ts', import.meta.url), 'utf8')
  const ownership = await readFile(new URL('../src/utils/gatewaySessionOwnership.ts', import.meta.url), 'utf8')
  // proper-lockfile keeps treating a lock a crashed process left behind as held
  // for its whole staleness window, so a retry shorter than that could never
  // succeed. The schedule has to outlast the claim's own window.
  const stale = Number(ownership.match(/stale: (\d+)/)?.[1])
  assert.ok(Number.isFinite(stale) && stale > 0, 'the writer claim has a staleness window')
  const schedule = hook.match(/GATEWAY_REGISTRATION_RETRY_MS = \[([^\]]*)\]/)?.[1] ?? ''
  const delays = schedule.split(',').map(part => Number(part.trim().replace(/_/g, ''))).filter(Number.isFinite)
  assert.ok(delays.length > 0, 'the registration attempt has a retry schedule')
  // The waits accumulate, so the final attempt is made after their total has
  // elapsed - that is the time that has to clear the window. The schedule is
  // the retry path for a process that died just before this one started, so the
  // lock is at its freshest when the first attempt sees it.
  const waits = delays.reduce((total, delay) => total + delay, 0)
  assert.ok(waits > stale, `the retries must keep trying past the ${stale}ms a dead holder's lock still looks held (they wait ${waits}ms)`)
  // Clearing the window is only half the promise. The loop used to give up when
  // the schedule ran out, so a blocker that outlived the window left the session
  // off the bus for as long as it lived. Every failure has to schedule another
  // attempt instead of returning.
  const failure = hook.slice(hook.indexOf('} catch (error) {'), hook.indexOf('if (disposed || getSessionId()'))
  assert.match(failure, /gatewayRegistrationRetryDelay\(attempt\)/, 'a failed attempt schedules the next one')
  assert.doesNotMatch(failure.replace(/if \(disposed\) return/g, ''), /\breturn\b/, 'the failure branch no longer gives up')
  // The retry has to build a fresh runtime: a failed start leaves its transport
  // closed, so reusing it can only fail again.
  assert.match(hook, /for \(let attempt = 0; !disposed; attempt\+\+\)/)
  assert.match(hook, /const runtime = new GatewaySessionRuntime\(sessionId, getSessionResumeDirectory\(\), name\)/)
  assert.equal((hook.match(/new GatewaySessionRuntime\(/g) ?? []).length, 1, 'one construction site, inside the retry loop')
})

test('the retry schedule has no end, so a session that cannot register keeps trying', () => {
  // The loop reads this schedule to decide whether to try again, so the property
  // that has to hold is that it never runs out. Stopping when it ran out is the
  // defect: the session was alive and writing its transcript while absent from
  // the bus, and only a new process ever put it back.
  for (const attempt of [0, 1, 2, 3, 4, 10, 100, 100_000]) {
    const delay = gatewayRegistrationRetryDelay(attempt)
    assert.ok(Number.isFinite(delay) && delay > 0, `attempt ${attempt} still has a wait`)
  }
  // The fast attempts are unchanged, so the failure the schedule was written for
  // - a lock that heals the moment its staleness window passes - is still met the
  // same way it was.
  assert.deepEqual([0, 1, 2].map(gatewayRegistrationRetryDelay), [2_000, 10_000, 30_000])
})

test('a request from a session with no registration of its own is refused for that reason', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-unregistered-sender-'))
  const directory = join(root, 'private')
  const receiver = new GatewaySessionTransport({ directory, sessionId: randomUUID(), name: 'Receiver', cwd: root })
  const sender = new GatewaySessionTransport({ directory, sessionId: randomUUID(), name: 'Sender', cwd: root })
  try {
    await receiver.start()
    await sender.start()
    const message = {
      id: randomUUID(), fromSessionId: sender.peer.sessionId, fromRuntimeId: sender.peer.runtimeId,
      toSessionId: receiver.peer.sessionId, text: 'FROM_NOWHERE', summary: 'unattributed', createdAt: new Date().toISOString(),
    }
    const request = { type: 'message', token: receiver.token, senderToken: sender.token, message }
    // While the sender is registered the same request is accepted, so the only
    // difference in the refusal below is the sender's own registration.
    assert.equal((await callGatewayPeer(receiver.peer.endpoint, request) as any).state, 'queued')
    await unlink(join(directory, `${sender.peer.sessionId}.json`))
    const refused = await callGatewayPeer(receiver.peer.endpoint, { ...request, message: { ...message, id: randomUUID() } }) as any
    assert.equal(refused.ok, false)
    assert.match(refused.reason, /not registered on this bus/)
    // A request that cannot show this session's token is still refused without
    // being told anything about the bus.
    const unauthorized = await callGatewayPeer(receiver.peer.endpoint, { ...request, token: 'not-the-token', message: { ...message, id: randomUUID() } }) as any
    assert.equal(unauthorized.ok, false)
    assert.doesNotMatch(unauthorized.reason, /not registered on this bus/)
  } finally {
    await sender.close()
    await receiver.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('closing a session whose registration was taken away is not an error', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-reaped-close-'))
  const directory = join(root, 'private')
  const transport = new GatewaySessionTransport({ directory, sessionId: randomUUID(), name: 'Reaped', cwd: root })
  try {
    await transport.start()
    // The registration can be gone while the session it describes is still
    // running - a listing that proved the pid dead removed it, or a person
    // clearing the tree did. Removing it is the outcome close() is reaching for,
    // so a session in that state has to close cleanly; it used to reject, and
    // that rejection landed in teardown paths and, worse, in the start-failure
    // path where it replaced the reason the start had failed.
    await unlink(join(directory, `${transport.peer.sessionId}.json`))
    await transport.close()
  } finally {
    await transport.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

test('every surface a person reads names the reason, not just "unavailable"', async () => {
  const sources: Array<[string, string]> = [
    ['/sessions', await readFile(new URL('../src/commands/gateway-sessions.ts', import.meta.url), 'utf8')],
    ['the panel', await readFile(new URL('../src/components/GatewaySessionsDialog.tsx', import.meta.url), 'utf8')],
    ['the peer skill', await readFile(new URL('../src/skills/bundled/gatewayPeers.ts', import.meta.url), 'utf8')],
    ['the send route', await readFile(new URL('../src/utils/gatewayPeerSend.ts', import.meta.url), 'utf8')],
  ]
  for (const [surface, source] of sources) assert.match(source, /gatewaySessionCommsProblem/, `${surface} names the reason`)
})
