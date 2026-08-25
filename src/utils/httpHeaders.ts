/**
 * Return normalized header names from the shapes used by Fetch, Node, and
 * SDK error objects. Error logging must tolerate malformed provider metadata.
 */
export function getHeaderNames(headers: unknown): string[] {
  if (!headers) return []

  if (Array.isArray(headers)) {
    return headers
      .map(entry => Array.isArray(entry) ? String(entry[0]).toLowerCase() : '')
      .filter(Boolean)
  }

  if (typeof (headers as { forEach?: unknown }).forEach === 'function') {
    const names: string[] = []
    try {
      ;(headers as globalThis.Headers).forEach((_value, key) => names.push(key))
      return names.map(name => String(name).toLowerCase())
    } catch {
      return []
    }
  }

  if (typeof (headers as { entries?: unknown }).entries === 'function') {
    try {
      return Array.from(
        (headers as { entries: () => Iterable<[unknown, unknown]> }).entries(),
      )
        .map(([key]) => String(key).toLowerCase())
    } catch {
      return []
    }
  }

  if (typeof headers === 'object') {
    return Object.keys(headers).map(name => name.toLowerCase())
  }

  return []
}
