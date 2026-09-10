import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(process.env.GATEWAY_REPO_ROOT || path.join(import.meta.dirname, '..'))
const boundedRunner = 'C:/Users/Ahmed/.claude/skills/verified-execution/scripts/run-bounded.mjs'
const bun = 'C:/Users/Ahmed/.bun/bin/bun.exe'
const expectedSourceHash = '18aabcd7cdf8140df3b2b420956f9f637d354fa853b224e2a300097440684c74'
const selfTestTimeoutMs = 90000
const selfTestHeapMb = 1024
const actualTimeoutMs = 570000
const actualWorkTimeoutMs = 510000
const actualInitTimeoutMs = 45000
const actualHeapMb = 1024
const marker = 'LIVE_COMPACTION_POST_MARKER'
const actualSourceSessionKeys = ['session_id', 'sessionId']
const actualToolUseTypes = new Set(['tool_use', 'tool_use_request'])
const actualPermissionTypes = new Set(['permission_request', 'permission_denied', 'control_request'])
const selfTestMarker = 'LOOPBACK_COMPACTION_SELFTEST_OK'
const maxObservedEvents = 10000
const maxRemainderBytes = 1024 * 1024
const childCloseTimeoutMs = 10000
const taskkillTimeoutMs = 5000
const processSnapshotTimeoutMs = 5000
const processSnapshotMaxBytes = 1024 * 1024
const processWatchIntervalMs = 250

function eventIdentity(value) {
  return value?.uuid || value?.id || value?.message?.id || null
}

function hasForbiddenCapabilityEvent(value) {
  if (actualPermissionTypes.has(value?.subtype) || actualPermissionTypes.has(value?.type)) return true
  if (actualToolUseTypes.has(value?.type)) return true
  return value?.type === 'assistant' && Array.isArray(value.message?.content) && value.message.content.some(block => actualToolUseTypes.has(block?.type))
}

function requestToolCount(request) {
  if (!Object.hasOwn(request?.body ?? {}, 'tools')) return 0
  if (!Array.isArray(request.body.tools)) fail('REQUEST_TOOLS_INVALID')
  return request.body.tools.length
}

function validateZeroCapabilities(init, events, requests = []) {
  if (!Array.isArray(init?.tools) || init.tools.length !== 0) fail('INIT_TOOLS_NONZERO')
  if (!Array.isArray(init?.mcp_servers) || init.mcp_servers.length !== 0) fail('INIT_MCP_NONZERO')
  if (requests.some(request => requestToolCount(request) !== 0)) fail('REQUEST_TOOLS_NONZERO')
  if (events.some(hasForbiddenCapabilityEvent)) fail('UNEXPECTED_TOOL_OR_PERMISSION_EVENT')
}

function isSuccessfulResult(value) {
  return value?.type === 'result' && value?.subtype === 'success' && value?.is_error === false
}

function isExactSuccessfulMarkerResult(value, expected) {
  return isSuccessfulResult(value) && value?.result === expected
}

function isSuccessfulControlResponse(value, requestId) {
  return value?.type === 'control_response' && value?.response?.subtype === 'success' && value?.response?.request_id === requestId
}

function hasOrderedReplayEvents(events, { compactingIndex, clearIndex, initIndex, boundaryIndex, resultIndex }) {
  return [compactingIndex, clearIndex, initIndex, boundaryIndex, resultIndex].every(Number.isInteger)
    && compactingIndex < clearIndex && clearIndex < initIndex && initIndex < boundaryIndex && boundaryIndex < resultIndex
}

function predicateRegressions() {
  if (isExactSuccessfulMarkerResult({ type: 'result', subtype: 'success', is_error: false, result: 'wrong' }, marker)) fail('PREDICATE_WRONG_MARKER_ACCEPTED')
  if (isExactSuccessfulMarkerResult({ type: 'result', subtype: 'error', is_error: true, result: marker }, marker)) fail('PREDICATE_ERROR_RESULT_ACCEPTED')
  if (isSuccessfulControlResponse({ type: 'control_response', response: { subtype: 'error', request_id: 'fixed' } }, 'fixed')) fail('PREDICATE_CONTROL_ERROR_ACCEPTED')
  if (isSuccessfulControlResponse({ type: 'control_response', response: { subtype: 'success', request_id: 'wrong' } }, 'fixed')) fail('PREDICATE_CONTROL_ID_ACCEPTED')
  if (hasOrderedReplayEvents([], { compactingIndex: 1, clearIndex: 0, initIndex: 2, boundaryIndex: 3, resultIndex: 4 })) fail('PREDICATE_EVENT_ORDER_ACCEPTED')
  if (hasOrderedReplayEvents([], { compactingIndex: 0, clearIndex: 1, initIndex: 2, boundaryIndex: 3, resultIndex: 3 })) fail('PREDICATE_EVENT_RESULT_ORDER_ACCEPTED')
  const oldBoundaryId = 'old-boundary'
  const oldBoundary = { type: 'system', subtype: 'compact_boundary', uuid: oldBoundaryId }
  if (!new Set([oldBoundaryId]).has(eventIdentity(oldBoundary))) fail('PREDICATE_OLD_BOUNDARY_SETUP_FAILED')
  let rejectedTool = false
  try { validateZeroCapabilities({ tools: [], mcp_servers: [] }, [{ type: 'assistant', message: { content: [{ type: 'tool_use' }] } }]) } catch (error) { rejectedTool = error?.code === 'UNEXPECTED_TOOL_OR_PERMISSION_EVENT' }
  if (!rejectedTool) fail('PREDICATE_TOOL_EVENT_ACCEPTED')
  return { wrongMarkerRejected: true, errorResultRejected: true, controlErrorRejected: true, controlIdRejected: true, eventOrderRejected: true, oldBoundaryExcluded: true, toolEventRejected: true }
}

function fail(code) {
  const error = new Error(code)
  error.code = code
  throw error
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function safeError(error) {
  const diagnostics = Array.isArray(error?.diagnostics) ? error.diagnostics.filter(code => typeof code === 'string') : []
  return { code: typeof error?.code === 'string' ? error.code : 'SELFTEST_FAILED', diagnostics }
}

function attachDiagnostics(error, diagnostics) {
  error.diagnostics = [...new Set(diagnostics.filter(code => typeof code === 'string'))]
  return error
}

async function cleanupErrorPreservationRegression() {
  const primary = Object.assign(new Error('PRIMARY_TEST'), { code: 'PRIMARY_TEST' })
  let hashRan = false
  const result = await finalizeReplayArtifacts({
    close: async () => { throw new Error('close') },
    hash: async () => { hashRan = true; throw new Error('hash') },
    remove: async () => { throw new Error('remove') },
  })
  const reported = attachDiagnostics(primary, result.diagnostics)
  if (reported !== primary || reported.code !== 'PRIMARY_TEST' || reported.diagnostics.join(',') !== 'CLEANUP_UNCONFIRMED,SOURCE_FINAL_HASH_UNKNOWN') fail('CLEANUP_PRIMARY_PRESERVATION_REGRESSION')
  if (!hashRan) fail('CLEANUP_HASH_SKIPPED_REGRESSION')
  if (result.removeAttempted) fail('CLEANUP_UNCONFIRMED_REMOVAL_REGRESSION')
  return { cleanupPrimaryPreserved: true, cleanupErrorsExercised: 1, cleanupUnconfirmedRetained: true, cleanupHashRan: true }
}

async function finalizeReplayArtifacts({ close, hash, remove }) {
  const diagnostics = []
  let closed = false
  try { closed = await close() } catch { diagnostics.push('CLEANUP_UNCONFIRMED') }
  if (!closed && !diagnostics.includes('CLEANUP_UNCONFIRMED')) diagnostics.push('CLEANUP_UNCONFIRMED')
  try { await hash() } catch { diagnostics.push('SOURCE_FINAL_HASH_UNKNOWN') }
  if (closed) {
    try { await remove() } catch { diagnostics.push('TEMP_CLEANUP_FAILED') }
  }
  return { diagnostics, removeAttempted: closed }
}

function replayStage(stage, startedAt, seen) {
  console.log(JSON.stringify({ stage, elapsedMs: Date.now() - startedAt, eventCount: seen?.events.length || 0, stdoutBytes: seen?.stdoutBytes() || 0, stderrBytes: seen?.stderrBytes() || 0 }))
}

function absolute(value, name) {
  if (!value || !path.isAbsolute(value)) fail(`${name}_NOT_ABSOLUTE`)
  return path.resolve(value)
}

function killTree(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('C:/Windows/System32/taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: taskkillTimeoutMs })
  } else {
    child.kill('SIGTERM')
  }
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return Promise.resolve(true)
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

function taskkillBounded(pid) {
  return new Promise(resolve => {
    const killer = spawn('C:/Windows/System32/taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      killer.kill()
      finish(false)
    }, taskkillTimeoutMs)
    killer.once('error', () => finish(false))
    killer.once('exit', code => finish(code === 0))
  })
}

function processIdentity(record) {
  const pid = Number(record?.ProcessId)
  const parentPid = Number(record?.ParentProcessId)
  const creationDate = typeof record?.CreationDate === 'string' ? record.CreationDate : ''
  return Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(parentPid) && parentPid >= 0 && creationDate
    ? { pid, parentPid, creationDate, key: `${pid}:${creationDate}` }
    : null
}

function boundedProcessSnapshot() {
  if (process.platform !== 'win32') return Promise.reject(Object.assign(new Error('PROCESS_SNAPSHOT_UNSUPPORTED'), { code: 'PROCESS_SNAPSHOT_UNSUPPORTED' }))
  return new Promise((resolve, reject) => {
    const command = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress'
    const probe = spawn('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    let output = ''
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error); else resolve(value)
    }
    const timer = setTimeout(() => { probe.kill(); finish(Object.assign(new Error('PROCESS_SNAPSHOT_TIMEOUT'), { code: 'PROCESS_SNAPSHOT_TIMEOUT' })) }, processSnapshotTimeoutMs)
    probe.stdout.setEncoding('utf8')
    probe.stdout.on('data', chunk => {
      output += chunk
      if (Buffer.byteLength(output) > processSnapshotMaxBytes) { probe.kill(); finish(Object.assign(new Error('PROCESS_SNAPSHOT_LIMIT'), { code: 'PROCESS_SNAPSHOT_LIMIT' })) }
    })
    probe.once('error', () => finish(Object.assign(new Error('PROCESS_SNAPSHOT_FAILED'), { code: 'PROCESS_SNAPSHOT_FAILED' })))
    probe.once('exit', code => {
      if (code !== 0) return finish(Object.assign(new Error('PROCESS_SNAPSHOT_FAILED'), { code: 'PROCESS_SNAPSHOT_FAILED' }))
      try {
        const value = JSON.parse(output)
        const records = (Array.isArray(value) ? value : [value]).map(processIdentity).filter(Boolean)
        finish(null, records)
      } catch { finish(Object.assign(new Error('PROCESS_SNAPSHOT_INVALID'), { code: 'PROCESS_SNAPSHOT_INVALID' })) }
    })
  })
}

function collectOwnedProcesses(known, records) {
  const ownedPids = new Set(records.filter(record => known.has(record.key)).map(record => record.pid))
  const observed = new Map()
  for (const record of records) if (ownedPids.has(record.pid)) observed.set(record.key, record)
  for (;;) {
    let added = false
    for (const record of records) {
      if (ownedPids.has(record.parentPid) && !ownedPids.has(record.pid)) {
        ownedPids.add(record.pid)
        observed.set(record.key, record)
        added = true
      }
    }
    if (!added) return observed
  }
}

function watchOwnedProcesses(rootPid, snapshot = boundedProcessSnapshot) {
  const owned = new Map()
  let rootIdentity = null
  let failed = false
  let stopped = false
  let timer = null
  let running = null
  const capture = async () => {
    try {
      const records = await snapshot()
      if (!rootIdentity) {
        rootIdentity = records.find(record => record.pid === rootPid) || null
        if (!rootIdentity) { failed = true; return }
        owned.set(rootIdentity.key, rootIdentity)
      }
      for (const record of collectOwnedProcesses(owned, records).values()) owned.set(record.key, record)
    } catch { failed = true }
  }
  const schedule = () => {
    if (stopped) return
    running = capture().finally(() => {
      running = null
      if (!stopped) timer = setTimeout(schedule, processWatchIntervalMs)
    })
  }
  schedule()
  return {
    async stop() { stopped = true; if (timer) clearTimeout(timer); if (running) await running },
    state() { return { failed, owned: [...owned.values()] } },
  }
}

async function closeOwnedChild(child, exitPromise, ownership) {
  if (!child || !ownership) return false
  await ownership.stop()
  const { failed, owned } = ownership.state()
  if (failed || owned.length === 0) return false
  const rootExited = child.exitCode !== null || await Promise.race([exitPromise.then(() => true), waitForExit(child, childCloseTimeoutMs)])
  if (!rootExited) {
    if (process.platform === 'win32') await taskkillBounded(child.pid)
    else child.kill('SIGTERM')
    if (!(child.exitCode !== null || await waitForExit(child, childCloseTimeoutMs))) return false
  }
  let current
  try { current = await boundedProcessSnapshot() } catch { return false }
  if (process.platform === 'win32') {
    for (const identity of owned) {
      try { current = await boundedProcessSnapshot() } catch { return false }
      if (current.some(record => record.key === identity.key)) await taskkillBounded(identity.pid)
    }
    try { current = await boundedProcessSnapshot() } catch { return false }
  }
  return !owned.some(identity => current.some(record => record.key === identity.key))
}

async function cleanupOwnershipRegressions() {
  if (process.platform !== 'win32') return { cleanupOwnership: 'skipped' }
  const run = async (script, expectCleanup, { snapshot, requireLiveDescendant = false } = {}) => {
    const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore', windowsHide: true })
    const ownership = watchOwnedProcesses(child.pid, snapshot)
    const exitPromise = new Promise(resolve => child.once('exit', code => resolve(code ?? 1)))
    await waitForExit(child, childCloseTimeoutMs)
    await ownership.stop()
    const captured = ownership.state().owned
    if (requireLiveDescendant && !captured.some(identity => identity.pid !== child.pid)) fail('CLEANUP_ORPHAN_NOT_OBSERVED')
    const closed = await closeOwnedChild(child, exitPromise, ownership)
    if (closed !== expectCleanup) fail('CLEANUP_OWNERSHIP_REGRESSION')
    if (expectCleanup) {
      const current = await boundedProcessSnapshot()
      if (captured.some(identity => current.some(record => record.key === identity.key))) fail('CLEANUP_OWNERSHIP_SURVIVOR')
    }
  }
  await run("const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},500)'],{stdio:'ignore'});setTimeout(()=>{},1000)", true)
  await run("require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'ignore',detached:true}).unref();setTimeout(()=>process.exit(0),6000)", true, { requireLiveDescendant: true })
  await run('setTimeout(()=>{},10)', false, { snapshot: async () => { throw new Error('snapshot') } })
  return { normalRootChildExitConfirmed: true, orphanDetectedAndCleaned: true, snapshotFailureUnconfirmed: true }
}

async function rootExitsFirstDescendantProbe() {
  return cleanupOwnershipRegressions()
}

function observe(child, { rejectCapabilities = false } = {}) {
  const events = []
  let stdoutBytes = 0
  let stderrBytes = 0
  let remainder = ''
  let fatalCode = null
  const waiters = new Set()
  const notify = () => {
    for (const waiter of [...waiters]) waiter()
  }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    stdoutBytes += Buffer.byteLength(chunk)
    remainder += chunk
    if (Buffer.byteLength(remainder) > maxRemainderBytes) {
      fatalCode = 'STDOUT_REMAINDER_LIMIT'
      killTree(child)
      notify()
      return
    }
    const lines = remainder.split(/\r?\n/)
    remainder = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const value = JSON.parse(line)
        if (!value || typeof value !== 'object') continue
        if (events.length >= maxObservedEvents) {
          fatalCode = 'EVENT_LIMIT'
          killTree(child)
          break
        }
        events.push(value)
        if (rejectCapabilities && hasForbiddenCapabilityEvent(value)) {
          fatalCode = 'UNEXPECTED_TOOL_OR_PERMISSION_EVENT'
          killTree(child)
          break
        }
      } catch {
        // Non-protocol output is counted only; never retained or reported.
      }
    }
    notify()
  })
  child.stderr.on('data', chunk => {
    stderrBytes += Buffer.byteLength(chunk)
    notify()
  })
  async function waitFor(predicate, code, deadline, startIndex = 0) {
    for (;;) {
      if (fatalCode) fail(fatalCode)
      const value = events.slice(startIndex).find(predicate)
      if (value) return value
      if (child.exitCode !== null) fail(`${code}_EXIT_${child.exitCode}`)
      if (Date.now() >= deadline) fail(`${code}_TIMEOUT`)
      await new Promise(resolve => {
        const waiter = () => {
          clearTimeout(timer)
          waiters.delete(waiter)
          resolve()
        }
        const timer = setTimeout(waiter, 50)
        waiters.add(waiter)
      })
    }
  }
  return { events, stdoutBytes: () => stdoutBytes, stderrBytes: () => stderrBytes, waitFor, fatalCode: () => fatalCode }
}

function sendMessage(child, value) {
  child.stdin.write(`${JSON.stringify(value)}\n`)
}

function sendPrompt(child, text) {
  sendMessage(child, {
    type: 'user',
    session_id: '',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
  })
}

function sseResponse(response) {
  const message = {
    type: 'message_start',
    message: {
      id: 'msg_loopback_selftest', type: 'message', role: 'assistant', content: [],
      model: 'loopback', stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }
  const events = [
    ['message_start', message],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: selfTestMarker } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ]
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' })
  for (const [event, data] of events) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  response.end()
}

async function loopbackServer() {
  const requests = []
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => {
      if (Buffer.concat(chunks).length < 2 * 1024 * 1024) chunks.push(chunk)
    })
    request.on('end', () => {
      let body = null
      const raw = Buffer.concat(chunks).toString('utf8')
      try { body = JSON.parse(raw) } catch {
        requests.push({ method: request.method, url: request.url, body: null })
        response.writeHead(400)
        response.end()
        return
      }
      requests.push({ method: request.method, url: request.url, body })
      sseResponse(response)
    })
    request.on('error', () => response.destroy())
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return { server, requests, url: `http://127.0.0.1:${address.port}` }
}

async function selfTest() {
  const predicates = { ...predicateRegressions(), ...await cleanupErrorPreservationRegression(), ...await rootExitsFirstDescendantProbe() }
  const candidate = absolute(process.env.GATEWAY_ACCEPTANCE_CANDIDATE, 'GATEWAY_ACCEPTANCE_CANDIDATE')
  const temp = await mkdtemp(path.join(os.tmpdir(), 'gateway-loopback-selftest-'))
  let child
  let fixture
  try {
    const home = path.join(temp, 'home')
    const config = path.join(temp, 'config')
    const settings = path.join(temp, 'settings.json')
    const mcp = path.join(temp, 'mcp.json')
    await writeFile(settings, '{"disableAllHooks":true}\n')
    await writeFile(mcp, '{"mcpServers":{}}\n')
    fixture = await loopbackServer()
    const env = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: temp,
      TMP: temp,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: config,
      ANTHROPIC_API_KEY: 'loopback-only',
      ANTHROPIC_BASE_URL: fixture.url,
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
    }
    child = spawn(process.execPath, [
      boundedRunner, '--timeout-ms', String(selfTestTimeoutMs), '--node-heap-mb', String(selfTestHeapMb), '--cwd', temp,
      '--', bun, candidate,
      '--bare', '--tools=', '--setting-sources=', '--settings', settings,
      '--mcp-config', mcp, '--strict-mcp-config', '--print',
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    ], { cwd: temp, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const seen = observe(child, { rejectCapabilities: true })
    const exitPromise = new Promise(resolve => child.once('exit', code => resolve(code ?? 1)))
    const deadline = Date.now() + selfTestTimeoutMs
    const controlRequestId = 'loopback-compaction-initialize-v1'
    sendMessage(child, { type: 'keep_alive' })
    sendMessage(child, { type: 'control_request', request_id: controlRequestId, request: { subtype: 'initialize' } })
    const control = await seen.waitFor(value => isSuccessfulControlResponse(value, controlRequestId), 'INITIALIZE_CONTROL', deadline)
    const controlIndex = seen.events.indexOf(control)
    sendPrompt(child, `Reply with exactly ${selfTestMarker} and nothing else.`)
    const init = await seen.waitFor(value => value.type === 'system' && value.subtype === 'init', 'INIT', deadline)
    const initIndex = seen.events.indexOf(init)
    const firstResult = await seen.waitFor(value => isExactSuccessfulMarkerResult(value, selfTestMarker), 'FIRST_MARKER', deadline, Math.max(controlIndex, initIndex) + 1)
    const firstResultIndex = seen.events.indexOf(firstResult)
    sendPrompt(child, `Reply with exactly ${selfTestMarker} and nothing else.`)
    const secondResult = await seen.waitFor(value => isExactSuccessfulMarkerResult(value, selfTestMarker), 'SECOND_MARKER', deadline, firstResultIndex + 1)
    const secondResultIndex = seen.events.indexOf(secondResult)

    sendPrompt(child, '/compact Retain the two loopback marker turns in the summary.')
    const compacting = await seen.waitFor(value => value.type === 'system' && value.subtype === 'status' && value.status === 'compacting', 'COMPACTION_START', deadline, secondResultIndex + 1)
    const compactingIndex = seen.events.indexOf(compacting)
    const cleared = await seen.waitFor(value => value.type === 'system' && value.subtype === 'status' && value.status === null, 'COMPACTION_CLEAR', deadline, compactingIndex + 1)
    const clearIndex = seen.events.indexOf(cleared)
    const compactInit = await seen.waitFor(value => value.type === 'system' && value.subtype === 'init', 'COMPACTION_INIT', deadline, clearIndex + 1)
    const compactInitIndex = seen.events.indexOf(compactInit)
    const preCompactBoundaryIds = new Set(seen.events.slice(0, compactingIndex).filter(value => value.type === 'system' && value.subtype === 'compact_boundary').map(eventIdentity).filter(Boolean))
    const boundary = await seen.waitFor(value => value.type === 'system' && value.subtype === 'compact_boundary' && Boolean(eventIdentity(value)) && !preCompactBoundaryIds.has(eventIdentity(value)), 'COMPACTION_BOUNDARY', deadline, compactInitIndex + 1)
    const boundaryIndex = seen.events.indexOf(boundary)
    const compactResult = await seen.waitFor(isSuccessfulResult, 'COMPACTION_RESULT', deadline, boundaryIndex + 1)
    const compactResultIndex = seen.events.indexOf(compactResult)
    if (!hasOrderedReplayEvents(seen.events, { compactingIndex, clearIndex, initIndex: compactInitIndex, boundaryIndex, resultIndex: compactResultIndex })) fail('COMPACTION_EVENT_ORDER_INVALID')

    sendPrompt(child, `Reply with exactly ${selfTestMarker} and nothing else.`)
    const postResult = await seen.waitFor(value => isExactSuccessfulMarkerResult(value, selfTestMarker), 'POST_MARKER', deadline, compactResultIndex + 1)
    const postResultIndex = seen.events.indexOf(postResult)
    child.stdin.end()
    const exitCode = await exitPromise
    const messageRequests = fixture.requests.filter(value => value.method === 'POST' && /\/v1\/messages\/?$/.test(new URL(value.url, fixture.url).pathname))
    if (messageRequests.length !== 4) fail('LOOPBACK_MESSAGE_REQUEST_COUNT')
    validateZeroCapabilities(init, seen.events, messageRequests)
    validateZeroCapabilities(compactInit, seen.events, messageRequests)
    const requestShapes = fixture.requests.map(value => ({ method: value.method, messageRequest: /\/v1\/messages\/?$/.test(new URL(value.url, fixture.url).pathname), hasBody: value.body !== null, toolsPresent: Object.hasOwn(value.body ?? {}, 'tools'), toolCount: Object.hasOwn(value.body ?? {}, 'tools') ? requestToolCount(value) : null }))
    const observed = { initTools: init.tools.length, mcpServers: init.mcp_servers.length, messageRequests: messageRequests.length, compactingIndex, clearIndex, compactInitIndex, boundaryIndex, compactResultIndex, postResultIndex, exitCode }
    console.log(JSON.stringify({ result: exitCode === 0 ? 'pass' : 'fail', mode: 'self-test', observed, predicates, requestShapes, requests: fixture.requests.length }))
    if (exitCode !== 0) fail('LOOPBACK_EXIT_NONZERO')
  } finally {
    killTree(child)
    if (fixture) await new Promise(resolve => fixture.server.close(resolve))
    await rm(temp, { recursive: true, force: true })
  }
}

function managedPolicyPreflight() {
  const probe = `import { getSettingsForSource } from ${JSON.stringify(path.join(root, 'src', 'utils', 'settings', 'settings.ts'))}; const s=await getSettingsForSource('policySettings'); const hooks=Array.isArray(s?.hooks)?s.hooks.length:Object.keys(s?.hooks??{}).length; const mcp=Object.keys(s?.mcpServers??{}).length; const statusLine=s?.statusLine?1:0; console.log(JSON.stringify({hooks,mcp,statusLine}));`
  const check = spawnSync(process.execPath, [boundedRunner, '--timeout-ms', '30000', '--node-heap-mb', '512', '--cwd', root, '--', bun, '--eval', probe], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  })
  if (check.status !== 0) fail('MANAGED_POLICY_PREFLIGHT_UNKNOWN')
  let result
  try { result = JSON.parse(String(check.stdout || '').trim().split(/\r?\n/).at(-1)) } catch { fail('MANAGED_POLICY_PREFLIGHT_UNKNOWN') }
  if (result?.hooks !== 0 || result?.mcp !== 0 || result?.statusLine !== 0) fail('MANAGED_POLICY_PREFLIGHT_NONZERO')
  return result
}

async function launcherPrerequisitesPreflight() {
  const realUserProfile = absolute(process.env.USERPROFILE, 'USERPROFILE')
  const keysafePath = path.join(realUserProfile, '.claude', 'skills', 'keysafe', 'scripts', 'keysafe.ps1')
  let keysafePathExists = true
  try { await access(keysafePath) } catch { keysafePathExists = false }
  if (!keysafePathExists) fail('KEYSAFE_PATH_MISSING')
  const codexHome = process.env.TANDEM_GATEWAY_CODEX_HOME || path.join(realUserProfile, '.codex')
  let codexHomeExists = true
  try { await access(codexHome) } catch { codexHomeExists = false }
  if (!codexHomeExists) fail('CODEX_HOME_MISSING')
  return { keysafePathExists, codexHomeExists }
}

async function actualReplay() {
  managedPolicyPreflight()
  const realUserProfile = absolute(process.env.USERPROFILE, 'USERPROFILE')
  const keysafePath = path.join(realUserProfile, '.claude', 'skills', 'keysafe', 'scripts', 'keysafe.ps1')
  try { await access(keysafePath) } catch { fail('KEYSAFE_PATH_MISSING') }
  const source = absolute(process.env.LIVE_COMPACTION_SOURCE, 'LIVE_COMPACTION_SOURCE')
  const candidate = absolute(process.env.GATEWAY_ACCEPTANCE_CANDIDATE, 'GATEWAY_ACCEPTANCE_CANDIDATE')
  const sourceBytes = await readFile(source)
  const sourceHash = sha256(sourceBytes)
  if (sourceHash !== expectedSourceHash) fail('SOURCE_HASH_MISMATCH')
  const candidateHash = sha256(await readFile(candidate))
  const temp = await mkdtemp(path.join(os.tmpdir(), 'gateway-compaction-replay-'))
  let child
  let ownership = null
  let exitPromise = Promise.resolve(0)
  let finalHash = null
  let completed = null
  let primaryError = null
  const diagnostics = []
  try {
    const copied = path.join(temp, 'transcript.jsonl')
    const settings = path.join(temp, 'settings.json')
    const mcp = path.join(temp, 'mcp.json')
    const home = path.join(temp, 'home')
    const config = path.join(temp, 'config')
    await writeFile(copied, sourceBytes)
    const copyHash = sha256(await readFile(copied))
    if (copyHash !== sourceHash) fail('COPY_HASH_MISMATCH')
    await writeFile(settings, '{"disableAllHooks":true}\n')
    await writeFile(mcp, '{"mcpServers":{}}\n')
    const sourceIds = new Set()
    const baselineBoundaryIds = new Set()
    for (const line of sourceBytes.toString('utf8').split(/\r?\n/)) {
      try {
        const record = JSON.parse(line)
        for (const key of actualSourceSessionKeys) if (record?.[key]) sourceIds.add(record[key])
        if (record?.type === 'system' && record?.subtype === 'compact_boundary') {
          const id = eventIdentity(record)
          if (id) baselineBoundaryIds.add(id)
        }
      } catch {}
    }
    const childEnv = {
      ...process.env,
      CC_CLAUDE_SCRIPT_OVERRIDE: candidate,
      HOME: home,
      USERPROFILE: realUserProfile,
      CLAUDE_CONFIG_DIR: config,
      TEMP: temp,
      TMP: temp,
      MODEL_GATEWAY_DEFAULT: 'gateway-gpt-sol',
      MODEL_GATEWAY_EFFORT: 'medium',
    }
    delete childEnv.CC_RAW_ARGS
    child = spawn(process.execPath, [
      boundedRunner, '--timeout-ms', String(actualTimeoutMs), '--node-heap-mb', String(actualHeapMb), '--cwd', temp,
      '--', 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', '-File', path.join(root, 'scripts', 'cc.ps1'),
      '--bare', '--tools=', '--setting-sources=', '--settings', settings, '--strict-mcp-config', '--mcp-config', mcp,
      '--resume', copied, '--fork-session', '--verbose', '--model', 'gateway-gpt-sol', '--effort', 'medium',
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--print',
    ], { cwd: temp, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    exitPromise = new Promise(resolve => child.once('exit', code => resolve(code ?? 1)))
    ownership = watchOwnedProcesses(child.pid)
    const seen = observe(child, { rejectCapabilities: true })
    const startedAt = Date.now()
    const deadline = startedAt + actualWorkTimeoutMs
    replayStage('spawn', startedAt, seen)
    const controlRequestId = 'live-compaction-initialize-v1'
    sendMessage(child, { type: 'keep_alive' })
    sendMessage(child, { type: 'control_request', request_id: controlRequestId, request: { subtype: 'initialize' } })
    const control = await seen.waitFor(value => isSuccessfulControlResponse(value, controlRequestId), 'INITIALIZE_CONTROL', Math.min(deadline, startedAt + actualInitTimeoutMs))
    const controlIndex = seen.events.indexOf(control)
    replayStage('init', startedAt, seen)
    sendPrompt(child, '/compact')
    replayStage('promptSent', startedAt, seen)
    const compacting = await seen.waitFor(value => value.type === 'system' && value.subtype === 'status' && value.status === 'compacting', 'COMPACTION_START', deadline, controlIndex + 1)
    replayStage('compacting', startedAt, seen)
    const compactingIndex = seen.events.indexOf(compacting)
    const cleared = await seen.waitFor(value => value.type === 'system' && value.subtype === 'status' && value.status === null, 'COMPACTION_CLEAR', deadline, compactingIndex + 1)
    replayStage('clear', startedAt, seen)
    const clearIndex = seen.events.indexOf(cleared)
    const init = await seen.waitFor(value => value.type === 'system' && value.subtype === 'init', 'COMPACTION_INIT', deadline, clearIndex + 1)
    replayStage('init', startedAt, seen)
    const initIndex = seen.events.indexOf(init)
    validateZeroCapabilities(init, seen.events)
    const newSession = actualSourceSessionKeys.map(key => init[key]).find(Boolean)
    if (!newSession || sourceIds.has(newSession)) fail('FORK_SESSION_NOT_DISTINCT')
    const boundary = await seen.waitFor(value => {
      if (value.type !== 'system' || value.subtype !== 'compact_boundary') return false
      const id = eventIdentity(value)
      return Boolean(id) && !baselineBoundaryIds.has(id)
    }, 'COMPACTION_BOUNDARY', deadline, initIndex + 1)
    replayStage('boundary', startedAt, seen)
    const boundaryIndex = seen.events.indexOf(boundary)
    const compactResult = await seen.waitFor(isSuccessfulResult, 'COMPACTION_RESULT', deadline, boundaryIndex + 1)
    const compactResultIndex = seen.events.indexOf(compactResult)
    if (!hasOrderedReplayEvents(seen.events, { compactingIndex, clearIndex, initIndex, boundaryIndex, resultIndex: compactResultIndex })) fail('COMPACTION_EVENT_ORDER_INVALID')
    sendPrompt(child, `Reply with exactly ${marker} and nothing else.`)
    await seen.waitFor(value => isExactSuccessfulMarkerResult(value, marker), 'POST_MARKER', deadline, compactResultIndex + 1)
    replayStage('marker', startedAt, seen)
    validateZeroCapabilities(init, seen.events)
    child.stdin.end()
    const exitCode = await exitPromise
    replayStage('exit', startedAt, seen)
    if (exitCode !== 0) fail('REPLAY_EXIT_NONZERO')
    completed = { sourceHash, copyHash, candidateHash, keysafePathExists: true, compactBoundaries: 1, markerSeen: true, toolUses: 0, eventCount: seen.events.length, exitCode }
  } catch (error) {
    primaryError = error
  } finally {
    const finalized = await finalizeReplayArtifacts({
      close: () => closeOwnedChild(child, exitPromise, ownership),
      hash: async () => {
        finalHash = sha256(await readFile(source))
        if (finalHash !== sourceHash) throw Object.assign(new Error('SOURCE_CHANGED'), { code: 'SOURCE_CHANGED' })
      },
      remove: () => rm(temp, { recursive: true, force: true }),
    })
    diagnostics.push(...finalized.diagnostics)
    if (finalHash && finalHash !== sourceHash && !diagnostics.includes('SOURCE_CHANGED')) diagnostics.push('SOURCE_CHANGED')
  }
  if (primaryError) throw attachDiagnostics(primaryError, diagnostics)
  if (diagnostics.length) throw attachDiagnostics(Object.assign(new Error(diagnostics[0]), { code: diagnostics[0] }), diagnostics)
  console.log(JSON.stringify({ result: 'pass', mode: 'run', ...completed, originalHashFinally: finalHash }))
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--run') && !args.includes('--authorize-copy-replay')) {
    console.log(JSON.stringify({ result: 'refused', mode: 'run', code: 'COPY_REPLAY_AUTHORIZATION_REQUIRED' }))
    process.exitCode = 2
    return
  }
  if (args.includes('--run')) return actualReplay()
  if (args.includes('--preflight')) {
    const policy = managedPolicyPreflight()
    const launcher = await launcherPrerequisitesPreflight()
    console.log(JSON.stringify({ result: 'pass', mode: 'preflight', observed: { ...policy, ...launcher } }))
    return
  }
  if (!args.includes('--self-test')) fail('SELFTEST_REQUIRED')
  await selfTest()
}

main().catch(error => {
  console.log(JSON.stringify({ result: 'fail', error: safeError(error) }))
  process.exitCode = 1
})
