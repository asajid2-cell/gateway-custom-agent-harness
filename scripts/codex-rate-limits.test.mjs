import { strict as assert } from 'node:assert'
import test from 'node:test'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

import { codexQuotaFromPayload, readCodexQuota } from '../src/utils/codexRateLimits.ts'
import { formatProviderQuota } from '../src/utils/bottomBarUsage.ts'

/**
 * The gateway's own readout of the Codex account's limits, served over the same
 * local surface a Gateway session talks to. The gateway holds one long-lived
 * `codex app-server` per gateway; the client no longer spawns one per poll nor
 * scrapes rollout JSONL, so these tests pin the reduction to the normalized
 * per-window shape and the gating of the single HTTP read.
 */
async function usageServer(respond) {
  const paths = []
  let hits = 0
  const server = createServer((req, res) => {
    hits += 1
    paths.push(req.url)
    const { status, body } = respond()
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    hits: () => hits,
    paths,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

async function withEnv(vars, run) {
  const saved = new Map()
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await run()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const gatewayBaseUrl = port => `http://127.0.0.1:${port}`

test('the payload maps to the normalized windows the gateway serves', () => {
  const parsed = codexQuotaFromPayload({
    windows: {
      H: { usedPercent: 58, resetsAt: 1_788_795_032_000 },
      W: { usedPercent: 0, resetsAt: 1_788_980_213_000 },
    },
    asof: 5,
    stale: false,
  })
  // The primary 5-hour window is H, the weekly secondary is W, and each keeps
  // its own figure rather than collapsing to the most restrictive one.
  assert.deepEqual(parsed.windows.H, { usedPercent: 58, resetsAt: 1_788_795_032_000 })
  assert.deepEqual(parsed.windows.W, { usedPercent: 0, resetsAt: 1_788_980_213_000 })
  assert.equal(parsed.asof, 5)
  assert.equal(parsed.stale, false)
  assert.equal(formatProviderQuota('Codex', parsed, 'H'), '5hr remaining 42%')
  assert.equal(formatProviderQuota('Codex', parsed, 'W'), 'weekly remaining 100%')
  // A window the gateway did not report is simply absent, not a zero.
  const onlyPrimary = codexQuotaFromPayload({ windows: { H: { usedPercent: 58 } } })
  assert.deepEqual(Object.keys(onlyPrimary.windows), ['H'])
  assert.equal(formatProviderQuota('Codex', onlyPrimary, 'W'), null)
  assert.equal(codexQuotaFromPayload({ windows: {} }), null)
})

test('a legacy rate-limits object is no longer accepted', () => {
  // The client consumes only the normalized shape; the gateway owns the mapping
  // from a rate-limits object, so the raw object never reaches here.
  assert.equal(codexQuotaFromPayload({
    rateLimits: {
      primary: { usedPercent: 60, resetsAt: 123 },
      secondary: { used_percent: 20, resets_at: 456 },
    },
  }), null)
  assert.equal(codexQuotaFromPayload({}), null)
  assert.equal(codexQuotaFromPayload(null), null)
})

test('a Codex quota is not read outside gateway mode or without a base URL', async () => {
  const fake = await usageServer(() => ({ status: 200, body: { windows: { H: { usedPercent: 58 } } } }))
  try {
    await assert.rejects(
      withEnv(
        {
          CLAUDE_CODE_USE_GATEWAY: undefined,
          CLAUDE_CODE_GATEWAY_BASE_URL: gatewayBaseUrl(fake.port),
        },
        () => readCodexQuota(),
      ),
    )

    await assert.rejects(
      withEnv(
        { CLAUDE_CODE_USE_GATEWAY: '1', CLAUDE_CODE_GATEWAY_BASE_URL: undefined },
        () => readCodexQuota(),
      ),
    )

    // Neither refusal may cost a request: there is nothing to ask for.
    assert.equal(fake.hits(), 0)
  } finally {
    await fake.close()
  }
})

test('a Codex quota returns the normalized windows the gateway serves', async () => {
  const fake = await usageServer(() => ({
    status: 200,
    body: {
      windows: {
        H: { usedPercent: 58, resetsAt: 1_788_795_032_000 },
        W: { usedPercent: 0, resetsAt: null },
      },
      asof: 1_234,
      stale: false,
    },
  }))
  try {
    const quota = await withEnv(
      {
        CLAUDE_CODE_USE_GATEWAY: '1',
        CLAUDE_CODE_GATEWAY_BASE_URL: gatewayBaseUrl(fake.port),
      },
      () => readCodexQuota(),
    )
    assert.deepEqual(quota.windows.H, { usedPercent: 58, resetsAt: 1_788_795_032_000 })
    assert.equal(quota.asof, 1_234)
    assert.deepEqual(fake.paths, ['/gateway/codex-usage'])
  } finally {
    await fake.close()
  }
})

test('a Codex quota is null when the gateway has nothing and rejects when it cannot answer', async () => {
  const empty = await usageServer(() => ({ status: 200, body: { windows: {} } }))
  const failing = await usageServer(() => ({ status: 503, body: { error: 'unavailable' } }))
  try {
    const emptyQuota = await withEnv(
      {
        CLAUDE_CODE_USE_GATEWAY: '1',
        CLAUDE_CODE_GATEWAY_BASE_URL: gatewayBaseUrl(empty.port),
      },
      () => readCodexQuota(),
    )
    assert.equal(emptyQuota, null)

    await assert.rejects(
      withEnv(
        {
          CLAUDE_CODE_USE_GATEWAY: '1',
          CLAUDE_CODE_GATEWAY_BASE_URL: gatewayBaseUrl(failing.port),
        },
        () => readCodexQuota(),
      ),
    )
  } finally {
    await empty.close()
    await failing.close()
  }
})

test('the client no longer spawns the Codex app-server or scrapes rollouts', async () => {
  // The reader is a single HTTP call now; the process cost and the stale
  // rollout figure both belonged to the deleted implementation.
  const source = await readFile(
    new URL('../src/utils/codexRateLimits.ts', import.meta.url),
    'utf8',
  )
  // Asserted on code tokens, not words: the prose above may name the deleted
  // mechanism, but the implementation must not carry any of it.
  assert.doesNotMatch(source, /child_process/)
  assert.doesNotMatch(source, /spawn\(/)
  assert.doesNotMatch(source, /'app-server'|--listen/)
  assert.doesNotMatch(source, /account\/rateLimits\/read/)
  assert.doesNotMatch(source, /readdir|readFileSync|openSync|readSync/)
  const hookSource = await readFile(
    new URL('../src/hooks/useProviderQuota.ts', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(hookSource, /codexQuotaToProviderQuota/)
})
