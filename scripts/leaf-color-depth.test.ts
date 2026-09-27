import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LEAF_TERMINAL = pathToFileURL(join(ROOT, 'src/utils/leafTerminal.ts')).href

const { leafColorEnv } = await import(pathToFileURL(join(ROOT, 'src/utils/leafColor.ts')).href)

/**
 * A leaf's fd 1 is a pipe to the session that owns it, so chalk — which reads
 * tty.isatty(1), not process.stdout — resolves to level 0 and every theme colour
 * is dropped. The leaf then renders black and white even though its bytes are
 * drawn by the owner's real terminal.
 *
 * This runs the real installLeafTerminal() in a child whose stdio is piped, in
 * the same order the CLI does it (install before chalk is loaded), and reports
 * the colour level the leaf would actually render with.
 */
function leafColorLevel(env: NodeJS.ProcessEnv): Promise<number> {
  const code = `
    const mod = await import(process.env.LEAF_TERMINAL_MODULE)
    await mod.installLeafTerminal()
    const chalk = (await import('chalk')).default
    process.send({ level: chalk.level })
  `
  // The shell these run in can itself be a leaf of a coloured session, and then
  // it carries the very depth the cases below are deciding. Whatever the child
  // inherits would silently answer for it, so the three keys that decide colour
  // come only from the case.
  const inherited = { ...process.env }
  for (const key of ['FORCE_COLOR', 'NO_COLOR', 'GATEWAY_LEAF_COLOR_DEPTH']) delete inherited[key]
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code], {
      // A suite run from a console-less parent - a leaf, a detached harness - would
      // otherwise have Windows allocate a visible console per child, which Windows
      // Terminal opens as a tab and pulls focus to.
      windowsHide: true,
      cwd: ROOT,
      // Piped stdio is what makes fd 1 a non-tty, which is the whole point.
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: { ...inherited, LEAF_TERMINAL_MODULE: LEAF_TERMINAL, ...env },
    })
    const timer = setTimeout(() => { child.kill(); reject(new Error('leaf child did not report a colour level')) }, 30000)
    child.on('message', (message: any) => {
      if (message?.level === undefined) return
      clearTimeout(timer)
      child.kill()
      resolve(message.level)
    })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('exit', () => { clearTimeout(timer); reject(new Error('leaf child exited before reporting')) })
  })
}

test('a leaf adopts the colour depth of the terminal that will draw it', async () => {
  assert.equal(await leafColorLevel({ GATEWAY_LEAF_COLOR_DEPTH: '3' }), 3)
})

test('a leaf without a declared depth stays uncoloured, as it did before', async () => {
  // The pipe is the only signal chalk has on its own; nothing about the fake
  // stdout changes that. This is the behaviour the depth is there to correct.
  assert.equal(await leafColorLevel({ GATEWAY_LEAF_COLOR_DEPTH: '' }), 0)
})

test('an explicit no-colour request is not overridden by the inherited depth', async () => {
  assert.equal(await leafColorLevel({ GATEWAY_LEAF_COLOR_DEPTH: '3', NO_COLOR: '1' }), 0)
  assert.equal(await leafColorLevel({ GATEWAY_LEAF_COLOR_DEPTH: '3', FORCE_COLOR: '0' }), 0)
})

test('a monochrome owner produces a monochrome leaf', async () => {
  assert.equal(await leafColorLevel({ GATEWAY_LEAF_COLOR_DEPTH: '0' }), 0)
})

/**
 * The production path, which the cases above do not exercise.
 *
 * A leaf started by a session is not handed a depth to apply - the CLI it runs
 * has chalk loaded before installLeafTerminal can run, so a depth set inside
 * the leaf is ignored and only the environment carries colour. These check the
 * environment the owner builds for it.
 */
function withCleanEnv<T>(run: () => T): T {
  const saved = { FORCE_COLOR: process.env.FORCE_COLOR, NO_COLOR: process.env.NO_COLOR }
  delete process.env.FORCE_COLOR
  delete process.env.NO_COLOR
  try {
    return run()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('a truecolor owner hands the leaf both the depth and the colour level', () => {
  // node reports 24 bits for truecolor; chalk's level for it is 3.
  const env = withCleanEnv(() => leafColorEnv({ getColorDepth: () => 24 }))
  assert.deepEqual(env, { GATEWAY_LEAF_COLOR_DEPTH: '3', FORCE_COLOR: '3' })
})

test('a 256-colour owner does not claim truecolor', () => {
  // Clamping the bit count into a level would have said 3 here.
  assert.equal(withCleanEnv(() => leafColorEnv({ getColorDepth: () => 8 })).FORCE_COLOR, '2')
  assert.equal(withCleanEnv(() => leafColorEnv({ getColorDepth: () => 4 })).FORCE_COLOR, '1')
})

test('an owner with no colour support asks for no colour, not a weak palette', () => {
  // node reports 1 bit for "no colour at all", which is not the same as
  // "16 colours" - the leaf must not be told to paint.
  const env = withCleanEnv(() => leafColorEnv({ getColorDepth: () => 1 }))
  assert.equal(env.GATEWAY_LEAF_COLOR_DEPTH, '0')
  assert.equal(env.FORCE_COLOR, undefined)
})

test('a colour-capable owner that reports only hasColors() still colours the leaf', () => {
  assert.equal(withCleanEnv(() => leafColorEnv({ hasColors: () => true })).FORCE_COLOR, '3')
  assert.equal(withCleanEnv(() => leafColorEnv({ hasColors: () => false })).FORCE_COLOR, undefined)
})

test('an explicit request from the person outranks the owner depth', () => {
  const noColor = withCleanEnv(() => { process.env.NO_COLOR = '1'; return leafColorEnv({ getColorDepth: () => 24 }) })
  assert.equal(noColor.FORCE_COLOR, undefined)
  const forced = withCleanEnv(() => { process.env.FORCE_COLOR = '0'; return leafColorEnv({ getColorDepth: () => 24 }) })
  assert.equal(forced.FORCE_COLOR, undefined, 'the inherited value must not be overwritten')
})
