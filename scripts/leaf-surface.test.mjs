import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { resolveLeafMember } from '../src/utils/leafFamily.ts'
import { parseForkRequest } from '../src/commands/leaf.tsx'

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
  assert.match(source, /const isLeaf = process\.env\.GATEWAY_INTERACTIVE_LEAF === '1'/)
  // Onboarding is a per-user dialog with no keyboard available in a leaf.
  assert.match(source, /if \(!isLeaf && \(!config\.theme \|\| !config\.hasCompletedOnboarding\)/)
  // Trust is inherited from the parent, never bypassed: the dialog is only
  // skipped when the parent recorded that this workspace was already accepted.
  assert.match(source, /const inheritsTrust = isLeaf && process\.env\.GATEWAY_LEAF_TRUSTED === '1'/)
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
  assert.match(processSource, /deliver\(text: string\): Promise<void>/)
  assert.match(processSource, /subtype: 'leaf_prompt'/)

  const terminalSource = await readFile(new URL('../src/utils/leafTerminal.ts', import.meta.url), 'utf8')
  assert.match(terminalSource, /export function writeLeafInput/)
  assert.match(terminalSource, /deliverInput = data =>/)
  assert.match(terminalSource, /\.resume\(\)/)

  const hookSource = await readFile(new URL('../src/hooks/useLeafTerminalSession.ts', import.meta.url), 'utf8')
  assert.match(hookSource, /case 'leaf_prompt':/)
  assert.match(hookSource, /writeLeafInput\(/)

  const workspaceSource = await readFile(new URL('../src/utils/leafWorkspace.ts', import.meta.url), 'utf8')
  assert.match(workspaceSource, /case 'send': result = await sendLeafMessage/)
  assert.match(workspaceSource, /case 'configure': result = await configureLeaf/)
  // A leaf reporting its own settings must not echo a control request back.
  assert.match(workspaceSource, /case 'settings': await saveLeafSettings/)
})

test('session comms resolves leaf references before falling back to peers', async () => {
  const source = await readFile(new URL('../src/commands/gateway-sessions.ts', import.meta.url), 'utf8')
  assert.match(source, /resolveLeafRef\(send\[1\]!\)/)
  assert.match(source, /sendLeafMessage\(leaf\.sessionId, send\[2\]!\)/)
  assert.match(source, /runtime\.transport\.send\(send\[1\]!/)
})

test('siblings stay mutually visible: state changes republish the family to every leaf', async () => {
  const source = await readFile(new URL('../src/utils/leafWorkspace.ts', import.meta.url), 'utf8')
  // Every idle/running transition republishes, so a leaf sees what its
  // siblings are doing without polling and without a parent turn.
  assert.match(source, /onState: publish/)
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
  for (const action of ['list', 'fork', 'new', 'send', 'interrupt', 'checkpoint', 'close', 'model', 'effort', 'return']) {
    assert.ok(actions.includes(action), `the Leaf tool must expose ${action}`)
  }
  assert.equal(LeafTool.inputSchema.safeParse({ action: 'shutdown' }).success, false)
})
