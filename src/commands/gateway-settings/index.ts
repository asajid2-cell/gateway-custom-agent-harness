import type { Command } from '../../commands.js'

export default {
  type: 'local',
  name: 'gateway-settings',
  description: 'Read or set install-owned gateway settings (vault root)',
  argumentHint: '[show|vaultRoot <path>]',
  supportsNonInteractive: true,
  load: () => import('./settings.js'),
} satisfies Command
