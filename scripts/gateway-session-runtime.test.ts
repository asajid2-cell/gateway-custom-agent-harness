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
