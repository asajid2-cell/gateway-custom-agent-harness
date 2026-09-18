import { join } from 'node:path';
import { readText } from './fsutil';
import { listTrackedFiles, listUntrackedFiles } from './git';
import { compileGlob, looksLikeGlob } from './glob';

/**
 * The SOURCE UNIVERSE: every repository file a quality tool may inspect.
 *
 * Two questions are routinely conflated, and separating them is the entire point
 * of this module:
 *
 *   SOURCE UNIVERSE - every file that may be inspected, with a role saying what
 *     kind of thing it is. Roles decide which analyzers are ELIGIBLE to look at a
 *     file. A fixture, a declaration file and a shipped module are all in the
 *     universe; they are not all things a clone detector or a complexity ceiling
 *     should block on.
 *
 *   RUNTIME ROOTS - the entrypoints from which runtime reachability is computed.
 *     A subset of the universe, and a different question: `globals.d.ts` is
 *     universe but not a root, because nothing imports it at runtime and no
 *     reachability walk will ever arrive at it.
 *
 * Collapsing the second into the first is how scope silently narrows. If the
 * runtime-root list is also the eligibility list, then every file that runtime
 * reachability cannot explain - fixtures, declarations, build tools, launchers -
 * stops being measured the moment someone tidies the root list. Nobody decides
 * that; it just happens, and the report still says everything passed.
 *
 * A file matching no role is UNCLASSIFIED and reported. It is not dropped: an
 * unmeasured file that looks measured is the failure mode this manifest exists
 * to make impossible. Exclusion is only ever an explicit `exclude` entry, which
 * is itself policy and invalidates accepted baselines.
 */
export const SOURCE_UNIVERSE_PATH = '.quality/policy/source-universe.json';

/**
 * The capabilities an analyzer may declare it needs. A role lists which of these
 * apply to files in that role; an analyzer is eligible for a file only when its
 * capability is listed by the file's role.
 *
 * Names are deliberately the vocabulary of a review, not of a tool: "syntax" is
 * "this file must parse", "clones" is "a copy of another file here is a defect
 * worth blocking on". Adding a capability is cheap; the point is that an
 * analyzer cannot expand its own scope by being installed.
 */
export type SourceCapability =
  | 'syntax'
  | 'format'
  | 'lint'
  | 'secrets'
  | 'complexity'
  | 'clones'
  /**
   * The file's import specifiers must resolve. This is a property of executable
   * code, which includes test files: a test that imports a module which does not
   * exist is a real defect, and it was found twice on this repository
   * (`scripts/effort-regression.test.ts`). It is NOT a property of declarations
   * (a `.d.ts` has no runtime imports) or of fixtures (which contain unresolved
   * specifiers deliberately, in order to test that the analyzer notices them).
   *
   * Named for what it checks, not for the analysis that consumes it. An earlier
   * name, `runtime-reachability`, described an entrypoint walk and made test
   * files ineligible by accident - the exact silent scope narrowing this role
   * model exists to prevent.
   */
  | 'import-integrity';

export interface SourceRole {
  name: string;
  description: string;
  path?: string;
  glob?: string;
  checks: string[];
  owner: string;
  proof: string;
}

export interface SourceUniverse {
  version: number;
  owner: string;
  rationale: string;
  extensions: string[];
  roles: SourceRole[];
  /** role name -> files in that role, sorted. */
  byRole: Map<string, string[]>;
  /** Files in the universe in no declared role. Reported, never dropped. */
  unclassified: string[];
  /** Every universe file, sorted. */
  files: string[];
  /** Role for a repo-relative path, or null when unclassified. */
  roleOf(relative: string): string | null;
  /**
   * Files an analyzer with the given capabilities is eligible for. This is the
   * only supported way to derive an analyzer's scope, so that "which files can
   * this analyzer see" has one answer that is written down in policy.
   */
  eligibleFor(capabilities: string[]): string[];
}

const DEFAULT_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.d.ts',
];

interface SourceUniverseFile {
  version: number;
  owner: string;
  rationale: string;
  extensions?: string[];
  roles: SourceRole[];
  exclude?: string[];
}

export function sourceUniversePathFor(repoRoot: string): string {
  return join(repoRoot, SOURCE_UNIVERSE_PATH);
}

export function loadSourceUniverse(repoRoot: string): SourceUniverse {
  const path = sourceUniversePathFor(repoRoot);
  const raw = readText(path);
  if (raw === null) {
    throw new Error(`source-universe manifest not found at ${path}`);
  }

  let parsed: SourceUniverseFile;
  try {
    parsed = JSON.parse(raw) as SourceUniverseFile;
  } catch (error) {
    throw new Error(
      `source-universe manifest at ${path} is not valid JSON: ` +
        (error instanceof Error ? error.message : String(error))
    );
  }

  if (!Array.isArray(parsed.roles) || parsed.roles.length === 0) {
    throw new Error(
      `source-universe manifest at ${path} declares no roles; an empty role set ` +
        'would make every file unclassified and the universe meaningless'
    );
  }

  const extensions = parsed.extensions ?? DEFAULT_EXTENSIONS;
  const excludeMatchers = (parsed.exclude ?? []).map(compileGlob);

  // Role order is priority order, and it is explicit rather than incidental.
  // A test file under scripts/quality/fixtures matches both `quality-fixture`
  // and the broader `harness-test` glob; which one wins decides whether clone
  // and complexity checks apply to it, so the manifest states the order and the
  // loader honors it rather than depending on JSON key order.
  const roleMatchers = parsed.roles.map((role) => ({
    role,
    matches: roleMatcher(role),
  }));

  const tracked = listTrackedFiles(repoRoot);
  const untracked = listUntrackedFiles(repoRoot);
  const universe = [...new Set([...tracked, ...untracked])].filter(
    (candidate) =>
      extensions.some((ext) => candidate.endsWith(ext)) &&
      !excludeMatchers.some((matches) => matches(candidate))
  );

  const byRole = new Map<string, string[]>();
  for (const role of parsed.roles) byRole.set(role.name, []);
  const unclassified: string[] = [];

  for (const candidate of universe) {
    const matched = roleMatchers.find((entry) => entry.matches(candidate));
    if (matched === undefined) {
      unclassified.push(candidate);
      continue;
    }
    (byRole.get(matched.role.name) as string[]).push(candidate);
  }

  for (const files of byRole.values()) files.sort();
  unclassified.sort();

  const files = [...universe].sort();
  const roleIndex = new Map<string, string>();
  for (const [role, members] of byRole) {
    for (const member of members) roleIndex.set(member, role);
  }

  const checksByRole = new Map<string, Set<string>>();
  for (const role of parsed.roles) {
    checksByRole.set(role.name, new Set(role.checks));
  }

  return {
    version: parsed.version,
    owner: parsed.owner,
    rationale: parsed.rationale,
    extensions,
    roles: parsed.roles,
    byRole,
    unclassified,
    files,
    roleOf(relative: string): string | null {
      return roleIndex.get(relative) ?? null;
    },
    eligibleFor(capabilities: string[]): string[] {
      const wanted = new Set(capabilities);
      return files.filter((candidate) => {
        const role = roleIndex.get(candidate);
        if (role === undefined) return false;
        const checks = checksByRole.get(role);
        if (checks === undefined) return false;
        return [...wanted].some((capability) => checks.has(capability));
      });
    },
  };
}

function roleMatcher(role: SourceRole): (candidate: string) => boolean {
  const patterns: string[] = [];
  if (typeof role.glob === 'string' && role.glob.length > 0) {
    patterns.push(role.glob);
  }
  if (typeof role.path === 'string' && role.path.length > 0) {
    patterns.push(looksLikeGlob(role.path) ? role.path : `${role.path}/**`);
    // A `path` role must also match the path itself: `globals.d.ts` is a file,
    // and `globals.d.ts/**` would match nothing but its (nonexistent) children.
    if (!looksLikeGlob(role.path)) patterns.push(role.path);
  }
  const matchers = patterns.map(compileGlob);
  return (candidate: string) => matchers.some((matches) => matches(candidate));
}
