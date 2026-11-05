import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  LocalJSXCommandCall,
  LocalJSXCommandContext,
} from '../../types/command.js'
import { Box, Text } from '../../ink.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Select } from '../../components/CustomSelect/index.js'
import { call as anthropicLogin } from '../login/anthropic.js'
import { call as providerLogin } from './login.js'
import { CodexDeviceLogin } from './codex-login.js'
import {
  codexAccounts,
  codexHomeFor,
  codexStatusMessage,
  nextCodexAccountName,
  removeCodexAccount,
  selectCodexAccount,
} from './codex-accounts.js'
import {
  anthropicAccounts,
  anthropicStatusMessage,
  registerCurrentClaudeLogin,
  removeClaudeAccount,
  selectAnthropicAccount,
} from './anthropic-accounts.js'
import {
  PICKER_LABELS,
  PROVIDERS,
  PROVIDER_CREDENTIALS,
  planLogin,
  type LoginPlan,
  type ProviderName,
} from './unified-plan.js'

/**
 * `/login` in gateway mode. Every credential the gateway can consume is
 * reachable here, not just the vault keys:
 *
 *   Claude Code  Anthropic OAuth; the gateway reads the file it writes.
 *   Codex        one ChatGPT device login per account home, switchable and
 *                rotated by the gateway on a credential failure.
 *   keys         the per-provider key UI (backend report, vault save, reload).
 *
 * A bare `/login` opens a picker; a named provider goes straight there;
 * `status`, `switch`, and `remove` work on their own or after a provider name.
 */

type ProviderPlan = Extract<LoginPlan, { kind: 'provider' }>

// The provider command's exported type is the generic three-argument form; the
// fourth argument is the bound credential name.
const dispatch = providerLogin as unknown as (
  onDone: (result?: string) => void,
  context: LocalJSXCommandContext,
  args: string,
  boundKeyName?: string,
) => Promise<ReactNode>

async function renderCodex(
  plan: ProviderPlan,
  onDone: (result?: string) => void,
): Promise<ReactNode> {
  if (plan.action === 'status') {
    onDone(await codexStatusMessage())
    return null
  }
  if (plan.action === 'switch') {
    if (!plan.target) {
      onDone('Name the Codex account to switch to: /login codex switch <number|name> [session|global].')
      return null
    }
    onDone((await selectCodexAccount(plan.target, plan.scope ?? 'session')).message)
    return null
  }
  if (plan.action === 'remove') {
    if (!plan.target) {
      onDone('Name the Codex account to remove: /login codex remove <number|name>.')
      return null
    }
    onDone((await removeCodexAccount(plan.target)).message)
    return null
  }
  // save or new: one device-auth flow into a home of its own.
  const name = plan.target ?? (await nextCodexAccountName())
  const existing = (await codexAccounts()).find(
    (account: { name: string }) => account.name === name,
  )
  if (existing) {
    onDone(
      `Codex account ${name} is already signed in (account ${existing.number}). ` +
        'Use /login codex new [other-name] to add another, or /login codex switch to select it.',
    )
    return null
  }
  return <CodexDeviceLogin name={name} home={codexHomeFor(name)} onDone={onDone} />
}

async function renderProvider(
  plan: ProviderPlan,
  onDone: (result?: string) => void,
  context: LocalJSXCommandContext,
): Promise<ReactNode> {
  if (plan.provider === 'claude') {
    if (plan.action === 'status') {
      onDone(await anthropicStatusMessage())
      return null
    }
    if (plan.action === 'switch') {
      if (!plan.target) {
        onDone('Name the Claude account to switch to: /login claude switch <number|name|email> [session|global].')
        return null
      }
      onDone((await selectAnthropicAccount(plan.target, plan.scope ?? 'session')).message)
      return null
    }
    if (plan.action === 'remove') {
      if (!plan.target) {
        onDone('Name the Claude account to remove: /login claude remove <number|name|email>.')
        return null
      }
      onDone((await removeClaudeAccount(plan.target)).message)
      return null
    }
    // save or new: sign in, then store the credential as its own account.
    if (plan.target) {
      const existing = (await anthropicAccounts()).find(
        (account: { name: string }) => account.name === plan.target,
      )
      if (existing) {
        onDone(
          `Claude account ${plan.target} is already stored (${existing.email ?? existing.name}). ` +
            'Use /login claude switch to select it, or pick another name.',
        )
        return null
      }
    }
    return anthropicLogin(async result => {
      if (result !== 'Login successful') {
        onDone(result)
        return
      }
      const registered = await registerCurrentClaudeLogin(plan.target)
      if (!registered.ok) {
        onDone(`Claude Code signed in, but the account was not stored: ${registered.reason}.`)
        return
      }
      const account = registered.account
      onDone(
        `Claude account ${account.number} (${account.email ?? account.name}) stored. ` +
          `Use /login claude switch ${account.number} [session|global] to select it.`,
      )
    }, context)
  }

  if (plan.provider === 'codex') return renderCodex(plan, onDone)

  return dispatch(onDone, context, plan.args, PROVIDER_CREDENTIALS[plan.provider])
}

function ProviderInline(props: {
  plan: ProviderPlan
  onDone: (result?: string) => void
  context: LocalJSXCommandContext
}): ReactNode {
  const [node, setNode] = useState<ReactNode>(null)
  useEffect(() => {
    void (async () => {
      const rendered = await renderProvider(props.plan, props.onDone, props.context)
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
        plan={{ kind: 'provider', provider: chosen, action: props.action, args: props.action === 'save' ? '' : props.action }}
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
  return renderProvider(plan, onDone, context)
}
