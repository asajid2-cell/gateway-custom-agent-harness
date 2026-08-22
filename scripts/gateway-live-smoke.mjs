const url = process.env.GATEWAY_SMOKE_URL || 'http://127.0.0.1:4011/v1/messages'
const model = process.env.GATEWAY_SMOKE_MODEL || 'opencode-go/mimo-v2.5'
const toolMode = process.env.GATEWAY_SMOKE_TOOL === '1'
const body = {
  model,
  max_tokens: toolMode ? 32 : 8,
  messages: [{
    role: 'user',
    content: toolMode
      ? 'Call the emit_value tool with the value OK.'
      : 'Reply with exactly OK.',
  }],
  ...(toolMode
    ? {
        tools: [{
          name: 'emit_value',
          description: 'Emit one short value.',
          input_schema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false,
          },
        }],
        tool_choice: { type: 'tool', name: 'emit_value' },
      }
    : {}),
}
const started = performance.now()
try {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(process.env.GATEWAY_SMOKE_TIMEOUT_MS || 60000)),
  })
  const reader = response.body?.getReader()
  let firstByteMs
  let chunks = 0
  let bytes = 0
  let text = ''
  if (reader) {
    while (chunks < 256) {
      const next = await reader.read()
      if (next.done) break
      if (firstByteMs == null) firstByteMs = Math.round(performance.now() - started)
      chunks += 1
      bytes += next.value.byteLength
      text += new TextDecoder().decode(next.value)
      if (text.includes('event: message_stop')) break
    }
    if (!text.includes('event: message_stop')) await reader.cancel().catch(() => {})
  }
  const events = text.split('\n\n').filter(Boolean)
  const hasJsonError = text.includes('"type":"error"') || text.includes('"type": "error"')
  const hasToolUse = text.includes('"type":"tool_use"') || text.includes('"type": "tool_use"')
  console.log(JSON.stringify({
    errorClass: response.ok ? undefined : hasJsonError ? 'gateway-or-provider-error' : `http-${response.status}`,
    model,
    status: response.status,
    ok: response.ok,
    firstByteMs: firstByteMs ?? null,
    totalMs: Math.round(performance.now() - started),
    chunks,
    bytes,
    hasMessageStart: text.includes('event: message_start'),
    hasMessageStop: text.includes('event: message_stop'),
    hasError: text.includes('event: error'),
    hasToolUse,
    eventCount: events.length,
    result: response.ok && text.includes('event: message_start') && text.includes('event: message_stop') && (!toolMode || hasToolUse) ? 'pass' : 'gateway-response-failed',
  }))
  process.exitCode = response.ok && text.includes('event: message_start') && text.includes('event: message_stop') && (!toolMode || hasToolUse) ? 0 : 1
} catch (error) {
  console.log(JSON.stringify({ model, result: 'connection-error', errorClass: error?.name || 'Error' }))
  process.exitCode = 1
}
