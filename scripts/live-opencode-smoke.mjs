const model = process.env.OPENCODE_SMOKE_MODEL || 'mimo-v2.5'
const protocol = process.env.OPENCODE_SMOKE_PROTOCOL || 'chat-completions'
const gatewayUrl = process.env.OPENCODE_SMOKE_GATEWAY_URL
  || 'https://opencode.ai/zen/go/v1'
const endpoint = {
  responses: 'https://opencode.ai/zen/go/v1/responses',
  'chat-completions': 'https://opencode.ai/zen/go/v1/chat/completions',
  'anthropic-messages': 'https://opencode.ai/zen/go/v1/messages',
}[protocol]
const key = process.env.OPENCODE_API_KEY

if (!key || !endpoint) {
  console.log(JSON.stringify({ model, protocol, result: 'invalid-test-configuration' }))
  process.exitCode = 2
} else {
  const headers = {
    authorization: protocol === 'anthropic-messages' ? undefined : `Bearer ${key}`,
    'x-api-key': protocol === 'anthropic-messages' ? key : undefined,
    'anthropic-version': protocol === 'anthropic-messages' ? '2023-06-01' : undefined,
    'content-type': 'application/json',
    accept: 'text/event-stream',
  }
  for (const name of Object.keys(headers)) if (headers[name] === undefined) delete headers[name]
  const body = protocol === 'responses'
    ? { model, stream: true, input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply with exactly OK.' }] }], max_output_tokens: 8 }
    : protocol === 'anthropic-messages'
      ? { model, stream: true, max_tokens: 8, messages: [{ role: 'user', content: 'Reply with exactly OK.' }] }
      : { model, stream: true, max_tokens: 8, messages: [{ role: 'user', content: 'Reply with exactly OK.' }] }
  const started = performance.now()
  try {
    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) })
    const firstByteStart = performance.now()
    const reader = response.body?.getReader()
    let chunks = 0
    let bytes = 0
    let hasData = false
    let hasDone = false
    const eventShapes = []
    let pending = ''
    const recordSse = chunk => {
      pending += chunk
      const frames = pending.split(/\r?\n\r?\n/)
      pending = frames.pop() || ''
      for (const frame of frames) {
        const data = frame.split(/\r?\n/).find(line => line.startsWith('data:'))?.slice(5).trim()
        if (!data || data === '[DONE]') continue
        try {
          const event = JSON.parse(data)
          eventShapes.push({
            type: typeof event.type === 'string' ? event.type : undefined,
            choices: Array.isArray(event.choices) ? event.choices.length : undefined,
            choiceShapes: Array.isArray(event.choices)
              ? event.choices.slice(0, 3).map(choice => ({
                  finish: choice?.finish_reason,
                  deltaKeys: choice?.delta && typeof choice.delta === 'object' ? Object.keys(choice.delta).sort() : [],
                  contentLength: typeof choice?.delta?.content === 'string' ? choice.delta.content.length : undefined,
                  reasoningLength: typeof choice?.delta?.reasoning === 'string' ? choice.delta.reasoning.length : undefined,
                  reasoningDetailsCount: Array.isArray(choice?.delta?.reasoning_details) ? choice.delta.reasoning_details.length : undefined,
                  toolCallCount: Array.isArray(choice?.delta?.tool_calls) ? choice.delta.tool_calls.length : undefined,
                }))
              : undefined,
            usageKeys: event.usage && typeof event.usage === 'object' ? Object.keys(event.usage).sort() : undefined,
            responseKeys: event.response && typeof event.response === 'object' ? Object.keys(event.response).sort() : undefined,
          })
        } catch {
          eventShapes.push({ malformed: true })
        }
      }
    }
    if (reader) {
      while (chunks < 16) {
        const next = await reader.read()
        if (next.done) break
        chunks += 1
        bytes += next.value.byteLength
        const text = new TextDecoder().decode(next.value)
        hasData ||= text.includes('data:')
        hasDone ||= text.includes('[DONE]')
        recordSse(text)
      }
      recordSse('\\n\\n')
      await reader.cancel().catch(() => {})
    }
    console.log(JSON.stringify({ model, protocol, status: response.status, ok: response.ok, firstByteMs: Math.round(firstByteStart - started), chunks, bytes, hasData, hasDone, eventShapes, result: response.ok && hasData ? 'pass' : 'provider-response-failed' }))
    process.exitCode = response.ok && hasData ? 0 : 1
  } catch (error) {
    console.log(JSON.stringify({ model, protocol, result: 'connection-error', errorClass: error?.name || 'Error' }))
    process.exitCode = 1
  }
}
