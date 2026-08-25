const model = process.env.OPENCODE_MULTI_TOOL_MODEL || 'ox-alpha-free'
const endpoint = process.env.OPENCODE_GO_CHAT_COMPLETIONS_URL
  || 'https://opencode.ai/zen/go/v1/chat/completions'
const key = process.env.OPENCODE_API_KEY
const timeoutMs = Number(process.env.OPENCODE_MULTI_TOOL_TIMEOUT_MS || 60000)

if (!key) {
  console.log(JSON.stringify({ result: 'invalid-test-configuration' }))
  process.exitCode = 2
} else {
  const body = {
    model,
    stream: false,
    max_tokens: 256,
    messages: [{
      role: 'user',
      content: 'Call read_file on README.md and shell with pwd. Do not answer until both calls are emitted.',
    }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a named file and return its text.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'shell',
          description: 'Run a harmless shell command and return its output.',
          parameters: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
          },
        },
      },
    ],
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const raw = await response.text()
    let parsed = null
    try {
      parsed = JSON.parse(raw)
    } catch {
      // Report only the shape below; never print a provider body or key.
    }
    const choices = Array.isArray(parsed?.choices) ? parsed.choices : []
    const calls = choices.flatMap(choice =>
      Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls : [],
    )
    const toolNames = calls
      .map(call => call?.function?.name)
      .filter(name => typeof name === 'string')
    const errorMessage = typeof parsed?.error?.message === 'string'
      ? parsed.error.message.slice(0, 300)
      : ''
    console.log(JSON.stringify({
      result: response.ok && toolNames.length >= 2 ? 'pass' : 'provider-limitation-or-failure',
      model,
      status: response.status,
      ok: response.ok,
      responseKeys: parsed && typeof parsed === 'object' ? Object.keys(parsed).sort() : [],
      choiceCount: choices.length,
      toolCount: calls.length,
      toolNames,
      finishReasons: choices.map(choice => choice?.finish_reason).filter(Boolean),
      errorMessage,
    }))
    process.exitCode = response.ok && toolNames.length >= 2 ? 0 : 1
  } catch (error) {
    console.log(JSON.stringify({
      result: error?.name === 'AbortError' ? 'timeout' : 'connection-error',
      model,
      status: 0,
      ok: false,
      errorClass: error?.name || 'Error',
    }))
    process.exitCode = 1
  } finally {
    clearTimeout(timer)
  }
}
