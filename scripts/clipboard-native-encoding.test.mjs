import assert from 'node:assert/strict'
import test from 'node:test'

import { WINDOWS_CLIPBOARD_SCRIPT, win32ClipboardCommand } from '../src/ink/termio/osc.js'
import { execFileNoThrow } from '../src/utils/execFileNoThrow.js'

/**
 * The Windows native clipboard write must decode its stdin as UTF-8.
 *
 * It used to run `clip`, which decodes stdin with the console output code
 * page. execa spawns children with `windowsHide` (its default), so the child
 * has no console and falls back to the system OEM code page — 437 here. Every
 * multibyte UTF-8 character was then read as its OEM bytes and written to the
 * clipboard as those glyphs, so a copied box-drawing rule landed as `ΓöÇΓöÇ`
 * and accented or CJK text was mangled the same way. The safety net was
 * corrupting a clipboard OSC 52 had often already filled correctly.
 */
const UNICODE = 'AB\u2500\u2500CD \u2014 caf\u00e9 \u4e2d\u6587 \u251c\u2500\u2500\u2524'
const utf8Hex = text =>
  Buffer.from(text, 'utf8').toString('hex').toUpperCase().match(/../g).join('-')

test('the Windows clipboard command does not go through clip.exe', () => {
  const { file, args } = win32ClipboardCommand()
  assert.doesNotMatch(file, /clip/i)
  assert.ok(!args.some(arg => /(^|[\\/])clip(\.exe)?$/i.test(arg)))
  // The payload is read from stdin, so it is never interpolated into the
  // command line — no quoting hazard and no command-line length limit.
  assert.ok(!args.some(arg => arg.includes(UNICODE)))
})

test('the Windows clipboard command sets an explicit UTF-8 input encoding', () => {
  assert.match(WINDOWS_CLIPBOARD_SCRIPT, /\[Console\]::InputEncoding=\[Text\.Encoding\]::UTF8/)
  assert.ok(
    WINDOWS_CLIPBOARD_SCRIPT.indexOf('[Console]::InputEncoding') <
      WINDOWS_CLIPBOARD_SCRIPT.indexOf('ReadToEnd'),
    'the encoding must be set before stdin is read',
  )
})

/**
 * Run the real script through the real wrapper, with `Set-Clipboard` shadowed
 * by a function that emits the bytes it was handed. PowerShell resolves a
 * function ahead of the cmdlet of the same name, so the decode under test is
 * the production decode while the test stays off the user's clipboard.
 *
 * The observation is hex because the child has no console either: ANY
 * non-ASCII stdout from an execa child is corrupted on the way back, which is
 * the same defect as the one under test and would otherwise mask it. Hex is
 * ASCII, so it survives.
 */
test('the Windows clipboard script decodes its stdin as UTF-8', { skip: process.platform !== 'win32' }, async () => {
  const shadow =
    'function Set-Clipboard { param([Parameter(ValueFromPipeline=$true)]$Value) ' +
    '[Console]::Out.Write([BitConverter]::ToString([Text.Encoding]::UTF8.GetBytes($Value))) }; '
  const result = await execFileNoThrow(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', shadow + WINDOWS_CLIPBOARD_SCRIPT],
    { input: UNICODE, useCwd: false },
  )
  assert.equal(result.code, 0, `powershell must succeed; stderr=${result.stderr}`)
  assert.equal(result.stdout, utf8Hex(UNICODE))
})
