import React, { useState } from 'react'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { PassThrough } from 'node:stream'
import { render } from '../src/ink.ts'
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

export async function exercisePromptWorkspace(views: import('../src/utils/leafWorkspace.ts').LeafView[] = []): Promise<void> {
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
    for (const [label, minimumWidth] of [['Sessions', 8], [`All ${views.length + 1}`, 5]] as const) {
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
    return <PromptInput {...{
      debug: false, ideSelection: undefined, toolPermissionContext: state.toolPermissionContext, setToolPermissionContext: noop,
      apiKeyStatus: 'valid', commands: [], agents: [], isLoading: false, verbose: false, messages: representativeMessages, onAutoUpdaterResult: noop, autoUpdaterResult: null,
      input, onInputChange: setInput, mode: 'prompt', onModeChange: noop, stashedPrompt: undefined, setStashedPrompt: noop, submitCount: 0,
      onShowMessageSelector: noop, mcpClients: [], pastedContents: {}, setPastedContents: noop, vimMode: 'INSERT', setVimMode: noop,
      showBashesDialog: false, setShowBashesDialog: noop, onExit: noop, getToolUseContext: () => ({}), onSubmit: async (text: string) => { submitted.push(text) },
      isSearchingHistory: false, setIsSearchingHistory: noop, helpOpen: false, setHelpOpen: noop,
    } as any} />
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
    await click(`All ${views.length + 1}`)
    assert.ok(textOf(root).includes('All sessions'), 'Expanded session picker must render')
    if (views.length) await click(`${views[0]!.member.number} ${views[0]!.member.name} [${views[0]!.process.getState()}]`)
    else await click('Close list')
    stdout.columns = 60
    stdout.emit('resize')
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(currentDraft, 'ORIGINAL_DRAFT appended')
    if (views.length > 0) {
      for (let index = 0; index < views.length; index++) {
        const marker = index === 0 ? 'TERMINAL_FIRST_LEAF' : index === 1 ? 'TERMINAL_SECOND_LEAF' : `TERMINAL_LEAF_${index + 1}`
        stdin.write(marker)
        await new Promise(resolve => setTimeout(resolve, 150))
        assert.equal(views[index].draft, marker, `Leaf ${index + 1} must show its own draft before submission`)
        stdin.write('\r')
        await new Promise(resolve => setTimeout(resolve, 150))
        if (index + 1 < views.length) {
          await click(`All ${views.length + 1}`)
          const next = views[index + 1]!
          await click(`${next.member.number} ${next.member.name} [${next.process.getState()}]`)
        } else stdin.write('\x1b')
        await new Promise(resolve => setTimeout(resolve, 150))
      }
    }
    assert.equal(currentDraft, 'ORIGINAL_DRAFT appended', 'Leaf typing and submission must not alter original input')
    const closeDeadline = Date.now() + 10000
    while (textOf(root).includes('wheel switches')) {
      assert.equal(textOf(root).includes('Drafts could not be saved'), false, 'Workspace exit must save all leaf drafts')
      if (Date.now() > closeDeadline) throw new Error('Workspace did not return to original prompt after saving drafts')
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    await new Promise(resolve => setTimeout(resolve, 150))
    stdin.write(' after')
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(currentDraft, 'ORIGINAL_DRAFT appended after')
    stdin.write('\x1b[200~ pasted世界\x1b[201~\r')
    await new Promise(resolve => setTimeout(resolve, 500))
    assert.equal(currentDraft, 'ORIGINAL_DRAFT appended after pasted世界')
    assert.deepEqual(submitted, ['ORIGINAL_DRAFT appended after pasted世界'])
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

test('actual prompt footer opens leaves and returns to original draft', { timeout: 15000 }, () => exercisePromptWorkspace())
