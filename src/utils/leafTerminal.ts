import { PassThrough, Writable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import type { LeafMember } from './leafFamily.js'
import type { LeafProcessState } from './leafProcess.js'
import { serveLeafChannel, type LeafChannel } from './leafChannel.js'
import { registerCleanup } from './cleanupRegistry.js'

export type LeafSnapshot = {
  rootSessionId: string
  rootName: string
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
       * `question` is the peer text being answered, so the parent can match the
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
// The last state this leaf published, so a session that arrives later learns
// what it is doing without waiting for the next turn boundary to change it.
let lastState: LeafProcessState | undefined

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
 * Whether this process is a leaf.
 *
 * This is the environment's answer alone. It used to also require
 * `process.send`, which made being a leaf the same thing as being somebody's
 * child - a leaf could not exist without a parent process holding the other end
 * of its IPC pipe. The transport is a socket now, so identity and transport are
 * independent: this says what the session *is*, not who launched it.
 */
export function isInteractiveLeaf(): boolean { return process.env.GATEWAY_INTERACTIVE_LEAF === '1' }
export function getLeafSnapshot(): LeafSnapshot | undefined { return snapshot }
export function subscribeLeafSnapshot(listener: () => void): () => void { snapshotListeners.add(listener); return () => { snapshotListeners.delete(listener) } }
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
  const colorDepth = Math.min(Number(process.env.GATEWAY_LEAF_COLOR_DEPTH) || 0, 3)
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
    columns: Number(process.env.GATEWAY_LEAF_COLUMNS) || 80,
    rows: Number(process.env.GATEWAY_LEAF_ROWS) || 24,
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
      snapshot = message.snapshot
      for (const listener of snapshotListeners) listener()
      return
    }
    if (message.type === 'leaf-response') {
      const pending = requests.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      requests.delete(message.id)
      if (message.ok) pending.resolve(message.value)
      else pending.reject(new Error('Leaf workspace action failed; saved sessions are retained'))
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
  const sessionId = process.env.GATEWAY_LEAF_SESSION ?? ''
  if (sessionId) {
    // Say goodbye while there is still a socket to say it on, so the session
    // watching this leaf can tell a deliberate exit from a kill.
    registerCleanup(async () => { sendLeafTerminal({ type: 'leaf-exit', code: 0 }) })
    serveLeafChannel({
      sessionId,
      identify: () => ({ sessionId, pid: process.pid, label: process.env.GATEWAY_LEAF_LABEL, state: lastState }),
      onMessage: message => handle(message as LeafTerminalMessage),
      onAttach: attached => { client = attached },
      // A detaching session takes its worker messages with it: they were asked
      // for by a conversation that is no longer there to receive the answer.
      onDetach: () => {
        client = undefined
        active = false
        instances.get(process.stdout)?.pause()
        for (const pending of requests.values()) { clearTimeout(pending.timer); pending.reject(new Error('Leaf workspace disconnected')) }
        requests.clear()
      },
    })
  }
}
