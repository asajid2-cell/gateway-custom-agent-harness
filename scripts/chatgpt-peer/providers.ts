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
    threadId: value => GEMINI_THREAD.test(value),
  },
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
