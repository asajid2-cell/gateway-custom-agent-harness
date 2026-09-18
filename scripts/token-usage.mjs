#!/usr/bin/env bun
/**
 * Token usage report over the harness token ledger.
 *
 *   bun scripts/token-usage.mjs
 *   bun scripts/token-usage.mjs week
 *   bun scripts/token-usage.mjs --session <id-prefix> --backend codex
 *   bun scripts/token-usage.mjs --json
 *
 * The ledger is one JSONL row per API response, written by the harness
 * (src/utils/tokenLedger.ts) from the same events the cost tracker counts.
 *
 * This is deliberately a shim, not an implementation. `/usage <args>` renders
 * the identical report through the identical module; a script that re-derived
 * the tables would drift from the command, and the drift would stay invisible
 * until the two sets of numbers disagreed. Run with bun - it imports the
 * TypeScript source directly.
 */
import {
  USAGE_HELP,
  UsageArgumentError,
  parseUsageArgs,
  renderUsageText,
} from '../src/utils/tokenUsageText.ts'

let options
try {
  options = parseUsageArgs(process.argv.slice(2))
} catch (error) {
  if (error instanceof UsageArgumentError) {
    process.stderr.write(`${error.message}\n\n${USAGE_HELP}`)
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  }
  process.exit(1)
}

process.stdout.write(renderUsageText(options))
