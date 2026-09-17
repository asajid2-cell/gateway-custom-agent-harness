import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addLeafMember, readLeafFamily, updateLeafMember, recordLeafContextReturn } from '../src/utils/leafFamily.ts'
import { createFork } from '../src/commands/branch/branch.ts'
import { createLeaf, changeLeaf, fileLeaf } from '../src/utils/leafWorkspace.ts'
import { LeafProcess } from '../src/utils/leafProcess.ts'
import { getCwd } from '../src/utils/cwd.ts'

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

test('worktree leaf rejects the current working tree before creating a fork', async () => {
  const { getCwdState, setCwdState } = await import('../src/bootstrap/state.ts')
  const { resolve } = await import('node:path')
  const previous = getCwdState()
  setCwdState(resolve(import.meta.dir, '..'))
  try { await assert.rejects(createLeaf('Must not create', undefined, getCwd()), /separate worktree/) }
  finally { setCwdState(previous) }
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
    await assert.rejects(addLeafMember(path, root, { ...first, parentSessionId: randomUUID(), sessionId: randomUUID() }), /Unknown leaf parent/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
