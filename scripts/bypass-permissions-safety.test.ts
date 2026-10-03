import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { hasPermissionsToUseTool } from '../src/utils/permissions/permissions.ts'
import { getNextPermissionMode } from '../src/utils/permissions/getNextPermissionMode.ts'
import { leafLaunchArgs } from '../src/utils/leafWorkspace.ts'
import { setSessionBypassPermissionsMode } from '../src/bootstrap/state.ts'
import type { ToolUseContext } from '../src/Tool.ts'

/**
 * A tool whose own checkPermissions returns a safetyCheck 'ask' — exactly what
 * checkPathSafetyForAutoEdit produces for .claude/settings.json, memory files
 * under .claude/, .git/, and the other DANGEROUS_DIRECTORIES. Step 1g normally
 * returns that ask before step 2a can allow it; explicit bypassPermissions mode
 * must fall through to step 2a so nothing prompts.
 */
function safetyCheckTool() {
  return {
    name: 'Edit',
    inputSchema: { parse: (value: unknown) => value },
    checkPermissions: async () => ({
      behavior: 'ask' as const,
      message:
        "Claude requested permissions to write to .claude/settings.json, but you haven't granted it yet.",
      decisionReason: {
        type: 'safetyCheck' as const,
        reason: 'sensitive file',
        classifierApprovable: true,
      },
    }),
  }
}

function contextFor(mode: string): ToolUseContext {
  const appState = {
    toolPermissionContext: {
      mode,
      isBypassPermissionsModeAvailable: mode === 'bypassPermissions',
      alwaysAllowRules: {},
      alwaysDenyRules: {},
      alwaysAskRules: {},
      additionalWorkingDirectories: new Map(),
      shouldAvoidPermissionPrompts: false,
    },
    denialTracking: undefined,
  }
  return {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
  } as unknown as ToolUseContext
}

test('bypassPermissions allows a safetyCheck ask that would otherwise prompt', async () => {
  const decision = await hasPermissionsToUseTool(
    safetyCheckTool() as never,
    {},
    contextFor('bypassPermissions'),
    {} as never,
    'tool-use-bypass',
  )
  assert.equal(decision.behavior, 'allow')
})

test('default mode still prompts on the same safetyCheck', async () => {
  const decision = await hasPermissionsToUseTool(
    safetyCheckTool() as never,
    {},
    contextFor('default'),
    {} as never,
    'tool-use-default',
  )
  assert.equal(decision.behavior, 'ask')
})

test('bypass appears in the Shift+Tab cycle only when the mode is available', () => {
  // isBypassPermissionsModeAvailable is set from the launch flags; the launcher
  // passes --allow-dangerously-skip-permissions, so this is the state a cc
  // session runs in. 'plan' is used because 'default' short-circuits to
  // bypassPermissions only for ant builds.
  const available = { mode: 'plan', isBypassPermissionsModeAvailable: true }
  const unavailable = { mode: 'plan', isBypassPermissionsModeAvailable: false }
  assert.equal(getNextPermissionMode(available as never), 'bypassPermissions')
  assert.equal(getNextPermissionMode(unavailable as never), 'default')
})

test('a leaf is launched offering bypass as an option when the parent is not in bypass', () => {
  // The leaf is a separate process: it only offers bypass if its own argv says
  // so. Without this the option is missing in every leaf while the parent that
  // spawned it has it. The flag is the "as an option, not by default" one, so
  // the leaf still starts at the default and the user opts in via the cycle.
  setSessionBypassPermissionsMode(false)
  try {
    const args = leafLaunchArgs({ sessionId: '11111111-1111-4111-8111-111111111111' }, true)
    assert.ok(args.includes('--allow-dangerously-skip-permissions'), 'leaf offers bypass as an option')
    assert.ok(!args.includes('--dangerously-skip-permissions'), 'leaf does not start in bypass')
    assert.deepEqual(args.slice(1, 3), ['--resume', '11111111-1111-4111-8111-111111111111'])
  } finally {
    setSessionBypassPermissionsMode(false)
  }
})

test('a leaf starts in bypass when the parent is in bypass', () => {
  setSessionBypassPermissionsMode(true)
  try {
    const args = leafLaunchArgs({ sessionId: '11111111-1111-4111-8111-111111111111' }, false)
    assert.ok(args.includes('--dangerously-skip-permissions'), 'leaf inherits the parent bypass mode')
    assert.ok(!args.includes('--allow-dangerously-skip-permissions'), 'no redundant option flag')
    assert.deepEqual(args.slice(1, 3), ['--session-id', '11111111-1111-4111-8111-111111111111'])
  } finally {
    setSessionBypassPermissionsMode(false)
  }
})
