import { test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { buildVectors } from './element-map-vectors.ts'

// The fixture is a cross-language contract, so the only property that keeps it
// honest is that it is still exactly what the codec produces. If a codec change
// makes this fail, regenerate with `bun run scripts/element-map-vectors.ts` and
// review the diff: the change is the contract change.
const OUT = fileURLToPath(
  new URL('../contracts/element-map-21338/element-map-vectors.json', import.meta.url),
)

test('committed vectors are byte-identical to a fresh run of the codec', () => {
  expect(buildVectors()).toBe(readFileSync(OUT, 'utf8'))
})

test('every emitted sequence is free of bytes that would end an OSC early', () => {
  const vectors = JSON.parse(readFileSync(OUT, 'utf8')) as {
    codec: { entries: Array<{ name: string; ok: boolean; sequence_hex?: string }> }
  }
  for (const entry of vectors.codec.entries) {
    if (!entry.ok) continue
    const bytes = Buffer.from(entry.sequence_hex!, 'hex')
    for (const forbidden of [0x07, 0x9c, 0x18, 0x1a]) {
      expect({ name: entry.name, forbidden, present: bytes.includes(forbidden) })
        .toEqual({ name: entry.name, forbidden, present: false })
    }
    expect(bytes.subarray(0, 8).toString('hex')).toBe('1b5d32313333383b')
    expect(bytes.subarray(-2).toString('hex')).toBe('1b5c')
  }
})
