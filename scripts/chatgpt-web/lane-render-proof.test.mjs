/**
 * A new lane tab must render before any turn is typed into it.
 *
 * Measured 2026-11-07: a tab created while another bridge's turn was running
 * came up with no composer and no message; the send faulted pre-post and the
 * turn then cost a 90-190 s requeue. The proof reloads THAT tab once and never
 * opens a second one.
 */
import { describe, expect, test } from 'bun:test'
import os from 'node:os'
import path from 'node:path'

process.env.CHATGPT_PROFILE ||= path.join(os.tmpdir(), 'lane-render-fixture-profile')
const { ensureLaneRendered, laneRenderProof } = await import('./chatgpt.mjs')

/** A page whose `evaluate` walks a list of states and whose reload swaps lists. */
function fakePage({ states, afterReload = null, context = null }) {
  let index = 0
  const page = {
    reloads: 0,
    async evaluate() {
      const state = states[Math.min(index, states.length - 1)]
      index += 1
      return state
    },
    async reload() {
      page.reloads += 1
      if (afterReload) { states = afterReload; index = 0 }
    },
  }
  if (context) context.page = page
  return page
}

const NONE = { composer: false, messages: 0 }
const COMPOSER = { composer: true, messages: 0 }
const MESSAGES = { composer: false, messages: 3 }

describe('laneRenderProof', () => {
  test('a composer is proof on the first read', async () => {
    const page = fakePage({ states: [COMPOSER] })
    expect(await laneRenderProof(page, 100, 10)).toEqual({ proven: true, composer: true, messages: 0 })
  })

  test('messages alone are proof too (a thread with no composer yet)', async () => {
    const page = fakePage({ states: [MESSAGES] })
    expect((await laneRenderProof(page, 100, 10)).proven).toBe(true)
  })

  test('nothing rendered times out as unproven', async () => {
    const page = fakePage({ states: [NONE] })
    const proof = await laneRenderProof(page, 60, 10)
    expect(proof.proven).toBe(false)
    expect(proof.messages).toBe(0)
  })
})

describe('ensureLaneRendered', () => {
  test('a tab that renders nothing is reloaded once, then used, with no second tab', async () => {
    const context = { created: 0, async newPage() { this.created += 1; return this.page } }
    const page = fakePage({ states: [NONE, NONE, NONE], afterReload: [COMPOSER], context })
    context.page = page
    const proof = await ensureLaneRendered(page, { timeoutMs: 60, pollMs: 10 })
    expect(proof).toMatchObject({ proven: true, reloads: 1 })
    expect(page.reloads).toBe(1)
    // The proof never asks for a page; nothing here may create one.
    expect(context.created).toBe(0)
  })

  test('a tab that already rendered is never reloaded', async () => {
    const page = fakePage({ states: [COMPOSER] })
    expect(await ensureLaneRendered(page, { timeoutMs: 60, pollMs: 10 })).toMatchObject({ proven: true, reloads: 0 })
    expect(page.reloads).toBe(0)
  })

  test('a tab that still renders nothing after the reload is reported unproven', async () => {
    const page = fakePage({ states: [NONE], afterReload: [NONE] })
    const proof = await ensureLaneRendered(page, { timeoutMs: 40, pollMs: 10 })
    expect(proof.proven).toBe(false)
    expect(page.reloads).toBe(1)
  })
})
