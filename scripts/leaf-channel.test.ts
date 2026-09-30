import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { createConnection, type Socket } from 'node:net'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { connectLeafChannel, leafEndpoint, LeafTakenError, serveLeafChannel, type LeafChannel } from '../src/utils/leafChannel.ts'
import { LeafProcess } from '../src/utils/leafProcess.ts'
import { getCwd } from '../src/utils/cwd.ts'

/** Wait for a member to catch up with something the session just did. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail(`the member never ${what}`)
}

/**
 * A member of a family as the leaf end serves it: it names itself, it takes
 * messages from whoever is watching, it answers the handshake, and it notices
 * when nobody is watching any more.
 */
function member() {
  const sessionId = randomUUID()
  const seen: any[] = []
  const counts = { attaches: 0, detaches: 0 }
  let watcher: LeafChannel | undefined
  const server = serveLeafChannel({
    sessionId,
    identify: () => ({ sessionId, pid: process.pid, label: 'Test member', state: 'idle' }),
    onAttach: attached => { counts.attaches++; watcher = attached },
    onDetach: () => { counts.detaches++; watcher = undefined },
    onMessage: message => {
      seen.push(message)
      if (message?.type === 'leaf-control') watcher?.send({ type: 'leaf-control-response', id: message.id, ok: true })
    },
  })
  return {
    sessionId, seen, counts,
    controls: () => seen.filter(message => message?.type === 'leaf-control'),
    close: () => server.close(),
  }
}

/** Read the newline-delimited frames a raw client receives. */
function frames(socket: Socket) {
  const received: any[] = []
  const waiters: { type: string; resolve: (value: any) => void }[] = []
  let buffer = ''
  socket.on('data', chunk => {
    buffer += chunk.toString('utf8')
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line.trim()) continue
      const message = JSON.parse(line)
      received.push(message)
      for (let index = waiters.length - 1; index >= 0; index--) {
        if (waiters[index]!.type !== message.type) continue
        waiters.splice(index, 1)[0]!.resolve(message)
      }
    }
  })
  const waitFor = (type: string) => new Promise<any>(resolve => {
    const already = received.find(message => message.type === type)
    if (already) return resolve(already)
    waiters.push({ type, resolve })
  })
  return { waitFor }
}

test('a member outlives the session watching it, and the next session picks it up', async () => {
  const leaf = member()
  try {
    const first = await connectLeafChannel(leaf.sessionId)
    assert.ok(first, 'a member that is listening must be reachable')
    assert.equal(first.identity.label, 'Test member')
    assert.equal(leaf.counts.attaches, 1)

    first.channel.send({ type: 'leaf-input', data: 'FROM_THE_FIRST_SESSION' })
    await until(() => leaf.seen.length === 1, 'took the message')
    assert.deepEqual(leaf.seen, [{ type: 'leaf-input', data: 'FROM_THE_FIRST_SESSION' }])

    // The session watching goes away. This is the whole point of the endpoint:
    // the member is not its child, so the watcher leaving is a detach and the
    // member keeps running for whoever opens it next.
    first.channel.close()
    await until(() => leaf.counts.detaches === 1, 'noticed that nobody is watching')

    const second = await connectLeafChannel(leaf.sessionId)
    assert.ok(second, 'the member must still be there for the next session')
    assert.equal(leaf.counts.attaches, 2)
    second.channel.send({ type: 'leaf-input', data: 'FROM_THE_SECOND_SESSION' })
    await until(() => leaf.seen.length === 2, 'took the second session\'s message')
    assert.deepEqual(leaf.seen.at(-1), { type: 'leaf-input', data: 'FROM_THE_SECOND_SESSION' })
    second.channel.close()
  } finally { leaf.close() }
})

test('a second session is refused rather than sharing the member input', async () => {
  const leaf = member()
  try {
    const owner = await connectLeafChannel(leaf.sessionId)
    assert.ok(owner)
    // Two sessions driving one REPL would interleave keystrokes into a single
    // conversation, so this is a refusal and not a queue.
    await assert.rejects(connectLeafChannel(leaf.sessionId), LeafTakenError)
    assert.equal(leaf.counts.attaches, 1, 'the refusal must not displace the session that owns it')
    assert.equal(leaf.counts.detaches, 0)

    owner.channel.close()
    await until(() => leaf.counts.detaches === 1, 'noticed the owner leaving')
  } finally { leaf.close() }
})

test('no member means nothing to open, not a fault', async () => {
  // The ordinary case: nobody has opened this session yet. Reporting it as an
  // error would make "start one" look like a failure recovery.
  assert.equal(await connectLeafChannel(randomUUID()), undefined)
})

test('a message is acted on only when it is whole, and only from the owner', async () => {
  const leaf = member()
  let socket: Socket | undefined
  const quiet = () => new Promise(resolve => setTimeout(resolve, 60))
  try {
    socket = createConnection(leafEndpoint(leaf.sessionId))
    const received = frames(socket)
    const identity = await received.waitFor('leaf-identity')
    assert.equal(identity.sessionId, leaf.sessionId)

    // Below the handshake, a socket may only ask who the member is. Anything
    // else would let a client that skipped it drive a REPL it does not own.
    socket.write(`${JSON.stringify({ type: 'leaf-input', data: 'NOT_THE_OWNER' })}\n`)
    await quiet()
    assert.deepEqual(leaf.seen, [], 'an unattached socket must not reach the member')

    socket.write(`${JSON.stringify({ type: 'leaf-attach' })}\n`)
    await received.waitFor('leaf-attached')

    // Half a frame is not a message: a split can fall anywhere, including
    // inside one, so nothing may be acted on until the newline arrives.
    socket.write('{"type":"leaf-input","data":"SPLIT_ACROSS_CHUNKS"')
    await quiet()
    assert.deepEqual(leaf.seen, [], 'an incomplete frame must not be acted on')
    socket.write('}\n')
    await until(() => leaf.seen.length === 1, 'took the completed frame')
    assert.deepEqual(leaf.seen, [{ type: 'leaf-input', data: 'SPLIT_ACROSS_CHUNKS' }])

    // And one frame per newline: two messages in one write are two messages.
    socket.write(`${JSON.stringify({ type: 'leaf-input', data: 'ONE' })}\n${JSON.stringify({ type: 'leaf-input', data: 'TWO' })}\n`)
    await until(() => leaf.seen.length === 3, 'took both frames')
    assert.deepEqual(leaf.seen.slice(1), [{ type: 'leaf-input', data: 'ONE' }, { type: 'leaf-input', data: 'TWO' }])
  } finally {
    socket?.destroy()
    leaf.close()
  }
})

test('a session adopts a member that is already up instead of starting a second one', async () => {
  const leaf = member()
  try {
    const session = new LeafProcess({
      // Deliberately not a real program: adopting is the only way this can
      // reach a member at all, so a start path taken here would fail loudly
      // instead of quietly spawning a second writer onto the transcript.
      executable: 'Z:/no/such/interpreter-please-do-not-spawn.exe',
      args: [], cwd: getCwd(), env: {},
      onEvent: () => {}, onState: () => {}, onTerminal: () => {},
      interactive: true, sessionId: leaf.sessionId,
    })
    await session.start()
    // The handshake ran over the endpoint, so the member answered - which it
    // could only do because it was already running.
    assert.equal(session.getState(), 'idle')
    assert.deepEqual(leaf.controls().map(message => message.request.subtype), ['initialize'])

    // The session leaving detaches the member. It must not be asked to stop:
    // an unprompted shutdown here is exactly what made a leaf the parent's to
    // keep, and what made closing the session you are in close the family.
    session.detach()
    await until(() => leaf.counts.detaches === 1, 'noticed the detach')
    assert.equal(session.getState(), 'closed')
    assert.deepEqual(
      leaf.controls().map(message => message.request.subtype).filter(subtype => subtype === 'shutdown'),
      [],
      'detaching a session must not close the member',
    )

    // And the member is still open for business.
    const next = await connectLeafChannel(leaf.sessionId)
    assert.ok(next, 'the member must survive the session that was watching it')
    next.channel.close()
  } finally { leaf.close() }
})

test('a session waits for a member it started, however long the start takes', { timeout: 60_000 }, async () => {
  const sessionId = randomUUID()
  const channel = fileURLToPath(new URL('../src/utils/leafChannel.ts', import.meta.url))
  // A real member is not listening the moment it is spawned - it has a whole CLI
  // to evaluate first - so a session that reached it once, straight after the
  // start, would find nothing and call a healthy member a failed one. This child
  // takes its time on purpose.
  const startDelay = 1500
  const script = `
    let attached
    setInterval(() => {}, 1000)
    setTimeout(async () => {
      const { serveLeafChannel } = await import(${JSON.stringify(channel)})
      serveLeafChannel({
        sessionId: ${JSON.stringify(sessionId)},
        identify: () => ({ sessionId: ${JSON.stringify(sessionId)}, pid: process.pid, state: 'idle' }),
        onAttach: opened => { attached = opened },
        onMessage: message => {
          if (message?.type !== 'leaf-control') return
          attached?.send({ type: 'leaf-control-response', id: message.id, ok: true })
        },
      })
    }, ${startDelay})
  `
  const session = new LeafProcess({
    executable: process.execPath, args: ['-e', script], cwd: getCwd(), env: process.env,
    onEvent: () => {}, onState: () => {}, onTerminal: () => {},
    interactive: true, sessionId,
  })
  const started = Date.now()
  try {
    await session.start()
    assert.equal(session.getState(), 'idle', 'a member that binds late must still be reached')
    assert.ok(Date.now() - started >= startDelay, 'the wait must outlast the start, not give up during it')
  } finally {
    await session.close().catch(() => {})
  }
})

test('a session that leaves takes the leaves it owns with it', async () => {
  const workspace = await readFile(new URL('../src/utils/leafWorkspace.ts', import.meta.url), 'utf8')
  // The release marker now appears earlier as well, because closing the session
  // parent releases the same lease, so the slice is measured from the cleanup.
  const cleanupStart = workspace.indexOf('registerCleanup(async () => {')
  const cleanup = workspace.slice(cleanupStart, workspace.indexOf('await hostRelease?.()', cleanupStart))
  // The leaves belong to the session holding the family's terminal, so a session
  // that ends without handing the family on ends them too. Detaching is what
  // happens when only the watching session goes away, and it lives on the leaf's
  // own channel - not here.
  assert.match(cleanup, /await view\.process\.close\(\)/, 'the leaves a session owns end with it')
  assert.doesNotMatch(cleanup, /view\.process\.detach\(\)/, 'a session ending is not a detach')
  // The explicit close still exists, on the path a person takes.
  const change = workspace.slice(workspace.indexOf('export async function changeLeaf'), workspace.indexOf('export async function fileLeaf'))
  assert.match(change, /await view\.process\.close\(\)/)
})

test('the claim a session takes covers the start, not the member life', async () => {
  const workspace = await readFile(new URL('../src/utils/leafWorkspace.ts', import.meta.url), 'utf8')
  // A member that is already up must be adopted, so the address is passed down
  // and the start path reaches the endpoint before it spawns anything.
  assert.match(workspace, /sessionId: member\.sessionId,/)
  // The claim is released once the member answers, in every outcome: held for
  // the member's life it would outlive the session that took it, go stale, and
  // read as "nobody holds this" while the member is still running.
  assert.match(workspace, /await release\(\)\.catch\(\(\) => \{\}\)/)
  assert.doesNotMatch(workspace, /ownerReleases\.set\(member\.sessionId/)

  const processSource = await readFile(new URL('../src/utils/leafProcess.ts', import.meta.url), 'utf8')
  // Reaching a running member comes first, and needs no gate of its own.
  assert.match(processSource, /let connected = await connectLeafChannel\(sessionId, handlers\)/)
  assert.match(processSource, /detached: true, windowsHide: true, stdio: 'ignore'/)
  // Nothing here waits on the member and nothing here keeps it alive.
  assert.match(processSource, /child\.unref\(\)/)
  assert.match(processSource, /private detached = false/)
})

test('a leaf is one by environment, not by having a parent', async () => {
  const cli = await readFile(new URL('../src/entrypoints/cli.tsx', import.meta.url), 'utf8')
  // The gate is the environment and nothing else: it used to also require an
  // IPC channel, which made being a leaf the same thing as being somebody's
  // child. Read once, then consumed, because the environment a leaf runs in is
  // the one its children inherit.
  assert.match(cli, /const \{ consumeLeafLaunchEnv, installLeafTerminal, isInteractiveLeaf \} = await import\('\.\.\/utils\/leafTerminal\.js'\)/)
  assert.match(cli, /const leaf = isInteractiveLeaf\(\)/)
  assert.match(cli, /if \(leaf\) \{\r?\n    consumeLeafLaunchEnv\(\)/)
  assert.doesNotMatch(cli, /GATEWAY_INTERACTIVE_LEAF === '1' && typeof process\.send/)
  // A protocol flag is not a session and must not take over the terminal the
  // leaf is drawing into: a leaf's own peer-send hook reaches this file.
  assert.ok(cli.indexOf("args[0] === '--gateway-peer-send'") < cli.indexOf('installLeafTerminal()'))
  const main = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8')
  assert.match(main, /const leafResumePath = isInteractiveLeaf\(\) && leafSessionId\(\) === sessionId/)
  assert.doesNotMatch(main, /typeof process\.send === 'function' && process\.env\.GATEWAY_LEAF_SESSION/)

  const terminal = await readFile(new URL('../src/utils/leafTerminal.ts', import.meta.url), 'utf8')
  // The leaf serves its own endpoint and says goodbye on it, so the session
  // watching can tell a deliberate exit from a kill. Transport loss is not
  // self-termination - that rule was the coupling in a single line.
  assert.match(terminal, /serveLeafChannel\(\{/)
  assert.match(terminal, /registerCleanup\(async \(\) => \{ sendLeafTerminal\(\{ type: 'leaf-exit', code: 0 \}\) \}\)/)
  assert.doesNotMatch(terminal, /process\.once\('disconnect'/)
  // A leaf ends itself for one reason only: the session that owns it is gone.
  // Losing the watching session is still not termination - the watchdog asks the
  // owner's own private endpoint, and only an endpoint that cannot be reached at
  // all is death - so the shutdown lives inside the watchdog and nowhere else.
  const watchdog = terminal.slice(terminal.indexOf('function watchLeafOwner'), terminal.indexOf('export function getLeafSnapshot'))
  assert.match(watchdog, /gracefulShutdown\(0\)/)
  assert.doesNotMatch(terminal.slice(0, terminal.indexOf('function watchLeafOwner')), /gracefulShutdown\(0\)/)
  assert.doesNotMatch(terminal.slice(terminal.indexOf('export function getLeafSnapshot')), /gracefulShutdown\(0\)/)
})

test('the leaf keeps its identity and its children inherit none of it', { timeout: 60_000 }, async () => {
  // Run in a child, because consuming the launch identity is once per process
  // by design and the test runner is not that process.
  //
  // What this pins is the cost of inheriting it: a leaf's tools run in the
  // leaf's environment, so a marker left in it made every command that happened
  // to be this CLI install the leaf's terminal for itself - no stdout of its
  // own, exit 0, and on a platform whose channel is a socket file, the leaf's
  // address taken from the leaf. Reported as "leaf peer sends do nothing and
  // the CLI prints nothing inside a leaf", and measured as four identity tests
  // failing when the suite ran from a leaf.
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const root = fileURLToPath(new URL('..', import.meta.url))
  const probe = `
    process.env.GATEWAY_INTERACTIVE_LEAF = '1'
    process.env.GATEWAY_LEAF_SESSION = '11111111-1111-4111-8111-111111111111'
    process.env.GATEWAY_LEAF_LABEL = 'Leaf 2: api (of session 11111111-1111-4111-8111-111111111111)'
    const { execFile } = await import('node:child_process')
    const leaf = await import(${JSON.stringify(new URL('../src/utils/leafTerminal.ts', import.meta.url).href)})
    leaf.consumeLeafLaunchEnv()
    const child = await new Promise(resolve => {
      execFile(process.execPath, ['--version'], { env: process.env, windowsHide: true }, (error, stdout) => resolve(error ? 'ERR ' + error.message : stdout.trim()))
    })
    console.log(JSON.stringify({
      stillLeaf: leaf.isInteractiveLeaf(),
      session: leaf.leafSessionId(),
      label: leaf.leafLabel(),
      inherited: Object.keys(process.env).filter(key => key.startsWith('GATEWAY_LEAF_') || key === 'GATEWAY_INTERACTIVE_LEAF'),
      child,
    }))
  `
  const result = await promisify(execFile)(process.execPath, ['-e', probe], { cwd: root, timeout: 30_000 })
  const observed = JSON.parse(result.stdout.trim().split('\n').at(-1)!)
  // The leaf is still the leaf to itself...
  assert.equal(observed.stillLeaf, true)
  assert.equal(observed.session, '11111111-1111-4111-8111-111111111111')
  assert.equal(observed.label, 'Leaf 2: api (of session 11111111-1111-4111-8111-111111111111)')
  // ...and nothing it starts is told otherwise. `GATEWAY_LEAF_TRUSTED` and the
  // viewport stay: every reader of those is gated on the identity itself.
  assert.deepEqual(observed.inherited, [])
  assert.match(observed.child, /^\d+\.\d+\.\d+/)
})
