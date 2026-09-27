import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveLeafMember } from '../src/utils/leafFamily.ts'
import { parseForkRequest } from '../src/commands/leaf.tsx'
import { leafFamilyReference, resolveLeafSource, rootReference } from '../src/utils/leafWorkspace.ts'

const member = (number, name, sessionId) => ({
  sessionId,
  parentSessionId: '00000000-0000-4000-8000-000000000001',
  number,
  name,
  transcriptPath: `C:/tmp/${sessionId}.jsonl`,
  forkMessageId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  status: 'open',
})

const members = [
  member(1, 'fork', '11111111-1111-4111-8111-111111111111'),
  member(2, 'api hardening', '22222222-2222-4222-8222-222222222222'),
  member(3, 'api polish', '33333333-3333-4333-8333-333333333333'),
]

test('leaf references resolve by id, number, numbered name, and name', () => {
  assert.equal(resolveLeafMember(members, '22222222-2222-4222-8222-222222222222')?.number, 2)
  assert.equal(resolveLeafMember(members, '2')?.number, 2)
  assert.equal(resolveLeafMember(members, '2:api hardening')?.number, 2)
  // An exact name wins over a substring that matches several leaves.
  assert.equal(resolveLeafMember(members, 'fork')?.number, 1)
})

test('ambiguous or unknown leaf references resolve to nothing rather than guessing', () => {
  // "api" is a substring of two leaves, so a caller must be more specific.
  assert.equal(resolveLeafMember(members, 'api'), undefined)
  assert.equal(resolveLeafMember(members, '2:fork'), undefined)
  assert.equal(resolveLeafMember(members, '9'), undefined)
  assert.equal(resolveLeafMember(members, 'missing'), undefined)
  assert.equal(resolveLeafMember(members, '   '), undefined)
})

test('fork grammar treats a bare fork as the current session and rejects stray verbs', () => {
  assert.equal(parseForkRequest('fork'), '')
  assert.equal(parseForkRequest('new fork'), '')
  assert.equal(parseForkRequest('new fork 68585386-425d-4744-ab09-31c4e5bb633b'), '68585386-425d-4744-ab09-31c4e5bb633b')
  assert.equal(parseForkRequest('new fork 68585386-425d-4744-ab09-31c4e5bb633b api'), '68585386-425d-4744-ab09-31c4e5bb633b api')
  assert.equal(parseForkRequest('fork 1:fork branch'), '1:fork branch')
  // `new` alone is a fresh conversation, not a fork.
  assert.equal(parseForkRequest('new'), null)
  assert.equal(parseForkRequest('new scratch'), null)
  assert.equal(parseForkRequest('list'), null)
})

test('leaf command is an immediate, non-interrupting entrance surface', async () => {
  const source = await readFile(new URL('../src/commands/leaf.tsx', import.meta.url), 'utf8')
  assert.match(source, /name: 'leaf'[\s\S]*immediate: true/)
  // A blanket `catch {` hid the real cause behind one generic message; the
  // command must surface the failure reason instead.
  assert.doesNotMatch(source, /catch\s*\{[\s\S]{0,40}Leaf could not start/)
  assert.match(source, /Leaf operation failed: \$\{reason\}/)
})

test('leaf command exposes deterministic verbs and resolves references before acting', async () => {
  const source = await readFile(new URL('../src/commands/leaf.tsx', import.meta.url), 'utf8')
  for (const verb of ['send', 'interrupt', 'checkpoint', 'model', 'effort', 'return', 'rename', 'close', 'reopen']) {
    assert.ok(source.includes(verb), `the leaf command must keep the ${verb} verb`)
  }
  assert.match(source, /workspace\.resolveLeafRef\(/)
  assert.match(source, /workspace\.sendLeafMessage\(/)
  assert.match(source, /workspace\.configureLeaf\(/)
  assert.match(source, /await workspace\.listLeaves\(\)/)
})

test('forks work for any session with a transcript, not only an open leaf', async () => {
  const source = await readFile(new URL('../src/utils/leafWorkspace.ts', import.meta.url), 'utf8')
  assert.match(source, /getTranscriptPathForSession/)
  assert.match(source, /No session or open leaf matches/)
  assert.match(source, /createFork\(undefined, parent \? \{ sessionId: parent\.member\.sessionId, transcriptPath: parent\.member\.transcriptPath \} : source\)/)
})

test('leaves skip setup modals that would wedge startup, inheriting trust instead', async () => {
  const source = await readFile(new URL('../src/interactiveHelpers.tsx', import.meta.url), 'utf8')
  assert.match(source, /const isLeaf = isInteractiveLeaf\(\)/)
  // Onboarding is a per-user dialog with no keyboard available in a leaf.
  assert.match(source, /if \(!isLeaf && \(!config\.theme \|\| !config\.hasCompletedOnboarding\)/)
  // Trust is inherited from the parent, never bypassed: the dialog is only
  // skipped when the parent recorded that this workspace was already accepted.
  // Both answers come from the launch snapshot rather than the environment,
  // because a leaf takes its launch environment back out of the process
  // (consumeLeafLaunchEnv) before setup screens run - reading process.env here
  // answered "not a leaf, not trusted", which is the dialog this skips.
  assert.match(source, /const inheritsTrust = isLeaf && leafTrusted\(\)/)
  assert.match(source, /import \{ isInteractiveLeaf, leafTrusted \} from '\.\/utils\/leafTerminal\.js'/)
  assert.match(source, /if \(!checkHasTrustDialogAccepted\(\) && !inheritsTrust\) \{/)
  assert.match(source, /allErrors\.length === 0 && !isLeaf/)
  assert.match(source, /if \(!isLeaf && await shouldShowClaudeMdExternalIncludesWarning\(\)\)/)

  const workspace = await readFile(new URL('../src/utils/leafWorkspace.ts', import.meta.url), 'utf8')
  assert.match(workspace, /GATEWAY_LEAF_TRUSTED: checkHasTrustDialogAccepted\(\) \? '1' : '0'/)
})

test('a leaf that never reaches its input loop says why instead of just timing out', async () => {
  const source = await readFile(new URL('../src/utils/leafProcess.ts', import.meta.url), 'utf8')
  // The start handshake only stalls when the REPL never mounted; a startup
  // dialog is the reason, and the parent cannot answer one for the child.
  assert.match(source, /Leaf did not reach its input loop; a startup dialog may be waiting/)
  assert.match(source, /request\.subtype === 'initialize'/)
})

test('parents and leaves reach each other through the interactive channel', async () => {
  const processSource = await readFile(new URL('../src/utils/leafProcess.ts', import.meta.url), 'utf8')
  assert.match(processSource, /deliver\(text: string\): Promise<boolean>/)
  assert.match(processSource, /subtype: 'leaf_prompt'/)
  // A leaf that cannot take a message holds it rather than dropping it, and
  // keeps arrival order.
  assert.match(processSource, /private readonly inbox/)
  assert.match(processSource, /private queue\(text: string\)/)
  assert.match(processSource, /private pump\(\): void/)
  assert.match(processSource, /private drainInbox\(\): void/)
  // A running leaf takes the message now: its own REPL queues it and the turn
  // drains it at the next step boundary, which is what makes a peer answer
  // mid-turn. Only a permission dialog is ineligible, because it owns the input.
  assert.match(processSource, /private canTakeMessage\(\): boolean/)
  assert.match(processSource, /return this\.state === 'idle' \|\| this\.state === 'running'/)
  assert.match(processSource, /if \(!this\.canTakeMessage\(\)\) return this\.queue\(text\)/)

  const terminalSource = await readFile(new URL('../src/utils/leafTerminal.ts', import.meta.url), 'utf8')
  // Delivery wakes a paused leaf's queue but must not type into its input: text
  // written to stdin is framed as the person's own message.
  assert.match(terminalSource, /export function wakeLeafInput/)
  assert.match(terminalSource, /wakeInput = \(\) =>/)
  assert.match(terminalSource, /\.resume\(\)/)
  assert.doesNotMatch(terminalSource, /input\.write\(data\)/)
  // The leaf reports its answer as soon as it exists, on its own message.
  assert.match(terminalSource, /type: 'leaf-answered'/)

  const hookSource = await readFile(new URL('../src/hooks/useLeafTerminalSession.ts', import.meta.url), 'utf8')
  assert.match(hookSource, /case 'leaf_prompt':/)
  // A peer's turn is queued with its origin, not typed in. Keystrokes reach the
  // turn boundary with no origin, and that path announces the text as "the user
  // sent a new message" and tells the model it MUST address it.
  assert.match(hookSource, /if \(!prompt\.trim\(\)\) throw new Error\('Empty leaf prompt'\)/)
  assert.match(hookSource, /prompt\.startsWith\(PEER_PROMPT_PREFIX\)/)
  assert.match(hookSource, /origin: \{ kind: 'gateway-peer' \}/)
  assert.match(hookSource, /import \{ enqueue \} from '\.\.\/utils\/messageQueueManager\.js'/)
  assert.match(hookSource, /wakeLeafInput\(\)/)
  assert.doesNotMatch(hookSource, /writeLeafInput/)
  assert.doesNotMatch(hookSource, /PASTE_START/)
  assert.doesNotMatch(hookSource, /if \(latest\.current\.status !== 'idle'\) throw new Error\('Leaf is not idle'\)/)
  // The leaf answers mid-turn rather than at turn end, and marks a message that
  // also calls a tool as "still working" instead of as an answer.
  assert.match(hookSource, /const found = peerAnswerFor\(messages, pending\)/)
  assert.match(hookSource, /sendLeafTerminal\(\{ type: 'leaf-answered', question: found\.question, answer: found\.answer \}\)/)
  assert.match(hookSource, /A busy root takes a leaf's message/)
  assert.match(hookSource, /if \(latest\.current\.status === 'busy'\) \{[\s\S]{0,400}enqueue\(\{/)

  const workspaceSource = await readFile(new URL('../src/utils/leafWorkspace.ts', import.meta.url), 'utf8')
  assert.match(workspaceSource, /case 'send': result = await sendLeafMessage/)
  assert.match(workspaceSource, /case 'configure': result = await configureLeaf/)
  // A leaf reporting its own settings must not echo a control request back.
  assert.match(workspaceSource, /case 'settings': await saveLeafSettings/)
})

test('a reply is routed back to whoever asked, not left in the leaf', async () => {
  const workspace = await readFile(new URL('../src/utils/leafWorkspace.ts', import.meta.url), 'utf8')
  // The send is recorded at dispatch and reported when the turn ends; without
  // the record a reply is only visible to whoever opens the leaf next. The
  // origin is explicit because a sibling's send is relayed by the root, so the
  // process handling it is not the session that asked.
  assert.match(workspace, /function expectLeafReply\(view: LeafView, message: string, origin\?: string\)/)
  assert.match(workspace, /case 'send': result = await sendLeafMessage\(id, value, \{ sessionId: sourceId \}\)/)
  assert.match(workspace, /function forgetExpectedReply\(sessionId: string, message: string\)/)
  assert.match(workspace, /async function reportLeafReplies\(view: OwnedLeafView, child: LeafProcess\)/)
  assert.match(workspace, /await reportLeafReply\(item, view, answer\)/)
  assert.match(workspace, /if \(current && child\.getState\(\) === 'idle'\) void reportLeafReplies\(current, child\)/)
  // The answer is read from the turn that just ended, not guessed.
  assert.match(workspace, /async function lastLeafTurnText/)
  // A sibling's reply goes back through the send path, so it is labelled too.
  assert.match(workspace, /await sendLeafMessage\(item\.source, text\)/)
})

test('an answer reported mid-turn is routed now, and not sent again at turn end', async () => {
  const workspace = await readFile(new URL('../src/utils/leafWorkspace.ts', import.meta.url), 'utf8')
  // Reporting only at idle made a peer wait for the leaf's whole turn. The leaf
  // now reports the answer when it has one, and this routes it on.
  assert.match(workspace, /async function reportEarlyLeafAnswers\(view: OwnedLeafView, question: string, answer: string\)/)
  assert.match(workspace, /if \(message\.type === 'leaf-answered'\) \{[\s\S]{0,200}reportEarlyLeafAnswers\(view, message\.question, message\.answer\)/)
  // The answer names the question it answers, and this matches it to the asker.
  // Two questions can be in flight at once now that a running leaf takes each
  // as it arrives, and a leaf may answer them out of order - "oldest still
  // owed" would hand the second asker the first asker's answer.
  assert.match(workspace, /const item = pending\.find\(candidate => candidate\.message\.includes\(question\)\) \?\? pending\[0\]!/)
  // Taking it off the books here is what stops the end-of-turn report from
  // answering the same question a second time.
  assert.match(workspace, /function takeExpectedReply\(sessionId: string, message: string\)/)
  assert.match(workspace, /takeExpectedReply\(id, item\.message\)/)
  // The seam drives the real matcher and bookkeeping rather than bypassing them.
  assert.match(workspace, /export function deliverLeafAnswerForTesting\(sessionId: string, question: string, answer: string\)/)
})

test('every peer-delivered turn is marked as coming from a session, not the user', async () => {
  const workspace = await readFile(new URL('../src/utils/leafWorkspace.ts', import.meta.url), 'utf8')
  // One definition, re-exported. The renderer recognises the peer family by
  // reading the text, so a second literal here could drift from the one it
  // matches on and silently stop labelling leaf turns.
  assert.match(workspace, /export const PEER_PROMPT_PREFIX = LEAF_PEER_PROMPT_PREFIX/)
  assert.match(workspace, /import \{ LEAF_PEER_PROMPT_PREFIX \} from '\.\/gatewaySessionProtocol\.js'/)
  // The parent labels the turn it hands over, and the reply it routes back.
  assert.match(workspace, /await view\.process\.deliver\(`\$\{PEER_PROMPT_PREFIX\}\$\{message\}`\)/)
  // The label is text, and the turn boundary rewrites the text around it, so
  // the answer is found by the id the question arrived under. Matching on the
  // marker instead never fires: the framing puts it behind a system-reminder.
  assert.match(workspace, /export function peerAnswerFor\(/)
  assert.match(workspace, /message\?\.attachment\?\.source_uuid === oldest\.uuid \|\|/)
  assert.match(workspace, /message\?\.type === 'user' && message\.uuid === oldest\.uuid/)
  assert.doesNotMatch(workspace, /startsWith\(PEER_PROMPT_PREFIX\)\) questionIndex/)

  const hook = await readFile(new URL('../src/hooks/useLeafTerminalSession.ts', import.meta.url), 'utf8')
  // The leaf fills in the label for any sender that omitted it, so the marker
  // is present on every peer turn regardless of which side dispatched it.
  assert.match(hook, /import \{ PEER_PROMPT_PREFIX, peerAnswerFor, registerLeafContextNotify, registerLeafContextReturn, type PendingPeerQuestion \}/)
  assert.match(hook, /const marked = prompt\.startsWith\(PEER_PROMPT_PREFIX\) \? prompt : `\$\{PEER_PROMPT_PREFIX\}\$\{prompt\}`/)
  // The label alone is not enough. A peer turn typed into the input reaches the
  // turn boundary with no origin, and that path opens "The user sent a new
  // message while you were working" and closes "you MUST address the user's
  // message above" - the marker would survive as text inside a frame that has
  // already called it the person's. Carrying the peer origin is what makes the
  // framing agree with the label, so both are asserted together.
  assert.match(hook, /enqueue\(\{[\s\S]{0,260}origin: \{ kind: 'gateway-peer' \}/)
  assert.match(hook, /enqueue\(\{[\s\S]{0,200}isMeta: true/)
  assert.doesNotMatch(hook, /writeLeafInput/)
  assert.doesNotMatch(hook, /PASTE_START/)
  // The up-path and the root's receiver already mark their turns; the marker
  // must not regress into an unmarked user turn on either side.
  assert.match(hook, /isMeta: true,[\s\S]{0,40}origin: \{ kind: 'task-notification' \}/)
  // A leaf's report to the root is marked too. Both wires share the bus origin
  // and the text is what separates them, so a report left unmarked would render
  // as something the operator typed.
  assert.match(hook, /const content = `\$\{PEER_PROMPT_PREFIX\}Message from Leaf /)
})

test('session comms resolves leaf references before falling back to peers', async () => {
  const source = await readFile(new URL('../src/commands/gateway-sessions.ts', import.meta.url), 'utf8')
  assert.match(source, /resolveLeafRef\(target\)/)
  assert.match(source, /sendLeafMessage\(leaf\.sessionId, send\[2\]!\)/)
  // The peer branch goes through the same resolver SendMessage uses, so both
  // entry points accept a name and both refuse an ambiguous one. The raw
  // transport call here accepted only an exact ID and turned a lookup miss into
  // a generic failure, which is why the two paths taught different addressing.
  assert.match(source, /const \{ sendViaGatewayPeer \} = await import\('\.\.\/utils\/gatewayPeerSend\.js'\)/)
  assert.match(source, /sendViaGatewayPeer\(target, send\[2\]!, send\[2\]!\.slice\(0, 200\)\)/)
})

test('a leaf-shaped address is never retargeted at an unrelated live session', async () => {
  // The reported bug: a message addressed to a leaf could land on whatever
  // session happened to answer to the same string. Peer addressing is UUID-only,
  // so a reference that is not a UUID can only mean a family member, and a
  // failure to resolve it must be refused rather than re-pointed at the bus.
  assert.equal(leafFamilyReference('1'), true)
  assert.equal(leafFamilyReference('2:api hardening'), true)
  assert.equal(leafFamilyReference('fork'), true)
  assert.equal(leafFamilyReference('original'), true)
  assert.equal(leafFamilyReference('11111111-1111-4111-8111-111111111111'), false)
  assert.equal(leafFamilyReference('  11111111-1111-4111-8111-111111111111  '), false)
  assert.equal(leafFamilyReference(''), false)

  const source = await readFile(new URL('../src/commands/gateway-sessions.ts', import.meta.url), 'utf8')
  // A swallowed family read must not fall through to the peer bus.
  assert.match(source, /catch\(error => \{\s*if \(leafFamilyReference\(target\)\) throw error/)
  assert.match(source, /else if \(leafFamilyReference\(target\)\) throw new Error\(`No leaf in this family matches/)
  // The peer transport is reached only for a non-leaf-shaped (session ID)
  // address, and through the shared resolver rather than a raw send.
  assert.match(source, /sendViaGatewayPeer\(target, send\[2\]!, send\[2\]!\.slice\(0, 200\)\)/)
  assert.match(source, /outcome\.ok\) throw new Error\(outcome\.message\)/)
})

test('siblings stay mutually visible: state changes republish the family to every leaf', async () => {
  const source = await readFile(new URL('../src/utils/leafWorkspace.ts', import.meta.url), 'utf8')
  // Every idle/running transition republishes, so a leaf sees what its
  // siblings are doing without polling and without a parent turn. The handler
  // also reports a finished turn's reply before republishing.
  assert.match(source, /onState: \(\) => \{[\s\S]{0,200}publish\(\)/)
  assert.match(source, /if \(current && child\.getState\(\) === 'idle'\) void reportLeafReplies\(current, child\)/)
  assert.match(source, /view\.process\.snapshot\(snapshot\)/)
  // A leaf reads the pushed family (not its own empty view map) and can list it.
  assert.match(source, /if \(isInteractiveLeaf\(\)\) return \(getLeafSnapshot\(\)\?\.members \?\? \[\]\)/)
  // Sibling control goes back through the parent, which owns the child handles.
  assert.match(source, /requestLeafWorkspace<string>\('send', \[member\.sessionId, message\]\)/)
  assert.match(source, /requestLeafWorkspace<string>\('interrupt', \[member\.sessionId\]\)/)
})

test('session comms reports the real failure instead of hiding it', async () => {
  // A blanket catch here made "peer unavailable", a wrong address and an
  // oversized message indistinguishable, so a broken surface could not be told
  // apart from a dead peer.
  const source = await readFile(new URL('../src/commands/gateway-sessions.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /catch\s*\{\s*onDone\('Session operation failed/)
  assert.match(source, /Session operation failed: \$\{reason\}/)

  const transport = await readFile(new URL('../src/utils/gatewaySessionTransport.ts', import.meta.url), 'utf8')
  // An unregistered session is an ordinary "not live", not a raw ENOENT that
  // leaks a config path and reads like a transport bug.
  assert.match(transport, /No live session \$\{sessionId\}; run \/sessions list/)
  assert.match(transport, /No live session/)
})

test('the Leaf tool is registered so agents can see and drive their leaves', async () => {
  const registry = await readFile(new URL('../src/tools.ts', import.meta.url), 'utf8')
  assert.match(registry, /const getLeafTool = \(\)/)
  assert.match(registry, /getLeafTool\(\),/)
  const { LeafTool } = await import('../src/tools/LeafTool/LeafTool.ts')
  assert.equal(LeafTool.name, 'Leaf')
  const actions = LeafTool.inputSchema.shape.action.options
  for (const action of ['list', 'fork', 'new', 'send', 'interrupt', 'checkpoint', 'close', 'model', 'effort', 'return', 'notify', 'roster', 'reparent']) {
    assert.ok(actions.includes(action), `the Leaf tool must expose ${action}`)
  }
  assert.equal(LeafTool.inputSchema.safeParse({ action: 'shutdown' }).success, false)
})

test('a leaf can reach its parent, not only its siblings', async () => {
  const workspace = await readFile(new URL('../src/utils/leafWorkspace.ts', import.meta.url), 'utf8')
  // The root is a nameable target inside a leaf, so `send original ...` reports
  // up instead of failing to resolve a member that is not in the family list.
  assert.match(workspace, /export function rootReference\(reference: string\)/)
  assert.match(workspace, /ref === 'parent'/)
  assert.match(workspace, /if \(isInteractiveLeaf\(\) && rootReference\(reference\)\) return notifyLeafParent\(message\)/)
  assert.match(workspace, /export async function notifyLeafParent/)
  assert.match(workspace, /case 'notify': \{/)

  const tool = await readFile(new URL('../src/tools/LeafTool/LeafTool.ts', import.meta.url), 'utf8')
  assert.match(tool, /return workspace\.notifyLeafParent\(input\.message\)/)
  // The prompt must state the symmetry, or a leaf never tries it.
  const prompt = await readFile(new URL('../src/tools/LeafTool/prompt.ts', import.meta.url), 'utf8')
  assert.match(prompt, /notify: available inside a leaf only/)
  assert.match(prompt, /Everyone in the family sees everyone else/)
  // The root registers the receiving end; without it notify has nowhere to land.
  const hook = await readFile(new URL('../src/hooks/useLeafTerminalSession.ts', import.meta.url), 'utf8')
  assert.match(hook, /registerLeafContextNotify/)
})

test('roster is the verb that names the parent, and the prompt says so', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaf-roster-'))
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  try {
    const { getSessionId } = await import('../src/bootstrap/state.ts')
    const { getClaudeConfigHomeDir } = await import('../src/utils/envUtils.ts')
    const { addLeafMember } = await import('../src/utils/leafFamily.ts')
    const { listLeaves, familyRoster } = await import('../src/utils/leafWorkspace.ts')
    const root = getSessionId()
    await addLeafMember(join(getClaudeConfigHomeDir(), 'leaf-families', `${root}.json`), root, {
      sessionId: randomUUID(), parentSessionId: root, name: 'Child', transcriptPath: join(directory, 'child.jsonl'), forkMessageId: randomUUID(),
    })
    // The prompt promises a leaf can reach its parent. Only `roster` names the
    // family - so the promise is only true if the prompt points at `roster`.
    assert.match(await familyRoster(), new RegExp(`^family ${root}$`, 'm'))
    assert.doesNotMatch(await listLeaves(), /^family /m)

    const prompt = await readFile(new URL('../src/tools/LeafTool/prompt.ts', import.meta.url), 'utf8')
    // Assert the claims, not the backtick escaping: what matters is that the
    // verb is documented as the family view, that it is named as the way to
    // reach the parent, and that it is told apart from `list`.
    assert.match(prompt, /roster: the family view/)
    assert.match(prompt, /\[parent\]/)
    assert.match(prompt, /roster.*shows it its parent|\\`roster\\` shows it its parent/)
    assert.match(prompt, /\\`list\\` shows the same members/)
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    await rm(directory, { recursive: true, force: true })
  }
})

test('opening is the only thing that starts a leaf process', async () => {
  const workspace = await readFile(new URL('../src/utils/leafWorkspace.ts', import.meta.url), 'utf8')
  const restore = workspace.slice(workspace.indexOf('export async function restoreLeafWorkspace'), workspace.indexOf('export async function openLeaf'))
  // Restore rebuilds the roster for the UI. If it launches, every mount and
  // every session switch spawns a process per open member - the background-chat
  // bug - so this must stay free of launch calls.
  assert.doesNotMatch(restore, /launch\(/)
  assert.match(restore, /await readLeafFamily\(familyPath\(root\), root\)/)
  assert.match(restore, /publish\(\)/)

  const open = workspace.slice(workspace.indexOf('export async function openLeaf'), workspace.indexOf('export async function openLeafOnce'))
  assert.match(open, /await changeLeaf\(member\.sessionId, \{ status: 'open' \}\)/)
  // changeLeaf launches on status 'open'; a second launch here would double it.
  assert.doesNotMatch(open, /await launch\(/)
  assert.match(open, /selectLeaf\(member\.sessionId\)/)
})

test('an archived leaf can be read, revived, and run without unfiling it', async () => {
  const dialog = await readFile(new URL('../src/components/LeafWorkspaceDialog.tsx', import.meta.url), 'utf8')
  // The archive screen is reachable from both menus a person looks in: the home
  // menu, and the family list where a missing leaf sends them.
  assert.match(dialog, /if \(screen === 'archives'\)/)
  assert.equal(dialog.match(/\{ value: 'archives', label: 'Archived leaves'/g)?.length, 2)
  // Three verbs, and each one is offered for an archived member by id.
  assert.match(dialog, /value: `revive:\$\{member\.sessionId\}`/)
  assert.match(dialog, /value: `open-once:\$\{member\.sessionId\}`/)
  assert.match(dialog, /value: `view:\$\{member\.sessionId\}`/)
  // Viewing reads the saved transcript and starts nothing.
  assert.match(dialog, /const \{ loadTranscriptFromFile \} = await import\('\.\.\/utils\/sessionStorage\.js'\)/)
  assert.match(dialog, /<SessionPreview/)
  assert.doesNotMatch(dialog, /\bunlink\b|\brmSync\b|\brm\(/)

  const workspace = await readFile(new URL('../src/utils/leafWorkspace.ts', import.meta.url), 'utf8')
  // Open once launches and selects, and writes no status at all: that is what
  // leaves the leaf archived, and what files it back when its process exits.
  const once = workspace.slice(workspace.indexOf('export async function openLeafOnce'), workspace.indexOf('export async function reviveLeaf'))
  assert.match(once, /await launch\(member, root\)/)
  assert.match(once, /selectLeaf\(member\.sessionId\)/)
  assert.doesNotMatch(once, /changeLeaf|updateLeafMember/)
  // Reviving is the opposite trade: back on the list, still closed, never started.
  const revive = workspace.slice(workspace.indexOf('export async function reviveLeaf'), workspace.indexOf('export async function changeLeaf'))
  assert.match(revive, /await changeLeaf\(member\.sessionId, \{ status: 'closed' \}\)/)
  assert.doesNotMatch(revive, /launch\(/)
  // Both work from a leaf, which reaches the family through the session hosting it.
  assert.match(once, /requestLeafWorkspace<string>\('open-once'/)
  assert.match(workspace, /case 'open-once': result = await openLeafOnce\(String\(id\)\); break/)
})

test('a leaf can fork itself, which it cannot checkpoint while it asks', async () => {
  const workspace = await readFile(new URL('../src/utils/leafWorkspace.ts', import.meta.url), 'utf8')
  const create = workspace.slice(workspace.indexOf('export async function createLeaf'), workspace.indexOf('let hostRelease'))
  // A mid-turn member refuses a checkpoint of its own turn, so a self-fork asked
  // for one and came back as an opaque failure. Only the asking leaf is skipped:
  // any other busy source is still a legible refusal.
  assert.match(create, /const selfFork = parent\?\.member\.sessionId === options\.requestedBy/)
  assert.match(create, /if \(parent && !options\.fresh && !selfFork\) await parent\.process\.checkpoint\(\)/)
  // The host knows which leaf asked from the request itself, not from a guess.
  assert.match(workspace, /requestedBy: sourceId/)
  // A fork copies a transcript FILE, and the host cannot flush another process's
  // queue, so the asking leaf lands its own writes before it asks.
  const relay = create.slice(create.indexOf('if (isInteractiveLeaf())'), create.indexOf('const self = getSessionId()'))
  const flushed = relay.indexOf('await flushSessionStorage()')
  assert.ok(flushed >= 0, 'the relay has to flush its own storage first')
  assert.ok(flushed < relay.indexOf("requestLeafWorkspace<LeafMember>('create'"), 'the flush precedes the request')
  // The leaf hosts no children, so the row for the leaf it just made is built
  // from the reply. Looking it up in the roster instead handed the menu an
  // undefined view, and the create reported a failure for a leaf that existed.
  assert.match(relay, /return \{\s*rootSessionId: familyRootSync\(\), member, draft: member\.draft \?\? ''/)
  assert.doesNotMatch(relay, /return getLeafViews\(\)\.find/)
})

test('a leaf menu shows filed-away leaves, which its own snapshot cannot', async () => {
  const workspace = await readFile(new URL('../src/utils/leafWorkspace.ts', import.meta.url), 'utf8')
  const list = workspace.slice(workspace.indexOf('export async function listLeafMembers'), workspace.indexOf('export async function resolveLeafRef'))
  // The snapshot a leaf holds is the live roster: it carries no process-less
  // member, so an archived leaf is missing from it. The family file is the
  // roster; the snapshot is only the fallback when the host is gone.
  assert.match(list, /requestLeafWorkspace<LeafMember\[\]>\('members'\)/)
  assert.match(list, /catch \{ return \(getLeafSnapshot\(\)\?\.members \?\? \[\]\)\.map\(entry => entry\.member\) \}/)
  // The host answers from the family file directly, never by relaying: a leaf
  // hosting its own family would otherwise send the question back to the
  // session it hosts, and the two would volley it until both timed out.
  assert.match(workspace, /case 'members': result = \(await currentFamily\(\)\)\.members; break/)
  // The roster is complete, asker included: a leaf forks itself from its own
  // menu, so it has to find itself in the list the wizard offers.
  assert.doesNotMatch(workspace, /case 'members': result = \(await currentFamily\(\)\)\.members\.filter/)
})

test('a leaf menu acts on the family, never on the session holding it', async () => {
  const dialog = await readFile(new URL('../src/components/LeafWorkspaceDialog.tsx', import.meta.url), 'utf8')
  // The roster a leaf reads is the family file, and a leaf is in it. Rows for
  // the session on screen would close or archive the process drawing the menu,
  // so that one is dropped from the rows - the same rule the host applies to
  // itself when it lists its own family.
  assert.match(dialog, /const self = selectedLeafId\(\)/)
  assert.match(dialog, /member\.status !== 'archived' && member\.sessionId !== self/)
  // A missing row is confusing on its own, so which session is on screen is
  // said out loud instead.
  assert.ok(dialog.includes('These rows act on the rest of the family'), 'the self row is named, not just dropped')
})

test('a refusal a leaf cannot read is a refusal it cannot act on', async () => {
  // The session that owns the family sends the reason...
  const workspace = await readFile(new URL('../src/utils/leafWorkspace.ts', import.meta.url), 'utf8')
  assert.match(workspace, /const reason = error instanceof Error \? error\.message\.replace\(/)
  assert.match(workspace, /\.trim\(\)\.slice\(0, 300\)/)
  assert.match(workspace, /ok: false, value: reason \|\| undefined/)
  // ...and the asking leaf reports it, keeping the old line for a bare refusal.
  const terminal = await readFile(new URL('../src/utils/leafTerminal.ts', import.meta.url), 'utf8')
  assert.match(terminal, /`Leaf workspace action failed: \$\{message\.value\.trim\(\)\.slice\(0, 300\)\}`/)
  assert.match(terminal, /'Leaf workspace action failed; saved sessions are retained'/)
})

test('the fork source rule picks the session on screen, and only names a member when told to', () => {
  const CREATOR = 'creator-session'
  const PARENT = 'parent-session'
  const SELF = 'self-session'
  const LEAF = 'leaf-session'
  const family = { creator: CREATOR, parent: PARENT, self: SELF }
  // The reported bug: with a leaf on screen, a bare fork copied the conversation
  // behind it and silently discarded the leaf's context.
  assert.equal(resolveLeafSource(undefined, family, LEAF), LEAF)
  // With nothing selected the source is the session asking. From a member that
  // is the member itself, not the family's creator.
  assert.equal(resolveLeafSource(undefined, family, undefined), SELF)
  // Naming a family member forces that one, even with a leaf selected - and the
  // family's creator and its designated parent are different members.
  assert.equal(resolveLeafSource('original', family, LEAF), CREATOR)
  assert.equal(resolveLeafSource('root', family, LEAF), PARENT)
  assert.equal(resolveLeafSource('parent', family, LEAF), PARENT)
  assert.equal(resolveLeafSource('  original  ', family, LEAF), CREATOR)
  // An explicit session ID wins over the selection.
  assert.equal(resolveLeafSource('other-session', family, LEAF), 'other-session')
})

test('creating a leaf forks what you are looking at, not the root behind it', async () => {
  const workspace = await readFile(new URL('../src/utils/leafWorkspace.ts', import.meta.url), 'utf8')
  const create = workspace.slice(workspace.indexOf('export async function createLeaf'), workspace.indexOf('/**\n * Rebuild the in-memory view'))
  assert.match(create, /const resolvedParentId = resolveLeafSource\(parentSessionId, \{ creator: root, parent: getLeafParentSessionId\(\), self \}, selectedLeafId\(\)\)/)
  // The session asking is the source when nothing else is named, so a member
  // opens new leaves from itself rather than from the conversation behind it.
  assert.match(create, /const fromSelf = resolvedParentId === self/)
  assert.match(create, /parentSessionId: parent\?\.member\.sessionId \?\? resolvedParentId/)
  // The resolved id, not the raw argument, seeds the fork and the fallback.
  assert.match(create, /getTranscriptPathForSession\(resolvedParentId\)/)
  assert.match(create, /source = \{ sessionId: resolvedParentId, transcriptPath \}/)
})

test('every member can name the conversation the family was forked from', () => {
  assert.equal(rootReference('original'), true)
  assert.equal(rootReference('root'), true)
  assert.equal(rootReference('parent'), true)
  assert.equal(rootReference('ROOT'), true)
  assert.equal(rootReference('  parent  '), true)
  // A leaf name must not be swallowed by the root aliases.
  assert.equal(rootReference('2'), false)
  assert.equal(rootReference('api'), false)
  assert.equal(rootReference(''), false)
})

test('the leaf menu names choices by goal and keeps the arg grammar as passthrough', async () => {
  const dialog = await readFile(new URL('../src/components/LeafWorkspaceDialog.tsx', import.meta.url), 'utf8')
  assert.match(dialog, /export function LeafMenu/)
  assert.match(dialog, /export function LeafCreateWizard/)
  // Every field the request called out is editable before the single confirm.
  for (const field of ['Name', 'Worktree', 'Goal', 'Model', 'Effort', 'Create leaf']) {
    assert.ok(dialog.includes(field), `the create wizard must offer ${field}`)
  }
  assert.match(dialog, /const \[fresh, setFresh\] = useState\(false\)/)
  assert.match(dialog, /setScreen\('create'\)/)

  const command = await readFile(new URL('../src/commands/leaf.tsx', import.meta.url), 'utf8')
  // Bare `/leaf` is the menu; `/leaf <args>` still hits the grammar.
  assert.match(command, /const \{ LeafMenu \} = await import\('\.\.\/components\/LeafWorkspaceDialog\.js'\)/)
  assert.match(command, /return <LeafMenu onDone=/)
  assert.doesNotMatch(command, /LeafCreateMenu/)
})

test('the bottom nav reaches the leaf menu, and the prompt overlay is what shows it', async () => {
  // The carousel lives in the layout, below the prompt, so it cannot render the
  // menu where it sits - the menu is an overlay that has to escape the bottom
  // slot's clip. It asks for the menu by name and the prompt opens it.
  const dialog = await readFile(new URL('../src/components/LeafWorkspaceDialog.tsx', import.meta.url), 'utf8')
  assert.match(dialog, /onManage \?\? requestLeafMenu/)
  assert.match(dialog, /Manage leaves/)

  const prompt = await readFile(new URL('../src/components/PromptInput/PromptInput.tsx', import.meta.url), 'utf8')
  assert.match(prompt, /subscribeLeafMenuRequest\(\(\) => setShowLeafMenu\(true\)\)/)
  assert.match(prompt, /const leafMenuDialog = showLeafMenu \? <LeafMenu onDone/)
  // Composed into the same portal as the other prompt dialogs, so it floats
  // above the prompt instead of being cropped to a row by the bottom slot.
  assert.match(prompt, /const promptOverlayDialog = gatewaySessionsDialog \?\? leafMenuDialog \?\? sessionMetadataDialog \?\? autoModeOptInDialog/)
  // Escape inside the menu must not reach the double-press message selector.
  assert.match(prompt, /showGatewaySessions \|\| showLeafMenu \|\| isLocalJSXCommandActive/)
  assert.match(prompt, /if \(showLeafMenu && !isFullscreenEnvEnabled\(\)\) return leafMenuDialog/)
})

test('the family outlives its parent: any member can find and reopen the rest', async () => {
  const workspace = await readFile(new URL('../src/utils/leafWorkspace.ts', import.meta.url), 'utf8')
  // A member's own pointer is what makes membership survive the parent process:
  // the family file is keyed by the root's id, which only the root can know.
  assert.ok(workspace.includes('type LeafFamilyPointer = { rootSessionId: string; rootName?: string; rootTranscriptPath?: string; rootCwd?: string; parentSessionId?: string }'))
  assert.match(workspace, /export async function familyRootSessionId\(\): Promise<string>/)
  assert.match(workspace, /await access\(familyPath\(pointer\.rootSessionId\)\)/)
  assert.match(workspace, /export function familyRootSync\(\): string/)
  assert.match(workspace, /export function forgetLeafFamilyRoot\(\): void/)
  // The root's own process is the only writer, because only it knows where its
  // transcript lives and which directory to resume it in.
  assert.match(workspace, /async function writeLeafFamilyPointer\(sessionId: string, pointer: LeafFamilyPointer\)/)
  assert.match(workspace, /await indexLeafMembers\(root, members\)/)
  assert.match(workspace, /function rootPointerInfo\(root: string\): LeafFamilyPointer/)

  // The creator is an ordinary row now, written by whichever session opens the
  // family, and found rather than synthesized.
  assert.match(workspace, /export async function leafCreatorMember\(\): Promise<LeafMember \| undefined>/)
  assert.match(workspace, /if \(root === getSessionId\(\)\) return undefined/)
  assert.match(workspace, /export async function leafParentMember\(\): Promise<LeafMember \| undefined>/)
  // Real members answer before the aliases do, and the aliases split: the
  // family's creator is not necessarily the member designated as its parent.
  assert.match(workspace, /const direct = resolveLeafMember\(members, reference\)/)
  assert.match(workspace, /if \(ref === 'original'\) return leafCreatorMember\(\)/)
  assert.match(workspace, /if \(ref === 'parent' \|\| ref === 'root'\) return leafParentMember\(\)/)
  assert.match(workspace, /await ensureCreatorMember\(familyPath\(root\), root, \{/)
  assert.match(workspace, /const members = await ensureCreatorRow\(root, family\.members\)/)
  // A member with a fork point is always resumed; the creator is resumed when
  // its transcript holds a turn, so starting it under `--session-id` cannot
  // shadow the real conversation with an empty one.
  assert.match(workspace, /let hasTranscript = member\.forkMessageId !== null/)
  assert.match(workspace, /function leafSelfLabel\(member: LeafMember, rootSessionId: string\): string/)

  // The creator is closed, reopened and renamed like any member; only the
  // session doing the asking is refused.
  assert.doesNotMatch(workspace, /changeParent/)
  assert.match(workspace, /That is the session you are in; it ends when you leave it/)
  // Reopening it from a member must not put two writers on one transcript.
  assert.match(workspace, /await claimHostOwnership\(\)/)
  assert.match(workspace, /is already open in another window; close it there before opening it here/)
  // Every member is a leaf, the creator included, so the bar and the roster are
  // the same list.
  assert.match(workspace, /export function getLeafCarouselViews\(\): LeafView\[\]/)
  assert.match(workspace, /return \[\.\.\.views\.values\(\)\]\.filter\(view => view\.rootSessionId === root\)/)
  assert.match(workspace, /export function getLeafHostName\(\): string/)
  assert.match(workspace, /return \(await currentFamily\(\)\)\.members\.filter\(member => member\.sessionId !== self\)/)
})

test('every member is an entry point, and the doctrine says so', async () => {
  const prompt = await readFile(new URL('../src/tools/LeafTool/prompt.ts', import.meta.url), 'utf8')
  // The tool used to describe the family as forks of one session and treat the
  // root as fixed. Neither is true now: the family id is historical, the parent
  // is a designation that can move, and any member opens on its own.
  assert.doesNotMatch(prompt, /forked from this one/)
  assert.match(prompt, /cc --resume <session id>/)
  assert.match(prompt, /reparent: make another member the family's parent/)
  assert.match(prompt, /The family id is the session the family was created from/)
  assert.match(prompt, /\\`original\\` names the member the family was created from/)
  assert.match(prompt, /\\`parent\\` and \\`root\\` name the member designated as its parent/)
  assert.match(prompt, /DESCRIPTION = 'See, talk to, and drive the leaf sessions in this family\.'/)

  // The menu hands out the command that opens each member from anywhere. It is
  // a read, not management, so a window that was displaced still offers it.
  const dialog = await readFile(new URL('../src/components/LeafWorkspaceDialog.tsx', import.meta.url), 'utf8')
  assert.match(dialog, /label: `Enter #\$\{member\.number\} \$\{member\.name\} from a terminal`/)
  assert.match(dialog, /description: `cc --resume \$\{member\.sessionId\}`/)
  assert.match(dialog, /if \(action === 'resume'\) \{ setNotice\(`To enter \$\{describeSession\(member\)\} from another terminal, run: cc --resume \$\{id\}`\); return \}/)
  // Asking for the address starts nothing: running it elsewhere is the person's
  // to do, and a session that opened on its own has no terminal to give.
  const resumeBranch = dialog.slice(dialog.indexOf("if (action === 'resume')"), dialog.indexOf('void run(', dialog.indexOf("if (action === 'resume')")))
  assert.doesNotMatch(resumeBranch, /openLeaf|openLeafOnce|createLeaf|changeLeaf/)

  // The peer skill carries the same model: a member is addressable by its own
  // session id, and the parent is a designation rather than an address.
  const peers = await readFile(new URL('../src/skills/bundled/gatewayPeers.ts', import.meta.url), 'utf8')
  assert.match(peers, /which member is the parent is a designation that can move/)
  assert.match(peers, /never assume the session a family was created from is the one that owns the rest/)
})

test('the leaf menu treats the parent as an ordinary member', async () => {
  const dialog = await readFile(new URL('../src/components/LeafWorkspaceDialog.tsx', import.meta.url), 'utf8')
  // The creator has a row like every other member, so there is no second path
  // for it: one set of open/close/archive rows covers the whole family.
  assert.doesNotMatch(dialog, /leafParentMember/)
  assert.doesNotMatch(dialog, /leafParentIsOpen/)
  assert.match(dialog, /const open = members\?\.filter\(member => member\.status !== 'archived' && member\.sessionId !== self\) \?\? \[\]/)
  assert.match(dialog, /label: `Open  #\$\{member\.number\} \$\{member\.name\}`/)
  assert.match(dialog, /label: `Archive #\$\{member\.number\} \$\{member\.name\}`/)
  assert.match(dialog, /describeSession/)
  // The bar's first entry is the session on screen, which is not always the root.
  assert.match(dialog, /label: getLeafHostName\(\)/)
  assert.match(dialog, /views=\{getLeafCarouselViews\(\)\}/)
})

test('archive detaches a leaf without deleting anything', async () => {
  const dialog = await readFile(new URL('../src/components/LeafWorkspaceDialog.tsx', import.meta.url), 'utf8')
  // Archiving is detach, not delete: it must reach for the archived status and
  // must never remove the transcript or the session.
  assert.match(dialog, /status: action === 'archive' \? 'archived' : 'closed'/)
  assert.match(dialog, /Archive #\$\{member\.number\} \$\{member\.name\}/)
  // Detach must not become delete: no file removal anywhere in the menu.
  assert.doesNotMatch(dialog, /\bunlink\b|\brmSync\b|\brm\(/)
  // An archived leaf leaves the menu, which is what "detached" means here. The
  // wizard's fork-source list also drops the designated parent, which has the
  // first row to itself and would otherwise appear twice.
  assert.match(dialog, /members\?\.filter\(member => member\.status !== 'archived' && member\.sessionId !== self\)/)
  assert.match(dialog, /\(members \?\? \[\]\)\.filter\(member => member\.status !== 'archived' && member\.sessionId !== parentId\)/)

  // The engine path already releases the process and the owner claim, keeps the
  // family file entry, and drops it from the live views the carousel reads.
  const workspace = await readFile(new URL('../src/utils/leafWorkspace.ts', import.meta.url), 'utf8')
  const change = workspace.slice(workspace.indexOf('export async function changeLeaf'), workspace.indexOf('export async function fileLeaf'))
  assert.match(change, /await saveLeafDraft\(view\)/)
  assert.match(change, /await view\.process\.close\(\)/)
  assert.match(change, /await ownerReleases\.get\(sessionId\)\?\.\(\)/)
  assert.match(change, /views\.delete\(sessionId\)/)
  assert.doesNotMatch(change, /unlink|rm\(/)

  // The grammar accepts it with a leaf reference, and the hint says so.
  const command = await readFile(new URL('../src/commands/leaf.tsx', import.meta.url), 'utf8')
  assert.match(command, /archive <leaf>/)
  assert.match(command, /\|archive\|promote/)
})
