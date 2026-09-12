import React, { useState } from 'react'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { PassThrough } from 'node:stream'
import { render, Box, Text, useInput } from '../src/ink.ts'
import instances from '../src/ink/instances.ts'
import { nodeCache } from '../src/ink/node-cache.ts'
import { LeafCarousel } from '../src/components/LeafWorkspaceDialog.tsx'
import { SessionEditControl } from '../src/components/PromptInput/PromptInputFooter.tsx'
import { AppStateProvider } from '../src/state/AppState.tsx'
import type { LeafView } from '../src/utils/leafWorkspace.ts'

const settle = () => new Promise(resolve => setTimeout(resolve, 80))
async function waitForScreen(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (!predicate() && Date.now() < deadline) await settle()
}
function textOf(node: any): string { return node.nodeName === '#text' ? node.nodeValue : (node.childNodes ?? []).map(textOf).join('') }
function labelNode(node: any, label: string): any {
  for (const child of node.childNodes ?? []) {
    if (child.nodeName === '#text') continue
    const found = labelNode(child, label)
    if (found) return found
  }
  return textOf(node) === label && nodeCache.has(node) ? node : undefined
}
async function terminal(content: React.ReactNode, columns = 100) {
  const stdout = Object.assign(new PassThrough(), { columns, rows: 30, isTTY: true })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  stdout.resume()
  function InputOwner() { useInput(() => {}); return null }
  const app = await render(<AppStateProvider><InputOwner /><Box width={columns}>{content}</Box></AppStateProvider>, { stdout: stdout as any, stderr: stdout as any, stdin: stdin as any, patchConsole: false, exitOnCtrlC: false })
  await settle()
  const ink = instances.get(stdout as any) as any
  // The real terminal supplies origin via CPR. Set only that measurement here;
  // all pointer input still traverses parsing, App routing and hit testing.
  const calibrate = () => { ink.inlineOrigin = 0; ink.inlineTracking = true }
  const point = (label: string) => {
    const node = labelNode(ink.rootNode, label)
    assert.ok(node, `Missing visible control ${label}; screen=${textOf(ink.rootNode)}`)
    const rect = nodeCache.get(node)!
    assert.ok(rect.width > 0 && rect.x >= 0 && rect.x + rect.width <= columns, `Control outside viewport: ${label}`)
    return { x: rect.x + 1, y: rect.y + 1 }
  }
  const mouse = (button: number, point: { x: number; y: number }, release = false) => { calibrate(); stdin.write(`\x1b[<${button};${point.x};${point.y}${release ? 'm' : 'M'}`) }
  const click = async (label: string) => { const p = point(label); mouse(0, p); mouse(0, p, true); await settle() }
  return { app, ink, stdin, stdout, point, mouse, click, close: () => { app.unmount(); stdin.destroy(); stdout.destroy() } }
}
function fixtures(count: number): { views: LeafView[] } {
  const views = Array.from({ length: count }, (_, index) => ({ rootSessionId: 'root', member: { number: index + 1, name: `Chat ${index + 1}`, sessionId: `leaf-${index}` }, draft: '', process: { getState: () => 'idle' } })) as LeafView[]
  return { views }
}

for (const columns of [40, 100]) test(`carousel pointer and wheel select full sessions at ${columns} columns; Tab never switches`, async () => {
  const { views } = fixtures(5)
  let selected: string | undefined = 'leaf-0'
  function Host() {
    const [active, setActive] = useState<string | undefined>(selected)
    return <LeafCarousel views={views} activeId={active} onSelect={id => { selected = id; setActive(id) }} />
  }
  const t = await terminal(<Host />, columns)
  try {
    t.stdin.write('\t'); await settle()
    assert.equal(selected, 'leaf-0')
    await t.click('All 6')
    await t.click('2 Chat 2 [idle]')
    assert.equal(selected, 'leaf-1')
    t.mouse(64, t.point('2 Chat 2')); await settle()
    assert.equal(selected, 'leaf-0')
    await t.click('All 6')
    const { getLeafRootName } = await import('../src/utils/leafWorkspace.ts')
    await t.click(getLeafRootName())
    assert.equal(selected, undefined)
  } finally { t.close() }
})

test('press-and-hold opens all sessions without selecting on release', async () => {
  const { views } = fixtures(15)
  let selected: string | undefined
  const t = await terminal(<LeafCarousel views={views} activeId="leaf-0" onSelect={id => { selected = id }} />)
  try {
    const p = t.point('1 Chat 1')
    t.mouse(0, p)
    await waitForScreen(() => textOf(t.ink.rootNode).includes('All sessions'))
    assert.match(textOf(t.ink.rootNode), /All sessions/)
    t.mouse(0, p, true); await settle()
    assert.equal(selected, undefined)
    await t.click('Next')
    await t.click('15 Chat 15 [idle]')
    assert.equal(selected, 'leaf-14')
  } finally { t.close() }
})

test('cursor position reports never become prompt keys', async () => {
  const { expectStandardCursorPosition, parseMultipleKeypresses, INITIAL_STATE } = await import('../src/ink/parse-keypress.ts')
  expectStandardCursorPosition(false)
  for (const report of ['\x1b[?19;9;1R', '\x1b[19;9;1R', '\x1b[21;18;1R']) {
    const [parsed] = parseMultipleKeypresses(INITIAL_STATE, report)
    assert.equal(parsed[0]?.kind, 'response', report)
    assert.equal(parsed[0]?.response.type, 'cursorPosition')
  }

  const plain = parseMultipleKeypresses(INITIAL_STATE, '\x1b[1;2R')
  expectStandardCursorPosition(true)
  const during = parseMultipleKeypresses(INITIAL_STATE, '\x1b[1;2R')
  const after = parseMultipleKeypresses(INITIAL_STATE, '\x1b[1;2R')
  assert.match(JSON.stringify(during), /cursorPosition/)
  assert.doesNotMatch(JSON.stringify(plain), /cursorPosition/)
  assert.doesNotMatch(JSON.stringify(after), /cursorPosition/)
})

test('terminal handoff suspends and restores both input listener modes exactly once', async () => {
  const t = await terminal(<Text>Input handoff</Text>)
  let deliveries = 0
  const data = () => { deliveries++ }
  const readable = () => { deliveries++ }
  t.stdin.on('data', data)
  t.stdin.on('readable', readable)
  try {
    const dataListeners = t.stdin.listeners('data')
    const readableListeners = t.stdin.listeners('readable')
    for (let cycle = 0; cycle < 5; cycle++) {
      t.ink.suspendStdin()
      assert.equal(t.stdin.listenerCount('data'), 0)
      assert.equal(t.stdin.listenerCount('readable'), 0)
      t.stdin.emit('data', 'LEAF_ONLY')
      t.stdin.emit('readable')
      assert.equal(deliveries, 0)
      t.ink.resumeStdin()
      assert.deepEqual(t.stdin.listeners('data'), dataListeners)
      assert.deepEqual(t.stdin.listeners('readable'), readableListeners)
    }
  } finally {
    t.stdin.off('data', data)
    t.stdin.off('readable', readable)
    t.close()
  }
})

test('pencil click survives a repaint between press and release without stealing typing', async () => {
  let opens = 0, redraw!: () => void
  function Host() {
    const [count, setCount] = useState(0)
    redraw = () => setCount(value => value + 1)
    return <Box flexDirection="column"><Text>{count}</Text><SessionEditControl onOpen={() => { opens++ }} /></Box>
  }
  const t = await terminal(<Host />)
  try {
    const p = t.point('✎ Rename')
    t.mouse(0, p); await settle()
    redraw(); await settle()
    t.mouse(0, p, true); await settle()
    assert.equal(opens, 1)
    t.stdin.write(' \r'); await settle()
    assert.equal(opens, 1)
  } finally { t.close() }
})
