import assert from 'node:assert/strict'
import test from 'node:test'

import { fitMediaToGatewayBodyLimit } from '../src/utils/gatewayMediaFit.js'

// The fit only runs in gateway mode; that is the environment these tests model.
process.env.CLAUDE_CODE_USE_GATEWAY = '1'

const MODEL = 'gateway-commandcode-deepseek-v4.1-flash'

function image(size: number) {
  return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(size) } }
}

function userMessage(content: unknown[]) {
  return { type: 'user', message: { role: 'user', content } }
}

test('an image over the provider ceiling is withheld with a reason the model can act on', () => {
  const messages = [userMessage([{ type: 'text', text: 'what is this?' }, image(20_000_000)])]
  const fitted = fitMediaToGatewayBodyLimit(messages, MODEL)
  assert.equal(fitted.provider, 'Command Code')
  assert.equal(fitted.stripped, 1)
  const block = (fitted.messages[0] as any).message.content[1]
  assert.equal(block.type, 'text')
  assert.match(block.text, /image withheld/)
  assert.match(block.text, /Read tool/)
  // The question itself is untouched.
  assert.equal((fitted.messages[0] as any).message.content[0].text, 'what is this?')
})

test('a request under the ceiling keeps every image', () => {
  const messages = [userMessage([image(1000), image(1000)])]
  const fitted = fitMediaToGatewayBodyLimit(messages, MODEL)
  assert.equal(fitted.stripped, 0)
  assert.equal(fitted.messages, messages)
})

test('the oldest images go first, so the ones just read survive', () => {
  const messages = [
    userMessage([image(10_000_000)]),
    userMessage([image(10_000_000)]),
    userMessage([image(5_000_000)]),
  ]
  const fitted = fitMediaToGatewayBodyLimit(messages, MODEL)
  assert.equal(fitted.stripped, 1)
  assert.equal((fitted.messages[0] as any).message.content[0].type, 'text')
  assert.equal((fitted.messages[1] as any).message.content[0].type, 'image')
  assert.equal((fitted.messages[2] as any).message.content[0].type, 'image')
})

test('an image inside a Read result names the file it came from', () => {
  const messages = [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'C:/shots/page.png' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: [image(20_000_000)] }] } },
  ]
  const fitted = fitMediaToGatewayBodyLimit(messages, MODEL)
  assert.equal(fitted.stripped, 1)
  const block = (fitted.messages[1] as any).message.content[0].content[0]
  assert.match(block.text, /C:\/shots\/page\.png/)
  assert.match(block.text, /Read tool/)
})
