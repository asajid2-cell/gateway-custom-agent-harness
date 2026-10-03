import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { LeafProcess } from '../src/utils/leafProcess.ts'
import { GatewaySessionTransport, listGatewayPeers } from '../src/utils/gatewaySessionTransport.ts'

/**
 * Phase D: the ledger and the sweep against *real* harness sessions.
 *
 * The unit suites drive GatewaySessionTransport directly, which proves the wire
 * but not the thing a coordinator actually asks: start some real chats, then
 * look up who owns what and who is live through the same modules `/zenith-ledger`
 * calls. This runs real `cc` children on `gateway-gpt-luna` at effort high, so
 * the sweep meets genuine registrations, genuine liveness and a genuine build id
 * - the one field `bun test` can never supply (`MACRO.BUILD_TIME` is undefined
 * there, which is B4's recorded limitation).
 *
 * Usage: bun run scripts/zenith-live.ts --run
 */
if (!process.argv.includes('--run')) throw new Error('Refusing to run without --run')
const candidate = resolve(process.env.GATEWAY_ACCEPTANCE_CANDIDATE ?? 'dist/cli.js')
await access(candidate)

const directory = await mkdtemp(join(tmpdir(), 'zenith-live-'))
const launcher = fileURLToPath(new URL('./cc.ps1', import.meta.url))
const gatewaySessions = join(directory, 'gateway-sessions')
const env = {
  ...process.env,
  CLAUDE_CONFIG_DIR: directory,
  CC_RAW_ARGS: undefined,
  CC_CLAUDE_SCRIPT_OVERRIDE: candidate,
  MODEL_GATEWAY_DEFAULT: 'gateway-gpt-luna',
  MODEL_GATEWAY_EFFORT: 'high',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  // Peer comms are started only when this is set, and a session launched
  // without it never registers - so the sweep would be asked about a bus the
  // chats are simply not on, and read that as "nobody is live".
  CLAUDE_CODE_USE_GATEWAY: '1',
  DEBUG: '1',
  CLAUDE_CODE_DEBUG_LOGS_DIR: join(directory, 'debug'),
}
type Chat = { process: LeafProcess; events: Record<string, any>[]; id: string }
const chats: Chat[] = []
let asker: GatewaySessionTransport | undefined
const savedConfig = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = directory

async function waitFor(check: () => boolean, label: string, timeout = 120000) {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

function spawn(agentArgs: string[], events: Record<string, any>[]) {
  const process = new LeafProcess({
    executable: 'powershell.exe',
    args: ['-NoProfile', '-File', launcher, '--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--model', 'gateway-gpt-luna', ...agentArgs],
    cwd: directory,
    env,
    onState: () => {},
    onEvent: event => events.push(event),
  })
  return { process, events }
}

const ledger = await import('../src/utils/zenithLedger.ts')
const role = await import('../src/utils/zenithRole.ts')
const results: Record<string, unknown>[] = []
const record = (check: string, passed: boolean, detail?: unknown) => {
  results.push({ check, passed, ...(detail === undefined ? {} : { detail }) })
  console.log(JSON.stringify({ check, passed, ...(detail === undefined ? {} : { detail }) }))
  return passed
}

async function main(): Promise<void> {
  await role.claimZenith({ purpose: 'Phase D live acceptance', force: false })

  // The sweep is a question one session asks another, and the asker has to be
  // a session: `broadcastIdentify` reads the asker's own registration for the
  // token it proves itself with, and without one it makes no calls at all -
  // a truthful "none asked" rather than a sweep that found nobody. This script
  // is the coordinator, so it registers as a peer for the length of the run.
  const askerId = randomUUID()
  asker = new GatewaySessionTransport({
    directory: gatewaySessions,
    sessionId: askerId,
    cwd: directory,
    name: 'zenith-live coordinator',
    purpose: 'Phase D live acceptance',
  })
  await asker.start()

  // Three real chats: two siblings that will share a family, and one stranger.
  //
  // Each is kept mid-turn rather than left to finish: a print-mode turn that
  // completes runs its cleanup and deregisters, so a chat awaited to its result
  // is off the bus by the time the next line runs. The turn is held open with a
  // prompt that asks for the ready marker and a wait the child has no reason to
  // end - its registration lives exactly as long as the turn does, which is the
  // condition this whole check is about.
  for (let i = 0; i < 3; i++) {
    const events: Record<string, any>[] = []
    const chat = spawn(['--max-turns', '4'], events) as Chat
    chats.push(chat)
    await chat.process.start()
    chat.process.send(`You are live acceptance chat ${i}. Reply exactly ZENITH_READY_${i}. Never use tools.`)
    await waitFor(() => events.some(event => event.type === 'result'), `ready ${i}`)
    const result = events.find(event => event.type === 'result')
    assert.equal(result?.subtype, 'success')
    chat.id = result.session_id as string
    // Keep this chat's registration alive for the assertions below: a resumed
    // turn re-registers, and the session stays the same identity.
    chat.process.send(`Another turn, chat ${i}. Reply exactly ZENITH_STILL_${i}. Never use tools.`)
  }

  // (1) A registration is a real discussion: the peer file must exist and the
  // peer must be listed as live, so the sweep is asked about a bus that is
  // actually populated rather than about an empty directory.
  const live = (await listGatewayPeers(gatewaySessions)).filter(peer => peer.sessionId !== askerId)
  record('three real chats register on the live bus', live.length === 3, { live: live.map(peer => peer.sessionId) })

  // The sweep records what answered. Every chat is mid-turn, so all three answer.
  const swept = await ledger.sweepSessions({ asker: { sessionId: askerId } })
  record('the sweep asks the live bus and records the sessions that answered', swept.recorded === 3 && swept.answered === 3, swept)

  // (2) Every live session is placed in a family with a dated history; an
  // unqueried session is UNKNOWN, not assumed idle.
  const histories = []
  for (const chat of chats) histories.push(await ledger.sessionHistory(chat.id))
  record('every live session has a dated family history', histories.every(h => h.state === 'known' && !!h.familyRootSessionId && h.observations.length >= 1), histories.map(h => ({ state: h.state, family: h.state === 'known' ? h.familyRootSessionId : undefined, seen: h.state === 'known' ? h.lastSeen : undefined })))

  const unqueried = await ledger.sessionHistory('11111111-1111-4111-8111-111111111111')
  record('a session the ledger never observed is UNKNOWN, not idle', unqueried.state === 'unknown', unqueried)

  const names = (await ledger.knownSessions()).filter(row => chats.some(chat => chat.id === row.sessionId))
  record('the observed sessions carry a real build id, which the harness cannot synthesize', names.length === 3 && names.every(row => !!row.buildId), names.map(row => ({ id: row.sessionId, buildId: row.buildId })))

  // (3) A workKey resolves to exactly one owner and family from the file.
  const taken = await ledger.assign('phase-d.live', { familyRootSessionId: await ledger.familyRootFor(chats[0]!.id!), summary: 'live acceptance' })
  assert.equal(taken.ok, true)
  const owner = await ledger.ownerOf('phase-d.live')
  record('a workKey resolves to one owning session and family', owner.state === 'owned' && owner.sessionId !== undefined, owner)

  // A second session cannot take it: a live holder is not displaced, and the
  // refusal names why rather than quietly overwriting.
  const contested = await ledger.assign('phase-d.live', { familyRootSessionId: await ledger.familyRootFor(chats[1]!.id) })
  const contestedHeld = contested.ok === false && contested.reason === 'held'
  record('a second claimant is refused rather than silently displacing the owner', contestedHeld, contested)

  // (4) The current assignments are a fold over the file, and the row that was
  // just written is the one that comes back - not a task list, and not a guess.
  const rows = await ledger.currentAssignments()
  const mineRow = rows.find(row => row.workKey === 'phase-d.live')
  record('the assignment fold returns the row that was just written', !!mineRow && mineRow.state !== 'unowned', mineRow)

  // The P7 gate on a real caller: this process holds Zenith because it claimed
  // it above, so a release it owns must succeed and a key it never held must not.
  const released = await ledger.release('phase-d.live', { reason: 'acceptance complete' })
  record('the Zenith holder releases the key it assigned', released === true, released)

  const foreign = await ledger.release('phase-d.never-taken')
  record('a release of a key nobody holds is refused', foreign === false, foreign)

  // The stranger leaves: its session must read as gone while the survivors stay
  // known, and the departed one's key reads ORPHANED rather than owned. The
  // process is killed outright rather than closed cleanly, because the case
  // ORPHANED exists for is an owner whose process is gone - and a clean close
  // deregisters, which is the *other* answer, not this one.
  const departed = chats[2]!
  const departedPid = JSON.parse(await readFile(join(gatewaySessions, `${departed.id}.json`), 'utf8')).peer.pid as number
  await new Promise<void>(resolve => execFile('taskkill.exe', ['/PID', String(departedPid), '/T', '/F'], { windowsHide: true }, () => resolve()))
  let gone = await listGatewayPeers(gatewaySessions)
  for (let attempt = 0; attempt < 60 && gone.some(peer => peer.sessionId === departed.id); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 500))
    gone = await listGatewayPeers(gatewaySessions)
  }
  const survivorsLive = gone.filter(peer => peer.sessionId !== askerId)
  record('a killed chat leaves the live bus', survivorsLive.length === 2 && !gone.some(peer => peer.sessionId === departed.id), { live: gone.map(peer => peer.sessionId) })

  // A key held by the session that just went away. The row is written in that
  // session's name so the fold has a real departed owner to resolve liveness
  // for - which is the case ORPHANED exists to distinguish from "unowned".
  await ledger.assign('phase-d.stranded', { sessionId: departed.id, zenith: false, familyRootSessionId: await ledger.familyRootFor(chats[0]!.id) })
  const orphanState = await ledger.ownerOf('phase-d.stranded')
  record('an owner whose process is gone reads as orphaned, not as absent and not as success', orphanState.state === 'orphaned', orphanState)

  const survivors = []
  for (const chat of chats.slice(0, 2)) survivors.push(await ledger.sessionHistory(chat.id))
  record('the survivors keep their known identity after the departure', survivors.every(h => h.state === 'known'), survivors.map(h => h.state))
}

try {
  await main()
} catch (error) {
  record('the live acceptance run completed without throwing', false, { error: error instanceof Error ? error.message : String(error) })
} finally {
  await Promise.all(chats.map(chat => chat.process.close()))
  await asker?.close().catch(() => {})
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfig
  const failed = results.filter(row => row.passed !== true)
  console.log(`ZENITH_LIVE=${failed.length === 0 ? 'PASS' : 'FAIL'} checks=${results.length} failed=${failed.length}`)
  console.log(`EVIDENCE_DIRECTORY=${directory}`)
  if (process.env.ZENITH_LIVE_KEEP !== '1') await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
  if (failed.length > 0) process.exitCode = 1
}
