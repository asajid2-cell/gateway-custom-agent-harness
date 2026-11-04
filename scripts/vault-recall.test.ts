import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { admitGeneration } from '../src/utils/vault/journal.js'
import { ftsExpression, recall } from '../src/utils/vault/recall.js'
import { submitProposals, type Proposal } from '../src/utils/vault/submit.js'

const FAMILY = 'fam-1'

function proposal(overrides: Partial<Proposal>): Proposal {
  return {
    event_id: 'e1',
    kind: 'decision',
    topic_id: 'relay',
    actor: 'sess-1',
    authority: 'user_ruling',
    evidence_status: 'direct',
    summary: 'placeholder',
    recorded_at: '2026-11-04T10:00:00.000Z',
    capture_version: 'scribe-0.1.0',
    proposed_by: 'sess-scribe-1',
    ...overrides,
  } as Proposal
}

async function vault(proposals: Proposal[], extra = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'vault-recall-'))
  await admitGeneration(root, FAMILY, { kind: 'admission', generation_id: 'gen-1' })
  const result = await submitProposals({ vaultRoot: root, familyId: FAMILY, generation: 'gen-1', proposals })
  assert.equal(result.rejected.length, 0, JSON.stringify(result.rejected))
  if ((extra as { obligations?: string }).obligations) {
    await writeFile(path.join(root, 'families', FAMILY, 'obligations.jsonl'), (extra as { obligations: string }).obligations)
  }
  return root
}

test('the FTS expression quotes significant terms and cannot inject syntax', () => {
  assert.equal(ftsExpression('relay "onion" OR *'), '"relay" OR "onion"')
  assert.equal(ftsExpression('   '), '')
  assert.equal(ftsExpression('a'), '')
  // The question's grammar must not build the match set: "the" and "is" are
  // stopwords, so they never reach FTS.
  assert.equal(ftsExpression('what is the relay'), '"relay"')
})

test('a decision is returned as current with the fields the gate checks', async () => {
  const root = await vault([
    proposal({ event_id: 'd1', summary: 'we ship build 30 and strip the relay onion', topic_id: 'release' }),
  ])
  try {
    const packet = await recall({ vaultRoot: root, familyId: FAMILY, query: 'relay onion' })
    assert.equal(packet.current.length, 1)
    const item = packet.current[0]!
    assert.equal(item.event_id, 'd1')
    assert.equal(item.kind, 'decision')
    assert.equal(item.status, 'validated')
    assert.equal(item.authority, 'user_ruling')
    assert.equal(item.topic_id, 'release')
    assert.ok(item.citations.length >= 1)
    assert.equal(packet.nothing_recorded, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a correction supersedes the older decision: current excludes it, history keeps the relation', async () => {
  const root = await vault([
    proposal({ event_id: 'old', summary: 'the relay stays on build 29', topic_id: 'release' }),
    proposal({
      event_id: 'new',
      kind: 'correction',
      summary: 'correction: the relay moves to build 30',
      topic_id: 'release',
      recorded_at: '2026-11-04T12:00:00.000Z',
      relations: [{ type: 'supersedes', target_event_id: 'old' }],
    }),
  ])
  try {
    const packet = await recall({ vaultRoot: root, familyId: FAMILY, query: 'relay build' })
    assert.deepEqual(packet.current.map(item => item.event_id), ['new'])
    const old = packet.history.find(item => item.event_id === 'old')
    assert.ok(old, 'the superseded event stays in history')
    assert.deepEqual(old.superseded_by, ['new'], 'history names what superseded it')
    const keeper = [...packet.current, ...packet.history].find(item => item.event_id === 'new')!
    assert.equal(
      (keeper.relations[0] as { type: string }).type,
      'supersedes',
      'the superseding relation must be visible to the gate',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an expired observation never appears as current state', async () => {
  const root = await vault([
    proposal({
      event_id: 'obs',
      kind: 'observation',
      class: 'live',
      summary: 'gateway pid 31212 is serving on port 33245',
      topic_id: 'fleet',
      authority: 'verified_artifact',
      observed_at: '2026-11-04T09:00:00.000Z',
      expires_at: '2026-11-04T11:00:00.000Z',
    }),
  ])
  try {
    const packet = await recall({
      vaultRoot: root,
      familyId: FAMILY,
      query: 'gateway port',
      filters: { asOf: '2026-11-04T12:00:00.000Z' },
    })
    assert.equal(packet.current.length, 0)
    assert.equal(packet.history[0]?.event_id, 'obs')
    assert.equal(packet.history[0]?.class, 'expired')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('authority outranks rank and there is no recency term', async () => {
  const root = await vault([
    proposal({
      event_id: 'ruling',
      summary: 'retire gateway-opencode-deepseek-v4.1-flash',
      topic_id: 'models',
      authority: 'user_ruling',
      recorded_at: '2026-11-01T00:00:00.000Z',
    }),
    proposal({
      event_id: 'guess',
      kind: 'finding',
      summary: 'gateway-opencode-deepseek-v4.1-flash retire maybe',
      topic_id: 'models',
      authority: 'agent_inference',
      recorded_at: '2026-11-04T00:00:00.000Z',
    }),
  ])
  try {
    const packet = await recall({ vaultRoot: root, familyId: FAMILY, query: 'gateway-opencode-deepseek-v4.1-flash retire' })
    assert.equal(packet.current[0]?.event_id, 'ruling')
    assert.equal(packet.current[1]?.event_id, 'guess')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a topic alias resolves to the topic id', async () => {
  const root = await vault([
    proposal({
      event_id: 'topic-1',
      kind: 'topic',
      topic_op: 'create',
      definition: 'Release gates and build numbers',
      topic_id: 'release',
    }),
    proposal({ event_id: 'd1', summary: 'build 30 ships', topic_id: 'release' }),
  ])
  try {
    const packet = await recall({ vaultRoot: root, familyId: FAMILY, query: 'release gates' })
    assert.equal(packet.current[0]?.event_id, 'd1')
    assert.equal(packet.current[0]?.topic_id, 'release')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('nothing recorded is said explicitly, and obligations are reported', async () => {
  const root = await vault(
    [proposal({ event_id: 'd1', summary: 'relay ships', topic_id: 'release' })],
    {
      obligations:
        `${JSON.stringify({ obligation_id: 'ob-old', kind: 'decision', state: 'pending', created_at: '2026-11-01T00:00:00.000Z' })}\n` +
        `${JSON.stringify({ obligation_id: 'ob-done', state: 'satisfied', created_at: '2026-11-01T00:00:00.000Z' })}\n`,
    },
  )
  try {
    const packet = await recall({ vaultRoot: root, familyId: FAMILY, query: 'p99 latency percentile' })
    assert.equal(packet.nothing_recorded, true)
    assert.deepEqual(packet.current, [])
    assert.deepEqual(packet.obligations.pending.map(row => row.obligation_id), ['ob-old'])
    assert.deepEqual(packet.obligations.overdue.map(row => row.obligation_id), ['ob-old'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('supersession is followed from the answering event, not from term coverage', async () => {
  const root = await vault([
    proposal({ event_id: 'old', summary: 'opencode route removed', topic_id: 'ops' }),
    proposal({
      event_id: 'new',
      kind: 'correction',
      summary: 'opencode route retired because the key expired',
      topic_id: 'ops',
      recorded_at: '2026-11-04T12:00:00.000Z',
      relations: [{ type: 'supersedes', target_event_id: 'old' }],
    }),
  ])
  try {
    const packet = await recall({ vaultRoot: root, familyId: FAMILY, query: 'why did the opencode route get retired' })
    assert.deepEqual(packet.current.map(item => item.event_id), ['new'])
    const old = packet.history.find(item => item.event_id === 'old')
    assert.ok(old, 'the target of an answering supersession must be in history even without the words')
    assert.deepEqual(old.superseded_by, ['new'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a term match that does not answer the question lands in candidates, not current', async () => {
  const root = await vault([
    proposal({ event_id: 'r1', summary: 'the relay stays on build 29', topic_id: 'release' }),
  ])
  try {
    const packet = await recall({ vaultRoot: root, familyId: FAMILY, query: 'what is the p99 relay latency' })
    assert.deepEqual(packet.current, [], 'an unanswerable question must not put anything in current')
    assert.equal(packet.nothing_recorded, true)
    assert.deepEqual(packet.candidates.map(item => item.event_id), ['r1'], 'the weak match is still shown, as a candidate')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a superseded weak match is a candidate, never history', async () => {
  const root = await vault([
    proposal({ event_id: 'old-route', summary: 'the opencode route key expired during the migration', topic_id: 'ops' }),
    proposal({
      event_id: 'new-route',
      kind: 'correction',
      summary: 'route migration completed',
      topic_id: 'ops',
      recorded_at: '2026-11-04T12:00:00.000Z',
      relations: [{ type: 'supersedes', target_event_id: 'old-route' }],
    }),
  ])
  try {
    const packet = await recall({ vaultRoot: root, familyId: FAMILY, query: 'what is the p99 relay latency' })
    assert.deepEqual(packet.current, [])
    assert.deepEqual(packet.history, [], 'a superseded event that does not answer must not fill history')
    assert.equal(packet.nothing_recorded, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a question about a file that was never recorded is not answered by a mention of the word', async () => {
  const root = await vault([
    proposal({ event_id: 'v1', summary: 'the vault topics are stored under topics.json', topic_id: 'release' }),
  ])
  try {
    const packet = await recall({
      vaultRoot: root,
      familyId: FAMILY,
      query: "what is the contents of the vault's topics file",
    })
    assert.deepEqual(packet.current, [])
    assert.equal(packet.nothing_recorded, true)
    assert.ok(packet.candidates.length >= 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the same query twice returns byte-identical packets', async () => {
  const root = await vault([
    proposal({ event_id: 'a', summary: 'relay alpha', topic_id: 'release' }),
    proposal({ event_id: 'b', summary: 'relay beta', topic_id: 'release' }),
  ])
  try {
    const at = '2026-11-05T00:00:00.000Z'
    const first = await recall({ vaultRoot: root, familyId: FAMILY, query: 'relay', filters: { asOf: at } })
    const second = await recall({ vaultRoot: root, familyId: FAMILY, query: 'relay', filters: { asOf: at } })
    assert.equal(JSON.stringify(first), JSON.stringify(second))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
