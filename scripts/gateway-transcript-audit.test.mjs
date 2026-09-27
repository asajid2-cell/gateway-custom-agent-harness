import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const auditScript = path.join(root, 'scripts', 'gateway-transcript-audit.mjs')

function runAudit(cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [auditScript, '--root', cwd, '--all-cwds'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', code => {
      if (code !== 0) reject(new Error(stderr || `audit exited ${code}`))
      else resolve(JSON.parse(stdout))
    })
  })
}

test('transcript audit classifies deterministic failures and retries without exposing input', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'gateway-transcript-audit-'))
  try {
    const use = (id, name, input) => JSON.stringify({
      type: 'assistant',
      timestamp: '2099-01-01T00:00:00.000Z',
      cwd: 'C:\\Users\\Ahmed',
      message: { content: [{ type: 'tool_use', id, name, input }] },
    })
    const result = (id, content) => JSON.stringify({
      type: 'user',
      timestamp: '2099-01-01T00:00:00.100Z',
      cwd: 'C:\\Users\\Ahmed',
      message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content }] },
    })
    await writeFile(path.join(temp, 'fixture.jsonl'), [
      use('a1', 'Agent', { isolation: 'worktree', prompt: 'secret prompt' }),
      result('a1', 'Cannot create agent worktree: not in a git repository'),
      use('a2', 'Agent', { isolation: 'worktree', prompt: 'secret prompt' }),
      result('a2', 'Cannot create agent worktree: not in a git repository'),
      use('r1', 'Read', { pages: '' }),
      result('r1', '<tool_use_error>Invalid pages parameter: ""</tool_use_error>'),
      use('a3', 'Agent', { prompt: 'another secret prompt' }),
      result('a3', 'API Error: 400 {"type":"error","error":{"type":"api_error","message":"Codex returned HTTP 400"}}'),
      JSON.stringify({
        type: 'user',
        timestamp: '2099-01-01T00:00:00.100Z',
        cwd: 'C:\\Users\\Ahmed',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'successful',
            content: 'The command inspected an error-handling branch and completed successfully.',
          }],
        },
      }),
    ].join('\n') + '\n')

    const report = await runAudit(temp)
    assert.equal(report.aggregate.agentCalls, 3)
    assert.equal(report.aggregate.agentFailures, 3)
    assert.equal(report.aggregate.retriesAfterFailure, 1)
    assert.deepEqual(report.aggregate.errorCategories, [
      { key: 'worktree-unavailable', count: 2 },
      { key: 'gateway-upstream-error', count: 1 },
      { key: 'invalid-input', count: 1 },
    ])
    assert.equal(report.files[0].repeatedFailureSignatures.length, 1)
    assert.equal(JSON.stringify(report).includes('secret prompt'), false)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
