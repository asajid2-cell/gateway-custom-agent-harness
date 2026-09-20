import instances from '../ink/instances.js'
import { isLeafProcessAlive, type LeafProcess } from './leafProcess.js'

let current: LeafProcess | undefined
let epoch = 0
let restoreOutput: (() => void) | undefined
let writeTerminal: ((text: string) => void) | undefined
let rootInk: ReturnType<typeof instances.get>

const dimensions = () => ({ columns: process.stdout.columns || 80, rows: process.stdout.rows || 24 })
const input = (data: Buffer | string) => {
  try { current?.input(data.toString()) } catch { /* Exit notification restores the root. */ }
}
const resize = () => {
  if (!current) return
  try { current.terminal({ type: 'leaf-resize', ...dimensions() }) } catch { /* Exit notification restores the root. */ }
}

/** Undo the handoff: this session's own writers, keyboard and screen come back. */
function restoreSessionTerminal(): void {
  if (!restoreOutput) return
  process.stdin.off('data', input)
  process.stdout.off('resize', resize)
  restoreOutput()
  restoreOutput = undefined
  writeTerminal = undefined
  rootInk?.exitAlternateScreen()
  rootInk = undefined
}

/**
 * Hand the terminal to a leaf, or leave it with this session.
 *
 * Returns whether the leaf took the terminal. Only this session family hands
 * off the terminal; no user process is suspended or restarted.
 */
export function focusLeafTerminal(next?: LeafProcess): boolean {
  if (next === current) return true
  // A leaf whose process has ended cannot take the terminal, and asking anyway
  // used to mute this session for it before the attempt: the screen went black
  // with no way back. Refusing before the handoff is what makes an entry for a
  // closed leaf harmless.
  if (next && !isLeafProcessAlive(next.getState())) return false
  const previous = current
  const size = dimensions()
  if (previous) {
    try { previous.focus(false, epoch, size.columns, size.rows) } catch { /* A failed leaf can still be switched away from. */ }
  }
  if (next && !current) {
    rootInk = instances.get(process.stdout)
    if (!rootInk) return false
    rootInk.enterAlternateScreen()
    const stdoutWrite = process.stdout.write
    const stderrWrite = process.stderr.write
    writeTerminal = text => { stdoutWrite.call(process.stdout, text) }
    const muted = ((_chunk: unknown, encoding?: unknown, callback?: () => void) => {
      const done = typeof encoding === 'function' ? encoding as () => void : callback
      done?.()
      return true
    }) as typeof process.stdout.write
    process.stdout.write = muted
    process.stderr.write = muted
    restoreOutput = () => { process.stdout.write = stdoutWrite; process.stderr.write = stderrWrite }
    process.stdin.setRawMode?.(true)
    process.stdin.on('data', input)
    process.stdin.resume()
    process.stdout.on('resize', resize)
  }
  current = next
  const frameEpoch = ++epoch
  if (!next) {
    restoreSessionTerminal()
    return true
  }
  process.stdin.setRawMode?.(true)
  writeTerminal?.('\x1b[0m\x1b[?25l\x1b[2J\x1b[H')
  try {
    next.focus(true, frameEpoch, size.columns, size.rows)
  } catch {
    // The leaf ended between accepting the switch and taking the terminal.
    // Without undoing the handoff this session stays muted inside the alternate
    // screen, which is the black terminal the switch was supposed to avoid.
    current = previous
    epoch++
    if (previous) { try { previous.focus(true, epoch, size.columns, size.rows) } catch { /* The previous leaf ended too. */ } }
    else restoreSessionTerminal()
    return false
  }
  return true
}

export function renderLeafTerminal(child: LeafProcess, frameEpoch: number, data: string): void {
  if (current === child && epoch === frameEpoch) writeTerminal?.(data)
}
