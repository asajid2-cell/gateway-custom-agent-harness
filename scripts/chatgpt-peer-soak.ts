/**
 * chatgpt-peer-soak - the restart soak/measurement harness for one chatgpt-peer host.
 *
 * This is a measurement tool, not product code. It exists to produce the same
 * numbers before and after a restart, so that "the send starvation is gone" is
 * a measurement rather than a claim.
 *
 * Three modes:
 *
 *   dry   (the default) print exactly what the run would do, touch nothing -
 *         no socket, no file read, no registration.
 *   poll  POST /operator {op:'status', bridge} per bridge at a fixed cadence,
 *         record start/end/latency/outcome for every request, and print a
 *         comparable summary. This is the mode that shows whether a poll is
 *         still starved by a send in flight.
 *   turn  send one short probe turn over the peer bus and measure the time to
 *         the delivered reply. It is REFUSED unless --bridge names exactly one
 *         bridge AND --i-authorize-live-turn is given: it spends a real model
 *         turn. Do not run it without an explicit go-ahead.
 *
 * No hidden defaults: every knob below is a required flag (mode alone defaults
 * to dry, which is the one value that cannot do anything).
 *
 * Bounded by construction: --duration-ms is capped at MAX_DURATION_MS and
 * --max-requests at MAX_REQUESTS; a run always ends with a summary, including
 * on Ctrl-C.
 *
 * Usage: bun run scripts/chatgpt-peer-soak.ts --help
 */

const MAX_DURATION_MS = 300_000
const MAX_REQUESTS = 10_000
const MAX_BRIDGES = 16

type Mode = 'dry' | 'poll' | 'turn'
type Outcome = 'answered' | 'error' | 'timeout' | 'aborted'

type Options = {
  mode: Mode
  base: string
  bridges: string[]
  cadenceMs: number
  durationMs: number
  maxRequests: number
  requestTimeoutMs: number
  tokenFile: string
  probeText: string
  authorizeLiveTurn: boolean
}

const HELP = `chatgpt-peer-soak - restart soak/measurement harness for one chatgpt-peer host

Usage:
  bun run scripts/chatgpt-peer-soak.ts [--mode <dry|poll|turn>] [flags]

Modes:
  dry    (default) print the plan; touch nothing - no socket, no file read.
  poll   POST /operator {op:'status', bridge} per bridge at a fixed cadence.
         Records start, end, latency and outcome (answered / error / timeout)
         for every request, then prints count, p50/p95/max latency and
         failures by kind.
  turn   Send ONE short probe turn over the peer bus and measure the time to
         the delivered reply. REFUSED unless --bridge names exactly one bridge
         AND --i-authorize-live-turn is given. It spends a real model turn.

Required flags (no hidden defaults):
  --base <url>                http(s) origin of the host, e.g. http://127.0.0.1:3770
  --bridge <name>             bridge to poll or address; repeat the flag or use
                              commas for several (max ${MAX_BRIDGES}). turn mode takes exactly one.
  --cadence-ms <n>            milliseconds between requests, per bridge
  --duration-ms <n>           run length in ms (hard cap ${MAX_DURATION_MS} ms)
  --max-requests <n>          total request budget (hard cap ${MAX_REQUESTS})
  --request-timeout-ms <n>    per-request budget; a request that hits it is
                              recorded as "timeout", not dropped
  --token-file <path>         JSON file holding {"token": "..."} (and optionally
                              "port"); required for poll and turn, never read in
                              dry. The token is never printed.
  --probe-text <text>         turn mode only: the probe text to send (required
                              for turn, ignored otherwise)

Turn-mode authorization:
  --i-authorize-live-turn     required for turn mode. Without it - or without
                              exactly one --bridge - turn mode refuses before
                              any work.

Output:
  Every request prints one line; the run ends with a summary that labels the
  window it covers, so two runs can be compared directly. Latency is in ms.

Exit codes:
  0  completed (including a completed dry run)
  1  the host refused or a request failed in a way the summary records
  2  usage error (nothing was sent)
`

function usageError(message: string): never {
  process.stderr.write(`chatgpt-peer-soak: ${message}\n\n${HELP}`)
  process.exit(2)
}

function parsePositiveInt(name: string, raw: string | undefined, max?: number): number {
  if (raw === undefined) usageError(`${name} is required`)
  if (!/^\d+$/.test(raw)) usageError(`${name} must be a whole number, got "${raw}"`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) usageError(`${name} must be at least 1, got ${raw}`)
  if (max !== undefined && value > max) usageError(`${name} is capped at ${max}, got ${value}`)
  return value
}

function parseArgs(argv: string[]): Options | 'help' {
  const flags = new Map<string, string>()
  const bridges: string[] = []
  const known = new Set([
    'mode', 'base', 'bridge', 'cadence-ms', 'duration-ms', 'max-requests',
    'request-timeout-ms', 'token-file', 'probe-text', 'i-authorize-live-turn',
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === '--help' || arg === '-h') return 'help'
    if (!arg.startsWith('--')) usageError(`unexpected argument "${arg}"`)
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
    if (!known.has(name)) usageError(`unknown flag --${name}`)
    const inline = eq === -1 ? undefined : arg.slice(eq + 1)
    if (inline !== undefined) {
      if (name === 'i-authorize-live-turn') usageError('--i-authorize-live-turn takes no value')
      if (name === 'bridge') bridges.push(...inline.split(',').map(part => part.trim()).filter(Boolean))
      else flags.set(name, inline)
      continue
    }
    if (name === 'i-authorize-live-turn') {
      flags.set(name, 'yes')
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) usageError(`--${name} needs a value`)
    index += 1
    if (name === 'bridge') bridges.push(...value.split(',').map(part => part.trim()).filter(Boolean))
    else flags.set(name, value)
  }

  const modeRaw = flags.get('mode') ?? 'dry'
  if (modeRaw !== 'dry' && modeRaw !== 'poll' && modeRaw !== 'turn') {
    usageError(`--mode must be dry, poll or turn, got "${modeRaw}"`)
  }
  const mode = modeRaw as Mode

  const base = flags.get('base')
  if (base === undefined) usageError('--base is required')
  let parsedBase: URL
  try { parsedBase = new URL(base) }
  catch { usageError(`--base is not a URL: "${base}"`) }
  if (parsedBase.protocol !== 'http:' && parsedBase.protocol !== 'https:') {
    usageError(`--base must be http(s), got ${parsedBase.protocol}`)
  }

  if (bridges.length === 0) usageError('--bridge is required (repeat the flag or use commas)')
  if (bridges.length > MAX_BRIDGES) usageError(`--bridge is capped at ${MAX_BRIDGES} names, got ${bridges.length}`)
  const duplicates = bridges.filter((name, index) => bridges.indexOf(name) !== index)
  if (duplicates.length > 0) usageError(`--bridge names must be unique; repeated: ${duplicates.join(', ')}`)

  const cadenceMs = parsePositiveInt('--cadence-ms', flags.get('cadence-ms'), MAX_DURATION_MS)
  const durationMs = parsePositiveInt('--duration-ms', flags.get('duration-ms'), MAX_DURATION_MS)
  const maxRequests = parsePositiveInt('--max-requests', flags.get('max-requests'), MAX_REQUESTS)
  const requestTimeoutMs = parsePositiveInt('--request-timeout-ms', flags.get('request-timeout-ms'), MAX_DURATION_MS)

  const tokenFile = flags.get('token-file')
  if (mode !== 'dry' && tokenFile === undefined) usageError(`--token-file is required in ${mode} mode`)

  const probeText = flags.get('probe-text')
  const authorizeLiveTurn = flags.get('i-authorize-live-turn') === 'yes'
  if (mode === 'turn') {
    if (bridges.length !== 1) usageError('turn mode addresses exactly one bridge (one --bridge)')
    if (!authorizeLiveTurn) {
      usageError('turn mode sends a real model turn and is refused without --i-authorize-live-turn')
    }
    if (probeText === undefined || probeText.trim() === '') usageError('turn mode requires --probe-text')
  }

  return {
    mode,
    base: parsedBase.origin,
    bridges,
    cadenceMs,
    durationMs,
    maxRequests,
    requestTimeoutMs,
    tokenFile: tokenFile ?? '',
    probeText: probeText ?? '',
    authorizeLiveTurn,
  }
}

// ------------------------------------------------------------------ summary

function nearestRank(sorted: number[], percentile: number): number | null {
  if (sorted.length === 0) return null
  const rank = Math.ceil((percentile / 100) * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!
}

function latencyLine(label: string, values: number[]): string {
  if (values.length === 0) return `  ${label}: n=0`
  const sorted = [...values].sort((left, right) => left - right)
  return `  ${label}: n=${sorted.length} p50 ${nearestRank(sorted, 50)} ms, p95 ${nearestRank(sorted, 95)} ms, max ${sorted[sorted.length - 1]} ms`
}

type Sample = {
  bridge: string
  tick: number
  scheduledAt: number
  startedAt: number
  endedAt: number
  latencyMs: number
  lagMs: number
  outcome: Outcome
  httpStatus?: number
  pageState?: string
  detail?: string
}

type RunState = {
  plannedStart: number
  startedAt: number
  endedAt: number
  issued: number
  skipped: number
  interrupted: boolean
  samples: Sample[]
}

function printSummary(options: Options, state: RunState): void {
  const byOutcome: Record<Outcome, number> = { answered: 0, error: 0, timeout: 0, aborted: 0 }
  const byState = new Map<string, number>()
  const byBridge = new Map<string, Record<Outcome, number>>()
  for (const sample of state.samples) {
    byOutcome[sample.outcome] += 1
    const key = sample.pageState ?? '(none)'
    if (sample.outcome === 'answered') byState.set(key, (byState.get(key) ?? 0) + 1)
    const bucket = byBridge.get(sample.bridge) ?? { answered: 0, error: 0, timeout: 0, aborted: 0 }
    bucket[sample.outcome] += 1
    byBridge.set(sample.bridge, bucket)
  }
  const answeredLatencies = state.samples.filter(sample => sample.outcome === 'answered').map(sample => sample.latencyMs)
  const allLatencies = state.samples.map(sample => sample.latencyMs)

  const lines: string[] = []
  lines.push('')
  lines.push('=== soak summary ===')
  lines.push(`  mode            ${options.mode}`)
  lines.push(`  window          ${new Date(state.startedAt).toISOString()} .. ${new Date(state.endedAt).toISOString()} (planned ${options.durationMs} ms, covered ${state.endedAt - state.startedAt} ms)`)
  lines.push(`  base            ${options.base}`)
  lines.push(`  bridges         ${options.bridges.join(', ')}`)
  lines.push(`  cadence         ${options.cadenceMs} ms per bridge`)
  lines.push(`  requests        issued ${state.issued}, completed ${state.samples.length}, skipped slots ${state.skipped}`)
  lines.push(`  outcomes        answered ${byOutcome.answered}, error ${byOutcome.error}, timeout ${byOutcome.timeout}, aborted ${byOutcome.aborted}`)
  lines.push(latencyLine('latency answered', answeredLatencies))
  lines.push(latencyLine('latency all     ', allLatencies))
  if (byState.size > 0) {
    lines.push(`  page state      ${[...byState.entries()].map(([state, count]) => `${state} ${count}`).join(', ')}`)
  }
  for (const [bridge, counts] of byBridge) {
    lines.push(`  bridge ${bridge.padEnd(9)} answered ${counts.answered}, error ${counts.error}, timeout ${counts.timeout}, aborted ${counts.aborted}`)
  }
  const kinds = new Map<string, number>()
  for (const sample of state.samples) {
    if (sample.outcome === 'answered') continue
    const kind = sample.outcome === 'error'
      ? `error${sample.httpStatus ? ` http ${sample.httpStatus}` : ''}${sample.detail ? `: ${sample.detail}` : ''}`
      : sample.outcome
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
  }
  lines.push(`  failures        ${kinds.size === 0 ? 'none' : [...kinds.entries()].map(([kind, count]) => `${kind} x${count}`).join('; ')}`)
  lines.push(`  budget          ${state.issued} of ${options.maxRequests} request(s) used`)
  // A budget of 15 over 15 grid points is not an early stop; the budget and the
  // schedule simply end together, and calling that "early" would make two
  // otherwise identical runs look different.
  const slots = Math.floor((options.durationMs - 1) / options.cadenceMs) + 1
  const plannedTotal = Math.min(options.maxRequests, slots * options.bridges.length)
  const budgetEnded = state.issued >= options.maxRequests && options.maxRequests < plannedTotal
  const why = state.interrupted
    ? 'yes (interrupted; in-flight requests were aborted)'
    : budgetEnded
      ? 'yes (request budget used)'
      : 'no (the schedule ran out)'
  lines.push(`  stopped early   ${why}`)
  process.stdout.write(`${lines.join('\n')}\n`)
}

// --------------------------------------------------------------------- poll

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

type OneRequest = {
  outcome: Outcome
  httpStatus?: number
  pageState?: string
  detail?: string
}

async function postStatus(
  options: Options,
  token: string,
  bridge: string,
  stop: AbortSignal,
): Promise<OneRequest> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, options.requestTimeoutMs)
  const onStop = () => controller.abort()
  stop.addEventListener('abort', onStop, { once: true })
  try {
    const response = await fetch(`${options.base}/operator`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'status', bridge }),
      signal: controller.signal,
    })
    const text = await response.text()
    let body: Record<string, unknown> | null = null
    try { body = JSON.parse(text) as Record<string, unknown> }
    catch { body = null }
    if (!response.ok) {
      return {
        outcome: 'error',
        httpStatus: response.status,
        detail: typeof body?.error === 'string' ? body.error.slice(0, 160) : text.slice(0, 160),
      }
    }
    if (body?.ok !== true) {
      return { outcome: 'error', httpStatus: response.status, detail: 'the body did not say ok:true' }
    }
    return {
      outcome: 'answered',
      httpStatus: response.status,
      pageState: typeof body.state === 'string' ? body.state : undefined,
    }
  } catch {
    if (timedOut) return { outcome: 'timeout', detail: `${options.requestTimeoutMs} ms budget` }
    if (stop.aborted) return { outcome: 'aborted' }
    return { outcome: 'error', detail: 'the request threw before a response' }
  } finally {
    clearTimeout(timer)
    stop.removeEventListener('abort', onStop)
  }
}

async function runBridgeWorker(
  options: Options,
  token: string,
  bridge: string,
  state: RunState,
  budget: { left: number },
  stop: AbortController,
): Promise<void> {
  const gridStart = state.plannedStart
  const deadline = gridStart + options.durationMs
  let tick = 0
  for (;;) {
    if (stop.signal.aborted || budget.left <= 0) return
    const scheduledAt = gridStart + tick * options.cadenceMs
    if (scheduledAt >= deadline) return
    const wait = scheduledAt - Date.now()
    if (wait > 0) {
      await sleep(wait)
      if (stop.signal.aborted) return
    }
    if (budget.left <= 0) return
    budget.left -= 1
    state.issued += 1
    // A slow request makes the next grid point late; count the slots it ate
    // rather than pretending the cadence was met.
    const startedAt = Date.now()
    const result = await postStatus(options, token, bridge, stop.signal)
    const endedAt = Date.now()
    state.samples.push({
      bridge,
      tick,
      scheduledAt,
      startedAt,
      endedAt,
      latencyMs: endedAt - startedAt,
      lagMs: startedAt - scheduledAt,
      ...result,
    })
    process.stdout.write(
      `${new Date(endedAt).toISOString()} ${bridge.padEnd(12)} tick ${String(tick).padStart(3)} lag ${String(startedAt - scheduledAt).padStart(5)} ms  ${String(endedAt - startedAt).padStart(6)} ms  ${result.outcome}${result.pageState ? ` state=${result.pageState}` : ''}${result.httpStatus ? ` http ${result.httpStatus}` : ''}\n`,
    )
    if (stop.signal.aborted) return
    const next = Math.floor((Date.now() - gridStart) / options.cadenceMs) + 1
    if (next > tick + 1) state.skipped += next - tick - 1
    tick = next
  }
}

async function runPoll(options: Options): Promise<number> {
  const { readFileSync } = await import('fs')
  let token = ''
  try {
    const parsed = JSON.parse(readFileSync(options.tokenFile, 'utf8')) as { token?: unknown }
    if (typeof parsed.token !== 'string' || parsed.token === '') throw new Error('no token field')
    token = parsed.token
  } catch (error) {
    process.stderr.write(`chatgpt-peer-soak: cannot read a token from ${options.tokenFile}: ${(error as Error).message}\n`)
    return 2
  }

  const plannedStart = Date.now()
  const state: RunState = { plannedStart, startedAt: plannedStart, endedAt: plannedStart, issued: 0, skipped: 0, interrupted: false, samples: [] }
  const stop = new AbortController()
  const interrupt = () => {
    if (stop.signal.aborted) return
    process.stderr.write('\nchatgpt-peer-soak: interrupted; abandoning the requests in flight\n')
    state.interrupted = true
    stop.abort()
  }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)

  const budget = { left: options.maxRequests }
  process.stdout.write(`chatgpt-peer-soak: poll ${options.bridges.length} bridge(s) for ${options.durationMs} ms at ${options.cadenceMs} ms, max ${options.maxRequests} request(s), ${options.requestTimeoutMs} ms per request\n`)
  try {
    await Promise.all(options.bridges.map(bridge => runBridgeWorker(options, token, bridge, state, budget, stop)))
  } finally {
    state.endedAt = Date.now()
    printSummary(options, state)
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
  }
  const failures = state.samples.filter(sample => sample.outcome === 'error').length
  return failures > 0 ? 1 : 0
}

// --------------------------------------------------------------------- turn

async function runTurn(options: Options): Promise<number> {
  const { randomUUID } = await import('crypto')
  const { join } = await import('path')
  const { readFileSync } = await import('fs')
  const { resolveGatewayPeer } = await import('../src/utils/gatewayPeerSend.js')
  const { GatewaySessionTransport } = await import('../src/utils/gatewaySessionTransport.js')
  const { getClaudeConfigHomeDir } = await import('../src/utils/envUtils.js')

  const resolved = await resolveGatewayPeer(options.bridges[0]!)
  if ('error' in resolved) {
    process.stderr.write(`chatgpt-peer-soak: could not resolve bridge "${options.bridges[0]}": ${resolved.error}\n`)
    return 2
  }
  const directory = join(getClaudeConfigHomeDir(), 'gateway-sessions')
  const sessionId = randomUUID()
  const inboxPath = join(directory, `${sessionId}.inbox`)
  const startedAt = Date.now()
  let reply: { at: number; sender: string; text: string } | null = null

  const checkInbox = () => {
    if (reply !== null) return
    try {
      const parsed = JSON.parse(readFileSync(inboxPath, 'utf8')) as {
        records?: { message?: { fromSessionId?: string; text?: string }; senderName?: string; receivedAt?: string }[]
      }
      for (const record of parsed.records ?? []) {
        if (record.message?.fromSessionId !== resolved.sessionId) continue
        reply = { at: Date.now(), sender: record.senderName ?? resolved.label, text: String(record.message.text ?? '') }
        return
      }
    } catch { /* the inbox is written atomically; a missing file is simply "not yet" */ }
  }

  const transport = new GatewaySessionTransport({
    directory,
    sessionId,
    cwd: process.cwd(),
    name: 'chatgpt-peer-soak',
    purpose: 'transient soak probe: measure the time to a delivered reply',
    onInboxChanged: checkInbox,
  })
  process.stdout.write(`chatgpt-peer-soak: turn probe to ${resolved.label} (${resolved.sessionId})\n`)
  await transport.start()
  try {
    const receipt = await transport.send(resolved.sessionId, options.probeText, options.probeText.slice(0, 200), undefined, 'inquiry', true)
    process.stdout.write(`  receipt ${JSON.stringify(receipt)}\n`)
    const deadline = startedAt + options.requestTimeoutMs
    while (reply === null && !(Date.now() >= deadline)) {
      checkInbox()
      if (reply === null) await sleep(Math.min(200, Math.max(1, deadline - Date.now())))
    }
    const endedAt = Date.now()
    process.stdout.write('')
    process.stdout.write('=== turn summary ===\n')
    process.stdout.write(`  window          ${new Date(startedAt).toISOString()} .. ${new Date(endedAt).toISOString()}\n`)
    process.stdout.write(`  bridge          ${resolved.label} (${resolved.sessionId})\n`)
    process.stdout.write(`  budget          ${options.requestTimeoutMs} ms\n`)
    if (reply === null) {
      process.stdout.write(`  reply           none within ${options.requestTimeoutMs} ms\n`)
      return 1
    }
    const seen: { at: number; sender: string; text: string } = reply
    const firstLine = seen.text.split('\n').find(line => line.trim() !== '') ?? ''
    process.stdout.write(`  reply           ${seen.sender} after ${seen.at - startedAt} ms: "${firstLine.slice(0, 120)}"\n`)
    return 0
  } finally {
    await transport.close()
  }
}

// ---------------------------------------------------------------------- dry

function printPlan(options: Options): void {
  const start = Date.now()
  const perBridge = Math.min(
    Math.floor((options.durationMs - 1) / options.cadenceMs) + 1,
    Math.floor(options.maxRequests / options.bridges.length),
  )
  const ticks = Math.min(options.maxRequests, options.bridges.length * perBridge)
  const lines: string[] = []
  lines.push('chatgpt-peer-soak: DRY - nothing is sent, no file is read')
  lines.push(`  mode            ${options.mode === 'dry' ? 'poll (plan only; dry was requested)' : options.mode}`)
  lines.push(`  base            ${options.base}`)
  lines.push(`  bridges         ${options.bridges.join(', ')}`)
  lines.push(`  cadence         ${options.cadenceMs} ms per bridge`)
  lines.push(`  duration        ${options.durationMs} ms (hard cap ${MAX_DURATION_MS} ms)`)
  lines.push(`  max requests    ${options.maxRequests} (hard cap ${MAX_REQUESTS})`)
  lines.push(`  request timeout ${options.requestTimeoutMs} ms`)
  lines.push(`  token file      ${options.tokenFile === '' ? '(none)' : options.tokenFile} (value never printed)`)
  lines.push(`  window          would cover ${new Date(start).toISOString()} .. ${new Date(start + options.durationMs).toISOString()}`)
  lines.push(`  requests        would issue at most ${ticks} request(s): ${options.bridges.length} bridge(s) x ${perBridge} tick(s)`)
  lines.push(`  schedule        ticks at +0, +${options.cadenceMs}, +${options.cadenceMs * 2}, ... ms per bridge, sequential within a bridge`)
  if (options.mode === 'turn') {
    lines.push(`  turn probe      would send "${options.probeText}" to ${options.bridges[0]} and wait ${options.requestTimeoutMs} ms for the reply`)
    lines.push(`  authorization   --i-authorize-live-turn given: yes`)
  } else {
    lines.push(`  turn probe      not planned`)
  }
  lines.push(`  writes          none`)
  process.stdout.write(`${lines.join('\n')}\n`)
}

// --------------------------------------------------------------------- main

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed === 'help') {
    process.stdout.write(HELP)
    return 0
  }
  const options = parsed
  if (options.mode === 'dry') {
    printPlan(options)
    return 0
  }
  if (options.mode === 'poll') return runPoll(options)
  return runTurn(options)
}

main().then(
  code => { process.exitCode = code },
  error => {
    process.stderr.write(`chatgpt-peer-soak: ${(error as Error).message}\n`)
    process.exitCode = 1
  },
)
