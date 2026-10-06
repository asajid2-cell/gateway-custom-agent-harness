import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Debug logging must never take down startup. getDebugLogPath() uses
 * CLAUDE_CODE_DEBUG_LOGS_DIR as the log *file* path, so a caller that reads the
 * name as a directory and points it at one used to hit an unhandled EISDIR on
 * the first log write - which happens pre-paint (the MDM load logs), so the
 * whole launch died blank.
 *
 * The buffered (ant, no --debug) write path already swallowed write errors; the
 * immediate --debug path did not. This asserts the immediate path is now
 * best-effort too, and that a normal file destination still receives output.
 */
test('logForDebugging survives a directory destination and still writes to a file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-debug-dest-'))
  const file = join(dir, 'session.txt')
  const saved = {
    DEBUG: process.env.DEBUG,
    NODE_ENV: process.env.NODE_ENV,
    LOGS_DIR: process.env.CLAUDE_CODE_DEBUG_LOGS_DIR,
  }

  try {
    process.env.DEBUG = '1'
    process.env.NODE_ENV = 'production'
    process.env.CLAUDE_CODE_DEBUG_LOGS_DIR = dir

    const debug = await import('../src/utils/debug.ts')
    // The mode/path helpers are memoized; recompute against the env above.
    debug.isDebugMode.cache.clear?.()
    debug.getDebugFilePath.cache.clear?.()
    assert.equal(debug.isDebugMode(), true, 'debug mode should be active')

    // A directory destination: the pre-fix code threw EISDIR here.
    assert.doesNotThrow(() => {
      debug.logForDebugging('startup probe with a directory destination')
    })

    // A real file destination still receives the line.
    process.env.CLAUDE_CODE_DEBUG_LOGS_DIR = file
    debug.logForDebugging('startup probe with a file destination')
    assert.match(
      readFileSync(file, 'utf8'),
      /startup probe with a file destination/,
    )
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      const name =
        key === 'LOGS_DIR' ? 'CLAUDE_CODE_DEBUG_LOGS_DIR' : key
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(dir, { recursive: true, force: true })
  }
})
