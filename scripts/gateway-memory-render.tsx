import { strict as assert } from 'node:assert'
import React from 'react'
import { PassThrough } from 'node:stream'
import { heapStats } from 'bun:jsc'
import { render, Box, Text } from '../src/ink.ts'
import { Markdown } from '../src/components/Markdown.tsx'
import { AppStateProvider } from '../src/state/AppState.tsx'

const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 30, isTTY: true })
const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
let renderedTail = ''
stdout.on('data', chunk => { renderedTail = (renderedTail + chunk.toString()).slice(-65536) })
const sample = (stage: string) => {
  const { heapSize, heapCapacity, objectCount } = heapStats()
  console.log(JSON.stringify({ stage, pid: process.pid, mode: process.env.NODE_ENV ?? 'unset', developmentReact: Boolean(React.captureOwnerStack), ...process.memoryUsage(), heapSize, heapCapacity, objectCount }))
}
const rows = Number(process.env.MEMORY_RENDER_ROWS ?? 80)
const repeats = Number(process.env.MEMORY_RENDER_REPEATS ?? 20)
const view = (turn: number) => process.env.MEMORY_MARKDOWN === '1'
  ? <AppStateProvider><Markdown>{`# Turn ${turn}\n\n${'**fixture** output paragraph.\n\n'.repeat(repeats)}`}</Markdown></AppStateProvider>
  : <Box flexDirection="column">{Array.from({ length: rows }, (_, i) => <Text key={i}>{`row ${i} turn ${turn}: ${'fixture output '.repeat(repeats)}`}</Text>)}</Box>
sample('before')
const app = await render(view(0), { stdout: stdout as unknown as NodeJS.WriteStream, stderr: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false, exitOnCtrlC: false })
try {
  for (let turn = 1; turn <= Number(process.env.MEMORY_RENDER_TURNS ?? 200); turn++) {
    app.rerender(view(turn))
    await new Promise(resolve => setTimeout(resolve, 2))
    if (turn % 100 === 0) sample(`render-${turn}`)
  }
} finally { app.unmount() }
assert.ok(renderedTail.includes('fixture'), 'Renderer must produce fixture output')
sample('unmounted')
Bun.gc(true)
sample('after-gc')
if (process.env.MEMORY_MAX_HEAP_MB) assert.ok(heapStats().heapSize <= Number(process.env.MEMORY_MAX_HEAP_MB) * 1024 * 1024, 'Retained heap exceeded diagnostic budget')
const counts = heapStats().objectTypeCounts
console.log(JSON.stringify({ largestObjectCounts: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12) }))
