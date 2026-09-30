import { test, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addLeafMember, type LeafMember } from '../src/utils/leafFamily.ts'
import { LeafProcess } from '../src/utils/leafProcess.ts'
import { getCwd } from '../src/utils/cwd.ts'

/**
 * These cases drive the merge surface from the session side, so pin the identity
 * the other leaf suites pin: a leaf process would answer "Leaf workspace
 * disconnected" instead, and none of this is about being a leaf.
 */
const ambientLeafIdentity = process.env.GATEWAY_INTERACTIVE_LEAF
delete process.env.GATEWAY_INTERACTIVE_LEAF
after(() => {
  if (ambientLeafIdentity === undefined) delete process.env.GATEWAY_INTERACTIVE_LEAF
  else process.env.GATEWAY_INTERACTIVE_LEAF = ambientLeafIdentity
})

type Turn = { uuid: string; parentUuid: string | null; text: string; role?: 'user' | 'assistant' | 'system'; summary?: boolean }

/** A transcript file as the write path leaves it, one chain entry per line. */
function transcriptLines(sessionId: string, turns: readonly Turn[]): string {
  return turns
    .map(turn => JSON.stringify({
      type: turn.role ?? 'user', uuid: turn.uuid, parentUuid: turn.parentUuid, sessionId, isSidechain: false,
      ...(turn.summary ? { isCompactSummary: true } : {}),
      message: { role: turn.role ?? 'user', content: turn.text }, timestamp: '2026-09-14T10:22:00.000Z',
    }))
    .join('\n') + '\n'
}

type Fixture = { directory: string; root: string; finish: () => Promise<void> }

/** A fresh config directory, so every case owns its family and its pointers. */
async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'leaf-merge-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  const { getSessionId } = await import('../src/bootstrap/state.ts')
  const { forgetLeafFamilyRoot, clearFamilyHostClaimForTesting } = await import('../src/utils/leafWorkspace.ts')
  forgetLeafFamilyRoot()
  clearFamilyHostClaimForTesting()
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

/** A member with a transcript on disk, which is all a merge needs of one. */
async function memberWith(directory: string, root: string, name: string, turns: readonly Turn[]): Promise<{ member: LeafMember; transcript: string }> {
  const transcript = join(directory, `${name.toLowerCase()}.jsonl`)
  const member = await addLeafMember(join(directory, 'leaf-families', `${root}.json`), root, {
    sessionId: randomUUID(), parentSessionId: root, name, transcriptPath: transcript, forkMessageId: randomUUID(),
  })
  await writeFile(transcript, transcriptLines(member.sessionId, turns))
  return { member, transcript }
}

/**
 * Write the loose per-session pointer the way a creation does, so the role a
 * merge reads is the same one production writes - not a stub of it.
 */
async function writePointer(root: string, sessionId: string, role: 'leaf' | 'seed' | 'seedling', seedOf?: string): Promise<void> {
  const { familyIndexDir, writeIndexFile } = await import('../src/utils/leafWorkspace.ts')
  await writeIndexFile(join(familyIndexDir(), `${sessionId}.json`), { rootSessionId: root, role, ...(seedOf ? { seedOf } : {}) })
}

/**
 * A member with a live terminal the test answers, so a merge travels the same
 * `leaf_prompt` control a real one does. `onPrompt` is where a case plays the
 * member's REPL running the injected turn.
 */
function listeningProcess(state: 'idle' | 'running', onPrompt: (prompt: string) => void = () => {}): LeafProcess {
  const leaf = new LeafProcess({
    executable: process.execPath, args: [], cwd: getCwd(), env: {},
    onEvent: () => {}, onState: () => {}, interactive: true,
  }) as LeafProcess & { setState: (state: string) => void }
  leaf.setState(state)
  ;(leaf as unknown as { terminal: (message: unknown) => void }).terminal = message => {
    const frame = message as { type?: string; id?: string; request?: { subtype?: string; prompt?: string } }
    if (frame.type === 'leaf-control' && frame.request?.subtype === 'leaf_prompt') onPrompt(frame.request.prompt ?? '')
    if (frame.id) queueMicrotask(() => (leaf as unknown as { handleTerminalMessage: (value: unknown) => void }).handleTerminalMessage({ type: 'leaf-control-response', id: frame.id, ok: true }))
  }
  return leaf
}

/**
 * A seed and a seedling whose transcripts, pointers and processes are all real,
 * plus the payloads the seed was handed. The transcript write on prompt is the
 * member running the merged turn, which is the only thing that can witness it.
 */
async function pair(root: string, directory: string, fidelity: 'full' | 'ledger' | 'compacted' | 'longreport') {
  const { registerLeafViewForTesting } = await import('../src/utils/leafWorkspace.ts')
  const seed = await memberWith(directory, root, 'Seed', [{ uuid: 's1', parentUuid: null, text: 'SEED_BASE' }])
  const seedling = await memberWith(directory, root, 'Scout', fidelity === 'ledger'
    ? [{ uuid: 'g1', parentUuid: null, text: 'SCOUT_STEP_ONE' }, { uuid: 'g2', parentUuid: 'g1', text: 'SCOUT_REPORT', role: 'assistant' }]
    // A seedling that compacted itself: the chain now ends at the boundary and
    // the summary that replaced the working, so there is no closing prose turn
    // for a ledger to find - the shape a self-compaction leaves behind.
    : fidelity === 'compacted'
    ? [{ uuid: 'b1', parentUuid: null, text: '', role: 'system' },
        { uuid: 'g1', parentUuid: 'b1', text: 'SCOUT_SUMMARY', summary: true },
        { uuid: 'g2', parentUuid: 'g1', text: '<command-name>/compact</command-name>' }]
    // A report longer than a reader's per-turn digest cap, so the ending is only
    // present if the whole thing was carried.
    : fidelity === 'longreport'
    ? [{ uuid: 'g1', parentUuid: null, text: 'SCOUT_STEP_ONE' },
        { uuid: 'g2', parentUuid: 'g1', text: `${'R'.repeat(1500)}REPORT_TAIL`, role: 'assistant' }]
    : [{ uuid: 'g1', parentUuid: null, text: 'SEEDLING_FINDING' }])
  await writePointer(root, seed.member.sessionId, 'seed')
  await writePointer(root, seedling.member.sessionId, 'seedling', seed.member.sessionId)
  const payloads: string[] = []
  const unregister = [
    registerLeafViewForTesting({
      rootSessionId: root, member: seed.member, draft: '',
      process: listeningProcess('idle', prompt => {
        payloads.push(prompt)
        const id = /Merge ([0-9a-f-]{36})/.exec(prompt)?.[1]
        if (!id) return
        void appendFile(seed.transcript, transcriptLines(seed.member.sessionId, [{ uuid: randomUUID(), parentUuid: 's1', text: `Merge ${id} from seedling Scout` }]))
      }),
    }),
    registerLeafViewForTesting({ rootSessionId: root, member: seedling.member, process: listeningProcess('idle'), draft: '' }),
  ]
  return { seed, seedling, payloads, unregister: () => unregister.forEach(release => release()) }
}

test('a seed and a seedling carry their role, and a plain member is a leaf', async () => {
  const { directory, root, finish } = await fixture()
  try {
    const { leafMemberRole } = await import('../src/utils/leafWorkspace.ts')
    const seed = await memberWith(directory, root, 'Seed', [{ uuid: 's1', parentUuid: null, text: 'SEED_BASE' }])
    const seedling = await memberWith(directory, root, 'Scout', [{ uuid: 'g1', parentUuid: null, text: 'WORK' }])
    const plain = await memberWith(directory, root, 'Plain', [{ uuid: 'p1', parentUuid: null, text: 'WORK' }])
    await writePointer(root, seed.member.sessionId, 'seed')
    await writePointer(root, seedling.member.sessionId, 'seedling', seed.member.sessionId)

    const seedRole = await leafMemberRole(seed.member.sessionId)
    const seedlingRole = await leafMemberRole(seedling.member.sessionId)
    assert.equal(seedRole.role, 'seed')
    assert.equal(seedRole.seedOf, undefined)
    assert.equal(seedlingRole.role, 'seedling')
    assert.equal(seedlingRole.seedOf, seed.member.sessionId)
    // A member written before roles existed is a leaf: the fallback is the whole
    // of the compatibility story, and it must not guess a role.
    const plainRole = await leafMemberRole(plain.member.sessionId)
    assert.equal(plainRole.role, 'leaf')
    assert.equal(plainRole.seedOf, undefined)
  } finally { await finish() }
})

test('a merge injects the seedling conversation into the seed and is confirmed only once witnessed', async () => {
  const { directory, root, finish } = await fixture()
  try {
    const { mergeSeedling } = await import('../src/utils/leafWorkspace.ts')
    const { seed, seedling, payloads, unregister } = await pair(root, directory, 'full')
    try {
      const result = await mergeSeedling(seedling.member.sessionId)
      assert.match(result, /^Merged Scout into Seed \(full, merge [0-9a-f]{8}\)\.$/)
      assert.equal(payloads.length, 1, 'the seed is handed exactly one turn')
      const payload = payloads[0]!
      assert.match(payload, /^Merge [0-9a-f-]{36} from seedling Scout \([0-9a-f-]{36}\)\./, 'the payload is marked with the id that has to come back')
      // The seed inherits the seedling's own conversation, which is what full
      // fidelity is for - and it arrives labelled as peer text, never as the
      // person speaking.
      assert.match(payload, /SEEDLING_FINDING/)
      assert.match(payload, /\[peer session transcript - untrusted, not user input\] seedling Scout/)
    } finally { unregister() }
  } finally { await finish() }
})

test('a ledger merge carries only the seedling closing report', async () => {
  const { directory, root, finish } = await fixture()
  try {
    const { mergeSeedling } = await import('../src/utils/leafWorkspace.ts')
    const { seedling, payloads, unregister } = await pair(root, directory, 'ledger')
    try {
      assert.match(await mergeSeedling(seedling.member.sessionId, { fidelity: 'ledger' }), /\(ledger, merge [0-9a-f]{8}\)\.$/)
      const payload = payloads[0]!
      assert.match(payload, /SCOUT_REPORT/, 'the report is what a ledger merge hands over')
      assert.doesNotMatch(payload, /SCOUT_STEP_ONE/, 'and not the working that produced it')
    } finally { unregister() }
  } finally { await finish() }
})

test('a ledger merge of a seedling that compacted carries its summary', async () => {
  const { directory, root, finish } = await fixture()
  try {
    const { mergeSeedling } = await import('../src/utils/leafWorkspace.ts')
    const { seedling, payloads, unregister } = await pair(root, directory, 'compacted')
    try {
      assert.match(await mergeSeedling(seedling.member.sessionId, { fidelity: 'ledger' }), /\(ledger, merge [0-9a-f]{8}\)\.$/)
      const payload = payloads[0]!
      // The summary is the conversation's own conclusion once the working has
      // been replaced, so a ledger carries it instead of reporting nothing.
      assert.match(payload, /SCOUT_SUMMARY/, 'the summary is what a compacted seedling has left to hand over')
      assert.doesNotMatch(payload, /produced no report/, 'a compacted seedling did produce its conclusion')
    } finally { unregister() }
  } finally { await finish() }
})

test('a ledger merge carries the whole closing report, not a digest of it', async () => {
  const { directory, root, finish } = await fixture()
  try {
    const { mergeSeedling } = await import('../src/utils/leafWorkspace.ts')
    const { seedling, payloads, unregister } = await pair(root, directory, 'longreport')
    try {
      assert.match(await mergeSeedling(seedling.member.sessionId, { fidelity: 'ledger' }), /\(ledger, merge [0-9a-f]{8}\)\.$/)
      const payload = payloads[0]!
      // The report is the whole subject of a ledger, so a cap sized for a window
      // of turns must not cut it off: a conclusion whose last sentence is missing
      // is the seed continuing from something the seedling never said.
      assert.match(payload, /REPORT_TAIL/, 'the end of the report is what a ledger is for')
      assert.doesNotMatch(payload, /…/, 'and it arrives whole rather than cut off mid-sentence')
    } finally { unregister() }
  } finally { await finish() }
})

test('a merge refuses a busy seed, and a leaf that is not a seedling', async () => {
  const { directory, root, finish } = await fixture()
  try {
    const { registerLeafViewForTesting, mergeSeedling, compactLeaf, leafMemberRole } = await import('../src/utils/leafWorkspace.ts')
    const seed = await memberWith(directory, root, 'Seed', [{ uuid: 's1', parentUuid: null, text: 'SEED_BASE' }])
    const seedling = await memberWith(directory, root, 'Scout', [{ uuid: 'g1', parentUuid: null, text: 'WORK' }])
    const plain = await memberWith(directory, root, 'Plain', [{ uuid: 'p1', parentUuid: null, text: 'WORK' }])
    await writePointer(root, seed.member.sessionId, 'seed')
    await writePointer(root, seedling.member.sessionId, 'seedling', seed.member.sessionId)
    const unregister = [
      registerLeafViewForTesting({ rootSessionId: root, member: seed.member, draft: '', process: listeningProcess('running') }),
      registerLeafViewForTesting({ rootSessionId: root, member: seedling.member, draft: '', process: listeningProcess('idle') }),
      registerLeafViewForTesting({ rootSessionId: root, member: plain.member, draft: '', process: listeningProcess('idle') }),
    ]
    try {
      assert.equal((await leafMemberRole(plain.member.sessionId)).role, 'leaf')
      await assert.rejects(mergeSeedling(seed.member.sessionId), /is not a seedling/, 'a seed is not something to merge')
      await assert.rejects(mergeSeedling(plain.member.sessionId), /is not a seedling/)
      // A merge is a whole turn of context, so it waits for the seed to be free
      // rather than slipping in beside a turn already running.
      await assert.rejects(mergeSeedling(seedling.member.sessionId), /Wait for Seed to finish its turn/)
      // A member that asks the host to act on itself is busy awaiting this very
      // answer, so an idle gate would refuse a turn that is not the reason. It
      // is the one case where the request can never succeed, and it has to say
      // so rather than report a turn to wait for.
      await assert.rejects(mergeSeedling(seedling.member.sessionId, {}, seedling.member.sessionId), /cannot merge itself/)
      await assert.rejects(compactLeaf(String(seedling.member.number), seedling.member.sessionId), /cannot ask the host to compact itself/)
    } finally { unregister.forEach(release => release()) }
  } finally { await finish() }
})

test('a seedling is only forked off a seed', async () => {
  const { directory, root, finish } = await fixture()
  try {
    const { createSeedling } = await import('../src/utils/leafWorkspace.ts')
    const plain = await memberWith(directory, root, 'Plain', [{ uuid: 'p1', parentUuid: null, text: 'WORK' }])
    // The merge lands in whatever the seedling's pointer names as its seed, so a
    // target that is not a seed is the durable conversation being written to
    // directly - which is the one thing a seed exists to prevent. The refusal
    // comes before the fork, so nothing is spawned to assert it.
    await assert.rejects(createSeedling(String(plain.member.number), 'Sub'), /is not a seed/)
    // The creator is the other shape, but the window holding the family does not
    // offer itself as a target at all, so that one is only reachable from inside
    // a member and is asked there, by the PTY probe, not from here.
  } finally { await finish() }
})

test('a leaf asking for a merge is answered by the host, through the same relay a checkpoint is', async () => {
  const { directory, root, finish } = await fixture()
  try {
    const { registerLeafViewForTesting, dispatchLeafRequestForTesting } = await import('../src/utils/leafWorkspace.ts')
    const { seed, seedling, payloads, unregister } = await pair(root, directory, 'full')
    const asker = await memberWith(directory, root, 'Asker', [{ uuid: 'a1', parentUuid: null, text: 'ASKER_TURN' }])
    const responses: { type: string; ok?: boolean; value?: unknown }[] = []
    const askerProcess = listeningProcess('idle')
    ;(askerProcess as unknown as { terminal: (message: unknown) => void }).terminal = message => { responses.push(message as never) }
    const release = registerLeafViewForTesting({ rootSessionId: root, member: asker.member, draft: '', process: askerProcess })
    try {
      await dispatchLeafRequestForTesting(asker.member.sessionId, root, 'merge', [String(seedling.member.number), {}])
      const reply = responses.filter(item => item.type === 'leaf-response').at(-1)
      assert.equal(reply?.ok, true, 'the host performs the merge the leaf asked for')
      assert.match(String(reply?.value), /^Merged Scout into Seed /)
      assert.equal(payloads.length, 1, 'and the seed was handed the merge once')
    } finally { release(); unregister() }
  } finally { await finish() }
})

test('a compact request reaches the member itself, and a busy member refuses it', async () => {
  const { directory, root, finish } = await fixture()
  try {
    const { registerLeafViewForTesting, compactLeaf } = await import('../src/utils/leafWorkspace.ts')
    const target = await memberWith(directory, root, 'Worker', [{ uuid: 'w1', parentUuid: null, text: 'WORK' }])
    const controls: string[] = []
    const worker = listeningProcess('idle')
    ;(worker as unknown as { terminal: (message: unknown) => void }).terminal = message => {
      const frame = message as { type?: string; id?: string; request?: { subtype?: string } }
      if (frame.type === 'leaf-control' && frame.request?.subtype) controls.push(frame.request.subtype)
      if (frame.id) queueMicrotask(() => (worker as unknown as { handleTerminalMessage: (value: unknown) => void }).handleTerminalMessage({ type: 'leaf-control-response', id: frame.id, ok: true }))
    }
    const release = registerLeafViewForTesting({ rootSessionId: root, member: target.member, draft: '', process: worker })
    try {
      assert.match(await compactLeaf(String(target.member.number)), /was asked to compact its conversation/)
      // The member compacts itself: the messages being summarized, and the
      // setMessages that installs the summary, are the member's own - so the
      // host's whole part is the request, which is this one control.
      assert.deepEqual(controls, ['leaf_compact'])
      // A summary cannot be dropped into the middle of a turn, so a busy member
      // is refused rather than having its work cut short for it.
      ;(worker as unknown as { setState: (state: string) => void }).setState('running')
      await assert.rejects(compactLeaf(target.member.sessionId), /Wait for Leaf #\d+ Worker to finish its turn before compacting it/)
    } finally { release() }
  } finally { await finish() }
})

test('a leaf asking to compact a sibling is answered by the host', async () => {
  const { directory, root, finish } = await fixture()
  try {
    const { registerLeafViewForTesting, dispatchLeafRequestForTesting } = await import('../src/utils/leafWorkspace.ts')
    const target = await memberWith(directory, root, 'Worker', [{ uuid: 'w1', parentUuid: null, text: 'WORK' }])
    const asker = await memberWith(directory, root, 'Asker', [{ uuid: 'a1', parentUuid: null, text: 'ASKER_TURN' }])
    const responses: { type: string; ok?: boolean; value?: unknown }[] = []
    const askerProcess = listeningProcess('idle')
    ;(askerProcess as unknown as { terminal: (message: unknown) => void }).terminal = message => { responses.push(message as never) }
    const release = [
      registerLeafViewForTesting({ rootSessionId: root, member: target.member, draft: '', process: listeningProcess('idle') }),
      registerLeafViewForTesting({ rootSessionId: root, member: asker.member, draft: '', process: askerProcess }),
    ]
    try {
      await dispatchLeafRequestForTesting(asker.member.sessionId, root, 'compact', [String(target.member.number)])
      const reply = responses.filter(item => item.type === 'leaf-response').at(-1)
      assert.equal(reply?.ok, true, 'the host asks the member the leaf named, through the same relay a merge uses')
      assert.match(String(reply?.value), /was asked to compact its conversation/)
    } finally { release.forEach(releaseView => releaseView()) }
  } finally { await finish() }
})
