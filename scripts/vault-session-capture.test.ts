import assert from 'node:assert/strict'
import test from 'node:test'
import { captureFamilyFor, captureSessionSafely } from '../src/utils/vault/sessionCapture.js'

test('a member files under its family root', () => {
  const result = captureFamilyFor({
    selfSessionId: 'leaf-1',
    familyRootSessionId: 'root-1',
    familyFileExists: true,
  })
  assert.deepEqual(result, { kind: 'family', familyId: 'root-1' })
})

test('a session that owns a family files under itself', () => {
  const result = captureFamilyFor({ selfSessionId: 'root-1', familyRootSessionId: 'root-1', familyFileExists: true })
  assert.deepEqual(result, { kind: 'family', familyId: 'root-1' })
})

test('a session with no family captures nothing, and says so in the completeness vocabulary', () => {
  // §12.16: no synthetic bucket. The resolver answers with the session's own id
  // when it stands alone, so the absent family file is the whole discriminator.
  const result = captureFamilyFor({ selfSessionId: 'plain', familyRootSessionId: 'plain', familyFileExists: false })
  assert.equal(result.kind, 'none')
  if (result.kind === 'none') {
    assert.match(result.reason, /belongs to no family/)
    assert.equal(result.state, 'no-captures', 'absence must not print as a healthy zero')
  }
})

test('a capture failure is reported and never thrown into the caller', async () => {
  const failed = await captureSessionSafely({
    resolve: async () => ({ kind: 'family', familyId: 'root-1' }),
    run: async () => {
      throw new Error('vault is on fire')
    },
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.ok === false ? failed.reason : '', 'failed')
  assert.match(failed.ok === false && failed.reason === 'failed' ? failed.message : '', /vault is on fire/)

  const unresolved = await captureSessionSafely({
    resolve: async () => {
      throw new Error('no pointer')
    },
    run: async () => 'unused',
  })
  assert.equal(unresolved.ok, false)
  assert.equal(unresolved.ok === false ? unresolved.reason : '', 'failed')

  const homeless = await captureSessionSafely({
    resolve: async () => ({ kind: 'none', reason: 'no family', state: 'no-captures' }),
    run: async () => 'unused',
  })
  assert.equal(homeless.ok, false)
  if (homeless.ok === false && homeless.reason === 'no-family') {
    assert.equal(homeless.state, 'no-captures')
    assert.match(homeless.note, /no family/)
  } else {
    assert.fail('a session with no family must report no-family, not a failed write')
  }
})

test('a successful capture returns the family it wrote under', async () => {
  const outcome = await captureSessionSafely({
    resolve: async () => ({ kind: 'family', familyId: 'root-1' }),
    run: async familyId => ({ appended: 2, familyId }),
  })
  assert.equal(outcome.ok, true)
  if (outcome.ok) {
    assert.equal(outcome.familyId, 'root-1')
    assert.deepEqual(outcome.result, { appended: 2, familyId: 'root-1' })
  }
})
