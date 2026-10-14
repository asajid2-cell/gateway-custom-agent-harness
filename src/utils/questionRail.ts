import { getSessionId } from '../bootstrap/state.js'
import type { QuestionRailEntry } from '../types/logs.js'
import type { QueuedCommand } from '../types/textInputTypes.js'
import { enqueuePendingNotification } from './messageQueueManager.js'
import { loadQuestionRailEntries, recordQuestionRail } from './sessionStorage.js'
import { createSignal } from './signal.js'

/**
 * The Questions rail.
 *
 * The AskUserQuestion tool used to hand the whole turn to a blocking modal:
 * the tool call's promise did not settle until a person at the keyboard
 * answered, so an agent that asked a question simply stopped. The rail is the
 * other half of that: the tool enqueues its questions and returns immediately,
 * the agent keeps working, and the questions wait in this store until someone
 * answers them. Answering injects the answer as an ordinary turn.
 *
 * Modelled on messageQueueManager.ts on purpose - a module-level store with a
 * frozen snapshot behind useSyncExternalStore - so the surface this feeds is
 * the same kind of subscriber the rest of the harness already drives, rather
 * than a second concurrency model.
 */

export type QuestionRailState = 'open' | 'answered' | 'closed'

export type QuestionRailOption = {
  label: string
  description: string
}

export type QuestionRailItem = {
  /** Monotonic per session: q1, q2, ... */
  id: string
  question: string
  header: string
  options: QuestionRailOption[]
  multiSelect: boolean
  state: QuestionRailState
  createdAt: number
  answeredAt?: number
  answer?: string
}

let items: QuestionRailItem[] = []
/** Frozen snapshot - recreated on every mutation for useSyncExternalStore. */
let snapshot: readonly QuestionRailItem[] = Object.freeze([])
const changed = createSignal()
/** The next number to hand out. Continues past a hydrated transscript's ids. */
let nextNumber = 1

function notify(): void {
  snapshot = Object.freeze(items.map(item => Object.freeze({ ...item })))
  changed.emit()
}

// ============================================================================
// useSyncExternalStore interface
// ============================================================================

/** Subscribe to rail changes. Compatible with React's useSyncExternalStore. */
export const subscribeToQuestionRail = changed.subscribe

/**
 * Get the current snapshot. A frozen array that only changes reference on
 * mutation, so a subscriber re-renders exactly when the rail changes.
 */
export function getQuestionRailSnapshot(): readonly QuestionRailItem[] {
  return snapshot
}

/** A mutable copy of the rail, for one-off reads outside React. */
export function getQuestionRail(): QuestionRailItem[] {
  return items.map(item => ({ ...item }))
}

/** How many items are still waiting for an answer. */
export function openQuestionCount(): number {
  return items.filter(item => item.state === 'open').length
}

/**
 * The label the TUCK pill shows. It counts open items only: an answered or
 * closed item is history, and the pill's number is "what still needs you".
 */
export function questionPillLabel(): string {
  return `Questions(${openQuestionCount()})`
}

/** Whether the rail has anything at all to show. */
export function hasRailItems(): boolean {
  return items.length > 0
}

// ============================================================================
// Write operations
// ============================================================================

function toEntry(item: QuestionRailItem): QuestionRailEntry {
  return {
    type: 'question-rail',
    sessionId: getSessionId() as QuestionRailEntry['sessionId'],
    id: item.id,
    question: item.question,
    header: item.header,
    options: item.options.map(option => ({ ...option })),
    multiSelect: item.multiSelect,
    state: item.state,
    createdAt: item.createdAt,
    ...(item.answeredAt !== undefined && { answeredAt: item.answeredAt }),
    ...(item.answer !== undefined && { answer: item.answer }),
    timestamp: new Date().toISOString(),
  }
}

/** Persist one rail item's current state. Best-effort: a write failure never
 *  blocks answering, because the answer is already in memory. */
function persist(item: QuestionRailItem): void {
  try {
    void recordQuestionRail(toEntry(item)).catch(() => {
      // A write failure never blocks the rail; memory is authoritative here.
    })
  } catch {
    // Nothing to do - the rail is authoritative in memory for this session.
  }
}

/**
 * Put a question on the rail and return it. Called from the AskUserQuestion
 * tool's synchronous result path, so it must not await anything.
 */
export function enqueueQuestion(question: {
  question: string
  header: string
  options: QuestionRailOption[]
  multiSelect?: boolean
}): QuestionRailItem {
  const id = `q${nextNumber++}`
  const item: QuestionRailItem = {
    id,
    question: question.question,
    header: question.header,
    options: question.options.map(option => ({ ...option })),
    multiSelect: question.multiSelect ?? false,
    state: 'open',
    createdAt: Date.now(),
  }
  items.push(item)
  notify()
  persist(item)
  return { ...item }
}

/**
 * The turn text an answer re-enters as. It names the question so a reply that
 * arrives several turns later still reads as an answer to something specific.
 */
function answerTurnText(item: QuestionRailItem, answer: string): string {
  return `The user answered your queued question "${item.question}": ${answer}`
}

/**
 * Answer a rail item. Records the answer, persists the transition, and injects
 * the answer onto the command queue so it reaches the model as a normal turn.
 * Returns the updated item, or undefined when there is nothing to answer.
 */
export function answerQuestion(id: string, answer: string): QuestionRailItem | undefined {
  const item = items.find(candidate => candidate.id === id)
  if (!item || item.state === 'answered') return undefined
  item.state = 'answered'
  item.answer = answer
  item.answeredAt = Date.now()
  notify()
  persist(item)
  const command: QueuedCommand = {
    value: answerTurnText(item, answer),
    mode: 'prompt',
    // The answer is free text a person chose; it must never be read as a slash
    // command just because it happens to start with '/'.
    skipSlashCommands: true,
  }
  enqueuePendingNotification(command)
  return { ...item }
}

/** Close an item without answering it. It stays on the rail as history. */
export function closeQuestion(id: string): QuestionRailItem | undefined {
  const item = items.find(candidate => candidate.id === id)
  if (!item || item.state === 'closed') return undefined
  item.state = 'closed'
  item.answer = undefined
  item.answeredAt = undefined
  notify()
  persist(item)
  return { ...item }
}

/** Reopen a closed or answered item so it can be answered again. */
export function reopenQuestion(id: string): QuestionRailItem | undefined {
  const item = items.find(candidate => candidate.id === id)
  if (!item) return undefined
  if (item.state === 'open' && item.answer === undefined) return { ...item }
  item.state = 'open'
  item.answer = undefined
  item.answeredAt = undefined
  notify()
  persist(item)
  return { ...item }
}

// ============================================================================
// Restore
// ============================================================================

/**
 * Fold persisted rail entries into the store. One record is written per state
 * transition, so the last entry for an id wins - an answered item comes back
 * answered rather than open, and a question nobody got to comes back open.
 * A no-op when the rail already holds live items, so a resume cannot clobber
 * questions enqueued in this process.
 */
export function hydrateQuestionRail(entries: readonly QuestionRailEntry[]): void {
  if (items.length > 0) return
  const byId = new Map<string, QuestionRailItem>()
  for (const entry of entries) {
    byId.set(entry.id, {
      id: entry.id,
      question: entry.question,
      header: entry.header,
      options: entry.options.map(option => ({ ...option })),
      multiSelect: entry.multiSelect,
      state: entry.state,
      createdAt: entry.createdAt,
      ...(entry.answeredAt !== undefined && { answeredAt: entry.answeredAt }),
      ...(entry.answer !== undefined && { answer: entry.answer }),
    })
  }
  if (byId.size === 0) return
  items = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt)
  // ids are qN; the next one must not collide with a restored id.
  for (const item of items) {
    const match = /^q(\d+)$/.exec(item.id)
    if (match) nextNumber = Math.max(nextNumber, Number(match[1]) + 1)
  }
  notify()
}

/**
 * Rehydrate from the current session's transcript, once. Called on layout
 * mount so a resumed session shows the questions that were still open when it
 * was left, with answered and closed items restored as terminal rather than
 * reappearing as open.
 */
export async function hydrateQuestionRailFromTranscript(): Promise<void> {
  if (items.length > 0) return
  try {
    hydrateQuestionRail(await loadQuestionRailEntries())
  } catch {
    // A transcript that cannot be read leaves the rail empty, not broken.
  }
}

/** Reset the store. Test cleanup only. */
export function resetQuestionRail(): void {
  items = []
  snapshot = Object.freeze([])
  nextNumber = 1
}
