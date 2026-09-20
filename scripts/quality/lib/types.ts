/**
 * Canonical model for the quality engine.
 *
 * Layering rule, and the reason this file exists at all:
 *
 *   analyzer  ->  describes what it observed   (Finding, Metric)
 *   engine    ->  decides what it means        (Disposition, GateResult)
 *   policy    ->  records what was tolerated   (Baseline, Acceptance)
 *
 * An analyzer must never decide whether something is acceptable, and the engine
 * must never know what an import or a cognitive-complexity score is. Every type
 * below belongs to exactly one of those three layers.
 */

export type Severity = 'info' | 'warning' | 'error';

export type FindingStatus = 'pass' | 'fail' | 'incomplete';

/**
 * Direction of a measured metric. `improved` is only meaningful relative to this.
 */
export type MetricDirection = 'lower-is-better' | 'higher-is-better';

export interface MetricValue {
  name: string;
  value: number;
  /** Threshold the metric is measured against, when the rule has one. */
  limit: number | null;
  direction: MetricDirection;
}

export interface Finding {
  /**
   * Stable identity. `subject` is always a full repo-relative path.
   *
   * Built from `anchor`, never from a position - see lib/anchor.ts for why a
   * line number cannot be an identity.
   */
  id: string;
  rule: string;
  /**
   * What the finding is *about*. For dependency rules this is the importer path;
   * for symbol rules it is the containing file. Always repo-relative.
   */
  subject: string;
  /**
   * Analyzer-specific locator within the subject. Empty string when the subject
   * alone identifies the finding. For imports this is the specifier; for lint
   * rules it is `rule@line:column`; for clones it is the clone family key.
   *
   * Informational only: it says where a human should look. It is deliberately
   * NOT part of `id`, because it moves whenever any line above it moves.
   */
  locator: string;
  /**
   * What the finding *is*, independent of where it currently sits.
   *
   * For a lint rule this is the normalized source text at the reported line, with
   * an ordinal suffix when one line carries several instances of the same rule.
   * For a dependency rule it is the specifier, which was never positional.
   */
  anchor: string;
  /** Filled from the analyzer's result metadata; see AnalyzerResult. */
  classification: string;
  status: FindingStatus;
  severity: Severity;
  detail: string;
  /** Occurrence count for this exact identity within one run. */
  occurrences: number;
  /**
   * Known-unverified rather than clean. Not a pass in the sense of "correct",
   * but not a failure either. Analyzer-level fact; the gate decides disposition.
   */
  debt: boolean;
  /**
   * The analyzer has determined this is *not* a statement about the code, so it
   * must not be frozen into a baseline.
   *
   * The motivating case: a dependency whose target is on disk but in no commit.
   * That is a fact about the working tree, not about the candidate, and it
   * resolves itself the moment someone commits. Recording it as accepted legacy
   * would permanently tolerate a defect that was only ever transient - and, worse,
   * would do so under the analyzer's own advice not to.
   *
   * A review-required finding blocks and is never recorded, which is the honest
   * position: the engine cannot certify a candidate whose dependencies are still
   * in flight.
   */
  reviewRequired?: boolean;
  /** Present when the rule measures something numeric. */
  metric?: MetricValue;
  /** Free-form, JSON-stable extras for evidence. */
  evidence: Record<string, string | number | boolean | null>;
}

/**
 * What the engine concluded about a finding, after consulting the baseline.
 * This is the terminology the CLI, reports and SARIF must use.
 */
export type Disposition =
  /** Fails, and nothing has accepted it. Blocks. */
  | 'active-blocker'
  /** Fails, but an accepted baseline entry freezes it. Visible, non-blocking. */
  | 'accepted-legacy'
  /** Fails, accepted until an expiry. Becomes a blocker when the expiry passes. */
  | 'temporary-waiver'
  /** Cannot be decided automatically; must not be reported as clean. */
  | 'review-required'
  /** The analyzer could not resolve this subject. Never reported as passing. */
  | 'unresolved';

export interface AnalyzerError {
  kind: 'scan-failure' | 'unreadable-file' | 'resolution-error' | 'tool-missing';
  subject: string;
  message: string;
}

/**
 * Coverage accounting. "Complete" must be arithmetic, not an assertion.
 *
 * The identity that must hold for a run to claim completeness is
 *
 *     eligible === scanned + skipped + failed
 *
 * with `eligible` never null, `eligible > 0`, and `failed === 0`. Anything less
 * than that is an assertion the analyzer cannot support, and the gate treats it
 * as INCOMPLETE. "Coverage complete" is therefore a sum, not a green label.
 *
 * What each field means, precisely:
 *  - `eligible`  : how many entities the analyzer was obliged to consider, per its
 *                  own definition of scope. `null` means "cannot self-count", and
 *                  a null eligible can never be complete. An analyzer that cannot
 *                  say how much it was supposed to cover has not covered it.
 *  - `scanned`   : entities it actually completed analysis on.
 *  - `skipped`   : entities deliberately not analyzed. Every one is named in
 *                  `skipReasons`, so "excluded" and "unsupported" are visible
 *                  rather than folded into a smaller `eligible`.
 *  - `failed`    : entities it tried and could not complete (unreadable file,
 *                  crash, fatal parse error). Non-zero always blocks completeness.
 *
 * `skipReasons` is where an analyzer must account for the specific ways scope can
 * leak, rather than leaving them implicit. For a source analyzer that means at
 * minimum: unsupported syntax, generated source, excluded paths, and runtime
 * roots that were not reachable. A reason string appearing here is a claim the
 * analyzer is making in public; an unreported exclusion is a silent hole.
 */
export interface Coverage {
  eligible: number | null;
  scanned: number;
  skipped: number;
  failed: number;
  /** Named reasons for anything not scanned. Sum should equal `skipped`. */
  skipReasons: Record<string, number>;
  /**
   * Named things deliberately set aside that are counted in a unit OTHER than
   * `eligible`'s, so they cannot go in `skipReasons`.
   *
   * The distinction matters for any analyzer whose scope is two-level. Source
   * integrity counts FILES in its arithmetic but excludes type-only SPECIFIERS
   * from its graph; adding a specifier count to `skipReasons` would break
   * `scanned + skipped + failed === eligible` and report a complete run as not
   * adding up. Omitting it entirely is worse - it is the silent hole this field
   * exists to close. Reported and rendered, but never folded into the arithmetic
   * it does not belong to.
   */
  exclusions?: Record<string, number>;
}

/** The arithmetic an analyzer must satisfy to claim completeness. */
export function coverageIsComplete(coverage: Coverage): boolean {
  if (coverage.eligible === null) return false;
  if (coverage.eligible === 0) return false;
  if (coverage.scanned === 0) return false;
  if (coverage.failed > 0) return false;
  return coverage.scanned + coverage.skipped + coverage.failed === coverage.eligible;
}

/**
 * How an analyzer execution ended, as distinct from what it found.
 *
 * The permanent engine rule this exists to enforce:
 *
 *   ANALYZER INTERNAL EXCEPTIONS MUST NEVER DEGRADE INTO "ZERO FINDINGS".
 *
 * The failure it prevents is specific and it has happened here. A traversal
 * threw; a `catch` around it returned `[]`; the run reported no findings; the
 * gate saw a smaller finding set than the baseline and reported the debt as
 * RESOLVED. Nothing in that sequence is a lie at any single step - the bug is
 * that "the walk failed" and "the walk found nothing" were the same value.
 *
 * So execution status is explicit and it is three-valued:
 *
 *  - `complete`   : the analyzer finished the work it set out to do. Findings
 *                   may be reported, and completeness is still checked
 *                   separately against the coverage arithmetic - this says the
 *                   run ended, not that it covered everything.
 *  - `incomplete` : the run ended early or deliberately covered less than its
 *                   declared scope. Findings are a lower bound, never a clean
 *                   bill of health. Never a PASS.
 *  - `failed`     : the run threw, or a component it depends on could not run.
 *                   Findings MUST be treated as absent rather than as an empty
 *                   result. Never a PASS, and never a resolution.
 *
 * The distinction between `failed` and "completed with zero findings" is the
 * whole point: an empty finding list is a claim about the code, and a failed run
 * has made no claim at all.
 */
export type ExecutionStatus = 'complete' | 'incomplete' | 'failed';

export interface AnalyzerResult {
  analyzer: string;
  findings: Finding[];
  errors: AnalyzerError[];
  coverage: Coverage;
  /**
   * How the execution ended. See `ExecutionStatus`.
   *
   * Required rather than optional: an analyzer that does not say how it ended
   * has not made its outcome inspectable, and the safe reading of a missing
   * status is not "complete".
   */
  status: ExecutionStatus;
  /**
   * True only when coverage can be vouched for arithmetically. An analyzer
   * asserts this, and the gate separately re-derives it from `coverage` so that a
   * wrong assertion cannot become a pass.
   *
   * Deliberately kept alongside `status` rather than replaced by it. `status`
   * answers "did the run end as intended"; `complete` answers "did it cover what
   * it claimed to". A run can end cleanly having skipped half its scope, and a
   * run can be failed while its coverage arithmetic happens to add up.
   */
  complete: boolean;
  notes: string[];
}

/**
 * The engine's guard for the rule above.
 *
 * Called wherever findings are about to be interpreted - never by the analyzer,
 * because an analyzer cannot be trusted to detect its own swallowed exception.
 * A `failed` execution yields no findings to reason about, and that is the only
 * honest reading: absence of evidence is not evidence of absence.
 */
export function findingsAreAuthoritative(result: AnalyzerResult): boolean {
  return result.status === 'complete';
}

export interface CandidateIdentity {
  head: string;
  headDirty: boolean;
  trackedChangesDigest: string;
  relevantUntrackedDigest: string;
  /**
   * What we ALLOW. Declared policy inputs: build exemptions, tsconfig, the
   * runtime-roots manifest, and any analyzer-declared policy file (a lint
   * config). A change here means the rules changed, so a baseline recorded
   * under the old rules is no longer a statement about the current ones.
   */
  policyDigest: string;
  /**
   * How we OBSERVE. The engine and analyzer implementation, hashed as a whole
   * tree.
   *
   * Kept separate from `policyDigest` because the two demand different
   * responses. A policy change asks "do we still tolerate this?"; a measurement
   * change asks "is the new observation even comparable to the old one?".
   * Collapsing them made every analyzer edit look like a policy edit, and the
   * only available answer was to re-record the baseline - which is how an
   * analyzer bug could erase a thousand pieces of debt without anyone seeing
   * the list. `lib/migration.ts` exists to make that list visible.
   */
  measurementDigest: string;
  /** What implementation versions EXECUTE the measurement. */
  toolchainDigest: string;
  computedAt: string;
  /**
   * Full digest of the candidate's source state. Two runs with equal identity
   * are measuring the same thing.
   */
  sourceDigest: string;
}

export interface RunRecord {
  schemaVersion: 1;
  runId: string;
  analyzer: string;
  profile: string;
  startedAt: string;
  finishedAt: string;
  candidate: CandidateIdentity;
  candidateAtFinish: CandidateIdentity;
  candidateStable: boolean;
  coverage: Coverage;
  complete: boolean;
  /**
   * How the execution ended. Recorded because a run record is read long after
   * the fact: a reviewer comparing two records needs to know whether an empty
   * finding list means "nothing was found" or "nothing was measured", and the
   * counts alone cannot say.
   */
  status: ExecutionStatus;
  counts: Record<string, number>;
  errors: AnalyzerError[];
  notes: string[];
}

/** Provenance for an accepted baseline entry. Every entry must be answerable. */
export interface Acceptance {
  /** Why this is tolerated. Not optional - an unexplained tolerance is a hole. */
  reason: string;
  /** Who accepted it. `unreviewed` is recorded honestly rather than omitted. */
  acceptedBy: string;
  acceptedAt: string;
  /** Ownership for routing and for staleness reports. */
  owner: string | null;
  /**
   * How `owner` was arrived at. `inherited` means it was derived from the
   * source-universe role of the finding's subject rather than typed in, so it
   * follows the file instead of drifting away from it.
   */
  ownerSource?: 'inherited' | 'explicit' | 'unattributable';
  /**
   * The source-universe role whose owner was inherited - the SCOPE of this
   * tolerance. A role reassignment moves this field, which is how a finding that
   * has quietly changed hands becomes visible without anyone re-reading 8,000
   * entries.
   */
  ownerRole?: string | null;
  /**
   * Why the owner is what it is, or why there is none. Never empty: an
   * unowned entry with no reason is indistinguishable from one nobody looked at,
   * and those are the entries that become permanent invisible debt.
   */
  ownerReason?: string;
  /** ISO timestamp after which a waiver stops being accepted. */
  expiresAt: string | null;
}

export interface BaselineFinding {
  rule: string;
  classification: string;
  status: FindingStatus;
  severity: Severity;
  subject: string;
  /** Where the finding last sat. Informational; not part of its identity. */
  locator: string;
  /**
   * What the finding is, independent of position - the identity component that
   * survives a line shift. See Finding.anchor.
   */
  anchor: string;
  /**
   * Digest of the subject's contents, used to recognize a move.
   *
   * Per-file, so it is evidence about the file rather than about the finding. It
   * cannot distinguish two findings in one file, which is exactly why `anchor`
   * exists.
   */
  subjectDigest: string | null;
  occurrences: number;
  debt: boolean;
  metric?: MetricValue;
  /**
   * The analyzer's own words for the finding, as recorded when it was accepted.
   *
   * This is the "original evidence" half of an accepted entry, and its absence was
   * not academic. A proposal once contained 198 entries whose entire justification
   * was the text "Definition for rule 'custom-rules/...' was not found" - a
   * statement that the *configuration* was wrong, frozen as accepted maintainability
   * debt. Nothing in the baseline could show it, because the baseline recorded only
   * identity and numbers, so the text existed only in the run that produced it and
   * was gone by the time anyone reviewed the ratchet.
   *
   * Optional so that entries written before this existed still read; a reader that
   * needs the evidence must treat its absence as unknown rather than as clean.
   */
  detail?: string;
  acceptance: Acceptance;
}

export interface Baseline {
  /**
   * v3: entries carry `anchor`, and ids are position-independent.
   *
   * The bump is not bookkeeping. A v2 entry has no anchor, and reading one into
   * this shape would give every entry an identity component of `undefined`, so
   * every finding in the repository would read as unrecorded at once. The engine
   * refuses a version it cannot interpret rather than guessing.
   */
  schemaVersion: 3;
  analyzer: string;
  policyDigest: string;
  /**
   * The observation system this baseline was recorded under.
   *
   * Optional because baselines written before the field existed have no value
   * for it, and inventing one would be worse than admitting ignorance: a
   * fabricated digest would compare equal to the current measurement and the
   * migration path would silently skip. Absent reads as "unknown epoch", which
   * forces a migration report rather than a quiet re-record.
   */
  measurementDigest?: string;
  /**
   * The instrument this baseline was recorded with.
   *
   * Recorded for the same reason as `measurementDigest`, one level further out.
   * That field covers the analyzer's own implementation; it does not cover the
   * external tool the analyzer shells out to, because that tool lives in its own
   * project with its own lockfile (`.quality/tools`), outside the tree the
   * implementation walk visits. So a moved pin would leave `measurementDigest`
   * unchanged while the instrument that produced the numbers was a different
   * program - the exact "different ruler, same measurement" hole this field is
   * the outer half of.
   *
   * The ratchet reads this. An accepted baseline cannot be silently re-scored by
   * a newer resolver; the run is refused with a direction, not merely a count,
   * because "the tree changed" and "the measuring instrument changed" are
   * indistinguishable from a findings count alone. Optional for the same reason
   * as `measurementDigest`: a baseline written before this existed reads as
   * "instrument unknown", which is honest and is reported.
   */
  toolchainDigest?: string;
  /**
   * How many entities the analyzer was obliged to consider when this baseline
   * was recorded.
   *
   * Recorded so a migration can tell "the ruler changed" apart from "the ruler
   * changed AND it is now looking at a different amount of the repository".
   * Without it, a scope change and a rule change are the same observation - a
   * different number of findings - and the reviewer cannot know which they are
   * approving. Optional for the same reason as `measurementDigest`.
   */
  recordedEligible?: number | null;
  createdAt: string;
  candidate: CandidateIdentity;
  findings: Record<string, BaselineFinding>;
}

/**
 * The result of re-measuring one unchanged tree under a new observation system.
 *
 * This exists because "the digest changed, so re-record the baseline" is not a
 * review - it is a blank cheque. An analyzer change that legitimately collapses
 * 4,994 findings into 3,100 and an analyzer bug that silently drops 1,894 are
 * indistinguishable from the outside, and the second is the one that erases
 * debt. The migration report is the difference: it names what the new system
 * added, what it removed, what kept its identity but changed shape, and whether
 * the scope it looked at moved at all.
 */
export interface MeasurementMigration {
  analyzer: string;
  from: {
    /** Absent when the baseline predates epoch tracking. */
    measurementDigest: string | null;
    /** Absent when the baseline predates instrument tracking. */
    toolchainDigest: string | null;
    policyDigest: string;
    recordedAt: string;
    recordedFindings: number;
    recordedEligible: number | null;
  };
  to: {
    measurementDigest: string;
    toolchainDigest: string;
    policyDigest: string;
    measuredFindings: number;
    measuredEligible: number | null;
  };
  /** Present in the new measurement, absent from the old baseline. */
  added: Finding[];
  /** Recorded in the old baseline, not observed now. */
  removed: BaselineFinding[];
  /**
   * Same identity on both sides, but the observation changed: occurrences
   * moved, a metric moved, severity moved. These are the entries a reviewer
   * must actually read, because they are where a measurement change hides.
   */
  changed: Array<{
    id: string;
    field: 'occurrences' | 'metric' | 'severity' | 'detail';
    before: string | number;
    after: string | number;
  }>;
  /** Unchanged on both sides; summarized by count rather than listed. */
  stableCount: number;
  /**
   * Whether the two measurements were taken over the same file set. A scope
   * change makes every count incomparable, so it is reported first and loudly.
   */
  scopeChanged: boolean;
  /**
   * True when the only difference is that the old baseline has no epoch
   * recorded. Nothing can be concluded from a comparison against unknown, so
   * this is reported as its own state rather than as a clean migration.
   */
  unknownEpoch: boolean;
  /**
   * A one-line judgement. `comparable` means the new measurement may be
   * reviewed as a successor; `scope-moved` and `unknown-epoch` mean the
   * numbers cannot be lined up at all and the reviewer is being asked to
   * accept something that was not compared.
   */
  /**
   * Whether the two measurements were taken with the same instrument - the
   * analyzer implementation AND the pinned external tool it shells out to.
   *
   * Distinct from `scopeChanged`: a scope change means the same instrument looked
   * at more or less of the tree, while this means the instrument itself is a
   * different program. The remedy differs - re-scope versus re-record - so they
   * are reported as two conditions rather than one "something moved".
   */
  instrumentChanged: boolean;
  verdict: 'comparable' | 'scope-moved' | 'instrument-changed' | 'unknown-epoch';
}

export interface MovedFinding {
  id: string;
  reason: 'subject-moved';
  from: BaselineFinding;
  to: Finding;
}

export interface ImprovedFinding {
  id: string;
  metric: MetricValue;
  from: MetricValue;
  /** Still failing, but measurably closer to the limit. */
  progress: number;
}

export interface GateResult {
  decision: 'PASS' | 'FAIL' | 'INCOMPLETE';
  analyzer: string;
  profile: string;
  /** Failing findings with no baseline entry, after move reconciliation. */
  newFindings: Finding[];
  resolvedFindings: BaselineFinding[];
  movedFindings: MovedFinding[];
  /** Accepted findings whose metric moved toward the limit but still fails. */
  improvedFindings: ImprovedFinding[];
  dispositions: Record<Disposition, number>;
  grandfatheredCount: number;
  debtCount: number;
  worsened: Array<{
    id: string;
    reason: 'occurrences-increased' | 'severity-increased' | 'metric-worsened';
    before: BaselineFinding;
    after: Finding;
  }>;
  incompleteReasons: string[];
  counts: Record<string, number>;
  /**
   * The coverage the decision was reached from, carried so a gate run can show
   * that it saw a complete measurement rather than merely reporting a verdict.
   * Without it a PASS is unreadable: it looks identical whether the analyzer
   * examined the whole scope or a fraction of it.
   */
  coverage: Coverage;
  /**
   * `complete` only when the analyzer vouched for coverage AND the engine
   * re-derived it arithmetically. Reported separately from the decision,
   * because a PASS can be reached over incomplete measurement when the
   * incomplete parts happen to carry no findings.
   */
  completeness: 'complete' | 'incomplete';
}
