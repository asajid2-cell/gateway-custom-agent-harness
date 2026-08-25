import type { Command, LocalCommandResult } from '../../commands.js'
import {
  fetchOpenRouterModels,
  getSavedOpenRouterModelOptions,
  openRouterModelOption,
  removeOpenRouterModel,
  saveOpenRouterModelOption,
} from '../../utils/model/openRouterModels.js'

function result(value: string): LocalCommandResult {
  return { type: 'text', value }
}

function formatModels(models: ReturnType<typeof openRouterModelOption>[], title: string): string {
  if (models.length === 0) return `${title}\nNo models found.`
  return [
    `${title} (${models.length})`,
    ...models.map(option => `${option.value}\t${option.label}\t${option.description}`),
  ].join('\n')
}

const command: Command = {
  type: 'local',
  name: 'openmodels',
  description: 'Browse OpenRouter models and manage which ones appear in /model',
  argumentHint: '[search <text>|all|saved|add <model-id>|remove <model-id>]',
  supportsNonInteractive: true,
  load: async () => ({
    call: async (rawArgs: string): Promise<LocalCommandResult> => {
      const args = rawArgs.trim()
      const [action, ...rest] = args.split(/\s+/)
      const query = rest.join(' ').trim()

      if (action === 'saved') {
        return result(formatModels(getSavedOpenRouterModelOptions(), 'Saved OpenRouter models'))
      }

      if (action === 'remove') {
        if (!query) return result('Usage: /openmodels remove <model-id>')
        const option = getSavedOpenRouterModelOptions().find(item =>
          item.description.split(',')[0] === query || item.description === query || item.value === query)
        const removed = removeOpenRouterModel(option?.value ?? query)
        return result(removed ? `Removed OpenRouter model ${query} from /model.` : `OpenRouter model ${query} was not saved.`)
      }

      let catalog
      try {
        catalog = await fetchOpenRouterModels()
      } catch (error) {
        return result(`Could not load OpenRouter models: ${error instanceof Error ? error.message : String(error)}`)
      }

      if (action === 'add') {
        if (!query) return result('Usage: /openmodels add <model-id>')
        const model = catalog.find(item => item.id === query)
        if (!model) return result(`OpenRouter model not found: ${query}`)
        const option = openRouterModelOption(model)
        saveOpenRouterModelOption(option)
        return result(`Saved ${option.label} (${model.id}) to the main /model picker.`)
      }

      const normalizedQuery = action === 'search' ? query.toLowerCase() : ''
      const filtered = catalog
        .filter(model => !normalizedQuery || `${model.id} ${model.name ?? ''} ${model.description ?? ''}`.toLowerCase().includes(normalizedQuery))
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(openRouterModelOption)

      if (action === 'all') {
        return result(formatModels(filtered, 'All OpenRouter models'))
      }
      if (action === 'search') {
        return result(formatModels(filtered.slice(0, 200), `OpenRouter models matching "${query}"`))
      }
      return result([
        `OpenRouter catalog loaded: ${catalog.length} models.`,
        'Use /openmodels search <text> to filter, /openmodels all to list every model,',
        '/openmodels add <model-id> to add one to /model, or /openmodels saved to inspect selections.',
        formatModels(filtered.slice(0, 50), 'First OpenRouter models'),
      ].join('\n'))
    },
  }),
}

export default command
