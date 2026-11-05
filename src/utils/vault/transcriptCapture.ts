import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { leafFamilyPaths } from '../gatewaySessionDurability.js'
import { capturePointer, HOOK_IDENTITY, textOf, type CapturePointer } from './capture.js'
import { captureFamilyFor, captureSessionSafely, type SafeCaptureOutcome } from './sessionCapture.js'
import { readGatewaySettings, vaultRootFor, type GatewaySettings } from './settings.js'

/**
 * The producer that rides the transcript write (spec §12.16-§12.18).
 *
 * Every turn records a pointer for each message it just wrote, under the
 * session's family root. Three properties are deliberate:
 *
 *  - It is incremental. `recordTranscript` already isolates the new tail, so a
 *    write captures only what that write added; nothing rescans the file.
 *  - It never provisions. A machine with no vault root records nothing and says
 *    `vault-root-absent` rather than creating a vault, because "a vault exists"
 *    has to keep meaning "someone opted in".
 *  - It never breaks the transcript. Every fault is reported on the outcome and
 *    swallowed - a vault that cannot be written must not fail the turn.
 */

/**
 * The one transcript root name. Bound to `<configHome>/projects`, forward-slashed
 * below it, never absolute and never containing `..`. A user-supplied
 * name-to-path map would let one root name mean different files on two machines,
 * which is what makes a capture unverifiable a year later.
 */
export const PROJECTS_ROOT = 'projects'

type CapturableMessage = Record<string, unknown>

export type TranscriptCapture = {
  appended: number
  duplicates: number
  skipped: number
}

/**
 * Record one write's new messages, or report why none were recorded.
 *
 * `sessionId` and `transcriptPath` describe the file that was just written; the
 * messages are the same objects, so the span text and its hash are derived by
 * the same function the tailer uses.
 */
export type TranscriptCaptureInput = {
  sessionId: string
  transcriptPath: string
  messages: readonly CapturableMessage[]
  /** The config home the transcripts and the settings file resolve through. */
  configHome?: string
  /** Test seam: otherwise the settings file is read. */
  settings?: GatewaySettings
  /** Test seam: the session's durable family root; otherwise leafWorkspace. */
  resolveFamilyRoot?: () => Promise<string>
  /** Test seam: family-file existence for that root; otherwise the filesystem. */
  familyFileExists?: (familyRoot: string) => Promise<boolean>
}

export async function captureTranscriptTurn(input: TranscriptCaptureInput): Promise<SafeCaptureOutcome> {
  try {
    return await captureTurn(input)
  } catch (error) {
    return { ok: false, reason: 'failed', message: `transcript capture failed: ${(error as Error).message}` }
  }
}

async function captureTurn(input: TranscriptCaptureInput): Promise<SafeCaptureOutcome> {
  const configHome = input.configHome ?? getClaudeConfigHomeDir()

  // Gate order is deliberate and must stay: the vault root is checked before
  // the family. `vault-root-absent` is the stronger statement - on a machine
  // with no vault, no family member could capture either, so reporting
  // `no-family` here would blame the session for a machine-level fact. A later
  // reorder has to argue with that, not just move a block.
  const settings = input.settings
    ? { ok: true as const, path: '<injected>', settings: input.settings, existed: true }
    : await readGatewaySettings()
  if (!settings.ok) return { ok: false, reason: 'failed', message: settings.reason }
  const vaultRoot = vaultRootFor(settings.settings).root
  if (!(await isDirectory(vaultRoot))) {
    return {
      ok: false,
      reason: 'vault-root-absent',
      state: 'no-captures',
      note: `no vault at ${vaultRoot}; capture does not create one, so this machine has not opted in`,
    }
  }

  const relativePath = relativeToProjects(configHome, input.transcriptPath)
  if (relativePath === null) {
    return {
      ok: false,
      reason: 'failed',
      message: `transcript ${input.transcriptPath} is not below ${join(configHome, PROJECTS_ROOT)}; a pointer cannot name it`,
    }
  }

  // The session's own durable membership: the live family snapshot's root, else
  // the pointer written when the session entered a family, else itself. Loaded
  // lazily because leafWorkspace imports sessionStorage, which is the module
  // this hook is called from.
  const familyRoot = input.resolveFamilyRoot
    ? await input.resolveFamilyRoot()
    : await (await import('../leafWorkspace.js')).familyRootSessionId()
  const familyFileExists = input.familyFileExists
    ? await input.familyFileExists(familyRoot)
    : await isFile(leafFamilyPaths(configHome, familyRoot).familyRecord)

  return captureSessionSafely({
    resolve: async () =>
      captureFamilyFor({
        selfSessionId: input.sessionId,
        familyRootSessionId: familyRoot,
        familyFileExists,
      }),
    run: async familyId => {
      const counts: TranscriptCapture = { appended: 0, duplicates: 0, skipped: 0 }
      for (const message of input.messages) {
        const pointer = pointerFor(input.sessionId, relativePath, message)
        if (!pointer) {
          counts.skipped += 1
          continue
        }
        const result = await capturePointer({ vaultRoot, familyId, pointer })
        if (!result.ok) counts.skipped += 1
        else if (result.duplicate) counts.duplicates += 1
        else counts.appended += 1
      }
      return counts
    },
  })
}

/**
 * The pointer for one message, or null when the message has no span worth
 * pointing at (no id, or no text - a tool-only or empty record).
 */
function pointerFor(sessionId: string, relativePath: string, message: CapturableMessage): CapturePointer | null {
  const messageId = typeof message.uuid === 'string' ? message.uuid : null
  const text = textOf(message)
  if (!messageId || !text) return null
  return {
    session_id: sessionId,
    message_id: messageId,
    transcript_root: PROJECTS_ROOT,
    relative_path: relativePath,
    span_sha256: `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`,
    observed_at: typeof message.timestamp === 'string' ? message.timestamp : new Date().toISOString(),
    by: HOOK_IDENTITY,
  }
}

/** The path below `<configHome>/projects`, forward-slashed, or null if it is outside. */
function relativeToProjects(configHome: string, transcriptPath: string): string | null {
  if (isAbsolute(transcriptPath) === false && /^[A-Za-z]:[\\/]/.test(transcriptPath) === false) {
    // A relative path cannot be checked against the root, and a pointer that
    // depends on the caller's cwd dangles the moment anything moves.
    return null
  }
  const path = relative(join(configHome, PROJECTS_ROOT), transcriptPath).split('\\').join('/')
  if (path === '' || path.startsWith('../') || path === '..' || path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    return null
  }
  return path
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
