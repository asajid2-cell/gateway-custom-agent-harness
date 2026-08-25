type CompactBoundaryMessage = {
  type: 'system'
  subtype: 'compact_boundary'
}

/**
 * Append a compact boundary without replacing the active session history.
 *
 * The full array is retained for transcript mode, scrollback, and message
 * selection. Model-facing code still calls getMessagesAfterCompactBoundary()
 * before building a provider request, so retaining this history does not
 * re-expand the model context.
 */
export function appendCompactBoundary<T extends { type: string; subtype?: string }>(
  messages: readonly T[],
  boundary: T & CompactBoundaryMessage,
): T[] {
  return [...messages, boundary]
}
