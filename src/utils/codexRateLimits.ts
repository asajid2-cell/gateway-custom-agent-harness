import { readdirSync, readFileSync, statSync } from 'node:fs'
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

function walkRollouts(
  dir: string,
  files: Array<{ file: string; mtimeMs: number }>,
): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const file = join(dir, entry.name)
    if (entry.isDirectory()) walkRollouts(file, files)
    else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
      try {
        files.push({ file, mtimeMs: statSync(file).mtimeMs })
      } catch {
        // The rollout may disappear between enumeration and stat.
      }
    }
  }
}

function lastRolloutRateLimits(file: string): RolloutRateLimits | null {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  let found: RolloutRateLimits | null = null
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const rateLimits = rolloutRateLimitsFromLine(JSON.parse(line))
      if (rateLimits) found = rateLimits
    } catch {
      // Ignore partial or non-JSON rollout lines.
    }
  }
  return found
}

export function readCodexQuotaFromRollouts(sessionsRoot: string): CodexQuota | null {
  const files: Array<{ file: string; mtimeMs: number }> = []
  walkRollouts(sessionsRoot, files)
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const { file, mtimeMs } of files.slice(0, 40)) {
    const rateLimits = lastRolloutRateLimits(file)
    const quota = rateLimits && quotaFromRateLimits(rateLimits, mtimeMs)
    if (quota) return quota
  }
  return null
}

export function getCodexSessionsRoot(): string {
  return join(getCodexHome(), 'sessions')
}

export function readCodexQuotaFromSource(
  sessionsRoot = getCodexSessionsRoot(),
): CodexQuota | null {
  return readCodexQuotaFromRollouts(sessionsRoot)
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
