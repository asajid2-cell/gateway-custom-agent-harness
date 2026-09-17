import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
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
      ])
      .describe('Operation to perform on the leaf family'),
    leaf: z
      .string()
      .optional()
      .describe('Leaf reference: session ID, number, N:name, or name'),
    name: z.string().optional().describe('Name for a new leaf, or a checkpoint name'),
    message: z.string().optional().describe('Text for send or for a context return'),
    value: z.string().optional().describe('Model name or effort level'),
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
      const member = await workspace.resolveLeafRef(input.leaf)
      if (!member) throw new Error('Unknown or ambiguous leaf reference')
      const view = await workspace.createLeaf(input.name?.trim() || undefined, member.sessionId, undefined, options)
      return `Forked leaf #${member.number} ${member.name} into leaf #${view.member.number} ${view.member.name} (${view.member.sessionId}).`
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
      const member = await workspace.resolveLeafRef(requireLeaf())
      if (!member) throw new Error('Unknown or ambiguous leaf reference')
      await workspace.changeLeaf(member.sessionId, { status: input.action === 'close' ? 'closed' : 'open' })
      return `Leaf #${member.number} ${member.name} ${input.action === 'close' ? 'closed' : 'reopened'}; transcript and ancestry retained.`
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
      if (!input.message) throw new Error('A message is required to notify the parent')
      return workspace.notifyLeafParent(input.message)
    case 'roster':
      return workspace.familyRoster()
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
