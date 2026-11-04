import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  LocalJSXCommandCall,
  LocalJSXCommandContext,
} from '../../types/command.js'
import { Box, Text } from '../../ink.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Select } from '../../components/CustomSelect/index.js'
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
 * `/login` in gateway mode. The provider key UI already exists per provider;
 * this command makes it reachable the way an operator expects: bare `/login`
 * opens a picker, a named provider goes straight there, and `status`/`remove`
 * work on their own or after a provider name.
 *
 * Saving goes through the same dialog as the per-provider commands, so it
 * reports the backend, repeats any degraded-vault warning, and reloads the
 * gateway keys.
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

function ProviderInline(props: {
  provider: ProviderName
  action: LoginAction
  onDone: (result?: string) => void
  context: LocalJSXCommandContext
}): ReactNode {
  const [node, setNode] = useState<ReactNode>(null)
  useEffect(() => {
    void (async () => {
      const rendered = await dispatch(
        props.onDone,
        props.context,
        actionArgs(props.action),
        PROVIDER_CREDENTIALS[props.provider],
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
      ? 'Add a provider key'
      : props.action === 'status'
        ? 'Check a provider key'
        : 'Remove a provider key'
  return (
    <Dialog title={title} onCancel={() => props.onDone('Login cancelled.')} color="permission">
      <Box flexDirection="column">
        <Text dimColor>Choose the provider whose key you want to manage.</Text>
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
  if (plan.kind === 'provider') {
    return dispatch(
      onDone,
      context,
      actionArgs(plan.action),
      PROVIDER_CREDENTIALS[plan.provider],
    )
  }
  return <ProviderPicker action={plan.action} onDone={onDone} context={context} />
}
