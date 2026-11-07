import { strict as assert } from 'node:assert'
import test from 'node:test'

const CATALOG = JSON.parse(
  await (await import('node:fs/promises')).readFile(
    new URL('../scripts/effort-capabilities.json', import.meta.url),
    'utf8',
  ),
)

async function load() {
  return import(
    `../src/utils/model/gatewayWebSearch.ts?case=${Date.now()}-${Math.random()}`
  )
}

test('the search providers are Haiku 5.5 and Luna, in that order', async () => {
  const { gatewayModelSupportsWebSearch, gatewaySearchRoutes } = await load()
  // Anthropic's own passthrough executes the tool and returns real result
  // blocks with URLs - verified live 2026-11-07 on haiku 5.5.
  assert.equal(gatewayModelSupportsWebSearch('gateway-claude-haiku-5-5'), true)
  // Codex executes it natively - `anthropicToCodex` maps the declaration onto
  // Codex's hosted `{type:'web_search'}` - but its results carry no URLs.
  assert.equal(gatewayModelSupportsWebSearch('gateway-gpt-6-luna'), true)

  // Exactly these three, in this order. Haiku 4.5 was removed deliberately.
  assert.deepEqual(
    gatewaySearchRoutes().map(route => route.id),
    ['haiku', 'luna', 'mistral'],
  )
  assert.deepEqual(
    gatewaySearchRoutes().map(route => route.label),
    ['Claude Haiku 5.5', 'Codex Luna', 'Mistral web search'],
  )
})

test('routes that cannot execute the server tool are not counted', async () => {
  const { gatewayModelSupportsWebSearch } = await load()
  // AMD Radeon answers HTTP 400 "does not support native web search"; the
  // commandcode/opencode/mistral chat-completions lanes hand the model a
  // `tool_use` named web_search that nothing runs. The DeepSeek routes served
  // it until their credential left the vault - a listed route that answers 401
  // can never serve a search. Haiku 4.5 is simply not offered any more.
  for (const model of [
    'gateway-amd-ds-v4-flash',
    'gateway-commandcode-deepseek-v4.1-flash',
    'gateway-opencode-deepseek-v4.1-flash',
    'gateway-mistral-vibe-deepseek-v4.1-flash',
    'gateway-ds-flash',
    'gateway-claude-haiku-4-5-20251001',
    'gateway-gpt-sol',
  ]) {
    assert.equal(
      gatewayModelSupportsWebSearch(model),
      false,
      `${model} must not be counted as executing the server tool`,
    )
  }
})

test('a session is offered web search even when its own backend cannot run it', async () => {
  const { gatewayWebSearchAvailability } = await load()
  // The search is a nested request addressed to a capable backend, so the
  // session's own backend is irrelevant - this is the case the user named
  // (commandcode/opencode deepseek). Withholding the tool here would hide a
  // working capability behind an unrelated backend limitation.
  for (const model of [
    'gateway-commandcode-deepseek-v4.1-flash',
    'gateway-gpt-luna',
    'gateway-amd-ds-v4-flash',
  ]) {
    assert.equal(
      gatewayWebSearchAvailability(model),
      true,
      `${model} sessions search via the redirect and must be offered the tool`,
    )
  }
})

test('the search request is addressed to a model whose backend executes it', async () => {
  const { resolveGatewayWebSearchModel } = await load()
  // A session already on an offered route keeps it rather than paying to
  // redirect to another backend.
  assert.equal(
    resolveGatewayWebSearchModel('gateway-gpt-6-luna'),
    'gateway-gpt-6-luna',
    'a Luna-routed session searches natively and must stay on its own route',
  )
  // Any other Codex generation is not offered any more; it redirects.
  assert.equal(
    resolveGatewayWebSearchModel('gateway-gpt-sol'),
    'gateway-claude-haiku-5-5',
  )
  // A route with no hosted search still gets a real search, because the search
  // is its own request and can be addressed to a backend that serves it. The
  // first entry is the Anthropic haiku route: cheapest, and it returns URLs
  // where Codex returns none.
  assert.equal(
    resolveGatewayWebSearchModel('gateway-commandcode-deepseek-v4.1-flash'),
    'gateway-claude-haiku-5-5',
    'a Command-Code-routed session searches on the cheap Claude route',
  )
  assert.equal(
    resolveGatewayWebSearchModel('gateway-mistral-vibe-deepseek-v4.1-flash'),
    'gateway-claude-haiku-5-5',
    'a Mistral-routed session searches on the cheap Claude route',
  )
  // The dead DeepSeek route must not keep a search addressed to itself.
  assert.equal(
    resolveGatewayWebSearchModel('gateway-ds-flash'),
    'gateway-claude-haiku-5-5',
  )
  // When the session already runs on a capable model, keep it.
  assert.equal(
    resolveGatewayWebSearchModel('gateway-claude-haiku-5-5'),
    'gateway-claude-haiku-5-5',
  )
})

test('every listed model is a real gateway route, so the list cannot rot', async () => {
  const listed = CATALOG.gatewayWebSearch.serverToolModels
  const options = CATALOG.gatewayModelOptions.map(option => option.value)
  // The Mistral executor is a hidden route on purpose: it is not a
  // conversation model, so it is never selectable in the picker.
  const hiddenButReal = new Set(['gateway-mistral-search'])
  assert.ok(listed.length > 0, 'at least one model must be able to search')
  for (const model of listed) {
    assert.ok(
      options.includes(model) || hiddenButReal.has(model),
      `${model} is listed as able to search but is not a selectable route`,
    )
  }
})
