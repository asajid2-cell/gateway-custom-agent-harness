import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const compiledBundle = new URL('../dist/cli.js', import.meta.url)

async function readCompiledBundle() {
  return readFile(compiledBundle, 'utf8')
}

function assertCompiledStoreContract(bundle) {
  assert.match(bundle, /class SandboxViolationStore/)
  assert.match(bundle, /getTotalCount\(\)/)
  assert.match(bundle, /subscribe\(listener\)/)
  assert.match(bundle, /maxSize = 100/)
  assert.match(bundle, /typeof store\.subscribe !== ['\"]function['\"]/)
  assert.match(bundle, /typeof store\.getTotalCount !== ['\"]function['\"]/)
}

import {
  SandboxManager,
  SandboxViolationStore,
} from '../src/utils/sandbox/fallback-sandbox-runtime.ts'

const command = 'echo sandbox-store'
const encodedCommand = Buffer.from(command.slice(0, 100)).toString('base64')

function violation(line = 'blocked path') {
  return {
    line,
    command,
    encodedCommand,
    timestamp: new Date('2026-08-23T23:00:00.000Z'),
  }
}

test('fallback sandbox store exposes the consumer contract', () => {
  const store = new SandboxViolationStore()
  const snapshots = []
  const unsubscribe = store.subscribe(value => snapshots.push(value))

  assert.deepEqual(store.getViolations(), [])
  assert.equal(store.getCount(), 0)
  assert.equal(store.getTotalCount(), 0)
  assert.deepEqual(snapshots, [[]])

  store.addViolation(violation('blocked <secret>\n\x1b[31m'))

  assert.equal(store.getCount(), 1)
  assert.equal(store.getTotalCount(), 1)
  assert.equal(store.getViolations()[0].line, 'blocked secret [31m')
  assert.deepEqual(store.getViolationsForCommand(command), store.getViolations())
  assert.equal(snapshots.length, 2)
  assert.equal(snapshots.at(-1)[0].line, 'blocked secret [31m')

  unsubscribe()
  store.addViolation(violation('second'))
  assert.equal(snapshots.length, 2)

  store.clear()
  assert.deepEqual(store.getViolations(), [])
  assert.equal(store.getCount(), 0)
  assert.equal(store.getTotalCount(), 2)

  const boundedStore = new SandboxViolationStore()
  for (let index = 0; index < 105; index += 1) {
    boundedStore.addViolation(violation(`blocked ${index}`))
  }
  assert.equal(boundedStore.getCount(), 100)
  assert.equal(boundedStore.getTotalCount(), 105)
  assert.equal(boundedStore.getViolations()[0].line, 'blocked 5')
  assert.equal(boundedStore.getViolations(-1).length, 0)
})

test('sandbox manager returns one stable violation store', () => {
  const first = SandboxManager.getSandboxViolationStore()
  const second = SandboxManager.getSandboxViolationStore()
  assert.equal(first, second)
  assert.equal(typeof first.subscribe, 'function')
  assert.equal(typeof first.getTotalCount, 'function')
})

test('compiled consumer contains the fallback store and unavailable-store guards', async () => {
  assertCompiledStoreContract(await readCompiledBundle())
})

test('compiled bundle does not retain the old empty sandbox store stub', async () => {
  const bundle = await readCompiledBundle()
  assert.doesNotMatch(bundle, /static getSandboxViolationStore\(\)\{ return new SandboxViolationStore\(\); \}/)
})

