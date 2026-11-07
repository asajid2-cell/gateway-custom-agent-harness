import { strict as assert } from 'node:assert'
import { access, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const gatewayEnvKeys = [
  'CLAUDE_CODE_USE_GATEWAY',
  'CLAUDE_CODE_GATEWAY_BASE_URL',
  'CLAUDE_CODE_GATEWAY_TOKEN',
  'MODEL_GATEWAY_MODEL',
  'MODEL_GATEWAY_DEFAULT_MODEL',
  'MODEL_GATEWAY_OPUS_MODEL',
  'MODEL_GATEWAY_FAST_MODEL',
  'MODEL_GATEWAY_SUBAGENT_MODEL',
  'MODEL_GATEWAY_EFFORT',
  'MODEL_GATEWAY_EFFORT_CAPABILITIES',
  'MODEL_GATEWAY_MODEL_OPTIONS',
]

const spawnUtilsSource = await readFile(
  new URL('../src/utils/swarm/spawnUtils.ts', import.meta.url),
  'utf8',
)
const teammateModelSource = await readFile(
  new URL('../src/utils/swarm/teammateModel.ts', import.meta.url),
  'utf8',
)
const agentModelSource = await readFile(
  new URL('../src/utils/model/agent.ts', import.meta.url),
  'utf8',
)

test('Gateway agents resolve real models and reject misleading tool aliases', async () => {
  const oldGateway = process.env.CLAUDE_CODE_USE_GATEWAY
  const oldOverride = process.env.CLAUDE_CODE_SUBAGENT_MODEL
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
  try {
    const { getAgentModel } = await import('../src/utils/model/agent.ts')
    assert.equal(getAgentModel(undefined, 'gateway-gpt-sol'), 'gateway-gpt-terra')
    for (const model of ['gateway-gpt-terra', 'gateway-gpt-sol', 'gateway-gpt-luna', 'gateway-gpt-astra', 'gateway-opencode-kimi-k3']) {
      assert.equal(getAgentModel(undefined, 'gateway-gpt-sol', model), model)
    }
    assert.throws(() => getAgentModel(undefined, 'gateway-gpt-sol', 'sonnet'), /real Gateway model/)
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'gateway-gpt-sol'
    assert.equal(getAgentModel(undefined, 'gateway-gpt-sol'), 'gateway-gpt-terra')
    assert.equal(getAgentModel(undefined, 'gateway-gpt-sol', 'gateway-gpt-terra'), 'gateway-gpt-terra')
  } finally {
    if (oldGateway === undefined) delete process.env.CLAUDE_CODE_USE_GATEWAY
    else process.env.CLAUDE_CODE_USE_GATEWAY = oldGateway
    if (oldOverride === undefined) delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
    else process.env.CLAUDE_CODE_SUBAGENT_MODEL = oldOverride
  }
})

test('Gateway Agent schema exposes actual models, effort, and local steering', async () => {
  const before = process.env.CLAUDE_CODE_USE_GATEWAY
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  try {
    const { inputSchema } = await import('../src/tools/AgentTool/AgentTool.tsx')
    const { SendMessageTool } = await import('../src/tools/SendMessageTool/SendMessageTool.ts')
    const base = { description: 'Scoped check', prompt: 'Inspect only' }
    assert.equal(inputSchema().safeParse({ ...base, model: 'gateway-gpt-terra', effort: 'medium' }).success, true)
    assert.equal(inputSchema().safeParse({ ...base, model: 'gateway-gpt-astra', effort: 'high' }).success, true)
    assert.equal(inputSchema().safeParse({ ...base, model: 'sonnet' }).success, false)
    assert.equal(inputSchema().safeParse({ ...base, effort: 'imaginary' }).success, false)
    assert.equal(SendMessageTool.isEnabled(), true)
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CODE_USE_GATEWAY
    else process.env.CLAUDE_CODE_USE_GATEWAY = before
  }
})

test('subagent effort does not inherit a more expensive global override', async () => {
  const gateway = process.env.CLAUDE_CODE_USE_GATEWAY
  const effort = process.env.CLAUDE_CODE_EFFORT_LEVEL
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  process.env.CLAUDE_CODE_EFFORT_LEVEL = 'high'
  try {
    const { resolveAppliedEffort } = await import('../src/utils/effort.ts')
    const { runWithAgentContext } = await import('../src/utils/agentContext.ts')
    assert.equal(resolveAppliedEffort('gateway-gpt-sol', 'medium'), 'high')
    const selected = await runWithAgentContext({ agentId: 'effort-test', agentType: 'subagent' }, async () => resolveAppliedEffort('gateway-gpt-sol', 'medium'))
    assert.equal(selected, 'medium')
  } finally {
    if (gateway === undefined) delete process.env.CLAUDE_CODE_USE_GATEWAY
    else process.env.CLAUDE_CODE_USE_GATEWAY = gateway
    if (effort === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    else process.env.CLAUDE_CODE_EFFORT_LEVEL = effort
  }
})

test('SendMessage steers a running local agent exactly once and refuses live retiering', async () => {
  const { SendMessageTool } = await import('../src/tools/SendMessageTool/SendMessageTool.ts')
  const { getDefaultAppState } = await import('../src/state/AppState.tsx')
  const { createAgentId } = await import('../src/utils/uuid.ts')
  const { drainPendingMessages } = await import('../src/tasks/LocalAgentTask/LocalAgentTask.tsx')
  const id = createAgentId()
  let state = { ...getDefaultAppState(), tasks: { [id]: { id, agentId: id, type: 'local_agent', agentType: 'general-purpose', status: 'running', pendingMessages: [] } } }
  const setAppState = update => { state = update(state) }
  const context = { getAppState: () => state, setAppState }
  const result = await SendMessageTool.call({ to: id, message: 'Focus only on the failing assertion', summary: 'Narrow investigation' }, context, async () => ({ behavior: 'deny' }))
  assert.equal(result.data.success, true)
  assert.deepEqual(drainPendingMessages(id, () => state, setAppState), ['Focus only on the failing assertion'])
  assert.deepEqual(drainPendingMessages(id, () => state, setAppState), [])
  const rejected = await SendMessageTool.call({ to: id, message: 'Escalate', model: 'gateway-gpt-sol', effort: 'high' }, context, async () => ({ behavior: 'deny' }))
  assert.equal(rejected.data.success, false)
  assert.equal(state.tasks[id].status, 'running')
  assert.deepEqual(state.tasks[id].pendingMessages, [])
})

for (const explicit of [true, false]) test(`compiled Agent sends selected model and effort to the provider (explicit=${explicit})`, { timeout: 90000 }, async () => {
  const { createServer } = await import('node:http')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { LeafProcess } = await import('../src/utils/leafProcess.ts')
  const defaultCandidate = fileURLToPath(new URL('../.candidate-build/cli.js', import.meta.url))
  const candidate = process.env.GATEWAY_ACCEPTANCE_CANDIDATE ?? defaultCandidate
  try {
    await access(candidate)
  } catch {
    throw new Error(`Gateway acceptance candidate is missing or unreadable: ${candidate}`)
  }
  const directory = await mkdtemp(join(tmpdir(), 'gateway-agent-contract-'))
  const requests = []
  let parentCalls = 0
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push(body)
    const parent = body.model === 'gateway-gpt-astra'
    const invoke = parent && parentCalls++ === 0
    const agentName = body.tools?.find(tool => tool.name === 'Agent' || tool.name === 'Task')?.name
    const events = [
      { type: 'message_start', message: { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: invoke ? { type: 'tool_use', id: 'call_contract', name: agentName, input: {} } : { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: invoke ? { type: 'input_json_delta', partial_json: JSON.stringify({ description: 'Verify scoped task', prompt: 'Reply CHILD_DONE without tools', subagent_type: 'general-purpose', ...(explicit ? { model: 'gateway-gpt-terra', effort: 'medium' } : {}) }) } : { type: 'text_delta', text: parent ? 'PARENT_DONE' : 'CHILD_DONE' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: invoke ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ]
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  const events = []
  const child = new LeafProcess({ executable: process.execPath,
    args: [candidate, '--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--model', 'gateway-gpt-astra', '--allowedTools', 'Agent,Task', '--max-turns', '3'],
    cwd: directory,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, USERPROFILE: directory, HOME: directory, TEMP: directory, TMP: directory, CLAUDE_CONFIG_DIR: directory, CLAUDE_CODE_USE_GATEWAY: '1', CLAUDE_CODE_GATEWAY_BASE_URL: url, ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: 'local-fixture-only', CLAUDE_CODE_SUBAGENT_MODEL: 'gateway-gpt-sol', CLAUDE_CODE_EFFORT_LEVEL: 'high', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' },
    onEvent: event => events.push(event), onState: () => {},
  })
  try {
    await child.start()
    child.send('Delegate a scoped task then finish.')
    const deadline = Date.now() + 60000
    while (!events.some(event => event.type === 'result')) {
      assert.equal(child.getPermissions().length, 0, 'No unexpected permission prompt')
      if (Date.now() > deadline) throw new Error('Agent fixture did not complete')
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.equal(events.find(event => event.type === 'result').subtype, 'success')
    const { readdir, readFile } = await import('node:fs/promises')
    async function metadataFiles(path) {
      const found = []
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const full = join(path, entry.name)
        if (entry.isDirectory()) found.push(...await metadataFiles(full))
        else if (entry.name.endsWith('.meta.json')) found.push(full)
      }
      return found
    }
    const metadataPaths = await metadataFiles(directory)
    assert.ok(metadataPaths.length > 0, 'Agent settings must persist for resume')
    const metadata = await Promise.all(metadataPaths.map(async path => JSON.parse(await readFile(path, 'utf8'))))
    assert.ok(metadata.some(value => value.model === 'gateway-gpt-terra' && value.effort === 'medium'))
    const subagentRequests = requests.filter(body => body.model !== 'gateway-gpt-astra')
    assert.ok(subagentRequests.length > 0, 'Compiled Agent must actually call the provider')
    for (const body of subagentRequests) {
      assert.equal(body.model, 'gateway-gpt-terra')
      assert.equal(body.output_config?.effort, 'medium')
    }
  } finally {
    await child.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})

function validateParentToolLifecycle(parentRequests, expectedAgentId) {
  const calls = []
  const results = []
  const parseResultValue = value => {
    if (typeof value === 'string') {
      try {
        return parseResultValue(JSON.parse(value))
      } catch {
        return undefined
      }
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const parsed = parseResultValue(item)
        if (parsed !== undefined) return parsed
      }
      return undefined
    }
    if (value && typeof value === 'object') {
      if (value.type === 'text' && typeof value.text === 'string') {
        return parseResultValue(value.text)
      }
      if (value.success === false) return value
      if ('content' in value) return parseResultValue(value.content)
    }
    return undefined
  }
  const stableInput = (name, input) => {
    const value = input ?? {}
    if (name === 'SendMessage') {
      return JSON.stringify({
        to: value.to ?? value.recipient,
        message: value.message ?? value.content,
        summary: value.summary,
        model: value.model,
        effort: value.effort,
      })
    }
    if (name === 'ToolSearch') return JSON.stringify({ query: value.query })
    return JSON.stringify(value)
  }
  for (const snapshot of parentRequests) {
    for (const message of snapshot.messages ?? []) {
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block?.type === 'tool_use') {
          const existing = calls.find(call => call.id === block.id)
          const call = { id: block.id, name: block.name, input: block.input ?? {} }
          if (existing) {
            assert.equal(existing.name, call.name, `Tool call ${call.id} changed name across repeated snapshots`)
            assert.equal(stableInput(existing.name, existing.input), stableInput(call.name, call.input), `Tool call ${call.id} changed input across repeated snapshots`)
          } else {
            calls.push(call)
          }
        }
        if (block?.type === 'tool_result') {
          const existing = results.find(result => result.id === block.tool_use_id)
          const value = parseResultValue(block.content)
          const result = { id: block.tool_use_id, isError: block.is_error === true, content: block.content, value }
          if (existing) {
            assert.equal(existing.isError, result.isError, `Tool result ${result.id} changed error state across repeated snapshots`)
            assert.deepEqual(existing.content, result.content, `Tool result ${result.id} changed payload across repeated snapshots`)
          } else {
            results.push(result)
          }
        }
      }
    }
  }
  assert.deepEqual(calls.map(call => call.name), ['Agent', 'ToolSearch', 'SendMessage', 'SendMessage'])
  assert.equal(calls[2].input.to, expectedAgentId)
  assert.equal(calls[3].input.to, expectedAgentId)
  for (const call of calls) {
    const matching = results.filter(result => result.id === call.id)
    assert.equal(matching.length, 1, `Tool call ${call.id} must have one consistent result`)
    assert.equal(matching[0].isError, false, `Tool call ${call.id} returned an error`)
    assert.notEqual(parseResultValue(matching[0].value)?.success, false, `Tool call ${call.id} returned success:false`)
  }
}

test('parent lifecycle validation rejects extra, missing, and unsuccessful unique calls', () => {
  const snapshot = (calls, results) => ({ messages: [
    { role: 'assistant', content: calls.map(call => ({ type: 'tool_use', ...call })) },
    { role: 'user', content: results.map(result => ({ type: 'tool_result', ...result })) },
  ] })
  const baseCalls = [
    { id: 'agent-1', name: 'Agent', input: {} },
    { id: 'search-1', name: 'ToolSearch', input: { query: 'select:SendMessage' } },
    { id: 'send-1', name: 'SendMessage', input: { to: 'agent-1', message: 'one' } },
    { id: 'send-2', name: 'SendMessage', input: { to: 'agent-1', message: 'two' } },
  ]
  const baseResults = baseCalls.map(call => ({ tool_use_id: call.id, content: [{ type: 'text', text: call.name === 'Agent' ? 'agentId: agent-1' : '{"success":true}' }] }))
  validateParentToolLifecycle([snapshot(baseCalls, baseResults), snapshot(baseCalls, baseResults)], 'agent-1')
  assert.throws(() => validateParentToolLifecycle([snapshot([...baseCalls, { id: 'send-3', name: 'SendMessage', input: { to: 'agent-1' } }], baseResults)], 'agent-1'))
  assert.throws(() => validateParentToolLifecycle([snapshot(baseCalls, baseResults.filter(result => result.tool_use_id !== 'send-2'))], 'agent-1'))
  assert.throws(() => validateParentToolLifecycle([snapshot(baseCalls, baseResults.map(result => result.tool_use_id === 'send-1' ? { ...result, content: [{ type: 'text', text: JSON.stringify({ success: false }) }] } : result))], 'agent-1'))
  assert.throws(() => validateParentToolLifecycle([snapshot(baseCalls, baseResults.map(result => result.tool_use_id === 'send-1' ? { ...result, content: '{"success":false}' } : result))], 'agent-1'))
  assert.throws(() => validateParentToolLifecycle([snapshot(baseCalls, baseResults.map(result => result.tool_use_id === 'send-1' ? { ...result, is_error: true } : result))], 'agent-1'))
  const repeatedPayload = snapshot(baseCalls, baseResults)
  const changedPayload = snapshot(baseCalls, baseResults.map(result => result.tool_use_id === 'send-1' ? { ...result, content: [{ type: 'text', text: JSON.stringify({ success: true, changed: true }) }] } : result))
  assert.throws(() => validateParentToolLifecycle([repeatedPayload, changedPayload], 'agent-1'))
  const rawTextConflict = snapshot(baseCalls, baseResults.map(result => result.tool_use_id === 'send-1' ? { ...result, content: [{ type: 'text', text: '{"success":true,"raw":"different"}' }] } : result))
  assert.throws(() => validateParentToolLifecycle([snapshot(baseCalls, baseResults), rawTextConflict], 'agent-1'))
  validateParentToolLifecycle([snapshot(baseCalls, baseResults), snapshot(baseCalls, baseResults)], 'agent-1')
})

test('compiled SendMessage resumes a stopped Terra agent with preserved history and supported overrides', { timeout: 90000 }, async () => {
  const { createServer } = await import('node:http')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { LeafProcess } = await import('../src/utils/leafProcess.ts')
  const defaultCandidate = fileURLToPath(new URL('../.candidate-build/cli.js', import.meta.url))
  const candidate = process.env.GATEWAY_ACCEPTANCE_CANDIDATE ?? defaultCandidate
  try {
    await access(candidate)
  } catch {
    throw new Error(`Gateway acceptance candidate is missing or unreadable: ${candidate}`)
  }

  const directory = await mkdtemp(join(tmpdir(), 'gateway-agent-resume-'))
  const parentRequests = []
  const childRequests = []
  let parentCalls = 0
  let resumedAgentId
  const toolEvents = (model, name, input, requestNumber) => [
    { type: 'message_start', message: { id: `msg_${requestNumber}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `call_${requestNumber}`, name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]
  const textEvents = (model, text, requestNumber) => [
    { type: 'message_start', message: { id: `msg_${requestNumber}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const requestNumber = parentRequests.length + childRequests.length + 1
    let events
    const agentName = body.tools?.find(tool => tool.name === 'Agent' || tool.name === 'Task')?.name ?? 'Agent'
    if (body.model === 'gateway-gpt-astra') {
      parentRequests.push(body)
      if (parentCalls === 0) {
        events = toolEvents(body.model, agentName, {
          description: 'Resume contract', prompt: 'Reply INITIAL_HISTORY_MARKER without tools', subagent_type: 'general-purpose', model: 'gateway-gpt-terra', effort: 'medium',
        }, requestNumber)
      } else if (parentCalls === 1) {
        const match = JSON.stringify(body).match(/agentId:\s*([a-z0-9-]+)/i)
        assert.ok(match, `Agent tool result must expose the actual spawned agent ID: ${JSON.stringify(body.messages)}`)
        resumedAgentId = match[1]
        assert.equal(
          body.tools?.some(tool => tool.name === 'SendMessage'),
          false,
          'SendMessage must remain deferred until ToolSearch discovers it',
        )
        assert.ok(
          body.tools?.some(tool => tool.name === 'ToolSearch'),
          'Compiled runtime must expose ToolSearch while SendMessage is deferred',
        )
        events = toolEvents(body.model, 'ToolSearch', { query: 'select:SendMessage' }, requestNumber)
      } else if (parentCalls === 2) {
        assert.ok(
          body.tools?.some(tool => tool.name === 'SendMessage'),
          'Compiled runtime must expose SendMessage after ToolSearch discovers it',
        )
        events = toolEvents(body.model, 'SendMessage', { to: resumedAgentId, message: 'Reply RESUME_DEFAULT_MARKER after INITIAL_HISTORY_MARKER', summary: 'Resume default tier' }, requestNumber)
      } else if (parentCalls === 3) {
        assert.ok(
          body.tools?.some(tool => tool.name === 'SendMessage'),
          'SendMessage schema must persist for the explicit supported resume override',
        )
        events = toolEvents(body.model, 'SendMessage', { to: resumedAgentId, message: 'Reply RESUME_OVERRIDE_MARKER after both earlier markers', summary: 'Resume supported override', model: 'gateway-gpt-terra', effort: 'high' }, requestNumber)
      } else {
        events = textEvents(body.model, 'PARENT_DONE', requestNumber)
      }
      parentCalls++
    } else {
      childRequests.push(body)
      const marker = ['INITIAL_HISTORY_MARKER', 'RESUME_DEFAULT_MARKER', 'RESUME_OVERRIDE_MARKER'][childRequests.length - 1]
      events = textEvents(body.model, marker, requestNumber)
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  const events = []
  const child = new LeafProcess({ executable: process.execPath,
    args: [candidate, '--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--model', 'gateway-gpt-astra', '--allowedTools', 'Agent,Task,SendMessage,ToolSearch', '--max-turns', '7', '--dangerously-skip-permissions'],
    cwd: directory,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, USERPROFILE: directory, HOME: directory, TEMP: directory, TMP: directory, CLAUDE_CONFIG_DIR: directory, CLAUDE_CODE_USE_GATEWAY: '1', CLAUDE_CODE_GATEWAY_BASE_URL: url, ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: 'local-fixture-only', CLAUDE_CODE_SUBAGENT_MODEL: 'gateway-gpt-sol', CLAUDE_CODE_EFFORT_LEVEL: 'high', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' },
    onEvent: event => events.push(event), onState: () => {},
  })
  try {
    await child.start()
    child.send('Delegate, resume twice, then finish.')
    const deadline = Date.now() + 60000
    while (!events.some(event => event.type === 'result')) {
      assert.equal(child.getPermissions().length, 0, 'No unexpected permission prompt')
      if (Date.now() > deadline) throw new Error(`Compiled resume fixture did not complete (parent=${parentRequests.length}, child=${childRequests.length}, parentMessages=${JSON.stringify(parentRequests.map(body => body.messages?.map(message => ({ role: message.role, content: JSON.stringify(message.content).slice(0, 500) }))))}, events=${JSON.stringify(events.slice(-8))})`)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.equal(events.find(event => event.type === 'result').subtype, 'success')
    assert.ok(resumedAgentId, 'The real Agent result supplied the resume target')
    assert.equal(childRequests.length, 3, `Expected spawn plus default and explicit-override resumes (parent=${parentRequests.length}, child=${childRequests.length}, parentTools=${JSON.stringify(parentRequests.map(body => body.tools?.map(tool => tool.name)))} parentMessages=${JSON.stringify(parentRequests.map(body => body.messages?.map(message => ({ role: message.role, content: JSON.stringify(message.content).slice(0, 1000) }))))})`)
    assert.deepEqual(childRequests.map(body => body.model), ['gateway-gpt-terra', 'gateway-gpt-terra', 'gateway-gpt-terra'])
    assert.deepEqual(childRequests.map(body => body.output_config?.effort), ['medium', 'medium', 'high'])
    const serializedResumes = childRequests.slice(1).map(body => JSON.stringify(body))
    assert.match(serializedResumes[0], /INITIAL_HISTORY_MARKER/)
    assert.match(serializedResumes[0], /RESUME_DEFAULT_MARKER/)
    assert.match(serializedResumes[1], /INITIAL_HISTORY_MARKER/)
    assert.match(serializedResumes[1], /RESUME_DEFAULT_MARKER/)
    assert.match(serializedResumes[1], /RESUME_OVERRIDE_MARKER/)
    validateParentToolLifecycle(parentRequests, resumedAgentId)
  } finally {
    await child.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})

test('tmux and pane teammates inherit the complete Gateway route', async () => {
  for (const key of gatewayEnvKeys) {
    assert.match(
      spawnUtilsSource,
      new RegExp(`['"]${key}['"]`),
      `${key} is not forwarded by buildInheritedEnvVars`,
    )
  }
})

test('Gateway teammate model resolution is provider-aware', () => {
  assert.match(teammateModelSource, /getAPIProvider\(\)\s*===\s*['"]gateway['"]/)
  assert.match(teammateModelSource, /MODEL_GATEWAY_SUBAGENT_MODEL/)
  // The bare-CLI fallback must sit on a lane that answers. It named the ds lane
  // until that credential left the vault (2026-11-07: every gateway-ds-* route
  // answers 401), so it now names a capable Codex route.
  assert.match(teammateModelSource, /gateway-gpt-6-luna/)
  assert.match(agentModelSource, /parseUserSpecifiedModel/)
})
