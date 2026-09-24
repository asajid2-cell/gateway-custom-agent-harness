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
import { requestLeafMenu, subscribeLeafMenuRequest, type LeafView } from '../src/utils/leafWorkspace.ts'

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

test('the session bar reaches the leaf menu by click, with nothing typed', async () => {
  const { views } = fixtures(3)
  let opened = 0
  const unsubscribe = subscribeLeafMenuRequest(() => { opened++ })
  try {
    // No onManage prop: the default is the real request channel, so this is the
    // gesture the user actually clicks rather than a test double standing in
    // for it. The carousel is in the layout, below the prompt, so it cannot
    // render the menu itself - it asks for it and the prompt overlay opens it.
    const t = await terminal(<LeafCarousel views={views} activeId={undefined} onSelect={() => {}} />)
    try {
      assert.equal(opened, 0, 'nothing opens the menu on its own')
      await t.click('All 4')
      await t.click('Manage leaves')
      assert.equal(opened, 1, 'Manage leaves asks for the leaf menu')
      // The list folds away behind the menu instead of leaving two rosters up.
      assert.doesNotMatch(textOf(t.ink.rootNode), /All sessions/)
    } finally { t.close() }
  } finally { unsubscribe() }
  // Unsubscribing is what the host does on unmount; a listener that outlived
  // it would reopen a menu in a session that is no longer on screen.
  requestLeafMenu()
  assert.equal(opened, 1, 'a removed listener is not called')
})

test('the bar offers only leaves that can still take the terminal', async () => {
  const live = fixtures(2).views
  const ended = { ...live[0]!, member: { ...live[0]!.member, number: 8, name: 'Ended eight', sessionId: 'leaf-ended' }, process: { getState: () => 'closed' } } as LeafView
  const failed = { ...live[0]!, member: { ...live[0]!.member, number: 9, name: 'Failed nine', sessionId: 'leaf-failed' }, process: { getState: () => 'failed' } } as LeafView
  let selected: string | undefined
  const t = await terminal(<LeafCarousel views={[...live, ended, failed]} activeId={undefined} onSelect={id => { selected = id }} />)
  try {
    const screen = textOf(t.ink.rootNode)
    // Entering one of these muted this session and left a black screen, so the
    // gesture that did it must not exist: they stay in the /leaf menu, which is
    // where they can be reopened, and leave the bar.
    assert.doesNotMatch(screen, /Ended eight/, 'a leaf whose process ended is not an entry point')
    assert.doesNotMatch(screen, /Failed nine/, 'a leaf that failed to start is not an entry point')
    assert.match(screen, /All 3/, 'the session and its two live leaves remain')
    await t.click('2 Chat 2')
    assert.equal(selected, 'leaf-1', 'the live leaves are still selectable')
  } finally { t.close() }
})

test('the terminal goes only to a leaf that can take it, and comes back when it cannot', async () => {
  const instances = (await import('../src/ink/instances.ts')).default
  const { focusLeafTerminal } = await import('../src/utils/leafTerminalHost.ts')
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, 'stdout')!
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin')!
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24, isTTY: true })
  stdout.resume()
  const stdin = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(mode: boolean) { this.isRaw = mode; return this } })
  let entered = 0, exited = 0
  // The real terminal's Ink instance is what hands off and takes back the screen.
  instances.set(stdout as any, { enterAlternateScreen() { entered++ }, exitAlternateScreen() { exited++ } } as any)
  Object.defineProperty(process, 'stdin', { configurable: true, value: stdin })
  Object.defineProperty(process, 'stdout', { configurable: true, value: stdout })
  const sessionWrite = process.stdout.write
  const focused: boolean[] = []
  const leaf = (state: string) => ({ getState: () => state, focus: (active: boolean) => { focused.push(active) } })
  try {
    assert.equal(focusLeafTerminal(leaf('closed') as any), false, 'an ended leaf is refused')
    assert.equal(process.stdout.write, sessionWrite, 'a refused handoff never mutes this session')
    assert.equal(entered, 0, 'a refused handoff never takes this session off the screen')

    assert.equal(focusLeafTerminal(leaf('idle') as any), true, 'a live leaf takes the terminal')
    assert.notEqual(process.stdout.write, sessionWrite, 'the leaf owns the output while it is on screen')
    assert.equal(focusLeafTerminal(undefined), true, 'going back is always allowed')
    assert.equal(process.stdout.write, sessionWrite, 'this session prints again')
    assert.deepEqual(focused, [true, false], 'the leaf is focused, then released')

    // The leaf ended between accepting the switch and taking the terminal. The
    // handoff is undone rather than left half-done: muted output and an active
    // alternate screen with nothing drawing in it is the black terminal.
    const dying = { getState: () => 'idle', focus: () => { throw new Error('Leaf process ended') } }
    assert.equal(focusLeafTerminal(dying as any), false, 'a failed handoff is reported as a refusal')
    assert.equal(process.stdout.write, sessionWrite, 'this session takes its writers back')
    assert.equal(entered, exited, 'this session is not left inside the alternate screen')
  } finally {
    Object.defineProperty(process, 'stdin', stdinDescriptor)
    Object.defineProperty(process, 'stdout', stdoutDescriptor)
    instances.delete(stdout as any)
  }
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

test('inline mouse ownership is selective: controls consume, content passes through', async () => {
  let controlClicks = 0
  let contentClicks = 0
  let contentMouseDowns = 0
  let contentMouseUps = 0
  let wheelEvents = 0
  let hovered = false
  function Host() {
    return <Box flexDirection="column">
      <Box onClick={() => { controlClicks++ }} onMouseDown={() => { controlClicks += 10 }}>
        <Text>CONTROL</Text>
      </Box>
      <Box onClick={() => { contentClicks++ }} onMouseDown={() => { contentMouseDowns++ }} onMouseUp={() => { contentMouseUps++ }}>
        <Text>CONTENT</Text>
      </Box>
      <Box onWheel={event => { wheelEvents++; event.stopImmediatePropagation() }}>
        <Text>WHEEL</Text>
      </Box>
      <Box onMouseEnter={() => { hovered = true }} onMouseLeave={() => { hovered = false }}>
        <Text>HOVER</Text>
      </Box>
    </Box>
  }
  const t = await terminal(<Host />)
  try {
    const control = t.point('CONTROL')
    t.mouse(0, control); t.mouse(0, control, true); await settle()
    assert.equal(controlClicks, 11, 'a matching control press/release is consumed and clicked')

    const content = t.point('CONTENT')
    t.mouse(0, content); t.mouse(0, content, true); await settle()
    assert.equal(contentMouseDowns, 1, 'ordinary inline press reaches the normal input path')
    assert.equal(contentMouseUps, 1, 'ordinary inline release reaches the normal input path')
    assert.equal(contentClicks, 1, 'ordinary inline content remains clickable through the fallback path')

    const wheel = t.point('WHEEL')
    t.mouse(64, wheel); await settle()
    assert.equal(wheelEvents, 1, 'a wheel handler claims only its own inline event')

    const ordinaryWheel = t.point('CONTENT')
    t.mouse(65, ordinaryWheel); await settle()
    assert.equal(wheelEvents, 1, 'a wheel over ordinary content is not swallowed by Gateway')

    const hover = t.point('HOVER')
    t.mouse(35, hover); await settle()
    assert.equal(hovered, true, 'passive hover state is still updated')
    assert.equal((t.ink as any).inlinePress, null, 'passive hover does not create a claimed press')
  } finally { t.close() }
})

test('inline press cannot activate a replacement control after repaint', async () => {
  let opens = 0
  let redraw!: () => void
  function Host() {
    const [label, setLabel] = useState('FIRST')
    redraw = () => setLabel(value => value === 'FIRST' ? 'SECOND' : 'FIRST')
    return label === 'FIRST'
      ? <Box onClick={() => { opens++ }}><Text>FIRST</Text></Box>
      : <Box onClick={() => { opens++ }}><Text>SECOND</Text></Box>
  }
  const t = await terminal(<Host />)
  try {
    const p = t.point('FIRST')
    t.mouse(0, p); await settle()
    redraw(); await settle()
    t.ink.repaint(); await settle()
    t.mouse(0, p, true); await settle()
    assert.equal(opens, 0, 'a stale press must not click newly rendered content')
  } finally { t.close() }
})

test('inline press is cancelled by a resize before release', async () => {
  let opens = 0
  function Host() {
    return <Box onClick={() => { opens++ }}><Text>RESIZE CONTROL</Text></Box>
  }
  const t = await terminal(<Host />)
  try {
    const p = t.point('RESIZE CONTROL')
    t.mouse(0, p); await settle()
    t.stdout.columns = 90
    t.stdout.rows = 30
    t.stdout.emit('resize')
    await settle()
    t.mouse(0, p, true); await settle()
    assert.equal(opens, 0, 'a press must not click after resize invalidates its frame')
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

  // A late CPR reply (probe already timed out or resolved) must still be
  // classified as a response when its row cannot be a modified F3 sequence,
  // otherwise the raw report is typed into the composer.
  for (const late of ['\x1b[16;3R', '\x1b[2;1R', '\x1b[40;120R']) {
    const [parsed] = parseMultipleKeypresses(INITIAL_STATE, late)
    assert.equal(parsed[0]?.kind, 'response', late)
    assert.equal(parsed[0]?.response.type, 'cursorPosition')
  }
  const plain = parseMultipleKeypresses(INITIAL_STATE, '\x1b[1;2R')
  expectStandardCursorPosition(true)
  const during = parseMultipleKeypresses(INITIAL_STATE, '\x1b[1;2R')
  const after = parseMultipleKeypresses(INITIAL_STATE, '\x1b[1;2R')
  assert.match(JSON.stringify(during), /cursorPosition/)
  assert.doesNotMatch(JSON.stringify(plain), /cursorPosition/)
  assert.doesNotMatch(JSON.stringify(after), /cursorPosition/)

  // A dual-query probe (private + plain DSR) draws two replies for one
  // matcher. The private reply must not spend the expectation, so the plain
  // reply that follows is classified as a response instead of being typed
  // into the composer as a modified F3 key.
  expectStandardCursorPosition(true)
  const [dualPrivate] = parseMultipleKeypresses(INITIAL_STATE, '\x1b[?12;4R')
  const [dualPlain] = parseMultipleKeypresses(INITIAL_STATE, '\x1b[1;7R')
  const [dualAfter] = parseMultipleKeypresses(INITIAL_STATE, '\x1b[1;7R')
  assert.equal(dualPrivate[0]?.response?.type, 'cursorPosition')
  assert.equal(dualPlain[0]?.response?.type, 'cursorPosition')
  assert.notEqual(dualAfter[0]?.response?.type, 'cursorPosition')
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
