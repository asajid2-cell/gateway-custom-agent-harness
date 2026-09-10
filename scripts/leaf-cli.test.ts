import { test } from 'node:test'
import { exercisePromptWorkspace } from './gateway-prompt-workspace.test.tsx'
import { strict as assert } from 'node:assert'
import { access, mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises'
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

for (const scenario of ['transport policy lifecycle', 'fork isolation', 'workspace lifecycle']) test(`candidate CLI ${scenario} against a local provider fixture`, { timeout: 180000 }, async () => {
  const inheritedFixture = process.env.LEAF_WORKSPACE_FIXTURE
  const directory = inheritedFixture ?? await mkdtemp(join(tmpdir(), 'leaf-cli-'))
  if (scenario === 'workspace lifecycle' && !inheritedFixture) {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    try {
      const result = await promisify(execFile)('node', [resolve('C:/Users/Ahmed/.claude/skills/verified-execution/scripts/run-bounded.mjs'), '--timeout-ms', '120000', '--node-heap-mb', '1024', '--cwd', resolve(import.meta.dir, '..'), '--', process.execPath, 'test', '--timeout', '110000', '--test-name-pattern', 'workspace lifecycle', fileURLToPath(import.meta.url)], { env: { ...process.env, LEAF_WORKSPACE_FIXTURE: directory }, timeout: 130000, maxBuffer: 65536 })
      console.log(result.stdout)
    } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) }
    return
  }
  const savedConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  let requests = 0
  const requestBodies: string[] = []
  let requestApproval = false
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
    if (requestApproval) {
      requestApproval = false
      events.splice(1, 2,
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_fixture_permission', name: 'Bash', input: {} } } as any,
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: 'printf APPROVAL_FIXTURE', description: 'Local approval fixture' }) } } as any)
      ;(events[4] as any).delta.stop_reason = 'tool_use'
    }
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
    if (scenario === 'transport policy lifecycle' || scenario === 'fork isolation') {
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
    } else if (scenario === 'workspace lifecycle') {
    const workspace = await import('../src/utils/leafWorkspace.ts')
    const { getTranscriptPath } = await import('../src/utils/sessionStorage.ts')
    const { getSessionId } = await import('../src/bootstrap/state.ts')
    const { dirname } = await import('node:path')
    const rootPath = getTranscriptPath()
    await mkdir(dirname(rootPath), { recursive: true })
    const rootId = getSessionId()
    await writeFile(rootPath, JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: rootId, parentUuid: null, isSidechain: false, message: { role: 'user', content: 'WORKSPACE_ROOT_CONTEXT' }, timestamp: new Date().toISOString() }) + '\n')
    const { getCwdState, setCwdState } = await import('../src/bootstrap/state.ts')
    const oldCwd = getCwdState()
    setCwdState(directory)
    const oldArg = process.argv[1]
    const systemRoot = process.env.SystemRoot
    const systemPath = process.env.PATH
    const oldEnv = { ...process.env }
    process.argv[1] = candidateCli
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, { NODE_ENV: 'test', PATH: systemPath, SystemRoot: systemRoot, SYSTEMROOT: systemRoot, WINDIR: systemRoot, USERPROFILE: directory, HOME: directory, TEMP: directory, TMP: directory, CLAUDE_CONFIG_DIR: directory, CLAUDE_CODE_USE_GATEWAY: '1', CLAUDE_CODE_GATEWAY_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'local-fixture-only', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
    try {
      console.log('CLI proof: actual workspace create and reopen')
      const fresh = await workspace.createLeaf('Empty leaf', undefined, undefined, { fresh: true, model: 'claude-sonnet-4-6' })
      assert.equal(fresh.member.forkMessageId, null)
      assert.equal(fresh.output.length, 0)
      fresh.process.send('FRESH_LEAF_ONLY')
      const freshDeadline = Date.now() + 15000
      while (fresh.process.getState() !== 'idle') {
        if (Date.now() > freshDeadline) throw new Error('Fresh leaf did not finish')
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      assert.match(requestBodies.at(-1)!, /FRESH_LEAF_ONLY/)
      assert.doesNotMatch(requestBodies.at(-1)!, /WORKSPACE_ROOT_CONTEXT/)
      await workspace.changeLeaf(fresh.member.sessionId, { status: 'closed' })
      await workspace.changeLeaf(fresh.member.sessionId, { status: 'open' })
      const freshRestored = workspace.getLeafViews().find(view => view.member.sessionId === fresh.member.sessionId)!
      assert.ok(freshRestored.output.some(text => text.includes('FRESH_LEAF_ONLY')))
      await workspace.changeLeaf(fresh.member.sessionId, { status: 'closed' })
      const { execFile: runFile } = await import('node:child_process')
      const { promisify: asyncFile } = await import('node:util')
      const git = async (...args: string[]) => asyncFile(runFile)('git', args, { timeout: 10000, env: process.env })
      const repository = join(directory, 'repository')
      const isolated = join(directory, 'isolated')
      await mkdir(repository)
      await git('init', repository)
      await writeFile(join(repository, 'isolation.txt'), 'original')
      await git('-C', repository, 'add', 'isolation.txt')
      await git('-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Disposable fixture baseline')
      await git('-C', repository, 'worktree', 'add', '--detach', isolated)
      setCwdState(repository)
      const leaf = await workspace.createLeaf('Workspace leaf', undefined, isolated)
      assert.equal(resolve(leaf.member.cwd!), resolve(isolated))
      await writeFile(join(isolated, 'isolation.txt'), 'leaf-only')
      assert.equal(await readFile(join(repository, 'isolation.txt'), 'utf8'), 'original')
      console.log('Workspace created')
      assert.equal(leaf.process.getState(), 'idle')
      leaf.draft = 'SAVED_WORKSPACE_DRAFT'
      const id = leaf.member.sessionId
      const { call: leafCommand } = await import('../src/commands/leaf.tsx')
      let goalResult = ''
      await leafCommand(text => { goalResult = text ?? '' }, {} as any, `goal ${id} --nudges 1 INDEPENDENT_REOPENED_LEAF_GOAL`)
      assert.match(goalResult, /goal saved/)
      const { readPersistSessionRecord } = await import('../src/utils/sessionStorage.ts')
      const leafGoal = await readPersistSessionRecord(leaf.member.transcriptPath)
      assert.equal(leafGoal?.task, 'INDEPENDENT_REOPENED_LEAF_GOAL')
      assert.equal(leafGoal?.taskMode, 'bounded')
      assert.equal(leafGoal?.keep, false)
      let settingsResult = ''
      await leafCommand(text => { settingsResult = text ?? '' }, {} as any, `model ${id} claude-sonnet-4-6`)
      assert.match(settingsResult, /model updated and saved/)
      await leafCommand(text => { settingsResult = text ?? '' }, {} as any, `effort ${id} high`)
      assert.match(settingsResult, /effort updated and saved/)
      await workspace.changeLeaf(id, { status: 'closed' })
      console.log('Workspace closed')
      await workspace.changeLeaf(id, { status: 'open' })
      console.log('Workspace reopened')
      const processBeforeRename = workspace.getLeafViews().find(view => view.member.sessionId === id)!.process
      let renameResult = ''
      await leafCommand(text => { renameResult = text ?? '' }, {} as any, `rename ${id} Renamed workspace leaf`)
      assert.match(renameResult, /rename recorded/)
      const reopened = workspace.getLeafViews().find(view => view.member.sessionId === id)!
      assert.equal(reopened.process, processBeforeRename, 'Rename must not close or replace the live process')
      assert.equal(reopened.member.name, 'Renamed workspace leaf')
      assert.equal(reopened.member.transcriptPath, leaf.member.transcriptPath)
      assert.equal(reopened.member.number, leaf.member.number)
      assert.equal(reopened.draft, 'SAVED_WORKSPACE_DRAFT')
      assert.equal(reopened.member.sessionId, id)
      assert.equal(reopened.member.transcriptPath, leaf.member.transcriptPath)
      assert.equal(resolve(reopened.member.cwd!), resolve(isolated))
      assert.equal(resolve((reopened.process as unknown as { options: { cwd: string } }).options.cwd), resolve(isolated))
      assert.equal(reopened.process.getState(), 'idle')
      const childEnv = (reopened.process as unknown as { options: { env: NodeJS.ProcessEnv } }).options.env
      assert.equal(childEnv.CLAUDE_CODE_GATEWAY_BASE_URL, `http://127.0.0.1:${port}`)
      assert.equal(childEnv.ANTHROPIC_BASE_URL, `http://127.0.0.1:${port}`)
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      await promisify(execFile)(process.execPath, ['-e', `fetch(${JSON.stringify(`http://127.0.0.1:${port}`)}).then(r=>{if(!r.ok)process.exit(2)}).catch(e=>{console.error(e.code,e.message);process.exit(3)})`], { env: childEnv, timeout: 5000 })
      const turn = new Promise<void>(resolve => {
        const unsubscribe = workspace.subscribeLeafWorkspace(() => {
          if (reopened.process.getState() === 'idle' && reopened.output.some(text => text.includes('LEAF_LOCAL_PROOF'))) { unsubscribe(); resolve() }
        })
      })
      assert.equal(reopened.member.model, 'claude-sonnet-4-6')
      assert.equal(reopened.member.effort, 'high')
      reopened.process.send('WORKSPACE_REAL_TURN')
      await turn
      console.log('Workspace turn completed')
      const restoredRequest = JSON.parse(requestBodies.at(-1)!)
      assert.equal(restoredRequest.model, 'claude-sonnet-4-6')
      assert.equal(restoredRequest.output_config?.effort, 'high')
      assert.match(requestBodies.at(-1)!, /WORKSPACE_ROOT_CONTEXT/)
      assert.match(requestBodies.at(-1)!, /WORKSPACE_REAL_TURN/)
      assert.equal(requestBodies.at(-1)!.includes('INDEPENDENT_REOPENED_LEAF_GOAL'), true, 'Reopened leaf must restore its own durable goal')
      const approvalReady = new Promise<void>(resolve => {
        const unsubscribe = workspace.subscribeLeafWorkspace(() => {
          if (reopened.process.getState() === 'awaiting-approval') { unsubscribe(); resolve() }
        })
      })
      requestApproval = true
      reopened.process.send('Ask for approval for the fixture tool')
      await approvalReady
      const peersAtApproval = await listGatewayPeers(join(directory, 'gateway-sessions'))
      assert.equal(peersAtApproval.find(peer => peer.sessionId === id)?.status, 'awaiting-approval')
      const resolved = new Promise<void>(resolve => {
        const unsubscribe = workspace.subscribeLeafWorkspace(() => {
          if (reopened.process.getState() === 'idle') { unsubscribe(); resolve() }
        })
      })
      reopened.process.approve(reopened.process.getPermissions()[0]!.id, false)
      await resolved
      const nested = await workspace.createLeaf('Nested workspace', id)
      assert.equal(nested.member.parentSessionId, id)
      assert.equal(nested.member.number, reopened.member.number + 1)
      assert.match(await readFile(nested.member.transcriptPath, 'utf8'), /WORKSPACE_ROOT_CONTEXT/)
      let observeCancelledRequest!: () => void
      const cancelledRequest = new Promise<void>(resolve => { observeCancelledRequest = resolve })
      const cancelledResponse = new Promise<void>(resolve => { releaseBusyResponse = resolve })
      pauseNextResponse = async () => { observeCancelledRequest(); await cancelledResponse }
      reopened.process.send('CANCEL_ONLY_THIS_LEAF')
      await cancelledRequest
      const nestedDone = new Promise<void>(resolve => {
        const unsubscribe = workspace.subscribeLeafWorkspace(() => {
          if (nested.process.getState() === 'idle' && nested.output.some(text => text.includes('LEAF_LOCAL_PROOF'))) { unsubscribe(); resolve() }
        })
      })
      nested.process.send('OTHER_LEAF_CONTINUES_DURING_CANCEL')
      await reopened.process.interrupt()
      await nestedDone
      releaseBusyResponse!()
      const cancelDeadline = Date.now() + 10000
      while (reopened.process.getState() !== 'idle') {
        if (Date.now() > cancelDeadline) throw new Error('Interrupted leaf did not become idle')
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      assert.equal(nested.process.getState(), 'idle')
      assert.equal(workspace.getLeafViews().some(view => view.member.sessionId === id), true)
      assert.ok(requestBodies.some(body => body.includes('OTHER_LEAF_CONTINUES_DURING_CANCEL')))
      const terminalViews = [reopened, nested]
      for (let index = 3; index <= 5; index++) terminalViews.push(await workspace.createLeaf(`Terminal leaf ${index}`))
      assert.equal(workspace.getLeafViews().length, 5)
      reopened.draft = ''
      const beforeTerminal = requestBodies.length
      const terminalTurns = new Promise<void>(resolve => {
        const unsubscribe = workspace.subscribeLeafWorkspace(() => {
          if (requestBodies.length >= beforeTerminal + 5 && terminalViews.every(view => view.process.getState() === 'idle')) { unsubscribe(); resolve() }
        })
      })
      await exercisePromptWorkspace(terminalViews)
      await terminalTurns
      const terminalBodies = requestBodies.slice(beforeTerminal)
      assert.equal(terminalBodies.length, 5)
      const markers = ['TERMINAL_FIRST_LEAF', 'TERMINAL_SECOND_LEAF', 'TERMINAL_LEAF_3', 'TERMINAL_LEAF_4', 'TERMINAL_LEAF_5']
      for (const marker of markers) assert.equal(terminalBodies.filter(body => body.includes(marker)).length, 1)
      for (const body of terminalBodies) assert.equal(markers.filter(marker => body.includes(marker)).length, 1)
      assert.equal(terminalBodies.filter(body => body.includes('TERMINAL_FIRST_LEAF')).length, 1)
      assert.equal(terminalBodies.filter(body => body.includes('TERMINAL_SECOND_LEAF')).length, 1)
      assert.equal(await readPersistSessionRecord(nested.member.transcriptPath), null, 'A context fork retains historical goal text but must not arm the parent’s continuation state')
      assert.ok(terminalBodies.every(body => !(body.includes('TERMINAL_FIRST_LEAF') && body.includes('TERMINAL_SECOND_LEAF'))))
      const filed = terminalViews[4]!
      const { readLeafFamily } = await import('../src/utils/leafFamily.ts')
      let lifecycleResult = ''
      await leafCommand(text => { lifecycleResult = text ?? '' }, {} as any, `file ${filed.member.sessionId} fixture-filed`)
      assert.match(lifecycleResult, /filed by tag/)
      assert.equal(workspace.getLeafViews().some(view => view.member.sessionId === filed.member.sessionId), false)
      const filedRecords = (await readFile(filed.member.transcriptPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      assert.equal(filedRecords.some(record => record.type === 'tag' && record.tag === 'fixture-filed' && record.sessionId === filed.member.sessionId), true)
      await leafCommand(text => { lifecycleResult = text ?? '' }, {} as any, `promote ${filed.member.sessionId} Promoted fixture`)
      assert.match(lifecycleResult, /promote recorded/)
      const promotedFamily = await readLeafFamily(join(directory, 'leaf-families', `${filed.rootSessionId}.json`), filed.rootSessionId)
      const promoted = promotedFamily.members.find(member => member.sessionId === filed.member.sessionId)!
      assert.equal(promoted.status, 'promoted')
      assert.equal(promoted.transcriptPath, filed.member.transcriptPath)
      assert.equal(promoted.number, filed.member.number)
      assert.equal(promoted.parentSessionId, filed.member.parentSessionId)
      assert.equal(promoted.name, 'Promoted fixture')
      let finishPromoted!: () => void
      const promotedTurn = new Promise<void>(resolve => { finishPromoted = resolve })
      let resumedIdentity: unknown
      const normalSession = new LeafProcess({
        executable: process.execPath,
        args: [process.argv[1]!, '--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--resume', promoted.transcriptPath],
        cwd: promoted.cwd!, env: { ...childEnv, GATEWAY_LEAF_SESSION: undefined },
        onState: () => {},
        onEvent: event => { if (event.type === 'system' && event.subtype === 'init') resumedIdentity = event.session_id; if (event.type === 'result') finishPromoted() },
      })
      try {
        await normalSession.start()
        normalSession.send('PROMOTED_NORMAL_SESSION_TURN')
        await promotedTurn
        assert.equal(resumedIdentity, promoted.sessionId)
        assert.equal(requestBodies.at(-1)!.includes('TERMINAL_LEAF_5'), true)
        assert.equal(requestBodies.at(-1)!.includes('PROMOTED_NORMAL_SESSION_TURN'), true)
      } finally { await normalSession.close() }
    } finally {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const roots = workspace.getLeafViews().map(view => (view.process as unknown as { child: { pid: number } }).child.pid)
      let descendants: { ProcessId: number; CreationDate: string }[] = []
      if (process.platform === 'win32' && roots.length) {
        const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command', `$all=Get-CimInstance Win32_Process; $ids=@(${roots.join(',')}); do { $next=@($all | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids } | Select-Object -ExpandProperty ProcessId); $ids += $next } while($next.Count); ConvertTo-Json -Compress -InputObject @($all | Where-Object { $_.ProcessId -in $ids } | Select-Object ProcessId,@{n='CreationDate';e={$_.CreationDate.ToString('o')}})`], { timeout: 10000 })
        descendants = JSON.parse(result.stdout)
      }
      for (const view of workspace.getLeafViews()) await workspace.changeLeaf(view.member.sessionId, { status: 'closed' })
      if (descendants.length) {
        const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -in @(${descendants.map(item => item.ProcessId).join(',')}) } | Select-Object ProcessId,ParentProcessId,Name,@{n='CreationDate';e={$_.CreationDate.ToString('o')}} | ConvertTo-Json -Compress`], { timeout: 10000 })
        const remaining = result.stdout.trim() ? [JSON.parse(result.stdout)].flat() : []
        const survivors = remaining.filter(item => descendants.some(original => original.ProcessId === item.ProcessId && original.CreationDate === item.CreationDate))
        assert.deepEqual(survivors, [], 'Workspace descendants must exit during close (PID, parent, executable and creation time only)')
      }
      process.argv[1] = oldArg!
      setCwdState(oldCwd)
      for (const key of Object.keys(process.env)) delete process.env[key]
      Object.assign(process.env, oldEnv)
      await (await import('../src/utils/cleanupRegistry.ts')).runCleanupFunctions()
    }
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
    if (!inheritedFixture) await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})
