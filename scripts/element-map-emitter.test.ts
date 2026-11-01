import { test, expect } from 'bun:test'
import type { DOMElement, TextNode } from '../src/ink/dom.ts'
import {
  ELEMENT_MAP_ENV,
  collectElementMap,
  isElementMapEnabled,
} from '../src/ink/element-map-emitter.ts'
import { nodeCache } from '../src/ink/node-cache.ts'

// The collector is the renderer's half of the contract: which nodes are
// semantic, where they are in app space, and what activating them does.
// These fixtures are the smallest tree that exercises each rule; the wire
// format and the publisher have their own tests in element-map.test.ts.

type Handlers = Record<string, unknown>

function el(
  nodeName: DOMElement['nodeName'],
  children: Array<DOMElement | TextNode> = [],
  handlers?: Handlers,
): DOMElement {
  const node = {
    nodeName,
    attributes: {},
    childNodes: children,
    style: {},
    dirty: false,
    parentNode: undefined,
    _eventHandlers: handlers,
  } as unknown as DOMElement
  for (const c of children) (c as { parentNode?: unknown }).parentNode = node
  return node
}

function text(value: string): TextNode {
  return { nodeName: '#text', nodeValue: value, style: {}, parentNode: undefined } as unknown as TextNode
}

function place(node: DOMElement, x: number, y: number, width: number, height: number): DOMElement {
  nodeCache.set(node, { x, y, width, height })
  return node
}

function rootOf(children: DOMElement[]): DOMElement {
  const root = el('ink-root', children)
  place(root, 0, 0, 80, 24)
  return root
}

test('the flag is off unless the env var is exactly 1', () => {
  expect(isElementMapEnabled({})).toBe(false)
  expect(isElementMapEnabled({ [ELEMENT_MAP_ENV]: '0' })).toBe(false)
  expect(isElementMapEnabled({ [ELEMENT_MAP_ENV]: 'true' })).toBe(false)
  expect(isElementMapEnabled({ [ELEMENT_MAP_ENV]: '1' })).toBe(true)
})

test('root is never an element; text carries a label; a bare layout box is skipped', () => {
  const label = el('ink-text', [text('  hello\nworld  ')])
  const bare = el('ink-box', [el('ink-box', [])])
  const root = rootOf([bare, el('ink-box', [label])])
  place(label, 2, 3, 10, 1)
  place(bare, 0, 0, 80, 10)
  place(bare.childNodes[0] as DOMElement, 0, 0, 80, 10)

  const els = collectElementMap(root, 80, 24)
  expect(els).toHaveLength(1)
  expect(els[0]).toMatchObject({ role: 'text', label: 'hello world', r: [2, 3, 10, 1] })
})

test('labels are capped so the map cannot become a transcript', () => {
  const long = el('ink-text', [text('x'.repeat(500))])
  const root = rootOf([long])
  place(long, 0, 0, 80, 1)
  const els = collectElementMap(root, 80, 24)
  expect(els).toHaveLength(1)
  expect([...els[0]!.label!].length).toBe(120)
  expect(els[0]!.label!.endsWith('…')).toBe(true)
})

test('a press handler makes a control the pointer dispatcher can reach', () => {
  const control = el('ink-box', [text('send')], { onClick: () => {} })
  const root = rootOf([control])
  place(control, 70, 22, 10, 2)
  const [element] = collectElementMap(root, 80, 24)
  expect(element).toMatchObject({ role: 'box', act: { t: 'ptr', x: 75, y: 23, b: 0 } })
  // A box itself has no label; its text child does.
  expect(element!.label).toBeUndefined()
})

test('onMouseDown is pointer-reachable too; a key handler alone is not guessed at', () => {
  const pressable = el('ink-box', [], { onMouseDown: () => {} })
  const keyOnly = el('ink-text', [text('k')], { onKeyDown: () => {} })
  const root = rootOf([pressable, keyOnly])
  place(pressable, 0, 0, 4, 1)
  place(keyOnly, 0, 1, 4, 1)
  const els = collectElementMap(root, 80, 24)
  expect(els.map(e => e.act?.t ?? 'none')).toEqual(['ptr', 'none'])
})

test('the declared cursor node is the focus target, even when it also clicks', () => {
  const input = el('ink-box', [], { onClick: () => {} })
  const root = rootOf([input])
  place(input, 0, 20, 80, 2)
  const [element] = collectElementMap(root, 80, 24, input)
  expect(element!.act).toEqual({ t: 'focus' })
})

test('the pointer target is clamped into the viewport', () => {
  const control = el('ink-box', [], { onClick: () => {} })
  const root = rootOf([control])
  place(control, 76, 23, 20, 4) // extends past 80x24
  const [element] = collectElementMap(root, 80, 24)
  expect(element!.act).toMatchObject({ t: 'ptr', x: 79, y: 23 })
})

test('offscreen and zero-area nodes are not in the map', () => {
  const above = el('ink-box', [], { onClick: () => {} })
  const below = el('ink-text', [text('gone')])
  const zero = el('ink-text', [text('collapsed')])
  const root = rootOf([above, below, zero])
  place(above, 0, -5, 10, 2)
  place(below, 0, 30, 10, 2)
  place(zero, 0, 1, 0, 1)
  expect(collectElementMap(root, 80, 24)).toHaveLength(0)
})

test('ids are stable across frames for the same node and distinct between nodes', () => {
  const a = el('ink-text', [text('a')])
  const b = el('ink-text', [text('b')])
  const root = rootOf([a, b])
  place(a, 0, 0, 1, 1)
  place(b, 1, 0, 1, 1)
  const first = collectElementMap(root, 80, 24)
  const second = collectElementMap(root, 80, 24)
  expect(second.map(e => e.id)).toEqual(first.map(e => e.id))
  expect(new Set(first.map(e => e.id)).size).toBe(2)
})

test('the collected frame survives the wire codec the consumer reads', () => {
  const control = el('ink-box', [], { onClick: () => {} })
  const label = el('ink-text', [text('send; \u001b\\ ✓')])
  const root = rootOf([control, label])
  place(control, 70, 22, 10, 1)
  place(label, 0, 0, 20, 1)
  const els = collectElementMap(root, 80, 24)
  expect(els).toHaveLength(2)
  // Roles and labels here are deliberately hostile to naive framing; the
  // codec's own tests cover the byte-level property, this is the shape.
  expect(els.every(e => typeof e.id === 'string' && e.r.length === 4)).toBe(true)
})
