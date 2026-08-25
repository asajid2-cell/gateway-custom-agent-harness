import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'cc.ps1',
)

test('interactive cc launches the harness without a PowerShell output pipeline', async () => {
  const script = await readFile(scriptPath, 'utf8')
  assert.equal(
    /& \$ClaudeRunner \$ClaudeScript @ClaudeArgs\s+2>&1\s*\|/.test(script),
    false,
    'interactive harness output must not be piped through PowerShell',
  )
  assert.match(
    script,
    /# Keep the harness attached directly to the caller's console/,
  )
  assert.match(
    script,
    /\$ExitCode -ne 0[\s\S]*\$ExitCode -ne 130/,
    'resumed sessions should have one bounded non-zero-exit recovery attempt',
  )
  assert.equal(script.includes('Tee-Object -FilePath $ClaudeCrashLog'), false)
})

test('interactive cc skips the full build when the compiled harness is fresh', async () => {
  const script = await readFile(scriptPath, 'utf8')
  assert.match(script, /function Test-ClaudeArtifactFresh\s*\{[\s\S]*Get-ChildItem[\s\S]*LastWriteTimeUtc/)
  assert.match(
    script,
    /if \(-not \(Test-ClaudeArtifactFresh\)\) \{[\s\S]*& \$ClaudeRunner 'run' 'build'/,
    'the build must be conditional on artifact freshness',
  )
  assert.equal(
    /# The global cc launcher intentionally points at this worktree\. Rebuild before\s+# every launch/.test(script),
    false,
    'the launcher must not rebuild unconditionally',
  )
})
