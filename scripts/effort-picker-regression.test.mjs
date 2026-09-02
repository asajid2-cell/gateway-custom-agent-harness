import { strict as assert } from 'node:assert'
import test from 'node:test'

import {
  clampGatewayEffort,
  cycleGatewayEffort,
  resolveGatewayEffortAfterModelSwitch,
} from '../src/utils/model/gatewayEffortState.ts'
import { getGatewayNativeEffortLevels } from '../src/utils/model/gatewayEffortCapabilities.ts'

test('5.6 model switching preserves the full native ladder', () => {
  const lunaLevels = getGatewayNativeEffortLevels('gateway-gpt-luna')
  const terraLevels = getGatewayNativeEffortLevels('gateway-gpt-terra')

  assert.deepEqual(lunaLevels, ['none', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(terraLevels, ['none', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(
    resolveGatewayEffortAfterModelSwitch(terraLevels, 'max', 'max', 'max', true),
    'max',
  )
})

test('GLM 5.3 Flash clamps an unsupported native level to verified high', () => {
  const flashLevels = getGatewayNativeEffortLevels('gateway-opencode-glm-5.3-flash')

  assert.equal(
    resolveGatewayEffortAfterModelSwitch(flashLevels, 'medium', 'medium', 'medium', true),
    'high',
  )
  assert.equal(clampGatewayEffort(flashLevels, 'medium'), 'high')
})

test('switching to a model without native effort removes stale native values', () => {
  const mimoLevels = getGatewayNativeEffortLevels('gateway-opencode-mimo-v2.5-pro')

  assert.equal(
    resolveGatewayEffortAfterModelSwitch(mimoLevels, 'max', 'max', 'max', true),
    undefined,
  )
  assert.equal(
    resolveGatewayEffortAfterModelSwitch(mimoLevels, 'ultracode', 'ultracode', 'ultracode', true),
    'ultracode',
  )
})

test('ultracode cycles as a harness control', () => {
  const flashLevels = [...getGatewayNativeEffortLevels('gateway-opencode-glm-5.3-flash'), 'ultracode']

  assert.equal(cycleGatewayEffort('max', 'right', flashLevels), 'ultracode')
  assert.equal(cycleGatewayEffort('ultracode', 'right', flashLevels), 'low')
})
