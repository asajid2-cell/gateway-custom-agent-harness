import React from 'react'
import { test, expect } from 'bun:test'
import { PassThrough } from 'node:stream'
import { Buffer } from 'buffer'
import { Text, render } from '../src/ink.ts'
import { Message } from '../src/components/Message.tsx'
import { AssistantThinkingMessage } from '../src/components/messages/AssistantThinkingMessage.tsx'
import { AppStateProvider, getDefaultAppState } from '../src/state/AppState.tsx'
import { createAssistantMessage } from '../src/utils/messages.ts'

// Proof that a thinking block reaches the screen in the ordinary conversation
// view, not only under verbose or in transcript mode. The regression this
// guards is silent: the request carries `thinking`, the provider streams the
// block, and the view renders nothing at all because the block was gated behind
// two modes nobody has on by default.

const COLUMNS = 80

async function capture(
  element: React.ReactElement,
  showThinking = true,
): Promise<string> {
  const stdout = Object.assign(new PassThrough(), {
    columns: COLUMNS,
    rows: 40,
    isTTY: true,
  })
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode() {},
    ref() {},
    unref() {},
  })
  const writes: string[] = []
  const realWrite = stdout.write.bind(stdout)
  stdout.write = (chunk: unknown, ...rest: unknown[]) => {
    writes.push(
      typeof chunk === 'string'
        ? chunk
        : Buffer.isBuffer(chunk)
          ? chunk.toString('utf8')
          : String(chunk),
    )
    return (realWrite as any)(chunk, ...rest)
  }
  const tree = (
    <AppStateProvider initialState={{ ...getDefaultAppState(), showThinking }}>
      {element}
    </AppStateProvider>
  )
  const instance = await render(tree, { stdout, stdin })
  // One extra turn of the loop so a layout pass has produced the frame.
  await new Promise(resolve => setTimeout(resolve, 20))
  instance.unmount()
  // Ink positions every word with a cursor sequence and publishes an element
  // map on the same stream, so the raw bytes never contain a sentence intact.
  // Strip both, then collapse the whitespace the sequences leave behind.
  return writes
    .join('')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, ' ')
    .replace(/\s+/g, ' ')
}

function thinkingMessage(thinking: string) {
  return createAssistantMessage({
    content: [
      { type: 'thinking', thinking, signature: 'sig' },
      { type: 'text', text: 'The answer.' },
    ],
  })
}

test('a completed thinking block renders in the ordinary view', async () => {
  const output = await capture(
    <Message
      message={thinkingMessage('Let me work out whether 17 times 23 is 391.')}
      lookups={{} as any}
      addMargin={false}
      tools={{} as any}
      commands={[]}
      verbose={false}
      inProgressToolUseIDs={new Set()}
      progressMessagesForMessage={[]}
      shouldAnimate={false}
      shouldShowDot={false}
      isTranscriptMode={false}
      isStatic={true}
      lastThinkingBlockId={null}
    />,
  )
  expect(output).toContain('Thinking')
})

test('the ordinary view prints the thinking text, so it is unmistakably shown', async () => {
  const visible = 'reasoning that the reader should be able to see'
  const output = await capture(
    <Message
      message={thinkingMessage(visible)}
      lookups={{} as any}
      addMargin={false}
      tools={{} as any}
      commands={[]}
      verbose={false}
      inProgressToolUseIDs={new Set()}
      progressMessagesForMessage={[]}
      shouldAnimate={false}
      shouldShowDot={false}
      isTranscriptMode={false}
      isStatic={true}
      lastThinkingBlockId={null}
    />,
  )
  expect(output).toContain('Thinking')
  expect(output).toContain('reasoning that the reader should be able to see')
})

test('a long block is tailed in the ordinary view, not printed whole', async () => {
  const lines = Array.from({ length: 40 }, (_, index) => `line-${index + 1}`)
  const output = await capture(
    <Message
      message={thinkingMessage(lines.join('\n'))}
      lookups={{} as any}
      addMargin={false}
      tools={{} as any}
      commands={[]}
      verbose={false}
      inProgressToolUseIDs={new Set()}
      progressMessagesForMessage={[]}
      shouldAnimate={false}
      shouldShowDot={false}
      isTranscriptMode={false}
      isStatic={true}
      lastThinkingBlockId={null}
    />,
  )
  expect(output).toContain('line-40')
  expect(output).not.toContain('line-1 ')
  expect(output).toContain('earlier lines hidden')
})

test('/toggle-thinking off hides the completed block again', async () => {
  const output = await capture(
    <Message
      message={thinkingMessage('hidden when the display is off')}
      lookups={{} as any}
      addMargin={false}
      tools={{} as any}
      commands={[]}
      verbose={false}
      inProgressToolUseIDs={new Set()}
      progressMessagesForMessage={[]}
      shouldAnimate={false}
      shouldShowDot={false}
      isTranscriptMode={false}
      isStatic={true}
      lastThinkingBlockId={null}
    />,
    false,
  )
  expect(output).not.toContain('Thinking')
})

test('a thinking block still renders its text while it is streaming', async () => {
  const output = await capture(
    <AssistantThinkingMessage
      param={{ type: 'thinking', thinking: 'half a thought so far' }}
      addMargin={false}
      isTranscriptMode={false}
      verbose={false}
      streaming={true}
      startedAt={Date.now() - 2000}
    />,
  )
  expect(output).toContain('half a thought so far')
  expect(output).toContain('Thinking')
})

test('nothing renders without a thinking block', async () => {
  const output = await capture(
    <Text>plain</Text>,
  )
  expect(output).toContain('plain')
})
