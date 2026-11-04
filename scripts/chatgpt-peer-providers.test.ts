/**
 * The provider table: every default a host derives from `--provider`.
 *
 * The point is not that two rows exist; it is that resolving one provider
 * never borrows another's home, profile, port, driver or thread vocabulary.
 */
import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { providerEnv, providerOf } from './chatgpt-peer/providers.ts'
import { resolveConfig } from './chatgpt-peer.ts'

const UUID = '11111111-1111-4111-8111-111111111111'

describe('providers', () => {
  test('the ChatGPT profile keeps every existing default', () => {
    const provider = providerOf(undefined)
    expect(provider.id).toBe('chatgpt-web')
    expect(provider.home).toBe(join(homedir(), 'chatgpt-web'))
    expect(provider.profile).toBe(join(homedir(), '.chatgpt-web', 'profile'))
    expect(provider.masterPort).toBe(9222)
    expect(provider.laneBasePort).toBe(9300)
    expect(provider.driver).toBe('chatgpt.mjs')
    expect(provider.peerPrefix).toBe('web')
    expect(provider.threadId(UUID)).toBe(true)
    expect(provider.threadId('not-a-uuid')).toBe(false)
  })

  test('Gemini has its own home, profile, ports and driver', () => {
    const provider = providerOf('gemini-web')
    expect(provider.home).toBe(join(homedir(), 'gemini-web'))
    expect(provider.privateHome).toBe(join(homedir(), '.gemini-web'))
    expect(provider.profile).toBe(join(homedir(), '.gemini-web', 'profile'))
    expect(provider.masterPort).toBe(9223)
    expect(provider.laneBasePort).toBe(9400)
    expect(provider.driver).toBe('gemini.mjs')
    expect(provider.peerPrefix).toBe('gemini')
    // Gemini conversation ids are opaque; a path or a query is never one.
    expect(provider.threadId('1a2b3c4d5e6f7a8b')).toBe(true)
    expect(provider.threadId('app/1a2b3c4d5e6f7a8b?x=1')).toBe(false)
    expect(provider.threadId('')).toBe(false)
  })

  test('an unknown provider id falls back to ChatGPT rather than inventing one', () => {
    expect(providerOf('nope').id).toBe('chatgpt-web')
  })

  test('resolveConfig derives the whole launch from the provider', () => {
    const chatgpt = resolveConfig({})
    expect(chatgpt.provider?.id).toBe('chatgpt-web')
    expect(chatgpt.home).toBe(join(homedir(), 'chatgpt-web'))
    expect(chatgpt.driverPath).toBe(join(homedir(), 'chatgpt-web', 'chatgpt.mjs'))
    expect(chatgpt.laneBasePort).toBe(9300)
    expect(chatgpt.laneSourcePort).toBe(9222)

    const gemini = resolveConfig({ provider: providerOf('gemini-web') })
    expect(gemini.provider?.id).toBe('gemini-web')
    expect(gemini.home).toBe(join(homedir(), 'gemini-web'))
    expect(gemini.driverPath).toBe(join(homedir(), 'gemini-web', 'gemini.mjs'))
    expect(gemini.profile).toBe(join(homedir(), '.gemini-web', 'profile'))
    expect(gemini.laneBasePort).toBe(9400)
    expect(gemini.laneSourcePort).toBe(9223)
  })

  test('the neutral environment name wins over the legacy one', () => {
    const previous = { neutral: process.env.WEB_BRIDGE_LANE_BASE_PORT, legacy: process.env.CHATGPT_WEB_LANE_BASE_PORT }
    try {
      process.env.WEB_BRIDGE_LANE_BASE_PORT = '9500'
      process.env.CHATGPT_WEB_LANE_BASE_PORT = '9600'
      expect(providerEnv('LANE_BASE_PORT')).toBe('9500')
      expect(resolveConfig({}).laneBasePort).toBe(9500)
    } finally {
      if (previous.neutral === undefined) delete process.env.WEB_BRIDGE_LANE_BASE_PORT
      else process.env.WEB_BRIDGE_LANE_BASE_PORT = previous.neutral
      if (previous.legacy === undefined) delete process.env.CHATGPT_WEB_LANE_BASE_PORT
      else process.env.CHATGPT_WEB_LANE_BASE_PORT = previous.legacy
    }
  })
})
