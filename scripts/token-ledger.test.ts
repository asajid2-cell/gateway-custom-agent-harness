import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import catalog from './effort-capabilities.json'
import { resolveModelBackend } from '../src/utils/model/gatewayBackend.ts'
import {
  recordTokenUsage,
  resetTokenLedgerForTests,
} from '../src/utils/tokenLedger.ts'

const PREVIOUS_DIR = process.env.GATEWAY_TOKEN_LEDGER_DIR
const PREVIOUS_FLAG = process.env.GATEWAY_TOKEN_LEDGER

async function inTempLedger(
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'token-ledger-'))
  process.env.GATEWAY_TOKEN_LEDGER_DIR = dir
  delete process.env.GATEWAY_TOKEN_LEDGER
  resetTokenLedgerForTests()
  try {
    await body(dir)
  } finally {
    resetTokenLedgerForTests()
    if (PREVIOUS_DIR === undefined) delete process.env.GATEWAY_TOKEN_LEDGER_DIR
    else process.env.GATEWAY_TOKEN_LEDGER_DIR = PREVIOUS_DIR
    if (PREVIOUS_FLAG === undefined) delete process.env.GATEWAY_TOKEN_LEDGER
    else process.env.GATEWAY_TOKEN_LEDGER = PREVIOUS_FLAG
    await rm(dir, { recursive: true, force: true })
  }
}

test('a backend is resolved from the catalog, not from the model name', () => {
  // Same Gateway prefix, two different providers: a prefix heuristic has to get
  // one of these wrong, and the catalog does not.
  assert.equal(resolveModelBackend('gateway-opencode-glm-5.3-flash'), 'opencode-go')
  assert.equal(resolveModelBackend('gateway-opencode-glm-5.3-flash-free'), 'opencode-zen')
  assert.equal(resolveModelBackend('gateway-opencode-big-pickle'), 'opencode-zen')
  assert.equal(
    resolveModelBackend('gateway-opencode-deepseek-v4.1-flash'),
    'opencode-go',
  )

  assert.equal(resolveModelBackend('gateway-gpt-sol'), 'codex')
  assert.equal(resolveModelBackend('gateway-ds-pro'), 'deepseek')
  assert.equal(
    resolveModelBackend('gateway-commandcode-longcat-2.0-free'),
    'commandcode',
  )
  assert.equal(resolveModelBackend('gateway-amd-qwen3.8-27b'), 'amd-radeon')

  // Provider-native and legacy spellings reach the same backend. The 5.6 ids
  // stay routable beside the GPT-6 ones they were superseded by, so both
  // generations are attributed rather than only the current one.
  assert.equal(resolveModelBackend('gpt-5.6-luna'), 'codex')
  assert.equal(resolveModelBackend('gpt-6-luna'), 'codex')
  assert.equal(resolveModelBackend('gpt-6-sol'), 'codex')
  assert.equal(resolveModelBackend('gpt-6-astra'), 'codex')
  assert.equal(resolveModelBackend('claude-gpt-sol'), 'codex')
  assert.equal(resolveModelBackend('deepseek-v4-flash'), 'deepseek')
  assert.equal(resolveModelBackend('opencode-go/hy3'), 'opencode-go')
  assert.equal(resolveModelBackend('opencode-zen/space-bunny-free'), 'opencode-zen')
  assert.equal(resolveModelBackend('claude-opencode-glm-5.3'), 'opencode-go')

  // The subscription's own models, visible route and provider-native spelling
  // alike: a Gateway route to Anthropic spends the same account a first-party
  // session would, so it is attributed to the provider, not left unresolved.
  assert.equal(resolveModelBackend('gateway-claude-opus-5-5'), 'anthropic')
  assert.equal(resolveModelBackend('gateway-claude-haiku-4-5-20251001'), 'anthropic')
  assert.equal(resolveModelBackend('claude-opus-4-6'), 'anthropic')
  assert.equal(resolveModelBackend('claude-haiku-4-5-20251001'), 'anthropic')

  // An unroutable Gateway id is reported as unknown rather than guessed into a
  // neighbouring provider's total.
  assert.equal(resolveModelBackend('gateway-opencode-nonexistent'), 'unknown')
  assert.equal(resolveModelBackend('gateway-mystery-model'), 'unknown')
})

test('every model the Gateway offers resolves to a real backend', () => {
  const options = (catalog as { gatewayModelOptions: Array<{ value: string }> })
    .gatewayModelOptions
  const unresolved = options
    .map(option => option.value)
    .filter(model => resolveModelBackend(model) === 'unknown')
  assert.deepEqual(
    unresolved,
    [],
    `Gateway models with no backend attribution: ${unresolved.join(', ')}`,
  )
})

test('every alias in the catalog resolves to the same backend as its canonical id', () => {
  const aliases = (
    catalog as { gatewayModelAliases: Record<string, string[]> }
  ).gatewayModelAliases
  for (const [canonical, names] of Object.entries(aliases)) {
    const expected = resolveModelBackend(canonical)
    for (const alias of names) {
      assert.equal(
        resolveModelBackend(alias),
        expected,
        `${alias} should attribute to ${expected} like ${canonical}`,
      )
    }
  }
})

test('one response writes one row with the provider figures verbatim', async () => {
  await inTempLedger(async dir => {
    recordTokenUsage({
      session: 'session-a',
      model: 'gateway-gpt-sol',
      usage: { input: 1200, output: 34, cacheRead: 56000, cacheWrite: 0 },
      costUSD: 0.0123,
    })

    const text = await readFile(join(dir, 'tokens.jsonl'), 'utf8')
    const lines = text.trim().split('\n')
    assert.equal(lines.length, 1)
    const row = JSON.parse(lines[0]!)
    assert.equal(row.v, 1)
    assert.equal(row.session, 'session-a')
    assert.equal(row.model, 'gateway-gpt-sol')
    assert.equal(row.backend, 'codex')
    assert.equal(row.input, 1200)
    assert.equal(row.output, 34)
    assert.equal(row.cacheRead, 56000)
    assert.equal(row.cacheWrite, 0)
    assert.equal(row.costUSD, 0.0123)
    assert.equal(row.src, 'response')
    assert.equal(Number.isNaN(Date.parse(row.at)), false)
  })
})

test('rows accumulate rather than overwrite, and keep their source', async () => {
  await inTempLedger(async dir => {
    recordTokenUsage({
      session: 'session-a',
      model: 'gateway-ds-pro',
      usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 },
      costUSD: 0,
    })
    recordTokenUsage({
      session: 'session-a',
      model: 'gateway-ds-pro',
      usage: { input: 20, output: 2, cacheRead: 0, cacheWrite: 0 },
      costUSD: 0,
      source: 'advisor',
    })
    recordTokenUsage({
      session: 'session-b',
      model: 'gateway-opencode-big-pickle',
      usage: { input: 30, output: 3, cacheRead: 0, cacheWrite: 0 },
      costUSD: 0,
      source: 'replay',
    })

    const rows = (await readFile(join(dir, 'tokens.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    assert.equal(rows.length, 3)
    assert.deepEqual(
      rows.map(row => row.src),
      ['response', 'advisor', 'replay'],
    )
    assert.deepEqual(
      rows.map(row => row.session),
      ['session-a', 'session-a', 'session-b'],
    )
    assert.equal(rows[2].backend, 'opencode-zen')
  })
})

test('absent or nonsense figures are recorded as zero, never as a guess', async () => {
  await inTempLedger(async dir => {
    recordTokenUsage({
      session: 'session-a',
      model: 'claude-opus-4-6',
      usage: {
        input: Number.NaN,
        output: -5,
        cacheRead: Number.POSITIVE_INFINITY,
        cacheWrite: 7,
      },
      costUSD: Number.NaN,
    })

    const row = JSON.parse(
      (await readFile(join(dir, 'tokens.jsonl'), 'utf8')).trim(),
    )
    assert.equal(row.input, 0)
    assert.equal(row.output, 0)
    assert.equal(row.cacheRead, 0)
    assert.equal(row.cacheWrite, 7)
    assert.equal(row.costUSD, 0)
    assert.equal(row.backend, 'anthropic')
  })
})

test('the ledger can be switched off without losing the session', async () => {
  await inTempLedger(async dir => {
    process.env.GATEWAY_TOKEN_LEDGER = '0'
    recordTokenUsage({
      session: 'session-a',
      model: 'gateway-gpt-sol',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      costUSD: 0,
    })
    await assert.rejects(readFile(join(dir, 'tokens.jsonl'), 'utf8'))
  })
})

test('an unwritable ledger never throws into the response path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'token-ledger-blocked-'))
  const blocker = join(dir, 'not-a-directory')
  try {
    await writeFile(blocker, 'this file stands where the ledger dir would go')
    process.env.GATEWAY_TOKEN_LEDGER_DIR = blocker
    delete process.env.GATEWAY_TOKEN_LEDGER
    resetTokenLedgerForTests()

    assert.doesNotThrow(() =>
      recordTokenUsage({
        session: 'session-a',
        model: 'gateway-gpt-sol',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        costUSD: 0,
      }),
    )
  } finally {
    resetTokenLedgerForTests()
    if (PREVIOUS_DIR === undefined) delete process.env.GATEWAY_TOKEN_LEDGER_DIR
    else process.env.GATEWAY_TOKEN_LEDGER_DIR = PREVIOUS_DIR
    if (PREVIOUS_FLAG === undefined) delete process.env.GATEWAY_TOKEN_LEDGER
    else process.env.GATEWAY_TOKEN_LEDGER = PREVIOUS_FLAG
    await rm(dir, { recursive: true, force: true })
  }
})
