import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addLeafMember, readLeafFamily, updateLeafMember, recordLeafContextReturn } from '../src/utils/leafFamily.ts'
import { createFork } from '../src/commands/branch/branch.ts'
import { createLeaf, changeLeaf, fileLeaf } from '../src/utils/leafWorkspace.ts'
import { getCwd } from '../src/utils/cwd.ts'

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
