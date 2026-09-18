import { join } from 'node:path';
import { readText, walkFiles } from './fsutil';
import { compileGlob, looksLikeGlob } from './glob';

/**
 * RUNTIME ROOTS: the entrypoints from which runtime reachability is computed.
 *
 * This is deliberately NOT the source universe and NOT an eligibility filter.
 *
 * It used to be both. The manifest declared `roots: [src, scripts]` with an
 * `exclude` list, and that one list was asked to answer three different
 * questions at once:
 *
 *   1. Where does a reachability walk start?      (an entrypoint question)
 *   2. Which files may an analyzer inspect?       (an eligibility question)
 *   3. Which files are reachable at runtime?      (a conclusion, not an input)
 *
 * The consequence was measurable: enforcing this list as scope authority drops
 * `globals.d.ts` and every `scripts/quality/fixtures/*` file, because nothing
 * imports them at runtime and no walk reaches them. Those files are read by a
 * reviewer, are inspected by the maintainability analyzer today, and carry nine
 * accepted findings. Nothing about them is unreachable - they were simply never
 * *runtime* artifacts, and one list cannot hold both facts without one of them
 * winning silently.
 *
 * So this module now answers question (1) only. Question (2) is
 * `.quality/policy/source-universe.json`. Question (3) is computed from (1) and
 * reported, never used to narrow scope.
 *
 * Every root still carries an owner and a proof, because "we stopped walking
 * from here" must never be anonymous - it is the input to reachability, and
 * reachability is what tells a reviewer which findings matter.
 */
export interface RuntimeRoot {
  path: string;
  kind: string;
  owner: string;
  proof: string;
  include?: string[];
}

export interface RuntimeRootsConfig {
  version: number;
  owner: string;
  rationale: string;
  extensions: string[];
  roots: RuntimeRoot[];
  /**
   * Absolute-or-repo-relative entrypoint files, derived from the declared roots.
   *
   * Reported for reachability walks. Nothing outside a runtime analysis may use
   * this to decide what to inspect: it is an input to a graph walk, and treating
   * it as a scope filter is the conflation this module was split to undo.
   */
  entrypoints: string[];
  /** Roots whose patterns matched no file. Reported, because a dead root is a silent scope change. */
  unmatchedRoots: string[];
}

interface RuntimeRootsFile {
  version: number;
  owner: string;
  rationale: string;
  extensions?: string[];
  roots: RuntimeRoot[];
  exclude?: string[];
}

const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx'];

export function runtimeRootsPathFor(repoRoot: string): string {
  return join(repoRoot, '.quality', 'policy', 'runtime-roots.json');
}

export function loadRuntimeRoots(repoRoot: string): RuntimeRootsConfig {
  const path = runtimeRootsPathFor(repoRoot);
  const raw = readText(path);
  if (raw === null) {
    throw new Error(`runtime-roots manifest not found at ${path}`);
  }

  let parsed: RuntimeRootsFile;
  try {
    parsed = JSON.parse(raw) as RuntimeRootsFile;
  } catch (error) {
    throw new Error(
      `runtime-roots manifest at ${path} is not valid JSON: ` +
        (error instanceof Error ? error.message : String(error))
    );
  }

  if (!Array.isArray(parsed.roots) || parsed.roots.length === 0) {
    throw new Error(
      `runtime-roots manifest at ${path} declares no roots; a reachability ` +
        'analysis with nowhere to start would report every file unreachable, ' +
        'which is a confident wrong answer rather than an empty one'
    );
  }

  const extensions = parsed.extensions ?? DEFAULT_EXTENSIONS;
  const excludeMatchers = (parsed.exclude ?? []).map(compileGlob);

  const entrypoints = new Set<string>();
  const unmatchedRoots: string[] = [];

  for (const root of parsed.roots) {
    const matches = rootMatcher(root);
    const before = entrypoints.size;
    for (const candidate of rootFileCandidates(repoRoot)) {
      if (!extensions.some((ext) => candidate.endsWith(ext))) continue;
      if (excludeMatchers.some((excludes) => excludes(candidate))) continue;
      if (matches(candidate)) entrypoints.add(candidate);
    }
    if (entrypoints.size === before) unmatchedRoots.push(root.path);
  }

  return {
    version: parsed.version,
    owner: parsed.owner,
    rationale: parsed.rationale,
    extensions,
    roots: parsed.roots,
    entrypoints: [...entrypoints].sort(),
    unmatchedRoots: unmatchedRoots.sort(),
  };
}

/** Repo-relative candidate paths under which entrypoints may be found. */
function rootFileCandidates(repoRoot: string): string[] {
  let files: string[];
  try {
    files = walkFiles(repoRoot).files;
  } catch {
    // An unreadable tree yields no entrypoints, and `unmatchedRoots` then reports
    // every declared root. That is the honest outcome: a manifest that resolved
    // to nothing because the walk failed must not read as "these roots are fine".
    return [];
  }
  const normalizedRoot = repoRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  return files
    .map((absolute) => absolute.replace(/\\/g, '/'))
    .map((absolute) =>
      absolute.startsWith(`${normalizedRoot}/`)
        ? absolute.slice(normalizedRoot.length + 1)
        : absolute
    )
    .filter(
      (rel) =>
        rel.length > 0 &&
        !rel.startsWith('.git/') &&
        !rel.includes('node_modules/') &&
        !rel.startsWith('dist/')
    );
}

function rootMatcher(root: RuntimeRoot): (candidate: string) => boolean {
  const patterns: string[] = [];
  if (looksLikeGlob(root.path)) {
    patterns.push(root.path);
  } else {
    const prefix = root.path.endsWith('/') ? root.path : `${root.path}/`;
    patterns.push(root.path);
    patterns.push(`${prefix}**`);
  }
  for (const extra of root.include ?? []) patterns.push(extra);
  const matchers = patterns.map(compileGlob);
  return (candidate: string) => matchers.some((matches) => matches(candidate));
}
