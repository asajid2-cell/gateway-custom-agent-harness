import { closeSync, openSync, readdirSync, readSync, statSync, type Dirent } from 'node:fs'
import { open, readdir, stat, type FileHandle } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type CodexQuota = {
  remainingPercent: number
  primaryUsedPercent: number | null
  secondaryUsedPercent: number | null
  resetsPrimary: number | null
  resetsSecondary: number | null
  asof: number
}

type RateLimitWindow = {
  used_percent?: unknown
  usedPercent?: unknown
  resets_at?: unknown
  resetsAt?: unknown
}

type RolloutRateLimits = {
  primary?: { used_percent?: unknown; resets_at?: unknown }
  secondary?: { used_percent?: unknown; resets_at?: unknown }
}

// The rollout corpus here is ~34 GB and its largest single file is multiple
// gigabytes, while the newest rollout is not necessarily the newest one that
// carries rate limits. So the read is bounded twice over: a fixed number of
// candidate files, and only the tail of each.
const ROLLOUT_TAIL_BYTES = 128 * 1024
const ROLLOUT_CANDIDATES = 12

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function collectWindows(
  value: unknown,
  location: string,
  windows: Array<{ location: string; usedPercent: number; resetsAt: number | null }>,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectWindows(item, `${location}[${index}]`, windows))
    return
  }
  if (!isObject(value)) return

  const window = value as RateLimitWindow
  const usedPercent = finiteNumber(window.used_percent ?? window.usedPercent)
  if (usedPercent !== null) {
    windows.push({
      location,
      usedPercent,
      resetsAt: finiteNumber(window.resets_at ?? window.resetsAt),
    })
  }

  for (const [key, child] of Object.entries(value)) {
    collectWindows(child, location ? `${location}.${key}` : key, windows)
  }
}

export function quotaFromRateLimits(value: unknown, asof = Date.now()): CodexQuota | null {
  const windows: Array<{
    location: string
    usedPercent: number
    resetsAt: number | null
  }> = []
  collectWindows(value, 'rateLimits', windows)
  if (windows.length === 0) return null

  const primary = windows.find(window => window.location === 'rateLimits.rateLimits.primary')
    ?? windows.find(window => /\.primary$/.test(window.location))
  const secondary = windows.find(window => window.location === 'rateLimits.rateLimits.secondary')
    ?? windows.find(window => /\.secondary$/.test(window.location))
  const usedValues = windows.map(window => window.usedPercent)

  return {
    remainingPercent: Math.round(
      Math.max(0, Math.min(100, 100 - Math.max(...usedValues))),
    ),
    primaryUsedPercent: primary?.usedPercent ?? null,
    secondaryUsedPercent: secondary?.usedPercent ?? null,
    resetsPrimary: primary?.resetsAt ?? null,
    resetsSecondary: secondary?.resetsAt ?? null,
    asof,
  }
}

function codexExecutable(): string {
  return process.platform === 'win32'
    ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'npm', 'codex.cmd')
    : 'codex'
}

export function getCodexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex')
}

function rolloutRateLimitsFromLine(value: unknown): RolloutRateLimits | null {
  if (!isObject(value)) return null
  if (
    value.type === 'event_msg' &&
    isObject(value.payload) &&
    value.payload.type === 'token_count' &&
    isObject(value.payload.rate_limits)
  ) {
    return value.payload.rate_limits as RolloutRateLimits
  }
  if (value.type === 'token_count' && isObject(value.rate_limits)) {
    return value.rate_limits as RolloutRateLimits
  }
  return null
}

function rateLimitsFromText(text: string): RolloutRateLimits | null {
  let found: RolloutRateLimits | null = null
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const rateLimits = rolloutRateLimitsFromLine(JSON.parse(line))
      if (rateLimits) found = rateLimits
    } catch {
      // The first line of a tail slice is normally cut mid-object.
    }
  }
  return found
}

async function readdirNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

// Rollouts live at sessions/YYYY/MM/DD/rollout-*.jsonl. Day directories sort
// lexicographically, so order comes from the names; only the handful of files
// actually considered get stat calls.
async function recentRolloutFiles(
  sessionsRoot: string,
  want = ROLLOUT_CANDIDATES,
): Promise<Array<{ file: string; mtimeMs: number }>> {
  const dayDirs: string[] = []
  for (const year of await readdirNames(sessionsRoot)) {
    const yearDir = join(sessionsRoot, year)
    for (const month of await readdirNames(yearDir)) {
      const monthDir = join(yearDir, month)
      for (const day of await readdirNames(monthDir)) dayDirs.push(join(monthDir, day))
    }
  }
  dayDirs.sort()
  dayDirs.reverse()

  const candidates: string[] = []
  for (const dir of dayDirs) {
    const names = await readdirNames(dir)
    names.sort()
    names.reverse()
    for (const name of names) {
      if (/^rollout-.*\.jsonl$/.test(name)) candidates.push(join(dir, name))
      if (candidates.length >= want) break
    }
    if (candidates.length >= want) break
  }

  const files: Array<{ file: string; mtimeMs: number }> = []
  for (const file of candidates) {
    try {
      files.push({ file, mtimeMs: (await stat(file)).mtimeMs })
    } catch {
      // The rollout may disappear between enumeration and stat.
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return files
}

async function readTailText(file: string, maxBytes: number): Promise<string | null> {
  let handle: FileHandle
  try {
    handle = await open(file, 'r')
  } catch {
    return null
  }
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - maxBytes)
    const length = size - start
    const buffer = Buffer.allocUnsafe(length)
    await handle.read(buffer, 0, length, start)
    return buffer.toString('utf8')
  } catch {
    return null
  } finally {
    await handle.close()
  }
}

export function getCodexSessionsRoot(): string {
  return join(getCodexHome(), 'sessions')
}

function readdirSubdirs(dir: string): Dirent[] {
  return readdirEntries(dir).filter(entry => entry.isDirectory())
}

function readdirEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function readTailTextSync(file: string, maxBytes: number): string | null {
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch {
    return null
  }
  try {
    const { size } = statSync(file)
    const start = Math.max(0, size - maxBytes)
    const length = size - start
    const buffer = Buffer.allocUnsafe(length)
    readSync(fd, buffer, 0, length, start)
    return buffer.toString('utf8')
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

// Synchronous counterpart of readCodexQuotaFromSource, for callers that cannot
// await. It reads the same tails under the same double bound - a fixed number
// of candidate files, and only the tail of each - and applies the same rule:
// the first rollout whose tail carries numeric limits wins.
export function readCodexQuotaFromRollouts(sessionsRoot: string): CodexQuota | null {
  const dayDirs: string[] = []
  for (const year of readdirSubdirs(sessionsRoot)) {
    const yearDir = join(sessionsRoot, year.name)
    for (const month of readdirSubdirs(yearDir)) {
      const monthDir = join(yearDir, month.name)
      for (const day of readdirSubdirs(monthDir)) dayDirs.push(join(monthDir, day.name))
    }
  }
  // Newest day directory first; day names sort lexicographically. The tests
  // write rollouts directly under the root, so it is searched after the days.
  dayDirs.sort()
  dayDirs.reverse()

  for (const dir of [...dayDirs, sessionsRoot]) {
    const names = readdirEntries(dir)
      .filter(entry => entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name))
      .map(entry => entry.name)
      .sort()
      .reverse()
    for (const name of names) {
      const file = join(dir, name)
      let mtimeMs: number
      try {
        mtimeMs = statSync(file).mtimeMs
      } catch {
        continue
      }
      const tail = readTailTextSync(file, ROLLOUT_TAIL_BYTES)
      if (!tail) continue
      const rateLimits = rateLimitsFromText(tail)
      if (!rateLimits) continue
      const quota = quotaFromRateLimits(rateLimits, mtimeMs)
      if (quota) return quota
    }
  }
  return null
}

export async function readCodexQuotaFromSource(
  sessionsRoot = getCodexSessionsRoot(),
): Promise<CodexQuota | null> {
  for (const { file, mtimeMs } of await recentRolloutFiles(sessionsRoot)) {
    const tail = await readTailText(file, ROLLOUT_TAIL_BYTES)
    if (!tail) continue
    const rateLimits = rateLimitsFromText(tail)
    if (!rateLimits) continue
    const quota = quotaFromRateLimits(rateLimits, mtimeMs)
    if (quota) return quota
  }
  return null
}

export async function readCodexQuota(): Promise<CodexQuota | null> {
  const child = spawn(codexExecutable(), ['app-server', '--listen', 'stdio://'], {
    shell: process.platform === 'win32',
    env: { ...process.env, CODEX_HOME: getCodexHome() },
    stdio: ['pipe', 'pipe', 'ignore'],
  })

  return await new Promise(resolve => {
    let buffer = ''
    let initialized = false
    let finished = false
    const timeout = setTimeout(() => finish(null), 10_000)

    const finish = (quota: CodexQuota | null) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      child.kill()
      resolve(quota)
    }

    const send = (message: Record<string, unknown>) => {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    }

    child.on('error', () => finish(null))
    child.stdout.on('data', chunk => {
      buffer += chunk.toString()
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)
        newlineIndex = buffer.indexOf('\n')
        if (!line) continue

        let message: unknown
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (!isObject(message)) continue
        const id = finiteNumber(message.id)
        if (id === 1 && !initialized) {
          initialized = true
          send({ method: 'initialized', params: {} })
          send({ method: 'account/rateLimits/read', id: 2, params: {} })
        } else if (id === 2) {
          const result = isObject(message.result) ? message.result : null
          finish(result ? quotaFromRateLimits(result) : null)
          return
        }
      }
    })

    send({
      method: 'initialize',
      id: 1,
      params: {
        clientInfo: {
          name: 'gateway-footer',
          title: 'Gateway footer quota reader',
          version: '1.0.0',
        },
      },
    })
  })
}

export function isCodexGatewayModel(model: string): boolean {
  return model.toLowerCase().startsWith('gateway-gpt-')
}
