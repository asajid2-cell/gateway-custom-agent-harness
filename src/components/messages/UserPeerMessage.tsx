import * as React from 'react'
import { INJECTED_ARROW } from '../../constants/figures.js'
import { Box, Text } from '../../ink.js'
import { parseGatewayPeerText } from '../../utils/gatewaySessionProtocol.js'
import { MessageResponse } from '../MessageResponse.js'

type Props = {
  addMargin: boolean
  text: string
  isTranscriptMode?: boolean
}

/**
 * How much of a peer body to mount. The same reasoning as UserPromptMessage's
 * display cap: Ink's output pass walks the whole mounted text on every frame, so
 * a 64KB body (the protocol's ceiling) costs keystroke latency for as long as it
 * stays on screen. A peer body is read once and answered by the model, so the
 * opening lines carry the request and the transcript view has the rest.
 */
const MAX_BODY_CHARS = 1500

function clipBody(body: string, expanded: boolean): string {
  if (expanded || body.length <= MAX_BODY_CHARS) return body
  const head = body.slice(0, MAX_BODY_CHARS)
  const boundary = head.lastIndexOf('\n')
  const clipped = boundary > MAX_BODY_CHARS / 2 ? head.slice(0, boundary) : head
  const hidden = body.slice(clipped.length).split('\n').length
  return `${clipped}\n… +${hidden} more lines (full text in transcript view)`
}

function shortId(sessionId: string): string {
  return sessionId.slice(0, 8)
}

/**
 * Text another session sent, rendered as a peer rather than as a prompt.
 *
 * The text arrives through several channels - a queued command consumed as a
 * turn input, a Stop hook's injected feedback, an attachment on a busy turn -
 * and every one of them delivered a string with no room for an origin field.
 * Rendering it as a user prompt therefore made a peer request indistinguishable
 * from something the operator typed, with the user-message background to match.
 * The peer header is the marker: it states who sent it and that it is not the
 * user, and the body is shown as the sender's content rather than as input.
 *
 * Exported for testing.
 */
export function UserPeerMessage({ addMargin, text, isTranscriptMode }: Props): React.ReactNode {
  const peer = parseGatewayPeerText(text)
  // A leaf's report travels the same renderer but is not a bus request, so it
  // does not borrow the request/reply vocabulary: "Message from another session
  // from api hardening" would say it twice.
  const heading = peer?.leaf ? 'Session message' : peer ? (peer.reply ? 'Peer reply' : 'Peer request') : 'Peer message'
  const name = peer?.peerName.trim()
  const body = peer ? clipBody(peer.body, isTranscriptMode === true) : clipBody(text, isTranscriptMode === true)
  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
      <Text>
        <Text color="suggestion">{INJECTED_ARROW}</Text>{' '}
        <Text dimColor>{heading}</Text>
        {name ? <Text>{' from '}<Text bold>{name}</Text></Text> : null}
        {peer?.peerId ? <Text dimColor>{` (session ${shortId(peer.peerId)})`}</Text> : null}
      </Text>
      <MessageResponse>
        <Box flexDirection="column">
          <Text>{body}</Text>
          {peer?.replyHint ? <Text dimColor>{peer.replyHint}</Text> : null}
        </Box>
      </MessageResponse>
    </Box>
  )
}
