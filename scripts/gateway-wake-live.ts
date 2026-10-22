/**
 * Live proof that a timer wake revives an IDLE session.
 *
 * Boots a real gateway session through the launcher, lets it answer one turn
 * and go idle, then sets a one-shot timer with the detached CLI. Nothing is
 * sent to the session's inbox and nothing is typed at it: the only thing that
 * happens is the timer firing, and the proof is a second turn appearing in its
 * stream-json output and in its transcript.
 *
 * Usage:
 *   GATEWAY_ACCEPTANCE_CANDIDATE=<path-to-cli.js> bun run scripts/gateway-wake-live.ts --run
 */
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { LeafProcess } from '../src/utils/leafProcess.ts'

const candidate = process.env.GATEWAY_ACCEPTANCE_CANDIDATE
if (!candidate) throw new Error('GATEWAY_ACCEPTANCE_CANDIDATE is required')
if (!process.argv.includes('--run')) throw new Error('Refusing to run without --run')

const directory = await mkdtemp(join(tmpdir(), 'gateway-wake-live-'))
const launcher = fileURLToPath(new URL('./cc.ps1', import.meta.url))
const wakeScript = fileURLToPath(new URL('./gateway-wake.mjs', import.meta.url))
// Any model the local gateway can reach works; the free Zen route is the
// cheapest one that answers reliably when a subscription token has expired.
const model = process.env.GATEWAY_WAKE_LIVE_MODEL || 'gateway-opencode-mimo-v2.6-flash-free'
const env = {
  ...process.env,
  CLAUDE_CONFIG_DIR: directory,
  CC_RAW_ARGS: undefined,
  CC_CLAUDE_SCRIPT_OVERRIDE: candidate,
  MODEL_GATEWAY_DEFAULT: model,
  // Not every gateway model takes an effort tier, and the launcher refuses a
  // tier the model cannot apply rather than silently dropping it.
  MODEL_GATEWAY_EFFORT: undefined,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
}

function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 90_000, label = 'boundary'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return (async () => {
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  })()
}

async function registrationStatus(sessionId: string): Promise<string | undefined> {
  try {
    return JSON.parse(await readFile(join(directory, 'gateway-sessions', `${sessionId}.json`), 'utf8'))?.peer?.status
  } catch { return undefined }
}

/** The session's transcript, found under the scratch config home it wrote to. */
async function findTranscript(sessionId: string): Promise<string> {
  const entries = await readdir(join(directory, 'projects'), { recursive: true })
  const match = entries.find(entry => String(entry).endsWith(`${sessionId}.jsonl`))
  if (!match) throw new Error(`no transcript for ${sessionId} under ${join(directory, 'projects')}`)
  return join(directory, 'projects', String(match))
}

/** Run the detached CLI the way a driver would, and return its receipt line. */
function runWake(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wakeScript, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }))
  })
}

const events: Record<string, any>[] = []
const session = new LeafProcess({
  executable: 'powershell.exe',
  args: ['-NoProfile', '-File', launcher, '--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', model, '--max-turns', '6'],
  cwd: directory,
  env,
  onState: () => {},
  onEvent: event => events.push(event),
})

try {
  await session.start()
  session.send('You are the live wake-proof session. Answer the first message with exactly WAKE_READY and never use tools. If you later receive a message that begins with [heartbeat], answer it with exactly HEARTBEAT_TURN_STARTED and never use tools.')
  await waitFor(() => events.some(event => event.type === 'result'), 120_000, 'the first turn')
  const sessionId = events.find(event => event.type === 'result')!.session_id as string
  assert.ok(sessionId, 'the first turn must name the session')
  const firstResult = events.filter(event => event.type === 'result').length
  console.log(`SESSION_ID=${sessionId}`)
  console.log(`FIRST_TURN_RESULTS=${firstResult}`)

  // Idle is the precondition: the whole point is waking a session whose turn
  // has already ended, not steering one that is still running.
  await waitFor(async () => await registrationStatus(sessionId) === 'idle', 60_000, 'the session to go idle')
  console.log('SESSION_STATUS=idle')
  const beforeWake = events.length

  const token = `live-proof-${Date.now()}`
  const receipt = await runWake(['--session', sessionId, '--after', '5s', '--label', 'live-proof', '--token', token])
  assert.equal(receipt.code, 0, `gateway-wake failed: ${receipt.stderr}`)
  console.log(`WAKE_RECEIPT=${receipt.stdout}`)

  // Nothing is sent to the session. The only cause of a second turn is the
  // timer, which is what makes this proof non-vacuous.
  await waitFor(() => events.slice(beforeWake).some(event => event.type === 'result'), 60_000, 'the timer turn')
  const wakeTurn = events.slice(beforeWake)
  const wakeResult = wakeTurn.find(event => event.type === 'result')
  assert.equal(wakeResult?.subtype, 'success')
  const answer = JSON.stringify(wakeTurn)
  assert.ok(answer.includes('HEARTBEAT_TURN_STARTED'), 'the model must answer the injected wake, proving a turn started')
  console.log(`WAKE_TURN_STARTED_AT=${new Date().toISOString()}`)
  console.log(`WAKE_TURN_EVENTS=${wakeTurn.length}`)

  const transcript = await readFile(await findTranscript(sessionId), 'utf8')
  const heartbeatLine = transcript.split('\n').find(line => line.includes('[heartbeat] The timer you set (label=live-proof, once)'))
  assert.ok(heartbeatLine, 'the synthetic wake must be in the transcript')
  // No inbox file at all is the strongest form of the same fact: nothing was
  // ever delivered to this session, so the second turn can only have come from
  // the timer.
  let inboxRecords = 0
  try { inboxRecords = JSON.parse(await readFile(join(directory, 'gateway-sessions', `${sessionId}.inbox`), 'utf8')).records.length }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  assert.equal(inboxRecords, 0, 'the wake must not arrive as a peer message')
  console.log('TRANSCRIPT_HEARTBEAT=FOUND')
  console.log('INBOX_RECORDS=0')
  console.log('REAL_TIMER_WAKE=PASS')
} finally {
  await session.close()
  console.log(`EVIDENCE_DIRECTORY=${directory}`)
}
