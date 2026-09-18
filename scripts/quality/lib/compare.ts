import type {
  AnalyzerResult,
  Baseline,
  BaselineFinding,
  CandidateIdentity,
  Disposition,
  Finding,
  GateResult,
  ImprovedFinding,
  MovedFinding,
} from './types';
import { coverageIsComplete } from './types';
import { identityEqual } from './identity';
import { fileDigest } from './hash';
import { join } from 'node:path';

const SEVERITY_RANK: Record<string, number> = { info: 0, warning: 1, error: 2 };

export interface CompareOptions {
  analyzer: string;
  profile: string;
  baseline: Baseline | null;
  result: AnalyzerResult;
  candidateAtStart: CandidateIdentity;
  candidateAtFinish: CandidateIdentity;
  repoRoot: string;
  detectMoves?: boolean;
  /** Injectable clock so waiver expiry is testable. */
  now?: () => Date;
}

/**
 * The gate.
 *
 * Invariants this function exists to enforce:
 *  1. A passing report from candidate A must never authorize candidate B.
 *  2. The baseline is a ratchet, not an allowlist. It freezes the set and count of
 *     known findings; anything not in it blocks.
 *  3. A relocation is not a new finding when identity evidence supports it: same
 *     rule, same locator, same content digest. Never assumed.
 *  4. An expired waiver blocks. An expiry that does not fail closed is decoration.
 *  5. A metric that improves but is still over its limit still fails - and the
 *     improvement is recorded, so "did this change help" is answerable.
 *
 * This function never writes a baseline. Discovery of resolved findings is
 * automatic; accepting that resolution is a separate, human act.
 */
export function compare(opts: CompareOptions): GateResult {
  const now = opts.now ?? (() => new Date());
  const incompleteReasons: string[] = [];

  if (!identityEqual(opts.candidateAtStart, opts.candidateAtFinish)) {
    incompleteReasons.push(
      'candidate mutated during the run (head, working tree, policy or toolchain ' +
        'changed between start and finish)'
    );
  }

  // A failed execution is checked FIRST and separately from incomplete coverage,
  // because the two demand different responses and conflating them loses the
  // distinction that matters most.
  //
  // The rule: an analyzer internal exception must never degrade into "zero
  // findings". A traversal throws, a `catch` returns `[]`, the run reports no
  // findings - and every later stage reads an empty list as a claim that the
  // code is clean, so the baseline shrinks and the debt is reported RESOLVED.
  // Naming a failed run stops that chain at the first link: the finding list is
  // not a measurement, it is the absence of one, and nothing downstream may
  // treat it as a resolution.
  if (opts.result.status === 'failed') {
    const detail = opts.result.errors
      .map((error) => `${error.kind}:${error.subject}`)
      .join(', ');
    incompleteReasons.push(
      'analyzer execution FAILED, so its finding list is not a measurement and ' +
        'must not be read as one (a failed traversal and an empty result are ' +
        `different facts)${detail ? ` (${detail})` : ''}`
    );
  } else if (opts.result.status === 'incomplete') {
    incompleteReasons.push(
      'analyzer execution was INCOMPLETE: it ended before finishing the work it ' +
        'set out to do, so any findings are a lower bound'
    );
  }

  if (!opts.result.complete) {
    const detail = opts.result.errors
      .map((error) => `${error.kind}:${error.subject}`)
      .join(', ');
    incompleteReasons.push(
      `analyzer reported incomplete coverage${detail ? ` (${detail})` : ''}`
    );
  }

  // The engine re-derives completeness from the arithmetic rather than trusting
  // the analyzer's word. An analyzer that asserts `complete: true` over coverage
  // that does not add up is exactly the loose green label this exists to stop.
  if (!coverageIsComplete(opts.result.coverage)) {
    const c = opts.result.coverage;
    incompleteReasons.push(
      `coverage does not add up: eligible ${c.eligible ?? 'unknown'} != ` +
        `scanned ${c.scanned} + skipped ${c.skipped} + failed ${c.failed}`
    );
  }

  if (opts.result.coverage.scanned === 0) {
    incompleteReasons.push('analyzer scanned zero files');
  }

  if (opts.baseline === null) {
    incompleteReasons.push(
      `no accepted baseline for analyzer "${opts.analyzer}"; nothing can be ` +
        'authorized until one is proposed and reviewed'
    );
  } else if (opts.baseline.policyDigest !== opts.candidateAtStart.policyDigest) {
    incompleteReasons.push(
      'baseline was produced under a different policy digest; what counts as ' +
        'tolerable has changed since it was accepted'
    );
  } else if (
    // A different observation system means the baseline's numbers describe a
    // different measurement, so comparing them would report every difference
    // between two rulers as a difference in the code. Blocked here rather than
    // guessed at; `quality migrate <analyzer>` produces the old-vs-new report
    // a reviewer needs before re-recording.
    opts.baseline.measurementDigest !== undefined &&
    opts.baseline.measurementDigest !== opts.candidateAtStart.measurementDigest
  ) {
    incompleteReasons.push(
      'baseline was recorded by a different measurement system (the analyzer or ' +
        'engine implementation changed since it was accepted); the two sets of ' +
        'numbers are not comparable. Run `quality migrate ' +
        `${opts.analyzer}\` to see what the new system adds, removes and changes, ` +
        'then re-record deliberately'
    );
  }

  if (incompleteReasons.length > 0) {
    return emptyResult(opts, incompleteReasons);
  }

  const baseline = opts.baseline as Baseline;
  const detectMoves = opts.detectMoves ?? true;
  const dispositions = emptyDispositions();

  const newFindings: Finding[] = [];
  const worsened: GateResult['worsened'] = [];
  const improvedFindings: ImprovedFinding[] = [];
  const unresolvedNew: Finding[] = [];
  let grandfatheredCount = 0;
  let debtCount = 0;

  for (const finding of opts.result.findings) {
    // Review-required findings are checked before the baseline is consulted, so
    // that a stale baseline entry can never launder one into accepted legacy. They
    // describe the working tree rather than the candidate and must be resolved,
    // not tolerated.
    if (finding.reviewRequired === true) {
      dispositions['review-required'] += 1;
      newFindings.push(finding);
      continue;
    }

    const previous = baseline.findings[finding.id];

    if (previous === undefined) {
      // Unrecorded failure, or unrecorded tolerated debt. The second case is not
      // hypothetical: a new use of an already-declared stub produces a fresh
      // pass-status debt finding, and it must be blocked. Otherwise "declare the
      // stub, then use it anywhere" is a silent bypass.
      if (finding.status === 'fail' || finding.debt) unresolvedNew.push(finding);
      continue;
    }

    if (finding.status === 'incomplete') {
      dispositions['unresolved'] += 1;
      continue;
    }

    if (finding.debt) debtCount += 1;

    const expired = isExpired(previous, now());
    if (previous.status === 'fail') {
      grandfatheredCount += 1;
      if (expired) {
        dispositions['active-blocker'] += 1;
        worsened.push({
          id: finding.id,
          reason: 'metric-worsened',
          before: previous,
          after: finding,
        });
        continue;
      }
      dispositions['accepted-legacy'] += 1;
    } else if (finding.status === 'fail') {
      dispositions['active-blocker'] += 1;
    } else if (finding.debt) {
      // A waiver is a tolerance with a deadline. Tolerated debt with no expiry is
      // accepted legacy, and calling that a "temporary waiver" would misreport a
      // permanent decision as a pending one.
      if (expired) dispositions['active-blocker'] += 1;
      else if (previous.acceptance.expiresAt !== null) {
        dispositions['temporary-waiver'] += 1;
      } else {
        dispositions['accepted-legacy'] += 1;
      }
    } else {
      dispositions['review-required'] += 1;
    }

    if (finding.occurrences > previous.occurrences) {
      worsened.push({
        id: finding.id,
        reason: 'occurrences-increased',
        before: previous,
        after: finding,
      });
      continue;
    }

    if (
      (SEVERITY_RANK[finding.severity] ?? 0) >
      (SEVERITY_RANK[previous.severity] ?? 0)
    ) {
      worsened.push({
        id: finding.id,
        reason: 'severity-increased',
        before: previous,
        after: finding,
      });
      continue;
    }

    // Still failing, but measurably closer to the limit. Recorded so that partial
    // progress is visible instead of being indistinguishable from no movement.
    if (
      finding.status === 'fail' &&
      finding.metric !== undefined &&
      previous.metric !== undefined
    ) {
      const progress = relativeProgress(previous.metric, finding.metric);
      if (progress > 0) {
        improvedFindings.push({
          id: finding.id,
          metric: finding.metric,
          from: previous.metric,
          progress,
        });
      } else if (progress < 0) {
        worsened.push({
          id: finding.id,
          reason: 'metric-worsened',
          before: previous,
          after: finding,
        });
      }
    }
  }

  const currentIds = new Set(opts.result.findings.map((finding) => finding.id));
  const resolvedFindings: BaselineFinding[] = Object.entries(baseline.findings)
    .filter(([id]) => !currentIds.has(id))
    .map(([, finding]) => finding);

  const movedFindings: MovedFinding[] = [];
  const claimed = new Set<string>();

  // With `anchor` in the identity, a finding that slides down a file keeps its id
  // and never reaches this pass at all. What is left for it is the genuine
  // cross-file move: same rule, same anchor text, different subject. The digest
  // is still required evidence rather than an assumption - a moved finding must
  // be findable in content that resembles where it came from.
  if (detectMoves && unresolvedNew.length > 0) {
    const bySignature = new Map<string, BaselineFinding[]>();
    for (const [id, previous] of Object.entries(baseline.findings)) {
      if (previous.status !== 'fail' || previous.subjectDigest === null) continue;
      // A finding still reported at its recorded location has not moved. Without
      // this, copying a bad module would let the copy inherit the original's
      // identity: both share a content digest, so the copy would be excused as a
      // relocation while the original is still there. A move requires the old
      // location to be vacant.
      if (!resolvedFindings.some((entry) => entryKey(entry) === entryKey(previous))) {
        continue;
      }
      if (claimed.has(id)) continue;
      const signature = `${previous.rule}::${previous.anchor}::${previous.subjectDigest}`;
      const list = bySignature.get(signature) ?? [];
      list.push(previous);
      bySignature.set(signature, list);
    }

    for (const finding of unresolvedNew) {
      const digest = subjectDigestFor(opts.repoRoot, finding);
      const signature = `${finding.rule}::${finding.anchor}::${digest ?? 'none'}`;
      const candidates = digest === null ? undefined : bySignature.get(signature);
      const matched =
        candidates === undefined || candidates.length === 0
          ? undefined
          : candidates.shift();
      if (matched === undefined) {
        newFindings.push(finding);
        dispositions['active-blocker'] += 1;
        continue;
      }
      // One vacated location absorbs exactly one relocation. A second arrival on
      // the same signature is additional debt wearing a copy of the original's
      // fingerprint, and the ratchet must not accept it.
      const matchedId = matchedIdFor(baseline, matched);
      if (matchedId !== null) claimed.add(matchedId);
      movedFindings.push({
        id: finding.id,
        reason: 'subject-moved',
        from: matched,
        to: finding,
      });
    }
  } else {
    for (const finding of unresolvedNew) {
      newFindings.push(finding);
      dispositions['active-blocker'] += 1;
    }
  }

  // A baseline entry that was relocated (or absorbed) is no longer resolved: it
  // is accounted for by the move, and reporting it as resolved would invite the
  // resolution-acceptance path to delete an entry whose debt still exists at a
  // new address.
  const movedFromKeys = new Set(
    movedFindings.map((entry) => entryKey(entry.from))
  );
  const stillResolved = resolvedFindings.filter(
    (entry) => !movedFromKeys.has(entryKey(entry))
  );

  return {
    decision:
      newFindings.length === 0 && worsened.length === 0 ? 'PASS' : 'FAIL',
    analyzer: opts.analyzer,
    profile: opts.profile,
    newFindings,
    resolvedFindings: stillResolved,
    movedFindings,
    improvedFindings,
    dispositions,
    grandfatheredCount,
    debtCount,
    worsened,
    incompleteReasons: [],
    counts: statusCounts(opts.result.findings),
    coverage: opts.result.coverage,
    completeness: completenessOf(opts.result),
  };
}

/**
 * Whether a conclusive run may also claim a complete measurement. All three
 * must hold: the execution ended as intended, the analyzer asserts coverage, and
 * the engine's own arithmetic agrees. Any one alone is a label someone could
 * assert into existence - and a `failed` run has no measurement to complete,
 * however tidy its coverage arithmetic happens to look.
 */
function completenessOf(result: AnalyzerResult): 'complete' | 'incomplete' {
  return result.status === 'complete' &&
    result.complete &&
    coverageIsComplete(result.coverage)
    ? 'complete'
    : 'incomplete';
}

function emptyDispositions(): Record<Disposition, number> {
  return {
    'active-blocker': 0,
    'accepted-legacy': 0,
    'temporary-waiver': 0,
    'review-required': 0,
    unresolved: 0,
  };
}

function emptyResult(
  opts: CompareOptions,
  reasons: string[]
): GateResult {
  return {
    decision: 'INCOMPLETE',
    analyzer: opts.analyzer,
    profile: opts.profile,
    newFindings: [],
    resolvedFindings: [],
    movedFindings: [],
    improvedFindings: [],
    dispositions: emptyDispositions(),
    grandfatheredCount: 0,
    debtCount: 0,
    worsened: [],
    incompleteReasons: reasons,
    counts: statusCounts(opts.result.findings),
    coverage: opts.result.coverage,
    // An INCOMPLETE decision means the run could not vouch for itself, whatever
    // the arithmetic below happens to say; that is the whole meaning of the
    // branch, so it is reported as incomplete rather than recomputed.
    completeness: 'incomplete',
  };
}

function isExpired(entry: BaselineFinding, now: Date): boolean {
  const expiry = entry.acceptance.expiresAt;
  if (expiry === null) return false;
  const at = Date.parse(expiry);
  if (Number.isNaN(at)) return true;
  return at <= now.getTime();
}

/** Positive means moved toward the limit. Only meaningful within one rule. */
function relativeProgress(before: { value: number; limit: number | null; direction: string }, after: typeof before): number {
  if (before.limit === null || after.limit === null) {
    return before.direction === 'lower-is-better'
      ? before.value - after.value
      : after.value - before.value;
  }
  const beforeGap = distanceFromLimit(before);
  const afterGap = distanceFromLimit(after);
  if (beforeGap === 0) return 0;
  return (beforeGap - afterGap) / beforeGap;
}

function distanceFromLimit(metric: {
  value: number;
  limit: number | null;
  direction: string;
}): number {
  if (metric.limit === null) return 0;
  return metric.direction === 'lower-is-better'
    ? Math.max(0, metric.value - metric.limit)
    : Math.max(0, metric.limit - metric.value);
}

/**
 * Identity of a baseline entry, in the same shape a Finding id takes.
 *
 * Built from `anchor`, exactly as Finding.id is. Using `locator` here would make
 * the relocation pass compare two different kinds of key - an entry's position
 * against a finding's text - and the comparison would simply never match, while
 * still looking correct at every call site.
 */
function entryKey(entry: BaselineFinding): string {
  return `${entry.rule}::${entry.subject}::${entry.anchor}`;
}

/** The key under which a baseline entry is stored, or null if it is unreachable. */
function matchedIdFor(
  baseline: Baseline,
  entry: BaselineFinding
): string | null {
  const key = entryKey(entry);
  return baseline.findings[key] === undefined ? null : key;
}

function subjectDigestFor(repoRoot: string, finding: Finding): string | null {
  if (finding.subject === '') return null;
  return fileDigest(join(repoRoot, finding.subject));
}

function statusCounts(findings: Finding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  const bump = (key: string): void => {
    counts[key] = (counts[key] ?? 0) + 1;
  };
  for (const finding of findings) {
    if (finding.debt) bump('debt');
    else bump(finding.status);
  }
  return counts;
}
