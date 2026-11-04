// Proves, with no Chrome and no contact with 9222, that chatgpt.mjs keeps its CDP-ownership, launch-identity and send-acceptance guarantees: real port-owner introspection, the real ensureChrome launch path against stubbed browsers, and a source-copy mutation per guard. Run from the repo root: `node proof/d5proof.mjs`.
// Red baseline on 6dec928 (measured by reverting 1c342ad and e6c572a): 5 load-bearing rows fail (2x R5 (c) chromePath, 3x R5 (d) exhausted window); 3 more rows pass red VACUOUSLY ("spawn the override decided is logged" via append-only driver.log, "does not borrow the refusal wording" and "records no launch marker" via the sentinel), so 8-red is NOT evidence of 8 defects.
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import os from 'node:os'
import fs from 'node:fs/promises'
import http from 'node:http'
import { execFileSync, spawn } from 'node:child_process'

// Resolved from this file, so the proof runs from any checkout. D5PROOF_SRC
// points the whole harness at another source file; the red baseline uses it to
// run these rows against the pre-fix driver (git show <sha>:chatgpt.mjs).
const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_PATH = process.env.D5PROOF_SRC || path.join(HERE, '..', 'chatgpt.mjs')
const STUB_PATH = path.join(HERE, 'stub-browser.mjs')

// This is the MUTATION baseline, not the red-baseline tree. It is the state
// before the count-based acceptance and the pre-owner launch recording existed,
// which is what the two mutation rows are about, and it comes from history so it
// is durable with the repo and cannot drift from it.
//
// Do NOT pin this to 6dec928 to "match" the red baseline: 6dec928 already carries
// those fixes, so both mutation rows would compare a fix against itself - it has 0
// occurrences of `Number(afterMessages) > Number(beforeMessages)` and its launch
// loop already calls portOwner(). Run against 9c34999 the harness fails 21 of 106,
// not 5, because 9c34999 also predates launchVerdict/portOwner entirely.
const BASELINE_SHA = '9c34999'
const BASELINE_PATH = path.join(os.tmpdir(), 'd5proof', `${BASELINE_SHA}.mjs`)
const baselineSource = async () => {
  const cached = await fs.readFile(BASELINE_PATH, 'utf8').catch(() => '')
  if (cached) return cached
  try {
    const text = execFileSync('git', ['show', `${BASELINE_SHA}:chatgpt.mjs`], {
      cwd: path.join(HERE, '..'), encoding: 'utf8', maxBuffer: 16 << 20,
    })
    await fs.mkdir(path.dirname(BASELINE_PATH), { recursive: true })
    await fs.writeFile(BASELINE_PATH, text)
    return text
  } catch {
    return ''
  }
}
// The source of one top-level function at an arbitrary commit, for before/after
// rows: the commit that still had the defect is the evidence it was real.
const sourceAt = (sha, signature) => {
  try {
    const text = execFileSync('git', ['show', `${sha}:chatgpt.mjs`], {
      cwd: path.join(HERE, '..'), encoding: 'utf8', maxBuffer: 16 << 20,
    })
    const start = text.indexOf(signature)
    if (start < 0) return ''
    let index = start + signature.length - 1
    let depth = 0
    for (; index < text.length; index += 1) {
      if (text[index] === '{') depth += 1
      else if (text[index] === '}') { depth -= 1; if (depth === 0) { index += 1; break } }
    }
    return text.slice(start, index)
  } catch {
    return ''
  }
}

const PROOF_PROFILE = path.join(os.tmpdir(), 'd5proof', 'profile-attach')
const SERVE_PROFILE = path.join(os.tmpdir(), 'd5proof', 'profile-serve')
// The CDP port the launch-window rows bind. 9599 is the default, but another
// long-lived process can hold it on this machine (Parsec does, wildcard-bound,
// which makes a loopback bind EACCES). D5PROOF_PORT exists so the suite can
// run without killing anything; the assertions are port-agnostic.
const PROOF_PORT = Number(process.env.D5PROOF_PORT || 9599)
process.env.CHATGPT_PROFILE = PROOF_PROFILE
process.env.CHATGPT_CDP_PORT = String(PROOF_PORT)

const results = []
// The two send-endpoint forms the driver's page-level POST matcher must cover in
// ONE regex: the live endpoint is `/backend-api/f/conversation`; the bare form is
// what earlier builds used.
const CONVERSATION_URL = 'https://chatgpt.com/backend-api/conversation'
const F_CONVERSATION_URL = 'https://chatgpt.com/backend-api/f/conversation'
const ok = (name, pass, detail = '') => {
  results.push({ name, pass: !!pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const mod = await import(pathToFileURL(SRC_PATH).href)

// ------------------------------------------------------------------ F1 origin
{
  const cases = [
    ['https://chatgpt.com/', true],
    ['https://chatgpt.com/c/68aabbcc-1111-2222-3333-444455556666', true],
    ['https://chatgpt.com:443/c/x', true],
    ['https://notchatgpt.com.evil.example/', false],
    ['https://chatgpt.com.evil.example/c/x', false],
    ['http://chatgpt.com/', false],
    ['https://evil.example/?u=https://chatgpt.com', false],
    ['about:blank', false],
    ['not a url', false],
  ]
  const bad = cases.filter(([url, want]) => mod.isChatGPTUrl(url) !== want)
  ok('F1 origin check accepts only https://chatgpt.com', bad.length === 0, bad.map(([u]) => u).join(', ') || '9 cases')
}

/** The exact source of one top-level function, by brace counting. */
const srcOf = async signature => {
  const src = await fs.readFile(SRC_PATH, 'utf8')
  const start = src.indexOf(signature)
  if (start < 0) throw new Error(`${signature} not found in the source`)
  let i = src.indexOf('{', start)
  let depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break } }
  }
  return src.slice(start, i)
}

// ------------------------------------------------------------- F3 chrome probe
{
  const fnSrc = await srcOf('async function chromePath()')
  ok('F3 the proof runs the real source (not a copy)', fnSrc.includes('fs.stat') && fnSrc.length > 200, `${fnSrc.length} chars`)
  const build = fakeFs => new Function('fs', 'path', 'process', `${fnSrc}; return chromePath`)(fakeFs, path, process)
  const missing = { stat: async () => { const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error } }
  const onlyThird = { stat: async file => ({ isFile: () => String(file).includes('AppData') }) }
  const allThere = { stat: async () => ({ isFile: () => true }) }
  let third
  try { third = await build(onlyThird)() } catch (error) { third = `threw: ${error.message}` }
  ok('F3 first-path-missing falls through to the per-user install', String(third).includes('AppData'), String(third))
  const first = await build(allThere)()
  ok('F3 probes in order when everything exists', first === 'C:/Program Files/Google/Chrome/Application/chrome.exe', first)
  let none
  try { await build(missing)(); none = 'NO THROW' } catch (error) { none = error.message }
  ok('F3 nothing installed is a defined error, not a crash', /Chrome not found/.test(none), none)
}

// ------------------------------------------------------- F2 launch identity
{
  const PORT = PROOF_PORT
  const PROFILE = PROOF_PROFILE
  const GUID = 'a1b2c3d4-1111-2222-3333-444455556666'
  const OTHER_GUID = 'ffffffff-0000-1111-2222-333333333333'
  const MARKER = path.join(PROFILE, 'driver-launch.json')
  const INSTALL = path.join(PROFILE, 'driver-install.json')
  const urlOf = guid => `ws://127.0.0.1:${PORT}/devtools/browser/${guid}`
  let servedBody = { Browser: 'Fake/1.0', 'Protocol-Version': '1.3', webSocketDebuggerUrl: urlOf(GUID) }
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(servedBody))
  })
  await new Promise(resolve => server.listen(PORT, '127.0.0.1', resolve))
  await fs.mkdir(PROFILE, { recursive: true })
  const clean = async () => { await fs.rm(MARKER, { force: true }); await fs.rm(INSTALL, { force: true }) }
  const put = (file, value) => fs.writeFile(file, JSON.stringify(value))
  const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'))
  const attempt = async () => mod.ensureChrome({ visible: false }).catch(error => ({ error: error.message }))

  ok('F2 a DevTools browser URL yields its GUID', mod.parseBrowserUrl(urlOf(GUID))?.guid === GUID)
  ok('F2 a page URL or a non-browser ws path is not a browser identity',
    mod.parseBrowserUrl('https://chatgpt.com/') === null && mod.parseBrowserUrl('ws://127.0.0.1:9222/json') === null)

  // (a) the live regression: NO marker, a dead launcher pid, and the install's
  // own record of the browser GUID that is actually serving the port. Fails
  // against the pid-checking code, which refused here.
  await clean()
  await put(INSTALL, { pid: 999999, profile: PROFILE, browserUrl: urlOf(GUID), at: new Date().toISOString() })
  const adopted = await attempt()
  ok('F2 (a) a no-marker install is adopted on its recorded browser GUID, not a dead pid',
    adopted.spawned === false && adopted.pid === 999999, JSON.stringify(adopted))
  const rewritten = await readJson(MARKER).catch(() => null)
  ok('F2 (a) adopting writes the marker back with the served GUID',
    rewritten?.browserUrl === urlOf(GUID) && rewritten?.port === PORT && rewritten?.profile === PROFILE, JSON.stringify(rewritten))

  // (b) a marker naming another browser is refused.
  await clean()
  await put(MARKER, { pid: process.pid, port: PORT, profile: PROFILE, browserUrl: urlOf(OTHER_GUID) })
  const foreign = await attempt()
  ok('F2 (b) a marker with a different browser GUID is refused',
    typeof foreign.error === 'string' && /refusing to attach/.test(foreign.error), foreign.error)

  // (c) the same GUID on another port or profile is still not ours.
  await put(MARKER, { pid: process.pid, port: 9222, profile: PROFILE, browserUrl: urlOf(GUID) })
  const otherPort = await attempt()
  ok('F2 (c) a marker with the same GUID but another port is refused',
    typeof otherPort.error === 'string' && /refusing to attach/.test(otherPort.error), otherPort.error)
  await put(MARKER, { pid: process.pid, port: PORT, profile: path.join(PROFILE, 'other'), browserUrl: urlOf(GUID) })
  const otherProfile = await attempt()
  ok('F2 (c) a marker with the same GUID but another profile is refused',
    typeof otherProfile.error === 'string' && /refusing to attach/.test(otherProfile.error), otherProfile.error)

  // The steady state: our own marker, same GUID, same port and profile.
  await put(MARKER, { pid: process.pid, port: PORT, profile: PROFILE, browserUrl: urlOf(GUID) })
  const steady = await attempt()
  ok('F2 our own marker with the served GUID is accepted without spawning',
    steady.spawned === false && steady.pid === process.pid, JSON.stringify(steady))

  // An install record naming another browser is refused too.
  await clean()
  await put(INSTALL, { pid: 1, browserUrl: urlOf(OTHER_GUID) })
  const staleInstall = await attempt()
  ok('F2 an install record naming another browser is refused',
    typeof staleInstall.error === 'string' && /refusing to attach/.test(staleInstall.error), staleInstall.error)

  // Nothing served: a debugger that is not a browser is never ours.
  await clean()
  servedBody = { Browser: 'Fake/1.0', 'Protocol-Version': '1.3' }
  const noGuid = await attempt()
  ok('F2 an endpoint that serves no browser GUID is refused',
    typeof noGuid.error === 'string' && /refusing to attach/.test(noGuid.error), noGuid.error)
  servedBody = { Browser: 'Fake/1.0', 'Protocol-Version': '1.3', webSocketDebuggerUrl: urlOf(GUID) }

  // The port-owner branch pre-record installs rely on, tested as a pure
  // decision: a stub process's command line cannot carry a Chrome profile.
  const served = { url: urlOf(GUID), guid: GUID }
  const ownerOf = (commandLine, pid = 20920) => ({ pid, commandLine })
  const verdict = facts => mod.attachVerdict({ port: PORT, profile: PROFILE, served, marker: null, install: null, owner: null, ...facts })
  ok('F2 a dead pid alone is never acceptance', verdict({ marker: { pid: 999999, port: PORT, profile: PROFILE } }).ok === false)
  ok('F2 the port owner carrying this exact --user-data-dir is accepted', (() => {
    const found = verdict({ owner: ownerOf(`chrome.exe --remote-debugging-port=${PORT} --user-data-dir="${PROFILE}"`) })
    return found.ok === true && found.pid === 20920 && found.how === 'port owner command line'
  })())
  ok('F2 a hand-written marker without a GUID can adopt through the port owner',
    verdict({ marker: { pid: 20920 }, owner: ownerOf(`chrome.exe --user-data-dir=${PROFILE}`) }).ok === true)
  ok('F2 a port owner carrying this profile with forward slashes and quotes is accepted',
    verdict({ owner: ownerOf(`chrome.exe --user-data-dir="${PROFILE.replace(/\\/g, '/')}"`) }).ok === true)
  ok('F2 a marker naming this profile in another case is the same place, not a foreign one',
    verdict({ marker: { pid: process.pid, port: PORT, profile: PROFILE.toUpperCase(), browserUrl: urlOf(GUID) } }).ok === true)
  ok('F2 a port owner on a different profile is refused',
    verdict({ owner: ownerOf('chrome.exe --user-data-dir=C:/Users/Ahmed/Other/profile') }).ok === false)
  ok('F2 no owner evidence means refusal, never a guess', verdict({}).ok === false)

  // The single chokepoint: reads, status, the observer and file downloads all
  // go through connect(), so they cannot attach to a browser ensureChrome
  // would have refused. Fails against the old code, whose reads connected
  // straight to the port.
  await clean()
  await put(MARKER, { pid: process.pid, port: PORT, profile: PROFILE, browserUrl: urlOf(OTHER_GUID) })
  const readRefusal = await mod.connect().then(() => 'CONNECTED', error => error.message)
  ok('F2 a read refuses a foreign browser instead of connecting to it',
    /refusing to attach/.test(readRefusal), readRefusal)
  await clean()
  const noEvidence = await mod.connect().then(() => 'CONNECTED', error => error.message)
  ok('F2 a read refuses when nothing proves ownership', /refusing to attach/.test(noEvidence), noEvidence)

  const source = await fs.readFile(SRC_PATH, 'utf8')
  const doors = source.match(/connectOverCDP\(/g) ?? []
  ok('F2 there is exactly one CDP door in the driver', doors.length === 1, `${doors.length} call(s)`)
  ok('F2 that door is connectOwned, which asks ownedDebugger first',
    (await srcOf('async function connectOwned')).includes('ownedDebugger('))

  server.closeAllConnections?.()
  server.close()
}

// ------------------ R5-F2 the launch window: whatever answers is not ours yet
{
  const PORT = PROOF_PORT
  const PROFILE = PROOF_PROFILE
  const GUID = 'b9c8d7e6-5555-4444-3333-222211110000'
  const urlOf = guid => `ws://127.0.0.1:${PORT}/devtools/browser/${guid}`
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ Browser: 'Fake/1.0', 'Protocol-Version': '1.3', webSocketDebuggerUrl: urlOf(GUID) }))
  })
  await new Promise(resolve => server.listen(PORT, '127.0.0.1', resolve))
  const served = { url: urlOf(GUID), guid: GUID }
  const judge = facts => mod.launchVerdict({ served, owner: null, profile: PROFILE, port: PORT, ...facts })

  // The real introspector against a real listener: this harness owns the port,
  // and its own command line names no Chrome profile.
  const owner = await mod.portOwner()
  ok('R5 (a) port owner introspection identifies the real listener',
    owner && owner.pid === process.pid && typeof owner.commandLine === 'string' && owner.commandLine.length > 0,
    JSON.stringify(owner))
  const foreign = judge({ owner })
  ok('R5 (a) a listener that binds the port without this profile is REFUSED after a launch',
    foreign.ok === false && foreign.retry === false && /refusing to adopt it as this driver's browser/.test(foreign.why),
    foreign.why)
  const chromeLine = extra => ({ pid: 4242, commandLine: `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=${PORT} --user-data-dir=${extra} --no-first-run` })
  const legitimate = judge({ owner: chromeLine(PROFILE) })
  ok('R5 (a) the legitimate owner carrying this exact --user-data-dir is adopted',
    legitimate.ok === true && legitimate.pid === 4242, JSON.stringify(legitimate))
  ok('R5 (a) the legitimate owner quoted, forward-slashed and trailing-separated is the same install',
    judge({ owner: chromeLine(`"${PROFILE.replace(/\\/g, '/')}/"`) }).ok === true)
  ok('R5 (a) an owner carrying another profile is refused',
    judge({ owner: chromeLine('C:/Users/Ahmed/Other/profile') }).ok === false)
  ok('R5 (a) a port that answers before serving a GUID is retried, never adopted',
    judge({ served: null, owner }).retry === true)
  ok('R5 (a) an owner that cannot be read is retried, never adopted',
    judge({ owner: null }).retry === true)

  // F5: the flag's VALUE is compared exactly. A path that merely starts with
  // ours is a different install, and a substring test on the whole line adopts it.
  const carries = command => mod.ownerCarriesProfile({ pid: 1, commandLine: command }, PROFILE)
  const flag = value => `chrome.exe --remote-debugging-port=${PORT} --user-data-dir=${value} --no-first-run`
  ok('R7-F5 a profile path that merely starts with ours is refused',
    carries(flag(`${PROFILE}-other`)) === false && carries(flag(`${PROFILE}2`)) === false
    && carries(`chrome.exe --user-data-dir "${PROFILE}-other"`) === false)
  ok('R7-F5 the exact profile is accepted', carries(flag(PROFILE)) === true)
  ok('R7-F5 a quoted profile is accepted', carries(flag(`"${PROFILE}"`)) === true)
  ok('R7-F5 a trailing separator is accepted', carries(flag(`${PROFILE}\\`)) === true)
  ok('R7-F5 case and forward slashes spell the same profile',
    carries(flag(PROFILE.toLowerCase().replace(/\\/g, '/'))) === true)
  ok('R7-F5 a similar but different profile is refused',
    carries(flag(PROFILE.replace('profile-attach', 'profile-attached'))) === false)
  ok('R7-F5 the space-separated spelling of the flag is read too',
    carries(`chrome.exe --user-data-dir "${PROFILE}" --no-first-run`) === true)
  ok('R7-F5 the driver no longer substring-matches the whole command line',
    !/line\.includes\(`--user-data-dir=\$\{tidy\(profile\)\}`\)/.test(await fs.readFile(SRC_PATH, 'utf8')))
  // Before/after on the same facts: the pre-fix test, run from the commit that
  // still had it, adopts the sibling profile the row above refuses.
  const preFixOwnerSrc = sourceAt('50e85ba', 'function ownerCarriesProfile(owner, profile) {')
  const preFixOwner = preFixOwnerSrc ? new Function(`${preFixOwnerSrc}; return ownerCarriesProfile`)() : null
  ok('R7-F5 mutation: the pre-fix substring test adopts a profile that only starts with ours',
    preFixOwnerSrc.length > 0 && preFixOwner({ commandLine: flag(`${PROFILE}-other`) }, PROFILE) === true
    && carries(flag(`${PROFILE}-other`)) === false,
    'old accepted it, this tree refuses it')

  // Wiring on the real source: the launch loop proves the owner BEFORE it
  // records any GUID, and a failed proof has a refusal, not a fallthrough.
  const bodyOf = (text, signature) => {
    const start = text.indexOf(signature)
    if (start < 0) return ''
    let i = start + signature.length - 1
    let depth = 0
    for (; i < text.length; i++) {
      if (text[i] === '{') depth += 1
      else if (text[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break } }
    }
    return text.slice(start, i)
  }
  const loop = bodyOf(await fs.readFile(SRC_PATH, 'utf8'), 'async function ensureChrome({ visible = true } = {}) {')
  const ownerAt = loop.indexOf('portOwner()')
  const verdictAt = loop.indexOf('launchVerdict(')
  const recordAt = loop.indexOf('writeLaunchMarker(')
  ok('R5 (a) the launch loop asks the port owner and judges before it records a GUID',
    ownerAt > 0 && verdictAt > ownerAt && recordAt > verdictAt, `${ownerAt}/${verdictAt}/${recordAt}`)
  ok('R5 (a) a refused launch throws instead of recording the foreign GUID',
    /if \(!verdict\.retry\) throw new Error\(verdict\.why\)/.test(loop))
  // Mutation check: the pre-fix blob recorded whatever answered first, which is
  // exactly what the cases above now refuse.
  const oldSrc = await baselineSource()
  const oldLoop = bodyOf(oldSrc, 'async function ensureChrome({ visible = true } = {}) {')
  ok('R5 (a) mutation: the pre-fix launch loop recorded a GUID with no owner check',
    oldLoop.length > 0 && !oldLoop.includes('portOwner') && !oldLoop.includes('launchVerdict') && oldLoop.includes('writeLaunchMarker('),
    `${oldLoop.includes('portOwner')}/${oldLoop.includes('launchVerdict')}`)

  server.closeAllConnections?.()
  server.close()
}

// ------- R5-C CHATGPT_CHROME: the launch window, end to end, with no Chrome
{
  const PORT = PROOF_PORT
  const PROFILE = PROOF_PROFILE
  const GUID = 'd0d0d0d0-2222-3333-4444-555566667777'
  const urlOf = guid => `ws://127.0.0.1:${PORT}/devtools/browser/${guid}`
  const stub = STUB_PATH
  const decoy = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe'
  const MARKER = path.join(PROFILE, 'driver-launch.json')
  const INSTALL = path.join(PROFILE, 'driver-install.json')
  const exists = async file => !!(await fs.stat(file).catch(() => null))
  const clean = async () => { await fs.rm(MARKER, { force: true }); await fs.rm(INSTALL, { force: true }) }
  const launch = async mod => mod.ensureChrome({ visible: false }).then(value => ({ value }), error => ({ error: error.message }))
  const stubOf = profile => spawn(process.execPath, [stub, String(PORT), '1200', GUID, ...(profile ? [`--user-data-dir=${profile}`] : [])], { stdio: ['ignore', 'pipe', 'ignore'] })

  // The override decides the spawn, and an override that is not a file is a
  // defined error rather than a silent fall through to the install search.
  const fnSrc = await srcOf('async function chromePath()')
  const build = (fakeFs, fakeProcess) => new Function('fs', 'path', 'process', `${fnSrc}; return chromePath`)(fakeFs, path, fakeProcess)
  const realish = { stat: async file => ({ isFile: () => String(file) === 'C:/stub/chrome.exe' }) }
  ok('R5 (c) CHATGPT_CHROME decides the spawn path',
    (await build(realish, { env: { CHATGPT_CHROME: 'C:/stub/chrome.exe' } })()) === 'C:/stub/chrome.exe')
  let notFile
  try { await build({ stat: async () => { const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error } }, { env: { CHATGPT_CHROME: 'C:/stub/gone.exe' } })(); notFile = 'NO THROW' } catch (error) { notFile = error.message }
  ok('R5 (c) an override that points at no file is refused, never silently ignored', /not a file/.test(notFile), notFile)

  process.env.CHATGPT_CHROME = decoy
  // (1) The stub binds the port WITHOUT this profile. The real ensureChrome
  // path spawns, sees the port, and must refuse - recording nothing.
  await clean()
  let foreignStub = stubOf(null)
  const foreign = await launch(mod)
  ok('R5 (c) a stub that binds the port without this profile is refused by a real launch',
    typeof foreign.error === 'string' && /refusing to adopt it as this driver's browser/.test(foreign.error), foreign.error)
  ok('R5 (c) a refused launch records no launch marker and no install record',
    !(await exists(MARKER)) && !(await exists(INSTALL)))
  foreignStub.kill()

  // (2) The positive control: the port owner carries this exact profile.
  await clean()
  let legitStub = stubOf(PROFILE)
  const adopted = await launch(mod)
  ok('R5 (c) the stub carrying this exact --user-data-dir is adopted by a real launch',
    adopted.value?.spawned === true, JSON.stringify(adopted))
  const marker = JSON.parse(await fs.readFile(MARKER, 'utf8').catch(() => 'null'))
  const install = JSON.parse(await fs.readFile(INSTALL, 'utf8').catch(() => 'null'))
  ok('R5 (c) the adopted marker holds the served GUID, not the stub\'s own pid claim',
    marker?.browserUrl === urlOf(GUID) && marker?.port === PORT, JSON.stringify(marker))
  ok('R5 (c) the override is never written into the marker or the install record',
    !JSON.stringify(marker).toLowerCase().includes('cmd.exe') && !JSON.stringify(install).toLowerCase().includes('cmd.exe')
    && !JSON.stringify(marker).includes(decoy) && !JSON.stringify(install).includes(decoy))
  const logTail = await fs.readFile(path.join(os.homedir(), '.chatgpt-web', 'driver.log'), 'utf8').then(text => text.slice(-65536)).catch(() => '')
  ok('R5 (c) the spawn the override decided is logged',
    /spawning .* by CHATGPT_CHROME override/.test(logTail), 'driver.log')
  legitStub.kill()

  // (3) Mutation: with the verdict guard removed the same foreign stub is
  // adopted, so the guard is what the refusal above rests on.
  await clean()
  const source = await fs.readFile(SRC_PATH, 'utf8')
  const mutated = source.replace('if (verdict.ok) {', 'if (true) {')
  ok('R5 (c) the mutation really removed the guard', mutated !== source && /if \(true\) \{/.test(mutated))
  const mutatedFile = path.join(os.tmpdir(), 'd5proof', 'mutated-chatgpt.mjs')
  await fs.writeFile(mutatedFile, mutated)
  const mutatedMod = await import(`file:///${mutatedFile.replace(/\\/g, '/')}`)
  let foreignStub2 = stubOf(null)
  const loose = await launch(mutatedMod)
  const looseMarker = JSON.parse(await fs.readFile(MARKER, 'utf8').catch(() => 'null'))
  ok('R5 (c) mutation: without the guard the foreign stub is adopted and its GUID recorded',
    loose.value?.spawned === true && looseMarker?.browserUrl === urlOf(GUID), JSON.stringify(looseMarker))
  foreignStub2.kill()
  await clean()
  delete process.env.CHATGPT_CHROME
}

// ---- R5-D the exhausted launch window: "no browser yet", not "wrong browser"
{
  const PORT = PROOF_PORT
  const PROFILE = PROOF_PROFILE
  const GUID = 'e1e2e3e4-5555-4444-3333-222211110000'
  const stub = STUB_PATH
  const decoy = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe'
  const MARKER = path.join(PROFILE, 'driver-launch.json')
  const INSTALL = path.join(PROFILE, 'driver-install.json')
  const exists = async file => !!(await fs.stat(file).catch(() => null))

  // The two failures must be told apart from the log alone.
  const spent = mod.exhaustedLaunchWhy({ port: PORT, served: { guid: null }, owner: { pid: 777 }, waitedMs: 3004 })
  const refused = mod.launchVerdict({ served: { guid: GUID, url: `ws://127.0.0.1:${PORT}/devtools/browser/${GUID}` }, owner: { pid: 777, commandLine: 'chrome.exe --user-data-dir=C:/elsewhere' }, profile: PROFILE, port: PORT }).why
  ok('R5 (d) the exhausted window names the last observed owner', /pid 777/.test(spent), spent)
  ok('R5 (d) the exhausted window does not borrow the refusal wording',
    !/refusing to adopt it as this driver's browser/.test(spent) && spent !== refused, spent)
  ok('R5 (d) an unreadable owner still reads distinctly',
    /an owner that could not be read/.test(mod.exhaustedLaunchWhy({ port: PORT, served: null, owner: null, waitedMs: 3000 })))

  // End to end: the port answers, but never serves a GUID. A real launch has to
  // run the window out and report "no browser yet", recording nothing.
  await fs.rm(MARKER, { force: true }); await fs.rm(INSTALL, { force: true })
  process.env.CHATGPT_CHROME = decoy
  const stubChild = spawn(process.execPath, [stub, String(PORT), '600', '-'], { stdio: ['ignore', 'pipe', 'ignore'] })
  const outcome = await mod.ensureChrome({ visible: false }).then(value => ({ value }), error => ({ error: error.message }))
  ok('R5 (d) a window with no GUID runs out with the exhausted message, not the refusal',
    typeof outcome.error === 'string' && /could not be proven to be this install's browser within/.test(outcome.error)
    && !/refusing to adopt it as this driver's browser/.test(outcome.error), outcome.error)
  ok('R5 (d) an exhausted window records no launch marker and no install record',
    !(await exists(MARKER)) && !(await exists(INSTALL)))
  stubChild.kill()
  delete process.env.CHATGPT_CHROME
}

// ------------------------- F9 acceptance without the user-node selector (R3-F5 residual)
{
  const body = {
    mapping: {
      a: { id: 'a', message: { author: { role: 'user' }, content: { parts: ['hello there,   please help'] } } },
      b: { id: 'b', message: { author: { role: 'assistant' }, content: { parts: ['hi'] } } },
    },
  }
  const treeOf = entries => ({ mapping: Object.fromEntries(entries) })
  const userNode = (key, parts) => [key, { id: key, message: { author: { role: 'user' }, content: { parts } } }]
  const assistantNode = (key, parts) => [key, { id: key, message: { author: { role: 'assistant' }, content: { parts } } }]
  const baselineOf = tree => mod.userTreeNodes(tree)
  const freshOf = (before, after) => mod.newUserNodes(baselineOf(before), baselineOf(after))

  ok('F9 a user node is read under its full normalized text',
    mod.userTreeNodes(body)?.get('m:a') === 'hello there, please help')
  ok('F9 an assistant node is not a user node',
    mod.userTreeNodes({ mapping: { b: body.mapping.b } })?.size === 0)
  ok('F9 an unreadable body has no nodes at all', mod.userTreeNodes(null) === null)
  ok('F9 normalization collapses whitespace only, never the content',
    mod.normalizedTurnText('  a \n\t b  ') === 'a b')

  const v = (over = {}) => mod.degradedSendVerdict({ userNodes: 0, newNodes: [], sentText: 'hello there, please help', ...over })
  ok('R5 (b) no new user node is no acceptance, whatever the page rendered', v() === false)
  ok('R5 (b) exactly one new node with our full text is acceptance',
    v({ newNodes: ['hello there,   please help'] }) === true)
  ok('R5 (b) a page WITH user nodes is never decided by this fallback',
    v({ userNodes: 1, newNodes: ['hello there, please help'] }) === false)
  ok('R5 (b) the verdict takes no message count at all', (() => {
    const source = mod.degradedSendVerdict.toString()
    return !/afterMessages|beforeMessages|treeAvailable|treeCount|baselineCount/.test(source)
  })(), 'no undifferentiated growth')

  // F6: an older turn with the SAME words is not this send. A node already in
  // the baseline is never new, however its text compares.
  const history = treeOf([userNode('h', ['hello there, please help']), assistantNode('t', ['ok'])])
  const grew = treeOf([...Object.entries(history.mapping), userNode('n', ['hello there,   please help'])])
  ok('R7-F6 historical identical text with no new node is not acceptance',
    mod.degradedSendVerdict({ userNodes: 0, newNodes: freshOf(history, history), sentText: 'hello there, please help' }) === false,
    `fresh=${JSON.stringify(freshOf(history, history))}`)
  ok('R7-F6 a new node carrying our text is acceptance',
    mod.degradedSendVerdict({ userNodes: 0, newNodes: freshOf(history, grew), sentText: 'hello there, please help' }) === true,
    `fresh=${JSON.stringify(freshOf(history, grew))}`)
  ok('R7-F6 an unchanged tree after the send is not acceptance',
    mod.degradedSendVerdict({ userNodes: 0, newNodes: [], sentText: 'hello there, please help' }) === false)
  ok('R7-F6 with no baseline the tree is not acceptance even when it holds our text',
    mod.degradedSendVerdict({ userNodes: 0, newNodes: mod.newUserNodes(null, baselineOf(history)), sentText: 'hello there, please help' }) === false)
  ok('R7-F6 a DOM user node present means the DOM path decides, not this fallback',
    mod.degradedSendVerdict({ userNodes: 2, newNodes: ['hello there, please help'], sentText: 'hello there, please help' }) === false)
  ok('R7-F6 the baseline is taken before the send, from the page tree',
    /const readTree = \(\) => readUserTreeOnPage\(page, /.test(await fs.readFile(SRC_PATH, 'utf8'))
    && /const beforeTree = treeOutcome\.value/.test(await fs.readFile(SRC_PATH, 'utf8')))
  ok('R7-F6 a DOM baseline with user nodes is not a tree baseline',
    mod.degradedSendVerdict({ userNodes: 0, newNodes: null, sentText: 'hello there, please help' }) === false,
    'a mid-turn selector rename must not turn history into acceptance')
  ok('R7-F6 the degraded check receives that baseline',
    /treeSendEvidence\(page, text, treeBaseline\)/.test(await fs.readFile(SRC_PATH, 'utf8'))
    && /treeBaseline: beforeTree/.test(await fs.readFile(SRC_PATH, 'utf8')))

  // R3-F5 residual (round 8): the proof must be THIS send's FULL text, not a
  // 40-character prefix that another bus prompt sharing the boilerplate opener
  // would also satisfy.
  const sent = 'Please review the following patch and list every defect you find in the parser, in order.'
  const sharedPrefix = sent.slice(0, 40)
  const otherBusPrompt = `${sharedPrefix} ALSO summarise the changelog and translate it into French.`
  ok('R8 full-text match accepts',
    mod.degradedSendVerdict({ userNodes: 0, newNodes: [sent], sentText: sent }) === true)
  ok('R8 a new node sharing the first 40 characters but differing later refuses',
    otherBusPrompt.startsWith(sharedPrefix)
    && mod.degradedSendVerdict({ userNodes: 0, newNodes: [otherBusPrompt], sentText: sent }) === false,
    'a shared boilerplate prefix is not identity')
  ok('R8 two new user nodes, one of them matching, refuse',
    mod.degradedSendVerdict({ userNodes: 0, newNodes: [sent, 'a different prompt'], sentText: sent }) === false)
  ok('R8 a node identical to one already in the baseline refuses',
    (() => {
      const before = treeOf([userNode('h', [sent])])
      const after = treeOf([userNode('h', [sent])])
      return mod.newUserNodes(baselineOf(before), baselineOf(after)).length === 0
        && mod.degradedSendVerdict({ userNodes: 0, newNodes: freshOf(before, after), sentText: sent }) === false
    })(),
    'the same node is never new')
  ok('R8 a recycled identity is not new even with different text',
    (() => {
      const before = treeOf([userNode('x', ['an older turn'])])
      const after = treeOf([userNode('x', [sent])])
      return mod.newUserNodes(baselineOf(before), baselineOf(after)).length === 0
        && mod.degradedSendVerdict({ userNodes: 0, newNodes: freshOf(before, after), sentText: sent }) === false
    })(),
    'an id present at baseline can never accept')
  ok('R8 a null baseline refuses',
    mod.degradedSendVerdict({ userNodes: 0, newNodes: mod.newUserNodes(null, baselineOf(treeOf([userNode('n', [sent])]))), sentText: sent }) === false)
  ok('R8 an empty sent text is never acceptance',
    mod.degradedSendVerdict({ userNodes: 0, newNodes: [''], sentText: '   ' }) === false)

  // Mutation: the pre-fix verdict accepted a bare "our text is somewhere in the
  // tree", which this one cannot express - it needs exactly one NEW turn.
  const preFix = await baselineSource()
  ok('R7-F6 mutation: the pre-fix verdict accepted our text anywhere in the tree',
    /if \(tree === true\) return true/.test(preFix) && !/if \(tree === true\) return true/.test(await fs.readFile(SRC_PATH, 'utf8')),
    'pre-fix accepted without a baseline; current verdict does not')
  // Before/after on the same facts: the commit before this fix still had the
  // no-baseline verdict, and it accepts the identical historical message.
  const preFixVerdictSrc = sourceAt('50e85ba', 'function degradedSendVerdict({ userNodes, tree }) {')
  const preFixVerdict = preFixVerdictSrc ? new Function(`${preFixVerdictSrc}; return degradedSendVerdict`)() : null
  const historical = [...mod.userTreeNodes(history).values()].includes('hello there, please help')
  ok('R7-F6 mutation: the pre-fix verdict accepts an older identical message in the tree',
    preFixVerdictSrc.length > 0 && historical === true && preFixVerdict({ userNodes: 0, tree: historical }) === true
    && mod.degradedSendVerdict({ userNodes: 0, newNodes: freshOf(history, history), sentText: 'hello there, please help' }) === false,
    'old accepted history; this tree needs exactly one new turn')
  // Mutation: the pre-fix source accepted a risen message count with the tree
  // unreadable, which is the false positive the new verdict cannot express.
  const oldSrc = await baselineSource()
  ok('R5 (b) mutation: the pre-fix fallback returned true on a risen message count',
    /Number\(afterMessages\) > Number\(beforeMessages\)/.test(oldSrc),
    'old degradedSendVerdict counted messages')
  const src = await fs.readFile(SRC_PATH, 'utf8')
  ok('R5 (b) the driver has no message-count acceptance path left',
    !/MESSAGE_NODES|afterMessages|beforeMessages/.test(src), 'no count fallback in chatgpt.mjs')
  ok('R5 (b) the degraded check is called with a new-node set, not a count',
    /treeSendEvidence\(page, text, treeBaseline\)/.test(src)
    && /treeBaseline: beforeTree/.test(src)
    && /const fresh = newUserNodes\(baseline, userTreeNodes\(read\.body\)\)/.test(src)
    && !/countUserTextInTree|countUserTextOnPage|treeHasSentText/.test(src))
}

// ------------------------- F4 a rejected fill must never double the composer
{
  // A prompt whose 9,495th char is the live splice point, reproduced without a page.
  const S = Array.from({ length: 9608 }, (_, i) => 'abcdefghij'[i % 10]).join('')
  const harness = ({ fill = 'ok', insertFails = 0, pressWorks = true, startText = '', caret = null, readFails = false } = {}) => {
    let content = startText
    const calls = { click: 0, focus: 0, fill: 0, insert: 0 }
    // Every option bag each action was called with: the bounded-timeout rows
    // read these rather than trusting the source.
    const options = { click: [], focus: [], fill: [], evaluate: [] }
    const composer = {
      click: async opts => { calls.click += 1; options.click.push(opts) },
      focus: async opts => { calls.focus += 1; options.focus.push(opts) },
      fill: async (value, opts) => {
        calls.fill += 1
        options.fill.push(opts)
        if (fill === 'reject-untouched') throw new Error('fill refused without writing')
        content = fill === 'reject-partial' ? value.slice(0, 9495) : value
        if (fill !== 'ok') throw new Error('fill rejected after writing')
      },
      evaluate: async (...args) => {
        options.evaluate.push(args[2])
        if (readFails) throw new Error('the composer did not answer')
        return content
      },
    }
    const page = {
      keyboard: {
        press: async key => {
          if (!pressWorks) return
          if (key === 'Control+A' || key === 'Delete' || key === 'Backspace') content = ''
        },
        // The caret is where a failed fill left it; insert lands THERE, not at 0.
        insertText: async value => {
          calls.insert += 1
          if (calls.insert <= insertFails) return
          content = caret === null ? content + value : content.slice(0, caret) + value + content.slice(caret)
        },
      },
    }
    return { page, composer, calls, options, read: () => content }
  }

  // Red on the pre-fix branch, reproduced verbatim (chatgpt.mjs 1306-1307 at 1a88bb9).
  {
    const h = harness({ fill: 'reject-after-write', caret: 9495 })
    await h.composer.click()
    const typed = await h.composer.fill(S).then(() => true).catch(() => false)
    if (!typed) await h.page.keyboard.insertText(S)
    ok('F4 mutation: the pre-fix branch doubles a prompt its fill wrote then rejected',
      h.read() === S.slice(0, 9495) + S + S.slice(9495) && h.read().length === S.length * 2,
      `len=${h.read().length} of ${S.length}, splice at 9495`)
  }

  // Green: the shipped path can only ever hold the text once.
  {
    // The empty-composer fast path: focus plus ONE insert, and no fill or click
    // at all - the speed change, proved by the call counters.
    const h = harness()
    const steps = []
    const composed = await mod.composeExactlyOnce(h.page, h.composer, S, (label, ms) => steps.push([label, ms]))
    ok('F4 an empty composer takes ONE insert and no fill or click',
      composed === true && h.read() === S && h.calls.insert === 1 && h.calls.fill === 0 && h.calls.click === 0,
      `len=${h.read().length} insert=${h.calls.insert} fill=${h.calls.fill} click=${h.calls.click}`)
    ok('F4 every composer action is bounded at 2000 ms',
      h.options.evaluate.every(opts => opts?.timeout === 2_000)
      && h.options.focus.every(opts => opts?.timeout === 2_000),
      `evaluate=${JSON.stringify(h.options.evaluate.map(opts => opts?.timeout))} focus=${JSON.stringify(h.options.focus.map(opts => opts?.timeout))}`)
    ok('F4 the compose steps are labelled so a slow compose cannot hide',
      steps.map(([label]) => label).join(',') === 'compose_clear,compose_type,compose_verify'
      && steps.every(([, ms]) => Number.isInteger(ms) && ms >= 0),
      steps.map(([label, ms]) => `${label}:${ms}`).join(' '))
  }
  {
    // A rejected fill is never "repaired" by a second insert at the caret: the
    // first insert did not land, the fill wrote then rejected, and the text is
    // cleared and typed exactly ONCE more.
    const h = harness({ insertFails: 1, fill: 'reject-after-write' })
    const composed = await mod.composeExactlyOnce(h.page, h.composer, S)
    ok('F4 a fill that writes then rejects composes the text exactly once',
      composed === true && h.read() === S && h.calls.fill === 1, `len=${h.read().length} fill=${h.calls.fill}`)
  }
  {
    const h = harness({ insertFails: 1, fill: 'reject-partial' })
    const composed = await mod.composeExactlyOnce(h.page, h.composer, S)
    ok('F4 a partial fill is cleared, then typed once',
      composed === true && h.read() === S, `len=${h.read().length}`)
  }
  {
    // The live doubling shape: the fill wrote the whole prompt and rejected.
    // Nothing may append on top of it; the turn is refused with no text.
    const h = harness({ insertFails: 9, fill: 'reject-after-write' })
    const composed = await mod.composeExactlyOnce(h.page, h.composer, S)
    ok('F4 a rejected fill is never followed by an insert at its caret',
      composed === false && h.read() === '' && h.read() !== S.slice(0, 9495) + S + S.slice(9495),
      `len=${h.read().length}`)
  }
  {
    const h = harness({ fill: 'reject-untouched', startText: 'stale words', pressWorks: false, insertFails: 9 })
    const composed = await mod.composeExactlyOnce(h.page, h.composer, S)
    ok('F4 a composer that will not clear is refused, never typed over',
      composed === false && h.read() === 'stale words')
  }
  {
    // An insert that cannot land falls back to one bounded fill.
    const h = harness({ insertFails: 9, fill: 'ok' })
    const composed = await mod.composeExactlyOnce(h.page, h.composer, S)
    ok('F4 an insert that does not land falls back to one bounded fill',
      composed === true && h.read() === S && h.calls.fill === 1, `len=${h.read().length} fill=${h.calls.fill}`)
  }
  {
    const h = harness({ startText: 'an older unsent prompt' })
    const composed = await mod.composeExactlyOnce(h.page, h.composer, S)
    ok('F4 a clean insert over prior content yields exactly the text',
      composed === true && h.read() === S && h.calls.insert === 1,
      `len=${h.read().length} insert=${h.calls.insert} fill=${h.calls.fill}`)
  }
  {
    const h = harness({ startText: S })
    const composed = await mod.composeExactlyOnce(h.page, h.composer, S)
    ok('F4 a composer already holding the text is left untouched',
      composed === true && h.read() === S && h.calls.insert === 0 && h.calls.fill === 0 && h.calls.click === 0,
      `insert=${h.calls.insert} fill=${h.calls.fill} click=${h.calls.click}`)
  }
  {
    // An unreadable composer cannot be proven to hold the text, so the turn is
    // refused rather than sent on a guess.
    const h = harness({ readFails: true })
    const composed = await mod.composeExactlyOnce(h.page, h.composer, S)
    ok('F4 an unreadable composer refuses the turn instead of sending',
      composed === false, `insert=${h.calls.insert} fill=${h.calls.fill}`)
  }
  {
    const h = harness({ fill: 'ok' })
    const composed = await mod.composeExactlyOnce(h.page, h.composer, '   ')
    ok('F4 an empty request is never typed', composed === false && h.read() === '')
  }

  const srcNow = await fs.readFile(SRC_PATH, 'utf8')
  ok('F4 the driver no longer inserts after a fill it did not verify',
    !/const typed = await composer\.fill\(text\)[\s\S]{0,80}if \(!typed\) await page\.keyboard\.insertText\(text\)/.test(srcNow)
    && /composeExactlyOnce\(page, composer, text,/.test(srcNow))
  // No pre-click composer action anywhere is left at Playwright's 30 s default.
  ok('SPEED no composer action is left at the default actionability wait',
    !/composer\.click\(\s*\)/.test(srcNow)
    && !/composer\.fill\(\s*text\s*\)(?!\s*,)/.test(srcNow)
    && !/composer\.focus\(\s*\)/.test(srcNow)
    && !/el\.textContent \?\? ''\)\)\.catch/.test(srcNow))
  const preFixAsk = sourceAt('1a88bb9', 'async function ask(page, text, { newChat = false, threadId = null, onAccepted = null, attachments = null, wait = true } = {})')
  ok('F4 mutation: the pre-fix send path carried the unconditional insertText fallback',
    /if \(!typed\) await page\.keyboard\.insertText\(text\)/.test(preFixAsk),
    'the 22:40 doubling came from this branch')
}

// ---------------------------------- N2 the pushed phase belongs to the LATEST turn
{
  const sampleSrc = await srcOf('const sample = () => {')
  const stateNode = state => ({ getAttribute: name => (name === 'data-talvt-turn-state' ? state : null), parentElement: null, textContent: '' })
  const bubbleOf = (state, text = '') => ({ getAttribute: () => null, parentElement: stateNode(state), textContent: text })
  const run = (bubbles, states) => {
    const factory = new Function('document', `
      let lastThread = null
      let lastPhase = null
      const events = []
      const send = value => events.push(value)
      const classify = value => {
        const text = String(value || '').toLowerCase()
        if (!text) return null
        return /complete/.test(text) ? 'complete' : 'streaming'
      }
      const FAILURE = /(this response couldn't load|couldn't load|something went wrong|you've reached (your )?limit|unusual activity|verify you are human|error generating|network error)/i
      const threadOf = () => 'thread-1'
      ${sampleSrc}
      sample()
      return events
    `)
    const events = factory({ querySelectorAll: selector => (selector.includes('talvt') ? states : bubbles) })
    return events.filter(event => event.event === 'signal').at(-1)?.phase ?? null
  }

  // The live shape: a finished turn, plus one stale in_progress node from an
  // abandoned turn. The old loop broke at that stale node and pushed streaming.
  ok('N2 a completed newest turn wins over a stale in_progress node',
    run([bubbleOf('complete')], [stateNode('in_progress'), stateNode('complete'), stateNode('in_progress')]) === 'complete')
  ok('N2 a live newest turn is streaming wherever earlier nodes sit',
    run([bubbleOf('in_progress')], [stateNode('complete'), stateNode('complete')]) === 'streaming')
  ok('N2 the failure chip still wins on the newest bubble',
    run([bubbleOf('in_progress', "This response couldn't load")], []) === 'failed')
  ok('N2 with no bubble the LAST state node decides, not the first live one',
    run([], [stateNode('complete'), stateNode('complete')]) === 'complete' && run([], [stateNode('complete'), stateNode('in_progress')]) === 'streaming')
}

// ----------------------------------- F8 status never says unknown for a live turn
{
  const ID = '6ae4bfc0-1111-2222-3333-444455556666'
  const OTHER = 'bbbbbbbb-1111-2222-3333-444455556666'
  const live = (over = {}) => ({ askable: true, page: true, thread: ID, live: true, ...over })
  const v = (pushed, liveArg, phase = null) => mod.statusVerdict({ pushed, phase, live: liveArg, threadId: ID })

  // The DOM reader itself, run from the real source against a fake page: the
  // three signs the requirement names, plus the zero-size Stop trap.
  const fnSrc = await srcOf('function liveTurnSample()')
  const runSample = (states, { stop = 'absent', size = { width: 10, height: 10 } } = {}) => {
    const stops = stop === 'absent' ? [] : [{ getBoundingClientRect: () => (stop === 'shown' ? size : { width: 0, height: 0 }) }]
    const nodes = states.map(state => ({ getAttribute: () => state, getBoundingClientRect: () => size }))
    const build = new Function('document', 'getComputedStyle', `${fnSrc}; return liveTurnSample`)
    return build({ querySelectorAll: selector => (selector.includes('talvt') ? nodes : stops) },
      () => ({ visibility: 'visible', display: 'block', opacity: '1' }))()
  }
  ok('F8 DOM: in_progress is a live turn', runSample(['in_progress']).live === true)
  ok('F8 DOM: streaming/thinking is a live turn', runSample(['thinking']).live === true)
  ok('F8 DOM: complete is not a live turn', runSample(['complete']).live === false)
  ok('F8 DOM: an unknown word is treated as still being written', runSample(['queued']).live === true)
  ok('F8 DOM: a visible Stop control alone is a live turn', runSample(['complete'], { stop: 'shown' }).live === true)
  ok('F8 DOM: the zero-size Stop control between turns is not', runSample(['complete'], { stop: 'hidden' }).live === false)

  // (a) the live defect: no push (or an old one) while the page is mid-turn.
  ok('F8 (a) a live page with no push is generating, not unknown',
    v('unknown', live()).state === 'generating' && v('unknown', live()).cost === 'page')
  ok('F8 (a) a stale idle push is overridden by a live page',
    v('idle', live()).state === 'generating')

  // (b) a pushed generating is not downgraded without the answer being proven;
  // the DOM showing complete is not proof, and this path reads no answer.
  const downgraded = v('generating', live({ live: false }))
  ok('F8 (b) page-complete with a pushed generating stays generating (no proof here)',
    downgraded.state === 'generating' && downgraded.cost === 'push')
  ok('F8 (b) a pushed failure is final even while the bubble says in_progress',
    v('failed', live()).state === 'failed')

  // (c) unknown only when the driver cannot be asked at all.
  ok('F8 (c) no debugger to ask is unknown', v('unknown', { askable: false }).state === 'unknown')
  ok('F8 (c) no ChatGPT tab is unknown', v('unknown', { askable: true, page: false }).state === 'unknown')
  ok('F8 (c) no push and no live turn is idle, with the reason stated',
    v('unknown', live({ live: false })).state === 'idle' && /no live turn/.test(v('unknown', live({ live: false })).evidence ?? ''))

  // The page's thread decides attribution.
  ok('F8 a live turn on another thread is not our generating',
    v('unknown', live({ thread: OTHER })).state === 'other-thread')
}

// ------------------------------------------------------------ F7 base64 shape
{
  const dec = (value) => {
    try { return { bytes: mod.decodeBase64(value, 'proof').toString('latin1') } } catch (error) { return { error: error.message } }
  }
  ok('F7 a canonical payload decodes', dec('QQ==').bytes === 'A')
  ok('F7 whitespace-wrapped base64 still decodes', dec('Q Q = =\n').bytes === 'A')
  for (const [label, value] of [
    ['%%%%', '%%%%'],
    ['missing padding', 'QQ'],
    ['bad padding', 'QQ='],
    ['non-zero trailing bits', 'QR=='],
    ['empty', ''],
    ['not a string', 12],
  ]) {
    const got = dec(value)
    ok(`F7 ${label} is refused`, !!got.error, got.error ?? `decoded ${JSON.stringify(got.bytes)}`)
  }

  // Size, not shape: the old validator was a repeated group that recursed once
  // per 4-character group, so node threw "Maximum call stack size exceeded" and
  // bun silently returned false for a payload that is provably canonical. These
  // three rows are red on 222dc7c under both runtimes.
  const pseudo = bytes => {
    const buf = Buffer.allocUnsafe(bytes)
    let x = 0x2f6e2b1
    for (let i = 0; i < bytes; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff
      buf[i] = (x >>> 16) & 255
    }
    return buf
  }
  const bigBytes = pseudo(8 * 1024 * 1024 + 3)
  const bigB64 = bigBytes.toString('base64')
  const attempt = value => {
    try { return { buffer: mod.decodeBase64(value, 'proof') } } catch (error) { return { error: error.message } }
  }
  const big = attempt(bigB64)
  ok('F7 an 11 MB canonical payload is accepted, not refused as non-canonical',
    bigB64.length > 11_000_000 && !big.error
    && big.buffer.length === bigBytes.length && big.buffer.equals(bigBytes),
    big.error ?? `${bigB64.length} chars decoded to ${big.buffer?.length} bytes`)
  // The same payload with one character replaced by a non-alphabet byte must
  // still be refused - and the clean copy's acceptance above is what makes the
  // refusal attributable to the corruption rather than to the length.
  const corruptAt = 5_000_000
  const corrupt = `${bigB64.slice(0, corruptAt)}*${bigB64.slice(corruptAt + 1)}`
  const bad = attempt(corrupt)
  ok('F7 one corrupt character deep inside that payload is still refused as not canonical',
    bad.error === 'proof: the payload is not canonical base64' && !big.error,
    bad.error ?? `decoded ${bad.buffer?.length} bytes`)
  // The cap is checked before decoding and the canonicality first: a legal
  // payload just over 64 MiB must get the size refusal, with its own wording.
  const overCap = 'A'.repeat(89_478_492)
  const huge = attempt(overCap)
  ok('F7 a canonical payload over the size cap gets the cap refusal, not the canonicality one',
    huge.error === 'proof: 67108869 bytes exceeds the 67108864-byte cap',
    huge.error ?? `decoded ${huge.buffer?.length} bytes`)
}

// --------------------------------------------------- F5/R9-F1 primary DOM acceptance
{
  const pageOf = states => {
    let index = 0
    return { evaluate: async () => states[Math.min(index++, states.length - 1)] }
  }
  const ids = count => Array.from({ length: count }, (_, i) => `u${i}`)
  const after = (identities, texts) => ({ identities, texts })
  const SENT = 'Please review the following patch and list every defect you find in the parser, in order.'

  // F5: the count delta and an emptied composer are not acceptance by themselves.
  ok('F5 a page with no user nodes at all never accepts on the composer alone',
    (await mod.waitForAcceptance(pageOf([after([], [])]), { users: 0, dom: [] }, 'hello', 400)).accepted === false)
  ok('F5 a new user node carrying exactly our text is acceptance',
    (await mod.waitForAcceptance(pageOf([after(['u0'], ['hello'])]), { users: 0, dom: [] }, 'hello', 400)).accepted === true)
  ok('F5 a pre-existing user node with our text is not a send',
    (await mod.waitForAcceptance(pageOf([after(ids(3), [null, null, 'hello'])]), { users: 3, dom: ids(3) }, 'hello', 400)).accepted === false)
  ok('F5 an unreadable DOM baseline never proves acceptance',
    (await mod.waitForAcceptance(pageOf([after(['u0'], ['hello'])]), { users: 0, dom: null }, 'hello', 400)).accepted === false)

  // R9-F1: the reviewer's five-step repro. A swallowed send + a rerender that
  // empties the composer + any other new user node used to be called accepted.
  const reviewerState = { users: 11, lastUserText: 'an unrelated message', composerHolds: false }
  const oldRule = (state, priorUsers, needle) => {
    const freshUser = state.users > priorUsers
    return freshUser && (!needle || state.lastUserText.includes(needle) || !state.composerHolds)
  }
  ok('R9-F1 mutation: the pre-fix rule accepts the reviewer repro',
    oldRule(reviewerState, 10, SENT.slice(0, 40)) === true,
    'new user node, differing text, emptied composer -> accepted')
  const reviewerAfter = after([...ids(10), 'u10'], [null, null, null, null, null, null, null, null, null, null, 'an unrelated message'])
  ok('R9-F1 the shipped path refuses the reviewer repro',
    mod.newDomUserTexts(ids(10), reviewerAfter).length === 1
    && mod.sendAcceptVerdict({ newNodes: mod.newDomUserTexts(ids(10), reviewerAfter), sentText: SENT }) === false
    && (await mod.waitForAcceptance(pageOf([reviewerAfter]), { users: 10, dom: ids(10) }, SENT, 400)).accepted === false)
  // A normal single-copy send still accepts.
  const normalAfter = after([...ids(10), 'u10'], [null, null, null, null, null, null, null, null, null, null, SENT])
  ok('R9-F1 a normal single-copy send still accepts',
    mod.sendAcceptVerdict({ newNodes: mod.newDomUserTexts(ids(10), normalAfter), sentText: SENT }) === true
    && (await mod.waitForAcceptance(pageOf([normalAfter]), { users: 10, dom: ids(10) }, SENT, 400)).accepted === true)
  // Two new nodes are ambiguous even when one matches.
  ok('R9-F1 two new user nodes refuse even when one carries our text',
    mod.sendAcceptVerdict({ newNodes: [SENT, 'something else'], sentText: SENT }) === false)
  // The trade-off is deliberate, not a gap: two new nodes in one send window are
  // ambiguous and this path refuses rather than guess. It cannot strand the turn,
  // because the host settles such a turn by node identity and text on its own
  // observation pass, outside the send-acceptance question.
  ok('R9-F1 two new nodes in one window are refused as ambiguous, and the host still settles them by identity (so nothing is stranded)',
    mod.sendAcceptVerdict({ newNodes: [SENT, 'an unrelated turn'], sentText: SENT }) === false
    && [SENT, 'an unrelated turn'].filter(t => mod.promptMatches(SENT, t)).length === 1)
  // Identity: a node already at the baseline is never the new one, even recycled.
  ok('R9-F1 a recycled identity is not a new node',
    mod.newDomUserTexts(ids(10), after(ids(10), Array(10).fill(SENT))).length === 0
    && mod.sendAcceptVerdict({ newNodes: [], sentText: SENT }) === false)
  // Without ids the count delta is the only "new" signal, and the text still decides.
  ok('R9-F1 without identities the count delta still needs our full text',
    mod.sendAcceptVerdict({ newNodes: mod.newDomUserTexts([null, null], after([null, null, null], [null, null, 'a different message'])), sentText: SENT }) === false
    && mod.sendAcceptVerdict({ newNodes: mod.newDomUserTexts([null, null], after([null, null, null], [null, null, SENT])), sentText: SENT }) === true)

  // The text rule: the host's promptMatches, exactly (threads.ts:76-84).
  const long = 'x'.repeat(512)
  ok('R9-F1 equal text after whitespace normalization matches',
    mod.promptMatches('a  b\nc', 'a b c') === true)
  ok('R9-F1 a strict prefix whose shorter side is at least 512 matches (a truncated page)',
    mod.promptMatches(long, `${long} footer`) === true)
  ok('R9-F1 a prefix shorter than 512 is not identity',
    mod.promptMatches('x'.repeat(511), `${'x'.repeat(511)}y`) === false)
  ok('R9-F1 a node that merely quotes our text mid-string is not a match (host parity: no contains clause)',
    mod.promptMatches('the whole composed text', 'preface: the whole composed text; footer') === false)
  ok('R9-F1 an empty or unreadable node never matches',
    mod.promptMatches(SENT, '') === false && mod.promptMatches('', SENT) === false)

  // One decision for both paths, and the composer is no longer consulted.
  const src = await fs.readFile(SRC_PATH, 'utf8')
  ok('R9-F1 the emptied-composer disjunct is gone',
    !/composerHolds/.test(src) && !/lastUserText\.includes/.test(src))
  ok('R9-F1 the primary and degraded paths ask the same question',
    /sendAcceptVerdict\(\{ newNodes: observed, sentText: composedText \}\)/.test(src)
    && /return sendAcceptVerdict\(\{ newNodes, sentText \}\)/.test(src))
}

// --------------------------- F3 Send is clicked once; evidence decides the rest
{
  // The EFFECT, not the verdict: a fake Send button counts its own clicks and
  // the fake page's user turns react to that count, so a second click is
  // visible as a second copy of the prompt in the page state. The shipped
  // module is exercised through a copy whose ONLY difference is where log()
  // points, so the live driver's driver.log is never written.
  const SENT = 'Please review the following patch and list every defect you find in the parser, in order.'
  const ids = count => Array.from({ length: count }, (_, i) => `u${i}`)
  const shipped = await fs.readFile(SRC_PATH, 'utf8')
  const HOME_LINE = 'const HOME = os.homedir()'
  const PROOF_HOME_LINE = "const HOME = process.env.D5PROOF_HOME || os.homedir()"
  const f3Source = shipped.replace(HOME_LINE, PROOF_HOME_LINE)
  const home = path.join(os.tmpdir(), 'd5proof', 'home')
  await fs.mkdir(home, { recursive: true })
  const f3Path = path.join(os.tmpdir(), 'd5proof', `f3-${process.pid}-${Date.now()}.mjs`)
  await fs.writeFile(f3Path, f3Source)
  // Row (h) is a regression demonstration: a copy with the OLD retry restored,
  // put back by ONE asserted replacement of the shipped tail, so the only
  // difference is that block. The restored retry calls nothing that no longer
  // exists, so the copy runs on the same fake page as the shipped one.
  const NL = shipped.includes('\r\n') ? '\r\n' : '\n'
  // The tail this row restores is DERIVED from the shipped source between two
  // markers, never quoted: a quoted tail pins the proof to one version, so every
  // base that predates a tail edit failed these scaffold rows and swamped the red
  // delta. Deriving it keeps the same guarantee (the span is unique and putting
  // the old retry back is exactly reversible) on any source that has the marker.
  const TAIL_FROM = '  const outcome = await waitForAcceptance(page, baseline, text, ACCEPTANCE_TIMEOUT_MS'
  const tailStart = shipped.indexOf(TAIL_FROM)
  const tailStop = tailStart < 0 ? -1 : shipped.indexOf(`${NL}}${NL}`, tailStart)
  const NEW_TAIL = tailStart < 0 || tailStop < 0 ? '' : shipped.slice(tailStart, tailStop + `${NL}}`.length)
  const OLD_TAIL = [
    '  const outcome = await waitForAcceptance(page, baseline, text, ACCEPTANCE_TIMEOUT_MS)',
    '  if (outcome.accepted) return',
    '  const retry = await waitForSendReady(page)',
    '  if (retry.ready) {',
    '    try { await retry.send.click() } catch (error) { await log(`retry click failed: ${error.message}`) }',
    '    const again = await waitForAcceptance(page, baseline, text, ACCEPTANCE_TIMEOUT_MS)',
    '    if (again.accepted) return',
    '  }',
    "  throw new TurnError(`the page never showed the message as sent (${acceptanceEvidence(outcome)}); the retry did not land either`, { reason: 'not-posted' })",
    '}',
  ].join(NL)
  const restoredSource = f3Source.replace(NEW_TAIL, () => OLD_TAIL)
  const restoredPath = path.join(os.tmpdir(), 'd5proof', `f3-retry-${process.pid}-${Date.now()}.mjs`)
  await fs.writeFile(restoredPath, restoredSource)
  // Speed mutation: ONE asserted replacement removes the wiring that lets the
  // window probe the tree, restoring the old post-window-only ordering. The
  // swift-acceptance row below must fail on this copy.
  const MUT_FROM = "  const treeBaseline = options.treeBaseline instanceof Map ? options.treeBaseline : null"
  const MUT_TO = "  const treeBaseline = null // MUTATION: the tree is read only after the full window"
  const mutatedSource = f3Source.replace(MUT_FROM, () => MUT_TO)
  const mutatedPath = path.join(os.tmpdir(), 'd5proof', `f3-mut-${process.pid}-${Date.now()}.mjs`)
  await fs.writeFile(mutatedPath, mutatedSource)
  // Slow-appender copy: ONE asserted replacement makes every log write take
  // 120 ms, so a send path that still waits on the disk cannot hide. The probe
  // rows below require the replacement to have applied, never pass vacuously.
  const APPENDER_FROM = '  await fs.appendFile(LOG, chunk).catch(() => {})'
  const APPENDER_TO = '  await new Promise(resolve => setTimeout(resolve, 120)); await fs.appendFile(LOG, chunk).catch(() => {})'
  const slowSource = f3Source.replace(APPENDER_FROM, () => APPENDER_TO)
  const slowApplied = slowSource !== f3Source
  const slowPath = path.join(os.tmpdir(), 'd5proof', `f3-slowlog-${process.pid}-${Date.now()}.mjs`)
  await fs.writeFile(slowPath, slowSource)
  // Probe copy: the SAME source, imported with CHATGPT_CLICK_PROBE=1. The flag is
  // read once at module scope, so a copy is needed: the default copy above must
  // stay flag-off for the default-path rows.
  const probePath = path.join(os.tmpdir(), 'd5proof', `f3-probe-${process.pid}-${Date.now()}.mjs`)
  await fs.writeFile(probePath, f3Source)
  // Both windows and the probe flag are read at import; restore all three
  // immediately after.
  const priorWindow = process.env.CHATGPT_ACCEPTANCE_MS
  const priorReady = process.env.CHATGPT_SEND_READY_MS
  const priorHome = process.env.D5PROOF_HOME
  const priorProbe = process.env.CHATGPT_CLICK_PROBE
  process.env.CHATGPT_ACCEPTANCE_MS = '400'
  process.env.CHATGPT_SEND_READY_MS = '300'
  process.env.D5PROOF_HOME = home
  let f3
  let f3retry
  let f3mut
  let f3slow
  let f3probe
  try {
    f3 = await import(pathToFileURL(f3Path).href)
    f3retry = await import(pathToFileURL(restoredPath).href)
    f3mut = await import(pathToFileURL(mutatedPath).href)
    f3slow = await import(pathToFileURL(slowPath).href)
    process.env.CHATGPT_CLICK_PROBE = '1'
    f3probe = await import(pathToFileURL(probePath).href)
  } finally {
    if (priorWindow === undefined) delete process.env.CHATGPT_ACCEPTANCE_MS
    else process.env.CHATGPT_ACCEPTANCE_MS = priorWindow
    if (priorReady === undefined) delete process.env.CHATGPT_SEND_READY_MS
    else process.env.CHATGPT_SEND_READY_MS = priorReady
    if (priorHome === undefined) delete process.env.D5PROOF_HOME
    else process.env.D5PROOF_HOME = priorHome
    if (priorProbe === undefined) delete process.env.CHATGPT_CLICK_PROBE
    else process.env.CHATGPT_CLICK_PROBE = priorProbe
  }
  ok('F3 the proof copy differs from the shipped source only in where the log goes',
    shipped.includes(HOME_LINE) && f3Source.replace(PROOF_HOME_LINE, HOME_LINE) === shipped)
  ok('F3 the restored-retry copy differs from the shipped copy only by that tail',
    NEW_TAIL.length > 0 && shipped.split(NEW_TAIL).length === 2
    && restoredSource.split(OLD_TAIL).length === 2
    && restoredSource.replace(OLD_TAIL, () => NEW_TAIL) === f3Source)
  // The invariant, read off the shipped text, now SPLIT on the probe gate: the
  // trial call may only exist inside `if (CLICK_PROBE) { ... }`, and the default
  // path is exactly one bare dispatching `send.click()`. Counting the total alone
  // would let the trial leak back onto the default path; counting only the
  // default side would let a second dispatcher hide inside the probe block.
  const submitSrc = shipped.slice(shipped.indexOf('async function submitTurn(page,'))
  const submitBody = submitSrc.slice(0, submitSrc.indexOf(`${NL}}${NL}`) + 3)
  const probeGateAt = submitBody.indexOf('if (CLICK_PROBE) {')
  const probeEndAt = submitBody.indexOf('// The only click this function is allowed to make.')
  const hasProbeGate = probeGateAt > -1 && probeEndAt > probeGateAt
  const probeBlock = hasProbeGate ? submitBody.slice(probeGateAt, probeEndAt) : ''
  const defaultBlock = hasProbeGate
    ? submitBody.slice(0, probeGateAt) + submitBody.slice(probeEndAt)
    : submitBody
  const allClickCalls = (submitBody.match(/send\.click\(/g) || []).length
  const probeTrials = (probeBlock.match(/send\.click\(\{ trial: true[^}]*\}\)/g) || []).length
  const probeClicks = (probeBlock.match(/send\.click\(/g) || []).length
  const defaultBare = (defaultBlock.match(/send\.click\(\)/g) || []).length
  const defaultClicks = (defaultBlock.match(/send\.click\(/g) || []).length
  ok('F3 the send is clicked exactly once by default and the trial exists only inside the probe gate',
    hasProbeGate && allClickCalls === 2
    && probeClicks === 1 && probeTrials === 1 && !/send\.click\(\)/.test(probeBlock)
    && defaultClicks === 1 && defaultBare === 1 && !/trial: true/.test(defaultBlock)
    && !/scrollIntoViewIfNeeded/.test(defaultBlock)
    && !/\bretry\b|treeProvesNotPosted|provablyNotPosted/.test(submitBody)
    && !/function treeProvesNotPosted|function provablyNotPosted/.test(shipped),
    `${allClickCalls} click calls (probe ${probeTrials} trial / ${probeClicks} call, default ${defaultBare} bare / ${defaultClicks} call) in submitTurn`)
  // #104: the tree baseline is no longer taken inline. It is STARTED right after
  // the landing check (so it overlaps the composer wait, the DOM baselines and
  // the compose), and JOINED after compose but before the click. The ordering it
  // owes is only "a snapshot before the click" - typing does not touch the tree.
  const earlyStart = shipped.indexOf('let treeRead = readTree()')
  // This await is railed too (the composer recovery path is the slowest
  // pre-click step), so accept the bare or the railed call shape.
  const composerJoin = Math.max(
    shipped.indexOf('let composer = await waitForComposer(page, alreadyThere'),
    shipped.indexOf('let composer = await railed(waitForComposer(page, alreadyThere'),
  )
  const composeMark = shipped.indexOf("await phaseMark('compose')")
  // The join is railed against the send deadline, so accept either the bare
  // awaited read or the railed one; both sit in the same place in the order.
  const treeJoin = Math.max(
    shipped.indexOf('const treeOutcome = await treeRead'),
    shipped.indexOf('const treeOutcome = await railed(treeRead'),
  )
  const sendCall = shipped.indexOf('await submitTurn(page,')
  ok('F3 the tree baseline is started early, joined after compose and before the click',
    /const readTree = \(\) => readUserTreeOnPage\(page, /.test(shipped)
    && earlyStart > -1 && composerJoin > -1 && composeMark > -1 && treeJoin > -1 && sendCall > -1
    && earlyStart < composerJoin
    && treeJoin > composeMark && treeJoin < sendCall
    && /const beforeTree = treeOutcome\.value/.test(shipped)
    && !/beforeTree = beforeUsers === 0 \?/.test(shipped),
    `start=${earlyStart} < composer=${composerJoin}; compose=${composeMark} < join=${treeJoin} < send=${sendCall}`)

  const treeWith = said => ({
    mapping: Object.fromEntries(said.map((text, index) => [`k${index}`, {
      message: { id: `tm${index}`, author: { role: 'user' }, content: { parts: [text] } },
    }])),
  })
  const baselineTree = () => f3.userTreeNodes(treeWith(['an older turn']))

  const fakePage = ({ landsOnClick = 0, unrelatedOnClick = 0, treeOnClick = 0, treeReadable = true, treeRevealAtRead = 0, treeFailUntilRead = 0, userNodeCount = 0, sendReady = true, stateProbeDelayMs = 0, boxDelayMs = 0, clickDelayMs = 0, treeReadDelayMs = 0, trialDelayMs = 0, scrollDelayMs = 0, trialTimeout = false, pageRequest = true, cdpRequest = true, pageRequestPath = CONVERSATION_URL, cdpRequestPath = CONVERSATION_URL, sendResponseStatus = null, sendResponseDelayMs = 0 } = {}) => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
    const listeners = new Map()
    const emit = (name, arg) => { for (const handler of listeners.get(name) ?? []) handler(arg) }
    // #106: a CDP session the driver can open on this page. The handler list is
    // separate from the page's event listeners so the proof can tell what the
    // page events saw from what the page target's network saw.
    const cdpHandlers = new Map()
    const cdp = {
      sent: [], enabledAt: null, disabledAt: null, detached: false,
      on: (name, handler) => { const list = cdpHandlers.get(name) ?? []; list.push(handler); cdpHandlers.set(name, list) },
      send: async method => {
        cdp.sent.push(method)
        if (method === 'Network.enable') cdp.enabledAt = Date.now()
        if (method === 'Network.disable') cdp.disabledAt = Date.now()
      },
      detach: async () => { cdp.detached = true },
    }
    const context = { newCDPSession: async () => cdp }
    const state = { clicks: 0, trials: 0, trialTimeoutMs: null, scrolls: 0, pageRequests: 0, cdpRequests: 0, said: [], treeSaid: [], treeReads: 0, postAt: null, cdp }
    // Fire one CDP Network event at the handlers the driver registered. The
    // requestId is what lets a response be attributed to the send POST.
    state.fireRequest = (requestId, method, url) => {
      for (const handler of cdpHandlers.get('Network.requestWillBeSent') ?? []) handler({ requestId, request: { method, url } })
    }
    state.fireResponse = (requestId, status, url) => {
      for (const handler of cdpHandlers.get('Network.responseReceived') ?? []) handler({ requestId, response: { status, url } })
    }
    const send = {
      isVisible: async () => true,
      // The click split's probes: both are reads, and their delays let the
      // proof pin that the split is timed outside `click_end`.
      isEnabled: async () => { if (stateProbeDelayMs) await wait(stateProbeDelayMs); return sendReady },
      boundingBox: async () => { if (boxDelayMs) await wait(boxDelayMs); return { x: 0, y: 0, width: 10, height: 10 } },
      isDisabled: async () => !sendReady,
      getAttribute: async () => null,
      // #106: a TRIAL click is a check, not a click. It records its own count and
      // returns before any dispatch or request - the proof asserts exactly that.
      scrollIntoViewIfNeeded: async () => { state.scrolls += 1; if (scrollDelayMs) await wait(scrollDelayMs) },
      click: async options => {
        if (options?.trial === true) {
          state.trials += 1
          state.trialTimeoutMs = options?.timeout ?? null
          if (trialDelayMs) await wait(trialDelayMs)
          if (trialTimeout) {
            const error = new Error(`locator.click: Timeout ${options?.timeout ?? 30_000}ms exceeded.`)
            error.name = 'TimeoutError'
            throw error
          }
          return
        }
        if (clickDelayMs) await wait(clickDelayMs)
        state.clicks += 1
        if (landsOnClick && state.clicks >= landsOnClick) state.said.push(SENT)
        if (unrelatedOnClick && state.clicks >= unrelatedOnClick) state.said.push('an unrelated message')
        if (treeOnClick && state.clicks >= treeOnClick) state.treeSaid.push(SENT)
        // The page's own send POST, observable only as a request event...
        state.postAt = Date.now()
        if (pageRequest) {
          state.pageRequests += 1
          emit('request', { method: () => 'POST', url: () => pageRequestPath })
        }
        // ...or from the page target's Network domain.
        if (cdpRequest) {
          state.cdpRequests += 1
          const requestId = `send-${state.clicks}`
          state.fireRequest(requestId, 'POST', cdpRequestPath)
          // #109: the response to that POST, optionally. Emitted after the
          // request so the watcher can attribute it by requestId.
          if (sendResponseStatus !== null) {
            const reply = () => state.fireResponse(requestId, sendResponseStatus, cdpRequestPath)
            if (sendResponseDelayMs) setTimeout(reply, sendResponseDelayMs)
            else reply()
          }
        }
      },
    }
    const locator = selector => {
      const isSend = [].concat(selector).some(item => /send/i.test(String(item)))
      const node = isSend ? send : { isVisible: async () => false, innerText: async () => '' }
      return { count: async () => (isSend ? 1 : userNodeCount), first: () => node, last: () => node, nth: () => node }
    }
    const page = {
      locator,
      url: () => 'https://chatgpt.com/c/6ae4bfc0-1111-2222-3333-444455556666',
      keyboard: { press: async () => {}, insertText: async () => {} },
      context: () => context,
      on: (name, handler) => { const list = listeners.get(name) ?? []; list.push(handler); listeners.set(name, list) },
      off: (name, handler) => { const list = listeners.get(name) ?? []; listeners.set(name, list.filter(entry => entry !== handler)) },
      listenerCount: name => (listeners.get(name) ?? []).length,
      evaluate: async fn => {
        const src = String(fn)
        if (src.includes('data-testid="stop-button"')) return { stop: false, streaming: false, busy: false }
        if (src.includes('progressbar')) return false
        // The thread tree: every backend read of the acceptance path.
        if (src.includes('api/auth/session')) {
          if (treeReadDelayMs) await wait(treeReadDelayMs)
          state.treeReads += 1
          if (treeFailUntilRead && state.treeReads <= treeFailUntilRead) return { ok: false, status: 429, error: 'the backend throttled the read' }
          if (!treeReadable) return { ok: false, status: 503, error: 'the backend did not answer' }
          const revealed = [...state.treeSaid]
          if (treeRevealAtRead && state.treeReads >= treeRevealAtRead) revealed.push(SENT)
          return { ok: true, status: 200, body: treeWith(['an older turn', ...revealed]) }
        }
        if (src.includes('querySelectorAll')) {
          return {
            identities: [...ids(10), ...state.said.map((_, index) => `n${index}`)],
            texts: [...Array(10).fill(null), ...state.said],
          }
        }
        throw new Error(`unexpected page.evaluate: ${src.slice(0, 60)}`)
      },
    }
    return { page, state }
  }
  const capture = async promise => {
    try { await promise; return null } catch (error) { return error }
  }
  const copiesOf = (state) => state.said.filter(said => f3.promptMatches(SENT, said)).length
  // The proof copies' log() writes under the redirected HOME, never driver.log.
  // The log is a QUEUE, and every imported copy (f3, the restored-retry copy,
  // the mutation, the slow-appender copy and the probe-flag copy) writes to this
  // same HOME. Draining only the copy a row happens to use left another copy's
  // queued lines to land after `clearLog()` or after the read - the race that
  // made navigation rows count other rows' phase lines. Every clear AND every
  // read drains all five first, so no row can race a write no matter which copy
  // it drives.
  const drainLogs = async () => {
    for (const copy of [f3, f3retry, f3mut, f3slow, f3probe]) {
      if (typeof copy?.flushLog === 'function') await copy.flushLog()
    }
  }
  const driverLog = async () => {
    await drainLogs()
    return fs.readFile(path.join(home, '.chatgpt-web', 'driver.log'), 'utf8').catch(() => '')
  }
  const logLines = async () => (await driverLog()).trim().split(/\r?\n/).filter(Boolean)
  const clearLog = async () => {
    await drainLogs()
    await fs.rm(path.join(home, '.chatgpt-web', 'driver.log'), { force: true })
  }

  // (a) The click lands and an unrelated turn appears in the same window: the
  // page holds our prompt ONCE, nothing else is clicked, and the outcome is
  // ambiguous - never the "never left the composer" failure.
  {
    const { page, state } = fakePage({ landsOnClick: 1, unrelatedOnClick: 1 })
    const error = await capture(f3.submitTurn(page, { baseline: { users: 10, dom: ids(10) }, text: SENT }))
    ok('F3 an unrelated new turn in the window keeps one click and fails ambiguous',
      error?.reason === 'ambiguous' && state.clicks === 1 && copiesOf(state) === 1
      && !/never left the composer|not-posted/.test(error.message ?? ''),
      `clicks=${state.clicks} copies=${copiesOf(state)} reason=${error?.reason}`)
  }

  // (e) The selector stops exposing new nodes after a rerender, but the first
  // click DID submit. The tree, read once, holds exactly one new turn carrying
  // our text: that is positive acceptance - one click, one copy, no ambiguity,
  // and never `not-posted`.
  {
    const { page, state } = fakePage({ landsOnClick: 0, treeOnClick: 1 })
    const error = await capture(f3.submitTurn(page, { baseline: { users: 10, dom: ids(10) }, text: SENT, treeBaseline: baselineTree() }))
    ok('F3 (e) a stale DOM with the send already in the thread tree keeps one click and is accepted',
      error === null && state.clicks === 1 && state.treeSaid.length === 1,
      `clicks=${state.clicks} treeCopies=${state.treeSaid.length}${error ? ` error=${error.message}` : ''}`)
  }

  // (f) A tree that cannot be read is not evidence either way, so the turn
  // settles as ambiguous, names the unreadable tree, and is never not-posted.
  {
    const { page, state } = fakePage({ landsOnClick: 0, treeReadable: false })
    const error = await capture(f3.submitTurn(page, { baseline: { users: 10, dom: ids(10) }, text: SENT, treeBaseline: baselineTree() }))
    ok('F3 (f) an unreadable thread tree keeps one click and fails ambiguous, naming the tree',
      error?.reason === 'ambiguous' && state.clicks === 1
      && /could not be read/.test(error.message ?? '') && !/not-posted/.test(error.message ?? ''),
      `clicks=${state.clicks} reason=${error?.reason} message=${error?.message}`)
  }

  // (g) A swallowed click. The tree is readable and does NOT hold our text -
  // a negative observation, which licenses nothing. One click, ambiguous, and
  // the refusal says exactly what the tree showed. No second click exists.
  {
    const { page, state } = fakePage({ landsOnClick: 0, userNodeCount: 1 })
    const error = await capture(f3.submitTurn(page, { baseline: { users: 10, dom: ids(10) }, text: SENT, treeBaseline: baselineTree() }))
    ok('F3 (g) a swallowed click with a readable tree lacking our text stays at one click and fails ambiguous',
      error?.reason === 'ambiguous' && state.clicks === 1 && state.said.length === 0
      && /holds no new turn carrying this text/.test(error.message ?? ''),
      `clicks=${state.clicks} reason=${error?.reason} message=${error?.message}`)
  }

  // (c) A baseline that could not be read cannot tell zero from something, so
  // the first click is the only click.
  {
    const { page, state } = fakePage({ landsOnClick: 1 })
    const error = await capture(f3.submitTurn(page, { baseline: { users: 0, dom: null }, text: SENT }))
    ok('F3 an unreadable baseline never earns a second click and fails ambiguous',
      error?.reason === 'ambiguous' && state.clicks === 1,
      `clicks=${state.clicks} reason=${error?.reason}`)
  }

  // The ONLY not-posted outcome left: the send control never became ready, so
  // nothing was typed, nothing was clicked, and no reply is coming.
  {
    const { page, state } = fakePage({ sendReady: false })
    const error = await capture(f3.submitTurn(page, { baseline: { users: 10, dom: ids(10) }, text: SENT }))
    ok('F3 not-posted is reachable only before the click: a send control that never opens',
      error?.reason === 'not-posted' && state.clicks === 0 && state.said.length === 0
      && /never became ready to send/.test(error.message ?? '')
      // Same host keep-queued token as the compose refusal (chatgpt-peer.ts:2274).
      && /^not-posted:/.test(error.message ?? ''),
      `clicks=${state.clicks} reason=${error?.reason}`)
  }

  // G-010: the send is bounded as an OPERATION. An expired deadline settles
  // ONCE with the shape for where it expired - not-posted before the click,
  // ambiguous after it - and never a second time later.
  {
    const { page, state } = fakePage({ sendReady: false })
    let settlements = 0
    let settledWith = null
    await f3.submitTurn(page, { baseline: { users: 10, dom: ids(10) }, text: SENT, deadline: Date.now() - 1 })
      .then(() => { settlements += 1 }, error => { settlements += 1; settledWith = error })
    await new Promise(resolve => setTimeout(resolve, 250))
    ok('G010 an expired deadline before the click settles once as not-posted',
      settlements === 1 && settledWith?.reason === 'not-posted'
      && state.clicks === 0 && state.said.length === 0
      && /the send deadline passed before the Send click/.test(settledWith?.message ?? ''),
      `settlements=${settlements} reason=${settledWith?.reason} clicks=${state.clicks}`)
  }
  {
    const { page, state } = fakePage({ landsOnClick: 0 })
    let settlements = 0
    let settledWith = null
    // Shorter than the harness's 400 ms acceptance window on purpose: the
    // window is cut at the op deadline, so it expires with the click made and
    // no acceptance, which is the ambiguous refusal - not the post-window
    // "nothing appeared" one.
    await f3.submitTurn(page, { baseline: { users: 10, dom: ids(10) }, text: SENT, deadline: Date.now() + 200 })
      .then(() => { settlements += 1 }, error => { settlements += 1; settledWith = error })
    await new Promise(resolve => setTimeout(resolve, 250))
    ok('G010 an expired deadline after the click settles once as ambiguous',
      settlements === 1 && settledWith?.reason === 'ambiguous' && state.clicks === 1
      && /the send deadline passed before the page proved acceptance/.test(settledWith?.message ?? ''),
      `settlements=${settlements} reason=${settledWith?.reason} clicks=${state.clicks}`)
  }

  // (h) Regression demonstration: the same fake page against a copy with the
  // old retry restored by one asserted replacement. The second click lands and
  // puts a second copy in the tree - what the shipped code must never do.
  {
    const { page, state } = fakePage({ landsOnClick: 0, treeOnClick: 1 })
    const error = await capture(f3retry.submitTurn(page, { baseline: { users: 10, dom: ids(10) }, text: SENT, treeBaseline: baselineTree() }))
    ok('F3 (h) restoring the old retry clicks twice and copies the prompt twice',
      state.clicks === 2 && state.treeSaid.length === 2 && error?.reason === 'not-posted',
      `clicks=${state.clicks} treeCopies=${state.treeSaid.length} reason=${error?.reason}`)
  }

  // ------------------------------------------------ SPEED: concurrent tree probes
  // The measured defect: the DOM never exposes the new user turn, so the tree is
  // the only path, and it used to be read only after the full window. With the
  // shortened 400 ms window the probe schedule scales to 20/40/67/107/160/240 ms
  // (6 probes), then the ceiling evidence read is the 7th. No real 30 s sleep is
  // used anywhere here; CHATGPT_ACCEPTANCE_MS=400 is the harness mechanism.

  // (a) The tree shows the node on the FIRST probe: accepted in tens of ms, not
  // after the window, with exactly one tree read and one click.
  {
    const { page, state } = fakePage({ treeRevealAtRead: 1 })
    await clearLog()
    const t0 = Date.now()
    const error = await capture(f3.submitTurn(page, { baseline: { users: 10, dom: ids(10) }, text: SENT, treeBaseline: baselineTree() }))
    const elapsed = Date.now() - t0
    ok('SPEED (a) a tree sighting on the FIRST probe is accepted swiftly, one click',
      error === null && state.clicks === 1 && state.treeReads === 1 && elapsed < 200,
      `clicks=${state.clicks} treeReads=${state.treeReads} elapsed=${elapsed}ms (window 400ms)`)
    ok('SPEED (a) the acceptance log names the tree path and the elapsed ms',
      (await logLines()).some(line => /acceptance in \d+ms: thread tree, exactly one new turn carrying the sent text$/.test(line)),
      (await logLines()).filter(line => line.includes('acceptance in')).slice(-1)[0] ?? 'no acceptance line')
  }

  // (b) Stale on the first two probes, positive on the third: a later probe
  // still accepts, and the send is still clicked once.
  {
    const { page, state } = fakePage({ treeRevealAtRead: 3 })
    const t0 = Date.now()
    const error = await capture(f3.submitTurn(page, { baseline: { users: 10, dom: ids(10) }, text: SENT, treeBaseline: baselineTree() }))
    const elapsed = Date.now() - t0
    ok('SPEED (b) a tree sighting on a LATER probe (third) is accepted, one click',
      error === null && state.clicks === 1 && state.treeReads === 3 && elapsed < 300,
      `clicks=${state.clicks} treeReads=${state.treeReads} elapsed=${elapsed}ms`)
  }

  // (c) Stale for the whole window: ambiguous, one click, no extra copy, and the
  // probe count is bounded by the schedule plus the one ceiling read (<= 7).
  {
    const { page, state } = fakePage({ treeRevealAtRead: 0 })
    const error = await capture(f3.submitTurn(page, { baseline: { users: 10, dom: ids(10) }, text: SENT, treeBaseline: baselineTree() }))
    ok('SPEED (c) a tree stale for the whole window is ambiguous, one click, no copy, bounded probes',
      error?.reason === 'ambiguous' && state.clicks === 1 && copiesOf(state) === 0
      && state.treeReads >= 2 && state.treeReads <= 7
      && /holds no new turn carrying this text/.test(error.message ?? ''),
      `clicks=${state.clicks} treeReads=${state.treeReads} reason=${error?.reason}`)
  }

  // (d) The accepted paths above never click twice; pinned in one place.
  {
    const A = fakePage({ treeRevealAtRead: 1 })
    const B = fakePage({ treeRevealAtRead: 3 })
    await capture(f3.submitTurn(A.page, { baseline: { users: 10, dom: ids(10) }, text: SENT, treeBaseline: baselineTree() }))
    await capture(f3.submitTurn(B.page, { baseline: { users: 10, dom: ids(10) }, text: SENT, treeBaseline: baselineTree() }))
    ok('SPEED (d) the accepted path never clicks twice',
      A.state.clicks === 1 && B.state.clicks === 1 && copiesOf(A.state) === 0 && copiesOf(B.state) === 0,
      `clicks=${A.state.clicks},${B.state.clicks}`)
  }

  // (e)-(g) The counters are read directly off waitForAcceptance, so the probe
  // count and the accepting path are observable, not inferred from the log.
  {
    const W = fakePage({ treeRevealAtRead: 1 })
    const outcome = await f3.waitForAcceptance(W.page, { users: 10, dom: ids(10) }, SENT, 400, { treeBaseline: baselineTree() })
    ok('SPEED (e) waitForAcceptance accepts on the FIRST tree probe, reporting path and counters',
      outcome.accepted === true && outcome.path === 'tree' && outcome.treeProbes === 1
      && outcome.domPolls >= 1 && outcome.elapsedMs < 200,
      `path=${outcome.path} probes=${outcome.treeProbes} domPolls=${outcome.domPolls} elapsed=${outcome.elapsedMs}ms`)
  }
  {
    const W = fakePage({ treeRevealAtRead: 3 })
    const outcome = await f3.waitForAcceptance(W.page, { users: 10, dom: ids(10) }, SENT, 400, { treeBaseline: baselineTree() })
    ok('SPEED (f) waitForAcceptance accepts on a later probe, not only the first',
      outcome.accepted === true && outcome.path === 'tree' && outcome.treeProbes === 3,
      `path=${outcome.path} probes=${outcome.treeProbes} elapsed=${outcome.elapsedMs}ms`)
  }
  {
    const W = fakePage({ treeRevealAtRead: 0 })
    const outcome = await f3.waitForAcceptance(W.page, { users: 10, dom: ids(10) }, SENT, 400, { treeBaseline: baselineTree() })
    ok('SPEED (g) waitForAcceptance never accepts a stale tree and caps its in-window probes at 6',
      outcome.accepted === false && outcome.treeProbes === 6 && outcome.treeProbes <= 7,
      `accepted=${outcome.accepted} probes=${outcome.treeProbes}`)
  }

  // (h) The DOM path still decides on its own, without touching the tree.
  {
    const W = fakePage()
    W.state.said.push(SENT)
    const outcome = await f3.waitForAcceptance(W.page, { users: 10, dom: ids(10) }, SENT, 400, { treeBaseline: baselineTree() })
    ok('SPEED (h) the DOM path still accepts on its own and does not read the tree',
      outcome.accepted === true && outcome.path === 'dom' && outcome.treeProbes === 0 && W.state.treeReads === 0,
      `path=${outcome.path} probes=${outcome.treeProbes} treeReads=${W.state.treeReads}`)
  }

  // (i) A throttled/unreadable probe (429) is "no evidence yet": the window keeps
  // waiting and a later positive probe accepts. It is never an error.
  {
    const W = fakePage({ treeFailUntilRead: 2, treeRevealAtRead: 3 })
    const outcome = await f3.waitForAcceptance(W.page, { users: 10, dom: ids(10) }, SENT, 400, { treeBaseline: baselineTree() })
    ok('SPEED (i) a throttled probe is no evidence yet: later probes still accept',
      outcome.accepted === true && outcome.path === 'tree' && outcome.treeProbes === 3 && W.state.treeReads === 3,
      `path=${outcome.path} probes=${outcome.treeProbes} reads=${W.state.treeReads}`)
  }

  // (j) The DOM acceptance path emits its own stable, greppable line.
  {
    const { page, state } = fakePage({ landsOnClick: 1 })
    await clearLog()
    const error = await capture(f3.submitTurn(page, { baseline: { users: 10, dom: ids(10) }, text: SENT, treeBaseline: baselineTree() }))
    ok('SPEED (j) the DOM acceptance path logs its own greppable line',
      error === null && state.clicks === 1 && state.treeReads === 0
      && (await logLines()).some(line => /acceptance in \d+ms: DOM, exactly one new user turn carrying the sent text$/.test(line)),
      `clicks=${state.clicks} treeReads=${state.treeReads}`)
  }

  // (k) Only the seventh (ceiling) read sees the node: the existing 30 s fallback
  // log line still works, and the total is exactly seven tree reads.
  {
    const { page, state } = fakePage({ treeRevealAtRead: 7 })
    await clearLog()
    const t0 = Date.now()
    const error = await capture(f3.submitTurn(page, { baseline: { users: 10, dom: ids(10) }, text: SENT, treeBaseline: baselineTree() }))
    const elapsed = Date.now() - t0
    ok('SPEED (k) when only the ceiling read sees the tree, the old fallback log line still works',
      error === null && state.clicks === 1 && state.treeReads === 7 && elapsed >= 300
      && (await logLines()).some(line => /acceptance in \d+ms: the DOM exposed no new user turn; the thread tree shows exactly one new turn carrying the sent text$/.test(line)),
      `clicks=${state.clicks} treeReads=${state.treeReads} elapsed=${elapsed}ms`)
  }

  // #109: accept from the send response. The page's own POST answering 2xx is
  // the server acknowledging THIS click, available at header time - so the
  // per-send tree read never runs. Three rows are RED on any base without the
  // feature: the observer, the window, and the shipped wiring. The fourth is a
  // control: a non-2xx must fall back to the tree, not accept.
  {
    const W = fakePage()
    const watch = await f3.startNetworkWatch(W.page)
    const settled = (promise, ms = 60) => Promise.race([
      promise.then(value => value ?? null),
      new Promise(resolve => setTimeout(() => resolve('pending'), ms)),
    ])
    const hasSignal = watch && watch.accepted instanceof Promise
    // A 500 on the send POST is not acceptance.
    W.state.fireRequest('r500', 'POST', F_CONVERSATION_URL)
    W.state.fireResponse('r500', 500, F_CONVERSATION_URL)
    const after500 = hasSignal ? await settled(watch.accepted) : 'no-signal'
    // A 2xx on a different backend endpoint is not acceptance either.
    W.state.fireRequest('rOther', 'POST', 'https://chatgpt.com/backend-api/models')
    W.state.fireResponse('rOther', 200, 'https://chatgpt.com/backend-api/models')
    const afterOther = hasSignal ? await settled(watch.accepted, 40) : 'no-signal'
    // The page's own send POST answered 2xx: acceptance.
    W.state.fireRequest('rSend', 'POST', F_CONVERSATION_URL)
    W.state.fireResponse('rSend', 200, F_CONVERSATION_URL)
    const hit = hasSignal ? await settled(watch.accepted) : 'no-signal'
    if (typeof watch?.stop === 'function') await watch.stop()
    ok('G109 the network watcher accepts only a 2xx response to the page\'s own send POST',
      hasSignal && after500 === 'pending' && afterOther === 'pending'
      && hit && hit.status === 200 && hit.pathname === '/backend-api/f/conversation',
      `signal=${hasSignal} after500=${JSON.stringify(after500)} afterOther=${JSON.stringify(afterOther)} hit=${JSON.stringify(hit)}`)
  }
  {
    const W = fakePage({ treeRevealAtRead: 1 })
    const signal = Promise.resolve({ at: Date.now(), status: 200, pathname: '/backend-api/f/conversation' })
    const outcome = await f3.waitForAcceptance(W.page, { users: 10, dom: ids(10) }, SENT, 400, { treeBaseline: baselineTree(), responseSignal: signal })
    ok('G109 waitForAcceptance accepts from the send response with no tree read',
      outcome.accepted === true && outcome.path === 'response' && outcome.treeProbes === 0
      && W.state.treeReads === 0 && outcome.response?.status === 200,
      `path=${outcome.path} probes=${outcome.treeProbes} treeReads=${W.state.treeReads} status=${outcome.response?.status}`)
  }
  {
    const { page, state } = fakePage({ sendResponseStatus: 200, treeRevealAtRead: 1 })
    await clearLog()
    const error = await capture(f3.submitTurn(page, { baseline: { users: 10, dom: ids(10) }, text: SENT, treeBaseline: baselineTree() }))
    ok('G109 submitTurn wires the send response: one click, accepted from the POST, zero tree reads',
      error === null && state.clicks === 1 && state.treeReads === 0
      && (await logLines()).some(line => /acceptance in \d+ms: the send response, the page's own POST was answered HTTP 200$/.test(line)),
      `clicks=${state.clicks} treeReads=${state.treeReads} error=${error?.message ?? 'none'}`)
  }
  {
    const { page, state } = fakePage({ sendResponseStatus: 500, treeRevealAtRead: 1 })
    const error = await capture(f3.submitTurn(page, { baseline: { users: 10, dom: ids(10) }, text: SENT, treeBaseline: baselineTree() }))
    ok('G109 a non-2xx send response does not accept; the tree fallback still decides',
      error === null && state.clicks === 1 && state.treeReads === 1,
      `clicks=${state.clicks} treeReads=${state.treeReads} error=${error?.message ?? 'none'}`)
  }

  // (MUTATION) One asserted replacement disables the in-window tree wiring, so
  // the tree is read only after the full window. The swift row's predicate must
  // then be false - this is what makes the speed property load-bearing.
  {
    const { page, state } = fakePage({ treeRevealAtRead: 1 })
    const t0 = Date.now()
    const error = await capture(f3mut.submitTurn(page, { baseline: { users: 10, dom: ids(10) }, text: SENT, treeBaseline: baselineTree() }))
    const elapsed = Date.now() - t0
    const swiftWouldPass = error === null && state.clicks === 1 && state.treeReads === 1 && elapsed < 200
    ok('SPEED mutation: restoring the post-window-only tree read makes the swift row fail',
      swiftWouldPass === false && error === null && state.clicks === 1 && elapsed >= 300,
      `clicks=${state.clicks} treeReads=${state.treeReads} elapsed=${elapsed}ms (shipped accepts in <200ms)`)
    ok('SPEED mutation: the copy differs only by the disabled in-window tree probe',
      f3Source.split(MUT_FROM).length === 2 && mutatedSource.replace(MUT_TO, () => MUT_FROM) === f3Source)
  }

  // The pre-send baseline reads the last assistant node's text. On a fresh chat
  // there is none, and Playwright's locator actions wait their default 30 s for
  // an element that will never exist (`.catch('')` hid it: 30 of the ~38 s before
  // the Send click on every newBridge; a flat ~2 s after the bound went in). The
  // count is already taken for `baseline_count`, so a zero count skips the read.
  // These fake pages record every innerText call and the timeout it was given,
  // and drive the real ask() pre-click path.
  const ASSISTANT_SEL = '[data-markdown-text-style="assistant-message"]'
  const fakeFresh = ({ assistantCount = 0, lastText = null } = {}) => {
    const said = []
    const calls = []
    const textState = { value: '' }
    const target = {
      innerText: async options => {
        calls.push(options?.timeout ?? null)
        if (lastText !== null) return lastText
        await new Promise(resolve => setTimeout(resolve, options?.timeout ?? 30_000))
        throw new Error('element not found: no assistant node')
      },
    }
    const send = {
      isVisible: async () => true,
      isDisabled: async () => false,
      getAttribute: async () => null,
      // #106: the trial click is a check and must not send.
      click: async options => { if (options?.trial === true) return; said.push(SENT) },
    }
    const composer = {
      isVisible: async () => true,
      click: async () => {},
      focus: async () => {},
      fill: async value => { textState.value = value },
      evaluate: async () => textState.value,
    }
    const locator = selector => {
      const sel = String(selector)
      if (/send/i.test(sel)) return { count: async () => 1, first: () => send, last: () => send, nth: () => send }
      if (sel === ASSISTANT_SEL) {
        return { count: async () => assistantCount, first: () => target, last: () => target, nth: () => target }
      }
      return { count: async () => 1, first: () => composer, last: () => composer, nth: () => composer }
    }
    const page = {
      locator,
      url: () => 'https://chatgpt.com/',
      keyboard: { press: async () => {}, insertText: async value => { textState.value += value } },
      evaluate: async fn => {
        const src = String(fn)
        if (src.includes('stop-button')) return { stop: false, streaming: false, busy: false }
        if (src.includes('progressbar')) return false
        if (src.includes('querySelectorAll')) return { identities: said.map((_, index) => `d${index}`), texts: [...said] }
        throw new Error(`unexpected page.evaluate: ${src.slice(0, 60)}`)
      },
    }
    return { page, said, calls }
  }

  // (new) Zero assistant nodes on a fresh chat: the count alone answers the
  // question, so no locator call is made and the ~2 s bound is not paid.
  {
    const { page, said, calls } = fakeFresh({ assistantCount: 0 })
    const t0 = Date.now()
    const error = await capture(f3.ask(page, SENT, { wait: false }))
    const elapsed = Date.now() - t0
    ok('SPEED a fresh chat with no assistant node skips the last-text read entirely',
      error === null && calls.length === 0 && elapsed < 1_000 && said.length === 1,
      `elapsed=${elapsed}ms innerText calls=${calls.length} sent=${said.length}`)
  }

  // (present) A node that is there is still read, still with the 2 s bound.
  {
    const { page, said, calls } = fakeFresh({ assistantCount: 1, lastText: 'an earlier answer' })
    const t0 = Date.now()
    const error = await capture(f3.ask(page, SENT, { wait: false }))
    const elapsed = Date.now() - t0
    ok('F3 a present assistant node is still read with a 2 s bound',
      error === null && calls.length === 1 && calls[0] === 2_000 && elapsed < 1_500 && said.length === 1,
      `elapsed=${elapsed}ms innerText timeouts=${JSON.stringify(calls)} sent=${said.length}`)
  }

  // (stale count) A count that outlived its node still costs the bounded read,
  // never the 30 s locator default - the dea8d9e guarantee, kept.
  {
    const { page, said, calls } = fakeFresh({ assistantCount: 1 })
    const t0 = Date.now()
    const error = await capture(f3.ask(page, SENT, { wait: false }))
    const elapsed = Date.now() - t0
    ok('F3 a stale assistant count still costs the bounded read, not the 30 s locator default',
      error === null && elapsed >= 1_900 && elapsed < 10_000 && calls.length === 1 && calls[0] === 2_000 && said.length === 1,
      `elapsed=${elapsed}ms innerText timeouts=${JSON.stringify(calls)} sent=${said.length}`)
  }

  // Pre-post navigation only: the page aborted its own document load on a
  // healthy tab (live 2026-10-31 18:15:46Z, net::ERR_ABORTED). Nothing has been
  // typed at that point, so one bounded retry is safe - and the third failure is
  // the turn's failure, with the composer untouched.
  const fakeNav = ({ abortAttempts = 0, onThread = false, composerUnreadable = false,
    composerMissing = false, composerAfterReload = false, busy = false, clickDelayMs = 0,
    stateProbeDelayMs = 0, boxDelayMs = 0, trialDelayMs = 0, scrollDelayMs = 0, trialTimeout = false,
    pageRequest = true, cdpRequest = true, pageRequestPath = CONVERSATION_URL, cdpRequestPath = CONVERSATION_URL,
    treeBody = undefined, treeReadDelayMs = 0, typeDelayMs = 0 } = {}) => {
    const threadId = '6ae4bfc0-1111-2222-3333-444455556666'
    const cdpHandlers = new Map()
    const cdp = {
      sent: [], enabledAt: null, disabledAt: null, detached: false,
      on: (name, handler) => { const list = cdpHandlers.get(name) ?? []; list.push(handler); cdpHandlers.set(name, list) },
      send: async method => {
        cdp.sent.push(method)
        if (method === 'Network.enable') cdp.enabledAt = Date.now()
        if (method === 'Network.disable') cdp.disabledAt = Date.now()
      },
      detach: async () => { cdp.detached = true },
    }
    const context = { newCDPSession: async () => cdp }
    const state = {
      url: onThread ? `https://chatgpt.com/c/${threadId}` : 'https://chatgpt.com/',
      gotos: [], gotoOptions: [], said: [], typed: [], text: '', focus: 0, clicks: 0, sendClicks: 0,
      trials: 0, trialTimeoutMs: null, scrolls: 0, pageRequests: 0, cdpRequests: 0, cdp,
      reloads: 0, reloadOptions: [], composerMissing,
      treeReadStartAt: null, treeReadEndAt: null, typedEndAt: null, clickedAt: null, postAt: null,
    }
    const listeners = new Map()
    const emit = (name, arg) => { for (const handler of listeners.get(name) ?? []) handler(arg) }
    const absent = { count: async () => 0, first: () => null, last: () => null, nth: () => null }
    const send = {
      isVisible: async () => true,
      isEnabled: async () => { if (stateProbeDelayMs) await new Promise(resolve => setTimeout(resolve, stateProbeDelayMs)); return true },
      boundingBox: async () => { if (boxDelayMs) await new Promise(resolve => setTimeout(resolve, boxDelayMs)); return { x: 0, y: 0, width: 10, height: 10 } },
      isDisabled: async () => false,
      getAttribute: async () => null,
      // #106: trial is a check only; scroll is its own step.
      scrollIntoViewIfNeeded: async () => { state.scrolls += 1; if (scrollDelayMs) await new Promise(resolve => setTimeout(resolve, scrollDelayMs)) },
      click: async options => {
        if (options?.trial === true) {
          state.trials += 1
          state.trialTimeoutMs = options?.timeout ?? null
          if (trialDelayMs) await new Promise(resolve => setTimeout(resolve, trialDelayMs))
          if (trialTimeout) {
            const error = new Error(`locator.click: Timeout ${options?.timeout ?? 30_000}ms exceeded.`)
            error.name = 'TimeoutError'
            throw error
          }
          return
        }
        if (clickDelayMs) await new Promise(resolve => setTimeout(resolve, clickDelayMs))
        state.sendClicks += 1
        state.clickedAt = Date.now()
        state.said.push(SENT)
        state.postAt = Date.now()
        if (pageRequest) {
          state.pageRequests += 1
          emit('request', { method: () => 'POST', url: () => pageRequestPath })
        }
        if (cdpRequest) {
          state.cdpRequests += 1
          for (const handler of cdpHandlers.get('Network.requestWillBeSent') ?? []) {
            handler({ request: { method: 'POST', url: cdpRequestPath } })
          }
        }
      },
    }
    const composer = {
      isVisible: async () => true,
      click: async () => { state.clicks += 1 },
      focus: async () => { state.focus += 1 },
      fill: async value => { state.text = value; state.typed.push(value) },
      evaluate: async () => {
        if (composerUnreadable) throw new Error('the composer did not answer')
        return state.text
      },
    }
    const locator = selector => {
      const sel = String(selector)
      if (/send/i.test(sel)) return { count: async () => 1, first: () => send, last: () => send, nth: () => send }
      if (sel === ASSISTANT_SEL) return absent
      // A load-error render: the composer selector finds nothing until a reload.
      if (state.composerMissing) return absent
      return { count: async () => 1, first: () => composer, last: () => composer, nth: () => composer }
    }
    const page = {
      locator,
      url: () => state.url,
      context: () => context,
      on: (name, handler) => { const list = listeners.get(name) ?? []; list.push(handler); listeners.set(name, list) },
      off: (name, handler) => { const list = listeners.get(name) ?? []; listeners.set(name, list.filter(entry => entry !== handler)) },
      listenerCount: name => (listeners.get(name) ?? []).length,
      keyboard: {
        press: async () => {},
        // The composer is a contenteditable: insertText IS the text now that the
        // proven-empty fast path skips `fill`.
        insertText: async value => {
          if (typeDelayMs) await new Promise(resolve => setTimeout(resolve, typeDelayMs))
          state.text += value; state.typed.push(value); state.typedEndAt = Date.now()
        },
      },
      goto: async (url, options) => {
        state.gotos.push(url)
        state.gotoOptions.push(options)
        if (state.gotos.length <= abortAttempts) throw new Error(`page.goto: net::ERR_ABORTED at ${url}`)
        state.url = url
      },
      reload: async options => {
        state.reloads += 1
        state.reloadOptions.push(options)
        if (composerAfterReload) state.composerMissing = false
      },
      evaluate: async (fn, arg) => {
        const src = String(fn)
        // The conversation read passes its path as an argument, not in the source.
        if (typeof arg === 'string' && arg.startsWith('/backend-api/')) {
          state.treeReadStartAt = Date.now()
          if (treeReadDelayMs) await new Promise(resolve => setTimeout(resolve, treeReadDelayMs))
          state.treeReadEndAt = Date.now()
          if (treeBody !== undefined) return { ok: true, status: 200, body: treeBody }
          return { ok: false, status: 503, error: 'no backend in this fake' }
        }
        if (src.includes('stop-button')) return { stop: busy, streaming: busy, busy }
        if (src.includes('progressbar')) return false
        if (src.includes('api/auth/session')) return { url: state.url, title: '', composer: true, challenge: false, model: '', loggedIn: true, email: null, plan: null }
        if (src.includes('querySelectorAll')) return { identities: state.said.map((_, index) => `d${index}`), texts: [...state.said] }
        throw new Error(`unexpected page.evaluate: ${src.slice(0, 60)}`)
      },
    }
    return { page, state, threadId }
  }

  // (1) One abort, then the load lands: exactly one retry, one phase line, and
  // the turn posts exactly once.
  {
    const { page, state, threadId } = fakeNav({ abortAttempts: 1 })
    await clearLog()
    const t0 = Date.now()
    const error = await capture(f3.ask(page, SENT, { wait: false, threadId }))
    const elapsed = Date.now() - t0
    const lines = await logLines()
    const retries = lines.filter(line => /phase send gotoRetry \d+ms$/.test(line))
    const steps = lines.filter(line => /phase send compose_(clear|type|verify) \d+ms$/.test(line))
    ok('NAV a page-aborted goto is retried once and the turn posts exactly once',
      error === null && state.gotos.length === 2 && state.typed.length === 1
      && state.said.length === 1 && retries.length === 1 && steps.length === 3,
      `gotos=${state.gotos.length} typed=${state.typed.length} sent=${state.said.length} retries=${JSON.stringify(retries)} steps=${steps.length} elapsed=${elapsed}ms`)
  }

  // (2) Every attempt aborts: the turn fails with the navigation error, and the
  // composer was never touched - nothing was typed and no Send was clicked.
  {
    const { page, state, threadId } = fakeNav({ abortAttempts: 3 })
    await clearLog()
    const error = await capture(f3.ask(page, SENT, { wait: false, threadId }))
    const retries = (await logLines()).filter(line => /phase send gotoRetry \d+ms$/.test(line))
    const bounded = state.gotoOptions.length === 3
      && state.gotoOptions.every(options => options?.timeout === 20_000 && options?.waitUntil === 'domcontentloaded')
    ok('NAV a navigation that aborts every time fails as not-posted and touches nothing',
      /net::ERR_ABORTED/.test(error?.message ?? '') && /^not-posted:/.test(error?.message ?? '')
      && error?.reason === 'not-posted' && state.gotos.length === 3
      && state.typed.length === 0 && state.said.length === 0 && retries.length === 2,
      `gotos=${state.gotos.length} typed=${state.typed.length} sent=${state.said.length} retries=${retries.length} reason=${error?.reason} error=${error?.message}`)
    ok('NAV every goto attempt is bounded at 20 s, so the worst case is 60 s not 90',
      bounded && /const NAV_TIMEOUT_MS = 20_000/.test(await fs.readFile(SRC_PATH, 'utf8')),
      `options=${JSON.stringify(state.gotoOptions)}`)
  }

  // (3) The tab is ALREADY on the requested thread: a goto there would throw the
  // SPA away and re-render the same page. Zero navigations, and the phase trace
  // still carries the labels (at 0 ms) so the trace shape is constant.
  {
    const { page, state, threadId } = fakeNav({ onThread: true })
    await clearLog()
    const error = await capture(f3.ask(page, SENT, { wait: false, threadId }))
    const lines = (await logLines()).join('\n')
    const skipped = /phase send goto \d+ms$/m.test(lines) && /phase send login \d+ms$/m.test(lines)
    ok('NAV a tab already on the requested thread is not navigated again',
      error === null && state.gotos.length === 0 && state.typed.length === 1 && state.said.length === 1 && skipped,
      `gotos=${state.gotos.length} typed=${state.typed.length} sent=${state.said.length} skipped=${skipped}`)
  }

  // (4) A new chat requested while the tab sits on the new-chat route: no goto.
  {
    const { page, state } = fakeNav()
    await clearLog()
    const error = await capture(f3.ask(page, SENT, { newChat: true, wait: false }))
    const skipped = /phase newchat goto \d+ms$/m.test((await logLines()).join('\n'))
    ok('NAV a tab already on the new-chat route is not navigated again',
      error === null && state.gotos.length === 0 && state.typed.length === 1 && state.said.length === 1 && skipped,
      `gotos=${state.gotos.length} typed=${state.typed.length} sent=${state.said.length} skipped=${skipped}`)
  }

  // A missing composer used to throw a plain Error: the host read it as a
  // TERMINAL failure and told the sender nothing was coming, although nothing
  // had been typed (live 2026-10-31, tor-fresh turns 0dd2dfb6 / 51dd277a during
  // a 429 load-error render). It must be a not-posted refusal, and a page that
  // reports a live turn must never be reloaded to recover it.
  {
    const { page, state, threadId } = fakeNav({ onThread: true, composerMissing: true, busy: true })
    await clearLog()
    const error = await capture(f3.ask(page, SENT, { wait: false, threadId }))
    const message = String(error?.message ?? '')
    const lines = (await logLines()).join('\n')
    const keepQueued = /mid-turn|not-posted|never left the composer|ambiguous/i // host chatgpt-peer.ts:2274
    ok('HOST a missing composer is a not-posted refusal the host keeps queued',
      error?.reason === 'not-posted' && message.startsWith('not-posted:') && keepQueued.test(message)
      && state.typed.length === 0 && state.said.length === 0 && state.clicks === 0,
      `message=${message.slice(0, 120)} reason=${error?.reason} typed=${state.typed.length} sent=${state.said.length}`)
    ok('COMPOSER a page that reports a live turn is never reloaded for a missing composer',
      state.reloads === 0 && /phase send composer_recover 0ms/.test(lines) && /live turn, so it was not reloaded/.test(lines),
      `reloads=${state.reloads} why=${(lines.match(/composer recovery skipped: (.*)/) ?? [])[1] ?? 'none'}`)
  }

  // One bounded recovery: the SAME thread reloaded once, no click, then the
  // composer appears and the turn posts exactly once.
  {
    const { page, state, threadId } = fakeNav({ onThread: true, composerMissing: true, composerAfterReload: true })
    await clearLog()
    const error = await capture(f3.ask(page, SENT, { wait: false, threadId }))
    const lines = (await logLines()).join('\n')
    ok('COMPOSER a missing composer is recovered by exactly one bounded reload',
      error === null && state.reloads === 1 && state.reloadOptions.length === 1
      && state.reloadOptions[0]?.timeout === 20_000 && state.reloadOptions[0]?.waitUntil === 'domcontentloaded'
      && state.typed.length === 1 && state.said.length === 1
      && /phase send composer_recover \d+ms/m.test(lines) && /phase send composer_recover_after \d+ms/m.test(lines),
      `reloads=${state.reloads} options=${JSON.stringify(state.reloadOptions)} typed=${state.typed.length} sent=${state.said.length}`)
  }

  // The gate itself: a page that is NOT on the requested thread is never
  // reloaded (the reload exists to re-render a page that is right but blank).
  {
    const { page, state, threadId } = fakeNav({ onThread: false })
    const result = typeof f3.recoverComposer === 'function'
      ? await f3.recoverComposer(page, { threadId })
      : { composer: null, why: 'recoverComposer is not exported at this source' }
    ok('COMPOSER recovery never reloads a page that is not on the requested thread',
      result?.composer === null && result?.reloadMs === 0 && state.reloads === 0
      && /not on the requested thread/.test(result?.why ?? ''),
      `reloads=${state.reloads} why=${result?.why}`)
  }

  // The phase log is a QUEUE, not a synchronous write: a slow append must not
  // stall the caller, and flushLog must still deliver every line in order.
  {
    await clearLog()
    const t0 = Date.now()
    for (let index = 0; index < 10; index += 1) await f3slow.log(`slowlog ${index}`)
    const enqueueMs = Date.now() - t0
    if (typeof f3slow.flushLog === 'function') await f3slow.flushLog()
    const delivered = (await logLines())
      .map(line => (line.match(/slowlog (\d+)$/) ?? [])[1])
      .filter(value => value !== undefined)
    ok('LOG a slow appender no longer blocks the caller, and flushLog delivers every line in order',
      slowApplied && enqueueMs < 200 && delivered.join(',') === '0,1,2,3,4,5,6,7,8,9',
      `applied=${slowApplied} enqueueMs=${enqueueMs} delivered=${delivered.join(',')}`)
  }

  // The send path itself: with every append costing 120 ms, the pre-click span
  // must stay at page-work speed and the phase trace must still be complete and
  // ordered. A send that awaited its log writes would spend seconds here.
  {
    const { page, state, threadId } = fakeNav({ onThread: true })
    await clearLog()
    const t0 = Date.now()
    const error = await capture(f3slow.ask(page, SENT, { wait: false, threadId }))
    const elapsed = Date.now() - t0
    if (typeof f3slow.flushLog === 'function') await f3slow.flushLog()
    const phases = (await logLines())
      .map(line => (line.match(/phase send (\S+) \d+ms$/) ?? [])[1])
      .filter(label => ['goto', 'login', 'composer', 'baselines', 'compose', 'click_scroll', 'click_trial', 'click_begin', 'click_dispatch', 'click_end', 'click_state', 'click_box', 'ready', 'preclick'].includes(label))
    ok('LOG a slow appender adds nothing to the send path, and every phase line still lands in order',
      slowApplied && error === null && state.said.length === 1 && elapsed < 800
      && phases.join(',') === 'goto,login,composer,baselines,compose,click_begin,click_dispatch,click_end,click_state,click_box,ready,preclick',
      `applied=${slowApplied} elapsed=${elapsed}ms sent=${state.said.length} phases=${phases.join(',')}`)
  }

  // The click bracket: the pair must straddle the click itself, so a click that
  // spends 150 ms has to report click_end >= 140 ms, with click_begin written
  // first. Without this row the pair could be two timestamps around nothing.
  {
    const { page, state, threadId } = fakeNav({ onThread: true, clickDelayMs: 150 })
    await clearLog()
    const error = await capture(f3.ask(page, SENT, { wait: false, threadId }))
    if (typeof f3.flushLog === 'function') await f3.flushLog()
    const lines = await logLines()
    const mark = label => {
      const line = lines.find(entry => (entry.match(/phase send (\S+) (\d+)ms$/) ?? [])[1] === label)
      if (!line) return null
      return { at: Date.parse((line.match(/^\S+/) ?? [])[0]), ms: Number((line.match(/(\d+)ms$/) ?? [])[1]) }
    }
    const begin = mark('click_begin')
    const end = mark('click_end')
    ok('CLICK the phase pair straddles the click and measures it',
      error === null && state.said.length === 1 && begin !== null && end !== null
      && end.ms >= 140 && end.ms < 2_000 && begin.at <= end.at,
      `begin=${begin?.ms} end=${end?.ms} sent=${state.said.length} error=${error?.message ?? 'none'}`)
  }

  // #105 CLICK SPLIT: `click_end` times the click CALL alone. The two reads the
  // call repeats (visible/enabled, then the box) are timed before it and
  // reported outside it - a 150 ms click with 60+40 ms of probes must still
  // report click_end >= 140 ms, so the split cannot swallow the call.
  {
    const { page, state, threadId } = fakeNav({ onThread: true, clickDelayMs: 150, stateProbeDelayMs: 60, boxDelayMs: 40 })
    await clearLog()
    const error = await capture(f3.ask(page, SENT, { wait: false, threadId }))
    if (typeof f3.flushLog === 'function') await f3.flushLog()
    const lines = await logLines()
    const mark = label => {
      const line = lines.find(entry => (entry.match(/phase send (\S+) (\d+)ms$/) ?? [])[1] === label)
      if (!line) return null
      return { at: Date.parse((line.match(/^\S+/) ?? [])[0]), ms: Number((line.match(/(\d+)ms$/) ?? [])[1]) }
    }
    const order = lines.map(line => (line.match(/phase send (\S+) \d+ms$/) ?? [])[1])
      .filter(label => ['click_begin', 'click_end', 'click_state', 'click_box', 'ready', 'preclick'].includes(label))
    const end = mark('click_end')
    const probes = mark('click_state')
    const box = mark('click_box')
    ok('#105 the click call is timed apart from the probes it made before it',
      error === null && state.said.length === 1
      && end !== null && end.ms >= 140 && end.ms < 600
      && probes !== null && probes.ms >= 50 && box !== null && box.ms >= 30
      && order.join(',') === 'click_begin,click_end,click_state,click_box,ready,preclick',
      `click_end=${end?.ms} state=${probes?.ms} box=${box?.ms} order=${order.join(',')}`)
  }

  // #105 CLICK POST: the page's own send request is observed, reported against
  // click_begin, and the request listener is removed when the turn ends.
  {
    const { page, state, threadId } = fakeNav({ onThread: true })
    await clearLog()
    const error = await capture(f3.ask(page, SENT, { wait: false, threadId }))
    if (typeof f3.flushLog === 'function') await f3.flushLog()
    const headLines = await logLines()
    // The second number is SIGNED: the POST is seen inside the click call, and
    // `clickedAt` is stamped once that call returns, so when the click spans a
    // millisecond boundary the difference is negative (the page reported it
    // before the call came back). It is 0 only when both land in one tick.
    const post = headLines.find(line => /click post: the send POST was seen \d+ms after click_begin \(-?\d+ms after click_end\)$/.test(line))
    ok('#105 the send POST is observed once and the request listener does not outlive the turn',
      error === null && state.said.length === 1 && Boolean(post)
      && page.listenerCount('request') === 0,
      `post=${post ?? 'none'} listeners=${page.listenerCount('request')} said=${state.said.length} error=${error?.message ?? 'none'} lines=${headLines.length}:${JSON.stringify(headLines.slice(-4))}`)
  }

  // #105 ACCEPTANCE SPLIT: the window reports the time spent INSIDE its reads
  // apart from its own poll cadence. A 120 ms tree read must show up as read
  // time, not be absorbed into the probe offsets.
  {
    const { page, state } = fakePage({ treeRevealAtRead: 1, treeReadDelayMs: 120 })
    await clearLog()
    const error = await capture(f3.submitTurn(page, { baseline: { users: 10, dom: ids(10) }, text: SENT, treeBaseline: baselineTree() }))
    if (typeof f3.flushLog === 'function') await f3.flushLog()
    const split = (await logLines()).find(line => /acceptance window: path tree, \d+ DOM polls in \d+ms, 1 tree probes in \d+ms \(\d+ms\)$/.test(line))
    const readMs = Number((split?.match(/tree probes in (\d+)ms/) ?? [])[1])
    ok('#105 the acceptance window reports read time apart from its poll cadence',
      error === null && state.clicks === 1 && state.treeReads === 1
      && Boolean(split) && readMs >= 110,
      `split=${split ?? 'none'} treeReads=${state.treeReads}`)
  }

  // #105 SOURCE: the split is measurement-only. Every new line must exist, the
  // click site must still be exactly one, and no click option may have been
  // added - a behaviour change would have to show up in this text.
  {
    const source = shipped.slice(shipped.indexOf('async function submitTurn(page,'))
    const body = source.slice(0, source.indexOf(`${NL}}${NL}`) + 3)
    const expected = [
      'phase ${phaseLabel} click_state ${clickStateMs}ms',
      'phase ${phaseLabel} click_box ${clickBoxMs}ms',
      'click post: the send POST was seen',
      'acceptance window: path',
      'acceptance ceiling: the last tree read took',
    ]
    ok('#105 the split is log-only: every new line exists and the click carries no new option',
      expected.every(text => body.includes(text))
      && (body.match(/send\.click\(\)/g) || []).length === 1
      && !/\.click\(\{[^}]*\b(force|noWaitAfter|dispatchEvent)\b/.test(body),
      `lines=${expected.filter(text => body.includes(text)).length}/${expected.length} clicks=${(body.match(/send\.click\(\)/g) || []).length}`)
  }

  // #106 DEFAULT: the probe flag is OFF, so the default send path is one click
  // and nothing else. The fake makes a trial and a scroll observable (40/90 ms
  // delays), so if either still ran it would appear as a count, a phase line or
  // extra elapsed time. The row also names the flag itself, so a source that
  // has no gate cannot pass it.
  {
    const gated = shipped.includes("const CLICK_PROBE = process.env.CHATGPT_CLICK_PROBE === '1'")
    const { page, state, threadId } = fakeNav({ onThread: true, trialDelayMs: 90, scrollDelayMs: 40, clickDelayMs: 150 })
    await clearLog()
    const error = await capture(f3.ask(page, SENT, { wait: false, threadId }))
    if (typeof f3.flushLog === 'function') await f3.flushLog()
    const lines = await logLines()
    const order = lines.map(line => (line.match(/phase send (\S+) \d+ms$/) ?? [])[1])
      .filter(label => ['click_trial', 'click_scroll', 'click_begin', 'click_dispatch', 'click_end', 'click_state', 'click_box', 'ready', 'preclick'].includes(label))
    const trialLine = lines.find(line => /phase send click_trial /.test(line))
    const scrollLine = lines.find(line => /phase send click_scroll /.test(line))
    ok('#106 by default there is no trial and no scroll: one click, phases without them',
      gated && error === null
      && state.trials === 0 && state.scrolls === 0 && state.trialTimeoutMs === null
      && state.sendClicks === 1 && state.said.length === 1
      && state.pageRequests === 1 && state.cdpRequests === 1
      && trialLine === undefined && scrollLine === undefined
      && order.join(',') === 'click_begin,click_dispatch,click_end,click_state,click_box,ready,preclick',
      `gated=${gated} trials=${state.trials} scrolls=${state.scrolls} sendClicks=${state.sendClicks} sent=${state.said.length} order=${order.join(',')}`)
  }

  // #106 ENDPOINT: the live send is `POST /backend-api/f/conversation`. ONE
  // matcher must accept both that and the bare form the earlier builds used, and
  // the page-level listener must be the one that says so: each fake fires ONLY
  // the page event, once at each endpoint.
  {
    const seen = async path => {
      const { page, state, threadId } = fakeNav({ onThread: true, pageRequest: true, cdpRequest: false, pageRequestPath: path })
      await clearLog()
      const error = await capture(f3.ask(page, SENT, { wait: false, threadId }))
      if (typeof f3.flushLog === 'function') await f3.flushLog()
      const pageLine = (await logLines()).find(line => /click post: the send POST was seen \d+ms after click_begin/.test(line))
      return { ok: error === null && state.pageRequests === 1 && state.cdpRequests === 0 && Boolean(pageLine), pageLine, state }
    }
    const live = await seen(F_CONVERSATION_URL)
    const legacy = await seen(CONVERSATION_URL)
    ok('#106 one page-level matcher accepts both the /backend-api/f/conversation and bare endpoints',
      live.ok && legacy.ok && shipped.includes('(?:f\\/)?conversation'),
      `live=${live.pageLine ?? 'none'} legacy=${legacy.pageLine ?? 'none'} matcher=${shipped.includes('(?:f\\/)?conversation')}`)
  }

  // #106 TRIAL: the trial click runs the actionability checks and dispatches
  // nothing. A fake whose trial costs 90 ms and whose scroll costs 40 ms, with a
  // 150 ms real click, must show all three separately: the trial and scroll
  // outside `click_end`, the real call inside it. Inertness is counted on the
  // fake itself - one trial, one dispatching click, one request - so a trial
  // that sent would show up as an extra send or an extra request. This drives
  // the PROBE copy (imported with CHATGPT_CLICK_PROBE=1).
  {
    const { page, state, threadId } = fakeNav({ onThread: true, trialDelayMs: 90, scrollDelayMs: 40, clickDelayMs: 150 })
    await clearLog()
    const error = await capture(f3probe.ask(page, SENT, { wait: false, threadId }))
    if (typeof f3probe.flushLog === 'function') await f3probe.flushLog()
    const lines = await logLines()
    const mark = label => {
      const line = lines.find(entry => (entry.match(/phase send (\S+) (\d+)ms$/) ?? [])[1] === label)
      if (!line) return null
      return { at: Date.parse((line.match(/^\S+/) ?? [])[0]), ms: Number((line.match(/(\d+)ms$/) ?? [])[1]) }
    }
    const order = lines.map(line => (line.match(/phase send (\S+) \d+ms$/) ?? [])[1])
      .filter(label => ['click_trial', 'click_scroll', 'click_begin', 'click_dispatch', 'click_end', 'click_state', 'click_box', 'ready', 'preclick'].includes(label))
    const trial = mark('click_trial')
    const scroll = mark('click_scroll')
    const begin = mark('click_begin')
    const dispatch = mark('click_dispatch')
    const end = mark('click_end')
    ok('#106 the scroll and the trial are timed apart from the real click and dispatch nothing',
      error === null && state.trials === 1 && state.trialTimeoutMs === 5_000
      && state.sendClicks === 1 && state.said.length === 1
      && state.pageRequests === 1 && state.cdpRequests === 1
      && trial !== null && trial.ms >= 80 && scroll !== null && scroll.ms >= 30
      && dispatch !== null && dispatch.ms >= 140 && end !== null && Math.abs(end.ms - dispatch.ms) <= 5
      && begin !== null && scroll.at <= begin.at && trial.at <= begin.at && scroll.at <= trial.at
      && order.join(',') === 'click_scroll,click_trial,click_begin,click_dispatch,click_end,click_state,click_box,ready,preclick',
      `trials=${state.trials} timeout=${state.trialTimeoutMs} sendClicks=${state.sendClicks} sent=${state.said.length} requests=${state.pageRequests}/${state.cdpRequests} scroll=${scroll?.ms} trial=${trial?.ms} dispatch=${dispatch?.ms} end=${end?.ms} order=${order.join(',')}`)
  }

  // #106 TRIAL BOUND: a trial that times out is INFORMATION, never a second
  // wait. The distinct line is written, the trial carried the explicit 5000 ms
  // ceiling (not the locator default), and the real click still dispatches
  // exactly once afterwards.
  {
    const { page, state, threadId } = fakeNav({ onThread: true, trialTimeout: true, trialDelayMs: 20 })
    await clearLog()
    const error = await capture(f3probe.ask(page, SENT, { wait: false, threadId }))
    if (typeof f3probe.flushLog === 'function') await f3probe.flushLog()
    const timedOut = (await logLines()).find(line => /phase send click_trial_timeout \d+ms$/.test(line))
    ok('#106 a timed-out trial is logged and the real click still dispatches once',
      error === null && state.trials === 1 && state.trialTimeoutMs === 5_000
      && state.sendClicks === 1 && state.said.length === 1 && Boolean(timedOut),
      `trials=${state.trials} timeout=${state.trialTimeoutMs} sendClicks=${state.sendClicks} line=${timedOut ?? 'none'}`)
  }

  // #106 NETWORK: the send endpoint is named from the CDP Network domain, not
  // from page request events. This fake fires NO page event but DOES fire the
  // CDP one, so the two log lines must disagree - and the observer must be
  // stopped (disable + detach) only after the acceptance window.
  {
    const { page, state, threadId } = fakeNav({ onThread: true, pageRequest: false, cdpRequest: true })
    await clearLog()
    const error = await capture(f3probe.ask(page, SENT, { wait: false, threadId }))
    if (typeof f3probe.flushLog === 'function') await f3probe.flushLog()
    const lines = await logLines()
    const network = lines.find(line => /click network: the CDP session saw POST \/backend-api\/conversation at \d+ms after click_begin \(\d+ requests seen\)$/.test(line))
    const pageLine = lines.find(line => /click post: no send POST was observed before acceptance$/.test(line))
    ok('#106 the send endpoint is reported from CDP even when page events see nothing',
      error === null && state.pageRequests === 0 && state.cdpRequests === 1
      && Boolean(network) && Boolean(pageLine)
      && state.cdp.sent.includes('Network.enable') && state.cdp.sent.includes('Network.disable')
      && state.cdp.enabledAt !== null && state.cdp.enabledAt <= state.clickedAt
      && state.cdp.detached === true && state.cdp.disabledAt >= state.clickedAt,
      `network=${network ?? 'none'} page=${pageLine ?? 'none'} sent=${state.cdp.sent.join(',')} detached=${state.cdp.detached}`)
  }

  // #106 SOURCE: the trial exists only inside the probe gate, the default side
  // is exactly one bare `send.click()`, and the observer is started before that
  // click and stopped after the acceptance window in BOTH modes - the shape #107
  // needs to swap the acceptance signal without adding a second capture.
  {
    const source = shipped.slice(shipped.indexOf('async function submitTurn(page,'))
    const body = source.slice(0, source.indexOf(`${NL}}${NL}`) + 3)
    const gateAt = body.indexOf('if (CLICK_PROBE) {')
    const gateEnd = body.indexOf('// The only click this function is allowed to make.')
    const gated = gateAt > -1 && gateEnd > gateAt
    const probeBlock = gated ? body.slice(gateAt, gateEnd) : ''
    const defaultBlock = gated ? body.slice(0, gateAt) + body.slice(gateEnd) : body
    const allClickCalls = (body.match(/send\.click\(/g) || []).length
    const probeTrials = (probeBlock.match(/send\.click\(\{ trial: true[^}]*\}\)/g) || []).length
    const proseClicks = (probeBlock.match(/send\.click\(/g) || []).length
    const defaultBare = (defaultBlock.match(/send\.click\(\)/g) || []).length
    const defaultClicks = (defaultBlock.match(/send\.click\(/g) || []).length
    const startAt = body.indexOf('const network = await startNetworkWatch(page)')
    // Two shipped shapes: the click is either awaited bare (before G-010) or
    // wrapped in the op-deadline rail. Accepting both keeps this invariant row
    // green on the red base, where only the deadline rows are meant to fail.
    const clickAt = Math.max(
      body.indexOf('try { await readiness.send.click() }'),
      body.indexOf('railed(readiness.send.click()'),
    )
    const windowAt = body.indexOf('const outcome = await waitForAcceptance(page,')
    const stopAt = body.indexOf('const net = await network.stop()')
    ok('#106 the probe branch holds the trial and the default branch holds one dispatching click',
      gated && allClickCalls === 2 && probeTrials === 1 && proseClicks === 1
      && defaultClicks === 1 && defaultBare === 1
      && probeBlock.includes('timeout: CLICK_TRIAL_TIMEOUT_MS')
      && probeBlock.includes('scrollIntoViewIfNeeded')
      && probeBlock.includes('click_trial') && probeBlock.includes('click_scroll')
      && defaultBlock.includes('click_dispatch')
      && !/trial: true/.test(defaultBlock) && !/scrollIntoViewIfNeeded/.test(defaultBlock)
      && !/\.click\(\{[^}]*\b(force|noWaitAfter|dispatchEvent)\b/.test(body)
      && startAt > -1 && clickAt > -1 && windowAt > -1 && stopAt > -1
      && startAt < clickAt && stopAt > windowAt,
      `gated=${gated} click=${allClickCalls} probe=${proseClicks}(${probeTrials} trial) default=${defaultClicks}(${defaultBare} bare) start=${startAt} click=${clickAt} window=${windowAt} stop=${stopAt}`)
  }

  // The compose refusal must be RECOGNISABLE to the host as "nothing was
  // posted". The host never reads reply.reason on this path: it decides from the
  // MESSAGE TEXT (Z:\328\...\gateway\scripts\chatgpt-peer.ts:2274,
  // /mid-turn|not-posted|never left the composer|ambiguous/i; the reply is
  // thrown verbatim at :1538). Without the token a bounded compose refusal is a
  // terminal failure line to the sender instead of a turn that stays queued.
  {
    const { page, state } = fakeNav({ composerUnreadable: true })
    const error = await capture(f3.ask(page, SENT, { wait: false }))
    const message = String(error?.message ?? '')
    const keepQueued = /mid-turn|not-posted|never left the composer|ambiguous/i // host chatgpt-peer.ts:2274
    ok('HOST a compose refusal matches the host keep-queued predicate',
      error !== null && error.reason === 'not-posted' && message.startsWith('not-posted:') && keepQueued.test(message)
      && state.said.length === 0,
      `message=${message.slice(0, 90)} reason=${error?.reason} sent=${state.said.length}`)
  }

  // ---------------------------------------------------------- #104 overlap tree
  // The pre-send tree read used to be awaited inline, so a slow backend read
  // added its whole duration to preclick (live 04:12:52Z: baseline_tree 4418 ms
  // of an 11173 ms preclick). It is now started right after the landing check
  // and joined after compose, so it runs under the composer wait, the DOM
  // baselines and the compose. Typing never reaches the thread tree, so a
  // snapshot taken under it is still a snapshot taken before the click.

  // (A) A 300 ms read plus a 500 ms compose must cost about one 500 ms step, not
  // 800: the read's residual `baseline_tree` label stays near zero while the
  // measurement line proves the read itself really took ~300 ms. On the old
  // source the read is inline, so the residual IS the read (~300 ms) and there
  // is no measurement line at all - this row fails there.
  {
    const { page, state, threadId } = fakeNav({ onThread: true, treeBody: treeWith(['an older turn']), treeReadDelayMs: 300, typeDelayMs: 500 })
    // Drain the queue BEFORE clearing: log() is async, so a previous row's line
    // could otherwise land after the rm and be read as this row's.
    if (typeof f3.flushLog === 'function') await f3.flushLog()
    await clearLog()
    const t0 = Date.now()
    const error = await capture(f3.ask(page, SENT, { wait: false, threadId }))
    const elapsed = Date.now() - t0
    if (typeof f3.flushLog === 'function') await f3.flushLog()
    const lines = await logLines()
    const measured = Number((lines.find(line => / tree baseline \d+ms status ok retry no$/.test(line))?.match(/tree baseline (\d+)ms/) ?? [])[1])
    const residual = Number((lines.find(line => / phase send baseline_tree \d+ms$/.test(line))?.match(/baseline_tree (\d+)ms/) ?? [])[1])
    ok('#104 the pre-send tree read overlaps the compose instead of adding to it',
      error === null && state.said.length === 1
      && measured >= 280 && residual < 150 && elapsed < 1_500,
      `read=${measured}ms residual=${residual}ms elapsed=${elapsed}ms sent=${state.said.length}`)
  }

  // (B) The click may never happen before the snapshot has been taken, even
  // though the read now overlaps: a 300 ms read must hold the Send click back,
  // and the click must land at or after the read finished.
  {
    const { page, state, threadId } = fakeNav({ onThread: true, treeBody: treeWith(['an older turn']), treeReadDelayMs: 300 })
    const promise = capture(f3.ask(page, SENT, { wait: false, threadId }))
    await new Promise(resolve => setTimeout(resolve, 100))
    const clickedWhilePending = state.clickedAt !== null
    const error = await promise
    ok('#104 the Send click waits for the tree snapshot and lands after it',
      error === null && state.said.length === 1 && state.clickedAt !== null
      && !clickedWhilePending
      && state.treeReadEndAt !== null && state.clickedAt >= state.treeReadEndAt,
      `clickedWhilePending=${clickedWhilePending} readEnd=${state.treeReadEndAt} clicked=${state.clickedAt} sent=${state.said.length}`)
  }

  // (C) The measurement must not change what an unreadable baseline means. With
  // no tree body the read answers 503, the snapshot is `null`, and the send still
  // posts once and is accepted by the DOM - exactly as before (F3 (f)/(c) prove
  // the null baseline settles ambiguous and never earns a second click when the
  // DOM shows nothing either). The measurement line names the unreadable status.
  {
    const { page, state, threadId } = fakeNav({ onThread: true })
    // This row reads the ONLY `tree baseline` line it may see, so the previous
    // row's queue must be drained and cleared, never raced past the rm.
    if (typeof f3.flushLog === 'function') await f3.flushLog()
    await clearLog()
    const error = await capture(f3.ask(page, SENT, { wait: false, threadId }))
    if (typeof f3.flushLog === 'function') await f3.flushLog()
    const status = (await logLines()).find(line => / tree baseline \d+ms status /.test(line))?.match(/status (\S+)/)?.[1]
    ok('#104 an unreadable tree baseline degrades exactly as today and is reported',
      error === null && state.said.length === 1 && state.typed.length === 1 && status === 'error-503',
      `sent=${state.said.length} typed=${state.typed.length} status=${status} error=${error?.message ?? 'none'}`)
  }
}

// ------------------------------- G-011 reads run beside a send (real dispatch)
// Live 2026-11-01: one 240 s send held the serial chain, the host's seven
// `status` polls queued behind it, each hit its own 20 s timeout, and the host
// concluded "the driver failed" about a child that was healthy the whole time.
// The dispatch is a shipped, page-free factory (createDispatcher), so these rows
// drive the REAL dispatcher with a `run` that holds a send and answers status at
// once: no page, no browser, and no copy of the logic.
{
  const T = '6ae4bfc0-1111-2222-3333-444455556666'
  const sink = () => { const lines = []; return { lines, emit: value => lines.push({ value, at: Date.now() }) } }
  const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))
  const makeDispatcher = (run, emit) => (typeof mod.createDispatcher === 'function' ? mod.createDispatcher({ run, emit }) : null)

  // (a) A read is answered INSIDE the hold, and a second send does not start
  // until the first has finished. That is the whole contract in one run.
  {
    const { lines, emit } = sink()
    let release = () => {}
    const held = new Promise(resolve => { release = resolve })
    const started = []
    const finished = []
    const run = async request => {
      started.push({ op: request.op, id: request.id })
      if (request.op === 'send') await held
      finished.push({ op: request.op, id: request.id })
      return { ok: true, op: request.op, accepted: true, state: 'idle' }
    }
    const dispatcher = makeDispatcher(run, emit)
    let statusAt = 0
    let statusReply = null
    let sendAnsweredBefore = true
    let secondStartedBefore = true
    if (dispatcher) {
      dispatcher.dispatch({ op: 'send', text: 'x', id: 'S1' }, 'S1', 'S1')
      await tick()
      statusAt = Date.now()
      dispatcher.dispatch({ op: 'status', threadId: T, id: 'C1' }, 'C1', 'C1')
      dispatcher.dispatch({ op: 'send', text: 'y', id: 'S2' }, 'S2', 'S2')
      await tick()
      statusReply = lines.find(entry => entry.value.id === 'C1')
      sendAnsweredBefore = lines.some(entry => entry.value.id === 'S1')
      secondStartedBefore = started.some(entry => entry.id === 'S2')
      release()
      await dispatcher.drain()
    }
    const sendReply = lines.find(entry => entry.value.id === 'S1')
    const secondReply = lines.find(entry => entry.value.id === 'S2')
    const ended = id => finished.findIndex(entry => entry.id === id)
    ok('G011 a status read is answered while the send it arrived with is still in flight',
      Boolean(statusReply) && sendAnsweredBefore === false && secondStartedBefore === false
      && statusReply.at - statusAt < 500
      && Boolean(sendReply) && sendReply.value.ok === true
      && Boolean(secondReply) && secondReply.value.ok === true
      && ended('S1') > -1 && ended('S2') > ended('S1')
      && started.filter(entry => entry.id === 'S2').length === 1
      && lines.filter(entry => entry.value.id === 'S1').length === 1
      && lines.filter(entry => entry.value.id === 'S2').length === 1
      && lines.filter(entry => entry.value.id === 'C1').length === 1,
      `statusSeq=${statusReply ? statusReply.at - statusAt : 'none'}ms statusBeforeSend=${!sendAnsweredBefore} secondWaited=${!secondStartedBefore} order=${finished.map(entry => entry.id).join(',')}`)

    // A rejection is still the one defined error frame, with its reason.
    const { lines: rejectLines, emit: rejectEmit } = sink()
    const rejector = makeDispatcher(async request => {
      const error = new Error('not-posted: nothing was sent')
      error.reason = 'not-posted'
      throw error
    }, rejectEmit)
    if (rejector) {
      rejector.dispatch({ op: 'send', text: 'z', id: 'S3' }, 'S3', 'S3')
      await rejector.drain()
    }
    ok('G011 a thrown op still answers once, with the contract reason',
      rejectLines.length === 1 && rejectLines[0].value.ok === false
      && rejectLines[0].value.id === 'S3' && rejectLines[0].value.reason === 'not-posted',
      `frames=${rejectLines.length} value=${JSON.stringify(rejectLines[0]?.value)}`)
  }

  // (b) Quit's drain waits for a read that bypassed the chain, so nothing can
  // follow the quit frame.
  {
    const { lines, emit } = sink()
    let release = () => {}
    const held = new Promise(resolve => { release = resolve })
    const dispatcher = makeDispatcher(async request => {
      if (request.op === 'conversation') await held
      return { ok: true, op: request.op }
    }, emit)
    let drained = false
    let drainedWhileHeld = true
    if (dispatcher) {
      dispatcher.dispatch({ op: 'conversation', threadId: T, id: 'R1' }, 'R1', 'R1')
      const drain = dispatcher.drain().then(() => { drained = true })
      await tick(50)
      drainedWhileHeld = drained
      release()
      await drain
    }
    ok('G011 the drain waits for a read that bypassed the chain, then answers it',
      Boolean(dispatcher) && drainedWhileHeld === false && drained === true
      && lines.length === 1 && lines[0].value.id === 'R1',
      `drainedWhileHeld=${drainedWhileHeld} drained=${drained} frames=${lines.length}`)
  }

  // (c) The classifier is the contract: every page-mutating op stays serialised.
  {
    const read = req => {
      try { return mod.isConcurrentRead(typeof req === 'string' ? { op: req } : req) } catch { return undefined }
    }
    ok('G011 only the proven read-only ops leave the chain; every mutation stays on it',
      typeof mod.isConcurrentRead === 'function'
      && read('status') === false
      && read({ op: 'status', threadId: T }) === true
      && ['conversation', 'conversations', 'threads', 'read'].every(op => read(op) === true)
      && ['send', 'attach', 'set', 'use', 'reload', 'unload', 'file', 'ping'].every(op => read(op) === false),
      `status=${read('status')} statusWithId=${read({ op: 'status', threadId: 'x' })}`)
  }

  // (d) serve() dispatches through the shipped factory, not a second chain.
  {
    const source = await fs.readFile(SRC_PATH, 'utf8')
    const slice = (from, to) => {
      const a = source.indexOf(from)
      const b = source.indexOf(to, a)
      return a >= 0 && b > a ? source.slice(a, b) : ''
    }
    const factory = slice('function createDispatcher(', 'async function serve()')
    const serveBody = slice('async function serve()', 'export {')
    ok('G011 serve() owns no chain: the queue and the read bypass live in the factory',
      factory.length > 0 && /chain = chain\.then/.test(factory)
      && /createDispatcher\(\{ run, emit \}\)/.test(serveBody)
      && !/chain = chain\.then/.test(serveBody) && !/const reads = new Set\(\)/.test(serveBody),
      `factory=${factory.length} serve=${serveBody.length}`)
  }
}

// --------------------------------------------------- TREE the baseline read bound
{
  // The pre-send tree baseline is the one pre-click read the driver cannot skip
  // (the host hands it no baseline). It must fail fast, not sit on Playwright's
  // or a 15 s default: a timeout means "unread", which is safe.
  if (typeof mod.readUserTreeOnPage !== 'function') {
    ok('TREE the pre-send tree baseline read is bounded at 5000 ms', false, 'readUserTreeOnPage is not exported at this source')
  } else {
    const page = {
      url: () => 'https://chatgpt.com/c/6ae4bfc0-1111-2222-3333-444455556666',
      evaluate: () => new Promise(() => {}), // a wedged backend: never answers
    }
    const t0 = Date.now()
    // The bound is an unref'd timer inside the driver; with nothing else pending
    // node would exit on the unsettled await instead of letting it fire, so hold
    // one ref'd handle open for the duration of the read.
    const keepAlive = setInterval(() => {}, 250)
    let tree
    try { tree = await mod.readUserTreeOnPage(page) } finally { clearInterval(keepAlive) }
    const elapsed = Date.now() - t0
    ok('TREE the pre-send tree baseline read is bounded at 5000 ms',
      tree === null && elapsed >= 4_900 && elapsed < 9_000,
      `elapsed=${elapsed}ms unread=${tree === null}`)
  }
  const src = await fs.readFile(SRC_PATH, 'utf8')
  ok('TREE the pre-send DOM baseline read is bounded the same way',
    /readDomUserTurns\(page, priorUsers = 0, timeoutMs = DOM_BASELINE_TIMEOUT_MS\)/.test(src)
    && /DOM_BASELINE_TIMEOUT_MS = 5_000/.test(src)
    && !/backend-api\/conversation\/\$\{threadId\}`, 15_000\)/.test(src),
    'evaluateTimed with the 5 s baseline budget')
}

// ----------------------------------------------------- F6 attachment chip delta
{
  const pageOf = states => {
    let index = 0
    return {
      // Call 1 is the pre-upload chip count (a number in the real page); every
      // later call is the poll state object.
      evaluate: async () => {
        const state = states[Math.min(index++, states.length - 1)]
        return index === 1 ? state.chips : state
      },
      locator: () => ({ first: () => ({ count: async () => 1, setInputFiles: async () => {} }) }),
    }
  }
  const file = { name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('x'), timeoutMs: 500 }
  let preExisting = ''
  try { await mod.attachFile(pageOf([{ chips: 1 }, { chips: 1, toast: false }]), file); preExisting = 'ATTACHED' }
  catch (error) { preExisting = error.message }
  ok('F6 a pre-existing chip is not reported as attached', /no NEW chip appeared/.test(preExisting), preExisting)
  const fresh = await mod.attachFile(pageOf([{ chips: 1 }, { chips: 2, toast: false }]), file)
  ok('F6 a new chip is reported as attached', fresh.state === 'attached', JSON.stringify(fresh))
  const refused = await mod.attachFile(pageOf([{ chips: 1 }, { chips: 1, toast: true, snippet: "couldn't upload note.txt" }]), file)
  ok('F6 the page refusal is surfaced as rejected', refused.state === 'rejected' && /upload/.test(refused.reason), JSON.stringify(refused))
}

// ------------------------------------------------------- F4 line-frame survival
{
  // The child must not be able to write the live driver.log: it is the real
  // driver, so its HOME (and therefore its log) is redirected to the proof's.
  // USERPROFILE is what os.homedir() reads on Windows; HOME covers the rest.
  const childHome = path.join(os.tmpdir(), 'd5proof', 'home')
  await fs.mkdir(childHome, { recursive: true })
  const child = spawn(process.execPath, [SRC_PATH, 'serve'], {
    env: { ...process.env, CHATGPT_PROFILE: SERVE_PROFILE, CHATGPT_CDP_PORT: '9601', HOME: childHome, USERPROFILE: childHome },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const lines = []
  let buffered = ''
  child.stdout.on('data', chunk => {
    buffered += chunk.toString()
    let cut
    while ((cut = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, cut)
      buffered = buffered.slice(cut + 1)
      if (line.trim()) lines.push(JSON.parse(line))
    }
  })
  const waitFor = async (predicate, ms = 8000) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const found = lines.find(predicate)
      if (found) return found
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return null
  }
  const write = text => child.stdin.write(text)
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)))

  // G-010: the ready frame now advertises the child's own worst-case send
  // ceiling. It must be a finite positive integer, must be the value the source
  // derives (not a number typed into the emitter), and must be at least the
  // reply wait alone - the reply wait is only part of the op.
  const readyFrame = await waitFor(line => line.event === 'ready')
  const advertised = readyFrame?.sendCeilingMs
  // The advertised value is the deadline the child ENFORCES: acceptance +
  // reply + the two post-reply reads, and nothing below it. It must be a finite
  // positive integer, equal to the derived sum, at or under 8 min, and at least
  // the reply wait on its own.
  const derivedCeiling = mod.SEND_ACCEPT_DEADLINE_MS + mod.SEND_TIMEOUT_MS + 2 * mod.SEND_TAIL_MS
  ok('G010 the ready frame carries the enforced send deadline as a finite positive integer',
    Number.isInteger(advertised) && Number.isFinite(advertised) && advertised > 0
    && advertised >= 240_000 && advertised === mod.SEND_CEILING_MS && advertised === derivedCeiling
    && advertised <= 8 * 60_000
    && typeof readyFrame?.pid === 'number',
    `ready=${JSON.stringify(readyFrame)} source=${mod.SEND_CEILING_MS} derived=${derivedCeiling} parts=${mod.SEND_ACCEPT_DEADLINE_MS}+${mod.SEND_TIMEOUT_MS}+2*${mod.SEND_TAIL_MS}`)

  // The per-file attachment allowance is advertised on the SAME frame, because a
  // host that cannot read it budgets only the ceiling and declares a healthy
  // child lost mid-upload. It must be the sum of the two bounds attachFile()
  // actually uses (not a fresh literal), and the attach path must USE those
  // constants rather than keep the old numbers inline.
  const readySource = await fs.readFile(SRC_PATH, 'utf8')
  ok('G010 the ready frame advertises the per-file attachment credit',
    Number.isInteger(readyFrame?.sendAttachCreditMs) && readyFrame.sendAttachCreditMs > 0
    && readyFrame.sendAttachCreditMs === mod.SEND_ATTACH_CREDIT_MS
    && readyFrame.sendAttachCreditMs === mod.ATTACH_INPUT_TIMEOUT_MS + mod.ATTACH_CHIP_TIMEOUT_MS
    && readyFrame.sendAttachCreditMs === 300_000
    && readyFrame.sendCeilingMs === mod.SEND_CEILING_MS
    && /timeout: ATTACH_INPUT_TIMEOUT_MS/.test(readySource)
    && /timeoutMs = ATTACH_CHIP_TIMEOUT_MS/.test(readySource)
    && /sendAttachCreditMs: SEND_ATTACH_CREDIT_MS/.test(readySource),
    `ready=${JSON.stringify(readyFrame)} credit=${mod.SEND_ATTACH_CREDIT_MS} parts=${mod.ATTACH_INPUT_TIMEOUT_MS}+${mod.ATTACH_CHIP_TIMEOUT_MS}`)

  write('null\n')
  const nullFrame = await waitFor(line => line.error && /expected a JSON object/.test(line.error))
  ok('F4 a bare null frame gets a defined protocol error', !!nullFrame && nullFrame.id === null, JSON.stringify(nullFrame))
  ok('F4 the child is still alive after the null frame', child.exitCode === null, `exitCode=${child.exitCode}`)

  write('[1,2]\n')
  const arrayFrame = await waitFor(line => line.error && /expected a JSON object/.test(line.error) && lines.filter(l => l.error).length >= 2)
  ok('F4 an array frame is refused the same way', !!arrayFrame)

  write('{"op":"ping"}\n')
  const noId = await waitFor(line => line.error && /id must be a non-empty string/.test(line.error))
  ok('F4 an object with no id is refused (never an unmatchable reply)', !!noId && noId.id === null, JSON.stringify(noId))
  ok('F4 the child is still alive after the id-less frame', child.exitCode === null, `exitCode=${child.exitCode}`)

  write('{"op":"ping","id":"r1"}\n')
  const pong = await waitFor(line => line.id === 'r1')
  ok('F4 a well-formed frame is still answered with its id', !!pong && pong.ok === true && pong.op === 'ping', JSON.stringify(pong))

  // No CDP listener on this child's port, so the driver genuinely cannot be
  // asked: that is the only thing `unknown` may mean, end to end.
  write('{"op":"status","threadId":"6ae4bfc0-1111-2222-3333-444455556666","id":"s1"}\n')
  const unasked = await waitFor(line => line.id === 's1')
  ok('F8 the real status op answers unknown when there is no CDP to ask',
    unasked?.ok === true && unasked?.state === 'unknown', JSON.stringify(unasked))

  write('{"op":"quit"}\n')
  const bye = await waitFor(line => line.op === 'quit')
  ok('F4 quit is answered (id:null when the host sent none)', !!bye && bye.ok === true && bye.id === null, JSON.stringify(bye))
  const exitCode = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve('timeout'), 8000))])
  ok('F4 the child exits cleanly on quit', exitCode === 0, String(exitCode))
}

// ------------------------------------------- G-010 the ceiling is derived, not pinned
{
  // Same source, imported with a raised reply wait. If the advertised ceiling is
  // derived from the constants it must move by EXACTLY the difference; a number
  // typed into the emitter would not move at all. The copy redirects its log so
  // nothing it might write lands in the live driver.log.
  const RAISE_MS = 160_000
  // Raise one attach bound by a different amount, so a credit that merely copied
  // the reply constant cannot move with it by accident.
  const ATTACH_RAISE_MS = 45_000
  const source = await fs.readFile(SRC_PATH, 'utf8')
  const home = path.join(os.tmpdir(), 'd5proof', 'g010home')
  await fs.mkdir(home, { recursive: true })
  const copyPath = path.join(os.tmpdir(), 'd5proof', `g010-${process.pid}-${Date.now()}.mjs`)
  await fs.writeFile(copyPath, source.replace('const HOME = os.homedir()', "const HOME = process.env.D5PROOF_HOME || os.homedir()"))
  const priorTimeout = process.env.CHATGPT_TIMEOUT_MS
  const priorAttachInput = process.env.CHATGPT_ATTACH_INPUT_MS
  const priorHome = process.env.D5PROOF_HOME
  process.env.CHATGPT_TIMEOUT_MS = String(240_000 + RAISE_MS)
  process.env.CHATGPT_ATTACH_INPUT_MS = String(180_000 + ATTACH_RAISE_MS)
  process.env.D5PROOF_HOME = home
  let raised
  try {
    raised = await import(pathToFileURL(copyPath).href)
  } finally {
    if (priorTimeout === undefined) delete process.env.CHATGPT_TIMEOUT_MS
    else process.env.CHATGPT_TIMEOUT_MS = priorTimeout
    if (priorAttachInput === undefined) delete process.env.CHATGPT_ATTACH_INPUT_MS
    else process.env.CHATGPT_ATTACH_INPUT_MS = priorAttachInput
    if (priorHome === undefined) delete process.env.D5PROOF_HOME
    else process.env.D5PROOF_HOME = priorHome
  }
  const base = mod.SEND_CEILING_MS
  const moved = raised.SEND_CEILING_MS
  ok('G010 the advertised ceiling tracks the constants: a raised reply wait raises it by the same amount',
    Number.isInteger(base) && Number.isInteger(moved) && moved - base === RAISE_MS
    && /emit\(\{ event: 'ready', pid: process\.pid, sendCeilingMs: SEND_CEILING_MS, sendAttachCreditMs: SEND_ATTACH_CREDIT_MS \}\)/.test(source)
    && (source.match(/event: 'ready'/g) || []).length === 1,
    `base=${base} raised=${moved} delta=${moved - base} expected=${RAISE_MS}`)

  const baseCredit = mod.SEND_ATTACH_CREDIT_MS
  const movedCredit = raised.SEND_ATTACH_CREDIT_MS
  ok('G010 the advertised attach credit tracks the attach bounds: a raised input bound raises it by the same amount',
    Number.isInteger(baseCredit) && Number.isInteger(movedCredit) && movedCredit - baseCredit === ATTACH_RAISE_MS
    && /const SEND_ATTACH_CREDIT_MS = ATTACH_INPUT_TIMEOUT_MS \+ ATTACH_CHIP_TIMEOUT_MS/.test(source),
    `base=${baseCredit} raised=${movedCredit} delta=${movedCredit - baseCredit} expected=${ATTACH_RAISE_MS}`)

  // The advertised number must be the deadline the child ENFORCES, and it must
  // be within the host's 8 min target. The enforcement is per-await (each step
  // is railed), and the acceptance clock is paused while files attach.
  // srcOf stops at the first balanced brace, which for these two signatures is
  // the destructuring in the parameter list, not the body. Slice to the next
  // top-level declaration instead.
  const sliceBetween = (from, to) => {
    const a = source.indexOf(from)
    const b = source.indexOf(to, a)
    return a >= 0 && b > a ? source.slice(a, b) : ''
  }
  const submitBody = sliceBetween('async function submitTurn(page,', 'function normalizedTurnText(')
  const askBody = sliceBetween('async function ask(page, text,', 'async function doLogin(')
  ok('G010 the advertised value is the enforced deadline, derived from named constants',
    Number.isFinite(mod.SEND_CEILING_MS) && mod.SEND_CEILING_MS > 0
    && mod.SEND_CEILING_MS === mod.SEND_ACCEPT_DEADLINE_MS + mod.SEND_TIMEOUT_MS + 2 * mod.SEND_TAIL_MS
    && mod.SEND_CEILING_MS <= 8 * 60_000
    && /const SEND_CEILING_MS = SEND_ACCEPT_DEADLINE_MS \+ SEND_TIMEOUT_MS \+ 2 \* SEND_TAIL_MS/.test(source)
    && /const opDeadline = Number\.isFinite\(deadline\) \? deadline : Date\.now\(\) \+ SEND_ACCEPT_DEADLINE_MS/.test(submitBody)
    && /acceptDeadline = opStartedAt \+ acceptBudgetMs \+ \(Date\.now\(\) - attachStartedAt\)/.test(askBody)
    && /acceptDeadline \+ SEND_TIMEOUT_MS/.test(askBody),
    `ceiling=${mod.SEND_CEILING_MS} accept=${mod.SEND_ACCEPT_DEADLINE_MS} reply=${mod.SEND_TIMEOUT_MS} tail=${mod.SEND_TAIL_MS}`)

  // The companion invariant, and the reason the deadline is not a Promise.race
  // around the op: one REPLY frame per id. The send branch carries no opTimed,
  // the dispatcher emits exactly one result and one failure frame per request,
  // and an accepted turn that outlives the reply budget still returns the same
  // `state:'generating', timedOut:true` shape the reply budget always returned.
  const serveSrc = await srcOf('async function serve()')
  const sendBranch = serveSrc.slice(serveSrc.indexOf("if (op === 'send') {"), serveSrc.indexOf("if (op === 'attach') {"))
  ok('G010 one reply frame per id: the send is bounded inside the op, never by a second racer',
    sendBranch.length > 0 && !/opTimed\(/.test(sendBranch)
    // The single reply site and the single run() call site now live in
    // createDispatcher; there must be exactly one of each in the module.
    && (source.match(/emit\(\{ \.\.\.result, id: replyId \}\)/g) || []).length === 1
    && (source.match(/run\(request\)\.then\(/g) || []).length === 1
    && /state: 'generating', timedOut: true/.test(serveSrc)
    && /result\.timedOut/.test(serveSrc),
    `opTimed=${/opTimed\(/.test(sendBranch)} branch=${sendBranch.length} emits=${(source.match(/emit\(\{ \.\.\.result, id: replyId \}\)/g) || []).length} runs=${(source.match(/run\(request\)\.then\(/g) || []).length}`)
}

// ------------------------------------- #101 what a page-ready lets the host read
{
  // The host licenses a read per bound bridge on every page-ready. A child that
  // has just attached needs the full catch-up; a document that changed under us
  // (reload, cross-thread navigation) licenses only the thread the page moved
  // to. So the driver names which one it is. Proven on a copy whose ONLY other
  // differences are the export of startEventChannel and a fake browser in place
  // of connectOwned: no Chrome, no CDP, and its log goes to the proof's HOME.
  const now = await fs.readFile(SRC_PATH, 'utf8')
  const NL2 = now.includes('\r\n') ? '\r\n' : '\n'
  const HOME_LINE2 = 'const HOME = os.homedir()'
  const PROOF_HOME_LINE2 = "const HOME = process.env.D5PROOF_HOME || os.homedir()"
  const EXPORT_FROM = `export {${NL2}  ask, attachFile`
  const EXPORT_TO = `export {${NL2}  startEventChannel,${NL2}  ask, attachFile`
  // Three call sites say `browser = await connectOwned()`; only the channel's
  // is bracketed by the try, so this anchor is unique and asserted to be.
  const CONNECT_FROM = 'try { browser = await connectOwned() }'
  const CONNECT_TO = 'try { browser = globalThis.__d5proofBrowser }'
  const reasonSource = now.replace(HOME_LINE2, PROOF_HOME_LINE2)
    .replace(EXPORT_FROM, () => EXPORT_TO)
    .replace(CONNECT_FROM, () => CONNECT_TO)
  ok('#101 the reason copy differs from the shipped source only in its log home, the export and the fake browser',
    reasonSource !== now
    && now.split(HOME_LINE2).length === 2
    && now.split(EXPORT_FROM).length === 2
    && now.split(CONNECT_FROM).length === 2
    && reasonSource.replace(PROOF_HOME_LINE2, () => HOME_LINE2).replace(EXPORT_TO, () => EXPORT_FROM).replace(CONNECT_TO, () => CONNECT_FROM) === now)
  // A fresh home per run: the log row below counts the lines this run wrote,
  // and a shared home would carry earlier runs' lines.
  const reasonHome = path.join(os.tmpdir(), 'd5proof', `f101-home-${process.pid}-${Date.now()}`)
  await fs.mkdir(reasonHome, { recursive: true })
  const reasonPath = path.join(os.tmpdir(), 'd5proof', `f101-reason-${process.pid}-${Date.now()}.mjs`)
  await fs.writeFile(reasonPath, reasonSource)
  const priorReasonHome = process.env.D5PROOF_HOME
  process.env.D5PROOF_HOME = reasonHome
  let f101
  try { f101 = await import(pathToFileURL(reasonPath).href) } finally {
    if (priorReasonHome === undefined) delete process.env.D5PROOF_HOME
    else process.env.D5PROOF_HOME = priorReasonHome
  }

  // One fake tab. `doc` is the mark the observer reports; a frame event re-runs
  // install exactly as a reload or navigation does. The observer answers
  // `already` because a previous child installed it - the case the flag exists
  // for.
  const handlers = { session: new Map(), page: new Map(), context: new Map(), browser: new Map() }
  const on = store => (name, handler) => {
    const list = store.get(name) ?? []
    list.push(handler)
    store.set(name, list)
  }
  const fire = (store, name, arg) => { for (const handler of store.get(name) ?? []) handler(arg) }
  const THREAD_A = '6ae63007-7260-83e8-b6bc-8b67dc51667c'
  const THREAD_B = '6ae1141d-bfe0-83e8-8930-7bb0c3a25145'
  let doc = 'doc-a'
  // Marks for installs that are expected to observe DIFFERENT documents while
  // they are already queued; empty means "whatever `doc` says now".
  let docQueue = []
  // A real Runtime.evaluate costs a CDP round trip. Without that latency the
  // fake answers so fast that concurrent installs happen to serialise, and the
  // burst race cannot be reproduced; 5 ms per mark read restores it.
  let docReadDelayMs = 0
  // What the document says its thread is. `null` is a document that names no
  // thread (a new chat), which must clear a stale id rather than reuse it.
  let pathThread = THREAD_A
  const pageFake = {
    url: () => (pathThread ? `https://chatgpt.com/c/${pathThread}` : 'https://chatgpt.com/'),
    context: () => contextFake,
    on: on(handlers.page),
  }
  // In-flight protocol calls, so a row can prove installs never overlap on one
  // entry: a real evaluate waits on the CDP socket, and two installs reading at
  // once is the interleaving the per-entry chain removes.
  let activeSends = 0
  let maxActiveSends = 0
  const handleSend = async (method, params) => {
    if (method !== 'Runtime.evaluate') return {}
    const expression = String(params?.expression ?? '')
    // The observer source itself mentions location.pathname (it samples the
    // thread), so it must be recognised by the mark it sets - otherwise this
    // fake would answer the install with a thread id instead of `already` and
    // the repeat-on-the-same-document case could never be exercised.
    if (expression.includes('window.__gwObserverDoc =')) return { result: { value: 'already' } }
    if (expression === 'window.__gwObserverDoc || null') {
      if (docReadDelayMs) await new Promise(resolve => setTimeout(resolve, docReadDelayMs))
      return { result: { value: docQueue.length ? docQueue.shift() : doc } }
    }
    if (expression.includes('location.pathname')) return { result: { value: pathThread } }
    if (expression === 'window.__gwPush && window.__gwPush()') return { result: { value: true } }
    return { result: { value: 'already' } }
  }
  const sessionFake = {
    async send(method, params) {
      activeSends += 1
      if (activeSends > maxActiveSends) maxActiveSends = activeSends
      try { return await handleSend(method, params) } finally { activeSends -= 1 }
    },
    on: on(handlers.session),
    async detach() {},
  }
  const contextFake = {
    pages: () => [pageFake],
    on: on(handlers.context),
    newCDPSession: async () => sessionFake,
  }
  const browserFake = {
    contexts: () => [contextFake],
    on: on(handlers.browser),
    async close() {},
    removeAllListeners() {},
  }
  globalThis.__d5proofBrowser = browserFake
  const emitted = []
  const channel = f101.startEventChannel(value => emitted.push(value))
  channel.start()
  const settle = () => new Promise(resolve => setTimeout(resolve, 40))
  await settle()
  const firstReady = emitted.filter(value => value.event === 'page-ready')
  ok('#101 the first page-ready after a child attaches says attach, naming the document thread',
    firstReady.length === 1 && firstReady[0].reason === 'attach' && firstReady[0].threadId === THREAD_A,
    JSON.stringify(firstReady))

  // The case that failed live: a cross-thread send loads a new document, and at
  // that instant no push has named the thread yet. The emit must still carry the
  // thread the page moved to, read from the document itself.
  doc = 'doc-b'
  pathThread = THREAD_B
  fire(handlers.session, 'Page.frameNavigated', {})
  await settle()
  const afterNav = emitted.filter(value => value.event === 'page-ready')
  ok('#101 a cross-thread document change says document and names the thread it moved to',
    afterNav.length === 2 && afterNav[1].reason === 'document' && afterNav[1].threadId === THREAD_B,
    JSON.stringify(afterNav))

  // The same document signalled again is not news: it must stay silent, and the
  // field is additive - exactly event, threadId and reason, nothing else.
  fire(handlers.session, 'Page.frameNavigated', {})
  await settle()
  const afterSame = emitted.filter(value => value.event === 'page-ready')
  const shapeHeld = afterSame.length === 2 && afterSame.every(value => {
    const keys = Object.keys(value).sort().join(',')
    return keys === 'event,reason,threadId'
  })
  ok('#101 a repeated look on the same document stays silent and the event shape is unchanged',
    shapeHeld, JSON.stringify(afterSame))

  // A document that names no thread (a new chat) must not inherit the previous
  // one: a stale id would scope this page-ready to the bridge that owns the old
  // thread. Null keeps the host on the wide catch-up.
  doc = 'doc-c'
  pathThread = null
  fire(handlers.session, 'Page.frameNavigated', {})
  await settle()
  const afterNoThread = emitted.filter(value => value.event === 'page-ready')
  ok('#101 a document with no /c/<id> emits a null thread and stays on the wide path',
    afterNoThread.length === 3 && afterNoThread[2].reason === 'document' && afterNoThread[2].threadId === null,
    JSON.stringify(afterNoThread))

  // One navigation fires several frame/load events. The page-ready EVENT stream
  // was already one per document change - `announced` is set synchronously at
  // emit, so a second install on the same mark sees it - and the five live lines
  // of 2026-11-01 were LOG lines printed above that guard, not five events. What
  // did race was the installs themselves: two reading one CDP session at once.
  // This row pins the event count for a back-to-back burst; the row below pins
  // the session.
  doc = 'doc-d'
  pathThread = THREAD_A
  docReadDelayMs = 5
  maxActiveSends = 0
  fire(handlers.session, 'Page.frameNavigated', {})
  fire(handlers.session, 'Page.frameNavigated', {})
  await settle()
  const afterBurst = emitted.filter(value => value.event === 'page-ready')
  ok('#103 a burst of frames for one document change emits exactly one page-ready',
    afterBurst.length === 4
    && afterBurst[3].reason === 'document' && afterBurst[3].threadId === THREAD_A,
    JSON.stringify(afterBurst))
  ok('#103 installs for one entry never overlap on the CDP session',
    maxActiveSends === 1, `max-in-flight=${maxActiveSends} events=${afterBurst.length}`)

  // Serialising must not swallow real news: two frames describing two
  // DIFFERENT documents must still emit one page-ready each.
  docQueue = ['doc-e', 'doc-f']
  pathThread = THREAD_B
  fire(handlers.session, 'Page.frameNavigated', {})
  fire(handlers.session, 'Page.frameNavigated', {})
  await settle()
  const afterTwoDocs = emitted.filter(value => value.event === 'page-ready')
  ok('#103 two distinct documents inside one burst still emit one page-ready each',
    afterTwoDocs.length === 6
    && afterTwoDocs[4].reason === 'document' && afterTwoDocs[4].threadId === THREAD_B
    && afterTwoDocs[5].reason === 'document' && afterTwoDocs[5].threadId === THREAD_B,
    JSON.stringify(afterTwoDocs))
  await channel.stop()
  try { await f101.flushLog?.() } catch {}
  // The event-channel note is written only when a page-ready is EMITTED, so the
  // log must carry exactly one `page-ready` line per emitted event. The live
  // 2026-11-01 case printed five lines for one event and read as a burst.
  const logText = await fs.readFile(path.join(reasonHome, '.chatgpt-web', 'driver.log'), 'utf8')
  const noteLines = logText.split(/\r?\n/).filter(line => line.includes('event channel: page-ready'))
  const eventCount = emitted.filter(value => value.event === 'page-ready').length
  ok('#103 the event-channel log carries one page-ready line per emitted event',
    noteLines.length === eventCount && eventCount > 0,
    `lines=${noteLines.length} events=${eventCount}`)
}

const failed = results.filter(result => !result.pass)
console.log(`\n${results.length - failed.length}/${results.length} proofs passed`)
if (failed.length) { console.log(failed.map(item => `  FAILED: ${item.name}`).join('\n')); process.exitCode = 1 }
