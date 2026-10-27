import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GatewaySessionTransport } from '../src/utils/gatewaySessionTransport.ts'
import { isolateAmbientGatewayRoute } from './gateway-test-env.ts'

isolateAmbientGatewayRoute()

const route = {
  provider: 'chatgpt-web',
  number: 1,
  baseUrl: 'http://127.0.0.1:1',
  model: 'gpt-page-model',
  effort: 'high',
}

async function published(directory: string, sessionId: string): Promise<any> {
  return JSON.parse(await readFile(join(directory, `${sessionId}.json`), 'utf8'))
}

async function withDirectory(fn: (directory: string, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'gateway-peer-host-'))
  try {
    await fn(join(root, 'gateway-sessions'), root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('a peer host publishes its explicit route', async () => {
  await withDirectory(async (directory, root) => {
    const host = new GatewaySessionTransport({ directory, sessionId: randomUUID(), name: 'ChatGPT page', cwd: root, route })
    try {
      await host.start()
      assert.deepEqual((await published(directory, host.peer.sessionId)).peer.route, route)
    } finally {
      await host.close()
    }
  })
})

test('a peer host update does not clobber its explicit route', async () => {
  await withDirectory(async (directory, root) => {
    const before = {
      baseUrl: process.env.CLAUDE_CODE_GATEWAY_BASE_URL,
      model: process.env.MODEL_GATEWAY_MODEL,
    }
    const host = new GatewaySessionTransport({ directory, sessionId: randomUUID(), name: 'ChatGPT page', cwd: root, route })
    try {
      await host.start()
      process.env.CLAUDE_CODE_GATEWAY_BASE_URL = 'http://127.0.0.1:9'
      process.env.MODEL_GATEWAY_MODEL = 'gateway-gpt-luna'
      await host.update({ status: 'running' })
      assert.deepEqual((await published(directory, host.peer.sessionId)).peer.route, route)
    } finally {
      if (before.baseUrl === undefined) delete process.env.CLAUDE_CODE_GATEWAY_BASE_URL
      else process.env.CLAUDE_CODE_GATEWAY_BASE_URL = before.baseUrl
      if (before.model === undefined) delete process.env.MODEL_GATEWAY_MODEL
      else process.env.MODEL_GATEWAY_MODEL = before.model
      await host.close()
    }
  })
})

test('a peer host can re-advertise its changed route', async () => {
  await withDirectory(async (directory, root) => {
    const host = new GatewaySessionTransport({ directory, sessionId: randomUUID(), name: 'ChatGPT page', cwd: root, route })
    const changed = { ...route, model: 'gpt-page-model-next' }
    try {
      await host.start()
      await host.update({ route: changed })
      assert.deepEqual((await published(directory, host.peer.sessionId)).peer.route, changed)
    } finally {
      await host.close()
    }
  })
})

test('a peer host rejects an explicit route with a non-positive number', async () => {
  await withDirectory(async (directory, root) => {
    const host = new GatewaySessionTransport({ directory, sessionId: randomUUID(), name: 'Zero route', cwd: root, route: { ...route, number: 0 } })
    try {
      await assert.rejects(host.start())
    } finally {
      await host.close()
    }
  })
})

test('a peer host rejects an explicit route missing its base URL', async () => {
  await withDirectory(async (directory, root) => {
    const host = new GatewaySessionTransport({ directory, sessionId: randomUUID(), name: 'Missing URL route', cwd: root, route: { provider: route.provider, number: route.number } as any })
    try {
      await assert.rejects(host.start())
    } finally {
      await host.close()
    }
  })
})

test('a peer host participates in the sender lifecycle and deregisters on close', async () => {
  await withDirectory(async (directory, root) => {
    const host = new GatewaySessionTransport({ directory, sessionId: randomUUID(), name: 'ChatGPT page', cwd: root, route })
    const sender = new GatewaySessionTransport({ directory, sessionId: randomUUID(), name: 'Claude sender', cwd: root })
    try {
      await host.start()
      await sender.start()
      const receipt = await sender.send(host.peer.sessionId, 'Hello page', 'Greeting') as { id: string; state: string }
      assert.equal(receipt.state, 'queued')
      assert.equal(host.inbox().length, 1)
      assert.equal(host.inbox()[0]!.message.id, receipt.id)
      await host.acknowledge(receipt.id)
      assert.equal(host.inbox()[0]!.state, 'delivered')
      await host.send(sender.peer.sessionId, 'Hello Claude', 'Reply', receipt.id)
      assert.equal(sender.inbox().length, 1)
      assert.equal(sender.inbox()[0]!.message.replyTo, receipt.id)
      await host.close()
      await assert.rejects(access(join(directory, `${host.peer.sessionId}.json`)))
      await access(join(directory, `${sender.peer.sessionId}.json`))
    } finally {
      await host.close()
      await sender.close()
    }
  })
})
