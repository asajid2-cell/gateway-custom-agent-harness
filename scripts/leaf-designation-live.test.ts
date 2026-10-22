import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { connectLeafChannel } from '../src/utils/leafChannel.ts'
import { ensureCreatorMember } from '../src/utils/leafFamily.ts'

/**
 * A handoff must reach the processes that are already up.
 *
 * Conferring the head writes the designation where every process can read it,
 * but a member resolves the head from memory - the snapshot its host published
 * at launch - and only the process that performed the move republishes. So the
 * record moved and every live process went on acting for the old head until it
 * was restarted: the old head could still write the ledger and the new one was
 * refused.
 *
 * The proof is not that the file changed - that always worked. Three real
 * processes are started, each serving its own endpoint and holding a snapshot
 * that names the OLD head, and then the handoff is performed while they run.
 * Each one then asks a head-gated verb the normal way. No process is restarted
 * between the move and the ask, which is what makes this the property rather
 * than a file assertion.
 *
 * This process is the family's creator and the window managing it, so it is the
 * one conferring; the members are the three children.
 */
const ROOT = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const OLD_HEAD = '8b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e'
const NEW_HEAD = '9c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f'
const OTHER = 'ad4e5f6a-7b8c-4d9e-8f0a-2b3c4d5e6f70'

const member = (number: number, name: string, sessionId: string) => ({
  sessionId,
  parentSessionId: ROOT,
  number,
  name,
  transcriptPath: '',
  forkMessageId: null as string | null,
  createdAt: '2026-10-22T00:00:00.000Z',
  status: 'open',
})

const directory = await mkdtemp(join(tmpdir(), 'leaf-designation-live-'))
process.env.CLAUDE_CONFIG_DIR = directory
const savedInteractive = process.env.GATEWAY_INTERACTIVE_LEAF
// The session performing the move is the family's host, not one of its members.
delete process.env.GATEWAY_INTERACTIVE_LEAF

const members = [member(1, 'box', OLD_HEAD), member(2, 'harmonizer-suite', NEW_HEAD), member(3, 'reviewer', OTHER)]
const harness = join(directory, 'member.ts')

type Child = {
  self: string
  proc: ReturnType<typeof Bun.spawn>
  next: (timeoutMs?: number) => Promise<string>
  send: (line: string) => Promise<void>
  attachment?: Awaited<ReturnType<typeof connectLeafChannel>>
}
const children: Child[] = []

after(async () => {
  for (const child of children) {
    child.attachment?.channel.close()
    try { child.proc.kill() } catch { /* Already gone. */ }
  }
  if (savedInteractive === undefined) delete process.env.GATEWAY_INTERACTIVE_LEAF
  else process.env.GATEWAY_INTERACTIVE_LEAF = savedInteractive
  await rm(directory, { recursive: true, force: true })
})

function spawnMember(self: string): Child {
  const proc = Bun.spawn({
    cmd: [process.execPath, harness],
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: directory,
      // Every member the gateway starts carries this, and it is what makes the
      // process resolve its family from the snapshot it is handed.
      GATEWAY_INTERACTIVE_LEAF: '1',
      LEAF_REPO: process.cwd(),
      LEAF_SELF: self,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const queued: string[] = []
  const waiting: ((line: string) => void)[] = []
  let buffer = ''
  void (async () => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const listener = waiting.shift()
        if (listener) listener(line)
        else queued.push(line)
      }
    }
  })()
  const next = (timeoutMs = 30_000) => new Promise<string>((resolve, reject) => {
    const ready = queued.shift()
    if (ready !== undefined) return resolve(ready)
    const timer = setTimeout(() => reject(new Error('The member did not answer in time')), timeoutMs)
    waiting.push(line => { clearTimeout(timer); resolve(line) })
  })
  const send = async (line: string) => {
    const stdin = proc.stdin as import('bun').FileSink
    stdin.write(`${line}\n`)
    await stdin.flush()
  }
  const child: Child = { self, proc, next, send }
  children.push(child)
  return child
}

// Three processes start, are handed a snapshot, and are asked a question: the
// default per-test budget is shorter than three cold bun starts.
test('a handoff while the family is running reaches every live process, without a restart', { timeout: 120_000 }, async () => {
  const { switchSession } = await import('../src/bootstrap/state.ts')
  const { asSessionId } = await import('../src/types/ids.ts')
  const workspace = await import('../src/utils/leafWorkspace.ts')
  await mkdir(join(directory, 'leaf-families'), { recursive: true })
  const familyFile = join(directory, 'leaf-families', `${ROOT}.json`)
  await writeFile(familyFile, JSON.stringify({
    version: 1, rootSessionId: ROOT, nextNumber: 4,
    members: members.map(entry => ({ ...entry, transcriptPath: join(directory, `${entry.name}.jsonl`) })),
    returnedContextIds: [],
  }))
  // The creator's own row, numbered last: the family file is named after it and
  // every reader expects it to be among the members.
  await ensureCreatorMember(familyFile, ROOT, { name: 'original', transcriptPath: join(directory, 'original.jsonl') })
  await writeFile(harness, HARNESS)

  const started = [OLD_HEAD, NEW_HEAD, OTHER].map(spawnMember)

  // Each member is up on its own endpoint before anything moves, and each is
  // handed the roster its host had at launch - which names the OLD head.
  const snapshot = {
    rootSessionId: ROOT,
    patriarchName: 'box',
    patriarchSessionId: OLD_HEAD,
    formerPatriarchIds: [] as string[],
    driverScope: {} as Record<string, string[]>,
    ledgerWriterIds: [] as string[],
    matriarchSessionId: ROOT,
    matriarchName: 'original',
    members: members.map(entry => ({ member: entry, state: 'idle' as const })),
  }
  for (const child of started) {
    assert.equal(await child.next(), 'ready')
    const attachment = await connectLeafChannel(child.self)
    assert.ok(attachment, 'a member that is up can be reached')
    child.attachment = attachment
    attachment.channel.send({ type: 'leaf-snapshot', snapshot })
    // The member took the launch snapshot, and it names the old head - which is
    // the memory the handoff has to defeat.
    assert.equal(await child.next(), `stale ${OLD_HEAD}`)
  }

  // The family is running when this happens: three member processes are up.
  switchSession(asSessionId(ROOT))
  workspace.forgetLeafFamilyRoot()
  await workspace.restoreLeafWorkspace()
  assert.match(await workspace.conferPatriarch(NEW_HEAD), /now the family head/)

  for (const child of started) await child.send('go')
  const results = await Promise.all(started.map(async child => {
    const result = JSON.parse(await child.next()) as { pid: number; resolved: string; gate: string }
    return { self: child.self, spawnedPid: child.proc.pid, ...result }
  }))

  for (const result of results) {
    // The same process that held the old snapshot answered: nothing restarted.
    assert.equal(result.pid, result.spawnedPid, `${result.self} is the process that was already up`)
    assert.equal(result.resolved, NEW_HEAD, `${result.self} resolves the new head after the handoff, with no restart`)
  }
  const by = (self: string) => results.find(result => result.self === self)!
  assert.match(by(NEW_HEAD).gate, /^allowed/, 'the new head writes the ledger')
  assert.match(by(OTHER).gate, /^refused/, 'an ordinary member is still not the head')
  assert.match(by(OTHER).gate, new RegExp(NEW_HEAD), 'and the refusal names the new head')
  assert.match(by(OLD_HEAD).gate, /^refused/, 'the old head can no longer write the ledger')
  assert.match(by(OLD_HEAD).gate, new RegExp(NEW_HEAD), 'and the refusal names the new head, not the one it remembers')
  assert.doesNotMatch(by(OLD_HEAD).gate, new RegExp(OLD_HEAD), 'the old head is no longer the answer anywhere')
})

const HARNESS = String.raw`
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const repo = process.env.LEAF_REPO
const self = process.env.LEAF_SELF
const load = relative => import(pathToFileURL(join(repo, relative)).href)

const { switchSession } = await load('src/bootstrap/state.ts')
const workspace = await load('src/utils/leafWorkspace.ts')
const terminal = await load('src/utils/leafTerminal.ts')
const ledger = await load('src/utils/headLedger.ts')
const channel = await load('src/utils/leafChannel.ts')

switchSession(self)
workspace.forgetLeafFamilyRoot()

const served = channel.serveLeafChannel({
  sessionId: self,
  identify: () => ({ sessionId: self, pid: process.pid }),
  onMessage: message => {
    if (message.type !== 'leaf-snapshot') return
    terminal.adoptLeafSnapshot(message.snapshot)
    process.stdout.write('stale ' + workspace.getLeafPatriarchSessionId() + '\n')
  },
})
process.stdout.write('ready\n')
await new Promise(resolve => process.stdin.once('data', () => resolve()))

let gate
try { gate = 'allowed ' + await ledger.runHeadLedger({ subverb: 'note', text: 'handoff probe' }) }
catch (error) { gate = 'refused ' + error.message }
process.stdout.write(JSON.stringify({ pid: process.pid, resolved: workspace.getLeafPatriarchSessionId(), gate }) + '\n')
served.close()
process.exit(0)
`
