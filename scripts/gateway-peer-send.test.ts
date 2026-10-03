import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseAddress } from '../src/utils/peerAddress.ts'
import { GatewaySessionTransport } from '../src/utils/gatewaySessionTransport.ts'

/**
 * The defect: a send to another live session resolved to a teammate name,
 * wrote a mailbox no live session reads, and returned success: true. These pin
 * the two halves that fix - an explicit address scheme, and a route that
 * actually reaches the peer transport.
 */

/** The endpoint a transport advertises for a given runtime, matching the reader's expectation. */
function endpointFor(directory: string, runtimeId: string): string {
  return process.platform === 'win32' ? `\\\\.\\pipe\\gateway-${runtimeId}` : join(directory, `${runtimeId}.sock`)
}

test('the gateway scheme is an address, not a teammate name', () => {
  // A teammate name must keep routing as a teammate.
  assert.equal(parseAddress('researcher').scheme, 'other')
  assert.equal(parseAddress('*').scheme, 'other')
  // The prefix is what turns a peer into a target.
  assert.deepEqual(parseAddress('gateway:abc'), { scheme: 'gateway', target: 'abc' })
  assert.deepEqual(parseAddress('gateway:11111111-1111-4111-8111-111111111111'), {
    scheme: 'gateway',
    target: '11111111-1111-4111-8111-111111111111',
  })
  // A bare session ID is an address too. The roster and every peer message
  // header print it without a prefix, so a sender copies it bare; read as
  // 'other' it fell into the silent-mailbox hole that a teammate name does.
  // The shape is unambiguous - no teammate name and no agent ID is a UUID.
  assert.deepEqual(parseAddress('11111111-1111-4111-8111-111111111111'), {
    scheme: 'gateway',
    target: '11111111-1111-4111-8111-111111111111',
  })
  assert.deepEqual(parseAddress('AABBCCDD-1122-3344-5566-778899AABBCC'), {
    scheme: 'gateway',
    target: 'AABBCCDD-1122-3344-5566-778899AABBCC',
  })
  // A near-miss that is not an ID shape stays a name, so the fallback cannot
  // widen into hijacking teammate names.
  assert.equal(parseAddress('11111111-1111-4111-8111-11111111111').scheme, 'other')
  assert.equal(parseAddress('session_manager').scheme, 'other')
  // The neighbouring schemes still parse, since the order of the checks matters.
  assert.deepEqual(parseAddress('uds:/tmp/x.sock'), { scheme: 'uds', target: '/tmp/x.sock' })
  assert.deepEqual(parseAddress('bridge:session_01'), { scheme: 'bridge', target: 'session_01' })
})

test('an unresolvable name fails loudly instead of reporting a false success', async () => {
  const { resolveGatewayPeer } = await import('../src/utils/gatewayPeerSend.ts')
  // No registry directory exists for this fake config home, so every name is
  // unresolvable. The old path returned success here; the fix must not.
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = `${process.cwd()}/.candidate-build/does-not-exist-${Date.now()}`
  try {
    const result = await resolveGatewayPeer('a-session-that-is-not-live')
    assert.ok('error' in result, 'an unresolvable name must produce an error, not a target')
    assert.match(result.error, /No live session named/)
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
  }
})

test('a session ID resolves even when the registry cannot be consulted', async () => {
  const { resolveGatewayPeer } = await import('../src/utils/gatewayPeerSend.ts')
  // An explicit ID is the address itself; refusing it because the registry is
  // unreadable would make addressing by ID as unreliable as addressing by name.
  // An empty live set is exactly that case - it cannot prove anything is dead.
  const id = '11111111-1111-4111-8111-111111111111'
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = `${process.cwd()}/.candidate-build/does-not-exist-${Date.now()}`
  try {
    assert.deepEqual(await resolveGatewayPeer(id), { sessionId: id, label: id })
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
  }
})

test('a session ID that is not live is refused, not routed onward', async () => {
  const { resolveGatewayPeer } = await import('../src/utils/gatewayPeerSend.ts')
  // The whole point of the check: a registration outlives its session, so an ID
  // that looks well-formed can name a session that exited hours ago. Routing it
  // onward produced "check the receipt before sending a copy" for a peer that
  // can never have received anything.
  const registry = await mkdtemp(join(tmpdir(), 'gateway-peer-resolution-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = registry
  try {
    // A registration file with no listener behind it is precisely the stale
    // case. listGatewayPeers pings and drops it, so the live set is empty of
    // this ID but non-empty overall - conclusive, and therefore a refusal.
    //
    // The directory must be created by the transport: start() is what sets the
    // private ACL that discovery validates, and a hand-made directory fails
    // that check for a reason unrelated to the behavior under test.
    const sessions = join(registry, 'gateway-sessions')
    const live = new GatewaySessionTransport({ directory: sessions, sessionId: randomUUID(), name: 'Live peer', cwd: registry })
    await live.start()
    try {
      const dead = randomUUID()
      const departedRuntime = randomUUID()
      await writeFile(join(sessions, `${dead}.json`), JSON.stringify({
        peer: { ...live.peer, sessionId: dead, runtimeId: departedRuntime, name: 'Departed', endpoint: endpointFor(sessions, departedRuntime) },
        token: 'a'.repeat(64),
      }))
      const result = await resolveGatewayPeer(dead)
      assert.ok('error' in result, 'a stale ID must not resolve to a target')
      assert.match(result.error, /is not live/)
      assert.match(result.error, /Live peer/)
      // And the live peer in the same directory still resolves.
      assert.deepEqual(await resolveGatewayPeer(live.peer.sessionId), { sessionId: live.peer.sessionId, label: live.peer.sessionId })
    } finally {
      await live.close()
    }
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(registry, { recursive: true, force: true })
  }
})

test('a peer that is connected but does not answer a ping is not declared exited', { timeout: 60000 }, async () => {
  const { resolveGatewayPeer } = await import('../src/utils/gatewayPeerSend.ts')
  const { listGatewayPeers } = await import('../src/utils/gatewaySessionTransport.ts')
  const { createServer } = await import('node:net')
  // The reported symptom: a reply the sender had composed was refused with
  // "Session X is not live; it has exited or crashed without deregistering",
  // for a session that was alive the whole time. The cause is in the listing,
  // not the ping: a ping is answered through the transport's own serial chain,
  // so a peer that is mid-request answers late or not at all, and the listing
  // drops it. Resolution then reads the drop as proof of death - even though
  // this file's own rule, written for the deletion path, is that a silent
  // endpoint is not proof of anything.
  //
  // A post-connect failure is the boundary being fixed: the client cannot tell
  // a ping that timed out from a socket that was torn down, and both mean the
  // registration's endpoint exists and accepted the connection. A failure to
  // connect (ENOENT) is the conclusive case, and that stays a refusal - it is
  // pinned by the neighbouring test.
  const registry = await mkdtemp(join(tmpdir(), 'gateway-peer-busy-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = registry
  const sessions = join(registry, 'gateway-sessions')
  const live = new GatewaySessionTransport({ directory: sessions, sessionId: randomUUID(), name: 'Live peer', cwd: registry })
  const busyRuntime = randomUUID()
  const busyId = randomUUID()
  const busyEndpoint = endpointFor(sessions, busyRuntime)
  // Accepts the connection and answers nothing: a stand-in for any peer that is
  // too busy to answer a ping within the client's window.
  const busyServer = createServer(socket => { socket.on('error', () => {}); setTimeout(() => socket.destroy(), 50) })
  try {
    await live.start()
    await new Promise<void>((resolve, reject) => { busyServer.once('error', reject); busyServer.listen(busyEndpoint, resolve) })
    await writeFile(join(sessions, `${busyId}.json`), JSON.stringify({
      peer: { ...live.peer, sessionId: busyId, runtimeId: busyRuntime, name: 'Busy peer', pid: process.pid, endpoint: busyEndpoint },
      token: 'b'.repeat(64),
    }))
    const listed = await listGatewayPeers(sessions)
    assert.ok(listed.some(peer => peer.sessionId === busyId), 'a peer that accepted the connection is still on the bus')
    // Both addresses must keep working, because the model addresses peers by
    // name as readily as by ID and a false refusal is what it acts on.
    assert.deepEqual(await resolveGatewayPeer(busyId), { sessionId: busyId, label: busyId })
    assert.deepEqual(await resolveGatewayPeer('Busy peer'), { sessionId: busyId, label: `Busy peer (${busyId})` })
  } finally {
    await new Promise<void>(resolve => busyServer.close(() => resolve()))
    await live.close()
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(registry, { recursive: true, force: true })
  }
})

test('a registry that cannot be validated is not reported as an empty one', { timeout: 60000 }, async () => {
  const { resolveGatewayPeer } = await import('../src/utils/gatewayPeerSend.ts')
  const { listGatewayPeers } = await import('../src/utils/gatewaySessionTransport.ts')
  const { mkdir, symlink } = await import('node:fs/promises')
  // An empty live set and an unreadable registry are different answers, and the
  // difference is what a sender acts on. The listing used to swallow a failed
  // directory check into [], which resolution reads as "nothing is live" - so a
  // peer that was running was reported as "No live session named X". The check
  // is a PowerShell spawn on Windows, so this is the shape of a transient
  // failure under load, not only of a tampered directory.
  const registry = await mkdtemp(join(tmpdir(), 'gateway-peer-untrusted-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = registry
  const sessions = join(registry, 'gateway-sessions')
  const live = new GatewaySessionTransport({ directory: sessions, sessionId: randomUUID(), name: 'Live peer', cwd: registry })
  try {
    await live.start()
    // A junction is a directory link an unprivileged user can create, and it is
    // what the check refuses: readdir follows it, so the registry looks readable
    // while nothing about it can be trusted.
    const home = join(registry, 'linked-home')
    await mkdir(home)
    await symlink(sessions, join(home, 'gateway-sessions'), 'junction')
    process.env.CLAUDE_CONFIG_DIR = home
    await assert.rejects(listGatewayPeers(join(home, 'gateway-sessions')), /Invalid session directory/)
    const byName = await resolveGatewayPeer('Live peer')
    assert.ok('error' in byName, 'an unreadable registry must not resolve a name')
    assert.match(byName.error, /Could not read the live session registry/)
    assert.doesNotMatch(byName.error, /No live session named/)
  } finally {
    await live.close()
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(registry, { recursive: true, force: true })
  }
})

test('a trusted registry replaced by a link is immediately refused', { timeout: 60000 }, async () => {
  const { listGatewayPeers } = await import('../src/utils/gatewaySessionTransport.ts')
  const { rename, symlink } = await import('node:fs/promises')
  // Cached ACL checks must not let a replacement link inherit the old directory's trust.
  const registry = await mkdtemp(join(tmpdir(), 'gateway-peer-trusted-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = registry
  const sessions = join(registry, 'gateway-sessions')
  const real = join(registry, 'real-sessions')
  const seed = new GatewaySessionTransport({ directory: sessions, sessionId: randomUUID(), name: 'Seed', cwd: registry })
  try {
    await seed.start()
    assert.equal((await listGatewayPeers(sessions)).length, 1)
    await rename(sessions, real)
    await symlink(real, sessions, 'junction')
    await assert.rejects(listGatewayPeers(sessions), /Invalid session directory/)
    await rm(sessions)
    await rename(real, sessions)
  } finally {
    await seed.close()
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(registry, { recursive: true, force: true })
  }
})

test('a listing is bounded by one probe, not by the sum of them', { timeout: 60000 }, async () => {
  const { listGatewayPeers } = await import('../src/utils/gatewaySessionTransport.ts')
  const { createServer } = await import('node:net')
  // A listing is on the path of every send and every panel refresh, so its cost
  // is a cost the user pays constantly. Probing one registration at a time made
  // that cost the sum of every probe, so a single hung endpoint - a frozen
  // process, a foreign pipe - stalled the whole registry for its whole timeout
  // before anyone else could be discovered. Waiting on the probes together
  // bounds the listing by the slowest one.
  const registry = await mkdtemp(join(tmpdir(), 'gateway-peer-listing-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = registry
  const sessions = join(registry, 'gateway-sessions')
  const seed = new GatewaySessionTransport({ directory: sessions, sessionId: randomUUID(), name: 'Seed', cwd: registry })
  const hung: Array<{ close: () => Promise<void> }> = []
  try {
    // Creates the directory with the private ACL the listing validates.
    await seed.start()
    const ids: string[] = []
    for (let index = 0; index < 3; index++) {
      const runtimeId = randomUUID()
      const sessionId = randomUUID()
      const endpoint = endpointFor(sessions, runtimeId)
      // Accepts and never answers, so each probe runs to its own timeout. The
      // accepted sockets are held so cleanup can end them: a server does not
      // close while a connection to it is open, and a server that never writes
      // never ends one, so closing without this waits forever on the very
      // silence the test is built from.
      const sockets = new Set<{ destroy: () => void }>()
      const server = createServer(socket => {
        socket.on('error', () => {})
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
      })
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve) })
      hung.push({ close: () => new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()) }) })
      await writeFile(join(sessions, `${sessionId}.json`), JSON.stringify({
        peer: { ...seed.peer, sessionId, runtimeId, name: `Hung ${index}`, pid: process.pid, endpoint },
        token: 'd'.repeat(64),
      }))
      ids.push(sessionId)
    }
    const started = Date.now()
    const listed = await listGatewayPeers(sessions)
    const elapsed = Date.now() - started
    for (const id of ids) assert.ok(listed.some(peer => peer.sessionId === id), 'a peer that accepted the connection is still on the bus')
    // One probe timeout is 5s; three probed in turn would be 15s. The bound is
    // loose enough for a loaded machine and still well inside the sum.
    assert.ok(elapsed < 10_000, `three hung endpoints cost one probe, not three: ${elapsed}ms`)
  } finally {
    for (const server of hung) await server.close()
    await seed.close()
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(registry, { recursive: true, force: true })
  }
})

test('a peer send is not refused for carrying model or effort', async () => {
  const { SendMessageTool } = await import('../src/tools/SendMessageTool/SendMessageTool.ts')
  const { getDefaultAppState } = await import('../src/state/AppState.tsx')
  // No runtime is registered in this process, so the peer route fails - but it
  // fails for its own reason. The defect was that the local-subagent override
  // check ran first and answered a gateway: address with "only supported when
  // resuming a local subagent", which a sender can only read as "retry with the
  // same fields", so the identical message went out again and again.
  const context = { getAppState: () => getDefaultAppState() }
  for (const overrides of [{ model: 'gateway-gpt-luna' }, { effort: 'none' as const }, { model: '', effort: 'medium' as const }]) {
    const result = await SendMessageTool.call(
      { to: 'gateway:a-session-that-is-not-live', message: 'Continue the task', summary: 'Continue', ...overrides },
      context,
      async () => ({ behavior: 'deny' }),
    )
    assert.equal(result.data.success, false)
    assert.doesNotMatch(result.data.message, /only supported when resuming a local subagent/)
    assert.match(result.data.message, /Gateway peer bus|No live session named/)
  }
  // The local rule still holds where it applies: a teammate name is this
  // process's own routing, so an override on a name that is not a local
  // subagent is refused exactly as before.
  const local = await SendMessageTool.call(
    { to: 'a-teammate-that-does-not-exist', message: 'Continue', summary: 'Continue', model: 'gateway-gpt-luna' },
    context,
    async () => ({ behavior: 'deny' }),
  )
  assert.equal(local.data.success, false)
  assert.match(local.data.message, /only supported when resuming a local subagent/)
})

test('a bare session ID cannot be swallowed by a teammate mailbox', async () => {
  const { SendMessageTool } = await import('../src/tools/SendMessageTool/SendMessageTool.ts')
  const { getDefaultAppState } = await import('../src/state/AppState.tsx')
  // The proven defect: a bare UUID target parsed as 'other', so it fell through
  // to teammate routing, wrote ~/.claude/teams/<team>/inboxes/<uuid>.json that
  // no live session reads, and returned success: true. A sender saw an ack and
  // believed the peer had the message. The address shape must reach the peer
  // transport instead, where a target that is not live is a refusal.
  const result = await SendMessageTool.call(
    { to: '00000000-0000-4000-8000-000000000abc', message: 'Are you there?', summary: 'Routing probe' },
    { getAppState: () => getDefaultAppState() },
    async () => ({ behavior: 'deny' }),
  )
  assert.equal(result.data.success, false, JSON.stringify(result.data))
  assert.match(result.data.message, /Gateway peer bus|is not live|No live session named/)
  assert.doesNotMatch(result.data.message, /'s inbox/)
})

test('a reply sent through SendMessage carries the id it answers, so the request retires', { timeout: 60000 }, async () => {
  const { SendMessageTool } = await import('../src/tools/SendMessageTool/SendMessageTool.ts')
  const { getDefaultAppState } = await import('../src/state/AppState.tsx')
  const { GatewaySessionRuntime } = await import('../src/utils/gatewaySessionRuntime.ts')
  const { getSessionId } = await import('../src/bootstrap/state.ts')
  // The tool hard-coded replyTo to undefined, so a session answering a peer
  // through SendMessage produced a reply the sender could not correlate: the
  // request stayed in outstandingReplies() and was raised again at the next turn
  // boundary. That is a reply that reads as never arriving, which is how the
  // "reply just failed" report looks from the sender's side.
  const home = await mkdtemp(join(tmpdir(), 'gateway-peer-reply-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  const previousGateway = process.env.CLAUDE_CODE_USE_GATEWAY
  process.env.CLAUDE_CONFIG_DIR = home
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  const receiver = new GatewaySessionRuntime(randomUUID(), home, 'Requester')
  // The sender must itself be on the bus: the route refuses a session that is
  // not registered rather than writing a mailbox nobody reads, which is why a
  // real reply has a live runtime behind it.
  const sender = new GatewaySessionRuntime(getSessionId(), home, 'Responder')
  try {
    await sender.start(new Set())
    await receiver.start(new Set())
    await receiver.setPolicy('accept')
    const requestId = randomUUID()
    const result = await SendMessageTool.call(
      { to: `gateway:${receiver.transport.peer.sessionId}`, message: 'The parser review is done.', summary: 'Review done', replyTo: requestId },
      { getAppState: () => getDefaultAppState() },
      async () => ({ behavior: 'deny' }),
    )
    assert.equal(result.data.success, true, result.data.message)
    const arrived = receiver.transport.inbox().find(record => record.message.text === 'The parser review is done.')
    assert.equal(arrived?.message.replyTo, requestId)
  } finally {
    await sender.close()
    await receiver.close()
    const { runCleanupFunctions } = await import('../src/utils/cleanupRegistry.ts')
    await runCleanupFunctions()
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    if (previousGateway === undefined) delete process.env.CLAUDE_CODE_USE_GATEWAY
    else process.env.CLAUDE_CODE_USE_GATEWAY = previousGateway
    await rm(home, { recursive: true, force: true })
  }
})

test('SendMessage routes the gateway scheme through the peer transport, not the mailbox', async () => {
  const tool = await readFile(new URL('../src/tools/SendMessageTool/SendMessageTool.ts', import.meta.url), 'utf8')
  assert.match(tool, /addr\.scheme === 'gateway'/)
  assert.match(tool, /sendViaGatewayPeer/)
  // The override guard must be scoped to the local scheme. Unscoped, it refused
  // the send before the address was parsed, so no peer message that carried
  // model or effort ever reached this route.
  assert.match(tool, /parseAddress\(input\.to\)\.scheme === 'other' &&/)
  // The route must not sit behind a feature gate: feature() is stubbed to false
  // at build time, which is how the only cross-process path disappears from the
  // shipped bundle.
  const route = tool.slice(tool.indexOf("addr.scheme === 'gateway'") - 900, tool.indexOf("addr.scheme === 'gateway'"))
  assert.doesNotMatch(route, /feature\('UDS_INBOX'\) &&/)
  const prompt = await readFile(new URL('../src/tools/SendMessageTool/prompt.ts', import.meta.url), 'utf8')
  assert.match(prompt, /gatewayRow/)
  // The addressing rule the model needs, unconditional rather than in the
  // feature-gated UDS section.
  assert.doesNotMatch(prompt, /const gatewayRow = feature\(/)
  // The kind decides whether the receiver does the work or answers a question,
  // so it has to reach the transport rather than being a schema field the tool
  // accepts and drops.
  assert.match(tool, /kind: z\.enum\(PEER_MESSAGE_KINDS\)/)
  assert.match(tool, /input\.kind,/)
  // A reply has to be able to name the message it answers through this tool too,
  // not only through the skill.
  assert.match(tool, /replyTo: z\.string\(\)\.optional\(\)/)
  assert.match(tool, /input\.replyTo,/)
  assert.match(prompt, /hands it work to carry out/)
  assert.match(prompt, /asks a question or shares information and asks only for an answer/)
  // The loop the user hit was not one message but the same message sent again:
  // a session recruited a second session to carry an instruction to a third,
  // and both nudged the target until the nudges were the traffic. The rule that
  // stops it is about addressing and repetition, and it has to be in the prompt
  // the model reads rather than only in the transport that reports the refusal.
  assert.match(prompt, /Send to the sessions your user named, and only those/)
  assert.match(prompt, /is a locator, not an addressee/)
  assert.match(prompt, /do not send to the session you found it through at all/)
  assert.match(prompt, /Do not hand the same task to two sessions/)
  assert.match(prompt, /do not recruit one session to carry an instruction to another/)
  assert.match(prompt, /say so to your user rather than routing it through a third party/)
  assert.match(prompt, /the identical message sent again is refused the same way/)
  // The rule has to be in the skill as well as the tool. The sends that produced
  // the user-visible incident came from the skill, not SendMessage - the tool was
  // refusing them for carrying model and effort - so a rule that lives only in
  // the tool's prompt did not reach the path that was actually used.
  const skill = await readFile(new URL('../src/skills/bundled/gatewayPeers.ts', import.meta.url), 'utf8')
  assert.match(skill, /is a locator, not an addressee/)
  assert.match(skill, /never to the session you found it through, not even to pass a note about its own leaf/)
  assert.match(skill, /do not recruit one session to carry an instruction to another/)
  assert.match(skill, /replyTo\?,kind\?/)
})
