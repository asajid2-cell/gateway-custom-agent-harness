/**
 * Collects the semantic map of one rendered frame from the DOM tree.
 *
 * The wire format, the publisher (generation/heartbeat/refusal rules) and the
 * consumer-side stripper live in `element-map.ts`. This module only answers
 * the renderer's half of the question: given the root node and the layout
 * cache the render pass just populated, what are the elements, where are they
 * in app space, and what does activating one do.
 *
 * Rects come from `nodeCache`, which `renderNodeToOutput` fills with
 * app-space (0-based, scroll-translated) rects for exactly the nodes that
 * rendered this frame. A node absent from the cache did not paint, so it is
 * not in the map.
 *
 * `act` is derived from the element's actual handler, never from its role:
 * a press handler that the click dispatcher would reach is `ptr`; the node
 * the cursor declaration names is the text-entry target and is `focus`.
 * A keyboard-only handler carries no discoverable activation bytes, so it is
 * published as display-only rather than guessed at.
 */

import type { EventHandlerProps } from './events/event-handlers.js'
import type { MapAction, MapElement } from './element-map.js'
import type { DOMElement } from './dom.js'
import { nodeCache } from './node-cache.js'
import squashTextNodes from './squash-text-nodes.js'

/** Opt-in. Default off: the sequence is invisible to terminals and costs bytes. */
export const ELEMENT_MAP_ENV = 'CLAUDE_CODE_TERMINAL_ELEMENT_MAP'

export function isElementMapEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[ELEMENT_MAP_ENV] === '1'
}

/**
 * Host-component vocabulary. Consumers tolerate roles they do not know, so
 * this stays mechanical: the role says what the node is, and `act` says
 * whether it can be activated. `ink-root` is never emitted.
 */
const ROLE_BY_HOST: Record<string, string> = {
  'ink-box': 'box',
  'ink-text': 'text',
  'ink-virtual-text': 'text',
  'ink-link': 'link',
  'ink-progress': 'progress',
  'ink-raw-ansi': 'raw',
}

/** Longest label kept; a map is geometry, not a transcript. */
const LABEL_MAX = 120

/**
 * Ids are stable for as long as the DOM node lives, which is what the
 * consumer keys overlays on. A remount is a new widget and gets a new id.
 */
const ids = new WeakMap<DOMElement, string>()
let nextId = 0

function idFor(node: DOMElement): string {
  let id = ids.get(node)
  if (id === undefined) {
    nextId += 1
    id = `e${nextId}`
    ids.set(node, id)
  }
  return id
}

/** Visible text of a text-bearing node, collapsed to one line and capped. */
function labelFor(node: DOMElement): string | undefined {
  if (
    node.nodeName !== 'ink-text' &&
    node.nodeName !== 'ink-virtual-text' &&
    node.nodeName !== 'ink-link'
  ) {
    return undefined
  }
  const raw = squashTextNodes(node)
  if (!raw) return undefined
  // Control characters never belong in a label; keep only visible spacing.
  const flat = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  return flat.length > LABEL_MAX ? `${flat.slice(0, LABEL_MAX - 1)}…` : flat
}

/**
 * What activating this element does, per its handlers. `hit-test`'s
 * pointerTarget accepts onClick or onMouseDown, so those are the press-
 * reachable set; anything else is not addressable by a synthetic press.
 */
function actionFor(
  node: DOMElement,
  focusNode: DOMElement | null,
  cols: number,
  rows: number,
  rect: { x: number; y: number; width: number; height: number },
): MapAction | undefined {
  if (node === focusNode) return { t: 'focus' }
  const handlers = node._eventHandlers as EventHandlerProps | undefined
  if (handlers?.onClick || handlers?.onMouseDown) {
    // Floor, not round: hit-test treats a rect as half-open [x, x+w) x [y, y+h),
    // so rounding a half-cell up puts the press on the next row (or column) for
    // any one-cell-tall control - a whole class of buttons in this UI. Floor of
    // the centre is inside the rect for every w,h >= 1, so it is never worse.
    const x = Math.min(Math.max(Math.floor(rect.x + rect.width / 2), 0), Math.max(cols - 1, 0))
    const y = Math.min(Math.max(Math.floor(rect.y + rect.height / 2), 0), Math.max(rows - 1, 0))
    return { t: 'ptr', x, y, b: 0 }
  }
  return undefined
}

function intersectsViewport(
  rect: { x: number; y: number; width: number; height: number },
  cols: number,
  rows: number,
): boolean {
  if (rect.width <= 0 || rect.height <= 0) return false
  return rect.x < cols && rect.x + rect.width > 0 && rect.y < rows && rect.y + rect.height > 0
}

/**
 * Walk the rendered tree in paint order and return the frame's elements.
 *
 * Only two kinds of node carry semantics a consumer can act on: a node that
 * can be activated (a control) and a node that renders text (a label). A
 * layout box with neither is structure, not semantics, and is skipped so a
 * deep tree does not spend the 32 KB payload on empty rectangles.
 */
export function collectElementMap(
  root: DOMElement,
  cols: number,
  rows: number,
  focusNode: DOMElement | null = null,
): MapElement[] {
  const elements: MapElement[] = []

  const walk = (node: DOMElement): void => {
    if (node.nodeName !== 'ink-root') {
      const rect = nodeCache.get(node)
      if (rect && intersectsViewport(rect, cols, rows)) {
        const label = labelFor(node)
        const act = actionFor(node, focusNode, cols, rows, rect)
        if (label !== undefined || act !== undefined) {
          const element: MapElement = {
            id: idFor(node),
            role: ROLE_BY_HOST[node.nodeName] ?? node.nodeName,
            r: [
              Math.round(rect.x),
              Math.round(rect.y),
              Math.round(rect.width),
              Math.round(rect.height),
            ],
          }
          if (label !== undefined) element.label = label
          if (act !== undefined) element.act = act
          elements.push(element)
        }
      }
    }
    for (const child of node.childNodes) {
      if (child.nodeName !== '#text') walk(child)
    }
  }

  walk(root)
  return elements
}
