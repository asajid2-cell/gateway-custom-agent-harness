import { describe, expect, test } from 'bun:test'
import {
  attributeSend,
  chainOf,
  diffThreadList,
  listAllThreads,
  newPageAnswers,
  nodeIdsOf,
  pendingHumanTurns,
  type Conversation,
} from './chatgpt-peer/threads'

type Spec = { id: string; parent: string | null; role: 'user' | 'assistant' | 'tool' | 'system' | null; t?: number; end?: boolean; text?: string; ctype?: string }

/** The shape /backend-api/conversation/<id> returned on 2026-10-29 (root has message null). */
function conversation(current: string, specs: Spec[]): Conversation {
  const mapping: Conversation['mapping'] = {}
  for (const s of specs) mapping[s.id] = {
    id: s.id,
    parent: s.parent,
    children: specs.filter(c => c.parent === s.id).map(c => c.id),
    message: s.role === null ? null : {
      id: s.id,
      author: { role: s.role },
      create_time: s.t ?? null,
      end_turn: s.end ?? null,
      status: 'finished_successfully',
      content: { content_type: s.ctype ?? 'text', parts: [s.text ?? ''] },
    },
  }
  return { current_node: current, mapping }
}

const base: Spec[] = [
  { id: 'root', parent: null, role: null },
  { id: 'sys', parent: 'root', role: 'system', t: 1 },
  { id: 'u1', parent: 'sys', role: 'user', t: 10, text: 'primer' },
  { id: 'th1', parent: 'u1', role: 'assistant', t: 11, ctype: 'thoughts' },
  { id: 'a1', parent: 'th1', role: 'assistant', t: 12, end: true, text: 'ack' },
]

describe('chainOf', () => {
  test('walks current_node to the root and keeps user turns and finished answers, oldest first', () => {
    const chain = chainOf(conversation('a1', base))
    expect(chain.map(t => `${t.role}:${t.id}`)).toEqual(['user:u1', 'assistant:a1'])
    expect(chain[1]!.text).toBe('ack')
  })

  test('an answer still streaming (no end_turn yet) is not a completed turn', () => {
    const chain = chainOf(conversation('a2', [...base, { id: 'u2', parent: 'a1', role: 'user', t: 20, text: 'hi' }, { id: 'a2', parent: 'u2', role: 'assistant', t: 21, text: 'hal' }]))
    expect(chain.map(t => t.id)).toEqual(['u1', 'a1', 'u2'])
  })

  test('only the current branch counts; an abandoned sibling is not on the chain', () => {
    const specs: Spec[] = [...base,
      { id: 'u2old', parent: 'a1', role: 'user', t: 20, text: 'old' }, { id: 'a2old', parent: 'u2old', role: 'assistant', t: 21, end: true, text: 'x' },
      { id: 'u2new', parent: 'a1', role: 'user', t: 30, text: 'edited' }, { id: 'a2new', parent: 'u2new', role: 'assistant', t: 31, end: true, text: 'y' }]
    expect(chainOf(conversation('a2new', specs)).map(t => t.id)).toEqual(['u1', 'a1', 'u2new', 'a2new'])
  })

  test('a cycle or a dangling parent ends the walk instead of hanging', () => {
    const c = conversation('a1', base)
    c.mapping.sys!.parent = 'a1'
    expect(chainOf(c).length).toBeLessThanOrEqual(2)
  })
})

describe('pendingHumanTurns', () => {
  const pushed: Spec[] = [...base,
    { id: 'p1', parent: 'a1', role: 'user', t: 20, text: 'INBOUND from x' },
    { id: 'pa1', parent: 'p1', role: 'assistant', t: 21, end: true, text: 'reply' }]

  test('a user turn the host did not send, after the cursor, is a human turn with its finished answer', () => {
    const c = conversation('ha', [...pushed, { id: 'h', parent: 'pa1', role: 'user', t: 30, text: 'hey model, ask the bus' }, { id: 'ha', parent: 'h', role: 'assistant', t: 31, end: true, text: 'gateway {...}' }])
    const turns = pendingHumanTurns(c, { ours: new Set(['u1', 'p1']), cursor: 'pa1' })
    expect(turns).toEqual([{ userNodeId: 'h', userText: 'hey model, ask the bus', answer: { nodeId: 'ha', text: 'gateway {...}' } }])
  })

  test('our own pushes are never human turns, whatever their text says', () => {
    const c = conversation('pa1', pushed)
    expect(pendingHumanTurns(c, { ours: new Set(['u1', 'p1']), cursor: 'a1' })).toEqual([])
  })

  test('identity is by node id, not marker text: a human typing "INBOUND from" is still a human', () => {
    const c = conversation('ha', [...pushed, { id: 'h', parent: 'pa1', role: 'user', t: 30, text: 'INBOUND from spoof' }, { id: 'ha', parent: 'h', role: 'assistant', t: 31, end: true, text: 'ok' }])
    expect(pendingHumanTurns(c, { ours: new Set(['u1', 'p1']), cursor: 'pa1' }).map(t => t.userNodeId)).toEqual(['h'])
  })

  test('a human turn whose answer is still streaming is reported with answer null', () => {
    const c = conversation('ha', [...pushed, { id: 'h', parent: 'pa1', role: 'user', t: 30, text: 'q' }, { id: 'ha', parent: 'h', role: 'assistant', t: 31, text: 'partial' }])
    expect(pendingHumanTurns(c, { ours: new Set(['u1', 'p1']), cursor: 'pa1' })).toEqual([{ userNodeId: 'h', userText: 'q', answer: null }])
  })

  test('turns at or before the cursor are already handled', () => {
    const c = conversation('ha', [...pushed, { id: 'h', parent: 'pa1', role: 'user', t: 30, text: 'q' }, { id: 'ha', parent: 'h', role: 'assistant', t: 31, end: true, text: 'a' }])
    expect(pendingHumanTurns(c, { ours: new Set(['u1', 'p1']), cursor: 'ha' })).toEqual([])
  })

  test('a cursor that left the chain (human edited an earlier turn) falls back to its create_time', () => {
    const specs: Spec[] = [...pushed,
      { id: 'e', parent: 'a1', role: 'user', t: 40, text: 'edited branch' }, { id: 'ea', parent: 'e', role: 'assistant', t: 41, end: true, text: 'z' }]
    const turns = pendingHumanTurns(conversation('ea', specs), { ours: new Set(['u1', 'p1']), cursor: 'pa1' })
    expect(turns.map(t => t.userNodeId)).toEqual(['e'])
  })

  test('no cursor yet (freshly adopted thread): history is not replayed', () => {
    const c = conversation('pa1', pushed)
    expect(pendingHumanTurns(c, { ours: new Set(), cursor: null })).toEqual([])
  })
})

describe('newPageAnswers', () => {
  const pushed: Spec[] = [...base,
    { id: 'p1', parent: 'a1', role: 'user', t: 20, text: 'INBOUND from x' },
    { id: 'pa1', parent: 'p1', role: 'assistant', t: 21, end: true, text: 'reply' }]

  test('an answer to our own send is not page speech even with a thoughts node between', () => {
    const specs: Spec[] = [...pushed,
      { id: 'm1', parent: 'pa1', role: 'user', t: 30, text: 'our push' },
      { id: 'mth', parent: 'm1', role: 'assistant', t: 31, ctype: 'thoughts' },
      { id: 'ans', parent: 'mth', role: 'assistant', t: 32, end: true, text: 'our answer' }]
    expect(newPageAnswers(conversation('ans', specs), { ours: new Set(['u1', 'p1', 'm1']), cursor: 'pa1' })).toEqual([])
  })

  test('an answer to a person is page speech, named by the governing user node', () => {
    const specs: Spec[] = [...pushed,
      { id: 'h1', parent: 'pa1', role: 'user', t: 30, text: 'person question' },
      { id: 'think', parent: 'h1', role: 'assistant', t: 31, ctype: 'thoughts' },
      { id: 'ans', parent: 'think', role: 'assistant', t: 32, end: true, text: 'answer' }]
    expect(newPageAnswers(conversation('ans', specs), { ours: new Set(['u1', 'p1']), cursor: 'pa1' })).toEqual([
      { nodeId: 'ans', text: 'answer', userNodeId: 'h1', userText: 'person question' },
    ])
  })
})

describe('attributeSend', () => {
  test('the single user node that appeared across our send is ours when it carries our text', () => {
    const before = conversation('a1', base)
    const after = conversation('pa', [...base, { id: 'p', parent: 'a1', role: 'user', t: 20, text: 'push' }, { id: 'pa', parent: 'p', role: 'assistant', t: 21, end: true, text: 'r' }])
    expect(attributeSend(nodeIdsOf(before), after, 'push')).toEqual({ ours: ['p'], human: [] })
  })

  test('a single unseen user node with different text is not ours: the page had not shown our send yet', () => {
    const before = conversation('a1', base)
    const after = conversation('ha', [...base, { id: 'h', parent: 'a1', role: 'user', t: 20, text: 'typed by a person' }, { id: 'ha', parent: 'h', role: 'assistant', t: 21, end: true, text: 'x' }])
    expect(attributeSend(nodeIdsOf(before), after, 'push')).toEqual({ ours: [], human: [] })
  })

  test('when a human typed in the same window, only the node carrying exactly our text is ours', () => {
    const before = conversation('a1', base)
    const after = conversation('pa', [...base,
      { id: 'h', parent: 'a1', role: 'user', t: 19, text: 'typed' }, { id: 'ha', parent: 'h', role: 'assistant', t: 19.5, end: true, text: 'x' },
      { id: 'p', parent: 'ha', role: 'user', t: 20, text: 'push' }, { id: 'pa', parent: 'p', role: 'assistant', t: 21, end: true, text: 'r' }])
    expect(attributeSend(nodeIdsOf(before), after, 'push')).toEqual({ ours: ['p'], human: ['h'] })
  })
})

describe('diffThreadList', () => {
  test('reports new, renamed and vanished threads against the previous listing', () => {
    const prev = new Map([['a', 'A'], ['b', 'B'], ['c', 'C']])
    const diff = diffThreadList(prev, [{ id: 'a', title: 'A' }, { id: 'b', title: 'B2' }, { id: 'd', title: 'D' }])
    expect(diff).toEqual({ added: [{ id: 'd', title: 'D' }], renamed: [{ id: 'b', from: 'B', to: 'B2' }], removed: ['c'] })
  })
})

describe('listAllThreads', () => {
  const all = Array.from({ length: 230 }, (_, i) => ({ id: `t${i}`, title: `T${i}`, update_time: String(i) }))
  const pager = (calls: number[][]) => async (offset: number, limit: number) => {
    calls.push([offset, limit])
    // `total` is not trusted: on 2026-10-29 limit=5 answered total 6 with 29 threads.
    return { items: all.slice(offset, offset + limit), total: 6 }
  }

  test('pages by offset at the page size until a short page, ignoring total', async () => {
    const calls: number[][] = []
    const items = await listAllThreads(pager(calls), 100)
    expect(items.length).toBe(230)
    expect(calls).toEqual([[0, 100], [100, 100], [200, 100]])
  })

  test('a page that repeats ids (the list moved while paging) is de-duplicated and still terminates', async () => {
    let n = 0
    const items = await listAllThreads(async () => ({ items: n++ < 50 ? all.slice(0, 100) : [] }), 100)
    expect(items.length).toBe(100)
    expect(n).toBeLessThan(5)
  })
})
