import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { access, mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const candidateCli = process.env.GATEWAY_ACCEPTANCE_CANDIDATE
  ? resolve(process.env.GATEWAY_ACCEPTANCE_CANDIDATE)
  : resolve(dirname(fileURLToPath(import.meta.url)), '../.candidate-build/cli.js')
if (process.env.GATEWAY_ACCEPTANCE_CANDIDATE && !isAbsolute(process.env.GATEWAY_ACCEPTANCE_CANDIDATE)) {
  throw new Error('GATEWAY_ACCEPTANCE_CANDIDATE must be an absolute path')
}
await access(candidateCli)

import { LeafProcess } from '../src/utils/leafProcess.ts'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { GatewaySessionTransport, listGatewayPeers } from '../src/utils/gatewaySessionTransport.ts'

for (const scenario of ['transport policy lifecycle', 'fork isolation']) test(`candidate CLI ${scenario} against a local provider fixture`, { timeout: 180000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaf-cli-'))
  const savedConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  let requests = 0
  const requestBodies: string[] = []
  let pauseNextResponse: (() => Promise<void>) | undefined
  let releaseBusyResponse: (() => void) | undefined
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    if (requests >= 60) { res.writeHead(400); res.end('Fixture request budget exceeded'); return }
    requestBodies.push(Buffer.concat(chunks).toString('utf8'))
    requests++
    console.log('CLI fixture request', req.method, req.url?.split('?')[0])
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const pause = pauseNextResponse
    pauseNextResponse = undefined
    if (pause) await pause()
    const events = [
      { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'LEAF_LOCAL_PROOF' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ]
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    res.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const received: Record<string, unknown>[] = []
  let finish!: () => void
  const completed = new Promise<void>(resolve => { finish = resolve })
  let resumed: LeafProcess | undefined
  const concurrent: LeafProcess[] = []
  const sender = new GatewaySessionTransport({ directory: join(directory, 'gateway-sessions'), sessionId: randomUUID(), name: 'Fixture sender', cwd: directory })
  const child = new LeafProcess({
    executable: process.execPath,
    args: [candidateCli, '--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--permission-prompt-tool', 'stdio'],
    cwd: directory,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, USERPROFILE: directory, HOME: directory, TEMP: directory, TMP: directory, CLAUDE_CONFIG_DIR: directory, CLAUDE_CODE_USE_GATEWAY: '1', CLAUDE_CODE_GATEWAY_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'local-fixture-only', ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    onEvent: event => { console.log('CLI fixture event', event.type, event.subtype ?? ''); received.push(event); if (event.type === 'result') finish() }, onState: () => {},
  })
  try {
    console.log('CLI proof: initializing first child')
    await child.start()
    console.log('CLI proof: first child initialized')
    assert.equal(child.getState(), 'idle')
    child.send('Reply with LEAF_LOCAL_PROOF')
    await completed
    assert.ok(requests > 0)
    assert.match(JSON.stringify(received.filter(event => event.type === 'assistant')), /LEAF_LOCAL_PROOF/)
    assert.equal(received.find(event => event.type === 'result')?.subtype, 'success')
    assert.equal(child.getState(), 'idle')
    const originalId = received.find(event => event.type === 'result')?.session_id as string
    assert.ok(originalId)
    const duplicate = new LeafProcess({ executable: process.execPath,
      args: [candidateCli, '--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--resume', originalId], cwd: directory,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, USERPROFILE: directory, HOME: directory, TEMP: directory, TMP: directory, CLAUDE_CONFIG_DIR: directory, CLAUDE_CODE_USE_GATEWAY: '1', CLAUDE_CODE_GATEWAY_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'local-fixture-only', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      onEvent: () => {}, onState: () => {},
    })
    const requestsBeforeDuplicate = requests
    try { await assert.rejects(duplicate.start()) } finally { await duplicate.close() }
    assert.equal(requests, requestsBeforeDuplicate)
    await sender.start()
    const peers = await listGatewayPeers(join(directory, 'gateway-sessions'))
    assert.ok(peers.some(peer => peer.sessionId === originalId))
    await child.close()
    const receiverPolicy = new GatewaySessionTransport({ directory: join(directory, 'gateway-sessions'), sessionId: originalId, name: 'Offline policy fixture', cwd: directory, policy: 'hold' })
    const heldMarker = '/clear must stay peer text'
    const refusedMarker = 'POLICY_REFUSAL_MUST_NOT_LEAK'
    await receiverPolicy.start()
    try {
      await receiverPolicy.setPolicy('hold')
      const policyRequests = requests
      const held = await sender.send(originalId, heldMarker, 'Held fixture') as { id: string; state: string }
      assert.equal(held.state, 'held')
      const heldInbox = receiverPolicy.inbox().find(record => record.message.id === held.id)
      assert.equal(heldInbox?.message.text, heldMarker)
      assert.equal(heldInbox?.state, 'held')
      await receiverPolicy.setPolicy('refuse')
      assert.equal(receiverPolicy.inbox().find(record => record.message.id === held.id)?.state, 'refused')
      const refused = await sender.send(originalId, refusedMarker, 'Refusal fixture') as { ok?: boolean; reason?: string; state?: string }
      assert.equal(refused.ok, false)
      assert.match(refused.reason ?? '', /refuses messages/)
      assert.equal(refused.state, undefined)
      assert.equal(receiverPolicy.inbox().some(record => record.message.text === refusedMarker), false)
      assert.equal(requests, policyRequests, 'Policy lifecycle messages must not reach the provider fixture')
      await receiverPolicy.setPolicy('accept')
    } finally { await receiverPolicy.close() }
    const resumedEvents: Record<string, unknown>[] = []
    let finishResume!: () => void
    const resumedTurn = new Promise<void>(resolve => { finishResume = resolve })
    resumed = new LeafProcess({ executable: process.execPath,
      args: [candidateCli, '--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--resume', originalId], cwd: directory,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, USERPROFILE: directory, HOME: directory, TEMP: directory, TMP: directory, CLAUDE_CONFIG_DIR: directory, CLAUDE_CODE_USE_GATEWAY: '1', CLAUDE_CODE_GATEWAY_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'local-fixture-only', ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      onEvent: event => { resumedEvents.push(event); if (event.type === 'result') finishResume() }, onState: () => {},
    })
    console.log('CLI proof: initializing resumed child')
    await resumed.start()
    console.log('CLI proof: resumed child initialized')
    await resumed.setModel('claude-sonnet-4-6')
    await resumed.setEffort('high')
    resumed.send('Continue the same conversation')
    await resumedTurn
    assert.equal(resumedEvents.find(event => event.type === 'result')?.subtype, 'success')
    assert.equal(resumedEvents.find(event => event.type === 'result')?.session_id, originalId)
    assert.equal(requestBodies.some(body => body.includes(heldMarker)), false, 'Held then refused peer text must not reach the provider fixture')
    assert.equal(requestBodies.some(body => body.includes(refusedMarker)), false, 'Refused peer text must not reach the provider fixture')
    const peerTurn = new Promise<void>(resolve => { finishResume = resolve })
    const accepted = await sender.send(originalId, 'PEER_IDLE_WAKE_PROOF', 'Idle wake') as { id: string; state: string }
    assert.equal(accepted.state, 'queued')
    await peerTurn
    assert.match(requestBodies.at(-1)!, /PEER_IDLE_WAKE_PROOF/)
    assert.match(requestBodies.at(-1)!, /Fixture sender/)
    const persistedInbox = JSON.parse(await readFile(join(directory, 'gateway-sessions', `${originalId}.inbox`), 'utf8'))
    assert.equal(persistedInbox.records.find((record: { message: { id: string } }) => record.message.id === accepted.id)?.state, 'delivered')
    let observeBusyRequest!: () => void
    const busyRequest = new Promise<void>(resolve => { observeBusyRequest = resolve })
    const responseReleased = new Promise<void>(resolve => { releaseBusyResponse = resolve })
    pauseNextResponse = async () => { observeBusyRequest(); await responseReleased }
    const beforeBusy = requestBodies.length
    const busyPeerTurn = new Promise<void>(resolve => {
      finishResume = () => { if (requestBodies.slice(beforeBusy).some(body => body.includes('PEER_BUSY_BOUNDARY_PROOF'))) resolve() }
    })
    resumed.send('BUSY_TURN_GATE')
    await busyRequest
    assert.equal(resumed.getState(), 'running')
    assert.equal((await listGatewayPeers(join(directory, 'gateway-sessions'))).find(peer => peer.sessionId === originalId)?.status, 'running')
    const busyAccepted = await sender.send(originalId, 'PEER_BUSY_BOUNDARY_PROOF', 'Busy boundary') as { id: string; state: string }
    assert.equal(busyAccepted.state, 'queued')
    assert.equal(requestBodies.length, beforeBusy + 1, 'Peer input must not start a parallel query while the response is blocked')
    const beforeBoundary = JSON.parse(await readFile(join(directory, 'gateway-sessions', `${originalId}.inbox`), 'utf8'))
    assert.equal(beforeBoundary.records.find((record: any) => record.message.id === busyAccepted.id)?.state, 'queued', 'Acceptance must not acknowledge incorporation')
    releaseBusyResponse!()
    await busyPeerTurn
    const afterBoundary = JSON.parse(await readFile(join(directory, 'gateway-sessions', `${originalId}.inbox`), 'utf8'))
    assert.equal(afterBoundary.records.find((record: any) => record.message.id === busyAccepted.id)?.state, 'delivered')
    const { getProjectDir: busyProjectDir } = await import('../src/utils/sessionStorage.ts')
    const busyTranscript = await readFile(join(busyProjectDir(directory), `${originalId}.jsonl`), 'utf8')
    assert.ok(busyTranscript.includes('PEER_BUSY_BOUNDARY_PROOF'))
    assert.ok(busyTranscript.includes(busyAccepted.id), 'Delivered receipt must correspond to a persisted message identity')
    assert.equal(requestBodies.slice(beforeBusy).filter(body => body.includes('PEER_BUSY_BOUNDARY_PROOF')).length, 1)
    await resumed.close()
    if (scenario === 'fork isolation') {
    const results: Record<string, unknown>[] = []
    const turns: Promise<void>[] = []
    const { createFork } = await import('../src/commands/branch/branch.ts')
    const { getProjectDir } = await import('../src/utils/sessionStorage.ts')
    const sourcePath = join(getProjectDir(directory), `${originalId}.jsonl`)
    const forkIds: string[] = []
    for (let index = 0; index < 5; index++) {
      const fork = await createFork(undefined, { sessionId: originalId, transcriptPath: sourcePath })
      forkIds.push(fork.sessionId)
      let done!: () => void
      turns.push(new Promise<void>(resolve => { done = resolve }))
      concurrent.push(new LeafProcess({ executable: process.execPath,
        args: [candidateCli, '--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--resume', fork.forkPath], cwd: directory,
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, USERPROFILE: directory, HOME: directory, TEMP: directory, TMP: directory, CLAUDE_CONFIG_DIR: directory, CLAUDE_CODE_USE_GATEWAY: '1', CLAUDE_CODE_GATEWAY_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'local-fixture-only', ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
        onEvent: event => { if (event.type === 'result') { results.push(event); done() } }, onState: () => {},
      }))
    }
    console.log('CLI proof: starting five concurrent children')
    for (const child of concurrent) {
      const starting = child.start()
      ;(child as unknown as { child: import('node:child_process').ChildProcessWithoutNullStreams }).child.stderr.on('data', chunk => console.log('Isolated fork startup:', chunk.toString()))
      await starting
    }
    concurrent.forEach((process, index) => process.send(`Independent leaf ${index}`))
    await Promise.all(turns)
    assert.equal(results.length, 5)
    assert.ok(results.every(result => result.subtype === 'success'))
    assert.equal(new Set(results.map(result => result.session_id)).size, 5)
    assert.deepEqual(results.map(result => result.session_id).sort(), forkIds.sort())
    for (const body of requestBodies.slice(-5)) {
      assert.match(body, /PEER_IDLE_WAKE_PROOF/)
      const markers = [...body.matchAll(/Independent leaf (\d)/g)].map(match => match[1])
      assert.equal(new Set(markers).size, 1)
    }
    assert.doesNotMatch(await readFile(sourcePath, 'utf8'), /Independent leaf/)
    await Promise.all(concurrent.map(process => process.close()))
    }
  } finally {
    releaseBusyResponse?.()
    await Promise.all(concurrent.map(process => process.close()))
    await resumed?.close()
    await child.close()
    await sender.close()
    if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedConfig
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})
