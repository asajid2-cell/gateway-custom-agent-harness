/**
 * Unit rows for the live-turn.mjs hard fail. The rig once appended two probe
 * blocks to the LIVE driver.log because a shell had already exported
 * HOME/USERPROFILE; these rows pin the structural refusal that replaced the
 * reminder.
 */
import { test, expect } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const RIG = new URL('./live-turn.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

const run = env => spawnSync(process.execPath, [RIG, '--check'], {
  encoding: 'utf8',
  env: { ...process.env, ...env },
  timeout: 60_000,
})

const liveHome = () => (process.env.HOMEDRIVE && process.env.HOMEPATH
  ? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
  : os.homedir())

test('l1. the rig refuses when HOME resolves to the live home', () => {
  const home = liveHome()
  const out = run({ HOME: home, USERPROFILE: home })
  expect(out.status).not.toBe(0)
  expect(out.status).toBe(3)
  expect(out.stderr).toContain('REFUSING TO RUN')
  expect(out.stderr).toContain(home)
})

test('l2. the rig refuses when only USERPROFILE is the live home', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'g018guard-'))
  const out = run({ HOME: scratch, USERPROFILE: liveHome() })
  expect(out.status).toBe(3)
  expect(out.stderr).toContain('USERPROFILE')
})

test('l3. a scratch HOME runs and reports a base inside it', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'g018guard-'))
  const out = run({ HOME: scratch, USERPROFILE: scratch })
  expect(out.status).toBe(0)
  const report = JSON.parse(out.stdout.trim())
  expect(report.safe).toBe(true)
  expect(report.base.toLowerCase().startsWith(path.resolve(scratch).toLowerCase())).toBe(true)
  expect(report.base.toLowerCase()).not.toBe(report.liveBase.toLowerCase())
})
