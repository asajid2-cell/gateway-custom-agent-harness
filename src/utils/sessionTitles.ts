import { listSessionsImpl, type SessionInfo } from './listSessionsImpl.js'

/**
 * Chat names for the usage report.
 *
 * The ledger records a session id, which is the only identifier a response
 * actually carries. Reading a report of ids is possible but not useful: the
 * question is "which chat spent this", and the answer is the name the user gave
 * it (or the summary the harness wrote, or failing both the first thing they
 * typed).
 *
 * Titles live in the transcript, not in the ledger, so they are resolved on
 * demand from the same head/tail reads `/resume` already uses. A title is a
 * nicety: a missing one falls back to the id, and a failure to read any of them
 * must never take the report down with it.
 */

const MAX_TITLE = 72

/** Collapse a title to one line. A summary can carry newlines and markup. */
export function cleanTitle(value: string | undefined): string {
  if (!value) return ''
  const oneLine = value.replace(/\s+/g, ' ').trim()
  return oneLine.length > MAX_TITLE ? `${oneLine.slice(0, MAX_TITLE - 1)}…` : oneLine
}

/** The best name a session record offers, in the order the CLI already uses. */
export function titleFromSessionInfo(info: SessionInfo): string {
  return cleanTitle(info.customTitle) || cleanTitle(info.summary) || cleanTitle(info.firstPrompt)
}

/**
 * Resolve every recorded session to a name, keyed by the full id.
 *
 * `limit` bounds the head/tail reads: the ledger can name sessions from
 * projects that no longer exist, and a report must not spend a second per
 * hundred chats it is about to show a single line of.
 */
export async function loadSessionTitles(
  options: { limit?: number } = {},
): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  try {
    const sessions = await listSessionsImpl({ limit: options.limit ?? 500 })
    for (const session of sessions) {
      const title = titleFromSessionInfo(session)
      if (title) titles.set(session.sessionId, title)
    }
  } catch {
    // Titles are decoration. The report still works without them.
  }
  return titles
}

/**
 * How a chat is named in a report.
 *
 * The short id rides along even when a title exists: two chats can share a
 * title (a copied prompt, a resumed session), and the id is what the filter
 * accepts, so hiding it would make "filter to this chat" a guess.
 */
export function chatLabel(
  sessionId: string,
  titles?: ReadonlyMap<string, string>,
  maxTitle = 48,
): string {
  const title = titles?.get(sessionId)
  const short = sessionId.slice(0, 8)
  if (!title) return short
  const clipped =
    title.length > maxTitle ? `${title.slice(0, maxTitle - 1)}…` : title
  return `${clipped} (${short})`
}
