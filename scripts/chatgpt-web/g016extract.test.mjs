/**
 * G-016 fixture: the user-node extraction happens in the page.
 *
 * What is being pinned, in the order the change cares about:
 *
 *   1. IDENTITY - the in-page extraction produces the same Map as the Node
 *      `userTreeNodes(body)` on the same body. It is a port, so the proof is a
 *      differential over fixed bodies (empty, odd/duplicate, and the live shape
 *      at 802 nodes / 120 users), never a spot check. The fixture drives the
 *      SAME exported function the page runs (the `{ body }` seam), so the two
 *      sides cannot drift without this file failing.
 *   2. FALLBACK - when the in-page path fails or is unavailable, the read falls
 *      back to the whole-body read and produces the identical Map. A readable
 *      thread must never become unreadable because a faster path was added.
 *   3. ONE READ PER CALL - every path costs exactly one page evaluate. The
 *      frozen d5proof fakes count `treeReads`; a double read would silently
 *      shift their reveal/fail schedules.
 *   4. CONTRACT - `readUserTreeOnPage` still returns Map|null and
 *      `treeSendEvidence` still accepts exactly one new user turn, so nothing
 *      downstream (`degradedSendVerdict`, `submitTurn`) sees a new shape.
 *
 * Run: `bun test g016extract.test.mjs`
 *
 * Red run, pointed at the parent commit:
 *   G016_SRC=$(git show f5dcd77:chatgpt.mjs > /tmp/base.mjs && echo /tmp/base.mjs) \
 *     bun test g016extract.test.mjs
 *
 * HOME is redirected before the import so nothing here can append to the live
 * driver.log (the module resolves BASE/LOG from it at load time).
 */
import { describe, expect, test } from 'bun:test'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const SCRATCH = path.join(os.tmpdir(), 'g016-fixture')
process.env.CHATGPT_PROFILE ||= path.join(SCRATCH, 'profile')
process.env.HOME = path.join(SCRATCH, 'home')
process.env.USERPROFILE = process.env.HOME

const source = process.env.G016_SRC
  ? pathToFileURL(path.resolve(process.env.G016_SRC)).href
  : new URL('./chatgpt.mjs', import.meta.url).href
const mod = await import(source)

const requireExport = name => {
  if (typeof mod[name] !== 'function') throw new Error(`${name} is not exported at this source`)
  return mod[name]
}
const readUserNodesInPage = name => requireExport(name)
const inPage = (...args) => readUserNodesInPage('readUserNodesInPage')(...args)
const nodesOn = (...args) => readUserNodesInPage('readUserNodesOn')(...args)

const THREAD = '11111111-1111-4111-8111-111111111111'
const PATHNAME = `/backend-api/conversation/${THREAD}`
const TEXT = 'count the peers on the bus'

const pairsOf = map => (map === null ? null : Array.from(map.entries()))

/**
 * The odd shape, exercising every branch of the identity rule at once:
 * a duplicate message id (the last one wins, in the first one's slot), a node
 * with no id at all (key identity), a node whose id lives on the node rather
 * than the message, an assistant node (skipped), a non-string part (dropped),
 * an empty-string id (key identity), missing parts (empty text), a null node,
 * a numeric id (key identity), and an empty key with no id (dropped).
 */
const ODD_BODY = {
  mapping: {
    k1: { message: { id: 'm-a', author: { role: 'user' }, content: { parts: ['  hello\n\nworld  '] } } },
    k2: { message: { id: 'm-a', author: { role: 'user' }, content: { parts: ['second wins'] } } },
    k3: { message: { author: { role: 'user' }, content: { parts: ['no id, key identity'] } } },
    k4: { id: 'node-only', message: { author: { role: 'user' }, content: { parts: ['node id'] } } },
    k5: { message: { id: 'm-assistant', author: { role: 'assistant' }, content: { parts: ['not ours'] } } },
    k6: { message: { id: 'm-parts', author: { role: 'user' }, content: { parts: ['a', 42, null, 'b'] } } },
    k7: { message: { id: '', author: { role: 'user' }, content: { parts: ['empty id -> key'] } } },
    k8: { message: { id: 'm-noparts', author: { role: 'user' } } },
    k9: null,
    k10: { message: { id: 7, author: { role: 'user' }, content: { parts: ['numeric id -> key'] } } },
    '': { message: { author: { role: 'user' }, content: { parts: ['no identity at all'] } } },
  },
}

/** 802 mapping nodes, exactly 120 of them user turns, deterministic text. */
const bigBody = () => {
  const mapping = {}
  for (let i = 0; i < 802; i++) {
    const role = i < 120 ? 'user' : i % 2 === 0 ? 'assistant' : 'system'
    mapping[`node-${i}`] = {
      id: `node-${i}`,
      message: {
        id: `msg-${i}`,
        author: { role },
        content: { parts: [`turn ${i} `, i % 3 === 0 ? 'with   extra\tspace' : 'plain'] },
      },
    }
  }
  return { title: 'synthetic 802', mapping, current_node: 'node-801' }
}

/** A thread body carrying only the given user turns, keyed by their identity. */
const userBody = entries => {
  const mapping = {}
  for (const [identity, said] of entries) {
    const [kind, id] = identity.split(':')
    const message = { author: { role: 'user' }, content: { parts: [said] } }
    if (kind === 'm') message.id = id
    mapping[kind === 'n' ? id : `k-${id}`] = { message }
  }
  return { mapping }
}

/** A page whose evaluate is scripted; `calls()` is the exact evaluate count. */
const fakePage = handler => {
  let count = 0
  return {
    url: () => `https://chatgpt.com/c/${THREAD}`,
    evaluate: async (fn, arg) => {
      count += 1
      return handler(fn, arg, count)
    },
    calls: () => count,
  }
}

describe('G-016 in-page user-node extraction', () => {
  // 1. Identity, differentially ------------------------------------------------
  test('1a. an empty thread is an empty Map, not an unreadable body', async () => {
    const body = { mapping: {} }
    const result = await inPage({ body })
    expect(result.via).toBe('in-page')
    expect(pairsOf(mod.userTreeNodes(result.body))).toEqual(pairsOf(mod.userTreeNodes(body)))
    expect(pairsOf(mod.userTreeNodes(result.body))).toEqual([])
  }, 15_000)

  test('1b. a body with no usable mapping is null on both sides', async () => {
    for (const body of [{ title: 'x' }, { mapping: null }, { mapping: 'nope' }, null, undefined]) {
      const result = await inPage({ body })
      expect(result.via).toBe('in-page')
      expect(mod.userTreeNodes(result.body)).toBe(null)
      expect(mod.userTreeNodes(body)).toBe(null)
    }
  }, 15_000)

  test('1c. odd and duplicate nodes: the projected body yields the same Map, entry for entry', async () => {
    const result = await inPage({ body: ODD_BODY })
    const projected = pairsOf(mod.userTreeNodes(result.body))
    expect(projected).toEqual(pairsOf(mod.userTreeNodes(ODD_BODY)))
    // Explicit, so a mistake shared by both sides cannot hide behind the
    // differential: last duplicate wins, key identity, roles, parts, order.
    expect(projected).toEqual([
      ['m:m-a', 'second wins'],
      ['n:k3', 'no id, key identity'],
      ['m:node-only', 'node id'],
      ['m:m-parts', 'a b'],
      ['n:k7', 'empty id -> key'],
      ['m:m-noparts', ''],
      ['n:k10', 'numeric id -> key'],
    ])
    // The projection keeps the user node objects themselves: nothing is
    // re-derived in the page, so an unexpected field survives untouched. The
    // role-user entry with no usable identity (`''`) rides along and is dropped
    // by userTreeNodes where it always was.
    expect(Object.keys(result.body.mapping)).toEqual(['k1', 'k2', 'k3', 'k4', 'k6', 'k7', 'k8', 'k10', ''])
    expect(result.body.mapping.k4).toBe(ODD_BODY.mapping.k4)
  }, 15_000)

  test('1d. the 802-node / 120-user body: identical length, order and text, 682 nodes dropped', async () => {
    const body = bigBody()
    const nodeMap = mod.userTreeNodes(body)
    const result = await inPage({ body })
    expect(nodeMap.size).toBe(120)
    expect(Object.keys(result.body.mapping).length).toBe(120)
    const projected = pairsOf(mod.userTreeNodes(result.body))
    expect(projected).toEqual(pairsOf(nodeMap))
    expect(projected[0]).toEqual(['m:msg-0', 'turn 0  with extra space'.replace(/\s+/g, ' ').trim()])
    expect(projected[119]).toEqual(['m:msg-119', 'turn 119 plain'])
  }, 15_000)

  test('1e. the extraction the page runs is the one the driver passes to evaluate', async () => {
    const src = await Bun.file(new URL(source)).text()
    expect(src).toContain('evaluateTimed(page, readUserNodesInPage, path, timeoutMs)')
    expect(src).toContain('readUserNodesOn(page, `/backend-api/conversation/${threadId}`, timeoutMs)')
    expect(src).toContain('readUserNodesOn(page, `/backend-api/conversation/${threadId}`, TREE_BASELINE_TIMEOUT_MS)')
  }, 15_000)

  // 2. Fallback ----------------------------------------------------------------
  test('2a. an in-page evaluate that throws falls back to the whole-body read: same Map', async () => {
    const page = fakePage((fn, arg) => {
      if (fn.name === 'readUserNodesInPage') throw new Error('Execution context was destroyed')
      return { ok: true, status: 200, body: ODD_BODY }
    })
    const map = await mod.readUserTreeOnPage(page)
    expect(pairsOf(map)).toEqual(pairsOf(mod.userTreeNodes(ODD_BODY)))
    expect(page.calls()).toBe(2)
  }, 15_000)

  test('2b. an extraction that fails inside the page rides the body back: same Map, one read', async () => {
    const page = fakePage(() => ({ ok: true, status: 200, via: 'body', body: ODD_BODY, why: 'extraction threw' }))
    const map = await mod.readUserTreeOnPage(page)
    expect(pairsOf(map)).toEqual(pairsOf(mod.userTreeNodes(ODD_BODY)))
    expect(page.calls()).toBe(1)
  }, 15_000)

  test('2c. an old whole-body answer is used as-is, never re-read', async () => {
    const page = fakePage(() => ({ ok: true, status: 200, body: ODD_BODY }))
    const read = await nodesOn(page, PATHNAME, 5_000)
    expect(read.ok).toBe(true)
    expect(read.how).toBe('body')
    expect(read.body).toBe(ODD_BODY)
    expect(pairsOf(mod.userTreeNodes(read.body))).toEqual(pairsOf(mod.userTreeNodes(ODD_BODY)))
    expect(page.calls()).toBe(1)
  }, 15_000)

  test('2d. a wedged in-page read is a timeout, not a second attempt', async () => {
    const page = fakePage(() => new Promise(() => {}))
    const startedAt = Date.now()
    const read = await nodesOn(page, PATHNAME, 150)
    const elapsed = Date.now() - startedAt
    expect(read).toMatchObject({ ok: false, reason: 'timeout', how: 'in-page-timeout' })
    expect(page.calls()).toBe(1)
    expect(elapsed).toBeLessThan(1_500)
  }, 15_000)

  // 3. The success path --------------------------------------------------------
  test('3a. the projected body becomes the Map with no second read', async () => {
    const projected = (await inPage({ body: ODD_BODY })).body
    const page = fakePage(() => ({ ok: true, status: 200, via: 'in-page', body: projected }))
    const read = await nodesOn(page, PATHNAME, 5_000)
    expect(read).toMatchObject({ ok: true, how: 'in-page' })
    expect(pairsOf(mod.userTreeNodes(read.body))).toEqual(pairsOf(mod.userTreeNodes(ODD_BODY)))
    expect(page.calls()).toBe(1)
  }, 15_000)

  test('3b. the baseline read returns that Map and reports the path to its callback', async () => {
    const projected = (await inPage({ body: ODD_BODY })).body
    const page = fakePage(() => ({ ok: true, status: 200, via: 'in-page', body: projected }))
    let seen = null
    const map = await mod.readUserTreeOnPage(page, read => { seen = read })
    expect(pairsOf(map)).toEqual(pairsOf(mod.userTreeNodes(ODD_BODY)))
    expect(seen).toMatchObject({ status: 'ok', retry: false, how: 'in-page' })
    expect(page.calls()).toBe(1)
  }, 15_000)

  test('3c. a new-chat route reads nothing and is an empty Map', async () => {
    const page = {
      url: () => 'https://chatgpt.com/',
      evaluate: async () => { throw new Error('a new chat has no thread tree to read') },
    }
    let seen = null
    const map = await mod.readUserTreeOnPage(page, read => { seen = read })
    expect(map instanceof Map).toBe(true)
    expect(map.size).toBe(0)
    expect(seen).toMatchObject({ status: 'new-chat', how: 'no-thread' })
  }, 15_000)

  // 4. Consumer contract -------------------------------------------------------
  test('4a. the ceiling read accepts one new user turn through the in-page path', async () => {
    const baseline = new Map([['m:older', 'an older turn']])
    const projected = (await inPage({ body: userBody([['m:older', 'an older turn'], ['m:new', TEXT]]) })).body
    const page = fakePage(() => ({ ok: true, status: 200, via: 'in-page', body: projected }))
    const result = await mod.treeSendEvidence(page, TEXT, baseline)
    expect(result.accepted).toBe(true)
    expect(page.calls()).toBe(1)
  }, 15_000)

  test('4b. two new turns are still refused: the consumer contract is unchanged', async () => {
    const baseline = new Map([['m:older', 'an older turn']])
    const projected = (await inPage({
      body: userBody([['m:older', 'an older turn'], ['m:new', TEXT], ['m:other', 'unrelated']]),
    })).body
    const page = fakePage(() => ({ ok: true, status: 200, via: 'in-page', body: projected }))
    const result = await mod.treeSendEvidence(page, TEXT, baseline)
    expect(result.accepted).toBe(false)
  }, 15_000)
})
