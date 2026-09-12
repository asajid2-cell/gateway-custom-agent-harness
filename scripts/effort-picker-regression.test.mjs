import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  clampGatewayEffort,
  cycleGatewayEffort,
  resolveGatewayEffortAfterModelSwitch,
} from '../src/utils/model/gatewayEffortState.ts'
import { getGatewayNativeEffortLevels } from '../src/utils/model/gatewayEffortCapabilities.ts'
import { getAppliedEffortLevel, getDisplayedEffortLevel } from '../src/utils/effort.ts'

test('5.6 model switching preserves the full native ladder', () => {
  const lunaLevels = getGatewayNativeEffortLevels('gateway-gpt-luna')
  const terraLevels = getGatewayNativeEffortLevels('gateway-gpt-terra')

  const solLevels = getGatewayNativeEffortLevels('gateway-gpt-sol')
  const astraLevels = getGatewayNativeEffortLevels('gateway-gpt-astra')

  assert.deepEqual(lunaLevels, ['none', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(solLevels, ['none', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(terraLevels, ['none', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(astraLevels, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
  assert.equal(solLevels.includes('ultra'), false)
  assert.equal(terraLevels.includes('ultra'), false)
  assert.equal(lunaLevels.includes('ultra'), false)
  assert.equal(
    resolveGatewayEffortAfterModelSwitch(terraLevels, 'max', 'max', 'max', true),
    'max',
  )
  assert.equal(
    resolveGatewayEffortAfterModelSwitch(astraLevels, 'ultra', 'ultra', 'ultra', true),
    'ultra',
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

test('the effort notification folds so the footer tracks the real session value', async () => {
  const source = await readFile(
    new URL('../src/components/PromptInput/PromptInput.tsx', import.meta.url),
    'utf8',
  )
  const start = source.indexOf("key: 'effort-level'")
  assert.ok(start >= 0, 'the effort notification must be registered')
  const block = source.slice(start, source.indexOf('});', start))
  assert.match(
    block,
    /fold: \(_previous, incoming\) => incoming/,
    'without a fold a same-key re-add is dropped and the footer text never updates',
  )
})

test('applied effort stays undefined when nothing is sent, displayed falls back to high', () => {
  // DeepSeek/OpenCode native ladder is low|high|max: undefined means no
  // effort parameter is sent, medium is not native and clamps to high.
  assert.equal(getAppliedEffortLevel('gateway-ds-4.1-flash', undefined), undefined)
  assert.equal(getAppliedEffortLevel('gateway-ds-4.1-flash', 'max'), 'max')
  assert.equal(getAppliedEffortLevel('gateway-ds-4.1-flash', 'medium'), 'high')
  assert.equal(getDisplayedEffortLevel('gateway-ds-4.1-flash', undefined), 'high')
})
