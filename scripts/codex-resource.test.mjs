import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  BUNDLED_CODEX_VERSION,
  bundledCodexPath,
  codexResourceDir,
  resolveBundledCodex,
} from './codex-resource.mjs'

async function scratch() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-resource-'))
  const previous = process.env.MODEL_GATEWAY_CODEX_BIN
  delete process.env.MODEL_GATEWAY_CODEX_BIN
  return {
    root,
    restore: async () => {
      if (previous !== undefined) process.env.MODEL_GATEWAY_CODEX_BIN = previous
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('a staged release resolves the entrypoint its manifest names', async () => {
  const { root, restore } = await scratch()
  try {
    const dir = codexResourceDir({ root, platform: 'win32', arch: 'x64' })
    await mkdir(dir, { recursive: true })
    const entry = 'codex-x86_64-pc-windows-msvc.exe'
    await writeFile(path.join(dir, 'codex-package.json'), JSON.stringify({ entrypoint: entry }))
    await writeFile(path.join(dir, entry), '')
    assert.equal(bundledCodexPath({ root, platform: 'win32', arch: 'x64' }), path.join(dir, entry))
    assert.equal(resolveBundledCodex({ root, platform: 'win32', arch: 'x64' }), path.join(dir, entry))
    assert.match(dir, new RegExp(`${BUNDLED_CODEX_VERSION}[\\\\/]win32-x64$`))
  } finally {
    await restore()
  }
})

test('a release without a manifest falls back to the conventional name', async () => {
  const { root, restore } = await scratch()
  try {
    const dir = codexResourceDir({ root, platform: 'darwin', arch: 'arm64' })
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'codex'), '')
    assert.equal(resolveBundledCodex({ root, platform: 'darwin', arch: 'arm64' }), path.join(dir, 'codex'))
  } finally {
    await restore()
  }
})

test('nothing staged resolves null, and the explicit override wins', async () => {
  const { root, restore } = await scratch()
  try {
    assert.equal(resolveBundledCodex({ root, platform: 'linux', arch: 'x64' }), null)
    const explicit = path.join(root, 'custom-codex')
    await writeFile(explicit, '')
    process.env.MODEL_GATEWAY_CODEX_BIN = explicit
    assert.equal(resolveBundledCodex({ root, platform: 'linux', arch: 'x64' }), explicit)
    process.env.MODEL_GATEWAY_CODEX_BIN = path.join(root, 'missing')
    assert.equal(resolveBundledCodex({ root, platform: 'linux', arch: 'x64' }), null)
  } finally {
    await restore()
  }
})
