/**
 * The webchat peer's own machinery, with no network and no browser.
 *
 * Everything here is the part that must not drift: the command channel's two
 * locks (newest turn only, per-turn nonce), the turn loop's budget, the state
 * file's durability, and the driver child's line protocol.
 */
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachmentRefusal, extractCommands, MAX_COMMANDS_PER_TURN, parseCommand, proseFromTurn, readFences, sanitizePeerText } from './chatgpt-peer/commands.ts'
import { runCommandTurn } from './chatgpt-peer/turn.ts'
import { audit, loadState, newState, peerStateSchema, saveState } from './chatgpt-peer/state.ts'
import { DriverChild } from './chatgpt-peer/driver.ts'
import { ChatGptHost } from './chatgpt-peer.ts'

/** Markdown, which a raw driver read can still return. */
const fenced = (nonce: string, body: unknown): string => '```gateway ' + nonce + '\n' + JSON.stringify(body) + '\n```'

/**
 * What the page actually returns. ChatGPT renders a fenced block as a widget
 * whose transcript text is the label word and the body - no backticks, and the
 * info string is gone - so every command fixture starts here.
 */
const rendered = (nonce: string | undefined, body: Record<string, unknown>): string =>
  'gateway\n' + JSON.stringify(nonce === undefined ? body : { nonce, ...body })

async function scratch(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-peer-test-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

describe('command channel', () => {
  test('a rendered body-nonce command runs', () => {
    const result = extractCommands(rendered('abcd1234', { op: 'list' }), 'abcd1234')
    expect(result.problems).toEqual([])
    expect(result.commands).toEqual([{ op: 'list' }])
  })

  test('a rendered block with a wrong nonce is refused and the other blocks still run', () => {
    const source = [rendered('deadbeef', { op: 'list' }), rendered('abcd1234', { op: 'inbox' })].join('\n\n')
    const result = extractCommands(source, 'abcd1234')
    expect(result.commands).toEqual([{ op: 'inbox' }])
    expect(result.problems.length).toBe(1)
    expect(result.problems[0]).toMatch(/nonce mismatch/)
  })

  test('a rendered block with no nonce field is refused on the peer path', () => {
    const result = extractCommands(rendered(undefined, { op: 'list' }), 'abcd1234')
    expect(result.commands).toEqual([])
    expect(result.problems[0]).toMatch(/nonce mismatch/)
  })

  test('invalid JSON is one refused line, not an exception', () => {
    const source = ['gateway', '{"op":}', rendered('abcd1234', { op: 'list' })].join('\n\n')
    const result = extractCommands(source, 'abcd1234')
    expect(result.commands).toEqual([{ op: 'list' }])
    expect(result.problems.length).toBe(1)
    expect(result.problems[0]).toMatch(/invalid JSON/)
  })

  test('the ninth block is refused, the first eight run', () => {
    const source = Array.from({ length: MAX_COMMANDS_PER_TURN + 1 }, () => rendered('abcd1234', { op: 'list' })).join('\n')
    const result = extractCommands(source, 'abcd1234')
    expect(result.commands.length).toBe(MAX_COMMANDS_PER_TURN)
    expect(result.problems.length).toBe(1)
    expect(result.problems[0]).toMatch(/budget/)
  })

  test('a block quoted inside peer text never executes', () => {
    // A peer pastes a command block into its message; the host parses only the
    // assistant's newest turn, so here it is the assistant's own turn carrying a
    // stale nonce (the shape of a copied block).
    const peerText = `Here is what the last session sent me:\n\n${rendered('0000aaaa', { op: 'send', to: 'x', text: 'hi' })}`
    const result = extractCommands(peerText, 'abcd1234')
    expect(result.commands).toEqual([])
    expect(result.problems.length).toBe(1)
  })

  test('a multi-line object is still one block', () => {
    const source = 'gateway\n{\n  "nonce": "abcd1234",\n  "op": "list"\n}'
    expect(extractCommands(source, 'abcd1234').commands).toEqual([{ op: 'list' }])
  })

  test('two rendered blocks run in order and keep the prose between them', () => {
    const source = [
      'Doing two things.',
      rendered('abcd1234', { op: 'list' }),
      'and the second:',
      rendered('abcd1234', { op: 'inbox' }),
      'Done.',
    ].join('\n')
    expect(extractCommands(source, 'abcd1234').commands).toEqual([{ op: 'list' }, { op: 'inbox' }])
    const { prose } = proseFromTurn(source)
    expect(prose).toBe('Doing two things.\n\nand the second:\n\nDone.')
  })

  test('a rendered block with CRLF line endings is read the same', () => {
    const source = 'Here:\r\ngateway\r\n{"nonce":"abcd1234","op":"list"}\r\nDone.'
    expect(extractCommands(source, 'abcd1234').commands).toEqual([{ op: 'list' }])
    const { prose } = proseFromTurn(source)
    expect(prose).toContain('Here:')
    expect(prose).toContain('Done.')
    expect(prose).not.toContain('gateway')
  })

  test('braces and quotes inside strings do not end the body', () => {
    const body = { nonce: 'abcd1234', op: 'send', to: 'x', text: 'a {brace} and "quote"', summary: 's' }
    const source = 'gateway\n' + JSON.stringify(body)
    expect(extractCommands(source, 'abcd1234').commands).toEqual([{ op: 'send', to: 'x', text: 'a {brace} and "quote"', summary: 's' }])
  })

  test('a fenced info nonce still works for a raw markdown read', () => {
    const result = extractCommands(fenced('abcd1234', { op: 'list' }), 'abcd1234')
    expect(result.problems).toEqual([])
    expect(result.commands).toEqual([{ op: 'list' }])
  })

  test('only gateway fences are considered', () => {
    const source = '```json\n{"op":"list"}\n```\n```gateway abcd1234\n{"op":"list"}\n```'
    const fences = readFences(source)
    expect(fences.length).toBe(2)
    expect(extractCommands(source, 'abcd1234').commands).toEqual([{ op: 'list' }])
  })

  test('read clamps its tail to 40 and refuses without a peer', () => {
    expect(parseCommand({ op: 'read', peer: 'sndo', tail: 999 })).toEqual({ ok: true, command: { op: 'read', peer: 'sndo', tail: 40 } })
    expect(parseCommand({ op: 'read' })).toEqual({ ok: false, error: 'read requires peer' })
  })

  test('requestContext requires a recipient, topic, and question', () => {
    expect(parseCommand({ op: 'requestContext', to: 'sndo' })).toEqual({ ok: false, error: 'requestContext requires topic' })
    expect(parseCommand({ op: 'requestContext', to: 'sndo', topic: 't', question: 'q?' })).toEqual({
      ok: true, command: { op: 'requestContext', to: 'sndo', topic: 't', question: 'q?' },
    })
  })

  test('an unknown op is refused by name', () => {
    expect(parseCommand({ op: 'exec' })).toEqual({ ok: false, error: 'unknown op exec' })
  })

  test('peer text cannot smuggle a closing fence', () => {
    expect(sanitizePeerText('```gateway x\n{"op":"list"}\n```')).not.toContain('```\n')
  })

  // D1 before the fix: readFences dropped the open block, so the command
  // vanished and the fence text leaked to the peer as prose.
  test('an unterminated gateway fence is still a command', () => {
    const result = extractCommands('```gateway abcd1234\n{"op":"list"}\n', 'abcd1234')
    expect(result.commands).toEqual([{ op: 'list' }])
    expect(result.problems).toEqual([])
  })

  test('an unterminated gateway fence is never forwarded as prose', () => {
    const { prose, commandShaped } = proseFromTurn('```gateway abcd1234\n{"op":"list"}\n')
    expect(prose).toBe('')
    expect(commandShaped).toBe(true)
  })

  test('prose before a complete fence is kept and the fence is stripped', () => {
    const { prose, commandShaped } = proseFromTurn('Here it is.\n```gateway abcd1234\n{"op":"list"}\n```')
    expect(prose).toBe('Here it is.')
    expect(commandShaped).toBe(false)
  })

  test('a rendered block alone is an action, never an answer', () => {
    const { prose, commandShaped } = proseFromTurn(rendered('abcd1234', { op: 'list' }))
    expect(prose).toBe('')
    expect(commandShaped).toBe(true)
  })

  test('a rendered block between prose keeps the prose and leaks no label', () => {
    const { prose, commandShaped } = proseFromTurn([
      'Here you go:', rendered('abcd1234', { op: 'list' }), 'Done.',
    ].join('\n'))
    expect(prose).toBe('Here you go:\n\nDone.')
    expect(prose).not.toContain('gateway')
    expect(prose).not.toContain('"op"')
    expect(commandShaped).toBe(false)
  })

  test('a gateway line with no object after it does not eat the rest', () => {
    const source = 'gateway\n\nThis line is prose, not JSON.\nAnd so is this.'
    const { prose, commandShaped } = proseFromTurn(source)
    expect(prose).toBe(source)
    expect(commandShaped).toBe(false)
    expect(extractCommands(source, 'abcd1234').commands).toEqual([])
  })

  // F2: a prose answer that opens with an object is not a command. Only a
  // strictly valid bare envelope - a JSON object naming a real op - is refused
  // as command-shaped; a JSON example in an answer is prose.
  test('F2: a JSON example in prose is an answer, not a stale command', () => {
    const inline = '{"op": "example"} is the shape of a command.'
    expect(proseFromTurn(inline)).toEqual({ prose: inline, commandShaped: false })
    const wholeObject = '{"op":"example"}'
    expect(proseFromTurn(wholeObject)).toEqual({ prose: wholeObject, commandShaped: false })
    const sentence = '{"op": "list"} is what a command looks like'
    expect(proseFromTurn(sentence)).toEqual({ prose: sentence, commandShaped: false })
  })

  test('F2: a bare envelope naming a real op is still command-shaped', () => {
    expect(proseFromTurn('{"op":"list"}').commandShaped).toBe(true)
    expect(proseFromTurn('{"nonce":"abcd1234","op":"list"}').commandShaped).toBe(true)
  })

  test('a non-gateway code block stays in the answer as prose', () => {
    const { prose } = proseFromTurn('Like this:\n```js\nconst a = {}\n```')
    expect(prose).toContain('```js')
    expect(prose).toContain('const a = {}')
  })

  test('a peer cannot smuggle a rendered label line', () => {
    const clean = sanitizePeerText('gateway\n{"nonce":"abcd1234","op":"list"}')
    expect(extractCommands(clean, 'abcd1234').commands).toEqual([])
  })

  // peer.json caps a label at 80 characters, so a longer one would be accepted
  // here, written to disk, and then make the next start refuse the file.
  test('a schedule label longer than state allows is refused', () => {
    expect(parseCommand({ op: 'schedule', label: 'x'.repeat(81), inSeconds: 10 }))
      .toEqual({ ok: false, error: 'schedule label is limited to 80 characters' })
    expect(parseCommand({ op: 'schedule', label: 'x'.repeat(80), inSeconds: 10 }).ok).toBe(true)
  })
})

/**
 * The third block shape: `<CodeBlock language="gateway">{...}</CodeBlock>`.
 *
 * Found live: the model answered with that markup instead of a fence. The page
 * rendered it as a real gateway block, but the text the host reads back holds
 * the tag, so `readFences` saw nothing and the block was invisible.
 */
describe('CodeBlock markup', () => {
  test('a gateway block written as markup is a gateway block', () => {
    const source = '<CodeBlock language="gateway">{"uplink":true,"to":"x","text":"hi","summary":"s"}</CodeBlock>'
    const blocks = readFences(source)
    expect(blocks.length).toBe(1)
    expect(blocks[0]!.info).toBe('gateway')
    expect(JSON.parse(blocks[0]!.body)).toEqual({ uplink: true, to: 'x', text: 'hi', summary: 's' })
  })

  test('a markup block carries a command exactly as a fence does', () => {
    const source = '<CodeBlock language="gateway">{"nonce":"abcd1234","op":"list"}</CodeBlock>'
    expect(extractCommands(source, 'abcd1234').commands).toEqual([{ op: 'list' }])
    expect(proseFromTurn(source).prose).toBe('')
    expect(proseFromTurn('Before.\n' + source + '\nAfter.').prose).toBe('Before.\n\nAfter.')
  })

  test('another language is a code sample, never a gateway block', () => {
    for (const language of ['json', 'python']) {
      const source = `<CodeBlock language="${language}">{"nonce":"abcd1234","op":"list"}</CodeBlock>`
      expect(readFences(source).map(block => block.info)).toEqual([language])
      expect(extractCommands(source, 'abcd1234').commands).toEqual([])
      expect(proseFromTurn(source).prose).toBe(source)
    }
  })

  test('an unclosed tag is not a block and the rest of the answer is left alone', () => {
    const source = 'Before.\n<CodeBlock language="gateway">{"nonce":"abcd1234","op":"list"}\nAfter, with no close.'
    expect(readFences(source)).toEqual([])
    expect(proseFromTurn(source).prose).toBe(source)
    expect(extractCommands(source, 'abcd1234').commands).toEqual([])
  })

  test('a nested tag is skipped in favour of the inner one, and a balanced block after it still reads', () => {
    const nested = '<CodeBlock language="gateway"><CodeBlock language="json">{"a":1}</CodeBlock></CodeBlock>'
    expect(readFences(nested).map(block => block.info)).toEqual(['json'])
    const afterUnclosed = '<CodeBlock language="gateway">{"nonce":"abcd1234","op":"list"}\n<CodeBlock language="gateway">{"nonce":"abcd1234","op":"inbox"}</CodeBlock>'
    expect(extractCommands(afterUnclosed, 'abcd1234').commands).toEqual([{ op: 'inbox' }])
  })

  test('markup inside a fenced block stays part of that fence', () => {
    const source = '```text\n<CodeBlock language="gateway">{"nonce":"abcd1234","op":"list"}</CodeBlock>\n```'
    const blocks = readFences(source)
    expect(blocks.map(block => block.info)).toEqual(['text'])
    expect(extractCommands(source, 'abcd1234').commands).toEqual([])
  })

  test('the rendered and literal fence shapes are unchanged', () => {
    expect(extractCommands(rendered('abcd1234', { op: 'list' }), 'abcd1234').commands).toEqual([{ op: 'list' }])
    expect(extractCommands('```gateway abcd1234\n{"op":"list"}\n```', 'abcd1234').commands).toEqual([{ op: 'list' }])
  })

  // F1: a rendered label inside a non-gateway CodeBlock is example text, not a
  // command. The label scan used to record it before the enclosing tag was seen,
  // and the tag was then skipped for overlapping that label's span - so an
  // answer that QUOTED a command inside a text block executed it when the
  // example carried the current nonce.
  test('F1: a gateway label quoted inside a non-gateway CodeBlock never executes', () => {
    const source = '<CodeBlock language="text">\ngateway\n{"nonce":"abcd1234","op":"list"}\n</CodeBlock>'
    expect(extractCommands(source, 'abcd1234')).toEqual({ commands: [], problems: [] })
    expect(readFences(source).map(block => block.info)).toEqual(['text'])
    expect(proseFromTurn(source).prose).toBe(source)
  })
})

describe('turn loop', () => {
  const nonce = 'abcd1234'

  test('stops when the model answers in prose', async () => {
    let calls = 0
    const outcome = await runCommandTurn('go', nonce, {
      generate: async () => { calls++; return { ok: true, text: 'done' } },
      execute: async () => ({ line: 'ok' }),
    })
    expect(calls).toBe(1)
    expect(outcome.rounds).toBe(1)
    expect(outcome.budgetSpent).toBe(false)
    expect(outcome.executed).toEqual([])
  })

  test('feeds command results back and then stops on prose', async () => {
    let calls = 0
    const outcome = await runCommandTurn('go', nonce, {
      generate: async () => { calls++; return { ok: true, text: calls === 1 ? fenced(nonce, { op: 'list' }) : 'answered' } },
      execute: async () => ({ line: 'peer list here' }),
    })
    expect(calls).toBe(2)
    expect(outcome.executed.length).toBe(1)
    expect(outcome.budgetSpent).toBe(false)
  })

  test('an endless command loop stops at the round budget', async () => {
    let calls = 0
    const outcome = await runCommandTurn('go', nonce, {
      // Distinct commands each round: identical ones are now collapsed by the
      // duplicate guard, which would hide the budget under test here.
      generate: async () => { calls++; return { ok: true, text: fenced(nonce, { op: 'read', peer: 'p', since: `c${calls}` }) } },
      execute: async () => ({ line: 'ok' }),
    })
    expect(calls).toBe(4)
    expect(outcome.budgetSpent).toBe(true)
    expect(outcome.executed.length).toBe(4)
  })

  test('an explicit reply is reported so the host does not answer twice', async () => {
    const outcome = await runCommandTurn('go', nonce, {
      generate: async () => ({ ok: true, text: fenced(nonce, { op: 'reply', toMessageId: 'm1', text: 'here' }) }),
      execute: async () => ({ line: 'replied', replied: true, repliedTo: 'm1' }),
    })
    expect(outcome.repliedExplicitly).toBe(true)
    expect(outcome.repliedTargets).toEqual(['m1'])
  })

  // A reply to somebody else's older message is not an answer to this inbound.
  // A single boolean made it look like one, and the real answer was dropped.
  test('a reply to another message does not count as answering this one', async () => {
    const inbound = 'this-inbound'
    const outcome = await runCommandTurn('go', nonce, {
      generate: async () => ({ ok: true, text: fenced(nonce, { op: 'reply', toMessageId: 'someone-else', text: 'here' }) }),
      execute: async () => ({ line: 'replied', replied: true, repliedTo: 'someone-else' }),
    })
    expect(outcome.repliedTargets).toEqual(['someone-else'])
    expect(outcome.repliedTargets.includes(inbound)).toBe(false)
  })

  test('a failed model turn is reported, not thrown', async () => {
    const outcome = await runCommandTurn('go', nonce, {
      generate: async () => ({ ok: false, error: 'page died' }),
      execute: async () => ({ line: 'ok' }),
    })
    expect(outcome.failed).toBe(true)
    expect(outcome.problems[0]).toMatch(/page died/)
  })

  // D2 before the fix: one refused block ended the turn, so the refusal never
  // reached the model and the sender got a canned error.
  test('a refused block is fed back and retried inside the budget', async () => {
    let calls = 0
    const outcome = await runCommandTurn('go', nonce, {
      generate: async () => { calls++; return { ok: true, text: calls === 1 ? fenced('deadbeef', { op: 'list' }) : 'the answer' } },
      execute: async () => ({ line: 'should not run' }),
    })
    expect(calls).toBe(2)
    expect(outcome.problems.length).toBe(1)
    expect(outcome.problems[0]).toMatch(/nonce mismatch/)
    expect(outcome.executed).toEqual([])
    expect(outcome.budgetSpent).toBe(false)
  })

  // F3: a response that explains something and quotes a refused (stale-nonce)
  // block is an answer, not a command-only turn. Retrying it burned the budget
  // and ended as a canned error instead of delivering the prose.
  test('F3: prose beside a refused block is delivered instead of retried', async () => {
    let calls = 0
    const text = 'Here is the syntax:\n```gateway deadbeef\n{"op":"list"}\n```\nUse your own nonce.'
    const outcome = await runCommandTurn('go', nonce, {
      generate: async () => { calls++; return { ok: true, text } },
      execute: async () => ({ line: 'should not run' }),
    })
    expect(calls).toBe(1)
    expect(outcome.budgetSpent).toBe(false)
    expect(outcome.executed).toEqual([])
    expect(outcome.finalText).toBe(text)
  })

  test('a turn that only emits refused blocks spends the budget', async () => {
    let calls = 0
    const outcome = await runCommandTurn('go', nonce, {
      generate: async () => { calls++; return { ok: true, text: fenced('deadbeef', { op: 'list' }) } },
      execute: async () => ({ line: 'should not run' }),
    })
    expect(calls).toBe(4)
    expect(outcome.budgetSpent).toBe(true)
  })

  // D5: the model polls a snapshot it already has. An exact repeat is answered
  // from the log instead of costing another page round trip.
  test('an exact duplicate command runs once in a turn', async () => {
    let calls = 0
    let runs = 0
    const outcome = await runCommandTurn('go', nonce, {
      generate: async () => {
        calls++
        return { ok: true, text: calls === 1 ? [fenced(nonce, { op: 'inbox' }), fenced(nonce, { op: 'inbox' })].join('\n') : 'done' }
      },
      execute: async () => { runs++; return { line: 'inbox: nothing owed' } },
    })
    expect(runs).toBe(1)
    expect(outcome.executed.length).toBe(1)
  })
})

describe('state', () => {
  test('a missing file yields defaults', async () => {
    const { dir, cleanup } = await scratch()
    try {
      const state = await loadState(join(dir, 'peer.json'), () => newState({ profile: 'p', healthPort: 0, idleUnloadMinutes: 5, instanceId: 'default' }))
      expect(state.instanceId).toBe('default')
      expect(state.schedules).toEqual([])
      expect(peerStateSchema.safeParse(state).success).toBe(true)
    } finally { await cleanup() }
  })

  test('an unreadable file is reported, never silently replaced', async () => {
    const { dir, cleanup } = await scratch()
    try {
      const path = join(dir, 'peer.json')
      await writeFile(path, JSON.stringify({ sessionId: 'not-a-uuid' }), 'utf8')
      await expect(loadState(path, () => newState({ profile: 'p', healthPort: 0, idleUnloadMinutes: 5 }))).rejects.toThrow(/peer\.json is invalid/)
    } finally { await cleanup() }
  })

  test('save and load round-trip', async () => {
    const { dir, cleanup } = await scratch()
    try {
      const path = join(dir, 'peer.json')
      const state = newState({ profile: 'p', healthPort: 123, idleUnloadMinutes: 5 })
      state.threadId = '11111111-1111-4111-8111-111111111111'
      await saveState(path, state)
      expect(await loadState(path, () => { throw new Error('should not be used') })).toEqual(state)
    } finally { await cleanup() }
  })

  // Two overlapping saves each renamed their own temporary; whichever rename
  // landed last won, so an older snapshot could overwrite a newer one and a
  // cancelled schedule came back after a restart.
  test('the last save wins when saves overlap', async () => {
    const { dir, cleanup } = await scratch()
    try {
      const path = join(dir, 'peer.json')
      const older = newState({ profile: 'p', healthPort: 123, idleUnloadMinutes: 5 })
      older.model = 'older'
      const newer = newState({ profile: 'p', healthPort: 123, idleUnloadMinutes: 5 })
      newer.model = 'newer'
      await Promise.all([saveState(path, older), saveState(path, newer)])
      const loaded = await loadState(path, () => { throw new Error('should not be used') })
      expect(loaded.model).toBe('newer')
    } finally { await cleanup() }
  })

  test('audit keeps a rolling cap of 200', () => {
    const state = newState({ profile: 'p', healthPort: 0, idleUnloadMinutes: 5 })
    for (let index = 0; index < 250; index++) audit(state, { op: 'list', result: `result ${index}` })
    expect(state.audit.length).toBe(200)
    expect(state.audit.at(-1)?.result).toBe('result 249')
  })
})

describe('route health', () => {
  // Ask 5: route health answers from host state alone. Starting with the page
  // never started must yield 200 + unknown and must not touch the driver at
  // all - a health probe is not allowed to spawn Chrome.
  test('answers unknown without starting the page and never calls the driver', async () => {
    const { dir, cleanup } = await scratch()
    const fake = {
      calls: 0,
      // `ping` is liveness, not page work: the host sends it at boot to bring
      // the child (and its event channel) up, so it is not counted here.
      call: async (request: { op?: string }) => { if (request.op === 'ping') return { ok: true }; fake.calls++; return { ok: true } },
      onEvent: () => () => {},
      kill: async () => {},
      reopen: () => {},
    }
    const host = new ChatGptHost({
      home: dir,
      statePath: join(dir, 'peer.json'),
      driverPath: join(dir, 'unused.mjs'),
      profile: join(dir, 'profile'),
      instanceId: 'test',
      healthPort: 0,
      idleUnloadMinutes: 0,
      number: 1,
      directory: join(dir, 'sessions'),
      privateHome: join(dir, 'private'),
    }, fake as unknown as DriverChild)
    try {
      await host.start()
      const fleet = await fetch(`http://127.0.0.1:${host.port}/gateway/route-health?provider=chatgpt-web`)
      expect(fleet.status).toBe(200)
      const fleetBody = await fleet.json() as { fleet?: string; numbers?: { state?: string }[] }
      expect(fleetBody.fleet).toBe('unknown')
      expect(fleetBody.numbers?.[0]?.state).toBe('unknown')
      const single = await fetch(`http://127.0.0.1:${host.port}/gateway/route-health?provider=chatgpt-web&number=1`)
      expect(single.status).toBe(200)
      expect((await single.json() as { state?: string }).state).toBe('unknown')
      expect(fake.calls).toBe(0)
    } finally {
      await host.stop()
      await cleanup()
    }
  })
})

describe('attachment envelope (D6)', () => {
  const ENVELOPE = 64 * 1024 * 1024

  const fakeDriver = () => {
    const state = { calls: 0 }
    const driver = {
      state,
      call: async (request: { op?: string }) => {
        state.calls++
        return { ok: true, op: request.op, threadId: '11111111-1111-4111-8111-111111111111', text: 'ok', model: 'm', effort: 'e' }
      },
      onEvent: () => () => {},
      kill: async () => {},
      reopen: () => {},
    }
    return driver
  }

  const credentials = async (privateHome: string): Promise<{ token: string; sessionId: string }> => {
    const body = JSON.parse(await readFile(join(privateHome, 'instances', 'test.json'), 'utf8')) as { token: string; sessionId: string }
    return { token: body.token, sessionId: body.sessionId }
  }

  test('the operator file path refuses on the stat size and never opens the file', async () => {
    const { dir, cleanup } = await scratch()
    let reads = 0
    const files = {
      stat: async () => ({ isFile: () => true, size: 2_000_000_000 }),
      readFile: async () => { reads++; return Buffer.from('x') },
    }
    const driver = fakeDriver()
    const privateHome = join(dir, 'private')
    const host = new ChatGptHost({
      home: dir,
      statePath: join(dir, 'peer.json'),
      driverPath: join(dir, 'unused.mjs'),
      profile: join(dir, 'profile'),
      instanceId: 'test',
      healthPort: 0,
      idleUnloadMinutes: 0,
      number: 1,
      directory: join(dir, 'sessions'),
      privateHome,
      files: files as never,
    }, driver as unknown as DriverChild)
    try {
      await host.start()
      const { token } = await credentials(privateHome)
      const response = await fetch(`http://127.0.0.1:${host.port}/operator`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'attachFile', path: 'C:/somewhere/huge.bin' }),
      })
      expect(response.status).toBe(413)
      const body = await response.json() as { error?: string }
      expect(body.error).toBe(`attachment refused: 2000000000 bytes exceeds the 64 MiB host envelope`)
      expect(reads).toBe(0)
    } finally {
      await host.stop()
      await cleanup()
    }
  })

  test('the transcript path refuses on the size carried by its stat and never opens the file', async () => {
    const { dir, cleanup } = await scratch()
    const claude = join(dir, 'claude')
    // Do not pre-create gateway-sessions: the transport secures that directory
    // itself, and a pre-made one keeps the inherited ACL it then refuses.
    await mkdir(join(claude, 'projects', 'p'), { recursive: true })
    const previous = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = claude
    let reads = 0
    // The stat report is fake; the rollout file is real but small. What is
    // proved is that the size the stat carried is gated before any read.
    const files = {
      stat: async () => ({ isFile: () => true, size: 20 }),
      readFile: async () => { reads++; return Buffer.from('x') },
    }
    const driver = fakeDriver()
    const privateHome = join(dir, 'private')
    const host = new ChatGptHost({
      home: dir,
      statePath: join(dir, 'peer.json'),
      driverPath: join(dir, 'unused.mjs'),
      profile: join(dir, 'profile'),
      instanceId: 'test',
      healthPort: 0,
      idleUnloadMinutes: 0,
      number: 1,
      directory: join(claude, 'gateway-sessions'),
      privateHome,
      maxAttachmentBytes: 10,
      files: files as never,
    }, driver as unknown as DriverChild)
    try {
      await host.start()
      const { token, sessionId } = await credentials(privateHome)
      await writeFile(join(claude, 'projects', 'p', `${sessionId}.jsonl`), 'x'.repeat(20), 'utf8')
      const response = await fetch(`http://127.0.0.1:${host.port}/operator`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'attachTranscript', peer: sessionId }),
      })
      expect(response.status).toBe(502)
      const body = await response.json() as { error?: string }
      expect(body.error).toBe('attachment refused: 20 bytes exceeds the 64 MiB host envelope')
      expect(reads).toBe(0)
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previous
      await host.stop()
      await cleanup()
    }
  })

  test('a file within the envelope is not refused', async () => {
    expect(attachmentRefusal(ENVELOPE)).toBeUndefined()
    expect(attachmentRefusal(ENVELOPE + 1)).toBe('attachment refused: 67108865 bytes exceeds the 64 MiB host envelope')
  })
})

describe('driver child', () => {
  test('speaks one JSON object per line and reports acceptance', async () => {
    const { dir, cleanup } = await scratch()
    const script = join(dir, 'fake-driver.js')
    await writeFile(script, `
const readline = require('node:readline')
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n')
const rl = readline.createInterface({ input: process.stdin })
emit({ event: 'ready' })
rl.on('line', line => {
  const request = JSON.parse(line)
  if (request.op === 'quit') { emit({ ok: true, op: 'quit', id: request.id }); process.exit(0) }
  emit({ event: 'accepted', threadId: 'thread-1', id: request.id })
  emit({ ok: true, op: request.op, id: request.id, text: 'echo:' + (request.text || '') })
})
`, 'utf8')
    const accepted: string[] = []
    const child = new DriverChild({ script, log: () => {} })
    try {
      const reply = await child.call({ op: 'send', text: 'hi' }, { onAccepted: id => accepted.push(id) })
      expect(reply.ok).toBe(true)
      expect(reply.text).toBe('echo:hi')
      expect(accepted.length).toBe(1)
    } finally {
      await child.kill()
      await cleanup()
    }
  })

  // F4: shutdown must be final. A call after kill() used to relaunch the child
  // and keep sending page requests; only an explicit reopen() may start a new
  // one.
  test('F4: a call after kill is refused and does not relaunch the child', async () => {
    const { dir, cleanup } = await scratch()
    const marker = join(dir, 'starts.txt')
    await writeFile(marker, '', 'utf8')
    const script = join(dir, 'counted.js')
    await writeFile(script, `
const fs = require('node:fs')
fs.appendFileSync(${JSON.stringify(marker)}, 'start\\n')
const readline = require('node:readline')
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n')
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', line => {
  const request = JSON.parse(line)
  if (request.op === 'quit') { emit({ ok: true, op: 'quit', id: request.id }); process.exit(0) }
  emit({ ok: true, op: request.op, id: request.id, text: 'echo:' + (request.text || '') })
})
`, 'utf8')
    const child = new DriverChild({ script, log: () => {} })
    const starts = async () => (await readFile(marker, 'utf8')).split('\n').filter(Boolean).length
    try {
      expect((await child.call({ op: 'send', text: 'hi' })).ok).toBe(true)
      expect(await starts()).toBe(1)
      await child.kill()
      const after = await child.call({ op: 'send', text: 'again' }, 2000)
      expect(after.ok).toBe(false)
      expect(after.error).toMatch(/closed/i)
      expect(await starts()).toBe(1)
    } finally { await child.kill(); await cleanup() }
  })

  test('drops the late answer to a timed-out request instead of giving it to the next caller', async () => {
    const { dir, cleanup } = await scratch()
    const script = join(dir, 'slow-driver.js')
    // Holds the first request forever, answers everything else, and can be told
    // to release the held answer - which is what a page finishing a timed-out
    // turn looks like.
    await writeFile(script, `
const readline = require('node:readline')
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n')
const rl = readline.createInterface({ input: process.stdin })
let held = null
emit({ event: 'ready' })
rl.on('line', line => {
  const request = JSON.parse(line)
  if (request.op === 'quit') { emit({ ok: true, op: 'quit', id: request.id }); process.exit(0) }
  if (request.op === 'hold') { held = request; return }
  if (request.op === 'release') {
    if (held) emit({ ok: true, op: 'hold', id: held.id, text: 'answer-for-the-abandoned-turn' })
    held = null
    emit({ ok: true, op: 'release', id: request.id })
    return
  }
  emit({ ok: true, op: request.op, id: request.id, text: 'echo:' + (request.text || '') })
})
`, 'utf8')
    const child = new DriverChild({ script, log: () => {} })
    try {
      const timedOut = await child.call({ op: 'hold' }, 150)
      expect(timedOut.ok).toBe(false)
      const next = await child.call({ op: 'send', text: 'the next inbound' })
      expect(next.ok).toBe(true)
      expect(next.text).toBe('echo:the next inbound')
      // The abandoned turn answers now. It must be dropped, not delivered to
      // whoever is waiting - here, nobody is, and the call that follows is still
      // answered with its own line.
      const released = await child.call({ op: 'release' })
      expect(released.ok).toBe(true)
      expect(released.text).toBeUndefined()
    } finally {
      await child.kill()
      await cleanup()
    }
  })
})
