import { getCommandQueue, removeByFilter } from './messageQueueManager.js'

/**
 * Rail answers still sitting in the command queue at a turn boundary.
 *
 * An answer or a note reaches a session two ways, exactly as a peer message
 * does: the queue wakes an idle session and the mid-turn drain takes it between
 * tool calls, and the Stop hook covers the gap a turn with no further tool
 * iteration leaves - a message arriving after the last tool call would sit in
 * the queue until the session went idle. The queue is the one ledger both paths
 * can read, so a rail command still in it when a turn ends is one neither queue
 * path has run, and the turn boundary is where it belongs.
 *
 * The origin is the discriminator: `question-rail` is stamped only by the rail,
 * so this cannot claim a peer message, a leaf's handed-over turn or anything
 * the person typed.
 */
export function queuedQuestionRailInjections(): string[] {
  return getCommandQueue()
    .filter(command => command.origin?.kind === 'question-rail' && typeof command.value === 'string')
    .map(command => String(command.value))
}

/**
 * Take the owed rail text out of the queue for a Stop hook to inject.
 *
 * `undefined` when nothing is owed and the turn should be allowed to end - the
 * common case, where a turn end costs one queue scan and nothing more.
 *
 * The command leaves the queue in the same breath as it is claimed. Leaving it
 * would let the idle-wake path run it a second time as a prompt, and the model
 * would read the same answer twice.
 */
export function takeQueuedQuestionRailInjections(): string | undefined {
  const texts = queuedQuestionRailInjections()
  if (texts.length === 0) return undefined
  removeByFilter(command => command.origin?.kind === 'question-rail')
  return texts.join('\n\n')
}
