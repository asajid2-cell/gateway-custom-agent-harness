/**
 * Which family a session's captures belong to, and the rule that a capture
 * problem never breaks a session.
 *
 * A session captures under its family ROOT - the durable family membership
 * every member shares (spec §12.16). A session with no family captures nothing:
 * there is deliberately no synthetic "unfiled" family, because a shared bucket
 * would make the transcript index the one artifact whose owner cannot be
 * attributed. The absence is meant to be visible rather than convenient: it is
 * reported with the completeness vocabulary (`state: 'no-captures'` plus a
 * note), so an empty capture set is never mistaken for an empty session.
 *
 * The second rule matters more in practice. This runs during a transcript
 * write, so it must be structurally unable to throw into the caller - not a
 * try/catch someone remembers to add. `captureSessionSafely` returns its
 * outcome and never rejects.
 */

/** Why a turn recorded nothing. Both are "not applicable", not "zero captures". */
export type CaptureSkipReason = 'no-family' | 'vault-root-absent'

export type CaptureFamily =
  | { kind: 'family'; familyId: string }
  | {
      kind: 'none'
      /**
       * The completeness state this absence reads as. A session with no family,
       * or a machine with no vault, is not a family with zero captures; carrying
       * the state and the reason keeps "not applicable" from being counted as
       * "nothing recorded yet".
       */
      state: 'no-captures'
      reason: CaptureSkipReason
      note: string
    }

/**
 * The decision, as a pure function so it can be read and tested without a
 * session.
 *
 * `familyRootSessionId` is the root the session resolved to - its family
 * membership, from the live family snapshot or from the pointer it wrote on its
 * way in. `familyFileExists` reports whether a family file actually exists for
 * it, which is what disambiguates a root from a session that stands alone: the
 * resolver answers with the session's own id in both cases, and only the file
 * makes that id a family.
 */
export function captureFamilyFor(input: {
  selfSessionId: string
  familyRootSessionId: string
  familyFileExists: boolean
}): CaptureFamily {
  if (input.familyRootSessionId !== input.selfSessionId) {
    return { kind: 'family', familyId: input.familyRootSessionId }
  }
  if (input.familyFileExists) return { kind: 'family', familyId: input.selfSessionId }
  return {
    kind: 'none',
    reason: 'no-family',
    state: 'no-captures',
    note: 'this session belongs to no family',
  }
}

export type SafeCaptureOutcome =
  | { ok: true; familyId: string; result: unknown }
  | { ok: false; reason: CaptureSkipReason; state: 'no-captures'; note: string }
  | { ok: false; reason: 'failed'; message: string }

/**
 * Run a capture without ever throwing into the caller. A vault fault is
 * reported on the outcome and swallowed; the transcript write it rides on must
 * not fail because the vault did.
 */
export async function captureSessionSafely(input: {
  resolve: () => Promise<CaptureFamily>
  run: (familyId: string) => Promise<unknown>
}): Promise<SafeCaptureOutcome> {
  let family: CaptureFamily
  try {
    family = await input.resolve()
  } catch (error) {
    return { ok: false, reason: 'failed', message: `cannot resolve the capture family: ${(error as Error).message}` }
  }
  if (family.kind === 'none') {
    // Not a success with zero rows: nothing was captured because nothing owns
    // the span, and the caller must be able to say which of those it is.
    return { ok: false, reason: family.reason, state: family.state, note: family.note }
  }
  try {
    return { ok: true, familyId: family.familyId, result: await input.run(family.familyId) }
  } catch (error) {
    return { ok: false, reason: 'failed', message: `capture failed for family ${family.familyId}: ${(error as Error).message}` }
  }
}
