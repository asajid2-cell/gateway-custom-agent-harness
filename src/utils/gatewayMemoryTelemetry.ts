import { appendFileSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { registerCleanup } from './cleanupRegistry.js'
import { subscribeCommandLifecycle } from './commandLifecycle.js'
import { onSessionSwitch } from '../bootstrap/state.js'

type Gauge = 'markdownEntries' | 'markdownSourceChars' | 'characterCacheEntries' | 'characterCacheWeight' | 'lineWidthCacheChars' | 'screenCells' | 'screenBufferBytes' | 'charPoolEntries' | 'hyperlinkPoolEntries' | 'stylePoolEntries' | 'styleTransitionEntries' | 'yogaLive' | 'virtualHeightCacheEntries' | 'virtualItemRefEntries' | 'virtualRefCacheEntries' | 'messageEntries' | 'messageTextChars'
const gauges: Partial<Record<Gauge, number>> = {}
let enabled = false
const events = { queryEntries: 0, replQueryEnds: 0, compactionChecks: 0, apiStarts: 0, apiEnds: 0, renders: 0 }
export function memoryEvent(name: keyof typeof events): void {
  if (enabled) events[name]++
}
export function memoryGauge(name: Gauge, value: number): void {
  if (enabled && Number.isFinite(value)) gauges[name] = value
}

export async function startGatewayMemoryTelemetry(directory: string, build: string, maxBytes = 2 * 1024 * 1024): Promise<(() => Promise<void>) | undefined> {
  if (enabled) return
  enabled = true
  for (const name of Object.keys(events) as (keyof typeof events)[]) events[name] = 0
  for (const name of Object.keys(gauges) as Gauge[]) delete gauges[name]
  const path = join(directory, `memory-${process.pid}-${randomUUID()}.jsonl`)
  const rotated = `${path}.1`
  let bytes = 0
  let stopped = false
  let busy: Promise<void> | undefined
  let started = 0
  let completed = 0
  let switches = 0
  let samples = 0
  let warned = false
  const warn = () => {
    if (!warned) process.stderr.write('Gateway memory telemetry unavailable; no memory diagnosis is assumed.\n')
    warned = true
  }
  try { mkdirSync(directory, { recursive: true, mode: 0o700 }) }
  catch { enabled = false; warn(); return }
  const jsc = await import('bun:jsc')
  const capture = async (reason: 'startup' | 'interval' | 'shutdown') => {
    if (busy) return busy
    busy = (async () => {
      const memory = process.memoryUsage()
      const heap = jsc.heapStats()
      let privateBytes: number | null = null
      let osSample: 'ok' | 'unavailable' | 'not-windows' = process.platform === 'win32' ? 'unavailable' : 'not-windows'
      if (process.platform === 'win32') {
        try {
          const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${process.pid}).PrivateMemorySize64`], { timeout: 3000, maxBuffer: 1024, windowsHide: true })
          const value = Number(result.stdout.trim())
          if (Number.isSafeInteger(value) && value > 0) { privateBytes = value; osSample = 'ok' }
        } catch { /* A missing OS sample must not interrupt the session. */ }
      }
      const line = JSON.stringify({ schema: 1, timestamp: new Date().toISOString(), pid: process.pid, build, bun: Bun.version, mode: Reflect.get(process.env, 'NODE_ENV') === 'production' ? 'production' : 'non-production', reason, sample: ++samples, uptime: process.uptime(), memory, heap: { heapSize: heap.heapSize, heapCapacity: heap.heapCapacity, objectCount: heap.objectCount, protectedObjectCount: heap.protectedObjectCount }, privateBytes, osSample, activity: { commandStarted: started, commandCompleted: completed, switches, ...events }, caches: { ...gauges } }) + '\n'
      try {
        if (bytes > 0 && bytes + Buffer.byteLength(line) > maxBytes) {
          rmSync(rotated, { force: true })
          renameSync(path, rotated)
          bytes = 0
        }
        appendFileSync(path, line, { mode: 0o600 })
        bytes += Buffer.byteLength(line)
      } catch { warn(); stopped = true }
    })().finally(() => { busy = undefined })
    return busy
  }
  const unsubscribe = subscribeCommandLifecycle((_id, state) => { if (state === 'started') started++; else completed++ })
  const unsubscribeSwitch = onSessionSwitch(() => { switches++ })
  await capture('startup')
  const timer = setInterval(() => { if (!stopped) void capture('interval') }, 60000)
  timer.unref()
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => closing ??= (async () => {
    clearInterval(timer)
    unsubscribe()
    unsubscribeSwitch()
    await busy
    if (!stopped) await capture('shutdown')
    stopped = true
    enabled = false
    unregister()
  })()
  const unregister = registerCleanup(close)
  return close
}
