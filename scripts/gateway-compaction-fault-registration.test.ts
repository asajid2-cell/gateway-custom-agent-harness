import { test, expect, mock } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// A metrics feature must not be able to take a session off the bus.
//
// `GatewaySessionRuntime.start()` reads the compaction-metrics checkpoint
// before it publishes the session. That read used to be unguarded inside the
// try block whose catch tears down the transport and rethrows - so an IO fault
// on the checkpoint made start() reject and REGISTRATION ABORTED. The counts
// are decoration on the peer record, not a registration precondition, so the
// read and its setCompactionCounts now degrade to "no counts" and the rest of
// start() stays strict.
//
// Red-first: with the read throwing, registration still reaches 'live' and the
// session is published on the bus; and the healthy path still lands the counts
// on the peer record.

const countsModule = await import('../src/utils/sessionCompactionCounts.ts')
const realLoad = countsModule.loadSessionCompactionCounts

// Module mocks are process-global and cannot be unregistered, so the injected
// fault is gated on a flag that is true only while this file's own runtime is
// starting. Installing it unconditionally would break every other suite that
// runs the real start() through this same import.
let injectLoadFailure = false
mock.module('../src/utils/sessionCompactionCounts.ts', () => ({
  ...countsModule,
  loadSessionCompactionCounts: async (...args: Parameters<typeof realLoad>) => {
    if (injectLoadFailure) throw new Error('ENOTDIR: checkpoint read failed')
    return realLoad(...args)
  },
}))

const { GatewaySessionRuntime, gatewaySessionCommsState } = await import(
  '../src/utils/gatewaySessionRuntime.ts'
)
const { releaseGatewaySessionWriter } = await import('../src/utils/gatewaySessionOwnership.ts')
type GatewaySessionRuntimeInstance = InstanceType<typeof GatewaySessionRuntime>

async function withConfigHome<T>(fn: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-compaction-fault-'))
  const previousDirectory = process.env.CLAUDE_CONFIG_DIR
  const previousGateway = process.env.CLAUDE_CODE_USE_GATEWAY
  // The checkpoint module honors the same persistence gates as the transcript
  // writer, and under `bun test` NODE_ENV is 'test' — so the durable read is
  // opt-in here, exactly as the counts suite does it. Without this the healthy
  // path legitimately returns undefined and there is nothing to land.
  const previousPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
  process.env.CLAUDE_CONFIG_DIR = directory
  process.env.CLAUDE_CODE_USE_GATEWAY = '1'
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  try {
    return await fn(directory)
  } finally {
    if (previousDirectory === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousDirectory
    if (previousGateway === undefined) delete process.env.CLAUDE_CODE_USE_GATEWAY
    else process.env.CLAUDE_CODE_USE_GATEWAY = previousGateway
    if (previousPersistence === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    else process.env.TEST_ENABLE_SESSION_PERSISTENCE = previousPersistence
    await rm(directory, { recursive: true, force: true })
  }
}

test('a throwing compaction checkpoint read does not abort registration', async () => {
  await withConfigHome(async directory => {
    const sessionId = randomUUID()
    let runtime: GatewaySessionRuntimeInstance | undefined
    try {
      runtime = new GatewaySessionRuntime(sessionId, directory, 'Metrics fault')
      injectLoadFailure = true
      // The read throws; start() must still resolve and register.
      await runtime.start(new Set())
      injectLoadFailure = false
      expect(gatewaySessionCommsState(sessionId).state).toBe('live')
      expect((await runtime.list()).some(peer => peer.sessionId === sessionId)).toBe(true)
      // Degraded, not absent: the peer record carries no counts.
      const peer = (await runtime.list()).find(peer => peer.sessionId === sessionId)
      expect(peer?.compactBoundaryCount).toBeUndefined()
      expect(peer?.microcompactBoundaryCount).toBeUndefined()
    } finally {
      injectLoadFailure = false
      await runtime?.close()
      await releaseGatewaySessionWriter(sessionId).catch(() => {})
    }
  })
})

test('the healthy path still lands the compaction counts on the peer record', async () => {
  await withConfigHome(async directory => {
    const sessionId = randomUUID()
    let runtime: GatewaySessionRuntimeInstance | undefined
    try {
      runtime = new GatewaySessionRuntime(sessionId, directory, 'Metrics healthy')
      await runtime.start(new Set())
      expect(gatewaySessionCommsState(sessionId).state).toBe('live')
      const peer = (await runtime.list()).find(peer => peer.sessionId === sessionId)
      // A fresh session with no boundaries reads as zero, not as absent.
      expect(peer?.compactBoundaryCount).toBe(0)
      expect(peer?.microcompactBoundaryCount).toBe(0)
    } finally {
      await runtime?.close()
      await releaseGatewaySessionWriter(sessionId).catch(() => {})
    }
  })
})
