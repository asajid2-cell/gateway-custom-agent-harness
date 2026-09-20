import type { Finding, Severity } from './types';

/**
 * The one place a `Finding` is constructed from its parts.
 *
 * Why this exists as a shared function rather than as a helper inside each
 * analyzer, stated as the defect it prevents: `id` is
 * `${rule}::${subject}::${anchor}`, and the whole ratchet rests on that string
 * being built the SAME way in the analyzer that reports a finding and in the
 * baseline entry that tolerates it. Two analyzers that each write
 * `id: \`${rule}::${subject}::${anchor}\`` produce two chances to write it
 * differently, and a divergence there is invisible - the finding is reported,
 * the baseline entry is stored under a key that never matches, and the entry
 * reads as resolved-and-replaced. Nothing fails; the debt silently changes.
 *
 * The duplication analyzer's clone detector found this exact shape written twice
 * across the two newest adapters, which is the measurement that prompted this
 * module rather than a style preference. A third and fourth analyzer were about
 * to write it again.
 *
 * Deliberately NOT parameterized beyond what every analyzer sets identically:
 * `status: 'fail'`, `occurrences: 1`, `debt: false` are the defaults because a
 * finding is only ever constructed for something the analyzer observed as
 * wrong. An analyzer that needs a different status or a debt flag sets it on the
 * returned object, which keeps that decision visible at the call site instead of
 * buried in an options bag.
 */
export interface FindingInput {
  rule: string;
  /**
   * Deliberately `string` rather than a union. Each analyzer declares its own
   * closed set of classifications (a source-integrity classification has no
   * meaning to a clone detector), and the engine stores the value without
   * interpreting it - so the shared constructor takes the field at the width the
   * engine actually uses and leaves the union to the analyzer that owns it.
   */
  classification: string;
  subject: string;
  locator: string;
  anchor: string;
  severity: Severity;
  detail: string;
  evidence: Finding['evidence'];
  metric?: Finding['metric'];
}

export function makeFinding(input: FindingInput): Finding {
  return {
    id: `${input.rule}::${input.subject}::${input.anchor}`,
    rule: input.rule,
    subject: input.subject,
    locator: input.locator,
    anchor: input.anchor,
    classification: input.classification,
    status: 'fail',
    severity: input.severity,
    detail: input.detail,
    occurrences: 1,
    debt: false,
    evidence: input.evidence,
    metric: input.metric,
  };
}
