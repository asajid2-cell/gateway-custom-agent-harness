import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { hasPermissionsToUseTool } from '../src/utils/permissions/permissions.ts'
import { getNextPermissionMode } from '../src/utils/permissions/getNextPermissionMode.ts'
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
