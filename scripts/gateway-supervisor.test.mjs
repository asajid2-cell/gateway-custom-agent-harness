import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const supervisor = path.join(root, 'gateway-supervisor.mjs')

async function stopTree(child) {
  if (child.exitCode !== null) return
  child.kill()
  await Promise.race([
    once(child, 'exit'),
    new Promise(resolve => setTimeout(resolve, 2000)),
  ])
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForMarker(file, marker, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if ((await readFile(file, 'utf8')).includes(marker)) return
    } catch {}
    await wait(10)
  }
  throw new Error(`Timed out waiting for marker ${marker}`)
}

async function fetchWithTimeout(url, options, timeoutMs = 250) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function findPort() {
  const server = http.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

test('gateway supervisor restarts a crashed local gateway and keeps the same port', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'gateway-supervisor-test-'))
  const childScript = path.join(temp, 'fake-gateway.mjs')
  const counter = path.join(temp, 'starts.txt')
  const port = await findPort()
  await writeFile(childScript, `
    import { appendFile } from 'node:fs/promises'
    import http from 'node:http'
    const counter = process.env.TEST_GATEWAY_STARTS
    await appendFile(counter, 'start\\n')
    const starts = (await import('node:fs/promises')).readFile(counter, 'utf8')
    if ((await starts).split('\\n').filter(Boolean).length === 1) {
      process.exit(1)
    }
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
    })
    server.listen(Number(process.argv[process.argv.indexOf('--port') + 1]), '127.0.0.1')
  `)

  const child = spawn(process.execPath, [
    supervisor,
    '--gateway',
    childScript,
    '--port',
    String(port),
  ], {
    cwd: root,
    env: {
      ...process.env,
      TEST_GATEWAY_STARTS: counter,
      MODEL_GATEWAY_SUPERVISOR_RESTART_BASE_MS: '10',
      MODEL_GATEWAY_SUPERVISOR_RESTART_MAX_MS: '10',
      MODEL_GATEWAY_SUPERVISOR_MAX_RESTARTS: '2',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })

  try {
    const deadline = Date.now() + 3000
    let response = null
    while (Date.now() < deadline) {
      try {
        response = await fetch(`http://127.0.0.1:${port}/health`)
        if (response.ok) break
      } catch {}
      await wait(10)
    }
    assert.equal(response?.status, 200, stderr)
    assert.deepEqual(
      (await readFile(counter, 'utf8')).trim().split(/\r?\n/).filter(Boolean),
      ['start', 'start'],
    )
    assert.match(stderr, /child-exit code=1 signal=none restart=1\/2/)
  } finally {
    await stopTree(child)
    await rm(temp, { recursive: true, force: true })
  }
})

test('consumer recovers across a supervised child restart with the follow-up tool catalog intact', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'gateway-supervisor-continuity-'))
  const childScript = path.join(temp, 'continuity-gateway.mjs')
  const starts = path.join(temp, 'starts.txt')
  const events = path.join(temp, 'events.txt')
  const requests = path.join(temp, 'requests.ndjson')
  const port = await findPort()
  await writeFile(childScript, `
    import { appendFile, readFile } from 'node:fs/promises'
    import http from 'node:http'

    const startsFile = process.env.TEST_GATEWAY_STARTS
    const eventsFile = process.env.TEST_GATEWAY_EVENTS
    const requestsFile = process.env.TEST_GATEWAY_REQUESTS
    await appendFile(startsFile, 'start\\n')
    const generation = (await readFile(startsFile, 'utf8'))
      .split(/\\r?\\n/)
      .filter(Boolean)
      .length

    const responseBody = [
      'data: ' + JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg-continuity',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-gpt-luna',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      }) + '\\n\\n',
      'data: ' + JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }) + '\\n\\n',
      'data: ' + JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'continuity-ok' },
      }) + '\\n\\n',
      'data: ' + JSON.stringify({
        type: 'content_block_stop',
        index: 0,
      }) + '\\n\\n',
      'data: ' + JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 },
      }) + '\\n\\n',
      'data: ' + JSON.stringify({ type: 'message_stop' }) + '\\n\\n',
    ].join('')

    const server = http.createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', generation }))
        return
      }
      if (req.method !== 'POST' || req.url !== '/v1/messages') {
        res.writeHead(404)
        res.end()
        return
      }

      const chunks = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const tools = Array.isArray(body.tools) ? body.tools : []
      await appendFile(
        requestsFile,
        JSON.stringify({
          generation,
          model: body.model,
          toolCount: tools.length,
          toolNames: tools.map(tool => tool.name),
        }) + '\\n',
      )
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(responseBody)

      if (generation === 1) {
        setTimeout(async () => {
          await appendFile(eventsFile, 'exit-1\\n')
          process.exit(1)
        }, 5)
      }
    })
    server.listen(Number(process.argv[process.argv.indexOf('--port') + 1]), '127.0.0.1')
  `)

  const child = spawn(process.execPath, [
    supervisor,
    '--gateway',
    childScript,
    '--port',
    String(port),
  ], {
    cwd: root,
    env: {
      ...process.env,
      TEST_GATEWAY_STARTS: starts,
      TEST_GATEWAY_EVENTS: events,
      TEST_GATEWAY_REQUESTS: requests,
      MODEL_GATEWAY_SUPERVISOR_RESTART_BASE_MS: '250',
      MODEL_GATEWAY_SUPERVISOR_RESTART_MAX_MS: '250',
      MODEL_GATEWAY_SUPERVISOR_MAX_RESTARTS: '2',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })

  const endpoint = `http://127.0.0.1:${port}/v1/messages`
  const request = {
    model: 'claude-gpt-luna',
    stream: true,
    messages: [
      { role: 'user', content: 'continue the tool-using task' },
    ],
    tools: [
      {
        name: 'read',
        description: 'Read a file',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      },
      {
        name: 'bash',
        description: 'Run a shell command',
        input_schema: { type: 'object', properties: { command: { type: 'string' } } },
      },
    ],
  }
  const requestOptions = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  }

  try {
    const healthDeadline = Date.now() + 3000
    while (Date.now() < healthDeadline) {
      try {
        const response = await fetchWithTimeout(`http://127.0.0.1:${port}/health`)
        if (response.ok) break
      } catch {}
      await wait(10)
    }

    const first = await fetchWithTimeout(endpoint, requestOptions)
    assert.equal(first.status, 200, stderr)
    assert.match(await first.text(), /message_stop/)
    await waitForMarker(events, 'exit-1')

    let connectionFailures = 0
    let followUp = null
    const followUpDeadline = Date.now() + 3000
    while (Date.now() < followUpDeadline) {
      try {
        followUp = await fetchWithTimeout(endpoint, requestOptions, 150)
        if (followUp.status === 200) break
      } catch {
        connectionFailures += 1
      }
      await wait(20)
    }

    assert.ok(connectionFailures >= 1, 'follow-up never observed the restart connection gap')
    assert.equal(followUp?.status, 200, stderr)
    assert.match(await followUp.text(), /message_stop/)

    const captured = (await readFile(requests, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => JSON.parse(line))
    assert.deepEqual(captured, [
      {
        generation: 1,
        model: 'claude-gpt-luna',
        toolCount: 2,
        toolNames: ['read', 'bash'],
      },
      {
        generation: 2,
        model: 'claude-gpt-luna',
        toolCount: 2,
        toolNames: ['read', 'bash'],
      },
    ])
    assert.deepEqual(
      (await readFile(starts, 'utf8')).trim().split(/\r?\n/).filter(Boolean),
      ['start', 'start'],
    )

    const recoveredHealth = await fetchWithTimeout(`http://127.0.0.1:${port}/health`)
    assert.equal(recoveredHealth.status, 200)
    assert.equal((await recoveredHealth.json()).generation, 2)
  } finally {
    await stopTree(child)
    await rm(temp, { recursive: true, force: true })
  }
})

test('gateway supervisor does not abandon a session after repeated child crashes by default', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'gateway-supervisor-crash-loop-'))
  const childScript = path.join(temp, 'crash-gateway.mjs')
  const counter = path.join(temp, 'starts.txt')
  await writeFile(childScript, `
    import { appendFile } from 'node:fs/promises'
    await appendFile(process.env.TEST_GATEWAY_STARTS, 'start\\n')
    process.exit(1)
  `)

  const child = spawn(process.execPath, [
    supervisor,
    '--gateway',
    childScript,
    '--port',
    '1',
  ], {
    cwd: root,
    env: {
      ...process.env,
      TEST_GATEWAY_STARTS: counter,
      MODEL_GATEWAY_SUPERVISOR_RESTART_BASE_MS: '5',
      MODEL_GATEWAY_SUPERVISOR_RESTART_MAX_MS: '5',
      MODEL_GATEWAY_SUPERVISOR_WINDOW_MS: '1000',
      MODEL_GATEWAY_SUPERVISOR_MAX_RESTARTS: '0',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })

  try {
    await wait(1000)
    assert.equal(child.exitCode, null, stderr)
    const starts = (await readFile(counter, 'utf8')).trim().split(/\r?\n/).filter(Boolean)
    assert.ok(starts.length >= 5, `expected repeated restarts, got ${starts.length}`)
    assert.doesNotMatch(stderr, /restart-limit-exhausted/)
  } finally {
    await stopTree(child)
    await rm(temp, { recursive: true, force: true })
  }
})
