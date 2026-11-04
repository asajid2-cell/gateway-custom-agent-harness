/**
 * A headless door onto the vault writer, so an import or a grader never has to
 * be driven by hand inside a session.
 *
 *   bun scripts/vault-cli.ts verify --vault <path> [--family <id>]
 *   bun scripts/vault-cli.ts repair --vault <path> --family <id>
 *   bun scripts/vault-cli.ts admit  --vault <path> --family <id> --generation <g>
 *   bun scripts/vault-cli.ts submit --vault <path> --family <id> --generation <g> --file <proposals.jsonl> [--idempotency-key <k>]
 *
 * JSON on stdout. Exit 0 when the work succeeded, 1 when anything was refused,
 * 2 for a usage error. A submit whose idempotency key is omitted uses the
 * SHA-256 of the proposal file, so re-running the same file is a replay rather
 * than a second import.
 */
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  activeGeneration,
  admitGeneration,
  familyJournalPath,
  repairTornTail,
  verifyJournal,
} from '../src/utils/vault/journal.js'
import { submitProposals } from '../src/utils/vault/submit.js'

type Args = Record<string, string | true>

function parseArgs(argv: string[]): { command: string; args: Args } {
  const [command = '', ...rest] = argv
  const args: Args = {}
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!
    if (!token.startsWith('--')) {
      throw new Error(`unexpected argument '${token}'`)
    }
    const name = token.slice(2)
    const next = rest[index + 1]
    if (next === undefined || next.startsWith('--')) {
      args[name] = true
    } else {
      args[name] = next
      index += 1
    }
  }
  return { command, args }
}

function required(args: Args, name: string): string {
  const value = args[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`--${name} is required`)
  }
  return value
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

async function familiesIn(vaultRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(join(vaultRoot, 'families'), { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function main(): Promise<number> {
  const { command, args } = parseArgs(process.argv.slice(2))
  const vaultRoot = required(args, 'vault')

  if (command === 'verify') {
    const named = typeof args.family === 'string' ? [args.family] : await familiesIn(vaultRoot)
    const results = []
    for (const familyId of named) {
      const verification = await verifyJournal(vaultRoot, familyId)
      results.push({ family_id: familyId, ...verification })
    }
    const ok = results.every(result => result.ok)
    print({ ok, vault: vaultRoot, checked: results.length, families: results })
    return ok ? 0 : 1
  }

  if (command === 'repair') {
    const familyId = required(args, 'family')
    const result = await repairTornTail(vaultRoot, familyId)
    print({ ok: true, family_id: familyId, ...result })
    return 0
  }

  if (command === 'admit') {
    // Imports and the first activation need a generation before a writer will
    // accept anything; this is the same admission the activation gate writes.
    const familyId = required(args, 'family')
    const generation = required(args, 'generation')
    const existing = await activeGeneration(vaultRoot, familyId)
    if (existing === generation) {
      print({ ok: true, family_id: familyId, generation, already: true })
      return 0
    }
    await admitGeneration(vaultRoot, familyId, {
      kind: 'admission',
      generation_id: generation,
      actor: typeof args.actor === 'string' ? args.actor : 'vault-cli',
    })
    print({ ok: true, family_id: familyId, generation, already: false })
    return 0
  }

  if (command === 'submit') {
    const familyId = required(args, 'family')
    const generation = required(args, 'generation')
    const file = required(args, 'file')
    const bytes = await readFile(file)
    const proposals = bytes
      .toString('utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line !== '')
      .map((line, index) => {
        try {
          return JSON.parse(line)
        } catch (error) {
          throw new Error(`${file}:${index + 1} is not JSON: ${(error as Error).message}`)
        }
      })
    const idempotencyKey =
      typeof args['idempotency-key'] === 'string'
        ? (args['idempotency-key'] as string)
        : `file:${createHash('sha256').update(bytes).digest('hex')}`
    const result = await submitProposals({
      vaultRoot,
      familyId,
      generation,
      idempotencyKey,
      proposals,
    })
    const ok = result.rejected.length === 0
    print({ ok, family_id: familyId, idempotency_key: idempotencyKey, journal: familyJournalPath(vaultRoot, familyId), ...result })
    return ok ? 0 : 1
  }

  throw new Error('usage: vault-cli.ts <verify|repair|submit> --vault <path> ...')
}

try {
  process.exit(await main())
} catch (error) {
  print({ ok: false, error: (error as Error).message })
  process.exit(2)
}
