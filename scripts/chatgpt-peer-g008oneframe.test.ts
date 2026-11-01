/**
 * G-008 companion: the child emits exactly ONE reply frame per accepted id.
 *
 * The incident could not say whether `r206`'s frame was never emitted or was
 * emitted and dropped. The shipped `serve` loop answers each valid request
 * exactly once: `.then(result => emit({...result, id}))` for a returned result
 * and `.catch(error => emit({ok:false, ..., id}))` for a throw, inside one
 * per-request chain step. This suite drives the vendored copy of that loop (the
 * byte-for-byte snapshot of `chatgpt.mjs`) as a real OS child, with no Chrome,
 * and counts frames per id for: a success, an error result, and a second
 * request that arrives while a slower one is outstanding.
 *
 * The throw branch needs a page (the page-free ops return their errors rather
 * than throw); it is covered here as an `ok:false` frame for an invalid op and
 * is otherwise a single `emit` in the same chain step, verified by reading.
 */
import { describe, expect, test } from 'bun:test'
import { createServer } from 'node:net'
import type { Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const THREAD_A = '11111111-1111-4111-8111-111111111111'
const DRIVER = join(import.meta.dir, 'chatgpt-peer', 'fixtures', 'chatgpt-driver.mjs')

type Frame = Record<string, unknown>

async function scratch(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-peer-g008-one-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

describe('G-008: one reply frame per accepted id', () => {
  test('success, error result, and a request queued behind an outstanding one each answer exactly once', async () => {
    const { dir, cleanup } = await scratch()
    // A loopback socket that accepts and never speaks: the deep status read
    // blocks on its own abort, giving a genuinely outstanding request with no
    // Chrome, no CDP and no page anywhere.
    const sockets = new Set<Socket>()
    const hole = createServer(socket => { sockets.add(socket) })
    await new Promise<void>(resolve => hole.listen(0, '127.0.0.1', resolve))
    const port = (hole.address() as { port: number }).port
    const frames: Frame[] = []
    const child = spawn(process.execPath, [DRIVER, 'serve'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: dir, USERPROFILE: dir, CHATGPT_PROFILE: join(dir, 'chrome-profile'), CHATGPT_CDP_PORT: String(port) },
    })
    const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)))
    createInterface({ input: child.stdout }).on('line', line => {
      const trimmed = line.trim()
      if (!trimmed) return
      try { frames.push(JSON.parse(trimmed) as Frame) } catch { /* not a frame */ }
    })
    child.stderr.resume()
    const send = (request: Record<string, unknown>): void => { child.stdin.write(`${JSON.stringify(request)}\n`) }
    const waitFor = async (predicate: () => boolean, ms = 20_000): Promise<void> => {
      const until = Date.now() + ms
      while (Date.now() < until) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
      throw new Error('timed out waiting for the shipped driver')
    }
    try {
      await waitFor(() => frames.some(frame => frame.event === 'ready'))

      // Success.
      send({ op: 'ping', id: 's1' })
      // Error results, no page needed.
      send({ op: 'status', threadId: 'not-a-uuid', id: 'e1' })
      send({ op: 'nonesuch-op', id: 'e2' })
      // An outstanding request and a second one behind it.
      send({ op: 'status', threadId: THREAD_A, deep: true, id: 'slow' })
      send({ op: 'ping', id: 'fast' })

      await waitFor(() => ['s1', 'e1', 'e2', 'slow', 'fast'].every(id => frames.some(frame => frame.id === id && !frame.event)))

      const replies = (id: string): Frame[] => frames.filter(frame => frame.id === id && !frame.event)
      for (const id of ['s1', 'e1', 'e2', 'slow', 'fast']) expect(replies(id).length).toBe(1)
      expect(replies('s1')[0]!.ok).toBe(true)
      expect(replies('e1')[0]!.ok).toBe(false)
      expect(replies('e2')[0]!.ok).toBe(false)
      // The second request arrived while the first was outstanding and was
      // answered after it - still exactly one frame, by its own id.
      const index = (id: string): number => frames.findIndex(frame => frame.id === id && !frame.event)
      expect(index('slow')).toBeLessThan(index('fast'))

      send({ op: 'quit' })
      expect(await exited).toBe(0)
    } finally {
      try { child.kill() } catch { /* already gone */ }
      for (const socket of sockets) socket.destroy()
      hole.close()
      await cleanup()
    }
  }, 30_000)
})
