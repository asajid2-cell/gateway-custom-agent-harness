import React from 'react'
import { expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { render, ThemeProvider, Box, Text } from '../src/ink.ts'
import { VirtualMessageList } from '../src/components/VirtualMessageList.tsx'
import ScrollBox from '../src/ink/components/ScrollBox.tsx'
import type { ScrollBoxHandle } from '../src/ink/components/ScrollBox.tsx'
import type { RenderableMessage } from '../src/types/message.ts'
import instances from '../src/ink/instances.ts'
import { cellAt, type Screen } from '../src/ink/screen.ts'
import { Messages } from '../src/components/Messages.tsx'
import { AppStateProvider } from '../src/state/AppState.tsx'
import {
  createAssistantMessage,
  createSystemMessage,
  createUserMessage,
  type StreamingToolUse,
} from '../src/utils/messages.ts'
import type { Message } from '../src/types/message.ts'

function visibleRows(screen: Screen) {
  const rows: string[] = []
  for (let y = 0; y < screen.height; y++) {
    let row = ''
    for (let x = 0; x < screen.width; x++) row += cellAt(screen, x, y)?.char ?? ' '
    if (row.trim()) rows.push(row.trim())
  }
  return rows
}

function createTerminal() {
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24, isTTY: true })
  stdout.resume()
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true, setRawMode() {}, ref() {}, unref() {},
  })
  return { stdout, stdin }
}

function currentScreen(stdout: PassThrough): Screen {
  const ink = instances.get(stdout as any) as unknown as { frontFrame: { screen: Screen } }
  return ink.frontFrame.screen
}

const settle = () => new Promise(resolve => setTimeout(resolve, 70))

test('virtual message updates never orphan duplicate assistant rows', async () => {
  const { stdout, stdin } = createTerminal()
  const scrollRef = React.createRef<ScrollBoxHandle>()
  const message = (uuid: string) => ({
    type: 'assistant', uuid,
    message: { content: [{ type: 'text', text: uuid }] },
  }) as RenderableMessage
  const stable = message('startup warning')
  const first = message('First assistant sentence')
  const tool = message('Streaming tool')
  const second = message('Second assistant sentence')
  const group = message('Collapsed tool group')
  const last = message('Last assistant sentence')
  const itemKey = (m: RenderableMessage) => m.uuid
  const renderItem = (m: RenderableMessage) => <Box key={m.uuid}><Text>{m.uuid}</Text></Box>
  const view = (messages: RenderableMessage[]) => (
    <ThemeProvider>
      <Box height={24} flexDirection="column">
        <ScrollBox ref={scrollRef} height={20} flexDirection="column">
          <VirtualMessageList messages={messages} scrollRef={scrollRef} columns={80}
            itemKey={itemKey} renderItem={renderItem} />
        </ScrollBox>
      </Box>
    </ThemeProvider>
  )
  const app = await render(view([]), {
    stdout: stdout as any, stdin: stdin as any, stderr: stdout as any,
    patchConsole: false, exitOnCtrlC: false,
  })
  try {
    const updates = [
      [stable, tool],
      // Deferred text catches up behind an already-visible streaming tool.
      [stable, first, tool],
      [stable, first, tool, second],
      // Grouping replaces interior rows without changing the length.
      [stable, first, second, group],
      [stable, first, second, group, last],
      // A prefix refresh used to rebuild the corrupt key array, leaving an
      // orphaned copy of `first` mounted by React's duplicate-key reconciliation.
      [{ ...stable }, first, second, group, last],
      [{ ...stable }, first, second, group, last],
      [first, second],
      [],
      [last],
    ]
    for (const messages of updates) {
      app.rerender(view(messages))
      await settle()
      expect(visibleRows(currentScreen(stdout))).toEqual(messages.map(itemKey))
    }
  } finally {
    app.unmount()
    app.cleanup()
  }
})

test('Messages tool lifecycle and scrolling never duplicate assistant text', async () => {
  const { stdout, stdin } = createTerminal()
  const scrollRef = React.createRef<ScrollBoxHandle>()
  const warning = createSystemMessage('Identity regression startup warning', 'warning')
  const first = createAssistantMessage({ content: 'IDENTITY_SENTINEL_FIRST' })
  const second = createAssistantMessage({ content: 'IDENTITY_SENTINEL_SECOND' })
  const last = createAssistantMessage({ content: 'IDENTITY_SENTINEL_LAST' })
  const filler = Array.from({ length: 18 }, (_, i) =>
    createAssistantMessage({ content: `identity filler row ${i}` }),
  )
  const toolBlock = {
    type: 'tool_use' as const,
    id: 'toolu_identity_regression',
    name: 'UnknownIdentityTool',
    input: { path: 'identity.txt' },
  }
  const persistedTool = createAssistantMessage({ content: [toolBlock] })
  const toolResult = createUserMessage({
    content: [{
      type: 'tool_result',
      tool_use_id: toolBlock.id,
      content: 'identity tool result',
    }],
    toolUseResult: 'identity tool result',
    sourceToolAssistantUUID: persistedTool.uuid,
  })
  const streaming = (input: Record<string, unknown>): StreamingToolUse[] => [{
    index: 0,
    contentBlock: { ...toolBlock, input },
    unparsedToolInput: JSON.stringify(input),
  }]

  const view = (messages: Message[], streamingToolUses: StreamingToolUse[]) => (
    <AppStateProvider>
      <ThemeProvider>
        <Box height={24} flexDirection="column">
          <ScrollBox ref={scrollRef} height={18} flexDirection="column" stickyScroll>
            <Messages
              messages={messages}
              tools={[]}
              commands={[]}
              verbose={false}
              toolJSX={null}
              toolUseConfirmQueue={[]}
              inProgressToolUseIDs={new Set()}
              isMessageSelectorVisible={false}
              conversationId="identity-regression"
              screen="prompt"
              streamingToolUses={streamingToolUses}
              isLoading={streamingToolUses.length > 0}
              hideLogo
              scrollRef={scrollRef}
            />
          </ScrollBox>
        </Box>
      </ThemeProvider>
    </AppStateProvider>
  )

  const app = await render(view([], []), {
    stdout: stdout as any, stdin: stdin as any, stderr: stdout as any,
    patchConsole: false, exitOnCtrlC: false,
  })
  const states: Array<[Message[], StreamingToolUse[]]> = [
    [[warning, first], streaming({})],
    [[warning, first], streaming({ path: 'identity.txt' })],
    // Deferred finalized text catches up while the synthetic tool row exists.
    [[warning, first, second], streaming({ path: 'identity.txt' })],
    // The finalized tool replaces the synthetic row, then receives its result.
    [[warning, first, second, persistedTool], []],
    [[warning, first, second, persistedTool, toolResult], []],
    [[warning, first, second, persistedTool, toolResult, ...filler, last], []],
    // Re-enter streaming and refresh the stable prefix after viewport movement.
    [[warning, first, second, ...filler, last], streaming({ path: 'again.txt' })],
    [[{ ...warning }, first, second, ...filler, last], streaming({ path: 'again.txt' })],
    [[{ ...warning }, first, second, ...filler, last], []],
  ]

  try {
    for (let i = 0; i < states.length; i++) {
      const [messages, streamingToolUses] = states[i]!
      app.rerender(view(messages, streamingToolUses))
      await settle()
      const assertUnique = () => {
        const text = visibleRows(currentScreen(stdout)).join('\n')
        for (const sentinel of [
          'IDENTITY_SENTINEL_FIRST',
          'IDENTITY_SENTINEL_SECOND',
          'IDENTITY_SENTINEL_LAST',
        ]) {
          expect(text.split(sentinel).length - 1).toBeLessThanOrEqual(1)
        }
        return text
      }
      if (i === 5) {
        scrollRef.current?.scrollTo(0)
        await settle()
        const topText = assertUnique()
        expect(topText).toContain('IDENTITY_SENTINEL_FIRST')
        expect(topText).toContain('IDENTITY_SENTINEL_SECOND')
        scrollRef.current?.scrollToBottom()
        await settle()
      }
      const text = assertUnique()
      if (i < 5) {
        expect(text).toContain('IDENTITY_SENTINEL_FIRST')
        if (i >= 2) expect(text).toContain('IDENTITY_SENTINEL_SECOND')
      }
      if (i >= 5) expect(text).toContain('IDENTITY_SENTINEL_LAST')
    }
  } finally {
    app.unmount()
    app.cleanup()
  }
})
