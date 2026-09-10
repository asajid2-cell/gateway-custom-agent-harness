import { createServer } from 'node:http'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { strict as assert } from 'node:assert'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { LeafProcess } from '../src/utils/leafProcess.ts'

const base = process.argv[2] === 'base'
const root = await mkdtemp(join(tmpdir(), 'gateway-memory-'))
let requestCount = 0
let requestBytes = 0
const server = createServer(async (req, res) => {
  for await (const chunk of req) requestBytes += Buffer.byteLength(chunk)
  requestCount++
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const events = [
    { type: 'message_start', message: { id: `msg_${requestCount}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...Array.from({ length: 20 }, () => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Synthetic memory fixture response. '.repeat(30) } })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5000 } },
    { type: 'message_stop' },
  ]
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  res.end()
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
let finish: (() => void) | undefined
let fail: ((error: Error) => void) | undefined
const common = ['--print', '--verbose', '--model', 'claude-sonnet-4-6', '--input-format', 'stream-json', '--output-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--tools', '']
const child = new LeafProcess({
  executable: base ? 'C:/Users/Ahmed/.local/bin/claude.exe' : process.execPath,
  args: base ? common : [resolve(import.meta.dir, '..', process.env.MEMORY_CLI_PATH ?? '.candidate-build/memory/cli.js'), ...common],
  cwd: root,
  env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, USERPROFILE: root, TEMP: root, TMP: root, CLAUDE_CONFIG_DIR: root, ANTHROPIC_API_KEY: 'local-fixture-only', ANTHROPIC_BASE_URL: url, CLAUDE_CODE_GATEWAY_BASE_URL: url, ...(base ? {} : { CLAUDE_CODE_USE_GATEWAY: '1', ...(process.env.MEMORY_TELEMETRY === '1' ? { GATEWAY_MEMORY_TELEMETRY_DIR: join(root, 'memory') } : {}) }), DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', NODE_ENV: process.env.MEMORY_NODE_ENV ?? 'production' },
  onEvent: event => { if (event.type === 'result') { if (event.is_error) fail?.(new Error('Fixture turn returned error')); else finish?.() } },
  onState: state => { if (state === 'failed') fail?.(new Error('Fixture child failed')) },
})
const sample = async (turn: number) => {
  const pid = (child as unknown as { child: { pid: number } }).child.pid
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p=Get-Process -Id ${pid}; [pscustomobject]@{privateBytes=$p.PrivateMemorySize64;workingSet=$p.WorkingSet64;cpu=$p.CPU;handles=$p.HandleCount} | ConvertTo-Json -Compress`], { timeout: 10000, maxBuffer: 4096 })
  console.log(JSON.stringify({ kind: base ? 'base' : 'gateway', turn, pid, requestCount, requestBytes, ...JSON.parse(stdout) }))
}
try {
  await child.start()
  await sample(0)
  for (let turn = 1; turn <= Number(process.env.MEMORY_API_TURNS ?? 20); turn++) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture turn timeout')), 15000)
      finish = () => { clearTimeout(timer); resolve() }
      fail = error => { clearTimeout(timer); reject(error) }
      child.send(`Synthetic fixture turn ${turn}. Respond with the fixture text.`)
    })
    if (turn % 5 === 0) await sample(turn)
  }
  await child.close()
  if (!base && process.env.MEMORY_TELEMETRY === '1') {
    const files = await readdir(join(root, 'memory'))
    assert.equal(files.length, 1)
    const text = await readFile(join(root, 'memory', files[0]!), 'utf8')
    assert.equal(text.includes('Synthetic'), false)
    assert.equal(text.includes('local-fixture-only'), false)
    const records = text.trim().split('\n').map(line => JSON.parse(line))
    assert.equal(records[0].reason, 'startup')
    assert.equal(records.at(-1).reason, 'shutdown')
    console.log(JSON.stringify({ observedActivity: records.at(-1).activity }))
    assert.ok(records.at(-1).activity.queryEntries > 0)
    assert.ok(records.at(-1).activity.apiStarts > 0)
    console.log(JSON.stringify({ telemetryVerified: true, samples: records.length, activity: records.at(-1).activity, heap: records.at(-1).heap, privateBytes: records.at(-1).privateBytes }))
  } else if (!base) {
    assert.equal((await readdir(root)).includes('memory'), false)
  }
} finally {
  await child.close()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
