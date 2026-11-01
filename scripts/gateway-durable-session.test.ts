import { strict as assert } from 'node:assert'
import { test, beforeEach, afterEach } from 'node:test'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GatewaySessionTransport, listGatewayPeers, probePeerRoute } from '../src/utils/gatewaySessionTransport.ts'
import {
  durableLaunchArgs, formatOpenOutcome, leafFamilyPaths, requestDurablePeerOpen, resolveDurableIdentity,
} from '../src/utils/gatewaySessionDurability.ts'
import { formatGatewayPeerLine, GATEWAY_SESSION_PROTOCOL } from '../src/utils/gatewaySessionProtocol.ts'
import { registerGatewayPeersSkill } from '../src/skills/bundled/gatewayPeers.ts'
import { clearBundledSkills, getBundledSkills } from '../src/skills/bundledSkills.ts'
import type { ToolUseContext } from '../src/Tool.ts'
import { isolateAmbientGatewayRoute } from './gateway-test-env.ts'

// A bare transport here must not inherit the launcher's ambient gateway route.
isolateAmbientGatewayRoute()

/**
 * A durable entry is enumerable and addressable while CLOSED. These tests pin
 * the four things that makes true, against real files and real sockets wherever
 * that is possible:
 *
 *  1. Close keeps a durable registration and removes an ordinary one.
 *  2. The reaper keeps a durable entry for liveness and reaps it only when the
 *     family it fronts is gone.
 *  3. Liveness is pid AND endpoint - never a route-health answer. `unknown` is
 *     "probe could not run", not "dead".
 *  4. A closed durable peer's route is advisory: it never withholds delivery,
 *     while the same exhausted route DOES withhold for a live peer.
 *  5. Mail to a closed durable peer queues to `<id>.mailbox`, merges at open,
 *     and reports `queued` + closed, never delivered.
 *  6. Explicit open is the only path that starts a session and reports one of
 *     three truthful outcomes; delivery never opens a peer.
 */

/** A pid `isProcessRunning` treats as gone without touching the process table. */
const DEAD_PID = 1

let configHome: string
let restoreConfigDir: () => void

beforeEach(async () => {
  configHome = await mkdtemp(join(tmpdir(), 'gateway-durable-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configHome
  restoreConfigDir = () => {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
  }
})

afterEach(async () => {
  restoreConfigDir()
  await rm(configHome, { recursive: true, force: true }).catch(() => {})
})

function endpointFor(directory: string, runtimeId: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\gateway-${runtimeId}`
    : join(directory, `${runtimeId}.sock`)
}

/** A private registry directory, created the way production creates one. */
async function withRegistry(
  fn: (sessions: string) => Promise<void>,
): Promise<void> {
  const sessions = join(configHome, 'gateway-sessions')
  const holder = new GatewaySessionTransport({ directory: sessions, sessionId: randomUUID(), name: 'Holder', cwd: configHome })
  await holder.start()
  try { await fn(sessions) }
  finally { await holder.close().catch(() => {}) }
}

async function writeRegistration(
  sessions: string,
  values: { sessionId: string; pid: number; durable?: boolean; durableFamilyId?: string; route?: { provider: string; number: number; baseUrl: string } },
): Promise<void> {
  const runtimeId = randomUUID()
  const peer = {
    protocol: GATEWAY_SESSION_PROTOCOL,
    sessionId: values.sessionId,
    runtimeId,
    name: 'Durable Peer',
    cwd: configHome,
    purpose: '',
    pid: values.pid,
    startedAt: new Date().toISOString(),
    status: 'idle',
    endpoint: endpointFor(sessions, runtimeId),
    ...(values.route ? { route: values.route } : {}),
    ...(values.durable ? { durable: true } : {}),
    ...(values.durable && values.durableFamilyId ? { durableFamilyId: values.durableFamilyId } : {}),
  }
  await writeFile(join(sessions, `${values.sessionId}.json`), JSON.stringify({ peer, token: '0'.repeat(64) }))
}

async function writeHostClaim(familyId: string, claim: { matriarchSessionId: string; pid: number; generation: number }): Promise<void> {
  const index = join(configHome, 'leaf-families', 'index')
  await mkdir(index, { recursive: true })
  await writeFile(leafFamilyPaths(configHome, familyId).hostClaim, JSON.stringify(claim))
}

async function writeFamilyRecord(familyId: string): Promise<void> {
  await mkdir(join(configHome, 'leaf-families'), { recursive: true })
  await writeFile(leafFamilyPaths(configHome, familyId).familyRecord, JSON.stringify({ rootSessionId: randomUUID(), members: [], nextNumber: 1, returnedContextIds: [], version: 1 }))
}

async function fileExists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch { return false }
}

/** A loopback gateway that reports its one credential exhausted. */
async function startExhaustedGateway(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    if (!request.url?.startsWith('/gateway/route-health')) { response.statusCode = 404; response.end(); return }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ fleet: 'exhausted', provider: 'testprov', size: 1, numbers: [{ number: 1, state: 'exhausted', reason: 'http_400_insufficient_credits' }] }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

// ---------------------------------------------------------------------------
// 1. Close keeps a durable registration; an ordinary one is unlinked
// ---------------------------------------------------------------------------

test('close keeps a durable registration and unlinks an ordinary one', async () => {
  const sessions = join(configHome, 'gateway-sessions')
  const familyId = randomUUID()
  await writeFamilyRecord(familyId)

  const durableId = randomUUID()
  const durable = new GatewaySessionTransport({ directory: sessions, sessionId: durableId, name: 'Durable', cwd: configHome, durable: true, durableFamilyId: familyId })
  await durable.start()
  await durable.close()
  assert.equal(await fileExists(join(sessions, `${durableId}.json`)), true, 'a durable registration survives close')

  const ordinaryId = randomUUID()
  const ordinary = new GatewaySessionTransport({ directory: sessions, sessionId: ordinaryId, name: 'Ordinary', cwd: configHome })
  await ordinary.start()
  await ordinary.close()
  assert.equal(await fileExists(join(sessions, `${ordinaryId}.json`)), false, 'an ordinary registration is unlinked at close')

  // The durable entry is still enumerable, and it reads as closed: pid alive,
  // endpoint gone.
  const listed = await listGatewayPeers(sessions)
  const row = listed.find(peer => peer.sessionId === durableId)
  assert.ok(row, 'the closed durable peer is still listed')
  assert.equal(row!.durable, true)
  assert.equal(row!.durableState, 'closed')
})

// ---------------------------------------------------------------------------
// 2. Reaper: keep for liveness, reap only when the family record is gone
// ---------------------------------------------------------------------------

test('the reaper keeps a durable entry whose pid and pipe are gone, and reaps it once its family is deleted', async () => {
  await withRegistry(async sessions => {
    const familyId = randomUUID()
    const sessionId = randomUUID()
    await writeFamilyRecord(familyId)
    await writeRegistration(sessions, { sessionId, pid: DEAD_PID, durable: true, durableFamilyId: familyId })

    const kept = (await listGatewayPeers(sessions)).find(peer => peer.sessionId === sessionId)
    assert.ok(kept, 'a dead durable pid is not a reap reason')
    assert.equal(kept!.durableState, 'closed')

    await rm(leafFamilyPaths(configHome, familyId).familyRecord, { force: true })
    const reaped = (await listGatewayPeers(sessions)).find(peer => peer.sessionId === sessionId)
    assert.equal(reaped, undefined, 'the entry is reaped once the family it fronts is gone')
    assert.equal(await fileExists(join(sessions, `${sessionId}.json`)), false)
    assert.equal(await fileExists(join(sessions, `${sessionId}.dead.json`)), true, 'it is tombstoned, not silently dropped')
  })
})

test('the reaper never retires a registration whose process is alive, whatever its durable claim says', async () => {
  await withRegistry(async sessions => {
    const sessionId = randomUUID()
    // The live shape of the failure: a running process whose record advertises
    // durable, with a family id that has no family record. The old reaper read
    // the claim, skipped the pid, saw the family gone and tombstoned the record
    // of a session that was answering on its pipe the whole time.
    await writeRegistration(sessions, {
      sessionId, pid: process.pid, durable: true, durableFamilyId: randomUUID(),
    })

    const listed = (await listGatewayPeers(sessions)).find(peer => peer.sessionId === sessionId)
    assert.ok(listed, 'a live process is listed even when its durable claim points at no family')
    assert.equal(listed!.durableState, 'closed', 'liveness comes from pid + endpoint, not from the claim')
    assert.equal(await fileExists(join(sessions, `${sessionId}.json`)), true, 'its registration is not consumed by a listing')
    assert.equal(await fileExists(join(sessions, `${sessionId}.dead.json`)), false, 'nothing is tombstoned')
  })
})

// ---------------------------------------------------------------------------
// 3. Liveness is pid AND endpoint; unknown is not dead
// ---------------------------------------------------------------------------

test('liveness tokens: pid alive + pipe present is open; pid dead is closed; pid alive + pipe absent is closed; a throwing probe is unknown', async () => {
  // Open: a live durable transport, real pipe.
  const sessions = join(configHome, 'gateway-sessions')
  const familyId = randomUUID()
  await writeFamilyRecord(familyId)
  const openId = randomUUID()
  const open = new GatewaySessionTransport({ directory: sessions, sessionId: openId, name: 'Durable', cwd: configHome, durable: true, durableFamilyId: familyId })
  await open.start()
  try {
    const live = (await listGatewayPeers(sessions)).find(peer => peer.sessionId === openId)
    assert.equal(live?.durableState, 'open', 'pid alive and pipe present is open')
    assert.match(formatGatewayPeerLine(live!), /^\[idle\] /, 'an open durable row reuses the live token')
    assert.match(formatGatewayPeerLine(live!), /\n {4}durable: open$/, 'and says durable: open')

    await open.update({ status: 'running' })
    const working = (await listGatewayPeers(sessions)).find(peer => peer.sessionId === openId)
    assert.match(formatGatewayPeerLine(working!), /^\[running\] /, 'working token comes from the live registration, not the durable entry')
  } finally { await open.close() }

  // pid alive + pipe absent (just closed) is closed.
  const closedRow = (await listGatewayPeers(sessions)).find(peer => peer.sessionId === openId)
  assert.equal(closedRow?.durableState, 'closed')

  // pid dead is closed - proven with a fabricated registration.
  await withRegistry(async registry => {
    const deadId = randomUUID()
    await writeRegistration(registry, { sessionId: deadId, pid: DEAD_PID, durable: true, durableFamilyId: familyId })
    const deadRow = (await listGatewayPeers(registry)).find(peer => peer.sessionId === deadId)
    assert.equal(deadRow?.durableState, 'closed', 'a dead pid is closed, never a reason to drop the row')
  })

  // A probe that cannot run is `unknown`, not `closed`.
  await withRegistry(async registry => {
    const unknownId = randomUUID()
    await writeRegistration(registry, { sessionId: unknownId, pid: process.pid, durable: true, durableFamilyId: familyId })
    const unknownRow = (await listGatewayPeers(registry, { probeEndpoint: async () => { throw new Error('probe cannot run') } })).find(peer => peer.sessionId === unknownId)
    assert.equal(unknownRow?.durableState, 'unknown')
    assert.match(formatGatewayPeerLine(unknownRow!), /^\[unknown\] /)
    assert.match(formatGatewayPeerLine(unknownRow!), /durable: unknown - liveness probe unavailable/)
  })
})

// ---------------------------------------------------------------------------
// 4. A closed durable route is advisory; a live peer's route still withholds
// ---------------------------------------------------------------------------

test('a closed durable peer with an exhausted route still accepts mail, while the same route withholds a live peer', async () => {
  const gateway = await startExhaustedGateway()
  try {
    await withRegistry(async sessions => {
      const familyId = randomUUID()
      await writeFamilyRecord(familyId)
      const route = { provider: 'testprov', number: 1, baseUrl: gateway.url }

      // The real withholding function is active for this route.
      assert.equal((await probePeerRoute(route)).state, 'exhausted', 'the fixture route is genuinely exhausted')

      // A live peer advertising it is withheld.
      const liveId = randomUUID()
      const live = new GatewaySessionTransport({ directory: sessions, sessionId: liveId, name: 'Live', cwd: configHome, route })
      await live.start()
      const sender = new GatewaySessionTransport({ directory: sessions, sessionId: randomUUID(), name: 'Sender', cwd: configHome })
      await sender.start()
      try {
        const withheld = (await sender.send(liveId, 'held?', 'held?')) as { ok?: boolean; reason?: string; state?: string }
        assert.equal(withheld.ok, false, 'a live peer whose route cannot serve is withheld')
        assert.equal(withheld.reason, 'route_unavailable')
      } finally {
        await sender.close()
        await live.close()
      }

      // A CLOSED durable peer advertising the very same route accepts the mail:
      // its route is declared, not probed.
      const durableId = randomUUID()
      const durable = new GatewaySessionTransport({ directory: sessions, sessionId: durableId, name: 'Durable', cwd: configHome, durable: true, durableFamilyId: familyId, route })
      await durable.start()
      await durable.close()
      const sender2 = new GatewaySessionTransport({ directory: sessions, sessionId: randomUUID(), name: 'Sender2', cwd: configHome })
      await sender2.start()
      try {
        const queued = (await sender2.send(durableId, 'queued?', 'queued?')) as { ok?: boolean; closed?: boolean; state?: string }
        assert.equal(queued.ok, true, 'a closed durable peer route never withholds')
        assert.equal(queued.closed, true)
        assert.equal(queued.state, 'queued')
      } finally { await sender2.close() }
    })
  } finally { await gateway.close() }
})

// ---------------------------------------------------------------------------
// 5. Mailbox: queue while closed, merge and drain at open
// ---------------------------------------------------------------------------

test('mail to a closed durable peer queues to its mailbox, merges into the inbox at open, and never renders as delivered', async () => {
  const sessions = join(configHome, 'gateway-sessions')
  const familyId = randomUUID()
  await writeFamilyRecord(familyId)
  const targetId = randomUUID()

  const first = new GatewaySessionTransport({ directory: sessions, sessionId: targetId, name: 'Durable', cwd: configHome, durable: true, durableFamilyId: familyId })
  await first.start()
  await first.close()

  const sender = new GatewaySessionTransport({ directory: sessions, sessionId: randomUUID(), name: 'Sender', cwd: configHome })
  await sender.start()
  try {
    const receipt = (await sender.send(targetId, 'while you are away', 'while away', undefined, 'directive')) as {
      ok?: boolean; closed?: boolean; delivered?: boolean; state?: string; id?: string; message?: string
    }
    assert.equal(receipt.ok, true)
    assert.equal(receipt.closed, true)
    assert.equal(receipt.delivered, false)
    assert.equal(receipt.state, 'queued')
    assert.equal(
      receipt.message,
      `queued: peer ${targetId} is closed; held in ${targetId}.mailbox, merged at its next open. Request an open with: gateway-peers open ${targetId}`,
    )

    const mailboxPath = join(sessions, `${targetId}.mailbox`)
    const mailbox = JSON.parse(await readFile(mailboxPath, 'utf8')) as { records: Array<{ state: string; message: { toSessionId: string } }> }
    assert.equal(Array.isArray(mailbox.records), true, 'the mailbox is the same records shape, not a sidecar format')
    assert.equal(mailbox.records.length, 1)
    assert.equal(mailbox.records[0]!.message.toSessionId, targetId)
    assert.equal(mailbox.records[0]!.state, 'queued')
  } finally { await sender.close() }

  // Opening the durable peer merges the mailbox into the ordinary inbox and
  // removes the mailbox. The record arrives as `queued`, i.e. drainable by the
  // normal queued -> held -> delivered lifecycle.
  const second = new GatewaySessionTransport({ directory: sessions, sessionId: targetId, name: 'Durable', cwd: configHome, durable: true, durableFamilyId: familyId })
  await second.start()
  try {
    const inbox = second.inbox()
    assert.equal(inbox.length, 1, 'held mail is in the ordinary inbox after open')
    assert.equal(inbox[0]!.state, 'queued')
    assert.equal(inbox[0]!.message.toSessionId, targetId)
    assert.equal(await fileExists(join(sessions, `${targetId}.mailbox`)), false, 'the mailbox is removed once merged')
  } finally { await second.close() }
})

// ---------------------------------------------------------------------------
// 5b. D7: `unknown` is not `closed`; it never parks a live peer's mail
// ---------------------------------------------------------------------------

test('an injected `unknown` liveness does not divert mail from a live durable peer', async () => {
  const sessions = join(configHome, 'gateway-sessions')
  const familyId = randomUUID()
  await writeFamilyRecord(familyId)
  const targetId = randomUUID()
  const target = new GatewaySessionTransport({ directory: sessions, sessionId: targetId, name: 'Durable', cwd: configHome, durable: true, durableFamilyId: familyId })
  await target.start()
  const sender = new GatewaySessionTransport({
    directory: sessions, sessionId: randomUUID(), name: 'Sender', cwd: configHome,
    // The probe cannot be evaluated. That is NOT evidence the peer is dead, so
    // the ordinary live-send path must be taken.
    durableLivenessProbe: async () => 'unknown',
  })
  await sender.start()
  try {
    const receipt = (await sender.send(targetId, 'live?', 'live?')) as { ok?: boolean; closed?: boolean; state?: string }
    assert.notEqual(receipt.closed, true, 'unknown must never be reported as closed')
    assert.equal(receipt.ok, true)
    assert.equal(await fileExists(join(sessions, `${targetId}.mailbox`)), false, 'a live peer\'s mail is not parked in a mailbox')
    assert.equal(target.inbox().length, 1, 'the message reached the live peer instead')
  } finally {
    await sender.close()
    await target.close()
  }
})

test('an injected `unknown` whose send then finds the pipe absent queues to the mailbox with the closed line', async () => {
  await withRegistry(async sessions => {
    const familyId = randomUUID()
    await writeFamilyRecord(familyId)
    const targetId = randomUUID()
    // A live pid but no listener: only the REAL endpoint probe can prove the
    // pipe is gone, and that is what licenses the fallback queue.
    await writeRegistration(sessions, { sessionId: targetId, pid: process.pid, durable: true, durableFamilyId: familyId })
    const sender = new GatewaySessionTransport({
      directory: sessions, sessionId: randomUUID(), name: 'Sender', cwd: configHome,
      durableLivenessProbe: async () => 'unknown',
    })
    await sender.start()
    try {
      const receipt = (await sender.send(targetId, 'park me', 'park me')) as { ok?: boolean; closed?: boolean; state?: string; message?: string }
      assert.equal(receipt.ok, true)
      assert.equal(receipt.closed, true, 'a failed connect plus an absent pipe is proof of closed')
      assert.equal(receipt.state, 'queued')
      assert.equal(
        receipt.message,
        `queued: peer ${targetId} is closed; held in ${targetId}.mailbox, merged at its next open. Request an open with: gateway-peers open ${targetId}`,
      )
      const mailbox = JSON.parse(await readFile(join(sessions, `${targetId}.mailbox`), 'utf8')) as { records: Array<{ message: { toSessionId: string }; state: string }> }
      assert.equal(mailbox.records.length, 1, 'the mail is parked in the recipient mailbox')
      assert.equal(mailbox.records[0]!.message.toSessionId, targetId)
      assert.equal(mailbox.records[0]!.state, 'queued')
    } finally { await sender.close() }
  })
})

test('requireOpen does not call an `unknown` durable peer closed', async () => {
  await withRegistry(async sessions => {
    const familyId = randomUUID()
    await writeFamilyRecord(familyId)
    const targetId = randomUUID()
    await writeRegistration(sessions, { sessionId: targetId, pid: process.pid, durable: true, durableFamilyId: familyId })
    const sender = new GatewaySessionTransport({
      directory: sessions, sessionId: randomUUID(), name: 'Sender', cwd: configHome,
      durableLivenessProbe: async () => 'unknown',
    })
    await sender.start()
    try {
      // The call is ATTEMPTED (and fails at the socket), so the error is the
      // transport's, never the durable "is closed" refusal.
      await assert.rejects(
        () => sender.receipt(targetId, randomUUID()),
        (error: unknown) => {
          assert.doesNotMatch(String((error as Error)?.message ?? error), /is closed \(durable\)/i)
          return true
        },
      )
    } finally { await sender.close() }
  })
})

// ---------------------------------------------------------------------------
// 6. Explicit open: three truthful outcomes, and delivery never opens
// ---------------------------------------------------------------------------

async function openFixture(
  sessions: string,
  options: { peerPid: number; hostPid: number; generation?: number },
): Promise<{ sessionId: string; familyId: string; claimPath: string }> {
  const familyId = randomUUID()
  const sessionId = randomUUID()
  await writeFamilyRecord(familyId)
  await writeRegistration(sessions, { sessionId, pid: options.peerPid, durable: true, durableFamilyId: familyId })
  await writeHostClaim(familyId, { matriarchSessionId: sessionId, pid: options.hostPid, generation: options.generation ?? 3 })
  return { sessionId, familyId, claimPath: leafFamilyPaths(configHome, familyId).hostClaim }
}

test('open reports already-open without invoking the launcher when a live peer row exists', async () => {
  await withRegistry(async sessions => {
    const { sessionId, familyId } = await openFixture(sessions, { peerPid: process.pid, hostPid: DEAD_PID })
    let launched = 0
    const outcome = await requestDurablePeerOpen(sessions, sessionId, {
      configHome,
      probeEndpoint: async () => 'present',
      launcher: async () => { launched += 1; return { ok: true } },
    })
    assert.equal(outcome.state, 'already-open', 'a live pid + present pipe is already open')
    assert.equal(launched, 0, 'the launcher is NOT invoked for an already-open peer')
    assert.equal((outcome as { generation: number }).generation, 3)
    assert.equal(formatOpenOutcome(outcome), `already-open: writer ${sessionId} (pid ${process.pid}, generation 3)`)
    void familyId
  })
})

test('open reports already-open when a live family host claim holds the writer, without launching', async () => {
  await withRegistry(async sessions => {
    // Peer row looks closed (dead pid), but the host claim's holder is alive.
    const { sessionId } = await openFixture(sessions, { peerPid: DEAD_PID, hostPid: process.pid })
    let launched = 0
    const outcome = await requestDurablePeerOpen(sessions, sessionId, {
      configHome,
      probeEndpoint: async () => 'absent',
      launcher: async () => { launched += 1; return { ok: true } },
    })
    assert.equal(outcome.state, 'already-open')
    assert.equal(launched, 0)
    assert.equal((outcome as { pid: number }).pid, process.pid)
  })
})

test('open reports opened only when the generation advances, the pid is alive and the pipe is present', async () => {
  await withRegistry(async sessions => {
    const { sessionId, familyId, claimPath } = await openFixture(sessions, { peerPid: DEAD_PID, hostPid: DEAD_PID })
    let launched = 0
    const outcome = await requestDurablePeerOpen(sessions, sessionId, {
      configHome,
      probeEndpoint: async () => 'present',
      postOpenTimeoutMs: 500,
      pollMs: 10,
      launcher: async () => {
        launched += 1
        await writeHostClaim(familyId, { matriarchSessionId: sessionId, pid: process.pid, generation: 4 })
        return { ok: true }
      },
    })
    assert.equal(launched, 1)
    assert.equal(outcome.state, 'opened')
    assert.equal((outcome as { pid: number }).pid, process.pid)
    assert.equal((outcome as { generation: number }).generation, 4)
    assert.equal(formatOpenOutcome(outcome), `opened: ${sessionId} (pid ${process.pid}, generation 4)`)
    void claimPath
  })
})

test('open names each failed post-open check, with retry safety', async () => {
  await withRegistry(async sessions => {
    // not-durable: an ordinary registration is never opened.
    const notDurableId = randomUUID()
    await writeRegistration(sessions, { sessionId: notDurableId, pid: DEAD_PID })
    const notDurable = await requestDurablePeerOpen(sessions, notDurableId, { configHome, launcher: async () => ({ ok: true }) })
    assert.equal(notDurable.state, 'failed')
    assert.equal((notDurable as { check: string }).check, 'not-durable')
    assert.equal(formatOpenOutcome(notDurable), 'failed: not-durable; retry unsafe')

    // generation-not-advanced: the launcher does nothing.
    {
      const { sessionId } = await openFixture(sessions, { peerPid: DEAD_PID, hostPid: DEAD_PID })
      const outcome = await requestDurablePeerOpen(sessions, sessionId, {
        configHome, probeEndpoint: async () => 'present', postOpenTimeoutMs: 40, pollMs: 5,
        launcher: async () => ({ ok: true }),
      })
      assert.equal(outcome.state, 'failed')
      assert.equal((outcome as { check: string }).check, 'generation-not-advanced')
      assert.equal(formatOpenOutcome(outcome), 'failed: generation-not-advanced; retry unsafe')
    }

    // pid-not-alive: the generation advances but the host pid is dead.
    {
      const { sessionId, familyId } = await openFixture(sessions, { peerPid: DEAD_PID, hostPid: DEAD_PID })
      const outcome = await requestDurablePeerOpen(sessions, sessionId, {
        configHome, probeEndpoint: async () => 'present', postOpenTimeoutMs: 40, pollMs: 5,
        launcher: async () => { await writeHostClaim(familyId, { matriarchSessionId: sessionId, pid: DEAD_PID, generation: 4 }); return { ok: true } },
      })
      assert.equal((outcome as { check: string }).check, 'pid-not-alive')
      assert.equal(formatOpenOutcome(outcome), 'failed: pid-not-alive; retry unsafe')
    }

    // pipe-absent: generation advances and pid is alive, but the pipe is not.
    {
      const { sessionId, familyId } = await openFixture(sessions, { peerPid: DEAD_PID, hostPid: DEAD_PID })
      const outcome = await requestDurablePeerOpen(sessions, sessionId, {
        configHome, probeEndpoint: async () => 'absent', postOpenTimeoutMs: 40, pollMs: 5,
        launcher: async () => { await writeHostClaim(familyId, { matriarchSessionId: sessionId, pid: process.pid, generation: 4 }); return { ok: true } },
      })
      assert.equal((outcome as { check: string }).check, 'pipe-absent')
      assert.equal(formatOpenOutcome(outcome), 'failed: pipe-absent; retry unsafe')
    }
  })
})

// ---------------------------------------------------------------------------
// 7. The CAS: a live claim is already-open; a stale-claim race is safe-once
// ---------------------------------------------------------------------------

test('the CAS serialises openers: a live claim means already-open, and a stale-claim race reports claim-stale-raced', async () => {
  await withRegistry(async sessions => {
    const { sessionId, familyId } = await openFixture(sessions, { peerPid: DEAD_PID, hostPid: DEAD_PID })
    const lockPath = leafFamilyPaths(configHome, familyId).openLock

    // A live claim (this process) is not a reason to launch.
    await writeFile(lockPath, JSON.stringify({ sessionId, pid: process.pid, token: 'live', createdAt: new Date().toISOString() }))
    let launched = 0
    const live = await requestDurablePeerOpen(sessions, sessionId, {
      configHome, probeEndpoint: async () => 'absent',
      launcher: async () => { launched += 1; return { ok: true } },
    })
    assert.equal(live.state, 'already-open')
    assert.equal(launched, 0)
    await rm(lockPath, { force: true })

    // A stale claim (dead pid) is replaced, but a competitor that wins the
    // retry makes this opener report the race - safe to retry exactly once.
    await writeFile(lockPath, JSON.stringify({ sessionId, pid: DEAD_PID, token: 'stale', createdAt: new Date(0).toISOString() }))
    const raced = await requestDurablePeerOpen(sessions, sessionId, {
      configHome, probeEndpoint: async () => 'absent',
      launcher: async () => { launched += 1; return { ok: true } },
      onStaleClaimRemoved: async () => {
        await writeFile(lockPath, JSON.stringify({ sessionId: randomUUID(), pid: process.pid, token: 'competitor', createdAt: new Date().toISOString() }))
      },
    })
    assert.equal(raced.state, 'failed')
    assert.equal((raced as { check: string }).check, 'claim-stale-raced')
    assert.equal(formatOpenOutcome(raced), 'failed: claim-stale-raced; retry safe-once')
    assert.equal(launched, 0, 'a lost race never launches')
  })
})

// ---------------------------------------------------------------------------
// 8. A closed durable peer is never "unknown peer" or "not found"
// ---------------------------------------------------------------------------

test('a receipt or read against a closed durable peer says closed, not unknown peer', async () => {
  const sessions = join(configHome, 'gateway-sessions')
  const familyId = randomUUID()
  await writeFamilyRecord(familyId)
  const targetId = randomUUID()
  const target = new GatewaySessionTransport({ directory: sessions, sessionId: targetId, name: 'Durable', cwd: configHome, durable: true, durableFamilyId: familyId })
  await target.start()
  await target.close()

  const sender = new GatewaySessionTransport({ directory: sessions, sessionId: randomUUID(), name: 'Sender', cwd: configHome })
  await sender.start()
  try {
    await assert.rejects(() => sender.receipt(targetId, randomUUID()), /is closed \(durable\)/i)
    await assert.rejects(() => sender.readPeer(targetId), /is closed \(durable\)/i)
  } finally { await sender.close() }
})

// ---------------------------------------------------------------------------
// 8b. The command surface: send renders the queued line, open is wired
// ---------------------------------------------------------------------------

/** Run one command through the real `gateway-peers` skill. */
async function viaSkill(input: string): Promise<string> {
  registerGatewayPeersSkill()
  try {
    const skill = getBundledSkills().find(entry => entry.name === 'gateway-peers') as unknown as {
      getPromptForCommand: (input: string, context: ToolUseContext) => Promise<Array<{ type: string; text?: string }>>
    }
    const result = await skill.getPromptForCommand(input, {} as ToolUseContext)
    return result.map(part => (part.type === 'text' ? String(part.text ?? '') : '')).join('')
  } finally { clearBundledSkills() }
}

test('the skill queues a send to a closed durable peer verbatim and refuses to open a non-durable one', async () => {
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  const sessions = join(configHome, 'gateway-sessions')
  const familyId = randomUUID()
  await writeFamilyRecord(familyId)
  const targetId = randomUUID()
  const target = new GatewaySessionTransport({ directory: sessions, sessionId: targetId, name: 'Durable', cwd: configHome, durable: true, durableFamilyId: familyId })
  await target.start()
  await target.close()

  const { GatewaySessionRuntime } = await import('../src/utils/gatewaySessionRuntime.ts')
  const { getSessionId } = await import('../src/bootstrap/state.ts')
  const runtime = new GatewaySessionRuntime(getSessionId(), configHome, 'Sender')
  await runtime.start(new Set())
  try {
    const text = await viaSkill(`send ${JSON.stringify({ toSessionId: targetId, text: 'hold this', summary: 'hold this' })}`)
    assert.match(
      text,
      new RegExp(`queued: peer ${targetId} is closed; held in ${targetId}\\.mailbox, merged at its next open\\. Request an open with: gateway-peers open ${targetId}`),
      `the closed receipt is the pinned line: ${text}`,
    )
    assert.doesNotMatch(text, /delivered/, 'a queued message is never rendered as delivered')

    // `open` on a non-durable session (this one) is a refusal that spawns nothing.
    const opened = await viaSkill(`open ${getSessionId()}`)
    assert.match(opened, /failed: not-durable; retry unsafe/)
  } finally {
    await runtime.close()
    delete process.env.CLAUDE_CODE_USE_GATEWAY
  }
})

// ---------------------------------------------------------------------------
// 9. Durable identity resolution from the leaf-family index
// ---------------------------------------------------------------------------

test('resolveDurableIdentity marks only the matriarch durable, and prefers a host claim over the legacy alias', async () => {
  const familyId = randomUUID()
  const matriarch = randomUUID()
  const aliasOnly = randomUUID()
  const index = join(configHome, 'leaf-families', 'index')
  await mkdir(index, { recursive: true })
  await writeFamilyRecord(familyId)
  // A host claim names the matriarch.
  await writeFile(join(index, `${familyId}.host.json`), JSON.stringify({ matriarchSessionId: matriarch, pid: DEAD_PID, generation: 1 }))
  // A stale patriarch alias in the same family points at a different session;
  // the host claim must win, so that alias is NOT durable.
  await writeFile(join(index, `${familyId}.json`), JSON.stringify({ rootSessionId: familyId, patriarchSessionId: aliasOnly }))

  assert.deepEqual(await resolveDurableIdentity(matriarch, configHome), { durable: true, familyId })
  assert.deepEqual(await resolveDurableIdentity(aliasOnly, configHome), { durable: false }, 'the host claim wins over the legacy alias')
  assert.deepEqual(await resolveDurableIdentity(randomUUID(), configHome), { durable: false })

  // A legacy family with no host claim at all is still readable via the alias.
  // It is written the way production writes it: the family file is the root's
  // own pointer (`rootSessionId` is the family id) and the family record exists.
  const legacyId = randomUUID()
  const legacyMatriarch = randomUUID()
  await writeFamilyRecord(legacyId)
  await writeFile(join(index, `${legacyId}.json`), JSON.stringify({ rootSessionId: legacyId, patriarchSessionId: legacyMatriarch }))
  assert.deepEqual(await resolveDurableIdentity(legacyMatriarch, configHome), { durable: true, familyId: legacyId })
})

test('a member pointer copy never makes a member durable: the family root is the family', async () => {
  const familyId = randomUUID()
  const matriarch = randomUUID()
  const member = randomUUID()
  const index = join(configHome, 'leaf-families', 'index')
  await mkdir(index, { recursive: true })
  await writeFamilyRecord(familyId)
  // The family's own pointer, as production writes it: the stem IS the root.
  await writeFile(join(index, `${familyId}.json`), JSON.stringify({ rootSessionId: familyId, patriarchSessionId: member }))
  // The host claim names the matriarch; the alias above is stale.
  await writeHostClaim(familyId, { matriarchSessionId: matriarch, pid: DEAD_PID, generation: 3 })
  // The member's own copy. It carries the family's stale alias and its own
  // session id as its filename - the exact shape that used to hand back
  // `member` as a FAMILY id, making the member claim durability for a family
  // that does not exist and letting the next listing tombstone it while alive.
  await writeFile(join(index, `${member}.json`), JSON.stringify({ rootSessionId: familyId, patriarchSessionId: member }))

  assert.deepEqual(await resolveDurableIdentity(matriarch, configHome), { durable: true, familyId })
  assert.deepEqual(await resolveDurableIdentity(member, configHome), { durable: false }, 'a member pointer copy is not the family')
})

test('a claim that names no existing family cannot make a session durable', async () => {
  const familyId = randomUUID()
  const matriarch = randomUUID()
  const index = join(configHome, 'leaf-families', 'index')
  await mkdir(index, { recursive: true })
  await writeHostClaim(familyId, { matriarchSessionId: matriarch, pid: DEAD_PID, generation: 1 })
  await writeFile(join(index, `${familyId}.json`), JSON.stringify({ rootSessionId: familyId, patriarchSessionId: matriarch }))

  // The family record is what makes the id a family. Without it the resolution
  // and the reaper would disagree - resolution says durable, the reaper says
  // the family is gone - and the disagreement is what retired a live session.
  assert.deepEqual(await resolveDurableIdentity(matriarch, configHome), { durable: false })

  await writeFamilyRecord(familyId)
  assert.deepEqual(await resolveDurableIdentity(matriarch, configHome), { durable: true, familyId })
})

// ---------------------------------------------------------------------------
// 10. No autostart
// ---------------------------------------------------------------------------

test('durability never registers an autostart: there is no RunOnce, scheduled task or startup entry', async () => {
  const sources = [
    fileURLToPath(new URL('../src/utils/gatewaySessionDurability.ts', import.meta.url)),
    fileURLToPath(new URL('../src/skills/bundled/gatewayPeers.ts', import.meta.url)),
  ]
  const forbidden = /RunOnce|schtasks|ScheduledTask|CurrentVersion\\+Run|Startup[\\/]|startup folder/i
  for (const path of sources) {
    const source = await readFile(path, 'utf8')
    assert.doesNotMatch(source, forbidden, `${path} must not start sessions automatically`)
  }
  // The only launch path is the explicit `wt.exe -w 0 nt -d <cwd>` tab, whose
  // argv is built by the pure function tested below.
  const durability = await readFile(sources[0]!, 'utf8')
  assert.match(durability, /spawn\('wt\.exe', durableLaunchArgs\(/, 'the launcher is one tab in the current window')
  assert.doesNotMatch(durability, /-w',? ?'new'/, 'never opens a new window')
})

test('durableLaunchArgs pins the model route and always resumes the session', () => {
  const entry = 'C:\\app\\cli.js'
  const cwd = 'C:\\work'
  const sessionId = randomUUID()

  const pinned = durableLaunchArgs({
    entry, cwd, sessionId,
    route: { provider: 'testprov', number: 1, baseUrl: 'http://127.0.0.1:1', model: 'claude-opus-4-6', effort: 'high' },
  })
  assert.deepEqual(pinned, [
    '-w', '0', 'nt', '-d', cwd, '--', entry, '--resume', sessionId, '--model', 'claude-opus-4-6', '--effort', 'high',
  ], 'a route with model and effort pins both')

  const bare = durableLaunchArgs({ entry, cwd, sessionId })
  assert.deepEqual(bare, ['-w', '0', 'nt', '-d', cwd, '--', entry, '--resume', sessionId], 'no route means no pinned flags')
  assert.equal(bare.includes('--model'), false, 'no default model is invented')
  assert.equal(bare.includes('--effort'), false, 'no default effort is invented')

  // A route with neither field still pins neither.
  const routeNoModel = durableLaunchArgs({ entry, cwd, sessionId, route: { provider: 'p', number: 2, baseUrl: 'http://127.0.0.1:1' } })
  assert.deepEqual(routeNoModel, bare)

  // `--resume <id>` is always present, whatever the route carries.
  for (const args of [bare, pinned, durableLaunchArgs({ entry, cwd, sessionId, route: { provider: 'p', number: 2, baseUrl: 'http://127.0.0.1:1', model: 'm' } })]) {
    const at = args.indexOf('--resume')
    assert.ok(at >= 0, '--resume is always present')
    assert.equal(args[at + 1], sessionId, 'it is followed by the session id')
    assert.deepEqual(args.slice(0, 4), ['-w', '0', 'nt', '-d'], 'one tab in the current window')
  }
})

// ---------------------------------------------------------------------------
// The closed row is the exact pinned block
// ---------------------------------------------------------------------------

test('a closed durable row is the exact pinned listing block', () => {
  const sessionId = randomUUID()
  const line = formatGatewayPeerLine({
    status: 'idle', name: 'Durable Name', purpose: '', cwd: 'C:\\work', sessionId,
    durable: true, durableState: 'closed', route: { provider: 'testprov', number: 1, baseUrl: 'http://127.0.0.1:1' },
  } as never)
  const expected = [
    '[closed] Durable Name',
    '    name: Durable Name',
    `    id: ${sessionId}`,
    '    cwd: C:\\work',
    `    durable: closed - no process; mail queues to ${sessionId}.mailbox`,
    '    route: testprov#1 declared, unprobed',
    `    to use: gateway-peers open ${sessionId} | gateway-peers send JSON {"toSessionId":"${sessionId}","text":"...","summary":"..."}`,
  ].join('\n')
  assert.equal(line, expected)
})
