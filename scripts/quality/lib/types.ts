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
}

/** The arithmetic an analyzer must satisfy to claim completeness. */
export function coverageIsComplete(coverage: Coverage): boolean {
  if (coverage.eligible === null) return false;
  if (coverage.eligible === 0) return false;
  if (coverage.scanned === 0) return false;
  if (coverage.failed > 0) return false;
  return coverage.scanned + coverage.skipped + coverage.failed === coverage.eligible;
}

export interface AnalyzerResult {
  analyzer: string;
  findings: Finding[];
  errors: AnalyzerError[];
  coverage: Coverage;
  /**
   * True only when coverage can be vouched for arithmetically. An analyzer
   * asserts this, and the gate separately re-derives it from `coverage` so that a
   * wrong assertion cannot become a pass.
   */
  complete: boolean;
  notes: string[];
}

export interface CandidateIdentity {
  head: string;
  headDirty: boolean;
  trackedChangesDigest: string;
  relevantUntrackedDigest: string;
  policyDigest: string;
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
  createdAt: string;
  candidate: CandidateIdentity;
  findings: Record<string, BaselineFinding>;
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
}
