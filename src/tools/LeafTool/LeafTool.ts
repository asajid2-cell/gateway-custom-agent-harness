import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { EFFORT_LEVELS, HARNESS_EFFORT_LEVELS } from '../../utils/effort.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { LEAF_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum([
        'list',
        'status',
        'fork',
        'new',
        'send',
        'interrupt',
        'checkpoint',
        'close',
        'reopen',
        'model',
        'effort',
        'return',
        'notify',
        'roster',
        'head',
        'heir',
        'driver',
        'ledger',
        'read',
        'checkpoints',
        'checkpoint-drop',
        'checkpoint-purge',
        'seed',
        'seedling',
        'merge',
        'compact',
        'partner',
        'partners',
        'partner-watch',
        'partner-close',
      ])
      .describe('Operation to perform on the leaf family'),
    leaf: z
      .string()
      .optional()
      .describe('Leaf reference: session ID, number, N:name, or name. A checkpoint reference is #number, or a label'),
    name: z.string().optional().describe('Name for a new leaf, a label for a checkpoint, or a watch mode (idle or new)'),
    message: z.string().optional().describe('Text for send, a context return, or a ledger entry'),
    value: z.string().optional().describe('Model name, effort level, merge fidelity (full or ledger), or a ledger subverb'),
    tail: z.number().int().positive().optional().describe('For read: how many of the newest turns to return (default 12, max 200)'),
    since: z.string().optional().describe('For read: return only the turns after this cursor, taken from a previous read'),
    leaves: z.array(z.string()).optional().describe('For driver: the leaf references the named driver is put in charge of. Empty or omitted clears the scope'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    result: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

/**
 * What a `partner` request's `value` names: the model the partner runs, or the
 * effort level it runs at.
 *
 * `value` carries one of several things depending on the action - a model, an
 * effort level, a merge fidelity - and for a partner both the model and the
 * effort are meaningful, so the word is what decides. The effort levels are a
 * closed set, so a level is recognised rather than guessed at, and anything
 * else is the model it names. Before this, `value` was read unconditionally as
 * the model, so a partner could not be given an effort at all - and a level
 * passed here silently became the model it was launched with - though both the
 * prompt and the design doc promise a partner runs with its own effort.
 */
export function partnerValueSpec(value: string | undefined): { model?: string; effort?: string } {
  const word = value?.trim()
  if (!word) return {}
  const levels: readonly string[] = [...EFFORT_LEVELS, ...HARNESS_EFFORT_LEVELS]
  return levels.includes(word) ? { effort: word } : { model: word }
}

async function run(input: z.infer<InputSchema>, context: { getAppState?: () => { mainLoopModel?: string | null; effortValue?: unknown } }): Promise<string> {
  const workspace = await import('../../utils/leafWorkspace.js')
  const requireLeaf = (): string => {
    if (!input.leaf) throw new Error('A leaf reference is required for this action')
    return input.leaf
  }
  switch (input.action) {
    case 'list':
    case 'status':
      return workspace.listLeaves()
    case 'fork': {
      const options = { model: context.getAppState?.().mainLoopModel ?? undefined, effort: context.getAppState?.().effortValue as import('../../utils/leafFamily.js').LeafMember['effort'] }
      if (!input.leaf) {
        const view = await workspace.createLeaf(input.name?.trim() || undefined, undefined, undefined, options)
        return `Forked the current session into leaf #${view.member.number} ${view.member.name} (${view.member.sessionId}).`
      }
      // A member reference is resolved to its session id; anything else is
      // handed to createLeaf unresolved, because a checkpoint reference - `#2`
      // or a label - is a source it knows and this surface does not.
      const member = await workspace.resolveLeafRef(input.leaf)
      const requested = input.leaf.trim()
      const view = await workspace.createLeaf(input.name?.trim() || undefined, member?.sessionId ?? requested, undefined, options)
      const origin = member ? `leaf #${member.number} ${member.name}` : requested
      return `Forked ${origin} into leaf #${view.member.number} ${view.member.name} (${view.member.sessionId}).`
    }
    case 'new': {
      const options = { fresh: true, model: context.getAppState?.().mainLoopModel ?? undefined, effort: context.getAppState?.().effortValue as import('../../utils/leafFamily.js').LeafMember['effort'] }
      const view = await workspace.createLeaf(input.name?.trim() || undefined, undefined, undefined, options)
      return `Started leaf #${view.member.number} ${view.member.name} (${view.member.sessionId}).`
    }
    case 'send':
      if (!input.message) throw new Error('A message is required to send')
      return workspace.sendLeafMessage(requireLeaf(), input.message)
    case 'interrupt':
      return workspace.interruptLeaf(requireLeaf())
    case 'checkpoint':
      return workspace.checkpointLeaf(requireLeaf(), input.name?.trim() || undefined)
    case 'close':
    case 'reopen': {
      // Closing may name the session you are in; reopening may not, because the
      // session on screen is already running - and that is refused with its own
      // message rather than being reported as a leaf that does not exist.
      const member = input.action === 'close'
        ? await workspace.resolveCloseTarget(requireLeaf())
        : await workspace.resolveOpenTarget(requireLeaf())
      if (!member) throw new Error('Unknown or ambiguous leaf reference')
      const promoted = await workspace.changeLeaf(member.sessionId, { status: input.action === 'close' ? 'closed' : 'open' })
      return `Leaf #${member.number} ${member.name} ${input.action === 'close' ? 'closed' : 'reopened'}; transcript and ancestry retained.${promoted ? ` ${promoted}` : ''}`
    }
    case 'model':
    case 'effort': {
      if (!input.value) throw new Error(`A ${input.action} value is required`)
      return workspace.configureLeaf(requireLeaf(), input.action === 'model' ? { model: input.value } : { effort: input.value })
    }
    case 'return':
      if (!input.message) throw new Error('Selected context is required to return')
      return workspace.returnLeafContext(requireLeaf(), input.message)
    case 'notify':
      if (!input.message) throw new Error('A message is required to notify the matriarch')
      return workspace.notifyLeafMatriarch(input.message)
    case 'roster':
      return workspace.familyRoster()
    // The head's ledger lives beside the family, not in it: the head records its
    // own account of the work, any member may read it, and the write gate is the
    // head designation rather than the matriarch lease. `value` is the subverb,
    // `message` the text, `leaf` the subject, and `name` the watch mode.
    case 'ledger': {
      const ledger = await import('../../utils/headLedger.js')
      return ledger.runHeadLedger({
        ...(input.value?.trim() ? { subverb: input.value.trim() } : {}),
        ...(input.leaf?.trim() ? { leaf: input.leaf.trim() } : {}),
        ...(input.message ? { text: input.message } : {}),
        ...(input.name?.trim() ? { mode: input.name.trim() } : {}),
      })
    }
    case 'read':
      return workspace.readLeafTranscript(input.leaf?.trim() || undefined, {
        ...(input.tail !== undefined ? { tail: input.tail } : {}),
        ...(input.since?.trim() ? { since: input.since.trim() } : {}),
      })
    case 'head': {
      const member = await workspace.resolveLeafRef(requireLeaf())
      if (!member) throw new Error('Unknown or ambiguous leaf reference')
      return workspace.conferPatriarch(member.sessionId)
    }
    case 'heir': {
      const member = await workspace.resolveLeafRef(requireLeaf())
      if (!member) throw new Error('Unknown or ambiguous leaf reference')
      return workspace.conferHeir(member.sessionId)
    }
    // The driver is `leaf`; the leaves it is put in charge of are `leaves`. Both
    // are resolved here so the designation is written once, against member ids.
    case 'driver': {
      const member = await workspace.resolveLeafRef(requireLeaf())
      if (!member) throw new Error('Unknown or ambiguous leaf reference')
      const leafIds: string[] = []
      for (const reference of input.leaves ?? []) {
        const driven = await workspace.resolveLeafRef(reference.trim())
        if (!driven) throw new Error(`Unknown or ambiguous leaf reference: ${reference.trim()}`)
        leafIds.push(driven.sessionId)
      }
      return workspace.conferDriver(member.sessionId, leafIds)
    }
    case 'checkpoints':
      return workspace.listLeafCheckpoints(input.leaf?.trim() || undefined)
    case 'checkpoint-drop':
      return workspace.dropLeafCheckpoint(requireLeaf())
    case 'checkpoint-purge':
      return workspace.purgeLeafCheckpoint(requireLeaf())
    // A seed's source is optional: with no reference it forks this conversation,
    // which is what makes `seed` on its own a way to keep the durable line
    // separate from the forks that do bounded jobs against it.
    case 'seed': {
      const view = await workspace.createSeed(input.leaf?.trim() || undefined, input.name?.trim() || undefined)
      return `Leaf #${view.member.number} ${view.member.name} is a seed (${view.member.sessionId}); fork a bounded job off it with action seedling.`
    }
    case 'seedling': {
      const view = await workspace.createSeedling(requireLeaf(), input.name?.trim() || undefined)
      return `Leaf #${view.member.number} ${view.member.name} is a seedling of ${requireLeaf()}; merge it back with action merge.`
    }
    case 'merge': {
      const fidelity = input.value?.trim().toLowerCase()
      if (fidelity && fidelity !== 'full' && fidelity !== 'ledger') throw new Error('Merge fidelity must be full or ledger')
      return workspace.mergeSeedling(requireLeaf(), fidelity ? { fidelity: fidelity as 'full' | 'ledger' } : {})
    }
    case 'compact':
      return workspace.compactLeaf(requireLeaf())
    // A partner is a session, not a family member: it is launched, listed and
    // closed by its own address on the peer bus rather than by a leaf number.
    case 'partner':
      return workspace.createPartner({
        ...(input.name?.trim() ? { purpose: input.name.trim() } : {}),
        ...partnerValueSpec(input.value),
      })
    case 'partners':
      return workspace.partnerRoster()
    // Watching stops the headless partner and opens its session in a terminal,
    // so it is the same reference as closing one: the partner's session id.
    case 'partner-watch':
      return workspace.watchTandem(requireLeaf())
    case 'partner-close':
      return workspace.closeTandem(requireLeaf())
  }
}

export const LeafTool = buildTool({
  name: LEAF_TOOL_NAME,
  searchHint: 'see, message and drive leaf sessions forked from this one',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return getPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'Leaf'
  },
  shouldDefer: true,
  isEnabled() {
    return true
  },
  isConcurrencySafe() {
    return false
  },
  renderToolUseMessage() {
    return null
  },
  async call(input, context) {
    return { data: { result: await run(input, context as Parameters<typeof run>[1]) } }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const { result } = content as Output
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: result,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
