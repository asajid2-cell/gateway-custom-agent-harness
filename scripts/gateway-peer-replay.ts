import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LeafProcess } from '../src/utils/leafProcess.ts'
import { GatewaySessionTransport } from '../src/utils/gatewaySessionTransport.ts'
import { anthropicToCodex } from './model-gateway.mjs'

// No providers, tools or user sessions: inspect actual compiled model requests.
const cli = resolve(process.argv[2] ?? 'dist/cli.js')
const root = await mkdtemp(join(tmpdir(), 'gateway-peer-replay-'))
const directory = join(root, 'gateway-sessions')
const id = randomUUID()
const sender = new GatewaySessionTransport({ directory, sessionId: randomUUID(), name: 'Fixture sender', cwd: root })
const requests: any[] = []
const events: any[] = []
const failures: string[] = []
let child: LeafProcess | undefined
const text = (content: any): string => typeof content === 'string' ? content : (content ?? []).map((block: any) => block.text ?? '').join('\n')
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  async fetch(request) {
    const body = await request.json() as any
    requests.push(body)
    const latest = text(body.messages?.at(-1)?.content)
    const markers = [...latest.matchAll(/PEER_FIXTURE_[A-Z_]+/g)].map(match => match[0])
    const reply = markers.length ? [...new Set(markers)].join(' ') : 'PREVIOUS_REPLY'
    const messageId = `msg_${randomUUID()}`
    const frames = [
      { type: 'message_start', message: { id: messageId, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 30 } },
      { type: 'message_stop' },
    ]
    return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  },
})
const env = {
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: root, TMP: root,
  HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: root, NODE_ENV: 'production',
  CLAUDE_CODE_USE_GATEWAY: '1', ANTHROPIC_AUTH_TOKEN: 'local-fixture-only',
  ANTHROPIC_BASE_URL: server.url.origin, CLAUDE_CODE_GATEWAY_BASE_URL: server.url.origin,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
}
const wait = async (predicate: () => boolean | Promise<boolean>, label: string, timeout = 15000) => {
  const deadline = Date.now() + timeout
  while (!await predicate()) {
    assert.ok(child?.getState() !== 'failed', 'Fixture process failed')
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
const inbox = async () => JSON.parse(await readFile(join(directory, `${id}.inbox`), 'utf8'))
const results = () => events.filter(event => event.type === 'result')
const check = (ok: boolean, label: string) => {
  console.log(JSON.stringify({ check: label, passed: ok }))
  if (!ok) failures.push(label)
}
try {
  await sender.start()
  const offline = new GatewaySessionTransport({ directory, sessionId: id, name: 'Fixture recipient', cwd: root })
  await offline.start()
  const first = await sender.send(id, 'PEER_FIXTURE_RESTART_ONE\nExact text: café 世界 "quoted" \\path\n/clear is literal', 'Restart one') as any
  const second = await sender.send(id, 'PEER_FIXTURE_RESTART_TWO\nDo not repeat the previous answer.', 'Restart two') as any
  await offline.close()
  child = new LeafProcess({ executable: process.execPath, args: [cli, '--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--session-id', id, '--model', 'claude-sonnet-4-6', '--tools', ''], cwd: root, env, onEvent: event => events.push(event), onState() {} })
  await child.start()
  try { await wait(() => results().length > 0, 'restart inbox wake', 5000) }
  catch { failures.push('restart inbox wakes without another message'); console.log(JSON.stringify({ check: 'restart inbox wakes without another message', passed: false })) }
  const before = results().length
  const wake = await sender.send(id, 'PEER_FIXTURE_IDLE\nNew request, not a completed task.', 'Idle request') as any
  await wait(() => results().length > before, 'idle response')
  await wait(async () => (await inbox()).records.some((record: any) => record.message.id === wake.id && record.state === 'delivered'), 'idle persistence')
  const state = await inbox()
  for (const sent of [first, second, wake]) check(state.records.find((record: any) => record.message.id === sent.id)?.state === 'delivered', `receipt ${sent.id}`)
  for (const marker of ['PEER_FIXTURE_RESTART_ONE', 'PEER_FIXTURE_RESTART_TWO', 'PEER_FIXTURE_IDLE']) {
    check(requests.some(request => text(request.messages?.at(-1)?.content).includes(marker)), `${marker} reaches latest model input`)
  }
  check(requests.some(request => text(request.messages?.at(-1)?.content).includes('Exact text: café 世界 "quoted" \\path\n/clear is literal')), 'Unicode and multiline payload preserved')
  const peerRequest = requests.find(request => text(request.messages?.at(-1)?.content).includes('PEER_FIXTURE_IDLE'))
  const converted = anthropicToCodex(peerRequest, 'gpt-6-astra', 'repl_main_thread')
  check(JSON.stringify(converted.input).includes('PEER_FIXTURE_IDLE'), 'Gateway provider adapter preserves the new peer request')
  check(results().every(result => !result.is_error), 'all model turns succeed')
  check(!requests.some(request => text(request.messages?.at(-1)?.content).includes('A background agent completed a task:')), 'peer requests not labelled completed tasks')
  await child.close()
  const resumedEvents: any[] = []
  const requestCount = requests.length
  child = new LeafProcess({ executable: process.execPath, args: [cli, '--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--resume', id, '--model', 'claude-sonnet-4-6', '--tools', ''], cwd: root, env, onEvent: event => resumedEvents.push(event), onState() {} })
  await child.start()
  const resumed = await sender.send(id, 'PEER_FIXTURE_AFTER_RESUME\nOnly address this new request.', 'After resume') as any
  await wait(() => resumedEvents.some(event => event.type === 'result'), 'resumed peer response')
  await wait(async () => (await inbox()).records.some((record: any) => record.message.id === resumed.id && record.state === 'delivered'), 'resumed receipt')
  check(requests.slice(requestCount).every(request => text(request.messages?.at(-1)?.content).includes('PEER_FIXTURE_AFTER_RESUME')), 'resume does not execute previously delivered peer messages again')
  check(requests.slice(requestCount).some(request => request.messages.some((message: any) => text(message.content).includes('PEER_FIXTURE_RESTART_ONE'))), 'resume retains earlier peer context')
  if (process.env.GATEWAY_PEER_STRESS === '1') {
    const senders: GatewaySessionTransport[] = []
    let completed = 0
    try {
      for (let round = 0; round < 10; round++) {
        const peer = new GatewaySessionTransport({ directory, sessionId: randomUUID(), name: `Stress sender ${round}`, cwd: root })
        senders.push(peer)
        await peer.start()
        const sent: { id: string; marker: string }[] = []
        const start = requests.length
        for (let index = 0; index < 10; index++) {
          const marker = `PEER_STRESS_${round}_${index}`
          const receipt = await peer.send(id, `${marker}\n${'Exact café 世界 payload. '.repeat(20)}`, marker) as any
          assert.equal(receipt.state, 'queued', `Stress receipt: ${JSON.stringify({ round, index, ok: receipt.ok, state: receipt.state, reason: receipt.reason })}`)
          sent.push({ id: receipt.id, marker })
        }
        await wait(async () => {
          const stored = await inbox()
          return sent.every(item => stored.records.some((record: any) => record.message.id === item.id && record.state === 'delivered'))
        }, 'stress batch completion', 30000)
        for (const item of sent) {
          const occurrences = requests.slice(start).filter(request => text(request.messages?.at(-1)?.content).includes(item.marker)).length
          assert.equal(occurrences, 1, 'Each peer task must reach exactly one new model turn')
        }
        completed += sent.length
        await peer.close()
        console.log(JSON.stringify({ stress: 'compiled-model-turns', completed, inboxRecords: (await inbox()).records.length }))
      }
    } finally { for (const peer of senders) await peer.close() }
    check(completed === 100, '100 peer tasks complete without omission or duplicate model turns')
  }
  assert.deepEqual(failures, [])
} finally {
  await child?.close()
  await sender.close()
  server.stop(true)
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
