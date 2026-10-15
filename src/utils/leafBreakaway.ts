import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'

/**
 * How long the containment helper is given to report a member it started.
 *
 * The helper only creates the process and returns, so this bounds a helper that
 * never answers rather than a member that is slow to boot.
 */
const BREAKAWAY_HELPER_TIMEOUT_MS = 30_000

/**
 * Where the containment helper lives, beside the launcher that shares it.
 *
 * The member is created by this helper rather than by `spawn` because a durable
 * member has to leave the launcher's job object, and `CREATE_BREAKAWAY_FROM_JOB`
 * is not something node's `spawn` can ask for. On POSIX there is no job object
 * and nothing to leave, so this is never reached.
 */
function containmentHelperPath(): string {
  return join(dirname(process.argv[1] ?? process.execPath), '..', 'scripts', 'owned-gateway-process.ps1')
}

/**
 * Start a durable member outside the launcher's job object, returning its pid.
 *
 * A member born into the launcher's KILL_ON_JOB_CLOSE job is killed with it, but
 * the member has to outlive the session that started it - so it is created here
 * instead, which can ask to leave the job, and the helper verifies the escape
 * before the member runs.
 *
 * The spec travels as base64-encoded JSON so the member's own command line is
 * never re-parsed by a shell on the way in. The member inherits this process's
 * environment - the endpoint, token and model it was handed all arrive intact -
 * which is what rules out reaching for WMI to create it, since a WMI-created
 * child would inherit the service host's environment instead.
 */
export function startBreakawayMember(spec: {
  executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv
}): Promise<{ pid: number } | { error: string }> {
  const file = process.env.ComSpec ? 'powershell.exe' : 'pwsh'
  const payload = Buffer.from(
    JSON.stringify({ file: spec.executable, args: spec.args, cwd: spec.cwd }),
    'utf8',
  ).toString('base64')
  return new Promise(resolve => {
    execFile(
      file,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', containmentHelperPath(), '-LeafLaunch', '-LeafSpec', payload],
      { env: spec.env, windowsHide: true, timeout: BREAKAWAY_HELPER_TIMEOUT_MS, maxBuffer: 65536 },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ error: `${stderr}`.trim() || error.message })
          return
        }
        const pid = Number(`${stdout}`.trim())
        if (Number.isInteger(pid) && pid > 0) resolve({ pid })
        else resolve({ error: `${stderr}`.trim() || 'the containment helper reported no process' })
      },
    )
  })
}
