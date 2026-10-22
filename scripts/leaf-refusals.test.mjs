import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { z } from 'zod/v4'

/**
 * The refusals a caller actually meets, exercised with real calls against a
 * temporary family root - not regexes over the source.
 *
 * The family file is written under a `CLAUDE_CONFIG_DIR` the test owns, which
 * is the same seam `leaf-family.test.ts` and `leaf-read.test.ts` use. The live
 * `~/.claude/leaf-families` is never read or written.
 */
const ROOT = '11111111-1111-4111-8111-111111111111'
const AMBIGUOUS_A = '22222222-2222-4222-8222-222222222222'
const AMBIGUOUS_B = '33333333-3333-4333-8333-333333333333'
const CLOSED = '44444444-4444-4444-8444-444444444444'
const RUNNING = '55555555-5555-4555-8555-555555555555'

const member = (number, name, sessionId, status) => ({
  sessionId,
  parentSessionId: ROOT,
  number,
  name,
  transcriptPath: `C:/tmp/${sessionId}.jsonl`,
  forkMessageId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  status,
})

const family = {
  version: 1,
  rootSessionId: ROOT,
  nextNumber: 6,
  members: [
    member(2, 'api hardening', AMBIGUOUS_A, 'open'),
    member(3, 'api polish', AMBIGUOUS_B, 'open'),
    member(4, 'parked', CLOSED, 'closed'),
    member(5, 'busy', RUNNING, 'open'),
  ],
  returnedContextIds: [],
}

const directory = await mkdtemp(join(tmpdir(), 'leaf-refusals-'))
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = directory
await mkdir(join(directory, 'leaf-families'), { recursive: true })
await writeFile(join(directory, 'leaf-families', `${ROOT}.json`), JSON.stringify(family))

const workspace = await import('../src/utils/leafWorkspace.ts')
const { LeafTool } = await import('../src/tools/LeafTool/LeafTool.ts')
const { switchSession } = await import('../src/bootstrap/state.ts')

// The session on screen is the family's root, so every member in the fixture is
// one it may act on and no member is "the session asking".
switchSession(ROOT)
workspace.forgetLeafFamilyRoot()

after(async () => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  await rm(directory, { recursive: true, force: true })
})

test('the fixture family, not the live one, is what the workspace reads', async () => {
  assert.notEqual(join(directory, 'leaf-families'), join(homedir(), '.claude', 'leaf-families'))
  const listing = await workspace.listLeaves()
  assert.match(listing, /#2 api hardening/)
  assert.match(listing, /#4 parked/)
})

test('an ambiguous reference names the candidates and the spelling that picks one', async () => {
  await assert.rejects(
    LeafTool.call({ action: 'interrupt', leaf: 'api' }, {}),
    (error) => {
      assert.match(error.message, /is ambiguous/)
      assert.match(error.message, /#2 api hardening/)
      assert.match(error.message, /#3 api polish/)
      assert.match(error.message, new RegExp(AMBIGUOUS_A))
      assert.match(error.message, new RegExp(AMBIGUOUS_B))
      // The number offered is the bare one: `#2` is a checkpoint reference and
      // would fail again, which is the second wrong guess this message prevents.
      assert.match(error.message, /Use "2"/)
      return true
    },
  )
})

test('an unknown reference says so and names the discovery verb', async () => {
  await assert.rejects(
    LeafTool.call({ action: 'interrupt', leaf: 'typo-leaf' }, {}),
    (error) => {
      assert.match(error.message, /No member of this family matches "typo-leaf"/)
      assert.match(error.message, /action:"list"/)
      assert.match(error.message, /session ID/)
      return true
    },
  )
})

test('operating on a closed member names reopen and the exact call', async () => {
  await assert.rejects(
    LeafTool.call({ action: 'interrupt', leaf: '4' }, {}),
    (error) => {
      assert.match(error.message, /Leaf #4 parked is closed/)
      assert.match(error.message, /action:"reopen"/)
      assert.match(error.message, /"leaf":"4"/)
      return true
    },
  )
})

test('a setting on a running member names its state and both ways forward', async () => {
  const busy = family.members.find((entry) => entry.sessionId === RUNNING)
  const dispose = workspace.registerLeafViewForTesting({
    rootSessionId: ROOT,
    member: busy,
    draft: '',
    process: {
      getState: () => 'running',
      checkpoint: async () => {},
      compact: async () => {},
      setModel: async () => {},
      setEffort: async () => {},
    },
  })
  try {
    await assert.rejects(
      LeafTool.call({ action: 'model', leaf: '5', value: 'clair-4' }, {}),
      (error) => {
        assert.match(error.message, /Leaf #5 busy is running, not idle/)
        assert.match(error.message, /Wait for its turn to end/)
        assert.match(error.message, /action:"interrupt"/)
        assert.match(error.message, /"leaf":"5"/)
        assert.match(error.message, /can also be set later/)
        return true
      },
    )
  } finally {
    dispose()
  }
})

test('archiving a running member is refused with its state and the fix', async () => {
  const busy = family.members.find((entry) => entry.sessionId === RUNNING)
  const dispose = workspace.registerLeafViewForTesting({
    rootSessionId: ROOT,
    member: busy,
    draft: '',
    process: {
      getState: () => 'running',
      checkpoint: async () => {},
      compact: async () => {},
      setModel: async () => {},
      setEffort: async () => {},
      close: async () => {},
    },
  })
  try {
    await assert.rejects(
      LeafTool.call({ action: 'archive', leaf: '5' }, {}),
      (error) => {
        assert.match(error.message, /Leaf #5 busy is running, not idle, so it cannot be archived/)
        assert.match(error.message, /archiving closes its conversation/)
        assert.match(error.message, /action:"interrupt"/)
        assert.match(error.message, /"leaf":"5"/)
        return true
      },
    )
  } finally {
    dispose()
  }
})

test('archive files a member out of list, and reopen brings it back', async () => {
  const archived = await LeafTool.call({ action: 'archive', leaf: '2' }, {})
  assert.match(archived.data.result, /^Leaf #2 api hardening archived; transcript and ancestry retained\./)

  assert.doesNotMatch(await workspace.listLeaves(), /#2 api hardening/, 'archiving is what shortens list')
  // Archiving keeps the row addressable: reopen still resolves it.
  assert.match(await workspace.familyRoster(), /#2 api hardening/)

  // Reopening launches a member process. An idle view is the "already up" shape
  // `launchOnce` attaches to, so the round trip is exercised without a spawn.
  const dispose = workspace.registerLeafViewForTesting({
    rootSessionId: ROOT,
    member: family.members[0],
    draft: '',
    process: {
      getState: () => 'idle',
      checkpoint: async () => {},
      compact: async () => {},
      setModel: async () => {},
      setEffort: async () => {},
      close: async () => {},
    },
  })
  try {
    const reopened = await LeafTool.call({ action: 'reopen', leaf: '2' }, {})
    assert.match(reopened.data.result, /^Leaf #2 api hardening reopened; transcript and ancestry retained\./)
  } finally {
    dispose()
  }

  assert.match(await workspace.listLeaves(), /#2 api hardening/, 'reopen puts the row back in list')
})

test('every caller refused by the same held writer lock is told why', async () => {
  // One held lock, more than one caller. The refusal used to be recorded in a
  // side map and deleted by whichever caller read it first, so the second
  // caller was handed "Writer claim was not taken" - a sentence that names
  // neither the state nor the move. Both callers here await the same attempt.
  const savedGateway = process.env.CLAUDE_CODE_USE_GATEWAY
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  const { lock } = await import('../src/utils/lockfile.ts')
  const { claimGatewaySessionWriter, releaseGatewaySessionWriter } = await import('../src/utils/gatewaySessionOwnership.ts')
  const sessionId = '66666666-6666-4666-8666-666666666666'
  await mkdir(join(directory, 'gateway-writers'), { recursive: true })
  const release = await lock(join(directory, 'gateway-writers', sessionId), { realpath: false, stale: 30000, retries: 0 })
  try {
    const outcomes = await Promise.allSettled([
      claimGatewaySessionWriter(sessionId),
      claimGatewaySessionWriter(sessionId),
    ])
    for (const outcome of outcomes) {
      assert.equal(outcome.status, 'rejected')
      const message = outcome.reason.message
      assert.match(message, /Another session is writing/)
      assert.match(message, /already being held/)
      assert.match(message, /Retry once that writer releases/)
      assert.doesNotMatch(message, /Writer claim was not taken/)
    }
    // A refused attempt is retired, so the next caller retries the lock rather
    // than replaying an old failure - and it is still held, so it is still told
    // why.
    await assert.rejects(claimGatewaySessionWriter(sessionId), /already being held/)
  } finally {
    await release()
    await releaseGatewaySessionWriter(sessionId)
    if (savedGateway === undefined) delete process.env.CLAUDE_CODE_USE_GATEWAY
    else process.env.CLAUDE_CODE_USE_GATEWAY = savedGateway
  }
})

test('a model passed as a top-level field is refused with the field that carries it', () => {
  const result = LeafTool.inputSchema.safeParse({ action: 'model', leaf: '5', model: 'clair-4' })
  assert.equal(result.success, false)
  assert.match(result.error.message, /`model` is not a top-level field/)
  assert.match(result.error.message, /`value`/)
  assert.match(result.error.message, /action:"model"/)
})

test('an effort passed as a top-level field is refused the same way', () => {
  const result = LeafTool.inputSchema.safeParse({ action: 'effort', leaf: '5', effort: 'high' })
  assert.equal(result.success, false)
  assert.match(result.error.message, /`effort` is not a top-level field/)
  assert.match(result.error.message, /action:"effort"/)
})

test('an action outside the enum lists the accepted actions', () => {
  const result = LeafTool.inputSchema.safeParse({ action: 'open' })
  assert.equal(result.success, false)
  assert.match(result.error.message, /`action` must be one of: list, status, fork/)
  assert.match(result.error.message, /received "open"/)
})

test('a valid call still parses, and the schema stays a serialisable zod object', () => {
  const result = LeafTool.inputSchema.safeParse({ action: 'model', leaf: '5', value: 'clair-4' })
  assert.equal(result.success, true)
  // The refusal text is layered on the same strict object the model-facing JSON
  // schema is generated from, so the field set and the action enum survive.
  const json = z.toJSONSchema(LeafTool.inputSchema)
  assert.equal(json.additionalProperties, false)
  assert.ok(json.properties.action.enum.includes('model'))
  assert.deepEqual(json.required, ['action'])
})
