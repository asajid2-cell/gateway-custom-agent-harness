/**
 * `cc login` - non-interactive credential setup for installers and scripts.
 *
 * The key is read from stdin, never from argv: it cannot appear in a process
 * list, a shell history, or a launcher log. Output names where the key went,
 * never the value. `/login` inside a session remains the interactive path and
 * the only path for the OAuth providers.
 */
import {
  describeCredentialStore,
  gatewayCredentialStatus,
  removeGatewayCredential,
  saveGatewayCredential,
} from '../utils/gatewayCredentials.js'
import { isValidRecordName, listSecrets } from '../utils/keysafe/index.js'

const PROVIDERS: Record<string, string> = {
  opencode: 'opencode-go',
  commandcode: 'commandcode',
  mistral: 'mistral',
  'mistral-vibe': 'mistral-vibe',
  deepseek: 'ds',
  openrouter: 'openrouter',
}

// Only the multi-account providers take a slot; `--slot 1` is the base record.
const NUMBERED = new Set(['opencode', 'commandcode', 'mistral', 'mistral-vibe'])

const OAUTH_PROVIDERS = new Set(['anthropic', 'claude', 'chatgpt', 'codex', 'openai'])

const USAGE = `Usage:
  cc login --provider <opencode|commandcode|mistral|mistral-vibe|deepseek|openrouter> --key-stdin [--slot N]
  cc login --provider <...> --remove
  cc login --status

The key is read from stdin, for example:
  printf '%s' "$KEY" | cc login --provider opencode --key-stdin

OAuth providers are interactive: run cc and use /login anthropic or /login chatgpt.`

type LoginIO = {
  stdin?: AsyncIterable<Buffer | string>
  isTTY?: boolean
}

async function readStdin(stdin: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

/** Which slot a record name represents, or null if it is not this provider's. */
function slotFor(provider: string, name: string): number | null {
  const base = PROVIDERS[provider]
  if (!base) return null
  if (name === base) return 1
  if (!NUMBERED.has(provider) || !name.startsWith(base)) return null
  const suffix = name.slice(base.length)
  return /^[2-9][0-9]*$/.test(suffix) ? Number(suffix) : null
}

function recordName(provider: string, slot: string | null): string | null {
  const base = PROVIDERS[provider]
  if (!base) return null
  if (slot === null) return base
  if (!NUMBERED.has(provider) || !/^[1-9][0-9]*$/.test(slot)) return null
  return Number(slot) === 1 ? base : `${base}${slot}`
}

export async function runLoginCommand(args: string[], io: LoginIO = {}): Promise<number> {
  let provider = ''
  let slot: string | null = null
  let keyStdin = false
  let status = false
  let remove = false

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    const equals = arg.indexOf('=')
    const flag = equals >= 0 ? arg.slice(0, equals) : arg
    const inline = equals >= 0 ? arg.slice(equals + 1) : undefined
    const take = () => inline ?? args[++index] ?? ''

    if (flag === '--provider') provider = take().toLowerCase()
    else if (flag === '--slot') slot = take()
    else if (flag === '--key-stdin') keyStdin = true
    else if (flag === '--status') status = true
    else if (flag === '--remove') remove = true
    else if (flag === '--help' || flag === '-h') {
      console.log(USAGE)
      return 0
    } else {
      console.error(`Unknown argument: ${arg}\n${USAGE}`)
      return 2
    }
  }

  if (status) {
    try {
      const store = await describeCredentialStore()
      // Bundled mode can enumerate every record, so numbered providers report
      // their actual slots. A slot-2-only save must not read as "not
      // configured". External mode stays base-record only here; its legacy UI
      // already lists slots.
      let records: string[] = []
      if (store.keysafe === 'bundled') {
        try {
          records = (await listSecrets()).map(entry => entry.name)
        } catch {
          records = []
        }
      }
      const providers = []
      for (const [name, record] of Object.entries(PROVIDERS)) {
        const state = await gatewayCredentialStatus(record)
        const slots = NUMBERED.has(name)
          ? records
              .map(candidate => slotFor(name, candidate))
              .filter((slot): slot is number => slot !== null)
              .sort((a, b) => a - b)
          : []
        providers.push({
          provider: name,
          // A numbered provider is configured when any of its slots is.
          present: state.present || slots.length > 0,
          source: state.source,
          ...(NUMBERED.has(name) ? { slots } : {}),
        })
      }
      // Presence only. A status command must never be a way to read a key.
      console.log(
        JSON.stringify(
          { mode: store.mode, keysafe: store.keysafe, oauth: store.oauth, backend: store.backend, providers },
          null,
          2,
        ),
      )
      return 0
    } catch (error) {
      console.error(`Credential store error: ${(error as Error).message}`)
      return 1
    }
  }

  if (OAUTH_PROVIDERS.has(provider)) {
    console.error(`${provider} is an OAuth sign-in and cannot be completed unattended.\n${USAGE}`)
    return 2
  }

  const name = recordName(provider, slot)
  if (!provider || !name || !isValidRecordName(name)) {
    console.error(`Unknown provider or slot: ${provider || '(none)'}${slot ? ` slot ${slot}` : ''}\n${USAGE}`)
    return 2
  }

  if (remove) {
    const result = await removeGatewayCredential(name)
    if (!result.ok) {
      console.error(`Could not remove ${name}: ${result.reason ?? 'not present'}`)
      return 1
    }
    console.log(`removed ${name} from the ${result.source}`)
    return 0
  }

  if (!keyStdin) {
    console.error(`Pass --key-stdin and pipe the key on stdin.\n${USAGE}`)
    return 2
  }
  const stdin = io.stdin ?? process.stdin
  if (io.isTTY ?? process.stdin.isTTY) {
    console.error('No key is piped on stdin; refusing to wait for a terminal.')
    return 2
  }

  const value = (await readStdin(stdin)).trim()
  if (!value) {
    console.error('No key was read from stdin.')
    return 1
  }

  const result = await saveGatewayCredential(name, value)
  if (!result.ok) {
    console.error(`Could not save ${name} (${result.source}): ${result.reason ?? 'unknown error'}`)
    return 1
  }
  console.log(`saved ${name} in the ${result.source}`)
  return 0
}
