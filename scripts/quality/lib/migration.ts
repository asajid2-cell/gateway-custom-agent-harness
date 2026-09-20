import type {
  AnalyzerResult,
  Baseline,
  BaselineFinding,
  CandidateIdentity,
  Finding,
  MeasurementMigration,
} from './types';

/**
 * Compare two measurements of the SAME tree under DIFFERENT observation systems.
 *
 * Why this exists, stated as the failure it prevents:
 *
 *   measurement digest changed
 *   -> re-record whatever the new tool says
 *
 * That is not a review. An analyzer change that legitimately collapses 4,994
 * findings into 3,100 and an analyzer bug that silently drops 1,894 produce the
 * identical artefact - a smaller baseline - and the second one erases debt with
 * nobody seeing which debt. The remedy is not to forbid re-recording (the
 * measurement system must be allowed to improve) but to make the re-record
 * answerable: name what was added, what was removed, what changed shape, and
 * whether the scope moved underneath the comparison.
 *
 * This function never writes anything. Like `compare`, it produces a report for
 * a human or a trusted CI job to act on.
 */
export interface MigrationOptions {
  analyzer: string;
  baseline: Baseline;
  result: AnalyzerResult;
  candidate: CandidateIdentity;
}

export function measureMigration(opts: MigrationOptions): MeasurementMigration {
  const { baseline, result } = opts;
  const recordedEpoch = baseline.measurementDigest ?? null;
  const unknownEpoch = recordedEpoch === null;

  // Compare like with like. A baseline records only tolerated and failing
  // findings - ordinary passes are deliberately excluded, because recording tens
  // of thousands of them would turn a file move into thousands of "new findings".
  // Comparing a baseline against the RAW finding set therefore reports every
  // ordinary pass as newly added, which is not a migration observation at all.
  // The same filter `proposeBaseline` applies has to be applied here, or the
  // report describes a different quantity than the file it is being compared to.
  const recordable = result.findings.filter(
    (finding) => finding.reviewRequired !== true && (finding.debt || finding.status === 'fail')
  );

  const current: Record<string, Finding> = {};
  for (const finding of recordable) current[finding.id] = finding;

  const added: Finding[] = [];
  const removed: BaselineFinding[] = [];
  const changed: MeasurementMigration['changed'] = [];
  let stableCount = 0;

  for (const [id, finding] of Object.entries(current)) {
    const previous = baseline.findings[id];
    if (previous === undefined) {
      added.push(finding);
      continue;
    }
    let differed = false;
    if (previous.occurrences !== finding.occurrences) {
      changed.push({
        id,
        field: 'occurrences',
        before: previous.occurrences,
        after: finding.occurrences,
      });
      differed = true;
    }
    const beforeMetric = previous.metric?.value ?? null;
    const afterMetric = finding.metric?.value ?? null;
    if (beforeMetric !== afterMetric) {
      changed.push({
        id,
        field: 'metric',
        before: beforeMetric ?? 'none',
        after: afterMetric ?? 'none',
      });
      differed = true;
    }
    if (previous.severity !== finding.severity) {
      changed.push({
        id,
        field: 'severity',
        before: previous.severity,
        after: finding.severity,
      });
      differed = true;
    }
    // The analyzer's own words are compared because a changed detail with an
    // unchanged identity is exactly how a re-worded rule slips through: the
    // identity matches, so nothing else is inspected, and the entry silently
    // comes to mean something new.
    if ((previous.detail ?? '') !== finding.detail) {
      changed.push({
        id,
        field: 'detail',
        before: previous.detail ?? '',
        after: finding.detail,
      });
      differed = true;
    }
    if (!differed) stableCount += 1;
  }

  for (const [id, entry] of Object.entries(baseline.findings)) {
    if (current[id] === undefined) removed.push(entry);
  }

  const scopeChanged = scopeMoved(baseline, result);
  // A baseline that predates the field cannot be compared on it. Reported as
  // unchanged rather than as changed, because "we never recorded it" and "it is
  // different" are different facts and only the second is a reason to re-record.
  const instrumentChanged =
    baseline.toolchainDigest !== undefined &&
    baseline.toolchainDigest !== opts.candidate.toolchainDigest;

  return {
    analyzer: opts.analyzer,
    from: {
      measurementDigest: recordedEpoch,
      toolchainDigest: baseline.toolchainDigest ?? null,
      policyDigest: baseline.policyDigest,
      recordedAt: baseline.createdAt,
      recordedFindings: Object.keys(baseline.findings).length,
      recordedEligible: baseline.recordedEligible ?? null,
    },
    to: {
      measurementDigest: opts.candidate.measurementDigest,
      toolchainDigest: opts.candidate.toolchainDigest,
      policyDigest: opts.candidate.policyDigest,
      // The same filtered quantity the baseline records, not the raw finding
      // count. Reporting `result.findings.length` here would put ~14,500
      // ordinary passes on the "measured" side of a comparison whose other side
      // holds 221 tolerated entries, and the headline number would describe a
      // different quantity than every line beneath it.
      measuredFindings: recordable.length,
      measuredEligible: result.coverage.eligible,
    },
    added,
    removed,
    changed,
    stableCount,
    scopeChanged,
    unknownEpoch,
    instrumentChanged,
    verdict: verdictOf({ unknownEpoch, scopeChanged, instrumentChanged }),
  };
}

/**
 * Ordered by what a reviewer must do about it. An unknown epoch cannot be
 * compared at all; a moved scope makes every count incomparable; a changed
 * instrument means the numbers came from a different program; only then is the
 * comparison itself worth reading.
 *
 * Written as an if-chain rather than a nested conditional so that the precedence
 * is readable as the precedence. As a ternary the order lived in the shape of
 * the expression, which is also why adding one more state turned it into a
 * nesting-depth finding rather than a one-line edit.
 */
function verdictOf(state: {
  unknownEpoch: boolean;
  scopeChanged: boolean;
  instrumentChanged: boolean;
}): MeasurementMigration['verdict'] {
  if (state.unknownEpoch) return 'unknown-epoch';
  if (state.scopeChanged) return 'scope-moved';
  if (state.instrumentChanged) return 'instrument-changed';
  return 'comparable';
}

/**
 * Whether the two sides looked at the same amount of the repository.
 *
 * Deliberately coarse - it compares `eligible` rather than the file sets, which
 * the baseline does not record. A count that moves is a certain signal; a count
 * that holds is not proof, and claiming more than that would be the kind of
 * false confidence this engine exists to refuse.
 */
function scopeMoved(baseline: Baseline, result: AnalyzerResult): boolean {
  const recorded = baseline.recordedEligible;
  if (recorded === undefined || recorded === null) return false;
  return recorded !== result.coverage.eligible;
}

/**
 * A migration is reviewable when the observation changed but the tree and the
 * scope did not. Anything else is a different question wearing the same name.
 */
export function migrationIsReviewable(migration: MeasurementMigration): boolean {
  return migration.verdict === 'comparable';
}

/**
 * The one-line summary a reviewer reads first.
 *
 * States the direction of the change rather than the magnitude alone: "removed
 * 1,894" is the shape of a bug and "added 1,894" is the shape of a stricter
 * ruler, and a reviewer's next action differs completely between them.
 */
export function renderMigration(migration: MeasurementMigration): string {
  const lines: string[] = [];
  lines.push(`measurement migration: ${migration.analyzer}`);
  lines.push('');
  lines.push(`  verdict          : ${migration.verdict}`);
  lines.push(
    `  recorded under   : ${
      migration.from.measurementDigest === null
        ? 'unknown (baseline predates epoch tracking)'
        : migration.from.measurementDigest.slice(0, 12)
    }`
  );
  lines.push(
    `  measured under   : ${migration.to.measurementDigest.slice(0, 12)}`
  );
  // Named as its own line rather than folded into the two above, because a
  // changed instrument and a changed measurement call for different actions and
  // a reader who sees one digest line will assume both moved together.
  lines.push(
    `  instrument       : ${
      migration.from.toolchainDigest === null
        ? 'unknown (baseline predates instrument tracking)'
        : migration.from.toolchainDigest.slice(0, 12)
    } -> ${migration.to.toolchainDigest.slice(0, 12)}` +
      (migration.instrumentChanged ? '   CHANGED' : '')
  );
  lines.push(
    `  recorded findings: ${migration.from.recordedFindings} -> measured ${migration.to.measuredFindings}`
  );
  lines.push(
    `  scope            : eligible ${migration.from.recordedEligible ?? 'unknown'} -> ${migration.to.measuredEligible ?? 'unknown'}`
  );
  lines.push('');
  lines.push(`  added   : ${migration.added.length}`);
  for (const finding of migration.added.slice(0, 15)) {
    lines.push(`    + ${finding.rule} ${finding.subject} ${finding.locator}`);
  }
  if (migration.added.length > 15) {
    lines.push(`    ... and ${migration.added.length - 15} more`);
  }
  lines.push(`  removed : ${migration.removed.length}`);
  for (const entry of migration.removed.slice(0, 15)) {
    lines.push(`    - ${entry.rule} ${entry.subject} ${entry.locator}`);
  }
  if (migration.removed.length > 15) {
    lines.push(`    ... and ${migration.removed.length - 15} more`);
  }
  lines.push(`  changed : ${migration.changed.length}`);
  for (const entry of migration.changed.slice(0, 15)) {
    lines.push(
      `    ~ ${entry.id} (${entry.field}: ${String(entry.before)} -> ${String(entry.after)})`
    );
  }
  if (migration.changed.length > 15) {
    lines.push(`    ... and ${migration.changed.length - 15} more`);
  }
  lines.push(`  stable  : ${migration.stableCount}`);
  return lines.join('\n');
}
