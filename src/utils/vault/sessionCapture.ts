/**
 * Which family a session's captures belong to, and the rule that a capture
 * problem never breaks a session.
 *
 * A leaf session belongs to the family whose root its pointer names. A session
 * that stands alone belongs to nothing: there is deliberately no synthetic
 * "unfiled" family, because inventing an owner is how a completeness metric
 * starts counting captures nobody owns. The consequence is meant to be visible:
 * a plain session in a repo produces no captures at all.
 *
 * The second rule matters more in practice. This runs during a transcript
 * write, so it must be structurally unable to throw into the caller - not a
 * try/catch someone remembers to add. `captureSessionSafely` returns its
 * outcome and never rejects.
 */

export type CaptureFamily =
  | { kind: 'family'; familyId: string }
  | { kind: 'unfiled'; reason: string }

/**
 * The decision, as a pure function so it can be read and tested without a
 * session.
 *
 * `familyRootSessionId` is the root the session resolved to; `familyFileExists`
 * reports whether a family file actually exists for it. A session whose root is
 * itself and has no family file is alone, even though the resolver returns a
 * value for it.
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
  return { kind: 'unfiled', reason: 'this session belongs to no family' }
}

export type SafeCaptureOutcome =
  | { ok: true; familyId: string; result: unknown }
  | { ok: false; reason: 'unfiled'; message: string }
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
  if (family.kind === 'unfiled') return { ok: false, reason: 'unfiled', message: family.reason }
  try {
    return { ok: true, familyId: family.familyId, result: await input.run(family.familyId) }
  } catch (error) {
    return { ok: false, reason: 'failed', message: `capture failed for family ${family.familyId}: ${(error as Error).message}` }
  }
}
