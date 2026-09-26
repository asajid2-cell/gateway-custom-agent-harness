import { addFunctionHook, removeFunctionHook } from './hooks/sessionHooks.js'
import { GatewayPeerInjection, queuedGatewayPeerIds } from './gatewayPeerInjection.js'
import type { GatewaySessionRuntime } from './gatewaySessionRuntime.js'
import type { SetAppState } from './messageQueueManager.js'

/**
 * The peer-request Stop hook, registered once per session.
 *
 * A peer request has to be delivered at a turn boundary, and the only channel
 * from a Stop hook to the model is a blocking error - a hook that allows the
 * stop has no way to say anything. So the callback blocks exactly when a peer
 * request is owed and allows the stop otherwise, which keeps the cost to the
 * turns that actually carry peer traffic instead of every turn end.
 *
 * The hook claims the requests still sitting in the command queue. The queue is
 * drained mid-turn, so a request that is still in it when a turn ends is one
 * that arrived after the last tool iteration: the drain had no further boundary
 * to run at, and this turn boundary is the earliest it could be answered. Once
 * the hook has injected a request it takes it out of the queue, so a request
 * that has LEFT the queue was consumed as a turn's input and is left alone
 * rather than asked a second time.
 *
 * The queue path is therefore still live and still necessary. A session sitting
 * idle has no turn to end, so no Stop hook can fire for it, and that is exactly
 * the case the queue exists to cover.
 */

/** Long enough to cover an inbox acknowledgement write, which the callback awaits. */
const PEER_INJECTION_TIMEOUT_MS = 30_000

/**
 * Spinner label. The hook is registered whether or not a request is in flight,
 * so without a label a turn ending normally would advertise anonymous hook
 * machinery for the fraction of a second the inbox read takes.
 */
const PEER_INJECTION_STATUS = 'peer request'

export type PeerStopHookHandle = {
  injection: GatewayPeerInjection
  remove: () => void
}

export function registerGatewayPeerStopHook(
  setAppState: SetAppState,
  runtime: Pick<GatewaySessionRuntime, 'transport'>,
): PeerStopHookHandle {
  // Scoped to the owning session, so the id cannot collide with a hook another
  // session registered for the same event.
  const hookId = `gateway-peer-inject-${runtime.transport.peer.sessionId}`
  const injection = new GatewayPeerInjection(runtime.transport)

  addFunctionHook(
    setAppState,
    runtime.transport.peer.sessionId,
    'Stop',
    '', // No matcher - applies to every turn end for this session.
    async () => {
      // Returns true (stop allowed) when nothing is owed, which is the common
      // case: every turn end pays an inbox read and nothing more.
      return (await injection.next(queuedGatewayPeerIds())) === undefined
    },
    () => injection.injectionText() || 'A peer request is waiting.',
    { id: hookId, timeout: PEER_INJECTION_TIMEOUT_MS, statusMessage: PEER_INJECTION_STATUS },
  )

  return {
    injection,
    // Removal must precede the transport close in session teardown, or a turn
    // ending during shutdown fires a callback against a closed inbox.
    remove: () => {
      injection.close()
      removeFunctionHook(setAppState, runtime.transport.peer.sessionId, 'Stop', hookId)
    },
  }
}
