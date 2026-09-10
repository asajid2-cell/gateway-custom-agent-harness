import { PassThrough, Writable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import type { LeafMember } from './leafFamily.js'
import type { LeafProcessState } from './leafProcess.js'

export type LeafSnapshot = {
  rootSessionId: string
  rootName: string
  members: { member: LeafMember; state: LeafProcessState }[]
}
export type LeafTerminalControl = { subtype: string; [key: string]: unknown }
export type LeafTerminalMessage =
  | { type: 'leaf-output'; epoch: number; data: string }
  | { type: 'leaf-state'; state: LeafProcessState; draft?: string }
  | { type: 'leaf-request'; id: string; action: string; args: unknown[] }
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

export function isInteractiveLeaf(): boolean { return process.env.GATEWAY_INTERACTIVE_LEAF === '1' && typeof process.send === 'function' }
export function getLeafSnapshot(): LeafSnapshot | undefined { return snapshot }
export function subscribeLeafSnapshot(listener: () => void): () => void { snapshotListeners.add(listener); return () => { snapshotListeners.delete(listener) } }
export function consumeLeafInitialDraft(): string { const value = initialDraft; initialDraft = ''; return value }
export function sendLeafTerminal(message: LeafTerminalMessage): void {
  if (process.connected) process.send?.(message, () => {})
}
export function requestLeafWorkspace<T>(action: string, args: unknown[] = []): Promise<T> {
  if (!isInteractiveLeaf() || !process.connected) return Promise.reject(new Error('Leaf workspace disconnected'))
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
    getColorDepth: () => 24, hasColors: () => true,
    getWindowSize() { return [this.columns, this.rows] },
  })
  Object.defineProperty(process, 'stdin', { configurable: true, value: input })
  Object.defineProperty(process, 'stdout', { configurable: true, value: output })
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
  process.on('message', (raw: unknown) => {
    const message = raw as LeafTerminalMessage
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
  })
  process.once('disconnect', () => {
    for (const pending of requests.values()) { clearTimeout(pending.timer); pending.reject(new Error('Leaf workspace disconnected')) }
    requests.clear()
    void import('./gracefulShutdown.js').then(({ gracefulShutdown }) => gracefulShutdown(0))
  })
}
