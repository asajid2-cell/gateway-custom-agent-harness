import { strict as assert } from 'node:assert'
import test from 'node:test'
import { createServer } from 'node:http'

import { readAnthropicQuota } from '../src/utils/anthropicUsage.ts'

/**
 * The gateway's own readout of the subscription limit, served over the same
 * local surface a Gateway session talks to. The client cannot ask Anthropic
 * itself - a Gateway session never reads Claude.ai auth state - so this is the
 * only source the footer has, and the tests pin both its gating and its
 * reduction to one remaining-percent figure.
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

test('an Anthropic quota is not read outside gateway mode or without a base URL', async () => {
  const fake = await usageServer(() => ({ status: 200, body: { five_hour: { utilization: 0.37 } } }))
  try {
    const outsideGateway = await withEnv(
      {
        CLAUDE_CODE_USE_GATEWAY: undefined,
        CLAUDE_CODE_GATEWAY_BASE_URL: gatewayBaseUrl(fake.port),
      },
      () => readAnthropicQuota(),
    )
    assert.equal(outsideGateway, null)

    const withoutBaseUrl = await withEnv(
      { CLAUDE_CODE_USE_GATEWAY: '1', CLAUDE_CODE_GATEWAY_BASE_URL: undefined },
      () => readAnthropicQuota(),
    )
    assert.equal(withoutBaseUrl, null)

    // Neither refusal may cost a request: there is nothing to ask for.
    assert.equal(fake.hits(), 0)
  } finally {
    await fake.close()
  }
})

test('an Anthropic quota reports the remaining share of the limiting window', async () => {
  const fake = await usageServer(() => ({
    status: 200,
    // Fractions, the scale the endpoint answers with.
    body: { five_hour: { utilization: 0.37 }, seven_day: { utilization: 0.88 } },
  }))
  try {
    const quota = await withEnv(
      {
        CLAUDE_CODE_USE_GATEWAY: '1',
        CLAUDE_CODE_GATEWAY_BASE_URL: gatewayBaseUrl(fake.port),
      },
      () => readAnthropicQuota(),
    )
    // The weekly window is nearer its limit, so it governs - and the figure is
    // what is left, not what was used.
    assert.deepEqual(quota, { remainingPercent: 12 })
    assert.deepEqual(fake.paths, ['/gateway/anthropic-usage'])
  } finally {
    await fake.close()
  }
})

test('an Anthropic quota stays null when the gateway has nothing or cannot answer', async () => {
  // A gateway that has seen no Anthropic traffic reports an empty object, which
  // is not a limit: a session that never reached the provider shows no figure
  // rather than a fabricated one.
  const empty = await usageServer(() => ({ status: 200, body: {} }))
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

    const unreachable = await withEnv(
      {
        CLAUDE_CODE_USE_GATEWAY: '1',
        CLAUDE_CODE_GATEWAY_BASE_URL: gatewayBaseUrl(failing.port),
      },
      () => readAnthropicQuota(),
    )
    assert.equal(unreachable, null)

    // A refused connection reads the same way as a refused status.
    const deadPort = failing.port
    await failing.close()
    const offline = await withEnv(
      {
        CLAUDE_CODE_USE_GATEWAY: '1',
        CLAUDE_CODE_GATEWAY_BASE_URL: gatewayBaseUrl(deadPort),
      },
      () => readAnthropicQuota(),
    )
    assert.equal(offline, null)
  } finally {
    await empty.close()
  }
})
