/**
 * Zenith is a claim, not an assertion. These cover the claim.
 *
 * The point of the module is that a second session asking to be Zenith is told
 * the truth rather than proceeding on its own belief, so the tests that matter
 * are the refusals: a live holder is not displaced silently, and a session that
 * does not hold the claim cannot act as Zenith.
 */
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// The config directory is read through a memoized accessor keyed on
// CLAUDE_CONFIG_DIR, so pointing the variable at a temp directory is enough to
// sandbox each case - no module reset is needed between them.
async function withConfig<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'zenith-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  try {
    return await run(directory)
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    await rm(directory, { recursive: true, force: true })
  }
}

test('an unheld role is empty, and a session that claims it becomes the holder', async () => {
  await withConfig(async directory => {
    const zenith = await import('../src/utils/zenithRole.ts')
    const first = await zenith.zenithState()
    assert.deepEqual(first, { state: 'empty' }, 'a role nobody holds reads as empty, not as an error')

    const outcome = await zenith.claimZenith({ sessionId: 'aaaa1111-1111-4111-8111-111111111111', purpose: 'watching the fleet' })
    assert.equal(outcome.taken, true, 'an empty role is taken')
    assert.equal((await zenith.zenithState()).state, 'held')

    const claim = await zenith.readZenithClaim()
    assert.equal(claim?.zenithSessionId, 'aaaa1111-1111-4111-8111-111111111111')
    assert.equal(claim?.purpose, 'watching the fleet')
    assert.equal(claim?.pid, process.pid, 'the claim records the process that wrote it, which is what liveness is checked against')
    assert.ok(typeof claim?.processStartedAt === 'string' && !Number.isNaN(Date.parse(claim.processStartedAt)), 'a start time is recorded, because a pid alone cannot answer whether the holder is still there')

    const onDisk = JSON.parse(await readFile(join(directory, 'zenith.json'), 'utf8')) as { zenithSessionId: string }
    assert.equal(onDisk.zenithSessionId, 'aaaa1111-1111-4111-8111-111111111111', 'the claim is a fact on disk, not session state')
  })
})

test('a live holder is not displaced silently, and the refusal carries who holds it', async () => {
  await withConfig(async () => {
    const zenith = await import('../src/utils/zenithRole.ts')
    const holder = 'bbbb2222-2222-4222-8222-222222222222'
    await zenith.claimZenith({ sessionId: holder })

    // This process is unquestionably running, so the claim written above is a
    // live one. A second session asking for the role must be refused rather than
    // take it - that refusal is the entire reason the role is on disk.
    const second = await zenith.claimZenith({ sessionId: 'cccc3333-3333-4333-8333-333333333333' })
    assert.equal(second.taken, false, 'a second session does not silently become Zenith while one is running')
    assert.equal(second.taken === false && second.reason, 'held')
    assert.equal(second.taken === false && second.claim.zenithSessionId, holder, 'the refusal names the holder, which is what the user decides on')
    assert.equal(second.taken === false && second.alive, true, 'and says the holder is still there')

    assert.equal((await zenith.readZenithClaim())?.zenithSessionId, holder, 'a refused claim leaves the file exactly as it was')
  })
})

test('a holder whose process is gone does not block a claim', async () => {
  await withConfig(async directory => {
    const zenith = await import('../src/utils/zenithRole.ts')
    // A pid that cannot be running: the module treats pid <= 1 as absent before
    // it ever asks the OS, so this is a dead holder by construction rather than
    // by racing a real process.
    await writeFile(join(directory, 'zenith.json'), JSON.stringify({
      zenithSessionId: 'dddd4444-4444-4444-8444-444444444444',
      pid: 1,
      processStartedAt: new Date().toISOString(),
      claimedAt: new Date().toISOString(),
    }), 'utf8')

    const state = await zenith.zenithState()
    assert.equal(state.state, 'held')
    assert.equal(state.state === 'held' && state.alive, false, 'a claim whose process is gone reads as dead')

    const outcome = await zenith.claimZenith({ sessionId: 'eeee5555-5555-4555-8555-555555555555' })
    assert.equal(outcome.taken, true, 'a dead holder does not block the role - nothing is running to displace')
    assert.equal((await zenith.readZenithClaim())?.zenithSessionId, 'eeee5555-5555-4555-8555-555555555555')
  })
})

test('a corrupt claim reads as empty rather than as a holder or an error', async () => {
  await withConfig(async directory => {
    const zenith = await import('../src/utils/zenithRole.ts')
    await writeFile(join(directory, 'zenith.json'), '{ this is not json', 'utf8')
    assert.deepEqual(await zenith.zenithState(), { state: 'empty' }, 'a parse failure is not a holder - it must not strand the role forever')
  })
})

test('replacing a live holder leaves it running, and the old holder stops being Zenith', async () => {
  await withConfig(async () => {
    const zenith = await import('../src/utils/zenithRole.ts')
    const holder = 'ffff6666-6666-4666-8666-666666666666'
    const successor = 'aaaa7777-7777-4777-8777-777777777777'
    await zenith.claimZenith({ sessionId: holder })

    const replaced = await zenith.claimZenith({ sessionId: successor, force: true })
    assert.equal(replaced.taken, true, 'the user-replace path takes the role even from a live holder')
    assert.equal((await zenith.readZenithClaim())?.zenithSessionId, successor)

    // The old holder is not signalled and not killed - ending a session is the
    // user's call, not a side effect of taking a title. What changes is that it
    // no longer holds the claim, which every action checks before it acts.
    assert.equal(await zenith.holdsZenith(holder), false, 'the displaced session does not hold the role')
    assert.equal(await zenith.holdsZenith(successor), true, 'the successor does')
  })
})

test('giving the role up only works for the session holding it', async () => {
  await withConfig(async () => {
    const zenith = await import('../src/utils/zenithRole.ts')
    const holder = 'bbbb8888-8888-4888-8888-888888888888'
    await zenith.claimZenith({ sessionId: holder })

    assert.equal(await zenith.releaseZenith('cccc9999-9999-4999-8999-999999999999'), false, 'a session that does not hold the role cannot release it')
    assert.equal((await zenith.zenithState()).state, 'held', 'and the refusal leaves the claim in place')

    assert.equal(await zenith.releaseZenith(holder), true)
    assert.deepEqual(await zenith.zenithState(), { state: 'empty' }, 'the holder can give the role up, leaving it free')
  })
})

test('the reported line says who holds the role and whether they are still there', async () => {
  await withConfig(async () => {
    const zenith = await import('../src/utils/zenithRole.ts')
    assert.match(zenith.renderZenithState({ state: 'empty' }), /unheld/, 'an unheld role is reported as free')

    const claim = {
      zenithSessionId: 'dddd0000-0000-4000-8000-000000000000',
      pid: process.pid,
      processStartedAt: new Date().toISOString(),
      claimedAt: new Date().toISOString(),
      purpose: 'the interface plane',
    }
    const live = zenith.renderZenithState({ state: 'held', claim, alive: true })
    assert.match(live, /dddd0000-0000-4000-8000-000000000000/, 'the holder is named so a person can act on it')
    assert.match(live, /the interface plane/, 'and what it says it is for')

    const dead = zenith.renderZenithState({ state: 'held', claim, alive: false })
    assert.match(dead, /gone/, 'a dead holder is said to be gone rather than reported as live')
  })
})

test('a claim written by this process reads as alive', async () => {
  await withConfig(async () => {
    const zenith = await import('../src/utils/zenithRole.ts')
    // The liveness answer is what the whole decision hangs on, so pin the one
    // case that is certain: this process, which is running by definition.
    const claim = {
      zenithSessionId: randomUUID(),
      pid: process.pid,
      processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      claimedAt: new Date().toISOString(),
    }
    assert.equal(await zenith.zenithProcessAlive(claim), true, 'this process is running')

    // The pair is the point: a pid alone would read as live here, and the guard
    // that matters is that a recycled pid must not. Pinning the live case is the
    // half this platform can answer without /proc.
    assert.equal(await zenith.zenithProcessAlive({ ...claim, pid: 1 }), false, 'an impossible pid is not running')
  })
})
