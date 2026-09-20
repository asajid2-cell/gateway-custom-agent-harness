import React from 'react'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { PassThrough } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render, Box, Text, useInput } from '../src/ink.ts'
import instances from '../src/ink/instances.ts'
import { nodeCache } from '../src/ink/node-cache.ts'
import { TaskListV2 } from '../src/components/TaskListV2.tsx'
import { AppStateProvider } from '../src/state/AppState.tsx'
import type { Task } from '../src/utils/tasks.ts'

/**
 * The task panel is a large block of the terminal, and it used to open itself:
 * TaskCreate and TaskUpdate each forced `expandedView` to 'tasks' on every
 * write, so the panel was on screen for the whole session whether or not anyone
 * asked for it. On a short terminal that left a line or two of conversation
 * readable, which is the reported symptom.
 *
 * What has to hold now: collapsed is exactly one line and still says what the
 * panel header says, expanded is the panel, and a click on either toggles. The
 * click is driven through the real pointer path (SGR mouse sequences, App
 * routing, hit testing) rather than by calling the prop, because the missing
 * affordance is the thing being fixed - a test that calls `onToggle()` directly
 * would pass with no clickable region at all.
 */

function task(id: string, status: Task['status']): Task {
  return { id, subject: `Task number ${id}`, description: '', status, blocks: [], blockedBy: [] }
}

const TASKS: Task[] = [
  ...Array.from({ length: 3 }, (_, i) => task(`${i + 1}`, 'completed')),
  ...Array.from({ length: 2 }, (_, i) => task(`${i + 4}`, 'in_progress')),
  task('6', 'pending'),
]

/** Ink encodes a space as a cursor-forward; deleting those sequences turns a
 * rendered line into "Tasknumber6" and a passing assertion into a mystery. */
function plain(output: string): string {
  return output
    .replace(/\x1b\[(\d+)C/g, (_, count: string) => ' '.repeat(Number(count)))
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
}

/**
 * The lines of the last drawn frame, with blank ones dropped.
 *
 * Ink wraps each repaint in a synchronized-update block (`?2026h` … `?2026l`)
 * and follows it with unrelated control writes, so "the last chunk" is not the
 * screen. The last such block is; earlier blocks are history and counting them
 * would report one line as seven.
 */
function lines(output: string): string[] {
  const start = output.lastIndexOf('\u001b[?2026h')
  const frame = start === -1 ? output : output.slice(start)
  return plain(frame).split('\n').map(line => line.trimEnd()).filter(line => line.trim().length > 0)
}

const tick = (ms = 150) => new Promise(resolve => setTimeout(resolve, ms))

async function terminal(content: React.ReactNode, { tty = false } = {}) {
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 40, isTTY: tty })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  function InputOwner() { useInput(() => {}); return null }
  const app = await render(
    <AppStateProvider><InputOwner /><Box width={100}>{content}</Box></AppStateProvider>,
    { stdout: stdout as never, stderr: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false },
  )
  await tick()
  const ink = instances.get(stdout as never) as any
  // The real terminal supplies the origin via CPR. Set only that measurement;
  // all pointer input still traverses parsing, App routing and hit testing.
  const calibrate = () => { ink.inlineOrigin = 0; ink.inlineTracking = true }
  const pointAt = (needle: string) => {
    const node = findNode(ink.rootNode, needle)
    assert.ok(node, `No hit-testable region containing ${JSON.stringify(needle)}`)
    const rect = nodeCache.get(node)!
    return { x: rect.x + 1, y: rect.y + 1 }
  }
  const click = async (needle: string) => {
    const point = pointAt(needle)
    calibrate(); stdin.write(`\x1b[<0;${point.x};${point.y}M`)
    calibrate(); stdin.write(`\x1b[<0;${point.x};${point.y}m`)
    await tick()
  }
  return {
    app, stdin, click, pointAt,
    text: () => plain(output),
    lines: () => lines(output),
    close: () => { app.unmount(); stdin.destroy(); stdout.destroy() },
  }
}

function textOf(node: any): string {
  return node.nodeName === '#text' ? node.nodeValue : (node.childNodes ?? []).map(textOf).join('')
}

/** The innermost laid-out node whose text contains `needle`. */
function findNode(node: any, needle: string): any {
  for (const child of node.childNodes ?? []) {
    if (child.nodeName === '#text') continue
    const found = findNode(child, needle)
    if (found) return found
  }
  return textOf(node).includes(needle) && nodeCache.has(node) ? node : undefined
}

function withTasks<T>(body: () => Promise<T>): Promise<T> {
  const previous = process.env.CLAUDE_CODE_ENABLE_TASKS
  process.env.CLAUDE_CODE_ENABLE_TASKS = '1'
  return body().finally(() => {
    if (previous === undefined) delete process.env.CLAUDE_CODE_ENABLE_TASKS
    else process.env.CLAUDE_CODE_ENABLE_TASKS = previous
  })
}

test('the collapsed task panel is one line that still carries the counts', async () => {
  await withTasks(async () => {
    const t = await terminal(<TaskListV2 tasks={TASKS} isStandalone={true} collapsed={true} onToggle={() => {}} />)
    try {
      const drawn = t.lines()
      assert.equal(drawn.length, 1, `collapsed must be exactly one line, got:\n${drawn.join('\n')}`)
      assert.match(drawn[0]!, /6 tasks \(3 done, 2 in progress, 1 open\)/)
      assert.match(drawn[0]!, /ctrl\+t/, 'the shortcut is discoverable without opening the panel')
      assert.ok(!drawn[0]!.includes('Task number 6'), 'the task rows are not drawn while collapsed')
    } finally {
      t.close()
    }
  })
})

test('the expanded panel still lists its tasks, and the panel header is a toggle', async () => {
  await withTasks(async () => {
    let toggles = 0
    const t = await terminal(<TaskListV2 tasks={TASKS} isStandalone={true} onToggle={() => { toggles++ }} />)
    try {
      const drawn = t.lines()
      assert.ok(drawn.length > 2, 'expanded draws the rows, not a single line')
      assert.ok(drawn.some(line => line.includes('Task number 6')), 'the task rows are drawn')
      assert.ok(drawn[0]!.includes('6 tasks (3 done, 2 in progress, 1 open)'), 'the header is the counts line')
      await t.click('6 tasks (')
      assert.equal(toggles, 1, 'clicking the header toggles the panel')
    } finally {
      t.close()
    }
  })
})

test('a click on the collapsed line opens the panel', async () => {
  await withTasks(async () => {
    let open = false
    function Host() {
      const [collapsed, setCollapsed] = React.useState(true)
      open = !collapsed
      return <TaskListV2 tasks={TASKS} isStandalone={true} collapsed={collapsed} onToggle={() => setCollapsed(current => !current)} />
    }
    const t = await terminal(<Host />)
    try {
      assert.equal(t.lines().length, 1, 'starts collapsed')
      await t.click('6 tasks (')
      assert.equal(open, true, 'the click opened it')
      assert.ok(t.lines().some(line => line.includes('Task number 6')), 'the rows are on screen after the click')
      await t.click('6 tasks (')
      assert.equal(open, false, 'and the same click closes it again')
      assert.equal(t.lines().length, 1)
    } finally {
      t.close()
    }
  })
})

test('the click target is the panel itself, not a stray region', async () => {
  await withTasks(async () => {
    const t = await terminal(<Box flexDirection="column">
      <Text>UNRELATED CONTENT ABOVE</Text>
      <TaskListV2 tasks={TASKS} isStandalone={true} collapsed={true} onToggle={() => {}} />
    </Box>)
    try {
      const point = t.pointAt('6 tasks (')
      assert.ok(point.y > 1, 'the counts line is below the unrelated content, not at the top of the screen')
    } finally {
      t.close()
    }
  })
})

/**
 * The panel used to open itself from the tools: every TaskCreate and TaskUpdate
 * write forced `expandedView` to 'tasks'. That is what made it a permanent half
 * of the screen rather than something you open. A task write must now leave the
 * view alone.
 */
test('writing a task does not open the panel by itself', async () => {
  await withTasks(async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'task-panel-'))
    const previousConfig = process.env.CLAUDE_CONFIG_DIR
    const previousList = process.env.CLAUDE_CODE_TASK_LIST_ID
    process.env.CLAUDE_CONFIG_DIR = configDir
    process.env.CLAUDE_CODE_TASK_LIST_ID = 'task-panel-collapse'
    try {
      const writes: Array<{ expandedView?: string }> = []
      const state = { expandedView: 'none' as const }
      const context = {
        setAppState: (update: (previous: typeof state) => typeof state) => { writes.push(update(state)) },
        getAppState: () => state,
        abortController: new AbortController(),
      } as never

      const { TaskCreateTool } = await import('../src/tools/TaskCreateTool/TaskCreateTool.ts')
      const { TaskUpdateTool } = await import('../src/tools/TaskUpdateTool/TaskUpdateTool.ts')
      const created = await TaskCreateTool.call({ subject: 'A task', description: 'd' }, context)
      assert.equal(writes.length, 0, 'creating a task must not touch the expanded view')
      await TaskUpdateTool.call({ taskId: created.data.task.id, status: 'in_progress' }, context)
      assert.equal(writes.length, 0, 'updating a task must not touch the expanded view either')
    } finally {
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfig
      if (previousList === undefined) delete process.env.CLAUDE_CODE_TASK_LIST_ID
      else process.env.CLAUDE_CODE_TASK_LIST_ID = previousList
      await rm(configDir, { recursive: true, force: true })
    }
  })
})
