import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

/**
 * The ledger is what makes ownership a lookup instead of a guess.
 *
 * The failure it closes is the stale-ledger class: a claim about who owns what,
 * held in someone's context, that is neither durable nor checked. A coordinator
 * that infers ownership from a name or from a session-local task list will
 * eventually hand work to the wrong lane, or to nobody, and nothing will
 * contradict it. Every case here drives the real files under a real config home
 * and asserts what a reader gets back.
 */
async function withLedger<T>(body: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'zenith-ledger-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = home
  try {
    // Assignment is gated on the Zenith claim (P7), and the caller of `assign`
    // is this process. Claiming the role for the home under test is how a case
    // writes as the coordinator a real one would be, rather than through a back
    // door production does not have. The claim lives in the temp home, so it
    // cannot disturb the machine's real one.
    const { claimZenith } = await import('../src/utils/zenithRole.ts')
    await claimZenith({ force: true })
    return await body(home)
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    await rm(home, { recursive: true, force: true })
  }
}

const ledger = () => import('../src/utils/zenithLedger.ts')

/** Run one command through the real `/zenith-ledger` skill, the surface a session types. */
async function viaSkill(input: string): Promise<string> {
  const { registerZenithLedgerSkill } = await import('../src/skills/bundled/zenithLedger.ts')
  const { clearBundledSkills, getBundledSkills } = await import('../src/skills/bundledSkills.ts')
  registerZenithLedgerSkill()
  try {
    // `getBundledSkills` is typed as the plain `Command` surface, which does not
    // carry the optional prompt builder - only a skill that registered one has
    // it, and this is the skill that did.
    const skill = getBundledSkills().find(entry => entry.name === 'zenith-ledger') as { getPromptForCommand?: (args: string, context: never) => Promise<{ type: string; text?: string }[]> }
    const result = await skill.getPromptForCommand!(input, {} as never)
    return result.map((part: { type: string; text?: string }) => (part.type === 'text' ? (part.text ?? '') : '')).join('')
  } finally {
    clearBundledSkills()
  }
}

test('a workKey resolves to exactly one owner and family, without a task list', async () => {
  await withLedger(async () => {
    const { assign, ownerOf } = await ledger()
    const owner = randomUUID()
    const family = randomUUID()
    const assigned = await assign('bus-reliability', { sessionId: owner, familyRootSessionId: family, summary: 'the Zenith campaign Phase A' })
    assert.equal(assigned.ok, true)
    // The answer comes from the durable file, on a fresh read - nothing was
    // carried in this process's memory between the write and the lookup.
    const found = await ownerOf('bus-reliability')
    assert.equal(found.state, 'owned')
    assert.equal(found.state === 'owned' && found.sessionId, owner)
    assert.equal(found.state === 'owned' && found.familyRootSessionId, family)
    assert.equal(found.state === 'owned' && found.summary, 'the Zenith campaign Phase A')
  })
})

test('an unqueried session is UNKNOWN, never assumed idle or gone', async () => {
  await withLedger(async () => {
    const { sessionHistory } = await ledger()
    const history = await sessionHistory(randomUUID())
    assert.equal(history.state, 'unknown')
    // The shape matters: an unknown answer carries no family and no timestamps,
    // because inventing any of them is how a session that was never checked
    // becomes one a coordinator acts on.
    assert.deepEqual(Object.keys(history).sort(), ['sessionId', 'state'])
  })
})

test('the history of a session is dated and ordered, not a single row', async () => {
  await withLedger(async () => {
    const { recordSessionObservation, sessionHistory } = await ledger()
    const sessionId = randomUUID()
    const family = randomUUID()
    await recordSessionObservation({ sessionId, familyRootSessionId: family, name: 'Leaf 5: box' })
    await new Promise(resolve => setTimeout(resolve, 5))
    await recordSessionObservation({ sessionId, familyRootSessionId: family, name: 'Leaf 5: box', buildId: '2026-10-03T19:18:04.931Z' })
    const history = await sessionHistory(sessionId)
    assert.equal(history.state, 'known')
    assert.equal(history.state === 'known' && history.observations.length, 2, 'both observations are the history')
    assert.equal(history.state === 'known' && history.familyRootSessionId, family)
    assert.ok(history.state === 'known' && history.firstSeen < history.lastSeen, 'the history is dated, earliest first')
    assert.equal(history.state === 'known' && history.observations.at(-1)?.buildId, '2026-10-03T19:18:04.931Z')
  })
})

test('a live holder is not displaced by a second claim', async () => {
  await withLedger(async () => {
    const { assign, ownerOf } = await ledger()
    const first = randomUUID()
    const second = randomUUID()
    const family = randomUUID()
    await assign('shared-file', { sessionId: first, familyRootSessionId: family })
    const blocked = await assign('shared-file', { sessionId: second, familyRootSessionId: family })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.ok === false && blocked.reason, 'held')
    // And the refusal did not write: the owner is still the first session.
    const found = await ownerOf('shared-file')
    assert.equal(found.state === 'owned' && found.sessionId, first)
  })
})

test('an owner whose process is gone reads as ORPHANED, and is recoverable', async () => {
  await withLedger(async () => {
    const { assign, ownerOf, release } = await ledger()
    const departed = randomUUID()
    const family = randomUUID()
    await assign('abandoned-work', { sessionId: departed, familyRootSessionId: family })
    // Liveness is computed on read, not polled, so the "process is gone" fact is
    // driven here rather than waited for. The two answers are deliberately
    // different - "someone must release this" is not "nobody has taken it" - and
    // a coordinator that conflates them either strands work or double-assigns it.
    const orphaned = await ownerOf('abandoned-work', { now: async () => false })
    assert.equal(orphaned.state, 'orphaned')
    // A proven-dead owner does not block recovery - nothing is running to
    // displace - so recovery takes it without `force`. An owner that merely
    // cannot be reached (no observation at all) is NOT proven dead and still
    // blocks, which the next case pins.
    const dead = async () => false as const
    const recovered = await assign('abandoned-work', { sessionId: randomUUID(), familyRootSessionId: family, recoverDead: true, now: dead })
    assert.equal(recovered.ok, true)
    // Release by a session that is not the owner is refused rather than obeyed.
    assert.equal(await release('abandoned-work', { sessionId: randomUUID() }), false)
  })
})

test('an owner the ledger has never seen is not provably dead, so it still blocks', async () => {
  await withLedger(async () => {
    const { assign } = await ledger()
    const family = randomUUID()
    await assign('unobserved-owner', { sessionId: randomUUID(), familyRootSessionId: family })
    // No observation means liveness is UNKNOWN, not false. Taking the work on an
    // unknown is how a live lane's job gets reassigned out from under it, so the
    // refusal stands.
    const blocked = await assign('unobserved-owner', { sessionId: randomUUID(), familyRootSessionId: family, recoverDead: true })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.ok === false && blocked.reason, 'held')
  })
})

test('a workKey with no history is unowned, which is not the same as orphaned', async () => {
  await withLedger(async () => {
    const { ownerOf } = await ledger()
    const found = await ownerOf('never-existed')
    assert.equal(found.state, 'unowned')
  })
})

test('an index disagreement resolves in favour of the JSONL, and the fold is reproducible', async () => {
  await withLedger(async (home) => {
    const { assign, currentAssignments, rebuildIndex, ownerOf } = await ledger()
    const owner = randomUUID()
    const family = randomUUID()
    await assign('phase-c', { sessionId: owner, familyRootSessionId: family })
    const rebuilt = await rebuildIndex()
    assert.equal(rebuilt.assignments.length, 1)
    // Now corrupt the index. It is a cache, so this must change nothing a reader
    // sees: the JSONL is the truth and the fold reproduces the same answer.
    await writeFile(join(home, 'zenith-ledger', 'index.json'), JSON.stringify({ rebuiltAt: 'nonsense', assignments: [], sessions: [] }))
    const found = await ownerOf('phase-c')
    assert.equal(found.state, 'owned')
    assert.equal(found.state === 'owned' && found.sessionId, owner)
    const rows = await currentAssignments()
    assert.equal(rows.length, 1, 'the fold does not read the index')
  })
})

test('a torn last line is skipped, not fatal, and the intact history still reads', async () => {
  await withLedger(async (home) => {
    const { assign, ledgerHealth, ownerOf } = await ledger()
    const owner = randomUUID()
    const family = randomUUID()
    await assign('durable', { sessionId: owner, familyRootSessionId: family })
    // A crash mid-append leaves a partial line. Refusing the whole file over it
    // would let one interrupted write destroy a ledger that is otherwise intact,
    // which is the opposite of what append-only is for.
    await appendFile(join(home, 'zenith-ledger', 'assignments.jsonl'), '{"version":1,"event":"assign","workK')
    const found = await ownerOf('durable')
    assert.equal(found.state, 'owned')
    assert.equal(found.state === 'owned' && found.sessionId, owner)
    const health = await ledgerHealth()
    assert.equal(health.assignments.records, 1)
    assert.equal(health.assignments.skipped, 1, 'the torn line is reported, not hidden')
  })
})

test('the ambiguity detector reports the collisions that have actually cost work here', async () => {
  await withLedger(async () => {
    const { recordSessionObservation, ambiguities } = await ledger()
    const family = randomUUID()
    // The measured collision: family-local labels mean "Leaf 5" names several
    // live sessions. Detecting is not fixing - the caller decides - because a
    // tool that picks silently is the defect, not the fix.
    const a = randomUUID()
    const b = randomUUID()
    await recordSessionObservation({ sessionId: a, familyRootSessionId: family, name: 'Leaf 5: box' })
    await recordSessionObservation({ sessionId: b, familyRootSessionId: family, name: 'Leaf 5: box' })
    // And one session seen under two names - a rename that left both rows.
    await recordSessionObservation({ sessionId: a, familyRootSessionId: family, name: 'Leaf 5: bridge' })
    const found = await ambiguities()
    const nameCollision = found.find(item => item.kind === 'name-multi-id' && item.name === 'Leaf 5: box')
    assert.ok(nameCollision, `the name collision must be reported: ${JSON.stringify(found)}`)
    assert.equal(nameCollision.kind, 'name-multi-id')
    assert.deepEqual([...nameCollision.sessionIds].sort(), [a, b].sort())
    const idCollision = found.find(item => item.kind === 'id-multi-name' && item.sessionId === a)
    assert.ok(idCollision, 'the one-id-two-names collision must be reported')
  })
})

test('a workKey claimed by more than one session is reported as an ambiguity', async () => {
  await withLedger(async (home) => {
    const { ambiguities, recordSessionObservation } = await ledger()
    const family = randomUUID()
    const one = randomUUID()
    const two = randomUUID()
    // Observing anything is what creates the ledger directory; the raw write
    // below then lands in a real ledger rather than a directory that is not
    // there.
    await recordSessionObservation({ sessionId: one, familyRootSessionId: family, name: 'Coordinator' })
    // Two opens with no release between them - what two coordinators racing
    // produce, and what the fold alone would resolve silently to the last one.
    await writeFile(
      join(home, 'zenith-ledger', 'assignments.jsonl'),
      [
        { version: 1, event: 'assign', workKey: 'contested', sessionId: one, familyRootSessionId: family, at: new Date().toISOString() },
        { version: 1, event: 'assign', workKey: 'contested', sessionId: two, familyRootSessionId: family, at: new Date().toISOString() },
      ].map(row => JSON.stringify(row)).join('\n') + '\n',
    )
    const found = await ambiguities()
    const contested = found.find(item => item.kind === 'workkey-multi-claimant' && item.workKey === 'contested')
    assert.ok(contested, `the multi-claimant key must be reported: ${JSON.stringify(found)}`)
    assert.equal(contested.kind, 'workkey-multi-claimant')
    assert.deepEqual([...contested.sessionIds].sort(), [one, two].sort())
  })
})

test('reassign moves ownership and records the move as one decision', async () => {
  await withLedger(async () => {
    const { assign, reassign, ownerOf } = await ledger()
    const first = randomUUID()
    const second = randomUUID()
    const family = randomUUID()
    await assign('handover', { sessionId: first, familyRootSessionId: family })
    // Reassigning a LIVE holder is a decision, so it needs force - the same
    // rule as displacing a Zenith holder, for the same reason.
    const refused = await reassign('handover', { to: second, familyRootSessionId: family })
    assert.equal(refused.ok, false)
    const moved = await reassign('handover', { to: second, familyRootSessionId: family, force: true })
    assert.equal(moved.ok, true)
    const found = await ownerOf('handover')
    assert.equal(found.state === 'owned' && found.sessionId, second)
  })
})

test('a session that is not Zenith cannot write ownership', async () => {
  // P7. The ledger is the record that says who is doing what; a session able to
  // write it without holding the role can quietly claim a lane's work, and the
  // file then disagrees with the fleet while looking authoritative. So the gate
  // is checked on the CALLER, and a refusal writes nothing.
  const home = await mkdtemp(join(tmpdir(), 'zenith-gate-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = home
  try {
    const { assign, ownerOf } = await import('../src/utils/zenithLedger.ts')
    const { holdsZenith, releaseZenith } = await import('../src/utils/zenithRole.ts')
    const { getSessionId } = await import('../src/bootstrap/state.ts')
    const family = randomUUID()
    // No claim exists in this home, so this session does not hold Zenith.
    assert.equal(await holdsZenith(), false)
    const refused = await assign('rogue-write', { sessionId: getSessionId(), familyRootSessionId: family })
    assert.equal(refused.ok, false)
    assert.equal(refused.ok === false && refused.reason, 'not-zenith')
    // And the refusal did not write: the key is still unowned rather than
    // half-created by the attempt.
    const found = await ownerOf('rogue-write')
    assert.equal(found.state, 'unowned')
    void releaseZenith
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    await rm(home, { recursive: true, force: true })
  }
})

test('a live session answers identify with what it is, from the running process', async () => {
  // C3's second source. The registration file is a session's claim about itself
  // that outlives it; `identify` is the same claim made by the process while it
  // is still running, which is the only version that cannot be stale. This is
  // the fact the sweep records, so it is asserted at the socket: a running
  // transport must answer, and answer as itself rather than as the file.
  const registry = await mkdtemp(join(tmpdir(), 'zenith-identify-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = registry
  try {
    const { GatewaySessionTransport, broadcastIdentify } = await import('../src/utils/gatewaySessionTransport.ts')
    const sessions = join(registry, 'gateway-sessions')
    const live = new GatewaySessionTransport({ directory: sessions, sessionId: randomUUID(), name: 'Leaf 7: sweep', cwd: registry })
    const asker = new GatewaySessionTransport({ directory: sessions, sessionId: randomUUID(), name: 'Coordinator', cwd: registry })
    await live.start()
    await asker.start()
    try {
      const identities = await broadcastIdentify(sessions, { sessionId: asker.peer.sessionId })
      const mine = identities.find(identity => identity.sessionId === live.peer.sessionId)
      assert.ok(mine, `a running session must answer identify: ${JSON.stringify(identities)}`)
      assert.equal(mine.sessionId, live.peer.sessionId)
      assert.equal(mine.name, 'Leaf 7: sweep', 'the answer names the session as it is now, not as a file recorded it')
      assert.equal(mine.runtimeId, live.peer.runtimeId, 'the answer is the running process speaking, not the registration')
    } finally {
      await live.close()
      await asker.close()
    }
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    await rm(registry, { recursive: true, force: true })
  }
})

test('the sweep records only the sessions that answered, and a silent one stays UNKNOWN', async () => {
  // The sweep must not turn a non-answer into a row. A registration whose
  // session is gone answers nothing, and recording it would make the ledger
  // assert that a session was observed when it was only advertised - exactly the
  // stale-ledger failure the ledger exists to close.
  const registry = await mkdtemp(join(tmpdir(), 'zenith-sweep-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = registry
  try {
    const { GatewaySessionTransport } = await import('../src/utils/gatewaySessionTransport.ts')
    const { sweepSessions, sessionHistory } = await import('../src/utils/zenithLedger.ts')
    const sessions = join(registry, 'gateway-sessions')
    const live = new GatewaySessionTransport({ directory: sessions, sessionId: randomUUID(), name: 'Leaf 8: sweep', cwd: registry })
    const departed = new GatewaySessionTransport({ directory: sessions, sessionId: randomUUID(), name: 'Leaf 9: gone', cwd: registry })
    const asker = new GatewaySessionTransport({ directory: sessions, sessionId: randomUUID(), name: 'Coordinator', cwd: registry })
    await live.start()
    await departed.start()
    await asker.start()
    const departedId = departed.peer.sessionId
    await departed.close()
    // The departed session's registration is still on disk; only its process is
    // gone. The sweep asks and gets nothing, so it must record nothing for it.
    const result = await sweepSessions({ directory: sessions, asker: { sessionId: asker.peer.sessionId } })
    // The departed session is not on the live list at all - a listing proves it
    // dead and drops it - so the only session asked is the live one, and it
    // answers. `asked` counts the questions put to other live sessions,
    // `answered` the answers that came back.
    assert.equal(result.asked, 1, 'the only live session other than the asker is asked')
    assert.equal(result.answered, 1, 'only the sessions that answered are counted as answered')
    assert.equal(result.recorded, 1, 'and only those are recorded')
    const answered = await sessionHistory(live.peer.sessionId)
    assert.equal(answered.state, 'known')
    assert.equal(answered.state === 'known' && answered.observations.at(-1)?.name, 'Leaf 8: sweep')
    const silent = await sessionHistory(departedId)
    assert.equal(silent.state, 'unknown', 'a session that did not answer is UNKNOWN, not recorded as observed')
    await live.close()
    await asker.close()
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    await rm(registry, { recursive: true, force: true })
  }
})

test('the /zenith-ledger surface answers ownership, history and the claim in words a person can act on', async () => {
  // The surface is the capability: the primitives are only usable if a
  // coordinator can reach them without writing code. Every case here goes
  // through the registered skill, so what is asserted is what a session reading
  // the output would actually see.
  await withLedger(async () => {
    const { randomUUID } = await import('node:crypto')
    // Nothing has been observed and nothing is owned, so the first answers are
    // the honest empty ones rather than a fabricated row.
    assert.match(await viaSkill('owner phase-c'), /unowned/)
    assert.match(await viaSkill('sessions'), /No sessions observed/)
    assert.match(await viaSkill('ambiguities'), /No collisions/)

    // This session already holds the role (the harness claimed it), so a second
    // claim must be refused rather than silently taken - and the surface must
    // say who holds it and that taking it needs the user, not just "refused".
    assert.match(await viaSkill('claim the Zenith campaign'), /held by .*still running/)
    assert.match(await viaSkill('assign phase-c the ledger surface'), /Assigned phase-c/)
    const owned = await viaSkill('owner phase-c')
    assert.match(owned, /held by/)
    assert.match(owned, /the ledger surface/)

    // A session nobody has observed reads as UNKNOWN, not as gone - and the
    // surface names `sweep` as the fix rather than inventing a state.
    assert.match(await viaSkill(`history ${randomUUID()}`), /UNKNOWN/)

    // Releasing is guarded: a key this session does not own is refused.
    assert.match(await viaSkill('release someone-elses-key'), /Refused/)

    assert.match(await viaSkill('health'), /assignments: \d+ record/)
  })
})

test('the /zenith-ledger surface refuses a write from a session that is not Zenith', async () => {
  // The same gate as the primitive, reached through the surface. A refusal must
  // say what to do about it, because "refused" alone sends a coordinator looking
  // for a bug where the fix is `claim` or the user.
  const home = await mkdtemp(join(tmpdir(), 'zenith-surface-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = home
  try {
    assert.match(await viaSkill('assign rogue-surface work'), /does not hold Zenith/)
    assert.match(await viaSkill('reassign rogue-surface ' + randomUUID()), /does not hold Zenith/)
    assert.match(await viaSkill('assignments'), /No assignments/)
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    await rm(home, { recursive: true, force: true })
  }
})
