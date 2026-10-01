import { test, expect, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchPartner, partnerStartupTimeoutMs, prewarm, prewarmTimeoutMs, maxPartnersPerLeaf, partnerCount } from '../src/utils/partnerLeaf.js'

/**
 * These exercise the launch path against a stub launcher, not the real gateway.
 *
 * That is deliberate and it is the whole point of the seam: the partner launcher
 * takes its script path from `GATEWAY_CC_SCRIPT`, so what is tested here is the
 * behaviour that is easy to get wrong and expensive to discover later - that a
 * warm build which overruns its budget refuses the launch instead of racing it,
 * that the admission cap refuses rather than multiplies, and that framing and
 * ownership reach the spawned process. None of it needs a built harness or a live
 * provider, so it runs on every change rather than only on a machine that can
 * afford a cold build.
 */

const isWindows = process.platform === 'win32'
const cleanups: (() => void)[] = []

/**
 * A launcher stub with the policy file both budgets live in.
 *
 * The startup budget defaults to what an install actually ships and is overridden
 * only by the tests that are about the deadline, so the ordinary tests exercise
 * the shipped numbers rather than a second set invented here.
 */
function stubLauncher(
  body: string,
  policy: { prewarmTimeoutMs?: number; partnerStartupTimeoutMs?: number } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), 'partner-leaf-'))
  const script = join(dir, 'cc.ps1')
  writeFileSync(script, body, 'utf8')
  writeFileSync(
    join(dir, 'launcher-policy.json'),
    JSON.stringify({ prewarmTimeoutMs: 180_000, partnerStartupTimeoutMs: 60_000, ...policy }),
    'utf8',
  )
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const previous = process.env.GATEWAY_CC_SCRIPT
  process.env.GATEWAY_CC_SCRIPT = script
  cleanups.push(() => { previous === undefined ? delete process.env.GATEWAY_CC_SCRIPT : process.env.GATEWAY_CC_SCRIPT = previous })
  return dir
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  delete process.env.GATEWAY_PARTNER_LIMIT
  delete process.env.PARTNER_ENV_DUMP
  delete process.env.PARTNER_LAUNCHED
  delete process.env.PARTNER_PID_FILE
  delete process.env.PARTNER_FRAME_DUMP
})

/** Whether a process this test started is still running. */
function isRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

// A launcher that warms instantly, then behaves like a print-mode session: it
// reads framed input and answers the initialize handshake, which is what print
// mode does from inside its input loop. That answer - keyed by the request id it
// was asked with - is the only turn-independent proof that a partner reached its
// loop, so this is what the stub answers rather than a startup announcement a
// real print partner never makes: `system/init` is emitted per query turn, so the
// real one arrives only once the first prompt does.
const LIVE_STUB = `
$prewarm = $false
foreach ($a in $args) { if ($a -eq '--prewarm') { $prewarm = $true } }
if ($prewarm) { exit 0 }
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try { $m = $line | ConvertFrom-Json } catch { continue }
  if ($m.type -eq 'control_request' -and $m.request.subtype -eq 'initialize') {
    [ordered]@{ type = 'control_response'; response = [ordered]@{ subtype = 'success'; request_id = $m.request_id } } | ConvertTo-Json -Compress -Depth 6 | Write-Output
    [Console]::Out.Flush()
  }
}
exit 0
`

// A launcher that warms, writes its own pid down, then reads input forever
// without ever answering the handshake - a child that starts and gets nowhere.
const SILENT_STUB = `
$prewarm = $false
foreach ($a in $args) { if ($a -eq '--prewarm') { $prewarm = $true } }
if ($prewarm) { exit 0 }
if ($env:PARTNER_PID_FILE) { Set-Content -Path $env:PARTNER_PID_FILE -Value $PID -Encoding utf8 }
while ($null -ne ($line = [Console]::In.ReadLine())) { }
exit 0
`

test('prewarm budget comes from the launcher policy file, not a second constant', () => {
  const dir = mkdtempSync(join(tmpdir(), 'partner-policy-'))
  const script = join(dir, 'cc.ps1')
  writeFileSync(script, 'exit 0', 'utf8')
  writeFileSync(join(dir, 'launcher-policy.json'), JSON.stringify({ prewarmTimeoutMs: 12_345 }), 'utf8')
  const previous = process.env.GATEWAY_CC_SCRIPT
  process.env.GATEWAY_CC_SCRIPT = script
  try {
    expect(prewarmTimeoutMs()).toBe(12_345)
  } finally {
    previous === undefined ? delete process.env.GATEWAY_CC_SCRIPT : process.env.GATEWAY_CC_SCRIPT = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a policy that is missing or unusable is refused rather than replaced by a second budget', () => {
  stubLauncher('exit 0')
  const path = join(process.env.GATEWAY_CC_SCRIPT!, '..', 'launcher-policy.json')
  // Absent: the launch parameters are unknown, and inventing a budget here is
  // the second copy of the number this file exists to avoid.
  rmSync(path, { force: true })
  expect(() => prewarmTimeoutMs()).toThrow(/cannot read the launcher policy/)

  // Present but unusable, in the two ways that are not a deadline: a value that
  // is not a whole number of milliseconds, and one past what a timer honours -
  // which Node clamps to 1ms, so it would fire at once and refuse every launch
  // while looking exactly like a real timeout.
  writeFileSync(path, JSON.stringify({ prewarmTimeoutMs: 'soon' }), 'utf8')
  expect(() => prewarmTimeoutMs()).toThrow(/whole number of milliseconds/)
  writeFileSync(path, JSON.stringify({ prewarmTimeoutMs: 2_147_483_648 }), 'utf8')
  expect(() => prewarmTimeoutMs()).toThrow(/whole number of milliseconds/)

  writeFileSync(path, JSON.stringify({ prewarmTimeoutMs: 12_345 }), 'utf8')
  expect(prewarmTimeoutMs()).toBe(12_345)
})

test('the startup budget is the launcher policy too, refused the same ways', () => {
  stubLauncher('exit 0', { partnerStartupTimeoutMs: 7_654 })
  expect(partnerStartupTimeoutMs()).toBe(7_654)
  const path = join(process.env.GATEWAY_CC_SCRIPT!, '..', 'launcher-policy.json')

  // A policy that names the warm budget and not this one is not usable either: a
  // default here would be a second copy of the number, and one that no install
  // ever chose.
  writeFileSync(path, JSON.stringify({ prewarmTimeoutMs: 1 }), 'utf8')
  expect(() => partnerStartupTimeoutMs()).toThrow(/partnerStartupTimeoutMs/)
  expect(() => partnerStartupTimeoutMs()).toThrow(/whole number of milliseconds/)
  writeFileSync(path, JSON.stringify({ prewarmTimeoutMs: 1, partnerStartupTimeoutMs: 0 }), 'utf8')
  expect(() => partnerStartupTimeoutMs()).toThrow(/whole number of milliseconds/)

  rmSync(path, { force: true })
  expect(() => partnerStartupTimeoutMs()).toThrow(/cannot read the launcher policy/)
})

test('the admission cap is per leaf and refuses the launch past it', () => {
  expect(maxPartnersPerLeaf()).toBe(2)
  process.env.GATEWAY_PARTNER_LIMIT = '3'
  expect(maxPartnersPerLeaf()).toBe(3)
})

test.skipIf(!isWindows)('a launch with no usable policy is refused before anything is spawned', async () => {
  const marker = join(tmpdir(), `partner-spawn-${randomUUID()}.marker`)
  cleanups.push(() => rmSync(marker, { force: true }))
  process.env.PARTNER_LAUNCHED = marker
  stubLauncher(`
New-Item -ItemType File -Path $env:PARTNER_LAUNCHED -Force | Out-Null
exit 0
`)
  rmSync(join(process.env.GATEWAY_CC_SCRIPT!, '..', 'launcher-policy.json'), { force: true })
  await expect(
    launchPartner(
      { sessionId: randomUUID(), ownerSessionId: 'owner-nopolicy', cwd: tmpdir(), label: 'partner of Leaf 9: anything' },
      { endpoint: '\\\\.\\pipe\\gateway-leaf-owner-none', token: 't' },
    ),
  ).rejects.toThrow(/cannot read the launcher policy/)
  // Refused rather than run: nothing was started, and the slot the refusal
  // reserved came back, so the leaf is not left holding a partner it never got.
  expect(existsSync(marker)).toBe(false)
  expect(partnerCount('owner-nopolicy')).toBe(0)

  // A policy that carries the warm budget but not the startup one is refused the
  // same way, and still before anything is spawned: the two are one set of launch
  // parameters, and half of it does not bound a launch.
  writeFileSync(join(process.env.GATEWAY_CC_SCRIPT!, '..', 'launcher-policy.json'), JSON.stringify({ prewarmTimeoutMs: 1 }), 'utf8')
  await expect(
    launchPartner(
      { sessionId: randomUUID(), ownerSessionId: 'owner-nostartup', cwd: tmpdir(), label: 'partner of Leaf 9: anything' },
      { endpoint: '\\\\.\\pipe\\gateway-leaf-owner-none', token: 't' },
    ),
  ).rejects.toThrow(/partnerStartupTimeoutMs/)
  expect(existsSync(marker)).toBe(false)
  expect(partnerCount('owner-nostartup')).toBe(0)
})

test.skipIf(!isWindows)('an overrunning warm build is killed and the partner is refused, not raced', async () => {
  stubLauncher(`
foreach ($a in $args) { if ($a -eq '--prewarm') { Start-Sleep -Seconds 30; exit 0 } }
exit 0
`)
  const started = Date.now()
  await expect(
    prewarm({ cwd: tmpdir(), timeoutMs: 400 }),
  ).rejects.toThrow(/prewarm exceeded 400ms/)
  // Bounded, not merely reported: the failure returned on its own deadline
  // rather than waiting out the build it declined to trust.
  expect(Date.now() - started).toBeLessThan(8_000)
})

test.skipIf(!isWindows)('a nonzero warm build refuses the launch', async () => {
  stubLauncher(`
foreach ($a in $args) { if ($a -eq '--prewarm') { exit 3 } }
exit 0
`)
  await expect(prewarm({ cwd: tmpdir() })).rejects.toThrow(/exited with code 3/)
})

test.skipIf(!isWindows)('a partner is owner-tied, framed, and counted against its leaf', async () => {
  stubLauncher(LIVE_STUB)
  process.env.GATEWAY_PARTNER_LIMIT = '1'
  const owner = { endpoint: '\\\\.\\pipe\\gateway-leaf-owner-test', token: 'secret-token' }
  const partner = await launchPartner(
    { sessionId: '11111111-1111-4111-8111-111111111111', ownerSessionId: 'owner-1', cwd: tmpdir(), label: 'partner of Leaf 1: api' },
    owner,
  )

  try {
    // Framed input reaches it: a stream-json user record is accepted and written.
    expect(await partner.deliver('review the plan')).toBe(true)
    expect(partnerCount('owner-1')).toBe(1)

    // The cap is what stops a leaf forking partners without limit.
    await expect(
      launchPartner(
        { sessionId: '22222222-2222-4222-8222-222222222222', ownerSessionId: 'owner-1', cwd: tmpdir(), label: 'partner of Leaf 1: api' },
        owner,
      ),
    ).rejects.toThrow(/already holds 1 partners/)

    // A second owner gets its own budget - the cap is per leaf, not global.
    expect(partnerCount('owner-2')).toBe(0)
  } finally {
    await partner.close()
  }

  expect(partnerCount('owner-1')).toBe(0)
  expect(partner.getState()).toBe('closed')
})

test.skipIf(!isWindows)('concurrent launches cannot exceed the cap, and a refusal gives its slot back', async () => {
  stubLauncher(LIVE_STUB)
  process.env.GATEWAY_PARTNER_LIMIT = '1'
  const owner = { endpoint: '\\\\.\\pipe\\gateway-leaf-owner-race', token: 'race-token' }
  const spec = (sessionId: string) => ({ sessionId, ownerSessionId: 'owner-race', cwd: tmpdir(), label: 'partner of Leaf 9: race' })

  // Both are in flight before either has finished warming - the window in which
  // a cap read on the far side of the await is read as empty by both, and the
  // second launch then registers a set of its own over the first.
  const results = await Promise.allSettled([
    launchPartner(spec('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), owner),
    launchPartner(spec('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), owner),
  ])
  const won = results.filter(result => result.status === 'fulfilled')
  const lost = results.filter(result => result.status === 'rejected')
  expect(won).toHaveLength(1)
  expect(lost).toHaveLength(1)
  expect(String((lost[0] as PromiseRejectedResult).reason)).toMatch(/already holds 1 partners/)
  // One slot, one partner - and the count is the one the winner registered, not
  // whichever set happened to be written last.
  expect(partnerCount('owner-race')).toBe(1)

  await (won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof launchPartner>>>).value.close()
  expect(partnerCount('owner-race')).toBe(0)
})

test.skipIf(!isWindows)('a warm build that fails gives its slot back', async () => {
  stubLauncher(`
foreach ($a in $args) { if ($a -eq '--prewarm') { exit 4 } }
exit 0
`)
  process.env.GATEWAY_PARTNER_LIMIT = '1'
  await expect(
    launchPartner(
      { sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', ownerSessionId: 'owner-warm', cwd: tmpdir(), label: 'partner of Leaf 9: warm' },
      { endpoint: '\\\\.\\pipe\\gateway-leaf-owner-warm', token: 't' },
    ),
  ).rejects.toThrow(/exited with code 4/)
  // Were the reservation not returned, the leaf would sit at its cap with no
  // partner to show for it and no way to start one.
  expect(partnerCount('owner-warm')).toBe(0)
})

test.skipIf(!isWindows)('one leaf cannot hold the same session id twice', async () => {
  stubLauncher(LIVE_STUB)
  const owner = { endpoint: '\\\\.\\pipe\\gateway-leaf-owner-dup', token: 't' }
  const sessionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  const spec = { sessionId, ownerSessionId: 'owner-dup', cwd: tmpdir(), label: 'partner of Leaf 9: dup' }
  const first = await launchPartner(spec, owner)
  await expect(launchPartner(spec, owner)).rejects.toThrow(/already held as a partner/)
  expect(partnerCount('owner-dup')).toBe(1)
  await first.close()
})

test.skipIf(!isWindows)('readiness is the partner answering this launch\'s handshake, and the wait for it is bounded', async () => {
  stubLauncher(LIVE_STUB)
  const owner = { endpoint: '\\\\.\\pipe\\gateway-leaf-owner-ready', token: 't' }
  const partner = await launchPartner(
    { sessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', ownerSessionId: 'owner-ready', cwd: tmpdir(), label: 'partner of Leaf 9: ready' },
    owner,
  )
  // The launch does not block on this, so the state is read after the fact; the
  // wait is what makes it answerable without holding the caller by default.
  expect(await partner.waitUntilReady(20_000)).toBe(true)
  expect(partner.getState()).toBe('ready')
  await partner.close()

  // Output that is not this launch's answer is not readiness: a status frame and
  // a response to a different request both leave the partner starting, and the
  // wait returns on its own deadline instead of hanging.
  stubLauncher(`
$prewarm = $false
foreach ($a in $args) { if ($a -eq '--prewarm') { $prewarm = $true } }
if ($prewarm) { exit 0 }
Write-Output '{"type":"system","subtype":"status","status":"starting"}'
Write-Output '{"type":"control_response","response":{"subtype":"success","request_id":"another-launchs-request"}}'
while ($null -ne ($line = [Console]::In.ReadLine())) { }
exit 0
`)
  const quiet = await launchPartner(
    { sessionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', ownerSessionId: 'owner-quiet', cwd: tmpdir(), label: 'partner of Leaf 9: quiet' },
    owner,
  )
  const started = Date.now()
  expect(await quiet.waitUntilReady(1_500)).toBe(false)
  expect(Date.now() - started).toBeLessThan(10_000)
  expect(quiet.getState()).toBe('starting')
  await quiet.close()
}, { timeout: 60_000 })

test.skipIf(!isWindows)('a partner that never answers is failed, killed and released on its own deadline, with nobody opting in', async () => {
  // The budget is generous on purpose. The child that has to be shown killed is
  // one that got as far as recording its own pid, and a cold powershell takes a
  // moment to do even that - measured with a budget short enough to beat the
  // write, this test would kill a spawn that never got anywhere and prove
  // nothing about a running partner.
  stubLauncher(SILENT_STUB, { partnerStartupTimeoutMs: 3_000 })
  process.env.GATEWAY_PARTNER_LIMIT = '1'
  const pidFile = join(tmpdir(), `partner-pid-${randomUUID()}.txt`)
  process.env.PARTNER_PID_FILE = pidFile
  cleanups.push(() => rmSync(pidFile, { force: true }))

  const started = Date.now()
  const partner = await launchPartner(
    { sessionId: '99999999-9999-4999-8999-999999999999', ownerSessionId: 'owner-silent', cwd: tmpdir(), label: 'partner of Leaf 9: silent' },
    { endpoint: '\\\\.\\pipe\\gateway-leaf-owner-silent', token: 't' },
  )
  // Handed back while it is still starting: the caller is not held for the start,
  // and no caller has to ask for the bound below - the launch armed it itself.
  expect(partner.getState()).toBe('starting')
  expect(partnerCount('owner-silent')).toBe(1)

  // The child is up - it recorded its pid - and silent: it never answers the
  // handshake, so nothing here is waiting for a deadline that a slow start would
  // have brought on by itself.
  let pid = 0
  for (let attempt = 0; attempt < 400 && !pid; attempt++) {
    try { pid = Number(readFileSync(pidFile, 'utf8').replace(/^\uFEFF/, '').trim()) } catch { await new Promise(resolve => setTimeout(resolve, 10)) }
  }
  expect(pid).toBeGreaterThan(0)
  expect(isRunning(pid)).toBe(true)

  // Nobody calls waitUntilReady to make this happen. The deadline is what ends
  // it, and the wait answers false the moment the failure is known rather than
  // sitting out its own bound.
  expect(await partner.waitUntilReady(30_000)).toBe(false)
  expect(partner.getState()).toBe('failed')
  expect(Date.now() - started).toBeLessThan(20_000)

  // The slot comes back and the partner is not talkable, so the leaf is not left
  // holding a name at its cap with nothing behind it.
  expect(partnerCount('owner-silent')).toBe(0)
  expect(await partner.deliver('anyone there?')).toBe(false)

  // The tree went with it, not just the parent - and the answer above is not
  // given until it has: the deadline is a kill, and the process the stub
  // recorded is gone by the time anyone is told the launch failed.
  expect(isRunning(pid)).toBe(false)

  // And cleaning up a failed partner does not rewrite why it ended.
  await partner.close()
  expect(partner.getState()).toBe('failed')
}, { timeout: 60_000 })

test.skipIf(!isWindows)('a partner that answers is never mistaken for one that did not', async () => {
  // A budget short enough that a partner which answered and then went quiet for
  // longer than it would still be killed were readiness measured by silence.
  stubLauncher(LIVE_STUB, { partnerStartupTimeoutMs: 1_200 })
  const partner = await launchPartner(
    { sessionId: '88888888-8888-4888-8888-888888888888', ownerSessionId: 'owner-survivor', cwd: tmpdir(), label: 'partner of Leaf 9: survivor' },
    { endpoint: '\\\\.\\pipe\\gateway-leaf-owner-survivor', token: 't' },
  )
  expect(await partner.waitUntilReady(20_000)).toBe(true)
  // Well past the startup budget, and with no traffic in between: a ready
  // collaborator is not a starting child, and there is no idle timeout on it.
  await new Promise(resolve => setTimeout(resolve, 3_000))
  expect(partner.getState()).toBe('ready')
  expect(await partner.deliver('still there?')).toBe(true)
  await partner.close()
  expect(partner.getState()).toBe('closed')
}, { timeout: 60_000 })

// A launcher that records the environment, arguments and first input frame it
// was handed, so the test can read what actually reached the spawned process
// rather than what the launch path believes it passed. It records only on the
// real spawn: the warm build runs first and would otherwise leave its own
// (unrelated) dump behind.
const RECORDING_STUB = `
$prewarm = $false
foreach ($a in $args) { if ($a -eq '--prewarm') { $prewarm = $true } }
if ($prewarm) { exit 0 }
if ($env:PARTNER_ENV_DUMP) {
  [ordered]@{
    endpoint = $env:GATEWAY_LEAF_OWNER_ENDPOINT
    token = $env:GATEWAY_LEAF_OWNER_TOKEN
    label = $env:GATEWAY_LEAF_LABEL
    interactive = $env:GATEWAY_INTERACTIVE_LEAF
    session = $env:GATEWAY_LEAF_SESSION
    args = ($args -join ' ')
  } | ConvertTo-Json -Compress | Set-Content -Path $env:PARTNER_ENV_DUMP -Encoding utf8
}
$seen = $false
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try { $m = $line | ConvertFrom-Json } catch { continue }
  if ($env:PARTNER_FRAME_DUMP -and -not $seen) { $seen = $true; Set-Content -Path $env:PARTNER_FRAME_DUMP -Value $line -Encoding utf8 }
  if ($m.type -eq 'control_request' -and $m.request.subtype -eq 'initialize') {
    [ordered]@{ type = 'control_response'; response = [ordered]@{ subtype = 'success'; request_id = $m.request_id } } | ConvertTo-Json -Compress -Depth 6 | Write-Output
    [Console]::Out.Flush()
  }
}
exit 0
`

/**
 * Wait for the spawned process to record itself.
 *
 * The launch resolves as soon as the first frame is written, which is before the
 * process it spawned has run far enough to write anything - so this waits for the
 * record rather than assuming it is there, with a bound so a launch that never
 * records fails the test instead of hanging it.
 */
async function waitForSpawnRecord(path: string, timeoutMs = 20_000): Promise<Record<string, string>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try { return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as Record<string, string> }
    catch { /* Not written yet, still being written, or no process reached it. */ }
    if (Date.now() > deadline) throw new Error(`the launched partner never recorded its environment (${path})`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

test.skipIf(!isWindows)('a leaf convenes a partner through the Leaf tool, named for its owner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'partner-e2e-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const dump = join(dir, 'spawn.json')
  const frameDump = join(dir, 'first-frame.json')
  process.env.PARTNER_ENV_DUMP = dump
  process.env.PARTNER_FRAME_DUMP = frameDump
  process.env.GATEWAY_PARTNER_LIMIT = '1'
  stubLauncher(RECORDING_STUB)
  // The session id and the family both come from config, and a test that left the
  // real config home in place would convene a partner against a real family.
  const config = mkdtempSync(join(tmpdir(), 'partner-config-'))
  cleanups.push(() => rmSync(config, { recursive: true, force: true }))
  const savedConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = config
  cleanups.push(() => { savedConfig === undefined ? delete process.env.CLAUDE_CONFIG_DIR : process.env.CLAUDE_CONFIG_DIR = savedConfig })

  const { LeafTool } = await import('../src/tools/LeafTool/LeafTool.ts')
  const call = async (input: Record<string, unknown>): Promise<string> =>
    (await LeafTool.call(input as never, {} as never)).data.result

  const convened = await call({ action: 'partner', name: 'review the plan' })
  expect(convened).toMatch(/^Convened partner of /)
  expect(convened).toContain('review the plan')
  // Convening waits for the handshake, so the result is written from an answer
  // rather than an assumption: it may claim the partner is reachable because it
  // has been observed answering, and the same path reports failure as failure.
  expect(convened).toContain('[ready]')
  expect(convened).toContain('on the peer bus')

  // What reached the process, not what the launch path meant to pass.
  const spawned = await waitForSpawnRecord(dump)
  // Ownership is the crux: the partner carries the owner's endpoint and secret,
  // which is what makes the existing 5s watchdog bind it to this leaf, so a leaf
  // that dies takes its partner with it.
  expect(spawned.endpoint).toContain('gateway-leaf-owner-')
  expect(spawned.token).toMatch(/^[0-9a-f-]{36}$/)
  // Framing is stated rather than inferred, so the sender's stream-json records
  // are read as turns rather than as a bare prompt argument.
  expect(spawned.args).toContain('--input-format stream-json')
  // A partner has no terminal to draw into, so it must not come up interactive
  // even though the session that owns it may itself be one.
  expect(spawned.interactive ?? '').toBe('')
  // The name is what makes it findable as belonging to its owner, rather than as
  // another anonymous headless session.
  expect(spawned.label).toMatch(/^partner of /)

  // The first frame is the initialize handshake, not a prompt. Readiness is only
  // evidence of the input loop when it is this launch's own request being
  // answered, and a print-mode session emits `system/init` only with its first
  // turn - so the handshake is what is sent, and this is proof it was.
  const firstFrame = JSON.parse(readFileSync(frameDump, 'utf8').replace(/^\uFEFF/, '')) as {
    type?: string
    request?: { subtype?: string }
  }
  expect(firstFrame.type).toBe('control_request')
  expect(firstFrame.request?.subtype).toBe('initialize')

  // Held, listed, and closeable - the cap is only actionable if a partner can be
  // given back.
  expect(await call({ action: 'partners' })).toContain('review the plan')
  expect(await call({ action: 'partner-close', leaf: spawned.session })).toMatch(/^Closed partner of /)
  expect(await call({ action: 'partners' })).toBe('No partners convened. Use action partner to start one.')
}, { timeout: 60_000 })

// A leaf is itself a leaf: it holds `GATEWAY_LEAF_*` in its environment because
// its own owner launched it that way. The partner it convenes must not carry that
// inherited identity - it is a leaf of *this* process, so it is handed the
// endpoint and token this process opened, and interactive-ness is cleared rather
// than passed through. This is the property that made a live probe's idle
// self-exit a probe bug rather than a product one, and it was uncovered: the
// convene test above runs with no ambient identity, so an inherited endpoint and
// the owner's own are indistinguishable there.
test.skipIf(!isWindows)('a partner of a leaf is bound to that leaf, not to the identity it inherited', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'partner-inherit-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const dump = join(dir, 'spawn.json')
  process.env.PARTNER_ENV_DUMP = dump
  process.env.GATEWAY_PARTNER_LIMIT = '1'
  stubLauncher(RECORDING_STUB)
  // The session id and the family both come from config, and a test that left the
  // real config home in place would convene a partner against a real family.
  const config = mkdtempSync(join(tmpdir(), 'partner-config-'))
  cleanups.push(() => rmSync(config, { recursive: true, force: true }))
  const savedConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = config
  cleanups.push(() => { savedConfig === undefined ? delete process.env.CLAUDE_CONFIG_DIR : process.env.CLAUDE_CONFIG_DIR = savedConfig })

  // What a leaf inherits from the owner above it. The token is deliberately not a
  // uuid, so a dropped override cannot pass by looking like a fresh one.
  const inherited: Record<string, string> = {
    GATEWAY_LEAF_SESSION: 'inherited-session-id',
    GATEWAY_LEAF_LABEL: 'inherited label',
    GATEWAY_LEAF_OWNER_ENDPOINT: '\\\\.\\pipe\\gateway-leaf-owner-INHERITED',
    GATEWAY_LEAF_OWNER_TOKEN: 'inherited-token-not-a-uuid',
    GATEWAY_INTERACTIVE_LEAF: '1',
  }
  const saved: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(inherited)) { saved[key] = process.env[key]; process.env[key] = value }
  cleanups.push(() => { for (const [key, value] of Object.entries(saved)) { value === undefined ? delete process.env[key] : process.env[key] = value } })

  const { LeafTool } = await import('../src/tools/LeafTool/LeafTool.ts')
  const call = async (input: Record<string, unknown>): Promise<string> =>
    (await LeafTool.call(input as never, {} as never)).data.result

  expect(await call({ action: 'partner', name: 'inherit probe' })).toContain('[ready]')

  const spawned = await waitForSpawnRecord(dump)
  // The endpoint is this process's own - a fresh pipe, not the one it inherited.
  expect(spawned.endpoint).toContain('gateway-leaf-owner-')
  expect(spawned.endpoint).not.toBe(inherited.GATEWAY_LEAF_OWNER_ENDPOINT)
  // The token is this process's own too, and a fresh one is a uuid.
  expect(spawned.token).not.toBe(inherited.GATEWAY_LEAF_OWNER_TOKEN)
  expect(spawned.token).toMatch(/^[0-9a-f-]{36}$/)
  // It is a leaf of this leaf, not of the session above it.
  expect(spawned.session).not.toBe(inherited.GATEWAY_LEAF_SESSION)
  // And it does not inherit interactive-ness: it has no terminal to draw into.
  expect(spawned.interactive ?? '').toBe('')
}, { timeout: 60_000 })
