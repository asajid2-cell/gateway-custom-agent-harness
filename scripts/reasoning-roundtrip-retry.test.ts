import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { APIError } from '@anthropic-ai/sdk'
import { isUnrecoverableReasoningError } from '../src/services/api/withRetry.js'

const withRetry = await readFile(
  new URL('../src/services/api/withRetry.ts', import.meta.url),
  'utf8',
)
const claude = await readFile(
  new URL('../src/services/api/claude.ts', import.meta.url),
  'utf8',
)

/**
 * A provider's thinking mode can reject a follow-up turn whose assistant
 * messages no longer carry the reasoning it produced:
 *
 *   OpenCode Go returned HTTP 400: Error from provider (Console Go): Upstream
 *   request failed: [invalid_request_error] The `reasoning_content` in the
 *   thinking mode must be passed back to the API.
 *
 * Measured against the live provider: the requirement is per assistant turn
 * that carries `tool_calls`, and it is cumulative - with two tool-call rounds
 * in history, stripping either one's reasoning fails the whole request. The
 * adapter now sends the field (see the Chat Completions reasoning tests in
 * model-gateway.test.mjs), but a session already broken by the old adapter
 * still holds the offending history, so the turn has to be retryable.
 *
 * Repeating the request cannot help: the reasoning text is gone. The retry is
 * only worth making because it sends a *different* request, with the blocks the
 * provider objects to dropped.
 */

// The real SDK error type, built the way the SDK builds it: the provider's
// message is embedded in a generic api_error body, so the wording is the only
// signal available.
const apiError = (status, message) => new APIError(status, { message }, undefined, {})

const REJECTION =
  'OpenCode Go returned HTTP 400: Error from provider (Console Go): Upstream ' +
  'request failed: [invalid_request_error] The `reasoning_content` in the ' +
  'thinking mode must be passed back to the API.'

test('recognizes the reasoning round-trip rejection', () => {
  assert.equal(isUnrecoverableReasoningError(apiError(400, REJECTION)), true)
})

test('does not claim unrelated 400s', () => {
  const unrelated = [
    // A different 400 entirely.
    'input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000',
    // Right subject, wrong class of error: this one is retryable as a 5xx.
    'reasoning_content was rejected',
    // A message mentioning both words but not the provider's phrasing.
    'thinking mode is not supported for this model',
    // An empty message must not match.
    '',
  ]
  for (const message of unrelated) {
    assert.equal(
      isUnrecoverableReasoningError(apiError(400, message)),
      false,
      `must not treat as a reasoning round-trip rejection: ${message}`,
    )
  }
  // Not a 400, and not an APIError at all.
  assert.equal(isUnrecoverableReasoningError(apiError(500, REJECTION)), false)
  assert.equal(isUnrecoverableReasoningError(new Error(REJECTION)), false)
  assert.equal(isUnrecoverableReasoningError(undefined), false)
})

test('the retry is reachable from the retry loop, not just from shouldRetry', () => {
  // shouldRetry gates the generic path; this branch has to run before it or
  // the 400 is thrown as a CannotRetryError before the strip ever happens.
  assert.match(withRetry, /if \(isUnrecoverableReasoningError\(error\)\) \{/)
  assert.match(withRetry, /retryContext\.reasoningUnrecoverable = true/)
  assert.match(withRetry, /tengu_api_reasoning_roundtrip_retry/)
})

test('the retry stops after the stripped request has been tried', () => {
  // A second identical rejection means the strip did not help. Without this
  // guard the loop would retry the same request maxRetries times.
  const branch = withRetry.slice(
    withRetry.indexOf('if (isUnrecoverableReasoningError(error)) {'),
    withRetry.indexOf('tengu_api_reasoning_roundtrip_retry'),
  )
  assert.match(
    branch,
    /if \(retryContext\.reasoningUnrecoverable\) \{\s*throw new CannotRetryError\(error, retryContext\)/,
  )
})

test('the request drops reasoning blocks once the round trip has failed', () => {
  // The strip is applied to the messages handed to addCacheBreakpoints, so the
  // cache marker still lands on the final surviving message.
  assert.match(
    claude,
    /retryContext\.reasoningUnrecoverable\s*\?\s*stripReasoningBlocks\(messagesForAPI\)/,
  )
  assert.match(
    claude,
    /block\.type !== 'thinking' && block\.type !== 'redacted_thinking'/,
  )
})

test('a turn left holding nothing but reasoning is dropped, not sent empty', () => {
  const stripper = claude.slice(
    claude.indexOf('function stripReasoningBlocks('),
    claude.indexOf('export type Options = {'),
  )
  assert.match(stripper, /if \(filtered\.length === 0\) return \[\]/)
})

test('the request is rebuilt from the retry context on every attempt', () => {
  // The strip only reaches the wire if paramsFromContext is called inside the
  // retry loop rather than once before it.
  const loop = claude.slice(
    claude.indexOf('const generator = withRetry('),
    claude.indexOf('queryCheckpoint(\'query_api_request_sent\')'),
  )
  assert.match(loop, /const params = paramsFromContext\(context\)/)
})
