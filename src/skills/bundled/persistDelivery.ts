export type DeliveryCheckpoint = {
  phase: 'implement' | 'integrate' | 'harden'
  outcome: string
  doneWhen: string
  next: string
  deferred: string
  evidence: string
  reviewsSinceDelivery: number
  detours: number
}

export type DeliveryReview = {
  kind: 'advanced' | 'learned' | 'delivered' | 'detoured'
  phase: DeliveryCheckpoint['phase']
  outcome: string
  doneWhen: string
  next: string
  deferred: string
  evidence: string
}

const phases = ['implement', 'integrate', 'harden'] as const
const fields = ['outcome', 'doneWhen', 'next', 'deferred', 'evidence'] as const

export function parseDeliveryReview(input: string): DeliveryReview {
  if (input.length > 16000) throw new Error('Delivery review is too large.')
  const value = JSON.parse(input)
  // A missing kind, or the skill's own verbs "checkpoint" and "continue" left in
  // its place, is the most conservative review there is, and
  // validateDeliveryCheckpoint already reads an absent kind as "advanced" when
  // it restores one - so a review that survives a resume must not be refused
  // live. Guessing "delivered" here would be the unsafe direction: it clears the
  // trajectory counters and permits a phase advance, which is the one thing a
  // review should have to say explicitly.
  const kind = value && typeof value === 'object' && (value.kind === undefined || value.kind === 'checkpoint' || value.kind === 'continue')
    ? 'advanced'
    : value?.kind
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !['advanced', 'learned', 'delivered', 'detoured'].includes(kind) ||
      !phases.includes(value.phase)) throw new Error('Invalid delivery review kind or phase.')
  // `deferred` names work deliberately not done yet, so an honest review often
  // has nothing to put there and the field is the one the loop below lets stand
  // empty. Demanding the key be present while allowing it to be empty is a rule
  // the skill never states, and it refused a well-formed review in a live
  // session, so an absent one reads as empty. Every other field must be present
  // and non-empty or the review says nothing.
  const review = { ...value, deferred: value.deferred === undefined ? '' : value.deferred }
  for (const field of fields) {
    if (typeof review[field] !== 'string' || review[field].length > 1200 ||
        (field !== 'deferred' && !review[field].trim())) throw new Error(`Invalid delivery field: ${field}.`)
  }
  return { kind, phase: value.phase, ...Object.fromEntries(fields.map(field => [field, review[field].trim()])) } as DeliveryReview
}

export function validateDeliveryCheckpoint(value: unknown): DeliveryCheckpoint | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  try {
    const review = parseDeliveryReview(JSON.stringify({ ...v, kind: 'advanced' }))
    if (!Number.isSafeInteger(v.reviewsSinceDelivery) || (v.reviewsSinceDelivery as number) < 0 ||
        !Number.isSafeInteger(v.detours) || (v.detours as number) < 0) return undefined
    const { kind, ...checkpoint } = review
    return { ...checkpoint, reviewsSinceDelivery: v.reviewsSinceDelivery as number, detours: v.detours as number }
  } catch { return undefined }
}

export function advanceDelivery(previous: DeliveryCheckpoint | undefined, review: DeliveryReview): DeliveryCheckpoint {
  if (!previous && review.phase !== 'implement') throw new Error('Begin with an implementation outcome before integration or hardening.')
  if (previous) {
    const shift = phases.indexOf(review.phase) - phases.indexOf(previous.phase)
    if (shift > 1 || (shift > 0 && review.kind !== 'delivered')) throw new Error('Advance phase only after delivering the current outcome; do not skip integration.')
    if (review.kind !== 'delivered' && (review.outcome !== previous.outcome || review.doneWhen !== previous.doneWhen)) {
      throw new Error('Keep the selected outcome and acceptance condition until delivered; change the approach in next instead.')
    }
  }
  const repeated = previous?.evidence === review.evidence && previous?.next === review.next
  const { kind, ...checkpoint } = review
  return {
    ...checkpoint,
    reviewsSinceDelivery: kind === 'delivered' ? 0 : Math.min(Number.MAX_SAFE_INTEGER, (previous?.reviewsSinceDelivery ?? 0) + 1),
    detours: kind === 'delivered' ? 0 : Math.min(Number.MAX_SAFE_INTEGER, (previous?.detours ?? 0) + (kind === 'detoured' || repeated ? 1 : 0)),
  }
}

export function deliveryDirection(checkpoint?: DeliveryCheckpoint): string {
  const policy = 'Deliver a connected user capability, not a sequence of tiny patch/test reports. During implementation use cheap checks and tests for consequential assumptions; exercise complete workflows during integration; defer nonblocking edge cases and broad regression to hardening. Fix authentication, destructive-operation and data-integrity risks immediately. Re-run checks when relevant inputs changed or the result will change a decision. Never weaken safety or ignore the latest user instruction.'
  if (!checkpoint) return `${policy} Establish a substantial outcome and doneWhen criterion with persist-review checkpoint JSON; do not substitute test counts for delivery.`
  const redirect = checkpoint.detours > 0 || checkpoint.reviewsSinceDelivery >= 3
    ? 'TRAJECTORY CORRECTION: Keep working, but zoom out before another local patch. Identify the missing end-to-end connection and change the approach in next. Do not repeat unchanged tests or expand peripheral hardening. Slow progress is not permission to stop.'
    : 'Continue the selected outcome through a meaningful implementation checkpoint; a focused test passing is not a handoff.'
  return `${policy}\nDelivery checkpoint (self-reported, not independently verified): ${JSON.stringify(checkpoint)}\n${redirect}`
}
