/**
 * Redaction of secrets from tool results before they are written to the
 * transcript or enter model context.
 *
 * One choke point: `addToolResult` in `services/tools/toolExecution.ts`.
 * Everything a tool produced — the mapped content block that reaches model
 * context, the persisted large-tool-result file, and the raw `toolUseResult`
 * field stored in the transcript — flows through that function, so redacting
 * there covers every surface. A leaf cannot leak a secret by forgetting a
 * per-command filter.
 *
 * Three passes, in order:
 *   1. Known-value — real secret VALUES held by this process (env vars whose
 *      name looks secret-ish) are replaced verbatim, plus their base64/hex/
 *      URL-encoded forms. Gives a named marker `[REDACTED:<NAME>]`.
 *   2. Name-based — a secret-ish key followed by a value, across `=`, `:`,
 *      `=>`, JSON, YAML, `.env`, `export K=V`, plist XML and `Authorization:`
 *      headers. Catches secrets this process never held.
 *   3. Shape — known token shapes (PEM/SSH private keys, JWTs, cloud tokens)
 *      via the curated gitleaks subset in `teamMemorySync/secretScanner`.
 *
 * Redaction is conservative: unquoted name/value pairs require a whitespace-free
 * value, and values that are obviously references (`${VAR}`, `<...>`, `$(...)`)
 * are left alone, so ordinary prose is not mangled.
 */

import { redactSecrets } from '../teamMemorySync/secretScanner.js'

const MARKER_OPEN = '[REDACTED:'
const MARKER_CLOSE = ']'

/** Env-var names whose value is treated as a known secret. */
const SECRET_NAME_RE =
  /KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|SEED|PREIMAGE|PRIVATE|CREDENTIAL|AUTH/i

/** Values shorter than this are too likely to be innocent to replace. */
const MIN_KNOWN_VALUE_LEN = 8

/**
 * A value that is really a reference, not a literal secret — or an already
 * redacted marker, so the passes never touch one another's output.
 */
const REFERENCE_VALUE_RE = /^[$<%{\[]|process\.env/

type KnownSecret = { name: string; value: string; encoded: string[] }

let knownSecrets: KnownSecret[] | null = null

function encodeVariants(value: string): string[] {
  const variants = new Set<string>()
  try {
    variants.add(Buffer.from(value, 'utf8').toString('base64'))
  } catch {
    // ignore
  }
  if (value.length >= 12) {
    try {
      variants.add(Buffer.from(value, 'utf8').toString('hex'))
    } catch {
      // ignore
    }
  }
  try {
    const encoded = encodeURIComponent(value)
    if (encoded !== value) variants.add(encoded)
  } catch {
    // ignore
  }
  return [...variants].filter(v => v.length >= MIN_KNOWN_VALUE_LEN)
}

/** Load known secret values from the environment once, hold in memory only. */
function getKnownSecrets(): KnownSecret[] {
  if (knownSecrets !== null) return knownSecrets
  const found: KnownSecret[] = []
  for (const [name, raw] of Object.entries(process.env)) {
    if (typeof raw !== 'string') continue
    if (!SECRET_NAME_RE.test(name)) continue
    const value = raw.trim()
    if (value.length < MIN_KNOWN_VALUE_LEN) continue
    if (REFERENCE_VALUE_RE.test(value)) continue
    found.push({ name, value, encoded: encodeVariants(value) })
  }
  // Longest value first so a value that contains a shorter one is replaced whole.
  found.sort((a, b) => b.value.length - a.value.length)
  knownSecrets = found
  return found
}

/** Test seam: drop the memoised known-value set. */
export function resetKnownSecretsForTests(): void {
  knownSecrets = null
}

function marker(name: string): string {
  return `${MARKER_OPEN}${name}${MARKER_CLOSE}`
}

function replaceLiteral(
  content: string,
  needle: string,
  replacement: string,
): string {
  if (needle.length === 0) return content
  // split/join avoids regex-escaping the needle.
  return content.split(needle).join(replacement)
}

/** Pass 1 — replace exact known secret values and their encodings. */
function redactKnownValues(content: string): string {
  for (const secret of getKnownSecrets()) {
    if (content.includes(secret.value)) {
      content = replaceLiteral(content, secret.value, marker(secret.name))
    }
    for (const encoded of secret.encoded) {
      if (content.includes(encoded)) {
        content = replaceLiteral(content, encoded, marker(secret.name))
      }
    }
  }
  return content
}

// ─── Pass 2: name-based ─────────────────────────────────────────

const STRONG_WORD =
  'KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|SEED|PREIMAGE|PRIVATE|CREDENTIAL'
// A name is one delimited token. Strong words match anywhere in the token;
// bare AUTH/AUTHORIZATION must stand as their own segment so "AUTHORS" is safe.
const NAME = `(?:[A-Za-z0-9_.-]*(?:${STRONG_WORD})[A-Za-z0-9_.-]*|(?<![A-Za-z0-9_.-])(?:AUTHORIZATION|AUTH)(?![A-Za-z0-9_.-]))`
const SEP = '\\s*(?:=>|:|=)\\s*'
const VALUE = `(?:"([^"\\r\\n]{6,})"|'([^'\\r\\n]{6,})'|\`([^\`\\r\\n]{6,})\`|([^\\s"'\\r\\n,;{}]{6,}))`
const NAME_VALUE_RE = new RegExp(
  `(["']?)(${NAME})\\1(${SEP})${VALUE}`,
  'gi',
)
const AUTHORIZATION_RE = new RegExp(
  `(authorization\\s*:\\s*)((?:bearer|basic|token)\\s+)?([^\\s"'\`\\r\\n,;]+)`,
  'gi',
)
const PLIST_SECRET_RE = new RegExp(
  `<key>([^<]*(?:${STRONG_WORD})[^<]*)<\\/key>\\s*<string>([\\s\\S]*?)<\\/string>`,
  'gi',
)

/** Auth scheme words carry no secret and must survive the name-based pass. */
const SCHEME_VALUE_RE = /^(?:bearer|basic|token|digest|negotiate)$/i

function isReferenceValue(value: string): boolean {
  return REFERENCE_VALUE_RE.test(value) || SCHEME_VALUE_RE.test(value)
}

function redactNameValuePairs(content: string): string {
  // Headers first: the credential may contain a space ("Bearer <token>").
  content = content.replace(
    AUTHORIZATION_RE,
    (_match, prefix: string, scheme: string | undefined) =>
      `${prefix}${scheme ?? ''}${marker('AUTHORIZATION')}`,
  )
  content = content.replace(
    PLIST_SECRET_RE,
    (match, key: string, value: string) =>
      isReferenceValue(value.trim())
        ? match
        : match.replace(
            `<string>${value}</string>`,
            `<string>${marker(key.trim())}</string>`,
          ),
  )
  content = content.replace(
    NAME_VALUE_RE,
    (
      match,
      nameQuote: string,
      name: string,
      sep: string,
      dq: string | undefined,
      sq: string | undefined,
      bq: string | undefined,
      uq: string | undefined,
    ) => {
      const quoted = dq ?? sq ?? bq
      const value = quoted ?? uq
      if (value === undefined || value === '' || isReferenceValue(value)) {
        return match
      }
      const replacement = marker(name.toUpperCase())
      if (quoted === undefined) {
        return `${nameQuote}${name}${nameQuote}${sep}${replacement}`
      }
      const q = dq !== undefined ? '"' : sq !== undefined ? "'" : '`'
      return `${nameQuote}${name}${nameQuote}${sep}${q}${replacement}${q}`
    },
  )
  return content
}

// ─── Pass 3: shape ──────────────────────────────────────────────

const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/g

function redactShapes(content: string): string {
  content = content.replace(JWT_RE, marker('JWT'))
  content = redactSecrets(content)
  return content
}

/**
 * Redact secrets from a block of tool-result text. Applied to every string
 * that reaches model context or the transcript.
 */
export function redactToolResultText(text: string): string {
  if (!text) return text
  let out = redactKnownValues(text)
  out = redactNameValuePairs(out)
  out = redactShapes(out)
  return out
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Deep-walk a tool-result value and redact every string leaf. Recurses into
 * arrays and plain objects only, so Buffers, Dates, class instances and other
 * non-plain values are returned untouched.
 */
export function redactToolResultValue(value: unknown): unknown {
  if (typeof value === 'string') return redactToolResultText(value)
  if (Array.isArray(value)) return value.map(redactToolResultValue)
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value)) {
      out[key] = redactToolResultValue(val)
    }
    return out
  }
  return value
}

/**
 * Redact the text content of a pre-mapped tool result block. Images and other
 * non-text blocks pass through unchanged.
 */
export function redactToolResultBlock<T extends { content?: unknown }>(
  block: T,
): T {
  const content = block.content
  if (typeof content === 'string') {
    return { ...block, content: redactToolResultText(content) }
  }
  if (Array.isArray(content)) {
    const mapped = content.map(item => {
      if (
        item &&
        typeof item === 'object' &&
        (item as { type?: unknown }).type === 'text' &&
        typeof (item as { text?: unknown }).text === 'string'
      ) {
        return {
          ...(item as object),
          text: redactToolResultText((item as { text: string }).text),
        }
      }
      return item
    })
    return { ...block, content: mapped }
  }
  return block
}
