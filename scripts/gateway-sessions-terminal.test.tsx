import React from 'react'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { PassThrough } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render, Box } from '../src/ink.ts'
import { AppStateProvider } from '../src/state/AppState.tsx'
import { GatewaySessionsDialog } from '../src/components/GatewaySessionsDialog.tsx'
import { GatewaySessionRuntime } from '../src/utils/gatewaySessionRuntime.ts'
import { getSessionId } from '../src/bootstrap/state.ts'

test('sessions panel renders live identity and handles policy keys and escape', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sessions-panel-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = root
  const runtime = new GatewaySessionRuntime(getSessionId(), root, 'TERMINAL_PEER')
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24, isTTY: true })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} })
  let output = ''
  let closed = false
  stdout.on('data', chunk => { output += chunk.toString() })
  let app: Awaited<ReturnType<typeof render>> | undefined
  try {
    await runtime.start(new Set())
    app = await render(<AppStateProvider><Box width={80} height={24}><GatewaySessionsDialog onDone={() => { closed = true }} /></Box></AppStateProvider>, { stdout: stdout as unknown as NodeJS.WriteStream, stderr: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false, exitOnCtrlC: false })
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 10000
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Terminal observation timed out')
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
    await waitFor(() => output.includes('TERMINAL_PEER'))
    assert.ok(output.includes(getSessionId()))
    // A peer with no checkpoint - an older session, or one that has never
    // compacted - renders without a count line rather than as a naked zero.
    assert.equal(output.includes('full compactions'), false)
    await runtime.transport.update({ compactBoundaryCount: 4, microcompactBoundaryCount: 9 })
    stdin.write('r')
    await waitFor(() => output.includes('4 full compactions') && output.includes('9 microcompactions'))
    stdin.write('h')
    await waitFor(() => output.replace(/\x1b\[1C/g, ' ').includes('Inbound policy: hold'))
    stdin.write('\x1b')
    await waitFor(() => closed)
  } finally {
    app?.unmount()
    await runtime.close()
    const { releaseGatewaySessionWriter } = await import('../src/utils/gatewaySessionOwnership.ts')
    await releaseGatewaySessionWriter(runtime.transport.peer.sessionId)
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})
