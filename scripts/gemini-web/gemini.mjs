#!/usr/bin/env node
/**
 * The Gemini driver: the same line-JSON contract as the ChatGPT driver.
 *
 * Playwright over CDP, like the ChatGPT driver. The browser must be a real,
 * visible window with native occlusion detection off: Chrome marks an occluded
 * (or off-screen) page hidden, and a hidden page drops CDP input, which makes a
 * send silently do nothing. Chrome is launched here with those flags.
 */
import { spawn } from 'node:child_process'
import { closeSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

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
const LANE_TAB = LANE_ID ? `webbridge-lane:${LANE_ID}` : ''
const LANE_SHARED_DIR = process.env.GEMINI_LANE_SHARED_DIR || process.env.CHATGPT_LANE_SHARED_DIR || join(STATE_DIR, '..')
// One tab can be in front at a time, and Playwright's click waits for the
// target to be hit-testable: two lanes typing at once would race for focus and
// one click would hang. Focus is held only while typing, not while waiting.
const FOCUS_LOCK = join(LANE_SHARED_DIR, 'webbridge-focus.lock')
const FOCUS_STALE_MS = 60_000

async function log(line) {
  try {
    await mkdir(STATE_DIR, { recursive: true })
    await writeFile(LOG_FILE, `${new Date().toISOString()} [${LANE_ID || 'master'}] ${line}\n`, { flag: 'a' })
  } catch { /* logging must never break a turn */ }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Take the one browser focus token. Lanes are tabs in one window; only one tab
 * is in front, and a click aimed at a tab that lost the front hangs. The token
 * covers typing only - a lane waits for its answer with the token released, so
 * turns still overlap.
 */
async function acquireFocus() {
  const deadline = Date.now() + 90_000
  for (;;) {
    try {
      const fd = openSync(FOCUS_LOCK, 'wx')
      writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`)
      closeSync(fd)
      return async () => { try { unlinkSync(FOCUS_LOCK) } catch { /* already released */ } }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(FOCUS_LOCK).mtimeMs > FOCUS_STALE_MS) { unlinkSync(FOCUS_LOCK); continue }
      } catch { /* the holder released between the two calls */ }
      if (Date.now() > deadline) throw new Error('another lane held the browser focus lock for 90s')
      await sleep(120)
    }
  }
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
async function ensureChrome() {
  // A shared lane lives in the master browser. If the host unloaded it, the
  // master profile is still the one to open: the login lives there.
  const targetPort = LANE_SHARED ? CONNECT_PORT : PORT
  const targetProfile = LANE_SHARED
    ? (process.env.GEMINI_LANE_SOURCE_PROFILE || process.env.CHATGPT_LANE_SOURCE_PROFILE || PROFILE)
    : PROFILE
  if (await portAnswers(targetPort)) return
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
    if (await portAnswers(PORT)) return
    await sleep(400)
  }
  throw new Error('Chrome did not open the debugging port')
}

/* ----------------------------------------------------------- Playwright */

/** Kill the browser that owns this debug port (only this driver's profile). */
async function killPortOwner(port) {
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
    await log(`attach on port ${port} stalled (${String(error.message).split('\n')[0]}); restarting the window`)
    await killPortOwner(port)
    await sleep(1_500)
    await ensureChrome()
    browser = await attach()
  }
  const context = browser.contexts()[0]
  if (!context) throw new Error(`browser on port ${port} has no browser context`)
  return { browser, context }
}

async function geminiPage(context) {
  if (LANE_SHARED) {
    // Lane tabs are named; never borrow the operator's own tab.
    for (const candidate of context.pages()) {
      const name = await candidate.evaluate(() => window.name).catch(() => '')
      if (name === LANE_TAB) {
        await candidate.bringToFront().catch(() => {})
        return candidate
      }
    }
    const page = await context.newPage()
    await page.goto(APP, { waitUntil: 'domcontentloaded' })
    // Chrome clears window.name on a cross-site navigation, so name the tab
    // AFTER it is on the site; same-site navigation and reload keep it.
    await page.evaluate(name => { window.name = name }, LANE_TAB).catch(() => {})
    await waitForComposer(page, 30_000)
    return page
  }
  const page = context.pages().find(candidate => candidate.url().includes('gemini.google.com'))
    ?? context.pages()[0]
    ?? await context.newPage()
  if (!page.url().includes('gemini.google.com')) await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.bringToFront().catch(() => {})
  return page
}

async function withPage(operation) {
  const { browser, context } = await connect()
  try {
    const page = await geminiPage(context)
    return await operation(page, context)
  } finally { await browser.close().catch(() => {}) }
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
  return new RegExp(`^${String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i')
}

async function setMode(page, model, effort) {
  const wantedModel = String(model || '').trim()
  const wantedEffort = String(effort || '').trim()
  if (!wantedModel && !wantedEffort) return { ok: true, state: await pickerState(page) }
  const before = await pickerState(page)
  if (wantedModel && !modelMatches(wantedModel, before)) {
    if (!(await openPicker(page))) return { ok: false, error: 'the mode picker did not open' }
    if (!(await clickMenuItem(page, exactName(wantedModel)))) {
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
  await press()
  // The click can land on a button the app is about to replace. If the composer
  // still holds the prompt a moment later, the message did not go: press once more.
  await sleep(600)
  if ((await read()) === wanted) await press()
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
  const { browser, context } = await connect()
  try {
    await branchMasterLogin(context)
    const page = await geminiPage(context)
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
      ok: true, op: 'warm', lane: LANE_ID || 'master', signedIn: true, plan: 'google',
      url: sign.url, model: mode?.model ?? null, effort: mode?.effort ?? null,
    }
  } finally { await browser.close().catch(() => {}) }
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

async function status(request) {
  return withPage(async page => {
    const state = await pageState(page)
    const wanted = typeof request.threadId === 'string' ? request.threadId.toLowerCase() : null
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

async function conversation(request) {
  return withPage(async page => {
    const state = await pageState(page)
    const wanted = typeof request.threadId === 'string' ? request.threadId.toLowerCase() : state.threadId
    if (wanted && state.threadId && wanted !== state.threadId) {
      return { ok: false, op: 'conversation', error: `the page is on another thread (${state.threadId})`, threadId: wanted }
    }
    const turns = await pageTurns(page)
    return { ok: true, op: 'conversation', conversation: conversationOf(wanted, turns.turns, turns.pending), threadId: wanted }
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
    try {
      const { browser, context } = await connect()
      try {
        for (const candidate of context.pages()) {
          const name = await candidate.evaluate(() => window.name).catch(() => '')
          if (name === LANE_TAB) await candidate.close().catch(() => {})
        }
      } finally { await browser.close().catch(() => {}) }
    } catch (error) { await log(`shared unload found no browser: ${error.message}`) }
    return { ok: true, op: 'unload', state: 'unloaded', cookiesSynced: null }
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

const CONCURRENT = new Set(['status', 'conversation', 'threads', 'read', 'ping'])
const handlers = {
  ping: async () => ({ ok: true, op: 'ping' }),
  warm, send, status, conversation, threads, read, use, recover, unload, mode,
}

function createDispatcher({ run, emit }) {
  let chain = Promise.resolve()
  return (request, id) => {
    const execute = () => run(request).then(
      result => { emit({ ...result, id }); return result },
      error => { emit({ ok: false, op: request.op, id, error: error.message }); return null },
    )
    if (CONCURRENT.has(request.op)) { void execute(); return }
    chain = chain.then(execute, execute).then(() => undefined)
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
