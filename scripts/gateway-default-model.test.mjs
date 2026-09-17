import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const CATALOG = JSON.stringify([
  {
    value: 'gateway-commandcode-deepseek-v4.1-flash',
    label: 'Command Code DeepSeek v4.1 Flash',
    description: 'Command Code',
  },
  { value: 'gateway-gpt-luna', label: 'GPT Luna', description: 'Gateway' },
])

async function withHome(run) {
  const home = await mkdtemp(path.join(tmpdir(), 'gateway-default-model-'))
  const previous = {
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
    options: process.env.MODEL_GATEWAY_MODEL_OPTIONS,
    gateway: process.env.CLAUDE_CODE_USE_GATEWAY,
  }
  process.env.USERPROFILE = home
  process.env.HOME = home
  process.env.MODEL_GATEWAY_MODEL_OPTIONS = CATALOG
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  try {
    const module = await import(
      `../src/utils/model/gatewayDefaultModel.ts?case=${Date.now()}-${Math.random()}`
    )
    await run(module, home)
  } finally {
    for (const [key, value] of Object.entries({
      USERPROFILE: previous.USERPROFILE,
      HOME: previous.HOME,
      MODEL_GATEWAY_MODEL_OPTIONS: previous.options,
      CLAUDE_CODE_USE_GATEWAY: previous.gateway,
    })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(home, { recursive: true, force: true })
  }
}

test('the picker default lands in the file the launcher reads', async () => {
  await withHome(async ({ gatewayDefaultModelPath, setGatewayDefaultModel }, home) => {
    assert.equal(
      gatewayDefaultModelPath(),
      path.join(home, '.claude', 'gateway-default-model.txt'),
    )
    assert.equal(
      await setGatewayDefaultModel('gateway-commandcode-deepseek-v4.1-flash'),
      true,
    )
    assert.equal(
      (await readFile(gatewayDefaultModelPath(), 'utf8')).trim(),
      'gateway-commandcode-deepseek-v4.1-flash',
    )
  })
})

test('an id the catalog cannot serve is never persisted', async () => {
  await withHome(async ({ gatewayDefaultModelPath, setGatewayDefaultModel }) => {
    // Gateway-shaped but not a route: writing it would strand every launch.
    assert.equal(await setGatewayDefaultModel('gateway-not-a-route'), false)
    // Not a Gateway id at all.
    assert.equal(await setGatewayDefaultModel('opus'), false)
    assert.equal(existsSync(gatewayDefaultModelPath()), false)
  })
})

test('choosing the Gateway default option clears the stored default', async () => {
  await withHome(async ({ gatewayDefaultModelPath, setGatewayDefaultModel }) => {
    await setGatewayDefaultModel('gateway-gpt-luna')
    assert.equal(existsSync(gatewayDefaultModelPath()), true)
    assert.equal(await setGatewayDefaultModel(null), true)
    assert.equal(existsSync(gatewayDefaultModelPath()), false)
  })
})
