/**
 * OSC 21338 survival probe. Run INSIDE a Windows Terminal tab:
 *
 *   bun run scripts/osc-probe-21338.ts
 *
 * Emits the real element-map sequence produced by encodeElementMap() - the
 * same bytes the render-pass emitter will write - then a sentinel + ruler line
 * so that any leak, swallowing or reflow shows up in the terminal buffer.
 * Each case is preceded by a coloured bar so a parser-state corruption would
 * be visible as colour bleed in a screenshot.
 *
 * Evidence is read from OUTSIDE the process (UIA text of the WT buffer,
 * clipboard, tab titles, screenshot) by osc-probe-run.ps1. This file only
 * writes bytes - and records the exact bytes it wrote to written.txt.
 */
import { Buffer } from 'buffer'
import { writeFileSync } from 'fs'
import { encodeElementMap, stripElementMap, createStripState } from '../src/ink/element-map.ts'
import type { ElementMapFrame, MapElement } from '../src/ink/element-map.ts'

const ESC = '\x1b'
const BEL = '\x07'
const ST = ESC + '\\'
const OSC_PREFIX = ESC + ']'
const OUT = 'C:\\Users\\Ahmed\\oscprobe\\written.txt'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const emit = (s: string) => {
  process.stdout.write(s)
}
const notes: string[] = []

/** N synthetic nodes, shaped like the map the emitter will build. */
function frameOf(gen: number, count: number): ElementMapFrame {
  const els: MapElement[] = []
  for (let i = 0; i < count; i++) {
    els.push({
      id: `n${i}`,
      role: i % 5 === 0 ? 'box' : 'text',
      r: [i % 78, i % 22, 12, 1],
      label: `element ${i} label text `.repeat(2).slice(0, 40),
      ...(i % 7 === 0 ? { act: { t: 'ptr' as const, x: i % 78, y: i % 22, b: 0 as const } } : {}),
    })
  }
  return { v: 1, gen, cols: 80, rows: 24, els }
}

function encoded(frame: ElementMapFrame): { sequence: string; bytes: number } {
  const r = encodeElementMap(frame)
  if (!r.ok) throw new Error(`encode refused: ${r.reason} ${r.bytes}`)
  return { sequence: r.sequence, bytes: Buffer.byteLength(JSON.stringify(frame), 'utf8') }
}

function frameUpTo(gen: number, targetBytes: number): { sequence: string; bytes: number } {
  let lo = 1
  let hi = 400
  let best: { sequence: string; bytes: number } | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const frame = frameOf(gen, mid)
    const r = encodeElementMap(frame)
    const bytes = Buffer.byteLength(JSON.stringify(frame), 'utf8')
    if (r.ok && bytes <= targetBytes) {
      best = { sequence: r.sequence, bytes }
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (!best) throw new Error(`no legal frame under ${targetBytes}B`)
  return best
}

/** ESC as ^[ and other controls spelled out, for the written-bytes record. */
function visibleBytes(s: string): string {
  return s
    .replaceAll(ESC, '^[')
    .replaceAll(BEL, '^G')
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')
}

function caseSeq(id: string, sequence: string, note = ''): void {
  emit(`\x1b[42;30mCASE ${id} COLOUR-BAR ${note}\x1b[0m\n`)
  emit(`MARK ${id} BEGIN ${note}\n`)
  emit(sequence)
  emit(`MARK ${id} SENTINEL\n`)
  emit(`${id}-RULER-${'0123456789'.repeat(6)}\n`)
}

const main = async () => {
  emit('OSCPROBE-21338 v2 START\n')
  emit(
    `ENV WT_SESSION=${process.env.WT_SESSION ?? '<unset>'} ` +
      `WT_PROFILE_ID=${process.env.WT_PROFILE_ID ?? '<unset>'} ` +
      `MUXTEE_ACTIVE=${process.env.MUXTEE_ACTIVE ?? '<unset>'} ` +
      `TERM_PROGRAM=${process.env.TERM_PROGRAM ?? '<unset>'} ` +
      `ppid=${process.ppid}\n`,
  )
  emit(`RULER-TOP-${'0123456789'.repeat(6)}\n`)
  await sleep(600)

  // --- canaries: OSC WT is expected to ACT on -----------------------------
  emit(`\nMARK C1-TITLE-ST BEGIN\n`)
  emit(`${OSC_PREFIX}2;OSCPROBE-21338-TITLE-ST${ST}`)
  emit(`MARK C1-TITLE-ST SENTINEL\n`)
  emit(`C1-RULER-${'0123456789'.repeat(6)}\n`)
  await sleep(1200)

  emit(`\nMARK C2-TITLE-BEL BEGIN\n`)
  emit(`${OSC_PREFIX}2;OSCPROBE-21338-TITLE-BEL${BEL}`)
  emit(`MARK C2-TITLE-BEL SENTINEL\n`)
  emit(`C2-RULER-${'0123456789'.repeat(6)}\n`)
  await sleep(1200)

  // Clipboard with a 32 KB payload, both terminators: if the exact bytes land,
  // a payload that size traverses conpty -> WT unmodified. 21338 itself cannot
  // give byte-exactness because WT has no handler for it.
  const big = 'C'.repeat(32 * 1024)
  emit(`\nMARK D1-CLIP-32K-ST BEGIN\n`)
  emit(`${OSC_PREFIX}52;c;${Buffer.from(big, 'utf8').toString('base64')}${ST}`)
  emit(`MARK D1-CLIP-32K-ST SENTINEL\n`)
  emit(`D1-RULER-${'0123456789'.repeat(6)}\n`)
  await sleep(1600)

  emit(`\nMARK D2-CLIP-32K-BEL BEGIN\n`)
  emit(`${OSC_PREFIX}52;c;${Buffer.from(big.replaceAll('C', 'D'), 'utf8').toString('base64')}${BEL}`)
  emit(`MARK D2-CLIP-32K-BEL SENTINEL\n`)
  emit(`D2-RULER-${'0123456789'.repeat(6)}\n`)
  await sleep(1600)

  // --- the sequence under test: OSC 21338 ---------------------------------
  const tiny = encoded(frameOf(1, 10))
  const mid = frameUpTo(2, 8 * 1024)
  const max = frameUpTo(3, 32 * 1024)
  emit(`\nPAYLOAD-BYTES tiny=${tiny.bytes} mid=${mid.bytes} max=${max.bytes}\n`)
  emit(`SEQUENCE-CHARS tiny=${tiny.sequence.length} mid=${mid.sequence.length} max=${max.sequence.length}\n`)

  caseSeq('M1-21338-ST', tiny.sequence, `(${tiny.bytes}B json, ST)`)
  await sleep(1200)
  caseSeq('M2-21338-BEL', tiny.sequence.slice(0, -2) + BEL, `(${tiny.bytes}B json, BEL)`)
  await sleep(1200)
  caseSeq('M3-21338-8K-ST', mid.sequence, `(${mid.bytes}B json, ST)`)
  await sleep(1800)
  caseSeq('M4-21338-8K-BEL', mid.sequence.slice(0, -2) + BEL, `(${mid.bytes}B json, BEL)`)
  await sleep(1800)
  caseSeq('M5-21338-32K-ST', max.sequence, `(${max.bytes}B json, largest legal, ST)`)
  await sleep(2000)
  caseSeq('M6-21338-32K-BEL', max.sequence.slice(0, -2) + BEL, `(${max.bytes}B json, largest legal, BEL)`)
  await sleep(2000)

  // Inline: text, sequence, text - no newline between. A leak shows as base64
  // on the line; a swallowed sequence leaves the two halves adjacent.
  emit(`\nMARK M7-INLINE BEGIN\n`)
  emit('INLINE-BEFORE|')
  emit(tiny.sequence)
  emit('|INLINE-AFTER\n')
  emit(`M7-RULER-${'0123456789'.repeat(6)}\n`)
  await sleep(1400)

  // Frame-rate burst: 20 sequences back to back like a fast redraw.
  emit(`\nMARK M8-BURST BEGIN\n`)
  for (let i = 0; i < 20; i++) emit(tiny.sequence)
  emit('M8-SENTINEL\n')
  emit(`M8-RULER-${'0123456789'.repeat(6)}\n`)
  await sleep(1500)

  // --- comparison: the original candidate, same run ------------------------
  emit(`\nMARK A1-1337-ST BEGIN\n`)
  emit(`${OSC_PREFIX}1337;File=name=probe;inline=1:QUJD${ST}`)
  emit(`MARK A1-1337-ST SENTINEL\n`)
  emit(`A1-RULER-${'0123456789'.repeat(6)}\n`)
  await sleep(1200)

  // --- record the exact bytes this process wrote --------------------------
  notes.push(`tiny sequence (${tiny.sequence.length} chars): ${visibleBytes(tiny.sequence)}`)
  notes.push(`mid  sequence head: ${visibleBytes(mid.sequence.slice(0, 80))}...`)
  notes.push(`max  sequence head: ${visibleBytes(max.sequence.slice(0, 80))}...`)
  notes.push(`mid  terminator: ${visibleBytes(mid.sequence.slice(-2))}`)
  notes.push(`BEL  variant terminator: ${visibleBytes(tiny.sequence.slice(0, -2) + BEL)}`.slice(0, 120))
  writeFileSync(OUT, notes.join('\n') + '\n')

  // Self-check: the consumer's stripper must recover every frame emitted here
  // and leave surrounding text intact.
  const state = createStripState()
  const stream = `A${tiny.sequence}B${mid.sequence}C`
  const stripped = stripElementMap(stream, state)
  emit(`\nSELFCHECK text=${JSON.stringify(stripped.text)} frames=${stripped.frames.map(f => f.gen).join(',')} dropped=${state.dropped}\n`)

  emit(`\nOSCPROBE-21338 v2 ALL-DONE\n`)
  emit(`RULER-BOTTOM-${'0123456789'.repeat(6)}\n`)
  setInterval(() => {}, 60_000)
}

void main()
