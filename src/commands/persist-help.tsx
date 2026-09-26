import React, { useState } from 'react'
import type { Command } from '../commands.js'
import type { ToolUseContext } from '../Tool.js'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../types/command.js'
import { Box, Text } from '../ink.js'
import { Select } from '../components/CustomSelect/select.js'
import { useRegisterOverlay } from '../context/overlayContext.js'

type Line = [text: string, style?: 'bold' | 'dim']

const USAGE_LINES: Line[] = [
  ['/persist — keep a goal alive across turns', 'bold'],
  [''],
  ['Arm a goal — modifiers come before the goal', 'bold'],
  ['  /persist <goal>                  bounded: work on it until the outcome is met'],
  ['  /persist task <goal>             one task, then the goal closes itself'],
  ['  /persist keep <task>             a standing goal that spans turns'],
  ['  /persist plan <goal>             plan before implementing'],
  ['  /persist task --nudges 3 <goal>  cap the nudges (1-3; default 1)'],
  ['  `task` and `keep` are mutually exclusive.', 'dim'],
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
  ['  bounded  one outcome, re-checked after every turn'],
  ['  task     a single task; the heartbeat stays armed until it is closed'],
  ['  keep     a standing goal until explicit completion'],
]

const CHECKPOINT_LINES: Line[] = [
  ['Checkpoints and blockers — reported through /persist-review', 'bold'],
  [''],
  ['A delivery checkpoint is this JSON:'],
  ['  {"kind":"advanced|learned|delivered|detoured",'],
  ['   "phase":"implement|integrate|harden",'],
  ['   "outcome":"...", "doneWhen":"...", "next":"...",'],
  ['   "deferred":"...", "evidence":"..."}'],
  [''],
  ['Rules the engine enforces', 'bold'],
  ['  Start at phase `implement`.'],
  ['  Advance one phase only after a `delivered` review — never skip `integrate`.'],
  ['  Until delivered, keep `outcome` and `doneWhen` word-for-word; change the'],
  ['  approach in `next` instead. Every field except `deferred` must be non-empty.'],
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

type Sample = { label: string; value: string; description: string }

const SAMPLES: Sample[] = [
  {
    label: 'bounded goal',
    value: '/persist fix the installer so a fresh PC bootstrap works end-to-end',
    description: 'Keep working until this outcome is met, on the default nudge budget.',
  },
  {
    label: 'task mode',
    value: '/persist task make the packager copy install-gateway.ps1 beside the zip',
    description: 'One task, then the goal closes itself.',
  },
  {
    label: 'keep mode',
    value: '/persist keep keep the release artifact downloadable and the repo private',
    description: 'A standing goal that spans turns until explicit completion.',
  },
  {
    label: 'plan first',
    value: '/persist plan add a /persist-help command that never queries the model',
    description: 'Ask for a plan before implementing.',
  },
  {
    label: 'capped nudges',
    value: '/persist task --nudges 3 verify the release archive on a clean profile',
    description: 'Cap the nudges at 3 (1-3; default 1).',
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

type Screen = 'usage' | 'checkpoints' | 'samples'

export function PersistHelp({ onDone }: { onDone: LocalJSXCommandOnDone }): React.ReactNode {
  const [screen, setScreen] = useState<Screen>('usage')
  const [focused, setFocused] = useState<string>(SAMPLES[0]!.value)
  useRegisterOverlay('persist-help', true)

  // Closing and the two content screens all leave the conversation untouched:
  // no result text is returned, so nothing is added to the transcript.
  const close = () => onDone(undefined, { display: 'skip' })

  const navigation = [
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

  return (
    <Box flexDirection="column">
      {screen === 'usage' ? renderLines(USAGE_LINES) : renderLines(CHECKPOINT_LINES)}
      <Box marginTop={1}>
        <Select
          options={navigation}
          visibleOptionCount={3}
          onCancel={screen === 'usage' ? close : () => setScreen('usage')}
          onChange={(value: string) => {
            if (value === 'exit') close()
            else setScreen(value as Screen)
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
