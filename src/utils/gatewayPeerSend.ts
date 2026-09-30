import { join } from 'path'
import { getSessionId } from '../bootstrap/state.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { gatewaySessionCommsProblem, getGatewaySessionRuntime } from './gatewaySessionRuntime.js'
import { listGatewayPeers } from './gatewaySessionTransport.js'
import { renderTranscriptSlice, type TranscriptSlice } from './transcriptRead.js'
import type { PeerMessageKind } from './gatewaySessionProtocol.js'

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
  // Only a conclusive live set can prove an ID dead. An empty set is not one: it
  // says this machine has no registrations, not that the address is wrong, and a
  // session in another config home would be refused by it. Refusing on that would
  // make addressing by ID as unreliable as addressing by name, so an empty set
  // defers to the transport, which reports the missing session in its own words.
  // A registry that could not be read at all is a different case and never
  // reaches here: the listing throws, and the caller above reports that.
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

export type GatewayPeerReadResult =
  | { ok: true; message: string; cursor: string; slice: TranscriptSlice }
  | { ok: false; message: string }

/**
 * Read what another live session has been doing, without asking it for a turn.
 *
 * The target serves the reply from its own transcript, so this works on a busy,
 * closed or archived peer alike and never disturbs the work it is watching. The
 * reply is peer-authored text, labelled as such, and `since` takes the cursor a
 * previous read returned so following along costs only the turns that are new.
 */
export async function readViaGatewayPeer(
  address: string,
  options: { tail?: number; since?: string } = {},
): Promise<GatewayPeerReadResult> {
  const runtime = getGatewaySessionRuntime(getSessionId())
  if (!runtime) return { ok: false, message: `This session is not registered on the Gateway peer bus, so nothing could be read. Reason: ${gatewaySessionCommsProblem(getSessionId()) ?? 'the peer runtime is not attached to this context'}.` }
  const resolved = await resolveGatewayPeer(address)
  if ('error' in resolved) return { ok: false, message: resolved.error }
  try {
    const slice = await runtime.transport.readPeer(resolved.sessionId, options)
    return { ok: true, cursor: slice.cursor, slice, message: renderTranscriptSlice(slice, resolved.label) }
  } catch (error) {
    const reason = error instanceof Error ? error.message.replace(/\s+/g, ' ').trim().slice(0, 300) : ''
    return { ok: false, message: `Reading ${resolved.label} failed: ${reason || 'transport error'}` }
  }
}

/** Send through the Gateway peer transport, never through the teammate mailbox. */
export async function sendViaGatewayPeer(
  address: string,
  text: string,
  summary: string,
  replyTo?: string,
  kind?: PeerMessageKind,
): Promise<GatewayPeerSendResult> {
  const runtime = getGatewaySessionRuntime(getSessionId())
  if (!runtime) {
    return {
      ok: false,
      message:
        `This session is not registered on the Gateway peer bus, so the message was not sent. Reason: ${gatewaySessionCommsProblem(getSessionId()) ?? 'the peer runtime is not attached to this context'}.`,
    }
  }
  const resolved = await resolveGatewayPeer(address)
  if ('error' in resolved) return { ok: false, message: resolved.error }
  let receipt: any
  try {
    receipt = await runtime.transport.send(resolved.sessionId, text, summary, replyTo, kind)
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
  // Report the kind back, because it changes what the receipt means: a
  // directive is a task the peer is expected to carry out, and reading it as
  // delivered-not-done is what sent senders looking for a second way to hand
  // the work over.
  const delivered = kind === 'directive' ? 'Delivered a directive to' : 'Delivered an inquiry to'
  return {
    ok: true,
    messageId: receipt?.id,
    state: receipt?.state,
    message: `${delivered} ${resolved.label} (${receipt?.state ?? 'unknown'}). queued/held means inbox acceptance; delivered means transcript-persisted, not executed or completed. It reaches them at their next step boundary, so do not re-send because their turn has not finished.`,
  }
}
