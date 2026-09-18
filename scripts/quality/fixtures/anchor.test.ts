/**
 * The anchor is the identity component that survives a line shift.
 *
 * Every case here is a way a naive anchor would make the ratchet wrong: too
 * coarse and distinct findings merge into one, too fine and a re-indent reads as
 * new debt, non-deterministic and the same file produces different ids on two
 * runs.
 */
import { describe, expect, test } from 'bun:test';
import {
  assignAnchors,
  lineAnchor,
  normalizeAnchor,
} from '../lib/anchor';
import type { Finding } from '../lib/types';

function finding(overrides: Partial<Finding> = {}): Finding {
  const subject = overrides.subject ?? 'src/a.ts';
  const rule = overrides.rule ?? 'complexity';
  const anchor = overrides.anchor ?? 'const x = 1';
  const locator = overrides.locator ?? '10:1';
  return {
    id: overrides.id ?? `${rule}::${subject}::${anchor}`,
    rule,
    subject,
    locator,
    anchor,
    classification: overrides.classification ?? 'size-or-complexity',
    status: overrides.status ?? 'fail',
    severity: overrides.severity ?? 'error',
    detail: overrides.detail ?? 'detail',
    occurrences: overrides.occurrences ?? 1,
    debt: overrides.debt ?? false,
    evidence: overrides.evidence ?? {},
  };
}

describe('anchor text normalization', () => {
  test('indentation and spacing cannot change an anchor', () => {
    expect(normalizeAnchor('      const x = 1')).toBe('const x = 1');
    expect(normalizeAnchor('  const   x =   1  ')).toBe('const x = 1');
    expect(normalizeAnchor('\tconst x = 1')).toBe('const x = 1');
  });

  test('a re-indent is not a new finding', () => {
    // Wrapping a block in an `if` re-indents every line inside it. That is the
    // most common edit in the repository, and it must not renumber debt.
    const before = ['function f() {', '  const x = 1', '}'];
    const after = ['function f() {', '  if (g) {', '    const x = 1', '  }', '}'];
    expect(lineAnchor(before, 2)).toBe(lineAnchor(after, 3));
  });

  test('comment text is preserved, not stripped', () => {
    // Suppression directives are findings in their own right (MAINT-020). If
    // comments normalized away, every suppression in a file would collapse onto
    // one identity.
    expect(normalizeAnchor('// eslint-disable-next-line no-console')).toBe(
      '// eslint-disable-next-line no-console'
    );
    expect(normalizeAnchor('// eslint-disable-next-line a')).not.toBe(
      normalizeAnchor('// eslint-disable-next-line b')
    );
  });

  test('a line that moved out of range anchors to nothing', () => {
    // A file that changed under the analyzer between lint and this read. It must
    // not silently adopt some other line's text.
    expect(lineAnchor(['a', 'b'], 99)).toBe('');
    expect(lineAnchor([], 1)).toBe('');
    expect(lineAnchor(['a'], 0)).toBe('');
  });

  test('anchor text is bounded', () => {
    const huge = 'x'.repeat(10_000);
    expect(normalizeAnchor(huge).length).toBeLessThanOrEqual(200);
  });
});

describe('anchor assignment', () => {
  test('identity does not contain a line number', () => {
    const [assigned] = assignAnchors([
      finding({ anchor: 'const x = 1', locator: '10:1' }),
    ]);
    expect(assigned?.id).toBe('complexity::src/a.ts::const x = 1');
    expect(assigned?.id).not.toContain('10');
  });

  test('two identical lines in one file stay two findings', () => {
    // Both lines are `const last = kids[kids.length - 1]!`. Without ordinals
    // they would share an id and the second would vanish into the first.
    const assigned = assignAnchors([
      finding({ anchor: 'const last = kids[kids.length - 1]!', locator: '10:3' }),
      finding({ anchor: 'const last = kids[kids.length - 1]!', locator: '40:3' }),
    ]);
    const ids = assigned.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain('complexity::src/a.ts::const last = kids[kids.length - 1]!');
    expect(ids).toContain('complexity::src/a.ts::const last = kids[kids.length - 1]!#1');
  });

  test('ordinals follow position, so inserting above does not renumber', () => {
    const line = 'const last = kids[kids.length - 1]!';
    const before = assignAnchors([
      finding({ anchor: line, locator: '10:3' }),
      finding({ anchor: line, locator: '40:3' }),
    ]);
    // 30 lines inserted at the top of the file: both findings slide down together.
    const after = assignAnchors([
      finding({ anchor: line, locator: '40:3' }),
      finding({ anchor: line, locator: '70:3' }),
    ]);
    expect(after.map((entry) => entry.id)).toEqual(
      before.map((entry) => entry.id)
    );
  });

  test('identical lines in different files are numbered independently', () => {
    // Grouping by rule and anchor alone would put these in one group, so an edit
    // to one file would renumber the finding in the other.
    const line = 'return null';
    const assigned = assignAnchors([
      finding({ subject: 'src/a.ts', anchor: line, locator: '5:1' }),
      finding({ subject: 'src/b.ts', anchor: line, locator: '5:1' }),
    ]);
    for (const entry of assigned) {
      expect(entry.id.endsWith('::return null')).toBe(true);
    }
  });

  test('two assertions on one line stay two findings', () => {
    // `children[0]!.getPermissions()[0]!.input` reports both assertions at the
    // same line and column and distinguishes them only by where each ends. Under
    // a line:column identity these collapsed into one finding with
    // occurrences: 2, which hid one of them from the ratchet entirely.
    const assigned = assignAnchors([
      finding({
        anchor: 'a[0]!.b[0]!',
        locator: '120:18',
        evidence: { line: 120, column: 18, endColumn: 30 },
      }),
      finding({
        anchor: 'a[0]!.b[0]!',
        locator: '120:18',
        evidence: { line: 120, column: 18, endColumn: 51 },
      }),
    ]);
    expect(new Set(assigned.map((entry) => entry.id)).size).toBe(2);
  });

  test('assignment is deterministic across runs', () => {
    const build = (): string[] =>
      assignAnchors([
        finding({ anchor: 'x', locator: '5:1' }),
        finding({ anchor: 'x', locator: '9:1' }),
        finding({ anchor: 'x', locator: '1:1' }),
      ]).map((entry) => entry.id);
    expect(build()).toEqual(build());
  });

  test('a sibling changing status does not renumber its neighbours', () => {
    // Ordinals depend on position, not on status. If only failures were
    // counted, the finding at line 9 would be `x` while the line 5 finding
    // passed and would become `x#1` once it failed - so one finding changing
    // status would report an already-accepted finding as new debt.
    const at = (entries: Finding[], locator: string): string | undefined =>
      entries.find((entry) => entry.locator === locator)?.id;

    const siblingPasses = assignAnchors([
      finding({ anchor: 'x', locator: '5:1', status: 'pass' }),
      finding({ anchor: 'x', locator: '9:1', status: 'fail' }),
    ]);
    const siblingFails = assignAnchors([
      finding({ anchor: 'x', locator: '5:1', status: 'fail' }),
      finding({ anchor: 'x', locator: '9:1', status: 'fail' }),
    ]);

    expect(at(siblingPasses, '9:1')).toBe(at(siblingFails, '9:1'));
    expect(at(siblingPasses, '9:1')).toBe('complexity::src/a.ts::x#1');
  });
});
