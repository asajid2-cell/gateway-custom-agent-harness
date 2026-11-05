/**
 * A headless door onto the vault writer, so an import or a grader never has to
 * be driven by hand inside a session.
 *
 *   bun scripts/vault-cli.ts verify --vault <path> [--family <id>]
 *   bun scripts/vault-cli.ts repair --vault <path> --family <id>
 *   bun scripts/vault-cli.ts admit  --vault <path> --family <id> --generation <g> [--import --reason <text>]
 *   bun scripts/vault-cli.ts submit --vault <path> --family <id> --generation <g> --file <proposals.jsonl> [--idempotency-key <k>]
 *   bun scripts/vault-cli.ts confer-driver --vault <path> --family <id> --session <sid> [--turn <t>] [--invocation-id <id>] [--mode monitor|enforce] [--as-harness [--scope a,b] [--root-name n] [--head sid]]
 *   bun scripts/vault-cli.ts capture  --vault <path> --family <id> --session <sid> --message <mid> --root <name> --path <relative> --sha <sha256>
 *   bun scripts/vault-cli.ts capture-transcript --vault <path> --family <id> --session <sid> --root <name> --path <relative> --file <transcript.jsonl>
 *   bun scripts/vault-cli.ts capture-mark --vault <path> --family <id> --capture-id <id> --event <event_id>
 *   bun scripts/vault-cli.ts captures --vault <path> --family <id> [--pending]
 *   bun scripts/vault-cli.ts register-scribe --vault <path> --family <id> --session <sid> [--generation <g>] [--replace]
 *   bun scripts/vault-cli.ts rotation-complete --vault <path> --family <id> --from <gen> --to <gen> [--pointer <pointer.json>]
 *
 * JSON on stdout. Exit 0 when the work succeeded, 1 when anything was refused,
 * 2 for a usage error. A submit whose idempotency key is omitted uses the
 * SHA-256 of the proposal file, so re-running the same file is a replay rather
 * than a second import.
 */
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  activeGeneration,
  admitGeneration,
  familyJournalPath,
  repairTornTail,
  verifyJournal,
} from '../src/utils/vault/journal.js'
import { admitDriverDesignation, completeRotation, conferDriverAdmission, registerScribe } from '../src/utils/vault/activation.js'
import { captureCompleteness, capturePointer, captureTranscript, listCaptures, markCaptured } from '../src/utils/vault/capture.js'
import { recall } from '../src/utils/vault/recall.js'
import { obligationPolicy, readGatewaySettings } from '../src/utils/vault/settings.js'
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
  // The install's obligation policy, read once. A malformed settings file falls
  // back to the defaults rather than failing a read of the vault: the vault is
  // the authority, the policy is a knob.
  const settingsRead = await readGatewaySettings()
  const policy = obligationPolicy(settingsRead.ok ? settingsRead.settings : {})

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
    // accept anything. An import fence is a different kind: it sets the active
    // generation but is not an activation and must say why it exists.
    const familyId = required(args, 'family')
    const generation = required(args, 'generation')
    const kind = args.import === true || args.kind === 'import_admission' ? 'import_admission' : 'admission'
    const reason = typeof args.reason === 'string' ? args.reason : ''
    if (kind === 'import_admission' && reason.trim() === '') {
      throw new Error('--reason is required for an import admission')
    }
    const existing = await activeGeneration(vaultRoot, familyId)
    if (existing === generation) {
      print({ ok: true, family_id: familyId, generation, kind, already: true })
      return 0
    }
    await admitGeneration(vaultRoot, familyId, {
      kind,
      generation_id: generation,
      ...(kind === 'import_admission' ? { reason } : {}),
      actor: typeof args.actor === 'string' ? args.actor : 'vault-cli',
    })
    print({ ok: true, family_id: familyId, generation, kind, already: false })
    return 0
  }

  if (command === 'confer-driver') {
    // The same gate `conferDriver` calls, not a second implementation: a headless
    // caller must not be able to reach a weaker door than the interactive one.
    const mode = args.mode === 'enforce' ? 'enforce' : 'monitor'
    // --as-harness drives the same function conferDriver calls, including the
    // charter write. Without it this is the gate alone, which is what a test of
    // the gate should use; with it, a script can prove the writer too.
    if (args['as-harness'] === true) {
      const scope = typeof args.scope === 'string' && args.scope.trim() !== ''
        ? args.scope.split(',').map(entry => entry.trim()).filter(entry => entry !== '')
        : []
      const harnessResult = await admitDriverDesignation({
        vaultRoot,
        familyId: required(args, 'family'),
        driverSessionId: required(args, 'session'),
        scope,
        mode,
        rootName: typeof args['root-name'] === 'string' ? (args['root-name'] as string) : undefined,
        headSessionId: typeof args.head === 'string' ? (args.head as string) : undefined,
        maxPending: policy.maxPending,
        overdueHours: policy.overdueHours,
      })
      if (!harnessResult) {
        print({
          ok: false,
          family_id: required(args, 'family'),
          reason: 'unknown-family',
          message: 'the family is not registered in this vault; monitor mode skips it rather than refusing',
        })
        return 1
      }
      print(harnessResult)
      return harnessResult.ok ? 0 : 1
    }
    const explicitTurn = typeof args.turn === 'string'
    const result = await conferDriverAdmission({
      vaultRoot,
      familyId: required(args, 'family'),
      driverSessionId: required(args, 'session'),
      turnBoundary: explicitTurn ? (args.turn as string) : 'manual',
      boundarySource: explicitTurn ? 'explicit' : 'default',
      invocationId: typeof args['invocation-id'] === 'string' ? (args['invocation-id'] as string) : undefined,
      mode,
      maxPending: policy.maxPending,
      overdueHours: policy.overdueHours,
    })
    print(result)
    return result.ok ? 0 : 1
  }

  if (command === 'capture') {
    const result = await capturePointer({
      vaultRoot,
      familyId: required(args, 'family'),
      pointer: {
        session_id: required(args, 'session'),
        message_id: required(args, 'message'),
        transcript_root: required(args, 'root'),
        relative_path: required(args, 'path'),
        span_sha256: required(args, 'sha'),
        observed_at: typeof args['observed-at'] === 'string' ? (args['observed-at'] as string) : new Date().toISOString(),
      },
    })
    print(result)
    return result.ok ? 0 : 1
  }

  if (command === 'capture-transcript') {
    // The producer, driven the way a tailer would: read the file, append what is
    // not already queued. Running it twice is the restart case, and appends
    // nothing the second time.
    const result = await captureTranscript({
      vaultRoot,
      familyId: required(args, 'family'),
      sessionId: required(args, 'session'),
      transcriptRoot: required(args, 'root'),
      relativePath: required(args, 'path'),
      transcriptPath: required(args, 'file'),
    })
    print({ ok: true, family_id: required(args, 'family'), ...result })
    return 0
  }

  if (command === 'capture-mark') {
    const result = await markCaptured({
      vaultRoot,
      familyId: required(args, 'family'),
      captureId: required(args, 'capture-id'),
      eventId: required(args, 'event'),
    })
    print(result)
    return result.ok ? 0 : 1
  }

  if (command === 'captures') {
    const entries = await listCaptures(vaultRoot, required(args, 'family'), { pendingOnly: args.pending === true })
    print({ ok: true, family_id: args.family, count: entries.length, completeness: await captureCompleteness(vaultRoot, required(args, 'family')), captures: entries })
    return 0
  }

  if (command === 'register-scribe') {
    // The harness writes the registration; a scribe never registers itself.
    const result = await registerScribe({
      vaultRoot,
      familyId: required(args, 'family'),
      sessionId: required(args, 'session'),
      generationId: typeof args.generation === 'string' ? (args.generation as string) : undefined,
      replace: args.replace === true,
    })
    print(result)
    return result.ok ? 0 : 1
  }

  if (command === 'rotation-complete') {
    // The checker computes the verdict; a caller-supplied one is refused rather
    // than ignored, so a script that thought it was certifying a rotation is
    // told it was not.
    if (args.reconstruction !== undefined) {
      print({
        ok: false,
        error: 'the reconstruction verdict is computed by the checker; --reconstruction is not accepted',
      })
      return 2
    }
    // The pointer is data the caller has, not a verdict: the checker still
    // decides. Without it the charter is checked against the vault alone.
    const pointer =
      typeof args.pointer === 'string'
        ? (JSON.parse(await readFile(args.pointer as string, 'utf8')) as {
            rootSessionId?: string
            rootName?: string
            patriarchSessionId?: string
          })
        : undefined
    const result = await completeRotation({
      vaultRoot,
      familyId: required(args, 'family'),
      fromGeneration: required(args, 'from'),
      toGeneration: required(args, 'to'),
      pointer,
    })
    print(result)
    return 0
  }

  if (command === 'recall') {
    const familyId = required(args, 'family')
    const query = required(args, 'query')
    const packet = await recall({
      vaultRoot,
      familyId,
      query,
      // The packet is a function of its request, so the install's policy is
      // handed in here rather than read from ambient settings inside recall;
      // `--overdue-hours` is an operator override of that policy.
      overdueHours:
        typeof args['overdue-hours'] === 'string' ? Number(args['overdue-hours']) : policy.overdueHours,
      filters: {
        asOf: typeof args['as-of'] === 'string' ? (args['as-of'] as string) : undefined,
        limit: typeof args.limit === 'string' ? Number(args.limit) : undefined,
      },
    })
    if (typeof args.dump === 'string') {
      await writeFile(args.dump as string, `${JSON.stringify(packet, null, 2)}\n`, 'utf8')
    }
    print(packet)
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

  throw new Error('usage: vault-cli.ts <verify|repair|admit|submit|recall|confer-driver|capture|capture-transcript|capture-mark|captures|register-scribe|rotation-complete> --vault <path> ...')
}

try {
  process.exit(await main())
} catch (error) {
  print({ ok: false, error: (error as Error).message })
  process.exit(2)
}
