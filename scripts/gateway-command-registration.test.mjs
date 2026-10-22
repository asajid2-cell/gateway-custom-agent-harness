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
const loginImplementationSource = await readFile(
  new URL('../src/commands/gateway-login/login.tsx', import.meta.url),
  'utf8',
)

test('gateway login command objects expose the expected interactive names', () => {
  assert.match(loginSource, /command\(\s*'opencodelogin'/)
  assert.match(loginSource, /command\(\s*'deepseeklogin'/)
  assert.match(loginSource, /command\(\s*'commandcodelogin'/)
  assert.match(loginSource, /type:\s*'local-jsx'/)
})

test('commandcodelogin advertises the account selection argument hint', () => {
  assert.match(
    loginSource,
    /keyName === 'opencode-go' \|\| keyName === 'commandcode'\s*\n\s*\?\s*'\[new\|switch <number> \[session\|global\]\|status\|remove\]'/,
  )
  assert.match(loginSource, /command\(\s*'commandcodelogin'/)
})

test('commandcode keys are labelled and routed as Command Code slots', () => {
  assert.match(loginImplementationSource, /if \(keyName\.startsWith\('commandcode'\)\) \{\s*\n\s*const suffix = keyName\.slice\('commandcode'\.length\)/)
  assert.match(loginImplementationSource, /if \(keyName\.startsWith\('commandcode'\)\) return 'commandcodelogin'/)
})

test('commandcode login supports new, switch, and status against the gateway', () => {
  assert.match(loginImplementationSource, /'\/gateway\/commandcode-account'/)
  assert.match(loginImplementationSource, /nextKeySlot\(accountKeyPrefix\)/)
  assert.match(loginImplementationSource, /accountKeyPrefix === 'commandcode' \? 'Command Code' : 'OpenCode'/)
  assert.match(loginImplementationSource, /`\$\{label\} account \$\{result\.number\} selected /)
  assert.match(loginImplementationSource, /`\$\{label\} active account: \$\{result\.number\}; global default:/)
  assert.match(loginImplementationSource, /Automatic fallback remains enabled\.`/)
})

test('gateway login commands are included in the built-in command registry', () => {
  assert.match(commandsSource, /\bdeepSeekLoginCommand,\s*[\r\n]\s*effort/)
  assert.match(commandsSource, /\bmodel,\s*[\r\n]\s*openCodeLoginCommand/)
  assert.match(commandsSource, /\bopenCodeLoginCommand,\s*[\r\n]\s*commandCodeLogin/)
})
