/**
 * Throwaway G-018 live runner: drive ONE real turn through the branch driver
 * against the already-open Chrome (CDP 9222), with HOME/USERPROFILE pointed at
 * a scratch dir so the live driver.log / peer.json are never written.
 *
 * The guard is structural, not a reminder: if the environment it is handed
 * resolves to the live ~/.chatgpt-web it refuses to run and exits non-zero.
 * An earlier probe run appended two blocks to the live driver.log because a
 * shell had already exported HOME/USERPROFILE; this is the fix for that.
 *
 * Usage: HOME=<scratch> USERPROFILE=<scratch> node live-turn.mjs --check
 *        HOME=<scratch> USERPROFILE=<scratch> node live-turn.mjs --status
 *        HOME=<scratch> USERPROFILE=<scratch> node live-turn.mjs "prompt text"
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// os.homedir() reads USERPROFILE, which is the very thing a scratch run
// overrides, so the live home must come from the logon pair the shell does not
// rewrite. HOMEDRIVE+HOMEPATH still says C:\Users\Ahmed under a scratch env
// (measured); fall back to os.homedir() when the pair is absent.
const LIVE_HOME = process.env.HOMEDRIVE && process.env.HOMEPATH
  ? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
  : os.homedir()
const LIVE_BASE = path.join(LIVE_HOME, '.chatgpt-web')

const norm = value => (value ? path.resolve(String(value)).replace(/[\\/]+$/, '').toLowerCase() : '')
const same = (a, b) => Boolean(norm(a)) && norm(a) === norm(b)
const inside = (child, parent) => {
  const c = norm(child)
  const p = norm(parent)
  return c === p || c.startsWith(`${p}${path.sep}`)
}

const refuse = reason => {
  console.error(`live-turn: REFUSING TO RUN: ${reason}`)
  process.exit(3)
}

// Refuse before anything can write. os.homedir() on Windows reads
// USERPROFILE, so a shell that exports the live profile is exactly the
// failure this catches, even when HOME alone looks scratch.
if (process.env.HOME && same(process.env.HOME, LIVE_HOME)) {
  refuse(`HOME=${process.env.HOME} is the live home (${LIVE_HOME})`)
}
if (process.env.USERPROFILE && same(process.env.USERPROFILE, LIVE_HOME)) {
  refuse(`USERPROFILE=${process.env.USERPROFILE} is the live home (${LIVE_HOME})`)
}

let SCRATCH = null
if (!process.env.HOME || !process.env.USERPROFILE) {
  SCRATCH = await fs.mkdtemp(path.join(os.tmpdir(), 'g018live-'))
  process.env.HOME ||= SCRATCH
  process.env.USERPROFILE ||= process.env.HOME
}
process.env.CHATGPT_PROFILE ||= path.join(LIVE_BASE, 'profile')

const mod = await import(new URL('./chatgpt.mjs', import.meta.url).href)

// The module resolved its own base from os.homedir(); assert on the value it
// will actually write to, not on the env we think we set.
const base = mod.BASE
if (same(base, LIVE_BASE)) refuse(`resolved BASE=${base} is the live state dir`)
if (!inside(base, process.env.HOME)) refuse(`resolved BASE=${base} is outside HOME=${process.env.HOME}`)

const args = process.argv.slice(2)

if (args[0] === '--check') {
  console.log(JSON.stringify({
    liveHome: LIVE_HOME,
    liveBase: LIVE_BASE,
    home: process.env.HOME,
    userprofile: process.env.USERPROFILE,
    base,
    scratch: SCRATCH,
    safe: true,
  }))
  process.exit(0)
}

const { page } = await mod.connect()

if (args[0] === '--status') {
  const state = await mod.pageState(page)
  console.log(JSON.stringify({ url: state.url, model: state.model, loggedIn: state.loggedIn, base: mod.BASE }))
  process.exit(0)
}

const text = args.join(' ')
const startedAt = Date.now()
const result = await mod.ask(page, text, {})
await mod.flushLog()
console.log(JSON.stringify({
  wall: Date.now() - startedAt,
  url: result.url,
  len: result.reply?.length ?? 0,
  head: (result.reply ?? '').slice(0, 80),
}))
process.exit(0)
