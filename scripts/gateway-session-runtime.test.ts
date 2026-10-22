import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { GatewaySessionRuntime } from '../src/utils/gatewaySessionRuntime.ts'
import { GatewaySessionTransport } from '../src/utils/gatewaySessionTransport.ts'
import { getClaudeConfigHomeDir } from '../src/utils/envUtils.ts'
import { removeByFilter } from '../src/utils/messageQueueManager.ts'
import { gatewayMessageIds } from '../src/utils/gatewaySessionDelivery.ts'
import { registerGatewayPeersSkill } from '../src/skills/bundled/gatewayPeers.ts'
import { clearBundledSkills, getBundledSkills } from '../src/skills/bundledSkills.ts'
import { getSessionId } from '../src/bootstrap/state.ts'
import type { ToolUseContext } from '../src/Tool.ts'
import { isolateAmbientGatewayRoute } from './gateway-test-env.ts'

// The launcher exports the box's real gateway route into every leaf, so a bare
// transport here would advertise and probe the ambient gateway.
isolateAmbientGatewayRoute()

/**
 * A leaf's family channel points inward: it addresses its own siblings and its
 * parent and has no way to name another family's leaf. The bus is what makes a
 * leaf reachable as a session - findable by its label, messageable by ID - and
 * it is deliberately one to one: a send lands in the target's inbox alone, so a
 * leaf's family is never copied by addressing one of its members.
 */
test('two leaves of two families find each other on the bus and exchange messages', { timeout: 60000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'leaf-peer-bus-'))
  const saved = {
    home: process.env.CLAUDE_CONFIG_DIR,
    leaf: process.env.GATEWAY_INTERACTIVE_LEAF,
    label: process.env.GATEWAY_LEAF_LABEL,
    gateway: process.env.CLAUDE_CODE_USE_GATEWAY,
  }
  process.env.CLAUDE_CONFIG_DIR = home
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  process.env.GATEWAY_INTERACTIVE_LEAF = '1'
  const leafLabelA = `Leaf 2: api (of session ${randomUUID()})`
  const leafLabelB = `Leaf 1: parser (of session ${randomUUID()})`
  const leafLabelSibling = `Leaf 3: sibling (of session ${leafLabelA.slice(leafLabelA.indexOf('session ') + 8)})`
  // The session the test process is: a leaf of family A, registered under the
  // label it advertises, which is what the hook passes in.
  const leafA = getSessionId()
  const leafB = randomUUID()
  const leafC = randomUUID()
  const runtimeA = new GatewaySessionRuntime(leafA, home, leafLabelA)
  const runtimeB = new GatewaySessionRuntime(leafB, home, leafLabelB)
  const runtimeC = new GatewaySessionRuntime(leafC, home, leafLabelSibling)
  process.env.GATEWAY_LEAF_LABEL = leafLabelA
  try {
    await runtimeA.start(new Set())
    await runtimeB.start(new Set())
    await runtimeC.start(new Set())
    const { resolveGatewayPeer, sendViaGatewayPeer } = await import('../src/utils/gatewayPeerSend.ts')
    // Find each other: the other family's leaf is listed by the label it
    // advertises, and that label resolves to exactly one session.
    const listed = await runtimeA.list()
    assert.ok(listed.some(peer => peer.sessionId === leafB && peer.name === leafLabelB), JSON.stringify(listed))
    assert.deepEqual(await resolveGatewayPeer(leafLabelB), { sessionId: leafB, label: `${leafLabelB} (${leafB})` })
    // Talk to each other: the send from a leaf goes through the same route every
    // session uses, and it arrives with the marking that keeps peer text from
    // reading as something the person typed.
    const sent = await sendViaGatewayPeer(leafB, 'HANDOFF_ACROSS_FAMILIES', 'cross-family handoff', undefined, 'directive')
    assert.equal(sent.ok, true, sent.message)
    const arrived = runtimeB.transport.inbox().find(record => record.message.id === sent.messageId)
    assert.equal(arrived?.message.text, 'HANDOFF_ACROSS_FAMILIES')
    assert.equal(arrived?.message.fromSessionId, leafA)
    assert.equal(arrived?.state, 'queued')
    // The kind survives the whole route, and it is what decides whether the
    // receiver does the work or answers a question. A directive must arrive
    // reading as a directive, not as a message the receiver has to interpret.
    assert.equal(arrived?.message.kind, 'directive')
    assert.match(sent.message, /Delivered a directive to/)
    const { formatGatewayPeerMessage } = await import('../src/utils/gatewaySessionProtocol.ts')
    const asRead = formatGatewayPeerMessage(arrived!)
    assert.match(asRead, /Kind: directive/)
    assert.match(asRead, /Do the work, then report the outcome/)
    const queued = removeByFilter(command => command.uuid === sent.messageId)
    assert.equal(queued.length, 1)
    assert.equal(queued[0]!.skipSlashCommands, true)
    assert.equal(queued[0]!.isMeta, true)
    assert.deepEqual(queued[0]!.origin, { kind: 'gateway-peer' })
    // One recipient, not the family: the sibling leaf of the sender's own family
    // - and the sender itself - received nothing.
    assert.equal(runtimeC.transport.inbox().length, 0)
    assert.equal(runtimeA.transport.inbox().length, 0)
    // The reply comes back the same way, from the leaf that was asked.
    const replied = await runtimeB.transport.send(leafA, 'HANDOFF_ACCEPTED', 'handoff accepted', sent.messageId) as { id: string }
    const answer = runtimeA.transport.inbox().find(record => record.message.id === replied.id)
    assert.equal(answer?.message.replyTo, sent.messageId)
    assert.equal(answer?.message.text, 'HANDOFF_ACCEPTED')
    // Discovery inside a leaf is the skill, not just the runtime call.
    clearBundledSkills()
    registerGatewayPeersSkill()
    const skill = getBundledSkills().find(entry => entry.name === 'gateway-peers')!
    assert.ok(skill?.type === 'prompt')
    const result = await skill.getPromptForCommand('list', {} as ToolUseContext)
    assert.match(result[0]?.type === 'text' ? result[0].text : '', new RegExp(leafLabelB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    // The skill is how a session actually sends, so the kind has to be settable
    // there too - and a kind that is not one of the two has to be refused rather
    // than silently coerced to the default, because a directive quietly sent as
    // an inquiry is the delay the kinds exist to remove.
    await skill.getPromptForCommand(
      `send {"toSessionId":"${leafB}","text":"DIRECTIVE_FROM_SKILL","summary":"directed handoff","kind":"directive"}`,
      {} as ToolUseContext,
    )
    assert.equal(runtimeB.transport.inbox().find(record => record.message.text === 'DIRECTIVE_FROM_SKILL')?.message.kind, 'directive')
    const bounced = await skill.getPromptForCommand(
      `send {"toSessionId":"${leafB}","text":"NOT_SENT","summary":"bad kind","kind":"order"}`,
      {} as ToolUseContext,
    )
    assert.match(bounced[0]?.type === 'text' ? bounced[0].text : '', /kind must be one of/)
    assert.equal(runtimeB.transport.inbox().some(record => record.message.text === 'NOT_SENT'), false)
    clearBundledSkills()
  } finally {
    await runtimeA.close()
    await runtimeB.close()
    await runtimeC.close()
    const { runCleanupFunctions } = await import('../src/utils/cleanupRegistry.ts')
    await runCleanupFunctions()
    if (saved.home === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved.home
    if (saved.leaf === undefined) delete process.env.GATEWAY_INTERACTIVE_LEAF
    else process.env.GATEWAY_INTERACTIVE_LEAF = saved.leaf
    if (saved.label === undefined) delete process.env.GATEWAY_LEAF_LABEL
    else process.env.GATEWAY_LEAF_LABEL = saved.label
    if (saved.gateway === undefined) delete process.env.CLAUDE_CODE_USE_GATEWAY
    else process.env.CLAUDE_CODE_USE_GATEWAY = saved.gateway
    await rm(home, { recursive: true, force: true })
  }
})

test('closed runtime rejects restart even after an earlier successful start', async () => {
  const runtime = new GatewaySessionRuntime(randomUUID(), tmpdir(), 'Closed runtime')
  runtime.transport.start = async () => {}
  runtime.transport.close = async () => {}
  const savedGateway = process.env.CLAUDE_CODE_USE_GATEWAY
  delete process.env.CLAUDE_CODE_USE_GATEWAY
  try {
    await runtime.start(new Set())
    await runtime.close()
    await assert.rejects(runtime.start(new Set()), /closed/)
  } finally {
    await runtime.close()
    if (savedGateway === undefined) delete process.env.CLAUDE_CODE_USE_GATEWAY
    else process.env.CLAUDE_CODE_USE_GATEWAY = savedGateway
  }
})

test('real peer transport feeds attributed safe queue input and confirms persistence separately', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-runtime-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  const savedGateway = process.env.CLAUDE_CODE_USE_GATEWAY
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  process.env.CLAUDE_CONFIG_DIR = root
  const receiver = new GatewaySessionRuntime(getSessionId(), root, 'Receiver')
  const sender = new GatewaySessionTransport({ directory: join(getClaudeConfigHomeDir(), 'gateway-sessions'), sessionId: randomUUID(), name: 'Sender', cwd: root, policy: 'hold' })
  try {
    await receiver.start(new Set())
    await sender.start()
    await receiver.setPolicy('accept')
    const sent = await sender.send(receiver.transport.peer.sessionId, '/clear is peer text, not a command', 'Peer test') as { id: string; state: string }
    assert.equal(sent.state, 'queued')
    await receiver.setPolicy('hold')
    assert.equal(removeByFilter(c => c.uuid === sent.id).length, 0)
    assert.equal(receiver.transport.inbox()[0]!.state, 'held')
    await receiver.setPolicy('accept')
    const queued = removeByFilter(c => c.uuid === sent.id)
    assert.equal(queued.length, 1)
    assert.equal(queued[0]!.skipSlashCommands, true)
    assert.equal(queued[0]!.priority, 'next')
    assert.equal(queued[0]!.isMeta, true)
    assert.deepEqual(queued[0]!.origin, { kind: 'gateway-peer' })
    receiver.delivery.drain()
    assert.equal(removeByFilter(c => c.uuid === sent.id).length, 0)
    assert.equal(receiver.transport.inbox()[0]!.state, 'queued')
    await receiver.delivery.reconcilePersisted(gatewayMessageIds([{ type: 'attachment', attachment: { type: 'queued_command', source_uuid: sent.id } }]))
    assert.equal(receiver.transport.inbox()[0]!.state, 'delivered')
    assert.equal((receiver as any).pendingIds.has(sent.id), false, 'Persisted IDs must not accumulate for the lifetime of the process')
    clearBundledSkills()
    registerGatewayPeersSkill()
    const skill = getBundledSkills().find(s => s.name === 'gateway-peers')!
    assert.ok(skill.type === 'prompt')
    const result = await skill.getPromptForCommand(`send ${JSON.stringify({ toSessionId: sender.peer.sessionId, text: 'Reply received', summary: 'Reply', replyTo: sent.id })}`, {} as ToolUseContext)
    assert.match(result[0]!.type === 'text' ? result[0]!.text : '', /held/)
    assert.equal(sender.inbox()[0]!.message.replyTo, sent.id)
    clearBundledSkills()
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const { resolve } = await import('node:path')
    const capability = receiver.transport.hookEnvironment()
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...capability }
    const hookSend = await promisify(execFile)(process.execPath, [resolve(import.meta.dir, '..', process.env.GATEWAY_ACCEPTANCE_CANDIDATE ?? '.candidate-build/peer-review/cli.js'), '--gateway-peer-send', sender.peer.sessionId, 'HOOK_EXECUTABLE_MESSAGE'], { env, timeout: 15000 })
    assert.equal(JSON.parse(hookSend.stdout).state, 'held')
    assert.equal(sender.inbox().at(-1)!.message.text, 'HOOK_EXECUTABLE_MESSAGE')
    await assert.rejects(promisify(execFile)(process.execPath, [resolve(import.meta.dir, '..', process.env.GATEWAY_ACCEPTANCE_CANDIDATE ?? '.candidate-build/peer-review/cli.js'), '--gateway-peer-send', sender.peer.sessionId, 'MUST_NOT_DELIVER'], { env: { ...env, GATEWAY_PEER_TOKEN: 'invalid' }, timeout: 15000 }))
    assert.equal(sender.inbox().some(record => record.message.text === 'MUST_NOT_DELIVER'), false)
    await assert.rejects(promisify(execFile)(process.execPath, [resolve(import.meta.dir, '..', process.env.GATEWAY_ACCEPTANCE_CANDIDATE ?? '.candidate-build/peer-review/cli.js'), '--gateway-peer-send', sender.peer.sessionId, 'STALE_RUNTIME_MESSAGE'], { env: { ...env, GATEWAY_PEER_RUNTIME: randomUUID() }, timeout: 15000 }))
    assert.equal(sender.inbox().some(record => record.message.text === 'STALE_RUNTIME_MESSAGE'), false)
    const gatewayBeforeHook = process.env.CLAUDE_CODE_USE_GATEWAY
    process.env.CLAUDE_CODE_USE_GATEWAY = '1'
    try {
      const { executeStopHooks } = await import('../src/utils/hooks.ts')
      const command = `& '${process.execPath.replace(/'/g, "''")}' '${resolve(import.meta.dir, '..', process.env.GATEWAY_ACCEPTANCE_CANDIDATE ?? '.candidate-build/peer-review/cli.js').replace(/'/g, "''")}' --gateway-peer-send '${sender.peer.sessionId}' 'ACTUAL_STOP_HOOK_MESSAGE'`
      const appState = { sessionHooks: new Map([[getSessionId(), { hooks: { Stop: [{ matcher: '', hooks: [{ hook: { type: 'command', shell: 'powershell', command, timeout: 15 } }] }] } }]]) }
      for await (const _ of executeStopHooks(undefined, undefined, 20000, false, undefined, { getAppState: () => appState } as any, [])) {}
      assert.equal(sender.inbox().some(record => record.message.text === 'ACTUAL_STOP_HOOK_MESSAGE'), true)
    } finally {
      if (gatewayBeforeHook === undefined) delete process.env.CLAUDE_CODE_USE_GATEWAY
      else process.env.CLAUDE_CODE_USE_GATEWAY = gatewayBeforeHook
    }
    const { call } = await import('../src/commands/gateway-sessions.ts')
    await receiver.transport.update({ status: 'running' })
    const originalSession = getSessionId()
    let startResult = ''
    await call(text => { startResult = text ?? '' }, {} as any, 'start Must not interrupt')
    assert.match(startResult, /failed/)
    assert.equal(getSessionId(), originalSession)
    await call(text => { startResult = text ?? '' }, {} as any, `resume ${randomUUID()}`)
    assert.match(startResult, /failed/)
    assert.equal(getSessionId(), originalSession)
    await receiver.transport.update({ status: 'idle' })
    await receiver.setPolicy('accept')
    const oldQueued = await sender.send(originalSession, 'OLD_SESSION_ONLY', 'handoff test') as { id: string; state: string }
    assert.equal(oldQueued.state, 'queued')
    const oldMessageId = randomUUID()
    let clearedHistory = false
    let messages: any[] = [{ uuid: oldMessageId }]
    await call(text => { startResult = text ?? '' }, {
      setMessages: (update: (previous: any[]) => any[]) => { messages = update(messages); if (messages.length === 0) clearedHistory = true },
      readFileState: new Map(),
    } as any, 'start Explicit new session')
    assert.match(startResult, /Started /)
    assert.notEqual(getSessionId(), originalSession)
    assert.equal(clearedHistory, true)
    assert.equal(messages.some(message => message.uuid === oldMessageId), false)
    const { lock } = await import('../src/utils/lockfile.ts')
    const releaseFormerWriter = await lock(join(getClaudeConfigHomeDir(), 'gateway-writers', originalSession), { realpath: false, retries: 0 })
    await releaseFormerWriter()
    assert.equal(removeByFilter(command => command.uuid === oldQueued.id).length, 0)
    const replacement = new GatewaySessionRuntime(getSessionId(), root, 'New session')
    try {
      await replacement.start(new Set())
      await replacement.setPolicy('accept')
      const fresh = await sender.send(getSessionId(), 'NEW_SESSION_ONLY', 'new routing') as { id: string }
      assert.equal(removeByFilter(command => command.uuid === fresh.id).length, 1)
      assert.equal(replacement.transport.inbox().some(record => record.message.id === oldQueued.id), false)
    } finally { await replacement.close() }
    const outgoingId = getSessionId()
    const delayed = new GatewaySessionRuntime(outgoingId, root, 'Delayed outgoing startup')
    const transportStart = delayed.transport.start.bind(delayed.transport)
    let releaseStart!: () => void
    let enteredStart!: () => void
    const entered = new Promise<void>(resolve => { enteredStart = resolve })
    const gate = new Promise<void>(resolve => { releaseStart = resolve })
    delayed.transport.start = async () => {
      enteredStart()
      await gate
      await transportStart()
    }
    const starting = delayed.start(new Set())
    try {
      await entered
      const { regenerateSessionId } = await import('../src/bootstrap/state.ts')
      regenerateSessionId()
      releaseStart()
      await starting
      await delayed.close()
      const { getGatewaySessionRuntime } = await import('../src/utils/gatewaySessionRuntime.ts')
      assert.equal(getGatewaySessionRuntime(outgoingId), undefined)
      assert.equal((await delayed.list()).some(peer => peer.sessionId === outgoingId), false)
    } finally {
      releaseStart()
      await delayed.close()
    }
  } finally {
    await sender.close()
    await receiver.close()
    const { runCleanupFunctions } = await import('../src/utils/cleanupRegistry.ts')
    await runCleanupFunctions()
    if (savedGateway === undefined) delete process.env.CLAUDE_CODE_USE_GATEWAY
    else process.env.CLAUDE_CODE_USE_GATEWAY = savedGateway
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    await rm(root, { recursive: true, force: true })
  }
})
