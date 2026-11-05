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
    /keyName === 'opencode-go' \|\| keyName === 'commandcode' \|\| keyName === 'mistral'\s*\n\s*\?\s*'\[new\|switch <number> \[session\|global\]\|status\|remove\]'/,
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
  assert.match(
    loginImplementationSource,
    /accountKeyPrefix === 'commandcode' \? 'Command Code' : accountKeyPrefix === 'mistral' \? 'Mistral' : 'OpenCode'/,
  )
  assert.match(loginImplementationSource, /`\$\{label\} account \$\{result\.number\} selected /)
  assert.match(loginImplementationSource, /`\$\{label\} active account: \$\{result\.number\}; global default:/)
  assert.match(loginImplementationSource, /Automatic fallback remains enabled\.`/)
})

test('gateway login commands are included in the built-in command registry', () => {
  assert.match(commandsSource, /\bdeepSeekLoginCommand,\s*[\r\n]\s*effort/)
  assert.match(commandsSource, /\bmodel,\s*[\r\n]\s*openCodeLoginCommand/)
  assert.match(commandsSource, /\bopenCodeLoginCommand,\s*[\r\n]\s*commandCodeLogin/)
})

test('gateway mode registers the credential login, off-gateway keeps OAuth login', () => {
  // Exactly one `login` in either mode: the OAuth command off gateway, the
  // gateway credential command under gateway/3P. Never both, never none.
  assert.match(
    commandsSource,
    /isUsing3PServices\(\)\s*\?\s*\[gatewayLogin\]\s*:\s*\[logout, login\(\)\]/,
  )
  assert.match(loginSource, /name: 'login'/)
  assert.match(loginSource, /Sign in to Claude Code or Codex and switch between their accounts/)
  assert.match(loginSource, /switch\|remove/)
})

test('the gateway login command reaches the picker and the per-provider UI', async () => {
  const unifiedSource = await readFile(
    new URL('../src/commands/gateway-login/unified.tsx', import.meta.url),
    'utf8',
  )
  const planSource = await readFile(
    new URL('../src/commands/gateway-login/unified-plan.ts', import.meta.url),
    'utf8',
  )
  // No-argument /login renders the picker component, which dispatches into the
  // existing per-provider dialog with the bound credential name.
  assert.match(unifiedSource, /<ProviderPicker action=\{plan\.action\}/)
  assert.match(unifiedSource, /import \{ call as providerLogin \} from '\.\/login\.js'/)
  assert.match(unifiedSource, /PROVIDER_CREDENTIALS\[plan\.provider\]/)
  assert.match(
    planSource,
    /opencode: 'opencode-go',\s*\n\s*commandcode: 'commandcode',\s*\n\s*mistral: 'mistral',\s*\n\s*mistralvibe: 'mistralvibe',\s*\n\s*deepseek: 'ds',\s*\n\s*openrouter: 'openrouter'/,
  )
})

test('the gateway picker reaches the host sign-ins, not only vault keys', async () => {
  const unifiedSource = await readFile(
    new URL('../src/commands/gateway-login/unified.tsx', import.meta.url),
    'utf8',
  )
  const planSource = await readFile(
    new URL('../src/commands/gateway-login/unified-plan.ts', import.meta.url),
    'utf8',
  )
  // Claude Code keeps Anthropic's own OAuth flow, Codex runs its device login
  // into an isolated home, and neither is turned into a vault key.
  assert.match(unifiedSource, /import \{ call as anthropicLogin \} from '\.\.\/login\/anthropic\.js'/)
  assert.match(unifiedSource, /import \{ CodexDeviceLogin \} from '\.\/codex-login\.js'/)
  assert.match(unifiedSource, /selectCodexAccount/)
  assert.match(unifiedSource, /removeCodexAccount/)
  // Claude sign-in is registered as its own account rather than only kept in
  // the single CLI credential slot.
  assert.match(unifiedSource, /registerCurrentClaudeLogin/)
  assert.match(unifiedSource, /selectAnthropicAccount/)
  assert.match(unifiedSource, /anthropicStatusMessage/)
  assert.match(planSource, /export const PROVIDERS: ProviderName\[\] = \['claude', 'codex', \.\.\.KEY_PROVIDERS\]/)
  assert.match(planSource, /anthropic: 'claude'/)
  assert.match(planSource, /chatgpt: 'codex'/)
  assert.match(planSource, /export const ACCOUNT_PROVIDERS: ProviderName\[\] = \['claude', 'codex', 'opencode', 'commandcode', 'mistral'\]/)
})
