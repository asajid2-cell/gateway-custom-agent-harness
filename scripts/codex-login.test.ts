import assert from 'node:assert/strict'
import test from 'node:test'
import { parseDevicePrompt } from '../src/commands/gateway-login/codex-login.js'

// The shape the CLI actually prints (ANSI coloured), observed from
// `codex login --device-auth`; the code is a fixture, not a real one.
const OUTPUT =
  '\nWelcome to Codex [v\u001b[90m0.147.0\u001b[0m]\n' +
  "\u001b[90mOpenAI's command-line agent\u001b[0m\n\n" +
  'Follow these steps to sign in with ChatGPT using device code authorization:\n\n' +
  '1. Open this link in your browser and sign in to your account\n' +
  '   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n\n' +
  '2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m\n' +
  '   \u001b[94mABCD-EFGHI\u001b[0m\n\n' +
  '\u001b[90mDevice codes are a common phishing target. Never share this code.\u001b[0m\n'

test('the device prompt yields exactly the URL and the one-time code', () => {
  assert.deepEqual(parseDevicePrompt(OUTPUT), {
    url: 'https://auth.openai.com/codex/device',
    code: 'ABCD-EFGHI',
  })
})

test('a partial read is parsed when only the URL has arrived', () => {
  const head = OUTPUT.slice(0, OUTPUT.indexOf('ABCD'))
  assert.deepEqual(parseDevicePrompt(head), {
    url: 'https://auth.openai.com/codex/device',
    code: null,
  })
})

test('text without the banner yields nothing rather than a guess', () => {
  assert.deepEqual(parseDevicePrompt('Welcome to Codex\nstarting...\n'), { url: null, code: null })
})
