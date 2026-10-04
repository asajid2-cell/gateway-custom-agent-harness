/**
 * Zenith: the one session the user talks to that manages the other live
 * sessions. It is a *claim*, not an assertion - a session becomes Zenith by
 * holding the claim, never by saying so, and only one session holds it at a
 * time.
 *
 * This is deliberately NOT the same thing as the matriarch, and the two must
 * not be conflated:
 *
 *   - Matriarch is per-family: a lease over which window manages that one
 *     family's window, claimed automatically on mount (leafWorkspace.ts).
 *   - Zenith is global: one claim over which session is the user's interface
 *     plane, claimed explicitly, and it outlives the process that holds it.
 *
 * A Zenith's leaf family is its own and starts fresh. Nothing merges across
 * Zeniths; succession within a family is the patriarch designation's job and is
 * untouched by this module.
 *
 * Why an artifact at all: so that a second session asking to be Zenith is told
 * the truth instead of proceeding on its own belief. Before this, two sessions
 * could each believe they were Zenith and neither could find out.
 */
import { join } from 'node:path'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { getSessionId } from '../bootstrap/state.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { isProcessRunning } from './genericProcessUtils.js'

/**
 * The held role. Shaped after LeafMatriarchClaim, and for the same reason it
 * carries the pid *and* the process start time: a pid alone cannot say whether
 * the holder is still there, because pids are recycled and a dead host's claim
 * would then read as live.
 */
export type ZenithClaim = {
  zenithSessionId: string
  pid: number
  processStartedAt: string
  claimedAt: string
  purpose?: string
}

/**
 * What `cc zenith` found. `empty` means the role is free; `held` means it is
 * taken and `alive` says whether the holder is still running. Those are the two
 * facts the user's decision rests on, so they are reported, never inferred.
 */
export type ZenithState =
  | { state: 'empty' }
  | { state: 'held'; claim: ZenithClaim; alive: boolean }

/** This process's own start, which is what a claim written here records. */
const processStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString()

export function zenithClaimPath(): string {
  return join(getClaudeConfigHomeDir(), 'zenith.json')
}

/**
 * An unreadable or malformed claim reads as *absent* rather than as an error.
 *
 * That is the safe direction: the file is a single pointer that the next
 * claimant overwrites, and a corrupt one must not strand the role forever. What
 * it must not do is read as *held* - a parse failure is not a holder.
 */
export async function readZenithClaim(): Promise<ZenithClaim | undefined> {
  try {
    const parsed = JSON.parse(await readFile(zenithClaimPath(), 'utf8')) as ZenithClaim
    if (!parsed || typeof parsed.zenithSessionId !== 'string' || !Number.isSafeInteger(parsed.pid)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/**
 * Whether the process that wrote a claim is still running.
 *
 * On Linux the process's start time is read from /proc and compared with the
 * claim's, so a recycled pid is caught. Windows has no cheap equivalent, so only
 * the pid is checked there - the same limit the matriarch claim and the peer
 * roster have, and why a wrong answer costs a stale line rather than a wrong
 * takeover: a live holder that reads as dead is only ever *offered* for
 * replacement, and the user still decides.
 */
export async function zenithProcessAlive(claim: ZenithClaim): Promise<boolean> {
  if (!isProcessRunning(claim.pid)) return false
  if (process.platform !== 'linux') return true
  try {
    const stat = await readFile(`/proc/${claim.pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const boot = (await readFile('/proc/stat', 'utf8')).split('\n').find(line => line.startsWith('btime '))?.split(' ')[1]
    if (!boot) return true
    return Math.abs(Number(boot) * 1000 + Number(fields[19]) * 10 - Date.parse(claim.processStartedAt)) < 2000
  } catch {
    return true
  }
}

/** The two facts a decision rests on: is the role free, and if not, is its holder there. */
export async function zenithState(): Promise<ZenithState> {
  const claim = await readZenithClaim()
  if (!claim) return { state: 'empty' }
  return { state: 'held', claim, alive: await zenithProcessAlive(claim) }
}

/**
 * Written like the family index files: a temp file, then a rename that Windows
 * may refuse while a reader holds the target. Duplicating that discipline here
 * rather than importing it keeps this module independent of leafWorkspace - the
 * two concepts are orthogonal and neither should have to load the other.
 */
async function writeZenithClaim(claim: ZenithClaim): Promise<void> {
  const target = zenithClaimPath()
  await mkdir(join(target, '..'), { recursive: true, mode: 0o700 })
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(claim), { mode: 0o600 })
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temporary, target)
      return
    } catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') || attempt >= 5) {
        await unlink(temporary).catch(() => {})
        throw error
      }
      await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)))
    }
  }
}

export type ZenithClaimOutcome =
  | { taken: true; claim: ZenithClaim }
  | { taken: false; reason: 'held'; claim: ZenithClaim; alive: boolean }

/**
 * Take the role, unless someone is holding it.
 *
 * The refusal is the whole point of the module: a live holder is not displaced
 * silently, because displacing one is the user's decision and not a side effect
 * of a second session starting. `force` is that decision, expressed - it is what
 * the "replace" choice passes, and even then the previous holder is left
 * *running*: ending a session is not what taking a title does.
 *
 * A holder whose process is gone is not a holder in any sense that protects
 * anything - nothing is running to displace - so it never blocks a claim.
 */
export async function claimZenith(options: { purpose?: string; force?: boolean; sessionId?: string } = {}): Promise<ZenithClaimOutcome> {
  const existing = await readZenithClaim()
  if (existing && !options.force) {
    const alive = await zenithProcessAlive(existing)
    if (alive) return { taken: false, reason: 'held', claim: existing, alive }
  }
  const claim: ZenithClaim = {
    zenithSessionId: options.sessionId ?? getSessionId(),
    pid: process.pid,
    processStartedAt,
    claimedAt: new Date().toISOString(),
    ...(options.purpose?.trim() ? { purpose: options.purpose.trim() } : {}),
  }
  await writeZenithClaim(claim)
  return { taken: true, claim }
}

/**
 * Whether this session still holds the role.
 *
 * This is the check every *action* taken in the role's name makes before it
 * acts. A displaced Zenith finds out here rather than by failing mid-action, and
 * because acting checks, "displaced" means "before its next action" rather than
 * "whenever it happens to look". A passive read is not enough - that would let a
 * replaced holder keep acting as Zenith, which is the gap the claim exists to
 * close.
 */
export async function holdsZenith(sessionId: string = getSessionId()): Promise<boolean> {
  const claim = await readZenithClaim()
  return claim?.zenithSessionId === sessionId
}

/** Give the role up, but only if this session is the one holding it. */
export async function releaseZenith(sessionId: string = getSessionId()): Promise<boolean> {
  const claim = await readZenithClaim()
  if (!claim || claim.zenithSessionId !== sessionId) return false
  await unlink(zenithClaimPath()).catch(() => {})
  return true
}

/** One line for a person: who holds the role, and whether they are still there. */
export function renderZenithState(state: ZenithState): string {
  if (state.state === 'empty') return 'Zenith is unheld; this session can take the role.'
  const { claim, alive } = state
  const since = new Date(claim.claimedAt).toLocaleString()
  const purpose = claim.purpose ? ` — ${claim.purpose}` : ''
  return alive
    ? `Zenith is held by ${claim.zenithSessionId} (running since ${since})${purpose}.`
    : `Zenith is held by ${claim.zenithSessionId}, whose process is gone (claimed ${since})${purpose}.`
}

/**
 * Take the role at session mount when the launcher asked for it (`cc zenith`).
 *
 * Both mounts call this - the interactive REPL and a headless print session -
 * because a launch verb that worked in one and silently did nothing in the
 * other would be worse than not having it. The launcher cannot take the claim
 * itself: it would record the launcher's pid and its own process, and the role
 * would then read as live after the chat behind it was gone. Here the id is the
 * session's, which is the whole reason the claim is written at mount.
 *
 * Returns the outcome so the caller can log a refusal; undefined means the
 * launch did not ask for the role, and a throw is swallowed to a warning
 * because a claim that failed must not turn a live session off the bus.
 */
export async function claimZenithFromLaunchEnv(): Promise<ZenithClaimOutcome | undefined> {
  if (process.env.CC_ZENITH !== '1') return undefined
  const purpose = process.env.CC_ZENITH_PURPOSE?.trim()
  try {
    return await claimZenith({
      ...(purpose ? { purpose } : {}),
      force: process.env.CC_ZENITH_MODE === 'take',
    })
  } catch {
    return undefined
  }
}
