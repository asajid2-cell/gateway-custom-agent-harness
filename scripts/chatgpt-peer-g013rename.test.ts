/**
 * G-013 acceptance fixture: `saveJson` survives a reader holding the target.
 *
 * Windows blocks `rename(tmp, target)` with EPERM while ANY handle holds the
 * target open without delete-share (measured: Node and Bun alike). `saveJson`
 * writes a uniquely named temporary and renames it, so any reader that is open
 * at that instant loses that save and leaves the temporary behind.
 *
 * The contract under test (scripts/chatgpt-peer/state.ts only):
 *
 *  - the rename is retried on EPERM and EBUSY only, 25/100/250 ms apart;
 *  - a reader released inside that budget costs one slow save, not a failure;
 *  - a reader held past the whole budget still fails, but leaves NO temporary;
 *  - the per-path serialisation is unchanged, and the error still names the
 *    path and the errno, so `persistBridgeState(bridge, true)` still throws.
 *
 * Every row uses a scratch directory under the OS temp root. It never opens
 * the live `C:\Users\Ahmed\chatgpt-web\peer.json`, and it spawns nothing: the
 * blocking handle is this process's own `open(path, 'r')`, which reproduces
 * the measured EPERM exactly.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtemp, open, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { saveJson } from './chatgpt-peer/state.ts'

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function scratch(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'g013-rename-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** The temporaries `saveJson` would leave behind for this target. */
async function leftovers(path: string): Promise<string[]> {
  const entries = await readdir(dirname(path))
  return entries.filter(entry => entry.startsWith(`${basename(path)}.`) && entry.endsWith('.tmp'))
}

const readJson = async (path: string): Promise<any> => JSON.parse(await readFile(path, 'utf8'))

/** Seed the target with no blocker, so a read handle can be opened on it. */
async function seed(path: string): Promise<void> {
  await saveJson(path, { n: -1 })
  expect(await leftovers(path)).toEqual([])
}

describe('G-013: saveJson retries a rename blocked by a reader', () => {
  // Row 1: the reader leaves inside the retry budget --------------------------
  test('1. a reader released inside the budget: the save succeeds and no tmp remains', async () => {
    const { dir, cleanup } = await scratch()
    const path = join(dir, 'peer.json')
    try {
      await seed(path)
      const handle = await open(path, 'r')
      const started = Date.now()
      const pending = saveJson(path, { n: 1 })
      // Release after the first retry has already fired (initial attempt at
      // ~0 ms, retry at ~25 ms): the next attempt at ~125 ms must land.
      void delay(60).then(() => handle.close())
      await pending
      const elapsed = Date.now() - started
      console.log(`[G-013] row 1: saved after ${elapsed} ms (reader released at 60 ms)`)
      expect(elapsed).toBeGreaterThanOrEqual(100)
      expect(elapsed).toBeLessThan(2_000)
      expect((await readJson(path)).n).toBe(1)
      expect(await leftovers(path)).toEqual([])
    } finally {
      await cleanup()
    }
  }, 20_000)

  // Row 2: the reader outlives the whole budget ------------------------------
  test('2. a reader held past the budget: the save fails, names the path, and leaves no tmp', async () => {
    const { dir, cleanup } = await scratch()
    const path = join(dir, 'peer.json')
    try {
      await seed(path)
      const handle = await open(path, 'r')
      const started = Date.now()
      let failure: NodeJS.ErrnoException | undefined
      try { await saveJson(path, { n: 2 }) }
      catch (error) { failure = error as NodeJS.ErrnoException }
      const elapsed = Date.now() - started
      await handle.close()

      const left = await leftovers(path)
      console.log(`[G-013] row 2: failed after ${elapsed} ms, ${left.length} tmp left`)
      expect(failure).toBeDefined()
      expect(String(failure!.code)).toBe('EPERM')
      expect(failure!.message).toContain('rename')
      expect(failure!.message).toContain(path)
      // The whole point of the fix: the temporary is not leaked. Checked
      // before the timing so a base build fails on the leak, not on a clock.
      expect(left).toEqual([])
      // The three backoff waits total 375 ms; a base build fails at ~1 ms.
      expect(elapsed).toBeGreaterThanOrEqual(300)
      expect(elapsed).toBeLessThan(3_000)
      // The previous good snapshot is still the file on disk.
      expect((await readJson(path)).n).toBe(-1)
      // And the next save, with the reader gone, lands normally.
      await saveJson(path, { n: 3 })
      expect((await readJson(path)).n).toBe(3)
    } finally {
      await cleanup()
    }
  }, 20_000)

  // Row 3: baseline and the per-path queue ------------------------------------
  test('3. no reader: every save lands, every time, and the last call is the last word', async () => {
    const { dir, cleanup } = await scratch()
    const path = join(dir, 'peer.json')
    try {
      const sequential = Date.now()
      for (let index = 0; index < 50; index += 1) await saveJson(path, { n: index })
      const sequentialMs = Date.now() - sequential
      expect((await readJson(path)).n).toBe(49)
      expect(await leftovers(path)).toEqual([])

      // Overlapping calls keep their order: the serialisation is unchanged.
      const overlapping = Date.now()
      await Promise.all(Array.from({ length: 20 }, (_, index) => saveJson(path, { n: 100 + index })))
      const overlappingMs = Date.now() - overlapping
      console.log(`[G-013] row 3: 50 sequential saves in ${sequentialMs} ms, 20 overlapping in ${overlappingMs} ms`)
      expect((await readJson(path)).n).toBe(119)
      expect(await leftovers(path)).toEqual([])
    } finally {
      await cleanup()
    }
  }, 20_000)

  // Row 4: the caller contract `critical=true` depends on ----------------------
  test('4. a final failure still rejects with the original errno and path (critical callers rethrow)', async () => {
    const { dir, cleanup } = await scratch()
    const path = join(dir, 'peer.json')
    try {
      await seed(path)
      const handle = await open(path, 'r')
      // `persistBridgeState(bridge, true)` is `saveJson(...).catch(error => {
      // log(...); if (critical) throw error })` (scripts/chatgpt-peer.ts:5498-
      // 5504, untouched here). That rethrow is only correct if saveJson
      // rejects with an Error carrying the errno and the path, so this asserts
      // exactly that rather than resolving quietly. (The temporary-leak
      // assertions live in rows 1 and 2; this row is the contract only.)
      const started = Date.now()
      const failure = await saveJson(path, { n: 4 }).then(() => null, (error: NodeJS.ErrnoException) => error)
      const elapsed = Date.now() - started
      await handle.close()
      console.log(`[G-013] row 4: rejected after ${elapsed} ms with code ${failure?.code ?? 'none'}`)
      expect(failure).toBeInstanceOf(Error)
      expect(String(failure!.code)).toBe('EPERM')
      expect(failure!.message).toContain(path)
      expect((await readJson(path)).n).toBe(-1)
      await saveJson(path, { n: 5 })
      expect((await readJson(path)).n).toBe(5)
    } finally {
      await cleanup()
    }
  }, 20_000)
})
