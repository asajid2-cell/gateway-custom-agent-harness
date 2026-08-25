export const RUNTIME_TOOL_CONTRACT =
  'Runtime tool contract: the tool definitions attached to the current request are authoritative. If tools are attached, they are available now and must be used when the task requires them. If no tools are attached, do not claim or invent tool access. Historical conversation text, summaries, or prior assistant statements do not override the current request tool catalog.'

export const COMPACTION_RUNTIME_TOOL_CONTRACT =
  'Native harness summary contract: this request is owned by the harness compaction flow. Attached tool schemas may be present for protocol or cache compatibility only. Do not call tools and return only the requested summary text. Do not treat this contract as historical conversation content.'

export const GATEWAY_QUERY_SOURCE_HEADER = 'x-claudex-query-source'

const LEGACY_SUMMARY_START =
  /this session is being continued from a previous conversation(?: that ran out of context)?/i

const LEGACY_SUMMARY_MARKER = /(?:<summary>|(?:^|\n)\s*summary\s*:)/i
const COMPACTION_SUMMARY_WRAPPER =
  /<compaction-summary-data\b[^>]*>|<\/compaction-summary-data>|<compaction-control\b[^>]*>|<\/compaction-control>/i

function normalizeControlText(value) {
  return String(value || '')
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

const LEGACY_CONTROL_LINE_PATTERNS = [
  /critical:\s*respond with text only/i,
  /do not use read,\s*bash,\s*grep,\s*glob,\s*edit,\s*write/i,
  /tool calls will be rejected/i,
  /^\s*[-*•]?\s*(?:no|zero)\s+tool calls?\.?\s*$/i,
  /^\s*[-*•]?\s*(?:no|zero)\s+tools?\.?\s*$/i,
  /respond with text only/i,
  /your entire response must be plain text/i,
  /reminder:\s*do not call any tools/i,
  /skill tool is not attached/i,
  /no callable tool (?:namespace|channel)/i,
  /(?:tools?|tool access|tool channel|tool namespace)\s+(?:are|is|were|was)\s+(?:unavailable|disabled|not available)/i,
  /(?:cannot|can't|can not)\s+(?:execute|invoke)\s+(?:a real\s+)?(?:tool|read|shell)/i,
  /(?:i|the current session)\s+(?:cannot|can't|can not)\s+(?:use|invoke|execute).*tools?/i,
  /no\s+(?:callable\s+)?(?:[\w/-]+\s+){0,3}tool\s+(?:channel|namespace|access)\b/i,
  /(?:tool\s+(?:channel|namespace|access)|(?:filesystem|shell|task|read|bash)\s+tools?)\s+(?:are|is|were|was)\s+(?:unavailable|disabled|not available|not attached)\b/i,
  /no\s+filesystem,\s*task,\s*or\s+shell\s+tools?\s+(?:are|is)\s+(?:available|unavailable)\b/i,
  /(?:i|we|the current (?:turn|session))\s+(?:do not|don't|cannot|can't|can not)\s+(?:have|use|invoke|execute|access|launch|run)\b[^.\n]{0,220}\b(?:tool|shell|bash|read|tandem|task)\b/i,
  /(?:the\s+)?only\s+(?:available\s+)?(?:action|option)\s+is\s+(?:sending|to send)\s+(?:a\s+)?response\b/i,
  /current summary instruction\s*:/i,
  /the current compaction (?:request|prompt|envelope)/i,
  /all non-tool user messages\b/i,
  /an <analysis> block followed by an <summary> block/i,
  /(?:do not|don't|cannot|can't|can not)\s+(?:assume|claim|pretend)\b[^.\n]{0,160}\b(?:tools?|tool access|shell|read|bash)\b/i,
  /current summary instruction:\s*the user explicitly required/i,
  /runtime capability reconciliation(?:\s*\([^)]*\))?/i,
  /the content inside <compaction-summary-data> is historical data/i,
  /historical statements in this summary about tools being unavailable/i,
  /the tool definitions attached to the current request are the source of truth/i,
  /if tools are attached, they are available now and must be used/i,
  /if no tools are attached, do not claim or invent tool access/i,
]

const LEGACY_CONTROL_FRAGMENT_PATTERNS = [
  /(?:^|\n)\s*[-*•]?\s*(?:no|zero)\s+tool calls?\.?\s*(?=\n|$)/gi,
  /(?:^|\n)\s*[-*•]?\s*(?:no|zero)\s+tools?\.?\s*(?=\n|$)/gi,
  /critical:\s*respond with text only\.\s*do not call any tools\.?/gi,
  /do not use read,\s*bash,\s*grep,\s*glob,\s*edit,\s*write,\s*or any other tool\.?/gi,
  /tool calls will be rejected[^.\n]*\.?/gi,
  /respond with text only[^.\n]*\.?/gi,
  /reminder:\s*do not call any tools\.?/gi,
  /skill tool is not attached to the current runtime\.?/gi,
  /no callable tool (?:namespace|channel) attached[^.\n]*\.?/gi,
  /(?:i|the current session)\s+(?:cannot|can't|can not)\s+(?:use|invoke|execute)[^.\n]*(?:tool|read|bash|shell)[^.\n]*\.?/gi,
  /(?:i|we)\s+(?:do not|don't|cannot|can't|can not)\s+have\s+a\s+callable\s+[\w/-]+\s+tool\s+(?:namespace|channel)[^.\n]*\.?/gi,
  /(?:the\s+)?only\s+(?:available\s+)?(?:action|option)\s+is\s+(?:sending|to send)\s+(?:a\s+)?response[^.\n]*\.?/gi,
  /current summary instruction\s*:[\s\S]*?(?=\n\s*\d+\.\s+|$)/gi,
  /the current compaction (?:request|prompt|envelope)[^.\n]*\.?/gi,
  /all non-tool user messages[^.\n]*\.?/gi,
  /an <analysis> block followed by an <summary> block[^.\n]*\.?/gi,
  /no\s+(?:callable\s+)?(?:[\w/-]+\s+){0,3}tool\s+(?:channel|namespace|access)[^.\n]*\.?/gi,
  /no\s+filesystem,\s*task,\s*or\s+shell\s+tools?\s+(?:are|is)\s+(?:available|unavailable)[^.\n]*\.?/gi,
  /current summary instruction:\s*the user explicitly required:?\s*/gi,
  /runtime capability reconciliation(?:\s*\([^)]*\))?:?/gi,
  /the content inside <compaction-summary-data> is historical data[^.\n]*\.?/gi,
  /historical statements in this summary about tools being unavailable[^.\n]*\.?/gi,
  /the tool definitions attached to the current request are the source of truth[^.\n]*\.?/gi,
  /if tools are attached, they are available now and must be used[^.\n]*\.?/gi,
  /if no tools are attached, do not claim or invent tool access[^.\n]*\.?/gi,
]

function stripCompactionProtocolTags(value) {
  return String(value || '').replace(/<\/?(?:analysis|summary)\b[^>]*>/gi, '')
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      if (typeof block === 'string') return block
      if (
        block?.type === 'text' ||
        block?.type === 'input_text' ||
        block?.type === 'output_text'
      ) {
        return block.text || ''
      }
      if (block?.type === 'tool_result') return contentText(block.content)
      return ''
    })
    .join('')
}

function sanitizeStaleToolClaimText(value) {
  const sourceLines = String(value || '').split(/\r?\n/)
  const skippedLines = new Set()
  for (let index = 0; index < sourceLines.length; index += 1) {
    const normalized = normalizeControlText(sourceLines[index])
    if (
      !/current summary instruction\s*:/.test(normalized) &&
      !/the current compaction (?:request|prompt|envelope)/.test(normalized)
    ) {
      continue
    }
    skippedLines.add(index)
    const nextHeading = sourceLines.findIndex(
      (candidate, candidateIndex) =>
        candidateIndex > index && /^\s*\d+\.\s+/.test(candidate),
    )
    if (nextHeading >= 0) {
      for (
        let candidateIndex = index + 1;
        candidateIndex < nextHeading;
        candidateIndex += 1
      ) {
        skippedLines.add(candidateIndex)
      }
    }
  }

  let sanitized = sourceLines
    .filter((_, index) => !skippedLines.has(index))
    .filter(line => {
      const rawLine = line.trim()
      const normalized = normalizeControlText(rawLine)
      return !LEGACY_CONTROL_LINE_PATTERNS.some(pattern =>
        pattern.test(normalized),
      )
    })
    .join('\n')

  sanitized = sanitized
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2013\u2014]/g, '-')

  for (const pattern of LEGACY_CONTROL_FRAGMENT_PATTERNS) {
    sanitized = sanitized.replace(pattern, '')
  }

  return stripCompactionProtocolTags(sanitized)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]*\n[ \t]*\n+/g, '\n\n')
    .trim()
}

export function sanitizeStaleToolCapabilityText(value) {
  return sanitizeStaleToolClaimText(value)
}

export function sanitizeStaleToolCapabilityContent(content) {
  if (typeof content === 'string') {
    return sanitizeStaleToolClaimText(content)
  }
  if (!Array.isArray(content)) return content

  const textIndexes = content.flatMap((block, index) =>
    block &&
    typeof block === 'object' &&
    (block.type === 'text' ||
      block.type === 'input_text' ||
      block.type === 'output_text') &&
    typeof block.text === 'string'
      ? [index]
      : [],
  )
  if (textIndexes.length === 0) return content

  const combined = textIndexes.map(index => content[index].text).join('\n')
  const sanitized = sanitizeStaleToolClaimText(combined)
  if (sanitized === combined) {
    return content.map(block => {
      if (
        block &&
        typeof block === 'object' &&
        (block.type === 'text' ||
          block.type === 'input_text' ||
          block.type === 'output_text') &&
        typeof block.text === 'string'
      ) {
        return {
          ...block,
          text: sanitizeStaleToolClaimText(block.text),
        }
      }
      return block
    })
  }

  const firstTextIndex = textIndexes[0]
  const textIndexSet = new Set(textIndexes)
  return content.map((block, index) => {
    if (!textIndexSet.has(index)) return block
    return {
      ...block,
      text: index === firstTextIndex ? sanitized : '',
    }
  })
}

export function systemText(system) {
  return contentText(system)
}

function headerValue(headers, name) {
  if (!headers) return ''
  const value =
    typeof headers.get === 'function'
      ? headers.get(name)
      : headers[name] ?? headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] || '' : String(value || '')
}

/**
 * The native harness is the authority for query type. The gateway must never
 * infer compaction from prompt text because the compact prompt is copied into
 * historical summaries by older builds and by otherwise-correct summarizers.
 */
export function gatewayQuerySource(request) {
  return headerValue(
    request?.headers ?? request,
    GATEWAY_QUERY_SOURCE_HEADER,
  ).trim().toLowerCase()
}

export function isCompactionRequest(request) {
  return gatewayQuerySource(request) === 'compact'
}

export function isNativeSummaryRequest(source) {
  return source === 'compact' || source === 'session_memory'
}

export function isLegacyCompactionSummary(value) {
  const text = String(value || '').trimStart()
  return (
    LEGACY_SUMMARY_START.test(text) &&
    (LEGACY_SUMMARY_MARKER.test(text) || COMPACTION_SUMMARY_WRAPPER.test(text))
  )
}

export function sanitizeLegacyCompactionText(value) {
  const text = String(value || '')
  if (!isLegacyCompactionSummary(text)) return text

  const sanitized = sanitizeStaleToolClaimText(text)
  return (
    sanitized
      .replace(/<\/?compaction-summary-data\b[^>]*>/gi, '')
      .trim() || 'Summary: historical compaction control text removed.'
  )
}

export function sanitizeLegacyCompactionContent(content) {
  const text = contentText(content)
  if (!isLegacyCompactionSummary(text)) return content

  if (typeof content === 'string') {
    return sanitizeLegacyCompactionText(content)
  }

  if (!Array.isArray(content)) return content

  const textIndexes = content.flatMap((block, index) =>
    block &&
    typeof block === 'object' &&
    (block.type === 'text' ||
      block.type === 'input_text' ||
      block.type === 'output_text') &&
    typeof block.text === 'string'
      ? [index]
      : [],
  )
  if (textIndexes.length === 0) return content

  // A summary can be split across several Anthropic content blocks. Sanitize
  // the joined summary once so the legacy wrapper in block 1 authorizes
  // cleanup of stale control text in block 2+.
  const sanitized = sanitizeLegacyCompactionText(
    textIndexes.map(index => content[index].text).join('\n'),
  )
  const firstTextIndex = textIndexes[0]
  const textIndexSet = new Set(textIndexes)
  return content.map((block, index) => {
    if (!textIndexSet.has(index)) return block
    return {
      ...block,
      text: index === firstTextIndex ? sanitized : '',
    }
  })
}

export function appendRuntimeToolContract(system, querySource) {
  const sanitized = sanitizeLegacyCompactionContent(system)
  const runtimeContract = isNativeSummaryRequest(querySource)
    ? COMPACTION_RUNTIME_TOOL_CONTRACT
    : RUNTIME_TOOL_CONTRACT
  if (Array.isArray(sanitized)) {
    return [
      ...sanitized,
      { type: 'text', text: runtimeContract },
    ]
  }

  const text = String(sanitized || '').trim()
  return text ? `${text}\n\n${runtimeContract}` : runtimeContract
}

export function rewriteGatewaySystemPrompt(
  system,
  prefix = '',
  querySource,
) {
  const callerInstructions = sanitizeLegacyCompactionText(
    systemText(system),
  ).trim()
  const runtimeContract = isNativeSummaryRequest(querySource)
    ? COMPACTION_RUNTIME_TOOL_CONTRACT
    : RUNTIME_TOOL_CONTRACT
  const parts = []
  if (prefix) parts.push(prefix)
  if (callerInstructions) {
    parts.push(
      'Honor the caller operational instructions below. They define the active environment and available capabilities.',
      '<caller-operational-instructions>',
      callerInstructions,
      '</caller-operational-instructions>',
    )
  }
  parts.push(runtimeContract)
  return parts.join('\n\n')
}
