import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const [agentToolSource, worktreeSource, fileReadSource, ripgrepSource] =
  await Promise.all([
    readFile(new URL('../src/tools/AgentTool/AgentTool.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/utils/worktree.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/tools/FileReadTool/FileReadTool.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/utils/ripgrep.ts', import.meta.url), 'utf8'),
  ])

test('Agent worktree isolation is documented as unavailable outside a repo', () => {
  assert.match(agentToolSource, /function isWorktreeIsolationAvailable\(\)/)
  assert.match(agentToolSource, /schema = schema\.omit\(\{\s*isolation: true/)
  assert.match(agentToolSource, /Use "worktree" only when the current working directory is inside a git repository/)
  assert.match(agentToolSource, /otherwise omit isolation/)
  assert.match(worktreeSource, /This is terminal for isolation: "worktree" in this session/)
  assert.match(worktreeSource, /Re-invoke Agent without isolation/)
})

test('blank PDF pages are normalized to an omitted page range', () => {
  assert.match(fileReadSource, /\.preprocess\(/)
  assert.match(fileReadSource, /value\.trim\(\) \|\| undefined/)
})

test('external builds fall back to a system ripgrep executable', () => {
  assert.match(ripgrepSource, /External builds do not always ship the vendored binary/)
  assert.match(ripgrepSource, /findExecutable\('rg', \[\]\)/)
})
