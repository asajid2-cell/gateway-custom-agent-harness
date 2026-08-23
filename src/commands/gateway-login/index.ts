import type { Command } from '../../commands.js'

const command = (name: string, description: string, keyName: string) =>
  ({
    type: 'local-jsx',
    name,
    description,
    argumentHint: '[status|remove]',
    load: async () => {
      const module = await import('./login.js')
      return {
        call: (onDone, context, args) =>
          module.call(onDone, context, args, keyName),
      }
    },
  }) satisfies Command

export const openCodeLogin = command(
  'opencodelogin',
  'Add, replace, inspect, or remove the OpenCode Go API key',
  'opencode-go',
)

export const deepSeekLogin = command(
  'deepseeklogin',
  'Add, replace, inspect, or remove the DeepSeek API key',
  'ds',
)

export const openRouterLogin = command(
  'openrouterlogin',
  'Add, replace, inspect, or remove the OpenRouter API key',
  'openrouter',
)
