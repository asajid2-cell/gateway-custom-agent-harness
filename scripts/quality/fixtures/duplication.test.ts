/**
 * Duplication fixtures: DUP-1 through DUP-10, plus the family model itself.
 *
 * A clone is a RELATION, not a defect at a place, so these fixtures are about
 * what happens to a family when the copies under it change. Each case is stated
 * as a change a person would actually make and answered by the real analyzer and
 * the real gate - jscpd is invoked for real, in a throwaway tree, and nothing
 * here mocks the detector.
 *
 * The cases, and the claim each one pins:
 *
 *   DUP-1  two copies accepted as legacy  -> the backlog is frozen, not blocked
 *   DUP-2  lines inserted above a copy    -> identity survives the shift
 *   DUP-3  a copy moved                   -> relocation, not new debt
 *   DUP-4  a third copy added             -> occurrences-increased, FAIL
 *   DUP-5  a copy deleted                 -> the family resolves
 *   DUP-6  identifiers renamed            -> same family, both directions
 *   DUP-7  a different algorithm, same size -> not a blocking finding
 *   DUP-8  repetition inside a fixture    -> scoped by ROLE, not a global ignore
 *   DUP-9  a scan that produced no input   -> FAILED, never a clean zero
 *   DUP-10 changed code vs the FULL corpus -> a changed-files-only scan is the bug
 *
 * The three fixtures that deliberately break the run - DUP-9, the tool-error case
 * and the caught-exception case - all assert the same thing from different
 * directions: the analyzer never reports an execution it could not perform as an
 * execution that found nothing.
 */
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runAnalyzer } from '../lib/registry';
import { compare } from '../lib/compare';
import { proposeBaseline } from '../lib/baseline';
import { createFixtureTree } from './tree';
import { loadSourceUniverse } from '../lib/sourceUniverse';
import { JSCPD_TOOL, duplicationAnalyzer } from '../adapters/duplication';
import { TOOL_HOME_ENV } from '../lib/toolHome';
import {
  familiesFromPairs,
  familyFingerprint,
  regionStartFor,
  shapeOf,
  membersKey,
  type ClonePair,
} from '../lib/cloneFamily';
import type {
  AnalyzerContext,
  CandidateIdentity,
  Finding,
} from '../lib/types';

// Every case here either spawns the detector or reads real files; the detector
// spawn is the slow part.
setDefaultTimeout(300_000);

/**
 * The repository this fixture lives in - the only place with the tool home.
 *
 * The detector is no longer fetched by `bun x`, which resolved from anywhere and
 * so worked from a temporary tree by accident. It is installed in one place with
 * a lockfile, and a fixture tree cannot carry a copy of it. Pointing the fixtures
 * at the real home is what exercises the real invocation path, and it is also the
 * only way these cases can assert that the detector was VERIFIED rather than
 * merely present.
 */
const REAL_ROOT = resolve(import.meta.dir, '..', '..', '..');
const REAL_TOOL_HOME = join(REAL_ROOT, '.quality', 'tools');

/** Run `fn` with the tool home pointed at `home`, restoring the previous value. */
async function withToolHome<T>(home: string, fn: () => T | Promise<T>): Promise<T> {
  const previous = process.env[TOOL_HOME_ENV];
  process.env[TOOL_HOME_ENV] = home;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[TOOL_HOME_ENV];
    else process.env[TOOL_HOME_ENV] = previous;
  }
}

/**
 * A missing tool home is a FAILURE, not a skip. A skipped fixture and a passing
 * fixture are the same colour in every test report.
 */
function requireRealToolHome(): void {
  if (!existsSync(join(REAL_TOOL_HOME, ...JSCPD_TOOL.entrypoint.split('/')))) {
    throw new Error(
      `the pinned tool home is missing at ${REAL_TOOL_HOME}; run \`bun install\` ` +
        'inside it before running these fixtures'
    );
  }
}

const ACCEPTANCE = {
  reason: 'fixture',
  acceptedBy: 'tester',
  owner: null,
  expiresAt: null,
};

/**
 * The canonical duplicated block.
 *
 * Comfortably above the configured floors (50 tokens, 5 lines) so the mutations
 * below - a rename, an inserted line, an extra copy - cannot accidentally move a
 * case across a floor and change what it is testing. Deliberately not a
 * one-liner: a block that clears the token floor by being dense rather than long
 * would be invisible to the detector, which applies both floors.
 */
const BLOCK_A = `export function computeTotals(rows: Row[]): Total[] {
  const out: Total[] = [];
  for (const row of rows) {
    if (row.amount === null) continue;
    const gross = row.amount * row.quantity;
    const net = gross - row.discount;
    out.push({ id: row.id, net });
  }
  return out;
}
`;

/**
 * The same block, renamed consistently - `total`/`acc` style.
 *
 * Used for DUP-6 in the direction that matters most: a repo-wide rename lands in
 * EVERY copy at once, so the pairs stay `exact` and the only thing that could
 * make the family look new is its own identity text.
 */
const BLOCK_A_RENAMED = `export function collectSums(items: Item[]): Sum[] {
  const result: Sum[] = [];
  for (const item of items) {
    if (item.amount === null) continue;
    const before = item.amount * item.quantity;
    const after = before - item.discount;
    result.push({ key: item.key, after });
  }
  return result;
}
`;

/**
 * The same shape with DIFFERENT names in one copy, which is what makes a pair
 * `renamed` rather than `exact`: the matcher only reaches it by ignoring
 * identifiers.
 */
const BLOCK_A_OTHER_NAMES = `export function tally(lines: Line[]): Sum[] {
  const collected: Sum[] = [];
  for (const line of lines) {
    if (line.value === null) continue;
    const whole = line.value * line.count;
    const part = whole - line.rebate;
    collected.push({ id: line.id, part });
  }
  return collected;
}
`;

/**
 * A genuinely different algorithm of comparable size.
 *
 * DUP-7's subject. It must NOT produce a blocking finding: the two are alike in
 * length and in being loops, and a gate that blocked on that resemblance is the
 * gate people route around.
 */
const BLOCK_DIFFERENT = `export function indexByName(records: Record[]): Map<string, number> {
  const index = new Map<string, number>();
  let position = 0;
  while (position < records.length) {
    const record = records[position];
    if (typeof record.name === 'string') {
      index.set(record.name, position);
    }
    position += 1;
  }
  return index;
}
`;

function candidate(overrides: Partial<CandidateIdentity> = {}): CandidateIdentity {
  return {
    head: 'head-1',
    headDirty: false,
    trackedChangesDigest: 'changes-1',
    relevantUntrackedDigest: 'untracked-1',
    policyDigest: 'policy-1',
    measurementDigest: 'measurement-1',
    toolchainDigest: 'toolchain-1',
    computedAt: '2026-09-17T00:00:00.000Z',
    sourceDigest: 'source-1',
    ...overrides,
  };
}

/**
 * The context the CLI would build, for a fixture tree.
 *
 * The universe is a stub here because scope is not what these fixtures are about
 * - except for DUP-8, which builds a real manifest with `loadSourceUniverse` and
 * passes its `eligibleFor(['clones'])` result in, exactly as the CLI does.
 */
function contextFor(root: string, files: string[]): AnalyzerContext {
  const sorted = [...files].sort();
  return {
    repoRoot: root,
    candidateFiles: sorted,
    universe: {
      version: 1,
      owner: 'fixture',
      rationale: 'fixture',
      extensions: ['.ts'],
      roles: [],
      byRole: new Map(),
      unclassified: [],
      files: sorted,
      roleOf: () => null,
      eligibleFor: () => sorted,
    },
    runtimeRoots: [],
    absolute: (relativePath: string) => join(root, relativePath),
    trackedFiles: new Set(sorted),
    cacheDir: join(root, '.quality', '.cache', 'duplication'),
    notes: [],
  };
}

async function analyze(root: string, files: string[]) {
  return withToolHome(REAL_TOOL_HOME, () =>
    runAnalyzer(duplicationAnalyzer, contextFor(root, files))
  );
}

/** The single DUP-001 finding for a tree with exactly one clone family. */
function onlyFinding(findings: Finding[]): Finding {
  expect(findings).toHaveLength(1);
  return findings[0] as Finding;
}

/** Where a finding says its copies are, as `path:start-end|...`. */
function memberList(finding: Finding): string {
  return String(finding.evidence.members ?? '');
}

/**
 * Delete a file from a fixture tree.
 *
 * `createFixtureTree` has no `remove`, and a delete is not a detail these cases
 * can skip: "the copy is gone" is the event DUP-5 is about, and a file left on
 * disk would make the family still look duplicated.
 */
function remove(tree: ReturnType<typeof createFixtureTree>, relPath: string): void {
  rmSync(tree.abs(relPath), { force: true });
}

describe('a clone family is a relation with a multiplicity', () => {
  test('three identical copies are ONE family of three, not three pairs', () => {
    // jscpd reports pairs, so three copies arrive as three pairs. Without
    // grouping, the occurrence count is meaningless and a ratchet that cannot
    // count copies cannot tell consolidation from duplication.
    const region = (path: string) => ({ path, startLine: 10, endLine: 20 });
    const pair = (a: string, b: string): ClonePair => ({
      first: region(a),
      second: region(b),
      fragment: BLOCK_A,
      kind: 'exact',
      tokens: 60,
      lines: 10,
    });

    const families = familiesFromPairs([
      pair('src/a.ts', 'src/b.ts'),
      pair('src/a.ts', 'src/c.ts'),
      pair('src/b.ts', 'src/c.ts'),
    ]);

    expect(families).toHaveLength(1);
    expect(families[0]?.members).toHaveLength(3);
    expect(membersKey(families[0]?.members ?? [])).toBe(
      'src/a.ts:10-20|src/b.ts:10-20|src/c.ts:10-20'
    );
  });

  test('two regions in ONE file are two members, not one', () => {
    // The de-duplication is by LOCATION, so an intra-file clone does not collapse
    // into a single member and report a two-copy clone as a single occurrence.
    const families = familiesFromPairs([
      {
        first: { path: 'src/a.ts', startLine: 1, endLine: 12 },
        second: { path: 'src/a.ts', startLine: 40, endLine: 51 },
        fragment: BLOCK_A,
        kind: 'exact',
        tokens: 60,
        lines: 12,
      },
    ]);

    expect(families[0]?.members).toHaveLength(2);
  });

  test('a family reduced to one region is not a clone at all', () => {
    // A single occurrence is the definition of not being duplicated. The check is
    // enforced here rather than trusted from the tool, whose own accounting counts
    // files participating in clones rather than copies.
    const families = familiesFromPairs([
      {
        first: { path: 'src/a.ts', startLine: 1, endLine: 12 },
        second: { path: 'src/a.ts', startLine: 1, endLine: 12 },
        fragment: BLOCK_A,
        kind: 'exact',
        tokens: 60,
        lines: 12,
      },
    ]);

    expect(families).toHaveLength(0);
  });

  test('a type-3 similar pair contributes nothing', () => {
    const families = familiesFromPairs([
      {
        first: { path: 'src/a.ts', startLine: 1, endLine: 12 },
        second: { path: 'src/b.ts', startLine: 1, endLine: 12 },
        fragment: BLOCK_A,
        kind: 'similar',
        tokens: 60,
        lines: 12,
      },
    ]);

    expect(families).toHaveLength(0);
  });

  test('the identity is the SHAPE digest, so a rename does not disturb it', () => {
    // The property the whole shape fingerprint exists for. If the identity were
    // the readable source line, renaming a variable in every copy would read as
    // every family being replaced by a new one, and the ratchet could not be
    // advanced while the replacements exist.
    expect(familyFingerprint(BLOCK_A)).toBe(familyFingerprint(BLOCK_A_RENAMED));
    // The readable line is carried separately, and it IS expected to change.
    expect(regionStartFor(BLOCK_A)).toBe(
      'export function computeTotals(rows: Row[]): Total[] {'
    );
    expect(regionStartFor(BLOCK_A_RENAMED)).not.toBe(regionStartFor(BLOCK_A));
  });

  test('the leading 200 characters of a shape are NOT an identity', () => {
    // The reason the family's identity is a digest. The two shapes have to be
    // longer than the anchor cap for the property to be about the cap rather than
    // about a short block, so the body is generated long enough on purpose.
    const body = '  total += row.amount * row.quantity - row.discount;\n'.repeat(12);
    const base = `function digest(rows) {\n${body}  return total;\n}\n`;
    const longer = `${base}\nfunction extra(rows) {\n  return digest(rows) + 1;\n}\n`;

    expect(shapeOf(base).length).toBeGreaterThan(200);
    expect(shapeOf(longer)).not.toBe(shapeOf(base));
    // Different shapes, identical first 200 characters - so an anchor of the
    // prefix would need a disambiguation pass and the digest needs none.
    expect(shapeOf(longer).slice(0, 200)).toBe(shapeOf(base).slice(0, 200));
    expect(familyFingerprint(longer)).not.toBe(familyFingerprint(base));
  });

  test('a region that is a SUPERSET of another is a different family, not a suffix', () => {
    // The defect that made the anchor a digest. Two regions where one extends the
    // other share their entire opening, so a truncated shape prefix is identical
    // for both while being two families - and that is not a hypothetical: twelve
    // families on this repository collided on exactly this.
    //
    // Pinned as an identity property rather than as a prefix length, because the
    // requirement is that identity is exact, not that the cap is a particular
    // number: an ordinal suffix satisfies a collision check while still
    // renumbering when a third such family appears between two existing ones.
    const shorter = `function tally(rows) {\n  const total = 0;\n  for (const row of rows) {\n    total += row.amount;\n  }\n  return total;\n}\n`;
    const longer = `${shorter}function subtotal(rows) {\n  return tally(rows) / 2;\n}\n`;

    expect(regionStartFor(longer)).toBe(regionStartFor(shorter));

    const make = (fragment: string, path: string): ClonePair => ({
      first: { path: `${path}-1.ts`, startLine: 1, endLine: 12 },
      second: { path: `${path}-2.ts`, startLine: 1, endLine: 12 },
      fragment,
      kind: 'exact',
      tokens: 60,
      lines: 12,
    });

    const families = familiesFromPairs([
      make(shorter, 'src/short'),
      make(longer, 'src/long'),
    ]);
    expect(families).toHaveLength(2);
    // Both open with the same text - which is what would have made a prefix
    // collide - and their identities still differ.
    expect(families[0]?.regionStart).toBe(families[1]?.regionStart);
    expect(families[0]?.fingerprint).not.toBe(families[1]?.fingerprint);
  });

  test('a region opening on a closing brace is described by the code inside it', () => {
    // Measured on this repository: 197 of 2,740 families opened on `}`. A reviewer
    // handed `}` as the region's first line has been told nothing about which
    // block this is.
    const fragment = `  }
  for (const row of rows) {
    total += row.amount;
  }`;

    expect(regionStartFor(fragment)).toBe('for (const row of rows) {');
  });

  test('an all-comment region has no shape and belongs to no family', () => {
    // Grouping these at the empty key would put every comment-only region in the
    // repository into a single family.
    expect(familyFingerprint('// nothing here\n/* nor here */\n')).toBe('');
    expect(regionStartFor('   \n\n')).toBe('');
  });
});

describe('DUP-1..DUP-6: the lifecycle of one family', () => {
  test('DUP-1: two copies are reported, and accepting them freezes the backlog', async () => {
    const tree = createFixtureTree();
    try {
      tree.write('src/a.ts', BLOCK_A);
      tree.write('src/b.ts', BLOCK_A);
      const files = ['src/a.ts', 'src/b.ts'];

      const result = await analyze(tree.root, files);
      expect(result.status).toBe('complete');
      const finding = onlyFinding(result.findings);
      expect(finding.subject).toBe('src/a.ts');
      expect(finding.occurrences).toBe(2);
      expect(finding.classification).toBe('duplicated-block');
      expect(memberList(finding)).toContain('src/b.ts');

      const baseline = proposeBaseline(
        tree.root,
        'duplication',
        result,
        candidate(),
        ACCEPTANCE
      ).baseline;
      expect(Object.keys(baseline.findings)).toHaveLength(1);

      // The unchanged tree against its own accepted baseline is a PASS: the
      // backlog is frozen rather than blocking forever.
      const gate = compare({
        analyzer: 'duplication',
        profile: 'research',
        baseline,
        result,
        candidateAtStart: candidate(),
        candidateAtFinish: candidate(),
        repoRoot: tree.root,
      });
      expect(gate.decision).toBe('PASS');
      expect(gate.dispositions['accepted-legacy']).toBe(1);
    } finally {
      tree.cleanup();
    }
  });

  test('DUP-2: inserting lines above a copy is not new debt', async () => {
    const tree = createFixtureTree();
    try {
      tree.write('src/a.ts', BLOCK_A);
      tree.write('src/b.ts', BLOCK_A);
      const files = ['src/a.ts', 'src/b.ts'];

      const before = await analyze(tree.root, files);
      const baseline = proposeBaseline(
        tree.root,
        'duplication',
        before,
        candidate(),
        ACCEPTANCE
      ).baseline;
      const baselineFinding = onlyFinding(before.findings);

      // Lines inserted ABOVE the block: the region slides down, but nothing about
      // it changed. This is the single most common artifact of ordinary editing
      // and the reason identity cannot be a position.
      tree.write(
        'src/a.ts',
        `import { Row, Total } from './types';\n\n` +
          `/** Totals for the rows that carry an amount. */\n` +
          BLOCK_A
      );

      const after = await analyze(tree.root, files);
      const finding = onlyFinding(after.findings);
      expect(finding.id).toBe(baselineFinding.id);
      // Same identity, different place: the locator moved, which is what a locator
      // is for.
      expect(finding.locator).not.toBe(baselineFinding.locator);

      const gate = compare({
        analyzer: 'duplication',
        profile: 'research',
        baseline,
        result: after,
        candidateAtStart: candidate(),
        candidateAtFinish: candidate(),
        repoRoot: tree.root,
      });
      expect(gate.newFindings).toHaveLength(0);
      expect(gate.resolvedFindings).toHaveLength(0);
      expect(gate.decision).toBe('PASS');
    } finally {
      tree.cleanup();
    }
  });

  test('DUP-3: renaming a file that is not the subject is a non-event', async () => {
    const tree = createFixtureTree();
    try {
      tree.write('src/a.ts', BLOCK_A);
      tree.write('src/b.ts', BLOCK_A);
      const files = ['src/a.ts', 'src/b.ts'];

      const before = await analyze(tree.root, files);
      const baseline = proposeBaseline(
        tree.root,
        'duplication',
        before,
        candidate(),
        ACCEPTANCE
      ).baseline;

      // The family's subject is its SMALLEST member path, so relocating a larger
      // member changes evidence without touching the identity. This is the copy-
      // versus-move distinction at its cheapest: the members list is what moved.
      tree.write('src/moved/b.ts', BLOCK_A);
      remove(tree, 'src/b.ts');

      const after = await analyze(tree.root, ['src/a.ts', 'src/moved/b.ts']);
      const finding = onlyFinding(after.findings);
      expect(finding.id).toBe(onlyFinding(before.findings).id);
      expect(memberList(finding)).toContain('src/moved/b.ts');

      const gate = compare({
        analyzer: 'duplication',
        profile: 'research',
        baseline,
        result: after,
        candidateAtStart: candidate(),
        candidateAtFinish: candidate(),
        repoRoot: tree.root,
      });
      expect(gate.newFindings).toHaveLength(0);
      expect(gate.decision).toBe('PASS');
    } finally {
      tree.cleanup();
    }
  });

  test('DUP-3b: renaming the SUBJECT file is reported as a move, not as debt', async () => {
    const tree = createFixtureTree();
    try {
      tree.write('src/a.ts', BLOCK_A);
      tree.write('src/b.ts', BLOCK_A);

      const before = await analyze(tree.root, ['src/a.ts', 'src/b.ts']);
      const baseline = proposeBaseline(
        tree.root,
        'duplication',
        before,
        candidate(),
        ACCEPTANCE
      ).baseline;
      expect(onlyFinding(before.findings).subject).toBe('src/a.ts');

      // Moving the smallest member changes the subject, so the id changes with it.
      // The relocation pass has to recognize this, or every file rename in a
      // repository reads as new debt - which is how a gate trains people to route
      // around it.
      tree.write('src/alt/a.ts', BLOCK_A);
      remove(tree, 'src/a.ts');

      const after = await analyze(tree.root, ['src/alt/a.ts', 'src/b.ts']);
      const gate = compare({
        analyzer: 'duplication',
        profile: 'research',
        baseline,
        result: after,
        candidateAtStart: candidate(),
        candidateAtFinish: candidate(),
        repoRoot: tree.root,
        detectMoves: true,
      });

      expect(gate.movedFindings).toHaveLength(1);
      expect(gate.newFindings).toHaveLength(0);
      // A relocated entry is NOT reported as resolved: the debt still exists, at a
      // new address, and calling it resolved would invite the resolution path to
      // delete an entry whose finding is still there.
      expect(gate.resolvedFindings).toHaveLength(0);
      expect(gate.decision).toBe('PASS');
    } finally {
      tree.cleanup();
    }
  });

  test('DUP-4: adding a third copy is new debt and blocks', async () => {
    const tree = createFixtureTree();
    try {
      tree.write('src/a.ts', BLOCK_A);
      tree.write('src/b.ts', BLOCK_A);
      const files = ['src/a.ts', 'src/b.ts'];

      const before = await analyze(tree.root, files);
      const baseline = proposeBaseline(
        tree.root,
        'duplication',
        before,
        candidate(),
        ACCEPTANCE
      ).baseline;

      tree.write('src/c.ts', BLOCK_A);

      const after = await analyze(tree.root, [...files, 'src/c.ts']);
      const finding = onlyFinding(after.findings);
      // Same family - the subject did not change - so this is a count change and
      // not a swap. That is exactly why the count has to be first-class.
      expect(finding.id).toBe(onlyFinding(before.findings).id);
      expect(finding.occurrences).toBe(3);

      const gate = compare({
        analyzer: 'duplication',
        profile: 'research',
        baseline,
        result: after,
        candidateAtStart: candidate(),
        candidateAtFinish: candidate(),
        repoRoot: tree.root,
      });
      expect(gate.decision).toBe('FAIL');
      expect(gate.worsened).toHaveLength(1);
      expect(gate.worsened[0]?.reason).toBe('occurrences-increased');
    } finally {
      tree.cleanup();
    }
  });

  test('DUP-5: deleting a copy resolves the family', async () => {
    const tree = createFixtureTree();
    try {
      tree.write('src/a.ts', BLOCK_A);
      tree.write('src/b.ts', BLOCK_A);

      const before = await analyze(tree.root, ['src/a.ts', 'src/b.ts']);
      const baseline = proposeBaseline(
        tree.root,
        'duplication',
        before,
        candidate(),
        ACCEPTANCE
      ).baseline;

      remove(tree, 'src/b.ts');

      // One region left is not a clone, so the family disappears entirely. The
      // resolution is DISCOVERED, never auto-accepted: the baseline is written by
      // a separate, deliberate act.
      const after = await analyze(tree.root, ['src/a.ts']);
      expect(after.findings).toHaveLength(0);

      const gate = compare({
        analyzer: 'duplication',
        profile: 'research',
        baseline,
        result: after,
        candidateAtStart: candidate(),
        candidateAtFinish: candidate(),
        repoRoot: tree.root,
      });
      expect(gate.resolvedFindings).toHaveLength(1);
      expect(gate.decision).toBe('PASS');
    } finally {
      tree.cleanup();
    }
  });

  test('DUP-6: renaming identifiers in every copy keeps the family, both directions', async () => {
    const tree = createFixtureTree();
    try {
      tree.write('src/a.ts', BLOCK_A);
      tree.write('src/b.ts', BLOCK_A);

      const before = await analyze(tree.root, ['src/a.ts', 'src/b.ts']);
      const baseline = proposeBaseline(
        tree.root,
        'duplication',
        before,
        candidate(),
        ACCEPTANCE
      ).baseline;
      const baselineFinding = onlyFinding(before.findings);

      // A repo-wide rename: both copies change, so the pair is still `exact` and
      // only the identity text could make this look like a new family.
      tree.write('src/a.ts', BLOCK_A_RENAMED);
      tree.write('src/b.ts', BLOCK_A_RENAMED);

      const after = await analyze(tree.root, ['src/a.ts', 'src/b.ts']);
      const finding = onlyFinding(after.findings);
      expect(finding.id).toBe(baselineFinding.id);
      expect((finding.evidence as Record<string, unknown>).cloneKind).toBe('exact');

      const gate = compare({
        analyzer: 'duplication',
        profile: 'research',
        baseline,
        result: after,
        candidateAtStart: candidate(),
        candidateAtFinish: candidate(),
        repoRoot: tree.root,
      });
      expect(gate.newFindings).toHaveLength(0);
      expect(gate.resolvedFindings).toHaveLength(0);
      expect(gate.decision).toBe('PASS');

      // And the other direction: ONE copy renamed differently. The matcher only
      // reaches this pair by ignoring identifiers, so the family is reported as
      // `renamed` - and it is still the SAME family, because the shape fingerprint
      // ignores names whether the tool called the pair exact or renamed.
      tree.write('src/b.ts', BLOCK_A_OTHER_NAMES);
      const renamed = await analyze(tree.root, ['src/a.ts', 'src/b.ts']);
      const renamedFinding = onlyFinding(renamed.findings);
      expect(renamedFinding.id).toBe(baselineFinding.id);
      expect((renamedFinding.evidence as Record<string, unknown>).cloneKind).toBe(
        'renamed'
      );
    } finally {
      tree.cleanup();
    }
  });
});

describe('DUP-7..DUP-10: what must NOT be reported, and what must not be missed', () => {
  test('DUP-7: a genuinely different algorithm of the same size is not a clone', async () => {
    const tree = createFixtureTree();
    try {
      tree.write('src/a.ts', BLOCK_A);
      tree.write('src/b.ts', BLOCK_DIFFERENT);

      const result = await analyze(tree.root, ['src/a.ts', 'src/b.ts']);
      expect(result.status).toBe('complete');
      // Two files, comparable size, both loops - and no blocking finding, because
      // type-3 similarity is deliberately not enabled. A gate that blocked on
      // "these are 85% similar" is a gate people learn to route around.
      expect(result.findings).toHaveLength(0);
    } finally {
      tree.cleanup();
    }
  });

  test('DUP-8: repetition inside a fixture is scoped by ROLE, not globally ignored', async () => {
    const tree = createFixtureTree({ git: true });
    try {
      const manifest = {
        version: 1,
        owner: 'fixture',
        rationale: 'fixture',
        extensions: ['.ts'],
        roles: [
          {
            name: 'production-source',
            description: 'shipped',
            path: 'src',
            checks: ['syntax', 'clones'],
            owner: 'fixture',
            proof: 'fixture',
          },
          {
            name: 'quality-fixture',
            description: 'planted inputs',
            glob: 'scripts/quality/fixtures/**',
            checks: ['syntax'],
            owner: 'fixture',
            proof: 'fixture',
          },
        ],
        exclude: ['**/node_modules/**', '**/dist/**'],
        unclassified: 'report',
      };
      tree.write('.quality/policy/source-universe.json', JSON.stringify(manifest));
      tree.write('src/a.ts', BLOCK_A);
      tree.write('src/b.ts', BLOCK_A);
      tree.write('scripts/quality/fixtures/planted-a.ts', BLOCK_A);
      tree.write('scripts/quality/fixtures/planted-b.ts', BLOCK_A);

      // Scope comes from the role model, exactly as the CLI derives it.
      const universe = loadSourceUniverse(tree.root);
      const eligible = universe.eligibleFor(['clones']);

      // The planted pair is a fixture: it is still inspected and still has to
      // parse, but it is not eligible for clone policy. That is a SCOPED decision
      // with an owner - not a path pattern hardcoded into the analyzer, which is
      // how an exception for one fixture quietly becomes an exception for
      // everything that resembles it.
      expect(universe.eligibleFor(['syntax'])).toContain(
        'scripts/quality/fixtures/planted-a.ts'
      );
      expect(eligible).not.toContain('scripts/quality/fixtures/planted-a.ts');

      const result = await withToolHome(REAL_TOOL_HOME, () =>
        runAnalyzer(duplicationAnalyzer, contextFor(tree.root, eligible))
      );
      // The production pair is reported; the fixture pair contributes nothing.
      const finding = onlyFinding(result.findings);
      expect(finding.subject).toBe('src/a.ts');
      expect(memberList(finding)).not.toContain('planted');
    } finally {
      tree.cleanup();
    }
  });

  test('DUP-9: a scan that produced no input is FAILED, never a clean zero', async () => {
    const tree = createFixtureTree();
    try {
      tree.write('src/a.ts', BLOCK_A);

      // Nothing eligible at all. "Found no clones" and "found no files" are
      // different claims and only one of them is about code; reporting this as a
      // PASS would let a scanner bug shrink scope to nothing and read as clean.
      const empty = await analyze(tree.root, []);
      expect(empty.status).toBe('failed');
      expect(empty.complete).toBe(false);
      expect(empty.findings).toHaveLength(0);
      expect(empty.coverage.scanned).toBe(0);
      expect(empty.errors.some((error) => error.subject === '<run>')).toBe(true);
    } finally {
      tree.cleanup();
    }
  });

  test('DUP-9b: a tree of only EMPTY files is a failed scan, not a passing one', async () => {
    const tree = createFixtureTree();
    try {
      tree.write('src/a.ts', '\n\n');
      tree.write('src/b.ts', '');

      const result = await analyze(tree.root, ['src/a.ts', 'src/b.ts']);
      expect(result.status).toBe('failed');
      expect(result.findings).toHaveLength(0);
      // The empties are still accounted for: a skip is a deliberate decision and
      // has to be nameable, not a silent removal from the count.
      expect(result.coverage.skipped).toBe(2);
    } finally {
      tree.cleanup();
    }
  });

  test('DUP-9c: a policy that silences the detector fails the run', async () => {
    const tree = createFixtureTree();
    try {
      tree.write('src/a.ts', BLOCK_A);
      tree.write('src/b.ts', BLOCK_A);
      // Measured: a size limit below every file makes jscpd analyze NOTHING and
      // still exit 0, with the only trace a warning on stderr. Under the current
      // adapter that cannot become a clean sweep, because the parse pre-pass
      // applies the SAME limit and finds nothing parsable either - so the two
      // agree, and the run is failed rather than empty.
      tree.write(
        'scripts/quality/policy/duplication.config.json',
        JSON.stringify({ version: 1, minTokens: 50, minLines: 5, maxBytes: 0 })
      );

      const result = await analyze(tree.root, ['src/a.ts', 'src/b.ts']);
      expect(result.status).toBe('failed');
      expect(result.findings).toHaveLength(0);
      expect(result.coverage.failed).toBe(2);
      expect(result.coverage.scanned).toBe(0);
    } finally {
      tree.cleanup();
    }
  });

  test('a tool that fails to run is a failed execution, not a clean report', async () => {
    const tree = createFixtureTree();
    try {
      tree.write('src/a.ts', BLOCK_A);
      tree.write('src/b.ts', BLOCK_A);
      // A negative token floor is accepted by our own policy reader and rejected
      // by the detector, which exits non-zero. Measured: exit 1, `invalid value:
      // integer -5, expected usize`. The report file is therefore never written,
      // and "no report" must not be readable as "no clones".
      tree.write(
        'scripts/quality/policy/duplication.config.json',
        JSON.stringify({ version: 1, minTokens: -5, minLines: 5, maxBytes: 16777216 })
      );

      const result = await analyze(tree.root, ['src/a.ts', 'src/b.ts']);
      expect(result.status).toBe('failed');
      expect(result.complete).toBe(false);
      expect(result.findings).toHaveLength(0);
      expect(result.coverage.scanned).toBe(0);
      expect(result.coverage.skipReasons['clone-detector-did-not-run']).toBe(1);
      expect(result.errors.some((error) => error.kind === 'scan-failure')).toBe(true);
    } finally {
      tree.cleanup();
    }
  });

  test('an analyzer that throws is a failed execution, not an empty result', async () => {
    const tree = createFixtureTree();
    try {
      tree.write('src/a.ts', BLOCK_A);
      tree.write('src/b.ts', BLOCK_A);
      // `cacheDir` lands on a path that cannot be created, so the detector's
      // output directory cannot be made and the analyzer throws before it can
      // measure anything. The engine's guard converts that into a status; the
      // point is that zero findings here is the ABSENCE of a measurement, and the
      // gate must not read it as a resolution.
      const context = contextFor(tree.root, ['src/a.ts', 'src/b.ts']);
      const broken: AnalyzerContext = {
        ...context,
        cacheDir: join(tree.abs('src/a.ts'), 'not-a-directory'),
      };

      // The tool home is pointed at the real one even though this case expects a
      // throw. Without it the throw would come from the missing tool home instead
      // of from the unwritable cache directory, and the case would pass while
      // testing a completely different path - the failure mode these fixtures
      // exist to prevent, one level up.
      const result = await withToolHome(REAL_TOOL_HOME, () =>
        runAnalyzer(duplicationAnalyzer, broken)
      );
      expect(result.status).toBe('failed');
      expect(result.complete).toBe(false);
      expect(result.findings).toHaveLength(0);
      expect(result.coverage.scanned).toBe(0);
      expect(result.coverage.skipReasons['analyzer-threw']).toBe(1);
    } finally {
      tree.cleanup();
    }
  });

  test('DUP-10: a changed copy is compared against the FULL eligible corpus', async () => {
    const tree = createFixtureTree();
    try {
      tree.write('src/a.ts', BLOCK_A);
      tree.write('src/b.ts', BLOCK_A);

      // The bug being excluded, stated as a measurement: if only the changed file
      // were handed to the detector, the clone would have no second copy in view
      // and would be reported as RESOLVED. Running that way produces exactly zero
      // findings here, which is what makes the next assertion meaningful rather
      // than vacuous.
      const changedOnly = await analyze(tree.root, ['src/b.ts']);
      expect(changedOnly.findings).toHaveLength(0);

      // The real call: the whole eligible corpus, so the changed copy is still
      // compared against the unchanged one - which is the copy that makes the
      // clone a clone.
      const full = await analyze(tree.root, ['src/a.ts', 'src/b.ts']);
      const finding = onlyFinding(full.findings);
      const members = memberList(finding);
      expect(members).toContain('src/a.ts');
      expect(members).toContain('src/b.ts');

      // ...and the unchanged file cannot be dropped from scope, because a clone is
      // a relation between two regions and one of them is not in the change set.
      expect(finding.occurrences).toBe(2);
    } finally {
      tree.cleanup();
    }
  });
});

/**
 * The detector is now installed in ONE place, so "the tool is missing" became a
 * reachable state that did not exist when `bun x` fetched it from a cache on
 * demand. This pins the response to it, because a missing instrument is exactly
 * the kind of condition that gets handled by falling back to something
 * convenient - and the convenient fallback here (`bun x jscpd`) is the
 * unreproducible invocation this whole change removes.
 */
describe('a missing instrument is a failed run, never a clean one', () => {
  test('DUP-11: an absent tool home fails the run and refuses to fall back', async () => {
    requireRealToolHome();
    const tree = createFixtureTree();
    try {
      tree.write('src/a.ts', BLOCK_A);
      tree.write('src/b.ts', BLOCK_A);

      const result = await withToolHome(
        join(tree.root, 'no-such-tool-home'),
        () => runAnalyzer(duplicationAnalyzer, contextFor(tree.root, ['src/a.ts', 'src/b.ts']))
      );

      expect(result.status).toBe('failed');
      expect(result.complete).toBe(false);
      // Zero findings, and the run says why. This is the distinction the whole
      // engine is built around: no clones found is a claim about the code, and
      // no detector run is the absence of one.
      expect(result.findings).toHaveLength(0);
      expect(result.coverage.scanned).toBe(0);
      const message = String(result.errors[0]?.message ?? '');
      expect(message).toContain('pinned clone detector is absent');
      // The refusal must name the forbidden alternative, so a future reader does
      // not "fix" this by restoring the invocation whose resolution is unhashed.
      expect(message).toContain('do NOT fall back');
    } finally {
      tree.cleanup();
    }
  });
});
