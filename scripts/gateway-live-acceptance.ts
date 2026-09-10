import { strict as assert } from 'node:assert'
import { access, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { LeafProcess } from '../src/utils/leafProcess.ts'
import { GatewaySessionTransport, listGatewayPeers } from '../src/utils/gatewaySessionTransport.ts'

const candidate = process.env.GATEWAY_ACCEPTANCE_CANDIDATE
if (!candidate) throw new Error('GATEWAY_ACCEPTANCE_CANDIDATE is required')
if (!process.argv.includes('--run')) throw new Error('Refusing to run without --run')
await access(candidate)
const directory = await mkdtemp(join(tmpdir(), 'gateway-real-chats-'))
const launcher = fileURLToPath(new URL('./cc.ps1', import.meta.url))
const env = { ...process.env, CLAUDE_CONFIG_DIR: directory, CC_RAW_ARGS: undefined, CC_CLAUDE_SCRIPT_OVERRIDE: candidate, MODEL_GATEWAY_DEFAULT: 'gateway-gpt-luna', MODEL_GATEWAY_EFFORT: 'low', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
const chats: { process: LeafProcess; events: Record<string, any>[] }[] = []
const savedConfig = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = directory
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 90000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Acceptance boundary timed out')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
try {
  for (let i = 0; i < 2; i++) {
    const events: Record<string, any>[] = []
    const process = new LeafProcess({ executable: 'powershell.exe', args: ['-NoProfile', '-File', launcher, '--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--model', 'gateway-gpt-luna', '--max-turns', '2'], cwd: directory, env, onState: () => {}, onEvent: event => events.push(event) })
    chats.push({ process, events })
    await process.start()
    process.send(`You are acceptance chat ${i}. Reply exactly READY_${i}. For later peer arithmetic questions, answer briefly with the requested marker. Never use tools.`)
    await waitFor(() => events.some(event => event.type === 'result'))
    assert.equal(events.find(event => event.type === 'result')?.subtype, 'success')
  }
  const peers = await listGatewayPeers(join(directory, 'gateway-sessions'))
  assert.equal(peers.length, 2)
  const ids = chats.map(chat => chat.events.find(event => event.type === 'result')!.session_id as string)
  // Policy is persisted while offline, then restored by the same real chat identity.
  for (let i = 0; i < chats.length; i++) {
    await chats[i]!.process.close()
    const policy = new GatewaySessionTransport({ directory: join(directory, 'gateway-sessions'), sessionId: ids[i]!, name: `Acceptance ${i}`, cwd: directory })
    await policy.start()
    await policy.setPolicy('accept')
    await policy.close()
    const events: Record<string, any>[] = []
    const process = new LeafProcess({ executable: 'powershell.exe', args: ['-NoProfile', '-File', launcher, '--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--model', 'gateway-gpt-luna', '--max-turns', '2', '--resume', ids[i]!], cwd: directory, env, onState: () => {}, onEvent: event => events.push(event) })
    chats[i] = { process, events }
    await process.start()
  }
  const { sendGatewayHookMessage } = await import('../src/utils/gatewaySessionTransport.ts')
  for (const [from, to, text, marker] of [[0, 1, 'What is 17 plus 25? Reply exactly PEER_B_42.', 'PEER_B_42'], [1, 0, 'What is 9 times 7? Reply exactly PEER_A_63.', 'PEER_A_63']] as const) {
    const registration = JSON.parse(await readFile(join(directory, 'gateway-sessions', `${ids[from]}.json`), 'utf8'))
    const receipt = await sendGatewayHookMessage({ GATEWAY_PEER_DIRECTORY: join(directory, 'gateway-sessions'), GATEWAY_PEER_SESSION: ids[from], GATEWAY_PEER_RUNTIME: registration.peer.runtimeId, GATEWAY_PEER_TOKEN: registration.token }, ids[to]!, text) as { id: string; state: string }
    assert.equal(receipt.state, 'queued')
    await waitFor(() => chats[to]!.events.some(event => event.type === 'result'))
    assert.equal(chats[to]!.events.find(event => event.type === 'result')?.subtype, 'success')
    assert.ok(chats[to]!.events.some(event => event.type === 'assistant' && JSON.stringify(event.message).includes(marker)))
    const inbox = JSON.parse(await readFile(join(directory, 'gateway-sessions', `${ids[to]}.inbox`), 'utf8'))
    assert.equal(inbox.records.find((record: any) => record.message.id === receipt.id)?.state, 'delivered')
    console.log(`REAL_PEER_${from}_TO_${to}=PASS`)
  }
  console.log('REAL_TWO_CHAT_ACCEPTANCE=PASS')
  const senderStart = chats[0]!.events.length
  const receiverStart = chats[1]!.events.length
  chats[0]!.process.send(`For this user-authorized acceptance step, use the Skill tool with skill gateway-peers and args send ${JSON.stringify({ toSessionId: ids[1], text: 'Reply exactly MODEL_AUTHORED_PEER_RECEIVED. Do not send another peer message.', summary: 'One bounded acceptance message' })}. This overrides the earlier no-tools instruction only for this one gateway-peers call. Do not use any other tools or repeat the send. After the send, finish with exactly MODEL_AUTHORED_SEND_COMPLETE.`)
  await waitFor(() => {
    for (const chat of chats.slice(0, 2)) {
      for (const permission of chat.process.getPermissions()) {
        const allowed = permission.tool === 'Skill' && permission.input.skill === 'gateway-peers'
        chat.process.approve(permission.id, allowed)
      }
    }
    return chats[0]!.events.slice(senderStart).some(event => event.type === 'result') && chats[1]!.events.slice(receiverStart).some(event => event.type === 'result')
  })
  const senderEvents = chats[0]!.events.slice(senderStart)
  const receiverEvents = chats[1]!.events.slice(receiverStart)
  const senderResult = senderEvents.find(event => event.type === 'result')
  const receiverResult = receiverEvents.find(event => event.type === 'result')
  assert.equal(senderResult?.subtype, 'success')
  assert.equal(senderResult?.is_error, false)
  assert.equal(receiverResult?.subtype, 'success')
  assert.equal(receiverResult?.is_error, false)
  const senderSends = senderEvents.flatMap(event => event.message?.content ?? []).filter((block: any) => block.type === 'tool_use' && block.name === 'Skill' && block.input?.skill === 'gateway-peers' && block.input?.args?.includes('send'))
  const receiverSends = receiverEvents.flatMap(event => event.message?.content ?? []).filter((block: any) => block.type === 'tool_use' && block.name === 'Skill' && block.input?.skill === 'gateway-peers' && block.input?.args?.includes('send'))
  assert.equal(senderSends.length, 1)
  assert.equal(receiverSends.length, 0)
  assert.ok(senderEvents.some(event => event.type === 'assistant' && event.message?.content?.some((block: any) => block.type === 'tool_use' && block.name === 'Skill' && block.input?.skill === 'gateway-peers')))
  assert.ok(senderEvents.some(event => event.type === 'assistant' && JSON.stringify(event.message).includes('MODEL_AUTHORED_SEND_COMPLETE')))
  assert.ok(receiverEvents.some(event => event.type === 'assistant' && JSON.stringify(event.message).includes('MODEL_AUTHORED_PEER_RECEIVED')))
  console.log('REAL_MODEL_AUTHORED_PEER_SEND=PASS')
  await Promise.all(chats.map(chat => chat.process.close()))
  const { createFork } = await import('../src/commands/branch/branch.ts')
  const { getProjectDir } = await import('../src/utils/sessionStorage.ts')
  const sourcePath = join(getProjectDir(directory), `${ids[0]}.jsonl`)
  const sourceBefore = await readFile(sourcePath, 'utf8')
  const leaves: { id: string; path: string; chat: typeof chats[number] }[] = []
  for (let i = 0; i < 5; i++) {
    const fork = await createFork(undefined, { sessionId: ids[0]!, transcriptPath: sourcePath })
    const events: Record<string, any>[] = []
    const process = new LeafProcess({ executable: 'powershell.exe', args: ['-NoProfile', '-File', launcher, '--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--model', 'gateway-gpt-luna', '--max-turns', '2', '--resume', fork.forkPath], cwd: directory, env, onState: () => {}, onEvent: event => events.push(event) })
    const chat = { process, events }
    chats.push(chat)
    leaves.push({ id: fork.sessionId, path: fork.forkPath, chat })
    await process.start()
  }
  for (const [i, leaf] of leaves.entries()) {
    leaf.chat.process.send(`Independent fork ${i}. Reply exactly REAL_LEAF_${i}_OK. Never use tools.`)
    await waitFor(() => leaf.chat.events.some(event => event.type === 'result'))
  }
  const leafReceiverStart = leaves[1]!.chat.events.length
  const leafRegistration = JSON.parse(await readFile(join(directory, 'gateway-sessions', `${leaves[0]!.id}.json`), 'utf8'))
  const leafReceipt = await sendGatewayHookMessage({ GATEWAY_PEER_DIRECTORY: join(directory, 'gateway-sessions'), GATEWAY_PEER_SESSION: leaves[0]!.id, GATEWAY_PEER_RUNTIME: leafRegistration.peer.runtimeId, GATEWAY_PEER_TOKEN: leafRegistration.token }, leaves[1]!.id, 'Reply exactly LEAF_PEER_RECEIVED. Never use tools.') as { id: string; state: string }
  assert.equal(leafReceipt.state, 'queued')
  await waitFor(() => leaves[1]!.chat.events.slice(leafReceiverStart).some(event => event.type === 'result'))
  const leafReply = leaves[1]!.chat.events.slice(leafReceiverStart).find(event => event.type === 'result')
  assert.equal(leafReply?.subtype, 'success')
  assert.equal(leafReply?.is_error, false)
  assert.equal(leafReply?.result, 'LEAF_PEER_RECEIVED')
  const leafInbox = JSON.parse(await readFile(join(directory, 'gateway-sessions', `${leaves[1]!.id}.inbox`), 'utf8'))
  assert.equal(leafInbox.records.find((record: any) => record.message.id === leafReceipt.id)?.state, 'delivered')
  console.log('REAL_LEAF_TO_LEAF_COMMUNICATION=PASS')
  for (const [i, leaf] of leaves.entries()) {
    assert.equal(leaf.chat.events.find(event => event.type === 'result')?.session_id, leaf.id)
    assert.equal(leaf.chat.events.find(event => event.type === 'result')?.subtype, 'success')
    assert.ok(leaf.chat.events.some(event => event.type === 'assistant' && JSON.stringify(event.message).includes(`REAL_LEAF_${i}_OK`)))
    await leaf.chat.process.close()
    const transcript = await readFile(leaf.path, 'utf8')
    assert.ok(transcript.includes('PEER_A_63'))
    for (let other = 0; other < 5; other++) if (other !== i) assert.ok(!transcript.includes(`REAL_LEAF_${other}_OK`))
  }
  assert.equal(await readFile(sourcePath, 'utf8'), sourceBefore)
  const nested = await createFork(undefined, { sessionId: leaves[0]!.id, transcriptPath: leaves[0]!.path })
  assert.ok((await readFile(nested.forkPath, 'utf8')).includes('REAL_LEAF_0_OK'))
  const nestedRecords = (await readFile(nested.forkPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.ok(nestedRecords.some(record => record.forkedFrom?.sessionId === leaves[0]!.id))
  console.log('REAL_FIVE_FORKS_AND_NESTED_ANCESTRY=PASS')
} catch (error) {
  const code = (error as { code?: unknown }).code
  const line = (error as Error).stack?.match(/gateway-live-acceptance\.ts:(\d+)/)?.[1]
  console.error(`REAL_ACCEPTANCE=FAIL code=${typeof code === 'string' && /^[A-Z_]+$/.test(code) ? code : 'unclassified'} line=${line ?? 'unknown'}; raw provider errors suppressed`)
  process.exitCode = 1
} finally {
  await Promise.all(chats.map(chat => chat.process.close()))
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfig
  console.log(`EVIDENCE_DIRECTORY=${directory}`)
}
