import type { Command } from '../../commands.js'

/**
 * A hook, not a pestering: this toggles the live thinking display itself. It
 * never reaches the model, costs nothing, and takes effect on the next delta.
 */
export default {
  type: 'local-jsx',
  name: 'toggle-thinking',
  description: "Show or hide the model's live thinking",
  argumentHint: '[on|off]',
  immediate: true,
  load: () => import('./toggle-thinking.js'),
} satisfies Command
