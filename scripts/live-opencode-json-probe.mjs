const model = process.env.OPENCODE_JSON_MODEL || 'glm-5.2'
const effort = process.env.OPENCODE_JSON_EFFORT || 'high'
const endpoint = 'https://opencode.ai/zen/go/v1/chat/completions'
const key = process.env.OPENCODE_API_KEY

if (!key) {
  console.log(JSON.stringify({ result: 'invalid-test-configuration' }))
  process.exitCode = 2
} else {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: Number(process.env.OPENCODE_JSON_MAX_TOKENS || 96),
        messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
        reasoning_effort: effort,
      }),
      signal: AbortSignal.timeout(Number(process.env.OPENCODE_JSON_TIMEOUT_MS || 60_000)),
    })
    const raw = await response.text()
    let body = null
    try {
      body = JSON.parse(raw)
    } catch {
      // Keep malformed provider output classified without emitting it.
    }
    const message = body?.choices?.[0]?.message
    const content = message?.content
    const reasoning = message?.reasoning_content ?? message?.reasoning
    console.log(JSON.stringify({
      model,
      effort,
      status: response.status,
      ok: response.ok,
      topLevelKeys: body && typeof body === 'object' ? Object.keys(body).sort() : [],
      choiceCount: Array.isArray(body?.choices) ? body.choices.length : 0,
      messageKeys: message && typeof message === 'object' ? Object.keys(message).sort() : [],
      contentLength: typeof content === 'string' ? content.length : 0,
      reasoningLength: typeof reasoning === 'string' ? reasoning.length : 0,
      finishReason: body?.choices?.[0]?.finish_reason ?? null,
      providerError: typeof body?.error?.message === 'string'
        ? body.error.message.slice(0, 500)
        : '',
      result: response.ok && Array.isArray(body?.choices) && body.choices.length > 0
        ? 'pass'
        : 'provider-response-failed',
    }))
    process.exitCode = response.ok && Array.isArray(body?.choices) && body.choices.length > 0 ? 0 : 1
  } catch (error) {
    console.log(JSON.stringify({
      model,
      effort,
      result: error?.name === 'TimeoutError' ? 'timeout' : 'connection-error',
      errorClass: error?.name || 'Error',
    }))
    process.exitCode = 1
  }
}
