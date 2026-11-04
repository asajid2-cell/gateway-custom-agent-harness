import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  LocalJSXCommandCall,
  LocalJSXCommandContext,
} from '../../types/command.js'
import { Box, Text } from '../../ink.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Select } from '../../components/CustomSelect/index.js'
import { call as anthropicLogin } from '../login/anthropic.js'
import {
  ChatGptLogin,
  anthropicCredentialsPath,
  anthropicState,
  codexHome,
} from '../login/login.js'
import { performLogout } from '../logout/logout.js'
import { call as providerLogin } from './login.js'
import {
  PICKER_LABELS,
  PROVIDERS,
  PROVIDER_CREDENTIALS,
  planLogin,
  type LoginAction,
  type ProviderName,
} from './unified-plan.js'

/**
 * `/login` in gateway mode. Every credential the gateway can consume is
 * reachable here, not just the vault keys: Claude Code signs in through
 * Anthropic OAuth, Codex through its own ChatGPT login, and the provider keys
 * through the per-provider key UI. A bare `/login` opens a picker, a named
 * provider goes straight there, and `status`/`remove` work on their own or
 * after a provider name.
 *
 * Key saves go through the same dialog as the per-provider commands, so they
 * report the backend, repeat any degraded-vault warning, and reload the gateway
 * keys. The two host sign-ins write the credential files the gateway already
 * reads, so they need no reload.
 */

// The provider command's exported type is the generic three-argument form; the
// fourth argument is the bound credential name.
const dispatch = providerLogin as unknown as (
  onDone: (result?: string) => void,
  context: LocalJSXCommandContext,
  args: string,
  boundKeyName?: string,
) => Promise<ReactNode>

function actionArgs(action: LoginAction): string {
  return action === 'save' ? '' : action
}

/** Signing out of Codex is removing the auth file its login writes. */
async function signOutCodex(): Promise<{ ok: boolean; file: string; reason?: string }> {
  const file = join(await codexHome(), 'auth.json')
  try {
    await rm(file)
    return { ok: true, file }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, file }
    return { ok: false, file, reason: (error as Error).message }
  }
}

async function renderProvider(
  provider: ProviderName,
  action: LoginAction,
  onDone: (result?: string) => void,
  context: LocalJSXCommandContext,
): Promise<ReactNode> {
  if (provider === 'claude') {
    if (action === 'save') return anthropicLogin(onDone, context)
    if (action === 'status') {
      const state = await anthropicState()
      onDone(
        state.present
          ? `Claude Code is signed in (${state.source}${state.oauth ? ', oauth' : ''}). The gateway reads ${anthropicCredentialsPath()}.`
          : 'Claude Code is not signed in. Run /login claude to sign in, or set ANTHROPIC_API_KEY for the gateway.',
      )
      return null
    }
    await performLogout({})
    // Logging out clears the file the gateway reads; an env key is a separate
    // credential and would keep working, so say so rather than implying more.
    const envNote = process.env.ANTHROPIC_API_KEY?.trim()
      ? ' ANTHROPIC_API_KEY is still set in this environment and takes precedence.'
      : ''
    onDone(
      `Claude Code signed out: credentials cleared and the gateway reads the same file, so no restart is needed.${envNote}`,
    )
    return null
  }

  if (provider === 'codex') {
    if (action === 'remove') {
      const result = await signOutCodex()
      onDone(
        result.ok
          ? `Codex signed out: removed ${result.file}. Run /login codex to sign in again.`
          : `Could not remove ${result.file}: ${result.reason}`,
      )
      return null
    }
    // Codex owns its device-auth login; this reports the state and, when it is
    // missing, the exact command pinned to the home the gateway reads.
    return <ChatGptLogin onDone={onDone} />
  }

  return dispatch(onDone, context, actionArgs(action), PROVIDER_CREDENTIALS[provider])
}

function ProviderInline(props: {
  provider: ProviderName
  action: LoginAction
  onDone: (result?: string) => void
  context: LocalJSXCommandContext
}): ReactNode {
  const [node, setNode] = useState<ReactNode>(null)
  useEffect(() => {
    void (async () => {
      const rendered = await renderProvider(
        props.provider,
        props.action,
        props.onDone,
        props.context,
      )
      setNode(rendered)
    })()
    // The picker decides the provider once; re-rendering must not re-dispatch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return node
}

function ProviderPicker(props: {
  action: 'save' | 'status' | 'remove'
  onDone: (result?: string) => void
  context: LocalJSXCommandContext
}): ReactNode {
  const [chosen, setChosen] = useState<ProviderName | null>(null)
  if (chosen) {
    return (
      <ProviderInline
        provider={chosen}
        action={props.action}
        onDone={props.onDone}
        context={props.context}
      />
    )
  }
  const title =
    props.action === 'save'
      ? 'Add or sign in to a provider'
      : props.action === 'status'
        ? 'Check a provider credential'
        : 'Remove a provider credential'
  return (
    <Dialog title={title} onCancel={() => props.onDone('Login cancelled.')} color="permission">
      <Box flexDirection="column">
        <Text dimColor>Choose the provider whose credential you want to manage.</Text>
        <Select
          options={PROVIDERS.map(provider => ({
            label: PICKER_LABELS[provider],
            value: provider,
          }))}
          onChange={(value: string) => setChosen(value as ProviderName)}
          onCancel={() => props.onDone('Login cancelled.')}
        />
      </Box>
    </Dialog>
  )
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const plan = planLogin(args)
  if (plan.kind === 'error') {
    onDone(plan.message)
    return null
  }
  if (plan.kind === 'pick') {
    return <ProviderPicker action={plan.action} onDone={onDone} context={context} />
  }
  return renderProvider(plan.provider, plan.action, onDone, context)
}
