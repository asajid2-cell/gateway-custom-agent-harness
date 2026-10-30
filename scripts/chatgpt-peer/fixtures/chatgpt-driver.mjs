#!/usr/bin/env node
/**
 * Drive the real chatgpt.com web UI through a headful Chrome with a dedicated
 * profile. Headful is deliberate: Cloudflare challenges headless far more often.
 *
 * Commands:
 *   node chatgpt.mjs check            launch, report page/login state, close
 *   node chatgpt.mjs login            launch, wait for you to sign in, leave open
 *   node chatgpt.mjs status           attach, print URL/login/model
 *   node chatgpt.mjs ask "text" [--new]   one question, print the reply
 *   node chatgpt.mjs chat             interactive REPL
 *   node chatgpt.mjs quit             close the Chrome we launched
 *
 * Nothing here reads cookies or tokens. It only types into the page and reads
 * the rendered assistant text.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import readline from 'node:readline'

const HOME = os.homedir()
const BASE = path.join(HOME, '.chatgpt-web')
// The host owns the profile path and passes it down, so the thread a restart
// resumes is the one in the profile it advertises. There is deliberately no
// default: a driver launched without the profile would open a second identity.
const PROFILE = process.env.CHATGPT_PROFILE || ''
if (!PROFILE) {
  throw new Error('CHATGPT_PROFILE is required: the host owns the Chrome profile path and this driver has no default profile')
}
const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024
const PID_FILE = path.join(BASE, 'chrome.pid')
const LOG = path.join(BASE, 'driver.log')
const PORT = Number(process.env.CHATGPT_CDP_PORT || 9222)
const CHAT_URL = 'https://chatgpt.com/'
const MAX_REPLY = 63_000 // bus messages cap at 64 KiB

/**
 * Is this page ChatGPT, by origin rather than by substring?
 *
 * `url().includes('chatgpt.com')` answers yes for
 * `https://notchatgpt.com.evil.example/`, and a tab like that would receive the
 * typed text and the in-page backend reads (the bearer token never leaves the
 * page, but the fetch is made by whatever page it is). Compare the parsed
 * origin instead: https, host exactly chatgpt.com, no port, no userinfo.
 */
function isChatGPTUrl(raw) {
  let url
  try { url = new URL(String(raw)) } catch { return false }
  return url.protocol === 'https:' && url.origin === 'https://chatgpt.com'
}

/**
 * The thread this driver is currently working on, when the page has more than
 * one ChatGPT tab open. `use` sets it to the thread it adopted or navigated to,
 * and `send` sets it to the thread it posted into, so every later op lands on
 * the same tab instead of guessing from tab order. Null means "no preference":
 * fall back to the first ChatGPT page, which is what one-tab use has always
 * done.
 */
let ACTIVE_THREAD = null

/**
 * Cap a reply by its UTF-8 length, not its JavaScript length.
 *
 * String length counts UTF-16 code units: 63,000 of them can be well over the
 * 64 KiB the transport accepts once non-ASCII prose is encoded, and the send
 * then fails after the page turn has already been spent.
 */
function clampReply(text, max = MAX_REPLY) {
  if (Buffer.byteLength(text, 'utf8') <= max) return text
  let end = text.length
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > max) {
    end -= Math.max(1, Math.floor(end / 64))
  }
  return text.slice(0, end)
}
const SEND_TIMEOUT_MS = Number(process.env.CHATGPT_TIMEOUT_MS || 240_000)

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/**
 * Decode a field the caller called base64, or refuse it.
 *
 * `Buffer.from(value, 'base64')` skips every character it does not recognise,
 * so `%%%%` decodes to zero bytes and the upload reports `attached` for a file
 * that does not exist. Accept only canonical base64 (alphabet, padding, and a
 * re-encode that reproduces the input exactly), check the size cap from the
 * encoded length before allocating, and check it again after decoding.
 */
function decodeBase64(value, label = 'attachment') {
  if (typeof value !== 'string' || !value) throw new Error(`${label}: no base64 payload was supplied`)
  // A caller may wrap long lines; whitespace is not part of the encoding.
  const text = value.replace(/\s+/g, '')
  if (!text || !BASE64.test(text)) throw new Error(`${label}: the payload is not canonical base64`)
  const padding = (text.match(/=+$/) || [''])[0].length
  const estimated = Math.floor(text.length * 3 / 4) - padding
  if (estimated > MAX_ATTACHMENT_BYTES) throw new Error(`${label}: ${estimated} bytes exceeds the ${MAX_ATTACHMENT_BYTES}-byte cap`)
  const buffer = Buffer.from(text, 'base64')
  if (buffer.toString('base64') !== text) throw new Error(`${label}: the base64 payload is not canonical (round-trip mismatch)`)
  if (buffer.length > MAX_ATTACHMENT_BYTES) throw new Error(`${label}: ${buffer.length} bytes exceeds the ${MAX_ATTACHMENT_BYTES}-byte cap`)
  return buffer
}

const require = createRequire(import.meta.url)

function loadPlaywright() {
  const candidates = [
    path.join(BASE, 'node_modules', 'playwright-core'),
    'C:/Users/Ahmed/301/watch-together-lanes/htv-memory-resume/node_modules/playwright-core',
    path.join(HOME, 'muxdiag/restored/node_modules/playwright-core'),
    path.join(HOME, 'muxdiag/redwt/node_modules/playwright-core'),
  ]
  for (const candidate of candidates) {
    try { return require(candidate) } catch {}
  }
  throw new Error('playwright-core not found; npm i playwright-core in ' + BASE)
}

/**
 * The first Chrome executable that is actually there.
 *
 * `.find(Boolean)` was always true on the first candidate, so a machine without
 * Chrome in Program Files never tried the 32-bit or per-user install - and the
 * failure surfaced as a spawn error instead of "not installed". Probe in order
 * and check the file exists.
 *
 * `CHATGPT_CHROME` pins the executable when the host sets it. It is a launch
 * decision and nothing else: it is not identity, so it is never written into
 * the launch marker or the install record, and the owner proof after a spawn
 * still decides whether the browser that answered is ours.
 */
async function chromePath() {
  const override = String(process.env.CHATGPT_CHROME ?? '').trim()
  if (override) {
    const info = await fs.stat(override).catch(() => null)
    if (!info?.isFile()) throw new Error(`CHATGPT_CHROME is set to ${override}, which is not a file`)
    return override
  }
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : '',
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      const info = await fs.stat(candidate)
      if (info.isFile()) return candidate
    } catch { /* try the next install location */ }
  }
  throw new Error(`Chrome not found: none of these exist: ${candidates.join(', ')}`)
}

/** Where this driver records the browser it launched, so a restart can prove it. */
const LAUNCH_FILE = path.join(PROFILE, 'driver-launch.json')
/**
 * The same claim made once per install, so a deleted or hand-replaced marker
 * still has a record of the browser GUID this install actually launched.
 */
const INSTALL_FILE = path.join(PROFILE, 'driver-install.json')

/**
 * The browser GUID a DevTools URL names.
 *
 * A pid is not a browser identity: Chrome re-execs itself, so the pid the
 * spawn recorded is usually not the one that ends up owning the port, and a
 * dead pid proves nothing except that its number is free. The GUID in
 * `/json/version`'s `webSocketDebuggerUrl`
 * (`ws://host:port/devtools/browser/<guid>`) survives a re-exec and cannot be
 * reused by another browser.
 */
function parseBrowserUrl(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return null
  let url
  try { url = new URL(text) } catch { return null }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null
  const match = /^\/devtools\/browser\/([A-Za-z0-9-]{8,64})\/?$/.exec(url.pathname)
  if (!match) return null
  return { url: `${url.protocol}//${url.host}/devtools/browser/${match[1]}`, guid: match[1] }
}

/** The same profile directory, spelled differently (Windows paths ignore case). */
function samePath(a, b) {
  const tidy = value => path.normalize(String(value)).replace(/[\\/]+$/, '').toLowerCase()
  return tidy(a) === tidy(b)
}

/** The browser GUID this endpoint serves, or null when it is not a DevTools browser. */
async function browserIdentity() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) })
    if (!response.ok) return null
    const text = await response.text()
    if (text.length > 16_384) return null
    return parseBrowserUrl(JSON.parse(text)?.webSocketDebuggerUrl)
  } catch { return null }
}

async function readRecord(file) {
  try {
    const record = JSON.parse(await fs.readFile(file, 'utf8'))
    return record && typeof record === 'object' ? record : null
  } catch { return null }
}

const readLaunchMarker = () => readRecord(LAUNCH_FILE)
const readInstallRecord = () => readRecord(INSTALL_FILE)

async function writeRecord(file, record) {
  await fs.mkdir(PROFILE, { recursive: true }).catch(() => {})
  await fs.writeFile(file, JSON.stringify(record)).catch(() => {})
}

async function writeLaunchMarker(pid, served = null) {
  await writeRecord(LAUNCH_FILE, {
    pid: Number(pid) || null,
    port: PORT,
    profile: PROFILE,
    browserUrl: served?.url ?? null,
    at: new Date().toISOString(),
  })
}

async function writeInstallRecord(pid, served = null) {
  await writeRecord(INSTALL_FILE, {
    pid: Number(pid) || null,
    profile: PROFILE,
    browserUrl: served?.url ?? null,
    at: new Date().toISOString(),
  })
}

/**
 * Does the process that owns the port carry THIS profile's exact
 * `--user-data-dir` on its command line?
 *
 * The only evidence a pid cannot forge: the same install seen from the process
 * table. Quoted, forward-slash and trailing-separator spellings are the same
 * profile (Windows paths ignore case).
 */
function ownerCarriesProfile(owner, profile) {
  const tidy = value => String(value).replace(/"/g, '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  const line = typeof owner?.commandLine === 'string' ? tidy(owner.commandLine) : ''
  return line.includes(`--user-data-dir=${tidy(profile)}`)
}

/**
 * Is the debugger answering on this port the browser this driver launched?
 *
 * Pure: every fact is an argument, so the answer can be proved without a
 * browser. The evidence order is the confidence order - a recorded browser
 * GUID is decisive either way; a marker naming another port or profile is
 * refused; with no GUID anywhere, the port owner's own command line is the
 * only real evidence a pre-record install can offer; a bare pid is never
 * enough, alive or dead.
 */
function attachVerdict({ served, marker, install, owner, port, profile }) {
  if (!served || !served.guid) {
    return { ok: false, why: `port ${port} answers, but not as a Chrome DevTools browser; refusing to attach` }
  }
  if (marker) {
    const namesOtherPort = marker.port !== undefined && marker.port !== null && Number(marker.port) !== Number(port)
    const namesOtherProfile = typeof marker.profile === 'string' && marker.profile !== '' && !samePath(marker.profile, profile)
    if (namesOtherPort || namesOtherProfile) {
      return { ok: false, why: `port ${port} answers, but this driver recorded its browser on port ${marker.port} profile ${marker.profile}; refusing to attach` }
    }
    const recorded = parseBrowserUrl(marker.browserUrl)
    if (recorded) {
      return recorded.guid === served.guid
        ? { ok: true, pid: Number(marker.pid) || null, how: 'launch marker' }
        : { ok: false, why: `port ${port} is served by browser ${served.guid}, but this driver launched ${recorded.guid}; refusing to attach` }
    }
  }
  // No GUID in the marker: it predates the GUID record, or was written by hand.
  // The install record is the next real evidence, then the port owner itself.
  const installed = parseBrowserUrl(install?.browserUrl)
  if (installed) {
    return installed.guid === served.guid
      ? { ok: true, pid: Number(install.pid) || null, how: 'install record' }
      : { ok: false, why: `port ${port} is served by browser ${served.guid}, but this install recorded ${installed.guid}; refusing to attach` }
  }
  // The port owner is the fallback for an install that recorded no GUID. Its
  // command line must carry THIS profile's exact --user-data-dir: the same
  // install, seen from the only side that cannot be forged by a pid.
  if (ownerCarriesProfile(owner, profile)) return { ok: true, pid: Number(owner?.pid) || null, how: 'port owner command line' }
  return { ok: false, why: `port ${port} is held by a browser that is not this driver's (profile ${profile}); refusing to attach` }
}

/**
 * The process that owns the listening port, with its command line.
 *
 * Only a pre-record install ever needs this, and only on Windows (the driver
 * ships Chrome paths and taskkill for Windows only). A null answer is not
 * evidence of ownership, so the caller refuses.
 */
async function portOwner() {
  if (process.platform !== 'win32') return null
  const script = [
    `$conn = Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1`,
    'if (-not $conn) { return }',
    `$proc = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $conn.OwningProcess)`,
    'if (-not $proc) { return }',
    'Write-Output ([string]$conn.OwningProcess)',
    'Write-Output ([string]$proc.CommandLine)',
  ].join('\n')
  const out = await new Promise(resolve => {
    let text = ''
    let settled = false
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value) } }
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    const timer = setTimeout(() => { child.kill(); finish('') }, 5_000)
    child.stdout.on('data', chunk => { text += chunk; if (text.length > 32_000) { child.kill(); finish('') } })
    child.on('error', () => finish(''))
    child.on('close', () => finish(text))
  })
  const lines = String(out).split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const pid = Number(lines[0])
  if (!Number.isInteger(pid) || pid <= 0 || lines.length < 2) return null
  return { pid, commandLine: lines.slice(1).join(' ') }
}

async function log(line) {
  await fs.mkdir(BASE, { recursive: true }).catch(() => {})
  await fs.appendFile(LOG, `${new Date().toISOString()} ${line}\n`).catch(() => {})
}

async function cdpUp() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) })
    return response.ok
  } catch { return false }
}

/**
 * The debugger on this port, proven to be the browser this driver launched.
 *
 * This is the ONE ownership check, and EVERY connection goes through it -
 * attach, backend reads, status, the observer, file downloads. A check that
 * only `ensureChrome` performs is a check that reads bypass: a read that called
 * `connect()` directly would attach to whatever Chromium owns the port (a
 * second browser, the user's own debugger) and type into, or read, an account
 * this driver does not own. Returns null when nothing is listening, throws when
 * the listener is not ours.
 */
async function ownedDebugger() {
  if (!(await cdpUp())) return null
  const served = await browserIdentity()
  const marker = await readLaunchMarker()
  const install = await readInstallRecord()
  const recorded = parseBrowserUrl(marker?.browserUrl) ?? parseBrowserUrl(install?.browserUrl)
  // Reading another process's command line costs a PowerShell round trip, so
  // only an install with no GUID on record pays for it.
  const owner = served && !recorded ? await portOwner() : null
  const verdict = attachVerdict({ served, marker, install, owner, port: PORT, profile: PROFILE })
  if (!verdict.ok) throw new Error(verdict.why)
  // Rewrite the record when it changed hands or when the marker has no GUID yet
  // (a hand-written or pre-GUID marker), so the expensive evidence is needed
  // once per install, not once per connection.
  if (verdict.how !== 'launch marker' || !parseBrowserUrl(marker?.browserUrl)) {
    await writeLaunchMarker(verdict.pid, served)
    await writeInstallRecord(verdict.pid, served)
    await log(`attached to the debugger on port ${PORT} by ${verdict.how} (browser ${served.guid ?? 'unknown'})`)
  }
  return { pid: verdict.pid, served, how: verdict.how }
}

/**
 * Connect over CDP, but only after ownership is proven. The only CDP door.
 *
 * Decision (round 5): there is no private or authenticated debugging endpoint
 * to ask for, so profile-proof ownership is the ceiling. CDP's HTTP endpoint
 * has no auth primitive at all - anything that can reach the port is the
 * browser. Loopback binding is the only exposure control Chrome offers and it
 * is already in force (the default is 127.0.0.1, and Chrome requires a
 * dedicated --user-data-dir before it opens the port at all). The alternative,
 * `--remote-debugging-pipe`, is not usable here: Playwright's connectOverCDP
 * speaks the HTTP/WebSocket endpoint and cannot be handed a pair of inherited
 * pipe handles. So the defence is what this function does - prove the listener
 * is the browser this install launched, and refuse everything else.
 */
async function connectOwned(ms = 0) {
  const owned = await ownedDebugger()
  if (!owned) throw new Error(`chrome is not running on port ${PORT}`)
  const { chromium } = loadPlaywright()
  const attach = chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  return ms > 0 ? await cdpTimed(attach, ms) : await attach
}

/**
 * Is the debugger that just appeared on the port the browser this launch
 * started?
 *
 * A launch is not proof of ownership by itself: between `spawn` and the first
 * `/json/version` answer another browser can bind the port, and whatever
 * answers first would then be recorded as this driver's identity forever. So
 * the first GUID after a launch is only recorded when the port owner's own
 * command line names this install's exact profile - the same evidence the
 * no-record adoption path uses. `retry` covers the window where Chrome has
 * bound the port but the process table has not caught up yet.
 */
function launchVerdict({ served, owner, profile, port }) {
  if (!served || !served.guid) return { ok: false, retry: true }
  if (!owner) return { ok: false, retry: true }
  if (!ownerCarriesProfile(owner, profile)) {
    return {
      ok: false,
      retry: false,
      why: `port ${port} answered as browser ${served.guid}, but it is owned by pid ${owner.pid ?? 'unknown'}, whose command line does not carry --user-data-dir=${profile}; refusing to adopt it as this driver's browser`,
    }
  }
  return { ok: true, retry: false, pid: Number(owner.pid) || null }
}

/** How long a launched browser has to prove itself before the window is spent. */
const LAUNCH_PROOF_ATTEMPTS = 6
const LAUNCH_PROOF_WINDOW_MS = 3_000

/**
 * The failure for a launch window that ran out before the port's owner could
 * be proven.
 *
 * Deliberately NOT the refusal wording. A refusal says the port belongs to a
 * browser that is not this install's; this says none of this install's has
 * answered yet, and names the last owner it saw so the two are told apart from
 * the log alone without reading the code.
 */
function exhaustedLaunchWhy({ port, served, owner, waitedMs }) {
  const seen = served?.guid ? `answered as browser ${served.guid}` : 'answered without a browser GUID'
  const who = owner?.pid ? `pid ${owner.pid}` : 'an owner that could not be read'
  const waited = (Math.round(Number(waitedMs || 0) / 100) / 10).toFixed(1)
  return `port ${port} ${seen}, but ${who} could not be proven to be this install's browser within ${waited} s; no browser of this install has answered yet, so nothing was adopted`
}

async function ensureChrome({ visible = true } = {}) {
  const owned = await ownedDebugger()
  if (owned) return { spawned: false, pid: owned.pid }
  const exe = await chromePath()
  if (String(process.env.CHATGPT_CHROME ?? '').trim()) {
    await log(`spawning ${exe} by CHATGPT_CHROME override (a launch decision, not recorded as identity)`)
  }
  await fs.mkdir(PROFILE, { recursive: true })
  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-default-apps',
    '--disable-component-update',
    '--disable-background-networking',
    '--disable-sync',
    '--mute-audio',
    '--metrics-recording-only',
    '--disable-features=Translate,MediaRouter,OptimizationHints,AcceptCHFrame,InterestFeedContentSuggestions,CalculateNativeWinOcclusion',
    '--window-size=900,760',
    '--window-position=80,60',
    CHAT_URL,
  ]
  if (!visible) args.unshift('--headless=new')
  if (process.env.CHATGPT_DISABLE_GPU !== '0') args.push('--disable-gpu')
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' })
  // A path that exists but cannot run (ENOENT after a race, EACCES, a broken
  // install) arrives asynchronously as `error`. Without this the loop below just
  // waits out its minute and reports the wrong cause.
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', error => reject(new Error(`could not launch Chrome at ${exe}: ${error.message}`)))
  })
  child.unref()
  await fs.writeFile(PID_FILE, String(child.pid)).catch(() => {})
  await log(`spawned chrome pid=${child.pid} headful=${visible}`)
  let attempts = 0
  let proofStartedAt = 0
  let last = { served: null, owner: null }
  for (let i = 0; i < 60; i++) {
    if (await cdpUp()) {
      // Record what the browser SERVES now, not the pid this process spawned:
      // Chrome may already have re-exec'd, and a later attach keys on the GUID.
      // A GUID is only recorded once the port's owner is proven to be this
      // install - anything else that binds the port in this window is refused.
      const served = await browserIdentity()
      // Read the owner even when nothing served a GUID: if this window runs out,
      // the failure has to name who was holding the port, or "no browser yet"
      // reads exactly like "wrong browser".
      const owner = await portOwner()
      const verdict = launchVerdict({ served, owner, profile: PROFILE, port: PORT })
      if (verdict.ok) {
        await writeLaunchMarker(verdict.pid ?? child.pid, served)
        await writeInstallRecord(verdict.pid ?? child.pid, served)
        return { spawned: true, pid: child.pid }
      }
      if (!verdict.retry) throw new Error(verdict.why)
      // The port answers but the owner cannot be named yet. Bound the window by
      // attempts AND wall clock: a listener that never becomes provable is not
      // this driver's, and adopting it would be the guess this check prevents.
      last = { served, owner }
      attempts += 1
      if (!proofStartedAt) proofStartedAt = Date.now()
      const waited = Date.now() - proofStartedAt
      if (attempts >= LAUNCH_PROOF_ATTEMPTS || waited >= LAUNCH_PROOF_WINDOW_MS) {
        throw new Error(exhaustedLaunchWhy({ port: PORT, served: last.served, owner: last.owner, waitedMs: waited }))
      }
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('Chrome did not open the debugging port')
}

async function connect() {
  const browser = await connectOwned()
  const context = browser.contexts()[0] ?? await browser.newContext()
  const pages = context.pages()
  // Prefer the tab the caller adopted: a bridge can point at a thread the user
  // already has open, and sending into a different tab would post into the
  // wrong conversation. With no preference, the first ChatGPT tab wins.
  let page = ACTIVE_THREAD
    ? pages.find(p => isChatGPTUrl(p.url()) && (threadOf(p.url()) || '').toLowerCase() === ACTIVE_THREAD.toLowerCase())
    : null
  // Never a lookalike host: a tab that merely contains the string
  // "chatgpt.com" is a different origin and must not receive our text.
  if (!page) page = pages.find(p => isChatGPTUrl(p.url()))
  if (!page) page = pages[0] ?? await context.newPage()
  return { browser, context, page }
}

async function pageState(page) {
  return page.evaluate(async () => {
    const text = (document.body?.innerText || '').toLowerCase()
    const composer = !!document.querySelector('#prompt-textarea, div.ProseMirror[contenteditable="true"], textarea[data-testid="prompt-textarea"]')
    const modelButton = document.querySelector('button[aria-label*="Select ChatGPT model" i], [data-testid="model-switcher-dropdown"]')
    const challenge = /just a moment|verify you are human|unusual activity|checking your browser/i.test(text)
    const model = modelButton ? (modelButton.innerText || '').replace(/\s+/g, ' ').trim() : ''
    let loggedIn = false
    let email = null
    let plan = null
    try {
      const response = await fetch('/api/auth/session', { credentials: 'include' })
      const session = await response.json()
      loggedIn = !!session?.user
      email = session?.user?.email ?? null
      plan = session?.account?.planType ?? null
    } catch {}
    return { url: location.href, title: document.title, composer, challenge, model, loggedIn, email, plan }
  })
}

async function waitForLogin(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const state = await pageState(page).catch(() => null)
    if (state?.loggedIn) return state
    const now = state ? `${state.url} composer=${state.composer} loggedIn=${state.loggedIn} challenge=${state.challenge}` : 'page unavailable'
    if (now !== last) { last = now; process.stderr.write(`[waiting] ${now}\n`) }
    await new Promise(resolve => setTimeout(resolve, 1500))
  }
  throw new Error('Timed out waiting for a signed-in ChatGPT page')
}

const COMPOSER = ['#prompt-textarea', 'div.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"]', 'textarea[data-testid="prompt-textarea"]']
const SEND = ['button[aria-label="Send" i]', '[data-testid="send-button"]', 'button[aria-label*="Send prompt" i]']
const STOP = ['[data-testid="stop-button"]', 'button[aria-label*="Stop" i]']

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const nodes = page.locator(selector)
    const count = await nodes.count().catch(() => 0)
    // Not .last(): the page keeps hidden zero-size copies of the same node
    // (an offscreen composer, an inactive stop button), and the last match is
    // often one of those. The first match that is actually on screen is the one
    // a person could click.
    for (let index = 0; index < count; index++) {
      const node = nodes.nth(index)
      if (await node.isVisible().catch(() => false)) return node
    }
  }
  return null
}

/**
 * The composer is not there the instant /api/auth/session answers: a fresh
 * navigation reports loggedIn before the SPA renders its input. Poll instead of
 * failing once, because the only thing a single check detects is load timing.
 */
async function waitForComposer(page, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  do {
    const composer = await firstVisible(page, COMPOSER)
    if (composer) return composer
    await new Promise(resolve => setTimeout(resolve, 300))
  } while (Date.now() < deadline)
  return null
}

const ASSISTANT = '[data-markdown-text-style="assistant-message"]'
/** The person's own messages: the node a successful send adds. */
const USER_MESSAGE = '[data-message-author-role="user"]'

/**
 * Is the page still working?
 *
 * The "stop" control is not a reliable proxy on its own: this build keeps a
 * zero-size Stop button in the DOM between turns, so a presence check reports
 * "still generating" on a finished answer and the reply wait never ends. Ask
 * for a stop control that is actually visible, plus the turn-state attribute.
 */
const busyState = page => page.evaluate(() => {
  const shown = node => {
    if (!node) return false
    const box = node.getBoundingClientRect()
    if (!(box.width > 0 && box.height > 0)) return false
    const style = getComputedStyle(node)
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'
  }
  const stop = [...document.querySelectorAll('[data-testid="stop-button"], button[aria-label*="Stop" i]')].some(shown)
  const streaming = [...document.querySelectorAll('[data-talvt-turn-state]')]
    .some(node => /streaming|thinking/i.test(node.getAttribute('data-talvt-turn-state') || ''))
  return { stop, streaming, busy: stop || streaming }
}).catch(() => ({ stop: false, streaming: false, busy: false }))

/**
 * The one DOM sample `status` takes: the page's own signs of a live turn.
 *
 * A top-level function so the same source can be proved against a fake DOM.
 * The page's vocabulary is `complete` and `in_progress` (observed 2026-10-30);
 * only `complete` means finished, so every other value - and a word we have
 * never seen - is a turn still being written. A Stop control counts only when
 * it is actually visible: this build keeps a zero-size one between turns.
 */
function liveTurnSample() {
  const shown = node => {
    if (!node) return false
    const box = node.getBoundingClientRect()
    if (!(box.width > 0 && box.height > 0)) return false
    const style = getComputedStyle(node)
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'
  }
  const stop = [...document.querySelectorAll('[data-testid="stop-button"], button[aria-label*="Stop" i]')].some(shown)
  const states = [...document.querySelectorAll('[data-talvt-turn-state]')]
    .map(node => (node.getAttribute('data-talvt-turn-state') || '').toLowerCase())
    .filter(Boolean)
  return { stop, states, live: stop || states.some(state => !/complete/.test(state)) }
}

/**
 * The CHEAP second opinion `status` needs when the pushed signal is old.
 *
 * One bounded DOM read, no conversation read, no `/backend-api` call: a status
 * answer built only from the last push said `unknown` while the page was
 * visibly mid-turn (live 2026-10-30: an 84 s old signal, the newest bubble at
 * `in_progress`). It never spawns Chrome - if no debugger is already up there
 * is nothing to ask - and it reports which thread the page is on, so a live
 * turn on someone else's thread is never attributed to this one.
 *
 * `askable:false` means exactly "this driver cannot be asked", which is the
 * only thing `unknown` is allowed to mean.
 */
async function cheapLiveTurn(threadId) {
  let browser = null
  try {
    // connectOwned is the one CDP door: a foreign browser on this port is not
    // asked anything, so status says unknown rather than reading its page.
    browser = await connectOwned(5_000)
    const pages = (browser.contexts()[0]?.pages() ?? []).filter(page => isChatGPTUrl(page.url()))
    if (pages.length === 0) return { askable: true, page: false }
    const wanted = String(threadId || '').toLowerCase()
    const page = pages.find(candidate => (threadOf(candidate.url()) || '').toLowerCase() === wanted) ?? pages[0]
    const sample = await evaluateTimed(page, liveTurnSample, null, 5_000)
    return {
      askable: true,
      page: true,
      thread: threadOf(page.url()) || null,
      live: sample?.live === true,
      stop: sample?.stop === true,
      states: Array.isArray(sample?.states) ? sample.states.slice(0, 8) : [],
    }
  } catch {
    // A wedged connection or a page that will not answer means the driver
    // cannot be asked - not that the page is idle.
    return { askable: false }
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
}

/** The block-level content every real answer has and a status header does not. */
const ANSWER_BLOCKS = 'p, ul, ol, pre, table, blockquote, h1, h2, h3, h4, h5, h6'

/**
 * One sample of the answer node, by structure rather than by position.
 *
 * `[data-markdown-text-style="assistant-message"]` matches the REASONING-STATUS
 * header too ("Consolidating findings"), and `nodes[nodes.length - 1]` is then
 * the thinking header, not the answer - which is how a 21-character status line
 * was accepted as a finished answer on 2026-10-30. So a node counts as the
 * ANSWER only when it is not inside a thinking/reasoning subtree and it renders
 * block content (a real answer always has a paragraph, list, code block or
 * table; a status header has none).
 */
const sampleTurn = page => page.evaluate(([selector, block]) => {
  const isReasoning = node => {
    for (let el = node, i = 0; el && i < 12; i++, el = el.parentElement) {
      const state = (el.getAttribute && el.getAttribute('data-talvt-turn-state')) || ''
      if (/think|reason/i.test(state)) return true
      const testid = (el.getAttribute && el.getAttribute('data-testid')) || ''
      if (/think|reason/i.test(testid)) return true
      const label = (el.getAttribute && el.getAttribute('aria-label')) || ''
      if (/think|reason/i.test(label)) return true
    }
    return false
  }
  const nodes = [...document.querySelectorAll(selector)]
  let chosen = null
  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index]
    if (isReasoning(node)) continue
    if (!node.querySelector(block)) continue
    chosen = node
    break
  }
  if (!chosen) return { found: false, text: '', state: null, candidates: nodes.length }
  let state = null
  for (let el = chosen, i = 0; el && i < 12; i++, el = el.parentElement) {
    const value = el.getAttribute && el.getAttribute('data-talvt-turn-state')
    if (value) { state = value; break }
  }
  return { found: true, text: (chosen.innerText || '').trim(), state, candidates: nodes.length }
}, [ASSISTANT, ANSWER_BLOCKS])

async function assistantText(page) {
  const sample = await sampleTurn(page).catch(() => null)
  return sample && sample.found ? sample.text : ''
}

/**
 * True once the page has taken the text: the turn is in the thread, whether or
 * not an answer exists yet. The host acknowledges on this signal, because
 * "delivered" on the bus means handed off, not answered.
 *
 * The proof is a NEW USER NODE - the identity/count delta. Neither of the two
 * cheaper signals is proof: a busy indicator can be the previous generation's
 * still-visible stop button, and a cleared composer can be a rerender after a
 * click that was swallowed. Both of those used to answer `accepted` for a turn
 * that was never posted, and the caller then waited out the reply timeout.
 *
 * `before` is the { users, answers } count taken before the click.
 */
async function waitForAcceptance(page, before, composedText = '', timeoutMs = 30_000) {
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs
  const needle = (composedText || '').trim().slice(0, 40)
  const priorUsers = Number(before?.users) || 0
  while (Date.now() < deadline) {
    const state = await page.evaluate(([userSelector, needle]) => {
      const node = document.querySelector('#prompt-textarea, div.ProseMirror[contenteditable="true"]')
      const composer = node ? (node.innerText || '').trim() : ''
      const users = [...document.querySelectorAll(userSelector)]
      const last = users.at(-1)
      return {
        users: users.length,
        lastUserText: last ? (last.innerText || '').replace(/\s+/g, ' ').trim() : '',
        composerHolds: needle ? composer.includes(needle) : composer.length > 0,
      }
    }, [USER_MESSAGE, needle]).catch(() => null)
    if (state) {
      const freshUser = state.users > priorUsers
      // The new node carries the text we sent. A page that reflows or trims the
      // text can fail the includes(); the count delta plus an emptied composer
      // covers exactly that case, and still needs the NEW NODE.
      if (freshUser && (!needle || state.lastUserText.includes(needle) || !state.composerHolds)) return true
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return false
}

/**
 * Does the thread tree hold a user node carrying what we sent?
 *
 * The acceptance proof that survives a DOM rename: it reads the page's own
 * backend conversation rather than an attribute. The needle is a collapsed
 * prefix, because the page reflows and trims the text it stored.
 */
function treeHasSentText(body, text) {
  const needle = String(text ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)
  if (!needle) return false
  const mapping = body && typeof body === 'object' && body.mapping && typeof body.mapping === 'object' ? body.mapping : {}
  for (const node of Object.values(mapping)) {
    if (node?.message?.author?.role !== 'user') continue
    const parts = Array.isArray(node.message.content?.parts) ? node.message.content.parts : []
    const said = parts.filter(part => typeof part === 'string').join('\n').replace(/\s+/g, ' ')
    if (said.includes(needle)) return true
  }
  return false
}

/**
 * The acceptance decision for a page that exposes no user nodes at all.
 *
 * Pure: the count and the tree answer are arguments. The evidence must be
 * IDENTITY - our text on a user turn - and never undifferentiated growth: an
 * earlier turn can append a reasoning or assistant node while this send is
 * swallowed, so a risen message count proves only that the page rendered
 * something, not that it rendered ours. A cleared composer is likewise never
 * acceptance on its own, since a rerender after a swallowed click clears it
 * with nothing posted. With no user node in the DOM, the thread tree is the
 * only place that can carry that identity; a page that cannot show it has not
 * accepted the send.
 */
function degradedSendVerdict({ userNodes, tree }) {
  if (Number(userNodes) > 0) return false
  return tree === true
}

/**
 * The degraded acceptance check, run only after `waitForAcceptance` failed.
 *
 * Reads the thread tree - the text-identity evidence that survives a DOM
 * rename - until it holds what we sent. The normal page never reaches this, so
 * it never costs a conversation read.
 */
async function confirmDegradedSend(page, text) {
  const userNodes = await page.locator(USER_MESSAGE).count().catch(() => 0)
  if (userNodes > 0) return false
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const threadId = threadOf(page.url())
    if (threadId) {
      const read = await backendGetOn(page, `/backend-api/conversation/${threadId}`, 15_000).catch(() => null)
      if (read?.ok && degradedSendVerdict({ userNodes, tree: treeHasSentText(read.body, text) })) return true
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return false
}

const SEND_READY_TIMEOUT_MS = Number(process.env.CHATGPT_SEND_READY_MS || 10 * 60_000)

/**
 * Wait for the composer to be able to send, not merely to contain the text.
 *
 * A large attachment is uploaded after the chip appears; until it finishes the
 * send button is present but disabled, and Enter in that state is swallowed.
 * The old path answered "button present but disabled" with a keypress and then
 * waited out the whole reply timeout for a message that was never sent. Poll
 * until the button is enabled and no upload is in flight.
 */
async function waitForSendReady(page, timeoutMs = SEND_READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  let reason = 'the send control never appeared'
  while (Date.now() < deadline) {
    const send = await firstVisible(page, SEND)
    if (send) {
      const disabled = await send.isDisabled().catch(() => false)
        || (await send.getAttribute('aria-disabled').catch(() => null)) === 'true'
      if (!disabled) {
        const busy = await busyState(page)
        const uploading = await page.evaluate(() => !!document.querySelector('[role="progressbar"]')).catch(() => false)
        if (!busy.busy && !uploading) return { ready: true, send }
        reason = 'an upload or a running turn is still in progress'
      } else reason = 'the send button is disabled (attachment still uploading)'
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return { ready: false, send: null, reason }
}

async function waitForReply(page, beforeCount, beforeText = '') {
  const startedAt = Date.now()
  const deadline = startedAt + SEND_TIMEOUT_MS
  let last = ''
  let agree = 0
  while (Date.now() < deadline) {
    // The ANSWER node by structure, never the last assistant-message element:
    // that one is the reasoning-status header while the turn is thinking.
    const snapshot = await sampleTurn(page).catch(() => null)
    if (!snapshot) { await new Promise(r => setTimeout(r, 500)); continue }
    const busy = await busyState(page)
    if (!snapshot.found || !snapshot.text) { last = ''; agree = 0; await new Promise(r => setTimeout(r, 400)); continue }
    // A new node is the usual shape, but ChatGPT also re-renders an existing
    // node in place (and a resumed thread can hydrate late, so the count taken
    // before sending is not reliable). Either a new node or changed text is a
    // reply; waiting only for the count hangs a finished answer forever.
    const got = snapshot.candidates > beforeCount || snapshot.text !== beforeText
    if (got && snapshot.text === last && !busy.busy) {
      agree++
      // Three agreeing samples ~900 ms apart, with no stop control and no
      // streaming state anywhere. One stable sample is not enough: a thinking
      // pause looks exactly like a finished turn for a second at a time.
      if (agree >= ANSWER_AGREE_SAMPLES) {
        const body = await page.evaluate(() => (document.body?.innerText || '').slice(-4000)).catch(() => '')
        if (/something went wrong|you've reached (your )?limit|unusual activity|verify you are human/i.test(body)) {
          throw new Error('ChatGPT reported a problem: ' + body.slice(-600))
        }
        return { reply: snapshot.text }
      }
    } else {
      agree = got ? 1 : 0
    }
    last = snapshot.text
    await new Promise(r => setTimeout(r, 900))
  }
  // Expiry is NOT a refusal. A turn many minutes into healthy pondering looks
  // exactly like this; the caller decides what a still-running turn means.
  return { timedOut: true, seconds: Math.round((Date.now() - startedAt) / 1000) }
}

/**
 * How many consecutive agreeing samples prove a turn finished. One is not
 * enough: `data-talvt-turn-state="complete"` has been seen on a turn that was
 * still running, and a single stable read inside a reasoning pause read like a
 * finished turn (live, 2026-10-30).
 */
const ANSWER_AGREE_SAMPLES = 3

/**
 * Read the newest ANSWER without touching the composer.
 *
 * Completion is fail-closed, and it is a RUN of samples, not one:
 *
 * - the node must be an answer by structure (see `sampleTurn`), not merely the
 *   last element that looks like a message - the reasoning header is neither
 *   the answer nor part of its text;
 * - the same non-empty text must be read three times in a row, and on each of
 *   those reads there must be no visible stop control and no streaming state;
 * - `data-talvt-turn-state="complete"` is a hint that labels the evidence, never
 *   proof on its own.
 *
 * If those do not all hold the turn is still running: return no evidence, so
 * the caller treats it as generating. A partial answer is never returned as
 * final.
 */
async function readNewestTurn(page) {
  let snapshot = await sampleTurn(page)
  if (!snapshot.found) {
    // An answer node can appear before its text hydrates after a navigation.
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline && !snapshot.found) {
      await new Promise(resolve => setTimeout(resolve, 300))
      snapshot = await sampleTurn(page)
    }
    if (!snapshot.found) return { found: false, text: '', evidence: null }
  }
  let last = snapshot.text
  let agree = last ? 1 : 0
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 900))
    const busy = await busyState(page)
    const now = await sampleTurn(page)
    if (!now.found || !now.text) { last = ''; agree = 0; continue }
    if (now.text !== last || busy.busy) { last = now.text; agree = 1; continue }
    agree++
    if (agree >= ANSWER_AGREE_SAMPLES) {
      return { found: true, text: now.text, evidence: /^complete$/i.test(now.state || '') ? 'state-complete' : 'stability' }
    }
  }
  return { found: true, text: last, evidence: null }
}

const threadOf = url => {
  const match = /\/c\/([0-9a-f-]{36})/i.exec(url || '')
  return match ? match[1] : null
}

const readPicker = page => page.evaluate(() => {
  const menus = [...document.querySelectorAll('[role="menu"]')]
  const menu = menus[menus.length - 1]
  if (!menu) return { model: null, effort: null, models: [], view: null }
  const radios = [...menu.querySelectorAll('[role="menuitemradio"]')]
  const checked = radios.find(radio => radio.getAttribute('aria-checked') === 'true')
  // Models with a short name render it above the effort ("5.6\nHigh"), so the
  // effort is the last line of the toggle, not the whole label.
  const toggle = menu.querySelector('[role="menuitem"][aria-label="Select model"]')
  const effort = ((toggle?.innerText || '').split('\n').map(part => part.trim()).filter(Boolean).pop()) || null
  const viewEl = menu.querySelector('[data-model-picker-view]')
  return {
    model: checked ? (checked.innerText || '').trim() : null,
    effort,
    models: radios.map(radio => (radio.innerText || '').trim()).filter(Boolean),
    view: viewEl ? viewEl.getAttribute('data-model-picker-view') : null,
  }
}).catch(() => ({ model: null, effort: null, models: [], view: null }))

async function readModelState(page) {
  const button = page.locator('button[aria-label*="Select ChatGPT model" i]').first()
  if (!await button.count().catch(() => 0)) return { model: null, effort: null, models: [] }
  await button.click()
  await new Promise(resolve => setTimeout(resolve, 700))
  // The picker opens on whichever view was last used; the effort panel is what
  // the caller wants, and the model list is one click away.
  await showEffortView(page)
  const state = await readPicker(page)
  await page.keyboard.press('Escape').catch(() => {})
  return state
}

/**
 * The picker is a two-panel track: "simple" (effort) and "advanced" (model
 * list), toggled by the Select-model row. Choosing a model returns to simple
 * by itself, so this only has to undo a stray advanced view.
 */
async function showEffortView(page) {
  if ((await readPicker(page)).view !== 'advanced') return
  const toggle = page.locator('[role="menu"] [data-model-picker-view-toggle="true"]').first()
  if (!await toggle.count().catch(() => 0)) return
  await toggle.click()
  await new Promise(resolve => setTimeout(resolve, 700))
}

async function setModelState(page, { model, effort } = {}) {
  const button = page.locator('button[aria-label*="Select ChatGPT model" i]').first()
  if (!await button.count().catch(() => 0)) throw new Error('No model control on screen')
  await button.click()
  await new Promise(resolve => setTimeout(resolve, 700))
  try {
    if (model) {
      const wanted = new RegExp(`^\\s*${model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i')
      const current = (await readPicker(page)).model
      // Choosing the model already selected is a click on a row behind the
      // effort panel: it cannot land, and it is a no-op anyway.
      if (!current || !wanted.test(current)) {
        if ((await readPicker(page)).view !== 'advanced') {
          const toggle = page.locator('[role="menu"] [data-model-picker-view-toggle="true"]').first()
          if (await toggle.count().catch(() => 0)) {
            await toggle.click()
            await new Promise(resolve => setTimeout(resolve, 700))
          }
        }
        const radio = page.locator('[role="menu"] [role="menuitemradio"]').filter({ hasText: wanted }).first()
        if (!await radio.count()) throw new Error(`No model named ${model} in the picker`)
        await radio.click({ timeout: 15_000 })
        await new Promise(resolve => setTimeout(resolve, 900))
      }
    }
    if (effort) {
      const desired = String(effort).toLowerCase()
      await showEffortView(page)
      const slider = page.locator('[role="menu"] [role="slider"]').first()
      if (!await slider.count()) throw new Error('No effort slider in the model picker')
      let current = (await readPicker(page)).effort
      if ((current || '').toLowerCase() !== desired) {
        await slider.focus()
        await page.keyboard.press('Home')
        await new Promise(resolve => setTimeout(resolve, 150))
        const seen = []
        for (let i = 0; i < 8; i++) {
          current = (await readPicker(page)).effort
          if (current && !seen.includes(current)) seen.push(current)
          if ((current || '').toLowerCase() === desired) break
          await page.keyboard.press('ArrowRight')
          await new Promise(resolve => setTimeout(resolve, 150))
        }
        const landed = (await readPicker(page)).effort
        if ((landed || '').toLowerCase() !== desired) {
          throw new Error(`Effort ${effort} not offered by this model; it offers ${seen.join(', ') || 'nothing readable'}`)
        }
      }
    }
  } finally {
    await page.keyboard.press('Escape').catch(() => {})
  }
  return readModelState(page)
}

async function listThreads(page) {
  return page.evaluate(() => {
    const seen = new Map()
    for (const link of document.querySelectorAll('a[href^="/c/"]')) {
      const id = (link.getAttribute('href') || '').slice(3).split(/[?#]/)[0]
      if (!id) continue
      const title = (link.innerText || '').replace(/\s+/g, ' ').trim()
      if (title && !seen.has(id)) seen.set(id, title)
    }
    return [...seen].map(([id, title]) => ({ id, title }))
  })
}

/**
 * Put a file into the composer through the page's own uploader.
 *
 * The bytes go to Playwright's setInputFiles - never to a path, never to disk.
 * ChatGPT does the uploading and owns the limits; its refusal is reported as a
 * refusal rather than guessed at. A file that silently does not attach is the
 * worst outcome, so this throws naming the selector it tried.
 */
async function attachFile(page, { name, mimeType, buffer, timeoutMs = 120_000 }) {
  const describe = 'input[aria-label="Attach files"]'
  let attempted = false
  let uploadError = null
  // How many `Remove <name>` chips exist BEFORE this upload. A pre-existing chip
  // - an earlier attachment with the same name, still in the composer - made a
  // failed replacement upload report `attached`. Only an increase is a success.
  const chipsLabel = `Remove ${name}`
  const countChips = () => page.evaluate(label => [...document.querySelectorAll('button')]
    .filter(button => button.getAttribute('aria-label') === label).length, chipsLabel).catch(() => 0)
  const beforeChips = await countChips()
  const input = page.locator(describe).first()
  if (await input.count()) {
    attempted = true
    // A large buffer crosses CDP into the page, so this is not a 30 s job. Keep
    // the failure instead of discarding it: "no chip appeared" with no reason is
    // what made a failed upload look like a slow one.
    await input.setInputFiles({ name, mimeType, buffer }, { timeout: 180_000 }).catch(error => { uploadError = error })
  }
  if (!attempted) {
    // Fallback: the attach button opens a menu; one of its items opens the
    // file chooser. Try once, and fail loudly below if nothing fires.
    const button = page.locator('button[aria-label="Add files and more"]').first()
    if (await button.count()) {
      attempted = true
      const chooserPromise = page.waitForEvent('filechooser', { timeout: 5_000 }).catch(() => null)
      await button.click({ timeout: 5_000 }).catch(() => {})
      const item = page.locator('[role="menuitem"]').filter({ hasText: /add files|upload file|add documents/i }).first()
      if (await item.count()) await item.click({ timeout: 5_000 }).catch(() => {})
      const chooser = await chooserPromise
      if (chooser) await chooser.setFiles({ name, mimeType, buffer }).catch(() => {})
    }
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await page.evaluate(label => {
      const chips = [...document.querySelectorAll('button')].filter(button => button.getAttribute('aria-label') === label).length
      const body = document.body.innerText || ''
      const toast = /couldn['’]t upload|failed to upload|not supported|unsupported (file|type)|(file|attachment) is too large|too large/i.test(body)
      return { chips, toast, snippet: toast ? body.slice(0, 500) : '' }
    }, chipsLabel)
    // A chip that was already there proves nothing; a new one does.
    if (state.chips > beforeChips) return { name, state: 'attached' }
    if (state.toast) return { name, state: 'rejected', reason: (state.snippet.match(/couldn['’]t upload[^.]*|failed to upload[^.]*|not supported[^.]*|unsupported[^.]*|too large[^.]*/i) || ['the page rejected the file'])[0] }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`attachment "${name}" did not attach: no NEW chip appeared (${beforeChips} already present; tried ${attempted ? describe : 'the file chooser'}${uploadError ? `; setInputFiles said: ${uploadError.message}` : ''})`)
}

/**
 * A failure the caller must be able to classify, not just read.
 *
 * `reason` travels on the wire (`not-posted`, `timeout`, `busy`), because the
 * host decides what to do from it: a message that never left the composer is
 * not a failed turn and must never be read as one.
 */
class TurnError extends Error {
  constructor(message, extra = {}) {
    super(message)
    Object.assign(this, extra)
  }
}

async function ask(page, text, { newChat = false, threadId = null, onAccepted = null, attachments = null, wait = true } = {}) {
  // Never type into a running turn. Live 2026-10-30: a message typed while a
  // turn was streaming was STEERED into that turn - the two tasks merged and
  // the original answer was lost. A stale signal says nothing about now, so
  // only a recent one refuses.
  if (PUSHED.phase === 'streaming' && PUSHED.at && Date.now() - PUSHED.at < 10 * 60_000) {
    throw new TurnError('the page is mid-turn; your message was not typed', { reason: 'busy', state: 'generating', threadId: PUSHED.threadId })
  }
  if (newChat || (threadId && threadOf(page.url()) !== threadId)) {
    const target = threadId ? `https://chatgpt.com/c/${threadId}` : CHAT_URL
    await page.goto(target, { waitUntil: 'domcontentloaded' })
    await waitForLogin(page, 60_000)
    // A redirect or a deleted thread lands somewhere else, and posting into
    // whatever page happens to be open would put the message in another
    // conversation. The caller asked for a thread; require that thread.
    if (threadId) {
      const landed = threadOf(page.url())
      if (!landed || landed.toLowerCase() !== String(threadId).toLowerCase()) {
        throw new Error(`the page landed on ${landed ?? 'no thread'} instead of the requested thread ${threadId}`)
      }
    }
  }
  const composer = await waitForComposer(page)
  if (!composer) {
    const state = await pageState(page)
    throw new Error(`No composer on screen (url=${state.url}, loggedIn=${state.loggedIn}, challenge=${state.challenge})`)
  }
  // Attach before typing: the chip lives beside the composer, and a later
  // navigation would discard it.
  let attachment = null
  const rejected = []
  for (const file of attachments ?? []) {
    const result = await attachFile(page, file)
    attachment = result
    if (result.state === 'rejected') rejected.push(result)
  }
  // The note built by the host claims a document is in the thread. When the
  // page refuses the upload that premise is false, so replace this turn with
  // one short correction the model cannot mistake for a real attachment, and
  // only then fail the turn for the sender.
  if (rejected.length) {
    text = rejected
      .map(item => `ATTACHMENT REJECTED: ${item.name} — ${item.reason}. The previous note does not describe a file that exists; do not refer to it.`)
      .join('\n')
  }
  const beforeCount = await page.locator(ASSISTANT).count()
  // The acceptance proof is a NEW user node, so its count is taken here too.
  const beforeUsers = await page.locator(USER_MESSAGE).count()
  const beforeText = await page.locator(ASSISTANT).last().innerText().then(text => text.trim()).catch(() => '')
  await composer.click()
  const typed = await composer.fill(text).then(() => true).catch(() => false)
  if (!typed) await page.keyboard.insertText(text)
  const readiness = await waitForSendReady(page)
  if (!readiness.ready) {
    throw new TurnError(`the page never became ready to send (${readiness.reason}); nothing was sent, so no reply is coming`, { reason: 'not-posted' })
  }
  try { await readiness.send.click() } catch (error) { await log(`send click failed: ${error.message}`) }
  await log(`sent ${text.length} chars`)
  let accepted = await waitForAcceptance(page, { users: beforeUsers, answers: beforeCount }, text)
  if (!accepted) {
    // A click that lands on a composer still settling can be swallowed. Try the
    // same readiness rule once more, then fail the turn rather than sit out the
    // reply timeout on a message that never left the box.
    await log('send was not accepted; retrying once')
    const retry = await waitForSendReady(page, 60_000)
    if (retry.ready) await retry.send.click().catch(() => {})
    accepted = await waitForAcceptance(page, { users: beforeUsers, answers: beforeCount }, text)
  }
  if (!accepted) {
    // The page may expose no user nodes at all (a renamed attribute must not
    // brick sending). Confirm with evidence that does not depend on that
    // selector - our text on a user turn in the thread tree - and never from a
    // cleared composer or an unspecific rise in the message count: either is
    // what a swallowed click looks like.
    accepted = await confirmDegradedSend(page, text)
    if (accepted) await log('acceptance: no user-node delta on this page; confirmed by our text in the thread tree')
  }
  if (!accepted) {
    // `not-posted`, never `timedOut`: a turn that was never posted cannot be
    // the turn that is generating, and saying so would make the host wait on an
    // answer nobody asked for.
    throw new TurnError('the message was composed but never left the composer (the send did not take); no reply is coming', { reason: 'not-posted' })
  }
  if (onAccepted) onAccepted(threadOf(page.url()))
  // A rejection replaces this turn with its own correction, so it is decided
  // as soon as the send lands - waiting for the answer first would spend the
  // whole timeout on a turn whose outcome is already known.
  if (rejected.length) throw new Error(`the page rejected ${rejected.map(item => `${item.name}: ${item.reason}`).join('; ')}`)
  // `wait:false` is the job shape: the text is in the thread, and the answer is
  // somebody else's to observe. Reading the model picker here would click into
  // the page while the turn is still running, so it is skipped.
  if (!wait) {
    return { reply: '', url: page.url(), model: null, attachment, state: 'generating', acceptedAt: new Date().toISOString() }
  }
  const waited = await waitForReply(page, beforeCount, beforeText)
  const state = await pageState(page)
  if (waited.timedOut) {
    return { reply: '', url: page.url(), model: state.model, attachment, timedOut: true, seconds: waited.seconds, state: 'generating' }
  }
  return { reply: clampReply(waited.reply), url: page.url(), model: state.model, attachment }
}

async function doLogin(minutes = 15) {
  await ensureChrome({ visible: true })
  const { page } = await connect()
  await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})
  console.log('A Chrome window is open. Sign in to ChatGPT there (any method).')
  const state = await waitForLogin(page, minutes * 60_000)
  console.log(`Logged in. url=${state.url} model=${JSON.stringify(state.model || 'unknown')}`)
  console.log('The browser stays open. Next: node chatgpt.mjs chat')
  await log(`login ok url=${state.url}`)
}

async function doCheck() {
  const started = await ensureChrome({ visible: true })
  const { browser, page } = await connect()
  await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await new Promise(resolve => setTimeout(resolve, 6000))
  const state = await pageState(page)
  console.log(JSON.stringify({ ...state, spawned: started.spawned }, null, 2))
  await browser.close().catch(() => {})
  if (started.spawned) await fs.rm(PID_FILE, { force: true }).catch(() => {})
}

async function doProbe() {
  await ensureChrome({ visible: true })
  const { browser, context, page } = await connect()
  await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await new Promise(resolve => setTimeout(resolve, 10000))
  console.log('pages=' + JSON.stringify(context.pages().map(p => p.url())))
  console.log('active=' + page.url() + ' title=' + JSON.stringify(await page.title().catch(() => '')))
  const info = await page.evaluate(() => {
    const testids = [...new Set([...document.querySelectorAll('[data-testid]')].map(el => el.getAttribute('data-testid')))].slice(0, 200)
    const editables = [...document.querySelectorAll('[contenteditable="true"], textarea')].map(el => ({
      tag: el.tagName, id: el.id, cls: String(el.className).slice(0, 80),
      placeholder: el.getAttribute('data-placeholder') || el.getAttribute('placeholder') || '',
      visible: !!(el.offsetWidth || el.offsetHeight),
    }))
    const buttons = [...document.querySelectorAll('button, a')].map(el => ({
      tag: el.tagName, text: (el.innerText || '').trim().slice(0, 60),
      label: el.getAttribute('aria-label') || '', tid: el.getAttribute('data-testid') || '', href: el.getAttribute('href') || '',
    })).filter(item => item.text || item.label).slice(0, 120)
    return {
      readyState: document.readyState,
      htmlLength: document.documentElement?.outerHTML.length || 0,
      bodyLength: document.body?.innerText?.length || 0,
      testids, editables, buttons,
      bodyStart: (document.body?.innerText || '').slice(0, 600),
    }
  })
  console.log(JSON.stringify(info, null, 2))
  await page.screenshot({ path: path.join(BASE, 'probe.png') }).catch(error => console.log('shot failed: ' + error.message))
  await browser.close().catch(() => {})
}

async function doStatus() {
  if (!(await cdpUp())) { console.log('Chrome not running'); return }
  const { browser, page } = await connect()
  console.log(JSON.stringify(await pageState(page), null, 2))
  await browser.close().catch(() => {})
}

// stdout belongs to the line-JSON channel when this file runs as the host's
// child, so every human-facing line goes to stderr in that mode.
let STDOUT_RESERVED = false
const say = line => STDOUT_RESERVED ? process.stderr.write(`${line}\n`) : console.log(line)

async function doQuit() {
  let pid = 0
  try { pid = Number((await fs.readFile(PID_FILE, 'utf8')).trim()) } catch {}
  if (pid) {
    const probe = await new Promise(resolve => {
      const child = spawn('powershell.exe', ['-NoProfile', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      child.stdout.on('data', chunk => { out += chunk })
      child.on('exit', () => resolve(out))
    })
    if (probe.includes(PROFILE)) {
      await new Promise(resolve => {
        const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
        child.on('exit', resolve)
      })
      say(`Closed Chrome pid=${pid}`)
    } else {
      say('PID file does not match this profile; not killing it')
    }
  } else {
    say('No PID file; nothing to close')
  }
  await fs.rm(PID_FILE, { force: true }).catch(() => {})
}

async function doAsk(text, newChat) {
  await ensureChrome({ visible: true })
  const { browser, page } = await connect()
  const result = await ask(page, text, { newChat })
  console.log(result.reply)
  console.error(`\n[url] ${result.url}\n[model] ${result.model || 'unknown'}`)
  await browser.close().catch(() => {})
}

async function doChat() {
  await ensureChrome({ visible: true })
  const { browser, page } = await connect()
  const state = await pageState(page)
  if (!state.loggedIn) {
    console.log('Not signed in. Run: node chatgpt.mjs login')
    await browser.close().catch(() => {})
    process.exit(2)
  }
  console.log(`Connected. model=${state.model || 'unknown'} url=${state.url}`)
  console.log('Type a message. Commands: /new  /url  /model  /quit')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY })
  const prompt = () => rl.setPrompt('> ')
  prompt()
  rl.prompt()
  for await (const raw of rl) {
    const line = raw.trim()
    if (!line) { rl.prompt(); continue }
    if (line === '/quit' || line === '/exit') break
    if (line === '/url') { console.log(page.url()); rl.prompt(); continue }
    if (line === '/model') { console.log((await pageState(page)).model || 'unknown'); rl.prompt(); continue }
    const newChat = line === '/new'
    if (newChat) { await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded' }); await waitForLogin(page, 60_000); rl.prompt(); continue }
    try {
      const result = await ask(page, line)
      console.log('\n' + result.reply + '\n')
      console.error(`[url] ${result.url}`)
    } catch (error) {
      console.error(`[error] ${error.message}`)
    }
    rl.prompt()
  }
  rl.close()
  await browser.close().catch(() => {})
}

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** A conversation node id: opaque, but never a path, a URL, or empty. */
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/

/**
 * A read of the page's own JSON API, made from inside the page.
 *
 * The bearer token is fetched and used inside the page and never returned to
 * this process. Observation never launches Chrome: if no browser or no
 * chatgpt.com tab is up, the read fails and the host looks again later.
 * Which thread the tab shows does not matter; the path names the thread.
 */
async function backendGetOn(page, path, timeoutMs = 30_000) {
  // Checked here as well as at tab selection: the tab may have navigated away
  // since it was chosen, and the bearer-token read must only ever run on the
  // real origin.
  if (!isChatGPTUrl(page.url())) return { ok: false, status: 0, error: 'no chatgpt.com tab is open' }
  try {
  return await evaluateTimed(page, async path => {
    const session = await fetch('/api/auth/session', { credentials: 'include' }).then(r => r.json()).catch(() => null)
    if (!session?.accessToken) return { ok: false, status: 401, error: 'not signed in' }
    const response = await fetch(path, { headers: { authorization: `Bearer ${session.accessToken}` } })
    if (!response.ok) return { ok: false, status: response.status, error: `GET ${path.split('?')[0]} answered ${response.status}` }
    return { ok: true, status: response.status, body: await response.json() }
  }, path, timeoutMs)
  } catch (error) {
    // A wedged connection is invisible at the JS level, so the only safe
    // reading of "no answer" is that we do not know - never that the page failed.
    if (error?.reason === 'timeout') return { ok: false, status: 0, reason: 'timeout', error: error.message }
    throw error
  }
}

async function backendGet(path, timeoutMs = 30_000) {
  if (!(await cdpUp())) return { ok: false, status: 0, error: 'chrome is not running' }
  const { browser, page } = await connect()
  try { return await backendGetOn(page, path, timeoutMs) } finally { await browser.close().catch(() => {}) }
}

/**
 * A backend read that survives one wedged connection.
 *
 * The failure this exists for is subtle: a long-lived connection stops
 * answering while a fresh one works at once. So a timeout buys one reconnect
 * and one retry, and only then is it reported. Reads are idempotent; nothing
 * that can post a message is retried this way.
 */
async function backendGetRetry(path, timeoutMs = 30_000) {
  const first = await backendGet(path, timeoutMs)
  if (first.reason !== 'timeout') return first
  await log('the page did not answer a backend read; reconnecting once')
  return await backendGet(path, timeoutMs)
}

// --------------------------------------------------------------- turn status
//
// Every shape below is a PURE function of the backend payload or of one DOM
// sample, so what "generating" means is decided in one place and can be tested
// without a page. Observed live 2026-10-30 on this account.

/** A file id as this backend issues them: `file_<hex>` or a `libfile_...` id. */
const FILE_ID = /^(?:file_[0-9a-f]{16,64}|libfile_[A-Za-z0-9]{8,64})$/i
/** The link a page-made file leaves in an answer: `sandbox:/mnt/data/<name>`. */
const SANDBOX_POINTER = /sandbox:(\/mnt\/data\/[^\s)"'<>\]]+)/gi
/** The pointer shapes a part can carry: `sediment://file_...`, `file-service://...`. */
const POINTER_PREFIX = /^(?:sediment|file-service):\/\//i

/** A file id from a pointer, a bare id, or nothing. The one regex, exported. */
export function fileIdOf(value) {
  if (typeof value !== 'string') return null
  const text = value.trim().replace(POINTER_PREFIX, '')
  return FILE_ID.test(text) ? text : null
}

/**
 * The files a message carries, from `metadata.attachments[]` first and asset
 * pointers in `content.parts[]` second. Index is the ONLY handle a caller gets:
 * nothing here comes from the message's prose.
 */
export function filesOfMessage(message) {
  const files = []
  const seen = new Set()
  const push = (fileId, name, mime, size) => {
    if (!fileId || seen.has(fileId)) return
    seen.add(fileId)
    files.push({ index: files.length, kind: 'attachment', fileId, name: String(name ?? ''), mime: String(mime ?? ''), size: Number(size) > 0 ? Number(size) : 0 })
  }
  const attachments = message?.metadata?.attachments
  if (Array.isArray(attachments)) {
    for (const entry of attachments) {
      if (!entry || typeof entry !== 'object') continue
      push(fileIdOf(entry.id) ?? fileIdOf(entry.file_id) ?? null, entry.name ?? entry.file_name, entry.mime_type ?? entry.mimeType, entry.size ?? entry.size_bytes)
    }
  }
  const parts = message?.content?.parts
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (typeof part === 'string') { push(fileIdOf(part), '', '', 0); continue }
      if (!part || typeof part !== 'object') continue
      push(fileIdOf(part.asset_pointer) ?? fileIdOf(part.file_id) ?? fileIdOf(part.id) ?? fileIdOf(part.pointer),
        part.name ?? part.file_name, part.mime_type ?? part.mimeType, part.size_bytes ?? part.size)
    }
  }
  // A file the PAGE made carries no attachment record at all: the only handle
  // is the `sandbox:/mnt/data/<name>` link in the answer (proven live
  // 2026-10-30). Enumerating only attachments finds nothing for those.
  const text = Array.isArray(parts) ? parts.filter(part => typeof part === 'string').join('\n') : ''
  const named = new Set(files.map(file => file.name.toLowerCase()).filter(Boolean))
  for (const match of text.matchAll(SANDBOX_POINTER)) {
    const sandboxPath = match[1]
    const name = sandboxPath.split('/').at(-1) || sandboxPath
    if (seen.has(sandboxPath) || named.has(name.toLowerCase())) continue
    seen.add(sandboxPath)
    files.push({ index: files.length, kind: 'sandbox', sandboxPath, name, mime: '', size: 0 })
  }
  return files
}

/** The newest assistant node on the visible branch, as the four facts a caller needs. */
export function turnStatus(body) {
  const current = body && typeof body === 'object' ? body.current_node ?? null : null
  const mapping = body && typeof body === 'object' && body.mapping && typeof body.mapping === 'object' ? body.mapping : {}
  let node = current ? mapping[current] : null
  const seen = new Set()
  let latest = null
  while (node && typeof node === 'object' && !seen.has(String(node.id ?? ''))) {
    seen.add(String(node.id ?? ''))
    if (node.message && node.message.author && node.message.author.role === 'assistant') {
      // A `thoughts` / `reasoning_recap` node is an assistant node too, and it
      // is not the answer: skip it and keep walking to the real one.
      const type = String(node.message?.content?.content_type ?? '')
      if (!/^(thoughts|reasoning_recap|reasoning)$/i.test(type)) { latest = node; break }
    }
    node = node.parent ? mapping[node.parent] : null
  }
  const message = latest?.message ?? null
  const status = typeof message?.status === 'string' ? message.status : null
  const parts = Array.isArray(message?.content?.parts) ? message.content.parts : []
  const text = parts.filter(part => typeof part === 'string').join('\n')
  return {
    nodeId: latest ? String(latest.id ?? '') : null,
    // Fail-safe: only explicit completion evidence counts as complete; every
    // other status - including ones we have never seen - is still streaming.
    complete: status === 'finished_successfully' || status === 'complete' || message?.end_turn === true,
    status,
    createTime: typeof message?.create_time === 'number' ? message.create_time : null,
    chars: text.length,
    files: filesOfMessage(message),
  }
}

/**
 * A failure chip in the page's own words. The last live failure was a bubble
 * reading "This response couldn't load" while every other signal said
 * `in_progress`. The detection now lives in the observer (it pushes only the
 * word `failed`, never the text); this pattern is kept because the reply wait
 * and the observer must agree on what a failure looks like, and because a
 * caller reading a transcript wants to know the words.
 */
const PAGE_FAILURE = /(this response couldn't load|couldn't load|something went wrong|you've reached (your )?limit|unusual activity|verify you are human|error generating|network error)/i

export function pageFailure(text) {
  const match = PAGE_FAILURE.exec(String(text ?? ''))
  return match ? match[0] : null
}

/** How many assistant nodes exist and how new the newest one is. */
export function nodeActivityOf(body) {
  const mapping = body && typeof body === 'object' && body.mapping && typeof body.mapping === 'object' ? body.mapping : {}
  let assistantNodes = 0
  let newestCreateTime = null
  for (const node of Object.values(mapping)) {
    if (node?.message?.author?.role !== 'assistant') continue
    assistantNodes += 1
    const at = node.message.create_time
    if (typeof at === 'number' && (newestCreateTime === null || at > newestCreateTime)) newestCreateTime = at
  }
  return { assistantNodes, newestCreateTime }
}

async function withPage(operation) {
  await ensureChrome({ visible: true })
  const { browser, page } = await connect()
  try { return await operation(page) } finally { await browser.close().catch(() => {}) }
}

/**
 * The observer, injected into every chatgpt.com document.
 *
 * It is READ-ONLY: it reads the turn-state attributes the page already renders
 * and `location.pathname`, and it reports state transitions only - never page
 * text, never a click, never a navigation. Samples are taken on the leading
 * edge (throttled to 100 ms) and once more 250 ms after the churn stops, so an
 * answer that begins and ends inside one debounce window is still reported as
 * two phases. The binding exists only on the persistent event connection; when
 * that connection is gone the send is a harmless no-op.
 */
const OBSERVER_SCRIPT = `(() => {
  if (window.top !== window) return 'not-top'
  if (window.__gwObserver) return 'already'
  window.__gwObserver = true
  // One mark per document, so the channel can tell a reload from a repeated
  // load event on the document it already knows.
  window.__gwObserverDoc = (self.crypto && self.crypto.randomUUID ? self.crypto.randomUUID() : Date.now() + '-' + Math.random())
  const THREAD = /\\/c\\/([0-9a-f-]{36})/i
  let lastPhase = null
  let lastThread = null
  let timer = null
  let lastSampleAt = 0
  const threadOf = () => {
    const match = THREAD.exec(location.pathname)
    return match ? match[1].toLowerCase() : null
  }
  const send = payload => {
    try { if (typeof window.__gatewayEvent === 'function') window.__gatewayEvent(JSON.stringify(payload)) } catch (error) {}
  }
  // The page's own vocabulary. Observed 2026-10-30: 'complete' and
  // 'in_progress', and nothing else. Rather than list today's active words,
  // only 'complete' means finished; every other non-empty value is a turn
  // still being written, so a word we have not seen yet reads as streaming
  // instead of silently reading as done.
  const classify = value => {
    const text = String(value || '').toLowerCase()
    if (!text) return null
    return /complete/.test(text) ? 'complete' : 'streaming'
  }
  // A failure chip in the page's own words. The observer tests the newest
  // assistant bubble against these patterns and pushes only the word
  // 'failed' - never the matched text, never any page content.
  const FAILURE = /(this response couldn't load|couldn't load|something went wrong|you've reached (your )?limit|unusual activity|verify you are human|error generating|network error)/i
  const sample = () => {
    // The phase of the LATEST turn only, read from the newest assistant
    // bubble's nearest turn state. Scanning every historical node was wrong:
    // an abandoned turn leaves its in_progress element behind (observed live
    // 2026-10-30: six complete nodes and one stale in_progress after the turn
    // had finished), and the first streaming found anywhere held this push at
    // streaming forever - so the host never ran completion proof and an
    // unrelated finished answer waited out its timeout.
    const bubbles = document.querySelectorAll('[data-markdown-text-style="assistant-message"]')
    const bubble = bubbles[bubbles.length - 1]
    let phase = null
    for (let el = bubble, i = 0; el && i < 12; i++, el = el.parentElement) {
      const value = el.getAttribute && el.getAttribute('data-talvt-turn-state')
      if (value) { phase = classify(value); break }
    }
    // No state on the newest bubble (a brand-new thread, or a bubble shape
    // change): fall back to the LAST turn state in document order, which is
    // the most recent turn - never the first live-looking one in history.
    if (!phase) {
      const nodes = document.querySelectorAll('[data-talvt-turn-state]')
      const last = nodes[nodes.length - 1]
      if (last) phase = classify(last.getAttribute('data-talvt-turn-state'))
    }
    // The chip wins over in_progress: a live failure had the turn state saying
    // in_progress while the bubble already said "This response couldn't load".
    // textContent, not innerText: reading during streaming must not force layout.
    if (bubble && FAILURE.test(bubble.textContent || '')) phase = 'failed'
    const threadId = threadOf()
    if (threadId !== lastThread) {
      // The first look at a thread is not a transition: adopt its state
      // without claiming a turn finished there. The baseline is still pushed,
      // so a caller that has just attached knows what the page shows.
      lastThread = threadId
      lastPhase = phase
      if (threadId) send({ event: 'navigated', threadId })
      send({ event: 'signal', threadId, phase, at: Date.now() })
      return
    }
    if (phase === lastPhase) return
    lastPhase = phase
    // The page's own clock at the transition is carried as "at", so the time
    // from a turn finishing here to the host acting on it can be measured
    // rather than argued about. No backticks in here: this whole script is
    // a template literal.
    send({ event: 'signal', threadId, phase, at: Date.now() })
  }
  // A fresh driver child attaches to a page whose observer is already
  // installed; without this hook it would hear nothing until the page next
  // changed, which during a long turn is exactly when it needs the state.
  window.__gwPush = () => { send({ event: 'signal', threadId: lastThread, phase: lastPhase, at: Date.now() }) }
  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; sample() }, 250)
  }
  // Every mutation is a sample candidate now: a failure chip is ordinary
  // child text, not a turn-state attribute, so a filter that skipped text
  // churn would never see it. The cost is bounded by the throttle below, and
  // the sample reads only two small selectors plus the newest bubble's text.
  const observer = new MutationObserver(() => {
    // Leading edge, throttled: a turn that starts and ends inside the trailing
    // window is still seen as two phases rather than as no change at all.
    const now = Date.now()
    if (now - lastSampleAt >= 250) { lastSampleAt = now; sample() }
    schedule()
  })
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-talvt-turn-state'],
  })
  // A discussion change is an SPA navigation, not a document load. Wrapping the
  // history calls only schedules a sample; it never changes what they do.
  for (const name of ['pushState', 'replaceState']) {
    const original = history[name]
    if (typeof original !== 'function') continue
    history[name] = function (...args) {
      const result = original.apply(this, args)
      schedule()
      return result
    }
  }
  window.addEventListener('popstate', schedule)
  schedule()
  return 'installed'
})()`

/**
 * What the page last SAID, kept in this process instead of being asked for.
 *
 * A status answer built from a live evaluate can hang: a long-lived CDP
 * connection was observed to stop answering while the page itself answered a
 * fresh connection instantly. So `status` reads this record, which every push
 * updates, and reports how old it is (`ageMs`). A stale answer is honest; a
 * missing answer is not.
 *
 * `phase` is one of `streaming`, `complete`, `failed`, or null when the page
 * shows no turn at all.
 */
const PUSHED = { phase: null, threadId: null, at: null }

/** Record one page push. Called only from the event channel. */
function notePush(phase, threadId, at) {
  PUSHED.phase = phase === 'streaming' || phase === 'complete' || phase === 'failed' ? phase : null
  PUSHED.threadId = typeof threadId === 'string' && threadId ? threadId.toLowerCase() : null
  PUSHED.at = Number.isFinite(at) ? at : Date.now()
}

/** The state a pushed phase implies, for one thread. */
function pushedState(threadId) {
  const ageMs = PUSHED.at === null ? null : Date.now() - PUSHED.at
  const matches = PUSHED.threadId && threadId ? PUSHED.threadId === threadId.toLowerCase() : null
  if (PUSHED.at === null) return { state: 'unknown', phase: null, ageMs, matchesThread: matches }
  if (matches === false) return { state: 'other-thread', phase: null, ageMs, matchesThread: false }
  if (PUSHED.phase === 'failed') return { state: 'failed', phase: 'failed', ageMs, matchesThread: matches }
  if (PUSHED.phase === 'streaming') return { state: 'generating', phase: 'streaming', ageMs, matchesThread: matches }
  return { state: 'idle', phase: PUSHED.phase, ageMs, matchesThread: matches }
}

/**
 * What `status` says, from the pushed signal plus (when needed) one DOM look.
 *
 * Pure: the pushed phase and the DOM sample are arguments, so the rule can be
 * proved without a page. The precedence is the page's own word:
 *
 * - a pushed `failed` is final (a failure chip wins over an `in_progress` turn);
 * - a pushed `generating` is final too: downgrading it needs the ANSWER to be
 *   proven complete, and this path never reads the answer, so a page that just
 *   stopped still reads `generating` until the turn loop proves it;
 * - otherwise the DOM decides. `generating` whenever the page shows a live turn
 *   (visible Stop, `streaming`/`thinking`, or `in_progress`), `other-thread`
 *   when the page is on another conversation, `idle` when it shows no live turn;
 * - `unknown` ONLY when the driver cannot be asked at all (no CDP, no page, a
 *   wedged evaluate). That is the defect this replaces: `unknown` used to mean
 *   "there is a turn and I have no recent signal", which is never honest.
 */
function statusVerdict({ pushed, phase, live, threadId }) {
  if (pushed === 'failed') return { state: 'failed', phase: phase ?? 'failed', cost: 'push' }
  if (pushed === 'generating') return { state: 'generating', phase: phase ?? 'streaming', cost: 'push' }
  if (!live || live.askable !== true || live.page !== true) {
    return { state: 'unknown', phase: null, cost: 'push', evidence: 'the page could not be asked' }
  }
  const thread = typeof live.thread === 'string' ? live.thread.toLowerCase() : null
  if (thread && thread !== String(threadId).toLowerCase()) {
    return { state: 'other-thread', phase: null, cost: 'page', evidence: 'the page is on another thread' }
  }
  if (live.live === true) return { state: 'generating', phase: 'streaming', cost: 'page' }
  return {
    state: 'idle', phase: phase ?? null, cost: 'page',
    // No push and no live turn is a real answer ("nothing is running"), not
    // ignorance: say so once, plainly.
    ...(pushed === 'unknown' ? { evidence: 'the page shows no live turn' } : {}),
  }
}

/** A CDP send that must answer within `ms`; a wedged session fails, not hangs. */
function cdpTimed(promise, ms) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`cdp did not answer within ${ms} ms`)), ms)
      timer.unref?.()
    }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * One `page.evaluate` that must answer within `ms`.
 *
 * A fresh connection answers a page instantly even while it streams, so a
 * timeout means the connection is wedged, not that the page is slow. The
 * promise left behind cannot be cancelled; it simply never settles into
 * anything anyone reads.
 */
/**
 * An op-level ceiling. A timeout here is a state (`reason:'timeout'`), never a
 * claim that the page failed: the only thing known is that no answer came.
 */
function opTimed(ms, op, fn) {
  let timer
  return Promise.race([
    fn(),
    new Promise(resolve => {
      timer = setTimeout(() => resolve({ ok: false, op, reason: 'timeout', error: `no answer within ${ms} ms` }), ms)
      timer.unref?.()
    }),
  ]).finally(() => clearTimeout(timer))
}

async function evaluateTimed(page, fn, arg, ms = 15_000) {
  let timer
  try {
    return await Promise.race([
      page.evaluate(fn, arg),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new TurnError(`page.evaluate did not answer within ${ms} ms`, { reason: 'timeout' })), ms)
        timer.unref?.()
      }),
    ])
  } finally { clearTimeout(timer) }
}

/**
 * The page's own push channel: one CDP connection, kept for the life of
 * `serve`, deliberately separate from the per-request connections `withPage`
 * opens and closes. It watches every chatgpt.com tab and reports, per tab,
 * when a turn starts and finishes and when the tab moves to another thread.
 *
 * A dead connection is not an error to spin on: it reports `page-lost` and
 * reconnects with a capped backoff, and reports `page-ready` when the observer
 * is installed again.
 *
 * A LIVE connection can also go quiet without dying - it stops answering while
 * the page is fine. So the channel watches itself: `claimed()` says whether a
 * turn is thought to be running, and the watchdog reconnects when a claimed
 * turn has produced no event for `QUIET_MS`.
 */
function startEventChannel(emit, claimed = () => false) {
  const state = { stopped: false, browser: null, pages: new Map(), retry: 0, timer: null, lastSeenAt: Date.now(), watchdog: null }
  const QUIET_MS = 60_000

  const note = (line) => { void log(`event channel: ${line}`) }

  const emitSafe = value => {
    if (state.stopped) return
    try { emit(value) } catch {}
  }

  const install = async entry => {
    if (state.stopped) return 'stopped'
    let result
    try {
      result = await cdpTimed(entry.session.send('Runtime.evaluate', { expression: OBSERVER_SCRIPT, returnByValue: true, awaitPromise: false }), 15_000)
    } catch (error) {
      // The document may be mid-navigation; the next frameNavigated retries.
      return 'failed'
    }
    // Which document is this? A reload makes a new one, and a new document is a
    // page that has come back: it gets one page-ready, so the host reconciles
    // now instead of at the next timer. A repeated frame or load event on the
    // document already known keeps the same mark and stays silent. After a
    // reload the observer is already in place (addScriptToEvaluateOnNewDocument
    // ran), so the install itself can only answer `already` - the mark is what
    // tells the two apart. The first look at a document is the baseline, not a
    // change.
    let mark = null
    try {
      const asked = await cdpTimed(entry.session.send('Runtime.evaluate', { expression: 'window.__gwObserverDoc || null', returnByValue: true }), 10_000)
      mark = typeof asked?.result?.value === 'string' ? asked.result.value : null
    } catch { /* mid-navigation; the next event retries */ }
    state.lastSeenAt = Date.now()
    // Ask the observer for its current state. A child that attaches to a page
    // whose observer is already installed would otherwise hear nothing until
    // the page next changes - during a long turn, exactly when it is needed.
    try { await cdpTimed(entry.session.send('Runtime.evaluate', { expression: 'window.__gwPush && window.__gwPush()' }), 10_000) } catch { /* the watchdog retries */ }
    if (!entry.primed) {
      entry.primed = true
      if (mark) entry.docId = mark
    } else if (mark && mark !== entry.docId) {
      entry.docId = mark
      entry.announced = false
    }
    const value = result?.result?.value
    if (value === 'already') {
      // The document is still the one we were watching: a repeated load or
      // frame event, not a page that came back. It is worth one page-ready
      // only when this connection is new - a fresh driver child attaches to a
      // page whose observer (and its stale binding) came from the child before
      // it - and silence afterwards.
      if (!entry.announced) {
        entry.announced = true
        emitSafe({ event: 'page-ready', threadId: entry.threadId ?? null })
      }
      return 'already'
    }
    entry.announced = true
    emitSafe({ event: 'page-ready', threadId: entry.threadId ?? null })
    return 'installed'
  }

  const attach = async page => {
    if (state.stopped || state.pages.has(page)) return
    // The binding injects into whatever document this is; only the real origin
    // gets one, or a lookalike page could learn the observer's shape.
    if (!isChatGPTUrl(page.url())) return
    let session
    try { session = await page.context().newCDPSession(page) } catch { return }
    if (state.stopped) { try { await session.detach() } catch {} ; return }
    const entry = { page, session, threadId: null, announced: false, docId: null, primed: false }
    state.pages.set(page, entry)
    session.on('Runtime.bindingCalled', event => {
      if (state.stopped || event.name !== '__gatewayEvent') return
      state.lastSeenAt = Date.now()
      let message
      try { message = JSON.parse(event.payload) } catch { return }
      if (!message || typeof message.event !== 'string') return
      if (message.event === 'signal') {
        // The observer sends the phase word only. Nothing else in the payload
        // is page content, and nothing else is forwarded.
        const threadId = typeof message.threadId === 'string' && message.threadId ? message.threadId.toLowerCase() : null
        const phase = message.phase === 'complete' || message.phase === 'streaming' || message.phase === 'failed' ? message.phase : null
        const at = Number.isFinite(message.at) ? message.at : Date.now()
        notePush(phase, threadId, at)
        emitSafe({ event: 'signal', threadId, phase, at })
        return
      }
      if (message.event === 'navigated' && typeof message.threadId === 'string' && message.threadId) {
        entry.threadId = message.threadId
        emitSafe({ event: 'navigated', threadId: message.threadId })
      }
    })
    try {
      await session.send('Page.enable')
      await session.send('Runtime.enable')
      await session.send('Runtime.addBinding', { name: '__gatewayEvent' })
      await session.send('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVER_SCRIPT })
    } catch (error) {
      note(`could not install on ${page.url()}: ${error.message}`)
    }
    session.on('Page.frameNavigated', frame => { state.lastSeenAt = Date.now(); if (!frame.parentId) void install(entry) })
    session.on('Page.loadEventFired', () => { state.lastSeenAt = Date.now(); void install(entry) })
    page.on('close', () => {
      state.pages.delete(page)
      if (state.pages.size === 0) {
        note('every watched tab closed')
        PUSHED.phase = null
        PUSHED.at = null
        emitSafe({ event: 'page-lost' })
      }
    })
    page.on('crash', () => {
      state.pages.delete(page)
      note('a watched tab crashed')
    })
    await install(entry)
  }

  const attachContext = context => {
    for (const page of context.pages()) void attach(page)
    context.on('page', page => {
      // A new tab may start blank and navigate later; `attach` is idempotent and
      // only takes a tab whose URL is chatgpt.com, so retry it on navigation.
      page.on('framenavigated', () => void attach(page))
      void attach(page)
    })
  }

  const scheduleReconnect = () => {
    if (state.stopped || state.timer) return
    const delay = Math.min(1000 * 2 ** Math.min(state.retry, 5), 30_000)
    state.timer = setTimeout(() => { state.timer = null; void connectLoop() }, delay)
    state.timer.unref?.()
  }

  const connectLoop = async () => {
    if (state.stopped) return
    let browser
    try { browser = await connectOwned() }
    catch (error) {
      // Not ours (or not running): the channel waits rather than installing an
      // observer into a browser this driver does not own.
      if (!(error instanceof Error) || !/chrome is not running/.test(error.message)) note(`not attaching: ${error instanceof Error ? error.message : String(error)}`)
      state.retry += 1
      scheduleReconnect()
      return
    }
    if (state.stopped) { try { await browser.close() } catch {} ; return }
    state.retry = 0
    state.browser = browser
    note('connected')
    browser.on('disconnected', () => {
      if (state.browser !== browser) return
      state.browser = null
      for (const entry of state.pages.values()) { try { void entry.session.detach() } catch {} }
      state.pages.clear()
      note('disconnected')
      // The last word from the old connection is not news any more.
      PUSHED.phase = null
      PUSHED.at = null
      emitSafe({ event: 'page-lost' })
      scheduleReconnect()
    })
    for (const context of browser.contexts()) attachContext(context)
  }

  // A live connection can silently stop answering. While a turn is claimed to
  // be running, silence is a wedge, not a quiet page: drop the connection and
  // let the reconnect install a fresh one (with a fresh binding).
  const watchdog = () => {
    if (state.stopped) return
    state.watchdog = setTimeout(watchdog, 10_000)
    state.watchdog.unref?.()
    if (!state.browser || state.pages.size === 0) return
    if (!claimed()) return
    if (Date.now() - state.lastSeenAt < QUIET_MS) return
    note(`no page event for ${Math.round((Date.now() - state.lastSeenAt) / 1000)}s during a turn; reconnecting the channel`)
    state.lastSeenAt = Date.now()
    const browser = state.browser
    Promise.resolve(browser.close()).catch(() => {})
  }

  return {
    start() { void connectLoop(); watchdog() },
    status() { return { connected: Boolean(state.browser), tabs: state.pages.size, retry: state.retry } },
    async stop() {
      state.stopped = true
      if (state.timer) { clearTimeout(state.timer); state.timer = null }
      if (state.watchdog) { clearTimeout(state.watchdog); state.watchdog = null }
      for (const entry of state.pages.values()) { try { await entry.session.detach() } catch {} }
      state.pages.clear()
      const browser = state.browser
      state.browser = null
      if (browser) { try { browser.removeAllListeners(); await browser.close() } catch {} }
    },
  }
}

/**
 * Line-JSON host protocol on stdio. One request per line, one response per
 * line; an `event` line may precede a response (acceptance, which the host
 * needs before the answer exists). Operations run one at a time.
 */
async function serve() {
  STDOUT_RESERVED = true
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`)
  let chain = Promise.resolve()
  let closing = false
  let outstanding = 0
  const channel = startEventChannel(value => {
    // Once quit has been answered, nothing else may follow it on the wire.
    if (closing) return
    emit(value)
  }, () => PUSHED.phase === 'streaming')

  const run = async request => {
    const op = request.op
    // The cheapest thing that makes the child exist: it touches no page and
    // starts no Chrome, but it brings the event channel up before the host has
    // any other reason to ask for something.
    if (op === 'ping') return { ok: true, op, channel: channel.status() }
    if (op === 'status') {
      // With a threadId this is the NON-BLOCKING TURN STATUS. The DEFAULT form
      // answers from the pushed page signal: no evaluate, no network, nothing
      // that can hang or be rate-limited, so it is safe every two seconds.
      // `deep:true` is the only form that reads the thread, and it carries its
      // own hard timeout. Without a threadId this stays the page/model report
      // the CLI has always printed.
      if (typeof request.threadId === 'string' && request.threadId) {
        const threadId = String(request.threadId)
        if (!THREAD_ID.test(threadId)) return { ok: false, op, error: 'threadId must be a conversation uuid' }
        const cheap = pushedState(threadId)
        const at = PUSHED.at === null ? null : new Date(PUSHED.at).toISOString()
        if (request.deep !== true) {
          // A pushed `failed` or `generating` needs no second opinion. Anything
          // else may simply be a signal older than the turn, so one cheap DOM
          // look decides - never the conversation, which is the 429 risk.
          const needsLook = cheap.state !== 'failed' && cheap.state !== 'generating'
          const live = needsLook ? await cheapLiveTurn(threadId) : null
          const verdict = statusVerdict({ pushed: cheap.state, phase: cheap.phase, live, threadId })
          return {
            ok: true, op, cost: verdict.cost, threadId,
            pushedThreadId: PUSHED.threadId,
            matchesThread: cheap.matchesThread,
            state: verdict.state, phase: verdict.phase, ageMs: cheap.ageMs, at,
            ...(verdict.evidence ? { evidence: verdict.evidence } : {}),
          }
        }
        const read = await backendGetRetry(`/backend-api/conversation/${threadId}`)
        if (!read.ok) {
          if (read.reason === 'timeout') return { ok: false, op, reason: 'timeout', threadId, cost: 'conversation' }
          if (read.status === 401) return { ok: true, op, cost: 'conversation', threadId, state: 'failed', reason: 'not-signed-in', evidence: 'not signed in', phase: cheap.phase, ageMs: cheap.ageMs, at }
          if (read.status === 404) return { ok: true, op, cost: 'conversation', threadId, state: 'failed', reason: 'not-found', evidence: 'the thread answered 404', phase: cheap.phase, ageMs: cheap.ageMs, at }
          return { ok: false, op, cost: 'conversation', threadId, status: read.status, error: read.error }
        }
        const detail = turnStatus(read.body)
        const staleNode = detail.nodeId && !detail.complete
          ? { nodeId: detail.nodeId, status: detail.status, since: typeof detail.createTime === 'number' ? new Date(detail.createTime * 1000).toISOString() : null }
          : null
        const common = {
          ok: true, op, cost: 'conversation', threadId,
          phase: cheap.phase, ageMs: cheap.ageMs, at,
          matchesThread: cheap.matchesThread,
          latestAssistant: detail,
          nodeActivity: nodeActivityOf(read.body),
          files: detail.files,
          ...(staleNode ? { staleNode } : {}),
        }
        // Precedence is the page's own word first, the conversation second: a
        // live 2026-10-30 observation had a node stuck at `in_progress` for
        // ~20 minutes across a reload, after the page had settled. So a pushed
        // failure wins, a pushed stop wins, and a node may never say "still
        // generating" by itself - it only says whether the ANSWER is complete.
        if (cheap.state === 'failed') return { ...common, state: 'failed', reason: 'page-error', evidence: 'the page rendered a failure message' }
        if (cheap.state === 'generating') return { ...common, state: 'generating' }
        if (cheap.state === 'unknown' || cheap.state === 'other-thread') {
          // Nothing has been pushed about this thread, so this read cannot say
          // whether the page is working; only whether an answer is complete.
          return { ...common, state: detail.complete ? 'idle' : 'unknown' }
        }
        return { ...common, state: 'idle' }
      }
      // The CLI's page report. It touches the picker, so it is bounded too: a
      // wedged connection must answer, not hang the caller.
      return opTimed(60_000, 'status', async () => withPage(async page => {
        const state = await pageState(page)
        const model = state.composer ? await readModelState(page) : { model: null, effort: null, models: [] }
        return {
          ok: true, op, signedIn: state.loggedIn, email: state.email, plan: state.plan,
          composer: state.composer, challenge: state.challenge, url: page.url(),
          threadId: threadOf(page.url()), model: model.model, effort: model.effort, models: model.models,
        }
      }))
    }
    if (op === 'file') {
      // No bytes on stdio, no base64, no cookie ever leaves the page. The
      // pre-signed URL only works with this profile's cookie jar, so the pull
      // is made by Playwright's own request context and written straight to
      // the absolute path the host chose.
      //
      // TWO WAYS TO LEARN THE FILE ID, because the page names its own files
      // differently from a file a person attached:
      //  - `fileId`: metadata.attachments[].id / an asset pointer (a person's
      //    upload, or anything with an attachment record);
      //  - `messageId` + `sandboxPath`: a file the PAGE made. It has no id at
      //    all, only a `sandbox:/mnt/data/<name>` link in the answer, so the
      //    id comes from the interpreter lookup for that node. Proven live
      //    2026-10-30.
      const outPath = String(request.outPath ?? '')
      if (!outPath || !path.isAbsolute(outPath)) return { ok: false, op, reason: 'bad-path', detail: 'outPath must be absolute' }
      const cap = Math.min(32 * 1024 * 1024, Number.isFinite(Number(request.maxBytes)) && Number(request.maxBytes) > 0 ? Number(request.maxBytes) : 32 * 1024 * 1024)
      let fileId = String(request.fileId ?? '')
      let sandboxPath = ''
      let sandboxRequest = null
      if (fileId) {
        if (!FILE_ID.test(fileId)) return { ok: false, op, reason: 'bad-id', detail: 'fileId must be a file id, not a path or url' }
      } else {
        sandboxPath = String(request.sandboxPath ?? '')
        const threadId = String(request.threadId ?? '')
        const messageId = String(request.messageId ?? '')
        if (!/^\/mnt\/data\/[^\s/]+$/.test(sandboxPath)) return { ok: false, op, reason: 'bad-id', detail: 'sandboxPath must be /mnt/data/<name>' }
        if (!THREAD_ID.test(threadId) || !MESSAGE_ID.test(messageId)) {
          return { ok: false, op, reason: 'bad-id', detail: 'a sandbox file needs the thread id and the node that links it' }
        }
        sandboxRequest = { threadId, messageId }
      }
      await ensureChrome({ visible: true })
      const { browser, context, page } = await connect()
      try {
        if (sandboxRequest) {
          const { threadId, messageId } = sandboxRequest
          const lookup = await backendGetOn(page, `/backend-api/conversation/${threadId}/interpreter/download?message_id=${encodeURIComponent(messageId)}&sandbox_path=${encodeURIComponent(sandboxPath)}`, 30_000)
          if (!lookup.ok) {
            const reason = lookup.status === 404 ? 'not-found' : lookup.reason === 'timeout' ? 'timeout' : 'http'
            return { ok: false, op, reason, status: lookup.status, detail: lookup.error }
          }
          const resolved = lookup.body ?? {}
          if (String(resolved.status ?? '') !== 'success') return { ok: false, op, reason: 'not-found', detail: 'the interpreter lookup did not succeed for that path' }
          const id = String(resolved.metadata?.file_id ?? resolved.file_id ?? '')
          if (!FILE_ID.test(id)) return { ok: false, op, reason: 'not-found', detail: 'the interpreter lookup returned no file id' }
          fileId = id
        }
        const meta = await backendGetOn(page, `/backend-api/files/${fileId}/download`, 30_000)
        if (!meta.ok) {
          const reason = meta.status === 404 ? 'not-found' : meta.reason === 'timeout' ? 'timeout' : 'http'
          return { ok: false, op, reason, status: meta.status, detail: meta.error }
        }
        const body = meta.body ?? {}
        const downloadUrl = String(body.download_url ?? body.downloadUrl ?? '')
        const name = String(body.file_name ?? body.fileName ?? '') || (sandboxPath ? sandboxPath.split('/').at(-1) : '')
        const size = Number(body.file_size_bytes ?? body.file_size ?? body.fileSize ?? 0) || 0
        // The size is known BEFORE the download: refuse over the cap without
        // pulling a byte of it.
        if (size > cap) return { ok: false, op, reason: 'too-large', detail: `${size} bytes exceeds ${cap}` }
        if (!/^https:\/\//i.test(downloadUrl)) return { ok: false, op, reason: 'http', detail: 'the page returned no https download url' }
        const response = await context.request.get(downloadUrl, { timeout: 60_000 })
        if (!response.ok()) return { ok: false, op, reason: 'http', status: response.status() }
        const buffer = Buffer.from(await response.body())
        if (buffer.length > cap) return { ok: false, op, reason: 'too-large', detail: `${buffer.length} bytes exceeds ${cap}` }
        await fs.mkdir(path.dirname(outPath), { recursive: true })
        try { await fs.writeFile(outPath, buffer, { flag: 'wx' }) }
        catch (error) { return { ok: false, op, reason: error?.code === 'EEXIST' ? 'exists' : 'io', detail: String(error?.message ?? error) } }
        return {
          ok: true, op, path: outPath, bytes: buffer.length,
          sha256: createHash('sha256').update(buffer).digest('hex'),
          name, fileId, mimeType: null, mimeTypeHint: String(body.mime_type ?? body.mimeType ?? ''),
        }
      } finally { await browser.close().catch(() => {}) }
    }
    if (op === 'reload') {
      // The operator's recovery for a turn whose page died. It only ever
      // reloads the named thread; it never wanders to another conversation.
      const threadId = String(request.threadId ?? '')
      if (!THREAD_ID.test(threadId)) return { ok: false, op, error: 'threadId must be a conversation uuid' }
      await ensureChrome({ visible: true })
      const { browser, page } = await connect()
      try {
        const showing = threadOf(page.url())
        if (showing && showing.toLowerCase() === threadId.toLowerCase()) await page.reload({ waitUntil: 'domcontentloaded' })
        else await page.goto(`https://chatgpt.com/c/${threadId}`, { waitUntil: 'domcontentloaded' })
        await waitForLogin(page, 60_000)
        await waitForComposer(page)
        ACTIVE_THREAD = threadId.toLowerCase()
        return { ok: true, op, threadId, url: page.url() }
      } finally { await browser.close().catch(() => {}) }
    }
    if (op === 'send') {
      const text = String(request.text || '')
      if (!text.trim()) return { ok: false, op, error: 'empty text' }
      const attachments = []
      if (request.attach && typeof request.attach === 'object') {
        const name = String(request.attach.name || '')
        const base64 = String(request.attach.base64 || '')
        if (!name || !base64) return { ok: false, op, error: 'attach requires name and base64' }
        let buffer
        try { buffer = decodeBase64(base64, `attachment "${name}"`) }
        catch (error) { return { ok: false, op, error: String(error.message) } }
        attachments.push({ name, mimeType: String(request.attach.mimeType || 'text/plain'), buffer })
      }
      return withPage(async page => {
        const result = await ask(page, text, {
          threadId: request.threadId || null,
          newChat: Boolean(request.newChat),
          wait: request.wait !== false,
          onAccepted: threadId => emit({ event: 'accepted', threadId, id: request.id }),
          attachments,
        })
        const sentThread = threadOf(result.url)
        if (sentThread) ACTIVE_THREAD = sentThread
        // A live turn that outlasted the send timeout is still running. Saying
        // so is a state, not a failure: `failed` is reserved for evidence.
        if (result.timedOut) {
          return {
            ok: false, op, state: 'generating', timedOut: true, threadId: sentThread, url: result.url,
            error: `still generating after ${result.seconds}s; the turn is running, not refused`,
          }
        }
        if (request.wait === false) {
          return {
            ok: true, op, accepted: true, threadId: sentThread, url: result.url,
            state: 'generating', acceptedAt: result.acceptedAt, model: null, effort: null,
          }
        }
        const model = await readModelState(page).catch(() => ({}))
        return {
          ok: true, op, text: result.reply, threadId: sentThread, url: result.url,
          model: model.model ?? null, effort: model.effort ?? null, state: 'complete',
          attachment: result.attachment ?? null,
        }
      })
    }
    if (op === 'attach') {
      const name = String(request.name || '')
      const base64 = String(request.base64 || '')
      if (!name) return { ok: false, op, error: 'attach requires name' }
      if (!base64) return { ok: false, op, error: 'attach requires base64' }
      let buffer
      try { buffer = decodeBase64(base64, `attachment "${name}"`) }
      catch (error) { return { ok: false, op, error: String(error.message) } }
      const mimeType = String(request.mimeType || 'text/plain')
      return withPage(async page => {
        const attachment = await attachFile(page, { name, mimeType, buffer })
        return { ok: attachment.state !== 'rejected', op, attachment }
      })
    }
    if (op === 'set') {
      return withPage(async page => {
        const state = await setModelState(page, { model: request.model, effort: request.effort })
        return { ok: true, op, model: state.model, effort: state.effort, models: state.models }
      })
    }
    if (op === 'threads') {
      return withPage(async page => {
        // The sidebar is a rendering of the conversation list, not the list. The
        // authoritative read is the backend the sidebar is built from, made from
        // inside the page; the open tab still answers which thread is showing.
        const read = await backendGetOn(page, '/backend-api/conversations?offset=0&limit=100&order=updated', 30_000)
        if (!read.ok) return { ok: false, op, status: read.status, error: read.error }
        const threads = (read.body?.items ?? []).map(item => ({ id: item.id, title: item.title ?? '' }))
        return { ok: true, op, threadId: threadOf(page.url()), threads }
      })
    }
    if (op === 'use') {
      if (!request.threadId) return { ok: false, op, error: 'threadId required' }
      const target = String(request.threadId)
      await ensureChrome({ visible: true })
      const { browser, context, page } = await connect()
      try {
        // Adopt before navigating: if the user already has this thread open in
        // a tab, bridging it must not reload (and must not spawn a second tab
        // for the same conversation). A reload would also lose any composer
        // draft in that tab.
        const existing = context.pages().find(p => isChatGPTUrl(p.url()) && (threadOf(p.url()) || '').toLowerCase() === target.toLowerCase())
        if (existing) {
          ACTIVE_THREAD = target.toLowerCase()
          return { ok: true, op, threadId: threadOf(existing.url()), url: existing.url(), adopted: true }
        }
        await page.goto(`https://chatgpt.com/c/${target}`, { waitUntil: 'domcontentloaded' })
        await waitForLogin(page, 60_000)
        const landed = threadOf(page.url())
        if (!landed || landed.toLowerCase() !== target.toLowerCase()) {
          return { ok: false, op, error: `the page landed on ${landed ?? 'no thread'} instead of the requested thread ${target}` }
        }
        ACTIVE_THREAD = landed.toLowerCase()
        return { ok: true, op, threadId: landed, url: page.url(), adopted: false }
      } finally { await browser.close().catch(() => {}) }
    }
    if (op === 'read') {
      return opTimed(60_000, op, () => withPage(async page => {
        const threadId = threadOf(page.url())
        if (!threadId) return { ok: false, op, error: 'no thread is open' }
        const turn = await readNewestTurn(page)
        if (!turn.found) return { ok: false, op, error: 'no assistant turn is on the page', threadId }
        if (!turn.evidence) return { ok: false, op, error: 'the newest assistant turn is still in progress', threadId }
        return { ok: true, op, threadId, text: clampReply(turn.text), evidence: turn.evidence, at: new Date().toISOString() }
      }))
    }
    if (op === 'conversation') {
      const threadId = String(request.threadId ?? '')
      if (!THREAD_ID.test(threadId)) return { ok: false, op, error: 'threadId must be a conversation uuid' }
      const read = await backendGetRetry(`/backend-api/conversation/${threadId}`)
      if (!read.ok) return { ok: false, op, status: read.status, reason: read.reason, error: read.error }
      const { current_node = null, mapping = {} } = read.body ?? {}
      return { ok: true, op, threadId, conversation: { current_node, mapping } }
    }
    if (op === 'conversations') {
      const offset = Math.max(0, Math.floor(Number(request.offset ?? 0)) || 0)
      const limit = Math.min(100, Math.max(1, Math.floor(Number(request.limit ?? 100)) || 100))
      const read = await backendGetRetry(`/backend-api/conversations?offset=${offset}&limit=${limit}&order=updated`)
      if (!read.ok) return { ok: false, op, status: read.status, error: read.error }
      const items = (read.body?.items ?? []).map(item => ({ id: item.id, title: item.title ?? '', update_time: item.update_time ?? null }))
      return { ok: true, op, offset, limit, items }
    }
    if (op === 'unload') {
      await doQuit()
      ACTIVE_THREAD = null
      return { ok: true, op, state: 'unloaded' }
    }
    return { ok: false, op, error: `unknown op ${op ?? '(missing)'}` }
  }

  emit({ event: 'ready', pid: process.pid })
  channel.start()
  // Every reply is correlated by id, so a second request reusing the id of one
  // still queued cannot be told apart from the first.
  const pending = new Set()
  const MAX_REQUEST_ID = 200
  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let request
    try { request = JSON.parse(trimmed) } catch { emit({ ok: false, id: null, error: 'invalid json' }); continue }
    // `null`, an array or a scalar is not a request. Reading `.op` on `null`
    // threw OUTSIDE the per-request handler and killed the child: one bare
    // `null` line lost the driver, and with it whatever turn was running.
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      emit({ ok: false, id: null, error: 'invalid request envelope: expected a JSON object' })
      await log(`refused envelope: ${trimmed.slice(0, 120)}`)
      continue
    }
    const id = request.id
    const validId = typeof id === 'string' && id.length > 0 && id.length <= MAX_REQUEST_ID
    const replyId = validId ? id : null
    // An id-less frame would be answered without an id (JSON.stringify drops
    // undefined), so the caller could never match the answer. The one exception
    // is `quit`: the host's kill() writes {"op":"quit"} with no id and waits
    // for the child to exit, so it stays a defined, id-less control frame.
    if (!validId && request.op !== 'quit') {
      emit({ ok: false, id: null, error: 'invalid request envelope: id must be a non-empty string (max 200 chars)' })
      await log(`refused request without a usable id: ${trimmed.slice(0, 120)}`)
      continue
    }
    if (validId && pending.has(id)) {
      emit({ ok: false, op: request.op, id, error: 'duplicate in-flight id: a request with this id has not answered yet' })
      continue
    }
    if (request.op === 'quit') {
      // Quitting drains, it does not abandon. New work is refused from this
      // point (the reader is closed), what is already queued runs, and only
      // then does the quit answer go out - so a page turn is never cut off
      // mid-flight and a caller is never left guessing whether its op ran.
      closing = true
      rl.close()
      emit({ event: 'draining', queued: outstanding })
      await chain
      await channel.stop()
      // Leaving the child does not mean leaving the browser: the page is the
      // shared resource, and `unload` is the op that closes it. A driver
      // restart therefore finds the same signed-in Chrome and thread.
      emit({ ok: true, op: 'quit', id: replyId })
      break
    }
    if (closing) { emit({ ok: false, op: request.op, id: replyId, error: 'the driver is draining; the request was not accepted' }); continue }
    outstanding += 1
    if (validId) pending.add(id)
    chain = chain.then(
      () => run(request).then(
        result => { emit({ ...result, id: replyId }); return result },
        error => {
          // `reason` (and the state it explains) is part of the contract: the
          // host acts on it rather than parsing English.
          emit({
            ok: false, op: request.op, id: replyId, error: error.message,
            ...(error.reason ? { reason: error.reason } : {}),
            ...(error.state ? { state: error.state } : {}),
            ...(error.threadId ? { threadId: error.threadId } : {}),
          })
          return null
        },
      ),
    ).finally(() => { outstanding -= 1; if (validId) pending.delete(id) })
  }
}

export {
  ask, attachFile, connect, ensureChrome, pageState, waitForLogin, doQuit, serve, readNewestTurn,
  BASE, log,
  // Pure or page-free helpers, exported so the guard logic can be proven without
  // a live page (origin check, base64 validation, install probe, acceptance,
  // browser identity).
  isChatGPTUrl, decodeBase64, chromePath, waitForAcceptance, parseBrowserUrl, attachVerdict, statusVerdict,
  treeHasSentText, degradedSendVerdict, launchVerdict, ownerCarriesProfile, portOwner,
  exhaustedLaunchWhy,
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const [command = 'status', ...rest] = process.argv.slice(2)
  try {
    if (command === 'check') await doCheck()
    else if (command === 'probe') await doProbe()
    else if (command === 'login') await doLogin(Number(process.env.CHATGPT_LOGIN_MINUTES || 15))
    else if (command === 'status') await doStatus()
    else if (command === 'quit') await doQuit()
    else if (command === 'ask') {
      const newChat = rest.includes('--new')
      const text = rest.filter(item => item !== '--new').join(' ').trim()
      if (!text) throw new Error('Usage: node chatgpt.mjs ask "text" [--new]')
      await doAsk(text, newChat)
    } else if (command === 'chat') await doChat()
    else if (command === 'serve') await serve()
    else { console.log('Commands: check | login | status | ask "text" [--new] | chat | serve | quit'); process.exit(1) }
  } catch (error) {
    console.error(`[fatal] ${error.message}`)
    await log(`fatal ${error.message}`)
    process.exit(1)
  }
}
