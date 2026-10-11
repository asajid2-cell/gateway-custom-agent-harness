import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// The picker's `e` writes a per-model default effort to this file and cc.ps1
// reads it back, so the launcher and the harness agree on what `auto` resolves
// to. Each test loads a fresh module instance against a temp home so the
// in-session pin map never leaks between cases.
async function withHome(run, snapshot) {
  const home = await mkdtemp(path.join(tmpdir(), 'gateway-effort-defaults-'))
  const previous = {
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
    defaults: process.env.MODEL_GATEWAY_EFFORT_DEFAULTS,
  }
  process.env.USERPROFILE = home
  process.env.HOME = home
  if (snapshot === undefined) delete process.env.MODEL_GATEWAY_EFFORT_DEFAULTS
  else process.env.MODEL_GATEWAY_EFFORT_DEFAULTS = snapshot
  try {
    const module = await import(
      `../src/utils/model/gatewayEffortDefaults.ts?case=${Date.now()}-${Math.random()}`
    )
    await run(module, home)
  } finally {
    for (const [key, value] of Object.entries({
      USERPROFILE: previous.USERPROFILE,
      HOME: previous.HOME,
      MODEL_GATEWAY_EFFORT_DEFAULTS: previous.defaults,
    })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(home, { recursive: true, force: true })
  }
}

test('a pin lands in the file the launcher reads', async () => {
  await withHome(
    async ({ gatewayEffortDefaultsPath, pinGatewayEffort, getPinnedGatewayEffort }, home) => {
      assert.equal(
        gatewayEffortDefaultsPath(),
        path.join(home, '.claude', 'gateway-effort-defaults.json'),
      )
      await pinGatewayEffort('gateway-opencode-deepseek-v4.1-flash', 'high')
      assert.equal(
        getPinnedGatewayEffort('gateway-opencode-deepseek-v4.1-flash'),
        'high',
      )
      assert.deepEqual(
        JSON.parse(await readFile(gatewayEffortDefaultsPath(), 'utf8')),
        { 'gateway-opencode-deepseek-v4.1-flash': 'high' },
      )
    },
  )
})

test('clearing a pin drops it from the file and from memory', async () => {
  await withHome(
    async ({ gatewayEffortDefaultsPath, pinGatewayEffort, getPinnedGatewayEffort }) => {
      await pinGatewayEffort('gateway-commandcode-deepseek-v4.1-flash', 'max')
      assert.equal(
        getPinnedGatewayEffort('gateway-commandcode-deepseek-v4.1-flash'),
        'max',
      )
      await pinGatewayEffort('gateway-commandcode-deepseek-v4.1-flash', null)
      assert.equal(
        getPinnedGatewayEffort('gateway-commandcode-deepseek-v4.1-flash'),
        undefined,
      )
      assert.deepEqual(
        JSON.parse(await readFile(gatewayEffortDefaultsPath(), 'utf8')),
        {},
      )
    },
  )
})

test('pinning one model keeps every other pin', async () => {
  await withHome(async ({ gatewayEffortDefaultsPath, pinGatewayEffort }) => {
    await pinGatewayEffort('gateway-opencode-deepseek-v4.1-flash', 'high')
    await pinGatewayEffort('gateway-commandcode-deepseek-v4.1-flash', 'max')
    assert.deepEqual(
      JSON.parse(await readFile(gatewayEffortDefaultsPath(), 'utf8')),
      {
        'gateway-opencode-deepseek-v4.1-flash': 'high',
        'gateway-commandcode-deepseek-v4.1-flash': 'max',
      },
    )
  })
})

test('the launch snapshot is honored and a clear shadows it', async () => {
  const snapshot = JSON.stringify({
    'gateway-opencode-deepseek-v4.1-flash': 'high',
  })
  await withHome(
    async ({ gatewayEffortDefaultsPath, pinGatewayEffort, getPinnedGatewayEffort }) => {
      // With no pin made this session, the snapshot cc.ps1 exported is the pin.
      assert.equal(
        getPinnedGatewayEffort('gateway-opencode-deepseek-v4.1-flash'),
        'high',
      )
      // Pinning another model preserves the snapshot entry in the written file.
      await pinGatewayEffort('gateway-commandcode-deepseek-v4.1-flash', 'max')
      assert.deepEqual(
        JSON.parse(await readFile(gatewayEffortDefaultsPath(), 'utf8')),
        {
          'gateway-opencode-deepseek-v4.1-flash': 'high',
          'gateway-commandcode-deepseek-v4.1-flash': 'max',
        },
      )
      // Clearing the snapshot's model shadows it, so `auto` stops resolving to
      // it even though the launcher still exported it for this process.
      await pinGatewayEffort('gateway-opencode-deepseek-v4.1-flash', null)
      assert.equal(
        getPinnedGatewayEffort('gateway-opencode-deepseek-v4.1-flash'),
        undefined,
      )
      assert.deepEqual(
        JSON.parse(await readFile(gatewayEffortDefaultsPath(), 'utf8')),
        { 'gateway-commandcode-deepseek-v4.1-flash': 'max' },
      )
    },
    snapshot,
  )
})

test('a malformed snapshot reads as no pins', async () => {
  await withHome(
    async ({ gatewayEffortDefaultsPath, pinGatewayEffort, getPinnedGatewayEffort }) => {
      assert.equal(
        getPinnedGatewayEffort('gateway-opencode-deepseek-v4.1-flash'),
        undefined,
      )
      await pinGatewayEffort('gateway-opencode-deepseek-v4.1-flash', 'high')
      assert.deepEqual(
        JSON.parse(await readFile(gatewayEffortDefaultsPath(), 'utf8')),
        { 'gateway-opencode-deepseek-v4.1-flash': 'high' },
      )
    },
    '{not json',
  )
})

test('auto resolves to a valid pin and ignores one the model cannot take', async () => {
  const { getDefaultEffortForModel } = await import('../src/utils/effort.ts')
  // The OpenCode DeepSeek route answers only low | high | max.
  const model = 'gateway-opencode-deepseek-v4.1-flash'
  const previous = process.env.MODEL_GATEWAY_EFFORT_DEFAULTS
  try {
    process.env.MODEL_GATEWAY_EFFORT_DEFAULTS = JSON.stringify({ [model]: 'high' })
    assert.equal(getDefaultEffortForModel(model), 'high')
    // `medium` is not on this model's ladder, so the pin is ignored rather than
    // sent as a level the provider rejects.
    process.env.MODEL_GATEWAY_EFFORT_DEFAULTS = JSON.stringify({
      [model]: 'medium',
    })
    assert.equal(getDefaultEffortForModel(model), undefined)
    // No pin at all: no effort parameter is sent and the provider default
    // governs, which is what the status line shows as `auto`.
    delete process.env.MODEL_GATEWAY_EFFORT_DEFAULTS
    assert.equal(getDefaultEffortForModel(model), undefined)
  } finally {
    if (previous === undefined) delete process.env.MODEL_GATEWAY_EFFORT_DEFAULTS
    else process.env.MODEL_GATEWAY_EFFORT_DEFAULTS = previous
  }
})
