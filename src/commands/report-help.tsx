import React, { useState } from 'react'
import type { Command } from '../commands.js'
import type { ToolUseContext } from '../Tool.js'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../types/command.js'
import { Box, Text } from '../ink.js'
import { Select } from '../components/CustomSelect/select.js'
import { useRegisterOverlay } from '../context/overlayContext.js'
import { DEFAULT_REPORT_DIR } from '../skills/bundled/report.js'

type Line = [text: string, style?: 'bold' | 'dim']

const USAGE_LINES: Line[] = [
  ['/report — hand off this project to another session', 'bold'],
  [''],
  ['A report is written from a session transcript, so it can describe work you were', 'dim'],
  ['not present for. It reports on any session, not only the one you are typing in.', 'dim'],
  [''],
  ['Depth — pick one; the default is checkpoint', 'bold'],
  ['  /report checkpoint             delta for a session that already knows the project'],
  ['  /report handoff                full rehydration for a session with no history'],
  ['  /report seed                   just the persist seed'],
  ['  /report list                   name the sessions you could report on'],
  [''],
  ['Choosing the session', 'bold'],
  ['  /report handoff <id>           an exact session id'],
  ['  /report handoff <words>        a title, a cwd, or a word from its opening prompt'],
  ['  /report handoff                this session'],
  ['  An unknown query resolves to nothing. It never guesses at the wrong session.', 'dim'],
  [''],
  ['Where it lands', 'bold'],
  [`  ${DEFAULT_REPORT_DIR}`],
  ['  --out <dir> overrides it; GATEWAY_REPORT_DIR sets a standing destination.'],
  [''],
  ['Flags', 'bold'],
  ['  --session, -s <id|query>       which session to report on'],
  ['  --out, -o <dir>                where the report is written'],
  ['  --max-bytes <n>                cap how much of a huge transcript is read'],
  [''],
  ['This menu is local: nothing is sent. Only you can invoke /report — the model', 'dim'],
  ['cannot, so a report is never written unless you ask for one.', 'dim'],
]

const RULES_LINES: Line[] = [
  ['What a report is built from — and what it may not say', 'bold'],
  [''],
  ['Every report carries a machine-gathered evidence block: the instructions given,'],
  ['the files touched, the commands run with their verdicts, and the test runs. It is'],
  ['reproduced verbatim under "## Raw evidence", so any line of it can be checked'],
  ['against the transcript. The model writes the prose; it does not supply the facts.'],
  [''],
  ['Every claim is labelled, and only these labels may be used', 'bold'],
  ['  [FACT]         directly supported by the evidence'],
  ['  [PROVEN]       a test or acceptance run in the evidence passed'],
  ['  [IMPLEMENTED]  code exists, but nothing in the evidence confirms it ran'],
  ['  [DESIGN]       agreed architecture; not necessarily built'],
  ['  [OPEN]         not decided or not built'],
  ['  [BLOCKED]      requires something currently unavailable'],
  ['  [SUPERSEDED]   was the plan; no longer is'],
  ['  [CONFLICT]     two sources disagree'],
  [''],
  ['Rules the skill enforces', 'bold'],
  ['  [PROVEN] requires a PASS row under TEST RUNS DETECTED. With none listed,'],
  ['  nothing may be called proven — looking correct is not evidence.'],
  ['  A gap in the evidence is reported as unknown, never as a guess.'],
  ['  Where history was compacted or the read was truncated, the report says so.'],
  [''],
  ['The evidence is bounded, and the bound is named', 'bold'],
  ['  A long session is summarised head and tail, and every row left out is counted'],
  ['  in the report — so a thin section reads as thin, not as complete.', 'dim'],
  [''],
  ['A seed ends with a /persist plan task line, ready to run as typed.', 'dim'],
]

type Sample = { label: string; value: string; description: string }

const SAMPLES: Sample[] = [
  {
    label: 'checkpoint (this session)',
    value: '/report checkpoint',
    description: 'The default. A short delta for a session that already knows the project.',
  },
  {
    label: 'handoff (this session)',
    value: '/report handoff',
    description: 'A full document for a session that has no history at all.',
  },
  {
    label: 'handoff by session id',
    value: '/report handoff --session eefe9d1f-1897-4129-a448-c2ed493fc2e6',
    description: 'Report on an exact session, found by its id.',
  },
  {
    label: 'handoff by title or prompt fragment',
    value: '/report handoff choralus licensing gate',
    description: 'Find the session by a word from its title, cwd, or opening prompt.',
  },
  {
    label: 'seed',
    value: '/report seed',
    description: 'Only the persist seed, ending in a runnable /persist plan task line.',
  },
  {
    label: 'list',
    value: '/report list',
    description: 'Name the sessions available to report on, newest first.',
  },
  {
    label: 'choose the destination',
    value: '/report handoff --out Z:\\tmp\\reports',
    description: 'Write this one report somewhere other than the archive.',
  },
  {
    label: 'cap the read',
    value: '/report handoff --max-bytes 8000000',
    description: 'Read at most ~8 MB of a very large transcript.',
  },
]

function renderLines(lines: Line[]): React.ReactNode {
  return lines.map(([text, style], index) => (
    <Text key={index} bold={style === 'bold'} dimColor={style === 'dim'}>
      {text}
    </Text>
  ))
}

type Screen = 'usage' | 'rules' | 'samples'

export function ReportHelp({ onDone }: { onDone: LocalJSXCommandOnDone }): React.ReactNode {
  const [screen, setScreen] = useState<Screen>('usage')
  const [focused, setFocused] = useState<string>(SAMPLES[0]!.value)
  useRegisterOverlay('report-help', true)

  // Closing and the two content screens all leave the conversation untouched:
  // no result text is returned, so nothing is added to the transcript.
  const close = () => onDone(undefined, { display: 'skip' })

  const navigation = [
    { label: 'Sample prompts — copy a format into your prompt', value: 'samples' },
    { label: 'Evidence and labels', value: 'rules' },
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
      {screen === 'usage' ? renderLines(USAGE_LINES) : renderLines(RULES_LINES)}
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
  return <ReportHelp onDone={onDone} />
}

export default { type: 'local-jsx', name: 'report-help', description: 'Show how to use /report, with sample commands', immediate: true, load: async () => ({ call }) } satisfies Command
