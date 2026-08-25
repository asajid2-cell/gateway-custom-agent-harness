import type { Command } from '../../commands.js'
import { deepSeekLogin, openCodeLogin } from './gateway-login.js'

export const openCodeLoginCommand = {
  type: 'local-jsx',
  name: 'opencodelogin',
  description: 'Add, check, or remove the OpenCode Go API key',
  argumentHint: '[status|remove]',
  load: async () => ({ call: openCodeLogin }),
} satisfies Command

export const deepSeekLoginCommand = {
  type: 'local-jsx',
  name: 'deepseeklogin',
  description: 'Add, check, or remove the native DeepSeek API key',
  argumentHint: '[status|remove]',
  load: async () => ({ call: deepSeekLogin }),
} satisfies Command
