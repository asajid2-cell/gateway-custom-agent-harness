import type { Command } from '../../commands.js'

const command = (name: string, description: string, keyName: string) =>
  ({
    type: 'local-jsx',
    name,
    description,
    argumentHint:
      keyName === 'opencode-go' || keyName === 'commandcode'
        ? '[new|switch <number> [session|global]|status|remove]'
        : '[status|remove]',
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

// Re-read the Keysafe vault into the running gateway without restarting cc.
export const refreshLogin: Command = {
  type: 'local-jsx',
  name: 'refreshlogin',
  description: 'Reload gateway API keys from Keysafe without restarting cc',
  load: async () => {
    const module = await import('./login.js')
    return {
      call: (onDone, context, args) => module.refreshLogin(onDone, context, args),
    }
  },
}

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

export const commandCodeLogin = command(
  'commandcodelogin',
  'Add, replace, inspect, or remove the Command Code API key',
  'commandcode',
)

// Compatibility aliases for the original command registry names.
export const openCodeLoginCommand = openCodeLogin
export const deepSeekLoginCommand = deepSeekLogin
