import { test, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addLeafMember } from '../src/utils/leafFamily.ts'

// Pinned like leaf-family.test.ts: launched by a leaf, the inherited identity
// changes what the workspace calls mean, so the file says the same thing
// wherever it is launched and puts the identity back for what runs next.
const ambientLeafIdentity = process.env.GATEWAY_INTERACTIVE_LEAF
delete process.env.GATEWAY_INTERACTIVE_LEAF
after(() => {
  if (ambientLeafIdentity === undefined) delete process.env.GATEWAY_INTERACTIVE_LEAF
  else process.env.GATEWAY_INTERACTIVE_LEAF = ambientLeafIdentity
})

test('the ledger home is a pure function of the family id', async () => {
  const ledger = await import('../src/utils/headLedger.ts')
  const a = ledger.headLedgerDir('11111111-1111-1111-1111-111111111111')
  const b = ledger.headLedgerDir('11111111-1111-1111-1111-111111111111')
  const c = ledger.headLedgerDir('22222222-2222-2222-2222-222222222222')
  assert.equal(a, b, 'the same family id always maps to the same home')
  assert.notEqual(a, c, 'a different family id maps elsewhere')
  // The home is derivable without reading anything: the tail is the family id.
  assert.match(a, /leaf-families[\\/]ledger[\\/]11111111-1111-1111-1111-111111111111$/)
  assert.equal(ledger.headLedgerViewPath('x'), join(ledger.headLedgerDir('x'), 'ledger.md'))
})

test('the ledger folds its events into a rendered view', async () => {
  const { renderHeadLedger, currentWatches } = await import('../src/utils/headLedger.ts')
  const at = '2026-10-11T00:00:00.000Z'
  const who = '11111111-1111-1111-1111-111111111111'
  const mate = '22222222-2222-2222-2222-222222222222'
  const events = [
    { version: 1 as const, kind: 'note' as const, at, by: who, text: 'Began the merge lane.' },
    { version: 1 as const, kind: 'decision' as const, at, by: who, text: 'Land on main only.' },
    { version: 1 as const, kind: 'handoff' as const, at, by: who, to: mate, text: 'Take the harness.' },
    { version: 1 as const, kind: 'watch' as const, at, by: who, to: mate, mode: 'idle' as const, on: true },
    { version: 1 as const, kind: 'watch-fired' as const, at, by: who, to: mate, mode: 'idle' as const, detail: 'idle' },
  ]
  const markdown = renderHeadLedger('family-1', events)
  assert.match(markdown, /^# Head ledger - family family-1$/m)
  assert.match(markdown, /## Record/)
  assert.match(markdown, /\[note\] Began the merge lane\./)
  assert.match(markdown, /\[handoff -> 22222222-2222-2222-2222-222222222222\] Take the harness\./)
  // The watcher registrations are folded, not listed as record entries.
  assert.match(markdown, /## Watchers\n\n- idle: 22222222-2222-2222-2222-222222222222/)
  assert.match(markdown, /## Fired\n\n- 2026-10-11T00:00:00\.000Z \[idle\] 22222222-2222-2222-2222-222222222222/)
  assert.deepEqual(currentWatches(events), [{ to: mate, mode: 'idle' }])
  // A watch turned off is not current, and a fold keeps only the last word.
  const off = [...events, { version: 1 as const, kind: 'watch' as const, at, by: who, to: mate, mode: 'idle' as const, on: false }]
  assert.deepEqual(currentWatches(off), [])
})

test('the watcher fires on an idle flip and on a new member', async () => {
  const { idleFlips, newMembers } = await import('../src/utils/headLedger.ts')
  const prev = new Map([['a', 'running'], ['b', 'idle'], ['c', 'running']])
  const now = new Map([['a', 'idle'], ['b', 'idle'], ['c', 'idle']])
  // Only the member that CROSSED into idle fires: b was already idle, and a
  // member the head is not watching never fires at all.
  assert.deepEqual(idleFlips(prev, now, ['a', 'b']), ['a'])
  assert.deepEqual(idleFlips(prev, now, ['c']), ['c'])
  assert.deepEqual(newMembers(new Set(['x', 'y']), new Set(['y', 'z'])), ['z'])
})

test('the ledger writes a JSONL source and a rendered view', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'head-ledger-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  try {
    const { getSessionId } = await import('../src/bootstrap/state.ts')
    const { getClaudeConfigHomeDir } = await import('../src/utils/envUtils.ts')
    const ledger = await import('../src/utils/headLedger.ts')
    const root = getSessionId()
    await ledger.appendHeadLedgerEvent(root, { kind: 'note', text: 'First line.' })
    const eventsFile = join(getClaudeConfigHomeDir(), 'leaf-families', 'ledger', root, 'ledger.jsonl')
    const viewFile = join(getClaudeConfigHomeDir(), 'leaf-families', 'ledger', root, 'ledger.md')
    const events = await ledger.readHeadLedgerEvents(root)
    assert.equal(events.length, 1)
    assert.equal(events[0]!.kind, 'note')
    assert.match(await readFile(eventsFile, 'utf8'), /"kind":"note","text":"First line."/)
    assert.match(await readFile(viewFile, 'utf8'), /\[note\] First line\./, 'the Markdown view is rendered from the source')
    // The structured source is the source and the Markdown is derived: a second
    // append extends both, and the view is regenerated from the events.
    await ledger.appendHeadLedgerEvent(root, { kind: 'decision', text: 'Second line.' })
    assert.equal((await ledger.readHeadLedgerEvents(root)).length, 2)
    const view = await readFile(viewFile, 'utf8')
    assert.match(view, /First line\./)
    assert.match(view, /\[decision\] Second line\./)
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    await rm(directory, { recursive: true, force: true })
  }
})

test('only the head writes the ledger, but any member reads it', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'head-ledger-gate-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  try {
    const { getSessionId, getSessionProjectDir, getSessionResumeDirectory, switchSession } = await import('../src/bootstrap/state.ts')
    const { asSessionId } = await import('../src/types/ids.ts')
    const workspace = await import('../src/utils/leafWorkspace.ts')
    const ledger = await import('../src/utils/headLedger.ts')
    const root = getSessionId()
    const family = join(directory, 'leaf-families', `${root}.json`)
    const member = await addLeafMember(family, root, { sessionId: randomUUID(), parentSessionId: root, name: 'Member', transcriptPath: join(directory, 'member.jsonl'), forkMessageId: randomUUID() })
    await workspace.restoreLeafWorkspace()

    // The creator is the head with nothing designated, so it may write.
    await ledger.appendHeadLedgerEvent(root, { kind: 'note', text: 'From the head.' })

    // A member is not the head: the write is refused, and the refusal names why.
    const projectDir = getSessionProjectDir()
    const resumeDirectory = getSessionResumeDirectory()
    switchSession(asSessionId(member.sessionId), null, directory)
    workspace.forgetLeafFamilyRoot()
    try {
      await assert.rejects(ledger.runHeadLedger({ subverb: 'note', text: 'Not mine to write.' }), /Only the family head/)
      const shown = await ledger.runHeadLedger({ subverb: 'show' })
      assert.match(shown, /From the head\./, 'a member reads the head record')
    } finally {
      switchSession(asSessionId(root), projectDir, resumeDirectory)
      workspace.forgetLeafFamilyRoot()
    }
    // And the ledger was not written into the family file: the source lives in
    // its own collection, so no on-disk family shape changed.
    assert.equal(await stat(join(directory, 'leaf-families', 'ledger', root, 'ledger.jsonl')).then(() => true), true)
    const familyShape = JSON.parse(await readFile(family, 'utf8')) as Record<string, unknown>
    assert.deepEqual(Object.keys(familyShape).sort(), ['members', 'nextNumber', 'returnedContextIds', 'rootSessionId', 'version'], 'the family file gained no ledger field')
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    await rm(directory, { recursive: true, force: true })
  }
})
