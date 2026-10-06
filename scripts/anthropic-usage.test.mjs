import { strict as assert } from 'node:assert'
import test from 'node:test'
import { createServer } from 'node:http'

import { anthropicQuotaFromPayload, readAnthropicQuota } from '../src/utils/anthropicUsage.ts'

/**
 * The gateway's own readout of the subscription limit, served over the same
 * local surface a Gateway session talks to. The client cannot ask Anthropic
 * itself - a Gateway session never reads Claude.ai auth state - so this is the
 * only source the footer has, and the tests pin both its gating and its
 * reduction to the normalized per-window shape.
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
  const parsed = anthropicQuotaFromPayload({
    windows: {
      H: { usedPercent: 37, resetsAt: 1_791_264_085_000 },
      W: { usedPercent: 88, resetsAt: null },
    },
    asof: 5,
    stale: false,
  })
  assert.deepEqual(parsed.windows.H, { usedPercent: 37, resetsAt: 1_791_264_085_000 })
  assert.deepEqual(parsed.windows.W, { usedPercent: 88, resetsAt: null })
  assert.equal(parsed.asof, 5)
  assert.equal(parsed.stale, false)
  assert.equal(anthropicQuotaFromPayload({ windows: {} }), null)
})

test('a legacy utilization object is no longer accepted', () => {
  // The client consumes only the normalized shape; the gateway owns the unit
  // ambiguity (utilization as percent used vs. a fraction) so the raw object
  // never reaches here. A payload without `windows` is "no figure", not a
  // guess - and crucially not the 0%-while-60%-used misread this once caused.
  assert.equal(anthropicQuotaFromPayload({
    five_hour: { utilization: 37, resets_at: '2026-10-06T05:00:00Z' },
    seven_day: { utilization: 88 },
  }), null)
  assert.equal(anthropicQuotaFromPayload({}), null)
  assert.equal(anthropicQuotaFromPayload({ five_hour: { utilization: null } }), null)
  assert.equal(anthropicQuotaFromPayload(null), null)
})

test('an Anthropic quota is not read outside gateway mode or without a base URL', async () => {
  const fake = await usageServer(() => ({ status: 200, body: { windows: { H: { usedPercent: 37 } } } }))
  try {
    await assert.rejects(
      withEnv(
        {
          CLAUDE_CODE_USE_GATEWAY: undefined,
          CLAUDE_CODE_GATEWAY_BASE_URL: gatewayBaseUrl(fake.port),
        },
        () => readAnthropicQuota(),
      ),
    )

    await assert.rejects(
      withEnv(
        { CLAUDE_CODE_USE_GATEWAY: '1', CLAUDE_CODE_GATEWAY_BASE_URL: undefined },
        () => readAnthropicQuota(),
      ),
    )

    // Neither refusal may cost a request: there is nothing to ask for.
    assert.equal(fake.hits(), 0)
  } finally {
    await fake.close()
  }
})

test('an Anthropic quota returns the normalized windows the gateway serves', async () => {
  const fake = await usageServer(() => ({
    status: 200,
    body: {
      windows: {
        H: { usedPercent: 37, resetsAt: 1_791_264_085_000 },
        W: { usedPercent: 88, resetsAt: null },
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
      () => readAnthropicQuota(),
    )
    assert.deepEqual(quota.windows.W, { usedPercent: 88, resetsAt: null })
    assert.equal(quota.asof, 1_234)
    assert.deepEqual(fake.paths, ['/gateway/anthropic-usage'])
  } finally {
    await fake.close()
  }
})

test('an Anthropic quota is null when the gateway has nothing and rejects when it cannot answer', async () => {
  // A gateway that has seen no Anthropic traffic reports empty windows, which
  // is not a limit: a session that never reached the provider shows no figure
  // rather than a fabricated one.
  const empty = await usageServer(() => ({ status: 200, body: { windows: {} } }))
  const failing = await usageServer(() => ({ status: 503, body: { error: 'unavailable' } }))
  try {
    const emptyQuota = await withEnv(
      {
        CLAUDE_CODE_USE_GATEWAY: '1',
        CLAUDE_CODE_GATEWAY_BASE_URL: gatewayBaseUrl(empty.port),
      },
      () => readAnthropicQuota(),
    )
    assert.equal(emptyQuota, null)

    // A refused status rejects, so the caller keeps the last good figure
    // instead of flickering to nothing.
    await assert.rejects(
      withEnv(
        {
          CLAUDE_CODE_USE_GATEWAY: '1',
          CLAUDE_CODE_GATEWAY_BASE_URL: gatewayBaseUrl(failing.port),
        },
        () => readAnthropicQuota(),
      ),
    )

    // A refused connection reads the same way as a refused status.
    const deadPort = failing.port
    await failing.close()
    await assert.rejects(
      withEnv(
        {
          CLAUDE_CODE_USE_GATEWAY: '1',
          CLAUDE_CODE_GATEWAY_BASE_URL: gatewayBaseUrl(deadPort),
        },
        () => readAnthropicQuota(),
      ),
    )
  } finally {
    await empty.close()
  }
})
