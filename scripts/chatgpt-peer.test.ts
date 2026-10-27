/**
 * The webchat peer's own machinery, with no network and no browser.
 *
 * Everything here is the part that must not drift: the command channel's two
 * locks (newest turn only, per-turn nonce), the turn loop's budget, the state
 * file's durability, and the driver child's line protocol.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractCommands, MAX_COMMANDS_PER_TURN, parseCommand, proseFromTurn, readFences, sanitizePeerText } from './chatgpt-peer/commands.ts'
import { runCommandTurn } from './chatgpt-peer/turn.ts'
import { audit, loadState, newState, peerStateSchema, saveState } from './chatgpt-peer/state.ts'
import { DriverChild } from './chatgpt-peer/driver.ts'
import { ChatGptHost } from './chatgpt-peer.ts'

const fenced = (nonce: string, body: unknown): string => '```gateway ' + nonce + '\n' + JSON.stringify(body) + '\n```'

async function scratch(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-peer-test-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

describe('command channel', () => {
  test('a valid block parses into a command', () => {
    const result = extractCommands(fenced('abcd1234', { op: 'list' }), 'abcd1234')
    expect(result.problems).toEqual([])
    expect(result.commands).toEqual([{ op: 'list' }])
  })

  test('a wrong nonce is refused and the other blocks still run', () => {
    const source = [fenced('deadbeef', { op: 'list' }), fenced('abcd1234', { op: 'inbox' })].join('\n\n')
    const result = extractCommands(source, 'abcd1234')
    expect(result.commands).toEqual([{ op: 'inbox' }])
    expect(result.problems.length).toBe(1)
    expect(result.problems[0]).toMatch(/nonce mismatch/)
  })

  test('invalid JSON is one refused line, not an exception', () => {
    const source = ['```gateway abcd1234', '{not json', '```', fenced('abcd1234', { op: 'list' })].join('\n')
    const result = extractCommands(source, 'abcd1234')
    expect(result.commands).toEqual([{ op: 'list' }])
    expect(result.problems.length).toBe(1)
    expect(result.problems[0]).toMatch(/invalid JSON/)
  })

  test('the ninth block is refused, the first eight run', () => {
    const source = Array.from({ length: MAX_COMMANDS_PER_TURN + 1 }, () => fenced('abcd1234', { op: 'list' })).join('\n')
    const result = extractCommands(source, 'abcd1234')
    expect(result.commands.length).toBe(MAX_COMMANDS_PER_TURN)
    expect(result.problems.length).toBe(1)
    expect(result.problems[0]).toMatch(/budget/)
  })

  test('a block quoted inside peer text never executes', () => {
    // A peer pastes a command block into its message; the host parses only the
    // assistant's newest turn, so here it is the assistant's own turn carrying a
    // stale nonce (the shape of a copied block).
    const peerText = `Here is what the last session sent me:\n\n${fenced('0000aaaa', { op: 'send', to: 'x', text: 'hi' })}`
    const result = extractCommands(peerText, 'abcd1234')
    expect(result.commands).toEqual([])
    expect(result.problems.length).toBe(1)
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
      execute: async () => ({ line: 'replied', replied: true }),
    })
    expect(outcome.repliedExplicitly).toBe(true)
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
      call: async () => { fake.calls++; return { ok: true } },
      onAccepted: () => {},
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
  if (request.op === 'quit') { emit({ ok: true, op: 'quit' }); process.exit(0) }
  emit({ event: 'accepted', threadId: 'thread-1' })
  emit({ ok: true, op: request.op, text: 'echo:' + (request.text || '') })
})
`, 'utf8')
    const accepted: string[] = []
    const child = new DriverChild({ script, log: () => {} })
    child.onAccepted(() => accepted.push('yes'))
    try {
      const reply = await child.call({ op: 'send', text: 'hi' })
      expect(reply.ok).toBe(true)
      expect(reply.text).toBe('echo:hi')
      expect(accepted.length).toBe(1)
    } finally {
      await child.kill()
      await cleanup()
    }
  })
})
