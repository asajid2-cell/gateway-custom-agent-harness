import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
const portIndex = args.indexOf('--port')
const port = Number(portIndex >= 0 ? args[portIndex + 1] : process.env.LUNA_BRIDGE_PORT || 4011)
const host = '127.0.0.1'
const model = process.env.LUNA_MODEL || 'gpt-5.6-luna'
const reasoningEffort = process.env.LUNA_REASONING_EFFORT || 'max'
const codexEndpoint =
  process.env.CODEX_RESPONSES_URL || 'https://chatgpt.com/backend-api/codex/responses'
const localToken = process.env.LUNA_BRIDGE_TOKEN || 'local-luna'

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid bridge port: ${port}`)
}

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function sendEvent(res, type, data) {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      if (typeof block === 'string') return block
      if (block?.type === 'text' || block?.type === 'input_text') {
        return block.text || ''
      }
      return ''
    })
    .join('')
}

function systemText(system) {
  return contentText(system)
}

function appendAnthropicMessage(input, message) {
  const role = message.role === 'assistant' ? 'assistant' : 'user'
  const content = typeof message.content === 'string'
    ? [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: message.content }]
    : Array.isArray(message.content)
      ? message.content
      : []

  for (const block of content) {
    if (typeof block === 'string') {
      input.push({
        role,
        content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: block }],
      })
      continue
    }

    if (block?.type === 'text') {
      input.push({
        role,
        content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: block.text || '' }],
      })
      continue
    }

    if (block?.type === 'tool_use') {
      input.push({
        type: 'function_call',
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
      })
      continue
    }

    if (block?.type === 'tool_result') {
      input.push({
        type: 'function_call_output',
        call_id: block.tool_use_id,
        output: contentText(block.content),
      })
      continue
    }

    if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
      continue
    }

    if (block?.type === 'image') {
      throw new Error('Images are not supported by the Luna bridge yet')
    }
  }
}

function anthropicToCodex(body) {
  const input = []
  for (const message of body.messages || []) {
    appendAnthropicMessage(input, message)
  }

  const request = {
    model,
    stream: true,
    store: false,
    input,
    reasoning: {
      effort: body.output_config?.effort || body.reasoning?.effort || reasoningEffort,
      summary: 'detailed',
    },
  }

  const instructions = systemText(body.system)
  if (instructions) request.instructions = instructions
  if (body.temperature != null) request.temperature = body.temperature
  if (body.top_p != null) request.top_p = body.top_p
  if (body.tools?.length) {
    request.tools = body.tools.map(tool => ({
      type: 'function',
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || { type: 'object' },
    }))
  }

  if (body.tool_choice === 'auto' || body.tool_choice === 'none' || body.tool_choice === 'any') {
    request.tool_choice = body.tool_choice === 'any' ? 'required' : body.tool_choice
  } else if (body.tool_choice?.type === 'tool' && body.tool_choice.name) {
    request.tool_choice = { type: 'function', name: body.tool_choice.name }
  }

  return request
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 50 * 1024 * 1024) throw new Error('Request body is too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function readCodexAuth() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  const auth = JSON.parse(await fs.readFile(path.join(home, 'auth.json'), 'utf8'))
  const accessToken = auth?.tokens?.access_token
  const accountId = auth?.tokens?.account_id
  if (!accessToken || !accountId) {
    throw new Error('Codex ChatGPT auth is missing or incomplete; run codex login first')
  }
  return { accessToken, accountId }
}

function anthropicError(res, status, message) {
  json(res, status, {
    type: 'error',
    error: { type: 'api_error', message },
  })
}

function writeMessageStart(res, id) {
  sendEvent(res, 'message_start', {
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })
  sendEvent(res, 'ping', {})
}

async function relayStream(res, upstream) {
  const messageId = `msg_${randomUUID().replaceAll('-', '')}`
  let contentIndex = 0
  let activeText = false
  let activeTool = null
  let sawOutput = false
  let toolCallSeen = false
  let usage = null
  let buffer = ''

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  writeMessageStart(res, messageId)

  const closeActive = () => {
    if (activeText || activeTool) sendEvent(res, 'content_block_stop', { index: contentIndex })
    activeText = false
    activeTool = null
  }

  const openText = () => {
    if (activeText) return
    closeActive()
    activeText = true
    sawOutput = true
    sendEvent(res, 'content_block_start', {
      index: contentIndex,
      content_block: { type: 'text', text: '' },
    })
  }

  const openTool = item => {
    closeActive()
    activeTool = {
      callId: item.call_id || item.id || `call_${randomUUID().replaceAll('-', '')}`,
      name: item.name || 'tool',
    }
    toolCallSeen = true
    sawOutput = true
    sendEvent(res, 'content_block_start', {
      index: contentIndex,
      content_block: {
        type: 'tool_use',
        id: activeTool.callId,
        name: activeTool.name,
        input: {},
      },
    })
  }

  const emitCompletedOutputFallback = response => {
    if (sawOutput || !response?.output) return
    for (const item of response.output) {
      if (item.type === 'message') {
        for (const part of item.content || []) {
          if (part.type === 'output_text' && part.text) {
            openText()
            sendEvent(res, 'content_block_delta', {
              index: contentIndex,
              delta: { type: 'text_delta', text: part.text },
            })
          }
        }
      } else if (item.type === 'function_call') {
        openTool(item)
        sendEvent(res, 'content_block_delta', {
          index: contentIndex,
          delta: { type: 'input_json_delta', partial_json: item.arguments || '{}' },
        })
      }
    }
  }

  const handleEvent = event => {
    const type = event?.type
    if (type === 'response.output_item.added' && event.item?.type === 'function_call') {
      openTool(event.item)
      return
    }
    if (type === 'response.output_text.delta') {
      openText()
      sendEvent(res, 'content_block_delta', {
        index: contentIndex,
        delta: { type: 'text_delta', text: event.delta || '' },
      })
      return
    }
    if (type === 'response.function_call_arguments.delta') {
      if (!activeTool) openTool(event.item || {})
      sendEvent(res, 'content_block_delta', {
        index: contentIndex,
        delta: { type: 'input_json_delta', partial_json: event.delta || '' },
      })
      return
    }
    if (type === 'response.output_item.done' && event.item?.type === 'function_call') {
      if (!activeTool) openTool(event.item)
      closeActive()
      contentIndex += 1
      return
    }
    if (type === 'response.completed') {
      usage = event.response?.usage || event.usage || null
      emitCompletedOutputFallback(event.response)
      return
    }
    if (type === 'response.failed') {
      throw new Error(event.response?.error?.message || 'Codex response failed')
    }
  }

  const decoder = new TextDecoder()
  const reader = upstream.body.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6)
      if (!data || data === '[DONE]') continue
      handleEvent(JSON.parse(data))
    }
  }

  closeActive()
  sendEvent(res, 'message_delta', {
    delta: {
      stop_reason: toolCallSeen ? 'tool_use' : 'end_turn',
      stop_sequence: null,
    },
    usage: {
      output_tokens: usage?.output_tokens || 0,
    },
  })
  sendEvent(res, 'message_stop', {})
  res.end()
}

async function handleMessages(req, res) {
  let body
  try {
    body = await readBody(req)
  } catch (error) {
    anthropicError(res, 400, error instanceof Error ? error.message : 'Invalid JSON')
    return
  }

  let auth
  try {
    auth = await readCodexAuth()
  } catch (error) {
    anthropicError(res, 401, error instanceof Error ? error.message : 'Codex auth unavailable')
    return
  }

  let request
  try {
    request = anthropicToCodex(body)
  } catch (error) {
    anthropicError(res, 400, error instanceof Error ? error.message : 'Unsupported request')
    return
  }

  let upstream
  try {
    upstream = await fetch(codexEndpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        'chatgpt-account-id': auth.accountId,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'user-agent': 'claudex-luna/0.1',
      },
      body: JSON.stringify(request),
    })
  } catch (error) {
    anthropicError(res, 502, error instanceof Error ? error.message : 'Codex connection failed')
    return
  }

  if (!upstream.ok) {
    const text = (await upstream.text()).slice(0, 1000)
    anthropicError(res, upstream.status >= 500 ? 502 : upstream.status, `Codex returned HTTP ${upstream.status}: ${text}`)
    return
  }

  try {
    await relayStream(res, upstream)
  } catch (error) {
    if (!res.headersSent) {
      anthropicError(res, 502, error instanceof Error ? error.message : 'Codex stream failed')
    } else {
      res.destroy(error instanceof Error ? error : undefined)
    }
  }
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${host}:${port}`)
  if (req.method === 'GET' && requestUrl.pathname === '/health') {
    json(res, 200, { status: 'ok', model, reasoningEffort })
    return
  }
  if (req.method === 'POST' && requestUrl.pathname === '/v1/messages') {
    const suppliedToken =
      req.headers['x-api-key'] ||
      req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (suppliedToken !== localToken) {
      anthropicError(res, 401, 'Invalid local Luna bridge token')
      return
    }
    await handleMessages(req, res)
    return
  }
  json(res, 404, { error: 'Not found' })
})

server.listen(port, host, () => {
  process.stderr.write(`claudex-luna bridge listening on http://${host}:${port} model=${model} effort=${reasoningEffort}\n`)
})
