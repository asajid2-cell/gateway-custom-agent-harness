import { strict as assert } from 'node:assert'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { advanceDelivery, deliveryDirection, parseDeliveryReview, type DeliveryReview } from '../src/skills/bundled/persistDelivery.ts'
import { registerPersistSkill, restorePersistForCurrentSession, settlePersistDelivery, getPersistGoalContext } from '../src/skills/bundled/persist.ts'
import { clearBundledSkills, getBundledSkills } from '../src/skills/bundledSkills.ts'
import { getSessionId } from '../src/bootstrap/state.ts'
import { readPersistSessionRecord, getPersistSessionPath } from '../src/utils/sessionStorage.ts'
import type { AppState } from '../src/state/AppState.ts'
import type { ToolUseContext } from '../src/Tool.ts'
import type { SessionHooksState } from '../src/utils/hooks/sessionHooks.ts'

const review: DeliveryReview = { kind: 'advanced', phase: 'implement', outcome: 'GUI-independent operations', doneWhen: 'Browser operations work with GUI closed', next: 'Connect headless reclaim', deferred: 'Peripheral input edge cases', evidence: 'Startup path connected; reclaim remains' }

test('checkpoint validation and stable outcomes distinguish drift from progress', () => {
  const first = advanceDelivery(undefined, review)
  assert.throws(() => parseDeliveryReview('x'.repeat(16001)))
  assert.throws(() => parseDeliveryReview(JSON.stringify({ ...review, evidence: '' })))
  // `deferred` is the one field a review may leave out; omitting it must not
  // refuse an otherwise well-formed review.
  const { deferred, ...withoutDeferred } = review
  assert.equal(parseDeliveryReview(JSON.stringify(withoutDeferred)).deferred, '')
  assert.throws(() => advanceDelivery(first, { ...review, outcome: 'Polish a local test' }))
  assert.throws(() => advanceDelivery(first, { ...review, kind: 'delivered', phase: 'harden' }))
  const repeated = advanceDelivery(first, review)
  assert.match(deliveryDirection(repeated), /TRAJECTORY CORRECTION/)
  assert.match(deliveryDirection(repeated), /Slow progress is not permission to stop/)
  const integrated = advanceDelivery(repeated, { ...review, kind: 'delivered', phase: 'integrate', evidence: 'Headless path connected', next: 'Exercise browser operations' })
  assert.equal(integrated.detours, 0)
  assert.doesNotMatch(deliveryDirection(integrated), /TRAJECTORY CORRECTION/)
})

test('registered checkpoints survive restore and redirect without exhausting keep mode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'persist-delivery-'))
  clearBundledSkills()
  registerPersistSkill()
  const command = getBundledSkills().find(s => s.name === 'persist')!
  const checkpoint = getBundledSkills().find(s => s.name === 'persist-review')!
  assert.ok(command.type === 'prompt' && checkpoint.type === 'prompt')
  const app = { sessionHooks: new Map() } as unknown as AppState
  const setAppState = (update: (state: AppState) => AppState) => { update(app) }
  const path = join(directory, 'session.jsonl')
  const chain = { chainId: 'delivery-chain', depth: 1, stopHookActive: true }
  const context = { setAppState, transcriptPath: path, queryTracking: chain } as unknown as ToolUseContext
  const hook = () => {
    const item = [...(app.sessionHooks as SessionHooksState).values()].flatMap(s => (s.hooks.Stop ?? []).flatMap(m => m.hooks))[0]?.hook
    assert.ok(item?.type === 'function')
    return item
  }
  try {
    await command.getPromptForCommand('keep --nudges 1 full web parity', context)
    for (let i = 0; i < 5; i++) {
      await checkpoint.getPromptForCommand(`checkpoint ${JSON.stringify(review)}`, context)
      assert.equal(await hook().callback([], undefined, chain), false)
      const before = await readPersistSessionRecord(path)
      assert.equal(before?.nudgesSent, i)
      await settlePersistDelivery(getSessionId(), chain.chainId, true)
    }
    const stored = await readPersistSessionRecord(path)
    assert.equal(stored?.status, 'active')
    assert.equal(stored?.nudgesRemaining, 0)
    assert.equal(stored?.nudgesSent, 5)
    assert.equal(stored?.delivery?.detours, 4)
    await restorePersistForCurrentSession(setAppState, path)
    assert.match(getPersistGoalContext()!, /TRAJECTORY CORRECTION/)
    assert.match(getPersistGoalContext()!, /GUI-independent operations/)
    const invalid = await checkpoint.getPromptForCommand(`checkpoint ${JSON.stringify({ ...review, outcome: 'unrelated polish' })}`, context)
    const refusal = invalid[0].type === 'text' ? invalid[0].text : ''
    // The refusal carries the drift rule that caught it rather than a blanket
    // message. The old tail said "No continuation authorized.", which a session
    // quoted back as an instruction to stop while the goal stayed armed.
    assert.match(refusal, /Checkpoint refused/)
    assert.match(refusal, /Keep the selected outcome and acceptance condition/)
    assert.doesNotMatch(refusal, /No continuation authorized/)
    assert.deepEqual(await readPersistSessionRecord(path), stored)
    await checkpoint.getPromptForCommand(`checkpoint ${JSON.stringify({ ...review, kind: 'delivered', phase: 'integrate' })}`, context)
    assert.equal((await readPersistSessionRecord(path))?.status, 'active')
    await checkpoint.getPromptForCommand('unrelated user requested discussion', context)
    assert.equal(await hook().callback([], undefined, chain), true)
    await command.getPromptForCommand('pause', context)
    assert.equal((await readPersistSessionRecord(path))?.delivery?.phase, 'integrate')
    await command.getPromptForCommand('resume', context)
    await checkpoint.getPromptForCommand('complete Browser workflow acceptance passed', context)
    assert.equal((await readPersistSessionRecord(path))?.status, 'completed')
    await writeFile(getPersistSessionPath(path), JSON.stringify({ ...stored, delivery: { broken: true } }))
    assert.equal((await readPersistSessionRecord(path))?.task, 'full web parity')
    assert.equal((await readPersistSessionRecord(path))?.delivery, undefined)
  } finally {
    await command.getPromptForCommand('clear', context)
    clearBundledSkills()
    await rm(directory, { recursive: true, force: true })
  }
})
