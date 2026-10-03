#!/usr/bin/env bun
/**
 * Forward proof: a fresh harness session reads a prefix it never sent.
 *
 * `cache-rate-report.mjs` measures the cache hit over HISTORY. That is the
 * right measurement for the fleet aggregate, but it cannot answer "does a
 * session that has just started inherit the shared prefix?" - the first ledger
 * row of a historical session is usually a RESUMED session carrying a large,
 * heterogeneous context (median first-request size ~38.7K, p75 97K), not a
 * plain fresh start. Measuring those reads cold (~14-17% median) and is
 * misleading. Only a FORWARD probe - start fresh sessions and read their very
 * first request - is trustworthy for that question.
 *
 * What this does: launch N fresh single-turn harness sessions back-to-back
 * from ONE unique cwd, then read the token ledger for the requests carrying
 * that cwd. Every matching row is therefore this probe's own, and each row is
 * the FIRST request of a distinct session id.
 *
 * Expected shape (measured 2026-10-03, ds4v1, warm fleet):
 *   - request #1 is cold (the head had not been established for this cwd):
 *     cacheRead ~2.5K / fresh ~15.8K (~14%).
 *   - requests #2..#N, each a DIFFERENT session id, read ~18,304 of the
 *     ~18,360-token head from cache with only ~56 tokens fresh (~99.7%).
 *     They read a prefix none of them ever sent.
 * That asymmetry is the proof of cross-session prefix reuse: the first request
 * establishes the head, every later fresh session inherits it.
 *
 * Why there is no harness cache lever on this route (verified 2026-10-03,
 * cell/main): shouldUseGlobalCacheScope() (src/utils/betas.ts:227) is true
 * only when getAPIProvider() === 'firstParty' (:229), and getAPIProvider()
 * (src/utils/model/providers.ts:38) returns 'gateway' (:40) whenever
 * CLAUDE_CODE_USE_GATEWAY is set. So SYSTEM_PROMPT_DYNAMIC_BOUNDARY
 * (src/constants/prompts.ts:114) is never inserted (:573) and
 * splitSysPromptPrefix (src/utils/api.ts:321) ships the whole system prompt as
 * one cacheScope:'org' block. cacheWrite=0 on every ledger row corroborates:
 * the cache is 100% the provider's automatic prefix caching.
 *
 * Caveat the aggregate hides: the head is RECENCY-bound. It is evicted within
 * ~2.5 min of no matching traffic, so a session that starts after an idle gap
 * pays the head (cold) and re-establishes it for those that follow. That is
 * why the fleet number tracks how busy the fleet is, not a permanent guarantee.
 *
 * This is a MEASUREMENT tool. It reports; it does not change the harness.
 *
 * Usage (the harness must run under bun; node cannot parse the dist bundle):
 *   CACHE_PROBE_N=8 bun scripts/cache-forward-probe.mjs
 * Env: CACHE_PROBE_MODEL, CACHE_PROBE_N, CACHE_PROBE_CLI, CACHE_PROBE_BUN,
 *      CACHE_PROBE_LEDGER, CACHE_PROBE_PROMPT, GATEWAY_TOKEN_LEDGER_DIR.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const model = process.env.CACHE_PROBE_MODEL || 'gateway-opencode-deepseek-v4.1-flash'
const prompt = process.env.CACHE_PROBE_PROMPT || 'ok'
const n = Number(process.env.CACHE_PROBE_N || 8)
const cli = resolve(process.env.CACHE_PROBE_CLI || 'dist/cli.js')
const bun = process.env.CACHE_PROBE_BUN || (process.versions?.bun ? process.execPath : 'bun')
const ledgerPath =
  process.env.CACHE_PROBE_LEDGER ||
  join(process.env.GATEWAY_TOKEN_LEDGER_DIR || join(homedir(), '.claude', 'token-ledger'), 'tokens.jsonl')

// A unique cwd makes every matching ledger row unambiguously this probe's.
const probeDir = mkdtempSync(join(tmpdir(), 'cache-forward-probe-'))
const norm = p => String(p || '').replace(/\\/g, '/').toLowerCase()
const wantCwd = norm(probeDir)

console.log(`# cache forward probe  (model=${model}, n=${n})`)
console.log(`cli:    ${cli}`)
console.log(`bun:    ${bun}`)
console.log(`cwd:    ${probeDir}`)
console.log(`ledger: ${ledgerPath}`)
console.log('')

const failures = []
for (let i = 0; i < n; i++) {
  const r = spawnSync(bun, [cli, '-p', prompt, '--model', model], { cwd: probeDir, stdio: 'ignore' })
  if (r.error) failures.push(`#${i + 1} spawn: ${r.error.message}`)
  else if (r.status !== 0) failures.push(`#${i + 1} exit ${r.status}`)
}

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
  try {
    r = JSON.parse(line)
  } catch {
    continue
  }
  if (norm(r.cwd) !== wantCwd) continue
  rows.push(r)
}
rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))

if (rows.length < 2) {
  console.error(`only ${rows.length} ledger row(s) for ${probeDir}; probes may have failed`)
  for (const f of failures) console.error(`  ${f}`)
  process.exit(1)
}

const hit = r => {
  const d = (r.cacheRead || 0) + (r.input || 0)
  return d === 0 ? 0 : (r.cacheRead || 0) / d
}

console.log('## per-session first request')
console.log('  #   session    cacheRead   fresh   total    hit%')
let cr = 0
let fresh = 0
let warm = 0
rows.forEach((r, i) => {
  const tot = (r.cacheRead || 0) + (r.input || 0)
  const h = hit(r)
  cr += r.cacheRead || 0
  fresh += r.input || 0
  if (h >= 0.5) warm++
  console.log(
    `  ${String(i + 1).padStart(2)}  ${String(r.session || '?').slice(0, 8)}  ${String(r.cacheRead || 0).padStart(9)}  ${String(r.input || 0).padStart(6)}  ${String(tot).padStart(6)}  ${(h * 100).toFixed(1).padStart(5)}`,
  )
})

// The first request establishes the head for this cwd; the rest should inherit
// it. Report both the whole sample and the inherited subset (all but #1).
const inherited = rows.slice(1)
const inhCr = inherited.reduce((a, r) => a + (r.cacheRead || 0), 0)
const inhFresh = inherited.reduce((a, r) => a + (r.input || 0), 0)
const distinct = new Set(rows.map(r => r.session)).size

console.log('')
console.log('## summary')
console.log(`  sessions (distinct ids)   ${distinct}`)
console.log(`  warm (>=50%)              ${warm}/${rows.length}`)
console.log(`  whole-sample weighted hit ${((cr / (cr + fresh)) * 100).toFixed(1)}%`)
console.log(`  inherited (all but #1)    ${((inhCr / (inhCr + inhFresh)) * 100).toFixed(1)}%  over ${inherited.length} distinct fresh sessions`)
console.log('')
console.log('  A high inherited rate means later fresh sessions read a prefix they')
console.log('  never sent - cross-session prefix reuse, not per-session caching.')
if (failures.length) {
  console.log('')
  console.log(`  probe failures: ${failures.length}`)
  for (const f of failures) console.log(`    ${f}`)
}
