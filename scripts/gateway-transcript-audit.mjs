import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { createInterface } from 'node:readline'

const DEFAULT_ROOT = path.join(
  process.env.USERPROFILE || process.env.HOME || '.',
  '.claude',
  'projects',
  'C--Users-Ahmed',
)
const DEFAULT_CWD = 'C:\\Users\\Ahmed'

function parseArgs(argv) {
  const options = {
    root: DEFAULT_ROOT,
    cwd: DEFAULT_CWD,
    sinceHours: 48,
    allCwds: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--root') options.root = argv[++index]
    else if (arg === '--cwd') options.cwd = argv[++index]
    else if (arg === '--since-hours') options.sinceHours = Number(argv[++index])
    else if (arg === '--all-cwds') options.allCwds = true
    else if (arg === '--help') {
      console.log(
        'Usage: node scripts/gateway-transcript-audit.mjs [--root DIR] [--cwd DIR] [--since-hours N] [--all-cwds]',
      )
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (!Number.isFinite(options.sinceHours) || options.sinceHours < 0) {
    throw new Error('--since-hours must be a non-negative number')
  }
  return options
}

function timestampMs(value) {
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function textFromContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      if (typeof block === 'string') return block
      if (!block || typeof block !== 'object') return ''
      return typeof block.text === 'string'
        ? block.text
        : typeof block.content === 'string'
          ? block.content
          : ''
    })
    .join('\n')
}

function hashInput(toolName, input) {
  const stable = JSON.stringify({ toolName, input })
  return createHash('sha256').update(stable).digest('hex').slice(0, 12)
}

function errorCategory(text) {
  const value = text.toLowerCase()
  if (/api\s+error\b|api_error\b|returned http [4-5]\d\d\b/.test(value)) {
    return 'gateway-upstream-error'
  }
  if (/cannot create agent worktree|worktree.*(not|no).*git|isolation.*worktree/.test(value)) {
    return 'worktree-unavailable'
  }
  if (/ripgrep|rg\\.exe|executable not found/.test(value)) {
    return 'search-runtime'
  }
  if (/invalid pages parameter|invalid .*parameter|validation|schema/.test(value)) {
    return 'invalid-input'
  }
  if (/current working directory|file does not exist|no such file|enoent/.test(value)) {
    return 'cwd-or-path'
  }
  if (/timed out|timeout|deadline/.test(value)) return 'timeout'
  if (/rate.?limit|429/.test(value)) return 'rate-limit'
  if (/permission denied|access denied|eacces|eperm/.test(value)) return 'permission'
  if (/exit code [1-9]|process failed|spawn.*failed/.test(value)) {
    return 'process-failure'
  }
  if (
    /^error(?::|$)/.test(value) ||
    /^failed(?::|$)/.test(value) ||
    /^failure(?::|$)/.test(value) ||
    /^cannot\b/.test(value) ||
    /^invalid\b/.test(value)
  ) {
    return 'other-error'
  }
  return null
}

function isErrorResult(block, root) {
  if (block?.is_error === true || block?.isError === true) return true
  if (root?.toolUseResult?.is_error === true || root?.toolUseResult?.isError === true) {
    return true
  }
  const text = textFromContent(block?.content).trim()
  return (
    /^<tool_use_error>/i.test(text) ||
    /^api\s+error\b/i.test(text) ||
    /\bapi_error\b/i.test(text) ||
    /\breturned http [4-5]\d\d\b/i.test(text) ||
    /^error(?::|\s)/i.test(text) ||
    /^failed(?::|\s)/i.test(text) ||
    /^failure(?::|\s)/i.test(text) ||
    /^cannot\b/i.test(text) ||
    /^invalid\b/i.test(text) ||
    /^exit code [1-9]\b/i.test(text) ||
    /^executable not found\b/i.test(text)
  )
}

function newFileStats(file) {
  return {
    file,
    lines: 0,
    toolCalls: 0,
    toolResults: 0,
    errors: 0,
    errorCategories: new Map(),
    agentErrorCategories: new Map(),
    toolCounts: new Map(),
    failedToolCounts: new Map(),
    agentCalls: 0,
    agentFailures: 0,
    retriesAfterFailure: 0,
    repeatedFailures: new Map(),
    durations: [],
    firstTimestamp: null,
    lastTimestamp: null,
    cwd: null,
    sessionId: null,
  }
}

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) || 0) + amount)
}

function sortedMap(map, limit = 20) {
  return [...map.entries()]
    .sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0])))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }))
}

async function auditFile(file, options, cutoffMs) {
  const stats = newFileStats(file)
  const pending = new Map()
  const failedSignatures = new Set()
  const recentCalls = new Map()
  const input = createReadStream(file, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })

  for await (const line of lines) {
    stats.lines += 1
    if (!line.trim()) continue

    let root
    try {
      root = JSON.parse(line)
    } catch {
      continue
    }

    const timestamp = timestampMs(root.timestamp)
    if (timestamp != null && timestamp < cutoffMs) continue
    if (timestamp != null) {
      stats.firstTimestamp ??= timestamp
      stats.lastTimestamp = timestamp
    }
    stats.cwd ??= root.cwd || null
    stats.sessionId ??= root.sessionId || null

    if (
      !options.allCwds &&
      options.cwd &&
      stats.cwd &&
      path.normalize(stats.cwd).toLowerCase() !== path.normalize(options.cwd).toLowerCase()
    ) {
      continue
    }

    const blocks = Array.isArray(root.message?.content) ? root.message.content : []
    for (const block of blocks) {
      if (block?.type === 'tool_use') {
        const toolName = block.name || 'unknown'
        const signature = hashInput(toolName, block.input ?? null)
        const call = {
          toolName,
          signature,
          timestamp,
          line: stats.lines,
        }
        pending.set(block.id, call)
        recentCalls.set(signature, call)
        stats.toolCalls += 1
        increment(stats.toolCounts, toolName)
        if (toolName.toLowerCase() === 'agent') stats.agentCalls += 1
        continue
      }

      if (block?.type !== 'tool_result') continue
      stats.toolResults += 1
      const call = pending.get(block.tool_use_id)
      const resultText = textFromContent(block.content)
      const failed = isErrorResult(block, root)
      if (call?.timestamp != null && timestamp != null) {
        const duration = timestamp - call.timestamp
        if (duration >= 0 && duration < 24 * 60 * 60 * 1000) {
          stats.durations.push(duration)
        }
      }
      if (!failed) continue

      stats.errors += 1
      const category = errorCategory(resultText) || 'other-error'
      increment(stats.errorCategories, category)
      increment(stats.failedToolCounts, call?.toolName || 'unknown')
      if (call?.toolName?.toLowerCase() === 'agent') {
        stats.agentFailures += 1
        increment(stats.agentErrorCategories, category)
      }
      if (call?.signature && failedSignatures.has(call.signature)) {
        stats.retriesAfterFailure += 1
      }
      if (call?.signature) {
        increment(stats.repeatedFailures, call.signature)
        failedSignatures.add(call.signature)
      }
    }
  }

  return stats
}

function percentile(values, fraction) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
}

function serializeFile(stats) {
  return {
    file: stats.file,
    sessionId: stats.sessionId,
    cwd: stats.cwd,
    firstTimestamp: stats.firstTimestamp == null ? null : new Date(stats.firstTimestamp).toISOString(),
    lastTimestamp: stats.lastTimestamp == null ? null : new Date(stats.lastTimestamp).toISOString(),
    spanMs:
      stats.firstTimestamp == null || stats.lastTimestamp == null
        ? null
        : Math.max(0, stats.lastTimestamp - stats.firstTimestamp),
    lines: stats.lines,
    toolCalls: stats.toolCalls,
    toolResults: stats.toolResults,
    errors: stats.errors,
    agentCalls: stats.agentCalls,
    agentFailures: stats.agentFailures,
    agentFailureRate:
      stats.agentCalls === 0 ? null : stats.agentFailures / stats.agentCalls,
    retriesAfterFailure: stats.retriesAfterFailure,
    errorCategories: sortedMap(stats.errorCategories),
    agentErrorCategories: sortedMap(stats.agentErrorCategories),
    failedTools: sortedMap(stats.failedToolCounts),
    tools: sortedMap(stats.toolCounts),
    resultLatencyMs: {
      count: stats.durations.length,
      p50: percentile(stats.durations, 0.5),
      p95: percentile(stats.durations, 0.95),
      max: stats.durations.length ? Math.max(...stats.durations) : null,
    },
    repeatedFailureSignatures: [...stats.repeatedFailures.entries()]
      .filter(([, count]) => count > 1)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 20)
      .map(([signature, count]) => ({ signature, count })),
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const cutoffMs = Date.now() - options.sinceHours * 60 * 60 * 1000
  const entries = await readdir(options.root, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    const file = path.join(options.root, entry.name)
    const fileStats = await stat(file)
    if (fileStats.mtimeMs >= cutoffMs) files.push(file)
  }

  const reports = []
  for (const file of files.sort()) {
    const report = await auditFile(file, options, cutoffMs)
    if (report.toolCalls > 0 || report.toolResults > 0) {
      reports.push(serializeFile(report))
    }
  }

  const aggregate = {
    files: reports.length,
    toolCalls: reports.reduce((sum, report) => sum + report.toolCalls, 0),
    toolResults: reports.reduce((sum, report) => sum + report.toolResults, 0),
    errors: reports.reduce((sum, report) => sum + report.errors, 0),
    agentCalls: reports.reduce((sum, report) => sum + report.agentCalls, 0),
    agentFailures: reports.reduce((sum, report) => sum + report.agentFailures, 0),
    retriesAfterFailure: reports.reduce((sum, report) => sum + report.retriesAfterFailure, 0),
    errorCategories: new Map(),
    agentErrorCategories: new Map(),
    failedTools: new Map(),
  }
  for (const report of reports) {
    for (const item of report.errorCategories) increment(aggregate.errorCategories, item.key, item.count)
    for (const item of report.agentErrorCategories) {
      increment(aggregate.agentErrorCategories, item.key, item.count)
    }
    for (const item of report.failedTools) increment(aggregate.failedTools, item.key, item.count)
  }

  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        scope: {
          root: path.resolve(options.root),
          cwd: options.allCwds ? null : options.cwd,
          since: new Date(cutoffMs).toISOString(),
          note: 'Hashes and counts only; prompts, tool inputs, and file contents are excluded.',
        },
        aggregate: {
          ...aggregate,
          agentFailureRate:
            aggregate.agentCalls === 0
              ? null
              : aggregate.agentFailures / aggregate.agentCalls,
          errorCategories: sortedMap(aggregate.errorCategories),
          agentErrorCategories: sortedMap(aggregate.agentErrorCategories),
          failedTools: sortedMap(aggregate.failedTools),
        },
        files: reports.sort((left, right) => right.errors - left.errors || right.toolCalls - left.toolCalls),
      },
      null,
      2,
    ),
  )
}

main().catch(error => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
