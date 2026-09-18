/**
 * Live probe for the `gateway:` send route.
 *
 * Sends through the real transport, in a child session that is NOT the peer
 * being addressed (the live session running this would be), so the wire path is
 * exercised end to end rather than asserted from source text.
 *
 * Usage: bun run scripts/gateway-peer-send-live.ts <session-id-or-name> "<text>"
 */
import { randomUUID } from 'crypto'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../src/utils/envUtils.js'
import { GatewaySessionTransport } from '../src/utils/gatewaySessionTransport.js'
import { resolveGatewayPeer } from '../src/utils/gatewayPeerSend.js'

const [target, text] = process.argv.slice(2)
if (!target || !text) {
  console.error('usage: bun run scripts/gateway-peer-send-live.ts <session-id-or-name> "<text>"')
  process.exit(2)
}

const resolved = await resolveGatewayPeer(target)
if ('error' in resolved) {
  console.error('RESOLVE FAILED:', resolved.error)
  process.exit(1)
}
console.log('RESOLVED:', JSON.stringify(resolved))

const directory = join(getClaudeConfigHomeDir(), 'gateway-sessions')
const transport = new GatewaySessionTransport({
  directory,
  sessionId: randomUUID(),
  cwd: process.cwd(),
  name: 'gateway-peer-send-live probe',
  purpose: 'transient probe: verify the gateway: send route reaches a live peer',
})
await transport.start()
try {
  const receipt = await transport.send(resolved.sessionId, text, 'live route probe')
  console.log('RECEIPT:', JSON.stringify(receipt))
  if ((receipt as { ok?: boolean })?.ok === false) process.exitCode = 1
} finally {
  await transport.close()
}
