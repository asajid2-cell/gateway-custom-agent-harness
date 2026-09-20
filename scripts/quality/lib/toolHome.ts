import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { runTool } from './toolrun';

/**
 * THE TOOL HOME: where the engine's external measurement tools are installed.
 *
 * One project, one lockfile, four pinned tools. The reasoning was measured on
 * this repository and is recorded in full on the architecture adapter's TOOL_HOME
 * comment; the short form is that `bun x` has three defects that all produce a
 * confident wrong answer:
 *
 *   1. It resolves from whatever a package cache happens to hold, so a version
 *      pin in the invocation is not a resolution identity. dependency-cruiser was
 *      measured resolving a DIFFERENT typescript than the repository pins and
 *      silently degrading to a non-TS parser (287 modules, 300 of 331 edges
 *      unresolved - versus 2,176 modules and 60 unresolved through this home).
 *
 *   2. Passing a directory argument cruises ZERO modules: exit 0, well-formed
 *      JSON, `totalCruised: 0`, empty stderr. A run that measured nothing, shaped
 *      exactly like a run that found nothing.
 *
 *   3. It has no lockfile entry, so its transitive resolution is unreproducible
 *      and unhashed. The pin named in the source is a claim about one package,
 *      not about the graph that package actually runs on.
 *
 * This module exists so there is ONE resolution of that location and ONE probe
 * that turns a pin-from-source into a verified fact. Every adapter that shells
 * out to an external tool goes through it; an adapter with its own copy of this
 * logic is an adapter whose pin can drift from the others'.
 *
 * The shipped tools:
 *
 *   dependency-cruiser 18.3.1   architecture     (the graph resolver)
 *   typescript          5.9.3   architecture     (dependency-cruiser's TS support)
 *   jscpd               5.3.0   duplication      (the clone detector)
 *   knip               5.88.1   unused-structure (the reachability walk)
 *
 * `typescript` is not invoked directly. It is present because dependency-cruiser
 * resolves it from its OWN location, so a tool home without it silently degrades -
 * which is defect (1) above, and the reason it is a direct dependency rather than
 * a transitive one that a resolution algorithm might hoist elsewhere.
 */
export const TOOL_HOME = '.quality/tools';

/**
 * The environment override, and why allowing one is safe.
 *
 * A fixture tree cannot carry its own copy of a 30 MB tool home, and copying one
 * per fixture is the defect the acceptance harness already paid for once with
 * `.candidate-build`. Pointing a fixture at the repository's own home is the only
 * way to exercise the real invocation path without that cost.
 *
 * What the override can NOT do is change what is measured: `probeToolVersion`
 * compares the installed tool's own reported version against the pin, so an
 * override that lands on a different build fails the run rather than silently
 * re-scoring the tree under a different instrument. That is the whole safety
 * argument, and it depends on the probe actually running - so an adapter must
 * treat a failed probe as a FAILED run, never as a warning.
 */
export const TOOL_HOME_ENV = 'QUALITY_TOOL_HOME';

export interface ToolHome {
  /** Absolute path to the tool home in force. */
  home: string;
  /** Absolute path to the tool's entrypoint inside it. */
  entrypoint: string;
  /** True when the location came from the environment rather than the default. */
  overridden: boolean;
}

export interface PinnedTool {
  /** Package name in the tool home's `package.json`. */
  package: string;
  /** Entrypoint relative to the tool home, POSIX separators. */
  entrypoint: string;
  /** The version this engine requires. */
  version: string;
}

export function resolveToolHome(
  repoRoot: string,
  tool: PinnedTool
): ToolHome {
  const override = process.env[TOOL_HOME_ENV];
  const overridden = override !== undefined && override.trim().length > 0;
  const declared = overridden ? (override as string).trim() : TOOL_HOME;
  const home = resolve(repoRoot, declared);
  return {
    home,
    entrypoint: join(home, ...tool.entrypoint.split('/')),
    overridden,
  };
}

export function toolEntrypointExists(home: ToolHome): boolean {
  return existsSync(home.entrypoint);
}

export interface VersionProbe {
  ok: boolean;
  /** The version the installed tool reports, or '' when the probe produced none. */
  observed: string;
  /** Why the probe failed, when it did. */
  failure: string | null;
}

/**
 * Ask the installed tool what version it is.
 *
 * Deliberately parses rather than compares the raw string. `jscpd --version`
 * prints `jscpd 5.3.0`, not `5.3.0`, so a string equality check would report a
 * correctly pinned tool as wrong - which is a false alarm, and a check that cries
 * wolf is a check someone disables. The last whitespace-separated token is the
 * version in every tool here, and a tool that prints only its version still works
 * because the token is then the whole string.
 */
export function parseReportedVersion(stdout: string): string {
  const text = stdout.trim();
  if (text === '') return '';
  const tokens = text.split(/\s+/);
  const last = tokens[tokens.length - 1] ?? '';
  // Accept only a plausible version token. A tool that prints an error message to
  // stdout would otherwise yield a "version" that could never equal a pin, so the
  // failure would be reported as a version mismatch rather than as a bad probe.
  return /^\d+\.\d+\.\d+/.test(last) ? last : '';
}

export function probeToolVersion(
  repoRoot: string,
  home: ToolHome,
  timeoutMs = 120_000
): VersionProbe {
  const outcome = runTool({
    command: process.execPath,
    args: [home.entrypoint, '--version'],
    cwd: repoRoot,
    timeoutMs,
    successCodes: [0],
  });
  if (!outcome.ok) {
    return {
      ok: false,
      observed: '',
      failure: outcome.failure ?? 'version probe failed',
    };
  }
  return { ok: true, observed: parseReportedVersion(outcome.stdout), failure: null };
}
