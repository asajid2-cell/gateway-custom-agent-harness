import { join } from 'path'
import { getSessionId } from '../bootstrap/state.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { SESSION_ID_PATTERN, SESSION_ID_PREFIX_PATTERN } from './peerAddress.js'
import { gatewaySessionCommsProblem, getGatewaySessionRuntime } from './gatewaySessionRuntime.js'
import { listGatewayPeers } from './gatewaySessionTransport.js'
import { renderTranscriptSlice, type TranscriptSlice } from './transcriptRead.js'
import type { PeerMessageKind } from './gatewaySessionProtocol.js'

export type GatewayPeerSendResult = {
  ok: boolean
  /** The result line a caller shows the model. */
  message: string
  /** Set when the peer accepted the message, so the caller can echo the ID. */
  messageId?: string
  state?: string
}

/**
 * The label a resolved peer is echoed back under.
 *
 * A name alone is not an identity: names are built from the family-local leaf
 * index, so "Leaf 5" and "Leaf 9" each name two different live sessions on this
 * machine. A coordinator reading a name back cannot tell which one it reached,
 * which is how a directive went to the wrong lane. Always carrying the session
 * ID - and the family root, when the registration names one - makes the echo an
 * identity rather than a label that happens to collide.
 */
function describePeer(peer: { sessionId: string; name: string; topics?: string[] }): string {
  return `${peer.name} (${peer.sessionId})`
}

/**
 * The build a peer is running relative to this one, when that is knowable.
 *
 * A live session answers the behaviour it loaded, and the dist rebuilds on
 * launch, so two sessions can differ in what they do with nothing on the wire
 * saying so. This is what turns "does that session have the fix?" into a fact
 * about its registration rather than an assumption. A peer with no buildId is
 * UNKNOWN - an older build predates the field - and is said to be unknown rather
 * than assumed old, because a guess here is what a stale ledger turns into.
 */
export function buildNote(peerBuildId: string | undefined): string {
  const own = typeof MACRO !== 'undefined' && MACRO.BUILD_TIME ? MACRO.BUILD_TIME : undefined
  if (!peerBuildId) return ''
  if (!own) return ` It is running build ${peerBuildId}.`
  if (peerBuildId === own) return ''
  const older = peerBuildId < own
  return older
    ? ` It is running an older build than this session (${peerBuildId}); a behaviour added since it started may not be live there.`
    : ` It is running a newer build than this session (${peerBuildId}).`
}

/**
 * The build note for a resolved peer, or an empty string when it is the same
 * build or unknowable. Read from the live registration at send time, so a peer
 * that restarted onto a new build between two sends is reported correctly.
 */
export async function peerBuildNote(sessionId: string): Promise<string> {
  try {
    const peers = await listGatewayPeers(join(getClaudeConfigHomeDir(), 'gateway-sessions'))
    const found = peers.find(peer => peer.sessionId === sessionId)
    return buildNote(found?.buildId)
  } catch {
    return ''
  }
}

/**
 * The live members of a dead reference's family, named so the sender can reach
 * one.
 *
 * A reference that names a leaf ("Leaf 5: box") usually resolves as a family
 * address, so what a sender needs when it is refused is not the machine's whole
 * live list - which can be twenty sessions across unrelated families - but the
 * members of the family the reference named, since one of those is almost always
 * what the sender meant. Only members that are live are offered, because
 * offering a closed one is the same wrong-mailbox failure at a smaller scale.
 *
 * Best-effort by design: resolving a leaf reference needs the family registry,
 * which a session outside the family cannot always read, so a failure here
 * degrades to the caller's own live list rather than blocking the refusal.
 */
async function liveFamilyMembers(reference: string, peers: readonly { sessionId: string; name: string }[]): Promise<string> {
  try {
    const { resolveLeafRef, listLeafMembers } = await import('./leafWorkspace.js')
    // The reference resolves the family (a member row, by id or label), and the
    // family's own roster is what says which of its members are live. Matching
    // the live set against the roster rather than against the one resolved
    // member keeps a member that is not itself live from being offered.
    if (!(await resolveLeafRef(reference))) return ''
    const family = await listLeafMembers()
    const memberIds = new Set(family.map(member => member.sessionId))
    const live = peers.filter(peer => memberIds.has(peer.sessionId))
    if (live.length === 0) return ''
    return ` The family's live members: ${live.map(peer => `${peer.name} (${peer.sessionId})`).join(', ')}.`
  } catch {
    return ''
  }
}

/** A name that matched more than one live session, with each candidate's stable id. */
function ambiguousNameError(address: string, matches: Array<{ sessionId: string; name: string }>): string {
  const candidates = matches.map(peer => `${peer.name} (${peer.sessionId})`)
  return `"${address}" matches ${matches.length} live sessions; a name is not an identity here, so address it by session ID: ${candidates.join(', ')}.`
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
      error: `Session ${address} is not live; it has exited or crashed without deregistering, and its stale registration is still on disk. Live sessions: ${available.join(', ')}.${await liveFamilyMembers(address, peers)} Use /sessions list.`,
    }
  }
  // A truncated ID is an address the sender pasted short, not a name. Expanding
  // it to the one live session it names keeps a short address from being a
  // silent drop; an ambiguous or unmatched prefix is refused rather than
  // guessed, because guessing is the same wrong-recipient failure as a mailbox
  // nobody reads. Unlike an exact ID, an empty live set cannot resolve a prefix
  // (the transport cannot expand one), so it is a refusal that names the fix.
  if (SESSION_ID_PREFIX_PATTERN.test(address)) {
    const prefix = address.toLowerCase()
    const live = peers.filter(peer => peer.sessionId.toLowerCase().startsWith(prefix))
    if (live.length === 1) {
      return { sessionId: live[0]!.sessionId, label: describePeer(live[0]!) }
    }
    if (live.length > 1) {
      return {
        error: `Session id "${address}" is a truncated ID and matches ${live.length} live sessions; address it by the full ID: ${live.map(peer => peer.sessionId).join(', ')}.`,
      }
    }
    const available = peers.map(peer => `"${peer.name}" (${peer.sessionId})`)
    return {
      error: `Session id "${address}" is a truncated ID and matches no live session. ${available.length ? `Live sessions: ${available.join(', ')}.` : 'No other live sessions are registered.'}${await liveFamilyMembers(address, peers)} Use /sessions list, or address a session by its full ID.`,
    }
  }
  const matches = peers.filter(peer => peer.name === address)
  if (matches.length === 1) {
    return { sessionId: matches[0]!.sessionId, label: describePeer(matches[0]!) }
  }
  if (matches.length > 1) {
    return { error: ambiguousNameError(address, matches) }
  }
  const idle = peers.filter(peer => peer.name.toLowerCase() === address.toLowerCase())
  if (idle.length === 1) {
    return { sessionId: idle[0]!.sessionId, label: describePeer(idle[0]!) }
  }
  // A case-insensitive match is still a name match, so ambiguity refuses here
  // too. Without this, two sessions whose names differ only in case fell past
  // every branch into "No live session named" - a false statement about a name
  // that plainly matched, which reads as the bus being broken rather than the
  // address being ambiguous.
  if (idle.length > 1) {
    return { error: ambiguousNameError(address, idle) }
  }
  const available = peers.map(peer => `"${peer.name}" (${peer.sessionId})`)
  return {
    error: `No live session named "${address}". ${available.length ? `Live sessions: ${available.join(', ')}.` : 'No other live sessions are registered.'}${await liveFamilyMembers(address, peers)} Use /sessions list, or address a session by its ID.`,
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
    return { ok: true, cursor: slice.cursor, slice, message: renderTranscriptSlice(slice, resolved.label) + await peerBuildNote(resolved.sessionId) }
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
  expectReply?: boolean,
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
    receipt = await runtime.transport.send(resolved.sessionId, text, summary, replyTo, kind, expectReply)
  } catch (error) {
    const reason = error instanceof Error ? error.message.replace(/\s+/g, ' ').trim().slice(0, 300) : ''
    return { ok: false, message: `Delivery to ${resolved.label} failed: ${reason || 'transport error'}` }
  }
  if (receipt?.ok === false) {
    return {
      ok: false,
      message: `Delivery to ${resolved.label} was refused: ${String(receipt.reason ?? 'refused').slice(0, 300)}${await peerBuildNote(resolved.sessionId)}`,
      messageId: receipt.id,
      state: receipt.state,
    }
  }
  // Success is a claim about a receipt, so it needs one. A transport that
  // returned nothing, or a receipt with no id or an unrecognised state, leaves
  // delivery unproven - reporting ok there is the same silent success a mailbox
  // write used to be, and a sender who reads it stops looking for the message
  // that never arrived.
  const SETTLED_STATES = ['queued', 'held', 'delivered']
  const state = receipt?.state
  if (!receipt || typeof receipt.id !== 'string' || !SETTLED_STATES.includes(state)) {
    return {
      ok: false,
      messageId: typeof receipt?.id === 'string' ? receipt.id : undefined,
      state,
      message: `Delivery to ${resolved.label} is unconfirmed: the transport returned no receipt${state ? ` (state "${String(state)}")` : ''}. Do NOT assume delivery; check \`receipt\` or \`history\` before re-sending.`,
    }
  }
  // Report the kind back, because it changes what the receipt means: a
  // directive is a task the peer is expected to carry out, and reading it as
  // delivered-not-done is what sent senders looking for a second way to hand
  // the work over.
  const delivered = kind === 'directive' ? 'Delivered a directive to' : 'Delivered an inquiry to'
  return {
    ok: true,
    messageId: receipt.id,
    state,
    message: `${delivered} ${resolved.label} (${state}). queued/held means inbox acceptance; delivered means transcript-persisted, not executed or completed. It reaches them at their next step boundary, so do not re-send because their turn has not finished.${await peerBuildNote(resolved.sessionId)}`,
  }
}
