import { PassThrough, Writable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { connect } from 'node:net'
import type { LeafMember } from './leafFamily.js'
import type { LeafProcessState } from './leafProcess.js'
import { serveLeafChannel, type LeafChannel } from './leafChannel.js'
import { registerCleanup } from './cleanupRegistry.js'

export type LeafSnapshot = {
  rootSessionId: string
  patriarchName: string
  /** Which member is the family's patriarch now; the family id until one is designated. */
  patriarchSessionId: string
  /** The member being raised as the family's next patriarch, if any. */
  heirSessionId?: string
  /** Members that have held the patriarch role and given it up, in the order they held it. */
  formerPatriarchIds?: readonly string[]
  /** Members the family has designated as drivers, each mapped to the leaves it drives. */
  driverScope?: Readonly<Record<string, readonly string[]>>
  /** Members the head has delegated the ledger's pen to, as last read. */
  ledgerWriterIds?: readonly string[]
  /** The session managing this family, so a leaf can tell when the family moved. */
  matriarchSessionId: string
  matriarchName: string
  members: { member: LeafMember; state: LeafProcessState }[]
}
export type LeafTerminalControl = { subtype: string; [key: string]: unknown }
export type LeafTerminalMessage =
  | { type: 'leaf-output'; epoch: number; data: string }
  | { type: 'leaf-state'; state: LeafProcessState; draft?: string }
  | {
      /**
       * The leaf's own answer to a peer message, sent the moment the answer
       * exists rather than when the whole turn ends. Without this a peer waits
       * for the leaf to finish everything it was already doing, which is the
       * "no proper awareness" complaint.
       *
       * `question` is the peer text being answered, so the asker can match the
       * answer to the right ask. Several questions can be in flight at once now
       * that a running leaf takes them immediately, and "oldest still owed"
       * would answer the wrong asker when the leaf replies out of order.
       */
      type: 'leaf-answered'
      question: string
      answer: string
    }
  | { type: 'leaf-request'; id: string; action: string; args: unknown[] }
  /**
   * The leaf is on its way out, deliberately.
   *
   * Only a parent is told a detached process's exit status, and the whole point
   * of this transport is that the session watching a leaf is not its parent. So
   * the member reports its own exit, and a session that never hears this knows
   * the member was killed rather than closed.
   */
  | { type: 'leaf-exit'; code: number }
  | { type: 'leaf-response'; id: string; ok: boolean; value?: unknown }
  | { type: 'leaf-control'; id: string; request: LeafTerminalControl }
  | { type: 'leaf-control-response'; id: string; ok: boolean }
  | { type: 'leaf-focus'; active: boolean; epoch: number; columns: number; rows: number }
  | { type: 'leaf-input'; data: string }
  | { type: 'leaf-resize'; columns: number; rows: number }
  | { type: 'leaf-snapshot'; snapshot: LeafSnapshot }

let snapshot: LeafSnapshot | undefined
const snapshotListeners = new Set<() => void>()
const requests = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
let controls: ((request: LeafTerminalControl) => Promise<void>) | undefined
const pendingControls: Extract<LeafTerminalMessage, { type: 'leaf-control' }>[] = []
let initialDraft = ''
let wakeInput: (() => void) | undefined
// The session currently watching this leaf, if any. Unset is a normal state, not
// a failure: a leaf whose session closed keeps running with nobody attached and
// is picked up again by whoever opens it next.
let client: LeafChannel | undefined
// When the last attached session went away, or when this process started if
// nobody has ever attached. Undefined while a session is attached, so the pair
// with `client` is always consistent.
let clientDetachedAt: number | undefined
const processStartedAt = Date.now()
// The last state this leaf published, so a session that arrives later learns
// what it is doing without waiting for the next turn boundary to change it.
let lastState: LeafProcessState | undefined

/**
 * Whether a session is watching this leaf.
 *
 * Being detached is the ordinary "paused, waiting to be picked up" state, and
 * that is precisely why it cannot be the whole signal for closing a leaf: a
 * leaf between owners must survive long enough for the next one to attach.
 */
export function isLeafClientAttached(): boolean {
  return client !== undefined
}

/** How long this leaf has had nobody attached; 0 while someone is. */
export function leafIdleMs(): number {
  if (client !== undefined) return 0
  return Date.now() - (clientDetachedAt ?? processStartedAt)
}

/**
 * Bring the leaf's REPL back to life without typing anything into it.
 *
 * A leaf that is not focused is paused, so its own command queue only drains
 * once the REPL is rendering again. Delivering a peer message through the queue
 * - rather than as keystrokes - is what keeps its "not the user" marking, but
 * that message still needs this nudge to run, or it sits there until the human
 * happens to focus the leaf. Nothing is written to the input, so the message is
 * never mistaken for something the person typed.
 */
export function wakeLeafInput(): void {
  if (!wakeInput) throw new Error('Leaf input channel is unavailable')
  wakeInput()
}

/**
 * What this process was launched as, kept once the environment it arrived in
 * has been cleaned up. Undefined until consumeLeafLaunchEnv() runs.
 */
type LeafLaunch = {
  interactive: boolean
  sessionId: string | undefined
  label: string | undefined
  trusted: boolean
  transcript: string | undefined
  columns: number
  rows: number
  colorDepth: number
  /**
   * Where the session that started this leaf answers, and the secret that says
   * the answer is really from it. Absent when nothing owns this leaf - a leaf
   * started from source or by a test - in which case there is no owner to
   * outlive and no watchdog to run.
   */
  ownerEndpoint: string | undefined
  ownerToken: string | undefined
}
let launch: LeafLaunch | undefined

/**
 * Whether this process is a leaf.
 *
 * This is the environment's answer alone. It used to also require
 * `process.send`, which made being a leaf the same thing as being somebody's
 * child - a leaf could not exist without a parent process holding the other end
 * of its IPC pipe. The transport is a socket now, so identity and transport are
 * independent: this says what the session *is*, not who launched it.
 *
 * Being a leaf is a fact about the process the family started, and the answer is
 * only about this process: a child of a leaf is not a leaf, which is why the
 * launch environment is taken back out of it (consumeLeafLaunchEnv) the moment
 * the leaf owns it. Inherited, it made every child a leaf - a nested CLI
 * replaced its own stdout with the leaf's channel, so it printed nothing at all
 * and reported success, and on a platform where the channel is a socket file it
 * unlinked and rebound the leaf's own address out from under the leaf.
 */
export function isInteractiveLeaf(): boolean { return launch ? launch.interactive : process.env.GATEWAY_INTERACTIVE_LEAF === '1' }
export function leafSessionId(): string | undefined { return launch ? launch.sessionId : process.env.GATEWAY_LEAF_SESSION }
export function leafLabel(): string | undefined { return launch ? launch.label : process.env.GATEWAY_LEAF_LABEL }
export function leafTrusted(): boolean { return launch ? launch.trusted : process.env.GATEWAY_LEAF_TRUSTED === '1' }
export function leafTranscript(): string | undefined { return launch ? launch.transcript : process.env.GATEWAY_LEAF_TRANSCRIPT }
function leafOwnerEndpoint(): string | undefined { return launch ? launch.ownerEndpoint : process.env.GATEWAY_LEAF_OWNER_ENDPOINT }
function leafOwnerToken(): string | undefined { return launch ? launch.ownerToken : process.env.GATEWAY_LEAF_OWNER_TOKEN }
export function leafViewport(): { columns: number; rows: number; colorDepth: number } {
  const reading = launch ?? { columns: Number(process.env.GATEWAY_LEAF_COLUMNS) || 80, rows: Number(process.env.GATEWAY_LEAF_ROWS) || 24, colorDepth: Math.min(Number(process.env.GATEWAY_LEAF_COLOR_DEPTH) || 0, 3) }
  return { columns: reading.columns, rows: reading.rows, colorDepth: reading.colorDepth }
}
/**
 * Take the launch environment out of this process, so nothing it starts can
 * inherit it. The leaf keeps every answer; its children get none.
 *
 * Read once and kept, because the environment is the one thing a leaf hands to
 * every command it runs: these arrive on the launch and describe the process the
 * family started, not the tools it then goes on to run. FORCE_COLOR is the one
 * exception - it is not about being a leaf, and a child that draws to this
 * terminal wants it as much as the leaf does.
 */
export function consumeLeafLaunchEnv(): void {
  if (launch) return
  launch = {
    interactive: process.env.GATEWAY_INTERACTIVE_LEAF === '1',
    sessionId: process.env.GATEWAY_LEAF_SESSION,
    label: process.env.GATEWAY_LEAF_LABEL,
    trusted: process.env.GATEWAY_LEAF_TRUSTED === '1',
    transcript: process.env.GATEWAY_LEAF_TRANSCRIPT,
    ownerEndpoint: process.env.GATEWAY_LEAF_OWNER_ENDPOINT,
    ownerToken: process.env.GATEWAY_LEAF_OWNER_TOKEN,
    ...leafViewport(),
  }
  delete process.env.GATEWAY_INTERACTIVE_LEAF
  delete process.env.GATEWAY_LEAF_SESSION
  delete process.env.GATEWAY_LEAF_LABEL
  delete process.env.GATEWAY_LEAF_TRUSTED
  delete process.env.GATEWAY_LEAF_TRANSCRIPT
  delete process.env.GATEWAY_LEAF_COLUMNS
  delete process.env.GATEWAY_LEAF_ROWS
  delete process.env.GATEWAY_LEAF_COLOR_DEPTH
  delete process.env.GATEWAY_LEAF_OWNER_ENDPOINT
  delete process.env.GATEWAY_LEAF_OWNER_TOKEN
}

const OWNER_PROBE_INTERVAL_MS = 5000
const OWNER_PROBE_TIMEOUT_MS = 3000

/**
 * Whether the session that started this leaf is still there.
 *
 * The owner answers on a private endpoint with a secret only the two of them
 * hold. A PID would be cheaper and wrong: the system hands a dead process's
 * number to the next one it starts, so a recycled PID reads as an owner that
 * never died, and the leaf would outlive the very thing it is tied to. A pipe
 * has no such gap - when the owner's process ends, its pipe goes with it.
 *
 * Only failing to reach the endpoint at all counts as gone. A busy owner still
 * holds the endpoint open, so a timeout, a reset, or a pipe whose instances are
 * all busy is a live owner that could not answer in time; reading those as death
 * would let a busy session take its own leaves down.
 */
function leafOwnerAlive(): Promise<boolean> {
  const endpoint = leafOwnerEndpoint()
  const token = leafOwnerToken()
  if (!endpoint || !token) return Promise.resolve(true)
  return new Promise(resolve => {
    const socket = connect(endpoint)
    let settled = false
    let answer = ''
    const done = (alive: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(alive)
    }
    socket.setTimeout(OWNER_PROBE_TIMEOUT_MS, () => done(true))
    socket.on('data', chunk => { answer += chunk.toString() })
    socket.on('close', () => done(answer.trim() === token))
    socket.on('error', error => {
      const code = (error as NodeJS.ErrnoException).code
      done(code !== 'ENOENT' && code !== 'ECONNREFUSED')
    })
  })
}

/**
 * End this leaf when the session that owns it ends.
 *
 * A leaf outliving its launcher is the ordinary case for the transport - the
 * launcher exiting is only "nobody is watching", and the leaf is picked up again
 * by whoever opens it next. That is the right answer for a leaf that owns
 * itself, and the wrong one for the matriarch: the leaves belong to that
 * session, so when it crashes, is Ctrl-C'd, or its terminal closes, they go with
 * it rather than sitting detached with no family left to belong to.
 */
function watchLeafOwner(): void {
  if (!leafOwnerEndpoint()) return
  const timer = setInterval(() => {
    void leafOwnerAlive().then(alive => {
      if (alive) return
      clearInterval(timer)
      void import('./gracefulShutdown.js').then(({ gracefulShutdown }) => gracefulShutdown(0))
    })
  }, OWNER_PROBE_INTERVAL_MS)
  timer.unref()
}

/**
 * Bind a leaf that has no terminal to the session that owns it.
 *
 * An interactive leaf gets both halves of this on the way up: installLeafTerminal
 * consumes the launch environment and calls watchLeafOwner. A headless partner
 * installs no terminal, so it took neither - it kept GATEWAY_LEAF_* in the
 * environment every tool it ran inherited, and it held an owner endpoint it
 * never watched, so it outlived the leaf that started it. Owning is a property
 * of the launch, not of having a terminal: a headless leaf takes the same two
 * steps here, in the same order, so leafOwnerEndpoint() reads the value the
 * consume call has just cached rather than the environment it just deleted.
 */
export function adoptHeadlessLeafOwner(): void {
  consumeLeafLaunchEnv()
  watchLeafOwner()
}
export function getLeafSnapshot(): LeafSnapshot | undefined { return snapshot }
export function subscribeLeafSnapshot(listener: () => void): () => void { snapshotListeners.add(listener); return () => { snapshotListeners.delete(listener) } }

/** Take the host's snapshot as this leaf's roster and display state. */
export function adoptLeafSnapshot(next: LeafSnapshot): void {
  snapshot = next
  for (const listener of snapshotListeners) listener()
}

/**
 * Re-seed the snapshot's designation fields from the designation just read.
 *
 * A leaf's snapshot is published by the session hosting the family, so it is
 * only as fresh as the last publish - and a designation that moves while the
 * leaf is up stays invisible until that host republishes. The designation
 * itself is on disk, where any process can read it, so a process that reads it
 * brings its display cache up to the same answer instead of going on naming a
 * head that has left. Only designations are taken: membership and member state
 * are the host's facts, and this process does not own the member processes.
 *
 * The rows and the names are untouched deliberately. A designation names a
 * member; what that member is called is read with the roster, and rewriting it
 * from a bare id here would rename a row on the strength of a narrowed read.
 */
export function adoptLeafDesignation(designation: Partial<Pick<LeafSnapshot,
  'patriarchSessionId' | 'heirSessionId' | 'formerPatriarchIds' | 'driverScope' | 'ledgerWriterIds'>>): void {
  if (!snapshot) return
  snapshot = { ...snapshot, ...designation }
  for (const listener of snapshotListeners) listener()
}
export function consumeLeafInitialDraft(): string { const value = initialDraft; initialDraft = ''; return value }
export function sendLeafTerminal(message: LeafTerminalMessage): void {
  if (message.type === 'leaf-state') lastState = message.state
  client?.send(message)
}
export function requestLeafWorkspace<T>(action: string, args: unknown[] = []): Promise<T> {
  // No attached session means nobody is displaying this leaf, so there is no
  // workspace to ask. Saying so is honest; the leaf itself keeps running.
  if (!isInteractiveLeaf() || !client) return Promise.reject(new Error('Leaf workspace disconnected'))
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { requests.delete(id); reject(new Error('Leaf workspace request timed out')) }, 90000)
    requests.set(id, { resolve, reject, timer })
    sendLeafTerminal({ type: 'leaf-request', id, action, args })
  })
}
async function handleControl(message: Extract<LeafTerminalMessage, { type: 'leaf-control' }>): Promise<void> {
  try {
    await controls!(message.request)
    sendLeafTerminal({ type: 'leaf-control-response', id: message.id, ok: true })
  } catch { sendLeafTerminal({ type: 'leaf-control-response', id: message.id, ok: false }) }
}
export function registerLeafTerminalControls(handler: (request: LeafTerminalControl) => Promise<void>): () => void {
  controls = handler
  for (const message of pendingControls.splice(0)) void handleControl(message)
  return () => { if (controls === handler) controls = undefined }
}

/**
 * Have this leaf leave, on its own word rather than a session's.
 *
 * Closing the session you are in is the one close a leaf performs rather than
 * asks for: the process that would be stopped is the one typing, so there is
 * nobody to ask. It runs the same leaving a session-issued close does - the
 * transcript is recorded, the queues are drained and the process exits - so the
 * two doors cannot drift apart.
 */
export function requestLeafSelfClose(): Promise<void> {
  if (!controls) return Promise.reject(new Error('Leaf shutdown is unavailable'))
  return controls({ subtype: 'shutdown' })
}

/** Installed before CLI imports: the normal REPL owns these streams, not a second chat renderer. */
export async function installLeafTerminal(): Promise<void> {
  // A leaf's fd 1 is a pipe to the session that owns it, and chalk decides its
  // colour level from tty.isatty(1) — not from process.stdout. Level 0 makes
  // applyTextStyles emit nothing, so every theme colour is dropped and the leaf
  // renders black and white even though its bytes are drawn by the owner's real,
  // colour-capable terminal. Adopt the owner's own depth instead, skipped when
  // the user already asked for no colour.
  //
  // This is the fallback, not the production path. chalk reads the environment
  // once, when it is loaded, and the bundled CLI has already loaded it by the
  // time this runs, so what actually colours a leaf is the FORCE_COLOR the owner
  // puts in its environment at launch. This binds for an unbundled leaf — the
  // tests, and a leaf started from source.
  const { columns: startColumns, rows: startRows, colorDepth } = leafViewport()
  if (colorDepth > 0 && !('FORCE_COLOR' in process.env) && !process.env.NO_COLOR) {
    process.env.FORCE_COLOR = String(colorDepth)
  }
  const { default: instances } = await import('../ink/instances.js')
  let active = false
  let epoch = 0
  const input = Object.assign(new PassThrough(), {
    isTTY: true, isRaw: false, fd: 0,
    setRawMode(mode: boolean) { this.isRaw = mode; return this },
    ref() { return this }, unref() { return this },
  })
  const output = Object.assign(new Writable({
    write(chunk, _encoding, callback) {
      if (active) sendLeafTerminal({ type: 'leaf-output', epoch, data: chunk.toString() })
      callback()
    },
  }), {
    isTTY: true, fd: 1,
    columns: startColumns,
    rows: startRows,
    getColorDepth: () => colorDepth || 1, hasColors: () => colorDepth > 0,
    getWindowSize() { return [this.columns, this.rows] },
  })
  Object.defineProperty(process, 'stdin', { configurable: true, value: input })
  Object.defineProperty(process, 'stdout', { configurable: true, value: output })
  // A background leaf is paused by leaf-focus; a delivery wakes its REPL
  // without stealing the parent's rendering (unfocused frames are dropped
  // upstream). No input is written - the message goes through the queue so it
  // keeps its "not the user" attribution.
  wakeInput = () => {
    instances.get(process.stdout)?.resume()
    input.setRawMode(true)
    input.resume()
  }
  const stderr = Object.assign(new Writable({ write(chunk, _encoding, callback) { output.write(chunk, callback) } }), { isTTY: true, fd: 2 })
  Object.defineProperty(process, 'stderr', { configurable: true, value: stderr })
  // A leaf needs a repaintable viewport; the original can retain its inline scrollback.
  process.env.CLAUDE_CODE_NO_FLICKER = '1'
  initialDraft = process.env.GATEWAY_LEAF_DRAFT ?? ''
  delete process.env.GATEWAY_LEAF_DRAFT
  watchLeafOwner()
  const resize = (columns: number, rows: number) => {
    if (columns === output.columns && rows === output.rows) return
    output.columns = Math.max(20, columns)
    output.rows = Math.max(8, rows)
    output.emit('resize')
  }
  const handle = (message: LeafTerminalMessage) => {
    if (!message || typeof message !== 'object') return
    if (message.type === 'leaf-input') {
      if (active) input.write(message.data)
      return
    }
    if (message.type === 'leaf-resize') { resize(message.columns, message.rows); return }
    if (message.type === 'leaf-focus') {
      const ink = instances.get(process.stdout)
      active = message.active
      epoch = message.epoch
      if (!active) { ink?.pause(); return }
      input.setRawMode(true)
      input.resume()
      resize(message.columns, message.rows)
      output.write('\x1b[?1049h\x1b[?2004h\x1b[?1004h')
      ink?.resume()
      ink?.reassertTerminalModes()
      ink?.forceRedraw()
      return
    }
    if (message.type === 'leaf-snapshot') {
      adoptLeafSnapshot(message.snapshot)
      return
    }
    if (message.type === 'leaf-response') {
      const pending = requests.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      requests.delete(message.id)
      if (message.ok) pending.resolve(message.value)
      // One opaque string covered four unrelated causes - an unavailable
      // matriarch, a busy target, a bad reference - so a refusal could not be told
      // apart from a broken workspace. The session that owns the family reports
      // what actually failed; the generic line is only the fallback for a
      // refusal that carried no reason.
      else pending.reject(new Error(typeof message.value === 'string' && message.value.trim()
        ? `Leaf workspace action failed: ${message.value.trim().slice(0, 300)}`
        : 'Leaf workspace action failed; saved sessions are retained'))
      return
    }
    if (message.type === 'leaf-control') {
      if (controls) void handleControl(message)
      else if (pendingControls.length < 32) pendingControls.push(message)
    }
  }
  // This leaf's own address. A session reaches it here rather than through a
  // pipe it has to keep alive, which is what lets the leaf outlive whoever
  // started it: the launcher exiting closes a socket, and a closed socket is
  // only "nobody is watching", not a shutdown.
  const sessionId = leafSessionId() ?? ''
  if (sessionId) {
    // Say goodbye while there is still a socket to say it on, so the session
    // watching this leaf can tell a deliberate exit from a kill.
    registerCleanup(async () => { sendLeafTerminal({ type: 'leaf-exit', code: 0 }) })
    serveLeafChannel({
      sessionId,
      identify: () => ({ sessionId, pid: process.pid, label: leafLabel(), state: lastState }),
      onMessage: message => handle(message as LeafTerminalMessage),
      onAttach: attached => { client = attached; clientDetachedAt = undefined },
      // A detaching session takes its worker messages with it: they were asked
      // for by a conversation that is no longer there to receive the answer.
      onDetach: () => {
        client = undefined
        clientDetachedAt = Date.now()
        active = false
        instances.get(process.stdout)?.pause()
        for (const pending of requests.values()) { clearTimeout(pending.timer); pending.reject(new Error('Leaf workspace disconnected')) }
        requests.clear()
      },
    })
  }
}
