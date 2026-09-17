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

test('a DeepSeek-routed model is offered web search', async () => {
  const { gatewayWebSearchAvailability } = await load()
  for (const model of ['gateway-ds-flash', 'gateway-ds-pro', 'gateway-ds-4.1-flash']) {
    assert.equal(
      gatewayWebSearchAvailability(model),
      true,
      `${model} serves the server-side web_search tool (verified live)`,
    )
  }
})

test('the backends that serve the server tool are the DeepSeek and Codex routes', async () => {
  const { gatewayModelSupportsWebSearch } = await load()
  for (const model of ['gateway-ds-flash', 'gateway-ds-pro', 'gateway-ds-4.1-flash']) {
    assert.equal(
      gatewayModelSupportsWebSearch(model),
      true,
      `${model} executes the server tool (verified live: real result blocks)`,
    )
  }
  // Codex executes it too, but natively - `anthropicToCodex` maps the
  // declaration onto Codex's hosted `{type:'web_search'}` rather than a
  // function call, and live probes return `web_search_call` items with real
  // queries and live citations (luna, sol, astra all verified).
  for (const model of ['gateway-gpt-luna', 'gateway-gpt-sol', 'gateway-gpt-astra']) {
    assert.equal(
      gatewayModelSupportsWebSearch(model),
      true,
      `${model} executes the search natively via the Codex hosted tool`,
    )
  }
  // AMD Radeon answers HTTP 400 "does not support native web search"; the
  // commandcode/opencode chat-completions lanes hand the model a `tool_use`
  // named web_search that nothing runs. Neither may be counted as serving it.
  for (const model of [
    'gateway-amd-ds-v4-flash',
    'gateway-commandcode-deepseek-v4.1-flash',
    'gateway-opencode-deepseek-v4.1-flash',
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
  // A Codex session runs its search natively now, so it keeps the route it is
  // already on rather than paying to redirect to another backend.
  assert.equal(
    resolveGatewayWebSearchModel('gateway-gpt-luna'),
    'gateway-gpt-luna',
    'a Codex-routed session searches natively and must stay on its own route',
  )
  // A route with no hosted search still gets a real search, because the search
  // is its own request and can be addressed to a backend that serves it.
  assert.equal(
    resolveGatewayWebSearchModel('gateway-commandcode-deepseek-v4.1-flash'),
    CATALOG.gatewayWebSearch.serverToolModels[0],
    'a Command-Code-routed session must not send the search to chat-completions',
  )
  // When the session already runs on a capable model, keep it.
  assert.equal(
    resolveGatewayWebSearchModel('gateway-ds-flash'),
    'gateway-ds-flash',
  )
})

test('every listed model is a real gateway route, so the list cannot rot', async () => {
  const listed = CATALOG.gatewayWebSearch.serverToolModels
  const options = CATALOG.gatewayModelOptions.map(option => option.value)
  assert.ok(listed.length > 0, 'at least one model must be able to search')
  for (const model of listed) {
    assert.ok(
      options.includes(model),
      `${model} is listed as able to search but is not a selectable route`,
    )
  }
})
