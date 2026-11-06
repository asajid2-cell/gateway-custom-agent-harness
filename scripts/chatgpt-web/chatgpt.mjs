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
import { closeSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import readline from 'node:readline'
import { AsyncLocalStorage } from 'node:async_hooks'

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
/**
 * Where this child writes its PID and log.
 *
 * The default is the one-window driver's historic home. A lane gets its own
 * directory from the host, because many lane children run at once and must not
 * overwrite one `chrome.pid` or interleave one `driver.log`.
 */
const STATE_DIR = process.env.CHATGPT_STATE_DIR || BASE
const PID_FILE = path.join(STATE_DIR, 'chrome.pid')
const LOG = path.join(STATE_DIR, 'driver.log')
const PORT = Number(process.env.CHATGPT_CDP_PORT || 9222)
const CHAT_URL = 'https://chatgpt.com/'
const MAX_REPLY = 63_000 // bus messages cap at 64 KiB
/**
 * Lane mode: this child works one page on behalf of one writer, inside the
 * master browser. A source port of 0 means the original one-window driver, and
 * every lane behaviour is off.
 */
const LANE_ID = process.env.CHATGPT_LANE_ID || ''
const LANE_SOURCE_PORT = Number(process.env.CHATGPT_LANE_SOURCE_PORT || 0)

/**
 * Shared-browser lanes: a lane is a named TAB in the master browser.
 *
 * Copying the login into a second profile is racy by construction. The master's
 * session token rotates while the copy is in flight, two lanes that branch the
 * same snapshot invalidate each other, and the write-back at close races the
 * next lane's read. One browser has one cookie jar, so the shared shape has
 * nothing to copy, nothing to rotate and nothing to write back - there is only
 * ever one session, and the tab is the unit of isolation.
 */
const LANE_SHARED = (process.env.CHATGPT_LANE_SHARED || process.env.GEMINI_LANE_SHARED || '0') === '1'
/** The port every CDP call in this process talks to. */
const CONNECT_PORT = LANE_SHARED && LANE_SOURCE_PORT ? LANE_SOURCE_PORT : PORT
/** The master's profile: the browser a shared lane lives in. */
const SHARED_PROFILE = String(process.env.CHATGPT_LANE_SOURCE_PROFILE || process.env.GEMINI_LANE_SOURCE_PROFILE || '').trim()
/** The profile a shared lane proves the browser with; its own is never launched. */
const OWN_PROFILE = LANE_SHARED ? (SHARED_PROFILE || PROFILE) : PROFILE
/** The name every lane tab carries, whoever opened it. */
const LANE_TAB_PREFIX = 'webbridge-lane:'
/** A lane tab is named, so lanes never borrow the operator's own tab. */
const LANE_TAB = LANE_ID ? `${LANE_TAB_PREFIX}${LANE_ID}` : ''
const LANE_SHARED_DIR = process.env.CHATGPT_LANE_SHARED_DIR || path.dirname(STATE_DIR)
/**
 * The lane this request is for, when one process serves several tabs.
 *
 * The host used to give every writer its own driver process, so the lane was a
 * process-wide env var. It now runs ONE child per browser and puts `lane` on
 * each request; everything that used to read LANE_ID reads this instead, so a
 * single process can own one tab per inputter without them colliding.
 */
const LANE_CTX = new AsyncLocalStorage()
const laneOf = () => LANE_CTX.getStore() || LANE_ID
/**
 * One tab can be in front at a time and Playwright's typing waits for the field
 * to take focus: two lanes typing at once race for it and one turns is refused
 * as "not-posted". The token is held only while composing and clicking, never
 * while waiting for an answer, so turns still overlap.
 */
const FOCUS_LOCK = path.join(LANE_SHARED_DIR, 'webbridge-focus.lock')
const FOCUS_STALE_MS = 60_000
/**
 * One browser-level attach at a time, across every lane.
 *
 * Concurrent attaches are what wedges Chrome 156: two websockets open and
 * neither handshake completes, and the browser then refuses every NEW attach
 * while its HTTP endpoints still answer. Serialising the attach is the cheap
 * half of the fix; `replaceOwnedBrowser` is the half for a browser that is
 * already wedged.
 */
const ATTACH_LOCK = path.join(LANE_SHARED_DIR, 'webbridge-attach.lock')
/**
 * One LAUNCH at a time, across every child that shares this browser.
 *
 * Two children that both see the port down will both launch, and the second
 * sees a browser that is still booting, decides it is an orphan, and kills it -
 * a launch cascade that never converges (measured 2026-11-05: two launches four
 * seconds apart, neither surviving). The lock makes the second child wait for
 * the first launch to finish instead of racing it.
 */
const LAUNCH_LOCK = path.join(LANE_SHARED_DIR, 'webbridge-launch.lock')
/**
 * Where a lane says its tab is still wanted, and how long that word stands.
 *
 * The host can terminate a driver at any moment and a terminated child cannot
 * close its tab, so a tab is swept by whoever opens a lane next: only a tab
 * whose lease is missing or older than this window is closed. A live lane keeps
 * its lease fresh, and a leaked tab is cleaned without a bookkeeper process.
 */
const LANE_LEASE_DIR = path.join(LANE_SHARED_DIR, 'lane-tabs')
const LANE_LEASE_STALE_MS = 3 * 60_000

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
const ACTIVE_THREADS = new Map()
const activeThread = () => ACTIVE_THREADS.get(laneOf() || '') || null
const setActiveThread = value => { const key = laneOf() || ''; if (value) ACTIVE_THREADS.set(key, value); else ACTIVE_THREADS.delete(key) }

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

// One linear class scan. The previous validator was
// /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, whose
// repeated group recursed once per 4-character group: on an 11 MB payload node
// threw "Maximum call stack size exceeded" and bun silently returned false, so
// a canonical attachment was refused as non-canonical. Alphabet membership is
// all this test adds - the length check below rejects a truncated group, and
// the round-trip re-encode proves the padding and the trailing bits.
const BASE64_ALPHABET = /[^A-Za-z0-9+/=]/

/**
 * Decode a field the caller called base64, or refuse it.
 *
 * `Buffer.from(value, 'base64')` skips every character it does not recognise,
 * so `%%%%` decodes to zero bytes and the upload reports `attached` for a file
 * that does not exist. Accept only canonical base64 (alphabet, a whole number
 * of 4-character groups, and a re-encode that reproduces the input exactly -
 * which is what catches bad padding and non-zero trailing bits), check the size
 * cap from the encoded length before allocating, and check it again after
 * decoding.
 */
function decodeBase64(value, label = 'attachment') {
  if (typeof value !== 'string' || !value) throw new Error(`${label}: no base64 payload was supplied`)
  // A caller may wrap long lines; whitespace is not part of the encoding.
  const text = value.replace(/\s+/g, '')
  if (!text || text.length % 4 !== 0 || BASE64_ALPHABET.test(text)) throw new Error(`${label}: the payload is not canonical base64`)
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
async function browserIdentity(port = PORT) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
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
function commandLineTokens(line) {
  const tokens = []
  let current = ''
  let quoted = false
  let started = false
  for (const character of String(line ?? '')) {
    if (character === '"') {
      quoted = !quoted
      started = true
      continue
    }
    if (!quoted && /\s/.test(character)) {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += character
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

function ownerCarriesProfile(owner, profile) {
  if (typeof owner?.commandLine !== 'string') return false
  const tidy = value => String(value).replace(/"/g, '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  const want = tidy(profile)
  if (!want) return false
  // Compare the flag's VALUE, not a substring of the whole line: a profile that
  // merely starts with ours (`...\profile-other` against `...\profile`) is a
  // different install, and a substring test adopts it.
  const tokens = commandLineTokens(owner.commandLine)
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index].toLowerCase()
    if (token === '--user-data-dir') {
      if (tidy(tokens[index + 1]) === want) return true
      continue
    }
    if (token.startsWith('--user-data-dir=') && tidy(tokens[index].slice('--user-data-dir='.length)) === want) return true
  }
  return false
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
      if (recorded.guid === served.guid) return { ok: true, pid: Number(marker.pid) || null, how: 'launch marker' }
      // The recorded browser is gone and another one holds the port. If that
      // browser was started with THIS profile's exact --user-data-dir it is the
      // same install restarted (live 2026-11-05: every master relaunch made
      // every attach refuse until the record was rewritten by hand). Adopt it
      // and say so, so the caller can replace the stale record. A foreign
      // browser on our port does not carry our profile and is still refused.
      if (ownerCarriesProfile(owner, profile)) {
        return { ok: true, pid: Number(owner?.pid) || null, how: 'port owner command line (stale launch record)', heal: true }
      }
      return { ok: false, why: `port ${port} is served by browser ${served.guid}, but this driver launched ${recorded.guid}; refusing to attach` }
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
async function portOwner(port = PORT) {
  if (process.platform !== 'win32') return null
  const script = [
    `$conn = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1`,
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

/**
 * Stop one process, and only that one.
 *
 * `taskkill /T /F` aborts as soon as it meets a child it may not kill
 * (`crashpad-handler` is one) and leaves the PARENT alive, so a "successful"
 * kill can leave the browser exactly where it was - measured 2026-11-05, twice.
 * A browser's children exit when the browser does; they do not need killing.
 */
/**
 * Is the host that spawned this child still there?
 *
 * A driver is a child of the host, and every op comes over a pipe the host
 * holds. When the host is killed, the pipe closes - but a child sitting inside
 * a long await does not notice until the await returns. In that window it can
 * still kill the shared browser, and with several such survivors they kill each
 * other's windows indefinitely. Before any destructive act, the parent's
 * existence is checked; a driver with no host exits instead of fighting.
 */
function parentAlive() {
  try { process.kill(process.ppid, 0); return true } catch { return false }
}

function stopProcess(pid) {
  return new Promise(resolve => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Stop-Process -Id ${Number(pid)} -Force -ErrorAction SilentlyContinue`], { stdio: 'ignore', windowsHide: true })
    child.on('exit', resolve)
    child.on('error', resolve)
  })
}

/**
 * Browser processes that carry this profile but cannot serve us.
 *
 * A Chrome whose DevTools endpoint has died still holds the profile's singleton
 * lock, so the next launch hands off to it and exits without binding a port -
 * the failure reads as "the browser did not open the port" forever, no matter
 * how many times it is launched. Measured 2026-11-05: two browser processes on
 * one profile, neither listening on 9222. Only a process whose command line
 * carries this exact profile AND that is a browser (no `--type=`) is killed;
 * renderers and utilities go with their browser.
 */
async function browserProcessesOnProfile(profile) {
  if (process.platform !== 'win32') return []
  const out = await new Promise(resolve => {
    let text = ''
    let settled = false
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value) } }
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" | ForEach-Object { "$($_.ProcessId)`t$([int]((Get-Date) - $_.CreationDate).TotalMilliseconds)`t$($_.CommandLine)" }'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    const timer = setTimeout(() => { try { child.kill() } catch { /* gone */ } finish('') }, 10_000)
    child.stdout.on('data', chunk => { text += chunk; if (text.length > 200_000) { try { child.kill() } catch { /* gone */ } finish('') } })
    child.on('error', () => finish(''))
    child.on('close', () => finish(text))
  })
  const rows = []
  for (const line of String(out).split(/\r?\n/)) {
    const first = line.indexOf('\t')
    const second = first < 0 ? -1 : line.indexOf('\t', first + 1)
    if (first <= 0 || second < 0) continue
    const pid = Number(line.slice(0, first))
    const ageMs = Number(line.slice(first + 1, second))
    const commandLine = line.slice(second + 1)
    if (!Number.isInteger(pid) || pid <= 0) continue
    if (/--type=/.test(commandLine)) continue
    if (!ownerCarriesProfile({ commandLine }, profile)) continue
    rows.push({ pid, ageMs: Number.isFinite(ageMs) ? ageMs : 0 })
  }
  return rows
}

/**
 * Wait for a browser that is already booting on this profile, if there is one.
 *
 * Returns true when the port came up, so the caller adopts instead of spawning.
 * A browser younger than `killOrphanBrowsers`' age floor is presumed to be in
 * the middle of its start-up.
 */
async function waitForBootingBrowser(profile, port, maxMs = 25_000) {
  if (!(await browserProcessesOnProfile(profile)).some(row => row.ageMs < 45_000)) return false
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    if (await cdpUp(port)) return true
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
  return false
}

/**
 * Close browsers that hold this profile and are too old to still be booting.
 *
 * Age is the whole point. A browser that is 5 s old may simply be starting: its
 * port is not up yet, and killing it is how a launch turns into a cascade in
 * which every child kills the window another child just opened. Only a browser
 * that has had time to bind its port and still is not serving is an orphan.
 * They must be confirmed GONE before the caller spawns, because Chrome hands
 * off to any browser still holding the profile and exits without a port.
 */
async function killOrphanBrowsers(profile, minAgeMs = 45_000) {
  if (!parentAlive()) {
    await log('the host that spawned this driver is gone; not touching the browser')
    process.exit(0)
  }
  const rows = (await browserProcessesOnProfile(profile)).filter(row => row.ageMs >= minAgeMs)
  for (const row of rows) await stopProcess(row.pid)
  if (rows.length === 0) return 0
  for (let look = 0; look < 40; look++) {
    const left = await browserProcessesOnProfile(profile)
    if (!left.some(row => rows.some(killed => killed.pid === row.pid))) break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return rows.length
}

/**
 * The log is a queue, not a synchronous write.
 *
 * Every phase label used to pay an fs.appendFile round trip before the next
 * page step could start: live 2026-10-31 one intermittent append blocked ~505
 * ms of a 2032 ms pre-click span (a normal append measures 0-2 ms, so that was
 * an external lock on the growing file, not work). The timestamp is still taken
 * at the call site and ONE drain writes chunks in enqueue order, so the trace
 * stays complete and ordered while no page turn waits on the disk. `flushLog`
 * is the durability point, called when the driver quits.
 */
const LOG_QUEUE = []
let logDrain = null
async function writeLogChunk(chunk) {
  await fs.appendFile(LOG, chunk).catch(() => {})
}
function drainLog() {
  if (!logDrain) {
    logDrain = (async () => {
      await fs.mkdir(STATE_DIR, { recursive: true }).catch(() => {})
      while (LOG_QUEUE.length) {
        const chunk = LOG_QUEUE.join('')
        LOG_QUEUE.length = 0
        await writeLogChunk(chunk)
      }
    })().finally(() => {
      logDrain = null
      // A line enqueued while the drain was closing would otherwise wait for
      // the NEXT caller; start the next drain here instead.
      if (LOG_QUEUE.length) drainLog().catch(() => {})
    })
  }
  return logDrain
}
function log(line) {
  // One process serves every inputter now, so a line without its lane is
  // unattributable once two writers are working.
  const lane = laneOf()
  LOG_QUEUE.push(`${new Date().toISOString()} ${lane ? `[${lane}] ` : ''}${line}\n`)
  drainLog().catch(() => {})
  return Promise.resolve()
}
/** Write every queued line, in order, before the caller goes on (quit). */
async function flushLog() {
  do {
    await drainLog().catch(() => {})
    await new Promise(resolve => setImmediate(resolve))
  } while (logDrain || LOG_QUEUE.length)
}

async function cdpUp(port = PORT) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
    return response.ok
  } catch { return false }
}

/**
 * Wait until the browser has committed a page, not merely opened its port.
 *
 * A browser that answers /json/version while its first renderer is still
 * booting accepts the CDP websocket and then stalls the handshake, which is a
 * 90 s attach timeout on a browser that is seconds away from being usable.
 * Chatting to a committed page is the condition that makes an attach cheap.
 */
async function waitForCommittedPage(ms = 90_000, port = PORT) {
  const started = Date.now()
  while (Date.now() - started < ms) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) })
      if (response.ok) {
        const list = await response.json()
        if (Array.isArray(list) && list.some(target => target?.type === 'page' && target.url)) return true
      }
    } catch { /* still booting */ }
    if (!(await cdpUp())) return false
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return false
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
  if (LANE_SHARED) return await sharedDebugger()
  if (!(await cdpUp())) return null
  const served = await browserIdentity()
  const marker = await readLaunchMarker()
  const install = await readInstallRecord()
  const recorded = parseBrowserUrl(marker?.browserUrl) ?? parseBrowserUrl(install?.browserUrl)
  // Reading another process's command line costs a PowerShell round trip, so
  // only an install with no GUID on record pays for it.
  let owner = served && !recorded ? await portOwner() : null
  let verdict = attachVerdict({ served, marker, install, owner, port: PORT, profile: PROFILE })
  if (!verdict.ok && served && recorded) {
    // A GUID mismatch can be a stale record after this install's browser was
    // restarted. The port owner's command line is the one fact that separates
    // "our browser, new GUID" from "someone else's browser on our port", so it
    // is paid for only when the cheap evidence disagrees.
    owner = await portOwner()
    verdict = attachVerdict({ served, marker, install, owner, port: PORT, profile: PROFILE })
  }
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
/**
 * The master browser a shared lane lives in, proven before any work.
 *
 * This driver did not launch the master, so there is no launch marker whose
 * GUID it could compare: the port owner's command line is the evidence - the
 * same check a pre-record install gets. A port held by a browser that does not
 * carry the master profile is refused rather than typed into. An unreadable
 * owner is not proof of the contrary either, but it is also not a reason to
 * refuse the one browser this install owns; the refusal is reserved for a
 * browser that is provably someone else's.
 */
let SHARED_OWNER = null

async function sharedDebugger() {
  if (!(await cdpUp(CONNECT_PORT))) return null
  // A browser that has bound the port but is still booting answers
  // /json/version without a browser GUID for a moment (and a replacement window
  // is exactly that). Give it the few seconds it needs instead of failing a
  // lane that is racing the relaunch.
  let served = await browserIdentity(CONNECT_PORT)
  for (let look = 0; look < 10 && !served?.guid; look++) {
    await new Promise(resolve => setTimeout(resolve, 500))
    served = await browserIdentity(CONNECT_PORT)
  }
  if (!served?.guid) throw new Error(`port ${CONNECT_PORT} answers, but not as a Chrome DevTools browser; refusing to attach`)
  // Reading a process command line costs a PowerShell round trip. One proven
  // browser GUID is enough for the life of this child: a different GUID on the
  // same port is a different browser and is proven again.
  if (SHARED_OWNER?.guid === served.guid) return SHARED_OWNER
  const owner = await portOwner(CONNECT_PORT)
  if (owner && !ownerCarriesProfile(owner, OWN_PROFILE)) {
    throw new Error(`port ${CONNECT_PORT} is held by pid ${owner.pid}, whose command line does not carry --user-data-dir=${OWN_PROFILE}; refusing to attach a lane to it`)
  }
  SHARED_OWNER = { pid: owner ? Number(owner.pid) || null : null, served, how: owner ? 'master profile' : 'unreadable port owner', guid: served.guid }
  return SHARED_OWNER
}

/**
 * The browser this driver launched, when a disposable lane owns one.
 *
 * See `ownedDebugger`: in shared mode the master is not this child's browser,
 * so the launch-marker proof does not apply and `sharedDebugger` takes over.
 */
/**
 * How long an attach may take, and when it counts as stalled.
 *
 * Two different waits, because they are two different situations. A FRESH
 * launch answers /json/version seconds before its browser websocket finishes
 * the handshake, and under load that gap reaches tens of seconds - so the first
 * attach after a launch gets `ATTACH_TIMEOUT_MS`. A browser that has been up
 * for a while and still does not answer the handshake in 15 s is wedged (its
 * HTTP endpoints stay fast: measured 2026-11-05, /json/version 42 ms while the
 * handshake ran out 60 s with no other client), and waiting the long bound only
 * costs the turn.
 */
const ATTACH_TIMEOUT_MS = 90_000
const ATTACH_STALL_MS = 15_000
/** When this child last launched a browser; the long bound applies before it. */
let LAUNCHED_AT = 0

/**
 * Kill the browser this install owns on the connect port, and open a new one.
 *
 * Chrome 156 accepts a browser-level CDP websocket and then never answers the
 * handshake: measured 2026-11-05 with no other client attached, /json/version
 * answered in 42 ms and /json/list in 21 ms while Playwright's attach sat for
 * 60 s and timed out. Retrying is not a recovery, and the login lives in the
 * profile, so the window is replaced. Only a process whose command line carries
 * this install's exact profile may be killed: anything else is not ours.
 */
async function replaceOwnedBrowser() {
  // Browser-wide, not page-wide: no other lane may be typing into a window that
  // is about to be closed. Non-shared drivers have the token for free.
  const releaseFocus = await acquireFocus()
  try {
    if (!parentAlive()) {
      await log('the host that spawned this driver is gone; not replacing the browser')
      process.exit(0)
    }
    const owner = await portOwner(CONNECT_PORT)
    if (!owner || !ownerCarriesProfile(owner, OWN_PROFILE)) {
      throw new Error(`refusing to replace the browser on port ${CONNECT_PORT}: its owner cannot be proven to carry --user-data-dir=${OWN_PROFILE}`)
    }
    await stopProcess(owner.pid)
    OWNED = null
    SHARED_OWNER = null
    // Wait for the port to actually close: launching while the dying browser
    // still answers hands the new window's startup to a socket that is about
    // to disappear.
    for (let look = 0; look < 20 && (await cdpUp(CONNECT_PORT)); look++) {
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    if (LANE_SHARED) await ensureMasterChrome()
    else await ensureChrome({ visible: true })
  } finally {
    await releaseFocus()
  }
}

async function attachOwned(ms = 0) {
  const owned = await ownedDebugger()
  if (!owned) throw new Error(`chrome is not running on port ${CONNECT_PORT}`)
  const { chromium } = loadPlaywright()
  const attach = timeout => chromium.connectOverCDP(`http://127.0.0.1:${CONNECT_PORT}`, { timeout })
  // A caller that brought its own short deadline (a status probe) gets that
  // deadline and no recovery: replacing a window is not a status-shaped act.
  if (ms > 0) return await cdpTimed(attach(ms), ms)
  const releaseAttach = LANE_SHARED ? await acquireLock(ATTACH_LOCK, 120_000) : async () => {}
  try {
    const bound = Date.now() - LAUNCHED_AT < 120_000 ? ATTACH_TIMEOUT_MS : ATTACH_STALL_MS
    return await attach(bound)
  } catch (error) {
    await log(`attach on port ${CONNECT_PORT} stalled (${String(error?.message ?? error).split('\n')[0]}); replacing the window`)
    await replaceOwnedBrowser()
    return await attach(ATTACH_TIMEOUT_MS)
  } finally {
    await releaseAttach()
  }
}

/**
 * The connection this child keeps, and why it is kept.
 *
 * Every op used to attach and disconnect. Chrome 156 stalls a browser-level
 * attach whenever another one is in flight (measured 2026-11-05: /json/version
 * keeps answering while the handshake hangs), and with several lanes plus the
 * master all connecting per op, attaches collided often enough that a healthy
 * page was reported as "chrome is not running". One attach per child, reused
 * by every op, removes the collision instead of retrying around it.
 *
 * A connection that dies (browser closed, renderer crash) clears itself here,
 * so the next op proves ownership and attaches again.
 */
let OWNED = null

async function connectOwned(ms = 0) {
  if (OWNED && typeof OWNED.isConnected === 'function' && OWNED.isConnected()) return OWNED
  OWNED = null
  const browser = await attachOwned(ms)
  OWNED = browser
  browser.on('disconnected', () => { if (OWNED === browser) OWNED = null })
  return browser
}

/**
 * End-of-op: the connection is this child's for its whole life and is
 * deliberately not closed here. Call sites keep calling this so that "this op
 * is done with the browser" stays an explicit statement rather than a silence
 * whose meaning has to be recovered from `connectOwned`.
 */
function release() {}

/**
 * Throw away the connection, without waiting for it to close.
 *
 * Playwright multiplexes every call over one websocket, so a call the renderer
 * never answers blocks the whole child, not just that read. Dropping it lets
 * the next op attach again; `browser.close()` is not awaited because a wedged
 * socket may never acknowledge it.
 */
function dropOwned(why) {
  const held = OWNED
  OWNED = null
  if (!held) return
  void log(`dropping the CDP connection: ${why}`)
  try { Promise.resolve(held.close()).catch(() => {}) } catch { /* already gone */ }
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
function launchVerdict({ served, owner, profile, port, portWasFree = false }) {
  if (!served || !served.guid) return { ok: false, retry: true }
  // Reading a Windows process command line goes through WMI, which is slow and
  // sometimes simply fails under load. When the port was proven free a moment
  // before this launch, the browser that appeared on it is this launch's; an
  // unreadable owner must not fail a lane that in fact started fine.
  if (!owner) return portWasFree ? { ok: true, retry: false, pid: null } : { ok: false, retry: true }
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

/**
 * Take the one browser focus token, or pass straight through when this lane has
 * a window of its own.
 *
 * Shared lanes are tabs in one window, and only one tab is in front at a time.
 * A lane that types into a tab that lost the front spends its whole compose
 * budget reading back the wrong text and is refused as "not-posted", so typing
 * and clicking are serialized. The token is released before the answer is
 * awaited, so several turns still stream at once.
 *
 * The lock is a file created with O_EXCL rather than an in-process mutex: the
 * contenders are separate driver children, one per lane. A holder that dies
 * without releasing leaves a stale file, which the mtime check clears.
 */
async function acquireLock(file, waitMs, staleMs = FOCUS_STALE_MS) {
  await fs.mkdir(path.dirname(file), { recursive: true }).catch(() => {})
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      const fd = openSync(file, 'wx')
      writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`)
      closeSync(fd)
      return async () => { try { unlinkSync(file) } catch { /* already released */ } }
    } catch (error) {
      // Windows reports an existing lock it cannot open as EPERM (and, under a
      // sharing violation, EACCES) rather than EEXIST; observed live 2026-11-05
      // as "did not warm: EPERM ... webbridge-attach.lock". All three mean
      // "someone holds it", which is exactly the case this loop exists for.
      if (error?.code !== 'EEXIST' && error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error
      // A holder that died without releasing leaves the file behind; its age is
      // the only thing that can tell a crash from a slow holder.
      try {
        if (Date.now() - statSync(file).mtimeMs > staleMs) { unlinkSync(file); continue }
      } catch { /* the holder released between the two calls */ }
      if (Date.now() > deadline) throw new Error(`another lane held ${path.basename(file)} for ${Math.round(waitMs / 1000)}s`)
      await new Promise(resolve => setTimeout(resolve, 120))
    }
  }
}

async function acquireFocus() {
  if (!LANE_SHARED) return async () => {}
  return await acquireLock(FOCUS_LOCK, 90_000)
}

/**
 * Open the master browser a shared lane lives in, when it is not running.
 *
 * The login lives in the profile, so opening the window loses nothing. Two
 * lanes can reach here at once: the first binds the port, the second's spawn
 * hands off to the running instance, and both wait for the same port to answer.
 * Nothing is recorded in this child's PID file - a lane must never be the
 * process that later kills the master.
 */
async function ensureMasterChrome() {
  const releaseLaunch = await acquireLock(LAUNCH_LOCK, 150_000, 120_000)
  try {
    return await openMasterChrome()
  } finally {
    await releaseLaunch()
  }
}

async function openMasterChrome() {
  // /json/version answers in milliseconds on an idle browser, but a window with
  // a dozen ChatGPT tabs can miss a 1.5 s timeout. Patience before deciding the
  // master is down: a booting Chrome binds its port seconds after it starts, and
  // killing it mid-boot is how a launch becomes a cascade.
  for (let look = 0; look < 8; look++) {
    if (await cdpUp(CONNECT_PORT)) {
      const owned = await sharedDebugger()
      return { spawned: false, pid: owned?.pid ?? null, shared: true }
    }
    await new Promise(resolve => setTimeout(resolve, 1_500))
  }
  // A browser that is already booting must be waited for, never launched
  // beside: Chrome hands the second launch off to the first and exits without a
  // port, which reads as "the browser did not open the port".
  if (await waitForBootingBrowser(OWN_PROFILE, CONNECT_PORT)) {
    const owned = await sharedDebugger()
    return { spawned: false, pid: owned?.pid ?? null, shared: true }
  }
  const exe = await chromePath()
  await fs.mkdir(OWN_PROFILE, { recursive: true })
  const args = [
    `--remote-debugging-port=${CONNECT_PORT}`,
    `--user-data-dir=${OWN_PROFILE}`,
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
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--window-size=1100,900',
    '--window-position=120,80',
    CHAT_URL,
  ]
  if (process.env.CHATGPT_DISABLE_GPU !== '0') args.push('--disable-gpu')
  // Two attempts. A browser on this profile that is not serving the port blocks
  // the launch (Chrome hands off to it and exits without a DevTools endpoint),
  // so each attempt clears the profile's browsers and confirms they are gone
  // before spawning. One bad window must not cost the lane its turn.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const orphans = await killOrphanBrowsers(OWN_PROFILE)
    if (orphans) await log(`shared lane ${LANE_ID || '(unnamed)'}: closed ${orphans} browser process(es) holding ${OWN_PROFILE} without serving port ${CONNECT_PORT}`)
    await log(`shared lane ${LANE_ID || '(unnamed)'}: opening master profile ${OWN_PROFILE} on port ${CONNECT_PORT} (attempt ${attempt})`)
    const child = spawn(exe, args, { detached: true, stdio: 'ignore' })
    LAUNCHED_AT = Date.now()
    child.once('error', () => {})
    child.unref()
    for (let i = 0; i < 60; i++) {
      if (await cdpUp(CONNECT_PORT)) {
        await waitForCommittedPage(90_000, CONNECT_PORT)
        return { spawned: true, pid: child.pid, shared: true }
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
  throw new Error(`the master browser did not open port ${CONNECT_PORT}`)
}

async function ensureChrome({ visible = true } = {}) {
  // A shared lane is a tab in the master browser, which is not this child's to
  // launch per lane: open it once if it is down, and never copy a login into a
  // second profile.
  if (LANE_SHARED) return await ensureMasterChrome()
  // The one-window driver launches the same browser the lanes live in, so it
  // takes the same launch lock: without it a lane and this driver can each
  // decide the port is down and kill the other's booting window.
  const releaseLaunch = await acquireLock(LAUNCH_LOCK, 150_000, 120_000)
  try {
    return await openOwnChrome({ visible })
  } finally {
    await releaseLaunch()
  }
}

async function openOwnChrome({ visible = true } = {}) {
  const owned = await ownedDebugger()
  if (owned) return { spawned: false, pid: owned.pid }
  // Proof of prior occupancy, taken BEFORE the spawn: a browser that appears on
  // a port nothing served a moment ago appeared because of this launch.
  const portWasFree = !(await cdpUp())
  if (await waitForBootingBrowser(PROFILE, PORT)) {
    const served = await ownedDebugger()
    if (served) return { spawned: false, pid: served.pid }
  }
  // A browser on this profile that is not serving the port blocks the launch.
  const orphans = await killOrphanBrowsers(PROFILE)
  if (orphans) await log(`closed ${orphans} browser process(es) holding ${PROFILE} without serving port ${PORT}`)
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
    // ON SCREEN. Parking the page off-screen (the old -2000,0) makes Chrome
    // treat it as hidden: typing then half-lands, every compose reads back the
    // wrong text, and the turn is refused as "not-posted".
    '--window-position=80,60',
    CHAT_URL,
  ]
  if (!visible) args.unshift('--headless=new')
  if (process.env.CHATGPT_DISABLE_GPU !== '0') args.push('--disable-gpu')
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' })
  LAUNCHED_AT = Date.now()
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
      const verdict = launchVerdict({ served, owner, profile: PROFILE, port: PORT, portWasFree })
      if (verdict.ok) {
        await writeLaunchMarker(verdict.pid ?? child.pid, served)
        await writeInstallRecord(verdict.pid ?? child.pid, served)
        // The port is open before the first renderer commits; attaching into
        // that window stalls the CDP handshake for as long as the boot takes.
        await waitForCommittedPage()
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

/**
 * This lane's tab in the shared browser, created on first use.
 *
 * Lanes are told apart by `window.name`, not by tab order or URL: the operator's
 * own tab is in the same window and must never receive a lane's text. A fresh
 * tab is named only AFTER it has landed on chatgpt.com, because Chrome clears
 * `window.name` on a cross-site navigation and the name has to survive the first
 * load; same-site navigation and reload keep it.
 */
/** Keep this lane's lease fresh: a tab whose lease ages out is swept. */
async function touchLaneLease(id) {
  const file = path.join(LANE_LEASE_DIR, `${id}.json`)
  const now = new Date()
  await fs.mkdir(LANE_LEASE_DIR, { recursive: true }).catch(() => {})
  const refreshed = await fs.utimes(file, now, now).then(() => true, () => false)
  if (!refreshed) await fs.writeFile(file, JSON.stringify({ pid: process.pid, at: now.toISOString() })).catch(() => {})
}

let SWEPT_LANE_TABS = false

/**
 * Close lane tabs whose owners are gone.
 *
 * Runs once per child, at tab creation, because that is the moment a new tab is
 * about to exist and every live lane is holding a fresh lease. A lane opens and
 * closes rarely; a sweep on every connect would be work for nothing.
 */
async function sweepOrphanLaneTabs(context) {
  if (SWEPT_LANE_TABS) return 0
  SWEPT_LANE_TABS = true
  // No lease directory means no lease has ever been taken, so every lane tab
  // that exists is an orphan - not a reason to skip the sweep.
  let names = []
  try { names = await fs.readdir(LANE_LEASE_DIR) } catch { names = [] }
  const live = new Set()
  const now = Date.now()
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = path.join(LANE_LEASE_DIR, name)
    const stat = await fs.stat(file).catch(() => null)
    if (!stat) continue
    if (now - stat.mtimeMs > LANE_LEASE_STALE_MS) { await fs.rm(file, { force: true }).catch(() => {}); continue }
    live.add(name.slice(0, -'.json'.length))
  }
  let closed = 0
  for (const page of context.pages()) {
    const name = String(await page.evaluate(() => window.name).catch(() => '') || '')
    if (!name.startsWith(LANE_TAB_PREFIX)) continue
    if (live.has(name.slice(LANE_TAB_PREFIX.length))) continue
    await page.close().catch(() => {})
    closed += 1
  }
  if (closed) await log(`shared lane ${LANE_ID || '(unnamed)'}: closed ${closed} orphaned lane tab(s)`)
  return closed
}

async function lanePage(context) {
  // The lane comes from the REQUEST when one process serves several inputters,
  // and from the env for the one-lane-per-process shape.
  const lane = laneOf()
  // A lane without an id still gets a name of its own rather than sharing one:
  // two lanes on the same name would type into each other's tab.
  const wanted = lane ? `${LANE_TAB_PREFIX}${lane}` : `${LANE_TAB_PREFIX}pid-${process.pid}`
  const leaseId = wanted.slice(LANE_TAB_PREFIX.length)
  await touchLaneLease(leaseId)
  for (const candidate of context.pages()) {
    const name = await candidate.evaluate(() => window.name).catch(() => '')
    if (name === wanted) {
      await candidate.bringToFront().catch(() => {})
      keepLeaseFresh(candidate, leaseId)
      await sweepOrphanLaneTabs(context)
      return candidate
    }
  }
  const page = await context.newPage()
  await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: LOGIN_WAIT_MS }).catch(() => {})
  await ensureLaneName(page, wanted)
  keepLeaseFresh(page, leaseId)
  await sweepOrphanLaneTabs(context)
  return page
}

/**
 * Keep a lane's lease younger than the sweep threshold while its tab lives.
 *
 * The lease used to be written once, when the tab was opened, while a turn may
 * legitimately run for SEND_TIMEOUT_MS (240 s) - longer than the 180 s stale
 * window. Any other lane opening in that time therefore swept this lane's tab
 * out from under a running turn. Refresh on a timer tied to the page's life.
 */
const LEASED = new WeakSet()
function keepLeaseFresh(page, leaseId) {
  if (!LANE_SHARED || !leaseId) return
  // One timer per page: connect() runs on every op, and a second interval per
  // op would write the lease forever for a tab that is long gone.
  if (LEASED.has(page)) return
  LEASED.add(page)
  const timer = setInterval(() => { void touchLaneLease(leaseId) }, Math.max(15_000, Math.floor(LANE_LEASE_STALE_MS / 3)))
  timer.unref?.()
  const stop = () => clearInterval(timer)
  page.once('close', stop)
  page.once('crash', stop)
}

/** Re-assert the lane's tab name after a navigation that may have cleared it. */
async function ensureLaneName(page, wanted = LANE_TAB) {
  if (!LANE_SHARED || !wanted) return
  if (!isChatGPTUrl(page.url())) return
  const name = await page.evaluate(() => window.name).catch(() => '')
  if (name === wanted) return
  await page.evaluate(value => { window.name = value }, wanted).catch(() => {})
}

/** Close only this lane's tab. The master window, and every other lane, stays. */
async function closeLaneTab() {
  if (!LANE_SHARED) return { tabClosed: false }
  // No lane in the request means a host-level unload: in shared mode the master
  // browser is never closed, and there is no tab of ours to close.
  const lane = laneOf()
  if (!lane) return { tabClosed: false }
  const wanted = `${LANE_TAB_PREFIX}${lane}`
  // Drop the lease first: once the tab is gone the sweep has nothing to clean,
  // and if the close fails the stale lease lets the next lane clean it.
  await fs.rm(path.join(LANE_LEASE_DIR, `${wanted.slice(LANE_TAB_PREFIX.length)}.json`), { force: true }).catch(() => {})
  const browser = await connectOwned()
  try {
    const context = browser.contexts()[0]
    if (!context) return { tabClosed: false }
    for (const page of context.pages()) {
      const name = await page.evaluate(() => window.name).catch(() => '')
      if (name === wanted) {
        await page.close().catch(() => {})
        return { tabClosed: true }
      }
    }
    return { tabClosed: false }
  } finally {
    release(browser)
  }
}

/**
 * Record what the page itself says when it fails.
 *
 * The "couldn't load messages" fault is a CLIENT render failure: the
 * conversation API answers 200 with the messages the page refuses to paint
 * (researched 2026-11-05; no public root cause). The evidence that separates
 * that from a genuinely broken conversation is the page's own: an uncaught
 * exception, a console error, or a failed conversation request. Those are
 * written to stderr as well as the driver log because stderr is the durable
 * trail - the host keeps it, while a lane's `driver.log` dies with the lane.
 * Capped per page so a noisy app cannot flood either log.
 */
const WATCHED_PAGES = new WeakSet()

function watchPageErrors(page) {
  if (WATCHED_PAGES.has(page)) return
  WATCHED_PAGES.add(page)
  let logged = 0
  const note = line => {
    if (logged >= 30) return
    logged += 1
    const clean = String(line).replace(/\s+/g, ' ').slice(0, 300)
    process.stderr.write(`[page] ${clean}\n`)
    void log(`page: ${clean}`)
  }
  page.on('pageerror', error => note(`uncaught: ${error?.message ?? error}`))
  page.on('console', message => {
    try { if (message.type() === 'error') note(`console: ${message.text()}`) } catch { /* page gone */ }
  })
  page.on('requestfailed', request => {
    try {
      if (!/\/backend-api\/(?:f\/)?conversation/.test(request.url())) return
      note(`conversation request failed: ${request.failure()?.errorText ?? 'unknown'}`)
    } catch { /* page gone */ }
  })
}

async function connect() {
  const browser = await connectOwned()
  const context = browser.contexts()[0] ?? await browser.newContext()
  // In a shared browser a LANE request is a named tab of the master window; the
  // operator's own tab is never selected. A request with no lane (host-level
  // work: observation, operator ops) falls through to the master page below,
  // even though this same child owns the lane tabs too.
  if (LANE_SHARED && laneOf()) {
    const page = await lanePage(context)
    watchPageErrors(page)
    return { browser, context, page }
  }
  // Never adopt a lane's tab as the master's page: a master turn typed into a
  // lane tab collides with that lane's turn. Every shared lane names its tab.
  const pages = []
  for (const candidate of context.pages()) {
    const name = await candidate.evaluate(() => window.name).catch(() => '')
    if (String(name || '').startsWith(LANE_TAB_PREFIX)) continue
    pages.push(candidate)
  }
  // Prefer the tab the caller adopted: a bridge can point at a thread the user
  // already has open, and sending into a different tab would post into the
  // wrong conversation. With no preference, the first ChatGPT tab wins.
  const active = activeThread()
  let page = active
    ? pages.find(p => isChatGPTUrl(p.url()) && (threadOf(p.url()) || String()).toLowerCase() === active.toLowerCase())
    : null
  // Never a lookalike host: a tab that merely contains the string
  // "chatgpt.com" is a different origin and must not receive our text.
  if (!page) page = pages.find(p => isChatGPTUrl(p.url()))
  if (!page) page = pages[0] ?? await context.newPage()
  watchPageErrors(page)
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
 * Per-STEP bounds on the send path. They are not added together: the send is
 * bounded as an operation by `SEND_ACCEPT_DEADLINE_MS` below, and these only say
 * how long one phase may spend before the step itself gives up.
 *
 * `COMPOSER_WAIT_MS` is the composer poll (`ask`, and the same bound again after
 * a recovery reload), `LOGIN_WAIT_MS` the sign-in wait before a send, and
 * `LAST_ASSISTANT_TEXT_TIMEOUT_MS` the read of the last assistant node taken as
 * the pre-send text baseline.
 */
const COMPOSER_WAIT_MS = 30_000
const LOGIN_WAIT_MS = 60_000
const LAST_ASSISTANT_TEXT_TIMEOUT_MS = 2_000

/**
 * The composer is not there the instant /api/auth/session answers: a fresh
 * navigation reports loggedIn before the SPA renders its input. Poll instead of
 * failing once, because the only thing a single check detects is load timing.
 */
async function waitForComposer(page, timeoutMs = COMPOSER_WAIT_MS) {
  const deadline = Date.now() + timeoutMs
  do {
    const composer = await firstVisible(page, COMPOSER)
    if (composer) return composer
    await new Promise(resolve => setTimeout(resolve, 300))
  } while (Date.now() < deadline)
  return null
}

/**
 * Every pre-click action is bounded. Playwright's default actionability wait is
 * 30 s per call, and a stalled read or a swallowed click used to spend it
 * silently: 2026-10-31 live, an 18:18 turn spent 41.6 s composing 6,240 chars
 * before the Send click. A field that will not take an action in 2 s is not
 * going to, so fail (or fall through) in 2 s instead of 30.
 */
const INPUT_ACTION_TIMEOUT_MS = 2_000
/** The pre-send tree baseline; a timeout leaves it unread, never stale. */
const TREE_BASELINE_TIMEOUT_MS = 5_000
/** The pre-send DOM baseline, same reasoning as the tree one. */
const DOM_BASELINE_TIMEOUT_MS = 5_000
/**
 * The trial click is a measurement, so it gets its own ceiling: inheriting the
 * locator default would let a never-actionable button cost two full
 * actionability waits (the swallowed trial plus the real click) instead of one.
 * The real click keeps its default and remains the only dispatch.
 */
const CLICK_TRIAL_TIMEOUT_MS = 5_000
/** Each CDP await in the network observer; a wedge degrades to unavailable. */
const OBSERVER_TIMEOUT_MS = 2_000
/** The page's own send POST; one regex covers the live `f/` form and the older bare one. */
const SEND_POST_PATH = /^\/backend-api\/(?:f\/)?conversation$/
/**
 * The trial and scroll probes are instrumentation, and on the primary send path
 * they cost a second full actionability pass (live 2026-11-01: scroll 2012 +
 * trial 2369 + click 2118 = 6499 ms; preclick 5706 -> 9745 ms). They are opt-in:
 * `CHATGPT_CLICK_PROBE=1` turns them on. The default path is one click.
 */
const CLICK_PROBE = process.env.CHATGPT_CLICK_PROBE === '1'

/** The composer's own text, whitespace-normalized, or null when it cannot be read. */
async function composerTextOf(composer) {
  const raw = await composer.evaluate(el => (el.innerText ?? el.textContent ?? ''), undefined, { timeout: INPUT_ACTION_TIMEOUT_MS }).catch(() => null)
  return raw === null ? null : normalizedTurnText(raw)
}

/**
 * Clear the composer and PROVE it is empty; false when it will not clear.
 *
 * The composer is a contenteditable, so there is no `.value = ''`: selection and
 * a delete key are the only ways to empty it, and the result has to be read back
 * rather than assumed - a swallowed click leaves the caret somewhere the delete
 * never reached.
 */
/**
 * Edit through the page's own DOM, not the CDP keyboard.
 *
 * Chrome silently drops synthesized keystrokes for a window it will not give
 * focus to (another Chrome window in front, a remote desktop, a locked screen).
 * The composer then reads back empty after every `fill`, and the turn is
 * refused as "not-posted" while the page itself is perfectly healthy.
 * `execCommand` runs inside the page, so it lands wherever the field is
 * editable, and the caller still verifies the text afterwards.
 */
async function editFromPage(composer, command, value = null) {
  return composer.evaluate((el, [cmd, text]) => {
    try {
      el.focus()
      if (cmd === 'clear') {
        const selection = window.getSelection()
        const range = document.createRange()
        range.selectNodeContents(el)
        selection.removeAllRanges()
        selection.addRange(range)
        return document.execCommand('delete') !== false
      }
      return document.execCommand(cmd, false, text) !== false
    } catch { return false }
  }, [command, value]).catch(() => false)
}

async function clearComposer(page, composer) {
  // An already-empty composer needs no click: the read is the proof, and
  // `composeExactlyOnce` focuses the field itself before inserting.
  if ((await composerTextOf(composer)) === '') return true
  await composer.click({ timeout: INPUT_ACTION_TIMEOUT_MS }).catch(() => {})
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if ((await composerTextOf(composer)) === '') return true
    await page.keyboard.press('Control+A').catch(() => {})
    await page.keyboard.press('Delete').catch(() => {})
    await page.keyboard.press('Backspace').catch(() => {})
  }
  return (await composerTextOf(composer)) === ''
}

/**
 * Put `text` into the composer EXACTLY once, and prove it before any send.
 *
 * `locator.fill` selects all and inserts, but it can REJECT after the text has
 * landed - or after a partial insert. The old code answered every rejected fill
 * with `keyboard.insertText(text)` at the CURRENT caret, so a full first copy
 * plus the fallback appended a second one. Live 2026-10-30: a 9,642-char prompt
 * went out doubled, one user node, second copy spliced at char 9,495. Here the
 * fallback runs ONLY on a composer proven empty, and the content must equal the
 * intended text (normalized) or the caller refuses the turn instead of sending
 * a doubled message.
 *
 * Speed: the common case is an empty composer, and for that `fill`'s
 * select-all-then-insert is three page operations where focus plus ONE
 * `insertText` is two (one input event, one read-back). Both paths still prove
 * the field holds exactly `want` before returning true - the read-back is what
 * makes exactly-once true rather than merely likely. `onStep(label, ms)` reports
 * each step so a slow compose cannot hide inside one `compose` number.
 */
async function composeExactlyOnce(page, composer, text, onStep = null) {
  const step = async (label, since) => { if (onStep) await onStep(label, Date.now() - since) }
  const want = normalizedTurnText(text)
  if (!want) return false
  // Already correct (a retried turn, a host that pre-filled): touching it could
  // only risk a second copy. One bounded read decides.
  let since = Date.now()
  if ((await composerTextOf(composer)) === want) { await step('compose_verify', since); return true }
  // Bounded focus plus ONE insert, on a composer that has been PROVEN empty.
  // Focus rather than click: the caret lands in the field without a hit-test
  // that a zero-size or offscreen copy of the composer can swallow.
  const insertOnce = async () => {
    since = Date.now()
    const focused = await composer.focus({ timeout: INPUT_ACTION_TIMEOUT_MS }).then(() => true).catch(() => false)
    if (focused) await page.keyboard.insertText(text).catch(() => {})
    await step('compose_type', since)
    since = Date.now()
    const ok = focused && (await composerTextOf(composer)) === want
    await step('compose_verify', since)
    return ok
  }
  // `fill` selects all before inserting, so on this path it REPLACES whatever is
  // in the field rather than appending to it.
  const fillOnce = async () => {
    since = Date.now()
    const filled = await composer.fill(text, { timeout: INPUT_ACTION_TIMEOUT_MS }).then(() => true).catch(() => false)
    await step('compose_fill', since)
    since = Date.now()
    const exact = filled && (await composerTextOf(composer)) === want
    await step('compose_verify', since)
    return exact
  }
  // The composer will not clear: it holds content we cannot vouch for, and a
  // select-all fill is the only way to replace it with exactly ours.
  const clearThenInsert = async () => {
    since = Date.now()
    const cleared = await clearComposer(page, composer)
    await step('compose_clear', since)
    return cleared ? await insertOnce() : false
  }
  since = Date.now()
  const emptied = await clearComposer(page, composer)
  await step('compose_clear', since)
  if (!emptied) return (await fillOnce()) || (await clearThenInsert())
  // Fast path: a field proven empty takes one insert and one read-back. If the
  // insert does not land, a bounded fill replaces whatever partial text there
  // is; a fill rejected after writing is cleared, and only a proven-empty field
  // is ever typed into again.
  if (await insertOnce()) return true
  if (await fillOnce()) return true
  return await clearThenInsert()
}

const ASSISTANT = '[data-markdown-text-style="assistant-message"]'
/**
 * The person's own messages: the node a successful send adds.
 *
 * ChatGPT changed its conversation DOM on 2026-11-05: the old
 * `[data-message-author-role]` attributes are gone and a turn now carries an
 * `h4[data-conversation-role]` label plus a `[data-user-message-bubble]` bubble.
 * Both spellings are kept so an older page and this one are both read.
 */
const USER_MESSAGE = '[data-user-message-bubble="true"], [data-message-author-role="user"]'
/** Every conversation turn the page has rendered, in either UI generation. */
const ANY_MESSAGE = `${ASSISTANT}, ${USER_MESSAGE}, [data-talvt-turn-state], [data-conversation-role]`

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
  // A conversation-level load failure. Only asked when no answer bubble carries
  // text, so a real answer that quotes the phrase is never a failure.
  const bubbles = [...document.querySelectorAll('[data-markdown-text-style="assistant-message"]')]
  const hasText = bubbles.some(node => (node.textContent || '').trim())
  let problem = null
  if (!hasText) {
    const body = (document.body && document.body.innerText || '').slice(0, 20000)
    if (/(couldn'?t load (the )?messages|could not load messages|unable to load (the )?(messages|conversation)|error loading (the )?(messages|conversation)|there was a problem loading (the )?(messages|conversation))/i.test(body)) problem = 'load'
  }
  return { stop, states, problem, live: stop || states.some(state => !/complete/.test(state)) }
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
      problem: sample?.problem === 'load' ? 'load' : null,
      states: Array.isArray(sample?.states) ? sample.states.slice(0, 8) : [],
    }
  } catch {
    // A wedged connection or a page that will not answer means the driver
    // cannot be asked - not that the page is idle.
    return { askable: false }
  } finally {
    if (browser) release(browser)
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
 * What the server says about a thread, when the page renders no messages.
 *
 * `missing` - the conversation is gone (404). `empty` - it exists with no
 * messages, which is what a thread the host just created looks like; the send
 * is the first message, so it must go ahead. `content` - the server holds
 * messages the page did not render, i.e. the hydration fault the guard exists
 * for. `unknown` is treated like `content` (reload, then refuse) because a
 * thread we cannot ask about must not be typed into blind.
 */
/**
 * The answer as the server holds it, used when the page will not render it.
 *
 * ChatGPT intermittently serves a conversation the DOM never paints ("can't
 * load conversation") while the turn itself completed - the answer is in the
 * conversation mapping. When that happens the reply must come from the source,
 * not from a window that failed to draw: a render fault is not a lost turn.
 * Attribution stays strict: only the last user message may match the text this
 * send typed (the whole normalized text - a shared tail is not evidence), and
 * only an assistant message after it is accepted.
 */
async function readServerReply(page, threadId, sentText) {
  if (!threadId) return ''
  // The WHOLE text, not a tail: every bus inbound ends with the same footer,
  // so a 60-character suffix matches other turns' user messages too and the
  // fallback would hand back the wrong turn's answer (found 2026-11-06).
  const wanted = String(sentText || '').replace(/\s+/g, ' ').trim()
  return page.evaluate(async ([id, wantedText]) => {
    try {
      const session = await (await fetch('/api/auth/session')).json()
      const headers = session?.accessToken ? { authorization: `Bearer ${session.accessToken}` } : {}
      const response = await fetch(`/backend-api/conversation/${id}`, { credentials: 'include', headers })
      if (!response.ok) return ''
      const body = await response.json()
      const norm = value => String(value || '').replace(/\s+/g, ' ').trim()
      const textOf = message => ((message.content && message.content.parts) || [])
        .map(part => (typeof part === 'string' ? part : ''))
        .join(' ')
      const messages = Object.values(body.mapping || {})
        .map(node => node && node.message)
        .filter(message => message && message.author && typeof message.create_time === 'number')
        .sort((a, b) => a.create_time - b.create_time)
      let lastUser = -1
      for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index].author.role === 'user') { lastUser = index; break }
      }
      if (lastUser < 0) return ''
      if (wantedText && norm(textOf(messages[lastUser])) !== wantedText) return ''
      for (let index = messages.length - 1; index > lastUser; index--) {
        if (messages[index].author.role !== 'assistant') continue
        const text = norm(textOf(messages[index]))
        if (text) return text
      }
      return ''
    } catch { return '' }
  }, [threadId, wanted]).catch(() => '')
}

async function threadContentState(page, threadId) {
  return page.evaluate(async id => {
    try {
      const sessionResponse = await fetch('/api/auth/session').catch(() => null)
      // If the session read is itself refused (429 during a limit window, 401
      // when signed out), there is no token below and the conversation read
      // answers 404 for EVERY thread - which this function would report as
      // 'missing' and the host as a dead thread. Carry the session's status
      // instead so a rate limit stays a rate limit and never a lost thread.
      if (!sessionResponse) return 'unknown'
      if (!sessionResponse.ok) return `unknown:${sessionResponse.status}`
      const session = await sessionResponse.json().catch(() => null)
      const response = await fetch(`/backend-api/conversation/${id}`, {
        credentials: 'include',
        headers: session?.accessToken ? { authorization: `Bearer ${session.accessToken}` } : {},
      })
      if (response.status === 404) return 'missing'
      // The status travels with the word: "unknown" alone cannot tell a rate
      // limit (429) from a session that expired (401), and those need different
      // answers - one waits, the other signs in.
      if (!response.ok) return `unknown:${response.status}`
      const body = await response.json()
      const messages = Object.values(body.mapping || {}).filter(node => node && node.message).length
      return messages === 0 ? 'empty' : 'content'
    } catch { return 'unknown' }
  }, threadId).catch(() => 'unknown')
}

/**
 * The page's user turns as (identity, text) pairs, or null when it cannot be read.
 *
 * Identity is the closest ancestor's `data-message-id` (or the node's own), so a
 * node that was already on screen before the send can never be mistaken for the
 * new one. Only the nodes at or after the pre-send count can be new, so their
 * text is read and older text is skipped - a long thread pays nothing for the poll.
 */
async function readDomUserTurns(page, priorUsers = 0, timeoutMs = DOM_BASELINE_TIMEOUT_MS) {
  // A hung evaluate has no timeout of its own; `evaluateTimed` races one. Null
  // means "unreadable baseline", which the acceptance checks already treat as
  // ambiguous rather than as proof of anything.
  return evaluateTimed(page, ([selector, prior]) => {
    const nodes = [...document.querySelectorAll(selector)]
    return {
      identities: nodes.map(node => {
        // The 2026-11-05 UI names its message ids differently; an identity is
        // only used to tell an old node from the new one, so any stable id on
        // the bubble's wrapper will do.
        const turn = node.closest && node.closest('[data-message-id], [data-chatgpt-selection-message-id], [data-chatgpt-search-message-ids]')
        return (turn && (turn.getAttribute('data-message-id') || turn.getAttribute('data-chatgpt-selection-message-id') || turn.getAttribute('data-chatgpt-search-message-ids')))
          || node.getAttribute('data-message-id') || node.getAttribute('data-chatgpt-search-message-ids') || node.id || null
      }),
      texts: nodes.map((node, index) => (index >= prior ? (node.innerText || '') : null)),
    }
  }, [USER_MESSAGE, Math.max(0, Number(priorUsers) || 0)], timeoutMs).catch(() => null)
}

/**
 * The full normalized texts of the DOM user nodes present now but absent from
 * the pre-send baseline, or null when either read is unusable.
 *
 * With stable ids on both reads the identity set decides what is new, so a count
 * that stays the same while a node is replaced cannot accept. Without ids the
 * count delta is the best "new" signal available, and every node past the
 * baseline still has to carry our text for the verdict to accept.
 */
function newDomUserTexts(baseline, after) {
  if (!Array.isArray(baseline)) return null
  if (!after || !Array.isArray(after.identities) || !Array.isArray(after.texts)) return null
  const known = new Set(baseline)
  const identified = baseline.length > 0 && baseline.every(id => typeof id === 'string' && id)
    && after.identities.length > 0 && after.identities.every(id => typeof id === 'string' && id)
  if (identified) {
    const fresh = []
    after.identities.forEach((identity, index) => {
      if (!known.has(identity)) fresh.push(normalizedTurnText(after.texts[index]))
    })
    return fresh
  }
  if (!(after.identities.length > baseline.length)) return []
  return after.texts.slice(baseline.length).map(text => normalizedTurnText(text))
}

/**
 * True once the page has taken the text: the turn is in the thread, whether or
 * not an answer exists yet. The host acknowledges on this signal, because
 * "delivered" on the bus means handed off, not answered.
 *
 * The proof is a NEW USER NODE whose FULL text carries what we sent - the same
 * evidence the degraded path asks for. Neither cheaper signal is proof: a busy
 * indicator can be the previous generation's still-visible stop button, and a
 * cleared composer can be a rerender after a swallowed click. The old rule
 * accepted any new user node once the composer was empty, which let an unrelated
 * message that appeared at the same moment acknowledge a send that never landed.
 *
 * `before` is `{ users, dom }`: the pre-send count and the identity list taken
 * by `readDomUserTurns`. A null baseline can never prove a node is new.
 *
 * The return value is the last OBSERVATION, never a bare boolean: the caller has
 * to tell "provably not posted" (a readable baseline and zero new user nodes)
 * from "ambiguous" (a new user node that is not ours, several of them, or a
 * baseline that could not be read). Editing the second click on the second
 * question is what used to duplicate a send that had already landed.
 *
 * The thread tree is asked CONCURRENTLY with the DOM window instead of only
 * after it. On a real page the DOM can stop exposing the new user turn while
 * the tree answers within a second or two; deferring that read to the end of
 * the window made every send cost a fixed ~30 s before acceptance. The probe
 * schedule below is offset from the click and scaled DOWN for a shortened
 * window (the test harness), never stretched, so the first probe is always
 * early. Six probes inside the window plus the one evidence read at the
 * ceiling in `submitTurn` bound a send to seven tree reads, never more.
 *
 * A probe uses exactly the same POSITIVE predicate as the final read
 * (`treeSendEvidence` -> `degradedSendVerdict`): exactly one user node absent
 * from the pre-send identity baseline and carrying the sent text. A negative,
 * stale or unreadable probe is "no evidence yet" and is simply waited past; it
 * never accepts, concludes, or licenses anything.
 *
 * #109: when the caller passes `options.responseSignal` (the network observer's
 * `accepted` promise), a 2xx response to the page's own send POST accepts the
 * turn the moment it arrives. That is the shortest honest evidence: the server
 * acknowledged THIS click by starting the answer. The window races the signal
 * against each read, so on a healthy send it returns before the first scheduled
 * tree probe (1.5 s) and the per-send tree read is not on the path at all. A
 * signal that never resolves - a non-2xx, an invisible service-worker fetch -
 * changes nothing: the DOM and tree paths below are the fallback, unchanged.
 *
 * `{ accepted, readable, newNodes, path, elapsedMs, domPolls, treeProbes,
 * domReadMs, treeReadMs, treeReads }` - `newNodes` is the last observable DOM
 * array, or null when the baseline or the last DOM read was unreadable; `path`
 * is `'dom'`, `'tree'`, `'response'` or null. The `*Ms`/`treeReads` fields are
 * measurement only: the time spent inside reads, split from the window's own
 * cadence.
 */
async function waitForAcceptance(page, before, composedText = '', timeoutMs = 30_000, options = {}) {
  const startedAt = Date.now()
  // The caller's op deadline can only SHORTEN this window, never extend it.
  const windowDeadline = startedAt + timeoutMs
  const deadline = Number.isFinite(options.deadline) ? Math.min(windowDeadline, options.deadline) : windowDeadline
  const baseline = Array.isArray(before?.dom) ? before.dom : null
  const priorUsers = Math.max(baseline ? baseline.length : 0, Number(before?.users) || 0)
  if (!baseline) {
    // Known boundary (#109), deliberate: an unreadable PRE-SEND DOM baseline
    // returns here without consulting the response signal. On a healthy send
    // that costs nothing, because the signal is raced inside the loop below and
    // a readable baseline is the common case; if this page is unreadable the
    // window could not have judged it anyway, and the tree path stays the
    // fallback. Widening this would add a window-long wait to a failure case.
    return { accepted: false, readable: false, newNodes: null, path: null, elapsedMs: 0, domPolls: 0, treeProbes: 0, domReadMs: 0, treeReadMs: 0, treeReads: [] }
  }
  const treeBaseline = options.treeBaseline instanceof Map ? options.treeBaseline : null
  // Offsets from the click, in the shape of the production window; a shortened
  // window (the test harness, or an op deadline that cuts it) gets
  // proportionally earlier probes, never later ones.
  const scale = Math.min(1, Math.max(0, deadline - startedAt) / TREE_PROBE_WINDOW_MS)
  const probeOffsets = treeBaseline ? TREE_PROBE_OFFSETS_MS.map(offset => Math.round(offset * scale)) : []
  let nextProbe = 0
  let domPolls = 0
  let treeProbes = 0
  // Measurement only: how much of the window was spent INSIDE a read, split
  // from the cadence that surrounds it. A probe that takes 2.5 s dominates the
  // window; its 1.5 s first offset is scheduling, not read cost.
  let domReadMs = 0
  let treeReadMs = 0
  const treeReads = []
  let last = null
  let nextDomAt = startedAt
  // #109: the send POST's own 2xx response, if the caller wired one. A null
  // (observer stopped) maps to a never-settling branch so only real acceptance
  // can win a race; the DOM and tree paths stay exactly as they were.
  const RESPONSE_SIGNAL = Symbol('response')
  let responseOutcome = null
  const responseArrived = options.responseSignal instanceof Promise
    ? options.responseSignal.then(value => {
        if (!value) return new Promise(() => {})
        responseOutcome = value
        return RESPONSE_SIGNAL
      })
    : null
  const acceptedByResponse = () => ({
    accepted: true,
    readable: true,
    newNodes: null,
    path: 'response',
    elapsedMs: Date.now() - startedAt,
    domPolls,
    treeProbes,
    domReadMs,
    treeReadMs,
    treeReads,
    response: responseOutcome,
  })
  // True when a race settled because the send response arrived, not because the
  // read it raced completed. Strict on the sentinel only: checking
  // `responseOutcome` here would be global, so a DOM read that won its race a
  // microtask before the response resolved would be mis-attributed to the
  // response and lose its `newNodes`. The checks that do NOT race pass
  // `responseOutcome !== null` explicitly below.
  const wonByResponse = value => value === RESPONSE_SIGNAL
  while (Date.now() < deadline) {
    const now = Date.now()
    if (now >= nextDomAt) {
      const domAt = Date.now()
      const domRead = readDomUserTurns(page, priorUsers)
      const readValue = responseArrived ? await Promise.race([domRead, responseArrived]) : await domRead
      if (wonByResponse(readValue)) return acceptedByResponse()
      const observed = newDomUserTexts(baseline, readValue)
      domReadMs += Date.now() - domAt
      domPolls += 1
      // A read that failed is not evidence of a zero delta, so it clears `last`.
      last = Array.isArray(observed) ? observed : null
      if (sendAcceptVerdict({ newNodes: observed, sentText: composedText })) {
        return { accepted: true, readable: true, newNodes: observed, path: 'dom', elapsedMs: Date.now() - startedAt, domPolls, treeProbes, domReadMs, treeReadMs, treeReads }
      }
      nextDomAt = Date.now() + 250
    }
    if (nextProbe < probeOffsets.length && Date.now() >= startedAt + probeOffsets[nextProbe]) {
      const remaining = deadline - Date.now()
      treeProbes += 1
      if (remaining > 0) {
        const treeAt = Date.now()
        const treeRead = treeSendEvidence(page, composedText, treeBaseline, Math.min(TREE_PROBE_READ_TIMEOUT_MS, remaining))
        const tree = responseArrived ? await Promise.race([treeRead, responseArrived]) : await treeRead
        if (wonByResponse(tree)) return acceptedByResponse()
        const readMs = Date.now() - treeAt
        treeReadMs += readMs
        treeReads.push(readMs)
        if (tree.accepted) {
          return { accepted: true, readable: true, newNodes: null, path: 'tree', elapsedMs: Date.now() - startedAt, domPolls, treeProbes, domReadMs, treeReadMs, treeReads }
        }
      }
      nextProbe += 1
      // A probe that outlived its slot skips the slots it missed, so a failed
      // or slow read backs off instead of hammering.
      while (nextProbe < probeOffsets.length && startedAt + probeOffsets[nextProbe] <= Date.now()) nextProbe += 1
      continue
    }
    const waits = [nextDomAt]
    if (nextProbe < probeOffsets.length) waits.push(startedAt + probeOffsets[nextProbe])
    const wait = Math.min(...waits) - Date.now()
    const pause = Math.max(1, Math.min(wait, 250))
    let timer = null
    const slept = new Promise(resolve => { timer = setTimeout(resolve, pause) })
    if (responseArrived) await Promise.race([slept, responseArrived])
    else await slept
    clearTimeout(timer)
    if (responseOutcome !== null) return acceptedByResponse()
  }
  if (responseOutcome !== null) return acceptedByResponse()
  return { accepted: false, readable: true, newNodes: last, path: null, elapsedMs: Date.now() - startedAt, domPolls, treeProbes, domReadMs, treeReadMs, treeReads }
}

/**
 * Where the concurrent tree probes fall in a production acceptance window, as
 * offsets from the click. Six inside the window; the seventh and last read is
 * the ceiling evidence read in `submitTurn`.
 */
const TREE_PROBE_OFFSETS_MS = [1500, 3000, 5000, 8000, 12_000, 18_000]
const TREE_PROBE_WINDOW_MS = 30_000
const TREE_PROBE_READ_TIMEOUT_MS = 15_000

/** What a failed window saw, in words: the evidence named in the error and the log. */
function acceptanceEvidence(outcome) {
  if (!outcome?.readable) return 'the page could not be read before the send'
  if (!Array.isArray(outcome.newNodes)) return 'the page could not be read at the end of the window'
  if (outcome.newNodes.length === 0) return 'no new user turn appeared'
  if (outcome.newNodes.length === 1) return 'one new user turn appeared whose text is not ours'
  return `${outcome.newNodes.length} new user turns appeared`
}

/**
 * One thread-tree read, used three ways: a concurrent in-window probe, the
 * ceiling acceptance evidence, and the sentence a refusal names.
 *
 * The DOM cannot answer "did it land" - a rerender can stop exposing new user
 * nodes while the send succeeded. The tree can, but only POSITIVELY. "The tree
 * shows no such node" is a negative observation: a stale backend can serve a
 * snapshot taken before the click, so it proves nothing about this send and
 * licenses nothing. Nothing in this function decides whether to click again;
 * nothing anywhere does.
 *
 * Accepted when the tree, read once, shows exactly one user turn absent from
 * the pre-send baseline and carrying the sent text under the host's rule. The
 * DOM count is deliberately not consulted - a stale selector may show older
 * user nodes and still miss the new one - so the shared predicate is asked with
 * `userNodes: 0`, which is the statement that only the tree speaks here.
 *
 * `timeoutMs` bounds the backend read only: an in-window probe passes the time
 * left so it can never outlive the acceptance ceiling.
 */
async function treeSendEvidence(page, text, baseline, timeoutMs = TREE_PROBE_READ_TIMEOUT_MS) {
  if (!(baseline instanceof Map)) return { accepted: false, why: 'could not be read before the send' }
  const threadId = threadOf(page.url())
  if (!threadId) return { accepted: false, why: 'has no thread to read' }
  const read = await readUserNodesOn(page, `/backend-api/conversation/${threadId}`, timeoutMs).catch(() => null)
  if (!read?.ok) return { accepted: false, why: 'could not be read' }
  const fresh = newUserNodes(baseline, userTreeNodes(read.body))
  if (fresh === null) return { accepted: false, why: 'could not be read' }
  if (degradedSendVerdict({ userNodes: 0, newNodes: fresh, sentText: text })) {
    return { accepted: true, why: 'shows exactly one new turn carrying the sent text' }
  }
  if (fresh.length === 0) return { accepted: false, why: 'holds no new turn carrying this text' }
  return { accepted: false, why: 'shows more than one new turn, so ours cannot be attributed' }
}

/**
 * Does this SSE frame say the assistant turn is over?
 *
 * G-018: the send POST's body carries a `delta` patch whose `v` array both
 * replaces `/message/status` with `finished_successfully` and `/message/end_turn`
 * with `true`. That pair is the source's own statement that the message is
 * complete, and it arrives 2.2-2.8 s before this page cancels its reader (live,
 * 2026-11-01, four turns).
 *
 * The predicate is deliberately narrow. `finished_successfully` also appears on
 * messages that are CREATED already finished (system, tool and reasoning
 * messages), and `is_complete:true` / `finish_details` / stop_tokens appear on
 * an empty assistant shell (live: `stop_tokens:[200012]`). None of those is a
 * patch on this turn's message, so requiring two patch operations in ONE delta
 * excludes them.
 */
function parseTurnMarker(eventName, data) {
  if (eventName !== 'delta') return null
  let payload = null
  try { payload = JSON.parse(data) } catch { return null }
  const ops = Array.isArray(payload?.v) ? payload.v : null
  if (!ops) return null
  let statusDone = false
  let endTurn = false
  for (const op of ops) {
    if (!op || typeof op !== 'object') continue
    if (op.p === '/message/status' && op.o === 'replace' && op.v === 'finished_successfully') statusDone = true
    else if (op.p === '/message/end_turn' && op.o === 'replace' && op.v === true) endTurn = true
  }
  return statusDone && endTurn ? { status: 'finished_successfully', endTurn: true } : null
}

/**
 * The answer message's id, from the marker frames that carry it. The completion
 * patch itself names no message, so this is how the marker is anchored to the
 * message it belongs to: `user_visible_token`/`first` announces the id,
 * `last_token`/`last` corroborates it. Corroboration is logged, never required.
 */
function parseMessageMarker(eventName, data) {
  let payload = null
  try { payload = JSON.parse(data) } catch { return null }
  if (payload?.type !== 'message_marker') return null
  return {
    messageId: typeof payload.message_id === 'string' ? payload.message_id : null,
    marker: typeof payload.marker === 'string' ? payload.marker : '',
    event: typeof payload.event === 'string' ? payload.event : '',
  }
}

/**
 * The content-part operations this frame carries, in order. The body writes
 * them three ways, all live on 2026-11-01:
 *   {v:[{p:"/message/content/parts/0",o:"append",v:"..."}]}   array of ops
 *   {p:"",o:"patch",v:[{p:"/message/content/parts/0",...}]}   one op, ops in v
 *   {p:"/message/content/parts/0",o:"append",v:"..."}         one op
 * Only part ops with a string value are content; everything else is skipped.
 */
function contentPartOps(payload) {
  const ops = []
  const take = op => {
    if (!op || typeof op !== 'object') return
    if (typeof op.p !== 'string' || typeof op.v !== 'string') return
    if (!/^\/message\/content\/parts\/\d+$/.test(op.p)) return
    ops.push(op)
  }
  if (Array.isArray(payload?.v)) {
    for (const op of payload.v) take(op)
  } else {
    take(payload)
  }
  return ops
}

/**
 * How many characters of answer text this frame carries, or null. Used only to
 * detect a content delta arriving AFTER the completion patch: the answer is
 * then being edited after the source said it was over, which changes what the
 * confirm window has to cover.
 */
function framePartOps(eventName, data) {
  if (eventName !== 'delta') return []
  let payload = null
  try { payload = JSON.parse(data) } catch { return [] }
  return contentPartOps(payload)
}

function parseContentDelta(eventName, data) {
  const ops = framePartOps(eventName, data)
  if (!ops.length) return null
  let chars = 0
  for (const op of ops) chars += op.v.length
  return chars > 0 ? chars : null
}

/**
 * The message id a frame names, or null. Content-append frames name no message,
 * so this is the only way to attribute them: a message object inside the frame
 * (creation snapshots) or the message id carried by a `message_marker` frame.
 */
function frameMessageId(eventName, data) {
  let payload = null
  try { payload = JSON.parse(data) } catch { return null }
  if (!payload || typeof payload !== 'object') return null
  const direct = payload?.message?.id
  if (typeof direct === 'string' && direct) return direct
  const inside = payload?.v
  if (inside && typeof inside === 'object' && !Array.isArray(inside)) {
    const id = inside.message?.id
    if (typeof id === 'string' && id) return id
  }
  if (Array.isArray(inside)) {
    for (const op of inside) {
      const id = op?.v && typeof op.v === 'object' ? op.v.message?.id : null
      if (typeof id === 'string' && id) return id
    }
  }
  return null
}

/**
 * Render markdown-ish payload text the way the page's innerText shows prose:
 * cite/HTML tags gone, links reduced to their text, emphasis/fence/heading/
 * quote marks gone, table pipes gone, rule lines gone, whitespace collapsed.
 * This is the comparison surface for the payload tail check; it is deliberately
 * blind to formatting, because the DOM has no markdown.
 */
function normalizeAnswerText(text) {
  return String(text ?? '')
    // Fence lines (``` and ```python) are chrome: the page renders the code
    // without them, and its own "Python / Run" header sits where the label was.
    .replace(/^[ \t]*```[^\n]*$/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[`*_#>]/g, ' ')
    .replace(/\|/g, ' ')
    .replace(/-{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The suffix the DOM must show before the marker path may deliver, or null when
 * the payload is too small to make a claim.
 *
 * It is built from the LAST BLOCK of the payload, not from the last N words of
 * everything: the page renders a fence's language label and a "Run" control
 * between a prose line and its code, so a suffix that spans that boundary can
 * never close even on a correct DOM. Whole words inside one block survive
 * rendering (the DOM shows tabs where markdown had pipes, spaces where it had
 * newlines), so the rule is: take the last block; walk back only if it holds
 * fewer than TAIL_MIN_WORDS; then keep its last TAIL_WORDS words.
 */
function tailSuffix(rawText, words = TAIL_WORDS) {
  const blocks = String(rawText ?? '').split(/\n[ \t]*\n+/).map(normalizeAnswerText).filter(Boolean)
  if (!blocks.length) return null
  let suffix = blocks[blocks.length - 1]
  let index = blocks.length - 2
  const count = value => value.split(' ').filter(Boolean).length
  while (count(suffix) < TAIL_MIN_WORDS && index >= 0) {
    suffix = `${blocks[index]} ${suffix}`.trim()
    index -= 1
  }
  const parts = suffix.split(' ').filter(Boolean)
  if (parts.length < TAIL_MIN_WORDS) return null
  return parts.slice(-Math.min(words, parts.length)).join(' ')
}

/**
 * Split decoded SSE text into frames. `push` takes base64 bytes as CDP delivers
 * them and calls `onFrame(name, data, at)` per complete frame; a frame split
 * across chunks is held until its blank-line terminator arrives.
 */
function createSseFrames(onFrame) {
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  return {
    push(base64, at) {
      let bytes = null
      try { bytes = Buffer.from(String(base64), 'base64') } catch { return }
      buffer += decoder.decode(bytes, { stream: true })
      for (;;) {
        const match = /\r?\n\r?\n/.exec(buffer)
        if (!match) return
        const raw = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)
        let name = ''
        const data = []
        for (const line of raw.split(/\r?\n/)) {
          if (!line || line.startsWith(':')) continue
          const colon = line.indexOf(':')
          const field = colon === -1 ? line : line.slice(0, colon)
          let value = colon === -1 ? '' : line.slice(colon + 1)
          if (value.startsWith(' ')) value = value.slice(1)
          if (field === 'event') name = value
          else if (field === 'data') data.push(value)
        }
        if (!name && !data.length) continue
        try { onFrame(name, data.join('\n'), at) } catch {}
      }
    },
  }
}

/**
 * A started/stopped observer for the page's own requests, built on the CDP
 * Network domain instead of page request events.
 *
 * `page.on('request')` is page-level convenience and does not surface every
 * request that actually leaves the renderer: a fetch made by a service worker or
 * a worker frame belongs to that target, not to the page's request events. The
 * CDP Network domain on the page's own session is the closest observer this
 * driver has, and even it sees only what the page target dispatches - a
 * service-worker fetch can still be invisible, and the caller must report that
 * as a fact about the observer, never as proof the page did not send.
 *
 * Reusable on purpose: the sender starts it before the click and holds it across
 * the acceptance window, so a later unit can consult the same `seen` list
 * instead of adding a second capture. Every failure here is swallowed into
 * `reason`: the send path must never depend on an observer.
 *
 * #109: the same session also watches the RESPONSE to the page's own send POST.
 * A 2xx on `POST /backend-api/(f/)conversation` is the server acknowledging the
 * turn: it begins streaming the answer for this request. That is acceptance
 * evidence about THIS click, available at header time. It is offered as the
 * `accepted` promise so the acceptance window can stop waiting for a thread-tree
 * read it no longer needs. A non-2xx, a different endpoint or an invisible
 * request (service worker, worker frame) leaves the promise pending, and every
 * existing evidence path - DOM and tree - is unchanged as the fallback.
 *
 * `stop()` is idempotent and returns `{ available, reason, seen }`, where
 * `seen` holds `{ at, method, pathname }` in arrival order. `at` is a wall
 * clock stamp; the caller differences it against its own click milestone.
 * `accepted` resolves `{ at, status, pathname }` on that 2xx, or null on stop.
 */
async function startNetworkWatch(page) {
  // Every CDP await on the send path carries a ceiling: an observer that wedges
  // must degrade to "unavailable", never hold up the click or the log.
  const ceiling = (promise, what) => {
    let timer = null
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not answer within ${OBSERVER_TIMEOUT_MS}ms`)), OBSERVER_TIMEOUT_MS)
    })
    return Promise.race([promise, expired]).finally(() => clearTimeout(timer))
  }
  const seen = []
  // The requestIds of the page's own send POSTs, so a response can be attributed
  // to a send this watcher actually saw rather than to any 2xx that happens past.
  const sendRequests = new Set()
  // The newest send POST this watcher saw. A completion is only attributable to
  // the request the acceptance belongs to; a later POST means the turn the
  // caller is waiting for is not the one that finished (see `superseded`).
  let latestSendId = null
  let acceptedResponse = null
  let resolveAccepted = null
  const accepted = new Promise(resolve => { resolveAccepted = resolve })
  // The send POST's body streams the answer, so its end is the page target's own
  // statement that the model stopped writing. It is NOT acceptance and never
  // becomes one: `waitForReply` keeps its evidence rule and only uses this to
  // sample faster once there is nothing left to stream. Two end kinds count:
  // `loadingFinished`, and a client cancellation - this page cancels its own
  // reader when the SSE ends, and the transport reports that as ERR_ABORTED with
  // no `loadingFinished` ever arriving. The promise resolves once, to `{ at,
  // requestId, end: 'finished' | 'canceled' }`, `{ failedAt, requestId, reason }`
  // for any other failure, or null (stopped, superseded, no qualifying request).
  const finished = new Map()
  let settleCompletion = null
  const completion = new Promise(resolve => { settleCompletion = resolve })
  const resolveCompletion = value => {
    const resolve = settleCompletion
    if (!resolve) return
    settleCompletion = null
    resolve(value)
  }
  const considerCompletion = () => {
    if (!acceptedResponse || !settleCompletion) return
    if (latestSendId !== null && latestSendId !== acceptedResponse.requestId) return resolveCompletion(null)
    const entry = finished.get(acceptedResponse.requestId)
    if (entry) resolveCompletion(entry)
  }
  // G-018: the answer's own completion patch, read from the send POST's body.
  // `Network.streamResourceContent` asks Chrome to hand the CDP session the
  // bytes it is already reading; it is an observer, never a proxy - the page's
  // reader is not paused, redirected or re-created. The promise resolves once,
  // to `{ at, requestId, messageId, lastTokenAt }` at the first qualifying
  // patch, or null when this observer can no longer say anything (stopped,
  // superseded, or the tap could not be started).
  let settleMarker = null
  const marker = new Promise(resolve => { settleMarker = resolve })
  const resolveMarker = value => {
    const resolve = settleMarker
    if (!resolve) return
    settleMarker = null
    resolve(value)
  }
  let tapId = null
  let answerMessageId = null
  let lastTokenAt = null
  let tapping = false
  let markerResolvedAt = null
  let postMarkerDeltas = 0
  // The answer's own stream text, kept per message id. Content-append frames
  // name no message, so a frame that names a different message resets the
  // buffer; the tail check only speaks when that id is the answer id the marker
  // named, and is unavailable otherwise.
  let answerBuffer = { id: null, parts: [], at: null }
  const resetAnswer = id => { answerBuffer = { id, parts: [], at: Date.now() } }
  const reader = createSseFrames((eventName, data, at) => {
    const namedId = frameMessageId(eventName, data)
    if (namedId && namedId !== answerBuffer.id) resetAnswer(namedId)
    // Contents next: a frame that both edits the answer and closes the message
    // must not be lost to the early return below.
    const ops = framePartOps(eventName, data)
    if (ops.length) {
      if (markerResolvedAt !== null) {
        postMarkerDeltas += 1
        log(`reply marker: post-marker content delta at +${at - markerResolvedAt}ms, ${ops.reduce((sum, op) => sum + op.v.length, 0)} chars, ${postMarkerDeltas} since the marker`)
      }
      for (const op of ops) {
        const index = Number(op.p.slice(op.p.lastIndexOf('/') + 1))
        const held = answerBuffer.parts[index] || ''
        answerBuffer.parts[index] = op.o === 'replace' ? op.v : held + op.v
      }
      answerBuffer.at = at
    }
    const named = parseMessageMarker(eventName, data)
    if (named) {
      if (named.marker === 'user_visible_token' && named.event === 'first' && named.messageId) {
        answerMessageId = named.messageId
        if (answerBuffer.id !== named.messageId) resetAnswer(named.messageId)
      } else if (named.marker === 'last_token' && named.event === 'last') lastTokenAt = at
      return
    }
    if (!parseTurnMarker(eventName, data)) return
    // Only the accepted request's own body can speak for this turn, and only
    // while it is still the newest send: a marker for a superseded requestId is
    // not evidence about the turn the caller is waiting for.
    if (!acceptedResponse || tapId !== acceptedResponse.requestId) return
    if (latestSendId !== null && latestSendId !== acceptedResponse.requestId) return
    markerResolvedAt = at
    resolveMarker({ at, requestId: acceptedResponse.requestId, messageId: answerMessageId, lastTokenAt })
  })
  // One tap per turn, started at the response header. The call fails while the
  // response is not yet streaming, so it is retried; every failure is bounded
  // and swallowed - a tap that cannot start costs the marker path, never the
  // turn.
  const startTap = requestId => {
    if (tapping || session === null) return
    tapping = true
    tapId = requestId
    const deadline = Date.now() + MARKER_TAP_DEADLINE_MS
    ;(async () => {
      for (;;) {
        const held = session
        if (!held) return
        try {
          const result = await ceiling(held.send('Network.streamResourceContent', { requestId }), 'Network.streamResourceContent')
          const buffered = typeof result?.bufferedData === 'string' ? result.bufferedData : ''
          if (buffered) reader.push(buffered, Date.now())
          return
        } catch {
          // Give up quietly: the turn keeps its guard and shortener.
          if (Date.now() >= deadline) return
          await new Promise(resolve => setTimeout(resolve, MARKER_TAP_RETRY_MS))
        }
      }
    })().catch(() => {})
  }
  let session = null
  let reason = null
  try {
    const context = typeof page?.context === 'function' ? page.context() : null
    if (!context || typeof context.newCDPSession !== 'function') {
      reason = 'the page has no CDP context'
    } else {
      session = await ceiling(context.newCDPSession(page), 'the CDP session')
      session.on('Network.requestWillBeSent', event => {
        try {
          const request = event?.request ?? {}
          let pathname = ''
          try { pathname = new URL(String(request.url ?? '')).pathname } catch {}
          if (seen.length < 200) seen.push({ at: Date.now(), method: String(request.method ?? ''), pathname })
          const requestId = event?.requestId
          if (requestId && String(request.method) === 'POST' && SEND_POST_PATH.test(pathname)) {
            sendRequests.add(requestId)
            if (latestSendId !== requestId) {
              latestSendId = requestId
              // A second send POST while we hold an acceptance means the request
              // that was accepted is not the last word: nothing it emits can be
              // attributed to the turn the caller waits for.
              if (acceptedResponse && requestId !== acceptedResponse.requestId) { resolveCompletion(null); resolveMarker(null) }
            }
          }
        } catch {}
      })
      session.on('Network.responseReceived', event => {
        try {
          if (acceptedResponse) return
          const requestId = event?.requestId
          if (!requestId || !sendRequests.has(requestId)) return
          const status = Number(event?.response?.status)
          // Only a 2xx is the server accepting the turn. A 4xx/5xx is reported by
          // the other evidence paths, never as acceptance.
          if (!(status >= 200 && status < 300)) return
          let pathname = ''
          try { pathname = new URL(String(event?.response?.url ?? '')).pathname } catch {}
          acceptedResponse = { at: Date.now(), status, pathname, requestId }
          resolveAccepted(acceptedResponse)
          considerCompletion()
          startTap(requestId)
        } catch {}
      })
      // Bytes Chrome is already reading from the send POST, once the tap asked
      // for them. `data` is base64 of the ALREADY-DECODED body even when the
      // response header says `content-encoding: gzip` (live, 2026-11-01), which
      // is why the frames are parsed as text and not gunzipped.
      session.on('Network.dataReceived', event => {
        try {
          if (!tapId || event?.requestId !== tapId) return
          if (typeof event?.data === 'string' && event.data) reader.push(event.data, Date.now())
        } catch {}
      })
      // The body ending is the only claim this makes: the request is done. A
      // truncated or aborted stream is reported the way it happened, so a caller
      // can decline to trust it rather than mistake a cut-off for a done.
      session.on('Network.loadingFinished', event => {
        try {
          const requestId = event?.requestId
          if (!requestId || !sendRequests.has(requestId)) return
          if (finished.size >= 20) finished.delete(finished.keys().next().value)
          finished.set(requestId, { at: Date.now(), requestId, end: 'finished' })
          considerCompletion()
        } catch {}
      })
      session.on('Network.loadingFailed', event => {
        try {
          const requestId = event?.requestId
          if (!requestId || !sendRequests.has(requestId)) return
          if (finished.size >= 20) finished.delete(finished.keys().next().value)
          // A client cancellation is an END, not a transport fault: the page
          // cancels its own reader when the SSE ends (live, 2026-11-01: fifteen
          // chunks, then `loadingFailed` 12 ms after the last one and no
          // `loadingFinished` ever). Only `canceled === true` says that - an
          // aborted-looking transport failure is ambiguous (a truncation and a
          // finished reader both read as ERR_ABORTED) and must pay the full
          // fallback rather than risk shortening on a partial answer. Only the
          // accepted request's cancellation is consulted - `considerCompletion`
          // keys on that requestId.
          if (event?.canceled === true) {
            finished.set(requestId, { at: Date.now(), requestId, end: 'canceled' })
          } else {
            finished.set(requestId, {
              failedAt: Date.now(),
              requestId,
              reason: String(event?.errorText ?? event?.blockedReason ?? 'the stream did not finish'),
            })
          }
          considerCompletion()
        } catch {}
      })
      await ceiling(session.send('Network.enable'), 'Network.enable')
    }
  } catch (error) {
    reason = `the CDP Network domain could not be started (${error instanceof Error ? error.message : String(error)})`
    const abandoned = session
    session = null
    if (abandoned) { try { await ceiling(abandoned.detach(), 'detach') } catch {} }
  }
  return {
    available: session !== null,
    reason,
    seen,
    // Resolves `{ at, status, pathname }` on the page's own send POST answering
    // 2xx, or null once the observer is stopped. It never rejects.
    accepted,
    // Resolves `{ at, requestId, end }` when the accepted POST's body ended,
    // where `end` is `finished` or `canceled` (the page's own reader
    // cancellation), `{ failedAt, requestId, reason }` when the transport failed
    // some other way, and null when this observer can no longer say anything
    // (stopped, superseded). Never rejects.
    completion,
    // Resolves `{ at, requestId, messageId, lastTokenAt }` at the first
    // `/message/status finished_successfully` + `/message/end_turn true` patch
    // in the accepted send POST's body, or null when the observer is stopped,
    // superseded, or the tap could not be started. Never rejects.
    marker,
    // The answer text the tap has received so far, as `{ id, text, at }`, or
    // `{ id: null, text: '' }` when no content has been attributed yet. It is a
    // live read, not a snapshot: a post-marker delta shows here too. The marker
    // path uses `text` to check that the DOM has caught up to the source; when
    // `id` is not the answer id the marker named, the check is unavailable.
    answerText: () => ({ id: answerBuffer.id, text: answerBuffer.parts.join(''), at: answerBuffer.at }),
    stop: async () => {
      const held = session
      session = null
      if (held) {
        // Disable and detach together, each bounded, so stopping can cost at
        // most one ceiling and can never hang the caller.
        await Promise.allSettled([
          ceiling(held.send('Network.disable'), 'Network.disable'),
          ceiling(held.detach(), 'detach'),
        ])
      }
      // Release anyone racing on acceptance, completion or the marker: the
      // observer is gone, so none of them can arrive for it now.
      if (postMarkerDeltas) await log(`reply marker: ${postMarkerDeltas} content delta(s) after the marker`)
      if (!acceptedResponse) resolveAccepted(null)
      resolveCompletion(null)
      resolveMarker(null)
      return { available: held !== null, reason, seen }
    },
  }
}

/**
 * Click Send once, then decide from evidence what that click did.
 *
 * INVARIANT: one prompt gets at most ONE Send click. A duplicate message is
 * worse than a stalled turn, so nothing here ever clicks twice - not on a
 * swallowed click, not on a stale DOM, not on any "probably did not submit"
 * observation. The only `not-posted` outcome is the pre-click one: the send
 * control never became ready, so nothing was sent.
 *
 * Decision table:
 *   1. send control never ready         -> not-posted (nothing was typed or sent)
 *   2. click Send exactly once
 *   3. the 2xx response to the send POST, or the DOM window, or a concurrent
 *      tree probe accepts              -> return, logging path + elapsed
 *   4. the ceiling evidence read shows exactly one NEW user turn carrying our
 *      text                             -> accepted (log it, return)
 *   5. anything else                    -> ambiguous, naming what was seen;
 *                                          the host observes the thread
 *
 * There is deliberately no third state. A swallowed click settles as
 * `ambiguous`, the host watches the thread, and if nothing appears the turn
 * reaches its TTL. That is the accepted availability trade: the driver will
 * sometimes leave a turn unposted rather than risk posting it twice.
 */
async function submitTurn(page, { baseline, text, treeBaseline = null, phaseLabel = null, phaseStartedAt = null, deadline = null, holdNetwork = false }) {
  // One absolute deadline for every blocking await below. `ask` passes the clock
  // it has already been counting (extended by any attach time); a direct caller
  // gets the acceptance bound from now. Expiry before the click is `not-posted`
  // (nothing was sent); expiry after it is `ambiguous` (it may have landed).
  const opDeadline = Number.isFinite(deadline) ? deadline : Date.now() + SEND_ACCEPT_DEADLINE_MS
  const readyAt = Date.now()
  const readiness = await railed(waitForSendReady(page), opDeadline, sendDeadlineNotPosted)
  const readyMs = Date.now() - readyAt
  if (!readiness.ready) {
    // `not-posted:` is the host's keep-queued token (matched on the message text,
    // not on `reason`; chatgpt-peer.ts ~2274) - the same refusals as the compose
    // path, which would otherwise become terminal failures for the sender.
    throw new TurnError(`not-posted: the page never became ready to send (${readiness.reason}); nothing was sent, so no reply is coming`, { reason: 'not-posted' })
  }
  // Measurement only, and before the click: what the click call is about to do
  // is not observable from outside it, so these two reads name the work the
  // actionability check will repeat. Both are pure reads; neither touches the
  // click's semantics and both are folded into the pre-click span, not into
  // `click_end`.
  const probeMs = async probe => {
    const at = Date.now()
    try { await probe() } catch {}
    return Date.now() - at
  }
  const clickStateMs = await railed(probeMs(async () => {
    if (typeof readiness.send.isVisible === 'function') await readiness.send.isVisible()
    if (typeof readiness.send.isEnabled === 'function') await readiness.send.isEnabled()
  }), opDeadline, sendDeadlineNotPosted)
  const clickBoxMs = await railed(probeMs(async () => {
    if (typeof readiness.send.boundingBox === 'function') await readiness.send.boundingBox()
  }), opDeadline, sendDeadlineNotPosted)
  // Observation only: the page's own send POST, when the page exposes request
  // events. The listener is attached before the click and removed once the
  // acceptance window has been judged, so it cannot outlive the turn.
  let postSeenAt = null
  const onRequest = request => {
    try {
      // One regex for both forms: the live send is `POST /backend-api/f/conversation`,
      // and earlier builds used the bare `/backend-api/conversation`. The `f/`
      // segment is optional rather than a second listener, so the page contrast
      // against the CDP watch stays one observation of one predicate.
      if (postSeenAt === null && request.method() === 'POST' && /\/backend-api\/(?:f\/)?conversation/.test(request.url())) postSeenAt = Date.now()
    } catch {}
  }
  const watchingPost = typeof page?.on === 'function'
  if (watchingPost) page.on('request', onRequest)
  // #106: the CDP Network observer is started before the click and held across
  // the acceptance window. The page-level listener above stays as the contrast:
  // what the page events show and what the page target's network shows are two
  // different observations, and only the second is allowed to name the endpoint.
  const network = await startNetworkWatch(page)
  // #106 SCROLL and TRIAL are OPT-IN (CHATGPT_CLICK_PROBE=1), because on the
  // primary send path they cost a second full actionability pass and dispatch
  // nothing: live 2026-11-01 measured scroll 2012 + trial 2369 against a real
  // click of 2118 ms, so the default path pays only the click.
  if (CLICK_PROBE) {
    // SCROLL first: a trial click scrolls the element into view as part of its
    // actionability set, so timing the scroll AFTER a trial would measure an
    // element the trial had just scrolled in (~0) and hide the real scroll cost
    // inside `click_trial`.
    const clickScrollMs = await probeMs(async () => {
      if (typeof readiness.send.scrollIntoViewIfNeeded === 'function') await readiness.send.scrollIntoViewIfNeeded()
    })
    // TRIAL: a trial click runs the same actionability checks as the real one
    // (visible, stable, receives events, enabled) and dispatches nothing, so it
    // times what the real call waits for without ever becoming a second click.
    // Bounded so a wedged button costs at most this once, never a doubled
    // default wait. This is the ONLY call that may carry `trial: true`; the real
    // click below is the only one that may dispatch.
    const trialAt = Date.now()
    let trialTimedOut = false
    try {
      if (typeof readiness.send.click === 'function') await readiness.send.click({ trial: true, timeout: CLICK_TRIAL_TIMEOUT_MS })
    } catch (error) {
      trialTimedOut = /timeout/i.test(String(error?.message ?? ''))
    }
    const clickTrialMs = Date.now() - trialAt
    if (phaseLabel) {
      await log(`phase ${phaseLabel} click_scroll ${clickScrollMs}ms`)
      await log(`phase ${phaseLabel} click_trial ${clickTrialMs}ms`)
      if (trialTimedOut) await log(`phase ${phaseLabel} click_trial_timeout ${clickTrialMs}ms`)
    }
  }
  // The only click this function is allowed to make. The bracket pair exists to
  // time the click itself: Playwright's actionability wait and the page's own
  // send handler both live inside this one call, and the `ready` line below is
  // stamped after it, so without these two lines that time has no name.
  // The deadline gate is checked BEFORE the call so a passed deadline cannot
  // invoke a click that might dispatch: an unstarted click is provably nothing.
  if (Date.now() >= opDeadline) throw sendDeadlineNotPosted()
  const clickStartedAt = Date.now()
  if (phaseLabel) await log(`phase ${phaseLabel} click_begin ${clickStartedAt - (phaseStartedAt ?? clickStartedAt)}ms`)
  // A rail that fires INSIDE this call is ambiguous, never not-posted: the call
  // may already have dispatched before the deadline passed.
  try {
    await railed(readiness.send.click(), opDeadline, sendDeadlineAmbiguous)
  } catch (error) {
    if (error?.reason === 'ambiguous') throw error
    await log(`send click failed: ${error.message}`)
  }
  const clickedAt = Date.now()
  const clickDispatchMs = clickedAt - clickStartedAt
  if (phaseLabel) {
    // #106: the real click gets its own name (`click_dispatch`); `click_end`
    // keeps its #105 meaning (the real call alone) so the two blocks stay
    // comparable. The trial and the scroll are deliberately outside both.
    await log(`phase ${phaseLabel} click_dispatch ${clickDispatchMs}ms`)
    await log(`phase ${phaseLabel} click_end ${clickDispatchMs}ms`)
  }
  // Measurement only, and after the click so the click path is unchanged: the
  // probe split, the send-ready wait, and the whole pre-click span ask() began
  // timing. `click_end` is the click call alone; these two are outside it.
  if (phaseLabel) {
    await log(`phase ${phaseLabel} click_state ${clickStateMs}ms`)
    await log(`phase ${phaseLabel} click_box ${clickBoxMs}ms`)
    await log(`phase ${phaseLabel} ready ${readyMs}ms`)
    if (phaseStartedAt) await log(`phase ${phaseLabel} preclick ${clickedAt - phaseStartedAt}ms`)
  }
  await log(`sent ${text.length} chars`)
  // The DOM window, the scheduled tree probes and (#109) the 2xx response to the
  // page's own send POST run together, and the first acceptance wins. Every
  // operation after the click is a read. The window never outlives the op
  // deadline: it is cut at `opDeadline` (a shorter window is never stretched),
  // so a click that has not been proved by then is ambiguous.
  // `released` makes teardown single-shot: whichever path ends the turn - the
  // direct returns below, a throw from the window or the ceiling, or the
  // caller's own release after the reply - exactly one stop runs, and a listener
  // or CDP session cannot outlive it. `holdNetwork` is the one caller that keeps
  // the observer alive past this function: `ask` takes the returned `release`
  // and runs it in its own `finally`, so the send POST's stream end can time the
  // reply. Every other caller gets the watcher stopped before this returns.
  let released = false
  let release = null
  const dropPageListener = () => {
    if (!watchingPost) return
    if (typeof page.off === 'function') page.off('request', onRequest)
    else if (typeof page.removeListener === 'function') page.removeListener('request', onRequest)
  }
  // The pre-window stop. It is a plain function rather than a `finally` arm on
  // purpose: a frozen row derives its replacement span from `const outcome =
  // await waitForAcceptance...` to the closing brace, so a `try` opened before
  // that marker would be left dangling by the replacement. Every exit below
  // therefore stops explicitly, and `released` keeps the double calls single-shot.
  const stopNow = async () => {
    if (released) return null
    released = true
    dropPageListener()
    return await network.stop()
  }
  const outcome = await waitForAcceptance(page, baseline, text, ACCEPTANCE_TIMEOUT_MS, { treeBaseline, deadline: opDeadline, responseSignal: network.accepted })
    .catch(async error => { await stopNow().catch(() => null); throw error })
  await log(watchingPost
    ? (postSeenAt === null
        ? 'click post: no send POST was observed before acceptance'
        : `click post: the send POST was seen ${postSeenAt - clickStartedAt}ms after click_begin (${postSeenAt - clickedAt}ms after click_end)`)
    : 'click post: the page exposes no request events')
  // #106: what the page TARGET's network saw, independent of page events. A
  // service-worker or worker-frame fetch belongs to another target and will not
  // appear here; saying so is the honest report, not evidence nothing was sent.
  const networkAt = network.seen.find(entry => entry.method === 'POST' && entry.pathname.startsWith('/backend-api/'))
  await log(network.available
    ? (networkAt
        ? `click network: the CDP session saw ${networkAt.method} ${networkAt.pathname} at ${networkAt.at - clickStartedAt}ms after click_begin (${network.seen.length} requests seen)`
        : `click network: the CDP session saw no backend POST before acceptance (${network.seen.length} requests seen; a service-worker or worker-frame fetch does not appear on the page target)`)
    : `click network: no CDP session (${network.reason})`)
  await log(`acceptance window: path ${outcome.path ?? 'none'}, ${outcome.domPolls} DOM polls in ${outcome.domReadMs}ms, ${outcome.treeProbes} tree probes in ${outcome.treeReadMs}ms${outcome.treeReads.length ? ` (${outcome.treeReads.join(',')}ms)` : ''}${outcome.path === 'response' ? ` (send POST answered HTTP ${outcome.response?.status ?? '2xx'})` : ''}`)
  // The shipped teardown, still after the window it closes (#106 pins this
  // literal's position). `stopNow` above is the same stop for the exits that can
  // happen before this line is reached; whichever runs first wins.
  release = async () => {
    if (released) return null
    released = true
    dropPageListener()
    const net = await network.stop()
    return net
  }
  if (outcome.accepted) {
    const elapsed = Date.now() - clickedAt
    await log(outcome.path === 'dom'
      ? `acceptance in ${elapsed}ms: DOM, exactly one new user turn carrying the sent text`
      : outcome.path === 'response'
        ? `acceptance in ${elapsed}ms: the send response, the page's own POST was answered HTTP ${outcome.response?.status ?? '2xx'}`
        : `acceptance in ${elapsed}ms: thread tree, exactly one new turn carrying the sent text`)
    if (holdNetwork) return { network, release }
    await release().catch(() => null)
    return null
  }
  // Nothing inside the window accepted. One evidence read at the ceiling, used
  // two ways: positive acceptance, or the evidence named in the refusal. A tree
  // that merely shows nothing is a negative observation (a stale backend can
  // serve a pre-click snapshot) and licenses nothing. This is the seventh and
  // last tree read of this send, never a reason to click again.
  // Gate before the call, so a passed deadline cannot start one more backend
  // read that nothing is waiting for.
  if (Date.now() >= opDeadline) {
    await release().catch(() => null)
    throw sendDeadlineAmbiguous()
  }
  const ceilingAt = Date.now()
  const tree = await railed(treeSendEvidence(page, text, treeBaseline), opDeadline, sendDeadlineAmbiguous)
    .catch(async error => { await stopNow().catch(() => null); throw error })
  await log(`acceptance ceiling: the last tree read took ${Date.now() - ceilingAt}ms`)
  if (tree.accepted) {
    await log(`acceptance in ${Date.now() - clickedAt}ms: the DOM exposed no new user turn; the thread tree shows exactly one new turn carrying the sent text`)
    if (holdNetwork) return { network, release }
    await release().catch(() => null)
    return null
  }
  await release().catch(() => null)
  throw new TurnError(`the send may have landed: ${acceptanceEvidence(outcome)}, and the thread tree ${tree.why}; nothing was clicked again - watch the thread for it rather than re-sending`, { reason: 'ambiguous' })
}

/** Collapse runs of whitespace and trim - the only normalization the page's own text is compared under. */
function normalizedTurnText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Read the user nodes out of a thread tree: identity -> that node's FULL
 * normalized text.
 *
 * Identity, not text, is what makes a node "already there": an id that was
 * present before the send can never satisfy it afterwards, even if the server
 * recycled that id for a different turn. A node is keyed by its message id when
 * it has one and by its mapping key otherwise. An unreadable body is null, and
 * a node with no usable identity is dropped so it can never look NEW.
 */
function userTreeNodes(body) {
  const mapping = body && typeof body === 'object' && body.mapping && typeof body.mapping === 'object' ? body.mapping : null
  if (!mapping) return null
  const nodes = new Map()
  for (const [key, node] of Object.entries(mapping)) {
    if (node?.message?.author?.role !== 'user') continue
    const id = node.message.id ?? node.id
    const identity = typeof id === 'string' && id ? `m:${id}` : typeof key === 'string' && key ? `n:${key}` : null
    if (!identity) continue
    const parts = Array.isArray(node.message.content?.parts) ? node.message.content.parts : []
    nodes.set(identity, normalizedTurnText(parts.filter(part => typeof part === 'string').join('\n')))
  }
  return nodes
}

/** The full normalized texts of the user nodes present now but absent at baseline, or null when either side is unusable. */
function newUserNodes(baseline, after) {
  if (!(baseline instanceof Map) || !(after instanceof Map)) return null
  const fresh = []
  for (const [identity, said] of after) {
    if (!baseline.has(identity)) fresh.push(said)
  }
  return fresh
}

/** The shortest side a prefix match may rest on: a truncated paste, never a guess. */
const PROMPT_PREFIX_MIN = 512

/**
 * Does a user node's text carry the prompt we sent? The SAME rule the host
 * applies to a posted turn (chatgpt-peer/threads.ts promptMatches).
 *
 * Equal after whitespace normalization, or one side a strict prefix of the
 * other with the shorter side at least PROMPT_PREFIX_MIN chars - a page that
 * trims or truncates a long body. A mid-string substring is never a match: that
 * would name a node that merely quotes us (the host's comment says exactly this,
 * and there is no "contains" clause there either).
 */
function promptMatches(sentText, seenText) {
  const sent = normalizedTurnText(sentText)
  const seen = normalizedTurnText(seenText)
  if (!sent || !seen) return false
  if (sent === seen) return true
  const shorter = sent.length <= seen.length ? sent : seen
  if (shorter.length < PROMPT_PREFIX_MIN) return false
  return (shorter === sent ? seen : sent).startsWith(shorter)
}

/**
 * Did OUR send land? The one decision the primary and degraded paths share.
 *
 * The evidence must be THIS send and nothing else - exactly ONE new user node
 * (absent from the pre-send baseline), carrying what we sent under the host's
 * full-text rule. A shared 40-char opener is not identity, a node already
 * present can never be the new one, and an unreadable or empty node proves
 * nothing.
 *
 * Two new nodes (ours plus an unrelated one in the same window) are AMBIGUOUS
 * and are refused here on purpose: this path cannot tell which one the host
 * will call ours, and a wrong "it landed" is worse than no answer. It cannot
 * strand the turn, because the host settles such a turn by node identity and
 * text on its own observation pass, outside this send-acceptance question.
 */
function sendAcceptVerdict({ newNodes, sentText }) {
  if (!Array.isArray(newNodes)) return false
  if (newNodes.length !== 1) return false
  return promptMatches(sentText, newNodes[0])
}

/**
 * The degraded path: only runs when the DOM exposed no user nodes at all, then
 * asks the same question as the primary path.
 */
function degradedSendVerdict({ userNodes, newNodes, sentText }) {
  // A page that shows user nodes is decided by the DOM path, never here.
  if (Number(userNodes) > 0) return false
  return sendAcceptVerdict({ newNodes, sentText })
}

/**
 * Snapshot this page's user nodes from its thread tree, or null when unread.
 *
 * Taken BEFORE the send: the identities already there are what a later read is
 * compared against. A page still on the new-chat route has no thread and so no
 * history - an empty set, not an unreadable one.
 *
 * The read is bounded at `TREE_BASELINE_TIMEOUT_MS` rather than 15 s: the host
 * hands the driver no pre-send baseline, so this read cannot be skipped or
 * reused on a thread. A timeout yields `null` (unreadable), which makes this
 * turn settle as `ambiguous` instead of letting the tree accept a stale-DOM
 * send - a slower-but-safe answer, never a wrong one.
 */
async function readUserTreeOnPage(page, onRead = null) {
  // `onRead` is measurement only: it reports how long THIS read took, its status
  // and whether a retry was spent (the baseline path has none). The value
  // returned to the caller is identical with or without it.
  const startedAt = Date.now()
  const report = (value, status, how = null) => {
    onRead?.({ status, ms: Date.now() - startedAt, retry: false, how })
    return value
  }
  const threadId = threadOf(page.url())
  if (!threadId) return report(new Map(), 'new-chat', 'no-thread')
  const read = await readUserNodesOn(page, `/backend-api/conversation/${threadId}`, TREE_BASELINE_TIMEOUT_MS).catch(() => null)
  if (!read?.ok) {
    const status = read?.reason === 'timeout' ? 'timeout' : `error${read?.status ? `-${read.status}` : ''}`
    return report(null, status, read?.how ?? null)
  }
  return report(userTreeNodes(read.body), 'ok', read.how)
}

const SEND_READY_TIMEOUT_MS = Number(process.env.CHATGPT_SEND_READY_MS || 10 * 60_000)
/** How long one acceptance window watches the page before its evidence is judged. */
const ACCEPTANCE_TIMEOUT_MS = Number(process.env.CHATGPT_ACCEPTANCE_MS || 30_000)

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
        // A wedged page is not a ready page: report it as not-ready, so the
        // caller keeps the turn queued instead of claiming it cannot be sent.
        const busy = await sampleWithin(page, 8_000, 'busy').catch(() => null)
        if (!busy) return { ready: false, send: null, reason: 'the page stopped answering' }
        const uploading = await page.evaluate(() => !!document.querySelector('[role="progressbar"]')).catch(() => false)
        if (!busy.busy && !uploading) return { ready: true, send }
        reason = 'an upload or a running turn is still in progress'
      } else reason = 'the send button is disabled (attachment still uploading)'
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return { ready: false, send: null, reason }
}

/**
 * Wait for the newest answer to settle.
 *
 * The guard is unchanged: `ANSWER_AGREE_SAMPLES` agreeing non-empty samples,
 * no stop control and no streaming state, 900 ms apart. The accepted send
 * POST's own stream end buys a second, cheaper path: once its body has
 * finished, the sample the guard already holds is the reference and one
 * confirming read a short settle later is enough, because a finished stream
 * cannot be a thinking pause. The bar is not lowered - the confirming read must
 * be non-empty, be the same text and not be busy - and any other outcome puts
 * the turn back on the 900 ms guard for the rest of its life. A failed stream
 * is teardown information only: it never shortens an interval the guard was
 * already serving.
 */
/**
 * A reply sample that cannot outlive its own interval.
 *
 * The guard samples on a timer; a read the renderer never answers used to hang
 * the loop (and, with a shared connection, every other op in the child) until
 * the host gave up a minute later. A missed bound is a wedged connection, not a
 * slow page: the connection is dropped and the turn is reported as a page fault
 * so the host recycles the window instead of waiting out the whole budget.
 */
async function sampleWithin(page, ms, kind) {
  const expired = Symbol('expired')
  let timer
  try {
    const value = await Promise.race([
      (kind === 'busy' ? busyState(page) : sampleTurn(page)).catch(() => null),
      new Promise(resolve => { timer = setTimeout(() => resolve(expired), ms) }),
    ])
    if (value !== expired) return value
  } finally {
    clearTimeout(timer)
  }
  dropOwned(`a ${kind} read did not answer within ${ms} ms`)
  throw new TurnError(`the page stopped answering during the reply (a ${kind} read missed ${ms} ms)`, { reason: 'page-load-error' })
}

async function waitForReply(page, beforeCount, beforeText = '', watch = null, sentText = '') {
  const startedAt = Date.now()
  const deadline = startedAt + SEND_TIMEOUT_MS
  let last = ''
  let agree = 0
  // The load-error banner: when it first appeared, and when we last looked.
  let loadSeenAt = null
  let loadProbeAt = 0
  let stableSince = null
  // The completion signal, when the caller has one. Absent, unavailable or
  // failed, every branch below is exactly the loop it was before.
  const signal = typeof watch?.completion?.then === 'function' ? watch.completion : null
  let completion = null
  let completionKnown = false
  // One attempt at the shorter path per turn, ever. A stream end that does not
  // produce a calm confirming sample is not retried at the shorter cadence.
  let shortened = false
  // When the confirming read returned, on the stream-end origin. The guard's
  // own sample is the reference, so this is the only stamp the shortener adds.
  let firstStableAt = null
  // Whether `last` came from a sample that was actually a reply (`got`), not
  // from a stale element that was already on the page before the send.
  let lastIsReply = false
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const settled = signal
    ? signal.then(
      value => { completion = value; completionKnown = true; return value },
      () => { completion = null; completionKnown = true; return null },
    )
    : null
  // The source's own completion patch, when the caller has one. It buys a
  // bounded confirm rather than an immediate delivery: live T2 read 877 chars
  // at the marker and the final 974 thirty-one milliseconds later, so the
  // source can lead the paint. Absent, unavailable or null, the two paths below
  // are exactly what they were.
  const markerSignal = typeof watch?.marker?.then === 'function' ? watch.marker : null
  let marker = null
  let markerKnown = false
  // One attempt per turn: a marker whose confirm does not settle is not retried
  // at the shorter cadence, it hands the turn back to the guard.
  let markerTried = false
  let markerArrivedAt = null
  let markerDeliveredAt = null
  let markerSamples = 0
  let markerSettleMs = 0
  let markerEntryLag = 0
  // The answer text the tap holds, when it can be attributed to the same message
  // the completion patch named. Null means "no claim": the DOM equality rule is
  // then exactly what it was.
  const answerTail = () => {
    if (typeof watch?.answerText !== 'function') return null
    let state = null
    try { state = watch.answerText() } catch { return null }
    if (!state || !state.text) return null
    if (!marker?.messageId || state.id !== marker.messageId) return null
    return tailSuffix(state.text)
  }
  const markerSettled = markerSignal
    ? markerSignal.then(
      value => { marker = value; markerKnown = true; return value },
      () => { marker = null; markerKnown = true; return null },
    )
    : null
  // Only a finished body counts: `loadingFinished`, or the page's own client
  // cancellation of its SSE reader. A transport fault, a supersession (`null`)
  // and a stop all land in `completion` without `at`, and are not evidence of an
  // end. The trade this accepts: a turn the user stops early also ends in a
  // cancel, so its partial answer is shortened by ~2.5 s as well. The guard
  // returns that same partial answer 2.5 s later - a stopped turn is stable and
  // not busy - so this changes when the partial answer comes back, not what.
  const cleanEnd = () => (completion && typeof completion.at === 'number' ? completion : null)
  const sleepOrCompletion = async ms => {
    // Only a signal this loop has not seen yet may cut the interval short. Once
    // a signal is known, the interval is the guard's again, exactly as before.
    const fresh = []
    if (settled && !completionKnown) fresh.push(settled)
    if (markerSettled && !markerKnown) fresh.push(markerSettled)
    if (!fresh.length) return sleep(ms)
    const at = Date.now()
    await Promise.race([sleep(ms), ...fresh])
    const rest = ms - (Date.now() - at)
    if (rest <= 0) return
    // A clean stream end or a live marker may end the interval early: both are
    // reads this loop wants now. Anything else - a failed/superseded/stopped
    // watch - says "the observer is done", not "the answer is in", so the
    // guard's own interval is still served in full.
    if (completionKnown && cleanEnd()) return
    if (markerKnown && marker && typeof marker.at === 'number') return
    await sleep(rest)
  }
  const refuseProblems = async () => {
    const body = await page.evaluate(() => (document.body?.innerText || '').slice(-4000)).catch(() => '')
    if (/something went wrong|you've reached (your )?limit|unusual activity|verify you are human/i.test(body)) {
      throw new Error('ChatGPT reported a problem: ' + body.slice(-600))
    }
  }
  const finish = async (how, reply) => {
    const elapsed = Date.now() - startedAt
    const stableFor = stableSince === null ? 0 : Date.now() - stableSince
    // The guard's verdict line is unchanged: one line, the same fields the
    // existing reader parses. The shortener adds its OWN line rather than
    // widening this one, so the two stamps (first stable, stream end) are each
    // readable by the `^<ISO> (kind) in <ms>ms` split and neither is a column
    // appended to a line that already had a meaning.
    await log(`reply in ${elapsed}ms: text stable for ${stableFor}ms, ${agree} agreeing samples`)
    if (how === 'stream') {
      await log(`reply stream: ended at ${completion.at - startedAt}ms (${completion.end}), first stable sample at ${firstStableAt - startedAt}ms (shortener)`)
    }
    if (how === 'server') {
      await log(`reply server: the page did not paint the answer; read ${reply.length} chars from the conversation API`)
    }
    if (how === 'marker') {
      const named = marker.messageId ? ` (message ${marker.messageId})` : ''
      // The corroborating marker usually arrives in the same batch but after
      // the patch frame, so a null here means "not yet seen", not "absent".
      const corroborated = marker.lastTokenAt ? `, last_token at ${marker.lastTokenAt - startedAt}ms` : ''
      await log(`reply marker: /message/status finished at ${markerArrivedAt - startedAt}ms${named}, entered +${markerEntryLag}ms, confirm settled at ${markerDeliveredAt - startedAt}ms after ${markerSamples} samples (${markerSettleMs}ms), delivered ${reply.length} chars${corroborated}`)
      // Counterfactual for the same turn, stated for exactly one path: the
      // 3 x 900 ms guard, projected from the same stable read. The existing
      // stream-end shortener is a different (usually earlier) counterfactual
      // and is measured from the stream end, not from here. A LOWER BOUND, not
      // a prediction: a guard sample taken while the stop control is still
      // visible resets agreement, and the page's busy flag has been measured
      // clearing up to 1.4 s after the patch, so the guard can lose one or two
      // 900 ms steps that this arithmetic does not charge it.
      const guardAt = stableSince === null ? null : stableSince - startedAt + (ANSWER_AGREE_SAMPLES - 1) * 900
      await log(`reply marker: guard (3 x 900ms from the same stable read) would have said at least ~${guardAt === null ? 'unknown' : `${guardAt}ms`} (lower bound; busy can reset a cadence step)`)
    }
    return { reply }
  }
  // The bounded confirm after the source's marker. Two consecutive equal
  // non-empty samples inside MARKER_CONFIRM_MS deliver; the cap falling first
  // is the DOM not having caught up, and the turn goes back to the guard.
  const confirmAfterMarker = async () => {
    // The window starts when the loop can actually look, not when the frame
    // landed: a big table sample can hold the loop past the marker's own 400 ms
    // (live 2026-11-01, shape 4: the confirm arrived with the window already
    // spent and took 0 samples). The entry lag is logged, so a late entry is
    // visible rather than hidden.
    const enteredAt = Date.now()
    const entryLag = enteredAt - markerArrivedAt
    markerEntryLag = entryLag
    const capAt = enteredAt + MARKER_CONFIRM_MS
    let previous = ''
    let previousAt = 0
    let samples = 0
    const trace = []
    const firstReadAt = enteredAt + MARKER_SETTLE_MS
    while (Date.now() <= capAt) {
      // Spend the render budget before the first read: the source leads the
      // paint, and a pair taken before the paint lands would agree on the
      // short text.
      const wait = firstReadAt - Date.now()
      if (wait > 0) await sleep(Math.min(wait, capAt - Date.now()))
      if (Date.now() > capAt) break
      const snapshot = await sampleWithin(page, 12_000, 'turn')
      const at = Date.now()
      samples += 1
      const busy = await sampleWithin(page, 8_000, 'busy')
      const got = Boolean(snapshot?.found && snapshot.text) && (snapshot.candidates > beforeCount || snapshot.text !== beforeText)
      // The payload tail check. Equality alone cannot tell a finished answer
      // from a stable prefix of one: live 2026-11-01 a 37-char prefix held for
      // 423 ms while the source had the full 253 chars. When the tap can name
      // the answer's text, its last words must already be in this read.
      const suffix = answerTail()
      const closed = suffix === null ? null : got ? normalizeAnswerText(snapshot.text).includes(suffix) : false
      if (trace.length < 12) trace.push(`${at - enteredAt}ms:${got ? (snapshot.text.length ?? 0) : 'none'}${busy.busy ? '+busy' : ''}${suffix === null ? '+no-tail' : closed ? '+tail' : '+tail-miss'}`)
      // The busy flag is deliberately NOT a condition here. It is the page's
      // streaming/thinking marker and it LAGS the source: live 2026-11-01 the
      // answer was already final (418 chars, unchanged) at +215/+277/+340/+402 ms
      // while the page still reported busy at every one of those reads. The
      // source's patch is the stronger statement; requiring the lagging DOM flag
      // as well makes the path unreachable. It is logged, never gating.
      if (got && previous && snapshot.text === previous && (suffix === null || closed)) {
        agree = 2
        stableSince = previousAt
        markerDeliveredAt = at
        markerSamples = samples
        markerSettleMs = at - previousAt
        await refuseProblems()
        return await finish('marker', snapshot.text)
      }
      previous = got ? snapshot.text : ''
      previousAt = at
      const left = capAt - Date.now()
      if (left <= 0) break
      await sleep(Math.min(MARKER_SAMPLE_MS, left))
    }
    const named = marker.messageId ? ` (message ${marker.messageId})` : ''
    await log(`reply marker: /message/status finished at ${markerArrivedAt - startedAt}ms${named}, entered +${entryLag}ms, confirm did not settle within ${MARKER_CONFIRM_MS}ms (${samples} samples: ${trace.join(', ')}); falling back to the guard`)
    // The stream is over and the DOM will not confirm it - the render fault.
    // Ask the server now instead of spending the rest of the reply budget on a
    // page that is not drawing: the answer is already in the conversation.
    const recovered = sentText ? await readServerReply(page, threadOf(page.url()), sentText) : ''
    if (recovered) return await finish('server', recovered)
    return null
  }
  while (Date.now() < deadline) {
    // The source says the turn is over. Confirm the DOM once, bounded, and
    // deliver as soon as it settles.
    if (!markerTried && markerKnown && marker && typeof marker.at === 'number') {
      markerTried = true
      markerArrivedAt = marker.at
      const delivered = await confirmAfterMarker()
      if (delivered) return delivered
    }
    // A clean end with a reply already on the page buys exactly one confirming
    // read, taken after the settle. The sample the guard already holds is the
    // reference - no fresh read is taken at the stream end, so the whole turn
    // costs two reads: the guard's own and this one. The window between them is
    // at least the settle, so this is a stronger stability claim than 200 ms,
    // not a weaker one.
    if (!shortened && lastIsReply && last && cleanEnd()) {
      shortened = true
      await sleep(STREAM_SETTLE_MS)
      const again = await sampleWithin(page, 12_000, 'turn')
      // The stamp is the moment the confirming read returned, on the same
      // origin as the stream end, so a later reader can recover the settle the
      // shortener actually saved.
      firstStableAt = Date.now()
      const calm = await sampleWithin(page, 8_000, 'busy')
      if (again?.found && again.text && again.text === last && !calm.busy) {
        agree = 2
        await refuseProblems()
        return await finish('stream', again.text)
      }
      // The stream ended without a calm, unchanged sample. That ends the
      // shorter path for this turn: every later wait is the guard's 900 ms.
      last = again?.text ?? ''
      lastIsReply = false
      agree = 0
      stableSince = null
      await sleep(900)
      continue
    }
    // The ANSWER node by structure, never the last assistant-message element:
    // that one is the reasoning-status header while the turn is thinking.
    const snapshot = await sampleWithin(page, 12_000, 'turn')
    if (!snapshot) { await sleepOrCompletion(500); continue }
    const busy = await sampleWithin(page, 8_000, 'busy')
    if (!snapshot.found || !snapshot.text) {
      // While there is no answer, ask whether the window is broken rather than
      // slow. A banner that persists is a window fault: the host recycles the
      // lane and re-posts, instead of waiting out the whole send budget.
      const atNow = Date.now()
      if (atNow - loadProbeAt >= LOAD_PROBE_MS) {
        loadProbeAt = atNow
        const problem = await pageLoadProblem(page)
        if (problem === 'load') loadSeenAt ??= atNow
        else loadSeenAt = null
        if (loadSeenAt !== null && atNow - loadSeenAt >= LOAD_CONFIRM_MS) {
          const threadId = threadOf(page.url())
          throw new TurnError(
            `the page could not load the messages${threadId ? ` in thread ${threadId}` : ''}`,
            { reason: 'page-load-error', ...(threadId ? { threadId } : {}) },
          )
        }
      }
      last = ''
      lastIsReply = false
      agree = 0
      stableSince = null
      await sleepOrCompletion(400)
      continue
    }
    // A new node is the usual shape, but ChatGPT also re-renders an existing
    // node in place (and a resumed thread can hydrate late, so the count taken
    // before sending is not reliable). Either a new node or changed text is a
    // reply; waiting only for the count hangs a finished answer forever.
    const got = snapshot.candidates > beforeCount || snapshot.text !== beforeText
    if (got && snapshot.text === last && !busy.busy) {
      agree++
      // Three agreeing samples, with no stop control and no streaming state
      // anywhere. One stable sample is not enough: a thinking pause looks
      // exactly like a finished turn for a second at a time - which is why the
      // interval is 900 ms while the answer can still be arriving.
      if (agree >= ANSWER_AGREE_SAMPLES) {
        await refuseProblems()
        return await finish('guard', snapshot.text)
      }
    } else {
      agree = got ? 1 : 0
    }
    if (got) { if (stableSince === null || snapshot.text !== last) stableSince = Date.now() } else stableSince = null
    last = snapshot.text
    lastIsReply = got
    // A clean end has already been seen with this reply on the page: go
    // straight to the confirming read, whose settle is the wait.
    if (cleanEnd() && got && !shortened) continue
    await sleepOrCompletion(900)
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
 * How long the shortener waits between its reference read and its confirming
 * read once the accepted send POST's body has ended.
 *
 * The 900 ms interval exists for one reason: a thinking pause looks exactly like
 * a finished turn for about a second. A finished body cannot be a thinking
 * pause, so after the accepted request's body ends - `loadingFinished`, or the
 * page's own cancellation - the guard's last sample plus one confirming read a
 * beat later are enough. The
 * evidence rule is not lowered (non-empty, unchanged and not busy), only the
 * wait is. The settle is real, not zero: the DOM can lag the transport by a
 * render. Bounded to 150-250 ms.
 */
const STREAM_SETTLE_MS = 200

/**
 * How long the marker path confirms the DOM once the loop can look at it (the
 * entry lag is logged; a slow sample can hold the loop past the frame). The
 * source can lead the paint: live T2 read 877 chars at the marker and 974
 * (final) 31 ms later. Two consecutive equal non-empty samples inside the
 * window deliver; the cap falling first means the DOM has not caught up, and
 * the turn falls back to the guard unchanged rather than being delivered on a
 * truncated read.
 */
const MARKER_CONFIRM_MS = 400

/** Sampling interval inside the marker confirm window. */
const MARKER_SAMPLE_MS = 50

/**
 * How long a "could not load messages" banner must persist before the turn is
 * handed back as a window fault. A transient render hiccup is not a fault; five
 * seconds of a textless page with the banner visible is.
 */
const LOAD_CONFIRM_MS = 5_000
/** How often the reply guard re-checks for that banner while no answer is up. */
const LOAD_PROBE_MS = 2_000

/**
 * The banner test, one bounded look. Same pattern and same guard as the
 * observer: only when no answer bubble has text.
 */
const pageLoadProblem = page => page.evaluate(() => {
  const bubbles = document.querySelectorAll('[data-markdown-text-style="assistant-message"]')
  const newest = bubbles[bubbles.length - 1]
  if (newest && (newest.textContent || '').trim()) return null
  const body = (document.body && document.body.innerText || '').slice(0, 20000)
  return /(couldn'?t load (the )?messages|could not load messages|unable to load (the )?(messages|conversation)|error loading (the )?(messages|conversation)|there was a problem loading (the )?(messages|conversation))/i.test(body) ? 'load' : null
}).catch(() => null)

/**
 * How long after the marker the first confirming read is taken. The source
 * leads the paint: live T2 read 877 chars at the marker and the final 974 at
 * +112 ms (a render of ~150 ms). Two equal reads taken at 50 ms spacing from
 * the marker itself would both land inside that lag and deliver the short
 * text, so the pair is taken only after one render budget has passed. The cap
 * is unchanged; this spends 200 of its 400 ms on the lag it is there to cover.
 */
const MARKER_SETTLE_MS = 200

/**
 * How long `Network.streamResourceContent` is retried after the response
 * header. It fails while the body has not started, so the first call is
 * normally too early; the retry is cheap and never blocks the send path.
 */
const MARKER_TAP_RETRY_MS = 120

/** When to give up on starting the tap for this turn. */
const MARKER_TAP_DEADLINE_MS = 5000

/**
 * The payload tail check: how many whole words of the answer's own stream text
 * must be present in the DOM read before the marker path may deliver.
 *
 * Live 2026-11-01, 12:57 turn: the source had all 253 chars of the answer before
 * the patch, the DOM showed a stable 37-char prefix 266 ms after it, and the
 * marker path delivered 37 of 253. Equality alone cannot see that: the prefix
 * was unchanged between two probes. The last 8 words of the payload were not in
 * the DOM read, would not be until the paint landed 423 ms after the patch, and
 * that is the check this constant sets. Below TAIL_MIN_WORDS the answer is too
 * short to make a claim, and the check is unavailable rather than wrong.
 */
const TAIL_WORDS = 8
const TAIL_MIN_WORDS = 3

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
    const busy = await sampleWithin(page, 8_000, 'busy')
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

// The two bounds attachFile() relies on, named once: the setInputFiles transfer
// (a large buffer crosses CDP, so not a 30 s job) and the chip-poll wait. Their
// sum is the per-file allowance a send spends OUTSIDE its op deadline, so the
// ready frame advertises it as `sendAttachCreditMs` - the host budgets the same
// amount instead of being told to remember a prose instruction.
const ATTACH_INPUT_TIMEOUT_MS = Number(process.env.CHATGPT_ATTACH_INPUT_MS || 180_000)
const ATTACH_CHIP_TIMEOUT_MS = Number(process.env.CHATGPT_ATTACH_CHIP_MS || 120_000)
const SEND_ATTACH_CREDIT_MS = ATTACH_INPUT_TIMEOUT_MS + ATTACH_CHIP_TIMEOUT_MS

/**
 * Put a file into the composer through the page's own uploader.
 *
 * The bytes go to Playwright's setInputFiles - never to a path, never to disk.
 * ChatGPT does the uploading and owns the limits; its refusal is reported as a
 * refusal rather than guessed at. A file that silently does not attach is the
 * worst outcome, so this throws naming the selector it tried.
 */
async function attachFile(page, { name, mimeType, buffer, timeoutMs = ATTACH_CHIP_TIMEOUT_MS }) {
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
    await input.setInputFiles({ name, mimeType, buffer }, { timeout: ATTACH_INPUT_TIMEOUT_MS }).catch(error => { uploadError = error })
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

// Only the document loads the page itself aborted or dropped. A challenge page,
// a logged-out page or a deleted thread is a real answer and must not be retried.
const TRANSIENT_NAVIGATION = /net::ERR_ABORTED|net::ERR_FAILED|net::ERR_CONNECTION_RESET|net::ERR_TIMED_OUT|Timeout \d+ms exceeded/i
const NAV_ATTEMPTS = 3 // the first try plus two retries
const NAV_RETRY_DELAY_MS = 500
// An explicit per-attempt bound: `goto` otherwise carries Playwright's 30 s
// default, and retrying that three times would stall a dead navigation for 90 s.
// Live gotos land in 3-5 s, so 20 s is generous; the ceiling is 60 s plus two
// 500 ms delays, and a timeout is itself transient (it is retried).
const NAV_TIMEOUT_MS = 20_000

/**
 * The ONE deadline for a send op, chosen from evidence instead of added up from
 * the per-phase bounds above.
 *
 * Each bound above says how long a phase may spend; none of them describes a
 * healthy send, and several exist only to survive an upload or a live turn (the
 * send-ready wait above all: 600 s). Summed, they came to 1 043 000 ms before the
 * reply wait - 83 s LONGER than the host's 20 min turn timeout - so a sum could
 * never shorten a lost-reply block. What was missing was a bound on the
 * OPERATION.
 *
 * Evidence for the number:
 *   - a legitimate send has reached acceptance in 4.2-4.9 s live (2026-11-01,
 *     thread 6adfe3f4, default click path);
 *   - the one recovery path (a reload of the same thread plus its sign-in and
 *     composer waits) needs about 2 min.
 * 180 s leaves that recovery path 60 s of headroom and is ~40x a normal send. An
 * op that has not reached acceptance by then is not going to, and it is answered
 * with a defined shape instead of being left to the host's timeout.
 *
 * The op is enforced by railing each blocking await against the deadline (see
 * `railed`). Expiry before the click is `not-posted` (nothing was sent, so the
 * turn can be retried); expiry after the click is `ambiguous` (the send may have
 * landed, and nothing is ever clicked again).
 *
 * Attachments are deliberately OUTSIDE this deadline: `attachFile` can spend
 * 180 s on the file input plus a 120 s chip poll PER FILE, and the number of
 * files is the caller's. The child pauses the acceptance budget while files
 * attach, and the host must add PER FILE: 300 000 ms (180 s input + 120 s chip
 * poll). Everything else on the path is inside.
 *
 * The reply wait keeps its own SEND_TIMEOUT_MS clock, started only once the turn
 * was accepted, so the op's total is acceptance + reply + the post-reply reads.
 * The two post-reply reads (the page state and the model/effort picker) are
 * best-effort enrichment: each is bounded by SEND_TAIL_MS, and an expiry returns
 * the reply with `model: null` rather than withholding it.
 *
 * SEND_READY_TIMEOUT_MS (600 s) is therefore no longer reachable on its own - the
 * op deadline preempts it. It stays as the per-step bound; 10 min for a send
 * button to become ready is its own concern and is tracked separately.
 *
 * SEND_CEILING_MS = 180 000 (acceptance) + 240 000 (reply) + 2*15 000 (tails)
 *                 = 450 000 ms = 7.5 min, under the host's 20 min and under 8.
 */
const SEND_ACCEPT_DEADLINE_MS = 180_000
const SEND_TAIL_MS = 15_000
const SEND_CEILING_MS = SEND_ACCEPT_DEADLINE_MS + SEND_TIMEOUT_MS + 2 * SEND_TAIL_MS

/** Expiry before the click: nothing was sent, so the turn can be queued again. */
const sendDeadlineNotPosted = () => new TurnError(
  'not-posted: the send deadline passed before the Send click; nothing was sent, so the turn can be retried',
  { reason: 'not-posted' },
)
/** Expiry after the click: the send may have landed, and it is never repeated. */
const sendDeadlineAmbiguous = () => new TurnError(
  'the send may have landed: the send deadline passed before the page proved acceptance; nothing was clicked again - watch the thread for it rather than re-sending',
  { reason: 'ambiguous' },
)

/**
 * Rail ONE blocking await against an absolute operation deadline.
 *
 * This is how SEND_ACCEPT_DEADLINE_MS is enforced: every await that can block is
 * raced against the time that is left, so the op unwinds with `onExpire()` when
 * the deadline passes. It is deliberately PER-AWAIT and not a second race around
 * the whole op: a race around the op would let `ask` keep running after its reply
 * went out, and `onAccepted` (which emits a frame) is called after `submitTurn`
 * resolves - a late `accepted` frame for an id that already answered would break
 * the one-reply-per-id invariant.
 *
 * The abandoned promise is not cancelled - these are Playwright calls - so it may
 * finish later with no listener. Nothing it does can emit: the only call that
 * emits a frame sits after `await submitTurn(...)`, and the unwind skips it.
 */
function railed(promise, deadline, onExpire) {
  const left = deadline - Date.now()
  if (left <= 0) {
    Promise.resolve(promise).catch(() => {})
    return Promise.reject(onExpire())
  }
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(onExpire()), left)
      timer.unref?.()
    }),
  ]).finally(() => clearTimeout(timer))
}

/** The same rail, where an EXPIRY has a harmless answer instead of failing the
 * op. A rejection of the promise itself is not an expiry and still propagates. */
const DEADLINE_EXPIRED = Symbol('send deadline expired')
async function railOr(promise, deadline, fallback) {
  try {
    return await railed(promise, deadline, () => DEADLINE_EXPIRED)
  } catch (error) {
    if (error === DEADLINE_EXPIRED) return fallback
    throw error
  }
}

/**
 * Load a thread, tolerating a transient navigation abort.
 *
 * Live 2026-10-31 18:15:46Z: a turn to a just-primed thread died with
 * `goto: net::ERR_ABORTED` on a page that was healthy before and after, with
 * every driver op serialized on `chain` - the page aborted its own document
 * load. Nothing has been typed at that point, so trying the load again cannot
 * duplicate a message. That is why this helper is used ONLY for pre-post
 * navigation (the `ask` switch, `reload`, `use`) and never once the composer or
 * the Send button has been touched: the one-Send-click invariant stands.
 *
 * Two retries, `NAV_RETRY_DELAY_MS` apart, and only for the transient errors
 * above, each attempt bounded by `NAV_TIMEOUT_MS`. Any other failure is thrown
 * at once. Every failure is a `not-posted` TurnError, because nothing has been
 * typed at any point this helper may be called: a navigation that never landed
 * must leave the turn queued, never be reported to the sender as a terminal
 * failure. When the target names a thread, the landed URL must name the same
 * thread; anything else (a redirect, a deleted thread) fails with the usual
 * "landed on X instead of Y" wording. `onRetry(ms)` receives the elapsed time of
 * the attempt that failed, for the phase log.
 */
async function gotoThread(page, url, { reload = false, onRetry = null } = {}) {
  const wanted = threadOf(reload ? page.url() : url)
  const destination = reload ? (wanted ? `thread ${wanted}` : 'the page') : url
  const notPosted = why => new TurnError(`not-posted: ${why}; nothing was typed, so nothing was sent`, { reason: 'not-posted' })
  for (let attempt = 1; attempt <= NAV_ATTEMPTS; attempt++) {
    const startedAt = Date.now()
    try {
      if (reload) await page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
      else await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
      if (wanted) {
        const landed = threadOf(page.url())
        if (!landed || landed.toLowerCase() !== String(wanted).toLowerCase()) {
          throw notPosted(`the page landed on ${landed ?? 'no thread'} instead of the requested thread ${wanted}`)
        }
      }
      return
    } catch (error) {
      if (error?.reason === 'not-posted') throw error
      const why = `the page could not load ${destination} (${String(error?.message ?? error).split('\n')[0]})`
      if (!TRANSIENT_NAVIGATION.test(String(error?.message ?? error))) throw notPosted(why)
      if (attempt === NAV_ATTEMPTS) throw notPosted(why)
      if (onRetry) await onRetry(Date.now() - startedAt)
      await new Promise(resolve => setTimeout(resolve, NAV_RETRY_DELAY_MS))
    }
  }
}

/**
 * One bounded recovery for a composer that never rendered.
 *
 * Live 2026-10-31 (tor-fresh, turns 0dd2dfb6 and 51dd277a): a load-error render
 * left the thread page without an input and the turn was declared dead on an
 * unhealthy DOM that a reload fixes. A reload is a NAVIGATION, not a click, and
 * the page never had a composer, so nothing could have been typed into it: this
 * is as safe as the pre-post goto retry. It runs at most once per send attempt
 * (the caller calls it once), only when the tab is already on the requested
 * page, and NEVER while the page reports a live turn - a pondering page is never
 * interrupted, and a reload would abort its stream. Every refusal returns null
 * with the reason so the caller can report one outcome.
 */
async function recoverComposer(page, { newChat = false, threadId = null } = {}) {
  const live = page.url()
  const liveThread = threadOf(live)
  const onTarget = newChat
    ? !liveThread && isChatGPTUrl(live)
    : Boolean(threadId) && String(liveThread || '').toLowerCase() === String(threadId).toLowerCase()
  if (!onTarget) return { composer: null, why: 'the page is not on the requested thread', reloadMs: 0, waitMs: 0 }
  const busy = await sampleWithin(page, 8_000, 'busy').catch(() => null)
  if (!busy) return { composer: null, why: 'the page stopped answering, so it was not reloaded', reloadMs: 0, waitMs: 0 }
  if (busy.busy) return { composer: null, why: 'the page reports a live turn, so it was not reloaded', reloadMs: 0, waitMs: 0 }
  const reloadAt = Date.now()
  try {
    await gotoThread(page, live, { reload: true })
  } catch (error) {
    return { composer: null, why: `the reload failed: ${error.message}`, reloadMs: Date.now() - reloadAt, waitMs: 0 }
  }
  const reloadMs = Date.now() - reloadAt
  const composer = await waitForComposer(page, NAV_TIMEOUT_MS)
  return { composer, reloadMs, waitMs: Date.now() - reloadAt - reloadMs }
}

async function ask(page, text, { newChat = false, threadId = null, onAccepted = null, attachments = null, wait = true, acceptDeadlineMs = null, model = null, effort = null } = {}) {
  // The op clock starts at request arrival. `SEND_ACCEPT_DEADLINE_MS` bounds
  // everything up to the Send click, and attachment time is credited back to the
  // budget after the files attach (attachments are outside the ceiling). The
  // override exists so a proof can drive expiry without waiting minutes; the
  // shipped path never passes it.
  const opStartedAt = Date.now()
  const acceptBudgetMs = Number.isFinite(acceptDeadlineMs) && acceptDeadlineMs > 0 ? acceptDeadlineMs : SEND_ACCEPT_DEADLINE_MS
  let acceptDeadline = opStartedAt + acceptBudgetMs
  // Never type into a running turn. Live 2026-10-30: a message typed while a
  // turn was streaming was STEERED into that turn - the two tasks merged and
  // the original answer was lost. A stale signal says nothing about now, so
  // only a recent one refuses.
  const pushedNow = pushedOf(laneOf())
  if (pushedNow.phase === 'streaming' && pushedNow.at && Date.now() - pushedNow.at < 10 * 60_000) {
    throw new TurnError('not-posted: the page is mid-turn; your message was not typed, so nothing was sent', { reason: 'busy', state: 'generating', threadId: pushedNow.threadId })
  }
  // Measurement only: where does the wall-clock before the Send click go? Each
  // line wraps an operation that already runs - no extra page call, no extra
  // wait - and `phase <name> preclick` is emitted by submitTurn once the click
  // has happened. Nothing here reads the page on its own.
  const phaseT0 = Date.now()
  let phaseAt = phaseT0
  const phaseName = newChat ? 'newchat' : 'send'
  const phaseMark = async label => {
    const now = Date.now()
    await log(`phase ${phaseName} ${label} ${now - phaseAt}ms`)
    phaseAt = now
  }
  // A `goto` of the URL the tab is already on is not free: it throws the SPA
  // away and spends seconds re-rendering exactly the page that was there. The
  // live URL is the same signal the post-goto landing test requires, so skip
  // when it already names the request - the thread id for a thread, and "no
  // thread on chatgpt.com" for a new chat. The new-chat half rests on one
  // assumption: being in a conversation always puts /c/<id> in the URL, so a
  // chatgpt.com URL with no thread id has no conversation on screen.
  const liveThread = threadOf(page.url())
  const wantedThread = threadId ? String(threadId).toLowerCase() : null
  const alreadyThere = newChat
    ? !liveThread && isChatGPTUrl(page.url())
    : Boolean(wantedThread) && String(liveThread || '').toLowerCase() === wantedThread
  if (alreadyThere) {
    await phaseMark('goto')
    await phaseMark('login')
  } else if (newChat || wantedThread) {
    const target = threadId ? `https://chatgpt.com/c/${threadId}` : CHAT_URL
    await railed(gotoThread(page, target, { onRetry: elapsed => log(`phase ${phaseName} gotoRetry ${elapsed}ms`) }), acceptDeadline, sendDeadlineNotPosted)
    await phaseMark('goto')
    await railed(waitForLogin(page, LOGIN_WAIT_MS), acceptDeadline, sendDeadlineNotPosted).catch(error => {
      // Still pre-click: the page never showed a signed-in session, so nothing
      // was typed. Keep it queued rather than terminal.
      if (error?.reason) throw error
      throw new TurnError(`not-posted: ${error.message}; nothing was typed, so nothing was sent`, { reason: 'not-posted' })
    })
    await phaseMark('login')
    // A redirect or a deleted thread lands somewhere else, and posting into
    // whatever page happens to be open would put the message in another
    // conversation. The caller asked for a thread; require that thread.
    if (threadId) {
      const landed = threadOf(page.url())
      if (!landed || landed.toLowerCase() !== String(threadId).toLowerCase()) {
        throw new TurnError(`not-posted: the page landed on ${landed ?? 'no thread'} instead of the requested thread ${threadId}; nothing was typed, so nothing was sent`, { reason: 'not-posted' })
      }
    }
  }
  if (threadId) {
    // ChatGPT's web app intermittently serves a conversation shell that never
    // hydrates: the composer is there, the messages never arrive, and a send
    // into it goes nowhere (observed 2026-11-05: 0 message nodes, a 404 on the
    // conversation API for a thread that answered minutes earlier). One reload
    // first - that fixes a slow hydration - and if the thread is still empty,
    // continue in a new chat, which always renders, rather than typing into a
    // page that will silently swallow the turn.
    // Any rendered turn counts as a message. ChatGPT's 2026-11-05 UI dropped
    // `data-message-author-role`, which made every real thread read as empty
    // while the page was visibly rendering it; ANY_MESSAGE covers both the old
    // and the new vocabulary so the guard cannot mistake a fine page for a
    // dead one and throw the turn away.
    // Hydration is a race, not an instant: a conversation created a second ago
    // by this very writer still has its message mapping in flight, and a single
    // read taken right after the goto is zero on a thread that is about to
    // render fine (live 2026-11-05: a freshly primed thread was declared empty
    // and thrown away). Poll before believing zero.
    const messageCount = async (ms) => {
      const until = Date.now() + ms
      let seen = -1
      do {
        seen = await page.evaluate(selector => document.querySelectorAll(selector).length, ANY_MESSAGE).catch(() => -1)
        if (seen > 0) return seen
        if (Date.now() >= until) break
        await new Promise(resolve => setTimeout(resolve, 500))
      } while (Date.now() < until)
      return seen
    }
    if ((await messageCount(6_000)) <= 0) {
      // Zero rendered nodes alone does not mean a broken page: a conversation
      // the host just created (newBridge) is genuinely empty, and its first
      // message is exactly what this send is for. Ask the server which case
      // this is before throwing a good turn away.
      // 'unknown' is most often a 429 on the conversation read, which says
      // nothing about the thread. Re-ask before treating it as a page fault.
      let content = await threadContentState(page, threadId)
      // Retry any inconclusive answer, including a 429: a short burst clears,
      // and asking again costs one fetch while a wrong verdict costs a window.
      for (let attempt = 0; attempt < 2 && /^unknown/.test(content); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 2_000))
        content = await threadContentState(page, threadId)
      }
      if (content === 'missing') {
        await log(`thread ${threadId} is gone on the server; reporting it as unreadable`)
        throw new TurnError(`not-posted: thread ${threadId} is gone on the server, so nothing was typed and nothing was sent`, { reason: 'thread-unreadable' })
      }
      // An account state is not a page fault. Recycling the window on a 429
      // (observed live 2026-11-05: "would not render (server says unknown:429);
      // recycling the window", over and over) throws away a fine browser and
      // immediately posts again into the same limit, so the lane churns
      // windows while the account backs off.
      const status = /^unknown:(\d{3})$/.exec(content)?.[1]
      if (status === '429') {
        // A rate-limited READ says nothing about the WRITE: a brand-new thread
        // is legitimately empty (exactly what this guard exists to let
        // through) and can still post. Do not reload or recycle - fall through
        // and let the send decide; the send path reports a 429 as the account
        // limit, which is the honest answer.
        await log(`thread ${threadId} answered 429 on the conversation read; attempting the send, which decides`)
      } else if (status === '401' || status === '403') {
        await log(`thread ${threadId} answered ${status} on the conversation read; the session is not signed in`)
        throw new TurnError(`not-posted: the session is not signed in (the conversation read answers ${status}); nothing was typed`, { reason: 'signed-out', threadId })
      } else if (content === 'empty') {
        await log(`thread ${threadId} is new and empty; posting the first message into it`)
      } else {
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
        await railed(waitForLogin(page, LOGIN_WAIT_MS), acceptDeadline, sendDeadlineNotPosted).catch(() => {})
        if ((await messageCount(8_000)) <= 0) {
          // The server holds messages this page will not draw - the fault the
          // user sees as "can't load conversation". Measured 2026-11-05: that
          // shell often has no usable composer at all ("no composer appeared")
          // or refuses the text, so typing into it just fails slower. Recycle
          // the window and post on a fresh one; the host re-posts the queued
          // turn (never re-sends an accepted one).
          await log(`thread ${threadId} would not render (server says ${content}); recycling the window`)
          throw new TurnError(`not-posted: the page could not render thread ${threadId} (server says ${content}); nothing was typed, so nothing was sent`, { reason: 'page-load-error', threadId })
        }
      }
    }
  }
  // The thread-tree snapshot starts here, the moment the page has landed on the
  // requested thread. Nothing reaches the tree until the Send click, so typing
  // and the DOM reads below cannot invalidate it; the only ordering it owes is
  // "taken before the click", which the join after compose enforces.
  //
  // SIZE-DEPENDENT, NOT A FIXED COST. Measured live 2026-11-01: on an 802-node /
  // 4.9 MB thread this read was 2.7-3.3 s, 87-95% of it TTFB while the server
  // built and brotli-compressed the whole mapping, and 0.25-0.43 s of the rest
  // was our own return of that body across CDP (now avoided by extracting in the
  // page - the payload fell 4.66 MB to 0.49 MB). A small thread costs a fraction of this, so treat the number as a
  // property of thread size - it grows with the thread and a future thread can
  // be worse than any number written here. It runs under the composer wait, the
  // DOM baselines and the compose; the callback records the read itself (status,
  // ms, retry, path) so a slow read can be told apart from a cold connection
  // instead of guessed at.
  const readTree = () => readUserTreeOnPage(page, read => log(`tree baseline ${read.ms}ms status ${read.status} retry ${read.retry ? 'yes' : 'no'}`)).then(
    value => ({ value }),
    error => ({ error }),
  )
  let treeRead = readTree()
  let composer = await railed(waitForComposer(page, alreadyThere ? 10_000 : COMPOSER_WAIT_MS), acceptDeadline, sendDeadlineNotPosted)
  await phaseMark('composer')
  if (!composer) {
    // One bounded recovery: a load-error render can leave the thread without an
    // input, and a single reload of the SAME page brings it back. It never runs
    // while the page reports a live turn, and the labels make its cost
    // accountable instead of hiding it in `composer`.
    const recovered = await railed(recoverComposer(page, { newChat, threadId }), acceptDeadline, sendDeadlineNotPosted)
    await log(`phase ${phaseName} composer_recover ${recovered.reloadMs}ms`)
    if (recovered.why) await log(`composer recovery skipped: ${recovered.why}`)
    await log(`phase ${phaseName} composer_recover_after ${recovered.waitMs}ms`)
    composer = recovered.composer
    if (recovered.reloadMs) {
      // The recovery reload is a navigation: whatever the early tree read was
      // doing against the old document is void. Take the snapshot again on the
      // fresh page - still before anything is typed.
      treeRead = readTree()
    }
  }
  if (!composer) {
    // A lane's first paint of a thread can take tens of seconds under load, and
    // the recovery above is bounded tightly. One last patient wait costs nothing
    // when the page is dead (the accept deadline still governs) and saves the
    // turn when the composer is simply late.
    composer = await railOr(waitForComposer(page, 30_000), acceptDeadline, null).catch(() => null)
  }
  if (!composer) {
    const state = await railOr(pageState(page), acceptDeadline, null).catch(() => null)
    if (alreadyThere && !state?.loggedIn) {
      // A signed-out tab still gets the old sign-in diagnostic (and its wording)
      // instead of "no composer"; a signed-in tab that still has no composer
      // after the one reload is refused at once rather than after a login wait
      // that a session check has already answered.
      composer = await railOr(waitForLogin(page, LOGIN_WAIT_MS).then(() => waitForComposer(page)), acceptDeadline, null).catch(() => null)
    }
    if (!composer) {
      // Pre-click: the composer never existed, so nothing was typed. `not-posted:`
      // is the host's keep-queued token, matched on the message text
      // (chatgpt-peer.ts ~2274), so the turn stays queued once the page renders.
      throw new TurnError(`not-posted: no composer appeared on the page (url=${state?.url ?? page.url()}, loggedIn=${state?.loggedIn ?? 'unknown'}, challenge=${state?.challenge ?? 'unknown'}); nothing was typed, so nothing was sent - this turn can be posted once the page renders`, { reason: 'not-posted' })
    }
  }
  // Attach before typing: the chip lives beside the composer, and a later
  // navigation would discard it.
  let attachment = null
  const rejected = []
  // Attachments are OUTSIDE the op deadline, so the time they spend is credited
  // back to the budget once every file is in: `acceptDeadline` moves by exactly
  // the measured attach time. The host is not told this in prose - it reads the
  // per-file allowance off the ready frame as `sendAttachCreditMs`.
  const attachStartedAt = Date.now()
  for (const file of attachments ?? []) {
    // Still pre-click: an upload that never attached means nothing was typed.
    // Wrap it so the host keeps the turn queued instead of declaring it dead.
    const result = await attachFile(page, file).catch(error => {
      throw new TurnError(`not-posted: ${error.message}; nothing was typed, so nothing was sent`, { reason: 'not-posted' })
    })
    attachment = result
    if (result.state === 'rejected') rejected.push(result)
  }
  if ((attachments?.length ?? 0) > 0) acceptDeadline = opStartedAt + acceptBudgetMs + (Date.now() - attachStartedAt)
  // The note built by the host claims a document is in the thread. When the
  // page refuses the upload that premise is false, so replace this turn with
  // one short correction the model cannot mistake for a real attachment, and
  // only then fail the turn for the sender.
  if (rejected.length) {
    text = rejected
      .map(item => `ATTACHMENT REJECTED: ${item.name} — ${item.reason}. The previous note does not describe a file that exists; do not refer to it.`)
      .join('\n')
  }
  const baselineAt = Date.now()
  phaseAt = baselineAt
  const beforeCount = await railed(page.locator(ASSISTANT).count(), acceptDeadline, sendDeadlineNotPosted)
  const countAt = Date.now()
  // The acceptance proof is a NEW user node whose full text carries ours, so
  // the DOM's user turns (identity list) are snapshotted before the send.
  const beforeDom = await railed(readDomUserTurns(page), acceptDeadline, sendDeadlineNotPosted)
  const beforeUsers = beforeDom ? beforeDom.identities.length : 0
  const domAt = Date.now()
  // There is no last assistant node on a fresh chat, so there is nothing to
  // read: when the count taken for `baseline_count` is zero, skip the locator
  // outright instead of paying the 2 s bound for an element that cannot exist
  // (a flat ~2 s of every new-chat pre-click). An unbounded `innerText()` used
  // to wait Playwright's default 30 s here and `.catch('')` hid it - 30 of the
  // ~38 s before the Send click on every newBridge. A present node answers in
  // milliseconds, so 2 s cannot clip a real value, and `beforeCount > 0` keeps
  // that bounded read for a stale count whose node has gone ('' either way).
  const beforeText = beforeCount > 0
    ? await railOr(page.locator(ASSISTANT).last().innerText({ timeout: LAST_ASSISTANT_TEXT_TIMEOUT_MS }).then(text => text.trim()), acceptDeadline, '').catch(() => '')
    : ''
  const textAt = Date.now()
  await log(`phase ${phaseName} baseline_count ${countAt - baselineAt}ms`)
  await log(`phase ${phaseName} baseline_dom ${domAt - countAt}ms`)
  await log(`phase ${phaseName} baseline_lasttext ${textAt - domAt}ms`)
  await phaseMark('baselines')
  // Type the text EXACTLY once and verify it before pressing send. A rejected
  // fill that had already written the prompt must never be "repaired" by
  // inserting a second copy at the caret.
  // The composer is replaced by the app under a re-render, so a single pass can
  // read back partial text that the next render then clears. Three bounded
  // passes with a pause between them; each pass still writes at most one copy,
  // because every attempt starts from a proven-empty or proven-matching field.
  let composed = false
  // In a shared browser every lane is a tab in ONE window, and only one tab can
  // hold focus at a time. The token covers typing and the Send click, and is
  // released before the reply is awaited so turns still overlap. The one-window
  // driver passes straight through: the browser is its own.
  const releaseFocus = await acquireFocus()
  let submitted
  try {
    // The picker is ONE control for every tab in this browser. Selecting it
    // inside the focus lock is what keeps another lane from retargeting it
    // between the selection and the Send click below. A refusal here is a
    // configuration error, not a page fault: name it, and type nothing.
    if (model || effort) {
      const wantedLabel = [model, effort].filter(Boolean).join('/')
      try {
        const applied = await setModelState(page, { model, effort })
        await log(`phase ${phaseName} model ${applied?.model ?? model ?? '?'}/${applied?.effort ?? effort ?? '?'}`)
      } catch (error) {
        throw new TurnError(`the model picker would not select ${wantedLabel} (${String(error?.message ?? error).slice(0, 140)}); nothing was typed`, { reason: 'model-unavailable' })
      }
    }
    for (let attempt = 1; attempt <= 3 && !composed; attempt++) {
      // Keyboard input goes to the focused TAB. A shared lane's tab sits behind
      // the operator's, so without this every pass types into a page that will
      // not take the keystrokes and the turn is refused as "not-posted".
      await page.bringToFront().catch(() => {})
      composed = await railed(composeExactlyOnce(page, composer, text, (label, ms) => log(`phase ${phaseName}${attempt > 1 ? ` retry${attempt}` : ''} ${label} ${ms}ms`)), acceptDeadline, sendDeadlineNotPosted)
      if (!composed && attempt < 3) await new Promise(resolve => setTimeout(resolve, 1_000))
    }
    await phaseMark('compose')
    if (!composed) {
      // The `not-posted:` PREFIX is load-bearing, not decoration: the host decides
      // "keep this queued" from the MESSAGE TEXT, not from `reason` (chatgpt-peer.ts
      // ~2274, /mid-turn|not-posted|never left the composer|ambiguous/i), and it
      // never reads `reply.reason` on this path (~1538). Without the prefix a
      // bounded compose refusal becomes a terminal failure line to the sender.
      // The page's own visibility is the fact that separates "the app re-rendered"
      // from "Chrome treats this window as hidden and drops the keystrokes".
      const visibility = await page.evaluate(() => document.visibilityState).catch(() => 'unknown')
      // A rate-limited account leaves the composer inert: every insert is
      // swallowed and the turn is refused as a compose fault, which reads like a
      // driver bug. Name the real cause so nobody debugs the wrong layer.
      const limit = await page.evaluate(() => {
        const text = (document.body?.innerText || '').replace(/\s+/g, ' ')
        const match = /(you(?:'| a)?re? (?:hitting|reached) (?:the|your) [^.]{0,40}limit|usage limit|try again (?:later|in a few minutes)|rate limit)/i.exec(text)
        return match ? match[0].slice(0, 80) : null
      }).catch(() => null)
      // The banner is not always rendered; the backend status is the ground
      // truth, and a 429 there is exactly why the composer stays inert.
      const backendStatus = await page.evaluate(async () => {
        const match = /\/c\/([A-Za-z0-9-]{8,})/.exec(location.pathname)
        if (!match) return 0
        try {
          const sessionResponse = await fetch('/api/auth/session').catch(() => null)
          // The session read is the first thing a rate-limited backend refuses;
          // without this the probe sends no bearer, gets 404, and misses the
          // limit in exactly the window it exists for.
          if (sessionResponse && sessionResponse.status === 429) return 429
          const session = sessionResponse ? await sessionResponse.json().catch(() => null) : null
          // The conversation read needs the session bearer: without it the backend
          // answers 404 for every thread (measured 2026-11-06), so a 429 could never
          // be seen and a live thread could be called missing.
          const headers = session?.accessToken ? { authorization: `Bearer ${session.accessToken}` } : {}
          const response = await fetch(`/backend-api/conversation/${match[1]}`, { credentials: 'include', headers })
          return response.status
        } catch { return 0 }
      }).catch(() => 0)
      if (limit || backendStatus === 429) {
        const why = limit ?? 'the conversation backend answers 429'
        throw new TurnError(`not-posted: the account is rate limited (${why}); nothing was sent, so no reply is coming`, { reason: 'rate-limited' })
      }
      throw new TurnError(`not-posted: the composer did not hold exactly the intended text (page ${visibility}); nothing was sent, so no reply is coming`, { reason: 'not-posted' })
    }
    // Join the snapshot begun right after the landing check. It has been reading
    // under the composer wait, the DOM baselines and the compose, so this label is
    // normally ~0; whatever remains is the residual wait. The tree is the evidence
    // that survives a stale DOM (the user-message selector can stop exposing new
    // nodes after a rerender while the send itself landed), which is why it is
    // taken before EVERY send. `readUserTreeOnPage` keeps both meanings: `null` is
    // an unreadable backend (cannot prove anything, so the turn settles ambiguous
    // exactly as before), an empty Map is the new-chat route (nothing was there
    // yet). A genuine throw is still raised here, before anything is clicked.
    const treeOutcome = await railed(treeRead, acceptDeadline, sendDeadlineNotPosted)
    if (treeOutcome.error) throw treeOutcome.error
    const beforeTree = treeOutcome.value
    await phaseMark('baseline_tree')
    const acceptanceBaseline = { users: beforeUsers, dom: beforeDom ? beforeDom.identities : null }
    // `holdNetwork` keeps the CDP observer (and the send POST's stream-end
    // signal) alive past acceptance and through the reply; the `finally` below is
    // the only stop for that case, so no exit - answer, timeout, abort, throw -
    // can leave the session or its listener behind.
    submitted = await submitTurn(page, { baseline: acceptanceBaseline, text, treeBaseline: beforeTree, phaseLabel: phaseName, phaseStartedAt: phaseT0, deadline: acceptDeadline, holdNetwork: true })
  } finally {
    await releaseFocus()
  }
  try {
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
    // The reply keeps its own SEND_TIMEOUT_MS clock, started after acceptance, and
    // is railed as well: a single hung sample must not outlive the op. Expiry here
    // is the reply budget running out - the same `timedOut` shape the loop returns.
    const replyStartedAt = Date.now()
    const waited = await railOr(
      waitForReply(page, beforeCount, beforeText, submitted?.network ?? null, text),
      acceptDeadline + SEND_TIMEOUT_MS,
      { timedOut: true, seconds: Math.round((Date.now() - replyStartedAt) / 1000) },
    )
    // Post-reply enrichment only: the reply is already in hand, so an expiry here
    // costs the model label and never the answer.
    const state = await railOr(pageState(page), Date.now() + SEND_TAIL_MS, { model: null })
    if (waited.timedOut) {
      // The DOM waited as long as it may. Before calling the turn lost, ask the
      // server: when the page fails to render ("can't load conversation") the
      // answer is usually already there, and the turn did complete.
      const recovered = await readServerReply(page, threadOf(page.url()), text)
      if (recovered) {
        await log(`reply recovered from the server after the page stopped rendering (${recovered.length} chars)`)
        return { reply: clampReply(recovered), url: page.url(), model: state.model, attachment, source: 'server' }
      }
      return { reply: '', url: page.url(), model: state.model, attachment, timedOut: true, seconds: waited.seconds, state: 'generating' }
    }
    return { reply: clampReply(waited.reply), url: page.url(), model: state.model, attachment }
  } finally {
    await submitted.release().catch(() => null)
  }
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
  release(browser)
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
  release(browser)
}

async function doStatus() {
  if (!(await cdpUp())) { console.log('Chrome not running'); return }
  const { browser, page } = await connect()
  console.log(JSON.stringify(await pageState(page), null, 2))
  release(browser)
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
      await stopProcess(pid)
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
  release(browser)
}

async function doChat() {
  await ensureChrome({ visible: true })
  const { browser, page } = await connect()
  const state = await pageState(page)
  if (!state.loggedIn) {
    console.log('Not signed in. Run: node chatgpt.mjs login')
    release(browser)
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
  release(browser)
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

/**
 * The same conversation read, with the user nodes extracted IN the page.
 *
 * The body is the cost: a live 2026-11-01 read of an 802-node / 4.9 MB thread
 * spent 0.25-0.43 s (mean 0.39 s of three paired runs) bringing the parsed
 * mapping back across CDP and parsing it again in Node, on top of the ~1.7-1.9 s
 * the backend itself takes. Both consumers
 * of that body (`treeSendEvidence`, `readUserTreeOnPage`) only ever ask for
 * `userTreeNodes(body)`, so the page drops every entry that function ignores and
 * only the user turns cross.
 *
 * NOT A SECOND IMPLEMENTATION: what comes back is still a body, to be read by
 * the one `userTreeNodes` in this module. The page keeps the entries whose
 * `message.author.role === 'user'` and passes their node objects through
 * untouched, so identity (`m:<message.id>` / `n:<key>`), text, ordering and the
 * last-duplicate-wins rule are all decided where they always were. The only
 * thing removed is data `userTreeNodes` provably discards, which is why the Map
 * cannot drift.
 *
 * SELF-CONTAINED ON PURPOSE: Playwright serialises this function's source into
 * the page, so it may not close over anything in this module. The fixture calls
 * it directly with `{ body }` for the same reason: the projection the page runs
 * is one function, not a copy that can drift.
 *
 * Called two ways:
 *   - `path` as a string, exactly like `backendGetOn` passes it, so every fake
 *     and every observer sees the existing argument shape;
 *   - `{ body }` in the fixture seam, which runs the projection with no network.
 *
 * Returns `{ ok, status, via:'in-page', body }` on success,
 * `{ ok, status, via:'body', body, why }` when the projection itself failed (the
 * page already has the body, so it rides back rather than failing the read), and
 * the same `{ ok:false, status, error }` refusals as `backendGetOn`.
 */
async function readUserNodesInPage(request) {
  // Keep every entry `userTreeNodes` could use and drop the rest, without
  // re-deriving identity or text here: node objects are passed through untouched,
  // so the Node side reads exactly what it would have read out of the full body.
  const userOnly = source => {
    const mapping = source && typeof source === 'object' && source.mapping && typeof source.mapping === 'object' ? source.mapping : null
    if (!mapping) return { mapping: null }
    const kept = {}
    for (const [key, node] of Object.entries(mapping)) {
      if (node?.message?.author?.role === 'user') kept[key] = node
    }
    return { mapping: kept }
  }
  const shaped = source => {
    try {
      return { via: 'in-page', body: userOnly(source) }
    } catch (error) {
      return { via: 'body', body: source, why: String(error?.message ?? error) }
    }
  }
  // The proof seam: no network, the same extraction, in the same runtime.
  if (request !== null && typeof request === 'object') return { ok: true, status: 0, ...shaped(request.body ?? null) }
  const path = String(request)
  const session = await fetch('/api/auth/session', { credentials: 'include' }).then(r => r.json()).catch(() => null)
  if (!session?.accessToken) return { ok: false, status: 401, error: 'not signed in' }
  const response = await fetch(path, { headers: { authorization: `Bearer ${session.accessToken}` } })
  if (!response.ok) return { ok: false, status: response.status, error: `GET ${path.split('?')[0]} answered ${response.status}` }
  return { ok: true, status: response.status, ...shaped(await response.json()) }
}

/**
 * Read the thread tree, returning a body the caller reads with `userTreeNodes`.
 *
 * The body is the same body on every path; only its size differs. On `in-page`
 * it carries just the user turns, which is all `userTreeNodes` reads, so the
 * caller's Map is identical either way.
 *
 * `how` names the path taken and is the only new observable:
 *   - `in-page`            the page projected the mapping; only user turns crossed CDP;
 *   - `body`               the page could not project, so the body rode back whole
 *                          and the Node function read it (same Map);
 *   - `whole-body`         the evaluate path itself failed, so the ordinary
 *                          `backendGetOn` read ran (same Map);
 *   - `in-page-timeout`    the page never answered; NOT retried, because a wedge
 *                          would wedge again and the read is bounded on purpose;
 *   - `in-page-refused`    the page refused the read (401/HTTP status).
 *
 * A readable thread must never become unreadable because a faster path was
 * added, so every failure below falls back to the exact read it replaced.
 */
async function readUserNodesOn(page, path, timeoutMs = 30_000) {
  const bodyFallback = (read, how) => {
    if (!read?.ok) return { ok: false, status: read?.status, reason: read?.reason, error: read?.error, how }
    return { ok: true, status: read.status, body: read.body, how }
  }
  let result = null
  try {
    result = await evaluateTimed(page, readUserNodesInPage, path, timeoutMs)
  } catch (error) {
    if (error?.reason === 'timeout') {
      // Same reading as backendGetOn: the page did not answer, so this is
      // unreadable, not a transport failure that a second read would fix.
      noteTreeRead(`tree read path: in-page timeout ${timeoutMs}ms`)
      return { ok: false, status: 0, reason: 'timeout', error: error.message, how: 'in-page-timeout' }
    }
    noteTreeRead(`tree read path: whole-body fallback (${error?.message ?? error})`)
    return bodyFallback(await backendGetOn(page, path, timeoutMs).catch(() => null), 'whole-body')
  }
  if (result?.ok === true && 'body' in result) {
    // `via` is the page's own report: 'in-page' means it projected the mapping,
    // and anything else - including the old whole-body shape the frozen proof's
    // fakes still answer with - means the body came back whole. Both cost exactly
    // ONE read, and both are read by the same `userTreeNodes` above the caller.
    const inPage = result.via === 'in-page'
    noteTreeRead(inPage ? 'tree read path: in-page' : `tree read path: body fallback (${result.why ?? 'whole-body shape'})`)
    return { ok: true, status: result.status, body: result.body, how: inPage ? 'in-page' : 'body' }
  }
  if (result?.ok === false) {
    noteTreeRead(`tree read path: in-page refused (${result.error ?? result.status})`)
    return { ok: false, status: result.status, error: result.error, how: 'in-page-refused' }
  }
  // A shape we do not know: fall back rather than guess.
  noteTreeRead('tree read path: whole-body fallback (unrecognised in-page result)')
  return bodyFallback(await backendGetOn(page, path, timeoutMs).catch(() => null), 'whole-body')
}

/**
 * The path line is a fact about the driver, never about a test: only the live
 * entry point writes it. Proofs import this module with the real HOME, so an
 * unconditional log() here would append to the live driver.log.
 */
function noteTreeRead(line) {
  if (isMain) log(line)
}

async function backendGet(path, timeoutMs = 30_000) {
  if (!(await cdpUp())) return { ok: false, status: 0, error: 'chrome is not running' }
  const { browser, page } = await connect()
  try { return await backendGetOn(page, path, timeoutMs) } finally { release(browser) }
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
  try { return await operation(page) } finally { release(browser) }
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
  // Set only once the observer is actually running (at the end): an install that
  // throws must be retryable, or that document stays permanently blind.
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
  // A conversation that cannot render its messages. The banner ("Couldn't load
  // messages" and its variants) sits outside the newest assistant bubble, so
  // the bubble test cannot see it. Only consulted when the newest bubble has
  // no text, so an answer that merely QUOTES the phrase is never a failure.
  const LOAD_FAILURE = /(couldn'?t load (the )?messages|could not load messages|unable to load (the )?(messages|conversation)|error loading (the )?(messages|conversation)|there was a problem loading (the )?(messages|conversation))/i
  const loadFailed = () => {
    const assistant = document.querySelectorAll('[data-markdown-text-style="assistant-message"]')
    const newest = assistant[assistant.length - 1]
    if (newest && (newest.textContent || '').trim()) return false
    return LOAD_FAILURE.test((document.body && document.body.innerText || '').slice(0, 20000))
  }
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
    // Why a turn reads as failed, for the host's repair rule: a load failure is
    // the window's fault and is repairable; a limit/challenge is the account's
    // and is not. Word only - never page text.
    let problem = null
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
    if (bubble && FAILURE.test(bubble.textContent || '')) {
      phase = 'failed'
      problem = /limit|unusual activity|verify you are human/i.test(bubble.textContent || '') ? 'blocked' : 'load'
    }
    // A conversation-level load failure is the same verdict for this turn: no
    // answer is coming through this window, so the host must recycle it.
    if (loadFailed()) { phase = 'failed'; problem = 'load' }
    const threadId = threadOf()
    if (threadId !== lastThread) {
      // The first look at a thread is not a transition: adopt its state
      // without claiming a turn finished there. The baseline is still pushed,
      // so a caller that has just attached knows what the page shows.
      lastThread = threadId
      lastPhase = phase
      if (threadId) send({ event: 'navigated', threadId })
      send({ event: 'signal', threadId, phase, problem, at: Date.now() })
      return
    }
    if (phase === lastPhase) return
    lastPhase = phase
    // The page's own clock at the transition is carried as "at", so the time
    // from a turn finishing here to the host acting on it can be measured
    // rather than argued about. No backticks in here: this whole script is
    // a template literal.
    send({ event: 'signal', threadId, phase, problem, at: Date.now() })
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
  // Observe the Document, not document.documentElement: at document_start (the
  // addScriptToEvaluateOnNewDocument path) the root element does not exist yet
  // and observing null throws "parameter 1 is not of type 'Node'". With
  // subtree:true on the Document the same mutations are delivered, and it is
  // valid however early the script runs.
  observer.observe(document, {
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
  window.__gwObserver = true
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
/** One pushed record per lane ('' is the master/operator page). */
const PUSHED = new Map()

function pushedOf(lane) {
  const key = lane || ''
  let entry = PUSHED.get(key)
  if (!entry) {
    entry = { phase: null, threadId: null, at: null, problem: null }
    PUSHED.set(key, entry)
  }
  return entry
}

const anyStreaming = () => [...PUSHED.values()].some(entry => entry.phase === 'streaming')

/** Record one page push. Called only from the event channel, with its lane. */
function notePush(lane, phase, threadId, at, problem = null) {
  const entry = pushedOf(lane)
  entry.phase = phase === 'streaming' || phase === 'complete' || phase === 'failed' ? phase : null
  entry.threadId = typeof threadId === 'string' && threadId ? threadId.toLowerCase() : null
  entry.at = Number.isFinite(at) ? at : Date.now()
  entry.problem = problem === 'load' || problem === 'blocked' ? problem : null
}

/** The state a pushed phase implies, for one thread, in the current lane. */
function pushedState(threadId) {
  const entry = pushedOf(laneOf())
  const ageMs = entry.at === null ? null : Date.now() - entry.at
  const matches = entry.threadId && threadId ? entry.threadId === threadId.toLowerCase() : null
  if (entry.at === null) return { state: 'unknown', phase: null, ageMs, matchesThread: matches }
  if (matches === false) return { state: 'other-thread', phase: null, ageMs, matchesThread: false }
  if (entry.phase === 'failed') return { state: 'failed', phase: 'failed', problem: entry.problem, ageMs, matchesThread: matches }
  if (entry.phase === 'streaming') return { state: 'generating', phase: 'streaming', ageMs, matchesThread: matches }
  return { state: 'idle', phase: entry.phase, ageMs, matchesThread: matches }
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
  // A page that says it cannot load the messages is not "idle": the window is
  // broken and must be recycled, so say `failed` with the reason the host acts on.
  if (live.problem === 'load') {
    return { state: 'failed', phase: 'failed', cost: 'page', evidence: 'the page could not load the messages', problem: 'load' }
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

  // Frame and load events for ONE navigation arrive in a burst, and two installs
  // running at once read the same CDP session concurrently - overlapping
  // evaluates with interleaved state updates. Serialise per entry, so a queued
  // install runs after the first finishes and then reads the finished state
  // (usually `already` with `announced` set). Marking `announced` at entry
  // instead would be the smaller change, but an install that then fails (CDP
  // mid-navigation) would swallow the event until the next document mark, which
  // is the retry this whole path exists for.
  const install = entry => {
    const run = entry.installChain.then(() => installOnce(entry))
    entry.installChain = run.then(() => {}, () => {})
    return run
  }

  const installOnce = async entry => {
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
    // Which inputter's tab is this? The tab NAME is the lane: it is set once by
    // the driver after landing and survives same-site navigation and reloads.
    // An unnamed tab is the master/operator page (lane '').
    try {
      const named = await cdpTimed(entry.session.send('Runtime.evaluate', { expression: 'window.name || ""', returnByValue: true }), 5_000)
      const name = typeof named?.result?.value === 'string' ? named.result.value : ''
      entry.lane = name.startsWith(LANE_TAB_PREFIX) ? name.slice(LANE_TAB_PREFIX.length) : ''
    } catch { /* keep the previous lane; the next page-ready retries */ }
    state.lastSeenAt = Date.now()
    // Ask the observer for its current state. A child that attaches to a page
    // whose observer is already installed would otherwise hear nothing until
    // the page next changes - during a long turn, exactly when it is needed.
    try { await cdpTimed(entry.session.send('Runtime.evaluate', { expression: 'window.__gwPush && window.__gwPush()' }), 10_000) } catch { /* the watchdog retries */ }
    // Which page-ready is this, and what may the host read for it? A child that
    // has just attached (the first look on this connection, or one that has
    // never managed to read a document mark) needs the full catch-up; every
    // later page-ready is a document that changed under us - a reload or a
    // cross-thread navigation - and licenses only the thread the page moved to.
    // The flag is taken BEFORE `primed` flips, and an unreadable baseline counts
    // as a fresh attach: over-licensing catch-up only reads too much, while
    // calling an attach a document change would lose the reconcile.
    const first = !entry.primed || entry.docId === null
    if (!entry.primed) {
      entry.primed = true
      if (mark) entry.docId = mark
    } else if (mark && mark !== entry.docId) {
      entry.docId = mark
      entry.announced = false
    }
    const reason = first ? 'attach' : 'document'
    // Name the thread from the DOCUMENT, not from a push. A cross-thread send
    // loads a new document, and the new observer only samples on its own
    // schedule, so the `navigated` push that would name the thread arrives
    // after this emit - and a page-ready the host cannot map to a bridge buys
    // the wide catch-up exactly when it should have bought one thread. One
    // bounded read of location.pathname settles it at emit time; a failure
    // keeps whatever the pushes last said.
    try {
      const asked = await cdpTimed(entry.session.send('Runtime.evaluate', {
        expression: '(() => { const m = /\\/c\\/([0-9a-f-]{36})/i.exec(location.pathname); return m ? m[1].toLowerCase() : null })()',
        returnByValue: true, awaitPromise: false,
      }), 10_000)
      const answer = asked?.result?.value
      // A string names this document's thread; an explicit null means the
      // document has none (a new chat), which must CLEAR a stale id or this
      // page-ready would be scoped to the bridge that owns the previous
      // thread. Only an unanswered read leaves naming to the pushes.
      if (typeof answer === 'string' && answer) entry.threadId = answer
      else if (answer === null) entry.threadId = null
    } catch { /* the pushes still name it when they arrive */ }
    // The line is written only when a page-ready is really EMITTED. Logging it
    // above the `already` guard made one navigation print five lines for one
    // event (live 2026-11-01), which read as an event burst that never existed.
    const value = result?.result?.value
    if (value === 'already') {
      // The document is still the one we were watching: a repeated load or
      // frame event, not a page that came back. It is worth one page-ready
      // only when this connection is new - a fresh driver child attaches to a
      // page whose observer (and its stale binding) came from the child before
      // it - and silence afterwards.
      if (!entry.announced) {
        entry.announced = true
        note(`page-ready ${reason} thread ${entry.threadId ?? 'none'}`)
        emitSafe({ event: 'page-ready', threadId: entry.threadId ?? null, reason })
      }
      return 'already'
    }
    entry.announced = true
    note(`page-ready ${reason} thread ${entry.threadId ?? 'none'}`)
    emitSafe({ event: 'page-ready', threadId: entry.threadId ?? null, reason })
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
    // `lane` names which inputter's tab this is (from window.name), so a push
    // is recorded in its own lane's slot instead of overwriting everyone's.
    const entry = { page, session, threadId: null, lane: '', announced: false, docId: null, primed: false, installChain: Promise.resolve() }
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
        const problem = message.problem === 'load' || message.problem === 'blocked' ? message.problem : null
        notePush(entry.lane, phase, threadId, at, problem)
        emitSafe({ event: 'signal', threadId, phase, at, lane: entry.lane || '' })
        return
      }
      if (message.event === 'navigated' && typeof message.threadId === 'string' && message.threadId) {
        entry.threadId = message.threadId
        emitSafe({ event: 'navigated', threadId: message.threadId, lane: entry.lane || '' })
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
      // Only this tab's slot: another inputter's page is still alive and its
      // last pushed state must not be erased by this close.
      const slot = pushedOf(entry.lane)
      slot.phase = null
      slot.at = null
      if (state.pages.size === 0) {
        note('every watched tab closed')
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
    // The observer owns its connection: it reconnects by closing it, which must
    // not pull the connection out from under the op that is still using it.
    try { browser = await attachOwned() }
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
      // The last word from the old connection is not news any more: drop every
      // lane's slot, because this connection was the only witness.
      for (const slot of PUSHED.values()) { slot.phase = null; slot.at = null }
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
 * Ops that may be served WHILE the serial chain is busy with a send.
 *
 * The chain exists to keep page MUTATIONS apart: two sends, a navigation, an
 * attachment and a model switch must never interleave, and a send's own
 * expectations (its DOM baselines, its new-user-node set, its acceptance check)
 * must not move under it. A read does none of that, so it must not wait behind a
 * 240 s send: live 2026-11-01 seven `status` reads queued behind one send and
 * each hit the host's own 20 s timeout, so the host concluded "the driver
 * failed" about a child that was healthy the whole time.
 *
 * Only the ops below qualify, each because it changes no DOM, no navigation, no
 * composer and no tab:
 *   - `status` WITH a threadId. The default form is the host's poll: one bounded
 *     DOM sample on the tab showing that thread, or a backend GET when `deep`.
 *     Neither clicks, so nothing the send is watching can change.
 *   - `conversation`, `conversations`, `threads`: backend GETs made from inside
 *     the page. The path names the thread, so even the tab `connect()` happens
 *     to pick cannot change the answer.
 *   - `read`: samples the newest assistant node's text and its stability.
 *
 * Everything else stays on the chain, deliberately. `status` WITHOUT a threadId
 * is the CLI report and calls `readModelState`, which CLICKS the model button
 * and toggles its panel - an overlay that would sit in the way of the send's
 * click. `file` writes a file and can pull for 60 s, and is not on the poll
 * path. `ping` touches no page at all but is not on the host's poll path either,
 * so it stays where it is rather than widening this change.
 */
const CONCURRENT_READ_OPS = new Set(['conversation', 'conversations', 'threads', 'read'])
function isConcurrentRead(request) {
  if (CONCURRENT_READ_OPS.has(request.op)) return true
  return request.op === 'status' && typeof request.threadId === 'string' && request.threadId.length > 0
}

/**
 * The serialiser, factored out of serve() so the dispatch itself can be proven
 * without a page: it is handed a `run` and an `emit`, owns no browser, and the
 * proof drives it with a `run` that holds a send and answers status at once.
 *
 * Mutating ops go on one `chain`; a read the predicate allows runs at once and
 * is tracked so quit can drain it. A reply is emitted exactly once per arrival:
 * the chain never re-runs an op, and nothing here races a second answer in.
 */
function createDispatcher({ run, emit, isConcurrent = isConcurrentRead }) {
  // One chain per LANE, not one per process: the process serves every
  // inputter's tab, so two writers must not wait for each other, while one
  // writer's mutations still never interleave with their own.
  const chains = new Map()
  const chainFor = key => {
    let chain = chains.get(key)
    if (!chain) { chain = Promise.resolve(); chains.set(key, chain) }
    return chain
  }
  const reads = new Set()
  const pending = new Set()
  let outstanding = 0

  const answer = (request, replyId) => run(request).then(
    result => { emit({ ...result, id: replyId }); return result },
    error => {
      // `reason` (and the state it explains) is part of the contract: the host
      // acts on it rather than parsing English.
      emit({
        ok: false, op: request.op, id: replyId, error: error.message,
        ...(error.reason ? { reason: error.reason } : {}),
        ...(error.state ? { state: error.state } : {}),
        ...(error.threadId ? { threadId: error.threadId } : {}),
      })
      return null
    },
  )

  const dispatch = (request, replyId, id = null) => {
    outstanding += 1
    if (id) pending.add(id)
    const settle = () => { outstanding -= 1; if (id) pending.delete(id) }
    // Every request runs inside its OWN lane's context, so everything below
    // (connect, the pushed state, the active thread, the lease) resolves to the
    // right tab without threading a lane argument through every function.
    const key = typeof request?.lane === 'string' ? request.lane : ''
    const task = () => LANE_CTX.run(key, () => answer(request, replyId)).finally(settle)
    if (isConcurrent(request)) {
      // Started NOW, so it does not wait for whatever the chain is doing.
      const running = task()
      reads.add(running)
      running.finally(() => reads.delete(running))
    } else {
      // Deferred behind the SAME lane's chain; other lanes run in parallel.
      chains.set(key, chainFor(key).then(task))
    }
  }

  return {
    dispatch,
    has: id => pending.has(id),
    get outstanding() { return outstanding },
    // Quit waits for BOTH: the mutating queue and any read that bypassed it, so
    // no answer can follow the quit frame.
    drain: async () => { await Promise.allSettled([...chains.values()]); await Promise.allSettled([...reads]) },
  }
}

/**
 * Line-JSON host protocol on stdio. One request per line, one response per
 * line; an `event` line may precede a response (acceptance, which the host
 * needs before the answer exists). Mutations run one at a time on `chain`;
 * a read that cannot disturb a send runs alongside it (isConcurrentRead).
 */
async function serve() {
  STDOUT_RESERVED = true
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`)
  let closing = false
  const channel = startEventChannel(value => {
    // Once quit has been answered, nothing else may follow it on the wire.
    if (closing) return
    emit(value)
  }, anyStreaming)

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
        const pushedLane = pushedOf(laneOf())
        const at = pushedLane.at === null ? null : new Date(pushedLane.at).toISOString()
        if (request.deep !== true) {
          // A pushed `failed` or `generating` needs no second opinion. Anything
          // else may simply be a signal older than the turn, so one cheap DOM
          // look decides - never the conversation, which is the 429 risk.
          const needsLook = cheap.state !== 'failed' && cheap.state !== 'generating'
          const live = needsLook ? await cheapLiveTurn(threadId) : null
          const verdict = statusVerdict({ pushed: cheap.state, phase: cheap.phase, live, threadId })
          const problem = verdict.problem ?? live?.problem ?? cheap.problem ?? null
          return {
            ok: true, op, cost: verdict.cost, threadId,
            pushedThreadId: pushedLane.threadId,
            matchesThread: cheap.matchesThread,
            state: verdict.state, phase: verdict.phase, ageMs: cheap.ageMs, at,
            ...(problem ? { problem } : {}),
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
          ...(cheap.problem ? { problem: cheap.problem } : {}),
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
      } finally { release(browser) }
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
        const onRetry = elapsed => log(`phase reload gotoRetry ${elapsed}ms`)
        if (showing && showing.toLowerCase() === threadId.toLowerCase()) await gotoThread(page, page.url(), { reload: true, onRetry })
        else await gotoThread(page, `https://chatgpt.com/c/${threadId}`, { onRetry })
        await waitForLogin(page, 60_000)
        await waitForComposer(page)
        setActiveThread(threadId.toLowerCase())
        return { ok: true, op, threadId, url: page.url() }
      } finally { release(browser) }
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
          // Per-turn model/effort from the bridge. Absent (CLI, tests) keeps the
          // page's current selection, exactly as before.
          model: typeof request.model === 'string' && request.model ? request.model : null,
          effort: typeof request.effort === 'string' && request.effort ? request.effort : null,
        })
        const sentThread = threadOf(result.url)
        if (sentThread) setActiveThread(sentThread)
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
        // The model/effort label is post-reply enrichment: bounded by the same
        // tail as the page state, and an expiry answers with no model rather
        // than delaying the reply frame.
        const model = await railOr(readModelState(page), Date.now() + SEND_TAIL_MS, {}).catch(() => ({}))
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
          setActiveThread(target.toLowerCase())
          return { ok: true, op, threadId: threadOf(existing.url()), url: existing.url(), adopted: true }
        }
        await gotoThread(page, `https://chatgpt.com/c/${target}`, { onRetry: elapsed => log(`phase use gotoRetry ${elapsed}ms`) })
        await waitForLogin(page, 60_000)
        const landed = threadOf(page.url())
        if (!landed || landed.toLowerCase() !== target.toLowerCase()) {
          return { ok: false, op, error: `the page landed on ${landed ?? 'no thread'} instead of the requested thread ${target}` }
        }
        setActiveThread(landed.toLowerCase())
        return { ok: true, op, threadId: landed, url: page.url(), adopted: false }
      } finally { release(browser) }
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
    if (op === 'warm') {
      // Start (or adopt) this child's browser and prove the login BEFORE the
      // host hands it a turn. In lane mode this is where the master branch is
      // injected and verified; the host treats a refusal as a failed lane open.
      await ensureChrome({ visible: true })
      const { browser, page } = await connect()
      try {
        let state = await pageState(page)
        if (!state.loggedIn) {
          await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: LOGIN_WAIT_MS }).catch(() => {})
          state = await waitForLogin(page, LOGIN_WAIT_MS)
        }
        // A sign-in redirect is a cross-site navigation, which clears the tab
        // name; restore it before the first turn so later ops find this tab.
        await ensureLaneName(page, laneOf() ? LANE_TAB_PREFIX + laneOf() : '')
        return { ok: true, op, lane: laneOf() || null, sharedBrowser: LANE_SHARED, signedIn: state.loggedIn, plan: state.plan ?? null, url: state.url }
      } finally {
        release(browser)
      }
    }
    if (op === 'unload') {
      if (LANE_SHARED) {
        // Close the tab this lane owns and nothing else. The master window is
        // the only browser and its session is the only session, so there is no
        // cookie write-back to do and no window to close.
        const closed = await closeLaneTab().catch(error => ({ tabClosed: false, error: error.message }))
        setActiveThread(null)
        return { ok: true, op, state: 'unloaded', sharedBrowser: true, ...closed }
      }
      // The one-window driver: close the Chrome this install launched. There is
      // no session to hand back, because no session was ever copied out.
      await doQuit()
      setActiveThread(null)
      return { ok: true, op, state: 'unloaded', cookiesSynced: 0, cookieSync: 'not a lane' }
    }
    return { ok: false, op, error: `unknown op ${op ?? '(missing)'}` }
  }

  // Both fields are additive: a host that does not know them ignores them, and
  // one that does binds the send call's timeout to the deadline the child
  // actually ENFORCES (SEND_CEILING_MS) and adds the per-file attachment
  // allowance the child keeps outside it (SEND_ATTACH_CREDIT_MS × file count),
  // instead of guessing either from prose. One attachment today means a
  // multiplier of 0 or 1.
  emit({ event: 'ready', pid: process.pid, sendCeilingMs: SEND_CEILING_MS, sendAttachCreditMs: SEND_ATTACH_CREDIT_MS })
  channel.start()
  // Every reply is correlated by id, so a second request reusing the id of one
  // still queued cannot be told apart from the first.
  const dispatcher = createDispatcher({ run, emit })
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
    if (validId && dispatcher.has(id)) {
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
      emit({ event: 'draining', queued: dispatcher.outstanding })
      await dispatcher.drain()
      // The reply goes out after every queued line is on disk: the host reads
      // this file for phase data, and a driver that quit must not lose its tail.
      await flushLog()
      await channel.stop()
      // Leaving the child does not mean leaving the browser: the page is the
      // shared resource, and `unload` is the op that closes it. A driver
      // restart therefore finds the same signed-in Chrome and thread.
      emit({ ok: true, op: 'quit', id: replyId })
      break
    }
    if (closing) { emit({ ok: false, op: request.op, id: replyId, error: 'the driver is draining; the request was not accepted' }); continue }
    dispatcher.dispatch(request, replyId, validId ? id : null)
  }
}

export {
  ask, attachFile, connect, ensureChrome, pageState, waitForLogin, doQuit, serve, readNewestTurn,
  BASE, log, flushLog,
  // Pure or page-free helpers, exported so the guard logic can be proven without
  // a live page (origin check, base64 validation, install probe, acceptance,
  // browser identity).
  isChatGPTUrl, decodeBase64, chromePath, waitForAcceptance, parseBrowserUrl, attachVerdict, statusVerdict,
  normalizedTurnText, promptMatches, sendAcceptVerdict, userTreeNodes, newUserNodes, newDomUserTexts,
  degradedSendVerdict, treeSendEvidence, acceptanceEvidence, submitTurn, launchVerdict, ownerCarriesProfile,
  startNetworkWatch, isConcurrentRead, createDispatcher,
  SEND_ATTACH_CREDIT_MS, ATTACH_INPUT_TIMEOUT_MS, ATTACH_CHIP_TIMEOUT_MS,
  composeExactlyOnce, clearComposer, composerTextOf, readUserTreeOnPage, recoverComposer,
  readUserNodesInPage, readUserNodesOn, waitForReply, STREAM_SETTLE_MS, ANSWER_AGREE_SAMPLES,
  parseTurnMarker, parseMessageMarker, parseContentDelta, createSseFrames, MARKER_CONFIRM_MS, MARKER_SAMPLE_MS,
  framePartOps, frameMessageId, contentPartOps, normalizeAnswerText, tailSuffix, TAIL_WORDS, TAIL_MIN_WORDS,
  commandLineTokens, portOwner,
  exhaustedLaunchWhy,
  // G-010: the enforced deadline and the advertised ceiling are exported so a
  // proof can derive one from the other instead of pinning a number.
  SEND_ACCEPT_DEADLINE_MS, SEND_TAIL_MS, SEND_TIMEOUT_MS, SEND_CEILING_MS,
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
    await flushLog()
    process.exit(1)
  }
}
