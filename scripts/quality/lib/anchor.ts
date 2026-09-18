import type { Finding } from './types';

/**
 * A finding's identity below the file, and why it cannot be a line number.
 *
 * `rule::subject::line:column` is not an identity, it is a position. Every
 * finding below a line someone inserts or deletes changes its position, so the
 * first commit after a baseline is accepted reports every finding in every
 * touched file as *new debt*. Measured on this repository's first real commit
 * after its baseline: 283 new blockers, of which 259 were findings that had
 * merely slid down a file. The ratchet then deadlocks, because the resolution
 * path refuses to shrink a baseline while new findings exist, and the line
 * shifts *are* the new findings.
 *
 * The engine already tried to absorb this in `compare`, by matching a vacated
 * location against an arrival on `rule::locator::subjectDigest`. That match is
 * structurally incapable of firing for a same-file shift: `subjectDigest` is a
 * digest of the *whole file*, so any edit anywhere in the file changes it, and
 * the locator never matches. It only ever detected cross-file moves.
 *
 * So identity is taken from the source text the finding is about, normalized so
 * that indentation and spacing cannot matter, and disambiguated by ordinal when
 * one line carries several instances of the same rule. The position is kept
 * separately, as `locator`, and is now explicitly informational - it is where a
 * human should look, not what the finding *is*.
 */

/** Longest anchor text kept. Guards against a minified single-line file. */
const MAX_ANCHOR_CHARS = 200;

/**
 * Normalize a source line into anchor text.
 *
 * Whitespace is collapsed and trimmed, so re-indenting a block - the single most
 * common artifact of the line shifts this exists to absorb - cannot change an
 * anchor. Nothing else is stripped: a rule that fires on a comment must keep the
 * comment as its anchor, or every suppression directive would collapse onto the
 * same identity.
 */
export function normalizeAnchor(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_ANCHOR_CHARS);
}

/**
 * The anchor for a finding that is about a single source line.
 *
 * `sourceLines` is 0-indexed; `line` is the 1-based line ESLint reported.
 */
export function lineAnchor(
  sourceLines: readonly string[],
  line: number
): string {
  if (!Number.isInteger(line) || line < 1 || line > sourceLines.length) {
    // Out of range means the file changed under the analyzer between the lint
    // pass and this read. That must not silently become an anchor shared by
    // every out-of-range finding in the file, so it is given no text at all and
    // the ordinal pass separates them.
    return '';
  }
  return normalizeAnchor(sourceLines[line - 1] as string);
}

/**
 * Give every finding a unique, position-independent identity.
 *
 * Two findings of the same rule can share an anchor legitimately - a file with
 * two identical `const last = kids[kids.length - 1]!` lines produces two
 * findings on identical text, and this repository has 906 findings that collide
 * this way. They are distinct findings at distinct places, so they take an
 * ordinal suffix, assigned in position order.
 *
 * Ordinal-by-position is stable under the edit that matters: inserting or
 * removing lines elsewhere in the file preserves the relative order of equal
 * anchors, so the ordinals do not move. Inserting a *new instance* between two
 * existing ones does shift them, and that is deliberately not compensated for:
 * the file gained an instance of a pattern that is already over its limit, and
 * reporting that as new debt is the correct reading rather than a false one.
 *
 * Grouping is per subject as well as per rule and anchor. Without the subject,
 * two files containing the same line would share a group and be handed ordinals
 * relative to each other, so an edit to one file would renumber findings in the
 * other.
 *
 * Every finding in the file takes an ordinal, including passing ones. Ordinals
 * must depend on position alone: if only failures were counted, a passing
 * finding on the same anchor becoming a failure would renumber its siblings.
 */
export function assignAnchors(findings: Finding[]): Finding[] {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key = `${finding.subject}\u0000${finding.rule}\u0000${finding.anchor}`;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [finding]);
    else bucket.push(finding);
  }

  const assigned: Finding[] = [];
  for (const bucket of groups.values()) {
    if (bucket.length === 1) {
      assigned.push(bucket[0] as Finding);
      continue;
    }
    // Position order, so the ordinal for a given instance is the same on every
    // run over the same file.
    const ordered = [...bucket].sort(compareByPosition);
    ordered.forEach((finding, index) => {
      assigned.push({
        ...finding,
        anchor: index === 0 ? finding.anchor : `${finding.anchor}#${index}`,
      });
    });
  }

  return assigned.map((finding) => ({
    ...finding,
    id: `${finding.rule}::${finding.subject}::${finding.anchor}`,
  }));
}

/**
 * Line, then column, then end column.
 *
 * The end column is not redundant. Two assertions on one line can share a start
 * column - `children[0]!.getPermissions()[0]!.input.text` reports both at the
 * same position and differs only in where each ends - and ordering those by
 * insertion would let ESLint's message order decide which one gets which
 * ordinal. A stable order is what keeps an ordinal meaningful across runs.
 */
function compareByPosition(a: Finding, b: Finding): number {
  const [aLine = 0, aColumn = 0] = a.locator.split(':').map(Number);
  const [bLine = 0, bColumn = 0] = b.locator.split(':').map(Number);
  const aEnd = typeof a.evidence.endColumn === 'number' ? a.evidence.endColumn : 0;
  const bEnd = typeof b.evidence.endColumn === 'number' ? b.evidence.endColumn : 0;
  return aLine - bLine || aColumn - bColumn || aEnd - bEnd;
}
