/**
 * Duplication analyzer: jscpd as a thin adapter over the engine.
 *
 * The engine does the work. This file's job is to translate jscpd's notion of a
 * clone into the engine's notion of a finding, and to be honest about the places
 * where the two do not line up.
 *
 * WHY THE IDENTITY MODEL IS DIFFERENT HERE
 *
 * Every other analyzer reports a defect that exists at a place: an unresolved
 * import in this file, a function that is too complex in that one. A clone is
 * not at a place. It is a RELATION between two or more regions, and the number
 * of regions is the quantity that matters - three copies of a block is worse
 * than two, and turning two copies into one by deleting a copy is a resolution
 * while turning two into three is new debt.
 *
 * So a duplication finding is a FAMILY:
 *
 *   one finding  = one normalized clone family
 *   occurrences  = how many copies of it exist
 *   evidence     = where they are, as `path:startLine-endLine` entries
 *
 * and the identity is `DUP-001::<smallest member path>::<shape digest>`.
 * Anchoring on the smallest member path rather than on a hash of the member set
 * is deliberate: it makes the identity survive a copy being added or removed,
 * which is exactly the event the ratchet has to see as an occurrence change
 * rather than as one family disappearing and another appearing. The anchor is the
 * region's shape digest rather than its source text so that renaming a variable
 * in every copy leaves the id untouched; `detail` and `evidence.regionStart`
 * carry the readable line.
 *
 * WHAT "COPY" VERSUS "MOVE" REQUIRES
 *
 * A family whose members changed is not automatically new debt, because a file
 * rename or a code move relocates a copy without creating one. But a family that
 * merely LOOKS similar is not a move either. The two are distinguished by
 * comparing member SETS between the recorded baseline and the current run, which
 * is why the member list has to be preserved in evidence rather than summarized
 * into a count. See `lib/cloneFamily.ts` for the model, the shape fingerprint,
 * the copy-versus-move argument and its known limitation.
 *
 * SCOPE
 *
 * jscpd is invoked ONCE over the full eligible corpus. It is not batched, and
 * that is not an optimization decision - a clone is a property of two files, so
 * a batched run would find only the clones whose copies happen to land in the
 * same batch. That would make the finding set depend on the batch size, which is
 * a measurement bug that looks like a clean repository.
 *
 * Specifically, the corpus is the WHOLE eligible set on every run, not the changed
 * files within it. A clone whose other copies are unchanged is still a clone, and
 * a changed-files-only scan would report it as resolved - the same bug as
 * batching, arrived at from the other direction.
 *
 * HIGHEST-CONFIDENCE MODE ONLY
 *
 * `kind` is restricted to exact and renamed clones above a token floor. Type-3
 * "similar" detection is deliberately not enabled: it reports pairs whose ASTs
 * are merely alike, and a gate that blocks on "these two functions are 85%
 * similar" is a gate people learn to route around. When fuzzy detection is added
 * it will need its own finding class and its own acceptance argument.
 */
import { join, relative } from 'node:path';
import { existsSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import type {
  AnalyzerError,
  AnalyzerResult,
  Coverage,
  Finding,
} from '../lib/types';
import { coverageIsComplete } from '../lib/types';
import type { Analyzer, AnalyzerContext } from '../lib/registry';
import { ensureDir, isFile } from '../lib/fsutil';
import { parseJsonReport, runTool } from '../lib/toolrun';
import {
  familiesFromPairs,
  membersKey,
  type CloneFamily,
  type ClonePair,
} from '../lib/cloneFamily';

export const DUPLICATION_ANALYZER = 'duplication';

/** Rule id for an exact or identifier-renamed clone above the floor. */
export const DUPLICATE_RULE = 'DUP-001';

/**
 * The token floor, used when policy declares none.
 *
 * 50 tokens is roughly five to eight lines of real code. Below that, "duplicate"
 * starts matching idioms that are short because the language is short -
 * `export const X = 1;`, a two-line guard clause, a one-line re-export - and a
 * gate that blocks on those is a gate that gets disabled. The floor is policy,
 * not a tuning knob: it lives in the analyzer's policy file and is hashed into
 * policyDigest, so raising it to make a finding disappear invalidates the
 * baseline and has to be re-accepted deliberately.
 *
 * IMPORTANT: it is passed to jscpd as well as applied afterwards, and both uses
 * matter. Raising the floor only in the post-filter would leave the tool still
 * reporting everything above the OLD floor, and lowering it would have no effect
 * at all because the tool would never report the smaller blocks - a policy that
 * silently does nothing in one direction.
 */
const DEFAULT_MIN_TOKENS = 50;

/**
 * Minimum lines per block, also passed to the tool.
 *
 * jscpd requires a block to clear BOTH floors, so a 60-token block written as
 * three dense lines is invisible unless this is set as well. Five is the tool's
 * conventional default and is kept as policy for the same reason as the token
 * floor: it decides what is reportable, so it must be reviewable.
 */
const DEFAULT_MIN_LINES = 5;

/**
 * The largest file the detector is allowed to skip.
 *
 * The tool has its own default of 1 MB, and that default is a silent hole: a file
 * above it is dropped from the report with no trace, exactly like an unparsable
 * one. Measured on this repository the largest eligible file is 908 KB - within
 * 10% of the limit - so "we are under the default today" is not a reason to leave
 * a silent cutoff in place. It is raised far above any realistic source file
 * here, and files above the raised limit are counted as coverage FAILURES rather
 * than skipped, so the cutoff can never quietly shrink what was measured.
 */
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * The clone detector's version, pinned in the source.
 *
 * See the invocation in `runJscpd` for why an unpinned `bun x jscpd` would let
 * the detector change under an unchanged `toolchainDigest`.
 */
export const JSCPD_VERSION = '5.3.0';

interface JscpdLocation {
  name: string;
  start: number;
  end: number;
}

interface JscpdDuplicate {
  firstFile: JscpdLocation;
  secondFile: JscpdLocation;
  fragment: string;
  kind?: string;
  tokens: number;
  lines: number;
}

interface JscpdReport {
  duplicates?: JscpdDuplicate[];
  statistics?: {
    total?: { clones?: number; tokens?: number; sources?: number };
  };
}

/**
 * Script kind by extension, the way the language is actually parsed.
 *
 * Getting this wrong is not a detail, and it is the same mistake source integrity
 * made and fixed: `ScriptKind.TSX` parses `<` as the start of a JSX element, so
 * ordinary TypeScript like `a < b` and `Record<string, number>` becomes a parse
 * error. Measured here: with TSX for everything, five files reported "unparsable"
 * (`src/utils/bash/prefix.ts` on `Expression expected`, `specPrefix.ts` on
 * `Unexpected token. Did you mean {'>'}?`) and were then excluded from clone
 * detection - a silent exclusion produced by the pre-pass that exists to prevent
 * silent exclusions.
 */
function scriptKindFor(resolved: typeof import('typescript'), path: string) {
  const lower = path.toLowerCase();
  if (lower.endsWith('.tsx')) return resolved.ScriptKind.TSX;
  if (lower.endsWith('.jsx')) return resolved.ScriptKind.JSX;
  // `.ts`, `.mts`, `.cts` and the plain-JS extensions. TypeScript is a superset of
  // JavaScript, and JSX is only ever legitimate in the extensions above.
  return resolved.ScriptKind.TS;
}

/**
 * A file that jscpd cannot tokenize is dropped from its report with no trace:
 * measured on this repository, a file containing `this is ((( not valid ###`
 * passed on the command line appears in neither `duplicates` nor `statistics`.
 *
 * That is the silent-scope-narrowing failure in its purest form - the file is
 * not measured and the report still says the run completed - so the adapter
 * does its own parse pre-pass and counts every file jscpd will not see. The
 * parser is the same TypeScript parser the toolchain already depends on.
 */
function parses(absolutePath: string): { ok: true } | { ok: false; reason: string } {
  let text: string;
  try {
    text = readFileSync(absolutePath, 'utf8');
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (text.trim().length === 0) {
    // An empty file has no tokens and jscpd drops it. It is not a scan failure -
    // there is genuinely nothing in it - but it is also not "scanned", so it is
    // reported as a deliberate skip rather than quietly removed from the count.
    return { ok: false, reason: 'empty' };
  }
  // `require` rather than a top-level import: TypeScript is a large dependency
  // and only this analyzer needs it, so loading it lazily keeps the other
  // analyzers' startup free of it.
  const ts = require('typescript') as typeof import('typescript');
  const source = ts.createSourceFile(
    absolutePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(ts, absolutePath)
  );
  const diagnostics = source.parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    const first = diagnostics[0];
    return {
      ok: false,
      reason:
        'unparsable: ' +
        (first === undefined
          ? 'parse diagnostics present'
          : ts.flattenDiagnosticMessageText(first.messageText, ' ')),
    };
  }
  return { ok: true };
}

/**
 * Translate jscpd's absolute, Windows-prefixed file names into repo-relative
 * posix paths.
 *
 * Both halves of that are load-bearing and both were got wrong first:
 *
 *  - jscpd reports `\\?\C:\...` because the config asks for absolute paths. A
 *    bare backslash-to-slash replacement turns that into `//?/C:/...`, which is
 *    not a repo-relative path and would make every finding's `subject` nonsense.
 *  - the engine's identity is `rule::subject::anchor` where subject is a
 *    repo-relative path, so a path that leaks the checkout location would make
 *    two clones in the same project on different machines unequal.
 */
function toRepoRelative(repoRoot: string, reported: string): string {
  const stripped = reported.replace(/^\\\\\?\\/, '').replace(/^\/\/\?\//, '');
  const rel = relative(repoRoot, stripped).replace(/\\/g, '/');
  return rel;
}

function pairFrom(repoRoot: string, duplicate: JscpdDuplicate): ClonePair {
  return {
    first: {
      path: toRepoRelative(repoRoot, duplicate.firstFile.name),
      startLine: duplicate.firstFile.start,
      endLine: duplicate.firstFile.end,
    },
    second: {
      path: toRepoRelative(repoRoot, duplicate.secondFile.name),
      startLine: duplicate.secondFile.start,
      endLine: duplicate.secondFile.end,
    },
    fragment: duplicate.fragment,
    kind: duplicate.kind ?? 'exact',
    tokens: duplicate.tokens,
    lines: duplicate.lines,
  };
}

function run(context: AnalyzerContext): AnalyzerResult {
  const errors: AnalyzerError[] = [];
  const notes: string[] = [];

  const eligible = context.candidateFiles.filter((file) => isDuplicationSource(file));

  // The parse pre-pass. Files that jscpd will silently ignore are counted here,
  // so they land in coverage as named skips instead of vanishing.
  const limits = limitsFor(context.repoRoot);
  const parsable: string[] = [];
  let unparsable = 0;
  let empty = 0;
  let oversized = 0;
  for (const file of eligible) {
    const absolute = context.absolute(file);
    if (!isFile(absolute)) {
      errors.push({
        kind: 'unreadable-file',
        subject: file,
        message: 'Listed as an eligible file but not readable on disk.',
      });
      unparsable += 1;
      continue;
    }
    const bytes = sizeOf(absolute);
    if (bytes > limits.maxBytes) {
      // A coverage failure rather than a skip. Calling it a deliberate skip would
      // claim a decision nobody made: the detector's own size cutoff is a
      // default, not a judgement about this file, and a skipped file is one the
      // report has quietly stopped being about.
      oversized += 1;
      unparsable += 1;
      errors.push({
        kind: 'scan-failure',
        subject: file,
        message:
          `${bytes} bytes exceeds the configured clone-detection limit of ` +
          `${limits.maxBytes}; the detector would have dropped it silently`,
      });
      continue;
    }
    const verdict = parses(absolute);
    if (verdict.ok) {
      parsable.push(absolute);
    } else if (verdict.reason === 'empty') {
      empty += 1;
    } else {
      unparsable += 1;
      errors.push({
        kind: 'scan-failure',
        subject: file,
        message: verdict.reason,
      });
    }
  }

  if (parsable.length === 0) {
    // Nothing to compare. This is the DUP-9 case: a scan that produced no input
    // must be INCOMPLETE, never a PASS with zero findings - "found no clones" and
    // "found no files" are different claims and only one of them is about code.
    return {
      analyzer: DUPLICATION_ANALYZER,
      findings: [],
      errors: [
        ...errors,
        {
          kind: 'scan-failure',
          subject: '<run>',
          message:
            `${eligible.length} eligible file(s) produced no parsable input for ` +
            'the clone detector',
        },
      ],
      coverage: {
        eligible: eligible.length,
        scanned: 0,
        skipped: empty,
        failed: unparsable,
        skipReasons: empty > 0 ? { 'empty-file': empty } : {},
      },
      complete: false,
      status: 'failed',
      notes,
    };
  }

  const report = runJscpd(context, parsable, limits);
  if (!report.ok) {
    return {
      analyzer: DUPLICATION_ANALYZER,
      findings: [],
      errors: [...errors, { kind: 'scan-failure', subject: '<run>', message: report.reason }],
      coverage: {
        eligible: eligible.length,
        scanned: 0,
        skipped: empty,
        failed: eligible.length - empty,
        skipReasons: { 'clone-detector-did-not-run': 1 },
      },
      complete: false,
      status: 'failed',
      notes,
    };
  }

  const families = familiesFromPairs(
    report.duplicates.map((duplicate) => pairFrom(context.repoRoot, duplicate))
  );

  const findingList = findingsFromFamilies(families, limits.minTokens);

  const coverage: Coverage = {
    eligible: eligible.length,
    scanned: parsable.length,
    skipped: empty,
    failed: unparsable,
    skipReasons: {
      ...(empty > 0 ? { 'empty-file': empty } : {}),
    },
  };

  notes.push(`clone detector: ${families.length} clone famil(ies) detected`);
  notes.push(`token floor: ${limits.minTokens} tokens, ${limits.minLines} lines`);
  notes.push(
    `files excluded from detection: ${unparsable} ` +
      `(${oversized} above the ${limits.maxBytes}-byte detector limit)`
  );

  return {
    analyzer: DUPLICATION_ANALYZER,
    findings: findingList,
    errors,
    coverage,
    complete: coverageIsComplete(coverage),
    status: unparsable > 0 ? 'incomplete' : 'complete',
    notes,
  };
}

/**
 * Turn families into findings.
 *
 * The floor is applied here as well as being passed to the detector. That is not
 * belt-and-braces for its own sake: the tool's own accounting is demonstrably
 * unable to be trusted about what it did with the files it was given (it drops
 * unparsable ones silently), so "the tool was asked for blocks above N tokens" is
 * not by itself evidence that every reported block clears N. The filter is cheap
 * and makes the analyzer's own floor the one that decides. In the normal case it
 * drops nothing, because the detector was given the same number.
 *
 * ---------------------------------------------------------------------------
 * THERE IS NO DISAMBIGUATION PASS HERE, AND THAT IS THE POINT
 *
 * Identity is `DUP-001::<smallest member path>::<shape digest>`, and the subject
 * and the digest together are unique BY CONSTRUCTION: `familiesFromPairs` emits
 * exactly one family per digest, so one subject cannot carry two families with
 * the same digest, and sha256 does not collide.
 *
 * The first version of this needed an ordinal pass, because the anchor was a
 * 200-character PREFIX of the shape. That prefix is not injective - one region
 * being a strict superset of another makes them share their whole opening - and
 * six ids collided on this repository under it. The ordinal resolved them by
 * position, which reads as a fix until a third such family appears between two of
 * them and renumbers both, at which point a baseline change that did not happen
 * is reported.
 *
 * A pass that is not needed is worse than absent: it implies the identity needs
 * disambiguation, and it hides the real failure. If ids ever collide here it is a
 * bug in the grouping, not a case for a suffix, and `findingsFromFamilies` has no
 * way to paper over it.
 * ---------------------------------------------------------------------------
 */
function findingsFromFamilies(
  families: CloneFamily[],
  minTokens: number
): Finding[] {
  const above = families.filter((family) => family.tokens >= minTokens);
  const findings: Finding[] = [];

  for (const family of above) {
    const smallest = family.members[0];
    if (smallest === undefined) continue;
    findings.push({
      id: `${DUPLICATE_RULE}::${smallest.path}::${family.fingerprint}`,
      rule: DUPLICATE_RULE,
      subject: smallest.path,
      locator: `${smallest.startLine}-${smallest.endLine}`,
      // The shape digest, NOT the readable line. An anchor over raw source would
      // change when every copy of a block had a variable renamed, so a repo-wide
      // rename would read as every family resolving and being replaced. The
      // readable line is in `detail` and `evidence.regionStart`, which is where a
      // human reads it: no surface shows the anchor itself.
      anchor: family.fingerprint,
      classification: 'duplicated-block',
      status: 'fail',
      severity: 'error',
      // The opening line is quoted here, and `detail` is the field the accepted
      // baseline persists. Without it a baseline entry is a rule, a path, a range
      // and 64 hex characters, which is a reviewer being asked to accept something
      // they cannot recognize.
      detail:
        `${family.members.length} copies of a ${family.tokens}-token block ` +
        `(${family.kind}) opening "${clip(family.regionStart)}"; ` +
        'consolidate or accept as legacy',
      occurrences: family.members.length,
      debt: false,
      metric: {
        name: 'clone-copies',
        value: family.members.length,
        limit: 1,
        direction: 'lower-is-better',
      },
      evidence: {
        cloneKind: family.kind,
        tokens: family.tokens,
        lines: family.lines,
        fingerprint: family.fingerprint,
        regionStart: family.regionStart,
        // The member list, not a count. Copy-versus-move is decided by comparing
        // member sets between runs, so a bare occurrence count cannot answer it.
        members: membersKey(family.members),
        memberCount: family.members.length,
      },
    });
  }

  return findings.sort(
    (a, b) => a.id.localeCompare(b.id) || a.locator.localeCompare(b.locator)
  );
}

/**
 * Enough of a source line to recognize a block by, without turning one finding
 * into a paragraph.
 *
 * `regionStart` is already whitespace-collapsed and capped at 200 characters by
 * the anchor rules, so this is the second, tighter cap - it decides how much of a
 * long line lands in `detail`, which is printed for every new finding and
 * persisted for every accepted one.
 */
function clip(line: string): string {
  const LIMIT = 80;
  return line.length <= LIMIT ? line : `${line.slice(0, LIMIT)}...`;
}

/**
 * The floors, read from policy so changing them is a visible change.
 *
 * A missing or malformed policy file falls back to the defaults rather than
 * throwing, because the alternative - refusing to measure - is worse than
 * measuring with the documented floor. The fallback is not silent: the token
 * floor in force is printed in the run notes and hashed into policyDigest via
 * `Analyzer.policyFiles`, so a deleted policy file changes the digest.
 */
export interface DuplicationLimits {
  minTokens: number;
  minLines: number;
  maxBytes: number;
}

function limitsFor(repoRoot: string): DuplicationLimits {
  const path = join(repoRoot, POLICY_PATH);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      minTokens?: number;
      minLines?: number;
      maxBytes?: number;
    };
    return {
      minTokens:
        typeof parsed.minTokens === 'number' ? parsed.minTokens : DEFAULT_MIN_TOKENS,
      minLines:
        typeof parsed.minLines === 'number' ? parsed.minLines : DEFAULT_MIN_LINES,
      maxBytes:
        typeof parsed.maxBytes === 'number' ? parsed.maxBytes : DEFAULT_MAX_BYTES,
    };
  } catch {
    return {
      minTokens: DEFAULT_MIN_TOKENS,
      minLines: DEFAULT_MIN_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
    };
  }
}

/** File size in bytes, or a sentinel that forces the size check to fail open. */
function sizeOf(absolutePath: string): number {
  try {
    return statSync(absolutePath).size;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function runJscpd(
  context: AnalyzerContext,
  files: string[],
  limits: DuplicationLimits
): { ok: true; duplicates: JscpdDuplicate[] } | { ok: false; reason: string } {
  const outDir = join(context.cacheDir, 'jscpd');
  ensureDir(outDir);
  const reportPath = join(outDir, 'jscpd-report.json');
  const configPath = join(outDir, 'jscpd-config.json');

  // The corpus is passed through a CONFIG FILE, not the command line. This is
  // not a preference: 2,179 absolute paths exceed every command-line limit on
  // Windows, and the truncated-command-line failure mode is silent - the tool
  // exits plausibly having seen a fraction of the files.
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        path: files,
        minTokens: limits.minTokens,
        minLines: limits.minLines,
        // Explicit rather than left at the tool's 1 MB default, which drops a
        // file from the report with no trace. Files above it are counted as
        // coverage failures in the pre-pass, so the limit cannot hide anything.
        // A string, not a number: the tool accepts "1mb" or raw bytes as text and
        // rejects an integer with `invalid type: integer, expected a string`.
        maxSize: String(limits.maxBytes),
        reporters: ['json'],
        output: outDir,
        silent: true,
        ignore: ['**/node_modules/**', '**/dist/**'],
        // Highest-confidence modes only. `similar` (Type-3) is excluded on
        // purpose; see the module comment.
        kind: ['exact', 'renamed'],
        // Required for `kind: renamed` to be reported at all: without one of the
        // ignore-* options jscpd has no way to reach a renamed match.
        ignoreIdentifiers: true,
        // The corpus is enumerated from the source-universe manifest. Letting
        // `.gitignore` filter it too would give scope a second, undeclared
        // owner, and a file could drop out of measurement by adding a line to a
        // file no reviewer associates with quality.
        gitignore: false,
        absolute: true,
      },
      null,
      2
    ),
    'utf8'
  );

  if (existsSync(reportPath)) rmSync(reportPath, { force: true });

  const outcome = runTool({
    command: 'bun',
    // The version is PINNED, and it is pinned HERE, in the analyzer's own source,
    // for a reason that is about the identity model rather than about hygiene.
    // `toolchainDigest` covers `package.json` and the lockfiles, and this tool is
    // in neither: it is fetched by `bun x` and resolved from whatever is cached,
    // so the detector version could change under a digest that did not move - a
    // measurement taken by a different ruler and reported as comparable. The
    // adapter source IS covered, by `measurementDigest` (which hashes the whole
    // `scripts/quality` tree), so a pin written here moves the digest and shows
    // up in `migrate` as a measurement change. A floating `jscpd` would not.
    //
    // Version 5.3.0 is what every measurement recorded so far was taken with.
    args: ['x', `jscpd@${JSCPD_VERSION}`, '-c', configPath],
    cwd: context.repoRoot,
    // 0 is the only success: jscpd does not use a non-zero code for "found
    // clones", so any non-zero exit is a failure to run, not a finding. Measured:
    // a missing path exits 2 with `Error: path does not exist`.
    successCodes: [0],
    timeoutMs: 15 * 60 * 1000,
  });

  if (!outcome.ok) {
    return { ok: false, reason: outcome.failure ?? 'clone detector failed' };
  }

  if (!existsSync(reportPath)) {
    return {
      ok: false,
      reason:
        'clone detector exited successfully but wrote no report; an absent ' +
        'report and a clean report are different facts',
    };
  }

  const parsed = parseJsonReport<JscpdReport>(readFileSync(reportPath, 'utf8'));
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason };
  }
  if (parsed.value.duplicates === undefined) {
    // A report with no `duplicates` key is malformed, not empty: jscpd always
    // emits the key, so its absence means the report is not the one we think.
    return {
      ok: false,
      reason: 'clone detector report has no `duplicates` key',
    };
  }

  return { ok: true, duplicates: parsed.value.duplicates };
}

const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx'];

/** Policy file holding the floors. Hashed into policyDigest. */
export const POLICY_PATH = 'scripts/quality/policy/duplication.config.json';

export function isDuplicationSource(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  return EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export const duplicationAnalyzer: Analyzer = {
  id: DUPLICATION_ANALYZER,
  description:
    'Duplicated blocks: clone families with occurrence multiplicity, exact and ' +
    'identifier-renamed matches only.',
  rules: {
    [DUPLICATE_RULE]:
      'A block of code appears two or more times in the eligible corpus.',
  },
  extensions: EXTENSIONS,
  policyFiles: [POLICY_PATH],
  capabilities: ['clones'],
  contentScoped: true,
  run,
};
