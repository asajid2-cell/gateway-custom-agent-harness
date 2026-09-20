/**
 * Measurement-epoch migration fixtures.
 *
 * The failure this whole module exists to prevent, stated as the artefact:
 *
 *   measurement digest changed
 *   -> re-record whatever the new tool says
 *
 * An analyzer change that legitimately collapses 4,994 findings into 3,100 and
 * an analyzer bug that silently drops 1,894 produce the identical artefact - a
 * smaller baseline - and the second erases debt with nobody seeing which debt.
 * So the cases below are all about the migration report being *answerable*: it
 * must name what was added, removed and reshaped, and it must refuse to call a
 * comparison reviewable when the two sides are not the same quantity.
 */
import { describe, expect, test } from 'bun:test';
import {
  measureMigration,
  migrationIsReviewable,
  renderMigration,
} from '../lib/migration';
import { proposeBaseline } from '../lib/baseline';
import { createFixtureTree } from './tree';
import type {
  AnalyzerResult,
  Baseline,
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
    ...(overrides.reviewRequired !== undefined
      ? { reviewRequired: overrides.reviewRequired }
      : {}),
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
  return {
    analyzer: 'source-integrity',
    findings,
    errors: [],
    coverage: overrides.coverage ?? coverage(),
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

/** A baseline as the *old* measurement system recorded it. */
function oldBaseline(
  repoRoot: string,
  findings: Finding[],
  opts: {
    measurementDigest?: string;
    eligible?: number | null;
    /** Write the baseline as one predating epoch tracking: no field at all. */
    stripEpoch?: boolean;
    /** Write the baseline as one predating instrument tracking. */
    stripInstrument?: boolean;
  } = {}
): Baseline {
  const proposal = proposeBaseline(
    repoRoot,
    'source-integrity',
    result(findings, { coverage: coverage({ eligible: opts.eligible ?? 10 }) }),
    candidate({ measurementDigest: opts.measurementDigest ?? 'measurement-1' }),
    ACCEPTANCE
  ).baseline;

  if (opts.stripInstrument === true) {
    delete (proposal as { toolchainDigest?: string }).toolchainDigest;
  }

  if (opts.stripEpoch === true) {
    // The shape every baseline written before the field existed actually has.
    // Deleting rather than blanking it is the point - a fabricated digest would
    // compare equal and the migration would skip.
    delete (proposal as { measurementDigest?: string }).measurementDigest;
  }
  return proposal;
}

describe('migration refuses to be a blank cheque', () => {
  test('an epoch-less baseline is unknown-epoch, not comparable', () => {
    const tree = createFixtureTree();
    try {
      const migration = measureMigration({
        analyzer: 'source-integrity',
        baseline: oldBaseline(tree.root, [finding()], { stripEpoch: true }),
        result: result([finding()]),
        candidate: candidate({ measurementDigest: 'measurement-2' }),
      });

      expect(migration.verdict).toBe('unknown-epoch');
      expect(migration.unknownEpoch).toBe(true);
      expect(migration.from.measurementDigest).toBeNull();
      expect(migrationIsReviewable(migration)).toBe(false);
      expect(renderMigration(migration)).toContain('predates epoch tracking');
    } finally {
      tree.cleanup();
    }
  });

  test('a scope change makes every count incomparable, and is reported first', () => {
    const tree = createFixtureTree();
    try {
      const migration = measureMigration({
        analyzer: 'source-integrity',
        baseline: oldBaseline(tree.root, [finding()], { eligible: 10 }),
        result: result([finding()], { coverage: coverage({ eligible: 12, scanned: 12 }) }),
        candidate: candidate({ measurementDigest: 'measurement-2' }),
      });

      expect(migration.scopeChanged).toBe(true);
      expect(migration.verdict).toBe('scope-moved');
      expect(migrationIsReviewable(migration)).toBe(false);
    } finally {
      tree.cleanup();
    }
  });

  test('an unknown epoch outranks a moved scope, because nothing can be compared', () => {
    const tree = createFixtureTree();
    try {
      const migration = measureMigration({
        analyzer: 'source-integrity',
        baseline: oldBaseline(tree.root, [finding()], { stripEpoch: true }),
        result: result([finding()], { coverage: coverage({ eligible: 12, scanned: 12 }) }),
        candidate: candidate({ measurementDigest: 'measurement-2' }),
      });

      expect(migration.verdict).toBe('unknown-epoch');
      expect(migration.scopeChanged).toBe(true);
    } finally {
      tree.cleanup();
    }
  });

  test('a baseline with no recorded eligible cannot claim a scope change', () => {
    const tree = createFixtureTree();
    try {
      // Deliberately coarse: a count that moved is a certain signal, a count that
      // held is not proof. Claiming more would be false confidence.
      const baseline = oldBaseline(tree.root, [finding()]);
      (baseline as { recordedEligible?: number | null }).recordedEligible = null;

      const migration = measureMigration({
        analyzer: 'source-integrity',
        baseline,
        result: result([finding()], { coverage: coverage({ eligible: 12, scanned: 12 }) }),
        candidate: candidate({ measurementDigest: 'measurement-2' }),
      });

      expect(migration.scopeChanged).toBe(false);
      expect(migration.verdict).toBe('comparable');
    } finally {
      tree.cleanup();
    }
  });

  test('same scope under a new measurement is comparable', () => {
    const tree = createFixtureTree();
    try {
      const migration = measureMigration({
        analyzer: 'source-integrity',
        baseline: oldBaseline(tree.root, [finding()]),
        result: result([finding()]),
        candidate: candidate({ measurementDigest: 'measurement-2' }),
      });

      expect(migration.verdict).toBe('comparable');
      expect(migrationIsReviewable(migration)).toBe(true);
    } finally {
      tree.cleanup();
    }
  });

  test('a changed instrument is not a measurement change, and is named as its own state', () => {
    // The failure this pins: the pinned external resolver lives in its own
    // project (`.quality/tools`) with its own lockfile, so a moved tool pin
    // changes `toolchainDigest` and NOTHING else - not `measurementDigest`,
    // which walks only `scripts/quality`, and not `policyDigest`. A newer
    // resolver can add or drop findings on a byte-identical tree. Without a
    // verdict for this, the report would print "comparable" and a reviewer would
    // read a changed instrument as a changed codebase.
    const tree = createFixtureTree();
    try {
      const migration = measureMigration({
        analyzer: 'source-integrity',
        baseline: oldBaseline(tree.root, [finding()]),
        result: result([finding()]),
        candidate: candidate({
          measurementDigest: 'measurement-1',
          toolchainDigest: 'toolchain-2',
        }),
      });

      expect(migration.instrumentChanged).toBe(true);
      expect(migration.scopeChanged).toBe(false);
      expect(migration.unknownEpoch).toBe(false);
      expect(migration.verdict).toBe('instrument-changed');
      expect(migrationIsReviewable(migration)).toBe(false);
      expect(renderMigration(migration)).toContain('CHANGED');
    } finally {
      tree.cleanup();
    }
  });

  test('a baseline predating instrument tracking cannot claim the instrument changed', () => {
    // "We never recorded it" and "it is different" are different facts, and only
    // the second is a reason to refuse the comparison.
    const tree = createFixtureTree();
    try {
      const migration = measureMigration({
        analyzer: 'source-integrity',
        baseline: oldBaseline(tree.root, [finding()], { stripInstrument: true }),
        result: result([finding()]),
        candidate: candidate({ toolchainDigest: 'toolchain-2' }),
      });

      expect(migration.from.toolchainDigest).toBeNull();
      expect(migration.instrumentChanged).toBe(false);
      expect(migration.verdict).toBe('comparable');
      expect(renderMigration(migration)).toContain('predates instrument tracking');
    } finally {
      tree.cleanup();
    }
  });

  test('a moved scope outranks a changed instrument', () => {
    // Both are real, but they demand different next actions: re-scope versus
    // re-record. The scope is reported because it makes every count
    // incomparable before the instrument question is even meaningful.
    const tree = createFixtureTree();
    try {
      const migration = measureMigration({
        analyzer: 'source-integrity',
        baseline: oldBaseline(tree.root, [finding()], { eligible: 10 }),
        result: result([finding()], { coverage: coverage({ eligible: 12, scanned: 12 }) }),
        candidate: candidate({ toolchainDigest: 'toolchain-2' }),
      });

      expect(migration.instrumentChanged).toBe(true);
      expect(migration.scopeChanged).toBe(true);
      expect(migration.verdict).toBe('scope-moved');
    } finally {
      tree.cleanup();
    }
  });
});

describe('the migration report names what changed', () => {
  test('findings present only in the new measurement are added', () => {
    const tree = createFixtureTree();
    try {
      const kept = finding();
      const fresh = finding({ subject: 'src/c.ts', locator: './d.js' });

      const migration = measureMigration({
        analyzer: 'source-integrity',
        baseline: oldBaseline(tree.root, [kept]),
        result: result([kept, fresh]),
        candidate: candidate({ measurementDigest: 'measurement-2' }),
      });

      expect(migration.added.map((entry) => entry.subject)).toEqual(['src/c.ts']);
      expect(migration.removed).toHaveLength(0);
      expect(migration.stableCount).toBe(1);
    } finally {
      tree.cleanup();
    }
  });

  test('recorded findings the new measurement no longer reports are removed', () => {
    const tree = createFixtureTree();
    try {
      const kept = finding();
      const gone = finding({ subject: 'src/gone.ts', locator: './e.js' });

      const migration = measureMigration({
        analyzer: 'source-integrity',
        baseline: oldBaseline(tree.root, [kept, gone]),
        result: result([kept]),
        candidate: candidate({ measurementDigest: 'measurement-2' }),
      });

      // A large `removed` list is the shape of an analyzer bug, and it is the
      // whole reason this report exists: it is the only artefact that makes
      // "the ruler got stricter" distinguishable from "debt was dropped".
      expect(migration.removed.map((entry) => entry.subject)).toEqual(['src/gone.ts']);
      expect(migration.added).toHaveLength(0);
      expect(renderMigration(migration)).toContain('removed : 1');
    } finally {
      tree.cleanup();
    }
  });

  test('an unchanged identity whose analyzer words changed is a change, not a stable entry', () => {
    const tree = createFixtureTree();
    try {
      // A re-worded rule keeps its identity, so nothing else is inspected and the
      // entry silently comes to mean something new. This is the case the `detail`
      // comparison exists for.
      const before = finding({ detail: 'declared stub' });
      const after = finding({ detail: 'definition for rule not found' });

      const migration = measureMigration({
        analyzer: 'source-integrity',
        baseline: oldBaseline(tree.root, [before]),
        result: result([after]),
        candidate: candidate({ measurementDigest: 'measurement-2' }),
      });

      expect(migration.changed).toEqual([
        {
          id: before.id,
          field: 'detail',
          before: 'declared stub',
          after: 'definition for rule not found',
        },
      ]);
      expect(migration.stableCount).toBe(0);
    } finally {
      tree.cleanup();
    }
  });

  test('occurrences, metric and severity movement are each named', () => {
    const tree = createFixtureTree();
    try {
      const before = finding({
        occurrences: 1,
        severity: 'warning',
        metric: { name: 'cyclomatic-complexity', value: 21, limit: 20, direction: 'lower-is-better' },
      });
      const after = finding({
        occurrences: 3,
        severity: 'error',
        metric: { name: 'cyclomatic-complexity', value: 25, limit: 20, direction: 'lower-is-better' },
      });

      const migration = measureMigration({
        analyzer: 'source-integrity',
        baseline: oldBaseline(tree.root, [before]),
        result: result([after]),
        candidate: candidate({ measurementDigest: 'measurement-2' }),
      });

      const fields = migration.changed.map((entry) => entry.field).sort();
      expect(fields).toEqual(['metric', 'occurrences', 'severity']);
      expect(migration.stableCount).toBe(0);
    } finally {
      tree.cleanup();
    }
  });

  test('a metric appearing or disappearing reads as none rather than as zero', () => {
    const tree = createFixtureTree();
    try {
      const withMetric = finding({
        metric: { name: 'cyclomatic-complexity', value: 21, limit: 20, direction: 'lower-is-better' },
      });
      const withoutMetric = finding();

      const migration = measureMigration({
        analyzer: 'source-integrity',
        baseline: oldBaseline(tree.root, [withMetric]),
        result: result([withoutMetric]),
        candidate: candidate({ measurementDigest: 'measurement-2' }),
      });

      // `0` and "the rule stopped measuring this" are different observations, and
      // rendering the second as the first would read as a metric that collapsed.
      expect(migration.changed).toEqual([
        { id: withMetric.id, field: 'metric', before: 21, after: 'none' },
      ]);
    } finally {
      tree.cleanup();
    }
  });
});

describe('the migration compares like with like', () => {
  test('ordinary passes are not reported as added', () => {
    const tree = createFixtureTree();
    try {
      // The regression this pins: the baseline records only tolerated and failing
      // findings, so comparing it against the RAW finding set reports every
      // ordinary pass as newly added. On this repository that produced
      // "added: 14531" against a 221-entry baseline - a report describing a
      // different quantity than the file it was being compared to.
      const tolerated = finding();
      const passes: Finding[] = [];
      for (let i = 0; i < 500; i += 1) {
        passes.push(
          finding({
            classification: 'real-implementation',
            rule: 'INT-001',
            subject: `src/pass-${i}.ts`,
            locator: `./impl-${i}.js`,
            status: 'pass',
            severity: 'info',
            debt: false,
          })
        );
      }

      const migration = measureMigration({
        analyzer: 'source-integrity',
        baseline: oldBaseline(tree.root, [tolerated]),
        result: result([tolerated, ...passes]),
        candidate: candidate({ measurementDigest: 'measurement-2' }),
      });

      expect(migration.added).toHaveLength(0);
      expect(migration.stableCount).toBe(1);
      expect(migration.to.measuredFindings).toBe(1);
      expect(migration.from.recordedFindings).toBe(1);
    } finally {
      tree.cleanup();
    }
  });

  test('tolerated debt is measured, so a new stub use shows up as added', () => {
    const tree = createFixtureTree();
    try {
      const knownDebt = finding({
        classification: 'declared-legacy-stub',
        rule: 'INT-002',
        status: 'pass',
        severity: 'warning',
        debt: true,
      });
      const newUse = finding({
        classification: 'declared-legacy-stub',
        rule: 'INT-002',
        status: 'pass',
        severity: 'warning',
        debt: true,
        subject: 'src/elsewhere.ts',
      });

      const migration = measureMigration({
        analyzer: 'source-integrity',
        baseline: oldBaseline(tree.root, [knownDebt]),
        result: result([knownDebt, newUse]),
        candidate: candidate({ measurementDigest: 'measurement-2' }),
      });

      expect(migration.added.map((entry) => entry.subject)).toEqual(['src/elsewhere.ts']);
    } finally {
      tree.cleanup();
    }
  });

  test('review-required findings are never counted on either side', () => {
    const tree = createFixtureTree();
    try {
      // They describe the working tree rather than the candidate and are never
      // recorded, so counting them as "added" would report a transient fact as
      // new debt in a report whose entire purpose is to be trustworthy.
      const uncommitted = finding({ subject: 'src/inflight.ts', reviewRequired: true });

      const migration = measureMigration({
        analyzer: 'source-integrity',
        baseline: oldBaseline(tree.root, [finding()]),
        result: result([finding(), uncommitted]),
        candidate: candidate({ measurementDigest: 'measurement-2' }),
      });

      expect(migration.added).toHaveLength(0);
      expect(migration.to.measuredFindings).toBe(1);
    } finally {
      tree.cleanup();
    }
  });
});

describe('the rendered report leads with direction', () => {
  test('the summary states added and removed separately, never netted', () => {
    const tree = createFixtureTree();
    try {
      // "removed 1,894" is the shape of a bug and "added 1,894" is the shape of a
      // stricter ruler; a reviewer's next action differs completely, so a single
      // net figure would destroy the only information that matters.
      const migration = measureMigration({
        analyzer: 'source-integrity',
        baseline: oldBaseline(tree.root, [
          finding({ subject: 'src/one.ts', locator: './a.js' }),
          finding({ subject: 'src/two.ts', locator: './b.js' }),
        ]),
        result: result([finding({ subject: 'src/one.ts', locator: './a.js' })]),
        candidate: candidate({ measurementDigest: 'measurement-2' }),
      });

      const text = renderMigration(migration);
      expect(text).toContain('added   : 0');
      expect(text).toContain('removed : 1');
      expect(text).toContain('stable  : 1');
      expect(text).toContain('measurement migration: source-integrity');
    } finally {
      tree.cleanup();
    }
  });

  test('long added and removed lists are truncated rather than dumped', () => {
    const tree = createFixtureTree();
    try {
      const entries: Finding[] = [];
      for (let i = 0; i < 20; i += 1) {
        entries.push(finding({ subject: `src/gone-${i}.ts`, locator: `./g${i}.js` }));
      }

      const migration = measureMigration({
        analyzer: 'source-integrity',
        baseline: oldBaseline(tree.root, entries),
        result: result([]),
        candidate: candidate({ measurementDigest: 'measurement-2' }),
      });

      const text = renderMigration(migration);
      expect(text).toContain('removed : 20');
      expect(text).toContain('... and 5 more');
    } finally {
      tree.cleanup();
    }
  });
});
