import { randomUUID, type UUID } from 'crypto'
import { getSessionId } from '../bootstrap/state.js'
import type { QuestionRailEntry } from '../types/logs.js'
import type { QueuedCommand } from '../types/textInputTypes.js'
import { enqueue } from './messageQueueManager.js'
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
 * answers them.
 *
 * Answers and notes do not re-enter as user prompts. They are injected as
 * harness traffic - a meta command carrying this rail's origin, drained between
 * tool calls and claimed at a turn boundary by the Stop hook - which is the
 * same shape session comms use (see gatewayPeerInjection.ts). The distinction
 * matters: a prompt is something the person typed into the composer, and one
 * queued behind their work would both jump the queue they are writing into and
 * be editable by Escape, which an answer is not.
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
  /** Everything the person typed about this question, in order. */
  thread?: string[]
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

/** How many items are finished - answered or closed - and can be cleared. */
export function finishedQuestionCount(): number {
  return items.filter(item => item.state !== 'open').length
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

function toEntry(item: QuestionRailItem, cleared = false): QuestionRailEntry {
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
    ...(item.thread !== undefined && item.thread.length > 0 && { thread: [...item.thread] }),
    ...(cleared && { cleared: true }),
    timestamp: new Date().toISOString(),
  }
}

/** Persist one rail item's current state. Best-effort: a write failure never
 *  blocks answering, because the answer is already in memory. */
function persist(item: QuestionRailItem, cleared = false): void {
  try {
    void recordQuestionRail(toEntry(item, cleared)).catch(() => {
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

/** The text a free-form note about a question re-enters as. */
function noteTurnText(item: QuestionRailItem, note: string): string {
  return `The user added context to your queued question "${item.question}": ${note}`
}

/**
 * Hand text to the model the way session comms do: as harness traffic, never as
 * the next user prompt.
 *
 * `isMeta` keeps it out of the composer (Escape cannot pull it back into the
 * input buffer as if the person had typed it), out of the prompt queue's
 * user-message budget, and out of the transcript's user turns; the origin is
 * what makes the queued command wrap as a system-reminder and what the Stop
 * hook claims at a turn boundary.
 */
function injectQuestionText(text: string): void {
  const command: QueuedCommand = {
    value: text,
    mode: 'prompt',
    priority: 'next',
    uuid: randomUUID() as UUID,
    // The text is harness-written; it must never be read as a slash command
    // just because a question happens to be quoted and starts with '/'.
    skipSlashCommands: true,
    isMeta: true,
    origin: { kind: 'question-rail' },
  }
  enqueue(command)
}

/**
 * Answer a rail item. Records the answer, persists the transition, and injects
 * the answer into the harness so it reaches the model without becoming a prompt.
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
  injectQuestionText(answerTurnText(item, answer))
  return { ...item }
}

/**
 * Say something more about a question - a reason, a caveat, detail the options
 * had no room for. The note is kept on the item so the rail shows the whole
 * conversation about it, and injected so the model reads it alongside the
 * answer rather than as an unrelated turn.
 */
export function addQuestionNote(id: string, text: string): QuestionRailItem | undefined {
  const note = text.trim()
  const item = items.find(candidate => candidate.id === id)
  if (!item || note.length === 0) return undefined
  item.thread = [...(item.thread ?? []), note]
  notify()
  persist(item)
  injectQuestionText(noteTurnText(item, note))
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

/**
 * Drop every finished item off the rail, so a session that has answered all its
 * questions can get the pill out of the bottom chrome instead of reading
 * "Questions(0)" for the rest of its life.
 *
 * A cleared item is written as a tombstone rather than simply forgotten: the
 * transcript is what a --resume rehydrates from, and without the record the
 * cleared items would all come back. Open items are never touched - clearing is
 * for history, and a question still waiting for an answer is not history.
 */
export function clearFinishedQuestions(): number {
  const finished = items.filter(item => item.state !== 'open')
  if (finished.length === 0) return 0
  items = items.filter(item => item.state === 'open')
  notify()
  for (const item of finished) persist(item, true)
  return finished.length
}

// ============================================================================
// Restore
// ============================================================================

/**
 * Fold persisted rail entries into the store. One record is written per state
 * transition, so the last entry for an id wins - an answered item comes back
 * answered rather than open, a question nobody got to comes back open, and a
 * cleared item stays gone.
 * A no-op when the rail already holds live items, so a resume cannot clobber
 * questions enqueued in this process.
 */
export function hydrateQuestionRail(entries: readonly QuestionRailEntry[]): void {
  if (items.length > 0) return
  const byId = new Map<string, QuestionRailItem>()
  // Ids are qN and are handed out monotonically. A cleared id is still spent -
  // reusing q2 after it was cleared would point a later answer at a question
  // that is no longer on the rail - so the counter is advanced over every
  // record, including the tombstones.
  let highest = nextNumber - 1
  for (const entry of entries) {
    const match = /^q(\d+)$/.exec(entry.id)
    if (match) highest = Math.max(highest, Number(match[1]))
    if (entry.cleared) {
      byId.delete(entry.id)
      continue
    }
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
      ...(entry.thread !== undefined && entry.thread.length > 0 && { thread: [...entry.thread] }),
    })
  }
  nextNumber = highest + 1
  if (byId.size === 0) return
  items = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt)
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
