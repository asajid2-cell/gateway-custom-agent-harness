import { test, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { addLeafMember, ensureCreatorMember, readLeafFamily, updateLeafMember, recordLeafContextReturn } from '../src/utils/leafFamily.ts'
import { createFork } from '../src/commands/branch/branch.ts'
import { createLeaf, changeLeaf, fileLeaf } from '../src/utils/leafWorkspace.ts'
import { LeafProcess } from '../src/utils/leafProcess.ts'
import { getCwd } from '../src/utils/cwd.ts'

/**
 * What this file is about decides the environment it runs in.
 *
 * Every case here builds a leaf and drives it from the outside: the subject is
 * the session side of a leaf family, not the leaf side. Launched by a leaf -
 * which is what happens when a leaf session runs the suite - the inherited
 * identity changes what those same calls mean, because a leaf has no workspace
 * to ask and answers "Leaf workspace disconnected" instead. Nine cases failed
 * for that reason and no other. Pin it so the file says the same thing wherever
 * it is launched, and put it back so the process is unchanged for what runs next.
 */
const ambientLeafIdentity = process.env.GATEWAY_INTERACTIVE_LEAF
delete process.env.GATEWAY_INTERACTIVE_LEAF
after(() => {
  if (ambientLeafIdentity === undefined) delete process.env.GATEWAY_INTERACTIVE_LEAF
  else process.env.GATEWAY_INTERACTIVE_LEAF = ambientLeafIdentity
})

type QueuedProcess = LeafProcess & { child: unknown; state: string; controls: Map<string, { resolve: () => void; reject: (error: Error) => void }> }

/**
 * A leaf whose control channel is answered by the test, so delivery can be
 * driven through its real transitions without spawning a CLI.
 */
function parkedLeaf(): { leaf: QueuedProcess; sent: { subtype: string; prompt?: string }[] } {
  const sent: { subtype: string; prompt?: string }[] = []
  const leaf = new LeafProcess({
    executable: process.execPath, args: [], cwd: getCwd(), env: {},
    onEvent: () => {}, onState: () => {}, interactive: true,
  }) as QueuedProcess
  leaf.child = { connected: true }
  leaf.setState('idle')
  ;(leaf as unknown as { control: (request: { subtype: string; prompt?: string }) => Promise<void> }).control = request => {
    sent.push(request)
    return Promise.resolve()
  }
  return { leaf, sent }
}

test('a leaf closes the parent it belongs to, and no session closes itself', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaf-close-parent-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  try {
    const { getSessionId, getSessionProjectDir, getSessionResumeDirectory, switchSession } = await import('../src/bootstrap/state.ts')
    const { asSessionId } = await import('../src/types/ids.ts')
    const {
      getLeafViews, registerLeafViewForTesting, registerLeafMatriarchHandoff, dispatchLeafRequestForTesting, forgetLeafFamilyRoot,
    } = await import('../src/utils/leafWorkspace.ts')
    const root = getSessionId()
    const projectDir = getSessionProjectDir()
    const resumeDirectory = getSessionResumeDirectory()
    forgetLeafFamilyRoot()
    const familyPath = join(directory, 'leaf-families', `${root}.json`)
    const { leaf } = parkedLeaf()
    const member = await addLeafMember(familyPath, root, {
      sessionId: randomUUID(), parentSessionId: root, name: 'Child',
      transcriptPath: join(directory, 'child.jsonl'), forkMessageId: randomUUID(),
    })
    const unregister = registerLeafViewForTesting({ rootSessionId: root, member, process: leaf as never, draft: '' })
    // Closing the matriarch hands this terminal to the successor, so the
    // successor's conversation is resumed where the parent's was. That resume is
    // the REPL's, and here it is a session switch plus a record of the call.
    const resumed: string[] = []
    const unregisterHandoff = registerLeafMatriarchHandoff({
      prepare: async () => {},
      resume: async successor => {
        resumed.push(successor.sessionId)
        switchSession(asSessionId(successor.sessionId), null, directory)
      },
    })
    const status = async (sessionId: string) => (await readLeafFamily(familyPath, root)).members.find(item => item.sessionId === sessionId)?.status
    try {
      // The reported failure: from a leaf, `Close #8 Original` was refused with
      // "That is the session you are in". The refusal belongs to the session that
      // ASKED, and a leaf asks through the session hosting its family - which is
      // usually the very parent it is asking to close, so the leaf was told it
      // was the parent. This is the real dispatch path a leaf's request takes.
      await dispatchLeafRequestForTesting(member.sessionId, root, 'change', [root, { status: 'closed' }])
      // The handoff itself is deferred past the reply, so the leaf learns its
      // request was accepted before the terminal it asked about changes hands.
      // The deferral is a `setTimeout(…, 0)`, so wait for the outcome instead of
      // guessing at its duration: a fixed sleep passes on a quiet machine and
      // fails on a busy one, which is the flake this replaces.
      const deadline = Date.now() + 5000
      while (await status(root) !== 'closed' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
      assert.equal(await status(root), 'closed', 'a leaf must be able to close the parent it belongs to')
      assert.equal(await status(member.sessionId), 'open', 'the leaf that asked takes the family over rather than closing with it')
      assert.deepEqual(resumed, [member.sessionId], 'the successor conversation is resumed into the session terminal')
      // Back to the parent's identity for the half that stays: this window is the
      // creator again, so the two refusals below are read from its side.
      switchSession(asSessionId(root), projectDir, resumeDirectory)
      forgetLeafFamilyRoot()

      // A fresh leaf stands in for the one that just became the session: the
      // asker of the first half holds the terminal now, and a leaf is refused
      // for itself and for nothing else.
      const { leaf: second } = parkedLeaf()
      const sibling = await addLeafMember(familyPath, root, {
        sessionId: randomUUID(), parentSessionId: root, name: 'Second',
        transcriptPath: join(directory, 'second.jsonl'), forkMessageId: randomUUID(),
      })
      const unregisterSibling = registerLeafViewForTesting({ rootSessionId: root, member: sibling, process: second as never, draft: '' })
      try {
        // A leaf cannot close itself. The host holds a view for the asker, so "is
        // there a process to close" cannot tell a leaf closing itself from a leaf
        // closing a sibling - the asker can.
        await dispatchLeafRequestForTesting(sibling.sessionId, root, 'change', [sibling.sessionId, { status: 'closed' }])
        assert.equal(await status(sibling.sessionId), 'open', 'a leaf cannot close itself')

        // And the parent still closes its own leaves, which is what "either
        // direction" means: the same rule, read from the other side.
        await changeLeaf(sibling.sessionId, { status: 'closed' })
        assert.equal(await status(sibling.sessionId), 'closed', 'the parent must still be able to close a leaf')
        assert.deepEqual(getLeafViews(), [], 'a closed leaf is no longer an entry point')
      } finally { unregisterSibling() }
    } finally {
      unregisterHandoff()
      unregister()
      switchSession(asSessionId(root), projectDir, resumeDirectory)
      forgetLeafFamilyRoot()
    }
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    await rm(directory, { recursive: true, force: true })
  }
})

test('a message to a running leaf is handed over mid-turn, not held until it ends', async () => {
  const { leaf, sent } = parkedLeaf()
  leaf.setState('running')
  // The reported failure: a session asking a working sibling a question waited
  // for that session's entire turn. A running leaf's REPL takes the text now and
  // runs it at its own next step boundary, so this must not be held.
  assert.equal(await leaf.deliver('MID_TURN_ONE'), true)
  assert.deepEqual(sent.map(item => item.prompt), ['MID_TURN_ONE'], 'a running leaf must take the message now')
  assert.deepEqual(leaf.getPending(), [], 'nothing is held when the leaf can take the message')

  assert.equal(await leaf.deliver('MID_TURN_TWO'), true)
  assert.deepEqual(sent.map(item => item.prompt), ['MID_TURN_ONE', 'MID_TURN_TWO'], 'arrival order is kept')
})

test('only a leaf that cannot take input waits, and arrival order survives the wait', async () => {
  const { leaf, sent } = parkedLeaf()
  // A permission dialog owns the keyboard, so text written now would answer the
  // dialog instead of becoming a turn. This is the one state that holds.
  leaf.setState('awaiting-approval')
  const first = leaf.deliver('WHILE_APPROVING_ONE')
  const second = leaf.deliver('WHILE_APPROVING_TWO')
  assert.deepEqual(sent, [], 'nothing is handed over while a permission dialog owns the input')
  assert.deepEqual(leaf.getPending(), ['WHILE_APPROVING_ONE', 'WHILE_APPROVING_TWO'])
  assert.equal(await Promise.race([first, Promise.resolve('pending')]), 'pending', 'a held message must not settle before it can run')

  // Approving the request resumes the turn; both held messages go in now, in
  // arrival order, because the running leaf's own queue takes them and its turn
  // drains them one at a time. Neither waits for the turn to end.
  leaf.setState('running')
  assert.equal(await first, true)
  assert.equal(await second, true)
  assert.deepEqual(sent.map(item => item.prompt), ['WHILE_APPROVING_ONE', 'WHILE_APPROVING_TWO'])
  assert.deepEqual(leaf.getPending(), [])
})

test('an idle leaf is handed the message straight away', async () => {
  const { leaf, sent } = parkedLeaf()
  assert.equal(await leaf.deliver('RIGHT_NOW'), true)
  assert.deepEqual(sent.map(item => item.prompt), ['RIGHT_NOW'])
  assert.deepEqual(leaf.getPending(), [], 'an idle leaf needs no queue')
})

test('a held message is dropped, not an error, when the leaf ends first', async () => {
  const { leaf } = parkedLeaf()
  leaf.setState('awaiting-approval')
  const held = leaf.deliver('NEVER_RUNS')
  leaf.setState('closed')
  assert.equal(await held, false)
  assert.deepEqual(leaf.getPending(), [], 'a closed leaf must not keep a queue')
})

test('a message the leaf refuses to take reports that it did not run', async () => {
  const { leaf, sent } = parkedLeaf()
  ;(leaf as unknown as { control: (request: { subtype: string; prompt?: string }) => Promise<void> }).control = request => {
    sent.push(request)
    // The leaf died between the eligibility check and the hand-off, which is
    // what the control channel reports as a rejection.
    return Promise.reject(new Error('Leaf is closing or not running'))
  }
  // Not a state that can take input, so this goes through the queue and only
  // reaches the hand-off when the leaf can take a message.
  leaf.setState('awaiting-approval')
  const held = leaf.deliver('REFUSED')
  leaf.setState('idle')
  assert.equal(await held, false)
  assert.deepEqual(sent.map(item => item.prompt), ['REFUSED'])
  assert.deepEqual(leaf.getPending(), [])
})

test('a sibling leaf send records the asking leaf as the sender, not the root', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaf-origin-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  try {
    const { getSessionId } = await import('../src/bootstrap/state.ts')
    const { getClaudeConfigHomeDir } = await import('../src/utils/envUtils.ts')
    const {
      pendingLeafSendSources, registerLeafViewForTesting, dispatchLeafRequestForTesting, PEER_PROMPT_PREFIX,
    } = await import('../src/utils/leafWorkspace.ts')
    const root = getSessionId()
    const familyPath = join(getClaudeConfigHomeDir(), 'leaf-families', `${root}.json`)
    const askerId = randomUUID()
    const targetTranscript = join(directory, 'target.jsonl')
    await writeFile(targetTranscript, '')
    const asker = await addLeafMember(familyPath, root, { sessionId: askerId, parentSessionId: root, name: 'Asker', transcriptPath: join(directory, 'asker.jsonl'), forkMessageId: randomUUID() })
    const target = await addLeafMember(familyPath, root, { sessionId: randomUUID(), parentSessionId: root, name: 'Target', transcriptPath: targetTranscript, forkMessageId: randomUUID() })

    const { LeafProcess: RealLeafProcess } = await import('../src/utils/leafProcess.ts')
    const makeLeaf = () => {
      const leaf = new RealLeafProcess({ executable: process.execPath, args: [], cwd: getCwd(), env: {}, onEvent: () => {}, onState: () => {}, interactive: true }) as any
      leaf.child = { connected: true, send: (_message: unknown, callback?: (error?: Error) => void) => { callback?.() } }
      leaf.setState('idle')
      return leaf
    }
    const askerLeaf = makeLeaf()
    const targetLeaf = makeLeaf()
    const prompts: string[] = []
    // Records the hand-off and stays idle: a leaf that went busy would hold the
    // second message in its queue, which this test is not about.
    targetLeaf.control = (request: any) => { prompts.push(request.prompt); return Promise.resolve() }

    const unregisterAsker = registerLeafViewForTesting({ rootSessionId: root, member: asker, process: askerLeaf, draft: '' })
    const unregisterTarget = registerLeafViewForTesting({ rootSessionId: root, member: target, process: targetLeaf, draft: '' })
    try {
      // The asker leaf sends to its sibling. This is the real dispatch path: the
      // relay runs in the ROOT process, so `getSessionId()` is the root here even
      // though the root never asked anything.
      await dispatchLeafRequestForTesting(askerId, root, 'send', [target.sessionId, 'SIBLING_QUESTION'])
      assert.deepEqual(prompts, [`${PEER_PROMPT_PREFIX}SIBLING_QUESTION`], 'the target must receive the labelled question')
      // The reply must be owed to the ASKING LEAF. Recording the root sent the
      // answer to a conversation with no question in it, and the asker waited
      // forever - the reported "leaves have no proper awareness".
      assert.deepEqual(
        pendingLeafSendSources(target.sessionId),
        [{ source: askerId, message: 'SIBLING_QUESTION' }],
        'the answer must be routed back to the leaf that asked',
      )
    } finally {
      unregisterAsker()
      unregisterTarget()
    }
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    await rm(directory, { recursive: true, force: true })
  }
})

test('closing a leaf takes its entry out of the bar and keeps the text typed into it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaf-close-entry-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  const savedGateway = process.env.CLAUDE_CODE_USE_GATEWAY
  process.env.CLAUDE_CONFIG_DIR = directory
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  try {
    const { getSessionId } = await import('../src/bootstrap/state.ts')
    const { getLeafViews, registerLeafViewForTesting } = await import('../src/utils/leafWorkspace.ts')
    const root = getSessionId()
    const familyPath = join(directory, 'leaf-families', `${root}.json`)
    const transcriptPath = join(directory, 'lifecycle.jsonl')
    await writeFile(transcriptPath, '')
    const member = await addLeafMember(familyPath, root, { sessionId: randomUUID(), parentSessionId: root, name: 'Lifecycle', transcriptPath, forkMessageId: randomUUID() })
    const leaf = new LeafProcess({ executable: process.execPath, args: [], cwd: getCwd(), env: {}, onEvent: () => {}, onState: () => {}, interactive: true }) as unknown as {
      child: unknown; setState: (state: string) => void; control: () => Promise<void>
    }
    leaf.child = { connected: true, send: (_message: unknown, callback?: (error?: Error) => void) => { callback?.() } }
    leaf.setState('idle')
    // The draft sync the close path asks for, answered here so the real close
    // path runs with no CLI behind it.
    leaf.control = () => Promise.resolve()
    const unregister = registerLeafViewForTesting({ rootSessionId: root, member, process: leaf as never, draft: 'SAVED_DRAFT' })
    try {
      assert.deepEqual(getLeafViews().map(view => view.member.sessionId), [member.sessionId], 'an open leaf is an entry point')
      await changeLeaf(member.sessionId, { status: 'closed' })
      // The reported failure: the closed leaf stayed clickable in the bottom bar,
      // and entering it muted this session inside an alternate screen that
      // nothing was drawing in. The bar offers what `getLeafViews` returns, so a
      // closed leaf must not be in it.
      assert.deepEqual(getLeafViews(), [], 'a closed leaf is not an entry point')
      const stored = (await readLeafFamily(familyPath, root)).members[0]!
      assert.equal(stored.status, 'closed', 'the close is recorded')
      assert.equal(stored.draft, 'SAVED_DRAFT', 'closing must not lose the text typed into the leaf')
    } finally { unregister() }
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    if (savedGateway === undefined) delete process.env.CLAUDE_CODE_USE_GATEWAY
    else process.env.CLAUDE_CODE_USE_GATEWAY = savedGateway
    await rm(directory, { recursive: true, force: true })
  }
})

test('an answer a leaf reports mid-turn reaches the asker without the turn ending', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaf-early-answer-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  try {
    const { getSessionId } = await import('../src/bootstrap/state.ts')
    const { getClaudeConfigHomeDir } = await import('../src/utils/envUtils.ts')
    const {
      pendingLeafSendSources, registerLeafViewForTesting, dispatchLeafRequestForTesting,
      deliverLeafAnswerForTesting,
    } = await import('../src/utils/leafWorkspace.ts')
    const root = getSessionId()
    const familyPath = join(getClaudeConfigHomeDir(), 'leaf-families', `${root}.json`)
    const askerId = randomUUID()
    const targetTranscript = join(directory, 'target.jsonl')
    await writeFile(targetTranscript, '')
    const asker = await addLeafMember(familyPath, root, { sessionId: askerId, parentSessionId: root, name: 'Asker', transcriptPath: join(directory, 'asker.jsonl'), forkMessageId: randomUUID() })
    const target = await addLeafMember(familyPath, root, { sessionId: randomUUID(), parentSessionId: root, name: 'Target', transcriptPath: targetTranscript, forkMessageId: randomUUID() })

    const { LeafProcess: RealLeafProcess } = await import('../src/utils/leafProcess.ts')
    const makeLeaf = () => {
      const leaf = new RealLeafProcess({ executable: process.execPath, args: [], cwd: getCwd(), env: {}, onEvent: () => {}, onState: () => {}, interactive: true }) as any
      leaf.child = { connected: true, send: (_message: unknown, callback?: (error?: Error) => void) => { callback?.() } }
      leaf.setState('idle')
      return leaf
    }
    const askerLeaf = makeLeaf()
    const targetLeaf = makeLeaf()
    const delivered: string[] = []
    // The control channel is answered by the test; the real one writes to a
    // child process this test never spawned.
    targetLeaf.control = () => Promise.resolve()
    askerLeaf.control = (request: any) => { delivered.push(request.prompt); return Promise.resolve() }

    const unregisterAsker = registerLeafViewForTesting({ rootSessionId: root, member: asker, process: askerLeaf, draft: '' })
    const unregisterTarget = registerLeafViewForTesting({ rootSessionId: root, member: target, process: targetLeaf, draft: '' })
    try {
      await dispatchLeafRequestForTesting(askerId, root, 'send', [target.sessionId, 'WHO_OWNS_THE_CACHE'])
      assert.deepEqual(pendingLeafSendSources(target.sessionId), [{ source: askerId, message: 'WHO_OWNS_THE_CACHE' }])

      // The target is still mid-turn when it reports the answer.
      targetLeaf.setState('running')
      await deliverLeafAnswerForTesting(target.sessionId, 'WHO_OWNS_THE_CACHE', 'I OWN THE CACHE')

      assert.equal(delivered.length, 1, 'the asker must receive the answer while the target is still running')
      assert.match(delivered[0]!, /WHO_OWNS_THE_CACHE/)
      assert.match(delivered[0]!, /I OWN THE CACHE/)
      // The question is off the books, so the end-of-turn report cannot answer
      // it a second time.
      assert.deepEqual(pendingLeafSendSources(target.sessionId), [], 'an answered question must not be reported again')
    } finally {
      unregisterAsker()
      unregisterTarget()
    }
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    await rm(directory, { recursive: true, force: true })
  }
})

test('two askers get their own answers back even when the second is answered first', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaf-two-askers-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  try {
    const { getSessionId } = await import('../src/bootstrap/state.ts')
    const { getClaudeConfigHomeDir } = await import('../src/utils/envUtils.ts')
    const {
      pendingLeafSendSources, registerLeafViewForTesting, dispatchLeafRequestForTesting,
      deliverLeafAnswerForTesting,
    } = await import('../src/utils/leafWorkspace.ts')
    const root = getSessionId()
    const familyPath = join(getClaudeConfigHomeDir(), 'leaf-families', `${root}.json`)
    const firstAskerId = randomUUID()
    const secondAskerId = randomUUID()
    const targetTranscript = join(directory, 'target.jsonl')
    await writeFile(targetTranscript, '')
    const firstAsker = await addLeafMember(familyPath, root, { sessionId: firstAskerId, parentSessionId: root, name: 'First', transcriptPath: join(directory, 'first.jsonl'), forkMessageId: randomUUID() })
    const secondAsker = await addLeafMember(familyPath, root, { sessionId: secondAskerId, parentSessionId: root, name: 'Second', transcriptPath: join(directory, 'second.jsonl'), forkMessageId: randomUUID() })
    const target = await addLeafMember(familyPath, root, { sessionId: randomUUID(), parentSessionId: root, name: 'Target', transcriptPath: targetTranscript, forkMessageId: randomUUID() })

    const { LeafProcess: RealLeafProcess } = await import('../src/utils/leafProcess.ts')
    const makeLeaf = (delivered: string[]) => {
      const leaf = new RealLeafProcess({ executable: process.execPath, args: [], cwd: getCwd(), env: {}, onEvent: () => {}, onState: () => {}, interactive: true }) as any
      leaf.child = { connected: true, send: (_message: unknown, callback?: (error?: Error) => void) => { callback?.() } }
      leaf.control = (request: any) => { delivered.push(request.prompt); return Promise.resolve() }
      leaf.setState('idle')
      return leaf
    }
    const firstDelivered: string[] = []
    const secondDelivered: string[] = []
    const firstLeaf = makeLeaf(firstDelivered)
    const secondLeaf = makeLeaf(secondDelivered)
    const targetLeaf = makeLeaf([])

    const unregister = [
      registerLeafViewForTesting({ rootSessionId: root, member: firstAsker, process: firstLeaf, draft: '' }),
      registerLeafViewForTesting({ rootSessionId: root, member: secondAsker, process: secondLeaf, draft: '' }),
      registerLeafViewForTesting({ rootSessionId: root, member: target, process: targetLeaf, draft: '' }),
    ]
    try {
      // Both leaves ask the same sibling. A running leaf now takes both
      // questions at once, so both are outstanding together.
      await dispatchLeafRequestForTesting(firstAskerId, root, 'send', [target.sessionId, 'IS_THE_INDEX_REBUILT'])
      await dispatchLeafRequestForTesting(secondAskerId, root, 'send', [target.sessionId, 'DID_THE_MIGRATION_RUN'])
      assert.equal(pendingLeafSendSources(target.sessionId).length, 2)

      // The sibling answers the SECOND question first. Matching "oldest still
      // owed" would send this answer to the first asker, who never asked it.
      targetLeaf.setState('running')
      await deliverLeafAnswerForTesting(target.sessionId, 'DID_THE_MIGRATION_RUN', 'YES, IT RAN')

      assert.equal(secondDelivered.length, 1, 'the second asker must get the answer to its own question')
      assert.match(secondDelivered[0]!, /DID_THE_MIGRATION_RUN/)
      assert.match(secondDelivered[0]!, /YES, IT RAN/)
      assert.equal(firstDelivered.length, 0, 'the first asker must not be told about a question it never asked')
      assert.deepEqual(
        pendingLeafSendSources(target.sessionId).map(item => item.message),
        ['IS_THE_INDEX_REBUILT'],
        'only the answered question comes off the books',
      )

      // Now the first question is answered too.
      await deliverLeafAnswerForTesting(target.sessionId, 'IS_THE_INDEX_REBUILT', 'REBUILT AN HOUR AGO')
      assert.equal(firstDelivered.length, 1)
      assert.match(firstDelivered[0]!, /IS_THE_INDEX_REBUILT/)
      assert.deepEqual(pendingLeafSendSources(target.sessionId), [], 'both questions are off the books')
    } finally {
      for (const unregisterOne of unregister) unregisterOne()
    }
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    await rm(directory, { recursive: true, force: true })
  }
})

test('the asker is found by the arrival id, because the marker does not survive framing', async () => {
  const { peerAnswerFor, PEER_PROMPT_PREFIX } = await import('../src/utils/leafWorkspace.ts')
  const asked = 'WHO OWNS THE CACHE'
  const pending = [{ uuid: 'ask-1', question: asked }]

  // What the model actually reads: the session's own turn boundary has wrapped
  // the queued peer text, so the marker is no longer at the front of the block.
  const framed = `<system-reminder>\n${PEER_PROMPT_PREFIX}${asked}\n</system-reminder>`
  assert.equal(framed.startsWith(PEER_PROMPT_PREFIX), false, 'the premise: the marker is not at the front')

  // A running leaf drains the question as an attachment carrying the queued id;
  // the framed text is the arrival itself, not a turn the leaf wrote.
  const attachmentArrival = [
    { type: 'attachment', attachment: { source_uuid: 'ask-1', prompt: framed } },
    { type: 'assistant', uuid: 'a-2', message: { content: [{ type: 'text', text: 'I OWN THE CACHE' }] } },
  ]
  assert.deepEqual(peerAnswerFor(attachmentArrival, pending), { uuid: 'a-2', question: asked, answer: 'I OWN THE CACHE' })

  // An idle leaf normalises the same message to a user turn with the same id.
  const idleArrival = [
    { type: 'user', uuid: 'ask-1', message: { content: framed } },
    { type: 'assistant', uuid: 'a-3', message: { content: [{ type: 'text', text: 'CACHE IS MINE' }] } },
  ]
  assert.deepEqual(peerAnswerFor(idleArrival, pending), { uuid: 'a-3', question: asked, answer: 'CACHE IS MINE' })

  // Nothing is reported before the question itself has arrived.
  assert.equal(peerAnswerFor([{ type: 'assistant', uuid: 'a-4', message: { content: [{ type: 'text', text: 'UNRELATED' }] } }], pending), undefined)
})

test('a leaf still working does not count as having answered, and prose before the ask does not either', async () => {
  const { peerAnswerFor } = await import('../src/utils/leafWorkspace.ts')
  const pending = [{ uuid: 'ask-1', question: 'WHO OWNS THE CACHE' }]
  const arrival = { type: 'attachment', attachment: { source_uuid: 'ask-1' } }

  // Prose written before the question arrived is not an answer to it.
  assert.equal(peerAnswerFor([
    { type: 'assistant', uuid: 'before', message: { content: [{ type: 'text', text: 'STILL DOING OTHER WORK' }] } },
    arrival,
  ], pending), undefined)

  // A message that also calls a tool is the leaf still working; the answer, if
  // it comes, is the later pure-prose message.
  assert.equal(peerAnswerFor([
    arrival,
    { type: 'assistant', uuid: 'working', message: { content: [{ type: 'text', text: 'LET ME CHECK' }, { type: 'tool_use' }] } },
  ], pending), undefined)

  // An empty question list means nobody is owed an answer.
  assert.equal(peerAnswerFor([
    arrival,
    { type: 'assistant', uuid: 'a-1', message: { content: [{ type: 'text', text: 'I OWN THE CACHE' }] } },
  ], []), undefined)
})

test('selected context return deduplicates after memory history and disk cache are cleared', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaf-return-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  const savedPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  process.env.CLAUDE_CONFIG_DIR = directory
  try {
    const { getSessionId } = await import('../src/bootstrap/state.ts')
    const { getClaudeConfigHomeDir } = await import('../src/utils/envUtils.ts')
    const { clearSessionMessagesCache, flushSessionStorage } = await import('../src/utils/sessionStorage.ts')
    const { call } = await import('../src/commands/leaf.tsx')
    const root = getSessionId()
    const member = await addLeafMember(join(getClaudeConfigHomeDir(), 'leaf-families', `${root}.json`), root, { sessionId: randomUUID(), parentSessionId: root, name: 'Source', transcriptPath: join(directory, 'source.jsonl'), forkMessageId: randomUUID() })
    let messages: any[] = []
    let result = ''
    const context = { messages, setMessages: (update: (previous: any[]) => any[]) => { messages = update(messages) } } as any
    await call(text => { result = text ?? '' }, context, `return ${member.sessionId} SELECTED_RETURN`)
    assert.match(result, /saved to the original transcript/)
    assert.equal(messages.length, 1)
    const { getTranscriptPath, recordTranscript } = await import('../src/utils/sessionStorage.ts')
    assert.match(await readFile(getTranscriptPath(), 'utf8'), /SELECTED_RETURN/)
    const { createUserMessage } = await import('../src/utils/messages.ts')
    const pendingWrite = recordTranscript([createUserMessage({ content: 'FLUSH_MUST_WAIT_FOR_STARTED_TRANSCRIPT' })])
    await flushSessionStorage()
    assert.match(await readFile(getTranscriptPath(), 'utf8'), /FLUSH_MUST_WAIT_FOR_STARTED_TRANSCRIPT/)
    await pendingWrite
    messages = []
    context.messages = []
    await flushSessionStorage()
    clearSessionMessagesCache()
    await call(text => { result = text ?? '' }, context, `return ${member.sessionId} SELECTED_RETURN`)
    assert.match(result, /already returned/)
    assert.equal(messages.length, 0)
    delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    await call(text => { result = text ?? '' }, context, `return ${member.sessionId} MUST_NOT_ACK_DISABLED_STORAGE`)
    assert.doesNotMatch(result, /saved to the original transcript/)
    assert.equal(messages.length, 0)
  } finally {
    const { getSessionId } = await import('../src/bootstrap/state.ts')
    const { flushSessionStorage } = await import('../src/utils/sessionStorage.ts')
    const { releaseGatewaySessionWriter } = await import('../src/utils/gatewaySessionOwnership.ts')
    await flushSessionStorage()
    await releaseGatewaySessionWriter(getSessionId())
    if (savedPersistence === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    else process.env.TEST_ENABLE_SESSION_PERSISTENCE = savedPersistence
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    await rm(directory, { recursive: true, force: true })
  }
})

test('rename, filing and promotion refuse another writer before metadata changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaf-rename-owner-'))
  const savedConfig = process.env.CLAUDE_CONFIG_DIR
  const savedGateway = process.env.CLAUDE_CODE_USE_GATEWAY
  process.env.CLAUDE_CONFIG_DIR = directory
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  const { mkdir } = await import('node:fs/promises')
  const { lock } = await import('../src/utils/lockfile.ts')
  const { getSessionId } = await import('../src/bootstrap/state.ts')
  const root = getSessionId()
  const familyPath = join(directory, 'leaf-families', `${root}.json`)
  const transcriptPath = join(directory, 'source.jsonl')
  let release: (() => Promise<void>) | undefined
  try {
    await writeFile(transcriptPath, '')
    const member = await addLeafMember(familyPath, root, { sessionId: randomUUID(), parentSessionId: root, name: 'Before rename', transcriptPath, forkMessageId: randomUUID() })
    await mkdir(join(directory, 'gateway-writers'))
    release = await lock(join(directory, 'gateway-writers', member.sessionId), { realpath: false, stale: 30000, retries: 0 })
    await assert.rejects(changeLeaf(member.sessionId, { name: 'Unsafe rename' }), /already being held|locked/i)
    assert.equal((await readLeafFamily(familyPath, root)).members[0]!.name, 'Before rename')
    assert.equal(await readFile(transcriptPath, 'utf8'), '')
    await assert.rejects(fileLeaf(member.sessionId, 'Unsafe filing'), /already being held|locked/i)
    await assert.rejects(changeLeaf(member.sessionId, { status: 'promoted', name: 'Unsafe promotion' }), /already being held|locked/i)
    const unchanged = (await readLeafFamily(familyPath, root)).members[0]!
    assert.equal(unchanged.name, 'Before rename')
    assert.equal(unchanged.status, 'open')
    assert.equal(await readFile(transcriptPath, 'utf8'), '')
    await release()
    release = undefined
    await changeLeaf(member.sessionId, { name: 'Safe rename' })
    assert.equal((await readLeafFamily(familyPath, root)).members[0]!.name, 'Safe rename')
    assert.match(await readFile(transcriptPath, 'utf8'), /Safe rename/)
    await Promise.all(Array.from({ length: 8 }, (_, index) => changeLeaf(member.sessionId, { name: `Concurrent ${index}` })))
    const finalName = (await readLeafFamily(familyPath, root)).members[0]!.name
    const titles = (await readFile(transcriptPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.type === 'custom-title')
    assert.equal(titles.at(-1).customTitle, `Leaf ${member.number}: ${finalName}`)
  } finally {
    await release?.()
    if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedConfig
    if (savedGateway === undefined) delete process.env.CLAUDE_CODE_USE_GATEWAY
    else process.env.CLAUDE_CODE_USE_GATEWAY = savedGateway
    await rm(directory, { recursive: true, force: true })
  }
})

test('archiving detaches a leaf but leaves its transcript on disk', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaf-archive-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  const savedGateway = process.env.CLAUDE_CODE_USE_GATEWAY
  process.env.CLAUDE_CONFIG_DIR = directory
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  try {
    const { getSessionId } = await import('../src/bootstrap/state.ts')
    const { getClaudeConfigHomeDir } = await import('../src/utils/envUtils.ts')
    const root = getSessionId()
    const familyPath = join(getClaudeConfigHomeDir(), 'leaf-families', `${root}.json`)
    // Seed real transcript content so a delete would be observable.
    const transcript = join(directory, 'archived.jsonl')
    await writeFile(transcript, JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: randomUUID(), parentUuid: null, isSidechain: false, message: { role: 'user', content: 'ARCHIVE_MUST_KEEP_ME' }, timestamp: new Date().toISOString() }) + '\n')
    const member = await addLeafMember(familyPath, root, { sessionId: randomUUID(), parentSessionId: root, name: 'Detach me', transcriptPath: transcript, forkMessageId: randomUUID() })

    await changeLeaf(member.sessionId, { status: 'archived' })

    // Detached: gone from the family list the menu reads, and out of the views
    // the carousel reads, so it stops appearing anywhere.
    const family = await readLeafFamily(familyPath, root)
    assert.equal(family.members.find(item => item.sessionId === member.sessionId)?.status, 'archived')
    const { listLeafMembers, getLeafViews } = await import('../src/utils/leafWorkspace.ts')
    assert.equal((await listLeafMembers()).filter(item => item.status !== 'archived').length, 0)
    assert.equal(getLeafViews().some(view => view.member.sessionId === member.sessionId), false)

    // Not deleted: the transcript still holds its content.
    assert.match(await readFile(transcript, 'utf8'), /ARCHIVE_MUST_KEEP_ME/)
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    if (savedGateway === undefined) delete process.env.CLAUDE_CODE_USE_GATEWAY
    else process.env.CLAUDE_CODE_USE_GATEWAY = savedGateway
    await rm(directory, { recursive: true, force: true })
  }
})

test('reviving an archived leaf files it back in without starting it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaf-revive-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  const savedGateway = process.env.CLAUDE_CODE_USE_GATEWAY
  process.env.CLAUDE_CONFIG_DIR = directory
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  try {
    const { getSessionId } = await import('../src/bootstrap/state.ts')
    const { getClaudeConfigHomeDir } = await import('../src/utils/envUtils.ts')
    const { reviveLeaf, listLeafMembers, getLeafViews } = await import('../src/utils/leafWorkspace.ts')
    const root = getSessionId()
    const familyPath = join(getClaudeConfigHomeDir(), 'leaf-families', `${root}.json`)
    const member = await addLeafMember(familyPath, root, { sessionId: randomUUID(), parentSessionId: root, name: 'Revive me', transcriptPath: join(directory, 'revive.jsonl'), forkMessageId: randomUUID() })
    await changeLeaf(member.sessionId, { status: 'archived' })
    assert.equal((await listLeafMembers()).filter(item => item.status !== 'archived').length, 0)
    assert.equal(getLeafViews().some(view => view.member.sessionId === member.sessionId), false)

    // Reviving by number, which is how a person names a leaf: an archived member
    // is still a member, so every reference the family accepts still resolves.
    const notice = await reviveLeaf(String(member.number))

    assert.equal((await listLeafMembers()).find(item => item.sessionId === member.sessionId)?.status, 'closed')
    // Back on the list and still shut: reviving is filing, not opening, so
    // nothing can have started.
    assert.equal(getLeafViews().some(view => view.member.sessionId === member.sessionId), false)
    assert.match(notice, /back in the leaf list/)
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    if (savedGateway === undefined) delete process.env.CLAUDE_CODE_USE_GATEWAY
    else process.env.CLAUDE_CODE_USE_GATEWAY = savedGateway
    await rm(directory, { recursive: true, force: true })
  }
})

test('a member that held the patriarch role is filed as an elder, and a merely parked member is not', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaf-elder-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  const savedGateway = process.env.CLAUDE_CODE_USE_GATEWAY
  process.env.CLAUDE_CONFIG_DIR = directory
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  try {
    const { getSessionId } = await import('../src/bootstrap/state.ts')
    const workspace = await import('../src/utils/leafWorkspace.ts')
    const root = getSessionId()
    workspace.forgetLeafFamilyRoot()
    const family = join(directory, 'leaf-families', `${root}.json`)
    const held = await addLeafMember(family, root, { sessionId: randomUUID(), parentSessionId: root, name: 'Held', transcriptPath: join(directory, 'held.jsonl'), forkMessageId: randomUUID() })
    const parked = await addLeafMember(family, root, { sessionId: randomUUID(), parentSessionId: root, name: 'Parked', transcriptPath: join(directory, 'parked.jsonl'), forkMessageId: randomUUID() })
    const member = async (sessionId: string) => (await readLeafFamily(family, root)).members.find(item => item.sessionId === sessionId)!

    // Holding the role is not eldership: the mark records that the role was held
    // and given up, so a member that is the patriarch right now is not an elder.
    await workspace.writePatriarchDesignation(root, held.sessionId)
    assert.equal((await member(held.sessionId)).eldership, undefined, 'holding the role is not eldership')

    // It is parked while it holds the designation, so the succession that parks
    // it is what makes it an elder - and the roster files it as one.
    await workspace.changeLeaf(held.sessionId, { status: 'archived' })
    assert.equal((await member(held.sessionId)).eldership, true, 'a member that held the role and gave it up is an elder')
    assert.match(await workspace.familyRoster(), new RegExp(`^#${held.number} Held \\[archived\\] \\[elder\\] ${held.sessionId}$`, 'm'), 'the elder is filed as one in the family view')

    // A member that was merely parked never held the role, so it is not an elder:
    // the two are the exact pair eldership exists to tell apart.
    await workspace.changeLeaf(parked.sessionId, { status: 'closed' })
    assert.equal((await member(parked.sessionId)).status, 'closed')
    assert.equal((await member(parked.sessionId)).eldership, undefined, 'a member that never held the role is not an elder')

    // The fact is durable: it is a record of what happened, so nothing clears it.
    assert.equal((await member(held.sessionId)).eldership, true, 'eldership survives every later read')
  } finally {
    // The resolved root and the matriarch lease are module state this case took;
    // give them back so the cases after it read their own family, not this one.
    const workspace = await import('../src/utils/leafWorkspace.ts')
    workspace.forgetLeafFamilyRoot()
    workspace.clearMatriarchClaimForTesting()
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    if (savedGateway === undefined) delete process.env.CLAUDE_CODE_USE_GATEWAY
    else process.env.CLAUDE_CODE_USE_GATEWAY = savedGateway
    await rm(directory, { recursive: true, force: true })
  }
})

test('naming an heir records a designation the family reads, and ascending clears it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaf-heir-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  const savedGateway = process.env.CLAUDE_CODE_USE_GATEWAY
  process.env.CLAUDE_CONFIG_DIR = directory
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  try {
    const { getSessionId } = await import('../src/bootstrap/state.ts')
    const workspace = await import('../src/utils/leafWorkspace.ts')
    const root = getSessionId()
    workspace.forgetLeafFamilyRoot()
    await workspace.restoreLeafWorkspace()
    const family = join(directory, 'leaf-families', `${root}.json`)
    const pointerPath = join(directory, 'leaf-families', 'index', `${root}.json`)
    const heir = await addLeafMember(family, root, { sessionId: randomUUID(), parentSessionId: root, name: 'Heir', transcriptPath: join(directory, 'heir.jsonl'), forkMessageId: randomUUID() })
    const other = await addLeafMember(family, root, { sessionId: randomUUID(), parentSessionId: root, name: 'Other', transcriptPath: join(directory, 'other.jsonl'), forkMessageId: randomUUID() })
    const pointer = async () => JSON.parse(await readFile(pointerPath, 'utf8')) as { patriarchSessionId?: string; heirSessionId?: string }

    // Naming an heir is a designation, not a mode: the member keeps its name and
    // its row, and the family reads it back from the same pointer the patriarch
    // designation lives in - the field an older reader simply ignores.
    assert.match(await workspace.conferHeir(heir.sessionId), /^Leaf #\d+ Heir is now the family heir\.$/)
    assert.equal(workspace.getLeafHeirSessionId(), heir.sessionId, 'the heir is readable as a designation')
    assert.equal((await pointer()).heirSessionId, heir.sessionId, 'the designation is written where the patriarch’s is')
    assert.match(await workspace.familyRoster(), new RegExp(`^#${heir.number} Heir \\[open\\] \\[heir\\] ${heir.sessionId}$`, 'm'), 'the family view files the heir')

    // Refusals: a reference outside the family, the member that is the patriarch
    // (it cannot succeed itself), the member that is already the heir, and a
    // target whose turn is in flight.
    await assert.rejects(workspace.conferHeir(randomUUID()), /Unknown leaf/)
    await assert.rejects(workspace.conferHeir(root), /already the family head/)
    await assert.rejects(workspace.conferHeir(heir.sessionId), /already the family heir/)
    const { leaf } = parkedLeaf()
    leaf.setState('running')
    const unregister = workspace.registerLeafViewForTesting({ rootSessionId: root, member: other as never, process: leaf as never, draft: '' })
    try {
      await assert.rejects(workspace.conferHeir(other.sessionId), /Wait for the leaf turn/)
    } finally { unregister() }

    // The designation is singular: naming a new heir replaces the old one, and
    // the member that was the heir keeps every other fact about itself.
    assert.match(await workspace.conferHeir(other.sessionId), /now the family heir/)
    assert.equal(workspace.getLeafHeirSessionId(), other.sessionId, 'one heir at a time')
    assert.match(await workspace.familyRoster(), new RegExp(`^#${other.number} Other \\[open\\] \\[heir\\] ${other.sessionId}$`, 'm'), 'the new heir is the one filed')

    // A write that does not move the role leaves the raise in place: the heir
    // was raised under the patriarch that is still there.
    await workspace.writePatriarchDesignation(root, root)
    assert.equal(workspace.getLeafHeirSessionId(), other.sessionId, 'a raise survives a write that does not move the role')

    // Ascension clears the designation: the member being raised takes the role,
    // so it stops being the heir in the same write - and the patriarch it
    // displaces is filed as an elder by that same write.
    await workspace.conferPatriarch(other.sessionId)
    assert.equal(workspace.getLeafHeirSessionId(), undefined, 'the heir that ascends stops being the heir')
    assert.equal((await pointer()).heirSessionId, undefined, 'the cleared designation is gone from the pointer too')
    assert.doesNotMatch(await workspace.familyRoster(), /\[heir\]/, 'no row is marked the heir after ascension')
    assert.equal((await readLeafFamily(family, root)).members.find(item => item.sessionId === root)!.eldership, true, 'the displaced patriarch is an elder')
  } finally {
    // The resolved root and the matriarch lease are module state this case took;
    // give them back so the cases after it read their own family, not this one.
    const workspace = await import('../src/utils/leafWorkspace.ts')
    workspace.forgetLeafFamilyRoot()
    workspace.clearMatriarchClaimForTesting()
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    if (savedGateway === undefined) delete process.env.CLAUDE_CODE_USE_GATEWAY
    else process.env.CLAUDE_CODE_USE_GATEWAY = savedGateway
    await rm(directory, { recursive: true, force: true })
  }
})

test('the patriarch is read from the family pointer, never from a member copy', async () => {
  // A member's own loose pointer carries the designation too, so a leaf resumed
  // on its own reads the family it belongs to. That copy is a republication of
  // what one reader resolved - written by whoever indexed the family last - and
  // it can disagree with the family-id pointer it came from. The family-id
  // pointer is the authority; a copy is never one. So a copy is made to name a
  // different member and every reading is held to what the family pointer says.
  const directory = await mkdtemp(join(tmpdir(), 'leaf-designation-copy-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  const savedGateway = process.env.CLAUDE_CODE_USE_GATEWAY
  process.env.CLAUDE_CONFIG_DIR = directory
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  try {
    const { getSessionId } = await import('../src/bootstrap/state.ts')
    const workspace = await import('../src/utils/leafWorkspace.ts')
    const root = getSessionId()
    workspace.forgetLeafFamilyRoot()
    await workspace.restoreLeafWorkspace()
    const family = join(directory, 'leaf-families', `${root}.json`)
    const designated = await addLeafMember(family, root, { sessionId: randomUUID(), parentSessionId: root, name: 'Designated', transcriptPath: join(directory, 'designated.jsonl'), forkMessageId: randomUUID() })
    const other = await addLeafMember(family, root, { sessionId: randomUUID(), parentSessionId: root, name: 'Other', transcriptPath: join(directory, 'other.jsonl'), forkMessageId: randomUUID() })
    // Conferring is what writes the member copies, so it is also what makes the
    // disagreement real rather than hypothetical: one copy is then made to lie.
    assert.match(await workspace.conferPatriarch(designated.sessionId), /now the family head/)
    const copyPath = join(directory, 'leaf-families', 'index', `${other.sessionId}.json`)
    const copy = JSON.parse(await readFile(copyPath, 'utf8')) as { patriarchSessionId?: string; formerPatriarchIds?: string[] }
    assert.equal(copy.patriarchSessionId, designated.sessionId, 'the copy is published from the designation')
    copy.patriarchSessionId = other.sessionId
    // The elder record is republished into the same copy, so it is held to the
    // same rule: a copy that names an extra elder cannot put that mark on the
    // roster. Without this a republication bug in the elder field would hide
    // behind the patriarch assertions above.
    copy.formerPatriarchIds = [other.sessionId]
    await writeFile(copyPath, JSON.stringify(copy))
    assert.equal(JSON.parse(await readFile(join(directory, 'leaf-families', 'index', `${root}.json`), 'utf8')).patriarchSessionId, designated.sessionId, 'the family pointer is untouched by the copy')

    // The copy is now wrong; the pointers on disk disagree. Every reading must
    // still answer with the family pointer's member, which is only visible if
    // the read goes back to that pointer rather than trusting a copy.
    assert.match(await workspace.familyRoster(), new RegExp(`^#${designated.number} Designated \\[open\\] \\[head\\] ${designated.sessionId}$`, 'm'), 'the roster marks the family pointer’s member')
    assert.doesNotMatch(await workspace.familyRoster(), new RegExp(`^#${other.number} Other \\[open\\] \\[head\\]`, 'm'), 'the roster must not follow a member copy')
    assert.equal(workspace.getLeafPatriarchSessionId(), designated.sessionId, 'the session-wide answer follows the family pointer')
    assert.equal((await workspace.resolveLeafRef('patriarch'))?.sessionId, designated.sessionId, 'the patriarch reference follows the family pointer')
    assert.doesNotMatch(await workspace.familyRoster(), new RegExp(`^#${other.number} Other \\[open\\] \\[elder\\]`, 'm'), 'the roster must not follow a member copy’s elder record')
  } finally {
    // The resolved root and the matriarch lease are module state this case took;
    // give them back so the cases after it read their own family, not this one.
    const workspace = await import('../src/utils/leafWorkspace.ts')
    workspace.forgetLeafFamilyRoot()
    workspace.clearMatriarchClaimForTesting()
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    if (savedGateway === undefined) delete process.env.CLAUDE_CODE_USE_GATEWAY
    else process.env.CLAUDE_CODE_USE_GATEWAY = savedGateway
    await rm(directory, { recursive: true, force: true })
  }
})

test('a stale designation records the member the move displaced, not the one the pointer still names', async () => {
  // A designated member that dies is filed away without the designation moving,
  // so the pointer keeps naming it while every reader resolves the role to the
  // member that can act. A conferral then displaces the acting member, and the
  // elder record must name that member - the one whose title this write demotes -
  // rather than the stale name the pointer still carries. Otherwise the history
  // gains a member the family never displaced and disagrees with the demotion.
  const directory = await mkdtemp(join(tmpdir(), 'leaf-stale-designation-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  const savedGateway = process.env.CLAUDE_CODE_USE_GATEWAY
  process.env.CLAUDE_CONFIG_DIR = directory
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  try {
    const { getSessionId } = await import('../src/bootstrap/state.ts')
    const workspace = await import('../src/utils/leafWorkspace.ts')
    const root = getSessionId()
    workspace.forgetLeafFamilyRoot()
    await workspace.restoreLeafWorkspace()
    const family = join(directory, 'leaf-families', `${root}.json`)
    const gone = await addLeafMember(family, root, { sessionId: randomUUID(), parentSessionId: root, name: 'Gone', transcriptPath: join(directory, 'gone.jsonl'), forkMessageId: randomUUID() })
    const target = await addLeafMember(family, root, { sessionId: randomUUID(), parentSessionId: root, name: 'Target', transcriptPath: join(directory, 'target.jsonl'), forkMessageId: randomUUID() })
    // Designate Gone, then file it away exactly as its process dying does: the
    // pointer still names it, which is the stale designation this case is about.
    await workspace.writePatriarchDesignation(root, gone.sessionId)
    await updateLeafMember(family, root, gone.sessionId, { status: 'closed' })
    const pointerPath = join(directory, 'leaf-families', 'index', `${root}.json`)
    assert.equal(JSON.parse(await readFile(pointerPath, 'utf8')).patriarchSessionId, gone.sessionId, 'the pointer still names the filed-away member')
    assert.equal(workspace.getLeafPatriarchSessionId(), root, 'every reader resolves the role to the member that can act')
    assert.doesNotMatch(await workspace.familyRoster(), new RegExp(`^#${gone.number} Gone \\[closed\\] \\[head\\]`, 'm'), 'the stale name is not marked as the patriarch')

    // An ordinary mount re-indexes the family. The family pointer is the root's
    // own entry, so it must keep the designation as written - the filed-away
    // member - while the member copies get the acting answer. Writing the acting
    // answer to the family pointer would heal away the record of who was
    // displaced on every mount, which is the ordinary path rather than a crash.
    await workspace.restoreLeafWorkspace()
    assert.equal(JSON.parse(await readFile(pointerPath, 'utf8')).patriarchSessionId, gone.sessionId, 'the mount leaves the family pointer’s designation as written')
    assert.equal(JSON.parse(await readFile(join(directory, 'leaf-families', 'index', `${target.sessionId}.json`), 'utf8')).patriarchSessionId, root, 'the member copy names the member that can act')

    // The acting patriarch is the creator, so conferring displaces the creator.
    assert.match(await workspace.conferPatriarch(target.sessionId), /now the family head/)
    const after = JSON.parse(await readFile(pointerPath, 'utf8')) as { formerPatriarchIds?: string[] }
    assert.deepEqual(after.formerPatriarchIds, [root], 'the elder record names the member the move displaced')
    assert.doesNotMatch(await workspace.familyRoster(), new RegExp(`^#${gone.number} Gone \\[closed\\] \\[elder\\]`, 'm'), 'the stale name is not recorded as an elder')
  } finally {
    const workspace = await import('../src/utils/leafWorkspace.ts')
    workspace.forgetLeafFamilyRoot()
    workspace.clearMatriarchClaimForTesting()
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    if (savedGateway === undefined) delete process.env.CLAUDE_CODE_USE_GATEWAY
    else process.env.CLAUDE_CODE_USE_GATEWAY = savedGateway
    await rm(directory, { recursive: true, force: true })
  }
})

test('worktree leaf rejects the current working tree before creating a fork', async () => {
  const { getCwdState, setCwdState, getSessionId, getSessionProjectDir, getSessionResumeDirectory, switchSession } = await import('../src/bootstrap/state.ts')
  const { resolve } = await import('node:path')
  const previous = getCwdState()
  const projectDir = getSessionProjectDir()
  const resumeDirectory = getSessionResumeDirectory()
  const directory = await mkdtemp(join(tmpdir(), 'leaf-worktree-'))
  const savedConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  const workspace = await import('../src/utils/leafWorkspace.ts')
  workspace.forgetLeafFamilyRoot()
  workspace.clearMatriarchClaimForTesting()
  setCwdState(resolve(import.meta.dir, '..'))
  switchSession(getSessionId(), projectDir, getCwd())
  try {
    await workspace.restoreLeafWorkspace()
    await updateLeafMember(join(directory, 'leaf-families', `${getSessionId()}.json`), getSessionId(), getSessionId(), { cwd: getCwd() })
    await assert.rejects(createLeaf('Must not create', getSessionId(), getCwd()), /separate worktree/)
  }
  finally {
    switchSession(getSessionId(), projectDir, resumeDirectory)
    setCwdState(previous)
    if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedConfig
    workspace.forgetLeafFamilyRoot()
    workspace.clearMatriarchClaimForTesting()
    await rm(directory, { recursive: true, force: true })
  }
})

test('nested fork copies the selected leaf transcript with immutable immediate ancestry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaf-fork-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  try {
    const parent = randomUUID()
    const messageId = randomUUID()
    const source = join(directory, 'parent.jsonl')
    const entry = { type: 'user', uuid: messageId, sessionId: parent, parentUuid: null, isSidechain: false, message: { role: 'user', content: 'SELECTED_LEAF_CONTEXT' }, timestamp: new Date().toISOString() }
    await writeFile(source, JSON.stringify(entry) + '\n')
    const fork = await createFork(undefined, { sessionId: parent, transcriptPath: source })
    assert.notEqual(fork.sessionId, parent)
    assert.equal(fork.serializedMessages.at(-1)?.uuid, messageId)
    const copied = JSON.parse((await readFile(fork.forkPath, 'utf8')).trim())
    assert.deepEqual(copied.forkedFrom, { sessionId: parent, messageUuid: messageId })
    assert.equal(copied.message.content, 'SELECTED_LEAF_CONTEXT')
    await writeFile(source, '')
    assert.equal(JSON.parse((await readFile(fork.forkPath, 'utf8')).trim()).message.content, 'SELECTED_LEAF_CONTEXT')
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    await rm(directory, { recursive: true, force: true })
  }
})

test('fork copies the active conversation chain, not abandoned sibling turns', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaf-chain-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  try {
    const sessionId = randomUUID(), root = randomUUID(), abandoned = randomUUID(), active = randomUUID()
    const source = join(directory, 'source.jsonl')
    await writeFile(source, [
      { uuid: root, parentUuid: null, text: 'SHARED_CONTEXT', timestamp: '2026-09-08T00:00:00.000Z' },
      { uuid: abandoned, parentUuid: root, text: 'ABANDONED_BRANCH', timestamp: '2026-09-08T00:00:01.000Z' },
      { uuid: active, parentUuid: root, text: 'ACTIVE_BRANCH', timestamp: '2026-09-08T00:00:02.000Z' },
    ].map(({ text, ...entry }) => JSON.stringify({ ...entry, type: 'user', sessionId, isSidechain: false, message: { role: 'user', content: text } })).join('\n') + '\n')
    const fork = await createFork(undefined, { sessionId, transcriptPath: source })
    assert.deepEqual(fork.serializedMessages.map(message => message.uuid), [root, active])
    assert.doesNotMatch(await readFile(fork.forkPath, 'utf8'), /ABANDONED_BRANCH/)
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    await rm(directory, { recursive: true, force: true })
  }
})

test('five concurrent allocations preserve ancestry and never recycle numbers after close', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaf-family-'))
  const path = join(directory, 'family.json')
  const root = randomUUID()
  try {
    const members = await Promise.all(Array.from({ length: 5 }, (_, i) => addLeafMember(path, root, { sessionId: randomUUID(), parentSessionId: root, name: `Work ${i}`, transcriptPath: join(directory, `${i}.jsonl`), forkMessageId: randomUUID() })))
    assert.deepEqual(members.map(m => m.number).sort((a, b) => a - b), [1, 2, 3, 4, 5])
    const first = members[0]!
    await updateLeafMember(path, root, first.sessionId, { name: 'Renamed', status: 'closed' })
    const nested = await addLeafMember(path, root, { sessionId: randomUUID(), parentSessionId: first.sessionId, name: 'Nested', transcriptPath: join(directory, 'nested.jsonl'), forkMessageId: randomUUID() })
    assert.equal(nested.number, 6)
    await updateLeafMember(path, root, nested.sessionId, { model: 'claude-sonnet-4-6', effort: 'high', draft: 'Unsent leaf draft', scrollOffset: 12 })
    const restored = await readLeafFamily(path, root)
    assert.equal(restored.members.find(m => m.sessionId === nested.sessionId)!.effort, 'high')
    assert.equal(restored.members.find(m => m.sessionId === first.sessionId)!.number, first.number)
    assert.equal(restored.members.find(m => m.sessionId === first.sessionId)!.name, 'Renamed')
    assert.equal(restored.members.find(m => m.sessionId === nested.sessionId)!.draft, 'Unsent leaf draft')
    assert.equal(restored.members.find(m => m.sessionId === nested.sessionId)!.scrollOffset, 12)
    assert.equal(restored.nextNumber, 7)
    const returnId = randomUUID()
    await assert.rejects(recordLeafContextReturn(path, root, returnId, async () => { throw new Error('write failed') }), /write failed/)
    assert.equal((await readLeafFamily(path, root)).returnedContextIds.includes(returnId), false)
    let writes = 0
    const receipts = await Promise.all([0, 1].map(() => recordLeafContextReturn(path, root, returnId, async () => { writes++ })))
    assert.equal(writes, 1)
    assert.deepEqual(receipts.sort(), [false, true])
    await assert.rejects(readLeafFamily(path, randomUUID()), /identity/)
    await assert.rejects(addLeafMember(path, root, { ...first, parentSessionId: randomUUID(), sessionId: randomUUID() }), /Unknown leaf ancestry/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('the creator row is bootstrapped once, numbered last, and never renumbered', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaf-creator-bootstrap-'))
  const path = join(directory, 'family.json')
  const root = randomUUID()
  try {
    const work = await addLeafMember(path, root, { sessionId: randomUUID(), parentSessionId: root, name: 'Work', transcriptPath: join(directory, 'work.jsonl'), forkMessageId: randomUUID() })
    const creator = await ensureCreatorMember(path, root, { name: 'Original', transcriptPath: join(directory, 'root.jsonl') })
    assert.equal(creator?.number, 2, 'a family that predates the row numbers its creator after the leaves it already had')
    assert.equal(creator?.parentSessionId, root, 'the creator records itself as its own ancestry')
    assert.equal(creator?.forkMessageId, null, 'the creator was not forked from anything')
    assert.equal(creator?.status, 'open')
    assert.equal(await ensureCreatorMember(path, root, { name: 'Rewritten', transcriptPath: join(directory, 'other.jsonl') }), undefined, 'a second bootstrap is a no-op')
    const family = await readLeafFamily(path, root)
    assert.equal(family.members.filter(member => member.sessionId === root).length, 1, 'never a second creator row')
    assert.equal(family.members.find(member => member.sessionId === root)!.name, 'Original', 'and never a rewrite of what the first call recorded')
    assert.equal(family.nextNumber, 3, 'the bootstrap consumes its number once')
    assert.equal(family.members.find(member => member.sessionId === work.sessionId)!.number, work.number, 'no existing number moves')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a member resumed on its own finds its family, its siblings, and its parent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaf-member-discovery-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  try {
    const { getSessionId, getSessionProjectDir, getSessionResumeDirectory, switchSession } = await import('../src/bootstrap/state.ts')
    const { asSessionId } = await import('../src/types/ids.ts')
    const workspace = await import('../src/utils/leafWorkspace.ts')
    const { getTranscriptPath } = await import('../src/utils/sessionStorage.ts')
    const root = getSessionId()
    const rootTranscript = getTranscriptPath()
    const family = join(directory, 'leaf-families', `${root}.json`)
    const sibling = await addLeafMember(family, root, { sessionId: randomUUID(), parentSessionId: root, name: 'Sibling', transcriptPath: join(directory, 'sibling.jsonl'), forkMessageId: randomUUID() })
    const member = await addLeafMember(family, root, { sessionId: randomUUID(), parentSessionId: root, name: 'Member', transcriptPath: join(directory, 'member.jsonl'), forkMessageId: randomUUID() })

    // Nothing in the family file names the family; only the root's own process
    // knows its transcript path and directory, so it writes the pointer every
    // member reads on the way back in.
    await workspace.restoreLeafWorkspace()
    const pointer = JSON.parse(await readFile(join(directory, 'leaf-families', 'index', `${member.sessionId}.json`), 'utf8'))
    assert.equal(pointer.rootSessionId, root, 'a member must be able to name the family it belongs to')
    assert.equal(pointer.rootTranscriptPath, rootTranscript, 'and to find the parent transcript it will be resumed from')

    // Opening the family gave the creator the row it never used to have: it is
    // an ordinary member now, numbered last because numbers are never recycled.
    const creator = (await readLeafFamily(family, root)).members.find(item => item.sessionId === root)
    assert.ok(creator, 'the family records the session it was created from')
    assert.equal(creator.number, 3)
    assert.equal(creator.transcriptPath, rootTranscript)

    // At the creator there is no parent target: the parent is the session asking.
    assert.equal(await workspace.leafCreatorMember(), undefined)
    assert.equal(await workspace.resolveLeafRef('patriarch'), undefined)
    assert.deepEqual((await workspace.listLeafMembers()).map(item => item.name), ['Sibling', 'Member'])
    // The reference a `close` resolves is the one that may name the session you
    // are in. Nothing else may: the list a reference resolves against leaves out
    // the conversation on screen so that `open` cannot start a second copy of it
    // - which is exactly the hole that made `close <this session>` an unknown
    // reference while the same close typed as `close me` worked.
    assert.equal(await workspace.resolveLeafRef(root), undefined, 'the session on screen is not a target')
    assert.equal((await workspace.resolveCloseTarget(root))?.sessionId, root, 'but a close may name it by its id')
    assert.equal((await workspace.resolveCloseTarget('3'))?.sessionId, root, 'and by its own number in the family')
    assert.equal((await workspace.resolveCloseTarget('Original'))?.sessionId, root, 'and by its own name')
    assert.equal((await workspace.resolveCloseTarget('Sibling'))?.name, 'Sibling', 'while a sibling resolves as any other reference does')
    // Closing the session you are in is not a refusal: with no live leaf to take
    // the terminal it leaves the way Ctrl-C leaves, and the family keeps its
    // leaves and its files.
    let left = false
    const unregisterHandoff = workspace.registerLeafMatriarchHandoff({
      prepare: async () => {},
      resume: async () => {},
      exit: async () => { left = true },
    })
    try {
      assert.equal(
        await workspace.changeLeaf(root, { status: 'closed' }),
        'Leaving this session; the family keeps its leaves and its files.',
        'a session closing itself leaves rather than being refused',
      )
      const deadline = Date.now() + 2000
      while (!left && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
      assert.equal(left, true, 'and the departure is what runs, not a handoff to a leaf that is not open')
    } finally { unregisterHandoff() }

    // Now be that member: a leaf resumed on its own, with no parent above it.
    const projectDir = getSessionProjectDir()
    const resumeDirectory = getSessionResumeDirectory()
    switchSession(asSessionId(member.sessionId), null, directory)
    workspace.forgetLeafFamilyRoot()
    try {
      assert.equal(await workspace.familyRootSessionId(), root, 'the member resolves the family it was forked from')
      assert.deepEqual((await workspace.listLeafMembers()).map(item => item.sessionId), [sibling.sessionId, root], 'it sees its siblings and the creator, not itself')
      const parent = await workspace.leafCreatorMember()
      assert.equal(parent?.sessionId, root)
      assert.equal(parent?.number, creator.number, 'the creator is a numbered member like any other')
      assert.equal(parent?.transcriptPath, rootTranscript, 'the creator row carries the transcript to resume')
      assert.equal((await workspace.resolveLeafRef('patriarch'))?.sessionId, root, 'the parent is addressable by name')
      assert.equal((await workspace.resolveLeafRef('1'))?.name, 'Sibling', 'and a sibling by number')
      // `cc --resume <leaf id>` is the address the menu hands out for a member,
      // and the window it opens carries none of the launch environment a spawn
      // does - so the member it is showing has to be named from the family's own
      // records. The roster keeps leaving the asker out, because a row for the
      // conversation you are in would offer to open or close it; the menu's
      // roster carries it back so the rows can drop it knowingly and the wizard
      // can offer it, and the id nothing was selected under is this window.
      assert.equal(workspace.selectedLeafId(), member.sessionId, 'the window is the member it was resumed on')
      assert.equal(await workspace.selfLeafMemberId(), member.sessionId, 'and the records say so')
      assert.deepEqual(
        (await workspace.listLeafMenuMembers()).map(item => item.sessionId),
        [sibling.sessionId, root, member.sessionId],
        'the menu roster names the session on screen as well',
      )
      assert.equal(
        workspace.resolveLeafSource(undefined, { creator: root, patriarch: root, self: member.sessionId }, workspace.selectedLeafId()),
        member.sessionId,
        'a leaf created without a source named copies the conversation on screen, not the parent behind it',
      )
      const roster = await workspace.familyRoster()
      assert.match(roster, new RegExp(`^family ${root}$`, 'm'))
      assert.match(roster, new RegExp(`^#${creator.number} \\S.* \\[head\\] ${root}$`, 'm'))
      // The creator is an ordinary member now: a member can close it, rename it
      // and archive it. Only the session doing the asking is still refused.
      await workspace.changeLeaf(root, { status: 'closed' })
      await workspace.changeLeaf(root, { name: 'Mine now' })
      assert.equal((await readLeafFamily(family, root)).members.find(item => item.sessionId === root)?.name, 'Mine now')
      await workspace.changeLeaf(root, { status: 'archived' })
      assert.equal((await readLeafFamily(family, root)).members.find(item => item.sessionId === root)?.status, 'archived')
      await workspace.changeLeaf(root, { status: 'closed' })
    } finally {
      switchSession(asSessionId(root), projectDir, resumeDirectory)
      workspace.forgetLeafFamilyRoot()
    }
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    await rm(directory, { recursive: true, force: true })
  }
})

test('the designated patriarch is the one patriarch and root name, and original never moves', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaf-parent-designation-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  try {
    const { getSessionId, getSessionProjectDir, getSessionResumeDirectory, switchSession } = await import('../src/bootstrap/state.ts')
    const { asSessionId } = await import('../src/types/ids.ts')
    const workspace = await import('../src/utils/leafWorkspace.ts')
    const root = getSessionId()
    const family = join(directory, 'leaf-families', `${root}.json`)
    const sibling = await addLeafMember(family, root, { sessionId: randomUUID(), parentSessionId: root, name: 'Sibling', transcriptPath: join(directory, 'sibling.jsonl'), forkMessageId: randomUUID() })
    const member = await addLeafMember(family, root, { sessionId: randomUUID(), parentSessionId: root, name: 'Member', transcriptPath: join(directory, 'member.jsonl'), forkMessageId: randomUUID() })
    await workspace.restoreLeafWorkspace()

    // Now be the member: a leaf resumed on its own, with no parent above it.
    const projectDir = getSessionProjectDir()
    const resumeDirectory = getSessionResumeDirectory()
    switchSession(asSessionId(member.sessionId), null, directory)
    workspace.forgetLeafFamilyRoot()
    try {
      // With nothing designated the family id is the parent: exactly what a
      // family written before the designation reads.
      assert.equal(workspace.getLeafPatriarchSessionId(), root, 'the family id is the parent until one is designated')
      assert.equal((await workspace.resolveLeafRef('patriarch'))?.sessionId, root)
      assert.equal((await workspace.resolveLeafRef('root'))?.sessionId, root)
      assert.equal((await workspace.resolveLeafRef('original'))?.sessionId, root)

      // The designation lives in the family-id pointer, so a member that was
      // already running sees it with no family-file change and no reload.
      await workspace.writePatriarchDesignation(root, sibling.sessionId)
      const pointerPath = join(directory, 'leaf-families', 'index', `${root}.json`)
      assert.equal(JSON.parse(await readFile(pointerPath, 'utf8')).patriarchSessionId, sibling.sessionId, 'the designation is written into the family-id pointer')
      assert.equal((await workspace.resolveLeafRef('patriarch'))?.sessionId, sibling.sessionId, 'the designated member is the parent')
      assert.equal((await workspace.resolveLeafRef('root'))?.sessionId, sibling.sessionId, 'and root means the same member')
      assert.equal((await workspace.resolveLeafRef('original'))?.sessionId, root, 'original stays the creator, wherever the parent goes')
      assert.equal(workspace.getLeafPatriarchSessionId(), sibling.sessionId, 'the session-wide answer follows the designation too')
      // The member pointer is a copy taken when it was indexed; the family-id
      // pointer is the authority, so a stale copy cannot name the wrong parent.
      assert.equal(JSON.parse(await readFile(join(directory, 'leaf-families', 'index', `${member.sessionId}.json`), 'utf8')).patriarchSessionId, root, 'the member pointer still carries the value it was indexed with')
      const creatorNumber = (await readLeafFamily(family, root)).members.find(item => item.sessionId === root)!.number
      const roster = await workspace.familyRoster()
      assert.match(roster, new RegExp(`^family ${root}$`, 'm'), 'the family is still named by its id, which never moves')
      assert.match(roster, new RegExp(`^#${sibling.number} Sibling \\[open\\] \\[head\\] ${sibling.sessionId}$`, 'm'), 'the mark follows the designation')
      // The creator held the role until this designation took it away, so it is
      // filed as an elder now: that is exactly the fact eldership records.
      assert.match(roster, new RegExp(`^#${creatorNumber} \\S.* \\[open\\] \\[elder\\] ${root}$`, 'm'), 'the member the designation moved away from is an elder')

      // A pointer with no designation at all - the shape older code writes -
      // still names a parent: the family id, which is the creator.
      const pointer = JSON.parse(await readFile(pointerPath, 'utf8'))
      delete pointer.patriarchSessionId
      await writeFile(pointerPath, JSON.stringify(pointer))
      assert.equal((await workspace.resolveLeafRef('patriarch'))?.sessionId, root, 'an absent designation falls back to the family id')
      assert.equal((await workspace.resolveLeafRef('original'))?.sessionId, root)
    } finally {
      switchSession(asSessionId(root), projectDir, resumeDirectory)
      workspace.forgetLeafFamilyRoot()
    }
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    await rm(directory, { recursive: true, force: true })
  }
})

test('a member the head puts in charge of leaves carries the driver tag and its scope', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaf-driver-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  try {
    const { getSessionId } = await import('../src/bootstrap/state.ts')
    const workspace = await import('../src/utils/leafWorkspace.ts')
    const root = getSessionId()
    const family = join(directory, 'leaf-families', `${root}.json`)
    const driver = await addLeafMember(family, root, { sessionId: randomUUID(), parentSessionId: root, name: 'Driver', transcriptPath: join(directory, 'driver.jsonl'), forkMessageId: randomUUID() })
    const other = await addLeafMember(family, root, { sessionId: randomUUID(), parentSessionId: root, name: 'Other', transcriptPath: join(directory, 'other.jsonl'), forkMessageId: randomUUID() })
    const alpha = await addLeafMember(family, root, { sessionId: randomUUID(), parentSessionId: root, name: 'Alpha', transcriptPath: join(directory, 'alpha.jsonl'), forkMessageId: randomUUID() })
    const bravo = await addLeafMember(family, root, { sessionId: randomUUID(), parentSessionId: root, name: 'Bravo', transcriptPath: join(directory, 'bravo.jsonl'), forkMessageId: randomUUID() })
    await workspace.restoreLeafWorkspace()
    const pointer = () => readFile(join(directory, 'leaf-families', 'index', `${root}.json`), 'utf8')

    // Nothing is marked until the head names a driver: the role is a fact the
    // family file does not know, written into the loose pointer like the rest.
    assert.doesNotMatch(await workspace.familyRoster(), /\[driver/, 'no member is a driver until one is named')

    // ONE write names the driver and the leaves it drives - the role and its
    // scope are set together, and the roster shows which leaves, not a bare tag.
    assert.match(await workspace.conferDriver(driver.sessionId, [alpha.sessionId, bravo.sessionId]), /now drives Leaf #\d+ Alpha, Leaf #\d+ Bravo/)
    const roster = await workspace.familyRoster()
    assert.match(roster, new RegExp(`^#${driver.number} Driver \\[open\\] \\[driver→#${alpha.number},#${bravo.number}\\] ${driver.sessionId}$`, 'm'), 'the driver tag carries the leaves it drives')
    assert.doesNotMatch(roster, new RegExp(`^#${other.number} Other .* \\[driver`, 'm'), 'an unnamed member is not a driver')
    assert.deepEqual(workspace.getLeafDriverScope(), { [driver.sessionId]: [alpha.sessionId, bravo.sessionId] }, 'the scope reads back synchronously')
    assert.deepEqual(JSON.parse(await pointer()).driverScope, { [driver.sessionId]: [alpha.sessionId, bravo.sessionId] }, 'the scope lives in the family-id pointer')

    // A leaf belongs to at most one driver: a second is REFUSED, naming the
    // driver that holds it and the exact command that releases it. Nothing moves.
    await assert.rejects(workspace.conferDriver(other.sessionId, [alpha.sessionId]), (error: Error) => {
      assert.match(error.message, new RegExp(`Leaf #${alpha.number} Alpha is already driven by Leaf #${driver.number} Driver`))
      assert.match(error.message, new RegExp(`/leaf driver ${driver.number} ${bravo.number}$`))
      return true
    }, 'a second driver for a leaf is refused, not silently transferred')
    assert.deepEqual(workspace.getLeafDriverScope(), { [driver.sessionId]: [alpha.sessionId, bravo.sessionId] }, 'the refused write changed nothing')

    // A driver named before it has leaves drives nothing, and is still a driver:
    // an empty list clears the scope rather than dropping the role.
    assert.match(await workspace.conferDriver(other.sessionId, []), /driving no leaves yet/)
    assert.match(await workspace.familyRoster(), new RegExp(`^#${other.number} Other \\[open\\] \\[driver\\] ${other.sessionId}$`, 'm'), 'a zero-leaf driver is marked bare')

    // A closed driver does not hold its leaves: the stale entry is pruned, so a
    // leaf it drove can be re-designated instead of blocked forever.
    await updateLeafMember(family, root, driver.sessionId, { status: 'closed' })
    assert.match(await workspace.conferDriver(other.sessionId, [alpha.sessionId, bravo.sessionId]), /now drives/)
    assert.deepEqual(workspace.getLeafDriverScope(), { [other.sessionId]: [alpha.sessionId, bravo.sessionId] }, 'the closed driver no longer holds its leaves')
    assert.doesNotMatch(await workspace.familyRoster(), new RegExp(`^#${driver.number} Driver .* \\[driver`, 'm'), 'the closed driver is no longer marked')
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    await rm(directory, { recursive: true, force: true })
  }
})

test('the session on screen sets its own model and effort by any of its names, and opening it is refused as already running', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaf-self-row-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  try {
    const { getSessionId } = await import('../src/bootstrap/state.ts')
    const workspace = await import('../src/utils/leafWorkspace.ts')
    const root = getSessionId()
    const family = join(directory, 'leaf-families', `${root}.json`)
    await addLeafMember(family, root, { sessionId: randomUUID(), parentSessionId: root, name: 'Alpha', transcriptPath: join(directory, 'alpha.jsonl'), forkMessageId: randomUUID() })
    // Opening the family writes the creator's own row, so the session on screen
    // has an address like every other member.
    await workspace.restoreLeafWorkspace()
    const row = async () => (await readLeafFamily(family, root)).members.find(member => member.sessionId === root)!
    const self = await row()
    // The session on screen writes its own transcript in life; in a test it has
    // none, so give the read something to open.
    await mkdir(dirname(self.transcriptPath), { recursive: true })
    await writeFile(self.transcriptPath, '')

    // Every spelling the roster accepts resolves to this session and writes its
    // row. A setting is a row the next launch reads, not a second process, so
    // naming the session on screen is answered rather than refused - and before
    // this fix each of these answered "Unknown or ambiguous leaf reference".
    const spellings = [String(self.number), self.name, `${self.number}:${self.name}`, self.sessionId, 'head', 'root', 'original', 'matriarch']
    for (const reference of spellings) {
      const result = await workspace.configureLeaf(reference, { model: `model-${reference}` })
      assert.match(result, /saved for restart; this session keeps its current route until it is relaunched/, `${reference} resolves to the session on screen`)
      // The old wording claimed the change was applied; a row write is only a
      // route for the next launch, so the honest message says so.
      assert.doesNotMatch(result, /updated and saved for restart/, `${reference} does not claim the live route changed`)
      assert.equal((await row()).model, `model-${reference}`, `${reference} wrote the row`)
    }
    assert.match(await workspace.configureLeaf(String(self.number), { effort: 'high' }), /effort high saved for restart/)
    assert.equal((await row()).effort, 'high', 'effort is written the same way')

    // Nothing was launched: the settings path writes the row and stops, so there
    // is no second copy of the conversation on screen.
    assert.deepEqual(workspace.getLeafViews(), [], 'setting your own row starts no leaf process')

    // A read of this session still works - it always did, on its own resolver.
    assert.match(await workspace.readLeafTranscript(self.sessionId), new RegExp(`Leaf #${self.number} ${self.name} \\(${self.sessionId}\\)`), 'a read of the session on screen resolves')

    // Opening the session on screen is still refused - it is already running -
    // but with its own message, distinct from a reference that names no leaf.
    await assert.rejects(workspace.resolveOpenTarget(String(self.number)), (error: Error) => {
      assert.match(error.message, /is the session asking: it is already running/)
      assert.doesNotMatch(error.message, /Unknown or ambiguous/)
      return true
    }, 'opening your own session is refused as already running')

    // A send reaches into another conversation, so the session on screen is not
    // a target either - and it is refused as itself, not as a leaf that is not
    // there. (Interrupt has the same shape but is out of this fix's scope.)
    await assert.rejects(workspace.sendLeafMessage(String(self.number), 'hello'), /is the session asking: a message to the conversation you are in is the turn you are already typing/)

    // A reference that names no member at all keeps the ordinary message, for
    // both a control verb and a launch verb.
    await assert.rejects(workspace.resolveOpenTarget('Nonexistent'), /Unknown or ambiguous leaf reference/)
    await assert.rejects(workspace.configureLeaf('Nonexistent', { model: 'x' }), /Unknown or ambiguous leaf reference/)
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    await rm(directory, { recursive: true, force: true })
  }
})

test('the creator hosted from a member is an ordinary entry, not a root line', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaf-hosted-parent-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  try {
    const { getSessionId } = await import('../src/bootstrap/state.ts')
    const workspace = await import('../src/utils/leafWorkspace.ts')
    const { leaf } = parkedLeaf()
    const root = getSessionId()
    const creator = {
      sessionId: root, parentSessionId: root, number: 3, name: 'Original',
      transcriptPath: join(directory, 'root.jsonl'), forkMessageId: null,
      createdAt: new Date(0).toISOString(), status: 'open',
    }
    const unregister = workspace.registerLeafViewForTesting({ rootSessionId: root, member: creator as never, process: leaf as never, draft: '' })
    try {
      // The creator is a member of its own family now, so a member that opened
      // it holds an ordinary view: the bar switches to it like any other, and
      // the roster published to the children lists it.
      assert.deepEqual(workspace.getLeafViews().map(view => view.member.sessionId), [root], 'the creator is a leaf of its own family now')
      assert.deepEqual(workspace.getLeafCarouselViews().map(view => view.member.sessionId), [root], 'and the bar can switch to it like any other')
    } finally { unregister() }
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    await rm(directory, { recursive: true, force: true })
  }
})

test('conferring the patriarch moves the name and the aliases without touching numbering or receipts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaf-reparent-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  try {
    const { getSessionId, getSessionProjectDir, getSessionResumeDirectory, switchSession } = await import('../src/bootstrap/state.ts')
    const { asSessionId } = await import('../src/types/ids.ts')
    const workspace = await import('../src/utils/leafWorkspace.ts')
    const root = getSessionId()
    const family = join(directory, 'leaf-families', `${root}.json`)
    const siblingPath = join(directory, 'sibling.jsonl')
    const memberPath = join(directory, 'member.jsonl')
    const sibling = await addLeafMember(family, root, { sessionId: randomUUID(), parentSessionId: root, name: 'Sibling', transcriptPath: siblingPath, forkMessageId: randomUUID() })
    const member = await addLeafMember(family, root, { sessionId: randomUUID(), parentSessionId: root, name: 'Member', transcriptPath: memberPath, forkMessageId: randomUUID() })
    await workspace.restoreLeafWorkspace()
    const before = await readLeafFamily(family, root)
    const titles = async (path: string) => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { type: string; customTitle?: string }).filter(entry => entry.type === 'custom-title').map(entry => entry.customTitle)

    // A re-parent rewrites a title, and a title is an append to the target's own
    // transcript - which a live session holds the writer lock for as long as it
    // lives. The lock that refuses a rename must not refuse this, or no leaf that
    // is up could ever be named the family's parent, which is the ordinary case.
    const { lock } = await import('../src/utils/lockfile.ts')
    const savedGateway = process.env.CLAUDE_CODE_USE_GATEWAY
    process.env.CLAUDE_CODE_USE_GATEWAY = '1'
    await mkdir(join(directory, 'gateway-writers'), { recursive: true })
    const writer = await lock(join(directory, 'gateway-writers', member.sessionId), { realpath: false, stale: 30000, retries: 0 })
    try {
      assert.match(await workspace.conferPatriarch(member.sessionId), /^Leaf #2 Member is now the family head/)
    } finally {
      await writer()
      if (savedGateway === undefined) delete process.env.CLAUDE_CODE_USE_GATEWAY
      else process.env.CLAUDE_CODE_USE_GATEWAY = savedGateway
    }
    // Only the displayed titles moved: the new parent's session reads as the
    // family, and the leaf that was the parent reads as a leaf of it.
    assert.equal(workspace.getLeafPatriarchName(), 'Member', 'the family is named after the member that is the parent now')
    assert.deepEqual(await titles(memberPath), ['Member'], 'the new parent takes its bare member name as the session title')
    await assert.rejects(readFile(siblingPath, 'utf8'), /ENOENT/, 'a member that is neither parent has no title written for it at all')
    // A re-parent creates no member and returns no context, so nothing that is
    // numbered or receipted can be disturbed by it.
    const after = await readLeafFamily(family, root)
    assert.equal(after.nextNumber, before.nextNumber, 'no number is spent')
    assert.deepEqual(after.returnedContextIds, before.returnedContextIds, 'no receipt is invalidated')
    assert.deepEqual(after.members.map(item => item.sessionId), before.members.map(item => item.sessionId), 'the same rows in the same order')
    assert.equal(after.members.find(item => item.sessionId === member.sessionId)!.name, 'Member', 'member names are untouched')
    // Refusals: a reference outside the family, the member that already holds
    // the designation, and a target whose turn is in flight.
    await assert.rejects(workspace.conferPatriarch(randomUUID()), /Unknown leaf/)
    await assert.rejects(workspace.conferPatriarch(member.sessionId), /already the family head/)
    const { leaf } = parkedLeaf()
    leaf.setState('running')
    const unregister = workspace.registerLeafViewForTesting({ rootSessionId: root, member: sibling as never, process: leaf as never, draft: '' })
    try {
      await assert.rejects(workspace.conferPatriarch(sibling.sessionId), /Wait for the leaf turn/)
    } finally { unregister() }

    // The alias split is clearest from a member that is neither the parent nor
    // the creator: the one the session on screen would otherwise be.
    const projectDir = getSessionProjectDir()
    const resumeDirectory = getSessionResumeDirectory()
    switchSession(asSessionId(sibling.sessionId), null, directory)
    workspace.forgetLeafFamilyRoot()
    try {
      assert.equal((await workspace.resolveLeafRef('patriarch'))?.sessionId, member.sessionId, 'parent is the designated member')
      assert.equal((await workspace.resolveLeafRef('root'))?.sessionId, member.sessionId, 'and root means the same member')
      assert.equal((await workspace.resolveLeafRef('original'))?.sessionId, root, 'original stays the creator, wherever the parent goes')
      assert.equal((await workspace.resolveLeafRef('original'))?.name, before.members.find(item => item.sessionId === root)!.name, 'and keeps the name the family was born with')
    } finally {
      switchSession(asSessionId(root), projectDir, resumeDirectory)
      workspace.forgetLeafFamilyRoot()
    }
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    await rm(directory, { recursive: true, force: true })
  }
})

test('a displaced matriarch refuses management but keeps the terminals it already attached', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaf-host-handoff-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  try {
    const { getSessionId } = await import('../src/bootstrap/state.ts')
    const workspace = await import('../src/utils/leafWorkspace.ts')
    const root = getSessionId()
    const family = join(directory, 'leaf-families', `${root}.json`)
    const claimPath = join(directory, 'leaf-families', 'index', `${root}.host.json`)
    const sibling = await addLeafMember(family, root, { sessionId: randomUUID(), parentSessionId: root, name: 'Sibling', transcriptPath: join(directory, 'sibling.jsonl'), forkMessageId: randomUUID() })
    // A window opened this family first and is holding one of its leaves. The
    // claim names this process as its pid, so the previous host reads as alive
    // and the member it was holding is inherited rather than started again.
    const first = randomUUID()
    const claim = (matriarchSessionId: string, generation: number, openMemberIds: string[]) => ({
      familyId: root, matriarchSessionId, pid: process.pid,
      processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      token: randomUUID(), generation, openMemberIds,
    })
    await mkdir(join(directory, 'leaf-families', 'index'), { recursive: true })
    await writeFile(claimPath, JSON.stringify(claim(first, 1, [sibling.sessionId])))
    // A window that has never seen this family is what opens it here; the lease
    // is module state, and the cases before this one took it.
    workspace.clearMatriarchClaimForTesting()

    // Opening the family takes the lease, and the member the previous host was
    // holding comes with it as an external one: it is still running there, and
    // starting a second copy is the one thing a family must never do.
    await workspace.restoreLeafWorkspace()
    assert.equal(workspace.isFamilyMatriarch(), true, 'the window that opened the family manages it')
    assert.equal(workspace.getLeafMatriarchSessionId(), root, 'and names itself as the manager')
    assert.deepEqual([...workspace.externallyHeldLeafIds()], [sibling.sessionId], 'the members the window it took over from is holding are reported as open there')

    // The terminal this window attached before the handoff is its own.
    const { leaf, sent } = parkedLeaf()
    const snapshots: { matriarchSessionId?: string }[] = []
    ;(leaf as unknown as { snapshot: (value: unknown) => void }).snapshot = value => { snapshots.push(value as never) }
    const unregister = workspace.registerLeafViewForTesting({ rootSessionId: root, member: sibling as never, process: leaf as never, draft: '' })
    try {
      // Another window opens the family, which is the whole of a handoff: the
      // most recently opened session is the one that manages it.
      const second = randomUUID()
      await writeFile(claimPath, JSON.stringify(claim(second, 2, [sibling.sessionId])))

      // Managing is refused, and refused before anything is written or started.
      const acts = [
        ['rename', () => workspace.changeLeaf(sibling.sessionId, { name: 'Renamed' })],
        ['close', () => workspace.changeLeaf(sibling.sessionId, { status: 'closed' })],
        ['archive', () => workspace.fileLeaf(sibling.sessionId, 'tag')],
        ['create', () => workspace.createLeaf('Another')],
        ['reparent', () => workspace.conferPatriarch(sibling.sessionId)],
        ['settings', () => workspace.configureLeaf(sibling.sessionId, { effort: 'low' })],
      ] as const
      for (const [what, act] of acts) {
        await assert.rejects(act(), /The family moved to another window/, `${what} must be refused in a window that no longer manages the family`)
      }
      assert.equal(workspace.isFamilyMatriarch(), false, 'the window reports itself displaced')
      assert.equal(workspace.getLeafMatriarchSessionId(), second, 'and names the window that manages the family now')
      // Reading the family is not managing it, so a displaced window still renders.
      assert.match(await workspace.listLeaves(), /Sibling/)
      assert.match(await workspace.familyRoster(), new RegExp(`^family ${root}$`, 'm'))

      // The terminals already attached are not taken away by the handoff: the
      // view survives and the leaf still takes a message from this window.
      assert.deepEqual(workspace.getLeafViews().map(view => view.member.sessionId), [sibling.sessionId], 'the attached terminal is not torn down')
      assert.match(await workspace.sendLeafMessage('Sibling', 'PING'), /Delivered to Leaf #1 Sibling/)
      assert.deepEqual(sent.map(item => item.prompt), [`${workspace.PEER_PROMPT_PREFIX}PING`], 'the message reaches the leaf it was already attached to')
      // A leaf learns the family moved from the snapshot, and the repaint happens
      // with the refusal rather than at whatever unrelated repaint comes next.
      assert.equal(snapshots.at(-1)?.matriarchSessionId, second, 'the leaf is told which window manages its family now')
    } finally { unregister() }
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    await rm(directory, { recursive: true, force: true })
  }
})

test('a lease whose window has exited is taken back', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaf-host-dead-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  const { getSessionId } = await import('../src/bootstrap/state.ts')
  const workspace = await import('../src/utils/leafWorkspace.ts')
  const root = getSessionId()
  const family = join(directory, 'leaf-families', `${root}.json`)
  const claimPath = join(directory, 'leaf-families', 'index', `${root}.host.json`)
  const holder = randomUUID()
  // Any number no process holds: `isProcessRunning` answers false for a pid it
  // cannot signal, which is the state a window that has exited leaves behind.
  const writeClaim = (matriarchSessionId: string, pid: number) => writeFile(claimPath, JSON.stringify({
    familyId: root, matriarchSessionId, pid,
    processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    token: randomUUID(), generation: 1, openMemberIds: [],
  }))
  try {
    const sibling = randomUUID()
    await addLeafMember(family, root, { sessionId: sibling, parentSessionId: root, name: 'Sibling', transcriptPath: join(directory, 'sibling.jsonl'), forkMessageId: randomUUID() })
    await mkdir(join(directory, 'leaf-families', 'index'), { recursive: true })
    await writeClaim(holder, process.pid)
    workspace.clearMatriarchClaimForTesting()
    await workspace.restoreLeafWorkspace()
    // A live holder keeps the family, exactly as it does when the roster is
    // re-read: what follows is about a lease nobody is behind any more.
    await writeClaim(holder, process.pid)
    await workspace.restoreLeafWorkspace()
    assert.equal(workspace.isFamilyMatriarch(), false, 'a window whose holder is still running is displaced')

    // The holder's window exits. Its lease is the file it left, and the pid in it
    // is dead - the reading is right and the session it names is not there, so a
    // window that took it at face value refused every close, open and rename of a
    // family nobody was managing, and only a restart cleared it.
    await writeClaim(holder, 0x7ffffff0)
    const promoted = await workspace.changeLeaf(sibling, { status: 'closed' })
    assert.equal(workspace.isFamilyMatriarch(), true, 'the window takes back a lease whose holder has exited')
    assert.equal(promoted, undefined, 'the member closed was not the family patriarch')
    assert.equal((JSON.parse(await readFile(claimPath, 'utf8')) as { matriarchSessionId: string }).matriarchSessionId, root, 'and the lease is rewritten to name it, so no other window reads the dead one')
    assert.equal((JSON.parse(await readFile(family, 'utf8')) as { members: { sessionId: string; status: string }[] }).members.find(member => member.sessionId === sibling)?.status, 'closed', 'the family it took back is one it can manage')
  } finally {
    workspace.clearMatriarchClaimForTesting()
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    await rm(directory, { recursive: true, force: true })
  }
})

test('reopening the family leaves the lease with the window that is holding it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaf-host-reopen-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  const { getSessionId } = await import('../src/bootstrap/state.ts')
  const workspace = await import('../src/utils/leafWorkspace.ts')
  const root = getSessionId()
  const family = join(directory, 'leaf-families', `${root}.json`)
  const claimPath = join(directory, 'leaf-families', 'index', `${root}.host.json`)
  const holder = randomUUID()
  const writeClaim = (matriarchSessionId: string) => writeFile(claimPath, JSON.stringify({
    familyId: root, matriarchSessionId, pid: process.pid,
    processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    token: randomUUID(), generation: 1, openMemberIds: [],
  }))
  try {
    await addLeafMember(family, root, { sessionId: randomUUID(), parentSessionId: root, name: 'Sibling', transcriptPath: join(directory, 'sibling.jsonl'), forkMessageId: randomUUID() })
    await mkdir(join(directory, 'leaf-families', 'index'), { recursive: true })
    await writeClaim(holder)
    workspace.clearMatriarchClaimForTesting()

    // Opening the family is what takes the lease, so a window that has never seen
    // it becomes the one that manages it - the most recently opened session wins.
    await workspace.restoreLeafWorkspace()
    assert.equal(workspace.isFamilyMatriarch(), true, 'a window with no lease takes it by opening the family')

    // Reading the family is not opening it. The roster is loaded again every time
    // the menu is drawn, so a restore that took the family back would have two
    // windows trade it on every repaint - and the one that manages it would be
    // whichever asked last rather than the one opened last.
    await writeClaim(holder)
    await workspace.restoreLeafWorkspace()
    assert.equal(workspace.isFamilyMatriarch(), false, 'the window that holds it keeps it')
    assert.equal(workspace.getLeafMatriarchSessionId(), holder, 'and is named as the manager')
    assert.equal((JSON.parse(await readFile(claimPath, 'utf8')) as { matriarchSessionId: string }).matriarchSessionId, holder, 'the claim the holder wrote is left alone')
    assert.deepEqual([...workspace.externallyHeldLeafIds()], [], 'a displaced window holds nothing it was not given')
    assert.match(await workspace.listLeaves(), /Sibling/, 'and still renders the family it cannot manage')
  } finally {
    workspace.clearMatriarchClaimForTesting()
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    await rm(directory, { recursive: true, force: true })
  }
})

test('a goal refuses before it stops the leaf, and reads back without stopping one', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaf-goal-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  const savedGateway = process.env.CLAUDE_CODE_USE_GATEWAY
  process.env.CLAUDE_CONFIG_DIR = directory
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  try {
    const { getSessionId } = await import('../src/bootstrap/state.ts')
    const workspace = await import('../src/utils/leafWorkspace.ts')
    const root = getSessionId()
    workspace.forgetLeafFamilyRoot()
    await workspace.restoreLeafWorkspace()
    const family = join(directory, 'leaf-families', `${root}.json`)
    const member = await addLeafMember(family, root, { sessionId: randomUUID(), parentSessionId: root, name: 'Goal', transcriptPath: join(directory, 'goal.jsonl'), forkMessageId: randomUUID() })
    const status = async () => (await readLeafFamily(family, root)).members.find(item => item.sessionId === member.sessionId)!.status

    // A goal is written with the leaf stopped, because the record it writes is
    // the one its next turn reads. The refusals come first, so a leaf that cannot
    // take a goal is never stopped for one.
    await assert.rejects(workspace.setLeafGoal(randomUUID(), 'status'), /Unknown leaf/, 'an unknown leaf is named, not stopped')

    // Every verb but `status` needs the leaf stopped and idle to be given a goal:
    // it has no turn to resume into while it is not running, and writing the
    // record under a live turn would be read by the turn already in flight.
    assert.equal(await status(), 'open', 'the row exists before anything is asked of it')
    await assert.rejects(workspace.setLeafGoal(member.sessionId, 'resume'), /Leaf must be open and idle/, 'the refusal precedes the write')
    assert.equal(await status(), 'open', 'a refusal that never closed the leaf leaves it open')

    // Reading the goal is a read: it answers while the leaf is stopped and it
    // must not stop one to answer. This is the half of the command reachable
    // without a launch, and it is pinned so the read stays a read.
    const { parsePersistArgs } = await import('../src/skills/bundled/persist.ts')
    const storage = await import('../src/utils/sessionStorage.ts')
    const parsed = parsePersistArgs('task: already done')
    if (parsed.kind !== 'task') throw new Error('the parser did not read a task')
    await storage.writePersistSessionRecord({ version: 1, task: parsed.options.task, mode: parsed.options.mode, keep: parsed.options.keep, taskMode: parsed.options.taskMode, nudgesRemaining: parsed.options.nudges, nudgesSent: 0, status: 'completed', initialPlanningResponseAllowed: parsed.options.mode === 'plan' }, member.transcriptPath)
    assert.match(await workspace.setLeafGoal(member.sessionId, 'status'), /completed/, 'the goal that is on disk is the one that reads back')
    assert.equal(await status(), 'open', 'reading the goal never stopped the leaf')

    // NOT COVERED HERE, and deliberately not claimed: the close-modify-reopen
    // itself. Writing a goal stops the leaf and starting it again is a real
    // spawn, so the path that matters - the `finally` that reopens a leaf whose
    // write failed - cannot be reached without a launch. Confirmed by mutation:
    // deleting the reopen from that `finally` leaves this case green, so the
    // contract is NOT pinned by this test and is not asserted by it. It belongs
    // to the terminal harness, which can drive a real process.
  } finally {
    const workspace = await import('../src/utils/leafWorkspace.ts')
    workspace.forgetLeafFamilyRoot()
    workspace.clearMatriarchClaimForTesting()
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    if (savedGateway === undefined) delete process.env.CLAUDE_CODE_USE_GATEWAY
    else process.env.CLAUDE_CODE_USE_GATEWAY = savedGateway
    await rm(directory, { recursive: true, force: true })
  }
})

test('the host reads an heir that was named before it opened the family', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaf-heir-reopen-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  const savedGateway = process.env.CLAUDE_CODE_USE_GATEWAY
  process.env.CLAUDE_CONFIG_DIR = directory
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  try {
    const { getSessionId } = await import('../src/bootstrap/state.ts')
    const workspace = await import('../src/utils/leafWorkspace.ts')
    const root = getSessionId()
    workspace.forgetLeafFamilyRoot()
    const family = join(directory, 'leaf-families', `${root}.json`)
    const pointerPath = join(directory, 'leaf-families', 'index', `${root}.json`)
    await ensureCreatorMember(family, root, { name: 'Original', transcriptPath: join(directory, 'root.jsonl') })
    const heir = await addLeafMember(family, root, { sessionId: randomUUID(), parentSessionId: root, name: 'Heir', transcriptPath: join(directory, 'heir.jsonl'), forkMessageId: randomUUID() })
    const other = await addLeafMember(family, root, { sessionId: randomUUID(), parentSessionId: root, name: 'Other', transcriptPath: join(directory, 'other.jsonl'), forkMessageId: randomUUID() })

    // The heir designation is written by whichever window held the family when a
    // person named one. It lives in the pointer keyed by the family id, which is
    // the only place the fact exists - so it is already on disk, and nothing in
    // it says which process put it there. This is a HAND-SHAPED pointer: the
    // module's own writer is not exported, so it cannot be called here, and the
    // fields below are written to match what a reader expects rather than
    // produced by the code under test. If the pointer's shape ever changes, this
    // literal must change with it and nothing will say so - which is the cost of
    // injecting at this layer rather than driving a real conferral.
    await mkdir(dirname(pointerPath), { recursive: true })
    await writeFile(pointerPath, JSON.stringify({ rootSessionId: root, rootName: 'Original', rootTranscriptPath: join(directory, 'root.jsonl'), heirSessionId: heir.sessionId }), 'utf8')
    assert.equal((JSON.parse(await readFile(pointerPath, 'utf8')) as { heirSessionId?: string }).heirSessionId, heir.sessionId, 'the raise is on disk before any window opens the family')

    // A window that opens the family now - the host after a restart, or any
    // session resuming it - reads the raise it never named. `refreshDesignated-
    // Patriarch` is the whole of what opening a family reads, and it is what
    // seeds every later sync read of the designation.
    await workspace.clearMatriarchClaimForTesting()
    await workspace.restoreLeafWorkspace()

    assert.equal(workspace.getLeafHeirSessionId(), heir.sessionId, 'the host reads the heir a previous window named')
    assert.match(await workspace.familyRoster(), new RegExp(`^#${heir.number} Heir \\[open\\] \\[heir\\] ${heir.sessionId}$`, 'm'), 'the family view files the heir named before this window opened')

    // The control: the patriarch is read on the same path and does survive a
    // reopen, so a missing heir is the heir's own read and not a stale file.
    assert.equal(workspace.getLeafPatriarchSessionId(), root, 'the patriarch reads correctly on the same path')

    // A raise that was cleared stays cleared: the read must not revive one.
    await writeFile(pointerPath, JSON.stringify({ rootSessionId: root, rootName: 'Original', rootTranscriptPath: join(directory, 'root.jsonl') }), 'utf8')
    workspace.forgetLeafFamilyRoot()
    await workspace.clearMatriarchClaimForTesting()
    await workspace.restoreLeafWorkspace()
    assert.equal(workspace.getLeafHeirSessionId(), undefined, 'a window that opens after the raise ended reads no heir')
    assert.doesNotMatch(await workspace.familyRoster(), /\[heir\]/, 'and files nobody as one')
    assert.ok(other.number > 0, 'the second member is real')
  } finally {
    const workspace = await import('../src/utils/leafWorkspace.ts')
    workspace.forgetLeafFamilyRoot()
    workspace.clearMatriarchClaimForTesting()
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    if (savedGateway === undefined) delete process.env.CLAUDE_CODE_USE_GATEWAY
    else process.env.CLAUDE_CODE_USE_GATEWAY = savedGateway
    await rm(directory, { recursive: true, force: true })
  }
})

test('a rename at the prompt is the name the family lists and opens the member under', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaf-native-rename-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  try {
    const { getSessionId } = await import('../src/bootstrap/state.ts')
    const workspace = await import('../src/utils/leafWorkspace.ts')
    const root = getSessionId()
    // The resolved root is module state, and the cases before this one left one
    // pointing into their own temp directory.
    workspace.forgetLeafFamilyRoot()
    const family = join(directory, 'leaf-families', `${root}.json`)
    await ensureCreatorMember(family, root, { name: 'Original', transcriptPath: join(directory, 'root.jsonl') })
    const member = await addLeafMember(family, root, { sessionId: randomUUID(), parentSessionId: root, name: 'newtok', transcriptPath: join(directory, 'member.jsonl'), forkMessageId: randomUUID() })

    const { leaf } = parkedLeaf()
    const snapshots: { members: { member: { sessionId: string; name: string } }[] }[] = []
    ;(leaf as unknown as { snapshot: (value: unknown) => void }).snapshot = value => { snapshots.push(value as never) }
    const unregister = workspace.registerLeafViewForTesting({ rootSessionId: root, member, process: leaf as never, draft: '' })
    try {
      // The leaf renames itself at its own prompt: its process reports the name
      // to the session hosting the family, which is the one holding the keys here.
      await workspace.dispatchLeafRequestForTesting(member.sessionId, root, 'renamed', ['newtok2'])

      // Everything the family calls a member by reads this row: the carousel's
      // `N name` label, the menu, and GATEWAY_LEAF_LABEL when it is opened again.
      // A rename that stopped at the transcript reopened the member under the name
      // it had before, which is the reported failure.
      const row = async (sessionId: string) => (await readLeafFamily(family, root)).members.find(item => item.sessionId === sessionId)!.name
      assert.equal(await row(member.sessionId), 'newtok2', 'the family row takes the new name')
      assert.equal(workspace.getLeafViews().find(view => view.member.sessionId === member.sessionId)!.member.name, 'newtok2', 'the running member is renamed in the bar')
      assert.equal((await workspace.resolveLeafRef('newtok2'))?.sessionId, member.sessionId, 'and the new name is how it is reached from now on')
      assert.match(await workspace.listLeaves(), /#2 newtok2 \[/, 'the menu lists it by the new name')
      assert.equal(snapshots.at(-1)?.members.find(entry => entry.member.sessionId === member.sessionId)!.member.name, 'newtok2', 'every other leaf is told the new name too')

      // The session hosting the family renames itself at its own prompt - the
      // `/rename` command and the footer's Rename control both land here - and it
      // writes its own row rather than reporting to itself.
      await workspace.reportSessionRename('Hostname')
      assert.equal(await row(root), 'Hostname', 'a host renaming itself renames its own row')

      // A name the family cannot use leaves the row alone, and a family that
      // cannot be reached is not a failed rename: the transcript already holds the
      // name, and neither case may resurrect a family that is gone.
      await workspace.reportSessionRename('   ')
      assert.equal(await row(member.sessionId), 'newtok2', 'an empty name never blanks a member')
      await rm(family)
      await workspace.reportSessionRename('Orphan')
      await assert.rejects(readFile(family, 'utf8'), /ENOENT/, 'a rename never recreates a family that is gone')
    } finally { unregister() }
  } finally {
    const workspace = await import('../src/utils/leafWorkspace.ts')
    workspace.forgetLeafFamilyRoot()
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    await rm(directory, { recursive: true, force: true })
  }
})
