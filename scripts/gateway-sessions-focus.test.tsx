import React, { useState } from 'react'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { PassThrough } from 'node:stream'
import { render, Box } from '../src/ink.ts'
import instances from '../src/ink/instances.ts'
import { nodeCache } from '../src/ink/node-cache.ts'
import { dispatchClick } from '../src/ink/hit-test.ts'
import type { DOMElement } from '../src/ink/dom.ts'
import PromptInput from '../src/components/PromptInput/PromptInput.tsx'
import { PromptOverlayProvider, usePromptOverlayDialog } from '../src/context/promptOverlayContext.tsx'
import { AppStateProvider, getDefaultAppState } from '../src/state/AppState.tsx'

function textOf(node: any): string {
  return node.nodeName === '#text' ? node.nodeValue : (node.childNodes ?? []).map(textOf).join('')
}

function findLabel(node: DOMElement, label: string): DOMElement | undefined {
  for (const child of node.childNodes ?? []) {
    if (child.nodeName === '#text') continue
    const found = findLabel(child, label)
    if (found) return found
  }
  return textOf(node) === label && nodeCache.has(node) ? node : undefined
}

const settle = () => new Promise(resolve => setTimeout(resolve, 250))

/**
 * The user-reported sequence: click Sessions, close it, press Space. Space used
 * to reopen the dialog.
 *
 * Fullscreen is the composition where it happens: PromptInput portals the
 * dialog (useSetPromptOverlayDialog) and keeps rendering the footer underneath
 * it, so the Sessions control outlives the dialog. Click-to-focus then leaves
 * that control holding focus — dispatchClick focuses the nearest numeric
 * tabIndex, -1 included — and nothing blurs it when the dialog goes away, so
 * the next Space reaches its onKeyDown. Button activates on Space. The control
 * is click-only now, so there is nothing left to re-trigger.
 */
async function exerciseSessionsFocus(): Promise<void> {
  const savedGateway = process.env.CLAUDE_CODE_USE_GATEWAY
  const savedFullscreen = process.env.CLAUDE_CODE_NO_FLICKER
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  process.env.CLAUDE_CODE_NO_FLICKER = '1'
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 30, isTTY: true })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  stdout.resume()
  const noop = () => {}
  const messages = [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'fixture' }], usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }] as any[]
  let draft = ''
  let app: Awaited<ReturnType<typeof render>> | undefined
  function DialogSlot() {
    return <>{usePromptOverlayDialog()}</>
  }
  function Host() {
    const [input, setInput] = useState('')
    draft = input
    const state = getDefaultAppState()
    return <PromptOverlayProvider><Box flexDirection="column">
      <PromptInput {...{
        debug: false, ideSelection: undefined, toolPermissionContext: state.toolPermissionContext, setToolPermissionContext: noop,
        apiKeyStatus: 'valid', commands: [], agents: [], isLoading: false, verbose: false, messages, onAutoUpdaterResult: noop, autoUpdaterResult: null,
        input, onInputChange: setInput, mode: 'prompt', onModeChange: noop, stashedPrompt: undefined, setStashedPrompt: noop, submitCount: 0,
        onShowMessageSelector: noop, mcpClients: [], pastedContents: {}, setPastedContents: noop, vimMode: 'INSERT', setVimMode: noop,
        showBashesDialog: false, setShowBashesDialog: noop, onExit: noop, getToolUseContext: () => ({}), onSubmit: async () => {},
        isSearchingHistory: false, setIsSearchingHistory: noop, helpOpen: false, setHelpOpen: noop,
      } as any} />
      <DialogSlot />
    </Box></PromptOverlayProvider>
  }
  app = await render(<AppStateProvider><Host /></AppStateProvider>, { stdout: stdout as any, stderr: stdout as any, stdin: stdin as any, patchConsole: false, exitOnCtrlC: false })
  try {
    await settle()
    const ink = instances.get(stdout as any) as any
    const root = ink.rootNode as DOMElement
    const dialogOpen = () => textOf(root).includes('Escape closes; R refreshes')

    assert.equal(dialogOpen(), false, 'the dialog starts closed')
    const sessions = findLabel(root, 'Sessions')
    assert.ok(sessions, `Sessions control must render in gateway mode; screen=${textOf(root)}`)
    const rect = nodeCache.get(sessions!)!
    assert.equal(dispatchClick(root, rect.x, rect.y), true, 'clicking Sessions must dispatch a click')
    await settle()
    assert.equal(dialogOpen(), true, 'clicking Sessions must open the dialog')

    // The whole defect: the clicked control must not be left holding focus.
    assert.equal(
      ink.focusManager?.activeElement ?? null,
      null,
      'the Sessions control must not become the keyboard focus target',
    )

    stdin.write('\x1b')
    await settle()
    assert.equal(dialogOpen(), false, 'Escape must close the dialog')
    assert.ok(findLabel(root, 'Sessions'), 'the Sessions control is still mounted behind the dialog')

    stdin.write(' ')
    await settle()
    assert.equal(dialogOpen(), false, 'Space after closing must not reopen the dialog')
    assert.equal(draft, ' ', 'the Space must reach the prompt instead')
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

test('a click on Sessions does not leave Space wired to reopen it', { timeout: 20000 }, () => exerciseSessionsFocus())
