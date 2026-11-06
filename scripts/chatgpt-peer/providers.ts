/**
 * What makes one web bridge provider different from another.
 *
 * The host, the lane manager and the bus contract are provider-neutral. What
 * differs is where the provider keeps its state, which Chrome port is its
 * master, how it spells a thread id, and where its driver lives. Keeping that
 * in one table means a second provider is a new row plus a driver, not a fork
 * of the host.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export type ProviderId = 'chatgpt-web' | 'gemini-web'

/** The optional driver ops a provider may lack; every driver has the rest. */
export type DriverOp = 'conversations' | 'file' | 'reload'

export type Provider = {
  id: ProviderId
  /** Host identity: operator `name`, first bridge name, default thread title. */
  name: string
  /** Bus display prefix: the peer renders as `${peerPrefix}; <bridge name>`. */
  peerPrefix: string
  /** Derived bridge name when a thread has no usable title. */
  fallbackName: string
  /** Purpose text shown on the peer's registration. */
  purpose: string
  /** State root (bridges, lanes, peer.json). */
  home: string
  /** Host-private files (instance identity, profile). */
  privateHome: string
  /** The master Chrome profile: the credential source. */
  profile: string
  /** The master Chrome's CDP port. */
  masterPort: number
  /** The first lane's CDP port. */
  laneBasePort: number
  /** Lanes are tabs in the master browser (the login cannot be copied). */
  laneSharedBrowser?: boolean
  /** Driver filename, resolved under `home` unless overridden. */
  driver: string
  /** Primer filename under `scripts/chatgpt-peer/`. */
  primer: string
  /** The site the master window is signed into. */
  site: string
  /**
   * The driver op that selects a model/effort in the page's picker.
   *
   * The two drivers were written at different times and name the same
   * capability differently; the host reads the name from here rather than
   * guessing or trying both.
   */
  modeOp: 'set' | 'mode'
  /**
   * Host ops this provider's driver does NOT implement. The host checks here
   * before sending one, instead of learning it from an `unknown op` reply on
   * every timer tick (live 2026-11-06: `title walk failed: unknown op
   * conversations` on every Gemini title walk).
   */
  unsupportedOps?: readonly DriverOp[]
  /**
   * What a NEW bridge pins when the caller names no model or effort.
   *
   * A bridge used to inherit whatever the shared picker last held, so a fresh
   * Gemini bridge came up on another session's Argon (measured 2026-11-06). A
   * default is explicit, cheap, and never a premium model.
   */
  defaultModel: string
  defaultEffort: string
  /** A thread id this provider hands back. */
  threadId: (value: string) => boolean
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/**
 * Gemini conversation ids are opaque in the URL (`/app/<id>`) and are not
 * UUIDs. The only shape the host needs is "no path, no query, no spaces", and
 * the driver re-checks the id against the page before using it.
 */
const GEMINI_THREAD = /^[A-Za-z0-9_-]{4,128}$/

export const PROVIDERS: Record<ProviderId, Provider> = {
  'chatgpt-web': {
    id: 'chatgpt-web',
    name: 'chatgpt-web',
    peerPrefix: 'web',
    fallbackName: 'chatgpt',
    purpose: "A signed-in ChatGPT web thread on this machine's account, addressed like any other live session.",
    home: join(homedir(), 'chatgpt-web'),
    privateHome: join(homedir(), '.chatgpt-web'),
    profile: join(homedir(), '.chatgpt-web', 'profile'),
    masterPort: 9222,
    laneBasePort: 9300,
    // Copying a session into a second profile is racy: the master rotates its
    // token while the copy is in flight, and two lanes branched from the same
    // snapshot invalidate each other. A lane is a named tab in the master
    // browser instead - one cookie jar, nothing to copy or write back.
    laneSharedBrowser: true,
    driver: 'chatgpt.mjs',
    primer: 'primer.md',
    site: 'https://chatgpt.com/',
    modeOp: 'set',
    // What every bridge on this host already runs: the model the picker is
    // expected to hold, never "whatever the last turn selected".
    defaultModel: 'GPT-6',
    defaultEffort: 'Medium',
    threadId: value => UUID.test(value),
  },
  'gemini-web': {
    id: 'gemini-web',
    name: 'gemini-web',
    peerPrefix: 'gemini',
    fallbackName: 'gemini',
    purpose: "A signed-in Google Gemini web thread on this machine's account, addressed like any other live session.",
    home: join(homedir(), 'gemini-web'),
    privateHome: join(homedir(), '.gemini-web'),
    profile: join(homedir(), '.gemini-web', 'profile'),
    masterPort: 9223,
    laneBasePort: 9400,
    laneSharedBrowser: true,
    driver: 'gemini.mjs',
    primer: 'primer-gemini.md',
    site: 'https://gemini.google.com/app',
    modeOp: 'mode',
    // The fast default, never a thinking model: a probe or a new bridge must
    // not spend Argon by inheriting the shared picker's last choice.
    defaultModel: 'Flash',
    defaultEffort: 'Low',
    // The Gemini page has no account-wide list endpoint, no file download and
    // no thread reload op; the host skips those paths instead of asking.
    unsupportedOps: ['conversations', 'file', 'reload'],
    threadId: value => GEMINI_THREAD.test(value),
  },
}

/** Does this provider's driver implement `op`? */
export function providerSupports(provider: Provider, op: DriverOp): boolean {
  return !(provider.unsupportedOps ?? []).includes(op)
}

/** A provider by id, or the ChatGPT profile (the only one that predates ids). */
export function providerOf(id: string | undefined | null): Provider {
  const key = String(id ?? '').trim().toLowerCase()
  return (PROVIDERS as Record<string, Provider>)[key] ?? PROVIDERS['chatgpt-web']
}

/**
 * One config environment variable, under its neutral name first.
 *
 * `WEB_BRIDGE_*` is the general spelling; `CHATGPT_WEB_*` keeps every existing
 * launch, script and test working without a flag day.
 */
export function providerEnv(name: string): string | undefined {
  return process.env[`WEB_BRIDGE_${name}`] ?? process.env[`CHATGPT_WEB_${name}`]
}
