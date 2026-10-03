#!/usr/bin/env bun
/**
 * Prefix-cache attribution over the durable token ledger.
 *
 * The question this answers: how much of the harness's prompt traffic is
 * served from the provider's prefix cache, does that hold across ALL sessions
 * (not just a healthy one), does it degrade as concurrent sessions grow, and
 * where does a cacheable prefix break?
 *
 * Raw metric (per request):  cacheRead / (cacheRead + freshInput)
 *   - freshInput is the ledger's `input` field (uncached prompt tokens)
 *   - cacheWrite is 0 throughout on this harness: it never writes cache
 *     explicitly, it rides provider-side prefix caching.
 *
 * Source: ~/.claude/token-ledger/tokens.jsonl - one JSON row per response,
 * written from the same funnel that normalizes every provider's usage. This is
 * the authoritative surface (transcript-derived stats under-count: see the
 * gateway-token-telemetry notes).
 *
 * This is a MEASUREMENT tool. It reports; it does not change the harness.
 *
 * Usage:
 *   bun scripts/cache-rate-report.mjs
 *   bun scripts/cache-rate-report.mjs --model deepseek-v4.1 --backend opencode-go
 *   bun scripts/cache-rate-report.mjs --since 2026-10-01
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const modelFilter = arg('model', 'deepseek-v4.1')
const backendFilter = arg('backend', 'opencode-go')
const since = arg('since', null)
const sinceMs = since ? Date.parse(since) : 0
const ledgerDir = process.env.GATEWAY_TOKEN_LEDGER_DIR || join(homedir(), '.claude', 'token-ledger')
const ledgerPath = join(ledgerDir, 'tokens.jsonl')

function load() {
  let raw
  try {
    raw = readFileSync(ledgerPath, 'utf8')
  } catch {
    console.error(`no ledger at ${ledgerPath}`)
    process.exit(1)
  }
  const rows = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let r
    try { r = JSON.parse(line) } catch { continue }
    if (backendFilter && !String(r.backend || '').includes(backendFilter)) continue
    if (modelFilter && !String(r.model || '').includes(modelFilter)) continue
    const t = Date.parse(r.at)
    if (sinceMs && !(t >= sinceMs)) continue
    rows.push({ t, s: r.session || '?', i: r.input || 0, cr: r.cacheRead || 0, cw: r.cacheWrite || 0 })
  }
  rows.sort((a, b) => a.t - b.t)
  return rows
}

const pct = (cr, i) => (cr + i > 0 ? (cr / (cr + i)) * 100 : 0)
const median = (a) => {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  return s[Math.floor(s.length / 2)]
}

const rows = load()
if (!rows.length) {
  console.error('no rows match the filter')
  process.exit(1)
}

const totCR = rows.reduce((a, r) => a + r.cr, 0)
const totI = rows.reduce((a, r) => a + r.i, 0)
const totCW = rows.reduce((a, r) => a + r.cw, 0)

console.log(`# cache-rate attribution  (backend~${backendFilter} model~${modelFilter})`)
console.log(`ledger: ${ledgerPath}`)
console.log(`span:   ${new Date(rows[0].t).toISOString()} .. ${new Date(rows[rows.length - 1].t).toISOString()}`)
console.log('')
console.log('## fleet-wide (all sessions)')
console.log(`  requests         ${rows.length}`)
console.log(`  sessions         ${new Set(rows.map((r) => r.s)).size}`)
console.log(`  cacheRead        ${totCR.toLocaleString()}`)
console.log(`  freshInput       ${totI.toLocaleString()}`)
console.log(`  cacheWrite       ${totCW.toLocaleString()}`)
console.log(`  %-hit aggregate  ${pct(totCR, totI).toFixed(1)}%`)
// cacheWrite==0 is the corroboration that the harness has no cache lever: it
// never writes a cache block of its own, so every cacheRead is provider-side
// prefix reuse on a byte-identical prefix. A non-zero cacheWrite would mean the
// harness is minting its own cache blocks and this metric would need re-reading.
if (totCW === 0) console.log('  note             cacheWrite=0 => no harness cache lever; cacheRead is pure provider-side prefix reuse')

// Per-session spread: the aggregate can be carried by one healthy session, so
// report the floor and ceiling too. The target floors the worst session.
console.log('')
console.log('## per-session spread')
const bySession = new Map()
for (const r of rows) {
  const s = bySession.get(r.s) || { cr: 0, i: 0, n: 0 }
  s.cr += r.cr; s.i += r.i; s.n++; bySession.set(r.s, s)
}
const sessions = [...bySession.entries()]
  .map(([sid, v]) => ({ sid, hit: pct(v.cr, v.i), ...v }))
  .sort((a, b) => a.hit - b.hit)
const withEnough = sessions.filter((s) => s.n >= 20)
if (withEnough.length) {
  const hits = withEnough.map((s) => s.hit)
  console.log(`  sessions >=20 reqs: ${withEnough.length}`)
  console.log(`  worst  ${hits[0].toFixed(1)}%  (${withEnough[0].sid.slice(0, 12)}, ${withEnough[0].n} reqs)`)
  console.log(`  median ${median(hits).toFixed(1)}%`)
  console.log(`  best   ${hits[hits.length - 1].toFixed(1)}%`)
}
console.log('  --- lowest 5 ---')
for (const s of withEnough.slice(0, 5)) {
  console.log(`    ${s.sid.slice(0, 12)}  hit=${s.hit.toFixed(1)}%  reqs=${s.n}  fresh=${s.i.toLocaleString()}`)
}

// Break detector: freshInput far above the session's own median is a prefix
// that had to be re-sent fresh (invalidated), i.e. a cacheable prefix broke.
// maxFresh near the full context size is a full-prefix re-send.
console.log('')
console.log('## prefix breaks (freshInput > 4x session median)')
const breaksBySession = []
for (const [sid, v] of bySession) {
  const inputs = rows.filter((r) => r.s === sid).map((r) => r.i)
  const med = median(inputs)
  const breaks = inputs.filter((x) => x > 4 * med).length
  breaksBySession.push({ sid, med, breaks, maxFresh: Math.max(...inputs), n: v.n, hit: pct(v.cr, v.i) })
}
breaksBySession.sort((a, b) => b.breaks / b.n - a.breaks / a.n)
console.log('  session        reqs   medianFresh  breaks  break%  maxFresh')
for (const b of breaksBySession.slice(0, 8)) {
  console.log(
    `    ${b.sid.slice(0, 12)}  ${String(b.n).padStart(5)}  ${String(b.med).padStart(11)}  ${String(b.breaks).padStart(6)}  ${((b.breaks / b.n) * 100).toFixed(1).padStart(5)}%  ${b.maxFresh.toLocaleString()}`,
  )
}

// Concurrency slope: does the rate degrade as more sessions run at once? A
// flat slope is true cross-session prefix reuse; a falling slope is
// per-session caching (the same prefix re-written per session). Concurrency is
// distinct sessions active within +/-5 minutes of each request.
console.log('')
console.log('## concurrency slope (hit rate vs sessions active in a +/-5min window)')
const W = 5 * 60 * 1000
const buckets = new Map()
let j = 0, k = 0
for (let x = 0; x < rows.length; x++) {
  const t = rows[x].t
  while (rows[j].t < t - W) j++
  while (k < rows.length && rows[k].t <= t + W) k++
  const conc = new Set(rows.slice(j, k).map((r) => r.s)).size
  const b = buckets.get(conc) || { cr: 0, i: 0, n: 0 }
  b.cr += rows[x].cr; b.i += rows[x].i; b.n++; buckets.set(conc, b)
}
console.log('  concurrent  reqs    hit%')
for (const c of [...buckets.keys()].sort((a, b) => a - b)) {
  const b = buckets.get(c)
  console.log(`    ${String(c).padStart(3)}      ${String(b.n).padStart(6)}  ${pct(b.cr, b.i).toFixed(1)}%`)
}
// Name the shape, because this is the headline proof: a FLAT slope is
// cross-session prefix reuse (the same prefix is cached once and read by every
// session); a FALLING slope would be per-session caching (each session
// re-writing its own copy, so more sessions = more misses).
const concKeys = [...buckets.keys()].sort((a, b) => a - b)
if (concKeys.length >= 2) {
  const first = buckets.get(concKeys[0]), last = buckets.get(concKeys[concKeys.length - 1])
  const delta = pct(last.cr, last.i) - pct(first.cr, first.i)
  const shape = Math.abs(delta) < 3 ? 'FLAT' : delta < 0 ? 'FALLING' : 'RISING'
  console.log(`  shape: ${shape} (${delta >= 0 ? '+' : ''}${delta.toFixed(1)}pp from ${concKeys[0]} to ${concKeys[concKeys.length - 1]} concurrent)`)
  if (shape === 'FLAT') console.log('  => cross-session prefix reuse: hit rate holds as concurrent sessions grow')
  if (shape === 'FALLING') console.log('  => per-session caching: the same prefix is re-written per session')
}
