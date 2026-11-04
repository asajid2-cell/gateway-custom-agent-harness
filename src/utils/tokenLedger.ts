import { appendFileSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveModelBackend, type ModelBackend } from './model/gatewayBackend.js'
import { outputTokensPerSecond } from './speed.js'

/**
 * A durable, append-only record of every token figure the harness was told.
 *
 * Why this exists next to the in-memory cost tracker:
 *
 *  - `bootstrap/state.ts` accumulates totals for the *current* session and
 *    `cost-tracker.ts` writes them to project config only for the *last*
 *    session that saved. Both are about the session you are sitting in. Neither
 *    answers "which model has this account really spent on, across every chat".
 *  - `~/.claude/stats-cache.json` can answer it, but by re-walking every
 *    transcript, so it is cached and recomputed on a schedule - it lags, and its
 *    daily series keeps only input+output while the four-way split lives in a
 *    separate block.
 *
 * This is one line per cost event. It is deliberately the same set of events the
 * cost tracker counts, so the ledger's totals can be reconciled against `/cost`
 * rather than being a second, disagreeing opinion.
 *
 * What it records is what the provider reported, normalized by the Gateway (or
 * by the Anthropic SDK) into four fields. Nothing here estimates or derives a
 * token count: a number absent from the provider's usage block is recorded as 0,
 * and zero means "not reported", which is why the fields are kept separate
 * instead of summed at write time.
 *
 * Failure policy: a ledger write must never affect a turn. Every failure path
 * here is swallowed after a single warning, because losing a telemetry line is
 * recoverable and throwing inside the response path is not.
 */

export type TokenLedgerSource = 'response' | 'advisor' | 'replay'

export interface TokenLedgerUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/**
 * The two clocks behind one response's throughput. Optional because the
 * response path cannot always measure - a replayed fixture never streamed, so
 * it has no honest speed to record.
 */
export interface TokenLedgerSpeed {
  /** Request start to first token. */
  ttftMs: number
  /** First token to last token - the span `tokPerSec` is computed over. */
  generationMs: number
  /** Request start to last token, including prompt processing. */
  totalMs: number
}

export interface TokenLedgerRecord {
  session: string
  model: string
  usage: TokenLedgerUsage
  costUSD: number
  source?: TokenLedgerSource
  speed?: TokenLedgerSpeed
}

export interface TokenLedgerRow {
  v: 1
  at: string
  session: string
  cwd: string
  /** Exactly as the harness saw it, before any canonicalization. */
  model: string
  /** Resolved at write time, so a later catalog change cannot re-attribute it. */
  backend: ModelBackend
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  costUSD: number
  src: TokenLedgerSource
  /** Milliseconds from request start to first token, when measured. */
  ttftMs?: number
  /** Milliseconds spent generating after the first token, when measured. */
  genMs?: number
  /** Milliseconds from request start to last token, when measured. */
  totalMs?: number
  /** Output tokens per second over `genMs`. */
  tokPerSec?: number
}

const MAX_BYTES = 8 * 1024 * 1024

let warned = false
let directory: string | null = null
let path: string | null = null
let rotatedPath: string | null = null
let bytes = 0

function ledgerDisabled(): boolean {
  const flag = process.env.GATEWAY_TOKEN_LEDGER
  return flag === '0' || flag === 'false' || flag === 'off'
}

/**
 * Resolved lazily and cached: this runs on the response path, and a session that
 * never completes a request should never have created the directory.
 */
function resolvePaths(): { path: string; rotatedPath: string } | null {
  if (path && rotatedPath) return { path, rotatedPath }
  if (directory === null) {
    directory =
      process.env.GATEWAY_TOKEN_LEDGER_DIR?.trim() ||
      join(homedir(), '.claude', 'token-ledger')
  }
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  } catch {
    warn()
    return null
  }
  path = join(directory, 'tokens.jsonl')
  rotatedPath = `${path}.1`
  return { path, rotatedPath }
}

function warn(): void {
  if (warned) return
  warned = true
  process.stderr.write(
    'Token ledger unavailable; no usage is being recorded to disk.\n',
  )
}

function finite(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

export function recordTokenUsage(record: TokenLedgerRecord): void {
  if (ledgerDisabled()) return
  const resolved = resolvePaths()
  if (!resolved) return

  const output = finite(record.usage.output)
  const speed = record.speed
  const tokPerSec = speed
    ? outputTokensPerSecond(output, speed.generationMs)
    : null

  const row: TokenLedgerRow = {
    v: 1,
    at: new Date().toISOString(),
    session: record.session,
    cwd: process.cwd(),
    model: record.model,
    backend: resolveModelBackend(record.model),
    input: finite(record.usage.input),
    output,
    cacheRead: finite(record.usage.cacheRead),
    cacheWrite: finite(record.usage.cacheWrite),
    costUSD: Number.isFinite(record.costUSD) ? record.costUSD : 0,
    src: record.source ?? 'response',
    ...(speed
      ? {
          ttftMs: Math.max(0, Math.round(speed.ttftMs)),
          genMs: Math.max(0, Math.round(speed.generationMs)),
          totalMs: Math.max(0, Math.round(speed.totalMs)),
        }
      : {}),
    ...(tokPerSec === null ? {} : { tokPerSec }),
  }

  let line: string
  try {
    line = `${JSON.stringify(row)}\n`
  } catch {
    return
  }
  const length = Buffer.byteLength(line)

  try {
    if (bytes > 0 && bytes + length > MAX_BYTES) {
      rmSync(resolved.rotatedPath, { force: true })
      renameSync(resolved.path, resolved.rotatedPath)
      bytes = 0
    }
    appendFileSync(resolved.path, line, { mode: 0o600 })
    bytes += length
  } catch {
    warn()
  }
}

/** Exposed for tests and for `--dir` overrides in the report. */
export function tokenLedgerDirectory(): string {
  if (directory === null) {
    directory =
      process.env.GATEWAY_TOKEN_LEDGER_DIR?.trim() ||
      join(homedir(), '.claude', 'token-ledger')
  }
  return directory
}

export function resetTokenLedgerForTests(): void {
  warned = false
  directory = null
  path = null
  rotatedPath = null
  bytes = 0
}
