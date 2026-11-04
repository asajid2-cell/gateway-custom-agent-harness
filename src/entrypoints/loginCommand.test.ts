import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { runLoginCommand } from './loginCommand.js'

// Host-independent: a scratch config dir holds the vault, and the ACL pass is
// skipped (the bundled vault tests cover it).
process.env.NODE_ENV = 'test'
process.env.KEYSAFE_SKIP_ACL = '1'

function streamOf(text: string): AsyncIterable<Buffer> {
  return (async function* () {
    yield Buffer.from(text)
  })()
}

async function withScratch(fn: (dir: string) => Promise<void>): Promise<void> {
  const previous = {
    config: process.env.CLAUDE_CONFIG_DIR,
    mode: process.env.GATEWAY_CREDENTIALS_MODE,
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'login-command-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  delete process.env.GATEWAY_CREDENTIALS_MODE
  try {
    await fn(dir)
  } finally {
    if (previous.config === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous.config
    if (previous.mode === undefined) delete process.env.GATEWAY_CREDENTIALS_MODE
    else process.env.GATEWAY_CREDENTIALS_MODE = previous.mode
    await rm(dir, { recursive: true, force: true })
  }
}

test('--key-stdin saves through the bundled vault without printing the key', async () => {
  await withScratch(async dir => {
    const output: string[] = []
    const warnings: string[] = []
    const original = console.log
    const originalError = console.error
    console.log = (line: unknown) => {
      output.push(String(line))
    }
    console.error = (line: unknown) => {
      warnings.push(String(line))
    }
    try {
      const code = await runLoginCommand(['--provider', 'opencode', '--key-stdin'], {
        stdin: streamOf('sk-sentinel-opencode\n'),
      })
      assert.equal(code, 0)
    } finally {
      console.log = original
      console.error = originalError
    }
    // The operator is told which master-key backend actually holds the key.
    assert.match(
      output.join('\n'),
      /^saved opencode-go in the bundled vault \(backend (dpapi|keychain|libsecret|file)\)$/m,
    )
    // Nothing about the key may reach either stream.
    assert.equal(warnings.join('\n').includes('sk-sentinel-opencode'), false)
    assert.equal(output.join('\n').includes('sk-sentinel-opencode'), false)

    const vault = path.join(dir, 'keysafe')
    const entries = await readdir(vault)
    assert.ok(entries.includes('opencode-go.json'))
    const raw = await readFile(path.join(vault, 'opencode-go.json'), 'utf8')
    assert.equal(raw.includes('sk-sentinel-opencode'), false)
  })
})

test('--slot chooses a numbered record and --slot 1 is the base name', async () => {
  await withScratch(async dir => {
    assert.equal(
      await runLoginCommand(['--provider', 'commandcode', '--slot', '1', '--key-stdin'], {
        stdin: streamOf('cc-one'),
      }),
      0,
    )
    assert.equal(
      await runLoginCommand(['--provider', 'commandcode', '--slot=3', '--key-stdin'], {
        stdin: streamOf('cc-three'),
      }),
      0,
    )
    const entries = await readdir(path.join(dir, 'keysafe'))
    assert.ok(entries.includes('commandcode.json'))
    assert.ok(entries.includes('commandcode3.json'))
    assert.equal(entries.includes('commandcode1.json'), false)
  })
})

test('unknown providers and slots are refused', async () => {
  await withScratch(async () => {
    assert.equal(await runLoginCommand(['--provider', 'nope', '--key-stdin'], { stdin: streamOf('x') }), 2)
    assert.equal(await runLoginCommand(['--provider', 'deepseek', '--slot', '2', '--key-stdin'], { stdin: streamOf('x') }), 2)
    assert.equal(await runLoginCommand(['--provider', 'openrouter'], { stdin: streamOf('x') }), 2)
  })
})

test('a TTY with no piped key is refused instead of hanging', async () => {
  await withScratch(async () => {
    const code = await runLoginCommand(['--provider', 'deepseek', '--key-stdin'], {
      stdin: streamOf(''),
      isTTY: true,
    })
    assert.equal(code, 2)
  })
})

async function statusJson(): Promise<{ providers: Array<{ provider: string; present: boolean; slots?: number[] }> }> {
  const lines: string[] = []
  const original = console.log
  console.log = (line: unknown) => {
    lines.push(String(line))
  }
  try {
    assert.equal(await runLoginCommand(['--status']), 0)
  } finally {
    console.log = original
  }
  return JSON.parse(lines.join('\n'))
}

test('--status reports presence only', async () => {
  await withScratch(async () => {
    await runLoginCommand(['--provider', 'deepseek', '--key-stdin'], { stdin: streamOf('ds-sentinel') })
    const lines: string[] = []
    const original = console.log
    console.log = (line: unknown) => {
      lines.push(String(line))
    }
    try {
      assert.equal(await runLoginCommand(['--status']), 0)
    } finally {
      console.log = original
    }
    const text = lines.join('\n')
    assert.match(text, /"provider": "deepseek"/)
    assert.match(text, /"present": true/)
    assert.equal(text.includes('ds-sentinel'), false)
  })
})

test('--status sees numbered slots, and a slot-only save reads as configured', async () => {
  await withScratch(async () => {
    assert.equal(
      await runLoginCommand(['--provider', 'commandcode', '--slot', '2', '--key-stdin'], {
        stdin: streamOf('cc-two'),
      }),
      0,
    )
    const saved = (await statusJson()).providers.find(entry => entry.provider === 'commandcode')
    assert.equal(saved?.present, true)
    assert.deepEqual(saved?.slots, [2])

    // A numbered provider is configured when any slot exists, and the other
    // providers must not inherit that state.
    const deepseek = (await statusJson()).providers.find(entry => entry.provider === 'deepseek')
    assert.equal(deepseek?.present, false)

    const lines: string[] = []
    const original = console.log
    console.log = (line: unknown) => {
      lines.push(String(line))
    }
    try {
      assert.equal(
        await runLoginCommand(['--provider', 'commandcode', '--slot', '2', '--remove']),
        0,
      )
    } finally {
      console.log = original
    }
    // Removal names the backend the vault is still on.
    assert.match(
      lines.join('\n'),
      /^removed commandcode2 from the bundled vault \(backend (dpapi|keychain|libsecret|file)\)$/m,
    )
    const removed = (await statusJson()).providers.find(entry => entry.provider === 'commandcode')
    assert.equal(removed?.present, false)
    assert.deepEqual(removed?.slots, [])
  })
})
