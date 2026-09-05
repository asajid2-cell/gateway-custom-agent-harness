import { strict as assert } from 'node:assert'
import test from 'node:test'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSessionId, getSessionProjectDir, getSessionResumeDirectory, switchSession } from '../src/bootstrap/state.ts'
import { restorePersistForCurrentSession } from '../src/skills/bundled/persist.ts'
import { writePersistSessionRecord, saveSessionName } from '../src/utils/sessionStorage.ts'
import { asSessionId } from '../src/types/ids.ts'
import React from 'react'
import { PassThrough } from 'node:stream'
import { render } from '../src/ink.ts'
import { AppStateProvider } from '../src/state/AppState.tsx'
import { SessionMetadataDialog } from '../src/components/SessionMetadataDialog.tsx'
import { FullscreenLayout } from '../src/components/FullscreenLayout.tsx'
import { useSetPromptOverlayDialog } from '../src/context/promptOverlayContext.tsx'
import { Box, Button, Text, useInput } from '../src/ink.ts'
import instances from '../src/ink/instances.ts'
import { isFullscreenEnvEnabled } from '../src/utils/fullscreen.ts'
import { formatSessionResumeCommand } from '../src/utils/bottomBarUsage.ts'

function MetadataPortal({ onDone }: { onDone: () => void }) {
  const dialog = React.useMemo(() => React.createElement(SessionMetadataDialog, { onDone }), [onDone])
  useSetPromptOverlayDialog(dialog)
  return React.createElement(Text, null, 'PROMPT_ANCHOR')
}

test('metadata and goal UI retain session identity and fullscreen wiring', async () => {
  const dialog = await readFile(new URL('../src/components/SessionMetadataDialog.tsx', import.meta.url), 'utf8')
  const prompt = await readFile(new URL('../src/components/PromptInput/PromptInput.tsx', import.meta.url), 'utf8')
  const footer = await readFile(new URL('../src/components/PromptInput/PromptInputFooter.tsx', import.meta.url), 'utf8')
  assert.match(dialog, /onSessionSwitch\(\(\) => onDone\(\)\)/)
  assert.match(dialog, /saveSessionName\(sessionId, newName, fullPath\)/)
  assert.match(dialog, /placeholder="Unnamed session"/)
  assert.match(dialog, /saving \|\| closing.current/)
  assert.match(dialog, /teammate \|\| !newName/)
  assert.match(prompt, /useSetPromptOverlayDialog\(isFullscreenEnvEnabled\(\) \? promptOverlayDialog/)
  assert.match(footer, /useSyncExternalStore\(subscribePersist, getCurrentPersistRecord/)
  assert.match(dialog, /controlPersistGoal\(action, appStateStore.setState\)/)
})

import {
  MUX_METADATA_READ_ONLY_REASON,
  MUX_METADATA_MUTATION_SUPPORTED,
  MUXCTL_DEFAULT_PORT,
  MUXCTL_MAX_RESPONSE_BYTES,
  buildMuxInfoRequest,
  buildMuxLsRequest,
  getMuxctlUrl,
  loadMuxSessionMetadata,
  matchMuxSession,
  muxMetadataUnavailableText,
  resolveMuxSessionMetadata,
  validateMuxInfoResponse,
  validateMuxLsResponse,
  type MuxWebSocketLike,
} from '../src/utils/muxSessionMetadata.ts'

test('resume command matches the mux directory and UUID form', () => {
  assert.equal(formatSessionResumeCommand('Z:\\different work', '00000000-0000-4000-8000-000000000001'),
    "cd 'Z:\\different work'; & cc --resume 00000000-0000-4000-8000-000000000001")
})

test('Gateway does not opt external users into fullscreen', () => {
  const saved = { gateway: process.env.CLAUDE_CODE_USE_GATEWAY, fullscreen: process.env.CLAUDE_CODE_NO_FLICKER }
  try {
    process.env.CLAUDE_CODE_USE_GATEWAY = '1'
    delete process.env.CLAUDE_CODE_NO_FLICKER
    assert.equal(isFullscreenEnvEnabled(), process.env.USER_TYPE === 'ant')
    process.env.CLAUDE_CODE_NO_FLICKER = '0'
    assert.equal(isFullscreenEnvEnabled(), false)
  } finally {
    if (saved.gateway === undefined) delete process.env.CLAUDE_CODE_USE_GATEWAY
    else process.env.CLAUDE_CODE_USE_GATEWAY = saved.gateway
    if (saved.fullscreen === undefined) delete process.env.CLAUDE_CODE_NO_FLICKER
    else process.env.CLAUDE_CODE_NO_FLICKER = saved.fullscreen
  }
})

for (const control of ['goal', 'pencil']) {
test(`actual footer ${control} responds to terminal mouse input`, async () => {
  const source = await readFile(new URL('../src/components/PromptInput/PromptInputFooter.tsx', import.meta.url), 'utf8')
  const start = source.indexOf(control === 'goal' ? '<Button onAction={() => onOpenSessionMetadata?.()}' : 'export function SessionEditControl')
  const end = control === 'goal' ? source.indexOf('</Button>', start) + '</Button>'.length : source.indexOf('\ntype BridgeStatusProps', start)
  assert.ok(start >= 0 && end > start)
  const snippet = control === 'goal'
    ? `const element = ${source.slice(start, end)};`
    : `${source.slice(start, end).replace('export function', 'function')}\nconst element = React.createElement(SessionEditControl, { onOpen: onOpenSessionMetadata });`
  const code = new Bun.Transpiler({ loader: 'tsx', tsconfig: { compilerOptions: { jsx: 'react' } } }).transformSync(snippet)
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 24, isTTY: true })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} })
  let output = ''
  let opened = false
  stdout.on('data', chunk => { output += chunk.toString() })
  const element = new Function('React', 'Button', 'Text', 'Box', 'persistGoal', 'isNarrow', 'onOpenSessionMetadata', `${code}; return element`)(
    React, Button, Text, Box, { task: 'HOVER_GOAL', status: 'active', keep: true, nudgesRemaining: 2 }, false, () => { opened = true })
  function InputHost() {
    useInput(() => {})
    return element
  }
  const app = await render(React.createElement(InputHost), { stdout: stdout as unknown as NodeJS.WriteStream, stderr: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false, exitOnCtrlC: false })
  try {
    const instance = instances.get(stdout as unknown as NodeJS.WriteStream)!
    instance.setAltScreenActive(true, true)
    await new Promise(resolve => setTimeout(resolve, 100))
    stdin.write('\x1b[<35;1;1M')
    await new Promise(resolve => setTimeout(resolve, 100))
    if (control === 'goal') assert.match(output, /HOVER_GOAL/)
    stdin.write('\x1b[<0;1;1M')
    stdin.write('\x1b[<0;1;1m')
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(opened, true)
    if (control === 'pencil') {
      opened = false
      stdin.write(' ')
      stdin.write('\t')
      stdin.write(' ')
      await new Promise(resolve => setTimeout(resolve, 100))
      assert.equal(opened, false, 'typing Space or tabbing must not activate the pencil')
    }
  } finally { app.unmount() }
})
}

test('native rename appends both resume metadata records to the captured transcript', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'session-rename-'))
  const transcriptPath = join(directory, 'session.jsonl')
  const sessionId = asSessionId('00000000-0000-4000-8000-000000000001')
  try {
    saveSessionName(sessionId, 'Original name', transcriptPath)
    saveSessionName(sessionId, 'Updated name', transcriptPath)
    const entries = (await readFile(transcriptPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(entries.slice(-2), [
      { type: 'custom-title', customTitle: 'Updated name', sessionId },
      { type: 'agent-name', agentName: 'Updated name', sessionId },
    ])
    assert.equal(entries.length, 4)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('inline rename saves typed spaces on Escape and closes exactly once', async () => {
  const original = { id: getSessionId(), project: getSessionProjectDir(), directory: getSessionResumeDirectory() }
  const directory = await mkdtemp(join(tmpdir(), 'rename-input-'))
  const id = asSessionId('00000000-0000-4000-8000-000000000099')
  const previous = process.env.CLAUDE_CODE_NO_FLICKER
  process.env.CLAUDE_CODE_NO_FLICKER = '0'
  switchSession(id, directory)
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24, isTTY: true })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} })
  let closed = 0
  const app = await render(React.createElement(AppStateProvider, null,
    React.createElement(SessionMetadataDialog, { onDone: () => { closed++ } })), {
    stdout: stdout as unknown as NodeJS.WriteStream, stderr: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false, exitOnCtrlC: false,
  })
  try {
    await new Promise(resolve => setTimeout(resolve, 100))
    stdin.write('Reliable session name')
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(closed, 0)
    stdin.write('\x1b')
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(closed, 1)
    const records = (await readFile(join(directory, `${id}.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(records.filter(record => record.type === 'custom-title').length, 1)
    assert.equal(records.find(record => record.type === 'custom-title').customTitle, 'Reliable session name')
  } finally {
    app.unmount()
    switchSession(original.id, original.project, original.directory)
    if (previous === undefined) delete process.env.CLAUDE_CODE_NO_FLICKER
    else process.env.CLAUDE_CODE_NO_FLICKER = previous
    await rm(directory, { recursive: true, force: true })
  }
})

for (const columns of [40, 60, 100]) {
for (const fullscreen of [false, true]) {
test(`metadata dialog scrolls and closes at ${columns} columns, fullscreen=${fullscreen}`, async () => {
  const previousFullscreen = process.env.CLAUDE_CODE_NO_FLICKER
  process.env.CLAUDE_CODE_NO_FLICKER = fullscreen ? '1' : '0'
  const stdout = Object.assign(new PassThrough(), { columns, rows: 24, isTTY: true })
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {},
  })
  const directory = await mkdtemp(join(tmpdir(), 'metadata-scroll-'))
  const transcriptPath = join(directory, `${getSessionId()}.jsonl`)
  await writePersistSessionRecord({
    version: 1, task: `${'Goal detail line\n'.repeat(40)}END_OF_GOAL`,
    mode: 'work', keep: false, nudgesRemaining: 0, nudgesSent: 1,
    status: 'exhausted', initialPlanningResponseAllowed: false,
  }, transcriptPath)
  await restorePersistForCurrentSession(() => {}, transcriptPath)
  let output = ''
  let closed = false
  stdout.on('data', chunk => { output += chunk.toString() })
  const onDone = () => { closed = true }
  const content = fullscreen
    ? React.createElement(FullscreenLayout, {
        scrollable: React.createElement(Text, null, 'TRANSCRIPT_ANCHOR'),
        bottom: React.createElement(MetadataPortal, { onDone }),
      })
    : React.createElement(SessionMetadataDialog, { onDone })
  const app = await render(React.createElement(AppStateProvider, null,
    React.createElement(Box, { height: 24, width: columns, flexDirection: 'column' }, content)), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false, exitOnCtrlC: false,
  })
  try {
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.match(output.replace(/\x1b\[1C/g, ' '), /Session metadata/)
    assert.equal(output.includes('END_OF_GOAL'), false)
    for (let page = 0; page < 12; page++) {
      stdin.write('\x1b[6~')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(output.includes('END_OF_GOAL'), true)
    stdin.write('\x1b')
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(closed, true)
  } finally {
    app.unmount()
    await rm(directory, { recursive: true, force: true })
    await restorePersistForCurrentSession(() => {}, transcriptPath)
    if (previousFullscreen === undefined) delete process.env.CLAUDE_CODE_NO_FLICKER
    else process.env.CLAUDE_CODE_NO_FLICKER = previousFullscreen
  }
})
}
}

const info = {
  t: 'info',
  protocol: 4,
  caps: ['ls', 'info', 'rename'],
}

const session = {
  name: 'Local work',
  sessionId: 'native-session-id',
  aliases: ['legacy-session-id'],
  sessionUuid: 'mux-uuid',
  identityPending: false,
  lifecycle: 'active',
}

class FakeWebSocket implements MuxWebSocketLike {
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onclose: (() => void) | null = null
  readonly sent: string[] = []
  closeCount = 0

  constructor(private readonly responses: Record<string, unknown>) {}

  send(data: string): void {
    this.sent.push(data)
    const request = JSON.parse(data) as { t: string }
    queueMicrotask(() => {
      this.onmessage?.({ data: JSON.stringify(this.responses[request.t]) })
    })
  }

  close(): void {
    this.closeCount += 1
    this.readyState = 3
  }
}

test('read request builders never construct mutation requests', () => {
  assert.deepEqual(buildMuxInfoRequest(), { t: 'info' })
  assert.deepEqual(buildMuxLsRequest(), { t: 'ls' })
  assert.equal(MUX_METADATA_MUTATION_SUPPORTED, false)
  assert.match(MUX_METADATA_READ_ONLY_REASON, /read-only|informational/i)
})

test('mux endpoint uses the configured loopback port and safe fallback', () => {
  assert.equal(getMuxctlUrl({ MUXCTL_PORT: '7701' }), 'ws://127.0.0.1:7701')
  assert.equal(
    getMuxctlUrl({ MUXCTL_PORT: 'not-a-port' }),
    `ws://127.0.0.1:${MUXCTL_DEFAULT_PORT}`,
  )
  assert.equal(getMuxctlUrl({ MUXCTL_PORT: '70000' }), `ws://127.0.0.1:${MUXCTL_DEFAULT_PORT}`)
})

test('runtime validators accept the bounded mux response shapes', () => {
  assert.deepEqual(validateMuxInfoResponse(info), info)
  assert.deepEqual(validateMuxLsResponse({ t: 'ls', list: [session] }), {
    t: 'ls',
    list: [session],
  })
  assert.deepEqual(validateMuxLsResponse({ t: 'ls', list: [] }), {
    t: 'ls',
    list: [],
  })
})

test('runtime validators reject malformed and oversized-shaped responses', () => {
  assert.equal(validateMuxInfoResponse({ t: 'info', protocol: '4', caps: [] }), null)
  assert.equal(validateMuxInfoResponse({ t: 'info', protocol: 4, caps: ['x'.repeat(129)] }), null)
  assert.equal(validateMuxLsResponse({ t: 'ls', list: [{ ...session, name: '' }] }), null)
  assert.equal(validateMuxLsResponse({ t: 'ls', list: [{ ...session, aliases: [''] }] }), null)
  assert.equal(validateMuxLsResponse({ t: 'ls', list: [{ ...session, tags: ['x'.repeat(129)] }] }), null)
  assert.equal(
    validateMuxLsResponse({ t: 'ls', list: new Array(4097).fill(session) }),
    null,
  )
})

test('identity matching requires exact canonical IDs or aliases and rejects ambiguity', () => {
  assert.deepEqual(matchMuxSession([session], 'native-session-id'), {
    status: 'matched',
    session,
  })
  assert.deepEqual(matchMuxSession([session], 'NATIVE-SESSION-ID'), {
    status: 'mismatched',
  })
  assert.deepEqual(matchMuxSession([session], ' native-session-id '), {
    status: 'mismatched',
  })
  assert.deepEqual(matchMuxSession([session], 'legacy-session-id'), {
    status: 'matched',
    session,
  })
  assert.deepEqual(matchMuxSession([session], 'other-session-id'), {
    status: 'mismatched',
  })
  assert.deepEqual(matchMuxSession([], 'native-session-id'), {
    status: 'mismatched',
  })

  const duplicate = { ...session, name: 'Duplicate' }
  const ambiguous = matchMuxSession([session, duplicate], 'native-session-id')
  assert.equal(ambiguous.status, 'ambiguous')
  if (ambiguous.status === 'ambiguous') {
    assert.equal(ambiguous.sessions.length, 2)
  }
})

test('metadata resolution is read-only and never invents native tags', () => {
  const result = resolveMuxSessionMetadata(
    validateMuxInfoResponse(info),
    validateMuxLsResponse({ t: 'ls', list: [session] }),
    'native-session-id',
  )
  assert.deepEqual(result, {
    available: true,
    metadata: {
      name: 'Local work',
      sessionId: 'native-session-id',
      aliases: ['legacy-session-id'],
      readOnly: true,
      mutation: {
        supported: false,
        reason: MUX_METADATA_READ_ONLY_REASON,
      },
    },
  })

  assert.deepEqual(
    resolveMuxSessionMetadata(
      validateMuxInfoResponse(info),
      validateMuxLsResponse({ t: 'ls', list: [{ ...session, tags: ['mux-tag'] }] }),
      'native-session-id',
    ),
    {
      available: true,
      metadata: {
        name: 'Local work',
        tags: ['mux-tag'],
        sessionId: 'native-session-id',
        aliases: ['legacy-session-id'],
        readOnly: true,
        mutation: {
          supported: false,
          reason: MUX_METADATA_READ_ONLY_REASON,
        },
      },
    },
  )

  assert.deepEqual(
    resolveMuxSessionMetadata(
      validateMuxInfoResponse(info),
      validateMuxLsResponse({ t: 'ls', list: [{ ...session, name: 'Other' }] }),
      'native-session-id',
    ),
    {
      available: true,
      metadata: {
        name: 'Other',
        sessionId: 'native-session-id',
        aliases: ['legacy-session-id'],
        readOnly: true,
        mutation: {
          supported: false,
          reason: MUX_METADATA_READ_ONLY_REASON,
        },
      },
    },
  )
})

test('metadata resolution fails closed for malformed, unsupported, ambiguous, and mismatched data', () => {
  assert.deepEqual(resolveMuxSessionMetadata(null, validateMuxLsResponse({ t: 'ls', list: [] }), 'id'), {
    available: false,
    reason: 'malformed-info',
  })
  assert.deepEqual(resolveMuxSessionMetadata(validateMuxInfoResponse(info), null, 'id'), {
    available: false,
    reason: 'malformed-list',
  })
  assert.deepEqual(
    resolveMuxSessionMetadata(
      validateMuxInfoResponse({ t: 'info', protocol: 4, caps: ['info'] }),
      validateMuxLsResponse({ t: 'ls', list: [session] }),
      'native-session-id',
    ),
    { available: false, reason: 'unsupported' },
  )
  assert.deepEqual(
    resolveMuxSessionMetadata(
      validateMuxInfoResponse(info),
      validateMuxLsResponse({ t: 'ls', list: [{ ...session, name: 'A' }, { ...session, name: 'B' }] }),
      'native-session-id',
    ),
    { available: false, reason: 'ambiguous' },
  )
  assert.deepEqual(
    resolveMuxSessionMetadata(
      validateMuxInfoResponse(info),
      validateMuxLsResponse({ t: 'ls', list: [session] }),
      'not-the-session',
    ),
    { available: false, reason: 'mismatched' },
  )
})

test('bounded websocket client sends only info and ls and closes both connections', async () => {
  const sockets: FakeWebSocket[] = []
  const result = await loadMuxSessionMetadata('native-session-id', {
    env: { MUXCTL_PORT: '7710' },
    maxResponseBytes: MUXCTL_MAX_RESPONSE_BYTES,
    webSocketFactory: async () => {
      const socket = new FakeWebSocket({ info, ls: { t: 'ls', list: [session] } })
      sockets.push(socket)
      return socket
    },
  })

  assert.equal(result.available, true)
  assert.equal(sockets.length, 2)
  assert.deepEqual(
    sockets.flatMap(socket => socket.sent.map(data => JSON.parse(data))),
    [{ t: 'info' }, { t: 'ls' }],
  )
  assert.deepEqual(sockets.map(socket => socket.closeCount), [1, 1])
})

test('oversized websocket data is rejected without exposing metadata', async () => {
  const socketFactory = async () => {
    const socket = new FakeWebSocket({
      info: 'x'.repeat(128),
      ls: { t: 'ls', list: [session] },
    })
    return socket
  }
  const result = await loadMuxSessionMetadata('native-session-id', {
    maxResponseBytes: 32,
    webSocketFactory: socketFactory,
  })
  assert.deepEqual(result, { available: false, reason: 'unavailable' })
})

test('unavailable text explains that mux metadata is disabled', () => {
  assert.match(muxMetadataUnavailableText('ambiguous'), /disabled/i)
  assert.match(muxMetadataUnavailableText('mismatched'), /identified/i)
})
