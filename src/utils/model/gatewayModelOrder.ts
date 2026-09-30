import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ModelOption } from './modelOptions.js'
import { getGatewayModelOptions } from './gatewayModelOptions.js'

/**
 * The order the user arranged the model picker in with `t` (move to top) and
 * `r` (lift and place).
 *
 * The picker renders its order from the environment snapshot taken when the
 * session started, so a saved order only reaches the next launch through
 * scripts/cc.ps1, which reads this file and re-sorts the catalog before it
 * exports MODEL_GATEWAY_MODEL_OPTIONS. That is the same two-sided arrangement
 * as the `f` launch default (`gatewayDefaultModel.ts` / `~/.claude/
 * gateway-default-model.txt`).
 */
export function gatewayModelOrderPath(): string {
  return join(homedir(), '.claude', 'gateway-model-order.json')
}

/** The routes the current launcher environment actually offers. */
function offeredModelIds(): Set<string> {
  return new Set(getGatewayModelOptions().map(option => option.value))
}

/**
 * Whether `id` names a route this launch offers, and so a row the picker can
 * order. The picker appends rows that are not in the catalog - a synthetic
 * "Current model" entry and the null-valued "Gateway default" - and ordering
 * one of those would be dropped by the filter in `writeGatewayModelOrder`, so
 * the picker checks first and says so instead of appearing to do nothing.
 */
export function isOrderableGatewayModel(id: string): boolean {
  return offeredModelIds().has(id)
}

/**
 * The stored order, filtered to routes this build can still serve. A stale file
 * cannot inject an entry the catalog no longer offers, and repeats collapse, so
 * the worst a hand-edited file can do is reorder the picker.
 */
export async function readGatewayModelOrder(): Promise<string[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(gatewayModelOrderPath(), 'utf8'))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const offered = offeredModelIds()
  return [
    ...new Set(
      parsed.filter(
        (id): id is string => typeof id === 'string' && offered.has(id),
      ),
    ),
  ]
}

/**
 * Serializes writes so the file ends on the last order the user made. The
 * picker writes on every arrow press while a row is lifted, so two writes can
 * overlap, and a slow earlier write landing after a later one would leave the
 * next launch on the order the user moved away from.
 */
let writeQueue: Promise<unknown> = Promise.resolve()

export async function writeGatewayModelOrder(
  ids: readonly string[],
): Promise<void> {
  const queued = writeQueue.then(
    () => writeGatewayModelOrderNow(ids),
    () => writeGatewayModelOrderNow(ids),
  )
  writeQueue = queued.then(
    () => {},
    () => {},
  )
  return queued
}

/**
 * Persist `ids` as the picker order. Written through a temporary file in the
 * same directory and renamed into place, so a reader never sees a half-written
 * list and an interrupted write leaves the previous order intact.
 *
 * A launch with no gateway routes at all (tests, a non-gateway build) refuses
 * to write: every id would fail the filter, and erasing an order a later
 * gateway launch would have honored is worse than leaving the file alone.
 */
async function writeGatewayModelOrderNow(
  ids: readonly string[],
): Promise<void> {
  const offered = offeredModelIds()
  if (offered.size === 0) return
  const order = [...new Set(ids.filter(id => offered.has(id)))]
  const path = gatewayModelOrderPath()
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    try {
      await handle.writeFile(`${JSON.stringify(order)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

/**
 * Sort `options` so the stored ids lead in stored order, with everything else
 * keeping the catalog's order behind them.
 *
 * Sorting a subset rather than replacing the list is what keeps a new model
 * from being hidden: an id the file was written before lands at the bottom,
 * where a fresh route belongs, instead of vanishing from the picker.
 */
export function applyGatewayModelOrder(
  options: readonly ModelOption[],
  order: readonly string[],
): ModelOption[] {
  if (order.length === 0) return [...options]
  const rank = new Map(order.map((id, index) => [id, index]))
  return [...options].sort((left, right) => {
    const leftRank = rank.get(left.value)
    const rightRank = rank.get(right.value)
    if (leftRank === undefined && rightRank === undefined) return 0
    if (leftRank === undefined) return 1
    if (rightRank === undefined) return -1
    return leftRank - rightRank
  })
}
