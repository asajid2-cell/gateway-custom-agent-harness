import { test, expect, beforeEach, afterEach } from 'bun:test'
import {
  redactToolResultText,
  redactToolResultValue,
  redactToolResultBlock,
  resetKnownSecretsForTests,
} from '../src/services/tools/toolResultRedaction.js'

/**
 * The redaction applies at one choke point (`addToolResult`) to every string a
 * tool produced. These tests exercise the three passes directly — known value,
 * name-based, shape — and the deep walk that carries them into the raw
 * `toolUseResult` stored on the transcript message.
 *
 * The known-value pass is the one that makes the promise real: a leaf cannot
 * leak a secret it was handed by the environment, even if it echoes it. The
 * value below stands in for the live gateway token this process actually holds;
 * it is set as an env var so the pass sources it exactly the way it sources the
 * real one.
 */

const ENV_NAME = 'GATEWAY_TEST_KNOWN_SECRET'
const ENV_VALUE = 's3cr3t-known-value-abcdef123456'
const MARKER = `[REDACTED:${ENV_NAME}]`

beforeEach(() => {
  process.env[ENV_NAME] = ENV_VALUE
  resetKnownSecretsForTests()
})

afterEach(() => {
  delete process.env[ENV_NAME]
  resetKnownSecretsForTests()
})

test('known value is replaced verbatim with a labelled marker', () => {
  const out = redactToolResultText(`echo ${ENV_VALUE} done`)
  expect(out).toBe(`echo ${MARKER} done`)
  expect(out).not.toContain(ENV_VALUE)
})

test('known value is caught in base64, hex and url-encoded form', () => {
  const base64 = Buffer.from(ENV_VALUE, 'utf8').toString('base64')
  const hex = Buffer.from(ENV_VALUE, 'utf8').toString('hex')
  const url = encodeURIComponent(ENV_VALUE)
  for (const encoded of [base64, hex, url]) {
    const out = redactToolResultText(`blob=${encoded}`)
    expect(out).not.toContain(encoded)
    expect(out).toContain(MARKER)
  }
})

test('name-based redaction: assignment, JSON, .env and YAML', () => {
  expect(redactToolResultText('password = hunter2hunter2')).toBe(
    'password = [REDACTED:PASSWORD]',
  )
  expect(redactToolResultText('{"api_key": "abcd1234efgh"}')).toBe(
    '{"api_key": "[REDACTED:API_KEY]"}',
  )
  expect(redactToolResultText('export DATABASE_PASSWORD=supersecretpw')).toBe(
    'export DATABASE_PASSWORD=[REDACTED:DATABASE_PASSWORD]',
  )
  expect(redactToolResultText('client_secret: abcdefghij')).toBe(
    'client_secret: [REDACTED:CLIENT_SECRET]',
  )
})

test('Authorization headers are redacted with their scheme kept', () => {
  expect(redactToolResultText('-H "Authorization: Bearer abcdefghijklmnop"')).toBe(
    '-H "Authorization: Bearer [REDACTED:AUTHORIZATION]"',
  )
})

test('PEM private key blocks are redacted (shape pass)', () => {
  const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ'
  const pem = `-----BEGIN PRIVATE KEY-----\n${body}${body}\n-----END PRIVATE KEY-----`
  const out = redactToolResultText(pem)
  expect(out).not.toContain('MIIEvQ')
  expect(out).toContain('[REDACTED]')
})

test('JWTs are redacted (shape pass)', () => {
  const jwt =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
  const out = redactToolResultText(`token ${jwt}`)
  expect(out).not.toContain(jwt)
  expect(out).toContain('[REDACTED:JWT]')
})

test('ordinary prose is not mangled', () => {
  const prose =
    'The API key is documented in the README; see the token section for how to rotate it.'
  expect(redactToolResultText(prose)).toBe(prose)
})

test('redaction is idempotent', () => {
  const once = redactToolResultText(`password=hunter2hunter2 token=${ENV_VALUE}`)
  expect(redactToolResultText(once)).toBe(once)
})

test('deep walk redacts string leaves, preserves non-plain values and scalars', () => {
  const buffer = Buffer.from('plain-bytes')
  const value = {
    stdout: `echo ${ENV_VALUE}`,
    nested: [{ stderr: 'password=hunter2hunter2' }],
    count: 3,
    ok: true,
    buffer,
  }
  const out = redactToolResultValue(value) as typeof value
  expect(out.stdout).toBe(`echo ${MARKER}`)
  expect(out.nested[0]!.stderr).toBe('password=[REDACTED:PASSWORD]')
  expect(out.count).toBe(3)
  expect(out.ok).toBe(true)
  // Non-plain objects are returned untouched (same reference, intact bytes).
  expect(out.buffer).toBe(buffer)
  expect(out.buffer.toString()).toBe('plain-bytes')
})

test('block redaction rewrites text content and leaves images alone', () => {
  const image = { type: 'image', source: { type: 'base64', data: 'AAAA' } }
  const block = {
    type: 'tool_result' as const,
    tool_use_id: 'toolu_1',
    content: [{ type: 'text' as const, text: `key=${ENV_VALUE}` }, image],
  }
  const out = redactToolResultBlock(block)
  const content = out.content as unknown as Array<{ type: string; text?: string }>
  expect(content[0]!.text).toBe(`key=${MARKER}`)
  expect(content[1]).toBe(image)
})
