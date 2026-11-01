/**
 * G-011 follow-up probe: can a failed `rename` over peer.json cost state?
 *
 * Measurement only, no fix. Runs the real `saveJson` (scripts/chatgpt-peer/
 * state.ts) against a scratch directory under the OS temp root, never the live
 * `C:\Users\Ahmed\chatgpt-web\peer.json`.
 *
 * Cases:
 *   A  baseline           - N sequential saves, no other handle
 *   B1 FileShare.Read     - a PowerShell handle that permits read but not
 *                           write/delete, held across N saves
 *   B2 FileShare.None     - the same, with an exclusive handle
 *   C1 a held Bun read    - `open(path, 'r')` kept open across N saves
 *   C2 tight readFile     - a reader loop as fast as the event loop allows
 *   C3 25 ms readFile     - the G-011 `waitFor(hostAudit)` cadence
 *   D  two writers        - two Bun processes saving the same target
 *
 * Prints one line per case: failures / attempts, the distinct error codes and
 * messages, leftover `.tmp` files, and whether the target still parses.
 */
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { saveJson } from './chatgpt-peer/state.ts'

const delay = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const root = await mkdtemp(join(tmpdir(), 'g011-eperm-'))
const errors: string[] = []

interface CaseResult {
  name: string
  attempts: number
  failures: number
  codes: string[]
  messages: string[]
  leftovers: number
  target: string
  targetParses: boolean
}

async function freshTarget(name: string): Promise<string> {
  const path = join(root, `${name}.json`)
  await saveJson(path, { case: name, n: -1 })
  return path
}

const tmpCount = async (path: string): Promise<number> =>
  (await readdir(root)).filter(entry => entry.startsWith(`${path.split(/[\\/]/).pop()!}.`) && entry.endsWith('.tmp')).length

function pay(n: number): { case: string; n: number; padding: string } {
  return { case: 'payload', n, padding: 'x'.repeat(200) }
}

/** Run N saves, collecting rejections. */
async function saves(path: string, from: number, count: number): Promise<{ failures: number; codes: string[]; messages: string[] }> {
  let failures = 0
  const codes: string[] = []
  const messages: string[] = []
  for (let i = 0; i < count; i += 1) {
    try { await saveJson(path, pay(from + i)) }
    catch (error) {
      failures += 1
      const err = error as NodeJS.ErrnoException
      codes.push(String(err.code ?? 'none'))
      messages.push(err.message)
    }
  }
  return { failures, codes, messages }
}

async function finish(name: string, path: string, attempts: number, result: { failures: number; codes: string[]; messages: string[] }): Promise<CaseResult> {
  const leftovers = await tmpCount(path)
  let parses = false
  try { JSON.parse(await readFile(path, 'utf8')); parses = true } catch {}
  return { name, attempts, failures: result.failures, codes: [...new Set(result.codes)], messages: [...new Set(result.messages)].slice(0, 3), leftovers, target: path, targetParses: parses }
}

const report = (r: CaseResult): void => {
  console.log(`[case ${r.name}] ${r.failures}/${r.attempts} failed | codes=${JSON.stringify(r.codes)} | tmp_left=${r.leftovers} | target_parses=${r.targetParses}`)
  for (const m of r.messages) console.log(`         ${m}`)
}

/** Hold a Windows handle on `path` with the given share mode until the child exits. */
async function holdHandle(path: string, share: 'Read' | 'None'): Promise<{ waitOpen: () => Promise<void>; waitExit: () => Promise<void>; stop: () => void }> {
  const script = [
    '$ErrorActionPreference="Stop"',
    `$fs=[System.IO.File]::Open('${path.replace(/'/g, "''")}','Open','Read','${share}')`,
    '[Console]::Out.WriteLine("open")',
    '[Console]::Out.Flush()',
    'Start-Sleep -Milliseconds 6000',
    '$fs.Dispose()',
    '[Console]::Out.WriteLine("closed")',
    '[Console]::Out.Flush()',
  ].join('; ')
  const child = execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script])
  let opened: () => void = () => {}
  let exited: () => void = () => {}
  const openSeen = new Promise<void>(resolveOpen => { opened = resolveOpen })
  const exitSeen = new Promise<void>(resolveExit => { exited = resolveExit })
  let buffer = ''
  child.stdout?.on('data', chunk => {
    buffer += String(chunk)
    if (buffer.includes('open')) opened()
  })
  child.on('exit', () => exited())
  child.on('error', () => { opened(); exited() })
  return {
    waitOpen: () => Promise.race([openSeen, delay(5000)]),
    waitExit: () => Promise.race([exitSeen, delay(9000)]),
    stop: () => { try { child.kill() } catch {} },
  }
}

// --- A: baseline -------------------------------------------------------------
{
  const path = await freshTarget('a-baseline')
  report(await finish('A baseline (no second handle)', path, 200, await saves(path, 0, 200)))
}

// --- B1: Windows handle, read share only ------------------------------------
{
  const path = await freshTarget('b1-share-read')
  const holder = await holdHandle(path, 'Read')
  await holder.waitOpen()
  const result = await saves(path, 0, 50)
  await holder.waitExit()
  // Recovery: does the next save succeed after the holder is gone?
  let recovered = false
  try { await saveJson(path, pay(999)); recovered = true } catch {}
  const done = await finish('B1 FileShare.Read held across saves', path, 50, result)
  console.log(`[case B1] recovered_after_release=${recovered}`)
  report(done)
  holder.stop()
}

// --- B2: Windows handle, no sharing -----------------------------------------
{
  const path = await freshTarget('b2-share-none')
  const holder = await holdHandle(path, 'None')
  await holder.waitOpen()
  const result = await saves(path, 0, 50)
  await holder.waitExit()
  let recovered = false
  try { await saveJson(path, pay(999)); recovered = true } catch {}
  const done = await finish('B2 FileShare.None held across saves', path, 50, result)
  console.log(`[case B2] recovered_after_release=${recovered}`)
  report(done)
  holder.stop()
}

// --- C1: a held Bun read handle ---------------------------------------------
{
  const path = await freshTarget('c1-held-open')
  const handle = await open(path, 'r')
  const result = await saves(path, 0, 200)
  await handle.close()
  report(await finish('C1 Bun open(r) held across saves', path, 200, result))
}

// --- C2: tight concurrent readers -------------------------------------------
{
  const path = await freshTarget('c2-tight-read')
  let stop = false
  let reads = 0
  const reader = (async () => { while (!stop) { try { await readFile(path, 'utf8'); reads += 1 } catch {} } })()
  const result = await saves(path, 0, 300)
  stop = true
  await reader
  console.log(`[case C2] concurrent reads=${reads}`)
  report(await finish('C2 tight readFile loop', path, 300, result))
}

// --- C3: the G-011 waitFor cadence ------------------------------------------
{
  const path = await freshTarget('c3-25ms-read')
  let stop = false
  let reads = 0
  const reader = (async () => { while (!stop) { try { await readFile(path, 'utf8'); reads += 1 } catch {} await delay(25) } })()
  const started = Date.now()
  let attempts = 0
  let failures = 0
  const codes: string[] = []
  const messages: string[] = []
  while (Date.now() - started < 4000) {
    attempts += 1
    try { await saveJson(path, pay(attempts)) }
    catch (error) {
      failures += 1
      const err = error as NodeJS.ErrnoException
      codes.push(String(err.code ?? 'none'))
      messages.push(err.message)
    }
  }
  stop = true
  await reader
  console.log(`[case C3] reads=${reads} writes=${attempts}`)
  report(await finish('C3 25 ms readFile (G-011 waitFor)', path, attempts, { failures, codes, messages }))
}

// --- D: two Bun writer processes --------------------------------------------
{
  const path = await freshTarget('d-two-writers')
  const scriptPath = join(root, 'writer.ts')
  await writeFile(scriptPath, `
import { saveJson } from ${JSON.stringify(resolve(import.meta.dir, 'chatgpt-peer', 'state.ts'))}
const path = ${JSON.stringify(path)}
let failures = 0
const codes = []
for (let i = 0; i < 150; i += 1) {
  try { await saveJson(path, { writer: process.argv[2], n: i }) }
  catch (error) { failures += 1; codes.push(String(error.code)) }
}
process.stdout.write(JSON.stringify({ failures, codes: [...new Set(codes)] }) + '\\n')
`, 'utf8')
  const run = (tag: string): Promise<{ failures: number; codes: string[] }> => new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [scriptPath, tag], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', chunk => { out += String(chunk) })
    child.on('exit', code => {
      try { resolveRun(JSON.parse(out.trim().split('\n').pop()!)) }
      catch { rejectRun(new Error(`writer ${tag} exited ${code}: ${out}`)) }
    })
  })
  const [one, two] = await Promise.all([run('one'), run('two')])
  const combined = { failures: one.failures + two.failures, codes: [...new Set([...one.codes, ...two.codes])], messages: [] as string[] }
  console.log(`[case D] writer1=${JSON.stringify(one)} writer2=${JSON.stringify(two)}`)
  report(await finish('D two Bun writers, 150 saves each', path, 300, combined))
}

console.log(`[probe] scratch root ${root}`)
errors.push('done')
await rm(root, { recursive: true, force: true })
