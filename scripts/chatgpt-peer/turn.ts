/**
 * One inbound message's turn on the page, with the command loop.
 *
 * The model answers in prose, in commands, or both. Commands run against the
 * bus; their results go back to the model as one user message; the loop repeats
 * until the model stops emitting commands or the round budget is spent. The
 * host, not this module, decides what to do about a missing reply.
 */
import {
  extractCommands, formatResultLines, MAX_COMMANDS_PER_TURN, MAX_MODEL_ROUNDS, type Command,
} from './commands.ts'

export type GenerateResult = { ok: boolean; text?: string; error?: string }
export type ExecuteResult = { line: string; replied?: boolean }

export type TurnDeps = {
  /** One page turn: post the prompt, return the assistant's text. */
  generate(prompt: string): Promise<GenerateResult>
  /** Run one validated command and describe the outcome in one line. */
  execute(command: Command): Promise<ExecuteResult>
  budget?: number
  maxCommands?: number
}

export type Executed = { command: Command; line: string; replied: boolean }

export type TurnOutcome = {
  rounds: number
  finalText: string
  executed: Executed[]
  problems: string[]
  /** True when a `reply`/`send` command already answered for this turn. */
  repliedExplicitly: boolean
  /** True when commands were still being emitted as the round budget ran out. */
  budgetSpent: boolean
  failed: boolean
}

export async function runCommandTurn(initialPrompt: string, nonce: string, deps: TurnDeps): Promise<TurnOutcome> {
  const budget = deps.budget ?? MAX_MODEL_ROUNDS
  const maxCommands = deps.maxCommands ?? MAX_COMMANDS_PER_TURN
  const executed: Executed[] = []
  const problems: string[] = []
  let repliedExplicitly = false
  let finalText = ''
  let rounds = 0
  let budgetSpent = false
  let failed = false
  let prompt = initialPrompt

  while (rounds < budget) {
    rounds++
    const generated = await deps.generate(prompt)
    if (!generated.ok) {
      failed = true
      problems.push(`model turn failed: ${generated.error ?? 'no answer'}`)
      break
    }
    finalText = generated.text ?? ''
    const extraction = extractCommands(finalText, nonce, maxCommands)
    problems.push(...extraction.problems)
    if (extraction.commands.length === 0) {
      budgetSpent = false
      break
    }
    const lines = [...extraction.problems.map(problem => problem.replace(/^line \d+: /, ''))]
    for (const command of extraction.commands) {
      const result = await deps.execute(command)
      const replied = result.replied === true
      executed.push({ command, line: result.line, replied })
      if (replied) repliedExplicitly = true
      lines.push(result.line)
    }
    prompt = formatResultLines(lines)
    if (rounds >= budget) budgetSpent = true
  }

  return { rounds, finalText, executed, problems, repliedExplicitly, budgetSpent, failed }
}
