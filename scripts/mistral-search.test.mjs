import { strict as assert } from 'node:assert'
import test from 'node:test'

// The Mistral web-search route executes Anthropic's server tool through the
// Conversations API. Its translation units are pure, so they can be checked
// without a key: the query the tool built, the domain filter, and the conversion
// of Mistral's packed result map into Anthropic result blocks.
//
// The live behaviour behind them was probed 2026-11-07: `POST /v1/conversations`
// with `tools:[{type:'web_search'}]` answers `tool.execution` (query and
// results) plus `message.output` (text and tool_reference citations), on both
// the Vibe and the Studio key, while chat completions refuses the connector.

const {
  mistralSearchQuery,
  mistralSearchResults,
} = await import('../scripts/model-gateway.mjs')

const TOOL_TURN = {
  role: 'user',
  content: 'Perform a web search for the query: newest stable Node.js release',
}

test('the query is the last user turn without the tool prefix', () => {
  assert.equal(
    mistralSearchQuery({ messages: [TOOL_TURN] }),
    'newest stable Node.js release',
  )
  assert.equal(
    mistralSearchQuery({
      messages: [
        { role: 'user', content: 'ignore me' },
        TOOL_TURN,
      ],
    }),
    'newest stable Node.js release',
  )
  assert.equal(mistralSearchQuery({ messages: [] }), '')
  assert.equal(mistralSearchQuery({}), '')
})

test('the query survives a block-shaped message', () => {
  assert.equal(
    mistralSearchQuery({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Perform a web search for the query: Swift 6.2 notes' },
          ],
        },
      ],
    }),
    'Swift 6.2 notes',
  )
})

const EXECUTION = {
  type: 'tool.execution',
  name: 'web_search',
  info: {
    result: JSON.stringify({
      a1: { url: 'https://nodejs.org/en/blog/release/v26.13.0', title: 'Node.js 26.13.0' },
      a2: { url: 'https://example.com/blog/post', title: 'Example' },
      a3: { url: 'https://docs.nodejs.org/api', title: 'Docs' },
      a4: { url: 'not a url', title: 'broken' },
    }),
  },
}

test('results become Anthropic web_search_result blocks with a url and title', () => {
  const results = mistralSearchResults(EXECUTION, { allowed: [], blocked: [] })
  assert.deepEqual(
    results.map(result => [result.type, result.title, result.url]),
    [
      ['web_search_result', 'Node.js 26.13.0', 'https://nodejs.org/en/blog/release/v26.13.0'],
      ['web_search_result', 'Example', 'https://example.com/blog/post'],
      ['web_search_result', 'Docs', 'https://docs.nodejs.org/api'],
    ],
  )
})

test('the domain filter applies to allowed and blocked lists', () => {
  // A blocked domain is removed; the rest survive.
  assert.deepEqual(
    mistralSearchResults(EXECUTION, { allowed: [], blocked: ['example.com'] }).map(
      result => result.url,
    ),
    ['https://nodejs.org/en/blog/release/v26.13.0', 'https://docs.nodejs.org/api'],
  )
  // An allowlist keeps only its domains, and a subdomain counts.
  assert.deepEqual(
    mistralSearchResults(EXECUTION, { allowed: ['nodejs.org'], blocked: [] }).map(
      result => result.url,
    ),
    ['https://nodejs.org/en/blog/release/v26.13.0', 'https://docs.nodejs.org/api'],
  )
})

test('a malformed or missing result map is empty, not a throw', () => {
  assert.deepEqual(mistralSearchResults({}, { allowed: [], blocked: [] }), [])
  assert.deepEqual(
    mistralSearchResults({ info: { result: 'not json' } }, { allowed: [], blocked: [] }),
    [],
  )
  assert.deepEqual(
    mistralSearchResults({ info: { result: '[]' } }, { allowed: [], blocked: [] }),
    [],
  )
})
