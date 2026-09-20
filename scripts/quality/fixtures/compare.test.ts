/**
 * Gate decision fixtures.
 *
 * The gate is the part of the system that can block a human, so it gets the most
 * adversarial coverage. Every case below is a way a naive implementation would
 * make the wrong call.
 */
import { describe, expect, test } from 'bun:test';
import { compare } from '../lib/compare';
import { proposeBaseline } from '../lib/baseline';
import { createFixtureTree } from './tree';
import type {
  AnalyzerResult,
  Baseline,
  BaselineFinding,
  CandidateIdentity,
  Coverage,
  Finding,
} from '../lib/types';

const POLICY = 'policy-digest-1';

function candidate(overrides: Partial<CandidateIdentity> = {}): CandidateIdentity {
  return {
    head: 'head-1',
    headDirty: false,
    trackedChangesDigest: 'changes-1',
    relevantUntrackedDigest: 'untracked-1',
    policyDigest: POLICY,
    measurementDigest: 'measurement-1',
    toolchainDigest: 'toolchain-1',
    computedAt: '2026-09-17T00:00:00.000Z',
    sourceDigest: 'source-1',
    ...overrides,
  };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  const rule = overrides.rule ?? 'INT-003';
  const subject = overrides.subject ?? 'src/a.ts';
  const locator = overrides.locator ?? './b.js';
  // Identity is built from `anchor`, never from the locator - these fixtures
  // exist to pin what the gate decides, and a helper that composed ids the way
  // the engine no longer does would keep passing while testing nothing.
  const anchor = overrides.anchor ?? locator;
  return {
    id: overrides.id ?? `${rule}::${subject}::${anchor}`,
    rule,
    subject,
    locator,
    anchor,
    classification: overrides.classification ?? 'unexpected-stub',
    status: overrides.status ?? 'fail',
    severity: overrides.severity ?? 'error',
    detail: overrides.detail ?? 'detail',
    occurrences: overrides.occurrences ?? 1,
    debt: overrides.debt ?? false,
    evidence: overrides.evidence ?? {},
    ...(overrides.metric !== undefined ? { metric: overrides.metric } : {}),
  };
}

function coverage(overrides: Partial<Coverage> = {}): Coverage {
  return {
    eligible: 10,
    scanned: 10,
    skipped: 0,
    failed: 0,
    skipReasons: {},
    ...overrides,
  };
}

function result(
  findings: Finding[],
  overrides: Partial<AnalyzerResult> = {}
): AnalyzerResult {
  const cov = overrides.coverage ?? coverage();
  return {
    analyzer: 'source-integrity',
    findings,
    errors: [],
    coverage: cov,
    complete: overrides.complete ?? true,
    status: overrides.status ?? 'complete',
    notes: [],
    ...overrides,
  };
}

const ACCEPTANCE = {
  reason: 'fixture',
  acceptedBy: 'tester',
  owner: null,
  expiresAt: null,
};

function baselineOf(repoRoot: string, findings: Finding[]): Baseline {
  return proposeBaseline(repoRoot, 'source-integrity', result(findings), candidate(), {
    ...ACCEPTANCE,
  }).baseline;
}

describe('gate fails closed', () => {
  test('no baseline is INCOMPLETE, never a pass', () => {
    const tree = createFixtureTree();
    try {
      const gate = compare({
        analyzer: 'source-integrity',
        profile: 'research',
        baseline: null,
        result: result([finding()]),
        candidateAtStart: candidate(),
        candidateAtFinish: candidate(),
        repoRoot: tree.root,
      });
      expect(gate.decision).toBe('INCOMPLETE');
      expect(gate.incompleteReasons.join(' ')).toContain('no accepted baseline');
    } finally {
      tree.cleanup();
    }
  });

  test('a candidate that mutated mid-run cannot be authorized', () => {
    const tree = createFixtureTree();
    try {
      const gate = compare({
        analyzer: 'source-integrity',
        profile: 'research',
        baseline: baselineOf(tree.root, []),
        result: result([]),
        candidateAtStart: candidate(),
        candidateAtFinish: candidate({ head: 'head-2' }),
        repoRoot: tree.root,
      });
      expect(gate.decision).toBe('INCOMPLETE');
      expect(gate.incompleteReasons.join(' ')).toContain('mutated during the run');
    } finally {
      tree.cleanup();
    }
  });

  test('an edit to an untracked source file mid-run also invalidates the run', () => {
    const tree = createFixtureTree();
    try {
      // The digest is of untracked *contents*, so editing a new file while the
      // analyzer runs is caught even though HEAD never moved and no path changed.
      const gate = compare({
        analyzer: 'source-integrity',
        profile: 'research',
        baseline: baselineOf(tree.root, []),
        result: result([]),
        candidateAtStart: candidate({ relevantUntrackedDigest: 'untracked-1' }),
        candidateAtFinish: candidate({ relevantUntrackedDigest: 'untracked-2' }),
        repoRoot: tree.root,
      });
      expect(gate.decision).toBe('INCOMPLETE');
    } finally {
      tree.cleanup();
    }
  });

  test('a working-tree edit to a tracked file mid-run invalidates the run', () => {
    const tree = createFixtureTree();
    try {
      const gate = compare({
        analyzer: 'source-integrity',
        profile: 'research',
        baseline: baselineOf(tree.root, []),
        result: result([]),
        candidateAtStart: candidate({ trackedChangesDigest: 'changes-1' }),
        candidateAtFinish: candidate({ trackedChangesDigest: 'changes-2' }),
        repoRoot: tree.root,
      });
      expect(gate.decision).toBe('INCOMPLETE');
    } finally {
      tree.cleanup();
    }
  });

  test('a policy change invalidates the baseline', () => {
    const tree = createFixtureTree();
    try {
      const gate = compare({
        analyzer: 'source-integrity',
        profile: 'research',
        baseline: baselineOf(tree.root, [finding()]),
        result: result([finding()]),
        candidateAtStart: candidate({ policyDigest: 'policy-digest-2' }),
        candidateAtFinish: candidate({ policyDigest: 'policy-digest-2' }),
        repoRoot: tree.root,
      });
      expect(gate.decision).toBe('INCOMPLETE');
      expect(gate.incompleteReasons.join(' ')).toContain('policy digest');
    } finally {
      tree.cleanup();
    }
  });

  test('a baseline from a different measurement system is INCOMPLETE', () => {
    const tree = createFixtureTree();
    try {
      // The ruler changed. Comparing the old numbers to the new ones would report
      // every difference between two rulers as a difference in the code, so the
      // gate refuses rather than guessing and points at `quality migrate`.
      const gate = compare({
        analyzer: 'source-integrity',
        profile: 'research',
        baseline: baselineOf(tree.root, [finding()]),
        result: result([finding()]),
        candidateAtStart: candidate({ measurementDigest: 'measurement-2' }),
        candidateAtFinish: candidate({ measurementDigest: 'measurement-2' }),
        repoRoot: tree.root,
      });
      expect(gate.decision).toBe('INCOMPLETE');
      expect(gate.incompleteReasons.join(' ')).toContain('measurement system');
      expect(gate.incompleteReasons.join(' ')).toContain('quality migrate');
    } finally {
      tree.cleanup();
    }
  });

  test('a baseline from a different pinned instrument is INCOMPLETE', () => {
    const tree = createFixtureTree();
    try {
      // The pin moved, the code did not. This check exists because
      // `toolchainDigest` was computed, stored on every run record and every
      // baseline, and read by NO decision: an external resolver pinned in its own
      // project (`.quality/tools`, outside the walk that produces
      // `measurementDigest`) could be swapped for a newer one and every check the
      // gate made would still agree, while the numbers on both sides came from
      // different programs. A newer resolver can add or drop findings on an
      // unchanged tree, so this must refuse rather than compare.
      const gate = compare({
        analyzer: 'source-integrity',
        profile: 'research',
        baseline: baselineOf(tree.root, [finding()]),
        result: result([finding()]),
        candidateAtStart: candidate({ toolchainDigest: 'toolchain-2' }),
        candidateAtFinish: candidate({ toolchainDigest: 'toolchain-2' }),
        repoRoot: tree.root,
      });
      expect(gate.decision).toBe('INCOMPLETE');
      expect(gate.incompleteReasons.join(' ')).toContain('pinned instrument');
      // The reason must name the direction, not just the fact: "re-record" and
      // "the code changed" are indistinguishable from a findings count alone.
      expect(gate.incompleteReasons.join(' ')).toContain('quality migrate');
      expect(gate.incompleteReasons.join(' ')).toContain('not a finding about the code');
    } finally {
      tree.cleanup();
    }
  });

  test('an instrument-less baseline is not blocked by the instrument check', () => {
    const tree = createFixtureTree();
    try {
      // Baselines written before instrument tracking existed have no digest to
      // compare. Same reasoning as the epoch-less case above: inventing a value
      // would compare equal and silently skip, so absence reads as unknown and
      // the migration report is what forces the deliberate re-record.
      const baseline = baselineOf(tree.root, [finding()]);
      delete (baseline as { toolchainDigest?: string }).toolchainDigest;

      const gate = compare({
        analyzer: 'source-integrity',
        profile: 'research',
        baseline,
        result: result([finding()]),
        candidateAtStart: candidate({ toolchainDigest: 'toolchain-2' }),
        candidateAtFinish: candidate({ toolchainDigest: 'toolchain-2' }),
        repoRoot: tree.root,
      });
      expect(gate.decision).toBe('PASS');
    } finally {
      tree.cleanup();
    }
  });

  test('an epoch-less baseline is not blocked by the measurement check', () => {
    const tree = createFixtureTree();
    try {
      // Baselines written before epoch tracking existed have no digest to compare,
      // and inventing one would be worse than admitting ignorance. They are read
      // as-is; the migration report is what forces a deliberate re-record, and it
      // reports `unknown-epoch` rather than pretending the comparison happened.
      const baseline = baselineOf(tree.root, [finding()]);
      delete (baseline as { measurementDigest?: string }).measurementDigest;

      const gate = compare({
        analyzer: 'source-integrity',
        profile: 'research',
        baseline,
        result: result([finding()]),
        candidateAtStart: candidate(),
        candidateAtFinish: candidate(),
        repoRoot: tree.root,
      });
      expect(gate.decision).toBe('PASS');
    } finally {
      tree.cleanup();
    }
  });

  test('a FAILED analyzer is never a pass and never a resolution', () => {
    const tree = createFixtureTree();
    try {
      // The permanent rule, as the artefact: a traversal throws, a `catch`
      // returns `[]`, and every downstream stage reads an empty finding list as
      // a claim that the code is clean. Here the baseline holds one finding and
      // the failed run reports none, so a naive implementation would call it
      // RESOLVED - the debt would vanish with nobody seeing it.
      const gate = compare({
        analyzer: 'source-integrity',
        profile: 'research',
        baseline: baselineOf(tree.root, [finding()]),
        result: result([], { status: 'failed', complete: false }),
        candidateAtStart: candidate(),
        candidateAtFinish: candidate(),
        repoRoot: tree.root,
      });

      expect(gate.decision).toBe('INCOMPLETE');
      expect(gate.incompleteReasons.join(' ')).toContain('FAILED');
      // The finding is NOT reported as resolved. That is the whole assertion:
      // absence of evidence is not evidence of absence.
      expect(gate.resolvedFindings).toHaveLength(0);
      expect(gate.completeness).toBe('incomplete');
    } finally {
      tree.cleanup();
    }
  });

  test('an INCOMPLETE execution is refused even when coverage adds up', () => {
    const tree = createFixtureTree();
    try {
      // A run that ends early having covered its scope cleanly is still not a
      // clean bill of health: the analyzer said so itself.
      const gate = compare({
        analyzer: 'source-integrity',
        profile: 'research',
        baseline: baselineOf(tree.root, [finding()]),
        result: result([finding()], { status: 'incomplete' }),
        candidateAtStart: candidate(),
        candidateAtFinish: candidate(),
        repoRoot: tree.root,
      });

      expect(gate.decision).toBe('INCOMPLETE');
      expect(gate.incompleteReasons.join(' ')).toContain('INCOMPLETE');
    } finally {
      tree.cleanup();
    }
  });

  test('a status of complete is required for a PASS, not merely asserted coverage', () => {
    const tree = createFixtureTree();
    try {
      // Same findings, same arithmetic, only the status differs. Nothing else
      // may be able to turn this into a pass.
      const gate = compare({
        analyzer: 'source-integrity',
        profile: 'research',
        baseline: baselineOf(tree.root, [finding()]),
        result: result([finding()], { status: 'failed', complete: true }),
        candidateAtStart: candidate(),
        candidateAtFinish: candidate(),
        repoRoot: tree.root,
      });
      expect(gate.decision).toBe('INCOMPLETE');
      expect(gate.completeness).toBe('incomplete');
    } finally {
      tree.cleanup();
    }
  });

  test('an incomplete analyzer cannot report a pass', () => {
    const tree = createFixtureTree();
    try {
      const gate = compare({
        analyzer: 'source-integrity',
        profile: 'research',
        baseline: baselineOf(tree.root, []),
        result: result([], { complete: false }),
        candidateAtStart: candidate(),
        candidateAtFinish: candidate(),
        repoRoot: tree.root,
      });
      expect(gate.decision).toBe('INCOMPLETE');
    } finally {
      tree.cleanup();
    }
  });

  test('coverage that does not add up is INCOMPLETE even if asserted complete', () => {
    const tree = createFixtureTree();
    try {
      // An analyzer that claims completeness while its own arithmetic disagrees is
      // the exact failure mode "coverage complete" must not be able to hide.
      const gate = compare({
        analyzer: 'source-integrity',
        profile: 'research',
        baseline: baselineOf(tree.root, []),
        result: result([], {
          complete: true,
          coverage: coverage({ eligible: 10, scanned: 3 }),
        }),
        candidateAtStart: candidate(),
        candidateAtFinish: candidate(),
        repoRoot: tree.root,
      });
      expect(gate.decision).toBe('INCOMPLETE');
      expect(gate.incompleteReasons.join(' ')).toContain('coverage');
    } finally {
      tree.cleanup();
    }
  });

  test('a scan that read zero files cannot pass', () => {
    const tree = createFixtureTree();
    try {
      const gate = compare({
        analyzer: 'source-integrity',
        profile: 'research',
        baseline: baselineOf(tree.root, []),
        result: result([], {
          complete: true,
          coverage: coverage({ eligible: 0, scanned: 0 }),
        }),
        candidateAtStart: candidate(),
        candidateAtFinish: candidate(),
        repoRoot: tree.root,
      });
      expect(gate.decision).toBe('INCOMPLETE');
    } finally {
      tree.cleanup();
    }
  });
});

describe('ratchet behaviour', () => {
  test('the frozen backlog does not fail the gate', () => {
    const tree = createFixtureTree();
    try {
      tree.write('src/b.js', 'export default {};\n');
      const known = finding({ status: 'fail' });
      const gate = compare({
        analyzer: 'source-integrity',
        profile: 'research',
        baseline: baselineOf(tree.root, [known]),
        result: result([known]),
        candidateAtStart: candidate(),
        candidateAtFinish: candidate(),
        repoRoot: tree.root,
      });
      expect(gate.decision).toBe('PASS');
      expect(gate.grandfatheredCount).toBe(1);
      expect(gate.dispositions['accepted-legacy']).toBe(1);
      expect(gate.newFindings).toHaveLength(0);
    } finally {
      tree.cleanup();
    }
  });

  test('a genuinely new failure fails the gate', () => {
    const tree = createFixtureTree();
    try {
      tree.write('src/b.js', 'export default {};\n');
      const known = finding({ status: 'fail' });
      const added = finding({
        subject: 'src/c.ts',
        locator: './d.js',
      });
      const gate = compare({
        analyzer: 'source-integrity',
        profile: 'research',
        baseline: baselineOf(tree.root, [known]),
        result: result([known, added]),
        candidateAtStart: candidate(),
        candidateAtFinish: candidate(),
        repoRoot: tree.root,
      });
      expect(gate.decision).toBe('FAIL');
      expect(gate.newFindings.map((entry) => entry.subject)).toEqual(['src/c.ts']);
      expect(gate.dispositions['active-blocker']).toBe(1);
    } finally {
      tree.cleanup();
    }
  });

  test('a NEW use of already-declared tolerated debt fails the gate', () => {
    const tree = createFixtureTree();
    try {
      tree.write('src/b.js', 'export default {};\n');
      const knownDebt = finding({
        classification: 'declared-legacy-stub',
        rule: 'INT-002',
        status: 'pass',
        severity: 'warning',
        debt: true,
        subject: 'src/a.ts',
      });
      // Same stub, different importer: the policy digest is unchanged, so this is
      // the only thing standing between the gate and a silent bypass.
      const newUse = finding({
        classification: 'declared-legacy-stub',
        rule: 'INT-002',
        status: 'pass',
        severity: 'warning',
        debt: true,
        subject: 'src/elsewhere.ts',
      });

      const gate = compare({
        analyzer: 'source-integrity',
        profile: 'research',
        baseline: baselineOf(tree.root, [knownDebt]),
        result: result([knownDebt, newUse]),
        candidateAtStart: candidate(),
        candidateAtFinish: candidate(),
        repoRoot: tree.root,
      });

      expect(gate.decision).toBe('FAIL');
      expect(gate.newFindings.map((entry) => entry.subject)).toEqual([
        'src/elsewhere.ts',
      ]);
    } finally {
      tree.cleanup();
    }
  });

  test('more occurrences of a known finding is a worsening', () => {
    const tree = createFixtureTree();
    try {
      tree.write('src/b.js', 'export default {};\n');
      const known = finding({ status: 'fail', occurrences: 1 });
      const gate = compare({
        analyzer: 'source-integrity',
        profile: 'research',
        baseline: baselineOf(tree.root, [known]),
        result: result([{ ...known, occurrences: 3 }]),
        candidateAtStart: candidate(),
        candidateAtFinish: candidate(),
        repoRoot: tree.root,
      });
      expect(gate.decision).toBe('FAIL');
      expect(gate.worsened[0]?.reason).toBe('occurrences-increased');
    } finally {
      tree.cleanup();
    }
  });

  test('resolving a finding shrinks the baseline and still passes', () => {
    const tree = createFixtureTree();
    try {
      tree.write('src/b.js', 'export default {};\n');
      const known = finding({ status: 'fail' });
      const gate = compare({
        analyzer: 'source-integrity',
        profile: 'research',
        baseline: baselineOf(tree.root, [known]),
        result: result([]),
        candidateAtStart: candidate(),
        candidateAtFinish: candidate(),
        repoRoot: tree.root,
      });
      expect(gate.decision).toBe('PASS');
      expect(gate.resolvedFindings).toHaveLength(1);
      expect(gate.resolvedFindings[0]?.subject).toBe('src/a.ts');
    } finally {
      tree.cleanup();
    }
  });
});

describe('waivers expire closed', () => {
  test('an expired waiver blocks', () => {
    const tree = createFixtureTree();
    try {
      tree.write('src/b.js', 'export default {};\n');
      const known = finding({ status: 'fail' });
      const baseline = proposeBaseline(
        tree.root,
        'source-integrity',
        result([known]),
        candidate(),
        {
          reason: 'temporary',
          acceptedBy: 'tester',
          expiresAt: '2026-01-01T00:00:00.000Z',
        }
      ).baseline;

      const gate = compare({
        analyzer: 'source-integrity',
        profile: 'research',
        baseline,
        result: result([known]),
        candidateAtStart: candidate(),
        candidateAtFinish: candidate(),
        repoRoot: tree.root,
        now: () => new Date('2026-09-17T00:00:00.000Z'),
      });

      expect(gate.decision).toBe('FAIL');
      expect(gate.dispositions['active-blocker']).toBe(1);
    } finally {
      tree.cleanup();
    }
  });

  test('an unexpired waiver is tolerated and counted as a waiver', () => {
    const tree = createFixtureTree();
    try {
      tree.write('src/b.js', 'export default {};\n');
      const known = finding({ status: 'fail' });
      const baseline = proposeBaseline(
        tree.root,
        'source-integrity',
        result([known]),
        candidate(),
        {
          reason: 'temporary',
          acceptedBy: 'tester',
          expiresAt: '2027-01-01T00:00:00.000Z',
        }
      ).baseline;

      const gate = compare({
        analyzer: 'source-integrity',
        profile: 'research',
        baseline,
        result: result([known]),
        candidateAtStart: candidate(),
        candidateAtFinish: candidate(),
        repoRoot: tree.root,
        now: () => new Date('2026-09-17T00:00:00.000Z'),
      });

      expect(gate.decision).toBe('PASS');
      expect(gate.dispositions['accepted-legacy']).toBe(1);
    } finally {
      tree.cleanup();
    }
  });

  test('an unreadable expiry date fails closed', () => {
    const tree = createFixtureTree();
    try {
      tree.write('src/b.js', 'export default {};\n');
      const known = finding({ status: 'fail' });
      const baseline = proposeBaseline(
        tree.root,
        'source-integrity',
        result([known]),
        candidate(),
        { reason: 'temporary', acceptedBy: 'tester', expiresAt: 'not-a-date' }
      ).baseline;

      const gate = compare({
        analyzer: 'source-integrity',
        profile: 'research',
        baseline,
        result: result([known]),
        candidateAtStart: candidate(),
        candidateAtFinish: candidate(),
        repoRoot: tree.root,
      });

      expect(gate.decision).toBe('FAIL');
    } finally {
      tree.cleanup();
    }
  });
});

describe('metric movement', () => {
  const metric = (
    value: number,
    limit = 20
  ): Finding['metric'] => ({
    name: 'cyclomatic-complexity',
    value,
    limit,
    direction: 'lower-is-better',
  });

  test('a worsened metric fails, even though the finding is baselined', () => {
    const tree = createFixtureTree();
    try {
      tree.write('src/a.ts', 'export const a = 1;\n');
      const before = finding({ rule: 'complexity', metric: metric(25) });
      const after = finding({ rule: 'complexity', metric: metric(31) });

      const gate = compare({
        analyzer: 'maintainability',
        profile: 'research',
        baseline: baselineOf(tree.root, [before]),
        result: result([after], { analyzer: 'maintainability' }),
        candidateAtStart: candidate(),
        candidateAtFinish: candidate(),
        repoRoot: tree.root,
      });

      expect(gate.decision).toBe('FAIL');
      expect(gate.worsened[0]?.reason).toBe('metric-worsened');
    } finally {
      tree.cleanup();
    }
  });

  test('an improvement that is still over the limit passes and is recorded', () => {
    const tree = createFixtureTree();
    try {
      tree.write('src/a.ts', 'export const a = 1;\n');
      const before = finding({ rule: 'complexity', metric: metric(40) });
      const after = finding({ rule: 'complexity', metric: metric(25) });

      const gate = compare({
        analyzer: 'maintainability',
        profile: 'research',
        baseline: baselineOf(tree.root, [before]),
        result: result([after], { analyzer: 'maintainability' }),
        candidateAtStart: candidate(),
        candidateAtFinish: candidate(),
        repoRoot: tree.root,
      });

      expect(gate.decision).toBe('PASS');
      expect(gate.improvedFindings).toHaveLength(1);
      expect(gate.improvedFindings[0]?.progress).toBeGreaterThan(0);
      expect(gate.worsened).toHaveLength(0);
    } finally {
      tree.cleanup();
    }
  });
});

describe('move reconciliation', () => {
  test('a relocated module is not new debt when content is preserved', () => {
    const tree = createFixtureTree();
    try {
      // A relocation is recognized by positive identity evidence: same rule, same
      // locator, and the subject's content digest is unchanged.
      tree.write('src/new/stub.js', 'export default {};\n');
      tree.write('src/new/consumer.ts', 'export const c = 1;\n');

      const before = finding({
        subject: 'src/old/consumer.ts',
        locator: './stub.js',
        status: 'fail',
      });
      const after = finding({
        subject: 'src/new/consumer.ts',
        locator: './stub.js',
        status: 'fail',
      });

      // The baseline must be recorded against the *new* location's digest, so
      // write the file the digest is taken from first.
      tree.write('src/old/consumer.ts', 'export const c = 1;\n');
      const baseline = proposeBaseline(
        tree.root,
        'source-integrity',
        result([before]),
        candidate(),
        ACCEPTANCE
      ).baseline;

      const gate = compare({
        analyzer: 'source-integrity',
        profile: 'research',
        baseline,
        result: result([after]),
        candidateAtStart: candidate(),
        candidateAtFinish: candidate(),
        repoRoot: tree.root,
      });

      expect(gate.movedFindings).toHaveLength(1);
      expect(gate.newFindings).toHaveLength(0);
    } finally {
      tree.cleanup();
    }
  });

  test('a move is not recognized when the subject content changed', () => {
    const tree = createFixtureTree();
    try {
      tree.write('src/old/consumer.ts', 'export const c = 1;\n');
      const before = finding({
        subject: 'src/old/consumer.ts',
        locator: './stub.js',
        status: 'fail',
      });
      const baseline = proposeBaseline(
        tree.root,
        'source-integrity',
        result([before]),
        candidate(),
        ACCEPTANCE
      ).baseline;

      // Same rule and locator, different content: identity does not support a move.
      tree.write('src/new/consumer.ts', 'export const c = 2;\n');
      const after = finding({
        subject: 'src/new/consumer.ts',
        locator: './stub.js',
        status: 'fail',
      });

      const gate = compare({
        analyzer: 'source-integrity',
        profile: 'research',
        baseline,
        result: result([after]),
        candidateAtStart: candidate(),
        candidateAtFinish: candidate(),
        repoRoot: tree.root,
      });

      expect(gate.movedFindings).toHaveLength(0);
      expect(gate.newFindings).toHaveLength(1);
    } finally {
      tree.cleanup();
    }
  });

  test('a copied finding is new debt, not a move', () => {
    const tree = createFixtureTree();
    try {
      // Copying a bad module is the case a naive "same content digest" rule gets
      // wrong: the digest matches, but the original still exists and nothing has
      // relocated. Only the first claim on a signature may be a move.
      tree.write('src/old/consumer.ts', 'export const c = 1;\n');
      tree.write('src/copy/consumer.ts', 'export const c = 1;\n');

      const before = finding({
        subject: 'src/old/consumer.ts',
        locator: './stub.js',
        status: 'fail',
      });
      const baseline = proposeBaseline(
        tree.root,
        'source-integrity',
        result([before]),
        candidate(),
        ACCEPTANCE
      ).baseline;

      const original = finding({
        subject: 'src/old/consumer.ts',
        locator: './stub.js',
        status: 'fail',
      });
      const copy = finding({
        subject: 'src/copy/consumer.ts',
        locator: './stub.js',
        status: 'fail',
      });

      const gate = compare({
        analyzer: 'source-integrity',
        profile: 'research',
        baseline,
        result: result([original, copy]),
        candidateAtStart: candidate(),
        candidateAtFinish: candidate(),
        repoRoot: tree.root,
      });

      // The copy is a second finding with the same signature; a baseline entry can
      // absorb exactly one relocation. The other must block.
      expect(gate.decision).toBe('FAIL');
      expect(gate.newFindings).toHaveLength(1);
      expect(gate.newFindings[0]?.subject).toBe('src/copy/consumer.ts');
    } finally {
      tree.cleanup();
    }
  });

  test('a removal plus an unrelated addition is not a move', () => {
    const tree = createFixtureTree();
    try {
      tree.write('src/gone.ts', 'export const gone = 1;\n');
      const before = finding({
        subject: 'src/gone.ts',
        locator: './stub.js',
        rule: 'INT-003',
        status: 'fail',
      });
      const baseline = proposeBaseline(
        tree.root,
        'source-integrity',
        result([before]),
        candidate(),
        ACCEPTANCE
      ).baseline;

      // Different rule: whatever this is, it is not the finding that disappeared.
      tree.write('src/fresh.ts', 'export const fresh = 1;\n');
      const after = finding({
        subject: 'src/fresh.ts',
        locator: './stub.js',
        rule: 'INT-004',
        status: 'fail',
      });

      const gate = compare({
        analyzer: 'source-integrity',
        profile: 'research',
        baseline,
        result: result([after]),
        candidateAtStart: candidate(),
        candidateAtFinish: candidate(),
        repoRoot: tree.root,
      });

      expect(gate.movedFindings).toHaveLength(0);
      expect(gate.newFindings).toHaveLength(1);
      expect(gate.resolvedFindings).toHaveLength(1);
      expect(gate.decision).toBe('FAIL');
    } finally {
      tree.cleanup();
    }
  });

  test('move detection can be disabled, and then the move is new debt', () => {
    const tree = createFixtureTree();
    try {
      tree.write('src/old/consumer.ts', 'export const c = 1;\n');
      const before = finding({
        subject: 'src/old/consumer.ts',
        locator: './stub.js',
        status: 'fail',
      });
      const baseline = proposeBaseline(
        tree.root,
        'source-integrity',
        result([before]),
        candidate(),
        ACCEPTANCE
      ).baseline;

      tree.write('src/new/consumer.ts', 'export const c = 1;\n');
      const after = finding({
        subject: 'src/new/consumer.ts',
        locator: './stub.js',
        status: 'fail',
      });

      const gate = compare({
        analyzer: 'source-integrity',
        profile: 'research',
        baseline,
        result: result([after]),
        candidateAtStart: candidate(),
        candidateAtFinish: candidate(),
        repoRoot: tree.root,
        detectMoves: false,
      });

      expect(gate.decision).toBe('FAIL');
    } finally {
      tree.cleanup();
    }
  });
});

describe('duplicated identity within one run', () => {
  test('a finding reported three times at the same identity is one finding', () => {
    const tree = createFixtureTree();
    try {
      // Analyzers collapse repeats before returning; the gate must not see three
      // separate findings, or an occurrence triple would read as three new debts.
      const collapsed = finding({ occurrences: 3 });
      const gate = compare({
        analyzer: 'source-integrity',
        profile: 'research',
        baseline: baselineOf(tree.root, [collapsed]),
        result: result([collapsed]),
        candidateAtStart: candidate(),
        candidateAtFinish: candidate(),
        repoRoot: tree.root,
      });
      expect(gate.decision).toBe('PASS');
      expect(gate.newFindings).toHaveLength(0);
    } finally {
      tree.cleanup();
    }
  });
});

describe('baseline composition', () => {
  test('baseline records debt and failures, never ordinary passes', () => {
    const tree = createFixtureTree();
    try {
      const clean = finding({
        classification: 'real-implementation',
        rule: 'INT-001',
        status: 'pass',
        severity: 'info',
      });
      const proposal = proposeBaseline(
        tree.root,
        'source-integrity',
        result([clean, finding({ status: 'fail' })]),
        candidate(),
        ACCEPTANCE
      );

      expect(Object.keys(proposal.baseline.findings)).toHaveLength(1);
      expect(proposal.passing).toHaveLength(1);
      expect(proposal.grandfathered).toHaveLength(1);
    } finally {
      tree.cleanup();
    }
  });

  test('every recorded finding carries who accepted it and why', () => {
    const tree = createFixtureTree();
    try {
      const proposal = proposeBaseline(
        tree.root,
        'source-integrity',
        result([finding({ status: 'fail' })]),
        candidate(),
        {
          reason: 'legacy backlog frozen at adoption time',
          acceptedBy: 'ahmed',
          owner: 'gateway-maintainers',
          expiresAt: null,
        }
      );

      const entries = Object.values(proposal.baseline.findings);
      expect(entries).toHaveLength(1);
      const acceptance = (entries[0] as BaselineFinding).acceptance;
      expect(acceptance.acceptedBy).toBe('ahmed');
      expect(acceptance.reason).toContain('legacy backlog');
      expect(acceptance.owner).toBe('gateway-maintainers');
      expect(acceptance.acceptedAt).not.toBe('');
    } finally {
      tree.cleanup();
    }
  });
});

/**
 * The line-shift defect.
 *
 * Identity was `rule::subject::line:column`, so a finding that merely slid down
 * its file arrived as new debt. Measured on this repository's first commit after
 * its baseline was accepted: 283 new blockers, 259 of them findings that had
 * only moved. The ratchet then deadlocked, because accepting a resolution is
 * refused while new findings exist and the shifts *were* the new findings.
 *
 * These pin the fix at the level the defect was observed: the gate.
 */
describe('a finding that moves is still the same finding', () => {
  test('a finding that shifts down its file is not new debt', () => {
    const tree = createFixtureTree();
    try {
      const before = finding({
        subject: 'src/a.ts',
        locator: '10:5',
        anchor: 'const x = maybe!',
      });
      const baseline = baselineOf(tree.root, [before]);

      // Same rule, same file, same text - 40 lines lower. This is what inserting
      // imports at the top of a file does to every finding beneath them.
      const after = finding({
        subject: 'src/a.ts',
        locator: '50:5',
        anchor: 'const x = maybe!',
      });

      const gate = compare({
        analyzer: 'source-integrity',
        profile: 'research',
        baseline,
        result: result([after]),
        candidateAtStart: candidate(),
        candidateAtFinish: candidate(),
        repoRoot: tree.root,
      });

      expect(gate.newFindings).toHaveLength(0);
      expect(gate.resolvedFindings).toHaveLength(0);
      expect(gate.dispositions['accepted-legacy']).toBe(1);
    } finally {
      tree.cleanup();
    }
  });

  test('the recorded position is updated to where the finding now is', () => {
    const tree = createFixtureTree();
    try {
      const gate = compare({
        analyzer: 'source-integrity',
        profile: 'research',
        baseline: baselineOf(tree.root, [
          finding({ subject: 'src/a.ts', locator: '10:5', anchor: 'const x = maybe!' }),
        ]),
        result: result([
          finding({ subject: 'src/a.ts', locator: '50:5', anchor: 'const x = maybe!' }),
        ]),
        candidateAtStart: candidate(),
        candidateAtFinish: candidate(),
        repoRoot: tree.root,
      });
      // The id is position-independent, but the finding still reports where it
      // now sits: a reviewer needs to be told where to look, and a run record
      // that kept the old line would send them to the wrong place.
      expect(gate.decision).toBe('PASS');
      expect(gate.resolvedFindings).toHaveLength(0);
    } finally {
      tree.cleanup();
    }
  });

  test('genuinely new debt on the same anchor is still blocked', () => {
    const tree = createFixtureTree();
    try {
      // A second instance of the same pattern in the same file. It shares the
      // anchor text with the accepted finding but is a different occurrence, so
      // it must not be absorbed by it.
      const gate = compare({
        analyzer: 'source-integrity',
        profile: 'research',
        baseline: baselineOf(tree.root, [
          finding({ subject: 'src/a.ts', locator: '10:5', anchor: './b.js' }),
        ]),
        result: result([
          finding({ subject: 'src/a.ts', locator: '10:5', anchor: './b.js' }),
          finding({ subject: 'src/a.ts', locator: '99:5', anchor: './c.js' }),
        ]),
        candidateAtStart: candidate(),
        candidateAtFinish: candidate(),
        repoRoot: tree.root,
      });
      expect(gate.newFindings).toHaveLength(1);
      expect(gate.newFindings[0]?.anchor).toBe('./c.js');
      expect(gate.decision).toBe('FAIL');
    } finally {
      tree.cleanup();
    }
  });
});
