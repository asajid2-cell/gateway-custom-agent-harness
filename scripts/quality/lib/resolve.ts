import { dirname, join, normalize, resolve } from 'node:path';
import { isFile, readText, repoRelative } from './fsutil';

/**
 * Resolution for the integrity analyzer.
 *
 * This deliberately does NOT use tsconfig `moduleResolution: bundler`, because
 * bundler resolution happily accepts `.d.ts`-only targets and `src/*` aliases.
 * The integrity question is narrower and stricter than the compiler's:
 * "does a runtime-loadable implementation exist on disk, at this exact path?"
 *
 * Every hop is a full-path decision. Nothing here ever matches on basename.
 */

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js', '.jsx', '.cjs'];

export interface AliasConfig {
  baseUrl: string;
  paths: Record<string, string[]>;
  /**
   * True when tsconfig.json exists but could not be read as JSON.
   *
   * Distinguished from `paths: {}` because the two mean opposite things: an empty
   * map is a claim that this repository declares no aliases, while `unreadable`
   * is a statement that aliases are UNKNOWN. Collapsing them is what let a broken
   * stripper look like a repository without aliases for as long as it did.
   */
  unreadable?: boolean;
}

export function loadAliasConfig(repoRoot: string): AliasConfig {
  const raw = readText(join(repoRoot, 'tsconfig.json'));
  if (raw === null) return { baseUrl: '.', paths: {} };

  // Parse the file as it is written before reaching for the comment stripper.
  //
  // This order is load-bearing, and getting it backwards cost 222 dependency
  // edges their analysis. `stripJsonComments` removes `/* ... */` with a regex,
  // and a regex cannot tell a comment from a string literal. This repository's
  // tsconfig is valid JSON containing `"src/*": ["./src/*"]`, and its `include`
  // array contains `"src/**/*.ts"`. The `/*` opening the alias matched and the
  // `*/` inside `**/` closed, so the stripper deleted ~100 characters of
  // perfectly good configuration, `JSON.parse` threw, and the `catch` returned
  // an EMPTY alias map.
  //
  // The consequence was not cosmetic. Every `src/...` specifier - 222 of them,
  // 118 in `src/cli/print.ts` alone - then resolved as `external`, which the
  // integrity analyzer reports as INT-007 at severity `info`, which is a PASS.
  // A hundred-odd intra-repository edges were passing unexamined, in a baseline
  // that said the repository had been measured.
  //
  // So: valid JSON is never handed to the stripper, and the stripper is only
  // reached for the JSON5-style tsconfig that actually needs it.
  const attempts = [raw, stripJsonComments(raw)];
  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt) as {
        compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
      };
      return {
        baseUrl: parsed.compilerOptions?.baseUrl ?? '.',
        paths: parsed.compilerOptions?.paths ?? {},
      };
    } catch {
      // Try the next form. A failure on the last form is reported below rather
      // than swallowed, because an unreadable tsconfig means aliases are unknown
      // - and treating "unknown" as "no aliases" is the bug this function had.
    }
  }
  return { baseUrl: '.', paths: {}, unreadable: true };
}

function stripJsonComments(input: string): string {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'])\/\/.*$/gm, '$1');
}

export interface ResolutionOutcome {
  /** Repo-relative path that exists as an implementation, if any. */
  implementation: string | null;
  /** Repo-relative declaration file that satisfied resolution, if any. */
  declaration: string | null;
  /** True when the specifier leaves the repo (package, builtin, URL). */
  external: boolean;
}

function tryAlias(
  specifier: string,
  repoRoot: string,
  aliases: AliasConfig
): string | null {
  for (const [pattern, targets] of Object.entries(aliases.paths)) {
    const starIndex = pattern.indexOf('*');
    let wildcard = '';
    if (starIndex === -1) {
      if (specifier !== pattern) continue;
    } else {
      const prefix = pattern.slice(0, starIndex);
      const suffix = pattern.slice(starIndex + 1);
      if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
      wildcard = specifier.slice(prefix.length, specifier.length - suffix.length);
    }

    const target = targets[0];
    if (target === undefined) continue;
    const substituted = target.includes('*') ? target.replace('*', wildcard) : target;
    return resolve(repoRoot, aliases.baseUrl, substituted);
  }
  return null;
}

/**
 * Extension-substitution cascade for a candidate base path.
 * Order is fixed so findings are reproducible run over run.
 */
function resolveFileCandidate(basePath: string): {
  implementations: string[];
  declaration: string | null;
} {
  const lower = basePath.toLowerCase();
  const candidates: string[] = [];

  const explicitSource = SOURCE_EXTENSIONS.find((ext) => lower.endsWith(ext));
  if (explicitSource !== undefined) {
    candidates.push(basePath);
    // ESM-in-TS convention: `./foo.js` names `./foo.ts` on disk.
    if (explicitSource === '.js') {
      const stem = basePath.slice(0, -'.js'.length);
      candidates.push(`${stem}.ts`, `${stem}.tsx`);
    }
    if (explicitSource === '.mjs') {
      candidates.push(`${basePath.slice(0, -'.mjs'.length)}.mts`);
    }
    if (explicitSource === '.jsx') {
      candidates.push(`${basePath.slice(0, -'.jsx'.length)}.tsx`);
    }
  } else {
    for (const ext of SOURCE_EXTENSIONS) candidates.push(`${basePath}${ext}`);
    for (const ext of SOURCE_EXTENSIONS) candidates.push(join(basePath, `index${ext}`));
  }

  const implementations = candidates.filter((candidate) => isFile(candidate));
  if (implementations.length > 0) return { implementations, declaration: null };

  // `foo.js.d.ts` is never a real convention, so only append `.d.ts` to an
  // extensionless base. For an explicit source extension the declaration is the
  // stem: `./types/message.js` -> `src/types/message.d.ts`.
  const declarationCandidates = [
    explicitSource === undefined ? `${basePath}.d.ts` : '',
    ...(explicitSource === undefined
      ? [join(basePath, 'index.d.ts')]
      : [`${basePath.slice(0, -explicitSource.length)}.d.ts`]),
  ].filter((candidate) => candidate.length > 0);

  return {
    implementations: [],
    declaration:
      declarationCandidates.find((candidate) => isFile(candidate)) ?? null,
  };
}

/**
 * Every on-disk implementation that a specifier could resolve to, in cascade order.
 * More than one entry means the path is ambiguous - the analyzer treats that as a
 * defect regardless of which one wins, because "which file runs" then depends on
 * resolver order rather than on intent.
 */
export function listResolvedImplementations(
  specifier: string,
  importerAbsolute: string,
  repoRoot: string,
  aliases: AliasConfig
): string[] {
  const basePath = resolveBasePath(specifier, importerAbsolute, repoRoot, aliases);
  if (basePath === null) return [];
  return resolveFileCandidate(normalize(basePath)).implementations.map((absolute) =>
    repoRelative(repoRoot, absolute)
  );
}

function resolveBasePath(
  specifier: string,
  importerAbsolute: string,
  repoRoot: string,
  aliases: AliasConfig
): string | null {
  if (specifier.startsWith('.')) {
    return resolve(dirname(importerAbsolute), specifier);
  }
  if (specifier.startsWith('/')) return resolve(specifier);
  const aliasTarget = tryAlias(specifier, repoRoot, aliases);
  if (aliasTarget !== null) return aliasTarget;
  return specifier.startsWith('src/') ? resolve(repoRoot, specifier) : null;
}

export function resolveSpecifier(
  specifier: string,
  importerAbsolute: string,
  repoRoot: string,
  aliases: AliasConfig
): ResolutionOutcome {
  const EXTERNAL: ResolutionOutcome = {
    implementation: null,
    declaration: null,
    external: true,
  };

  if (specifier.startsWith('node:') || /^[a-z]+:/.test(specifier)) return EXTERNAL;

  const basePath = resolveBasePath(specifier, importerAbsolute, repoRoot, aliases);
  if (basePath === null) return EXTERNAL;

  const relativePath = repoRelative(repoRoot, basePath);
  if (relativePath.startsWith('..')) return EXTERNAL;

  const resolvedFiles = resolveFileCandidate(normalize(basePath));
  const first = resolvedFiles.implementations[0];

  return {
    implementation: first === undefined ? null : repoRelative(repoRoot, first),
    declaration:
      resolvedFiles.declaration === null
        ? null
        : repoRelative(repoRoot, resolvedFiles.declaration),
    external: false,
  };
}
