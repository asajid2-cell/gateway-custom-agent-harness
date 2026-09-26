import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { appendSessionTopic, deriveSessionPurpose, deriveSessionTopic, formatGatewayPeerLine } from '../src/utils/gatewaySessionProtocol.ts'

const user = content => ({ type: 'user', message: { content } })

test('recent topics describe current work, so a session that pivots stays findable', () => {
  // The real sequence from a live session whose display name never changed.
  // Its purpose is fixed to "what is a stack", which is exactly why discovery
  // could not find the session once it had moved on to 2D platformers.
  const conversation = [
    user('what is a stack'),
    user('ok now we are switching to 2d platformers i just wanna understand how theyre made'),
    user('and what about art and sprites and the like'),
  ]
  assert.equal(deriveSessionTopic(conversation), 'and what about art and sprites and the like')

  let topics = []
  for (const message of conversation) topics = appendSessionTopic(topics, deriveSessionTopic([message]))
  const line = formatGatewayPeerLine({
    status: 'idle', name: 'Explain what a stack is', purpose: 'what is a stack',
    cwd: 'C:/Users/Ahmed', sessionId: '11111111-1111-4111-8111-111111111111', topics,
  })
  // The finding that matters: the platformer work is searchable in the listing.
  assert.match(line, /recent: .*2d platformers/)
  assert.match(line, /art and sprites/)
})

test('a continued-context session reports real work, not its pasted preamble', () => {
  const preamble = user('This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation. Summary: 1. Primary Request and Intent: the archive work')
  // Both skip it for the actual request. Purpose skipping it too is the fix for
  // a real fleet reading: three of seven live sessions advertised a 1000-char
  // "This session is being continued..." wall as their description, because that
  // is the first user turn of every resumed session.
  assert.equal(deriveSessionTopic([preamble]), '')
  assert.equal(deriveSessionTopic([preamble, user('fix the memory leak in the renderer')]), 'fix the memory leak in the renderer')
  assert.equal(deriveSessionPurpose([preamble]), '')
  assert.equal(
    deriveSessionPurpose([preamble, user('fix the memory leak in the renderer')]),
    'fix the memory leak in the renderer',
  )
  // A preamble that is the only thing available still falls back rather than
  // advertising a summary as intent.
  assert.equal(deriveSessionPurpose([preamble], 'Claude Code'), 'Claude Code')
})

test('topics stay bounded and de-duplicated', () => {
  let topics = []
  for (let index = 0; index < 12; index++) topics = appendSessionTopic(topics, `task ${index}`)
  assert.equal(topics.length, 8)
  assert.deepEqual(topics.slice(-2), ['task 10', 'task 11'])
  // Re-stating the current topic refreshes it instead of repeating it.
  assert.deepEqual(appendSessionTopic(['alpha', 'beta'], 'alpha'), ['beta', 'alpha'])
  // Empties are never recorded, and a long topic is clipped at a word boundary.
  assert.deepEqual(appendSessionTopic(['alpha'], '   '), ['alpha'])
  const clipped = deriveSessionTopic([user('x'.repeat(400))])
  assert.ok(clipped.length <= 121 && clipped.endsWith('…'), clipped.length)
})

test('a peer in an older build still reads, because topics are optional', async () => {
  const { gatewayPeerSchema } = await import('../src/utils/gatewaySessionProtocol.ts')
  // Registrations written before topics existed must stay live: a schema that
  // rejected them would drop every peer running the previous build.
  const legacy = {
    protocol: 1, sessionId: '11111111-1111-4111-8111-111111111111',
    runtimeId: '22222222-2222-4222-8222-222222222222', name: 'Claude Code',
    cwd: 'C:/w', purpose: '', pid: 1, endpoint: '\\\\.\\pipe\\gateway-x',
    status: 'idle', startedAt: new Date().toISOString(),
  }
  assert.doesNotThrow(() => gatewayPeerSchema.parse(legacy))
  assert.equal(formatGatewayPeerLine(gatewayPeerSchema.parse(legacy)).includes('recent:'), false)
})

test('session intent comes from the opening request, not the truncated display name', () => {
  assert.equal(
    deriveSessionPurpose([user('Work on the archive project: migrate the audio key queue')]),
    'Work on the archive project: migrate the audio key queue',
  )
  // Whitespace is collapsed so a multi-line paste stays one readable line.
  assert.equal(deriveSessionPurpose([user('line one\n\n   line two')]), 'line one line two')
  // Array content blocks are joined; non-text blocks contribute nothing.
  assert.equal(
    deriveSessionPurpose([user([{ type: 'text', text: 'first' }, { type: 'tool_use', name: 'x' }, { type: 'text', text: 'second' }])]),
    'first second',
  )
})

test('intent ignores everything that is not a real request from the user', () => {
  const messages = [
    { type: 'assistant', message: { content: 'I will start' } },
    { type: 'user', isMeta: true, message: { content: 'meta reminder should not become intent' } },
    { type: 'user', isSidechain: true, message: { content: 'subagent chatter' } },
    user(''),
    user('the actual request'),
  ]
  assert.equal(deriveSessionPurpose(messages), 'the actual request')
})

test('intent falls back rather than advertising an empty purpose', () => {
  assert.equal(deriveSessionPurpose([], 'Claude Code'), 'Claude Code')
  assert.equal(deriveSessionPurpose(undefined, '  spaced   name '), 'spaced name')
  assert.equal(deriveSessionPurpose([], ''), '')
  // The schema caps purpose at 1000 characters.
  assert.equal(deriveSessionPurpose([user('x'.repeat(5000))]).length, 1000)
})

test('discovery lines lead with what a session is doing', () => {
  const line = formatGatewayPeerLine({
    status: 'running',
    name: 'Friendly pickle greeting',
    purpose: 'migrating the archive audio key queue',
    cwd: 'C:/work/archive',
    sessionId: '11111111-1111-4111-8111-111111111111',
  })
  assert.ok(line.startsWith('[running] migrating the archive audio key queue'), line)
  assert.match(line, /11111111-1111-4111-8111-111111111111/)
  assert.match(line, /C:\/work\/archive/)

  // A session that has stated nothing still reads as a session, never a blank.
  const unstated = formatGatewayPeerLine({
    status: 'idle', name: 'Session 4', purpose: '', cwd: 'C:/w', sessionId: 's',
  })
  assert.match(unstated, /\[idle\] Session 4/)
  assert.doesNotMatch(formatGatewayPeerLine({ status: 'idle', name: '', purpose: '', cwd: 'C:/w', sessionId: 's' }), /\[\] |^\[idle\]\s*$/)
})

test('every session records an intent on registration', async () => {
  const hook = await readFile(new URL('../src/hooks/useGatewaySession.ts', import.meta.url), 'utf8')
  assert.match(hook, /import \{[^}]*deriveSessionPurpose[^}]*\} from '\.\.\/utils\/gatewaySessionProtocol\.js'/)
  // Seeded at start; the name/status refresh must never clobber a declaration.
  assert.match(hook, /const purpose = runtime\.transport\.peer\.purpose\.trim\(\) \? runtime\.transport\.peer\.purpose : sessionPurposeSeed\(sessionMessages, name\)/)
  assert.match(hook, /await runtime\.transport\.update\(\{ name: latest\.current\.name, status:[^}]*purpose \}\)/)
  // The live status effect updates name and status only.
  assert.match(hook, /transport\.update\(\{ name: peerName, status: status === 'busy'/)
  assert.doesNotMatch(hook, /transport\.update\(\{ name: peerName, status: status === 'busy'[^)]*purpose/)

  const transport = await readFile(new URL('../src/utils/gatewaySessionTransport.ts', import.meta.url), 'utf8')
  // A restart keeps the intent it already advertised instead of blanking it.
  assert.match(transport, /if \(typeof raw\?\.peer\?\.purpose === 'string'\) this\.peer\.purpose = raw\.peer\.purpose\.slice\(0, 1000\)/)
})

test('a leaf registers on the shared bus as a leaf, not as the session it forked', async () => {
  const hook = await readFile(new URL('../src/hooks/useGatewaySession.ts', import.meta.url), 'utf8')
  // A leaf is a session: registering is what lets another family's leaf find it
  // and message it. The old leaf gate is what made "any two sessions" untrue for
  // the sessions people actually work in, and its cost - a leaf that could not
  // be reached or answered from outside its family - outlived the one it fixed
  // (a leaf listed beside unrelated sessions under its parent's title).
  const guard = hook.slice(hook.indexOf('useEffect'), hook.indexOf('new GatewaySessionRuntime'))
  assert.match(guard, /process\.env\.CLAUDE_CODE_USE_GATEWAY !== '1'\) return/)
  assert.doesNotMatch(guard, /GATEWAY_INTERACTIVE_LEAF/)
  // What keeps a forked leaf from reading as its parent: the label it carries is
  // both the name it advertises and the intent it states, so a listing says
  // which leaf it is and which conversation it belongs to.
  assert.match(hook, /function leafLabel\(\): string \| undefined/)
  assert.match(hook, /return \(leafLabel\(\) \?\? name\)\.slice\(0, 200\)/)
  assert.match(hook, /return leafLabel\(\)\?\.slice\(0, 1000\) \?\? deriveSessionPurpose\(messages, name\)/)
  // The live status refresh advertises the same name, or the next status change
  // would replace a leaf's label with its terminal title.
  assert.match(hook, /transport\.update\(\{ name: peerName, status: status === 'busy'/)

  const workspace = await readFile(new URL('../src/utils/leafWorkspace.ts', import.meta.url), 'utf8')
  assert.match(workspace, /GATEWAY_LEAF_LABEL: leafSelfLabel\(member, rootSessionId\)/)
  assert.match(workspace, /function leafSelfLabel\(member: LeafMember, rootSessionId: string\): string/)
  assert.match(workspace, /`Leaf \$\{member\.number\}: \$\{member\.name\} \(of session \$\{rootSessionId\}\)`/)
  // The parent session is hosted as a member now, and naming it "Leaf 0" would
  // have it derive its intent from being one of its own leaves.
  assert.match(workspace, /`The original session \$\{member\.name\} \(family root \$\{rootSessionId\}\)`/)

  // A peer message cannot wait for a person to look at a paused leaf: delivery
  // wakes the leaf's input, exactly as the family channel does.
  const runtime = await readFile(new URL('../src/utils/gatewaySessionRuntime.ts', import.meta.url), 'utf8')
  assert.match(runtime, /if \(isInteractiveLeaf\(\)\) \{\n\s+void import\('\.\/leafTerminal\.js'\)\.then\(leaf => leaf\.wakeLeafInput\(\)\)\.catch\(\(\) => \{\}\)/)
})

test('a leaf inherits no peer capability from its parent', async () => {
  const hooks = await readFile(new URL('../src/utils/hooks.ts', import.meta.url), 'utf8')
  // Hook environment is rebuilt per spawn: an inherited GATEWAY_PEER_* from the
  // parent would let a leaf's hooks send as that parent to unrelated sessions.
  assert.match(hooks, /for \(const key of \['GATEWAY_PEER_DIRECTORY', 'GATEWAY_PEER_SESSION', 'GATEWAY_PEER_RUNTIME', 'GATEWAY_PEER_TOKEN', 'GATEWAY_PEER_EXECUTABLE', 'GATEWAY_PEER_CLI'\]\) delete envVars\[key\]/)
  // A leaf that registered holds its own capability, issued to its own session,
  // so nothing is re-added for a session that did not register.
  assert.match(hooks, /if \(runtime\) Object\.assign\(envVars, runtime\.transport\.hookEnvironment\(\)/)
})

test('sessions can declare their intent and see each other doing it', async () => {
  const command = await readFile(new URL('../src/commands/gateway-sessions.ts', import.meta.url), 'utf8')
  // Declaring intent is explicit and bounded.
  assert.match(command, /input === 'purpose' \|\| input\.startsWith\('purpose '\)/)
  assert.match(command, /await runtime\.transport\.update\(\{ purpose: text \}\)/)
  assert.match(command, /Purpose must be 1000 characters or fewer/)
  // Discovery leads with intent and separates this session from the others.
  assert.match(command, /This session:\\n\$\{render\(self\)\}/)
  assert.match(command, /Other live sessions \(\$\{others\.length\}\)/)
  assert.match(command, /formatGatewayPeerLine/)

  const panel = await readFile(new URL('../src/components/GatewaySessionsDialog.tsx', import.meta.url), 'utf8')
  assert.match(panel, /\{peer\.purpose\.trim\(\) \|\| peer\.name\}/)
})

test('the peer skill reports why it failed and teaches intent-first discovery', async () => {
  const skill = await readFile(new URL('../src/skills/bundled/gatewayPeers.ts', import.meta.url), 'utf8')
  // One blanket message made a bad address, an offline peer and malformed JSON
  // indistinguishable, which is why peer messaging read as broken.
  assert.doesNotMatch(skill, /catch \{[\s\S]{0,200}invalid input, unavailable peer, or transport error/)
  assert.match(skill, /Peer operation failed: \$\{reason \|\| 'unavailable peer or transport error'\}/)
  assert.match(skill, /input === 'purpose'\)/)
  assert.match(skill, /input\.startsWith\('purpose '\)/)
  assert.match(skill, /await runtime\.transport\.update\(\{ purpose: text \}\)/)
  assert.match(skill, /formatGatewayPeerLine/)
  // A leaf is on the bus, and this surface is how it reaches a session outside
  // its family, so nothing excludes it; the honest refusal stays for a session
  // that has no runtime to send with.
  assert.doesNotMatch(skill, /GATEWAY_INTERACTIVE_LEAF/)
  assert.match(skill, /Peer communication requires an active main Gateway session/)
})

// Importing the real formatter pulls the CLI module graph (~8s), which is not
// worth paying to prove that bundled guidance survives a character clip.
test('the listing shows a bundled skill in full and still caps third-party ones', { timeout: 60_000 }, async () => {
  // Asserted against the real formatter, not string positions. A per-entry clip
  // applied to bundled skills silently deleted the gateway-peers collaboration
  // protocol, so this pins the exemption as behaviour: bundled guidance must
  // survive, and the cap must still protect the listing from one verbose
  // third-party description.
  const { formatCommandsWithinBudget, MAX_LISTING_DESC_CHARS } = await import(
    '../src/tools/SkillTool/prompt.ts'
  )
  const long = 'coordination guidance '.repeat(40)
  const render = (source, loadedFrom) =>
    formatCommandsWithinBudget([
      { type: 'prompt', name: 'sample', description: long, source, loadedFrom },
    ])

  const bundled = render('bundled', 'bundled')
  assert.ok(
    !bundled.includes('\u2026'),
    'a bundled description is never clipped by the per-entry cap',
  )
  assert.ok(bundled.includes(long), 'every word of the bundled guidance reaches the listing')

  const plugin = render('plugin', 'plugin')
  assert.ok(
    plugin.includes('\u2026'),
    'a third-party description is still clipped to protect the listing',
  )
  assert.ok(
    plugin.length <= MAX_LISTING_DESC_CHARS + 10,
    `third-party entry stays near the cap, got ${plugin.length}`,
  )
})

test('the peer skill teaches coordination before it lists its arguments', async () => {
  const skill = await readFile(new URL('../src/skills/bundled/gatewayPeers.ts', import.meta.url), 'utf8')
  // No apostrophes, so a plain match extracts the literal description.
  const description = skill.match(/description: '([^']*)'/)?.[1] ?? ''
  // What a session must learn from the listing alone: peers exist, discover
  // them, and settle ownership by talking rather than through a ledger.
  assert.match(description, /Other live sessions share this workspace/)
  assert.match(description, /list peers and their stated intent/)
  assert.match(description, /agree who owns which files/)
  assert.match(description, /worktree/)
  // The lesson: there is no central authority to appeal to.
  assert.match(description, /no lock service or merge bot/)
  // Leading with the teaching, not the argument reference.
  assert.ok(
    description.indexOf('Other live sessions') < description.indexOf('Arguments:'),
    'the argument list must not come before the collaboration protocol',
  )
})

test('discovery hands back the next move instead of leaving coordination implied', async () => {
  const command = await readFile(new URL('../src/commands/gateway-sessions.ts', import.meta.url), 'utf8')
  assert.match(command, /Coordination is conversation: \/sessions send <id> <message> to talk to one, agree who owns which files/)
  const skill = await readFile(new URL('../src/skills/bundled/gatewayPeers.ts', import.meta.url), 'utf8')
  assert.match(skill, /Coordination is conversation: send JSON \{toSessionId,text,summary\}/)
})
