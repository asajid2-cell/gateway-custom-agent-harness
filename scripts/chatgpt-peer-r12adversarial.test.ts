/**
 * Round 12, adversarial: the two PARTIAL findings from the round-11 verdict,
 * written from the verdict alone against gateway main at `8aa7c2d`.
 *
 *   F1  host, `scripts/chatgpt-peer.ts` (`attachTranscript` at :1077-1087 and
 *       `grantTranscript` at :4044-4067). `uploadDocument` already tells an
 *       AMBIGUOUS upload - one that may have landed - apart from a refusal: it
 *       audits `ATTACHMENT_UNPROVEN` and throws `UploadAmbiguous`. But
 *       `grantTranscript` catches EVERY error and returns `{ok:false}`, so the
 *       operator gets a 502 for a send that may already be on the page. A 502
 *       is an invitation to retry, and a retry is how the document lands twice.
 *       An ambiguous attach must answer 200 `{ok:true, landed:'unknown'}` with
 *       the unproven line, and must upload exactly once.
 *
 *       Guard: a GENUINE refusal (the page refuses the upload, no ambiguity)
 *       still fails - the fix must not turn every failure into success.
 *
 *   F2  driver, the vendored fixture (`submitTurn`). Two shapes:
 *
 *       (c) stale DOM / tree-silent. The DOM selector stops exposing any new
 *           user node and the thread-tree read is READABLE but UNCHANGED (a
 *           stale snapshot that does not yet carry the send). The old gate
 *           treated "the tree does not hold it" as proof the click did not
 *           submit and CLICKED AGAIN. But a stale tree cannot prove a click
 *           was swallowed, so the second click may post a second copy. Every
 *           send path must click Send at most once; this one must fail
 *           `ambiguous` (may have landed), never `not-posted`, never a retry.
 *
 *       (d) positive tree sighting. The DOM exposes no new user node, but the
 *           tree DOES - exactly one new user turn carrying our text. That is
 *           the degraded acceptance proof, and it must still accept: one
 *           click, one copy, no throw.
 *
 * The r11-F2 row in `chatgpt-peer-r11adversarial.test.ts` is the companion of
 * (d): a DOM-baselined send whose tree positively holds the text must also be
 * ACCEPTED, not reported as an ambiguous possible duplicate.
 *
 * Both rows (c) and (d) drive the exported `ask` against the VENDORED fixture
 * so the effect (click count, thrown reason, tree copies) is asserted on the
 * fake page, not a log string. The fixture is re-vendored from the live driver;
 * at this base it is still the pre-fix one.
 *
 * Self-contained: neighbouring lanes' test files register suites at import
 * time, so their harnesses cannot be imported without running them.
 */
import { describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ChatGptHost } from './chatgpt-peer.ts'
import type { DriverChild, DriverReply } from './chatgpt-peer/driver.js'
import { newBridgeState, newHostState, saveJson, type BridgeState } from './chatgpt-peer/state.ts'

const THREAD_A = '11111111-1111-4111-8111-111111111111'
const DRIVER_MODULE = pathToFileURL(join(import.meta.dir, 'chatgpt-peer', 'fixtures', 'chatgpt-driver.mjs')).href
/** The exact sentence `uploadDocument` writes when an upload may have landed. */
const ATTACHMENT_UNPROVEN = "may have landed (the driver's send result was ambiguous and nothing was retried)"

type Call = Record<string, unknown>
type CallOptions = { timeoutMs?: number; onAccepted?: (id: string) => void }

/** The frozen child protocol, in memory. One page, one active thread. */
class FakeDriver {
  readonly calls: Call[] = []
  threads = [{ id: THREAD_A, title: 'Existing work' }]
  observable = false
  /** Present only when the test wants the page to answer an attach send. */
  uploadOutcome: 'ambiguous' | 'refused' | null = null
  uploadSends = 0
  private readonly listeners = new Set<(event: Record<string, unknown>) => void>()
  private current: string | null = null
  readonly trees = new Map<string, { current: string; mapping: Record<string, any> }>()
  private clock = Math.floor(Date.now() / 1000)

  private treeOf(threadId: string): { current: string; mapping: Record<string, any> } {
    let tree = this.trees.get(threadId)
    if (!tree) {
      const root = `root-${threadId}`
      tree = { current: root, mapping: { [root]: { id: root, parent: null, children: [], message: null } } }
      this.trees.set(threadId, tree)
    }
    return tree
  }

  appendNode(threadId: string, role: 'user' | 'assistant', text: string, options: { id?: string; createTime?: number | null } = {}): string {
    const tree = this.treeOf(threadId)
    const id = options.id ?? randomUUID()
    tree.mapping[id] = {
      id,
      parent: tree.current,
      children: [],
      message: {
        id,
        author: { role },
        create_time: options.createTime === undefined ? this.clock++ : options.createTime,
        end_turn: role === 'assistant' ? true : null,
        status: 'finished_successfully',
        content: { content_type: 'text', parts: [text] },
      },
    }
    tree.mapping[tree.current]!.children.push(id)
    tree.current = id
    return id
  }

  onEvent(handler: (event: Record<string, unknown>) => void): () => void {
    this.listeners.add(handler)
    return () => { this.listeners.delete(handler) }
  }

  async call(request: Call, options: CallOptions = {}): Promise<DriverReply> {
    const op = String(request.op ?? '')
    if (op === 'ping') return { ok: true, op }
    this.calls.push({ ...request })
    if (op === 'threads') return { ok: true, op, threadId: this.current, threads: this.threads }
    if (op === 'use') {
      const threadId = String(request.threadId ?? '')
      this.current = threadId
      return { ok: true, op, threadId, url: `https://chatgpt.com/c/${threadId}`, adopted: true }
    }
    if (op === 'send') {
      // An attach send is the one the F1 rows drive: the page neither lands nor
      // refuses it cleanly. Every one is counted, so a retry shows as two.
      if (request.attach) {
        this.uploadSends += 1
        if (this.uploadOutcome === 'ambiguous') {
          return {
            ok: false,
            op,
            reason: 'ambiguous',
            error: 'the send may have landed: no new user turn appeared, so nothing was clicked again',
          }
        }
        if (this.uploadOutcome === 'refused') {
          return { ok: false, op, error: 'the page did not accept the attachment' }
        }
      }
      const threadId = this.current ?? THREAD_A
      this.appendNode(threadId, 'user', String(request.text ?? ''))
      if (options.onAccepted) options.onAccepted(String(request.id ?? ''))
      this.appendNode(threadId, 'assistant', 'answered on the page')
      return { ok: true, op, text: 'answered on the page', threadId, model: 'GPT-6', effort: 'High' }
    }
    if (op === 'read') return { ok: true, op, threadId: this.current, text: '', evidence: 'state-complete' }
    if (op === 'conversation' && this.observable) {
      const threadId = String(request.threadId ?? '')
      const tree = this.treeOf(threadId)
      return { ok: true, op, conversation: { current_node: tree.current, mapping: structuredClone(tree.mapping) } }
    }
    if (op === 'conversations' && this.observable) {
      const offset = Number(request.offset ?? 0)
      const limit = Number(request.limit ?? 100)
      return { ok: true, op, items: this.threads.slice(offset, offset + limit) }
    }
    if (op === 'status') {
      const asked = typeof request.threadId === 'string' ? request.threadId : ''
      return { ok: true, op, cost: 'push', threadId: asked, state: 'idle', phase: 'complete', ageMs: 1_000, at: new Date().toISOString() }
    }
    return { ok: false, op, error: `unknown op ${op}` }
  }

  async kill(): Promise<void> {}
  reopen(): void {}
}

async function scratch(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-peer-r12-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

const sessionsDir = (dir: string): string => join(dir, 'gateway-sessions')
const privateHome = (dir: string): string => join(dir, 'private')
const profileDir = (dir: string): string => join(dir, 'profile')

async function seedHost(dir: string, bridges: BridgeState[] = []): Promise<void> {
  await mkdir(join(dir, 'bridges'), { recursive: true })
  await saveJson(join(dir, 'peer.json'), newHostState({
    profile: profileDir(dir), healthPort: 0, idleUnloadMinutes: 0, instanceId: 'test',
  }))
  for (const bridge of bridges) await saveJson(join(dir, 'bridges', `${bridge.sessionId}.json`), bridge)
}

async function startHost(dir: string, driver: FakeDriver): Promise<ChatGptHost> {
  process.env.CLAUDE_CONFIG_DIR = dir
  const host = new ChatGptHost({
    home: dir,
    statePath: join(dir, 'peer.json'),
    driverPath: join(dir, 'unused.mjs'),
    profile: profileDir(dir),
    instanceId: 'test',
    healthPort: 0,
    idleUnloadMinutes: 0,
    number: 1,
    pollSeconds: 0,
    titlesEvery: 0,
    turnTimeoutMs: 900,
    waitPollMs: 20,
    directory: sessionsDir(dir),
    privateHome: privateHome(dir),
  }, driver as unknown as DriverChild)
  await host.start()
  return host
}

async function primedBridge(threadId = THREAD_A): Promise<BridgeState> {
  const bridge = newBridgeState({ sessionId: randomUUID(), name: 'alpha', threadId })
  bridge.primedThreadId = threadId
  bridge.primerSha256 = createHash('sha256')
    .update(await readFile(join(import.meta.dir, 'chatgpt-peer', 'primer.md'), 'utf8'), 'utf8')
    .digest('hex')
  return bridge
}

type AuditLine = { op: string; target: string | null; result: string; messageId?: string | null }
async function audits(dir: string): Promise<AuditLine[]> {
  const state = JSON.parse(await readFile(join(dir, 'peer.json'), 'utf8')) as { audit: AuditLine[] }
  return state.audit
}

/** The operator bearer token and the host's own session id, from its credentials file. */
async function credentials(dir: string): Promise<{ token: string; sessionId: string }> {
  const body = JSON.parse(await readFile(join(privateHome(dir), 'instances', 'test.json'), 'utf8')) as { token: string; sessionId: string }
  return { token: body.token, sessionId: body.sessionId }
}

/** Seed exactly one rollout for `sessionId`, where `resolveTranscript` looks. */
async function seedRollout(dir: string, sessionId: string, body = 'the transcript body\n'): Promise<void> {
  await mkdir(join(dir, 'projects', 'p'), { recursive: true })
  await writeFile(join(dir, 'projects', 'p', `${sessionId}.jsonl`), body, 'utf8')
}

async function operatorAttachTranscript(host: ChatGptHost, dir: string, peer: string): Promise<{
  status: number
  body: { ok?: boolean; op?: string; landed?: string; line?: string; error?: string }
}> {
  const { token } = await credentials(dir)
  const response = await fetch(`http://127.0.0.1:${host.port}/operator`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'attachTranscript', peer }),
  })
  return { status: response.status, body: await response.json() as { ok?: boolean; op?: string; landed?: string; line?: string; error?: string } }
}

// --------------------------------------------------------------------- F1
describe('R12-F1: an ambiguous transcript upload is unproven, not a failure', () => {
  test('ambiguity answers 200 landed unknown, audits the unproven line, and uploads once', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.uploadOutcome = 'ambiguous'
    const host = await startHost(dir, driver)
    try {
      const { sessionId } = await credentials(dir)
      await seedRollout(dir, sessionId)
      const { status, body } = await operatorAttachTranscript(host, dir, sessionId)
      // A 502 here is the defect: it invites the blind retry that posts twice.
      expect(status).toBe(200)
      expect(body.ok).toBe(true)
      expect(body.landed).toBe('unknown')
      expect(body.line).toBe(ATTACHMENT_UNPROVEN)
      expect(body.error).toBeUndefined()
      // Exactly one upload attempt: the ambiguous send is never re-issued.
      expect(driver.uploadSends).toBe(1)
      const unproven = (await audits(dir)).filter(line => line.result === ATTACHMENT_UNPROVEN)
      expect(unproven).toHaveLength(1)
      expect(unproven[0]!.op).toBe('attachment')
      expect(unproven[0]!.target?.endsWith('-transcript.txt')).toBe(true)
    } finally {
      await host.stop()
      await cleanup()
    }
  }, 40_000)

  test('guard: a genuine upload refusal still fails and is not reported as landed', async () => {
    const { dir, cleanup } = await scratch()
    const alpha = await primedBridge()
    await seedHost(dir, [alpha])
    const driver = new FakeDriver()
    driver.uploadOutcome = 'refused'
    const host = await startHost(dir, driver)
    try {
      const { sessionId } = await credentials(dir)
      await seedRollout(dir, sessionId)
      const { status, body } = await operatorAttachTranscript(host, dir, sessionId)
      expect(status).toBe(502)
      expect(body.ok).toBe(false)
      expect(String(body.error ?? '')).toContain('the page did not accept the attachment')
      expect(driver.uploadSends).toBe(1)
      expect((await audits(dir)).some(line => line.result === ATTACHMENT_UNPROVEN)).toBe(false)
    } finally {
      await host.stop()
      await cleanup()
    }
  }, 40_000)
})

// --------------------------------------------------------------------- F2
//
// The fake page answers only what `ask` reads on this path: the composer, the
// send control, the DOM user-node list, and the conversation tree fetched by
// `backendGetOn`. Clicks are counted on the page. Each click MAY append a user
// turn to the tree - in the stale shape it does not, because the tree read is
// an out-of-date snapshot.

type FakeNode = {
  innerText: string
  id: string
  getAttribute(name: string): string | null
  closest(selector: string): FakeNode | null
}

function domUserNode(id: string, text: string): FakeNode {
  const node: FakeNode = {
    innerText: text,
    id: `el-${id}`,
    getAttribute: (name: string) => (name === 'data-message-id' ? id : null),
    closest: () => node,
  }
  return node
}

/** >700 normalized chars, so the prompt-matching rules apply to the sent text. */
const r12Body = (): string =>
  Array.from({ length: 24 }, (_, index) => `r12 section ${index}: ${'k'.repeat(55)}`).join('\n\n')

type DriveResult = { clicks: number; copies: number; result: unknown; thrown: any }

/**
 * Drive the vendored `ask` against a fake page and report what the page saw.
 *
 * `domUsers` is the DOM user-node list at baseline AND after the send (the
 * stale shape: the selector never exposes a new node). `treeOnClick` decides
 * whether a submitted click appears in the thread tree (positive sighting) or
 * whether the tree read is a stale snapshot that never changes.
 */
async function driveAsk(options: {
  dir: string
  sentText: string
  domUsers: FakeNode[]
  treeOnClick: boolean
}): Promise<DriveResult> {
  const sentText = options.sentText
  let clicks = 0
  const treeTexts: string[] = []

  const send = {
    isVisible: async () => true,
    isDisabled: async () => false,
    getAttribute: async (_name: string) => null,
    click: async () => {
      clicks += 1
      if (options.treeOnClick) treeTexts.push(sentText)
    },
  }
  const composer = {
    innerText: '',
    textContent: '',
    isVisible: async () => true,
    click: async () => {},
    fill: async (value: string) => { composer.innerText = value; composer.textContent = value },
    evaluate: async (fn: (el: unknown) => unknown) => fn(composer),
  }
  const assistantDummy = { innerText: async () => '' }

  const locatorOf = (nodes: unknown[]) => ({
    count: async () => nodes.length,
    nth: (index: number) => nodes[index],
    last: () => nodes[nodes.length - 1] ?? assistantDummy,
  })

  const page = {
    url: () => `https://chatgpt.com/c/${THREAD_A}`,
    locator: (selector: string) => {
      if (/prompt-textarea|contenteditable/i.test(selector)) return locatorOf([composer])
      if (/send-button|Send/i.test(selector)) return locatorOf([send])
      if (/data-message-author-role="user"/i.test(selector)) return locatorOf(options.domUsers)
      return locatorOf([])
    },
    keyboard: {
      press: async () => {},
      insertText: async () => {},
    },
    evaluate: async (fn: (arg?: unknown) => unknown, arg?: unknown) => fn(arg),
  }

  // The conversation tree `readUserTreeOnPage` fetches. In the stale shape the
  // body never changes, so a post-click read is byte-identical to the baseline.
  const treeBody = () => {
    let seq = 0
    const mapping: Record<string, unknown> = {
      root: { id: 'root', parent: null, children: [], message: null },
    }
    const add = (role: string, text: string) => {
      const id = `node${seq++}`
      mapping[id] = {
        id, parent: 'root', children: [],
        message: { id, author: { role }, create_time: null, content: { content_type: 'text', parts: [text] } },
      }
    }
    add('user', 'an earlier question')
    add('assistant', 'an earlier answer')
    for (const text of treeTexts) add('user', text)
    return { current_node: 'root', mapping }
  }

  const fakeDocument = {
    querySelectorAll: (selector: string) => (/data-message-author-role/.test(selector) ? options.domUsers : []),
    querySelector: (_selector: string) => null,
  }
  const realFetch = globalThis.fetch
  const realDocument = (globalThis as any).document
  const realGetComputedStyle = (globalThis as any).getComputedStyle
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    if (url.includes('/api/auth/session')) return { ok: true, status: 200, json: async () => ({ accessToken: 'test-token' }) }
    if (url.includes('/backend-api/conversation/')) return { ok: true, status: 200, json: async () => treeBody() }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
  ;(globalThis as any).document = fakeDocument
  ;(globalThis as any).getComputedStyle = () => ({ visibility: 'visible', display: 'block', opacity: '1' })

  const priorProfile = process.env.CHATGPT_PROFILE
  const priorHome = process.env.USERPROFILE
  const priorAcceptance = process.env.CHATGPT_ACCEPTANCE_MS
  process.env.CHATGPT_PROFILE = join(options.dir, 'driver-profile')
  process.env.USERPROFILE = join(options.dir, 'driver-home')
  // Read once at module load; the poll interval is 250 ms, so 300 ms is one or
  // two DOM reads - short enough to keep the test fast.
  process.env.CHATGPT_ACCEPTANCE_MS = '300'

  let result: unknown = null
  let thrown: any = null
  try {
    const driver = await import(DRIVER_MODULE) as { ask: (page: any, text: string, opts?: Record<string, unknown>) => Promise<unknown> }
    try {
      result = await driver.ask(page, sentText, { wait: false })
    } catch (error) {
      thrown = error
    }
  } finally {
    globalThis.fetch = realFetch
    ;(globalThis as any).document = realDocument
    ;(globalThis as any).getComputedStyle = realGetComputedStyle
    if (priorProfile === undefined) delete process.env.CHATGPT_PROFILE
    else process.env.CHATGPT_PROFILE = priorProfile
    if (priorHome === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = priorHome
    if (priorAcceptance === undefined) delete process.env.CHATGPT_ACCEPTANCE_MS
    else process.env.CHATGPT_ACCEPTANCE_MS = priorAcceptance
  }

  return { clicks, copies: treeTexts.filter(text => text === sentText).length, result, thrown }
}

describe('R12-F2: every send path clicks Send at most once', () => {
  test('a stale DOM window with an unchanged readable tree clicks once and reports ambiguous', async () => {
    const { dir, cleanup } = await scratch()
    const sentText = r12Body()
    try {
      const driven = await driveAsk({
        dir,
        sentText,
        // The DOM exposes the baseline turns and never the new one - a readable
        // window with zero new nodes, exactly like a swallowed click.
        domUsers: [domUserNode('u1', 'an earlier question'), domUserNode('u2', 'an earlier answer')],
        // ...and the tree read is a STALE snapshot: it never carries the send.
        treeOnClick: false,
      })
      // Asserted first so a base run reports the extra click.
      expect(driven.clicks).toBe(1)
      expect(driven.copies).toBe(0)
      // An unchanged tree cannot prove the click did not submit: the send may
      // have landed, so the turn must be `ambiguous`, never `not-posted`.
      expect(driven.thrown).not.toBeNull()
      expect(driven.thrown?.reason).toBe('ambiguous')
      expect(String(driven.thrown?.message ?? '')).not.toContain('not-posted')
      expect(String(driven.thrown?.message ?? '')).not.toContain('never left the composer')
      expect(driven.result).toBeNull()
    } finally {
      await cleanup()
    }
  }, 60_000)

  test('a positive tree sighting still accepts: one click, one copy, no throw', async () => {
    const { dir, cleanup } = await scratch()
    const sentText = r12Body()
    try {
      const driven = await driveAsk({
        dir,
        sentText,
        // The DOM exposes no user nodes at all; the tree is the only evidence.
        domUsers: [],
        // The click lands in the tree: exactly one new user turn carrying ours.
        treeOnClick: true,
      })
      expect(driven.clicks).toBe(1)
      expect(driven.copies).toBe(1)
      // The degraded acceptance proof: a new tree turn carrying the sent text.
      expect(driven.thrown).toBeNull()
      expect(driven.result).not.toBeNull()
      expect((driven.result as { state?: string }).state).toBe('generating')
    } finally {
      await cleanup()
    }
  }, 60_000)
})
