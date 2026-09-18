import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { parseAddress } from '../src/utils/peerAddress.ts'

/**
 * The defect: a send to another live session resolved to a teammate name,
 * wrote a mailbox no live session reads, and returned success: true. These pin
 * the two halves that fix - an explicit address scheme, and a route that
 * actually reaches the peer transport.
 */

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

test('a session ID resolves without consulting the registry', async () => {
  const { resolveGatewayPeer } = await import('../src/utils/gatewayPeerSend.ts')
  // An explicit ID is the address itself; refusing it because the registry is
  // unreadable would make addressing by ID as unreliable as addressing by name.
  const id = '11111111-1111-4111-8111-111111111111'
  assert.deepEqual(await resolveGatewayPeer(id), { sessionId: id, label: id })
})

test('SendMessage routes the gateway scheme through the peer transport, not the mailbox', async () => {
  const tool = await readFile(new URL('../src/tools/SendMessageTool/SendMessageTool.ts', import.meta.url), 'utf8')
  assert.match(tool, /addr\.scheme === 'gateway'/)
  assert.match(tool, /sendViaGatewayPeer/)
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
