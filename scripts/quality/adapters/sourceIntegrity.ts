import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type {
  AnalyzerError,
  AnalyzerResult,
  Coverage,
  Finding,
  Severity,
} from '../lib/types';
import { coverageIsComplete } from '../lib/types';
import type { Analyzer, AnalyzerContext } from '../lib/registry';
import { isFile, readText } from '../lib/fsutil';
import { loadBuildManifest, type BuildManifest } from '../lib/buildManifest';
import {
  listResolvedImplementations,
  loadAliasConfig,
  resolveSpecifier,
  type AliasConfig,
} from '../lib/resolve';

export const SOURCE_INTEGRITY_ANALYZER = 'source-integrity';

/** Rule IDs are stable and human-citable. Never renumber; retire instead. */
export const RULES = {
  realImplementation: 'INT-001',
  declaredLegacyStub: 'INT-002',
  unexpectedStub: 'INT-003',
  missingImplementation: 'INT-004',
  ambiguousResolution: 'INT-005',
  dynamicUnverified: 'INT-006',
  externalPackage: 'INT-007',
  untrackedGenerated: 'INT-008',
} as const;

export const RULE_DESCRIPTIONS: Record<string, string> = {
  'INT-001': 'Dependency resolves to a tracked on-disk implementation.',
  'INT-002': 'Dependency resolves to a declared research-only stub.',
  'INT-003': 'Dependency resolves to a stub that no manifest declares.',
  'INT-004': 'Dependency has no runtime-loadable implementation.',
  'INT-005': 'Dependency matches more than one implementation.',
  'INT-006': 'Computed dynamic import; not verifiable by inspection.',
  'INT-007': 'Dependency leaves the repository.',
  'INT-008': 'Dependency is untracked on disk and not reproducible.',
};

export type RuleId = (typeof RULES)[keyof typeof RULES];
export type Classification =
  | 'real-implementation'
  | 'declared-legacy-stub'
  | 'external-package'
  | 'unexpected-stub'
  | 'untracked-generated'
  | 'uncommitted-source'
  | 'unresolved-no-implementation'
  | 'unexpected-missing'
  | 'ambiguous-resolution'
  | 'dynamic-unverified';

/**
 * Fallback-stub detection.
 *
 * Three behaviors shaped this, each learned by getting it wrong first:
 *  1. Substring containment is wrong. This analyzer and build.ts both contain the
 *     marker as a string literal, so `includes()` reported the tool's own source
 *     as a manufactured stub. The marker must be the file's first line.
 *  2. Marker-prefix alone is also wrong. `src/utils/protectedNamespace.js` is a
 *     *specific* stub whose body is custom (`isProtectedNamespace` returning
 *     false), so it carries no marker at all. A marker-only test silently demoted
 *     real tolerated debt to clean - the exact failure this tool exists to stop.
 *  3. Manifest membership alone is not sufficient either. build.ts writes stubs
 *     with `ensureFile`, so a genuine implementation placed at a declared stub
 *     path wins and the stub is never written.
 *  4. "No module syntax" is the wrong discriminator. The specific declared stubs
 *     do export symbols; what they never do is *depend* on anything. See
 *     hasDependencyEdges.
 *
 * A fallback stub is therefore: declared-in-manifest AND having no dependency
 * edges of its own. Requiring both keeps the rule conservative in the direction
 * that matters - it would rather call a stub real than accuse a real module of
 * being manufactured, because the second mistake invents debt that does not exist
 * while the first only under-reports debt that the marker check still catches.
 */
const STUB_MARKER = '// Generated snapshot stub for missing research-only module.';
const STUB_MAX_BYTES = 1024;

/**
 * Whether the file depends on anything.
 *
 * A previous predicate asked "does this file have no module syntax", which is
 * simply false for the specific declared stubs in build.ts: they `export default
 * {}` and export trivial consts and functions. That test called
 * `src/utils/protectedNamespace.js` a real implementation and silently demoted
 * tolerated debt to clean - the precise failure this analyzer exists to prevent.
 *
 * What actually separates a stub from an implementation at a declared path is
 * that a stub *uses nothing*. `isProtectedNamespace` returns `false`; the real
 * version of it must consult the namespace registry, so it imports it. A file
 * with no dependency edges of its own cannot be implementing anything, whatever
 * it exports.
 */
function hasDependencyEdges(text: string): boolean {
  return (
    /\b(?:import|export)\b[^;]*?\bfrom\s*["']/.test(text) ||
    /^\s*import\s*["']/m.test(text) ||
    /\bimport\s*\(/.test(text) ||
    /\brequire\s*\(/.test(text)
  );
}

const STUB_MARKER_KEY = STUB_MARKER;

interface RawEdge {
  importer: string;
  specifier: string;
  kind: 'import-statement' | 'require' | 'dynamic-import';
}

interface ClassifiedEdge {
  classification: Classification;
  severity: Severity;
  target: string | null;
  detail: string;
  evidence: Record<string, string | number | boolean | null>;
  reviewRequired?: boolean;
}

interface AnalyzerState {
  repoRoot: string;
  aliases: AliasConfig;
  manifest: BuildManifest;
  trackedFiles: Set<string>;
  /** False when the caller could not supply git's tracked universe. */
  hasTrackedUniverse: boolean;
  stubCache: Map<string, boolean>;
  contentCache: Map<string, string | null>;
}

function contentsOf(state: AnalyzerState, relPath: string): string | null {
  const cached = state.contentCache.get(relPath);
  if (cached !== undefined) return cached;
  const text = readText(join(state.repoRoot, relPath));
  state.contentCache.set(relPath, text);
  return text;
}

export function moduleKey(relPath: string): string {
  return relPath.replace(/\.(?:[jt]sx?)$/, '');
}

/** The filter the engine and this analyzer must agree on for coverage to hold. */
export function isSourceFile(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  return EXTENSIONS.some((ext) => lower.endsWith(ext));
}

interface StubAssessment {
  isStub: boolean;
  declaredBy: string | null;
}

function assessStub(state: AnalyzerState, relPath: string): StubAssessment {
  const declaredBy =
    state.manifest.declaredStubSource.get(moduleKey(relPath)) ?? null;
  const cached = state.stubCache.get(relPath);
  if (cached !== undefined) return { isStub: cached, declaredBy };

  const text = contentsOf(state, relPath);
  let isStub = false;

  if (text !== null) {
    if (text.startsWith(STUB_MARKER_KEY)) {
      isStub = true;
    } else if (
      declaredBy !== null &&
      text.length <= STUB_MAX_BYTES &&
      !hasDependencyEdges(text)
    ) {
      isStub = true;
    }
  }

  state.stubCache.set(relPath, isStub);
  return { isStub, declaredBy };
}

function isUntracked(state: AnalyzerState, relPath: string): boolean {
  if (!state.hasTrackedUniverse) return false;
  return !state.trackedFiles.has(relPath);
}

interface ExtractedEdges {
  runtime: RawEdge[];
  typeOnlyCount: number;
  computedDynamic: RawEdge[];
  /** Non-null when the parser-backed scan threw; the file's edges are unknown. */
  scanFailed: string | null;
}

/**
 * Blank out comment bodies while preserving byte offsets and line structure.
 *
 * Not optional: the supplementary regexes scan raw text, and this repository's
 * source comments legitimately discuss imports - including `import('../build.ts')`
 * in a doc comment and `require()` in prose. Without masking, the analyzer reports
 * code-shaped text from comments as dependencies.
 */
export function maskComments(source: string): string {
  const out = source.split('');
  let index = 0;
  let quote: string | null = null;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (quote !== null) {
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      index += 1;
      continue;
    }

    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        out[index] = ' ';
        index += 1;
      }
      continue;
    }

    if (char === '/' && next === '*') {
      out[index] = ' ';
      out[index + 1] = ' ';
      index += 2;
      while (index < source.length) {
        if (source[index] === '*' && source[index + 1] === '/') {
          out[index] = ' ';
          out[index + 1] = ' ';
          index += 2;
          break;
        }
        if (source[index] !== '\n') out[index] = ' ';
        index += 1;
      }
      continue;
    }

    index += 1;
  }

  return out.join('');
}

/**
 * Extract import edges.
 *
 * Three deliberate decisions:
 *  - `import type` / `export type` edges are counted but NOT analysed. They are
 *    erased at build time and cannot produce an unverified runtime stub.
 *  - `require()` is parsed directly. Bun's `scan()` does not report require calls
 *    at all, and `src/utils/envUtils.ts` depends on them.
 *  - dynamic `import()` is parsed directly rather than taken from `scan()`, so the
 *    specifier is matched exactly as written instead of being rewritten.
 */
export function extractEdges(source: string, importer: string): ExtractedEdges {
  const runtime: RawEdge[] = [];
  const computedDynamic: RawEdge[] = [];
  const seen = new Set<string>();

  const masked = maskComments(source);
  const scanResult = scanEdges(source, importer);

  const typeOnlySpecifiers = new Set<string>();
  for (const match of masked.matchAll(
    /\b(?:import|export)\s+type\b[\s\S]*?\bfrom\s*(["'])([^"']+)\1/g
  )) {
    const specifier = match[2];
    if (specifier !== undefined) typeOnlySpecifiers.add(specifier);
  }
  for (const match of masked.matchAll(/\bimport\s+type\s*(["'])([^"']+)\1/g)) {
    const specifier = match[2];
    if (specifier !== undefined) typeOnlySpecifiers.add(specifier);
  }

  const push = (specifier: string, kind: RawEdge['kind']): void => {
    if (typeOnlySpecifiers.has(specifier) && kind === 'import-statement') return;
    const key = `${kind}::${specifier}`;
    if (seen.has(key)) return;
    seen.add(key);
    runtime.push({ importer, specifier, kind });
  };

  for (const item of scanResult.imports) {
    if (item.kind !== 'import-statement') continue;
    push(item.path, 'import-statement');
  }

  for (const match of masked.matchAll(
    /\brequire\s*\(\s*(["'])([^"'\\]+)\1\s*\)/g
  )) {
    const specifier = match[2];
    if (specifier === undefined) continue;
    push(specifier, 'require');
  }

  for (const match of masked.matchAll(
    /\bimport\s*\(\s*(`[^`]*`|["'][^"']*["'])/g
  )) {
    const raw = match[1];
    if (raw === undefined) continue;
    if (raw.startsWith('`') && raw.includes('${')) {
      computedDynamic.push({ importer, specifier: raw, kind: 'dynamic-import' });
      continue;
    }
    push(raw.slice(1, -1), 'dynamic-import');
  }

  return {
    runtime,
    typeOnlyCount: typeOnlySpecifiers.size,
    computedDynamic,
    scanFailed: scanResult.failed,
  };
}

/**
 * Run the parser-backed scanner, reporting failure rather than swallowing it.
 *
 * A silent failure here is the worst case in this analyzer: the file is marked
 * scanned, no edges are found, every rule passes, and the report claims a clean
 * file that was never actually read. The caller must be able to see this, so the
 * failure is returned instead of caught and forgotten.
 */
function scanEdges(
  source: string,
  importer: string
): {
  imports: Array<{ kind: string; path: string }>;
  failed: string | null;
} {
  // `jsx` (not `tsx`) for .ts files, deliberately.
  //
  // Bun's transpiler can be told to parse TypeScript and JSX at once via the
  // `tsx` loader, and that is the obvious choice. It is also wrong: `tsx` parses
  // `<` as the start of a JSX element, so ordinary TypeScript like
  // `const x: Record<string, number>` or `a < b` is a parse error. Five files in
  // this repository failed that way - `prefix.ts` on `Unexpected :`,
  // `specPrefix.ts` on `Unexpected if` - and all five scan cleanly under `js`.
  // Since JSX is the rarer case and only ever legitimate in .tsx/.jsx, the loader
  // is chosen by extension rather than fixed.
  const loader = loaderFor(importer);
  try {
    const transpiler = new Bun.Transpiler({ loader });
    return {
      imports: transpiler.scan(source).imports as Array<{
        kind: string;
        path: string;
      }>,
      failed: null,
    };
  } catch (error) {
    return {
      imports: [],
      failed: error instanceof Error ? error.message : String(error),
    };
  }
}

export function loaderFor(relPath: string): 'tsx' | 'ts' | 'jsx' | 'js' {
  const lower = relPath.toLowerCase();
  if (lower.endsWith('.tsx')) return 'tsx';
  if (lower.endsWith('.jsx')) return 'jsx';
  if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts')) {
    return 'ts';
  }
  return 'js';
}

function classify(state: AnalyzerState, edge: RawEdge): ClassifiedEdge {
  const importerAbsolute = join(state.repoRoot, edge.importer);

  const resolution = resolveSpecifier(
    edge.specifier,
    importerAbsolute,
    state.repoRoot,
    state.aliases
  );

  if (resolution.external) {
    return {
      classification: 'external-package',
      severity: 'info',
      target: null,
      detail: 'Specifier leaves the repository; integrity is not asserted here.',
      evidence: { external: true },
    };
  }

  if (resolution.implementation === null) {
    if (resolution.declaration !== null) {
      return {
        classification: 'unexpected-missing',
        severity: 'error',
        target: resolution.declaration,
        detail:
          `Only a declaration exists (${resolution.declaration}); the compiler may ` +
          'be satisfied while no runtime-loadable implementation exists.',
        evidence: { declaration: resolution.declaration, implementation: null },
      };
    }
    return {
      classification: 'unresolved-no-implementation',
      severity: 'error',
      target: null,
      detail: 'Resolves inside the repository, but nothing exists at that path.',
      evidence: { implementation: null, declaration: null },
    };
  }

  const implementations = listResolvedImplementations(
    edge.specifier,
    importerAbsolute,
    state.repoRoot,
    state.aliases
  );
  if (implementations.length > 1) {
    return {
      classification: 'ambiguous-resolution',
      severity: 'error',
      target: implementations.join(' | '),
      detail:
        `Specifier matches ${implementations.length} on-disk implementations ` +
        `(${implementations.join(', ')}). Which one executes depends on resolver order.`,
      evidence: { candidates: implementations.join(',') },
    };
  }

  const target = resolution.implementation;
  const stubAssessment = assessStub(state, target);

  if (isUntracked(state, target)) {
    if (stubAssessment.isStub) {
      return {
        classification: 'untracked-generated',
        severity: 'error',
        target,
        detail:
          'Resolves to a generated fallback stub that no commit contains. The ' +
          'build manufactured this module on demand; the artifact is not ' +
          'reproducible from tracked source.',
        evidence: { tracked: false, stub: true },
      };
    }
    return {
      classification: 'uncommitted-source',
      severity: 'error',
      target,
      detail:
        'Target exists on disk but no commit contains it. Resolve by committing ' +
        'the file or removing the dependency; do not baseline this.',
      evidence: { tracked: false, stub: false },
      // This is a statement about the working tree, not about the candidate. It
      // disappears the moment someone commits, so freezing it as accepted legacy
      // would permanently tolerate a defect that was never durable - and the
      // analyzer's own instruction is not to baseline it. It blocks, and it is
      // never recorded.
      reviewRequired: true,
    };
  }

  if (stubAssessment.isStub) {
    if (stubAssessment.declaredBy !== null) {
      return {
        classification: 'declared-legacy-stub',
        severity: 'warning',
        target,
        detail:
          `Declared research-only stub (${stubAssessment.declaredBy}). Resolves to ` +
          'a fallback implementation, so runtime use of this dependency is ' +
          'unverified. Tolerated in the baseline, never invisible.',
        evidence: { declaredBy: stubAssessment.declaredBy, stub: true },
      };
    }
    return {
      classification: 'unexpected-stub',
      severity: 'error',
      target,
      detail:
        'Resolves to a fallback stub that is NOT declared in the build manifest. ' +
        'The build manufactures this module on demand; no human approved it.',
      evidence: { declaredBy: null, stub: true },
    };
  }

  return {
    classification: 'real-implementation',
    severity: 'info',
    target,
    detail: 'Resolved to a tracked on-disk implementation.',
    evidence: {},
  };
}

export function ruleFor(classification: Classification): RuleId {
  switch (classification) {
    case 'declared-legacy-stub':
      return RULES.declaredLegacyStub;
    case 'unexpected-stub':
      return RULES.unexpectedStub;
    case 'unresolved-no-implementation':
    case 'unexpected-missing':
      return RULES.missingImplementation;
    case 'ambiguous-resolution':
      return RULES.ambiguousResolution;
    case 'dynamic-unverified':
      return RULES.dynamicUnverified;
    case 'external-package':
      return RULES.externalPackage;
    case 'untracked-generated':
    case 'uncommitted-source':
      return RULES.untrackedGenerated;
    case 'real-implementation':
      return RULES.realImplementation;
    default:
      return RULES.realImplementation;
  }
}

export function findingId(rule: string, importer: string, specifier: string): string {
  return `${rule}::${importer}::${specifier}`;
}

/**
 * Fixture seam: build a classifier over a synthetic tree so fixtures exercise the
 * real classification logic rather than a reimplementation.
 */
export interface ClassifierDependencies {
  repoRoot: string;
  trackedFiles: Iterable<string>;
  hasTrackedUniverse?: boolean;
  declaredStubs: Map<string, string>;
  aliases?: AliasConfig;
}

export function createClassifier(
  deps: ClassifierDependencies
): (edge: RawEdge) => ClassifiedEdge & { rule: RuleId } {
  const state: AnalyzerState = {
    repoRoot: deps.repoRoot,
    aliases: deps.aliases ?? loadAliasConfig(deps.repoRoot),
    manifest: {
      buildScriptDigest: 'fixture',
      declaredStubs: new Set(deps.declaredStubs.keys()),
      declaredStubSource: new Map(
        deps.declaredStubs as Map<
          string,
          'source-stub-paths' | 'specific-source-stubs'
        >
      ),
      manufacturedPackages: new Set(),
    },
    trackedFiles: new Set(deps.trackedFiles),
    hasTrackedUniverse: deps.hasTrackedUniverse ?? true,
    stubCache: new Map(),
    contentCache: new Map(),
  };

  return (edge: RawEdge) => {
    const classified = classify(state, edge);
    return { ...classified, rule: ruleFor(classified.classification) };
  };
}

export type { RawEdge };

function run(context: AnalyzerContext): AnalyzerResult {
  const errors: AnalyzerError[] = [];
  const notes: string[] = [];

  const manifest = loadBuildManifest(context.repoRoot);
  const aliases = loadAliasConfig(context.repoRoot);

  const state: AnalyzerState = {
    repoRoot: context.repoRoot,
    aliases,
    manifest,
    trackedFiles: context.trackedFiles,
    hasTrackedUniverse: context.trackedFiles.size > 0,
    stubCache: new Map(),
    contentCache: new Map(),
  };

  notes.push(
    `manifest: ${manifest.declaredStubs.size} declared stubs, ` +
      `${manifest.manufacturedPackages.size} manufactured packages`
  );

  const importers = context.candidateFiles.filter((file: string) =>
    isSourceFile(file)
  );

  const findings: Finding[] = [];
  const skipReasons: Record<string, number> = {};
  let scanned = 0;
  let failed = 0;
  let runtimeEdges = 0;
  let typeOnlyEdges = 0;
  let computedDynamicEdges = 0;

  for (const importer of importers) {
    const absolute = context.absolute(importer);
    if (!isFile(absolute)) {
      failed += 1;
      errors.push({
        kind: 'unreadable-file',
        subject: importer,
        message: 'Listed as a candidate file but not readable on disk.',
      });
      continue;
    }

    let source: string;
    try {
      source = readFileSync(absolute, 'utf8');
    } catch (error) {
      failed += 1;
      errors.push({
        kind: 'unreadable-file',
        subject: importer,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    let extracted: ExtractedEdges;
    try {
      extracted = extractEdges(source, importer);
    } catch (error) {
      failed += 1;
      errors.push({
        kind: 'scan-failure',
        subject: importer,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (extracted.scanFailed !== null) {
      // The parser-backed pass did not run, so this file's edge set is unknown
      // rather than small. Counting it as scanned is how a report ends up clean
      // over a file it never fully read; counting it as failed stops the run from
      // being accepted at all. Its findings are not emitted, which under-reports
      // rather than over-reports - and since the run is INCOMPLETE, no baseline
      // can be written from it either way.
      failed += 1;
      errors.push({
        kind: 'scan-failure',
        subject: importer,
        message:
          `Dependency edges were not enumerated by the parser-backed scanner ` +
          `(${extracted.scanFailed}); only textual patterns were applied.`,
      });
      continue;
    }

    scanned += 1;
    typeOnlyEdges += extracted.typeOnlyCount;
    computedDynamicEdges += extracted.computedDynamic.length;

    const emit = (edge: RawEdge, classified: ClassifiedEdge): void => {
      const rule = ruleFor(classified.classification);
      findings.push({
        id: findingId(rule, edge.importer, edge.specifier),
        rule,
        subject: edge.importer,
        locator: edge.specifier,
        // A dependency edge is identified by the specifier it names, which was
        // never a position. Nothing here needs an anchor to survive a line shift,
        // so identity and anchor are the same string by construction.
        anchor: edge.specifier,
        classification: classified.classification,
        status: classified.severity === 'error' ? 'fail' : 'pass',
        severity: classified.severity,
        detail: classified.detail,
        occurrences: 1,
        debt: classified.classification === 'declared-legacy-stub',
        evidence: { ...classified.evidence, edgeKind: edge.kind },
        ...(classified.reviewRequired === true ? { reviewRequired: true } : {}),
      });
    };

    for (const edge of extracted.runtime) {
      runtimeEdges += 1;
      emit(edge, classify(state, edge));
    }

    for (const edge of extracted.computedDynamic) {
      computedDynamicEdges += 1;
      emit(edge, {
        classification: 'dynamic-unverified',
        severity: 'info',
        target: null,
        detail:
          'Computed dynamic import. Not an integrity failure, and not evidence ' +
          'that the target is wired.',
        evidence: { computed: true },
      });
    }
  }

  if (importers.length > 0 && scanned === 0) {
    skipReasons['scanned-nothing'] = importers.length;
  }

  const coverage: Coverage = {
    eligible: importers.length,
    scanned,
    skipped: 0,
    failed,
    skipReasons,
  };

  notes.push(`runtime edges evaluated: ${runtimeEdges}`);
  notes.push(`type-only edges skipped: ${typeOnlyEdges}`);
  notes.push(`computed dynamic imports recorded: ${computedDynamicEdges}`);
  notes.push(`runtime roots: ${context.candidateFiles.length} candidate files`);

  return {
    analyzer: SOURCE_INTEGRITY_ANALYZER,
    findings: collapseOccurrences(findings),
    errors,
    coverage,
    complete: coverageComplete(coverage),
    notes,
  };
}

/**
 * Coverage is arithmetic, not an assertion.
 *
 * A file that could not be read is a coverage failure. Reporting "complete" while
 * an unread file silently contributed nothing is exactly the loose green label
 * that makes a quality gate untrustworthy.
 *
 * The rule itself lives in the engine (types.ts) so that every analyzer is held
 * to the same definition; this is a re-export for callers that were written
 * against the analyzer-local name.
 */
export const coverageComplete = coverageIsComplete;

function collapseOccurrences(findings: Finding[]): Finding[] {
  const byId = new Map<string, Finding>();
  for (const finding of findings) {
    const existing = byId.get(finding.id);
    if (existing === undefined) {
      byId.set(finding.id, finding);
      continue;
    }
    existing.occurrences += 1;
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx'];

export const sourceIntegrityAnalyzer: Analyzer = {
  id: SOURCE_INTEGRITY_ANALYZER,
  description:
    'Runtime import integrity: unresolved dependencies, manufactured stubs, ' +
    'ambiguous resolution and untracked artifacts.',
  rules: RULE_DESCRIPTIONS,
  extensions: EXTENSIONS,
  run,
};
