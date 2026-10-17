import { test, expect, mock, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * The succession record belongs to the family pointer, and a republish must carry
 * it through rather than write over it.
 *
 * `index/<root>.json` is two things at once: the creator's member pointer, and the
 * family's authority for `patriarchSessionId` / `formerPatriarchIds` /
 * `heirSessionId`. Two writers touch it - a move of the designation
 * (`writePatriarchDesignation`) and a republish of every member pointer
 * (`indexLeafMembers`) - and both read the record before they write it. Read apart
 * from the write, the republish's older read can land after the move and put the
 * closed matriarch back at the head of the family with `formerPatriarchIds` empty.
 * That is the flake the acceptance harness saw once in four runs on a live family,
 * and it is a lost update rather than a convergence: nothing about the run
 * converges it, the two writes simply crossed.
 *
 * Reproducing it needs the interleave driven, not observed. `rename` is the last
 * step of every pointer write (temp file, then rename), so it is the one place the
 * test can hold a republish inside its write, start the move while it is parked,
 * and only then let it finish. The gate is a pause before the real rename, never a
 * replacement for it - the write that lands is the real one, on a real temp home -
 * and it is armed before the republish starts, so the first rename to the root's
 * pointer path is unambiguously the republish's own write.
 *
 * What is asserted is the durable outcome, not the interleave: after both writes
 * settle, the pointer names the member the move designated and records the member
 * it left. Those two files are what every reader goes through, and the harness
 * assertion that flaked is the same pair of fields.
 */

;(globalThis as unknown as { MACRO: unknown }).MACRO = { VERSION: 'test', BUILD_TIME: 'test' }

/** The real rename, captured before the module is mocked: the gate pauses before it, it does not stand in for it. */
const realFs = await import('node:fs/promises')
const realRename = realFs.rename.bind(realFs)

/** Set by a test to park the first rename to this path until it releases it. */
let gateTarget: string | undefined
let gateUsed = false
let arrived: (() => void) | undefined
let release: (() => void) | undefined

mock.module('node:fs/promises', () => ({
  ...realFs,
  default: realFs,
  rename: async (from: string, to: string) => {
    if (gateTarget !== undefined && !gateUsed && String(to) === gateTarget) {
      gateUsed = true
      arrived?.()
      await new Promise<void>(resolve => { release = resolve })
    }
    return realRename(from, to)
  },
}))

const { indexLeafMembers, writePatriarchDesignation } = await import('../src/utils/leafWorkspace.ts')
const { switchSession } = await import('../src/bootstrap/state.ts')
const { asSessionId } = await import('../src/types/ids.ts')

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const homes: string[] = []

afterEach(() => {
  release?.()
  gateTarget = undefined
  gateUsed = false
  arrived = undefined
  release = undefined
  delete process.env.CLAUDE_CONFIG_DIR
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/** A temp home holding one family: the creator (root) as matriarch, and one leaf. */
function familyHome(): { home: string; root: string; alpha: string; pointerPath: string } {
  const home = mkdtempSync(join(tmpdir(), 'leaf-succession-'))
  homes.push(home)
  process.env.CLAUDE_CONFIG_DIR = home
  const families = join(home, 'leaf-families')
  const index = join(families, 'index')
  mkdirSync(index, { recursive: true })
  const root = randomUUID()
  const alpha = randomUUID()
  const createdAt = new Date().toISOString()
  const row = (sessionId: string, number: number, name: string) => ({
    sessionId, parentSessionId: root, number, name,
    transcriptPath: join(families, `${sessionId}.jsonl`),
    forkMessageId: null, createdAt, status: 'open',
  })
  writeFileSync(join(families, `${root}.json`), JSON.stringify({
    version: 1, rootSessionId: root, nextNumber: 3,
    members: [row(root, 1, 'Original'), row(alpha, 2, 'Alpha')],
    returnedContextIds: [],
  }))
  // The pointer while root still holds the role: the state a mount finds.
  const pointerPath = join(index, `${root}.json`)
  writeFileSync(pointerPath, JSON.stringify({
    rootSessionId: root, rootName: 'Original', patriarchSessionId: root, formerPatriarchIds: [],
  }))
  switchSession(asSessionId(root), null, home)
  return { home, root, alpha, pointerPath }
}

test('a republish that read the pointer before a move does not put the closed matriarch back', async () => {
  const { root, alpha, pointerPath } = familyHome()

  gateTarget = pointerPath
  gateUsed = false
  const parked = new Promise<void>(resolve => { arrived = resolve })
  const republish = indexLeafMembers(root, [{ sessionId: root }, { sessionId: alpha }] as never)
  await Promise.race([parked, sleep(5_000).then(() => { throw new Error('the republish never reached its pointer write') })])

  // The republish is parked inside its own write, having already read the record.
  // The move of the designation starts now, exactly as a close of the matriarch
  // does it, and lands while the republish is held.
  const move = writePatriarchDesignation(root, alpha, root)
  await Promise.race([move, sleep(500)])
  release?.()
  await Promise.all([move, republish])

  const pointer = JSON.parse(readFileSync(pointerPath, 'utf8')) as {
    patriarchSessionId?: string
    formerPatriarchIds?: string[]
  }
  expect(pointer.patriarchSessionId).toBe(alpha)
  expect(pointer.formerPatriarchIds).toEqual([root])
})
