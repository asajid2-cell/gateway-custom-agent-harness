/**
 * Which turns create an obligation.
 *
 * An obligation is a commitment the record must carry: a decision that settles
 * something, a handoff that moves work to an owner, an artifact a later claim
 * may rest on, or a correction that revises what was believed. Everything else
 * - acknowledgements, status reports, hypotheses, open questions - is
 * conversation. A question is deliberately not an obligation: the answer is,
 * and recording the question would fill the journal with things nobody owed.
 *
 * This is a lexicon by necessity, so the rules below are written as definitions
 * with their reason, not as regexes that happen to fit a table. The predicate
 * fixture (`scripts/fixtures/obligation-predicates.jsonl`, owned by the spec
 * side) is the oracle: when a row disagrees, the disagreement is reported and
 * the row is not edited to match the code.
 *
 * Two rows in the fixture carry a `context_turn` and are undecidable without
 * it. The detector takes the preceding turn; a bare "hold" with no context is
 * ambiguous and must not be counted.
 */

export type EligibleActionKind = 'decision' | 'handoff' | 'external_evidence' | 'correction'

export type EligibleActionTurn = {
  text: string
  source?: 'user' | 'peer'
  /** The turn this one answers, when the excerpt alone cannot decide it. */
  context?: string
}

export type EligibleActionVerdict = {
  eligible: boolean
  kind: EligibleActionKind | 'question' | null
  reason: string
}

const NO_ACTION =
  /\b(no (reply|response|action|acknowledg\w*) (is )?(needed|required)|(do not|don't) (reply|respond|send|acknowledge)|informational only|for your information only)\b/
const STATUS_REPORT = /\b(status report|status update|for your information|fyi)\b/
const ACK = /^(thanks|thank you|thx|ty|ok|okay|ok noted|noted|got it|received|ack|acknowledged|understood)\b[\s.!]*$/
const HEDGE = /\b(i think|probably|maybe|i guess|perhaps|it seems|seems like|might be|may be)\b/
// A question about the state of an artifact is answered from the file; it is
// not a question event. "How is the ledger going" is status, not evidence.
const STATE_QUESTION = /\bhow('s| is| are)\b.*\b(going|doing|looking)\b|\bany updates?\b|\bstatus\?/
const REQUEST_AS_QUESTION = /\b(can|could|would|will) you\b/
const WORK_VERB =
  /\b(check|checking|look|send|add|fix|open|run|verify|review|write|tell|make|route|build|read|test|update|push|merge|deploy|install)\b/
const INTERROGATIVE_START = /^(what|why|how|when|where|who|which|should|do|does|did|is|are|was|were|can|could|would|will|am)\b/
const STOP_ONLY = /^(hold|stop|wait|pause|freeze)\b[\s.!]*$/
const AFFIRM_START = /^(ok|okay|alright|yes|yep|sure|go|agreed)\b/
const CORRECTION =
  /\b(actually|withdrawn|withdrawing|correction|my [^.]{0,80} was wrong|that('s| is) wrong|incorrect|mistaken|not \w+[ ,]+(but|it is|it's))\b/
const EVIDENCE =
  /\b(measured|median|p90|p50|percentile|returned|status code|exit code|counted|benchmark|readback)\b|\bhttp \d{3}\b|\bn=\d+\b|\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}\b|:(20\d{2})\b/
const HANDOFF =
  /\b(route (this|it) to|tell (it|them|him|her|\w+) to|directed [\w ]{1,40} to|hand(ed|ing)? (this|it) (off|to)|take over|you (take|own|handle|pick)|assign(ed)? [\w ]{1,40} to|go (to|build|make))\b/
const DECISION =
  /\b(going with|go with|we'?re going|let'?s go|i rule|ruled|approved|approve|settled|ship it|is fine|not needed now|go ahead|do it|build it|the call is)\b/
export function eligibleActions(turn: EligibleActionTurn): EligibleActionVerdict {
  const raw = typeof turn.text === 'string' ? turn.text.trim() : ''
  const text = raw.toLowerCase().replace(/\s+/g, ' ')
  if (text === '') return { eligible: false, kind: null, reason: 'an empty turn commits nothing' }
  const hasContext = typeof turn.context === 'string' && turn.context.trim() !== ''

  if (NO_ACTION.test(text)) {
    return { eligible: false, kind: null, reason: 'explicit no-action; recording it would be chatter' }
  }
  if (STATUS_REPORT.test(text)) {
    return { eligible: false, kind: null, reason: 'routine status; it neither settles nor transfers anything' }
  }
  if (ACK.test(text)) {
    return { eligible: false, kind: null, reason: 'acknowledgement; nothing is settled or assigned' }
  }
  if (HEDGE.test(text)) {
    return { eligible: false, kind: null, reason: 'an inference with no artifact and no ruling is not a decision' }
  }
  if (STATE_QUESTION.test(text)) {
    return { eligible: false, kind: null, reason: 'a question about state is answered from the file' }
  }
  if (REQUEST_AS_QUESTION.test(text) && WORK_VERB.test(text)) {
    return { eligible: true, kind: 'handoff', reason: 'a request that assigns work, even framed as a question' }
  }
  if (INTERROGATIVE_START.test(text) || raw.endsWith('?')) {
    return { eligible: false, kind: 'question', reason: 'an open question is not a decision; the answer is the obligation' }
  }
  if (STOP_ONLY.test(text)) {
    if (!hasContext) {
      return { eligible: false, kind: null, reason: 'a bare stop word is ambiguous without the turn it stops' }
    }
    return { eligible: true, kind: 'decision', reason: 'a stop instruction changes what may run' }
  }
  if (hasContext && AFFIRM_START.test(text)) {
    return {
      eligible: true,
      kind: 'decision',
      reason: 'an approval of the turn under discussion; without that context it is not decidable',
    }
  }
  if (CORRECTION.test(text)) {
    return { eligible: true, kind: 'correction', reason: 'it revises a claim or a recorded fact' }
  }
  // A handoff outranks evidence when a sentence names both. "I have directed
  // Leaf 22 to send me the readback" moves work to an owner; the readback is
  // what the work will produce, not what this turn produces. The obligation is
  // the handoff.
  if (HANDOFF.test(text)) {
    return { eligible: true, kind: 'handoff', reason: 'work moved to a named owner or target' }
  }
  if (EVIDENCE.test(text)) {
    return { eligible: true, kind: 'external_evidence', reason: 'an artifact or measurement a later claim may rest on' }
  }
  if (DECISION.test(text)) {
    return { eligible: true, kind: 'decision', reason: 'it settles what happens next' }
  }
  // A bare "X is Y" is deliberately not eligible. It names no artifact, commits
  // nothing, and does not say what it corrects; a correction whose target is
  // implicit is not a correction (spec §12.4 requires it to name the event it
  // corrects). It becomes one only when the turn says so - "actually", "not X",
  // "was wrong", "correction:" and the rest of CORRECTION - or when the context
  // it answers names the prior claim.
  if (hasContext && /\b(recorded|previous|earlier|stated|claimed|we said|you said|the claim)\b/.test(turn.context!.toLowerCase())) {
    return { eligible: true, kind: 'correction', reason: 'it revises a claim the preceding turn named' }
  }
  return { eligible: false, kind: null, reason: 'nothing here settles, assigns, cites an artifact, or corrects a named claim' }
}
