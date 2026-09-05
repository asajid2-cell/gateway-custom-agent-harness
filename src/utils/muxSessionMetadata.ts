const WS_OPEN = 1

export const MUXCTL_DEFAULT_PORT = 7699
export const MUXCTL_DEFAULT_TIMEOUT_MS = 5_000
export const MUXCTL_MAX_RESPONSE_BYTES = 256 * 1024

export const MUX_METADATA_MUTATION_SUPPORTED = false
export const MUX_METADATA_READ_ONLY_REASON =
  'Local mux metadata is informational only; rename and tag mutation are not supported.'

const MAX_PORT = 65_535
const MAX_PROTOCOL = 1_000_000
const MAX_SESSIONS = 4_096
const MAX_ID_LENGTH = 512
const MAX_NAME_LENGTH = 512
const MAX_ALIAS_COUNT = 128
const MAX_TAG_COUNT = 128
const MAX_TAG_LENGTH = 128
const MAX_CAP_COUNT = 256
const MAX_CAP_LENGTH = 128
const MAX_TIMEOUT_MS = 60_000

type ProcessEnvLike = {
  readonly MUXCTL_PORT?: string
  readonly MUXCTL_TIMEOUT?: string
}

export type MuxInfoRequest = {
  readonly t: 'info'
}

export type MuxLsRequest = {
  readonly t: 'ls'
}

export type MuxReadRequest = MuxInfoRequest | MuxLsRequest

export type MuxInfoResponse = {
  readonly t: 'info'
  readonly protocol: number
  readonly caps: readonly string[]
}

export type MuxSession = {
  readonly name: string
  readonly sessionId: string
  readonly aliases: readonly string[]
  readonly sessionUuid?: string
  readonly tags?: readonly string[]
  readonly identityPending?: boolean
  readonly lifecycle?: string
}

export type MuxLsResponse = {
  readonly t: 'ls'
  readonly list: readonly MuxSession[]
}

export type MuxSessionMetadata = {
  readonly name: string
  readonly tags?: readonly string[]
  readonly sessionId: string
  readonly aliases: readonly string[]
  readonly readOnly: true
  readonly mutation: {
    readonly supported: false
    readonly reason: string
  }
}

export type MuxMetadataUnavailableReason =
  | 'unavailable'
  | 'malformed-info'
  | 'malformed-list'
  | 'unsupported'
  | 'missing'
  | 'mismatched'
  | 'ambiguous'

export type MuxMetadataResult =
  | {
      readonly available: true
      readonly metadata: MuxSessionMetadata
    }
  | {
      readonly available: false
      readonly reason: MuxMetadataUnavailableReason
    }

export type MuxSessionMatch =
  | {
      readonly status: 'matched'
      readonly session: MuxSession
    }
  | {
      readonly status: 'missing'
    }
  | {
      readonly status: 'mismatched'
    }
  | {
      readonly status: 'ambiguous'
      readonly sessions: readonly MuxSession[]
    }

export type MuxWebSocketMessageEvent = {
  readonly data: unknown
}

export type MuxWebSocketLike = {
  readonly readyState: number
  onopen: (() => void) | null | undefined
  onmessage: ((event: MuxWebSocketMessageEvent) => void) | null | undefined
  onerror: ((event: unknown) => void) | null | undefined
  onclose: (() => void) | null | undefined
  send(data: string): void
  close(): void
}

export type MuxWebSocketFactory = (
  url: string,
) => MuxWebSocketLike | Promise<MuxWebSocketLike>

export type LoadMuxMetadataOptions = {
  readonly env?: ProcessEnvLike
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
  readonly webSocketFactory?: MuxWebSocketFactory
}

export function getMuxctlUrl(env: ProcessEnvLike = { MUXCTL_PORT: process.env.MUXCTL_PORT }): string {
  const configuredPort = env.MUXCTL_PORT
  const port = configuredPort && isValidPort(configuredPort)
    ? Number(configuredPort)
    : MUXCTL_DEFAULT_PORT
  return `ws://127.0.0.1:${port}`
}

export function buildMuxInfoRequest(): MuxInfoRequest {
  return { t: 'info' }
}

export function buildMuxLsRequest(): MuxLsRequest {
  return { t: 'ls' }
}

export function validateMuxInfoResponse(value: unknown): MuxInfoResponse | null {
  if (!isRecord(value) || value.t !== 'info') return null
  if (!isSafeIntegerInRange(value.protocol, 0, MAX_PROTOCOL)) return null
  if (!isStringArray(value.caps, MAX_CAP_COUNT, MAX_CAP_LENGTH, true)) return null
  return {
    t: 'info',
    protocol: value.protocol,
    caps: [...value.caps],
  }
}

export function validateMuxLsResponse(value: unknown): MuxLsResponse | null {
  if (!isRecord(value) || value.t !== 'ls') return null
  if (!Array.isArray(value.list) || value.list.length > MAX_SESSIONS) {
    return null
  }

  const list: MuxSession[] = []
  for (const item of value.list) {
    const session = validateMuxSession(item)
    if (!session) return null
    list.push(session)
  }
  return { t: 'ls', list }
}

export function matchMuxSession(
  sessions: readonly MuxSession[],
  nativeSessionId: string,
): MuxSessionMatch {
  if (!nativeSessionId) return { status: 'missing' }

  const matches = sessions.filter(session => {
    const identities = [session.sessionId, ...session.aliases]
    return identities.some(identity => identity === nativeSessionId)
  })

  if (matches.length === 0) return { status: 'mismatched' }
  if (matches.length > 1) return { status: 'ambiguous', sessions: matches }
  return { status: 'matched', session: matches[0]! }
}

export function resolveMuxSessionMetadata(
  info: MuxInfoResponse | null,
  list: MuxLsResponse | null,
  nativeSessionId: string,
): MuxMetadataResult {
  if (!info) return { available: false, reason: 'malformed-info' }
  if (!list) return { available: false, reason: 'malformed-list' }
  if (!info.caps.includes('ls')) return { available: false, reason: 'unsupported' }

  const match = matchMuxSession(list.list, nativeSessionId)
  if (match.status === 'missing') return { available: false, reason: 'missing' }
  if (match.status === 'mismatched') return { available: false, reason: 'mismatched' }
  if (match.status === 'ambiguous') return { available: false, reason: 'ambiguous' }

  const session = match.session
  return {
    available: true,
    metadata: {
      name: session.name,
      ...(session.tags && { tags: [...session.tags] }),
      sessionId: session.sessionId,
      aliases: [...session.aliases],
      readOnly: true,
      mutation: {
        supported: false,
        reason: MUX_METADATA_READ_ONLY_REASON,
      },
    },
  }
}

export function muxMetadataUnavailableText(
  reason: MuxMetadataUnavailableReason,
): string {
  switch (reason) {
    case 'malformed-info':
    case 'malformed-list':
      return 'Mux metadata disabled: the local response was malformed.'
    case 'unsupported':
      return 'Mux metadata disabled: this mux does not expose session listing.'
    case 'missing':
    case 'mismatched':
      return 'Mux metadata disabled: the active session was not identified.'
    case 'ambiguous':
      return 'Mux metadata disabled: more than one mux session matched.'
    case 'unavailable':
    default:
      return 'Mux metadata unavailable.'
  }
}

export async function loadMuxSessionMetadata(
  nativeSessionId: string,
  options: LoadMuxMetadataOptions = {},
): Promise<MuxMetadataResult> {
  const env = options.env ?? {
    MUXCTL_PORT: process.env.MUXCTL_PORT,
    MUXCTL_TIMEOUT: process.env.MUXCTL_TIMEOUT,
  }
  const timeoutMs = boundedTimeout(options.timeoutMs ?? getMuxctlTimeoutMs(env))
  const maxResponseBytes = boundedResponseSize(
    options.maxResponseBytes ?? MUXCTL_MAX_RESPONSE_BYTES,
  )
  const url = getMuxctlUrl(env)
  const webSocketFactory = options.webSocketFactory ?? createMuxWebSocket
  const requestOptions = { url, timeoutMs, maxResponseBytes, webSocketFactory }

  try {
    const [infoValue, listValue] = await Promise.all([
      requestMuxResponse(buildMuxInfoRequest(), requestOptions),
      requestMuxResponse(buildMuxLsRequest(), requestOptions),
    ])
    const info = validateMuxInfoResponse(infoValue)
    const list = validateMuxLsResponse(listValue)
    return resolveMuxSessionMetadata(info, list, nativeSessionId)
  } catch {
    return { available: false, reason: 'unavailable' }
  }
}

type RequestOptions = {
  readonly url: string
  readonly timeoutMs: number
  readonly maxResponseBytes: number
  readonly webSocketFactory: MuxWebSocketFactory
}

async function requestMuxResponse(
  request: MuxReadRequest,
  options: RequestOptions,
): Promise<unknown> {
  const socket = await options.webSocketFactory(options.url)
  return new Promise<unknown>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const closeSocket = (): void => {
      try {
        socket.close()
      } catch {
        // The request is already failing or complete; cleanup must not mask it.
      }
    }

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      socket.onopen = null
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
    }

    const finish = (callback: () => void, close = true): void => {
      if (settled) return
      settled = true
      cleanup()
      if (close) closeSocket()
      callback()
    }

    const fail = (): void => {
      finish(() => reject(new Error('mux request failed')))
    }

    const receive = async (event: MuxWebSocketMessageEvent): Promise<void> => {
      try {
        const text = await decodeMuxMessage(event.data, options.maxResponseBytes)
        const parsed: unknown = JSON.parse(text)
        finish(() => resolve(parsed))
      } catch {
        fail()
      }
    }

    const send = (): void => {
      if (settled) return
      try {
        // This function only receives the two closed-over read request types.
        socket.send(JSON.stringify(request))
      } catch {
        fail()
      }
    }

    socket.onopen = send
    socket.onmessage = event => {
      void receive(event)
    }
    socket.onerror = fail
    socket.onclose = fail
    timer = setTimeout(fail, options.timeoutMs)

    if (socket.readyState === WS_OPEN) send()
  })
}

async function decodeMuxMessage(data: unknown, maxBytes: number): Promise<string> {
  if (typeof data === 'string') {
    const encoded = new TextEncoder().encode(data)
    if (encoded.byteLength > maxBytes) throw new Error('mux response too large')
    return data
  }

  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    if (data.size > maxBytes) throw new Error('mux response too large')
    return decodeBytes(new Uint8Array(await data.arrayBuffer()), maxBytes)
  }

  if (data instanceof ArrayBuffer) {
    return decodeBytes(new Uint8Array(data), maxBytes)
  }

  if (ArrayBuffer.isView(data)) {
    return decodeBytes(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      maxBytes,
    )
  }

  throw new Error('unsupported mux response data')
}

function decodeBytes(data: Uint8Array, maxBytes: number): string {
  if (data.byteLength > maxBytes) throw new Error('mux response too large')
  return new TextDecoder('utf-8', { fatal: true }).decode(data)
}

async function createMuxWebSocket(url: string): Promise<MuxWebSocketLike> {
  if (typeof Bun !== 'undefined') {
    return new globalThis.WebSocket(url) as unknown as MuxWebSocketLike
  }
  const { default: WebSocket } = await import('ws')
  return new WebSocket(url) as unknown as MuxWebSocketLike
}

function validateMuxSession(value: unknown): MuxSession | null {
  if (!isRecord(value)) return null
  if (!isNonEmptyBoundedString(value.name, MAX_NAME_LENGTH)) return null
  if (!isBoundedString(value.sessionId, MAX_ID_LENGTH)) return null
  if (!isStringArray(value.aliases, MAX_ALIAS_COUNT, MAX_ID_LENGTH)) return null

  if (value.sessionUuid !== undefined && !isBoundedString(value.sessionUuid, MAX_ID_LENGTH)) {
    return null
  }
  if (value.identityPending !== undefined && typeof value.identityPending !== 'boolean') {
    return null
  }
  if (value.lifecycle !== undefined && !isBoundedString(value.lifecycle, MAX_NAME_LENGTH)) {
    return null
  }
  if (
    value.tags !== undefined &&
    !isStringArray(value.tags, MAX_TAG_COUNT, MAX_TAG_LENGTH)
  ) {
    return null
  }

  return {
    name: value.name,
    sessionId: value.sessionId,
    aliases: [...value.aliases],
    ...(value.sessionUuid !== undefined && { sessionUuid: value.sessionUuid }),
    ...(value.identityPending !== undefined && {
      identityPending: value.identityPending,
    }),
    ...(value.lifecycle !== undefined && { lifecycle: value.lifecycle }),
    ...(value.tags !== undefined && { tags: [...value.tags] }),
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength
}

function isNonEmptyBoundedString(value: unknown, maxLength: number): value is string {
  return isBoundedString(value, maxLength) && value.trim().length > 0
}

function isStringArray(
  value: unknown,
  maxItems: number,
  maxItemLength: number,
  allowEmpty = false,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every(item =>
      allowEmpty
        ? isBoundedString(item, maxItemLength)
        : isNonEmptyBoundedString(item, maxItemLength),
    )
  )
}

function isValidPort(value: string): boolean {
  if (!/^\d+$/.test(value)) return false
  const port = Number(value)
  return Number.isSafeInteger(port) && port > 0 && port <= MAX_PORT
}

function isSafeIntegerInRange(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  )
}

function getMuxctlTimeoutMs(env: ProcessEnvLike): number {
  const configuredSeconds = Number(env.MUXCTL_TIMEOUT)
  if (!Number.isFinite(configuredSeconds) || configuredSeconds <= 0) {
    return MUXCTL_DEFAULT_TIMEOUT_MS
  }
  return boundedTimeout(Math.ceil(configuredSeconds * 1_000))
}

function boundedTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return MUXCTL_DEFAULT_TIMEOUT_MS
  return Math.min(Math.max(Math.ceil(value), 1), MAX_TIMEOUT_MS)
}

function boundedResponseSize(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return MUXCTL_MAX_RESPONSE_BYTES
  return Math.min(Math.max(Math.floor(value), 1), MUXCTL_MAX_RESPONSE_BYTES)
}
