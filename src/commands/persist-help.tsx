import React, { useState } from 'react'
import type { Command } from '../commands.js'
import type { ToolUseContext } from '../Tool.js'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../types/command.js'
import { Box, Text } from '../ink.js'
import { setClipboard } from '../ink/termio/osc.js'
import { Select } from '../components/CustomSelect/select.js'
import { useRegisterOverlay } from '../context/overlayContext.js'

type Line = [text: string, style?: 'bold' | 'dim']

/** What parsePersistArgs returns, restated so an example can pin it exactly. */
export type ParsedPersist =
  | { kind: 'status' }
  | { kind: 'clear' }
  | { kind: 'complete' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'error'; message: string }
  | {
      kind: 'task'
      options: {
        task: string
        mode: 'work' | 'plan'
        keep: boolean
        taskMode: 'bounded' | 'task' | 'keep'
        nudges: number
      }
    }

export type PersistExample = {
  /** The whole line a reader types, modifiers included. */
  command: string
  /** What the engine does with it, in the reader's terms. */
  effect: string
  /**
   * Exactly what parsePersistArgs must return for that line. The help test
   * asserts it, so an example cannot silently drift from the grammar - a wrong
   * example here is a wrong instruction to whoever copies it.
   */
  parsed: ParsedPersist
}

export const EXAMPLES: PersistExample[] = [
  {
    command: '/persist Fix the flaky login redirect so the suite goes green',
    effect: 'bounded, the default: one contained job, up to 1 reminder.',
    parsed: {
      kind: 'task',
      options: { task: 'Fix the flaky login redirect so the suite goes green', mode: 'work', keep: false, taskMode: 'bounded', nudges: 1 },
    },
  },
  {
    command: '/persist --nudges 3 Ship the release: build, tag, publish, verify a fresh install',
    effect: 'bounded with a wider opening budget. A modifier may come first.',
    parsed: {
      kind: 'task',
      options: { task: 'Ship the release: build, tag, publish, verify a fresh install', mode: 'work', keep: false, taskMode: 'bounded', nudges: 3 },
    },
  },
  {
    command: '/persist task Get the installer working end to end: build the archive, publish the release, then prove a sandboxed install on a clean directory',
    effect: 'task: the heartbeat stays armed past the budget until it is verified complete.',
    parsed: {
      kind: 'task',
      options: {
        task: 'Get the installer working end to end: build the archive, publish the release, then prove a sandboxed install on a clean directory',
        mode: 'work', keep: false, taskMode: 'task', nudges: 1,
      },
    },
  },
  {
    command: '/persist task --nudges 3 Verify the release archive on a clean profile',
    effect: 'task mode first, then the nudge count. Order between modifiers is free.',
    parsed: {
      kind: 'task',
      options: { task: 'Verify the release archive on a clean profile', mode: 'work', keep: false, taskMode: 'task', nudges: 3 },
    },
  },
  {
    command: '/persist keep Migrate the fleet to the new shard registry',
    effect: 'keep: custody of the goal until you explicitly complete or release it.',
    parsed: {
      kind: 'task',
      options: { task: 'Migrate the fleet to the new shard registry', mode: 'work', keep: true, taskMode: 'keep', nudges: 1 },
    },
  },
  {
    command: '/persist keep --nudges 2 Drain the WAL without losing a row',
    effect: 'keep with a starting reminder count. In keep mode --nudges is never a limit.',
    parsed: {
      kind: 'task',
      options: { task: 'Drain the WAL without losing a row', mode: 'work', keep: true, taskMode: 'keep', nudges: 2 },
    },
  },
  {
    command: '/persist plan task Rebuild the retry epoch so a signature change cannot pass a dead timestamp',
    effect: 'plan + task: state the goal, state and completion criteria first, then drive it.',
    parsed: {
      kind: 'task',
      options: { task: 'Rebuild the retry epoch so a signature change cannot pass a dead timestamp', mode: 'plan', keep: false, taskMode: 'task', nudges: 1 },
    },
  },
  {
    command: '/persist plan keep Migrate the fleet to the new shard registry',
    effect: 'plan + keep. Identical to /persist keep plan ... — modifier order does not matter.',
    parsed: {
      kind: 'task',
      options: { task: 'Migrate the fleet to the new shard registry', mode: 'plan', keep: true, taskMode: 'keep', nudges: 1 },
    },
  },
  {
    command: '/persist Ship task X',
    effect: 'TRAP: modifiers only count before the goal, so the goal here is "Ship task X".',
    parsed: {
      kind: 'task',
      options: { task: 'Ship task X', mode: 'work', keep: false, taskMode: 'bounded', nudges: 1 },
    },
  },
  {
    command: '/persist keep task Migrate the fleet',
    effect: 'TRAP: task and keep together is refused, not resolved.',
    parsed: { kind: 'error', message: 'Choose either task mode or keep mode, not both.' },
  },
  {
    command: '/persist --nudges 5 Drain the WAL',
    effect: 'TRAP: --nudges is 1-3. Five is an error, not a clamp.',
    parsed: { kind: 'error', message: 'Nudge count must be an integer from 1 to 3.' },
  },
  {
    command: '/persist status',
    effect: 'The armed goal, its mode, phase and latest checkpoint. The verb stands alone.',
    parsed: { kind: 'status' },
  },
  {
    command: '/persist pause',
    effect: 'Stop the heartbeat, keep the goal stored.',
    parsed: { kind: 'pause' },
  },
  {
    command: '/persist resume',
    effect: 'Re-arm a paused goal.',
    parsed: { kind: 'resume' },
  },
  {
    command: '/persist complete',
    effect: 'Record the goal as done — the manual override. done is an alias.',
    parsed: { kind: 'complete' },
  },
  {
    command: '/persist clear',
    effect: 'Release the goal without recording completion.',
    parsed: { kind: 'clear' },
  },
]

const USAGE_LINES: Line[] = [
  ['/persist — keep a goal alive across turns', 'bold'],
  [''],
  ['Arm a goal — modifiers come before the goal', 'bold'],
  ['  /persist <goal>                   bounded: up to N reminders, then kept but quiet'],
  ['  /persist task <goal>              task: armed past the budget until closed'],
  ['  /persist keep <goal>              keep: custody until you complete or release it'],
  ['  /persist plan <goal>              plan first, then execute'],
  ['  /persist keep --nudges 2 <goal>   modifiers compose, in any order'],
  ['  /persist task --nudges 3 <goal>   --nudges is 1-3, default 1'],
  ['  `task` and `keep` together is refused; the mode words must precede the goal.', 'dim'],
  ['  "Full reference" below has the whole grammar and copy-ready commands.', 'dim'],
  [''],
  ['Control a live goal', 'bold'],
  ['  /persist status     armed goal, mode, phase, latest checkpoint'],
  ['  /persist pause      stop the heartbeat, keep the goal'],
  ['  /persist resume     restart a paused goal'],
  ['  /persist complete   record the goal as done'],
  ['  /persist clear      drop the goal entirely'],
  ['  These verbs stand alone: `/persist complete fix it` sets a GOAL, it does not complete.', 'dim'],
  [''],
  ['Modes', 'bold'],
  ['  bounded  one contained job; reminders stop at the budget, the goal is retained'],
  ['  task     a long job; the heartbeat stays armed until it is verified complete'],
  ['  keep     a standing goal held until explicit completion'],
  ['  plan     orthogonal to all three: it adds a planning step before implementation'],
]

const CHECKPOINT_LINES: Line[] = [
  ['Checkpoints and blockers — reported through /persist-review', 'bold'],
  [''],
  ['A delivery checkpoint is this JSON:'],
  ['  {"kind":"advanced|learned|delivered|detoured",'],
  ['   "phase":"implement|integrate|harden",'],
  ['   "outcome":"...", "doneWhen":"...", "next":"...",'],
  ['   "deferred":"...", "evidence":"..."}'],
  ['  Every field is a string of at most 1200 chars. `deferred` may be empty or'],
  ['  omitted; all the others must be non-empty.'],
  [''],
  ['Rules the engine enforces', 'bold'],
  ['  Start at phase `implement`.'],
  ['  Advance one phase only after a `delivered` review — never skip `integrate`.'],
  ['  Until delivered, keep `outcome` and `doneWhen` word-for-word; change the'],
  ['  approach in `next` instead.'],
  ['  `delivered` is a milestone, not goal completion. reviewsSinceDelivery and'],
  ['  detours are derived by the engine, not fields you pass.'],
  ['  A refused checkpoint records nothing and leaves the goal active — fix the'],
  ['  JSON and resend.'],
  [''],
  ['A task-mode hard stop is a different JSON:', 'bold'],
  ['  {"kind":"blocked",'],
  ['   "blocker":"user-input|authorization|safety|external-dependency|provider-failure",'],
  ['   "canProceedWithoutUser":false, "next":"...", "evidence":"..."}'],
  ['  Uncertainty, reversible tests and diagnosis are NOT blockers.', 'dim'],
  [''],
  ['The goal is stored beside the transcript, so it survives a restart.', 'dim'],
  ['You can arm a goal, and so can an agent you tell to invoke /persist; a subagent', 'dim'],
  ['cannot. One goal per session; leaves and the main session can both hold one.', 'dim'],
]

const referenceExamples: Line[] = EXAMPLES.flatMap((example): Line[] => [
  [example.command],
  [`    ${example.effect}`, 'dim'],
  [''],
])

/** The full explanation, line by line; the screen renders the synopsis below. */
const PERSIST_REFERENCE_LINES: Line[] = [
  ['PERSIST — a durable session goal with a Stop-hook heartbeat', 'bold'],
  ['  Copy this whole text with "Copy to clipboard" below.', 'dim'],
  [''],
  ['WHAT IT IS', 'bold'],
  ['  You arm a goal once. From then on, every time the agent tries to end its turn'],
  ['  the Stop hook asks whether the goal is actually done; if it is not, the goal'],
  ['  and your latest instruction are re-injected as a reminder and the turn'],
  ['  continues. The goal lives in a sidecar record beside the transcript, so it'],
  ['  survives /clear, a session switch, pause/resume, and a restart. Only one goal'],
  ['  per session: arming a second overwrites the first. /persist refuses inside a'],
  ['  subagent; both commands are otherwise available to you and to an agent you'],
  ['  instruct to call them.'],
  [''],
  ['GRAMMAR', 'bold'],
  ['  /persist [<modifiers>] <goal text>'],
  ['  /persist status | pause | resume | complete | clear'],
  [''],
  ['  Modifiers are read left to right until the first token that is not one;'],
  ['  everything from there on is the goal, verbatim. Order among the modifiers is'],
  ['  free, but they only count before the goal text.'],
  [''],
  ['    task | --task   task mode - armed past the budget, closed on verification'],
  ['    keep            keep mode - custody until you explicitly complete or release'],
  ['    plan            plan first, then execute (legacy spelling: plan;)'],
  ['    --nudges N      1-3, default 1 - opening reminders (a count, not a cap)'],
  [''],
  ['  task and keep together is refused: "Choose either task mode or keep mode, not'],
  ['  both." Bare /persist, or nothing left after the modifiers, replies with the'],
  ['  usage line.'],
  [''],
  ['LOOK-AFTER MODES', 'bold'],
  ['  bounded  (default)  up to --nudges N reminders on an attempted stop, then the'],
  ['                      goal is kept but silent. One contained job.'],
  ['  task     (task)     keeps firing past the budget while useful work remains, and'],
  ['                      will not accept prose as completion: closing needs a'],
  ['                      delivery checkpoint (substantial outcome + doneWhen +'],
  ['                      evidence) or /persist complete. A long multi-phase job.'],
  ['  keep     (keep)     custody until you release it; --nudges is an opening count,'],
  ['                      never a limit. Also asks for a /persist-review on the first'],
  ['                      stop attempt of each chain. An open-ended goal.'],
  ['  plan is orthogonal to the three: it adds a planning requirement, any mode.'],
  [''],
  ['EXAMPLES — complete commands you can copy', 'bold'],
  ['  Each line is checked against the parser by the help tests, so it does exactly'],
  ['  what the line beneath it says.', 'dim'],
  [''],
  ...referenceExamples,
  ['LIFECYCLE (any time; the verb must be the whole argument)', 'bold'],
  ['  /persist            same as /persist status'],
  ['  /persist pause      stop auto-continuation, keep the goal stored'],
  ['  /persist resume     re-arm it'],
  ['  /persist complete   mark done — the manual override (done is an alias)'],
  ['  /persist clear      release it without recording completion'],
  [''],
  ['/persist-review — checkpoints and the done/blocked verdict', 'bold'],
  ['  The agent calls this at meaningful checkpoints; you can type it too.'],
  [''],
  ['  /persist-review checkpoint <JSON>'],
  ['  /persist-review continue | unrelated | blocked | complete <evidence>'],
  ['  JSON on its own is accepted (its kind names the verb), and so is'],
  ['  `checkpoint: {…}`.'],
  [''],
  ['  Checkpoint JSON — every field a string of at most 1200 chars; deferred may be'],
  ['  empty or omitted, all the others must be non-empty:'],
  [''],
  ['    {"kind":"advanced|learned|delivered|detoured",'],
  ['     "phase":"implement|integrate|harden",'],
  ['     "outcome":"the substantial outcome being delivered",'],
  ['     "doneWhen":"the acceptance condition that says it is delivered",'],
  ['     "next":"the immediate next step",'],
  ['     "deferred":"what is deliberately postponed",'],
  ['     "evidence":"what you actually observed"}'],
  [''],
  ['  Four rules that reject a checkpoint (nothing is recorded), so correct the JSON'],
  ['  and resend rather than stopping:'],
  ['    1. The first checkpoint must be phase "implement"; you cannot open at'],
  ['       integrate or harden.'],
  ['    2. A phase may advance at most one step, and only on kind "delivered" —'],
  ['       never skip integrate.'],
  ['    3. Until you deliver, outcome and doneWhen must be word-for-word identical to'],
  ['       the previous checkpoint; change the approach in next, not the outcome.'],
  ['    4. "delivered" is a milestone, not goal completion. reviewsSinceDelivery and'],
  ['       detours are derived by the engine, not fields you pass.'],
  [''],
  ['  Short forms:'],
  ['    /persist-review continue  <what you tested and observed>'],
  ['    /persist-review unrelated <why this turn was not the goal>'],
  ['    /persist-review complete  <concrete evidence the doneWhen condition is met>'],
  [''],
  ['  A task-mode hard stop is a different JSON, and only a real hard stop counts:'],
  ['    {"kind":"blocked",'],
  ['     "blocker":"user-input|authorization|safety|external-dependency|provider-failure",'],
  ['     "canProceedWithoutUser":false, "next":"...", "evidence":"..."}'],
  ['    Hypotheses, reversible tests and diagnosis uncertainty are not blockers; a'],
  ['    non-JSON blocker leaves the task active.'],
  [''],
  ['THINGS THAT WILL BITE YOU', 'bold'],
  ['  Order matters: /persist Ship task X makes "Ship task X" the goal; the mode'],
  ['  words must precede the goal text.'],
  ['  complete and done are the completion verb only as the whole argument, so a'],
  ['  goal cannot be those words alone.'],
  ['  --nudges is 1-3 exactly. --nudges 5 is an error, not a clamp.'],
  ['  Main session only: /persist refuses inside a subagent.'],
  ['  One goal per session; arming a second overwrites the record.'],
  ['  Injected text is truncated: the goal at 2000 chars, your latest instruction at'],
  ['  1000.'],
]

/**
 * The complete explanation, as one string: this is what "Copy the complete
 * reference" hands over. The screen cannot draw it - an immediate local-jsx
 * command renders in a slot capped at the viewport height with overflow hidden,
 * so ~150 lines would clip the menu and the prompt away - so the screen shows
 * REFERENCE_LINES and the clipboard carries all of this.
 */
export const PERSIST_REFERENCE = PERSIST_REFERENCE_LINES.map(([text]) => text).join('\n')

/** What fits on screen: the whole shape, with the complete text one key away. */
const REFERENCE_LINES: Line[] = [
  ['Full reference — the complete text goes to your clipboard', 'bold'],
  ['  "Copy the complete reference" below has all of it: the grammar, every example', 'dim'],
  ['  as a copy-ready command, the checkpoint JSON and its rules, and the traps.', 'dim'],
  [''],
  ['WHAT IT IS', 'bold'],
  ['  Arm a goal once. On every attempted stop the Stop hook checks whether the goal'],
  ['  is done; if it is not, the goal and your latest instruction are re-injected as'],
  ['  a reminder and the turn continues. The goal is stored beside the transcript, so'],
  ['  it survives /clear, a session switch, pause/resume and a restart. One goal per'],
  ['  session; main session only. Both commands are model-invocable too.'],
  [''],
  ['GRAMMAR — modifiers precede the goal; order among them is free', 'bold'],
  ['  /persist [<modifiers>] <goal text>'],
  ['  /persist status | pause | resume | complete | clear'],
  ['    task | --task   task mode          keep            keep mode'],
  ['    plan            plan first         --nudges N      1-3, default 1'],
  ['  task and keep together is refused. Bare /persist prints the usage line.'],
  [''],
  ['MODES', 'bold'],
  ['  bounded (default)  up to N reminders, then the goal is kept but quiet'],
  ['  task               armed past the budget until verified complete'],
  ['  keep               custody until you complete or release it'],
  ['  plan               orthogonal to the three: adds a planning step'],
  [''],
  ['REVIEW — /persist-review', 'bold'],
  ['  checkpoint <JSON> | continue | unrelated | blocked | complete <evidence>'],
  ['  Start at phase implement; advance one phase only on delivered; keep outcome and'],
  ['  doneWhen until delivered. A refused checkpoint records nothing.'],
]

type Sample = { label: string; value: string; description: string }

/** Exported so the help test can hold every sample to the real parser. */
export const SAMPLES: Sample[] = [
  {
    label: 'bounded goal',
    value: '/persist fix the installer so a fresh PC bootstrap works end-to-end',
    description: 'One contained job, on the default reminder budget.',
  },
  {
    label: 'capped nudges',
    value: '/persist --nudges 3 ship the release: build, tag, publish, then verify a fresh install',
    description: 'A modifier may come first; --nudges is 1-3 (default 1).',
  },
  {
    label: 'task mode',
    value: '/persist task get the installer working end to end: build the archive, publish it, then prove a sandboxed install',
    description: 'One task driven to verified completion, not just a small step.',
  },
  {
    label: 'keep mode',
    value: '/persist keep keep the release artifact downloadable and the repo private',
    description: 'A standing goal that spans turns until explicit completion.',
  },
  {
    label: 'keep + nudge count',
    value: '/persist keep --nudges 2 drain the WAL without losing a row',
    description: 'Modifiers compose in any order; in keep mode --nudges is only a count.',
  },
  {
    label: 'plan then task',
    value: '/persist plan task rebuild the retry epoch so a signature change cannot pass a dead timestamp',
    description: 'plan and task together: plan first, then execute.',
  },
  {
    label: 'plan then keep',
    value: '/persist plan keep migrate the fleet to the new shard registry',
    description: 'plan + keep. Identical to /persist keep plan … — order is free.',
  },
  {
    label: 'status',
    value: '/persist status',
    description: 'Armed goal, mode, phase and latest checkpoint.',
  },
  {
    label: 'pause',
    value: '/persist pause',
    description: 'Stop the heartbeat without dropping the goal.',
  },
  {
    label: 'resume',
    value: '/persist resume',
    description: 'Restart a paused goal.',
  },
  {
    label: 'complete',
    value: '/persist complete',
    description: 'Record the goal as done. Completion evidence is reported through persist-review.',
  },
  {
    label: 'clear',
    value: '/persist clear',
    description: 'Drop the goal entirely.',
  },
  {
    label: 'checkpoint: implement',
    value:
      '/persist-review {"kind":"advanced","phase":"implement","outcome":"Installer bootstraps on a clean profile","doneWhen":"cc.cmd launches the gateway after install","next":"Wire install-gateway.ps1 into the packager","deferred":"Uninstall polish","evidence":"install log on a clean profile"}',
    description: 'The first checkpoint. The phase must start at implement.',
  },
  {
    label: 'checkpoint: delivered',
    value:
      '/persist-review {"kind":"delivered","phase":"integrate","outcome":"Installer bootstraps on a clean profile","doneWhen":"cc.cmd launches the gateway after install","next":"Exercise the full install-and-run workflow","deferred":"Uninstall polish","evidence":"clean-profile install then cc.cmd run"}',
    description: 'Delivered advances one phase to integrate. outcome and doneWhen stay unchanged.',
  },
]

function renderLines(lines: Line[]): React.ReactNode {
  return lines.map(([text, style], index) => (
    <Text key={index} bold={style === 'bold'} dimColor={style === 'dim'}>
      {text}
    </Text>
  ))
}

/**
 * Put text on the real clipboard. setClipboard returns the OSC 52 sequence the
 * caller must write; its native-utility path (PowerShell on Windows) runs
 * inside it, fire-and-forget, so the raw write is the only thing left here.
 */
async function copyToClipboard(text: string): Promise<void> {
  const raw = await setClipboard(text)
  if (raw) process.stdout.write(raw)
}

type Screen = 'usage' | 'checkpoints' | 'samples' | 'reference'

export function PersistHelp({
  onDone,
  copy = copyToClipboard,
}: {
  onDone: LocalJSXCommandOnDone
  /** Injected in tests so exercising the copy never spawns a clipboard tool. */
  copy?: (text: string) => Promise<void>
}): React.ReactNode {
  const [screen, setScreen] = useState<Screen>('usage')
  const [focused, setFocused] = useState<string>(SAMPLES[0]!.value)
  const [copied, setCopied] = useState(false)
  useRegisterOverlay('persist-help', true)

  // Closing and the content screens all leave the conversation untouched: no
  // result text is returned, so nothing is added to the transcript.
  const close = () => onDone(undefined, { display: 'skip' })

  const navigation = [
    { label: 'Full reference — read it, or copy the whole thing', value: 'reference' },
    { label: 'Sample prompts — copy a format into your prompt', value: 'samples' },
    { label: 'Checkpoints and blockers', value: 'checkpoints' },
    { label: 'Close', value: 'exit' },
  ]

  if (screen === 'samples') {
    const current = SAMPLES.find(sample => sample.value === focused) ?? SAMPLES[0]!
    return (
      <Box flexDirection="column">
        <Text bold>Samples</Text>
        <Text dimColor>Enter puts the highlighted line into your prompt; nothing is sent. Esc goes back.</Text>
        <Select
          key="samples"
          options={SAMPLES.map(sample => ({ label: sample.label, value: sample.value }))}
          visibleOptionCount={8}
          defaultValue={SAMPLES[0]!.value}
          onFocus={(value: string) => setFocused(value)}
          onCancel={() => setScreen('usage')}
          onChange={(value: string) => onDone(undefined, { display: 'skip', nextInput: value })}
        />
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{current.label}</Text>
          <Text dimColor>{current.description}</Text>
          <Text>{current.value}</Text>
        </Box>
      </Box>
    )
  }

  if (screen === 'reference') {
    return (
      <Box flexDirection="column">
        {renderLines(REFERENCE_LINES)}
        <Box marginTop={1}>
          <Select
            key="reference"
            options={[
              { label: 'Copy the complete reference', value: 'copy' },
              { label: 'Back', value: 'back' },
            ]}
            visibleOptionCount={2}
            onCancel={() => setScreen('usage')}
            onChange={(value: string) => {
              if (value === 'back') setScreen('usage')
              else void copy(PERSIST_REFERENCE).then(() => setCopied(true))
            }}
          />
        </Box>
        {copied ? <Text dimColor>Complete reference copied to the clipboard.</Text> : null}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {screen === 'usage' ? renderLines(USAGE_LINES) : renderLines(CHECKPOINT_LINES)}
      <Box marginTop={1}>
        <Select
          key="navigation"
          options={navigation}
          visibleOptionCount={4}
          onCancel={screen === 'usage' ? close : () => setScreen('usage')}
          onChange={(value: string) => {
            if (value === 'exit') close()
            else {
              // A fresh visit should not open showing the last visit's copy toast.
              if (value === 'reference') setCopied(false)
              setScreen(value as Screen)
            }
          }}
        />
      </Box>
    </Box>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: ToolUseContext & LocalJSXCommandContext,
  _args: string,
): Promise<React.ReactNode> {
  return <PersistHelp onDone={onDone} />
}

export default { type: 'local-jsx', name: 'persist-help', description: 'Show how to use /persist, with sample commands', immediate: true, load: async () => ({ call }) } satisfies Command
