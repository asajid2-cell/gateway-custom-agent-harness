import type { UUID } from 'crypto'
import { onSessionWillSwitch } from '../bootstrap/state.js'
import { join } from 'path'
import { GatewaySessionTransport, listGatewayPeers } from './gatewaySessionTransport.js'
import { GatewaySessionDelivery } from './gatewaySessionDelivery.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { enqueue, removeByFilter } from './messageQueueManager.js'
import type { GatewayPeer, GatewayInboundPolicy } from './gatewaySessionProtocol.js'

const runtimes = new Map<string, GatewaySessionRuntime>()
export function getGatewaySessionRuntime(sessionId: string): GatewaySessionRuntime | undefined { return runtimes.get(sessionId) }

export class GatewaySessionRuntime {
  readonly transport: GatewaySessionTransport
  readonly delivery: GatewaySessionDelivery
  private readonly pendingIds = new Set<string>()
  private unsubscribeSwitch: (() => void) | undefined
  private closing: Promise<void> | undefined
  private ready = false
  constructor(sessionId: string, cwd: string, name: string) {
    this.transport = new GatewaySessionTransport({
      directory: join(getClaudeConfigHomeDir(), 'gateway-sessions'), sessionId, cwd, name,
      onInboxChanged: () => { if (this.ready) this.delivery.drain() },
    })
    this.delivery = new GatewaySessionDelivery(this.transport, (id, text) => {
      this.pendingIds.add(id)
      enqueue({ value: text, mode: 'prompt', priority: 'next', uuid: id as UUID, skipSlashCommands: true, isMeta: true, origin: { kind: 'gateway-peer' } })
    }, id => { this.pendingIds.delete(id) })
  }
  private starting: Promise<void> | undefined
  start(persistedIds: ReadonlySet<string>): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Gateway runtime is closed'))
    if (this.starting) return this.starting
    this.unsubscribeSwitch = onSessionWillSwitch(id => {
      if (id === this.transport.peer.sessionId) void this.close().catch(() => {})
    })
    this.starting = (async () => {
      try {
        await (await import('./gatewaySessionOwnership.js')).claimGatewaySessionWriter(this.transport.peer.sessionId)
        if (this.closing) return
        await this.transport.start()
        if (this.closing) return
        await this.delivery.reconcilePersisted(persistedIds)
        if (this.closing) return
        runtimes.set(this.transport.peer.sessionId, this)
        this.ready = true
        this.delivery.drain()
      } catch (error) {
        this.unsubscribeSwitch?.()
        this.unsubscribeSwitch = undefined
        this.delivery.close()
        await this.transport.close()
        throw error
      }
    })()
    return this.starting
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.unsubscribeSwitch?.()
    this.unsubscribeSwitch = undefined
    if (runtimes.get(this.transport.peer.sessionId) === this) runtimes.delete(this.transport.peer.sessionId)
    this.delivery.close()
    removeByFilter(command => command.uuid !== undefined && this.pendingIds.has(command.uuid))
    this.closing = (this.starting ?? Promise.resolve()).catch(() => {}).then(() => this.transport.close())
    return this.closing
  }
  list(): Promise<GatewayPeer[]> { return listGatewayPeers(join(getClaudeConfigHomeDir(), 'gateway-sessions')) }
  setPolicy(policy: GatewayInboundPolicy): Promise<void> {
    return this.transport.setPolicy(policy, () => {
      const withdrawn = removeByFilter(command => command.uuid !== undefined && this.pendingIds.has(command.uuid))
      const ids = new Set(withdrawn.map(command => command.uuid!))
      return {
        ids,
        rollback: () => { for (const command of withdrawn) enqueue(command) },
        commit: () => { this.delivery.releaseQueued(ids); for (const id of ids) this.pendingIds.delete(id) },
      }
    })
  }
}
