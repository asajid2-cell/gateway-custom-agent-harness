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
