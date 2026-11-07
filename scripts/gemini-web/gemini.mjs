#!/usr/bin/env node
/**
 * The Gemini driver: the same line-JSON contract as the ChatGPT driver.
 *
 * Playwright over CDP, like the ChatGPT driver. The browser must be a real,
 * visible window with native occlusion detection off: Chrome marks an occluded
 * (or off-screen) page hidden, and a hidden page drops CDP input, which makes a
 * send silently do nothing. Chrome is launched here with those flags.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn } from 'node:child_process'
import { closeSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { createRequire } from 'node:module'
import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { createLaneGate } from '../web-lane-gate.mjs'

const PORT = Number(process.env.GEMINI_CDP_PORT || process.env.CHATGPT_CDP_PORT || 9223)
const PROFILE = process.env.GEMINI_PROFILE || process.env.CHATGPT_PROFILE || join(homedir(), '.gemini-web', 'profile')
const STATE_DIR = process.env.GEMINI_STATE_DIR || process.env.CHATGPT_STATE_DIR || join(homedir(), 'gemini-web')
const LANE_ID = process.env.GEMINI_LANE_ID || process.env.CHATGPT_LANE_ID || ''
const LANE_SOURCE_PORT = Number(process.env.GEMINI_LANE_SOURCE_PORT || process.env.CHATGPT_LANE_SOURCE_PORT || 0)
const LANE_SYNC_COOKIES = (process.env.GEMINI_LANE_SYNC_COOKIES || process.env.CHATGPT_LANE_SYNC_COOKIES || '1') !== '0'
const APP = 'https://gemini.google.com/app'
const THREAD = /\/app\/([A-Za-z0-9_-]{4,128})/
const LOG_FILE = join(STATE_DIR, 'driver.log')
const SEND_TIMEOUT_MS = Number(process.env.GEMINI_SEND_TIMEOUT_MS || 240_000)
const POLL_MS = 700
const MODEL_WANTED = String(process.env.GEMINI_WEB_MODEL || process.env.WEB_BRIDGE_MODEL || '').trim()
const EFFORT_WANTED = String(process.env.GEMINI_WEB_EFFORT || process.env.WEB_BRIDGE_EFFORT || '').trim().toLowerCase()
/**
 * Google does not accept a copied session: cookies moved into a fresh profile
 * leave the page signed out, and the profile's cookie database is locked while
 * the master Chrome runs. So a Gemini lane is a TAB in the master browser, not
 * a second profile. Each lane keeps its own tab, named by window.name, and
 * CDP input reaches a background tab, so lanes stay independent and parallel.
 */
const LANE_SHARED = (process.env.GEMINI_LANE_SHARED || process.env.CHATGPT_LANE_SHARED || '0') === '1'
const CONNECT_PORT = LANE_SHARED && LANE_SOURCE_PORT ? LANE_SOURCE_PORT : PORT
const LANE_TAB_PREFIX = 'webbridge-lane:'
const LANE_TAB = LANE_ID ? `${LANE_TAB_PREFIX}${LANE_ID}` : ''
const LANE_SHARED_DIR = process.env.GEMINI_LANE_SHARED_DIR || process.env.CHATGPT_LANE_SHARED_DIR || join(STATE_DIR, '..')
// One tab can be in front at a time, and Playwright's click waits for the
// target to be hit-testable: two lanes typing at once would race for focus and
// one click would hang. Focus is held only while typing, not while waiting.
const FOCUS_LOCK = join(LANE_SHARED_DIR, 'webbridge-focus.lock')
const FOCUS_STALE_MS = 60_000
// One browser-level launch/replace at a time. Two lanes that both decide the
// master is wedged must not kill and relaunch it over each other.
const LAUNCH_LOCK = join(LANE_SHARED_DIR, 'webbridge-launch.lock')
const LAUNCH_STALE_MS = 120_000
// Tab leases, exactly as the ChatGPT driver uses them: a lane names its tab,
// writes a lease, and whoever opens a lane next sweeps tabs whose lease is
// gone. Without this a driver killed with its host leaves an orphan tab in the
// shared master forever (measured 2026-11-06: Gemini had neither).
const LANE_LEASE_DIR = join(LANE_SHARED_DIR, 'lane-tabs')
const LANE_LEASE_STALE_MS = 3 * 60_000
/**
 * The lane a request is for, when one process serves several tabs.
 *
 * The host runs ONE driver child per browser and stamps `lane` on each lane
 * request; the env var is the older one-process-per-lane shape. Everything that
 * picks a tab reads this, so each inputter gets its own tab and its own serial
 * chain inside one process - the same contract as the ChatGPT driver.
 */
const LANE_CTX = new AsyncLocalStorage()
const laneOf = () => LANE_CTX.getStore() || LANE_ID

async function log(line) {
  try {
    await mkdir(STATE_DIR, { recursive: true })
    await writeFile(LOG_FILE, `${new Date().toISOString()} [${laneOf() || 'master'}] ${line}\n`, { flag: 'a' })
  } catch { /* logging must never break a turn */ }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Take the one browser focus token. Lanes are tabs in one window; only one tab
 * is in front, and a click aimed at a tab that lost the front hangs. The token
 * covers typing only - a lane waits for its answer with the token released, so
 * turns still overlap.
 */
async function acquireLock(file, waitMs, staleMs) {
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      const fd = openSync(file, 'wx')
      writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`)
      closeSync(fd)
      return async () => { try { unlinkSync(file) } catch { /* already released */ } }
    } catch (error) {
      // Windows answers an existing lock it cannot open with EPERM/EACCES as
      // well as EEXIST; all three mean "someone holds it".
      if (error?.code !== 'EEXIST' && error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error
      try {
        if (Date.now() - statSync(file).mtimeMs > staleMs) { unlinkSync(file); continue }
      } catch { /* the holder released between the two calls */ }
      if (Date.now() > deadline) throw new Error(`another lane held ${basename(file)} for ${Math.round(waitMs / 1000)}s`)
      await sleep(120)
    }
  }
}

async function acquireFocus() {
  // The wait must exceed the stale window, or a dead holder fails the waiter.
  return acquireLock(FOCUS_LOCK, 90_000, FOCUS_STALE_MS)
}

async function acquireLaunch() {
  return acquireLock(LAUNCH_LOCK, 150_000, LAUNCH_STALE_MS)
}

async function withFocus(page, work) {
  if (!LANE_SHARED) return work()
  const release = await acquireFocus()
  try {
    await page.bringToFront().catch(() => {})
    return await work()
  } finally { await release() }
}

function loadPlaywright() {
  const require = createRequire(import.meta.url)
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    process.env.GEMINI_PLAYWRIGHT,
    join(here, 'node_modules', 'playwright-core'),
    join(STATE_DIR, 'node_modules', 'playwright-core'),
    'C:/Users/Ahmed/301/watch-together-lanes/htv-memory-resume/node_modules/playwright-core',
  ].filter(Boolean)
  for (const candidate of candidates) {
    try { return require(candidate) } catch { /* next */ }
  }
  throw new Error('playwright-core not found; install it or set GEMINI_PLAYWRIGHT')
}

/* --------------------------------------------------------------- Chrome */

async function portAnswers(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
    return response.ok
  } catch { return false }
}

function chromeCandidates() {
  return [
    process.env.GEMINI_CHROME,
    process.env.CHATGPT_CHROME,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  ].filter(Boolean)
}

async function chromeExe() {
  for (const candidate of chromeCandidates()) {
    try { await readFile(candidate); return candidate } catch { /* next */ }
  }
  throw new Error('Chrome not found: set GEMINI_CHROME')
}

let launched = null

/**
 * A lane window is small but ON SCREEN: a hidden page drops CDP input, and a
 * send that types nothing is worse than one more small window.
 */
async function ensureChrome(locked = false) {
  // A shared lane lives in the master browser. If the host unloaded it, the
  // master profile is still the one to open: the login lives there.
  const targetPort = LANE_SHARED ? CONNECT_PORT : PORT
  const targetProfile = LANE_SHARED
    ? (process.env.GEMINI_LANE_SOURCE_PROFILE || process.env.CHATGPT_LANE_SOURCE_PROFILE || PROFILE)
    : PROFILE
  if (await portAnswers(targetPort)) return
  if (locked) return openChrome(targetPort, targetProfile)
  const release = await acquireLaunch()
  try {
    if (await portAnswers(targetPort)) return
    return await openChrome(targetPort, targetProfile)
  } finally { await release() }
}

/** Spawn the window. The caller holds the launch lock. */
async function openChrome(targetPort, targetProfile) {
  const exe = await chromeExe()
  await mkdir(targetProfile, { recursive: true })
  const lane = !LANE_SHARED && LANE_SOURCE_PORT > 0
  const args = [
    `--remote-debugging-port=${targetPort}`,
    `--user-data-dir=${targetProfile}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-default-apps', '--disable-component-update',
    '--disable-background-networking', '--disable-sync', '--mute-audio',
    '--disable-features=Translate,MediaRouter,OptimizationHints,AcceptCHFrame,InterestFeedContentSuggestions,CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    `--window-size=${lane ? '720,620' : '1100,900'}`,
    `--window-position=${lane ? '40,40' : '120,80'}`,
    APP,
  ]
  launched = spawn(exe, args, { detached: true, stdio: 'ignore' })
  launched.unref()
  launched.on('exit', () => log(`Closed Chrome pid=${launched?.pid ?? '?'}`))
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    // The shared master's source port is not necessarily PORT; waiting on the
    // wrong one timed the launch out while the window was up and answering.
    if (await portAnswers(targetPort)) return
    await sleep(400)
  }
  throw new Error('Chrome did not open the debugging port')
}

/* ----------------------------------------------------------- Playwright */

/**
 * The command line of the process listening on `port`, or '' if unreadable.
 *
 * Killing a browser is only safe when it can be shown to carry THIS provider's
 * profile. Matching on the port alone used to kill the shared master that every
 * Gemini lane borrows - a stalled lane took the whole browser down mid-turn.
 */
async function portOwnerCommandLine(port) {
  return new Promise(resolve => {
    const script = `$c=Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { (Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)").CommandLine }`
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', chunk => { out += chunk.toString('utf8') })
    child.on('exit', () => resolve(out.trim()))
    child.on('error', () => resolve(''))
  })
}

/** Kill the browser that owns this debug port, and only when it is OURS. */
async function killPortOwner(port, profile) {
  const command = await portOwnerCommandLine(port)
  // Normalise BOTH sides: Chrome may print the profile with forward slashes,
  // backslashes, or a trailing separator, and a proof that fails on that is a
  // proof that can never pass (measured 2026-11-06: the master was refused).
  const canonical = value => String(value || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  if (!command || !canonical(command).includes(canonical(profile))) {
    throw new Error(`refusing to kill the browser on port ${port}: its owner cannot be proven to carry --user-data-dir=${profile}`)
  }
  await new Promise(resolve => {
    const script = `$p=(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess; if ($p) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }`
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', script], { stdio: 'ignore' })
    child.on('exit', resolve)
    child.on('error', resolve)
  })
}

async function connect(port = CONNECT_PORT) {
  const { chromium } = loadPlaywright()
  const attach = () => chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 30_000 })
  let browser
  try {
    browser = await attach()
  } catch (error) {
    // Chrome 156 intermittently accepts the browser websocket and never answers
    // the handshake: /json/version keeps answering while every attach hangs
    // (measured 2026-11-05 on both masters). The window is disposable - the
    // login lives in the profile - so replace it and attach to the new one.
    // Two guards, both learned the hard way: the launch lock so two lanes never
    // replace the same browser at once, and a profile proof before any kill so
    // a lane can never take down a browser that is not this provider's.
    const targetProfile = LANE_SHARED
      ? (process.env.GEMINI_LANE_SOURCE_PROFILE || process.env.CHATGPT_LANE_SOURCE_PROFILE || PROFILE)
      : PROFILE
    await log(`attach on port ${port} stalled (${String(error.message).split('\n')[0]}); restarting the window`)
    const release = await acquireLaunch()
    try {
      await killPortOwner(port, targetProfile)
      await sleep(1_500)
      await ensureChrome(true)
    } finally { await release() }
    browser = await attach()
  }
  const context = browser.contexts()[0]
  if (!context) throw new Error(`browser on port ${port} has no browser context`)
  return { browser, context }
}

/**
 * The connection this child keeps for the shared browser.
 *
 * Every op used to attach and then disconnect. One process now serves every
 * inputter's tab, and Chrome 156 stalls a browser-level attach whenever another
 * is in flight, so per-op attaches from several lanes are what turned a healthy
 * page into "attach stalled; restarting the window". One attach, reused, and
 * dropped only when the browser itself goes away.
 */
let SHARED_CONNECTION = null

async function sharedConnection() {
  if (SHARED_CONNECTION?.browser?.isConnected?.()) return SHARED_CONNECTION
  SHARED_CONNECTION = null
  const connection = await connect()
  connection.browser.on('disconnected', () => { if (SHARED_CONNECTION === connection) SHARED_CONNECTION = null })
  SHARED_CONNECTION = connection
  return connection
}

/** Keep this lane's lease fresh: a tab whose lease ages out is swept. */
async function touchLaneLease(id) {
  const file = join(LANE_LEASE_DIR, `${id}.json`)
  const now = new Date()
  await mkdir(LANE_LEASE_DIR, { recursive: true }).catch(() => {})
  const refreshed = await utimes(file, now, now).then(() => true, () => false)
  if (!refreshed) await writeFile(file, JSON.stringify({ pid: process.pid, at: now.toISOString() })).catch(() => {})
}

/** Each lane's tab, by lane id: the Page is the identity, the name the label. */
const LANE_PAGES = new Map()
/** When each lane last asked for its tab. An open in flight is never swept. */
const LANE_SEEN = new Map()
const LANE_SEEN_GRACE_MS = 60_000
const LANE_SWEEP_EVERY_MS = 60_000
let LANE_SWEPT_AT = 0
/** Tab creation and its first load are one-at-a-time; see scripts/web-lane-gate.mjs. */
const serialLaneOpen = createLaneGate()

function bounded(promise, ms) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms); timer.unref?.() }),
  ]).finally(() => clearTimeout(timer))
}

/** A tab's name, bounded: a hung renderer must not hold the caller. */
async function tabNameOf(page) {
  try { return String(await bounded(page.evaluate(() => window.name), 3_000) || '') } catch { return '' }
}

async function laneIdOfPage(page) {
  for (const [id, known] of LANE_PAGES) if (known === page) return id
  const name = await tabNameOf(page)
  return name.startsWith(LANE_TAB_PREFIX) ? name.slice(LANE_TAB_PREFIX.length) : null
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

async function readLeases() {
  let names = []
  try { names = await readdir(LANE_LEASE_DIR) } catch { names = [] }
  const leases = new Map()
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = join(LANE_LEASE_DIR, name)
    const info = await stat(file).catch(() => null)
    if (!info) continue
    let pid = null
    try { pid = Number(JSON.parse(await readFile(file, 'utf8'))?.pid) || null } catch { /* no owner */ }
    leases.set(name.slice(0, -'.json'.length), { file, ageMs: Date.now() - info.mtimeMs, pid })
  }
  return leases
}

/**
 * Close lane tabs (and leases) no live lane owns.
 *
 * With `keep` (the host lane manager's list, sent as `sweep-lanes`) the list is
 * authoritative: this process is the browser's only driver, so any other lane
 * tab is a ghost - a lease timer keeps a dead lane's lease fresh for as long
 * as its tab lives, which is why the age rule alone never cleaned them. Without
 * `keep` the age rule applies. A lane that asked for its tab in the last minute
 * is always spared, and so is a fresh lease held by a different live process.
 */
async function sweepLaneTabs(context, { keep = null } = {}) {
  LANE_SWEPT_AT = Date.now()
  const leases = await readLeases()
  const live = new Set(keep ? [...keep] : [...LANE_PAGES.keys()])
  for (const [id, at] of LANE_SEEN) if (Date.now() - at < LANE_SEEN_GRACE_MS) live.add(id)
  for (const [id, lease] of leases) {
    if (lease.ageMs > LANE_LEASE_STALE_MS) continue
    const foreign = lease.pid && lease.pid !== process.pid && pidAlive(lease.pid)
    if (foreign || !keep) live.add(id)
  }
  let closed = 0
  for (const page of context.pages()) {
    const id = await laneIdOfPage(page)
    if (id === null || live.has(id)) continue
    await page.close().catch(() => {})
    LANE_PAGES.delete(id)
    LANE_SEEN.delete(id)
    closed += 1
  }
  for (const [id, lease] of leases) {
    if (!live.has(id)) await rm(lease.file, { force: true }).catch(() => {})
  }
  for (const id of [...LANE_PAGES.keys()]) if (!live.has(id)) { LANE_PAGES.delete(id); LANE_SEEN.delete(id) }
  if (closed) await log(`lane sweep: closed ${closed} lane tab(s) no live lane owns`)
  return closed
}

/** Keep the lease younger than the sweep threshold for the tab's whole life. */
const LEASED = new WeakSet()
function keepLeaseFresh(page, leaseId) {
  if (!LANE_SHARED || !leaseId || LEASED.has(page)) return
  LEASED.add(page)
  const timer = setInterval(() => { void touchLaneLease(leaseId) }, Math.max(15_000, Math.floor(LANE_LEASE_STALE_MS / 3)))
  timer.unref?.()
  const stop = () => clearInterval(timer)
  page.once('close', stop)
  page.once('crash', stop)
}

const isGeminiUrl = url => /^https:\/\/gemini\.google\.com\//.test(String(url || ''))

/**
 * The tab this request works in.
 *
 * A lane request gets its own named tab, opened once and then kept: reusing it
 * is what makes an interactive back-and-forth cost no page load. A request with
 * no lane is the master/operator page, and must never pick up a lane's tab. No
 * tab is brought to the front here: a read must not steal the window from a
 * lane that is typing, and the send path brings its tab forward under the focus
 * lock for exactly the compose-and-click.
 */
async function geminiPage(context) {
  const lane = laneOf()
  if (LANE_SHARED && lane) {
    const wanted = `${LANE_TAB_PREFIX}${lane}`
    LANE_SEEN.set(lane, Date.now())
    let page = LANE_PAGES.get(lane)
    if (page && page.isClosed()) { LANE_PAGES.delete(lane); page = undefined }
    if (!page) {
      await touchLaneLease(lane)
      const owned = new Set(LANE_PAGES.values())
      for (const candidate of context.pages()) {
        if (owned.has(candidate)) continue
        if (await tabNameOf(candidate) === wanted) { page = candidate; break }
      }
      if (!page) {
        // One tab opens at a time per browser: concurrent first loads starve
        // each other and a lane warm then misses its budget (ChatGPT measured
        // two at 120 s; the browser is the same single resource here).
        page = await serialLaneOpen(async () => {
          const created = await context.newPage()
          await created.goto(APP, { waitUntil: 'domcontentloaded' })
          await log(`lane tab opened for ${lane}`)
          return created
        })
      }
      const mine = page
      LANE_PAGES.set(lane, mine)
      mine.once('close', () => { if (LANE_PAGES.get(lane) === mine) LANE_PAGES.delete(lane) })
    }
    // Chrome clears window.name on a cross-site navigation (a sign-in bounce),
    // so the name is re-asserted whenever the tab is on the site.
    if (isGeminiUrl(page.url()) && await tabNameOf(page) !== wanted) {
      await bounded(page.evaluate(name => { window.name = name }, wanted), 3_000).catch(() => {})
    }
    keepLeaseFresh(page, lane)
    if (Date.now() - LANE_SWEPT_AT > LANE_SWEEP_EVERY_MS) await sweepLaneTabs(context).catch(() => 0)
    return page
  }
  const lanePages = new Set(LANE_PAGES.values())
  let page = null
  for (const candidate of context.pages()) {
    if (lanePages.has(candidate) || !isGeminiUrl(candidate.url())) continue
    if (LANE_SHARED && (await tabNameOf(candidate)).startsWith(LANE_TAB_PREFIX)) continue
    page = candidate
    break
  }
  if (!page) {
    page = context.pages().find(candidate => !lanePages.has(candidate)) ?? await context.newPage()
    if (!isGeminiUrl(page.url())) await page.goto(APP, { waitUntil: 'domcontentloaded' })
  }
  if (!LANE_SHARED) await page.bringToFront().catch(() => {})
  return page
}

/**
 * A tab that already SHOWS `threadId`: this lane's own first, then any other.
 *
 * Gemini has no conversation API the page can call - the transcript is the DOM
 * - so a thread can only be read from a tab that is on it. Reading whatever tab
 * the request happened to land on is what reported "the page is on another
 * thread" while the thread was open in its lane's tab.
 */
function pageShowing(context, threadId) {
  const wanted = String(threadId || '').toLowerCase()
  if (!wanted) return null
  const own = LANE_PAGES.get(laneOf())
  if (own && !own.isClosed() && threadOfUrl(own.url()) === wanted) return own
  return context.pages().find(page => !page.isClosed() && threadOfUrl(page.url()) === wanted) ?? null
}

async function withPage(operation) {
  if (!LANE_SHARED) {
    const { browser, context } = await connect()
    try {
      const page = await geminiPage(context)
      return await operation(page, context)
    } finally { await browser.close().catch(() => {}) }
  }
  const { context } = await sharedConnection()
  const page = await geminiPage(context)
  return await operation(page, context)
}

/* ------------------------------------------------------------- cookies */

const googleCookie = cookie => /(^|\.)google\.com$|(^|\.)googleusercontent\.com$/i.test(cookie.domain || '')

async function branchMasterLogin() {
  if (LANE_SHARED) return { cookiesSynced: false, sharedBrowser: true }
  // Google refuses a copied session: the fresh profile renders signed out, and
  // the same session seen twice makes Google invalidate the original login
  // (2026-11-04: the master profile was signed out after a branched lane).
  // A Gemini lane must therefore be a tab in the master browser, never a
  // second profile.
  if (LANE_SOURCE_PORT) {
    throw new Error('a Gemini lane cannot copy the login; run it as a shared-browser tab (CHATGPT_LANE_SHARED=1)')
  }
  return { cookiesSynced: false }
}

async function syncBackCookies(context) {
  if (!LANE_SOURCE_PORT || !LANE_SYNC_COOKIES) return null
  const cookies = (await context.cookies()).filter(googleCookie)
  if (cookies.length === 0) return null
  const { browser, context: master } = await connect(LANE_SOURCE_PORT)
  try {
    await master.addCookies(cookies)
    await log(`cookie write-back ok (${cookies.length} cookies) to master port ${LANE_SOURCE_PORT}`)
    return cookies.length
  } finally { await browser.close().catch(() => {}) }
}

/* ------------------------------------------------------------ page model */

const PICKER = /Open mode picker/i

async function signedIn(page) {
  return page.evaluate(() => {
    const text = node => (node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim()
    return {
      account: [...document.querySelectorAll('button,[role=button]')]
        .some(button => /Google Account/i.test(button.getAttribute('aria-label') || '')),
      signIn: [...document.querySelectorAll('button,a')].some(element => /^Sign in$/i.test(text(element))),
      url: location.href,
    }
  }).catch(() => ({ account: false, signIn: true, url: page.url() }))
}

async function pickerState(page) {
  return page.evaluate(() => {
    const picker = [...document.querySelectorAll('button,[role=button]')]
      .find(button => /Open mode picker/i.test(button.getAttribute('aria-label') || ''))
    if (!picker) return null
    const label = picker.getAttribute('aria-label') || ''
    const text = (picker.innerText || '').replace(/\s+/g, ' ').trim()
      || label.replace(/^Open mode picker,?\s*(currently\s*)?/i, '')
    const parts = text.split(' ')
    // Low is the lowest level and the picker omits it, so a bare "Flash" is Low.
    return { label, text, model: parts[0] || null, effort: parts[1] || 'Low' }
  }).catch(() => null)
}

const properNameOf = name => String(name || '').trim().split(' ').pop() || ''

function modelMatches(wanted, state) {
  if (!state?.model) return false
  const actual = state.model.toLowerCase()
  const tail = properNameOf(wanted).toLowerCase()
  return actual === tail || `${wanted}`.toLowerCase().endsWith(actual) || tail.endsWith(actual)
}

async function pageState(page) {
  return page.evaluate(() => {
    const body = document.body?.innerText || ''
    const stop = [...document.querySelectorAll('button,[role=button]')]
      .some(button => /stop response/i.test(button.getAttribute('aria-label') || ''))
    const pending = document.querySelector('pending-request') !== null
    const match = /\/app\/([A-Za-z0-9_-]{4,128})/.exec(location.pathname)
    return {
      url: location.href,
      threadId: match ? match[1].toLowerCase() : null,
      generating: stop || pending,
      hasComposer: !!document.querySelector('.ql-editor[contenteditable="true"]'),
      signIn: /\bSign in\b/.test(body),
    }
  })
}

const threadOfUrl = url => {
  const match = THREAD.exec(String(url || ''))
  return match ? match[1].toLowerCase() : null
}

async function pageTurns(page) {
  return page.evaluate(() => {
    const text = node => (node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim()
    // The query node also carries a visually-hidden screen-reader copy of the
    // prompt; only the .query-text-line paragraphs are the real text.
    const cleanUser = element => {
      const lines = [...element.querySelectorAll('.query-text-line')].map(node => text(node)).filter(Boolean)
      if (lines.length) return lines.join(' ')
      return text(element.querySelector('.query-text') || element).replace(/You said\s*/i, '').trim()
    }
    const cleanModel = element => text(element.querySelector('message-content') || element).replace(/^Gemini said\s*/i, '').trim()
    const turns = []
    for (const container of document.querySelectorAll('.conversation-container, pending-request')) {
      const user = container.querySelector('user-query')
      const model = container.querySelector('model-response')
      if (user) turns.push({ role: 'user', text: cleanUser(user) })
      if (model) turns.push({ role: 'assistant', text: cleanModel(model) })
    }
    return { turns, pending: document.querySelectorAll('pending-request').length }
  })
}

function conversationOf(threadId, turns, pending) {
  const mapping = {}
  let parent = null
  let current = null
  let users = 0
  let assistants = 0
  turns.forEach((turn, index) => {
    const id = turn.role === 'user' ? `u${users++}` : `a${assistants++}`
    const incomplete = turn.role === 'assistant' && pending > 0 && index === turns.length - 1
    mapping[id] = {
      id,
      parent,
      children: [],
      message: {
        id,
        author: { role: turn.role },
        create_time: index,
        end_turn: turn.role === 'assistant' ? !incomplete : null,
        status: turn.role === 'assistant' ? (incomplete ? 'in_progress' : 'finished_successfully') : null,
        content: { content_type: 'text', parts: [turn.text] },
      },
    }
    if (parent && mapping[parent]) mapping[parent].children.push(id)
    parent = id
    current = id
  })
  if (!current) {
    const root = `root-${threadId || 'new'}`
    mapping[root] = { id: root, parent: null, children: [], message: null }
    current = root
  }
  return { current_node: current, mapping, threadId }
}

async function waitForComposer(page, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await page.locator('.ql-editor[contenteditable="true"]').count().catch(() => 0)) return true
    await sleep(300)
  }
  return false
}

async function openThread(page, threadId) {
  if (threadOfUrl(page.url()) === threadId.toLowerCase()) return true
  await page.goto(`${APP}/${threadId}`, { waitUntil: 'domcontentloaded' })
  return waitForComposer(page)
}

/* --------------------------------------------------------------- actions */

async function overlayOpen(page) {
  // Tooltips and the dictate bubble are overlays too; only the mode menu counts.
  return page.evaluate(() => [...document.querySelectorAll('.cdk-overlay-pane')].some(pane => {
    const rect = pane.getBoundingClientRect()
    if (!rect.width || !rect.height) return false
    return /Thinking level|Flash-Lite|Argon|All-around help/i.test(pane.innerText || '')
  })).catch(() => false)
}

async function openPicker(page) {
  if (await overlayOpen(page)) return true
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.getByRole('button', { name: PICKER }).first().click({ timeout: 5_000 }).catch(() => {})
    await sleep(900)
    if (await overlayOpen(page)) return true
  }
  return false
}

async function clickMenuItem(page, pattern) {
  const point = await page.evaluate(([source, flags]) => {
    const rx = new RegExp(source, flags)
    for (const pane of document.querySelectorAll('.cdk-overlay-pane')) {
      const rect = pane.getBoundingClientRect()
      if (!rect.width || !rect.height) continue
      for (const element of pane.querySelectorAll('span,button,[role=menuitem],[role=option],[role=radio]')) {
        const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim()
        if (!rx.test(text)) continue
        const box = element.getBoundingClientRect()
        if (!box.width || !box.height) continue
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      }
    }
    return null
  }, [pattern.source, pattern.flags]).catch(() => null)
  if (!point) return false
  await page.mouse.click(point.x, point.y)
  return true
}

function exactName(name) {
  return new RegExp(`^${String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'i')
}

/**
 * Click the row whose text names `name`, preferring a row that STARTS with it.
 *
 * The menu's row text is not the picker's short label: a picker reading "Pro"
 * can be a row reading "Gemini 3 Pro", and the old start-anchored matcher then
 * reported a model the account offers as missing (measured 2026-11-06:
 * `model "Pro" not in the picker`). Fall back to a whole-word match.
 */
async function pickMenuItem(page, name) {
  if (await clickMenuItem(page, exactName(name))) return true
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return await clickMenuItem(page, new RegExp(`(^|[\\s(])${escaped}(?![A-Za-z0-9])`, 'i'))
}

async function setMode(page, model, effort) {
  const wantedModel = String(model || '').trim()
  const wantedEffort = String(effort || '').trim()
  if (!wantedModel && !wantedEffort) return { ok: true, state: await pickerState(page) }
  const before = await pickerState(page)
  if (wantedModel && !modelMatches(wantedModel, before)) {
    if (!(await openPicker(page))) return { ok: false, error: 'the mode picker did not open' }
    if (!(await pickMenuItem(page, wantedModel))) {
      return { ok: false, error: `model "${wantedModel}" not in the picker` }
    }
    await sleep(1200)
  }
  if (wantedEffort) {
    const now = await pickerState(page)
    if (String(now?.effort || '').toLowerCase() !== wantedEffort.toLowerCase()) {
      if (!(await openPicker(page))) return { ok: false, error: 'the mode picker did not open for the thinking level' }
      if (!(await clickMenuItem(page, /^Thinking level/i))) {
        return { ok: false, error: 'the thinking level row is not in the picker' }
      }
      await sleep(900)
      if (!(await clickMenuItem(page, exactName(wantedEffort)))) {
        return { ok: false, error: `thinking level "${wantedEffort}" not in the picker` }
      }
      await sleep(1200)
    }
  }
  return { ok: true, state: await pickerState(page) }
}

async function typePrompt(page, text) {
  const wanted = String(text).replace(/\s+/g, ' ').trim()
  const editor = page.locator('.ql-editor[contenteditable="true"]').first()
  const read = async () => (await editor.innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
  const compose = async () => {
    await editor.click({ timeout: 10_000 })
    if ((await read()) === wanted) return true
    // fill() selects all before inserting, so it REPLACES rather than appends.
    const filled = await editor.fill(String(text), { timeout: 10_000 }).then(() => true).catch(() => false)
    if (!filled || (await read()) !== wanted) {
      if (await read()) {
        await page.keyboard.press('Control+A').catch(() => {})
        await page.keyboard.press('Backspace').catch(() => {})
      }
      await page.keyboard.insertText(String(text))
    }
    return (await read()) === wanted
  }
  // A just-opened tab can re-render under the first compose and clear it;
  // one bounded retry, then refuse rather than click a send that would no-op.
  if (!(await compose()) && !(await compose())) {
    throw new Error('the composer did not hold the prompt exactly once')
  }
  await sleep(150)
  const send = page.getByRole('button', { name: /^Send message/i })
  const press = async () => {
    if (await send.count()) { await send.first().click({ timeout: 10_000 }); return }
    await page.keyboard.press('Enter')
  }
  // A click can land on a button the app is about to replace, so one re-press
  // is allowed - but only on PROOF the first press did nothing. The composer
  // can keep the text while the request is already in flight, and time alone is
  // not evidence: pressing then sends the prompt twice (found 2026-11-06).
  const userTurns = async () => (await pageTurns(page)).turns.filter(turn => turn.role === 'user').length
  const beforeSend = await userTurns().catch(() => -1)
  await press()
  await sleep(600)
  const stillHeld = (await read()) === wanted
  if (stillHeld) {
    const afterSend = await userTurns().catch(() => beforeSend)
    // A new user bubble means the press landed; only the unchanged page may be
    // pressed again. An unreadable count (-1 on either side) never re-presses.
    if (beforeSend >= 0 && afterSend >= 0 && afterSend <= beforeSend) await press()
  }
  // The mark the ChatGPT driver already emits, so a turn's cost can be split
  // the same way on both providers: receipt -> this click is bridge overhead,
  // the click -> the reply on the bus is the model's own time.
  await log('phase send clicked')
}

const PROVIDER_ERROR = /Sorry, something went wrong|encountering an error|having a hard time fulfilling/i
const providerError = text => PROVIDER_ERROR.test(String(text || ''))

async function lastAnswer(page) {
  return page.evaluate(() => {
    const text = node => (node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim()
    const answers = [...document.querySelectorAll('model-response')]
    const last = answers[answers.length - 1]
    if (!last) return { text: '', nodes: 0 }
    const content = last.querySelector('message-content')
    return { text: text(content || last).replace(/^Gemini said\s*/i, '').trim(), nodes: answers.length }
  })
}

/**
 * Did the turn actually begin?
 *
 * Any one of: a new model-response node, the Stop control appearing (the
 * client's own "generating" signal), or the URL moving to a conversation id
 * (a new chat is created server-side before the first stream frame). Absent
 * all three, the click was cosmetic and waiting would burn the whole budget
 * on a page that will never answer.
 */
async function waitForTurnStart(page, start, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await pageState(page)
    const read = await lastAnswer(page)
    if (read.nodes > start.nodes) return true
    if (state.generating) return true
    if (state.threadId && state.threadId !== start.threadId) return true
    await sleep(300)
  }
  return false
}

async function waitForAnswer(page, beforeCount, timeoutMs = SEND_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    await sleep(POLL_MS)
    const state = await pageState(page)
    const read = await lastAnswer(page)
    last = { ...state, ...read }
    if (read.nodes > beforeCount && read.text && !state.generating) return last
  }
  return last ? { ...last, timedOut: true } : { timedOut: true, text: '', nodes: 0 }
}

/* ------------------------------------------------------------------- ops */

async function warm() {
  await ensureChrome()
  await branchMasterLogin()
  return withPage(async page => {
    // An existing lane tab that still shows a composer is warm already: no
    // reload, so a returning writer keeps its thread on screen.
    if (!(await waitForComposer(page, 5_000))) await page.goto(APP, { waitUntil: 'domcontentloaded' })
    await waitForComposer(page, 30_000)
    let sign = await signedIn(page)
    if (!sign.account) {
      await page.goto(APP, { waitUntil: 'domcontentloaded' })
      await sleep(1500)
      sign = await signedIn(page)
    }
    if (!sign.account) throw new Error('the lane did not accept the master login (no Google account on the page)')
    const mode = await pickerState(page)
    return {
      ok: true, op: 'warm', lane: laneOf() || 'master', signedIn: true, plan: 'google',
      url: sign.url, model: mode?.model ?? null, effort: mode?.effort ?? null,
    }
  })
}

async function send(request) {
  return withPage(async page => {
    const wanted = typeof request.threadId === 'string' && request.threadId ? request.threadId : null
    if (wanted) {
      if (!(await openThread(page, wanted))) {
        return { ok: false, op: 'send', error: `thread ${wanted} did not load a composer`, threadId: wanted }
      }
    } else if (!/^https:\/\/gemini\.google\.com\/app\/?$/.test(page.url())) {
      // No thread means "start a new conversation". Without this the send types
      // into whatever conversation the tab happens to show, which is how two
      // fresh bridges were primed into ONE thread (measured 2026-11-05: both
      // newBridge calls returned the same conversation id).
      await page.goto(APP, { waitUntil: 'domcontentloaded' })
      await waitForComposer(page, 30_000)
    }
    // Refuse to type into a tab whose previous turn never finished: measured
    // 2026-11-05, such a tab accepts text, adds the user bubble, and then never
    // starts a stream - the Stop control stays forever and no answer is ever
    // rendered. The window is the broken part; the host recycles it.
    const start = await pageState(page)
    if (start.generating) {
      return { ok: false, op: 'send', reason: 'page-load-error', threadId: start.threadId ?? wanted, error: 'the page was still generating a previous turn' }
    }
    const composed = await withFocus(page, async () => {
      const mode = await setMode(page, request.model ?? MODEL_WANTED, request.effort ?? EFFORT_WANTED)
      if (mode.ok !== true) return { mode }
      const before = await lastAnswer(page)
      await typePrompt(page, String(request.text ?? ''))
      return { mode, before }
    })
    if (composed.mode.ok !== true) return { ok: false, op: 'send', error: composed.mode.error, threadId: wanted }
    const before = composed.before
    const acceptedAt = Date.now()
    // Acceptance is not a turn. Gemini's client occasionally takes the click,
    // prints the user bubble, and never issues the generation request, so the
    // Stop control is the only sign that anything is happening. Require one of
    // the three real signals before spending the reply budget waiting.
    const started = await waitForTurnStart(page, { nodes: before.nodes, threadId: start.threadId })
    if (!started) {
      const now = await pageState(page)
      return {
        ok: false, op: 'send', reason: 'page-load-error', acceptedAt,
        threadId: now.threadId ?? wanted,
        error: 'the page accepted the text but never started generating',
      }
    }
    const answer = await waitForAnswer(page, before.nodes)
    const state = await pageState(page)
    const modeNow = await pickerState(page)
    if (answer.timedOut || !answer.text) {
      return { ok: false, op: 'send', timedOut: true, threadId: state.threadId ?? wanted, acceptedAt, model: modeNow?.model ?? null, effort: modeNow?.effort ?? null }
    }
    const turns = await pageTurns(page)
    const users = turns.turns.filter(turn => turn.role === 'user').length
    if (providerError(answer.text)) {
      return {
        ok: false, op: 'send', reason: 'provider-error', text: answer.text, acceptedAt,
        threadId: state.threadId ?? wanted,
        model: modeNow?.model ?? null, effort: modeNow?.effort ?? null,
      }
    }
    return {
      ok: true, op: 'send',
      text: answer.text,
      threadId: state.threadId ?? wanted,
      ownNodeId: state.threadId ? `u${Math.max(0, users - 1)}` : null,
      model: modeNow?.model ?? null,
      effort: modeNow?.effort ?? null,
      at: new Date().toISOString(),
    }
  })
}

/**
 * The tab a thread-scoped read should look at: the one that shows the thread
 * if any does, else this request's own tab (which then reports other-thread).
 */
async function withThreadPage(threadId, operation) {
  return withPage(async (page, context) => operation(pageShowing(context, threadId) ?? page, context))
}

async function status(request) {
  const wanted = typeof request.threadId === 'string' ? request.threadId.toLowerCase() : null
  return withThreadPage(wanted, async page => {
    const state = await pageState(page)
    const mode = await pickerState(page)
    const base = {
      ok: true, op: 'status',
      threadId: wanted ?? state.threadId,
      pushedThreadId: state.threadId,
      matchesThread: wanted && state.threadId ? state.threadId === wanted : null,
      phase: state.generating ? 'streaming' : null,
      ageMs: null,
      at: new Date().toISOString(),
      model: mode?.model ?? null,
      effort: mode?.effort ?? null,
      url: state.url,
    }
    if (wanted && state.threadId && state.threadId !== wanted) return { ...base, state: 'other-thread', cost: 'page' }
    if (request.deep === true) {
      const turns = await pageTurns(page)
      const last = [...turns.turns].reverse().find(turn => turn.role === 'assistant')
      return {
        ...base, cost: 'conversation',
        state: state.generating ? 'generating' : 'idle',
        latestAssistant: last ? { nodeId: null, complete: !state.generating, chars: last.text.length, files: [] } : null,
      }
    }
    return { ...base, state: state.generating ? 'generating' : 'idle', cost: 'page' }
  })
}

/**
 * Read one thread's transcript.
 *
 * Gemini's transcript is the DOM, so the read needs a tab that shows the
 * thread. Any tab already on it is read where it stands (this lane's own tab
 * first). With none, a request that says `open: true` - a delivery read, which
 * the host sends inside the writer's lane - navigates THIS lane's tab to the
 * thread; it is dispatched on the lane's own chain, so it never navigates under
 * that lane's own send. Anything else (observation) answers `not-open` rather
 * than moving a tab: an observation pass must not cost a page load, and a
 * thread nobody has on screen has nothing new for it.
 */
async function conversation(request) {
  return withPage(async (page, context) => {
    const wanted = typeof request.threadId === 'string' && request.threadId ? request.threadId.toLowerCase() : null
    let target = wanted ? pageShowing(context, wanted) : page
    if (!target && request.open === true) {
      if (await openThread(page, wanted)) target = page
    }
    if (!target) {
      return { ok: false, op: 'conversation', reason: 'not-open', error: `no tab shows thread ${wanted}`, threadId: wanted }
    }
    const state = await pageState(target)
    const shown = wanted ?? state.threadId
    if (shown && state.threadId && shown !== state.threadId) {
      return { ok: false, op: 'conversation', reason: 'not-open', error: `the page is on another thread (${state.threadId})`, threadId: shown }
    }
    const turns = await pageTurns(target)
    return { ok: true, op: 'conversation', conversation: conversationOf(shown, turns.turns, turns.pending), threadId: shown }
  })
}

async function threads() {
  return withPage(async page => {
    const rows = await page.evaluate(() => {
      const text = node => (node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim()
      return [...document.querySelectorAll('a[href*="/app/"]')]
        .map(link => {
          const match = /\/app\/([A-Za-z0-9_-]{4,128})/.exec(link.getAttribute('href') || '')
          return match ? { id: match[1], title: text(link).slice(0, 200) } : null
        })
        .filter(Boolean)
    })
    const seen = new Set()
    return { ok: true, op: 'threads', threads: rows.filter(row => !seen.has(row.id) && seen.add(row.id)) }
  })
}

async function read() {
  return withPage(async page => {
    const answer = await lastAnswer(page)
    const state = await pageState(page)
    return { ok: true, op: 'read', text: answer.text, threadId: state.threadId }
  })
}

async function use(request) {
  const threadId = String(request.threadId ?? '')
  if (!THREAD.test(`/app/${threadId}`)) return { ok: false, op: 'use', error: 'threadId must be a Gemini conversation id' }
  return withPage(async page => {
    const loaded = await openThread(page, threadId)
    return loaded ? { ok: true, op: 'use', threadId } : { ok: false, op: 'use', error: `thread ${threadId} did not load`, threadId }
  })
}

async function recover() {
  return withPage(async page => {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForComposer(page, 60_000)
    return { ok: true, op: 'recover', threadId: threadOfUrl(page.url()) }
  })
}

async function unload() {
  // A shared lane may have relaunched the master browser itself. That browser
  // belongs to every lane and to the operator: closing a lane must never kill
  // it (2026-11-04: an idle lane closed the master Chrome mid-turn).
  if (LANE_SHARED) {
    const lane = laneOf()
    // No lane means a host-level unload: the master browser is never closed.
    if (!lane) return { ok: true, op: 'unload', state: 'unloaded', sharedBrowser: true, tabClosed: false }
    // Drop the lease FIRST: if the close fails, the stale lease lets the next
    // sweep clean the orphan. Same order as the ChatGPT driver.
    await rm(join(LANE_LEASE_DIR, `${lane}.json`), { force: true }).catch(() => {})
    const known = LANE_PAGES.get(lane)
    LANE_PAGES.delete(lane)
    LANE_SEEN.delete(lane)
    let tabClosed = false
    try {
      if (known && !known.isClosed()) {
        await known.close().catch(() => {})
        tabClosed = true
      }
      // A retry can leave more than one tab carrying the lane's name; close
      // every one, not just the page this process remembered.
      const { context } = await sharedConnection()
      for (const candidate of context.pages()) {
        if (candidate.isClosed()) continue
        if (await tabNameOf(candidate) === `${LANE_TAB_PREFIX}${lane}`) { await candidate.close().catch(() => {}); tabClosed = true }
      }
    } catch (error) { await log(`shared unload found no browser: ${error.message}`) }
    return { ok: true, op: 'unload', state: 'unloaded', sharedBrowser: true, tabClosed, cookiesSynced: null }
  }
  const { browser, context } = await connect()
  let synced = null
  try {
    synced = await syncBackCookies(context).catch(error => { log(`cookie write-back failed: ${error.message}`); return null })
  } finally { await browser.close().catch(() => {}) }
  if (!LANE_ID || !launched) return { ok: true, op: 'unload', state: 'unloaded', cookiesSynced: synced }
  const child = launched
  launched = null
  await new Promise(resolve => {
    child.once('exit', resolve)
    try { child.kill() } catch { resolve() }
    setTimeout(resolve, 10_000)
  })
  return { ok: true, op: 'unload', state: 'unloaded', cookiesSynced: synced }
}

async function mode(request) {
  return withPage(async page => {
    const result = await withFocus(page, () => setMode(page, request.model, request.effort))
    return result.ok === true
      ? { ok: true, op: 'mode', model: result.state?.model ?? null, effort: result.state?.effort ?? null, label: result.state?.label ?? null }
      : { ok: false, op: 'mode', error: result.error }
  })
}

/* ---------------------------------------------------------------- dispatch */

/**
 * Lane-wide sweep: the host's list of live lanes is authoritative, and every
 * other lane tab in this browser is closed. Never starts Chrome.
 */
async function sweepLanes(request) {
  if (!LANE_SHARED) return { ok: true, op: 'sweep-lanes', closed: 0, sharedBrowser: false }
  if (!Array.isArray(request.keep)) return { ok: false, op: 'sweep-lanes', error: 'keep must be a list of lane ids' }
  if (!(await portAnswers(CONNECT_PORT))) return { ok: true, op: 'sweep-lanes', closed: 0, browser: 'down' }
  const { context } = await sharedConnection()
  const closed = await sweepLaneTabs(context, { keep: new Set(request.keep.map(String)) })
  return { ok: true, op: 'sweep-lanes', closed, lanes: [...LANE_PAGES.keys()] }
}

/**
 * Ops that run at once instead of on their lane's chain. A conversation read
 * that may NAVIGATE (`open: true`) is not one of them: it moves its lane's tab,
 * so it waits behind that lane's own send.
 */
const CONCURRENT = new Set(['status', 'conversation', 'threads', 'read', 'ping', 'sweep-lanes'])
const isConcurrent = request => CONCURRENT.has(request.op) && !(request.op === 'conversation' && request.open === true)
const handlers = {
  ping: async () => ({ ok: true, op: 'ping' }),
  warm, send, status, conversation, threads, read, use, recover, unload, mode,
  'sweep-lanes': sweepLanes,
}

/**
 * One serial chain per LANE, not per process: the process serves every
 * inputter's tab, so two writers never wait for each other, while one writer's
 * mutations still never interleave. Every request runs inside its lane's
 * context, so everything below resolves to the right tab.
 */
function createDispatcher({ run, emit }) {
  const chains = new Map()
  return (request, id) => {
    const lane = typeof request?.lane === 'string' ? request.lane : ''
    const execute = () => LANE_CTX.run(lane, () => run(request)).then(
      result => { emit({ ...result, id }); return result },
      error => { emit({ ok: false, op: request.op, id, error: error.message }); return null },
    )
    if (isConcurrent(request)) { void execute(); return }
    const next = (chains.get(lane) ?? Promise.resolve()).then(execute, execute).then(() => undefined)
    chains.set(lane, next)
    // Forget a drained chain so a lane that is gone does not keep an entry.
    void next.then(() => { if (chains.get(lane) === next) chains.delete(lane) })
  }
}

function serve() {
  const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`)
  const dispatch = createDispatcher({
    run: async request => {
      const handler = handlers[request.op]
      if (!handler) return { ok: false, op: request.op, error: `unknown op ${request.op}` }
      return handler(request)
    },
    emit,
  })
  const rl = createInterface({ input: process.stdin })
  let id = 0
  rl.on('line', line => {
    if (!line.trim()) return
    let request
    try { request = JSON.parse(line) } catch { emit({ ok: false, op: '?', error: 'not JSON' }); return }
    if (request.op === 'quit') { emit({ ok: true, op: 'quit' }); setTimeout(() => process.exit(0), 50); return }
    dispatch(request, request.id ?? ++id)
  })
  log(`driver ready on port ${PORT} (lane ${LANE_ID || 'master'})`)
}

const which = process.argv[2] || 'serve'
if (which === 'serve') serve()
else if (which === 'mode') mode({ model: process.argv[3], effort: process.argv[4] }).then(result => { console.log(JSON.stringify(result)); process.exit(result.ok ? 0 : 1) })
else if (which === 'warm') warm().then(result => { console.log(JSON.stringify(result)); process.exit(result.ok ? 0 : 1) })
else if (which === 'send') send({ text: process.argv.slice(3).join(' ') }).then(result => { console.log(JSON.stringify(result)); process.exit(result.ok ? 0 : 1) })
else { console.error(`unknown command ${which}`); process.exit(2) }
