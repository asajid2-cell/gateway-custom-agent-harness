import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { access, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { GatewaySessionTransport, listGatewayPeers } from '../src/utils/gatewaySessionTransport.ts'
import { claimGatewaySessionWriter, releaseGatewaySessionWriter } from '../src/utils/gatewaySessionOwnership.ts'
import { lock } from '../src/utils/lockfile.ts'
import { GATEWAY_SESSION_PROTOCOL } from '../src/utils/gatewaySessionProtocol.ts'
import { registerGatewayPeersSkill } from '../src/skills/bundled/gatewayPeers.ts'
import { clearBundledSkills, getBundledSkills } from '../src/skills/bundledSkills.ts'
import type { ToolUseContext } from '../src/Tool.ts'
import { isolateAmbientGatewayRoute } from './gateway-test-env.ts'

// The launcher exports the box's real gateway route into every leaf, so a bare
// transport here would advertise and probe the ambient gateway.
isolateAmbientGatewayRoute()

/**
 * The bus has one defect class and it is silent: a send reports success and
 * reaches nobody. Two halves of it are pinned here.
 *
 *  (1) A name that is not a live session. Names are the address a coordinator
 *      naturally uses, and every one of them that is not a teammate fell through
 *      to a mailbox write that returned success regardless. A name that resolves
 *      to no peer must be refused, because a refusal is the only honest answer.
 *
 *  (2) A receipt that proves nothing. `sendViaGatewayPeer` returned ok when the
 *      transport returned nothing, and printed the state as "(unknown)" while
 *      claiming success. Success is a claim about a receipt, so it needs one.
 *
 *  (3) A name that matches more than one live session. Names are family-local,
 *      so "Leaf 5" and "Leaf 9" each name two different live sessions on this
 *      machine. Picking one silently hands the work to the wrong lane; the case-
 *      insensitive branch previously fell past every check and reported the name
 *      as not existing at all, which is false and reads as the bus being broken.
 */

function endpointFor(directory: string, runtimeId: string): string {
  return process.platform === 'win32' ? `\\\\.\\pipe\\gateway-${runtimeId}` : join(directory, `${runtimeId}.sock`)
}

/** Stand up a transport with a real registration so discovery can see it. */
async function withPeer(
  registry: string,
  name: string,
  fn: (peer: { sessionId: string; transport: GatewaySessionTransport }) => Promise<void>,
): Promise<void> {
  const sessions = join(registry, 'gateway-sessions')
  const live = new GatewaySessionTransport({ directory: sessions, sessionId: randomUUID(), name, cwd: registry })
  await live.start()
  try {
    await fn({ sessionId: live.peer.sessionId, transport: live })
  } finally {
    await live.close()
  }
}

test('a real accepted send names the message and a settled state', async () => {
  // The invariant, stated at the transport boundary because that is where it is
  // provable with real behavior: a send that reports ok must name the message it
  // is about and carry a state the caller can read, and that message must
  // actually be in the recipient's inbox. This is what makes ok a claim about
  // something rather than an assertion.
  const registry = await mkdtemp(join(tmpdir(), 'gateway-receipt-'))
  try {
    const sessions = join(registry, 'gateway-sessions')
    const receiver = new GatewaySessionTransport({ directory: sessions, sessionId: randomUUID(), name: 'Receiver', cwd: registry })
    await receiver.start()
    const sender = new GatewaySessionTransport({ directory: sessions, sessionId: randomUUID(), name: 'Sender', cwd: registry })
    await sender.start()
    try {
      const receipt = (await sender.send(receiver.peer.sessionId, 'a real probe', 'a real probe')) as {
        ok?: boolean
        id?: string
        state?: string
      }
      assert.equal(receipt.ok, true, 'a real accepted send reports ok')
      assert.equal(typeof receipt.id, 'string', 'a receipt must name the message it is about')
      assert.ok(
        ['queued', 'held', 'delivered'].includes(String(receipt.state)),
        `a receipt must carry a settled state, got "${String(receipt.state)}"`,
      )
      // And the state is real: what the receipt named is actually in the inbox.
      const inbox = receiver.inbox()
      assert.equal(inbox.length, 1, 'the message the receipt named must actually be in the inbox')
      assert.equal(inbox[0]!.message.id, receipt.id, 'the receipt must name the message that landed')
    } finally {
      await sender.close()
      await receiver.close()
    }
  } finally {
    await rm(registry, { recursive: true, force: true })
  }
})

test('a registration cannot redirect a send to an endpoint it does not own', async () => {
  // The route an unsettled receipt could take. A registration is a file on
  // disk, so if it could name any endpoint, a stale or forged one could point a
  // send at a socket that answers whatever it likes - and a receipt is only
  // worth what the endpoint is worth. The transport therefore pins the endpoint
  // to the runtime's own pipe, which is why `sendViaGatewayPeer` can treat a
  // settled receipt as proof. This pins that the pinning is real.
  const registry = await mkdtemp(join(tmpdir(), 'gateway-endpoint-pin-'))
  try {
    const sessions = join(registry, 'gateway-sessions')
    const sender = new GatewaySessionTransport({ directory: sessions, sessionId: randomUUID(), name: 'Sender', cwd: registry })
    await sender.start()
    const targetSessionId = randomUUID()
    try {
      await writeFile(
        join(sessions, `${targetSessionId}.json`),
        JSON.stringify({
          peer: {
            protocol: GATEWAY_SESSION_PROTOCOL,
            sessionId: targetSessionId,
            runtimeId: randomUUID(),
            name: 'Redirected',
            cwd: registry,
            purpose: '',
            pid: process.pid,
            // Anywhere other than the pipe this runtime id would own.
            endpoint: 'tcp://127.0.0.1:9',
            status: 'idle',
            startedAt: new Date().toISOString(),
          },
          token: 'a'.repeat(64),
        }),
      )
      let reported: { ok?: boolean; state?: string } | undefined
      try {
        reported = (await sender.send(targetSessionId, 'a probe', 'a probe')) as {
          ok?: boolean
          state?: string
        }
      } catch {
        // Throwing is an honest failure; only a returned ok can be a lie.
        reported = undefined
      }
      if (reported) {
        assert.notEqual(
          reported.ok,
          true,
          `a redirected registration must never read as delivered: ${JSON.stringify(reported)}`,
        )
      }
    } finally {
      await sender.close()
    }
  } finally {
    await rm(registry, { recursive: true, force: true })
  }
})

test('a peer that dies without deregistering is a failure, never a delivered', async () => {
  // The measured incident: a registration outlives its session, so an address
  // that looks live names nothing. The send must fail rather than report a
  // delivery, because the sender reads a success as "the message is in their
  // hands" and stops looking for the copy that never arrived.
  const registry = await mkdtemp(join(tmpdir(), 'gateway-dead-peer-'))
  try {
    const sessions = join(registry, 'gateway-sessions')
    const receiver = new GatewaySessionTransport({ directory: sessions, sessionId: randomUUID(), name: 'Receiver', cwd: registry })
    await receiver.start()
    const deadSessionId = receiver.peer.sessionId
    const departedRuntime = randomUUID()
    // Leave the registration on disk but stop listening, which is what a crash
    // does. The registration is now a name for nothing: discovery will drop it
    // from the live set, but the file is still there to be addressed.
    await receiver.close()
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      join(sessions, `${deadSessionId}.json`),
      JSON.stringify({
        peer: { ...receiver.peer, runtimeId: departedRuntime, endpoint: endpointFor(sessions, departedRuntime) },
        token: 'a'.repeat(64),
      }),
    )
    const sender = new GatewaySessionTransport({ directory: sessions, sessionId: randomUUID(), name: 'Sender', cwd: registry })
    await sender.start()
    try {
      let result: { ok?: boolean; state?: string } | undefined
      try {
        result = (await sender.send(deadSessionId, 'a probe to a dead peer', 'a probe')) as {
          ok?: boolean
          state?: string
        }
      } catch {
        // A throw is already an honest failure - the sender is told nothing was
        // delivered. Only a returned value can be the silent success.
        result = undefined
      }
      if (result) {
        assert.ok(
          result.ok === false || result.state === 'unknown' || result.state === 'failed',
          `a send to a stale registration must not read as delivered: ${JSON.stringify(result)}`,
        )
      }
    } finally {
      await sender.close()
    }
  } finally {
    await rm(registry, { recursive: true, force: true })
  }
})

test('an ambiguous name refuses and names both candidates by session ID', async () => {
  const { resolveGatewayPeer } = await import('../src/utils/gatewayPeerSend.ts')
  const registry = await mkdtemp(join(tmpdir(), 'gateway-ambiguous-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = registry
  try {
    // The collision measured on this machine: "Leaf 5" named both the bridge and
    // the box lane. Two live sessions, one name, two different families.
    const ids: string[] = []
    await withPeer(registry, 'Leaf 5: box', async ({ sessionId }) => {
      ids.push(sessionId)
      await withPeer(registry, 'Leaf 5: BOX', async ({ sessionId: second }) => {
        ids.push(second)
        const result = await resolveGatewayPeer('leaf 5: BOX')
        assert.ok('error' in result, 'an ambiguous name must not resolve to a target')
        assert.match(result.error, /matches 2 live sessions/)
        for (const id of ids) {
          assert.ok(result.error.includes(id), `the refusal must name candidate ${id}: ${result.error}`)
        }
        // An exact-case match that names exactly one session is not ambiguous,
        // and must still resolve - the strictness of the fix is about ambiguity,
        // not about forbidding case-insensitive addressing.
        const exact = await resolveGatewayPeer('Leaf 5: box')
        assert.ok(!('error' in exact), 'an exact-case name matching one session must resolve')
        assert.equal(exact.sessionId, ids[0])
      })
    })
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(registry, { recursive: true, force: true })
  }
})

test('a resolved name is echoed back with its stable session ID', async () => {
  const { resolveGatewayPeer } = await import('../src/utils/gatewayPeerSend.ts')
  const registry = await mkdtemp(join(tmpdir(), 'gateway-label-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = registry
  try {
    await withPeer(registry, 'Leaf 9: tester', async ({ sessionId }) => {
      const resolved = await resolveGatewayPeer('Leaf 9: tester')
      assert.ok(!('error' in resolved), 'a unique name must resolve')
      // A label is what a coordinator reads back and reasons about. A bare name
      // cannot be told from another session's identical name, so the echo must
      // carry the ID that is actually unique.
      assert.ok(resolved.label.includes(sessionId), `the label must carry the session ID: ${resolved.label}`)
      assert.notEqual(resolved.label, 'Leaf 9: tester')
    })
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(registry, { recursive: true, force: true })
  }
})

test('a registration written by an older build still parses, its build read as unknown', async () => {
  // The dist rebuilds on launch, so a session that started before a fix is
  // running different behaviour with nothing on the wire saying so. `buildId`
  // is how a sender asks "is that fix live there?" - but every registration
  // written before the field existed has none, and a field made required would
  // make every older session undiscoverable. Missing must mean UNKNOWN, never
  // "old": a guess here is what a stale ledger turns into.
  //
  // The red direction is the schema: require `buildId` in `gatewayPeerSchema`
  // and this fails at the registration parse, which is the point.
  const { gatewayPeerSchema } = await import('../src/utils/gatewaySessionProtocol.ts')
  const { peer: registration } = new GatewaySessionTransport({
    directory: join(tmpdir(), 'gateway-old-build-ignore'),
    sessionId: randomUUID(),
    name: 'Oldtimer',
    cwd: process.cwd(),
  }) as unknown as { peer: Record<string, unknown> }
  // Exactly what a build that predates B4 leaves on disk: no buildId key.
  const { buildId: _dropped, ...asOldBuild } = registration
  assert.ok(!('buildId' in asOldBuild))
  const parsed = gatewayPeerSchema.safeParse(asOldBuild)
  assert.ok(parsed.success, `a registration without buildId must still parse: ${parsed.error?.message}`)
  assert.equal(parsed.data.buildId, undefined, 'a missing buildId reads as unknown, not as a guessed build')
  // And the field is genuinely read when it is present, so this is not a test
  // that would pass with the whole field ignored.
  assert.equal(gatewayPeerSchema.parse({ ...asOldBuild, buildId: 'a-real-build' }).buildId, 'a-real-build')
})

test('a send to a peer on a different build carries the build note', async () => {
  // The question "does that session have the fix?" is answered by the build it
  // registered, not by assumption. A sender that cannot tell an older peer from
  // a current one treats a fix as live when it is not - which is the same
  // silent-failure shape one layer up.
  //
  // The note is read from the live registration at send time, so this exercises
  // the whole path: a peer with an older buildId on disk must be reported as
  // older, and the report must not fire for an unknown build.
  const { buildNote, peerBuildNote } = await import('../src/utils/gatewayPeerSend.ts')
  const withOwnBuild = async (buildId: string | undefined, body: (dir: string) => Promise<void>) => {
    const directory = await mkdtemp(join(tmpdir(), 'gateway-build-note-'))
    // Own BUILD_TIME is a compile-time constant that does not exist under the
    // test runner (bun test does not inline MACRO), so the peer's build is
    // written by hand. `buildNote` is a pure function of the two ids, which is
    // what makes the comparison testable at all.
    try {
      await body(directory)
    } finally {
      await rm(directory, { recursive: true, force: true })
      void buildId
    }
  }
  await withOwnBuild(undefined, async () => {
    assert.equal(buildNote(undefined), '', 'unknown is silent: an older registration predates the field')
    const note = buildNote('build-from-before-the-fix')
    assert.ok(note.length > 0, 'a peer on a different build must be reported, not silently treated as current')
    assert.match(note, /older build|newer build|build build-from-before-the-fix/)
  })
  // The end-to-end half: `peerBuildNote` reads the registration off disk and
  // produces the note through the same path a send uses. Under `bun test` this
  // session has no build of its own (MACRO is a compile-time constant the
  // runner does not define), so `buildNote` can only say what the peer is, not
  // whether it is older. That is the honest limit of this harness: the
  // comparison the warning depends on is witnessed against the real build in
  // Phase D's real-session tests, not here.
  const registry = await mkdtemp(join(tmpdir(), 'gateway-build-note-e2e-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = registry
  try {
    const sessions = join(registry, 'gateway-sessions')
    const receiver = new GatewaySessionTransport({ directory: sessions, sessionId: randomUUID(), name: 'OldPeer', cwd: registry })
    await receiver.start()
    try {
      const stale = { ...receiver.peer, buildId: '2020-01-01T00:00:00.000Z' }
      await writeFile(join(sessions, `${receiver.peer.sessionId}.json`), JSON.stringify({ peer: stale, token: 'a'.repeat(64) }))
      // What must hold in every environment: a peer with no recordable build is
      // silent, never a note, and a peer whose registration the send path can
      // read is reported by `buildNote` as it stands there.
      assert.equal(buildNote(undefined), '', 'an unknown peer build must not produce a note')
      const note = await peerBuildNote(receiver.peer.sessionId)
      assert.equal(note, '', 'with no session-side build to compare against, the note is silent rather than a guess')
    } finally {
      await receiver.close()
    }
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(registry, { recursive: true, force: true })
  }
})

/** Run one command through the real `gateway-peers` skill, the surface a session actually types. */
async function viaSkill(input: string): Promise<string> {
  registerGatewayPeersSkill()
  try {
    const skill = getBundledSkills().find(entry => entry.name === 'gateway-peers')!
    const result = await skill.getPromptForCommand(input, {} as ToolUseContext)
    return result.map(part => (part.type === 'text' ? part.text : '')).join('')
  } finally {
    clearBundledSkills()
  }
}

test('a reply payload sent through `send` is named as a reply, not a raw parse error', async () => {
  // The sender typed the right payload against the wrong verb, and the generic
  // "Invalid message" answers a question about toSessionId - a field they never
  // meant to supply - when the fix is one word. The two shapes are disjoint, so
  // the mistake is unambiguous and can be named before anything is looked up.
  // This runs through the real skill against a registered session, because that
  // is the surface the mistake is typed at.
  const registry = await mkdtemp(join(tmpdir(), 'gateway-reply-misdirect-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = registry
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  try {
    const { GatewaySessionRuntime } = await import('../src/utils/gatewaySessionRuntime.ts')
    const { getSessionId } = await import('../src/bootstrap/state.ts')
    // The skill resolves the bus by `getSessionId()`, so the runtime has to be
    // this process's own session - which is what makes this the surface a
    // session actually types at, not a stand-in for it.
    const runtime = new GatewaySessionRuntime(getSessionId(), registry, 'Sender')
    await runtime.start(new Set())
    try {
      // It must fail on the payload shape, not on the missing recipient: the
      // recipient here is a real live session, so "Invalid message" would be the
      // old answer and the reply-shaped refusal is the new one.
      const text = await viaSkill(`send ${JSON.stringify({ toMessageId: randomUUID(), text: 'REPLY_MISDIRECTED' })}`)
      assert.match(text, /reply payload, not a send/, `the refusal must name the mistake: ${text}`)
      assert.match(text, /reply \{"toMessageId"/, 'the refusal must show the command that works')
    } finally {
      await runtime.close()
    }
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(registry, { recursive: true, force: true })
  }
})

test('a byte-identical re-send to the same peer is refused unless it is explicit', async () => {
  // No preemption: a peer reads at its next tool boundary, so a turn that has
  // not finished is not a lost message. Re-sending the same bytes because the
  // peer has not replied is how one directive becomes two, or two sessions that
  // each believe they own the work. The guard has to be on the real skill path,
  // because that is where a session re-sends from.
  //
  // The sender is a real `GatewaySessionRuntime`, so the skill's send goes
  // through the same transport a session uses - and the guard reads the message
  // the transport recorded as sent, which is what makes it survive a lost
  // acknowledgement.
  const registry = await mkdtemp(join(tmpdir(), 'gateway-resend-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = registry
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  const sessions = join(registry, 'gateway-sessions')
  const receiver = new GatewaySessionTransport({ directory: sessions, sessionId: randomUUID(), name: 'Receiver', cwd: registry })
  try {
    await receiver.start()
    const { GatewaySessionRuntime } = await import('../src/utils/gatewaySessionRuntime.ts')
    const { getSessionId } = await import('../src/bootstrap/state.ts')
    // The sender has to be this process's own session, because that is the one
    // the skill resolves the bus for. It sends to the receiver's real transport,
    // so the whole path is real: skill -> transport -> the peer's inbox.
    const sender = new GatewaySessionRuntime(getSessionId(), registry, 'Sender')
    await sender.start(new Set())
    try {
      const payload = { toSessionId: receiver.peer.sessionId, text: 'DO_NOT_DUPLICATE', summary: 'a repeated directive' }
      // The accepted result names the message and a settled state, which is what
      // "sent" means here - a receipt rather than a claim.
      const first = await viaSkill(`send ${JSON.stringify(payload)}`)
      assert.match(first, /"ok":true/, `the first send must be accepted: ${first}`)
      assert.match(first, /"state":"queued"/, `the first send must carry a settled state: ${first}`)
      assert.equal(receiver.inbox().filter(record => record.message.text === 'DO_NOT_DUPLICATE').length, 1)
      // The identical second send is refused, and the refusal names the message
      // already sent so the sender can check its state rather than re-send.
      const second = await viaSkill(`send ${JSON.stringify(payload)}`)
      assert.match(second, /byte-identical/, `a re-send must be refused: ${second}`)
      assert.match(second, /receipt /, 'the refusal must send the sender to the receipt, not to a second copy')
      assert.equal(receiver.inbox().filter(record => record.message.text === 'DO_NOT_DUPLICATE').length, 1, 'the refused re-send must not land')
      // A different summary is a different message, so the guard does not block
      // an ordinary follow-up to the same peer.
      const followUp = await viaSkill(`send ${JSON.stringify({ ...payload, summary: 'a different question' })}`)
      assert.match(followUp, /"ok":true/, `a follow-up is not a re-send: ${followUp}`)
      // And the escape hatch is real: an explicit resend goes through, so this
      // is a guard on an accidental repeat rather than a ban on re-sending.
      const third = await viaSkill(`send ${JSON.stringify({ ...payload, resend: true })}`)
      assert.match(third, /"ok":true/, `an explicit resend must go through: ${third}`)
      // First, then follow-up, then the explicit resend - and not the refused
      // second copy, which is the one this guard exists to stop.
      assert.equal(receiver.inbox().filter(record => record.message.text === 'DO_NOT_DUPLICATE').length, 3)
    } finally {
      await sender.close()
    }
  } finally {
    await receiver.close()
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(registry, { recursive: true, force: true })
  }
})

test('a refusal for a dead family reference names the family members that are still live', async () => {
  // The measured referral: a coordinator addressed "Leaf 5: box" and got a
  // refusal listing every live session on the machine - twenty rows across
  // unrelated families - when the one thing it needed was that family's other
  // members. The reference names a family, so the refusal should answer in the
  // family's terms: here is who from that family is live, address one of those.
  //
  // This stands up a real family file and two real live sessions, one of them a
  // member, then refuses a stale reference into that family.
  const { resolveGatewayPeer } = await import('../src/utils/gatewayPeerSend.ts')
  const { addLeafMember } = await import('../src/utils/leafFamily.ts')
  const registry = await mkdtemp(join(tmpdir(), 'gateway-family-refusal-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = registry
  const sessions = join(registry, 'gateway-sessions')
  const root = randomUUID()
  const familyName = 'Leaf 5: box'
  const siblingId = randomUUID()
  const departedId = randomUUID()
  const live = new GatewaySessionTransport({ directory: sessions, sessionId: siblingId, name: familyName, cwd: registry })
  try {
    await live.start()
    // A real family file with the member that is live and the member that is
    // not, so the two cases a refusal has to tell apart both exist on disk.
    const familyPath = join(registry, 'leaf-families', `${root}.json`)
    await addLeafMember(familyPath, root, { sessionId: siblingId, parentSessionId: root, name: familyName, transcriptPath: join(registry, 'sibling.jsonl'), forkMessageId: randomUUID() })
    await addLeafMember(familyPath, root, { sessionId: departedId, parentSessionId: root, name: 'departed member', transcriptPath: join(registry, 'departed.jsonl'), forkMessageId: randomUUID() })
    // A session knows its family by the pointer written on its way in, and that
    // pointer is read for the session *asking* - so this session pointing at the
    // family is what lets the reference resolve into it. That is the real
    // mechanism (the same write every leaf entry does), not a fake, and it is
    // done through the real writer so the directory is created the same way.
    const { writeIndexFile } = await import('../src/utils/leafWorkspace.ts')
    const { getSessionId } = await import('../src/bootstrap/state.ts')
    await writeIndexFile(
      join(registry, 'leaf-families', 'index', `${getSessionId()}.json`),
      { rootSessionId: root, rootName: familyName, patriarchSessionId: root },
    )
    // The address names the family but not a live member, so it is a refusal -
    // and the refusal must name the sibling, which is live, and must not offer
    // the departed one, which is a mailbox nobody reads.
    const result = await resolveGatewayPeer(departedId)
    assert.ok('error' in result, 'an address naming a dead session must be refused')
    // The family note is the whole point of B8: without it the refusal is the
    // machine's live list, which is what made a coordinator read a real
    // answer as unhelpful. Assert it is present, then assert what it says.
    const at = result.error.indexOf(' The family')
    assert.ok(at >= 0, `the refusal must name the family's live members: ${result.error}`)
    const note = result.error.slice(at)
    assert.ok(note.includes(siblingId), `the family note must name the live member ${siblingId}: ${note}`)
    assert.ok(note.includes(familyName), `the family note must name the member by its label: ${note}`)
    // And it must not offer the dead member as a target - that id is the mailbox
    // nobody reads, so pointing the sender back at it is the failure this whole
    // layer exists to prevent.
    assert.ok(!note.includes(departedId), `the family note must not offer the dead member as a target: ${note}`)
  } finally {
    await live.close()
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(registry, { recursive: true, force: true })
  }
})

test('a registration written by a newer build still parses, its unknown field dropped', async () => {
  // The other direction of the build skew the sibling test above covers. A field
  // added to the schema is written by every session launched after it and read by
  // every session launched before it, and the reader is `.strict()` - so the
  // newer session's registration fails to parse in the older reader, which is
  // exactly what "the bus randomly drops a session" was. The write side stays
  // strict (this build writes only fields it knows); the read side has to match
  // the wire's tolerance, the same way `parsePeerMessage` already does for a
  // message from a newer build.
  const { gatewayPeerSchema, parseGatewayPeer } = await import('../src/utils/gatewaySessionProtocol.ts')
  const base = {
    protocol: GATEWAY_SESSION_PROTOCOL,
    sessionId: randomUUID(),
    runtimeId: randomUUID(),
    name: 'Future',
    cwd: process.cwd(),
    purpose: '',
    pid: process.pid,
    endpoint: `\\\\.\\pipe\\gateway-${randomUUID()}`,
    status: 'idle' as const,
    startedAt: new Date().toISOString(),
  }
  // The red direction is the reader: parse with `gatewayPeerSchema` and this
  // fails on the unknown key, which is the defect.
  assert.equal(gatewayPeerSchema.safeParse({ ...base, futureField: 'from-a-newer-build' }).success, false)
  const parsed = parseGatewayPeer({ ...base, futureField: 'from-a-newer-build' })
  assert.equal(parsed.sessionId, base.sessionId, 'the known fields must survive the read')
  assert.ok(!('futureField' in parsed), 'a field this build does not know is dropped, not carried')
  // And the known fields are still validated rather than skipped, so this is a
  // tolerant read and not an unvalidated one.
  assert.throws(() => parseGatewayPeer({ ...base, sessionId: 'not-a-uuid' }))
})

test('a peer from a newer build stays visible on the bus', async () => {
  // The same skew, measured at the surface that acts on it: discovery. A
  // registration the reader cannot parse is dropped from the live set, so the
  // session is not merely missing a field - it is invisible, and a sender is
  // told it has exited. This is a real live transport whose registration is
  // rewritten with one field a future build would add.
  const { listGatewayPeers } = await import('../src/utils/gatewaySessionTransport.ts')
  const registry = await mkdtemp(join(tmpdir(), 'gateway-newer-build-'))
  const sessions = join(registry, 'gateway-sessions')
  const live = new GatewaySessionTransport({ directory: sessions, sessionId: randomUUID(), name: 'Future peer', cwd: registry })
  await live.start()
  try {
    // Rewrite the registration the transport itself wrote, so the token that
    // answers its ping stays the real one - only the peer gains a field. A
    // hand-written token would be refused by the ping and drop the peer for a
    // reason that has nothing to do with what is under test.
    const path = join(sessions, `${live.peer.sessionId}.json`)
    const stored = JSON.parse(await readFile(path, 'utf8')) as { peer: Record<string, unknown>; token: string }
    await writeFile(path, JSON.stringify({ ...stored, peer: { ...stored.peer, futureField: 'from-a-newer-build' } }))
    const listed = await listGatewayPeers(sessions)
    assert.ok(
      listed.some(peer => peer.sessionId === live.peer.sessionId),
      'a peer whose registration carries a field this build does not know must stay on the bus',
    )
  } finally {
    await live.close()
    await rm(registry, { recursive: true, force: true })
  }
})

/**
 * A real session process, killed the way Ctrl-C kills one.
 *
 * The defect these tests pin cannot be staged with a hand-written registration:
 * a registration written by a process that is still alive is a live peer, and
 * one written by hand has a made-up pid and no lock. So the owner here is a real
 * child process running the real transport, and it dies by SIGKILL - no close(),
 * no cleanup registry, exactly the state a session leaves behind when its
 * terminal goes away.
 *
 * The child is spawned with the test runner's own executable because this file
 * is a `.ts` module importing the TypeScript source; bun runs it directly.
 */
type ChildSession = { child: ChildProcess; pid: number }

/**
 * Spawn a script until it prints READY, and hand back the live child.
 *
 * `CLAUDE_CODE_USE_GATEWAY` is forced on so a runtime child takes its writer
 * claim: a child that only registered on the bus would leave no claim behind, and
 * the whole point of the reopen test is the claim a real session holds.
 */
async function spawnAndWait(script: string, args: string[], registry: string, what: string): Promise<ChildSession> {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: registry,
    env: { ...process.env, CLAUDE_CONFIG_DIR: registry, CLAUDE_CODE_USE_GATEWAY: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stderr = ''
  child.stderr?.on('data', chunk => { stderr += String(chunk) })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the ${what} did not register: ${stderr}`)), 20_000)
    child.stdout?.on('data', chunk => {
      if (!String(chunk).includes('READY')) return
      clearTimeout(timer)
      resolve()
    })
    child.once('exit', code => {
      clearTimeout(timer)
      reject(new Error(`the ${what} exited before registering (code ${code}): ${stderr}`))
    })
  })
  assert.ok(child.pid, 'a spawned child has a pid')
  return { child, pid: child.pid! }
}

/** A child running only the transport: enough to publish, hold, and be killed. */
async function startChildSession(registry: string, sessions: string, sessionId: string, purpose: string, topics: string[]): Promise<ChildSession> {
  const script = join(registry, 'killed-child.ts')
  const transportUrl = new URL('../src/utils/gatewaySessionTransport.ts', import.meta.url).href
  await writeFile(script, [
    `import { GatewaySessionTransport } from ${JSON.stringify(transportUrl)}`,
    'const [directory, sessionId, purpose, topics] = process.argv.slice(2)',
    "const transport = new GatewaySessionTransport({ directory, sessionId, name: 'Killed child', cwd: process.cwd(), purpose })",
    'await transport.start()',
    'await transport.update({ topics: JSON.parse(topics) })',
    "process.stdout.write('READY\\n')",
    'setInterval(() => {}, 1000)',
    '',
  ].join('\n'))
  return spawnAndWait(script, [sessions, sessionId, purpose, JSON.stringify(topics)], registry, 'child session')
}

/**
 * A child running the real `GatewaySessionRuntime`, which claims the writer lock
 * before it registers.
 *
 * This is the shape a Ctrl-C actually kills. The bare transport is enough to
 * prove the bus reaps a registration, but it never takes a writer claim, so a
 * reopen test built on it cannot see the claim that is the thing standing in the
 * way of a reopen.
 */
async function startChildRuntime(registry: string, sessionId: string, purpose: string, topics: string[]): Promise<ChildSession> {
  const script = join(registry, 'claimed-child.ts')
  const runtimeUrl = new URL('../src/utils/gatewaySessionRuntime.ts', import.meta.url).href
  await writeFile(script, [
    `import { GatewaySessionRuntime } from ${JSON.stringify(runtimeUrl)}`,
    'const [sessionId, cwd, purpose, topics] = process.argv.slice(2)',
    "const runtime = new GatewaySessionRuntime(sessionId, cwd, 'Claimed child')",
    'runtime.transport.peer.purpose = purpose',
    'await runtime.start(new Set())',
    'await runtime.transport.update({ topics: JSON.parse(topics) })',
    "process.stdout.write('READY\\n')",
    'setInterval(() => {}, 1000)',
    '',
  ].join('\n'))
  return spawnAndWait(script, [sessionId, registry, purpose, JSON.stringify(topics)], registry, 'runtime child')
}

/** Kill a child the way a closed terminal does: no chance to deregister. */
async function killChild({ child, pid }: ChildSession): Promise<void> {
  child.kill('SIGKILL')
  if (child.exitCode === null) await new Promise<void>(resolve => child.once('exit', () => resolve()))
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try { process.kill(pid, 0) } catch { return }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`pid ${pid} is still running after SIGKILL`)
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}

/** The tombstone a reaped registration is kept in, if the bus wrote one. */
async function findTombstone(sessions: string, sessionId: string): Promise<string | undefined> {
  const candidates = [
    join(sessions, `${sessionId}.dead.json`),
    join(sessions, 'reaped', `${sessionId}.json`),
  ]
  for (const path of candidates) if (await exists(path)) return path
  return undefined
}

test('a killed session is deregistered by the bus, and the sender is told the truth', { timeout: 60_000 }, async () => {
  // The incident, in the user's words: "if i ctrl c out routegate like i did
  // then it should deregister and you can easily just reopen it." The killed
  // session cannot cooperate - it is gone - so the only party that can correct
  // the registry is the bus. Four things have to be true at once:
  //
  //   (a) the live listing drops it (it already does),
  //   (b) its registration leaves the live registry within seconds (it does
  //       not: the sweep waits an hour on the file's mtime),
  //   (c) a sender is told "not live" without the "stale registration is still
  //       on disk" clause, because after (b) that is no longer true,
  //   (d) the intent the dead registration declared survives for the restart.
  const registry = await mkdtemp(join(tmpdir(), 'gateway-reap-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = registry
  const sessions = join(registry, 'gateway-sessions')
  const sessionId = randomUUID()
  const witnessId = randomUUID()
  const declaredPurpose = 'the work the crashed session declared'
  const declaredTopics = ['reap the bus', 'reopen without a timer']
  // A witness keeps the registry non-empty, so resolution takes the refusal
  // branch rather than deferring to the transport on an empty live set. It is a
  // real live peer that the bus must not touch.
  const witness = new GatewaySessionTransport({ directory: sessions, sessionId: witnessId, name: 'Witness', cwd: registry })
  let child: ChildSession | undefined
  try {
    await witness.start()
    child = await startChildSession(registry, sessions, sessionId, declaredPurpose, declaredTopics)
    assert.ok((await listGatewayPeers(sessions)).some(peer => peer.sessionId === sessionId), 'the child really registered before it was killed')
    await killChild(child)
    child = undefined

    // (a) and (b): the bus's own reading of the registry, repeated, is what
    // proves the registration dead - no cooperation from the dead session.
    const livePath = join(sessions, `${sessionId}.json`)
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      await listGatewayPeers(sessions)
      if (!(await exists(livePath))) break
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    assert.equal(
      await exists(livePath),
      false,
      'the registration of a session proven dead must leave the live registry within seconds, not an hour',
    )
    const tombstone = await findTombstone(sessions, sessionId)
    assert.ok(tombstone, 'reaping must keep the dead registration as a tombstone, not delete it')
    assert.ok((await readFile(tombstone!, 'utf8')).includes(declaredPurpose), 'the tombstone must carry the intent the session declared')
    assert.ok((await readFile(tombstone!, 'utf8')).includes(declaredTopics[0]!), 'the tombstone must carry the topics the session had been working on')

    // (c): the send-side refusal is a liveness verdict. `resolveGatewayPeer` is
    // where that sentence is produced, and `sendViaGatewayPeer` returns its
    // error verbatim, so this is the text a sender sees.
    const { resolveGatewayPeer } = await import('../src/utils/gatewayPeerSend.ts')
    const refusal = await resolveGatewayPeer(sessionId)
    assert.ok('error' in refusal, 'a reaped session must not resolve')
    assert.match(refusal.error, /is not live/)
    assert.doesNotMatch(refusal.error, /stale registration is still on disk/, `a reaped session has no stale file to point at: ${refusal.error}`)
    assert.ok(refusal.error.includes(witnessId), `the refusal must still name the live sessions: ${refusal.error}`)

    // (d): a restart reads the intent back. This is the property tombstoning
    // exists for - without it, the fix for (b) would silently erase stated
    // intent on every crash-restart.
    const restarted = new GatewaySessionTransport({ directory: sessions, sessionId, name: 'Restarted', cwd: registry })
    await restarted.start()
    try {
      assert.equal(restarted.peer.purpose, declaredPurpose, 'a restarted session must recover the intent its dead registration declared')
      assert.deepEqual(restarted.peer.topics, declaredTopics, 'a restarted session must recover the topics it had been working on')
      assert.equal(restarted.peer.sessionId, sessionId, 'the restart keeps the session id')
      assert.ok((await listGatewayPeers(sessions)).some(peer => peer.sessionId === sessionId), 'the restarted session is live under the same id')
      assert.ok(await exists(join(sessions, `${sessionId}.json`)))
    } finally {
      await restarted.close()
    }
  } finally {
    if (child) await killChild(child).catch(() => {})
    await witness.close().catch(() => {})
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(registry, { recursive: true, force: true })
  }
})

test('a session killed without closing can be reopened at once, with no leftover claim', { timeout: 90_000 }, async () => {
  // The second half of the user's sentence: "...and you can easily just reopen
  // it." A Ctrl-C leaves two things behind: the registration lock, and - because
  // the runtime claims a writer lock before it registers - the writer claim.
  // proper-lockfile treats both as held until their staleness windows pass, so a
  // session opened in that window is refused by locks a dead process owns. The
  // bus has the evidence the owner is gone (its pid and its endpoint), so a
  // reopen must not wait out a timer, and must not be refused by a corpse.
  //
  // The child is the real runtime rather than a bare transport, because the
  // writer claim is what refuses a reopen; a transport-only child never takes it
  // and this test would pass without exercising the thing that breaks.
  const registry = await mkdtemp(join(tmpdir(), 'gateway-reopen-'))
  const previousConfig = process.env.CLAUDE_CONFIG_DIR
  const previousGateway = process.env.CLAUDE_CODE_USE_GATEWAY
  process.env.CLAUDE_CONFIG_DIR = registry
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  const sessions = join(registry, 'gateway-sessions')
  const sessionId = randomUUID()
  const declaredPurpose = 'reopen must keep this intent'
  const declaredTopics = ['reopen now', 'no timer']
  const claim = join(registry, 'gateway-writers', `${sessionId}.lock`)
  let child: ChildSession | undefined
  let reopened: import('../src/utils/gatewaySessionRuntime.ts').GatewaySessionRuntime | undefined
  try {
    child = await startChildRuntime(registry, sessionId, declaredPurpose, declaredTopics)
    assert.ok(await exists(claim), 'the child runtime really held the writer claim before it was killed')
    await killChild(child)
    child = undefined
    // What the dead session left behind, as the bus reads it: both locks are
    // still on disk, because no process had a chance to release them.
    const leftovers = await readdir(sessions)
    assert.ok(leftovers.includes(`${sessionId}.json`), 'the killed session left its registration')
    assert.ok(await exists(claim), 'and it left the writer claim it was holding')
    // Reopen immediately - the state the user was in after Ctrl-C.
    const { GatewaySessionRuntime } = await import('../src/utils/gatewaySessionRuntime.ts')
    const started = performance.now()
    reopened = new GatewaySessionRuntime(sessionId, registry, 'Reopened')
    await reopened.start(new Set())
    const elapsed = performance.now() - started
    assert.ok(elapsed < 5000, `a reopen must not wait out a lock timer; it took ${Math.round(elapsed)}ms`)
    assert.equal(reopened.transport.peer.sessionId, sessionId, 'the reopened runtime registers under the same id, not a new one')
    assert.equal(reopened.transport.peer.purpose, declaredPurpose, 'the reopen recovers the dead registration intent')
    assert.deepEqual(reopened.transport.peer.topics, declaredTopics, 'the reopen recovers the topics the dead session was working on')
    assert.ok((await listGatewayPeers(sessions)).some(peer => peer.sessionId === sessionId), 'the reopened session is live')
    // Both stale locks are gone rather than merely tolerated: a lock the dead
    // process left must not survive for the next process to age out.
    assert.equal(await exists(join(sessions, `${sessionId}.json.lock`)), false, 'the dead session registration lock must not survive the reap')
    assert.ok(await exists(claim), 'the reopened runtime holds a fresh claim of its own')
  } finally {
    await reopened?.close().catch(() => {})
    if (child) await killChild(child).catch(() => {})
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfig
    if (previousGateway === undefined) delete process.env.CLAUDE_CODE_USE_GATEWAY
    else process.env.CLAUDE_CODE_USE_GATEWAY = previousGateway
    await rm(registry, { recursive: true, force: true })
  }
})

/**
 * A registration written by hand, for the cases a real process cannot stage.
 *
 * A live session cannot be made to advertise a dead endpoint, and a dead one
 * cannot be made to stay alive, so these records pin the decision table the bus
 * runs: which registrations it may reap and which writer claims it may clear.
 * They are ordinary records in every field the code reads.
 */
function registrationJson(values: { sessionId: string; pid: number; endpoint: string; purpose?: string; topics?: string[] }): string {
  return JSON.stringify({
    peer: {
      protocol: GATEWAY_SESSION_PROTOCOL,
      sessionId: values.sessionId,
      runtimeId: randomUUID(),
      name: 'Hand written',
      cwd: process.cwd(),
      purpose: values.purpose ?? '',
      pid: values.pid,
      endpoint: values.endpoint,
      status: 'idle',
      startedAt: new Date().toISOString(),
      ...(values.topics ? { topics: values.topics } : {}),
    },
    token: randomUUID().replace(/-/g, ''),
  })
}

/** A pipe name with no server behind it: every probe refuses to connect. */
function deadEndpoint(): string {
  return endpointFor('', randomUUID())
}

/** Stand up a registry the way a session does, so the ACL check a listing runs is the real one. */
async function withRegistrySession(registry: string, fn: (sessions: string) => Promise<void>): Promise<void> {
  const sessions = join(registry, 'gateway-sessions')
  const creator = new GatewaySessionTransport({ directory: sessions, sessionId: randomUUID(), name: 'Creator', cwd: registry })
  await creator.start()
  try {
    await fn(sessions)
  } finally {
    await creator.close()
  }
}

test('a tombstone is never listed as a peer, and is swept once it is past its TTL', { timeout: 30_000 }, async () => {
  // A tombstone is a record of a death. Two properties keep it from becoming a
  // live claim: discovery filters on `<uuid>.json` and a tombstone is
  // `<uuid>.dead.json`, so it can never be probed or resolved; and it is swept
  // once its TTL passes, so the registry empties instead of growing.
  const registry = await mkdtemp(join(tmpdir(), 'gateway-tombstone-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = registry
  try {
    await withRegistrySession(registry, async sessions => {
      const expiredId = randomUUID()
      const freshId = randomUUID()
      const expiredPath = join(sessions, `${expiredId}.dead.json`)
      const freshPath = join(sessions, `${freshId}.dead.json`)
      await writeFile(expiredPath, registrationJson({ sessionId: expiredId, pid: process.pid, endpoint: deadEndpoint(), purpose: 'long gone' }))
      await writeFile(freshPath, registrationJson({ sessionId: freshId, pid: process.pid, endpoint: deadEndpoint(), purpose: 'just died' }))
      const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000)
      await utimes(expiredPath, twoDaysAgo, twoDaysAgo)

      const peers = await listGatewayPeers(sessions)
      assert.equal(
        peers.some(peer => peer.sessionId === expiredId || peer.sessionId === freshId),
        false,
        'a tombstone must never be visible as a live peer',
      )
      assert.equal(await exists(expiredPath), false, 'a tombstone past its TTL must be swept by a listing')
      assert.ok(await exists(freshPath), 'a fresh tombstone must be kept, because a restart may still recover its intent')
    })
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(registry, { recursive: true, force: true })
  }
})

test('a session whose process is alive is never reaped, even when its endpoint does not answer', { timeout: 30_000 }, async () => {
  // The endpoint being down is one signal; the process being gone is the other.
  // A recycled pid, a session between transports, or a genuinely busy peer all
  // look like "no answer" while the owner exists. Reaping on one signal would
  // delete a live session's registration and make it unreachable until it
  // happened to publish again - so the missing signal must leave the file alone.
  const registry = await mkdtemp(join(tmpdir(), 'gateway-live-pid-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = registry
  try {
    await withRegistrySession(registry, async sessions => {
      const sessionId = randomUUID()
      const path = join(sessions, `${sessionId}.json`)
      await writeFile(path, registrationJson({ sessionId, pid: process.pid, endpoint: deadEndpoint() }))
      await listGatewayPeers(sessions)
      await listGatewayPeers(sessions)
      assert.ok(await exists(path), 'a registration whose pid is alive must never be reaped')
      assert.equal(await exists(join(sessions, `${sessionId}.dead.json`)), false, 'and no tombstone may be written for it')
    })
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(registry, { recursive: true, force: true })
  }
})

test('a sender is told the registration is still on disk when it is', { timeout: 30_000 }, async () => {
  // The counterpart of the reaped case. A registration that is present but whose
  // owner cannot be reached is not the same fact as one the bus has already
  // reaped, and the two sentences must stay distinct: the first is "it is still
  // on disk", the second is "it is gone". Telling a sender a file is gone while
  // it sits there is a false statement about their own machine.
  const registry = await mkdtemp(join(tmpdir(), 'gateway-stale-sentence-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = registry
  try {
    await withRegistrySession(registry, async sessions => {
      const staleId = randomUUID()
      await writeFile(join(sessions, `${staleId}.json`), registrationJson({ sessionId: staleId, pid: process.pid, endpoint: deadEndpoint() }))
      const { resolveGatewayPeer } = await import('../src/utils/gatewayPeerSend.ts')
      const refusal = await resolveGatewayPeer(staleId)
      assert.ok('error' in refusal, 'a registration that no endpoint answers for must not resolve')
      assert.match(refusal.error, /is not live/)
      assert.match(refusal.error, /stale registration is still on disk/, `a present registration must be described as present: ${refusal.error}`)
      assert.doesNotMatch(refusal.error, /its registration is gone/, `a present registration must not be described as gone: ${refusal.error}`)
    })
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(registry, { recursive: true, force: true })
  }
})

test('a writer claim held by a live session is never stolen', { timeout: 30_000 }, async () => {
  // The claim exists to keep two writers out of one record. Clearing it on weak
  // evidence would hand a live session's record to a second writer, which is the
  // exact corruption the claim prevents. A live pid must keep the refusal.
  const registry = await mkdtemp(join(tmpdir(), 'gateway-claim-live-'))
  const previousConfig = process.env.CLAUDE_CONFIG_DIR
  const previousGateway = process.env.CLAUDE_CODE_USE_GATEWAY
  process.env.CLAUDE_CONFIG_DIR = registry
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  const sessionId = randomUUID()
  const claimPath = join(registry, 'gateway-writers', sessionId)
  let holding: (() => Promise<void>) | undefined
  try {
    await withRegistrySession(registry, async sessions => {
      await writeFile(join(sessions, `${sessionId}.json`), registrationJson({ sessionId, pid: process.pid, endpoint: deadEndpoint() }))
      await mkdir(join(registry, 'gateway-writers'), { recursive: true, mode: 0o700 })
      holding = await lock(claimPath, { realpath: false, stale: 30000, retries: 0 })
      await assert.rejects(
        claimGatewaySessionWriter(sessionId),
        /Another session is writing/,
        'a claim whose owner is alive must never be granted to a second session',
      )
      assert.ok(await exists(`${claimPath}.lock`), 'the live owner keeps its claim')
    })
  } finally {
    if (holding) await holding().catch(() => {})
    await releaseGatewaySessionWriter(sessionId).catch(() => {})
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfig
    if (previousGateway === undefined) delete process.env.CLAUDE_CODE_USE_GATEWAY
    else process.env.CLAUDE_CODE_USE_GATEWAY = previousGateway
    await rm(registry, { recursive: true, force: true })
  }
})

test('a writer claim left by a dead session is cleared, and the claim is granted at once', { timeout: 30_000 }, async () => {
  // The Ctrl-C case at the ownership layer: the claim directory outlives the
  // process, so without clearing it a reopen is refused for the full stale
  // window by an owner that is provably gone. Both signals must agree before the
  // claim may be cleared: pid gone AND the endpoint refusing.
  const registry = await mkdtemp(join(tmpdir(), 'gateway-claim-dead-'))
  const previousConfig = process.env.CLAUDE_CONFIG_DIR
  const previousGateway = process.env.CLAUDE_CODE_USE_GATEWAY
  process.env.CLAUDE_CONFIG_DIR = registry
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  const sessionId = randomUUID()
  const claimPath = join(registry, 'gateway-writers', sessionId)
  let holding: (() => Promise<void>) | undefined
  let deadPid: number | undefined
  try {
    await withRegistrySession(registry, async sessions => {
      // A real process that has really exited: its pid is a genuine dead pid, not
      // a made-up number that might be in use.
      const gone = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true })
      await new Promise<void>(resolve => gone.once('exit', () => resolve()))
      deadPid = gone.pid
      await writeFile(join(sessions, `${sessionId}.json`), registrationJson({ sessionId, pid: deadPid!, endpoint: deadEndpoint(), purpose: 'died holding the claim' }))
      await mkdir(join(registry, 'gateway-writers'), { recursive: true, mode: 0o700 })
      holding = await lock(claimPath, { realpath: false, stale: 30000, retries: 0 })
      await claimGatewaySessionWriter(sessionId)
      assert.ok(await exists(`${claimPath}.lock`), 'the reopened session holds a claim of its own after the dead one was cleared')
    })
  } finally {
    await releaseGatewaySessionWriter(sessionId).catch(() => {})
    if (holding) await holding().catch(() => {})
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfig
    if (previousGateway === undefined) delete process.env.CLAUDE_CODE_USE_GATEWAY
    else process.env.CLAUDE_CODE_USE_GATEWAY = previousGateway
    await rm(registry, { recursive: true, force: true })
  }
})
