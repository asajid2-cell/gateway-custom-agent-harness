import { useEffect, useRef } from 'react'
import { getSessionId } from '../bootstrap/state.js'
import { getCwd } from '../utils/cwd.js'
import { GatewaySessionRuntime } from '../utils/gatewaySessionRuntime.js'
import { gatewayMessageIds } from '../utils/gatewaySessionDelivery.js'
import { deriveSessionPurpose } from '../utils/gatewaySessionProtocol.js'
import type { Message } from '../types/message.js'
import { logForDebugging } from '../utils/debug.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'

/**
 * A leaf announces itself on the shared bus instead of looking like a stray
 * sibling session. The label wins outright rather than falling back to the
 * transcript: a forked leaf carries its parent's history, so deriving from
 * messages would advertise the parent's opening prompt and make the leaf
 * indistinguishable from the session it was forked from.
 */
function sessionPurposeSeed(messages: Message[] | undefined, name: string): string {
  const label = process.env.GATEWAY_LEAF_LABEL
  if (label) return label.replace(/\s+/g, ' ').trim().slice(0, 1000)
  return deriveSessionPurpose(messages, name)
}

export function useGatewaySession(name: string, status: 'idle' | 'busy' | 'waiting', sessionMessages: Message[] | undefined): void {
  const sessionId = getSessionId()
  const latest = useRef({ name, status })
  latest.current = { name, status }
  const runtimeRef = useRef<GatewaySessionRuntime | undefined>(undefined)
  const closing = useRef<Promise<void>>(Promise.resolve())
  useEffect(() => {
    if (process.env.CLAUDE_CODE_USE_GATEWAY !== '1') return
    const runtime = new GatewaySessionRuntime(sessionId, getCwd(), name)
    let disposed = false
    const started = closing.current.then(async () => {
      if (disposed) return
      await runtime.start(gatewayMessageIds(sessionMessages ?? []))
      if (disposed || getSessionId() !== sessionId) return
      runtimeRef.current = runtime
      // Seed intent only while it is unstated. An explicit declaration outranks
      // the derived one, and a later name/status refresh must never clobber it.
      const purpose = runtime.transport.peer.purpose.trim() ? runtime.transport.peer.purpose : sessionPurposeSeed(sessionMessages, name)
      await runtime.transport.update({ name: latest.current.name, status: latest.current.status === 'busy' ? 'running' : latest.current.status === 'waiting' ? 'awaiting-approval' : 'idle', purpose })
    }).catch(() => { logForDebugging('Gateway session communication could not start.') })
    const close = async () => {
      disposed = true
      runtime.delivery.close()
      await started
      if (runtimeRef.current === runtime) runtimeRef.current = undefined
      await runtime.close().catch(() => { logForDebugging('Gateway session communication cleanup failed.') })
    }
    const unregister = registerCleanup(close)
    return () => {
      unregister()
      closing.current = close()
    }
  }, [sessionId])
  useEffect(() => {
    void runtimeRef.current?.transport.update({ name, status: status === 'busy' ? 'running' : status === 'waiting' ? 'awaiting-approval' : 'idle' }).catch(() => { logForDebugging('Gateway session status update failed.') })
  }, [name, status])
}
