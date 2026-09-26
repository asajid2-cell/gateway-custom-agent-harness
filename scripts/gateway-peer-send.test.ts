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
})
