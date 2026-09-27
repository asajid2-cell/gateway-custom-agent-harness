import React, { useState } from 'react'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { PassThrough } from 'node:stream'
import { render, Box } from '../src/ink.ts'
import { LeafSessionBar } from '../src/components/LeafWorkspaceDialog.tsx'
import instances from '../src/ink/instances.ts'
import { nodeCache } from '../src/ink/node-cache.ts'
import { dispatchClick } from '../src/ink/hit-test.ts'
import type { DOMElement } from '../src/ink/dom.ts'
import PromptInput from '../src/components/PromptInput/PromptInput.tsx'
import { AppStateProvider, getDefaultAppState } from '../src/state/AppState.tsx'
import { clearCommandQueue, enqueueUserPrompt, getCommandQueue } from '../src/utils/messageQueueManager.ts'
import { addToSessionTokenTotals, resetSessionTokenTotals } from '../src/bootstrap/state.ts'

function textOf(node: any): string {
  return node.nodeName === '#text' ? node.nodeValue : (node.childNodes ?? []).map(textOf).join('')
}

function findLabel(node: DOMElement, label: string): DOMElement | undefined {
  for (const child of node.childNodes) {
    if (child.nodeName === '#text') continue
    const found = findLabel(child, label)
    if (found) return found
  }
  return textOf(node) === label && nodeCache.has(node) ? node : undefined
}

async function exercisePromptWorkspace(): Promise<void> {
  const savedGateway = process.env.CLAUDE_CODE_USE_GATEWAY
  const savedFullscreen = process.env.CLAUDE_CODE_NO_FLICKER
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  process.env.CLAUDE_CODE_NO_FLICKER = '0'
  const stdout = Object.assign(new PassThrough(), { columns: 90, rows: 28, isTTY: true })
  let app: Awaited<ReturnType<typeof render>> | undefined
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  let output = ''
  stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-200000) })
  let currentDraft = ''
  const submitted: string[] = []
  const noop = () => {}
  const representativeMessages = [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'representative status content' }], usage: { input_tokens: 6300, output_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }] as any[]
  const assertFooterGeometry = () => {
    const root = (instances.get(stdout as any) as unknown as { rootNode: DOMElement }).rootNode
    for (const [label, minimumWidth] of [['Sessions', 8], ['All 1', 5]] as const) {
      const node = findLabel(root, label)
      assert.ok(node, `${label} label must render`)
      const rect = nodeCache.get(node!)
      assert.ok(rect, `${label} label must have a Yoga rectangle`)
      assert.ok(rect!.width >= minimumWidth, `${label} width ${rect!.width} < ${minimumWidth}`)
      assert.equal(rect!.height, 1, `${label} height must remain one row`)
      assert.ok(rect!.x >= 2 && rect!.x + rect!.width <= stdout.columns - 2,
        `${label} bounds x=${rect!.x} width=${rect!.width} right=${rect!.x + rect!.width} viewport=${stdout.columns} must stay within [2, ${stdout.columns - 2}]`)
    }
  }
  function Host() {
    const [input, setInput] = useState('ORIGINAL_DRAFT')
    currentDraft = input
    const state = getDefaultAppState()
    return <Box flexDirection="column"><PromptInput {...{
      debug: false, ideSelection: undefined, toolPermissionContext: state.toolPermissionContext, setToolPermissionContext: noop,
      apiKeyStatus: 'valid', commands: [{ name: 'fixture', type: 'local-jsx', description: 'Fixture command', load: async () => ({ call: async () => null }) }], agents: [], isLoading: false, verbose: false, messages: representativeMessages, onAutoUpdaterResult: noop, autoUpdaterResult: null,
      input, onInputChange: setInput, mode: 'prompt', onModeChange: noop, stashedPrompt: undefined, setStashedPrompt: noop, submitCount: 0,
      onShowMessageSelector: noop, mcpClients: [], pastedContents: {}, setPastedContents: noop, vimMode: 'INSERT', setVimMode: noop,
      showBashesDialog: false, setShowBashesDialog: noop, onExit: noop, getToolUseContext: () => ({}), onSubmit: async (text: string) => { submitted.push(text) },
      isSearchingHistory: false, setIsSearchingHistory: noop, helpOpen: false, setHelpOpen: noop,
    } as any} /><LeafSessionBar /></Box>
  }
  const { selectLeaf } = await import('../src/utils/leafWorkspace.ts')
  selectLeaf()
  app = await render(<AppStateProvider><Host /></AppStateProvider>, { stdout: stdout as any, stderr: stdout as any, stdin: stdin as any, patchConsole: false, exitOnCtrlC: false })
  try {
    await new Promise(resolve => setTimeout(resolve, 250))
    assertFooterGeometry()
    assert.ok(output.includes('All'), 'Actual prompt must render the session carousel')
    stdin.write(' appended')
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(currentDraft, 'ORIGINAL_DRAFT appended')
    const root = (instances.get(stdout as any) as unknown as { rootNode: DOMElement }).rootNode
    const click = async (label: string) => {
      const node = findLabel(root, label)
      assert.ok(node, `Visible control missing: ${label}`)
      const rect = nodeCache.get(node)!
      assert.equal(dispatchClick(root, rect.x, rect.y), true)
      await new Promise(resolve => setTimeout(resolve, 150))
    }
    await click('All 1')
    assert.ok(textOf(root).includes('All sessions'), 'Expanded session picker must render')
    await click('Close list')
    stdout.columns = 60
    stdout.emit('resize')
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(currentDraft, 'ORIGINAL_DRAFT appended')
    assertFooterGeometry()
    assert.equal(textOf(root).includes('All sessions'), false, 'Session picker must close without replacing the prompt')
    stdin.write(' after')
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(currentDraft, 'ORIGINAL_DRAFT appended after')
    stdin.write('\x1b[200~ pasted世界\x1b[201~\r')
    await new Promise(resolve => setTimeout(resolve, 500))
    assert.equal(currentDraft, 'ORIGINAL_DRAFT appended after pasted世界')
    assert.deepEqual(submitted, ['ORIGINAL_DRAFT appended after pasted世界'])
    stdin.write('\x15')
    await new Promise(resolve => setTimeout(resolve, 150))
    stdin.write('/fixture')
    await new Promise(resolve => setTimeout(resolve, 500))
    stdin.write('\r')
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(submitted.filter(text => text === '/fixture').length, 1, 'One Enter must submit an exact slash command once')
  } finally {
    app?.unmount()
    stdin.destroy()
    stdout.destroy()
    if (savedGateway === undefined) delete process.env.CLAUDE_CODE_USE_GATEWAY
    else process.env.CLAUDE_CODE_USE_GATEWAY = savedGateway
    if (savedFullscreen === undefined) delete process.env.CLAUDE_CODE_NO_FLICKER
    else process.env.CLAUDE_CODE_NO_FLICKER = savedFullscreen
  }
}

test('session picker preserves the normal prompt draft and paste submission', { timeout: 15000 }, () => exercisePromptWorkspace())

/**
 * Tab queues the message the user just wrote, and up-arrow hands the newest one
 * back to be changed. The point of the queue is that a burst can be written
 * without waiting for each reply, so the two things that have to hold are that
 * the composer empties when a message is queued and that the messages keep the
 * order they were written in. The stub standing in for handlePromptSubmit does
 * the two things the real one does - enqueue, then clear the composer - so what
 * is under test is the key handling on either end.
 */
async function exercisePromptQueue(): Promise<void> {
  const savedGateway = process.env.CLAUDE_CODE_USE_GATEWAY
  const savedFullscreen = process.env.CLAUDE_CODE_NO_FLICKER
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  process.env.CLAUDE_CODE_NO_FLICKER = '0'
  const stdout = Object.assign(new PassThrough(), { columns: 90, rows: 28, isTTY: true })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  let app: Awaited<ReturnType<typeof render>> | undefined
  let currentDraft = ''
  const submissions: Array<{ text: string; queue?: boolean }> = []
  const noop = () => {}
  const pause = () => new Promise(resolve => setTimeout(resolve, 200))
  const representativeMessages = [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'representative status content' }], usage: { input_tokens: 6300, output_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }] as any[]
  clearCommandQueue()

  function Host() {
    const [input, setInput] = useState('')
    currentDraft = input
    const state = getDefaultAppState()
    return <Box flexDirection="column"><PromptInput {...{
      debug: false, ideSelection: undefined, toolPermissionContext: state.toolPermissionContext, setToolPermissionContext: noop,
      apiKeyStatus: 'valid', commands: [], agents: [], isLoading: false, verbose: false, messages: representativeMessages,
      onAutoUpdaterResult: noop, autoUpdaterResult: null,
      input, onInputChange: setInput, mode: 'prompt', onModeChange: noop, stashedPrompt: undefined, setStashedPrompt: noop, submitCount: 0,
      onShowMessageSelector: noop, mcpClients: [], pastedContents: {}, setPastedContents: noop, vimMode: 'INSERT', setVimMode: noop,
      showBashesDialog: false, setShowBashesDialog: noop, onExit: noop, getToolUseContext: () => ({}),
      clearBuffer: noop, resetHistory: noop, onHistoryUp: noop, onHistoryDown: () => false,
      onSubmit: async (text: string, _helpers: unknown, _spec: unknown, options?: { queue?: boolean }) => {
        submissions.push({ text, queue: options?.queue })
        if (options?.queue) {
          enqueueUserPrompt({ value: text, mode: 'prompt' })
          setInput('')
        }
      },
      isSearchingHistory: false, setIsSearchingHistory: noop, helpOpen: false, setHelpOpen: noop,
    } as any} /></Box>
  }
  app = await render(<AppStateProvider><Host /></AppStateProvider>, { stdout: stdout as any, stderr: stdout as any, stdin: stdin as any, patchConsole: false, exitOnCtrlC: false })
  try {
    await pause()
    const root = (instances.get(stdout as any) as unknown as { rootNode: DOMElement }).rootNode

    // Tab on an empty composer stays the thinking-toggle hint: there is nothing
    // to queue, and the key must keep its existing meaning.
    stdin.write('\t')
    await pause()
    assert.deepEqual(submissions, [], 'an empty composer has nothing to queue')

    // Write a message and Tab. It is handed to the queue with the flag that
    // says "wait for the turn to end", and the composer is left empty.
    stdin.write('first message')
    await pause()
    assert.equal(currentDraft, 'first message')
    stdin.write('\t')
    await pause()
    assert.deepEqual(submissions, [{ text: 'first message', queue: true }])
    assert.equal(currentDraft, '', 'the composer empties once the message is queued')
    assert.deepEqual(getCommandQueue().map(cmd => cmd.value), ['first message'])

    // A second message lands behind the first, not in front of it.
    stdin.write('second message')
    await pause()
    stdin.write('\t')
    await pause()
    assert.deepEqual(submissions.map(entry => entry.text), ['first message', 'second message'])
    assert.deepEqual(getCommandQueue().map(cmd => cmd.value), ['first message', 'second message'])
    assert.ok(textOf(root).includes('second message'), 'the waiting message is shown under the prompt')

    // Up-arrow brings the newest one back to be changed and leaves the first
    // one waiting, so the queue can be walked one message at a time.
    stdin.write('\x1b[A')
    await pause()
    assert.equal(currentDraft, 'second message')
    assert.deepEqual(getCommandQueue().map(cmd => cmd.value), ['first message'])

    // Enter sends what is in the composer; it does not queue it again.
    stdin.write('\r')
    await pause()
    assert.equal(submissions.at(-1)?.text, 'second message')
    assert.equal(submissions.at(-1)?.queue, undefined, 'enter sends, tab queues')
  } finally {
    clearCommandQueue()
    app?.unmount()
    stdin.destroy()
    stdout.destroy()
    if (savedGateway === undefined) delete process.env.CLAUDE_CODE_USE_GATEWAY
    else process.env.CLAUDE_CODE_USE_GATEWAY = savedGateway
    if (savedFullscreen === undefined) delete process.env.CLAUDE_CODE_NO_FLICKER
    else process.env.CLAUDE_CODE_NO_FLICKER = savedFullscreen
  }
}

test('tab queues the message and up-arrow hands it back for editing', { timeout: 15000 }, () => exercisePromptQueue())

/**
 * The bottom bar carries one plain charged-token number beside the usage stats,
 * and clicking it is the only way to the breakdown. What has to hold is that the
 * number is a single compact figure with no model name glued to it, that it sits
 * inside the footer rather than pushing the row off the screen, and that a click
 * opens the cached/input/output detail without losing the prompt underneath.
 */
async function exerciseSessionUsage(readout: string): Promise<void> {
  const savedGateway = process.env.CLAUDE_CODE_USE_GATEWAY
  const savedFullscreen = process.env.CLAUDE_CODE_NO_FLICKER
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  process.env.CLAUDE_CODE_NO_FLICKER = '0'
  const stdout = Object.assign(new PassThrough(), { columns: 90, rows: 28, isTTY: true })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  let app: Awaited<ReturnType<typeof render>> | undefined
  let currentDraft = ''
  const noop = () => {}
  const pause = () => new Promise(resolve => setTimeout(resolve, 200))
  const representativeMessages = [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'representative status content' }], usage: { input_tokens: 6300, output_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }] as any[]

  function Host() {
    const [input, setInput] = useState('KEEP_MY_DRAFT')
    currentDraft = input
    const state = getDefaultAppState()
    return <Box flexDirection="column"><PromptInput {...{
      debug: false, ideSelection: undefined, toolPermissionContext: state.toolPermissionContext, setToolPermissionContext: noop,
      apiKeyStatus: 'valid', commands: [], agents: [], isLoading: false, verbose: false, messages: representativeMessages,
      onAutoUpdaterResult: noop, autoUpdaterResult: null,
      input, onInputChange: setInput, mode: 'prompt', onModeChange: noop, stashedPrompt: undefined, setStashedPrompt: noop, submitCount: 0,
      onShowMessageSelector: noop, mcpClients: [], pastedContents: {}, setPastedContents: noop, vimMode: 'INSERT', setVimMode: noop,
      showBashesDialog: false, setShowBashesDialog: noop, onExit: noop, getToolUseContext: () => ({}), onSubmit: async () => {},
      isSearchingHistory: false, setIsSearchingHistory: noop, helpOpen: false, setHelpOpen: noop,
    } as any} /></Box>
  }

  // A run that has spent 100m charged tokens, split so the detail view has
  // something in every column.
  resetSessionTokenTotals()
  addToSessionTokenTotals('fixture-model', { input: 99_950_000, output: 50_000, cacheRead: 0, cacheWrite: 0 })

  app = await render(<AppStateProvider><Host /></AppStateProvider>, { stdout: stdout as any, stderr: stdout as any, stdin: stdin as any, patchConsole: false, exitOnCtrlC: false })
  try {
    await pause()
    const root = (instances.get(stdout as any) as unknown as { rootNode: DOMElement }).rootNode
    const node = findLabel(root, readout)
    assert.ok(node, `the bar must show the charged-token total as "${readout}"`)
    const rect = nodeCache.get(node!)
    assert.ok(rect, 'the readout must have a Yoga rectangle')
    assert.equal(rect!.height, 1, 'the readout is one row')
    assert.ok(rect!.x >= 2 && rect!.x + rect!.width <= stdout.columns - 2,
      `readout bounds x=${rect!.x} width=${rect!.width} must stay inside the footer`)
    assert.ok(textOf(root).includes('context'), 'the context readout is still there beside it')

    assert.equal(dispatchClick(root, rect!.x, rect!.y), true, 'the readout must be clickable')
    await pause()
    const opened = textOf(root)
    assert.ok(opened.includes('Session usage'), 'the click must open the detail view')
    assert.ok(opened.includes('Cache read'), 'the detail view splits cached from input and output')
    assert.ok(opened.includes('Per model'), 'the detail view has a per-model overview')
    assert.ok(opened.includes('fixture-model'), 'the model that spent the tokens is named')

    // A response that lands while the view is open moves it: the count is read
    // live, not snapshotted when the dialog was opened.
    addToSessionTokenTotals('fixture-model', { input: 50_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })
    await pause()
    assert.ok(textOf(root).includes('150m total'), 'the open view follows the run as it spends')

    stdin.write('\x1b')
    await pause()
    assert.equal(textOf(root).includes('Session usage'), false, 'escape closes the detail view')
    assert.equal(currentDraft, 'KEEP_MY_DRAFT', 'the prompt draft survives the round trip')
    assert.ok(textOf(root).includes('150m total'), 'the bar carries the live total, not the seeded one')
  } finally {
    resetSessionTokenTotals()
    app?.unmount()
    stdin.destroy()
    stdout.destroy()
    if (savedGateway === undefined) delete process.env.CLAUDE_CODE_USE_GATEWAY
    else process.env.CLAUDE_CODE_USE_GATEWAY = savedGateway
    if (savedFullscreen === undefined) delete process.env.CLAUDE_CODE_NO_FLICKER
    else process.env.CLAUDE_CODE_NO_FLICKER = savedFullscreen
  }
}

test('the bar shows one charged-token total that opens the breakdown', { timeout: 15000 }, () => exerciseSessionUsage('100m total'))
