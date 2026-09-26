import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { decideReap, isLauncherAlive, startSessionReaper } from '../src/utils/sessionReaper.ts'

/**
 * The idle reaper decides whether to close a session that nothing is using.
 *
 * Two things are worth testing and they are not the same thing. The policy is
 * tested as a truth table, because the cost of a wrong branch is a closed
 * session somebody was still typing into. The wiring is tested through a real
 * timer against a scripted snapshot, because "the rule is right" and "the rule
 * ever runs" were separate defects here: Windows had no orphan detection at all,
 * so a correct rule with no caller would have looked finished and changed
 * nothing.
 */

const LIMITS = { leafIdleMs: 120_000, rootIdleMs: 1_800_000 }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('work in flight outranks every other signal', () => {
  // An eighteen-hour-idle orphan that has somehow started working is not
  // abandoned, it is busy, and closing it would throw away a live turn.
  assert.deepEqual(
    decideReap({ role: 'root', busy: true, idleMs: 64_800_000, attached: false, launcherAlive: false, limits: LIMITS }),
    { reap: false, reason: 'busy' },
  )
  assert.deepEqual(
    decideReap({ role: 'leaf', busy: true, idleMs: 0, attached: false, launcherAlive: false, limits: LIMITS }),
    { reap: false, reason: 'busy' },
  )
})

test('a leaf is reaped on nobody-attached plus idleness, and on nothing else', () => {
  const leaf = (over: Partial<{ busy: boolean; idleMs: number; attached: boolean }>) =>
    decideReap({ role: 'leaf', busy: false, idleMs: 0, attached: false, launcherAlive: false, limits: LIMITS, ...over })
  // Attached and quiet for a day is somebody's open terminal, not an orphan.
  assert.deepEqual(leaf({ attached: true, idleMs: 86_400_000 }), { reap: false, reason: 'attached' })
  // Detached between owners: the handover gap must survive.
  assert.deepEqual(leaf({ idleMs: 119_999 }), { reap: false, reason: 'idle-within-window' })
  assert.deepEqual(leaf({ idleMs: 120_000 }), { reap: true, reason: 'unattached-leaf-idle', idleMs: 120_000 })
  // The launcher is irrelevant to a leaf: it is detached by design and its
  // parent dying is the ordinary case, not evidence of abandonment.
  assert.deepEqual(leaf({ idleMs: 600_000 }), { reap: true, reason: 'unattached-leaf-idle', idleMs: 600_000 })
})

test('a root session is reaped only once its launcher is provably gone', () => {
  const root = (over: Partial<{ busy: boolean; idleMs: number; launcherAlive: boolean }>) =>
    decideReap({ role: 'root', busy: false, idleMs: 0, attached: false, launcherAlive: false, limits: LIMITS, ...over })
  // A live terminal, however quiet, is never the reaper's business.
  assert.deepEqual(root({ launcherAlive: true, idleMs: 86_400_000 }), { reap: false, reason: 'launcher-alive' })
  // Orphaned but recently used: a launcher can die mid-crash-restart, and the
  // session may be resumed into a new one a moment later.
  assert.deepEqual(root({ idleMs: 300_000 }), { reap: false, reason: 'idle-within-window' })
  assert.deepEqual(root({ idleMs: 1_800_000 }), { reap: true, reason: 'orphaned-root-idle', idleMs: 1_800_000 })
  assert.deepEqual(root({ idleMs: 64_800_000 }), { reap: true, reason: 'orphaned-root-idle', idleMs: 64_800_000 })
})

test('the launcher probe errs towards alive', () => {
  assert.equal(isLauncherAlive(process.pid), true, 'this process is running')
  // pid 0 is this process group and 1 is init; neither is a launcher to trust.
  assert.equal(isLauncherAlive(0), false)
  assert.equal(isLauncherAlive(1), false)
  // A process that has exited answers a signal-0 probe with ESRCH. spawnSync has
  // already reaped it by the time pid is read, so this is a genuinely dead pid.
  const exited = spawnSync(process.execPath, ['-e', ''])
  assert.ok(exited.pid && exited.pid > 0, 'the probe needs a real pid to test against')
  assert.equal(isLauncherAlive(exited.pid!), false)
})

test('the reaper can be switched off entirely', async () => {
  process.env.CLAUDE_CODE_DISABLE_IDLE_REAP = '1'
  try {
    const reaped: string[] = []
    const stop = startSessionReaper({
      role: 'root', intervalMs: 5, limits: { rootIdleMs: 1 },
      snapshot: () => ({ busy: false, idleMs: 60_000, attached: false, launcherAlive: false }),
      onReap: decision => { reaped.push(decision.reason) },
    })
    await sleep(40)
    stop()
    assert.deepEqual(reaped, [], 'an escaped kill switch is the only way to keep a stuck fleet alive')
  } finally {
    delete process.env.CLAUDE_CODE_DISABLE_IDLE_REAP
  }
})

test('an armed reaper closes an unattached idle leaf once, then stops', async () => {
  const previous = process.env.GATEWAY_LEAF_SESSION
  process.env.GATEWAY_LEAF_SESSION = '11111111-1111-4111-8111-111111111111'
  const reaped: string[] = []
  const state = { busy: false, idleMs: 0, attached: false }
  const stop = startSessionReaper({
    role: 'leaf', intervalMs: 10, limits: { leafIdleMs: 50 },
    snapshot: () => ({ busy: state.busy, idleMs: state.idleMs, attached: state.attached, launcherAlive: false }),
    onReap: decision => { reaped.push(decision.reason) },
  })
  try {
    await sleep(60)
    assert.deepEqual(reaped, [], 'a leaf inside its window is left alone')

    state.attached = true
    state.idleMs = 10_000
    await sleep(40)
    assert.deepEqual(reaped, [], 'nobody is closed while somebody is watching')

    state.attached = false
    state.busy = true
    await sleep(40)
    assert.deepEqual(reaped, [], 'a paused leaf mid-turn is still working')

    state.busy = false
    await sleep(40)
    assert.deepEqual(reaped, ['unattached-leaf-idle'])

    await sleep(40)
    assert.equal(reaped.length, 1, 'the timer stops once it has acted')
  } finally {
    stop()
    if (previous === undefined) delete process.env.GATEWAY_LEAF_SESSION
    else process.env.GATEWAY_LEAF_SESSION = previous
  }
})

test('a real leaf, detected from its own launch, is closed on the idle clock', async () => {
  // Everything but the exit action is the production path: the role comes from
  // the launch environment, the idle clock is the real one, and the attach state
  // is genuinely "no session is watching". Only the shutdown is captured, so this
  // cannot take the test runner down with it.
  const saved = {
    leaf: process.env.GATEWAY_INTERACTIVE_LEAF,
    session: process.env.GATEWAY_LEAF_SESSION,
    window: process.env.CLAUDE_CODE_LEAF_IDLE_EXIT_MS,
  }
  process.env.GATEWAY_INTERACTIVE_LEAF = '1'
  process.env.GATEWAY_LEAF_SESSION = '22222222-2222-4222-8222-222222222222'
  process.env.CLAUDE_CODE_LEAF_IDLE_EXIT_MS = '1'
  const reaped: string[] = []
  let stop: (() => void) | undefined
  try {
    stop = startSessionReaper({ intervalMs: 20, onReap: decision => { reaped.push(decision.reason) } })
    await sleep(80)
    assert.deepEqual(reaped, ['unattached-leaf-idle'])
  } finally {
    stop?.()
    for (const [key, value] of Object.entries({
      GATEWAY_INTERACTIVE_LEAF: saved.leaf,
      GATEWAY_LEAF_SESSION: saved.session,
      CLAUDE_CODE_LEAF_IDLE_EXIT_MS: saved.window,
    })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('a leaf with no endpoint of its own is left to its launcher', async () => {
  // Reachability is the guard that keeps this rule from acting on a signal the
  // process cannot observe: with no session id there is no endpoint, so nothing
  // can ever attach and "nobody is watching" is true forever. Every tracked test
  // that impersonates a leaf leans on this, which is why it is asserted.
  const saved = {
    leaf: process.env.GATEWAY_INTERACTIVE_LEAF,
    session: process.env.GATEWAY_LEAF_SESSION,
  }
  process.env.GATEWAY_INTERACTIVE_LEAF = '1'
  delete process.env.GATEWAY_LEAF_SESSION
  const reaped: string[] = []
  let stop: (() => void) | undefined
  try {
    stop = startSessionReaper({
      intervalMs: 20, limits: { leafIdleMs: 1 },
      onReap: decision => { reaped.push(decision.reason) },
    })
    await sleep(80)
    assert.deepEqual(reaped, [])
  } finally {
    stop?.()
    if (saved.leaf === undefined) delete process.env.GATEWAY_INTERACTIVE_LEAF
    else process.env.GATEWAY_INTERACTIVE_LEAF = saved.leaf
    if (saved.session === undefined) delete process.env.GATEWAY_LEAF_SESSION
    else process.env.GATEWAY_LEAF_SESSION = saved.session
  }
})
