import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from './hash';

/**
 * Declared-stub authority, read out of scripts/build.ts *as text*.
 *
 * We must not `import('../build.ts')` - that module runs the build at top level.
 * So we extract the manifest literals. If extraction ever returns nothing we throw
 * rather than silently degrading to "nothing is a declared stub", because that
 * failure mode would silently convert tolerated debt into 100+ false failures.
 *
 * `build.ts` is part of policyDigest, so editing these manifests is visible as a
 * policy change and invalidates baselines. That is intentional: SOURCE_STUB_PATHS
 * is an exemption list, and exemptions must not be editable privately.
 */
export interface BuildManifest {
  buildScriptDigest: string;
  /** Union of both manifests, normalized to extensionless repo-relative paths. */
  declaredStubs: Set<string>;
  /** Which manifest each path came from, for evidence. */
  declaredStubSource: Map<string, 'source-stub-paths' | 'specific-source-stubs'>;
  /** Packages build.ts manufactures into node_modules. */
  manufacturedPackages: Set<string>;
}

function normalizeModuleKey(rawPath: string): string {
  return rawPath
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\.(?:[jt]sx?|d\.ts)$/, '');
}

/**
 * Extract the text between the opening bracket at/after `anchorIndex` and its
 * matching close, ignoring brackets and quotes inside string literals,
 * templates and comments.
 */
function extractLiteralBlock(source: string, anchorIndex: number): string {
  const openers: Record<string, string> = { '[': ']', '{': '}', '(': ')' };

  let index = anchorIndex;
  while (index < source.length && !(source[index] in openers)) index += 1;
  if (index >= source.length) {
    throw new Error('extractLiteralBlock: no opening bracket found after anchor');
  }

  const open = source[index];
  const close = openers[open];
  const start = index;
  let depth = 0;
  let quote: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (inLineComment) {
      if (char === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }

    if (char === '/' && next === '/') {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }

    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }

  throw new Error('extractLiteralBlock: unbalanced brackets');
}

/**
 * Return the index of the `=` that assigns a declaration, not the declaration
 * itself. Searching from the declaration name would land inside a type annotation:
 * `const X: Record<string, string[]> = {` contains `[` and `>` before the literal
 * ever starts, so bracket matching would run on `string[]` and return `[]`.
 */
function findAnchor(source: string, name: string): number {
  const index = source.indexOf(name);
  if (index < 0) {
    throw new Error(`build.ts: could not find declaration anchor "${name}"`);
  }
  const equalsIndex = source.indexOf('=', index + name.length);
  if (equalsIndex < 0) {
    throw new Error(`build.ts: declaration "${name}" has no assignment`);
  }
  return equalsIndex;
}

function extractQuotedStrings(block: string): string[] {
  const out: string[] = [];
  for (const match of block.matchAll(/"([^"\\]+)"/g)) out.push(match[1]);
  return out;
}

/**
 * Keys of an object literal, quoted or bare.
 *
 * `INTERNAL_PACKAGE_EXPORTS` mixes both (`bundle: [...]` is bare, `@ant/...` must
 * be quoted), so a quotes-only pattern silently drops `bundle` - which is the
 * package that defines `feature()`, the single most load-bearing entry here.
 */
function extractObjectKeys(block: string): string[] {
  const out: string[] = [];
  const pattern = /^\s*(?:"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/gm;
  for (const match of block.matchAll(pattern)) {
    const key = match[1] ?? match[2];
    if (key !== undefined) out.push(key);
  }
  return out;
}

export function loadBuildManifest(repoRoot: string): BuildManifest {
  const buildPath = join(repoRoot, 'scripts', 'build.ts');
  const source = readFileSync(buildPath, 'utf8');

  const stubPathsBlock = extractLiteralBlock(
    source,
    findAnchor(source, 'const SOURCE_STUB_PATHS')
  );
  const specificStubsBlock = extractLiteralBlock(
    source,
    findAnchor(source, 'const SPECIFIC_SOURCE_STUBS')
  );
  const internalPackagesBlock = extractLiteralBlock(
    source,
    findAnchor(source, 'const INTERNAL_PACKAGE_EXPORTS')
  );

  const fromArray = extractQuotedStrings(stubPathsBlock).map(normalizeModuleKey);
  const fromObject = extractObjectKeys(specificStubsBlock).map(normalizeModuleKey);

  if (fromArray.length === 0 || fromObject.length === 0) {
    throw new Error(
      `build.ts manifest extraction produced empty result ` +
        `(SOURCE_STUB_PATHS=${fromArray.length}, SPECIFIC_SOURCE_STUBS=${fromObject.length}); ` +
        `refusing to run with an empty declared-stub authority`
    );
  }

  const declaredStubs = new Set<string>();
  const declaredStubSource: BuildManifest['declaredStubSource'] = new Map();
  for (const key of fromArray) {
    declaredStubs.add(key);
    declaredStubSource.set(key, 'source-stub-paths');
  }
  for (const key of fromObject) {
    if (!declaredStubs.has(key)) {
      declaredStubSource.set(key, 'specific-source-stubs');
    }
    declaredStubs.add(key);
  }

  // `splitPackageName` is applied at build time; keys are already package names.
  const manufacturedPackages = new Set(extractObjectKeys(internalPackagesBlock));

  return {
    buildScriptDigest: sha256Hex(source),
    declaredStubs,
    declaredStubSource,
    manufacturedPackages,
  };
}
