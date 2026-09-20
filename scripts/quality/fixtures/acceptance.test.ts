/**
 * End-to-end acceptance fixtures for the two analyzers.
 *
 * These drive the real analyzers through the real gate, in a throwaway copy of
 * the repository. Nothing here is a unit test of a helper: each case is a claim
 * about what the system does, stated in terms of a change a person would actually
 * make, and answered by the engine rather than by a mock.
 *
 * The copy exists because the questions are about *working-tree* state - a new
 * untracked file, an edited tracked file - and those cannot be asked of a
 * temporary directory that is not a checkout. It also means an injected defect
 * can never touch the real tree, which matters because these fixtures
 * deliberately write bad code.
 *
 * Cost: copying the tree is the expensive part, so the copies are shared across
 * the tests in each describe block rather than made per test.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compare } from '../lib/compare';
import { BASELINE_SCHEMA_VERSION } from '../lib/baseline';
import type { AnalyzerResult, Baseline, GateResult } from '../lib/types';
import type { Analyzer } from '../lib/registry';
import { sourceIntegrityAnalyzer } from '../adapters/sourceIntegrity';
import { maintainabilityAnalyzer } from '../adapters/maintainability';
import {
  computeCandidateIdentity,
  identityEqual,
  policyFilesFor,
} from '../lib/identity';
import { loadCandidate } from '../lib/candidate';

const REAL_ROOT = join(import.meta.dir, '..', '..', '..');

// Declared once and inherited by both tests and hooks. Each test also passes an
// explicit timeout, and that is not redundant: measured on Bun 1.4.0, a per-hook
// timeout argument is not reliably applied to a `beforeAll` that runs inside a
// `describe`, and the symptom is a bare "a beforeEach/afterEach hook timed out"
// against a hook that was given 300s. The default is the one that holds.
setDefaultTimeout(300_000);

/** Paths that are never worth copying, and one that must not be. */
const SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  '.quality',
  '.claude',
  '.agent',
  // `.candidate-build` is a build artifact: a whole COPY of this repository,
  // produced by the acceptance build and gitignored. Not skipping it meant every
  // sandbox contained two repositories - measured here at 8,800 files and 139 MB
  // of the 1,700-file working tree, copied once per sandbox - and the analyzers
  // were then run in a tree that is not the candidate. That is the same defect the
  // unused-structure analyzer guards against by excluding the path from its own
  // walk, and it belongs at the copy, where it costs nothing to avoid.
  '.candidate-build',
]);

interface Sandbox {
  root: string;
  write(relPath: string, contents: string): void;
  remove(relPath: string): void;
  cleanup(): void;
}

function createSandbox(): Sandbox {
  const root = join(
    tmpdir(),
    `quality-acceptance-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  );
  cpSync(REAL_ROOT, root, {
    recursive: true,
    filter: (src) => {
      const parts = src.split(/[\\/]/);
      return !parts.some((part) => SKIP.has(part));
    },
  });

  // The dependencies are linked in, not copied, and this is load-bearing rather
  // than an optimisation. Without them the copy is a *different repository*: the
  // maintainability analyzer's ESLint config cannot resolve `typescript-eslint`,
  // ESLint exits 2, and every batch is reported as a tool that failed to run. The
  // exact same defect landed on the source-integrity side, where everything under
  // `scripts/` resolved to nothing and was reclassified as newly-untracked. Both
  // read as "the analyzer is broken" when in fact the measurement was taken over
  // a tree whose imports do not resolve.
  symlinkSync(
    join(REAL_ROOT, 'node_modules'),
    join(root, 'node_modules'),
    'junction'
  );

  // The sandbox is not a git checkout, and fabricating one would make these
  // fixtures depend on git's behaviour rather than the engine's. Instead the
  // analyzers are told which paths to treat as tracked; see `runAnalyzer`.
  return {
    root,
    write(relPath, contents) {
      const absolute = join(root, relPath);
      mkdirSync(join(absolute, '..'), { recursive: true });
      writeFileSync(absolute, contents, 'utf8');
    },
    remove(relPath) {
      rmSync(join(root, relPath), { force: true });
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * The working-tree model the analyzer will be handed, reproduced.
 *
 * `loadCandidate` reads git in the real tree, and the sandbox copy has no git, so
 * the model has to come from outside it; the fixture's own files are then added.
 * They are deliberately never added to the tracked set, because the whole point of
 * the untracked-file fixture is that a file git has never seen is still analyzed.
 *
 * The candidate set is deliberately read ONCE, before the sandbox exists, and never
 * re-read. Two reasons, and both were learned from failures:
 *
 *  1. A peer session edits this working tree continuously. Two independent git
 *     reads can disagree, and the disagreement surfaces as an incoherent
 *     measurement rather than as the noise it is: a run reported
 *     `eligible 2172 != scanned 2164 + skipped 7` because the eligible set came
 *     from before an edit and the policy digest from after it.
 *  2. The sandbox is never a source of files. `loadCandidate` is scoped to the real
 *     tree and copies are made from it, so the model cannot pick up a fixture file
 *     through a second read and mistake it for a tracked one.
 */
interface RunModel {
  files: string[];
  trackedFiles: Set<string>;
  identity: ReturnType<typeof computeCandidateIdentity>;
}

/**
 * One model per analyzer, captured on first use and never refreshed.
 *
 * Memoised by analyzer because the identity has to carry that analyzer's own policy
 * files - exactly as the CLI composes them - while the file set and tracked
 * universe are properties of the tree. A single shared snapshot with a
 * freshly-derived policy digest would reintroduce the two-reads-disagree defect
 * this exists to prevent.
 */
const MODELS = new Map<string, RunModel>();

function modelFor(analyzer: Analyzer, extras: Iterable<string>): RunModel {
  let base = MODELS.get(analyzer.id);
  if (base === undefined) {
    const candidate = loadCandidate(REAL_ROOT);
    const policyFiles = [
      ...policyFilesFor(analyzer.id),
      ...(analyzer.policyFiles ?? []),
    ];
    base = {
      files: candidate.files,
      trackedFiles: candidate.trackedFiles,
      identity: computeCandidateIdentity(REAL_ROOT, policyFiles),
    };
    MODELS.set(analyzer.id, base);
  }
  const files = new Set(base.files);
  for (const extra of extras) files.add(extra);
  return { ...base, files: [...files].sort() };
}

async function runAnalyzer(
  analyzer: Analyzer,
  root: string,
  extras: Iterable<string> = []
): Promise<RunAnalysis> {
  const model = modelFor(analyzer, extras);
  const result = await analyzer.run({
    repoRoot: root,
    candidateFiles: model.files,
    absolute: (relativePath) => join(root, relativePath),
    // Real tracked files only. Anything the fixture added stays untracked.
    trackedFiles: model.trackedFiles,
    cacheDir: join(root, '.quality-cache'),
    notes: [],
  });
  return { result, identity: model.identity };
}

interface RunAnalysis {
  result: AnalyzerResult;
  identity: ReturnType<typeof computeCandidateIdentity>;
}

/**
 * Run the gate over a run's own identity.
 *
 * `candidateAtFinish` is the same value as `candidateAtStart` on purpose: the
 * fixture is asserting what the engine decides about the *analyzer's output*, not
 * re-asserting that the working tree held still. The mid-run mutation case is
 * covered by its own fixture in compare.test.ts, where the two are made to differ
 * deliberately. Reading git a second time here would instead make these fixtures
 * fail whenever a peer happens to save a file, which is noise about the
 * developer's machine rather than a statement about the engine.
 */
function gateOver(
  analysis: RunAnalysis,
  baseline: Baseline | null,
  root: string
): GateResult {
  return compare({
    analyzer: analysis.result.analyzer,
    profile: 'research',
    baseline,
    result: analysis.result,
    candidateAtStart: analysis.identity,
    candidateAtFinish: analysis.identity,
    repoRoot: root,
    detectMoves: false,
  });
}

/**
 * Assert the gate's verdict, and fail with the reasons rather than the verdict
 * when the answer is INCOMPLETE.
 *
 * A bare `expect(gate.decision).toBe('FAIL')` failing as "received INCOMPLETE"
 * says nothing about which of the several completeness rules tripped, and the
 * rules include ones that fire for entirely different reasons - an analyzer that
 * did not run, a batch that crashed, coverage that does not add up. Reporting the
 * reasons is the difference between a fixture that names a defect and one that
 * sends the reader back to instrumenting by hand.
 */
function expectDecision(
  gate: GateResult,
  expected: Exclude<GateResult['decision'], 'INCOMPLETE'>
): void {
  if (gate.decision === 'INCOMPLETE') {
    throw new Error(
      `expected ${expected} but the gate reported INCOMPLETE:\n  - ` +
        gate.incompleteReasons.join('\n  - ')
    );
  }
  expect(gate.decision).toBe(expected);
}

/**
 * A baseline that records exactly the currently-failing findings.
 *
 * This mirrors what `quality baseline --propose` does, with two deliberate
 * departures that exist so the fixtures can ask their questions at all:
 *
 *  - `metric` with a null limit is omitted. A real baseline is produced by the
 *    real proposal path, which has the analyzer's configured limit available. The
 *    fixtures build their own baseline and cannot know it, and a metric with no
 *    limit is exactly the case the improvement arithmetic refuses to guess at.
 *  - `subjectDigest` is a fixed placeholder. Move detection is switched off for
 *    these fixtures, so a digest that does not track content is honest rather than
 *    load-bearing.
 *
 * `policyDigest` and `candidate` come from the run's own snapshot rather than a
 * fresh read, so they describe the same tree the findings came from. The gate
 * rejects a baseline whose policy digest disagrees with the candidate as
 * INCOMPLETE - correctly - and a fresh read could disagree simply because a peer
 * saved a file in between.
 */
function baselineFrom(analysis: RunAnalysis): Baseline {
  const acceptance = {
    reason: 'fixture baseline: current state frozen as the ratchet point',
    acceptedBy: 'fixture',
    acceptedAt: '2026-09-17T00:00:00.000Z',
    owner: null,
    expiresAt: null,
  };
  const recorded: Record<string, unknown> = {};
  for (const finding of analysis.result.findings) {
    if (finding.reviewRequired === true) continue;
    if (finding.status !== 'fail' && !finding.debt) continue;
    const metric =
      finding.metric !== undefined && finding.metric.limit !== null
        ? finding.metric
        : undefined;
    recorded[finding.id] = {
      rule: finding.rule,
      classification: finding.classification,
      status: finding.status,
      severity: finding.severity,
      subject: finding.subject,
      locator: finding.locator,
      anchor: finding.anchor,
      subjectDigest: finding.subject === '' ? null : 'fixture-digest',
      occurrences: finding.occurrences,
      debt: finding.debt,
      ...(metric !== undefined ? { metric } : {}),
      acceptance,
    };
  }
  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    analyzer: analysis.result.analyzer,
    policyDigest: analysis.identity.policyDigest,
    createdAt: '2026-09-17T00:00:00.000Z',
    candidate: analysis.identity,
    findings: recorded as Baseline['findings'],
  };
}

describe('source-integrity: a new untracked source file is analyzed, not ignored', () => {
  let sandbox: Sandbox;
  let baseline: Baseline;
  const REL = 'src/__fixture_new_module.ts';

  beforeAll(async () => {
    sandbox = createSandbox();
    // A brand-new file that no commit contains, importing a module that does not
    // exist. The trusted repository state does not contain it, so the baseline is
    // taken first; the file then appears on disk exactly as `git status` would
    // report a new untracked source file.
    const clean = await runAnalyzer(sourceIntegrityAnalyzer, sandbox.root);
    baseline = baselineFrom(clean);
    sandbox.write(
      REL,
      "import { missing } from './__fixture_absent_target.js';\nexport const x = missing;\n"
    );
  }, 300_000);

  afterAll(() => {
    sandbox?.cleanup();
  });

  test('the new file is on disk but absent from the tracked universe', () => {
    const model = loadCandidate(REAL_ROOT);
    expect(model.files).not.toContain(REL);
    expect(model.trackedFiles.has(REL)).toBe(false);
    expect(existsSync(join(sandbox.root, REL))).toBe(true);
  });

  test('it is not in the baseline, because the baseline predates it', () => {
    const recorded = Object.keys(baseline.findings).filter((id) =>
      id.includes(REL)
    );
    expect(recorded).toEqual([]);
  });

  test('its unresolved dependency fails the gate', async () => {
    const analysis = await runAnalyzer(sourceIntegrityAnalyzer, sandbox.root, [REL]);

    // The fixture's whole point is that the file was analysed rather than skipped.
    // Without this the case would still "pass" if the analyzer ignored the file and
    // the gate failed for some unrelated reason.
    expect(
      analysis.result.findings.filter((finding) => finding.subject === REL).length
    ).toBeGreaterThan(0);
    expect(analysis.result.coverage.eligible).toBeGreaterThan(0);

    const gate = gateOver(analysis, baseline, sandbox.root);
    expectDecision(gate, 'FAIL');
    const subjects = gate.newFindings.map((finding) => finding.subject);
    expect(subjects).toContain(REL);
  }, 300_000);
});

describe('maintainability: the five required behaviours', () => {
  const COMPLEX = 'src/__fixture_complex.ts';
  const SUPPRESSED = 'src/__fixture_suppression.ts';
  let sandbox: Sandbox;
  let baseline: Baseline;

  /** A function over the configured cognitive-complexity limit of 25. */
  function complexFunction(name: string, branches: number): string {
    const lines = [`export function ${name}(n: number): number {`, '  let total = 0;'];
    for (let index = 0; index < branches; index += 1) {
      lines.push(`  if (n > ${index}) { total += ${index}; }`);
    }
    lines.push('  return total;', '}');
    return `${lines.join('\n')}\n`;
  }

  beforeAll(async () => {
    sandbox = createSandbox();

    // Order matters, and this is the whole fixture.
    //
    // The over-complex function is written FIRST and the baseline is taken over a
    // tree that contains it. That is what "historical" means: the baseline is the
    // ratchet point, and a defect recorded in it is tolerated. Nothing else about
    // the file distinguishes it from the repository's real legacy complexity debt -
    // which is exactly the claim under test, that being in the baseline is what
    // makes something accepted legacy, and not any property of the finding.
    //
    // The genuinely-new files (the second over-complex function, the suppression
    // file) are written by their own tests, after this baseline, and are asserted
    // to be absent from it. That is what stops the "should fail" cases from
    // passing for the wrong reason.
    sandbox.write(COMPLEX, complexFunction('historical', 40));
    const seeded = await runAnalyzer(maintainabilityAnalyzer, sandbox.root, [COMPLEX]);
    baseline = baselineFrom(seeded);
  }, 600_000);

  afterAll(() => {
    sandbox?.cleanup();
  });

  test('the historical function is recorded in the baseline', () => {
    // Three separate rules fire on this function - cyclomatic complexity,
    // cognitive complexity and statement count - and each gets its own entry, so
    // several accepted-legacy dispositions are expected rather than one.
    //
    // The ids carry the function's own source text rather than the line it was
    // found on, which is what lets these three entries survive the file being
    // edited above them. `complexFunction` writes the declaration on line 1, so
    // the anchor is that line's text.
    const declaration = `export function historical(n: number): number {`;
    const recorded = Object.keys(baseline.findings).filter((id) =>
      id.includes(COMPLEX)
    );
    expect(recorded).toContain(`complexity::${COMPLEX}::${declaration}`);
    expect(recorded).toContain(
      `sonarjs/cognitive-complexity::${COMPLEX}::${declaration}`
    );
    expect(recorded.length).toBeGreaterThanOrEqual(3);
    // No entry may be identified by a position, which is the defect this shape
    // exists to prevent.
    for (const id of recorded) {
      expect(id).not.toMatch(/::\d+:\d+$/);
    }
  });

  test('the files the later cases introduce are not', () => {
    const recorded = Object.keys(baseline.findings);
    expect(recorded.some((id) => id.includes('__fixture_new_complex'))).toBe(false);
    expect(recorded.some((id) => id.includes(SUPPRESSED))).toBe(false);
  });

  test('a historical over-complex function is accepted legacy, not a failure', async () => {
    const analysis = await runAnalyzer(maintainabilityAnalyzer, sandbox.root, [COMPLEX]);
    const gate = gateOver(analysis, baseline, sandbox.root);
    expectDecision(gate, 'PASS');
    expect(gate.newFindings).toHaveLength(0);
    expect(gate.dispositions['accepted-legacy']).toBeGreaterThan(0);
  }, 600_000);

  test('the same function worsened fails', async () => {
    sandbox.write(COMPLEX, complexFunction('historical', 90));
    const analysis = await runAnalyzer(maintainabilityAnalyzer, sandbox.root, [COMPLEX]);
    const gate = gateOver(analysis, baseline, sandbox.root);
    expectDecision(gate, 'FAIL');
    expect(gate.worsened.length).toBeGreaterThan(0);
    // Restore, so a failure here cannot be mistaken for the next case's cause.
    sandbox.write(COMPLEX, complexFunction('historical', 40));
  }, 600_000);

  test('the same function improved but still over the limit passes and is recorded', async () => {
    sandbox.write(COMPLEX, complexFunction('historical', 32));
    const analysis = await runAnalyzer(maintainabilityAnalyzer, sandbox.root, [COMPLEX]);
    const gate = gateOver(analysis, baseline, sandbox.root);
    // Still above the limit of 25, so it is not "fixed" - but it moved the right
    // way, and that has to be visible rather than indistinguishable from no change.
    expectDecision(gate, 'PASS');
    expect(gate.improvedFindings.length).toBeGreaterThan(0);
    expect(gate.worsened).toHaveLength(0);
    sandbox.write(COMPLEX, complexFunction('historical', 40));
  }, 600_000);

  test('a new over-complex function fails', async () => {
    const added = 'src/__fixture_new_complex.ts';
    sandbox.write(added, complexFunction('brandNew', 40));
    const analysis = await runAnalyzer(maintainabilityAnalyzer, sandbox.root, [added]);
    const gate = gateOver(analysis, baseline, sandbox.root);
    expectDecision(gate, 'FAIL');
    expect(gate.newFindings.length).toBeGreaterThan(0);
  }, 600_000);

  test('editing above a tolerated finding does not report it as new debt', async () => {
    // The defect, through the real analyzer. Every finding in this file sits on
    // the function declaration, so adding imports at the top of the file moves
    // the whole function down. Under a `line:column` identity that produced one
    // new blocker and one resolved entry per rule - and because accepting a
    // resolution is refused while new findings exist, the ratchet could not be
    // advanced at all. Measured on this repository's first post-baseline commit:
    // 283 new findings, 259 of them pure line shifts.
    const body = complexFunction('historical', 40);
    const shifted = `import { thing } from './other';\n\n${body}`;
    sandbox.write(COMPLEX, shifted);
    try {
      const analysis = await runAnalyzer(maintainabilityAnalyzer, sandbox.root, [COMPLEX]);
      const gate = gateOver(analysis, baseline, sandbox.root);
      expectDecision(gate, 'PASS');
      expect(gate.newFindings).toHaveLength(0);
      expect(gate.resolvedFindings).toHaveLength(0);
    } finally {
      // Restore, so a failure here cannot be mistaken for the next case's cause.
      sandbox.write(COMPLEX, complexFunction('historical', 40));
    }
  }, 600_000);

  test('a new broad eslint-disable fails as suppression debt', async () => {
    sandbox.write(
      SUPPRESSED,
      [
        '/* eslint-disable */',
        'export function silenced(n: number): number {',
        '  return n + 1;',
        '}',
        '',
      ].join('\n')
    );
    const analysis = await runAnalyzer(maintainabilityAnalyzer, sandbox.root, [
      SUPPRESSED,
    ]);
    const suppression = analysis.result.findings.filter(
      (finding) => finding.subject === SUPPRESSED
    );
    expect(suppression.length).toBeGreaterThan(0);
    const gate = gateOver(analysis, baseline, sandbox.root);
    expectDecision(gate, 'FAIL');
  }, 600_000);
});

describe('identity invariant', () => {
  test('two runs over an unchanged tree produce the same identity', () => {
    const a = computeCandidateIdentity(REAL_ROOT);
    const b = computeCandidateIdentity(REAL_ROOT);
    expect(identityEqual(a, b)).toBe(true);
    expect(a.computedAt).not.toBe('');
  });
});
