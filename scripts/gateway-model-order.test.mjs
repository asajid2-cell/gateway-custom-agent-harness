import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const CATALOG = JSON.stringify([
  { value: 'gateway-gpt-luna', label: 'GPT Luna', description: 'Gateway' },
  { value: 'gateway-ds-flash', label: 'DeepSeek Flash', description: 'Gateway' },
  { value: 'gateway-ds-pro', label: 'DeepSeek Pro', description: 'Gateway' },
])

async function withHome(run) {
  const home = await mkdtemp(path.join(tmpdir(), 'gateway-model-order-'))
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
      `../src/utils/model/gatewayModelOrder.ts?case=${Date.now()}-${Math.random()}`
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

test('the picker order lands in the file the launcher reads', async () => {
  await withHome(async ({ gatewayModelOrderPath, readGatewayModelOrder, writeGatewayModelOrder }, home) => {
    assert.equal(
      gatewayModelOrderPath(),
      path.join(home, '.claude', 'gateway-model-order.json'),
    )
    // No file yet is the "catalog order" state, not an error.
    assert.deepEqual(await readGatewayModelOrder(), [])
    await writeGatewayModelOrder(['gateway-ds-pro', 'gateway-gpt-luna'])
    assert.deepEqual(await readGatewayModelOrder(), [
      'gateway-ds-pro',
      'gateway-gpt-luna',
    ])
  })
})

test('ids the catalog cannot serve never reach the file', async () => {
  await withHome(async ({ readGatewayModelOrder, writeGatewayModelOrder }) => {
    await writeGatewayModelOrder([
      'gateway-not-a-route',
      'gateway-gpt-luna',
      'gateway-gpt-luna',
      'gateway-ds-flash',
    ])
    // Not a route and a repeat both collapse, leaving only what can be served.
    assert.deepEqual(await readGatewayModelOrder(), [
      'gateway-gpt-luna',
      'gateway-ds-flash',
    ])
  })
})

test('a launch with no gateway catalog leaves a stored order alone', async () => {
  await withHome(async ({ gatewayModelOrderPath, writeGatewayModelOrder }) => {
    await writeGatewayModelOrder(['gateway-ds-pro'])
    const stored = await readFile(gatewayModelOrderPath(), 'utf8')
    // Outside gateway mode every id fails the filter, so a write would erase an
    // order the next gateway launch would have honored.
    delete process.env.MODEL_GATEWAY_MODEL_OPTIONS
    await writeGatewayModelOrder(['gateway-gpt-luna'])
    assert.equal(await readFile(gatewayModelOrderPath(), 'utf8'), stored)
  })
})

test('a corrupt order file reads as no order', async () => {
  await withHome(async ({ gatewayModelOrderPath, readGatewayModelOrder }, home) => {
    await mkdir(path.join(home, '.claude'), { recursive: true })
    await writeFile(gatewayModelOrderPath(), '{ not json')
    assert.deepEqual(await readGatewayModelOrder(), [])
    await writeFile(gatewayModelOrderPath(), '{"gateway-ds-pro":1}')
    assert.deepEqual(await readGatewayModelOrder(), [])
  })
})

test('a stored order leads and unlisted routes keep catalog order', async () => {
  await withHome(async ({ applyGatewayModelOrder }) => {
    const options = [
      { value: 'gateway-gpt-luna' },
      { value: 'gateway-ds-flash' },
      { value: 'gateway-ds-pro' },
      { value: 'gateway-gpt-terra' },
    ]
    assert.deepEqual(
      applyGatewayModelOrder(options, [
        'gateway-ds-pro',
        'gateway-gpt-luna',
      ]).map(option => option.value),
      [
        'gateway-ds-pro',
        'gateway-gpt-luna',
        'gateway-ds-flash',
        'gateway-gpt-terra',
      ],
    )
    // A route added after the file was written lands at the bottom rather than
    // vanishing, and an empty order is the untouched catalog, not a re-sort.
    assert.deepEqual(
      applyGatewayModelOrder(options, ['gateway-gpt-terra']).map(
        option => option.value,
      ),
      [
        'gateway-gpt-terra',
        'gateway-gpt-luna',
        'gateway-ds-flash',
        'gateway-ds-pro',
      ],
    )
    assert.deepEqual(
      applyGatewayModelOrder(options, []).map(option => option.value),
      options.map(option => option.value),
    )
  })
})

test('only routes the catalog offers can be reordered', async () => {
  await withHome(async ({ isOrderableGatewayModel }) => {
    assert.equal(isOrderableGatewayModel('gateway-gpt-luna'), true)
    assert.equal(isOrderableGatewayModel('gateway-not-a-route'), false)
    // The picker's synthetic rows and Anthropic ids are not gateway routes.
    assert.equal(isOrderableGatewayModel('opus'), false)
    assert.equal(isOrderableGatewayModel('__NO_PREFERENCE__'), false)
  })
})

test('overlapping writes leave one whole order and no temporary behind', async () => {
  await withHome(async ({ gatewayModelOrderPath, readGatewayModelOrder, writeGatewayModelOrder }, home) => {
    await writeGatewayModelOrder(['gateway-ds-pro'])
    await Promise.all([
      writeGatewayModelOrder(['gateway-ds-flash', 'gateway-ds-pro']),
      writeGatewayModelOrder(['gateway-ds-pro', 'gateway-ds-flash']),
    ])
    // Writes are queued, so the file ends on the last order asked for rather
    // than on whichever write happened to finish last - and it is always one
    // complete order, never a half-written list.
    assert.deepEqual(await readGatewayModelOrder(), [
      'gateway-ds-pro',
      'gateway-ds-flash',
    ])
    const written = await readdir(path.join(home, '.claude'))
    assert.deepEqual(written, ['gateway-model-order.json'])
  })
})
