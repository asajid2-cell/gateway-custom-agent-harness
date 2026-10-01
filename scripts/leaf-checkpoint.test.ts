import { test, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addLeafMember, type LeafMember } from '../src/utils/leafFamily.ts'
import { createFork } from '../src/commands/branch/branch.ts'
import { LeafProcess } from '../src/utils/leafProcess.ts'
import { getCwd } from '../src/utils/cwd.ts'
import { checkpointDir, checkpointTranscriptPath, findCheckpoint } from '../src/utils/leafCheckpoints.ts'

/**
 * What this file is about decides the environment it runs in - the same reason
 * the family suite pins it. A case here drives the checkpoint surface from the
 * session side; launched by a leaf it would inherit that identity and answer
 * "Leaf workspace disconnected" instead. Pin it, and put it back afterwards.
 */
const ambientLeafIdentity = process.env.GATEWAY_INTERACTIVE_LEAF
delete process.env.GATEWAY_INTERACTIVE_LEAF
after(() => {
  if (ambientLeafIdentity === undefined) delete process.env.GATEWAY_INTERACTIVE_LEAF
  else process.env.GATEWAY_INTERACTIVE_LEAF = ambientLeafIdentity
})

type Turn = { uuid: string; parentUuid: string | null; text: string }

/** A transcript file as the write path leaves it, one chain entry per line. */
function transcriptLines(sessionId: string, turns: readonly Turn[]): string {
  return turns
    .map(turn => JSON.stringify({
      type: 'user', uuid: turn.uuid, parentUuid: turn.parentUuid, sessionId, isSidechain: false,
      message: { role: 'user', content: turn.text }, timestamp: '2026-09-14T10:22:00.000Z',
    }))
    .join('\n') + '\n'
}

type Fixture = { directory: string; root: string; finish: () => Promise<void> }

/** A fresh config directory, so every case owns its family and its checkpoints. */
async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'leaf-checkpoint-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  const { getSessionId } = await import('../src/bootstrap/state.ts')
  const { forgetLeafFamilyRoot, clearMatriarchClaimForTesting } = await import('../src/utils/leafWorkspace.ts')
  forgetLeafFamilyRoot()
  clearMatriarchClaimForTesting()
  return {
    directory,
    root: getSessionId(),
    finish: async () => {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = saved
      await rm(directory, { recursive: true, force: true })
    },
  }
}

/** A member with a transcript on disk, which is all a checkpoint needs. */
async function memberWith(directory: string, root: string, name: string, turns: readonly Turn[]): Promise<{ member: LeafMember; transcript: string }> {
  const transcript = join(directory, `${name.toLowerCase()}.jsonl`)
  const member = await addLeafMember(join(directory, 'leaf-families', `${root}.json`), root, {
    sessionId: randomUUID(), parentSessionId: root, name, transcriptPath: transcript, forkMessageId: randomUUID(),
  })
  await writeFile(transcript, transcriptLines(member.sessionId, turns))
  return { member, transcript }
}

test('a checkpoint freezes a conversation, and taking the same tip twice saves nothing new', async () => {
  const { directory, root, finish } = await fixture()
  try {
    const { checkpointLeaf, listLeafCheckpoints } = await import('../src/utils/leafWorkspace.ts')
    const { member } = await memberWith(directory, root, 'Probe', [{ uuid: 'a1', parentUuid: null, text: 'FIRST_TURN' }])

    const taken = await checkpointLeaf(String(member.number))
    assert.match(taken, /Checkpoint #1 probe/, 'the number is the identity and the label is the mnemonic')
    assert.match(taken, /1 turns · /, 'the snapshot counts the turns it saw')
    assert.match(taken, /Branch it any time with `\/leaf fork #1`/)

    // The id is derived from the frozen tip, so a second snapshot of an unchanged
    // conversation is the checkpoint that already exists, not a second number.
    const again = await checkpointLeaf(String(member.number))
    assert.match(again, /already covers this conversation; nothing new was saved/)

    const frozen = await findCheckpoint(root, '#1')
    assert.equal(frozen?.sourceTip, 'a1')
    assert.equal(frozen?.sourceName, 'Probe')
    assert.equal(frozen?.familyId, root)
    assert.match(await readFile(checkpointTranscriptPath(root, frozen!.id), 'utf8'), /FIRST_TURN/)

    const listed = await listLeafCheckpoints()
    assert.match(listed, /checkpoints for family/)
    assert.equal(listed.split('\n').filter(line => line.startsWith('#1 ')).length, 1, 'one checkpoint, listed once')
  } finally { await finish() }
})

test('ordinals are monotonic and never reused, and identical labels stay distinct', async () => {
  const { directory, root, finish } = await fixture()
  try {
    const { checkpointLeaf, listLeafCheckpoints, dropLeafCheckpoint } = await import('../src/utils/leafWorkspace.ts')
    const turns: Turn[] = [{ uuid: 'a1', parentUuid: null, text: 'FIRST_TURN' }]
    const { member, transcript } = await memberWith(directory, root, 'Probe', turns)

    await checkpointLeaf(String(member.number), 'Auth Split!')
    assert.equal((await findCheckpoint(root, '#1'))?.label, 'auth-split', 'a supplied label is slugged so it can be typed back')

    turns.push({ uuid: 'b2', parentUuid: 'a1', text: 'SECOND_TURN' })
    await writeFile(transcript, transcriptLines(member.sessionId, turns))
    await checkpointLeaf(String(member.number), 'auth-split')

    assert.equal((await findCheckpoint(root, '#1'))?.label, 'auth-split')
    assert.equal((await findCheckpoint(root, '#2'))?.label, 'auth-split', 'a duplicate label is a name, not an identity')
    await assert.rejects(findCheckpoint(root, 'auth-split'), /Ambiguous checkpoint/, 'a label that names two is refused, not guessed')

    // Dropping #2 frees the label but never the number it was given.
    await dropLeafCheckpoint('#2')
    assert.equal(await findCheckpoint(root, '#2'), undefined, 'a dropped checkpoint is no longer a target')
    assert.equal((await findCheckpoint(root, '#2', { includeDropped: true }))?.ordinal, 2, 'its history keeps its number')
    assert.equal((await findCheckpoint(root, 'auth-split'))?.ordinal, 1, 'the surviving name answers again')
    assert.doesNotMatch(await listLeafCheckpoints(), /#2 /)

    turns.push({ uuid: 'c3', parentUuid: 'b2', text: 'THIRD_TURN' })
    await writeFile(transcript, transcriptLines(member.sessionId, turns))
    const third = await checkpointLeaf(String(member.number))
    assert.match(third, /Checkpoint #3 /, 'a new snapshot takes the next number, never the one a dropped checkpoint holds')

    // Every frozen copy holds the tip it froze, not the conversation as it stands later.
    const one = (await findCheckpoint(root, '#1'))!
    const three = (await findCheckpoint(root, '#3'))!
    const first = await readFile(checkpointTranscriptPath(root, one.id), 'utf8')
    assert.match(first, /FIRST_TURN/)
    assert.doesNotMatch(first, /SECOND_TURN/)
    assert.match(await readFile(checkpointTranscriptPath(root, three.id), 'utf8'), /THIRD_TURN/)
  } finally { await finish() }
})

test('a branch from a checkpoint copies the frozen conversation, not the source as it stands now', async () => {
  const { directory, root, finish } = await fixture()
  try {
    const { checkpointLeaf, checkpointSource } = await import('../src/utils/leafWorkspace.ts')
    const first: Turn[] = [{ uuid: 'a1', parentUuid: null, text: 'FIRST_TURN' }]
    const { member, transcript } = await memberWith(directory, root, 'Probe', first)
    await checkpointLeaf(String(member.number))

    // The member keeps working; the snapshot must not follow it.
    const later: Turn[] = [...first, { uuid: 'b2', parentUuid: 'a1', text: 'AFTER_THE_SNAPSHOT' }]
    await writeFile(transcript, transcriptLines(member.sessionId, later))

    const source = await checkpointSource('#1')
    assert.equal(source.sessionId, member.sessionId)
    const frozen = await readFile(source.transcriptPath, 'utf8')
    assert.match(frozen, /FIRST_TURN/)
    assert.doesNotMatch(frozen, /AFTER_THE_SNAPSHOT/)

    // Exactly what createLeaf hands to createFork for `/leaf fork #1`.
    const fork = await createFork(undefined, { sessionId: source.sessionId, transcriptPath: source.transcriptPath })
    assert.equal(fork.serializedMessages.at(-1)?.uuid, 'a1', 'the branch starts at the frozen tip')
    const copied = await readFile(fork.forkPath, 'utf8')
    assert.match(copied, /FIRST_TURN/)
    assert.doesNotMatch(copied, /AFTER_THE_SNAPSHOT/)

    await writeFile(transcript, transcriptLines(member.sessionId, [...later, { uuid: 'c3', parentUuid: 'b2', text: 'MUCH_LATER' }]))
    assert.doesNotMatch(await readFile(fork.forkPath, 'utf8'), /MUCH_LATER/, 'a branch is a copy, not a view of the source')

    await assert.rejects(checkpointSource('no-such-checkpoint'), /Unknown checkpoint/)
  } finally { await finish() }
})

test('dropping keeps the bytes, purging deletes them, and a branch survives both', async () => {
  const { directory, root, finish } = await fixture()
  try {
    const { checkpointLeaf, dropLeafCheckpoint, purgeLeafCheckpoint, listLeafCheckpoints } = await import('../src/utils/leafWorkspace.ts')
    const { member } = await memberWith(directory, root, 'Probe', [{ uuid: 'a1', parentUuid: null, text: 'FIRST_TURN' }])
    await checkpointLeaf(String(member.number))
    const entry = (await findCheckpoint(root, '#1'))!
    const frozenPath = checkpointTranscriptPath(root, entry.id)
    const metadataPath = join(checkpointDir(root), `${entry.id}.json`)
    const branch = await createFork(undefined, { sessionId: member.sessionId, transcriptPath: frozenPath })

    assert.match(await dropLeafCheckpoint('#1'), /dropped/)
    await access(frozenPath)
    await access(metadataPath)

    await assert.rejects(purgeLeafCheckpoint('#2'), /Unknown checkpoint/, 'a number nobody holds is not a purge target')
    assert.match(await purgeLeafCheckpoint('#1'), /purged/)
    await assert.rejects(access(frozenPath), undefined, 'the bytes are gone')
    await assert.rejects(access(metadataPath))
    assert.equal(await findCheckpoint(root, '#1', { includeDropped: true }), undefined, 'a purged checkpoint leaves the index too')
    assert.match(await listLeafCheckpoints(), /No checkpoints for family/)

    assert.match(await readFile(branch.forkPath, 'utf8'), /FIRST_TURN/, 'the branch taken before the purge is untouched')
  } finally { await finish() }
})

test('a checkpoint reference answers only while a live checkpoint holds it', async () => {
  const { directory, root, finish } = await fixture()
  try {
    const { checkpointLeaf, dropLeafCheckpoint, isCheckpointReference } = await import('../src/utils/leafWorkspace.ts')
    const { member } = await memberWith(directory, root, 'Probe', [{ uuid: 'a1', parentUuid: null, text: 'FIRST_TURN' }])
    await checkpointLeaf(String(member.number), 'probe')

    assert.equal(await isCheckpointReference('#1'), true, 'a numbered checkpoint is a branch point')
    assert.equal(await isCheckpointReference('1'), true, 'so is its bare number')
    assert.equal(await isCheckpointReference('probe'), true, 'so is its label')
    assert.equal(await isCheckpointReference('no-such-checkpoint'), false)
    assert.equal(await isCheckpointReference(''), false)

    // A dropped checkpoint stops answering, which is what keeps `/leaf fork probe`
    // from reading as "fork a branch of probe" when nothing is offered under it.
    await dropLeafCheckpoint('#1')
    assert.equal(await isCheckpointReference('probe'), false)
    assert.equal(await isCheckpointReference('#1'), false)
  } finally { await finish() }
})

/**
 * A leaf with a live terminal the test answers, so a request can travel the same
 * relay a leaf's `leaf-request` message takes in production. Spawning a CLI is
 * the thing being replaced here, not the path being tested.
 */
function parkedProcess(responses: { type: string; ok?: boolean; value?: unknown }[]): LeafProcess {
  const leaf = new LeafProcess({
    executable: process.execPath, args: [], cwd: getCwd(), env: {},
    onEvent: () => {}, onState: () => {}, interactive: true,
  }) as LeafProcess & { child: unknown; setState: (state: string) => void }
  leaf.child = { connected: true, send: (_message: unknown, callback?: (error?: Error) => void) => { callback?.() } }
  leaf.setState('idle')
  ;(leaf as unknown as { terminal: (message: unknown) => void }).terminal = message => { responses.push(message as never) }
  return leaf
}

test('a leaf asking about a sibling is answered by the host, not from its own view', async () => {
  const { directory, root, finish } = await fixture()
  try {
    const {
      registerLeafViewForTesting, dispatchLeafRequestForTesting, listLeafCheckpoints,
    } = await import('../src/utils/leafWorkspace.ts')
    const asker = await memberWith(directory, root, 'Asker', [{ uuid: 'q1', parentUuid: null, text: 'ASKER_TURN' }])
    const sibling = await memberWith(directory, root, 'Sibling', [{ uuid: 's1', parentUuid: null, text: 'SIBLING_WORK' }])
    const responses: { type: string; ok?: boolean; value?: unknown }[] = []
    const unregister = registerLeafViewForTesting({ rootSessionId: root, member: asker.member, process: parkedProcess(responses), draft: '' })
    const reply = () => responses.filter(item => item.type === 'leaf-response').at(-1)
    try {
      // The sibling's chat. A leaf holds no member list and no transcript paths,
      // so this answer can only come back from the host that holds them.
      await dispatchLeafRequestForTesting(asker.member.sessionId, root, 'read', ['Sibling', {}])
      const chat = reply()
      assert.equal(chat?.ok, true, 'the sibling read is answered, not refused')
      assert.match(String(chat?.value), /SIBLING_WORK/, 'and it carries the sibling chat')
      assert.doesNotMatch(String(chat?.value), /ASKER_TURN/, 'never the asking leaf own conversation')

      // The family at a glance, with no reference: every member is summarised.
      await dispatchLeafRequestForTesting(asker.member.sessionId, root, 'read', [undefined, {}])
      const digest = String(reply()?.value)
      assert.match(digest, /^family /m)
      assert.match(digest, /Asker/)
      assert.match(digest, /Sibling/)

      // A checkpoint taken from inside a leaf is taken host-side too, where the
      // member's transcript path and its flush live.
      await dispatchLeafRequestForTesting(asker.member.sessionId, root, 'checkpoint', [sibling.member.sessionId, 'relay-snap'])
      assert.match(String(reply()?.value), /Checkpoint #1 relay-snap/, 'the host takes the snapshot and reports the number')
      assert.equal((await findCheckpoint(root, '#1'))?.sourceSessionId, sibling.member.sessionId, 'frozen from the member the leaf named')
      assert.match(await listLeafCheckpoints(), /#1 relay-snap/)
    } finally { unregister() }
  } finally { await finish() }
})
