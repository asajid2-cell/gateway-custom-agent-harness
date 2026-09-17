import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const commandsSource = await readFile(
  new URL('../src/commands.ts', import.meta.url),
  'utf8',
)
const loginSource = await readFile(
  new URL('../src/commands/gateway-login/index.ts', import.meta.url),
  'utf8',
)

test('gateway login command objects expose the expected interactive names', () => {
  assert.match(loginSource, /command\(\s*'opencodelogin'/)
  assert.match(loginSource, /command\(\s*'deepseeklogin'/)
  assert.match(loginSource, /command\(\s*'commandcodelogin'/)
  assert.match(loginSource, /type:\s*'local-jsx'/)
})

test('gateway login commands are included in the built-in command registry', () => {
  assert.match(commandsSource, /\bdeepSeekLoginCommand,\s*[\r\n]\s*effort/)
  assert.match(commandsSource, /\bmodel,\s*[\r\n]\s*openCodeLoginCommand/)
  assert.match(commandsSource, /\bopenCodeLoginCommand,\s*[\r\n]\s*commandCodeLogin/)
})
