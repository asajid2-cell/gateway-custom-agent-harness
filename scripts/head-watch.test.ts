import { test, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addLeafMember } from '../src/utils/leafFamily.ts'

// Pinned like head-ledger.test.ts: launched by a leaf, the inherited identity
// changes what the workspace calls mean, so the file says the same thing
// wherever it is launched and puts the identity back for what runs next.
const ambientLeafIdentity = process.env.GATEWAY_INTERACTIVE_LEAF
delete process.env.GATEWAY_INTERACTIVE_LEAF
after(() => {
  if (ambientLeafIdentity === undefined) delete process.env.GATEWAY_INTERACTIVE_LEAF
  else process.env.GATEWAY_INTERACTIVE_LEAF = ambientLeafIdentity
})

test('the head is pushed a notice on an idle flip and on a new leaf', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'head-watch-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  try {
    const { getSessionId } = await import('../src/bootstrap/state.ts')
    const workspace = await import('../src/utils/leafWorkspace.ts')
    const ledger = await import('../src/utils/headLedger.ts')
    const root = getSessionId()
    const family = join(directory, 'leaf-families', `${root}.json`)
    const mate = await addLeafMember(family, root, { sessionId: randomUUID(), parentSessionId: root, name: 'Member', transcriptPath: join(directory, 'member.jsonl'), forkMessageId: randomUUID() })
    await workspace.restoreLeafWorkspace()

    // The head sets the two watches it asked about: this member going idle, and
    // any new leaf. Only the registrations are written here - the watch pass
    // below is what decides what fires.
    await ledger.appendHeadLedgerEvent(root, { kind: 'watch', to: mate.sessionId, mode: 'idle', on: true })
    await ledger.appendHeadLedgerEvent(root, { kind: 'watch', to: root, mode: 'new', on: true })

    // The sink the app wires to the head: exactly the registration the hook makes,
    // captured so the PUSH - not just the ledger append - is what is asserted.
    const pushed: { familyId: string; notice: string }[] = []
    const remove = ledger.registerHeadWatchSink((familyId, notice) => { pushed.push({ familyId, notice }) })

    try {
      const appearing = randomUUID()
      const before = { states: new Map([[mate.sessionId, 'running']]), ids: new Set([root, mate.sessionId]) }
      const now = { states: new Map([[mate.sessionId, 'idle']]), ids: new Set([root, mate.sessionId, appearing]) }
      const notices = await ledger.headWatchPass(root, before, now)

      // Both conditions the head asked for are reported, in order, and both are
      // PUSHED to the sink - the head's UI is told, not left to read the file.
      assert.deepEqual(notices, [`${mate.sessionId} went idle`, `new leaf ${appearing}`])
      assert.deepEqual(pushed, [
        { familyId: root, notice: `${mate.sessionId} went idle` },
        { familyId: root, notice: `new leaf ${appearing}` },
      ])

      // And the fires are durable: the ledger is the record even if no head was up.
      const fired = await ledger.runHeadLedger({ subverb: 'fired' })
      assert.match(fired, new RegExp(`\\[idle\\] ${mate.sessionId}`))
      assert.match(fired, new RegExp(`\\[new\\] ${appearing}`))

      // A member that was already idle is not a second notice, and an unwatched
      // member that flips is not one at all.
      pushed.length = 0
      const quiet = await ledger.headWatchPass(root,
        { states: new Map([[mate.sessionId, 'idle'], ['stranger', 'running']]), ids: new Set([root, mate.sessionId, 'stranger']) },
        { states: new Map([[mate.sessionId, 'idle'], ['stranger', 'idle']]), ids: new Set([root, mate.sessionId, 'stranger']) })
      assert.deepEqual(quiet, [])
      assert.deepEqual(pushed, [])
    } finally {
      remove()
    }
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    await rm(directory, { recursive: true, force: true })
  }
})

test('one new leaf fires the watcher once, even when two passes land together', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'head-watch-dup-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  try {
    const { getSessionId } = await import('../src/bootstrap/state.ts')
    const ledger = await import('../src/utils/headLedger.ts')
    const root = getSessionId()
    await ledger.appendHeadLedgerEvent(root, { kind: 'watch', to: root, mode: 'new', on: true })

    const pushed: string[] = []
    const remove = ledger.registerHeadWatchSink((_familyId, notice) => { pushed.push(notice) })
    try {
      // Two passes that both start from the same "before": two publishes landing
      // in one turn, each running a pass. Both used to read the member as new
      // and both append a watch-fired event for it - the duplicate the head saw,
      // 1ms apart. The first pass advances the shared baseline before it awaits,
      // so the second finds the member already taken and says nothing.
      const appearing = randomUUID()
      const previous = { states: new Map<string, string>(), ids: new Set<string>([root]) }
      const current = { states: new Map<string, string>(), ids: new Set<string>([root, appearing]) }
      const [first, second] = await Promise.all([
        ledger.headWatchPass(root, previous, current),
        ledger.headWatchPass(root, previous, current),
      ])

      assert.equal(first.length + second.length, 1, 'the two passes fire the change once between them')
      assert.deepEqual([...first, ...second], [`new leaf ${appearing}`])
      assert.deepEqual(pushed, [`new leaf ${appearing}`], 'the sink is pushed once')

      // And the fire is durable, recorded once.
      const fired = (await ledger.runHeadLedger({ subverb: 'fired' })).split('\n').filter(line => line.includes(appearing) && line.includes('[new]'))
      assert.equal(fired.length, 1, `one new leaf fires once, not ${fired.length}`)
    } finally {
      remove()
    }
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    await rm(directory, { recursive: true, force: true })
  }
})
