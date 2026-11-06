/**
 * One isolated page per writer.
 *
 * A lane is a driver child of its own with its own serial page chain, so nothing
 * about one writer's page collides with another's. Where that page LIVES is the
 * provider's choice, and it is the one thing that changes between providers:
 *
 * - A disposable window: its own Chrome process, its own temporary profile and
 *   its own debugging port. Its login is branched from the master's cookies.
 * - A shared browser (`sharedBrowser`): a named TAB in the master window. A
 *   provider whose session cannot be copied - Google invalidates a session seen
 *   twice, and every copied login races the master's token rotation - gets this
 *   shape, where there is exactly one cookie jar and nothing to copy or sync.
 *
 * The master Chrome (the human's window) is never unloaded or navigated by this
 * manager, and in shared mode it is not closed with its last lane: only the
 * lane's own tab is.
 *
 * Cap and queue are deliberate: at most `maxLanes` lanes exist, and a writer
 * beyond the cap waits for one instead of failing. Order is FIFO.
 */
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { connect as netConnect, createServer } from 'node:net'
import { join } from 'node:path'
import { DriverChild, type CallOptions, type DriverReply } from './driver.ts'

/**
 * A per-lane view of the shared child.
 *
 * The child is one process for the whole browser; every request carries the
 * lane it is for and the driver resolves the tab from it. `terminate` is a
 * deliberate no-op: closing one writer's lane must never kill the process every
 * other writer is using.
 */
function laneDriver(shared: DriverChild, laneId: string): DriverChild {
  return {
    call: (request: Record<string, unknown>, options?: number | CallOptions) =>
      shared.call({ ...request, lane: laneId }, options),
    terminate: async () => { /* the shared child outlives every lane */ },
  } as unknown as DriverChild
}

export type LaneHandle = {
  laneId: string
  driver: DriverChild
  port: number
  profile: string
  stateDir: string
}

export type LaneState = 'opening' | 'active' | 'idle' | 'closing'

export type LaneStatus = {
  laneId: string
  port: number
  state: LaneState
  users: number
  /** Turns served by this window since it opened. */
  turns: number
  since: string
  lastUsedAt: string
}

export type LaneEvent = 'open' | 'ready' | 'close' | 'recycle' | 'queue' | 'failed'

export type LaneOptions = {
  /** The driver entry point this repo ships (`chatgpt.mjs`). */
  driverScript: string
  /** Where lane state directories live. */
  root: string
  /**
   * The master Chrome's debugging port: where a shared lane's tab lives, and
   * where a copied-login lane would read its cookies from.
   */
  sourcePort?: number
  /** The first lane port; 0 picks 9300. */
  basePort?: number
  /**
   * Live lanes at once; 8 by default. In the shared-tab shape it is a SOFT cap:
   * a new writer at the cap evicts the least recently used idle tab instead of
   * queueing, and only waits when every lane is mid-turn.
   */
  maxLanes?: number
  /**
   * How long an idle lane survives. 30 s by default for a lane with its own
   * Chrome window; 30 min for a shared-browser tab, because reopening a tab is a
   * full page load against the account and an interactive back-and-forth must
   * find its tab still on its thread.
   */
  idleMs?: number
  /**
   * How often a shared lane manager tells the driver which lane tabs are live,
   * so a tab or lease left by a dead lane is closed. 60 s by default; 0 off.
   */
  sweepEveryMs?: number
  /** Write a lane's rotated cookies back to the master on close. */
  syncCookies?: boolean
  /**
   * A provider whose session cannot be copied into a fresh profile gives each
   * lane a TAB in the master browser instead of its own Chrome window.
   */
  sharedBrowser?: boolean
  /** The master's Chrome profile, so a shared lane can reopen a closed browser. */
  sourceProfile?: string
  /** Rotate a lane after this many acquired turns (0 disables). */
  maxTurns?: number
  /** Rotate a lane this long after it opened (0 disables). */
  maxAgeMs?: number
  /** First retry delay when a lane open is rate-limited. */
  backoffBaseMs?: number
  log?: (line: string) => void
  /** Every open/close/recycle, for the host's audit trail. */
  onEvent?: (event: LaneEvent, laneId: string, detail: string) => void
  /** Test seam: build the child for one lane. */
  spawnLane?: (lane: { laneId: string; port: number; profile: string; stateDir: string; env: Record<string, string> }) => DriverChild
  /**
   * ONE driver child for every lane, instead of a process per writer.
   *
   * The driver keeps one tab per lane and routes each request by `lane`, so a
   * browser has one Playwright connection and one process no matter how many
   * inputters use it. Without a factory the manager keeps the old shape: one
   * child per lane (what every existing proof injects).
   */
  sharedDriver?: () => DriverChild
  /** Test seam: the clock. */
  now?: () => number
  /** Test seam: timers. Returns a cancel function. */
  schedule?: (work: () => void, ms: number) => () => void
  /** How long one lane open (Chrome + branched login) may take. */
  openTimeoutMs?: number
  /** How long a lane close may wait for the driver to drain. */
  closeTimeoutMs?: number
}

type Lane = {
  laneId: string
  port: number
  profile: string
  stateDir: string
  driver: DriverChild
  /** True when `driver` is a facade over the shared child (never terminated). */
  shared: boolean
  users: number
  /** Acquired turns since open; drives `maxTurns` rotation. */
  turns: number
  ready: boolean
  state: LaneState
  since: number
  lastUsedAt: number
  cancelIdle?: () => void
  closePromise?: Promise<void>
  closing: boolean
}

type Waiter = {
  laneId: string
  resolve: (handle: LaneHandle) => void
  reject: (error: Error) => void
  onQueued?: () => void
}

const DEFAULT_BASE_PORT = 9300
const DEFAULT_MAX_LANES = 8
const DEFAULT_IDLE_MS = 30_000
/** A shared tab stays warm this long: an interactive chat must find it open. */
export const DEFAULT_SHARED_IDLE_MS = 30 * 60_000
const DEFAULT_SWEEP_EVERY_MS = 60_000
const DEFAULT_OPEN_TIMEOUT_MS = 120_000
const DEFAULT_CLOSE_TIMEOUT_MS = 90_000
const DEFAULT_MAX_TURNS = 20
const DEFAULT_MAX_AGE_MS = 10 * 60_000
const DEFAULT_BACKOFF_BASE_MS = 5_000
const WARM_ATTEMPTS = 3

/** A lane id is a bus session id; the directory only needs it to be safe. */
const safeName = (value: string): string => String(value || 'lane').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'lane'

/** Is anything listening on this loopback port right now? */
function portFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

/** A live pid, treating EPERM as alive (it is a process we may not signal). */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * One process's command line, or null when it cannot be read.
 *
 * Windows only, and only ever used to prove a pid really is a lane before it is
 * killed. A null answer means "cannot prove", which means "do not kill".
 */
function commandLineOf(pid: number): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  return new Promise(resolve => {
    const script = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    let text = ''
    let settled = false
    const finish = (value: string | null) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value) } }
    const timer = setTimeout(() => { try { child.kill() } catch { /* gone */ } finish(null) }, 5_000)
    child.stdout.on('data', chunk => { text += chunk; if (text.length > 32_000) { try { child.kill() } catch { /* gone */ } finish(null) } })
    child.on('error', () => finish(null))
    child.on('close', () => finish(text.trim() ? text.trim() : null))
  })
}

/** Kill a proved lane's whole process tree. */
function killTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    return new Promise(resolve => {
      const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      child.on('error', () => resolve())
      child.on('exit', () => resolve())
    })
  }
  try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  return Promise.resolve()
}

export class LaneManager {
  private readonly options: LaneOptions
  private readonly lanes = new Map<string, Lane>()
  private readonly waiters: Waiter[] = []
  /**
   * Ports handed to a lane that is still opening. A concurrent open would
   * otherwise see the same port free - `portFree` binds, closes, and reports,
   * which no other caller can see - and two lanes would launch Chrome on one
   * port: the second gets a browser it does not own and refuses to attach.
   */
  private readonly reservedPorts = new Set<number>()
  private readonly registryPath: string
  private readonly maxLanes: number
  private readonly basePort: number
  private readonly idleMs: number
  private readonly sourcePort: number
  private readonly openTimeoutMs: number
  private readonly closeTimeoutMs: number
  private readonly maxTurns: number
  private readonly maxAgeMs: number
  private readonly backoffBaseMs: number
  private readonly sweepEveryMs: number
  private cancelSweep?: () => void
  private opening = 0
  private closed = false

  constructor(options: LaneOptions) {
    this.options = options
    this.maxLanes = Math.max(1, Math.floor(options.maxLanes ?? DEFAULT_MAX_LANES))
    this.basePort = Math.max(1, Math.floor(options.basePort ?? DEFAULT_BASE_PORT))
    // A tab in the shared browser is cheap to keep and expensive to reopen (a
    // full page load against the account), so it stays warm and is never
    // rotated on a timer; a lane with its own Chrome window is the opposite.
    const tabs = options.sharedBrowser === true
    this.idleMs = Math.max(0, Math.floor(options.idleMs ?? (tabs ? DEFAULT_SHARED_IDLE_MS : DEFAULT_IDLE_MS)))
    this.sourcePort = Math.max(1, Math.floor(options.sourcePort ?? 9222))
    this.openTimeoutMs = Math.max(1_000, Math.floor(options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS))
    this.closeTimeoutMs = Math.max(1_000, Math.floor(options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS))
    this.maxTurns = Math.max(0, Math.floor(options.maxTurns ?? (tabs ? 0 : DEFAULT_MAX_TURNS)))
    this.maxAgeMs = Math.max(0, Math.floor(options.maxAgeMs ?? (tabs ? 0 : DEFAULT_MAX_AGE_MS)))
    this.sweepEveryMs = Math.max(0, Math.floor(options.sweepEveryMs ?? DEFAULT_SWEEP_EVERY_MS))
    this.backoffBaseMs = Math.max(0, Math.floor(options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS))
    this.registryPath = join(options.root, 'lanes.json')
  }

  /** The cap, so the host can say why a turn is queued. */
  get max(): number { return this.maxLanes }
  /** Live lanes, including ones still opening. */
  get size(): number { return this.lanes.size }
  /** Writers waiting for a lane. */
  get queued(): number { return this.waiters.length }

  private get now(): number { return this.options.now ? this.options.now() : Date.now() }

  private log(line: string): void { this.options.log?.(line) }

  private emit(event: LaneEvent, laneId: string, detail: string): void {
    try { this.options.onEvent?.(event, laneId, detail) } catch { /* an audit sink must not break a lane */ }
  }

  private schedule(work: () => void, ms: number): () => void {
    if (this.options.schedule) return this.options.schedule(work, ms)
    const handle = setTimeout(work, ms)
    handle.unref?.()
    return () => clearTimeout(handle)
  }

  private handle(lane: Lane): LaneHandle {
    return { laneId: lane.laneId, driver: lane.driver, port: lane.port, profile: lane.profile, stateDir: lane.stateDir }
  }

  /**
   * Take a lane for one writer.
   *
   * Returns at once when the lane (or a free slot) exists, and otherwise waits
   * in FIFO order. `onQueued` is called once, exactly when this caller could
   * not start now, so the host can say "queued for a lane" instead of failing.
   */
  async acquire(laneId: string, onQueued?: () => void): Promise<LaneHandle> {
    if (this.closed) throw new Error('lane manager is closed')
    const lane = this.lanes.get(laneId)
    if (lane && !lane.closing) {
      if (lane.ready && lane.users === 0) {
        this.use(lane)
        return this.handle(lane)
      }
      return this.wait(laneId, onQueued)
    }
    if (this.lanes.size + this.opening >= this.maxLanes) this.evictIdle(laneId)
    if (this.lanes.size + this.opening < this.maxLanes) return this.open(laneId, onQueued)
    return this.wait(laneId, onQueued)
  }

  /** Is this writer's lane open (or opening) right now? */
  has(laneId: string): boolean {
    const lane = this.lanes.get(laneId)
    return Boolean(lane && !lane.closing)
  }

  /**
   * Free one slot for `forLaneId` by closing the least recently used IDLE lane.
   *
   * The cap counts live lanes, and a lane nobody is using is the cheapest one
   * to give up: its writer pays one page load if it ever comes back, while a
   * new writer would otherwise wait out the whole idle window. A lane that is
   * mid-turn, still opening, or wanted by a queued writer is never evicted.
   */
  private evictIdle(forLaneId: string): boolean {
    const wanted = new Set(this.waiters.map(waiter => waiter.laneId))
    let victim: Lane | undefined
    for (const lane of this.lanes.values()) {
      if (lane.closing || !lane.ready || lane.users > 0 || lane.laneId === forLaneId || wanted.has(lane.laneId)) continue
      if (!victim || lane.lastUsedAt < victim.lastUsedAt) victim = lane
    }
    if (!victim) return false
    const idleFor = Math.round((this.now - victim.lastUsedAt) / 1000)
    void this.close(victim.laneId, `evicted after ${idleFor}s idle: the cap (${this.maxLanes}) was full and another writer needed a lane`)
    return true
  }

  /** Give a lane back. The idle timer starts only when nobody else is waiting. */
  release(laneId: string): void {
    const lane = this.lanes.get(laneId)
    if (!lane || lane.closing) return
    lane.users = Math.max(0, lane.users - 1)
    lane.lastUsedAt = this.now
    if (lane.users === 0 && lane.ready) {
      lane.state = 'idle'
      lane.cancelIdle?.()
      lane.cancelIdle = undefined
    }
    // A waiter for THIS lane gets the window first; only then is an unused
    // window offered to a different writer by closing it.
    this.pump()
    if (lane.closing || this.lanes.get(laneId) !== lane || lane.users > 0) return
    // Bounded lifetime: a window that has served its turn budget or lived too
    // long is rotated before it can degrade. This is the proactive half of the
    // health policy; the idle timer is the reactive half.
    if (this.maxTurns > 0 && lane.turns >= this.maxTurns) {
      void this.close(laneId, `rotated after ${lane.turns} turns`)
      return
    }
    if (this.maxAgeMs > 0 && this.now - lane.since >= this.maxAgeMs) {
      void this.close(laneId, `rotated after ${Math.round((this.now - lane.since) / 1000)}s`)
      return
    }
    // A queued writer that needed a slot has already had one freed by pump()
    // above (LRU eviction), so this lane simply goes idle.
    if (lane.ready) {
      lane.cancelIdle = this.schedule(() => { void this.close(laneId, 'idle') }, this.idleMs)
    }
  }

  /** Close one lane now. The slot is free for the queue as soon as it is called. */
  async close(laneId: string, reason = 'idle'): Promise<void> {
    const lane = this.lanes.get(laneId)
    if (!lane) return
    if (lane.closePromise) return lane.closePromise
    lane.closing = true
    lane.state = 'closing'
    lane.cancelIdle?.()
    lane.cancelIdle = undefined
    this.lanes.delete(laneId)
    this.log(`lane "${laneId}": closing (${reason}); port ${lane.port}`)
    lane.closePromise = this.destroy(lane).then(detail => { this.emit('close', laneId, `${reason}${detail}`) })
    void this.writeRegistry()
    this.pump()
    await lane.closePromise
  }

  /** Close a lane whose page went bad, so the next acquire opens a clean one. */
  async recycle(laneId: string, reason: string): Promise<void> {
    this.emit('recycle', laneId, reason)
    await this.close(laneId, `recycled: ${reason}`)
  }

  status(): LaneStatus[] {
    return [...this.lanes.values()].map(lane => ({
      laneId: lane.laneId,
      port: lane.port,
      state: lane.state,
      users: lane.users,
      turns: lane.turns,
      since: new Date(lane.since).toISOString(),
      lastUsedAt: new Date(lane.lastUsedAt).toISOString(),
    }))
  }

  /**
   * Tell the shared driver which lane tabs are live; it closes every other
   * lane tab and lease.
   *
   * The cap is this manager's map, but tabs and lease files outlive it: a host
   * restart, a crashed close, or a writer that died mid-turn leaves a named tab
   * in the master window that nothing would ever close. The driver is the one
   * process that owns every lane tab of this browser, so the manager's list is
   * authoritative and the sweep can be exact rather than age-based.
   */
  async sweep(): Promise<number> {
    const shared = this.options.spawnLane ? undefined : this.options.sharedDriver?.()
    if (!shared || this.closed) return 0
    const keep = [...this.lanes.values()].filter(lane => !lane.closing).map(lane => lane.laneId)
    try {
      const reply = await shared.call({ op: 'sweep-lanes', keep }, { timeoutMs: 30_000 })
      const closed = Number((reply as { closed?: unknown }).closed) || 0
      if (reply.ok !== true && !/unknown op/i.test(String(reply.error ?? ''))) this.log(`lane sweep failed: ${String(reply.error ?? 'no reason')}`)
      if (closed > 0) this.log(`lane sweep closed ${closed} tab(s) no live lane owns`)
      return closed
    } catch (error) {
      this.log(`lane sweep failed: ${(error as Error).message}`)
      return 0
    }
  }

  /** Arm the periodic sweep once a shared lane exists. */
  private armSweep(): void {
    if (this.cancelSweep || this.closed || this.sweepEveryMs <= 0) return
    if (this.options.spawnLane || !this.options.sharedDriver) return
    const tick = (): void => {
      this.cancelSweep = this.schedule(() => {
        void this.sweep().finally(() => { if (!this.closed) tick() })
      }, this.sweepEveryMs)
    }
    tick()
  }

  /** Close every lane; the host is stopping. */
  async shutdown(): Promise<void> {
    this.closed = true
    this.cancelSweep?.()
    this.cancelSweep = undefined
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error('lane manager is closing'))
    await Promise.allSettled([...this.lanes.keys()].map(laneId => this.close(laneId, 'shutdown')))
  }

  /**
   * Kill lanes a crashed earlier host left behind.
   *
   * A lane is only killed when its own `chrome.pid` names a live process AND
   * that process's command line carries this lane's exact profile: the same
   * proof-of-ownership rule the driver uses before attaching. Anything that
   * cannot be proved is left alone; its directory is still removed, because it
   * cannot be adopted by a new host anyway.
   */
  async reapOrphans(): Promise<number> {
    let rows: { laneId?: string; profile?: string; stateDir?: string }[] = []
    try {
      const parsed = JSON.parse(await readFile(this.registryPath, 'utf8')) as { rows?: typeof rows }
      rows = Array.isArray(parsed?.rows) ? parsed.rows : []
    } catch { return 0 }
    let killed = 0
    for (const row of rows) {
      if (!row?.stateDir || !row?.profile) continue
      try {
        const pid = Number((await readFile(join(row.stateDir, 'chrome.pid'), 'utf8')).trim())
        if (alive(pid)) {
          const commandLine = await commandLineOf(pid)
          if (commandLine && commandLine.toLowerCase().includes(String(row.profile).toLowerCase())) {
            await killTree(pid)
            killed += 1
          }
        }
      } catch { /* no pid file, or unreadable: nothing provable */ }
      await rm(row.stateDir, { recursive: true, force: true }).catch(() => {})
    }
    await rm(this.registryPath, { force: true }).catch(() => {})
    if (killed > 0) this.log(`reaped ${killed} orphan lane browser(s) from an earlier host`)
    return killed
  }

  // --------------------------------------------------------------- internals

  private use(lane: Lane): void {
    lane.cancelIdle?.()
    lane.cancelIdle = undefined
    lane.users += 1
    lane.turns += 1
    lane.state = 'active'
    lane.lastUsedAt = this.now
  }

  private wait(laneId: string, onQueued?: () => void): Promise<LaneHandle> {
    return new Promise<LaneHandle>((resolve, reject) => {
      this.waiters.push({ laneId, resolve, reject, onQueued })
      onQueued?.()
      this.pump()
    })
  }

  /**
   * Open the browser and prove the branched login, retrying only when the
   * page is rate-limiting us.
   *
   * A 429 at open is the account asking for a pause, not a broken lane: sending
   * the next writer at it immediately turns one throttle into a burst. A real
   * refusal (signed out, no cookies) keeps its single attempt and its error.
   */
  private async warmLane(driver: DriverChild, laneId: string): Promise<DriverReply> {
    let reply = await driver.call({ op: 'warm' }, { timeoutMs: this.openTimeoutMs })
    for (let attempt = 1; reply.ok !== true && attempt < WARM_ATTEMPTS && this.rateLimited(reply); attempt++) {
      const wait = this.backoffBaseMs * 2 ** (attempt - 1)
      this.log(`lane "${laneId}": warm hit a rate limit; retrying in ${wait} ms (attempt ${attempt + 1}/${WARM_ATTEMPTS})`)
      await new Promise(resolve => setTimeout(resolve, wait))
      reply = await driver.call({ op: 'warm' }, { timeoutMs: this.openTimeoutMs })
    }
    return reply
  }

  private rateLimited(reply: DriverReply): boolean {
    return /429|rate.?limit|too many/i.test(`${String(reply.error ?? '')} ${String((reply as { reason?: unknown }).reason ?? '')}`)
  }

  /** A new lane: reserve capacity now, then open Chrome and branch the login. */
  private async open(laneId: string, onQueued?: () => void): Promise<LaneHandle> {
    if (this.closed) throw new Error('lane manager is closed')
    if (this.lanes.size + this.opening >= this.maxLanes) {
      if (onQueued) onQueued()
      return this.wait(laneId, onQueued)
    }
    this.opening += 1
    let lane: Lane | undefined
    let port = 0
    try {
      // A shared lane has no port of its own: it is a tab in the master
      // browser, so the master's port is the honest answer in a status row and
      // there is nothing to reserve or collide over.
      port = this.options.sharedBrowser ? this.sourcePort : await this.nextPort()
      // One process for every inputter: the shared child owns each lane's tab
      // and this handle is a facade that stamps the lane on every request, so
      // `destroy` closes only the tab and never the process.
      const shared = this.options.spawnLane ? undefined : this.options.sharedDriver?.()
      const stateDir = join(this.options.root, `${safeName(laneId)}-${randomUUID().slice(0, 8)}`)
      const profile = join(stateDir, 'profile')
      // A shared lane needs no per-writer profile or state directory: its tab
      // lives in the master browser and its log is the shared child's.
      if (!shared) await mkdir(profile, { recursive: true })
      const env: Record<string, string> = {
        CHATGPT_CDP_PORT: String(port),
        CHATGPT_PROFILE: profile,
        CHATGPT_STATE_DIR: stateDir,
        CHATGPT_LANE_ID: laneId,
        CHATGPT_LANE_SOURCE_PORT: String(this.sourcePort),
        CHATGPT_LANE_SYNC_COOKIES: this.options.syncCookies === false ? '0' : '1',
        ...(this.options.sharedBrowser
          ? {
              CHATGPT_LANE_SHARED: '1',
              CHATGPT_LANE_SHARED_DIR: this.options.root,
              ...(this.options.sourceProfile ? { CHATGPT_LANE_SOURCE_PROFILE: this.options.sourceProfile } : {}),
            }
          : {}),
      }
      const driver = this.options.spawnLane
        ? this.options.spawnLane({ laneId, port, profile, stateDir, env })
        : shared
          ? laneDriver(shared, laneId)
          : new DriverChild({
              script: this.options.driverScript,
              profile,
              log: this.log.bind(this),
              timeoutMs: 20 * 60_000,
              env,
            })
      lane = {
        laneId,
        port,
        profile,
        stateDir,
        driver,
        shared: Boolean(shared),
        users: 0,
        turns: 0,
        ready: false,
        state: 'opening',
        since: this.now,
        lastUsedAt: this.now,
        closing: false,
      }
      this.lanes.set(laneId, lane)
      this.reservedPorts.delete(port)
      void this.writeRegistry()
      this.emit('open', laneId, `port ${port}`)
      this.log(`lane "${laneId}": opening on port ${port}`)
      const warm = await this.warmLane(driver, laneId)
      if (warm.ok !== true) throw new Error(`lane "${laneId}" did not warm: ${String(warm.error ?? 'no reason')}`)
      lane.ready = true
      lane.state = 'active'
      lane.users = 1
      // The open itself serves the caller's first turn; count it, or a lane
      // would always be one turn short of its rotation budget.
      lane.turns = 1
      lane.lastUsedAt = this.now
      this.emit('ready', laneId, `signedIn=${warm.signedIn === true} plan=${String(warm.plan ?? 'unknown')}`)
      this.log(`lane "${laneId}": ready on port ${port} (plan ${String(warm.plan ?? 'unknown')})`)
      if (shared) {
        this.armSweep()
        // A new tab is the moment a leftover one costs the most (another page
        // in the same renderer budget), so sweep now, not only on the timer.
        void this.sweep()
      }
      return this.handle(lane)
    } catch (error) {
      if (lane) {
        this.lanes.delete(laneId)
        await this.destroy(lane)
      }
      this.emit('failed', laneId, (error as Error).message)
      this.log(`lane "${laneId}": open failed: ${(error as Error).message}`)
      throw error
    } finally {
      if (port) this.reservedPorts.delete(port)
      this.opening = Math.max(0, this.opening - 1)
      this.pump()
    }
  }

  private pump(): void {
    if (this.closed) return
    let index = 0
    while (index < this.waiters.length) {
      const waiter = this.waiters[index]!
      const lane = this.lanes.get(waiter.laneId)
      if (lane && !lane.closing) {
        if (lane.ready && lane.users === 0) {
          this.waiters.splice(index, 1)
          this.use(lane)
          waiter.resolve(this.handle(lane))
          continue
        }
        // Busy or still opening: stay queued behind this lane.
        index += 1
        continue
      }
      if (this.lanes.size + this.opening >= this.maxLanes && this.evictIdle(waiter.laneId)) {
        // The eviction may have re-entered pump() and served this waiter
        // already; look at the same index again rather than assume.
        continue
      }
      if (this.lanes.size + this.opening < this.maxLanes) {
        this.waiters.splice(index, 1)
        void this.open(waiter.laneId).then(waiter.resolve, waiter.reject)
        continue
      }
      index += 1
    }
  }

  /** Unload (which writes cookies back), terminate, and remove the profile. */
  private async destroy(lane: Lane): Promise<string> {
    let detail = ''
    try {
      // The facade carries this lane's id, so the shared child closes THIS
      // tab; a per-lane child has the id in its env and ignores the field.
      const reply = await lane.driver.call({ op: 'unload' }, { timeoutMs: this.closeTimeoutMs })
      if (lane.shared) return detail
      const synced = Number((reply as { cookiesSynced?: unknown }).cookiesSynced)
      if (Number.isFinite(synced) && synced > 0) detail = `; cookies written back: ${synced}`
      else if (typeof (reply as { cookieSync?: unknown }).cookieSync === 'string') {
        detail = `; cookie sync ${String((reply as { cookieSync?: unknown }).cookieSync)}`
      }
    } catch (error) {
      this.log(`lane "${lane.laneId}": unload failed: ${(error as Error).message}`)
    }
    if (lane.shared) return detail
    try { await lane.driver.terminate() } catch { /* already gone */ }
    await rm(lane.stateDir, { recursive: true, force: true }).catch(() => {})
    return detail
  }

  /** The first free lane port at or above the base, skipping live lanes. */
  private async nextPort(): Promise<number> {
    const used = new Set([...this.lanes.values()].map(lane => lane.port))
    for (const reserved of this.reservedPorts) used.add(reserved)
    const limit = this.basePort + this.maxLanes * 4 + 16
    for (let port = this.basePort; port < limit; port++) {
      if (used.has(port)) continue
      if (!(await portFree(port))) continue
      this.reservedPorts.add(port)
      return port
    }
    throw new Error(`no free lane port between ${this.basePort} and ${limit}`)
  }

  private async writeRegistry(): Promise<void> {
    const rows = [...this.lanes.values()].map(lane => ({
      laneId: lane.laneId,
      port: lane.port,
      profile: lane.profile,
      stateDir: lane.stateDir,
      since: new Date(lane.since).toISOString(),
    }))
    try {
      await mkdir(this.options.root, { recursive: true })
      await writeFile(this.registryPath, JSON.stringify({ rows }, null, 2))
    } catch (error) {
      this.log(`lane registry write failed: ${(error as Error).message}`)
    }
  }
}

/** Is `port` listening? Exported for tests and the host's health report. */
export function portListening(port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise(resolve => {
    const socket = netConnect({ host: '127.0.0.1', port })
    let settled = false
    const finish = (value: boolean) => { if (!settled) { settled = true; clearTimeout(timer); socket.destroy(); resolve(value) } }
    const timer = setTimeout(() => finish(false), timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}
