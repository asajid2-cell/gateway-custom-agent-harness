import { join } from 'node:path';
import { readText } from './fsutil';
import { listTrackedFiles, listUntrackedFiles } from './git';
import { compileGlob, looksLikeGlob } from './glob';

/**
 * The runtime-roots manifest is a protected quality artifact, not incidental
 * scanner configuration. It decides what counts as first-class runtime code, so
 * widening it is a policy change and is covered by policyDigest.
 *
 * Every root carries an owner and a proof so that "we added an exclusion" is never
 * anonymous.
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
  roots: string[];
  files: string[];
  trackedFiles: string[];
  untrackedFiles: string[];
}

interface RuntimeRootsFile {
  version: number;
  owner: string;
  rationale: string;
  extensions: string[];
  roots: RuntimeRoot[];
  exclude?: string[];
}

const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx'];

export function loadRuntimeRoots(runtimeRootsPath: string): RuntimeRootsConfig {
  const raw = readText(runtimeRootsPath);
  if (raw === null) {
    throw new Error(`runtime-roots manifest not found at ${runtimeRootsPath}`);
  }

  let parsed: RuntimeRootsFile;
  try {
    parsed = JSON.parse(raw) as RuntimeRootsFile;
  } catch (error) {
    throw new Error(
      `runtime-roots manifest at ${runtimeRootsPath} is not valid JSON: ` +
        (error instanceof Error ? error.message : String(error))
    );
  }

  if (!Array.isArray(parsed.roots) || parsed.roots.length === 0) {
    throw new Error(
      `runtime-roots manifest at ${runtimeRootsPath} declares no roots; ` +
        'an empty root set would make every file unreachable and the tool useless'
    );
  }

  const repoRoot = inferRepoRoot(runtimeRootsPath);
  const tracked = listTrackedFiles(repoRoot);
  const untracked = listUntrackedFiles(repoRoot);
  const universe = [...tracked, ...untracked];

  const includeMatchers = parsed.roots.flatMap((root) => {
    const matchers: Array<(candidate: string) => boolean> = [];
    if (looksLikeGlob(root.path)) {
      matchers.push(compileGlob(root.path));
    } else {
      const prefix = root.path.endsWith('/') ? root.path : `${root.path}/`;
      matchers.push(
        (candidate) => candidate === root.path || candidate.startsWith(prefix)
      );
    }
    for (const extra of root.include ?? []) {
      matchers.push(compileGlob(extra));
    }
    return matchers;
  });

  const excludeMatchers = (parsed.exclude ?? []).map(compileGlob);

  const extensions = parsed.extensions ?? DEFAULT_EXTENSIONS;

  const files = universe.filter((candidate) => {
    if (!extensions.some((ext) => candidate.endsWith(ext))) return false;
    if (excludeMatchers.some((matches) => matches(candidate))) return false;
    return includeMatchers.some((matches) => matches(candidate));
  });

  return {
    version: parsed.version,
    owner: parsed.owner,
    rationale: parsed.rationale,
    extensions,
    roots: parsed.roots.map((root) => root.path),
    files: [...new Set(files)].sort(),
    trackedFiles: tracked,
    untrackedFiles: untracked,
  };
}

/**
 * `.quality/policy/runtime-roots.json` -> repo root is two levels up.
 * Deriving it from the path keeps the tool runnable from anywhere.
 */
function inferRepoRoot(runtimeRootsPath: string): string {
  const normalized = runtimeRootsPath.replace(/\\/g, '/');
  const marker = '/.quality/policy/';
  const index = normalized.indexOf(marker);
  if (index === -1) {
    throw new Error(
      `cannot infer repo root from runtime-roots path ${runtimeRootsPath}; ` +
        `expected it to live under .quality/policy/`
    );
  }
  return normalized.slice(0, index);
}

export function runtimeRootsPathFor(repoRoot: string): string {
  return join(repoRoot, '.quality', 'policy', 'runtime-roots.json');
}
