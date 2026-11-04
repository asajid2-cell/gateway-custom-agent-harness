import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { admitGeneration, readJournal } from '../src/utils/vault/journal.js'
import { submitProposals, validateProposal, type Proposal } from '../src/utils/vault/submit.js'

const FAMILY = 'fam-1'

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    event_id: 'e1',
    kind: 'decision',
    topic_id: 'topic-1',
    actor: 'sess-1',
    authority: 'user_ruling',
    evidence_status: 'direct',
    summary: 'ship it',
    recorded_at: '2026-11-05T00:00:00.000Z',
    capture_version: 'scribe-0.1.0',
    proposed_by: 'sess-scribe-1',
    ...overrides,
  } as Proposal
}

async function seeded(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'vault-submit-'))
  await admitGeneration(root, FAMILY, { kind: 'admission', generation_id: 'gen-1' })
  return root
}

test('a valid proposal commits with the generation stamped and a writer hash', async () => {
  const root = await seeded()
  try {
    const result = await submitProposals({
      vaultRoot: root,
      familyId: FAMILY,
      generation: 'gen-1',
      proposals: [proposal()],
    })
    assert.equal(result.rejected.length, 0, JSON.stringify(result.rejected))
    assert.equal(result.committed.length, 1)
    const event = result.committed[0]!
    assert.equal(event.generation_id, 'gen-1')
    assert.equal(event.sequence, 1)
    assert.equal(event.family_id, FAMILY)
    assert.match(String(event.content_hash), /^sha256:[0-9a-f]{64}$/)
    // The verdict and the identity are the writer's, and can never be the
    // proposer's own word.
    assert.equal(event.status, 'validated')
    assert.equal(event.committed_by, 'writer:gateway-vault/1')
    assert.notEqual(event.committed_by, event.proposed_by)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an absent generation refuses the whole submission', async () => {
  const root = await seeded()
  try {
    const result = await submitProposals({
      vaultRoot: root,
      familyId: FAMILY,
      generation: '   ',
      proposals: [proposal()],
    })
    assert.equal(result.committed.length, 0)
    assert.match(result.rejected[0]?.reason ?? '', /generation is required/)
    assert.equal((await readJournal(root, FAMILY)).events.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a proposal naming a different generation is rejected instead of being restamped', async () => {
  const root = await seeded()
  try {
    const result = await submitProposals({
      vaultRoot: root,
      familyId: FAMILY,
      generation: 'gen-1',
      proposals: [proposal({ generation_id: 'gen-0' })],
    })
    assert.equal(result.committed.length, 0)
    assert.match(result.rejected[0]?.reason ?? '', /does not match the submitted generation/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('structural validation names what is missing', () => {
  assert.deepEqual(validateProposal(proposal()), [])
  const missingTopic = validateProposal(proposal({ topic_id: '' }))
  assert.ok(missingTopic.some(reason => /topic_id is required/.test(reason)))
  const badKind = validateProposal(proposal({ kind: 'rumour' as never }))
  assert.ok(badKind.some(reason => /kind must be one of/.test(reason)))
  const badAuthority = validateProposal(proposal({ authority: 'because' as never }))
  assert.ok(badAuthority.some(reason => /authority must be one of/.test(reason)))
  const topicMerge = validateProposal(proposal({ kind: 'topic', topic_op: 'merge' }))
  assert.ok(topicMerge.some(reason => /merge needs merged_into/.test(reason)))
  const topicSplit = validateProposal(proposal({ kind: 'topic', topic_op: 'split' }))
  assert.ok(topicSplit.some(reason => /split needs split_into/.test(reason)))
  const noCapture = validateProposal(proposal({ capture_version: '' }))
  assert.ok(noCapture.some(reason => /capture_version is required/.test(reason)))
  const noProposer = validateProposal(proposal({ proposed_by: '' }))
  assert.ok(noProposer.some(reason => /proposed_by is required/.test(reason)))
})

test('a proposal that declares its own status is refused; the writer stamps it', async () => {
  const root = await seeded()
  try {
    const result = await submitProposals({
      vaultRoot: root,
      familyId: FAMILY,
      generation: 'gen-1',
      proposals: [proposal({ status: 'validated' } as never)],
    })
    assert.equal(result.committed.length, 0)
    assert.match(result.rejected[0]?.reason ?? '', /status is writer-owned/)
    assert.equal((await readJournal(root, FAMILY)).events.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the idempotency key makes a retried batch a replay, not a second commit', async () => {
  const root = await seeded()
  try {
    const request = {
      vaultRoot: root,
      familyId: FAMILY,
      generation: 'gen-1',
      idempotencyKey: 'batch-1',
      proposals: [proposal()],
    }
    const first = await submitProposals(request)
    assert.equal(first.committed.length, 1)
    assert.equal(first.replayed, false)

    const second = await submitProposals(request)
    assert.equal(second.replayed, true)
    assert.equal(second.committed.length, 0)
    assert.deepEqual(second.duplicates, ['e1'])
    assert.equal((await readJournal(root, FAMILY)).events.length, 1)

    const submissions = await readFile(path.join(root, 'families', FAMILY, 'submissions.jsonl'), 'utf8')
    assert.equal(submissions.trim().split('\n').length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a proposal closes only an obligation that exists, and records which event closed it', async () => {
  const root = await seeded()
  try {
    const obligations = path.join(root, 'families', FAMILY, 'obligations.jsonl')
    await writeFile(
      obligations,
      `${JSON.stringify({ obligation_id: 'ob-1', state: 'pending' })}\n${JSON.stringify({ obligation_id: 'ob-2', state: 'pending' })}\n`,
    )
    const result = await submitProposals({
      vaultRoot: root,
      familyId: FAMILY,
      generation: 'gen-1',
      proposals: [proposal({ obligationIds: ['ob-1', 'ob-does-not-exist'] })],
    })
    assert.equal(result.committed.length, 1)
    assert.deepEqual(result.obligationsSatisfied, ['ob-1'])

    const lines = (await readFile(obligations, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const closure = lines.find(line => line.state === 'satisfied')
    assert.equal(closure.obligation_id, 'ob-1')
    assert.deepEqual(closure.committed_event_ids, ['e1'])
    assert.equal(closure.event_hash, result.committed[0]!.content_hash)
    assert.equal(lines.filter(line => line.obligation_id === 'ob-does-not-exist').length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a forged content_hash is rejected through the submit seam too', async () => {
  const root = await seeded()
  try {
    const result = await submitProposals({
      vaultRoot: root,
      familyId: FAMILY,
      generation: 'gen-1',
      proposals: [proposal({ content_hash: 'sha256:forged' } as never)],
    })
    assert.equal(result.committed.length, 0)
    assert.match(result.rejected[0]?.reason ?? '', /content_hash is writer-owned/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a fenced generation is rejected by the writer, not by the caller', async () => {
  const root = await seeded()
  try {
    await admitGeneration(root, FAMILY, { kind: 'rotation', generation_id: 'gen-2' })
    const result = await submitProposals({
      vaultRoot: root,
      familyId: FAMILY,
      generation: 'gen-1',
      proposals: [proposal()],
    })
    assert.equal(result.committed.length, 0)
    assert.match(result.rejected[0]?.reason ?? '', /fenced; active is gen-2/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
