import { join } from 'path'
import { getSessionId } from '../bootstrap/state.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { getGatewaySessionRuntime } from './gatewaySessionRuntime.js'
import { listGatewayPeers } from './gatewaySessionTransport.js'

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type GatewayPeerSendResult = {
  ok: boolean
  /** The result line a caller shows the model. */
  message: string
  /** Set when the peer accepted the message, so the caller can echo the ID. */
  messageId?: string
  state?: string
}

/**
 * Resolve an address to a live Gateway session.
 *
 * A session ID is exact; a name is matched against the advertised name, and an
 * ambiguous name is refused rather than guessed. Refusing matters more than
 * picking: the previous behaviour silently accepted any unresolved name and
 * reported success, which is how a message could be "delivered" into a mailbox
 * no live session reads.
 */
export async function resolveGatewayPeer(
  address: string,
): Promise<{ sessionId: string; label: string } | { error: string }> {
  let peers
  try {
    const directory = join(getClaudeConfigHomeDir(), 'gateway-sessions')
    peers = await listGatewayPeers(directory)
  } catch {
    return { error: 'Could not read the live session registry.' }
  }
  // A session ID is exact, but exact is not the same as live. Registration
  // files outlive the sessions that wrote them - most of the ones on this
  // machine ping dead - so addressing one by ID used to sail past discovery and
  // fail later as an ambiguous transport error. Discovery has already pinged
  // every candidate, so checking membership costs nothing extra.
  //
  // Only a conclusive live set can prove an ID dead. An empty set means the
  // registry could not be consulted (no directory, failed directory check), and
  // refusing on that would make addressing by ID as unreliable as addressing by
  // name - so an empty set defers to the transport, which reports the missing
  // session in its own words.
  if (SESSION_ID_PATTERN.test(address)) {
    if (peers.length === 0 || peers.some(peer => peer.sessionId === address)) return { sessionId: address, label: address }
    const available = peers.map(peer => `"${peer.name}" (${peer.sessionId})`)
    return {
      error: `Session ${address} is not live; it has exited or crashed without deregistering, and its stale registration is still on disk. Live sessions: ${available.join(', ')}. Use /sessions list.`,
    }
  }
  const matches = peers.filter(peer => peer.name === address)
  if (matches.length === 1) {
    return { sessionId: matches[0]!.sessionId, label: `${matches[0]!.name} (${matches[0]!.sessionId})` }
  }
  if (matches.length > 1) {
    return { error: `"${address}" matches ${matches.length} live sessions; address it by session ID: ${matches.map(peer => peer.sessionId).join(', ')}` }
  }
  const idle = peers.filter(peer => peer.name.toLowerCase() === address.toLowerCase())
  if (idle.length === 1) {
    return { sessionId: idle[0]!.sessionId, label: `${idle[0]!.name} (${idle[0]!.sessionId})` }
  }
  const available = peers.map(peer => `"${peer.name}" (${peer.sessionId})`)
  return {
    error: `No live session named "${address}". ${available.length ? `Live sessions: ${available.join(', ')}.` : 'No other live sessions are registered.'} Use /sessions list, or address a session by its ID.`,
  }
}

/** Send through the Gateway peer transport, never through the teammate mailbox. */
export async function sendViaGatewayPeer(
  address: string,
  text: string,
  summary: string,
  replyTo?: string,
): Promise<GatewayPeerSendResult> {
  const runtime = getGatewaySessionRuntime(getSessionId())
  if (!runtime) {
    return {
      ok: false,
      message:
        'This session is not registered on the Gateway peer bus, so the message was not sent. Check /sessions list.',
    }
  }
  const resolved = await resolveGatewayPeer(address)
  if ('error' in resolved) return { ok: false, message: resolved.error }
  let receipt: any
  try {
    receipt = await runtime.transport.send(resolved.sessionId, text, summary, replyTo)
  } catch (error) {
    const reason = error instanceof Error ? error.message.replace(/\s+/g, ' ').trim().slice(0, 300) : ''
    return { ok: false, message: `Delivery to ${resolved.label} failed: ${reason || 'transport error'}` }
  }
  if (receipt?.ok === false) {
    return {
      ok: false,
      message: `Delivery to ${resolved.label} was refused: ${String(receipt.reason ?? 'refused').slice(0, 300)}`,
      messageId: receipt.id,
      state: receipt.state,
    }
  }
  return {
    ok: true,
    messageId: receipt?.id,
    state: receipt?.state,
    message: `Delivered to ${resolved.label} (${receipt?.state ?? 'unknown'}). queued/held means inbox acceptance; delivered means transcript-persisted, not executed or completed. It reaches them at their next step boundary, so do not re-send because their turn has not finished.`,
  }
}
