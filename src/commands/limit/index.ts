import type { Command } from '../../commands.js'

/**
 * Every window the current upstream reports, in one view.
 *
 * The bottom bar can only afford one window at a time - a row is always tight -
 * so this is the place the full set is printed, each with its reset, next to
 * what this chat has spent on that route.
 */
export default {
  type: 'local',
  name: 'limit',
  description: "Show the current upstream's usage limits and this chat's spend",
  argumentHint: '[--json]',
  supportsNonInteractive: true,
  load: () => import('./limit.js'),
} satisfies Command
