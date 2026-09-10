import React, { useState } from 'react'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { PassThrough } from 'node:stream'
import { render, Box, Text, useInput } from '../src/ink.ts'
import instances from '../src/ink/instances.ts'
import { nodeCache } from '../src/ink/node-cache.ts'
import { LeafCarousel, LeafWorkspacePanel } from '../src/components/LeafWorkspaceDialog.tsx'
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
function fixtures(count: number): { views: LeafView[]; sent: string[][] } {
  const sent = Array.from({ length: count }, () => [] as string[])
  const views = sent.map((messages, index) => ({ rootSessionId: 'root', member: { number: index + 1, name: `Chat ${index + 1}`, sessionId: `leaf-${index}` }, output: [`OUTPUT_${index + 1}`], draft: '', scrollOffset: 0, process: { getState: () => 'idle', getPermissions: () => [], send: (text: string) => messages.push(text) } })) as unknown as LeafView[]
  return { views, sent }
}

export async function exerciseRealLeafTerminal(views: LeafView[]): Promise<void> {
  let closed = false
  const t = await terminal(<LeafWorkspacePanel views={views} onDone={() => { closed = true }} />)
  try {
    for (let index = 0; index < views.length; index++) {
      await t.click('All ' + (views.length + 1))
      await t.click(`${views[index]!.member.number} ${views[index]!.member.name} [${views[index]!.process.getState()}]`)
      t.stdin.write(index === 0 ? 'TERMINAL_FIRST_LEAF' : index === 1 ? 'TERMINAL_SECOND_LEAF' : `TERMINAL_LEAF_${index + 1}`)
      await settle(); t.stdin.write('\r'); await settle()
    }
    t.stdin.write('\x1b'); await settle()
    assert.equal(closed, true)
  } finally { t.close() }
}

for (const columns of [40, 100]) test(`pointer and wheel switch independent drafts at ${columns} columns; Tab never switches`, async () => {
  const { views, sent } = fixtures(5)
  let closes = 0
  const t = await terminal(<LeafWorkspacePanel views={views} onDone={() => { closes++ }} />, columns)
  try {
    t.stdin.write('alpha'); await settle()
    t.stdin.write('\t'); await settle()
    assert.equal(closes, 0)
    assert.equal(views[0]!.draft, 'alpha')
    await t.click('All 6')
    await t.click('2 Chat 2 [idle]')
    t.stdin.write('beta'); await settle()
    assert.equal(views[1]!.draft, 'beta')
    const p = t.point('2 Chat 2')
    t.mouse(64, p); await settle()
    assert.match(textOf(t.ink.rootNode), /alpha/)
    t.stdin.write('\r'); await settle()
    assert.deepEqual(sent, [['alpha'], [], [], [], []])
    await t.click('All 6'); await t.click('2 Chat 2 [idle]')
    assert.match(textOf(t.ink.rootNode), /beta/)
    t.stdin.write('\r'); await settle()
    assert.deepEqual(sent, [['alpha'], ['beta'], [], [], []])
    t.stdin.write('\x1b'); await settle()
    assert.equal(closes, 1)
  } finally { t.close() }
})

test('short bracketed paste does not leave a leaf input unable to submit', async () => {
  const { views, sent } = fixtures(1)
  const t = await terminal(<LeafWorkspacePanel views={views} onDone={() => {}} />)
  try {
    t.stdin.write('\x1b[200~hello\x1b[201~'); await settle()
    t.stdin.write('\r'); await settle()
    assert.deepEqual(sent, [['hello']])
  } finally { t.close() }
})

test('leaf rename Escape cancels without closing the workspace or losing its draft', async () => {
  const { views } = fixtures(1)
  let closes = 0
  const t = await terminal(<LeafWorkspacePanel views={views} onDone={() => { closes++ }} />)
  try {
    t.stdin.write('unsent draft'); await settle()
    await t.click('✎ Rename')
    assert.match(textOf(t.ink.rootNode), /Enter saves/)
    t.stdin.write('\x1b')
    await waitForScreen(() => !textOf(t.ink.rootNode).includes('Enter saves'))
    assert.doesNotMatch(textOf(t.ink.rootNode), /Enter saves/)
    assert.match(textOf(t.ink.rootNode), /unsent draft/)
    assert.equal(closes, 0)
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

test('plain cursor reports are consumed only during an explicit Windows calibration', async () => {
  const { expectStandardCursorPosition, parseMultipleKeypresses, INITIAL_STATE } = await import('../src/ink/parse-keypress.ts')
  expectStandardCursorPosition(false)
  const before = parseMultipleKeypresses(INITIAL_STATE, '\x1b[1;2R')
  expectStandardCursorPosition(true)
  const during = parseMultipleKeypresses(INITIAL_STATE, '\x1b[1;2R')
  const after = parseMultipleKeypresses(INITIAL_STATE, '\x1b[1;2R')
  assert.match(JSON.stringify(during), /cursorPosition/)
  assert.doesNotMatch(JSON.stringify(before), /cursorPosition/)
  assert.doesNotMatch(JSON.stringify(after), /cursorPosition/)
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
