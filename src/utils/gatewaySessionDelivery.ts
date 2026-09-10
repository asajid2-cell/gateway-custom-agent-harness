import { formatGatewayPeerMessage } from './gatewaySessionProtocol.js'
import type { GatewaySessionTransport } from './gatewaySessionTransport.js'

export function gatewayMessageIds(messages: readonly { uuid?: string; type: string; attachment?: { type: string; source_uuid?: string } }[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    if (message.type === 'user' && message.uuid) ids.add(message.uuid)
    if (message.type === 'attachment' && message.attachment?.type === 'queued_command' && message.attachment.source_uuid) ids.add(message.attachment.source_uuid)
  }
  return ids
}

/** One adapter per session runtime; queue acceptance is not a delivery receipt. */
export class GatewaySessionDelivery {
  private readonly queued = new Set<string>()
  private readonly persisted = new Set<string>()
  private closed = false

  constructor(
    private readonly transport: Pick<GatewaySessionTransport, 'inbox' | 'acknowledge'>,
    private readonly enqueue: (id: string, text: string) => void,
    private readonly onPersisted: (id: string) => void = () => {},
  ) {}

  drain(): void {
    if (this.closed) return
    for (const record of this.transport.inbox()) {
      if (record.state !== 'queued' || this.queued.has(record.message.id) || this.persisted.has(record.message.id)) continue
      this.queued.add(record.message.id)
      try { this.enqueue(record.message.id, formatGatewayPeerMessage(record)) }
      catch (error) { this.queued.delete(record.message.id); throw error }
    }
  }

  async reconcilePersisted(ids: ReadonlySet<string>): Promise<void> {
    if (this.closed) return
    for (const record of this.transport.inbox()) {
      if (record.state === 'queued' && (ids.has(record.message.id) || this.persisted.has(record.message.id))) {
        this.persisted.add(record.message.id)
        try {
          await this.transport.acknowledge(record.message.id)
          this.queued.delete(record.message.id)
          this.persisted.delete(record.message.id)
          this.onPersisted(record.message.id)
        } catch {
          // Transcript persistence is authoritative. A receipt write can be
          // retried by a later drain/restart without delaying the model result.
        }
      }
    }
  }

  releaseQueued(ids: ReadonlySet<string>): void {
    for (const id of ids) this.queued.delete(id)
  }

  close(): void { this.closed = true; this.queued.clear(); this.persisted.clear() }
}
