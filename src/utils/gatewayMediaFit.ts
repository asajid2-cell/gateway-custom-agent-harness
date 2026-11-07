import { getGatewayProviderLabel } from './bottomBarUsage.js'
import { isGatewayMode } from './model/providers.js'

/**
 * The body ceiling a provider enforces, in bytes. Only the ones we can name a
 * number for are listed: a provider whose limit is unknown keeps its images and
 * takes its own error, rather than having them withheld on a guess.
 */
const PROVIDER_BODY_LIMITS: Record<string, number> = {
  // Command Code rejects a body of 20 MB or more outright. 19 MB leaves room
  // for the wrappers the gateway adds when it converts the request.
  'Command Code': 19_000_000,
}

/* eslint-disable @typescript-eslint/no-explicit-any */

function imageBytesOf(block: any): number {
  const data = block?.source?.data
  return typeof data === 'string' ? data.length : 0
}

function isImage(block: any): boolean {
  return Boolean(block && typeof block === 'object' && block.type === 'image')
}

/**
 * A path for an image that came back from reading a file, when the tool call
 * that produced it is still in the transcript. A pasted clipboard image has no
 * path anywhere, so it resolves to null.
 */
function toolImagePath(messages: any[], messageIndex: number, toolUseId: string): string | null {
  for (let index = messageIndex - 1; index >= 0; index -= 1) {
    const content = messages[index]?.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type !== 'tool_use' || block.id !== toolUseId) continue
      const candidate = block.input?.file_path ?? block.input?.path
      return typeof candidate === 'string' && candidate ? candidate : null
    }
  }
  return null
}

function withheldMarker(provider: string, path: string | null): string {
  if (path) {
    return (
      `[image withheld: this request exceeded ${provider}'s 20 MB body limit, so the image was not sent. ` +
      `You must call the Read tool on ${path} now, before answering the question, and say in one line that it was withheld.]`
    )
  }
  return (
    `[image withheld: this request exceeded ${provider}'s 20 MB body limit, so the image was not sent. ` +
    `Say in one line that it was withheld and ask for the file path; read it with the Read tool before you answer.]`
  )
}

export type MediaFit<T> = {
  messages: T[]
  stripped: number
  bytes: number
  provider: string | null
}

/**
 * Withhold inline images until a request fits the provider's body ceiling.
 *
 * The gateway enforces the same ceiling as a backstop, but a strip there is
 * invisible to the session: the turn continues with no image and no
 * explanation. Doing it here means the person sees a notice, and the marker can
 * tell the model to read the file rather than leaving it to guess.
 */
export function fitMediaToGatewayBodyLimit<T>(messages: T[], model: string): MediaFit<T> {
  const unchanged = { messages, stripped: 0, bytes: 0, provider: null as string | null }
  if (!isGatewayMode()) return unchanged
  const provider = getGatewayProviderLabel(model)
  const limit = PROVIDER_BODY_LIMITS[provider]
  if (!limit) return unchanged

  const list = messages as any[]
  let bytes = 0
  let images = 0
  for (const message of list) {
    const content = message?.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (isImage(block)) {
        bytes += imageBytesOf(block)
        images += 1
      } else if (block?.type === 'tool_result' && Array.isArray(block.content)) {
        for (const nested of block.content) {
          if (isImage(nested)) {
            bytes += imageBytesOf(nested)
            images += 1
          }
        }
      }
    }
  }
  if (images === 0 || bytes <= limit) return { ...unchanged, bytes, provider }

  let stripped = 0
  const out = list.map((message, index) => {
    const content = message?.message?.content
    if (!Array.isArray(content)) return message
    let changed = false
    const next = content.map((block: any) => {
      if (bytes <= limit) return block
      if (isImage(block)) {
        bytes -= imageBytesOf(block)
        stripped += 1
        changed = true
        return { type: 'text', text: withheldMarker(provider, null) }
      }
      if (block?.type === 'tool_result' && Array.isArray(block.content)) {
        const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
        const path = toolUseId ? toolImagePath(list, index, toolUseId) : null
        let nestedChanged = false
        const nested = block.content.map((item: any) => {
          if (bytes <= limit || !isImage(item)) return item
          bytes -= imageBytesOf(item)
          stripped += 1
          nestedChanged = true
          return { type: 'text', text: withheldMarker(provider, path) }
        })
        if (!nestedChanged) return block
        changed = true
        return { ...block, content: nested }
      }
      return block
    })
    return changed ? { ...message, message: { ...message.message, content: next } } : message
  })

  return { messages: out as T[], stripped, bytes, provider }
}

/* eslint-enable @typescript-eslint/no-explicit-any */
