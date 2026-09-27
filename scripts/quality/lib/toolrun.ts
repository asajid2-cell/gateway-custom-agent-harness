import { spawnSync } from 'node:child_process';

/**
 * Running external analyzers.
 *
 * Two rules, both learned from tools that lie when they fail:
 *  - A analyzer that exits non-zero because it found violations is NOT an error.
 *    A analyzer that exits non-zero because it crashed IS. The caller declares
 *    which exit codes mean "found problems" so a crash cannot be mistaken for
 *    findings, or worse, for a clean run.
 *  - Empty or unparseable output is never treated as "no findings". It is an
 *    analyzer error, because a missing report and a clean report look identical
 *    otherwise.
 */
export interface ToolInvocation {
  command: string;
  args: string[];
  cwd: string;
  /** Exit codes that mean "ran successfully, findings included". */
  successCodes: number[];
  /** Hard timeout. A hung analyzer must not hang the gate. */
  timeoutMs: number;
  /**
   * Opt in to running through the system shell. Defaults to false, and the
   * default is load-bearing - see the measurement below.
   */
  useShell?: boolean;
  /**
   * Probe the tool runs before the real invocation.
   *
   * A tool that is present but not *loadable* - because a plugin, preset or
   * config it needs cannot be resolved - reports no findings and exits zero,
   * which is indistinguishable from a clean run. That happened here: an ESLint
   * config that declared plugins without loading them produced 198 findings whose
   * entire text was "Definition for rule X was not found", and nothing in the
   * report said the rule set was not the one configured.
   *
   * The probe makes that state observable, and a failure is fatal to the run
   * rather than a note. What the bootstrap asserts is the invocation's own
   * business; the engine only decides what to do when it fails.
   */
  bootstrap?: ToolBootstrap;
}

export interface ToolBootstrap {
  args: string[];
  /** Non-empty stdout from this invocation counts as a load failure. */
  diagnostic: (stdout: string) => string | null;
}

export interface ToolOutcome {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  /** Populated when ok=false. */
  failure: string | null;
  timedOut: boolean;
}

/**
 * Run an external analyzer.
 *
 * `shell: false` is not a style choice. On Windows, running through the shell
 * routes the command line to cmd.exe, whose limit is 8,191 characters - not the
 * 32,767 that CreateProcess itself allows. Measured on this repository, spawning
 * `bun x eslint` over candidate files:
 *
 *     200 paths,  6,425 chars  shell:true  ->  2.5 MB of report
 *     400 paths, 13,244 chars  shell:true  ->  0 bytes, silent
 *     400 paths, 13,244 chars  shell:false ->  4.5 MB of report
 *     600 paths, 21,277 chars  shell:false ->  9.2 MB of report
 *
 * The failure mode is the dangerous part: the shell variant exits with a
 * plausible status and empty stdout, so it reads exactly like "the analyzer ran
 * and found nothing" rather than "the command line was truncated". Executing the
 * binary directly avoids the intermediate shell entirely.
 *
 * An analyzer that genuinely needs a `.cmd` shim can ask for `useShell: true`,
 * but it must then keep its own argument list small enough to survive cmd.exe.
 */
export function runTool(invocation: ToolInvocation): ToolOutcome {
  if (invocation.bootstrap !== undefined) {
    const diagnostic = runBootstrap(invocation);
    if (diagnostic !== null) {
      return {
        ok: false,
        status: null,
        stdout: '',
        stderr: diagnostic,
        failure: `tool did not load: ${diagnostic}`,
        timedOut: false,
      };
    }
  }

  const proc = spawnSync(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    timeout: invocation.timeoutMs,
    shell: invocation.useShell ?? false,
    // Analyzers are console programs; a console-less parent must not flash one.
    windowsHide: true,
  });

  const stdout = proc.stdout ?? '';
  const stderr = proc.stderr ?? '';
  const timedOut = proc.error?.message.includes('ETIMEDOUT') === true;

  if (timedOut) {
    return {
      ok: false,
      status: null,
      stdout,
      stderr,
      failure: `analyzer exceeded ${invocation.timeoutMs}ms`,
      timedOut: true,
    };
  }

  if (proc.error !== undefined) {
    return {
      ok: false,
      status: null,
      stdout,
      stderr,
      failure: `could not execute ${invocation.command}: ${proc.error.message}`,
      timedOut: false,
    };
  }

  const status = proc.status;
  if (status === null || !invocation.successCodes.includes(status)) {
    return {
      ok: false,
      status,
      stdout,
      stderr,
      failure:
        `${invocation.command} exited ${status}` +
        (stderr.trim().length > 0 ? `: ${firstLines(stderr, 5)}` : ''),
      timedOut: false,
    };
  }

  return { ok: true, status, stdout, stderr, failure: null, timedOut: false };
}

function firstLines(text: string, count: number): string {
  return text.split('\n').slice(0, count).join(' ').trim();
}

/** Returns the failure text, or null when the tool loaded cleanly. */
function runBootstrap(invocation: ToolInvocation): string | null {
  const probe = invocation.bootstrap;
  if (probe === undefined) return null;

  const proc = spawnSync(invocation.command, probe.args, {
    cwd: invocation.cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: Math.min(invocation.timeoutMs, 120_000),
    shell: invocation.useShell ?? false,
    windowsHide: true,
  });

  if (proc.error !== undefined) {
    return `could not run the load probe: ${proc.error.message}`;
  }
  const verdict = probe.diagnostic(proc.stdout ?? '');
  if (verdict !== null) return verdict;
  // The probe is lint output like any other, so it inherits the caller's notion of
  // which exit codes mean "ran, findings included". Treating exit 1 as a load
  // failure would make a lint-clean probe the only accepted outcome, which is a
  // different and wrong claim: the question is whether the tool loaded.
  if (proc.status === null || !invocation.successCodes.includes(proc.status)) {
    return (
      `the load probe exited ${proc.status}` +
      ((proc.stderr ?? '').trim().length > 0
        ? `: ${firstLines(proc.stderr ?? '', 5)}`
        : '')
    );
  }
  return null;
}

/**
 * Parse a JSON document, distinguishing "absent" from "malformed".
 * Returning null for both would let a truncated report read as an empty one.
 */
export function parseJsonReport<T>(
  raw: string
): { ok: true; value: T } | { ok: false; reason: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'analyzer produced no output to parse' };
  }
  try {
    return { ok: true, value: JSON.parse(trimmed) as T };
  } catch (error) {
    return {
      ok: false,
      reason:
        'analyzer output is not valid JSON: ' +
        (error instanceof Error ? error.message : String(error)),
    };
  }
}
