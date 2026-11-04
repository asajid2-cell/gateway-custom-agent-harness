import type { Command } from '../../commands.js'

const command = (name: string, description: string, keyName: string) =>
  ({
    type: 'local-jsx',
    name,
    description,
    argumentHint:
      keyName === 'opencode-go' || keyName === 'commandcode' || keyName === 'mistral'
        ? '[new|switch <number> [session|global]|status|remove]'
        : '[status|remove]',
    load: async () => {
      const module = await import('./login.js')
      // login.tsx takes the bound credential as a fourth argument; its exported
      // type is the generic three-argument command shape.
      const call = module.call as unknown as (
        onDone: Parameters<typeof module.call>[0],
        context: Parameters<typeof module.call>[1],
        args: string,
        boundKeyName?: string,
      ) => ReturnType<typeof module.call>
      return {
        call: (onDone, context, args) => call(onDone, context, args, keyName),
      }
    },
  }) satisfies Command

export const openCodeLogin = command(
  'opencodelogin',
  'Add, replace, inspect, or remove the OpenCode Go API key',
  'opencode-go',
)

/**
 * `/login` in gateway mode: the picker-backed entry point to the provider key
 * UI. The per-provider commands stay registered; this is the one an operator
 * who types `/login` gets.
 */
export const gatewayLogin: Command = {
  type: 'local-jsx',
  name: 'login',
  description:
    'Add, replace, inspect, or remove a gateway provider key (opencode, commandcode, deepseek, openrouter)',
  argumentHint: '[provider|status|remove]',
  load: async () => {
    const module = await import('./unified.js')
    return {
      call: (onDone, context, args) => module.call(onDone, context, args),
    }
  },
}

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

export const mistralLogin = command(
  'mistrallogin',
  'Add, replace, inspect, or remove the Mistral API key',
  'mistral',
)

// Vibe plan keys are a separate Mistral credential type (Code > Vibe CLI) and
// are spent before Studio API usage.
export const mistralVibeLogin = command(
  'mistralvibelogin',
  'Add, replace, inspect, or remove the Mistral Vibe plan key',
  'mistralvibe',
)

// Compatibility aliases for the original command registry names.
export const openCodeLoginCommand = openCodeLogin
export const deepSeekLoginCommand = deepSeekLogin
