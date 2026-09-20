import type { AnalyzerError, AnalyzerResult } from './types';

/**
 * The one shape a failed run takes, wherever the failure is detected.
 *
 * Why this is shared rather than written per analyzer, stated as the property
 * that has to hold: `status: 'failed'` and `complete: false` are the two fields
 * `compare` reads to decide that a finding list is NOT a measurement. Every site
 * that constructs a failed result is therefore constructing the same safety
 * argument, and a site that gets it slightly wrong - `complete: true`, or a
 * coverage record whose `failed` count is zero - produces a result the engine
 * will read as "ran and found nothing" instead of "never ran". That is the exact
 * degradation the whole gated-shrink design exists to prevent, and it is not a
 * thing to re-derive at each of a dozen call sites.
 *
 * `failed` accounts for every file the analyzer was obliged to consider, with a
 * floor of 1 so that a failure over an empty candidate set still has a non-zero
 * denominator. A zero here would make the coverage arithmetic read as tidy while
 * nothing had been measured.
 *
 * `reason` is a named key rather than free text: it is the field a reader or a
 * dashboard groups by, and "the tool was missing" and "the tool was the wrong
 * version" call for different remedies.
 */
export interface FailedResultInput {
  analyzer: string;
  /** Named in `coverage.skipReasons`; identifies why no measurement was taken. */
  reason: string;
  errors: AnalyzerError[];
  notes: string[];
  /**
   * How many files the run was obliged to consider. Callers pass
   * `context.candidateFiles.length` for a run that failed on the candidate, or
   * the analyzer's own eligible count when it computed a narrower scope first.
   */
  eligible: number;
}

export function failedResult(input: FailedResultInput): AnalyzerResult {
  return {
    analyzer: input.analyzer,
    findings: [],
    errors: input.errors,
    coverage: {
      eligible: input.eligible,
      scanned: 0,
      skipped: 0,
      failed: Math.max(input.eligible, 1),
      skipReasons: { [input.reason]: 1 },
    },
    complete: false,
    status: 'failed',
    notes: input.notes,
  };
}
