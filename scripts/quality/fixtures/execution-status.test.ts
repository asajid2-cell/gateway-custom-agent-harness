/**
 * The analyzer execution-status contract.
 *
 * The permanent engine rule, stated as the thing that must never happen:
 *
 *   AN ANALYZER INTERNAL EXCEPTION MUST NEVER DEGRADE INTO "ZERO FINDINGS".
 *
 * The failure this pins is a chain, and every link in it is individually
 * reasonable:
 *
 *   1. a traversal throws;
 *   2. a `catch` around it returns `[]`;
 *   3. the run reports no findings;
 *   4. the gate sees a smaller finding set than the baseline;
 *   5. the missing findings are reported as RESOLVED.
 *
 * Nothing lies at any single step. The bug is that "the walk failed" and "the
 * walk found nothing" were the same value. This fixture exists because that
 * exact defect was found in this engine: `engineImplementationFiles` called
 * `.map` on `walkFiles`'s `{files, truncated}` return, the throw was caught, the
 * `catch` returned `[]`, and the digest silently covered nothing while the gate
 * still passed. It was caught only by counting the files.
 *
 * The tests below therefore assert on the OUTCOME of a throw, not on the
 * absence of one: a thrown analyzer must produce a result the gate refuses.
 */
import { describe, expect, test } from 'bun:test';
import { runAnalyzer, clearRegistryForTest, registerAnalyzer } from '../lib/registry';
import { compare } from '../lib/compare';
import { proposeBaseline } from '../lib/baseline';
import { createFixtureTree } from './tree';
import type {
  Analyzer,
  AnalyzerContext,
  AnalyzerResult,
  CandidateIdentity,
  Finding,
} from '../lib/types';

const ACCEPTANCE = {
  reason: 'fixture',
  acceptedBy: 'tester',
  owner: null,
  expiresAt: null,
};

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
    ...overrides,
  };
}

function contextFor(tree: ReturnType<typeof createFixtureTree>): AnalyzerContext {
  const files = tree.tracked();
  return {
    repoRoot: tree.root,
    candidateFiles: files,
    universe: {
      version: 1,
      owner: 'fixture',
      rationale: 'fixture',
      extensions: ['.ts'],
      roles: [],
      byRole: new Map(),
      unclassified: [],
      files,
      roleOf: () => null,
      eligibleFor: () => files,
    },
    runtimeRoots: [],
    absolute: (relativePath: string) => tree.abs(relativePath),
    trackedFiles: new Set(files),
    cacheDir: tree.abs('.quality/.cache/fixture'),
    notes: [],
  };
}

describe('a thrown analyzer becomes a failed execution, not an empty result', () => {
  test('an analyzer whose traversal throws reports status failed with no findings', async () => {
    const tree = createFixtureTree();
    try {
      tree.write('src/a.ts', 'export const a = 1;\n');
      tree.track('src/a.ts');

      const throwing: Analyzer = {
        id: 'throwing-analyzer',
        description: 'fixture: throws during traversal',
        rules: { 'X-001': 'fixture rule' },
        extensions: ['.ts'],
        capabilities: ['syntax'],
        run(): AnalyzerResult {
          // The shape of the real defect: a walk that throws inside a try whose
          // catch returns an empty list. The throw here is what the engine must
          // convert into a status, because the analyzer cannot be trusted to
          // detect its own swallowed exception.
          throw new Error('traversal blew up');
        },
      };

      const result = await runAnalyzer(throwing, contextFor(tree));

      expect(result.status).toBe('failed');
      expect(result.complete).toBe(false);
      // Findings are empty AND that emptiness is not a claim about the code.
      // The status is what distinguishes the two.
      expect(result.findings).toHaveLength(0);
      expect(result.errors[0]?.message).toContain('traversal blew up');
      expect(result.notes.join(' ')).toContain('not because nothing was found');
    } finally {
      tree.cleanup();
    }
  });

  test('the failed result cannot pass the gate even with a matching baseline', async () => {
    const tree = createFixtureTree();
    try {
      tree.write('src/a.ts', 'export const a = 1;\n');
      tree.track('src/a.ts');

      const baseline = proposeBaseline(
        tree.root,
        'throwing-analyzer',
        {
          analyzer: 'throwing-analyzer',
          findings: [finding()],
          errors: [],
          coverage: { eligible: 1, scanned: 1, skipped: 0, failed: 0, skipReasons: {} },
          complete: true,
          status: 'complete',
          notes: [],
        },
        candidate(),
        ACCEPTANCE
      ).baseline;

      const throwing: Analyzer = {
        id: 'throwing-analyzer',
        description: 'fixture',
        rules: { 'X-001': 'fixture rule' },
        extensions: ['.ts'],
        capabilities: ['syntax'],
        run(): AnalyzerResult {
          throw new Error('traversal blew up');
        },
      };

      const result = await runAnalyzer(throwing, contextFor(tree));
      const gate = compare({
        analyzer: 'throwing-analyzer',
        profile: 'research',
        baseline,
        result,
        candidateAtStart: candidate(),
        candidateAtFinish: candidate(),
        repoRoot: tree.root,
      });

      expect(gate.decision).toBe('INCOMPLETE');
      // The critical assertion: the baselined finding is NOT resolved. If the
      // empty list were treated as a measurement, this is where debt would
      // disappear without anyone seeing the list.
      expect(gate.resolvedFindings).toHaveLength(0);
      expect(gate.completeness).toBe('incomplete');
    } finally {
      tree.cleanup();
    }
  });

  test('a failed result records coverage that cannot be read as a clean sweep', async () => {
    const tree = createFixtureTree();
    try {
      tree.write('src/a.ts', 'export const a = 1;\n');
      tree.write('src/b.ts', 'export const b = 1;\n');
      tree.track('src/a.ts');
      tree.track('src/b.ts');

      const analyzer: Analyzer = {
        id: 'throwing-analyzer',
        description: 'fixture',
        rules: {},
        extensions: ['.ts'],
        capabilities: ['syntax'],
        run(): AnalyzerResult {
          throw new Error('boom');
        },
      };

      const result = await runAnalyzer(analyzer, contextFor(tree));
      // `failed` is non-zero and `scanned` is zero, so the arithmetic refuses
      // completeness on its own terms - the status is a second, independent
      // guard rather than the only one.
      expect(result.coverage.scanned).toBe(0);
      expect(result.coverage.failed).toBeGreaterThan(0);
      expect(result.coverage.skipReasons['analyzer-threw']).toBe(1);
    } finally {
      tree.cleanup();
    }
  });

  test('a registered analyzer that throws is caught, not propagated', async () => {
    const tree = createFixtureTree();
    try {
      tree.write('src/a.ts', 'export const a = 1;\n');
      tree.track('src/a.ts');

      clearRegistryForTest();
      try {
        registerAnalyzer({
          id: 'throwing-analyzer',
          description: 'fixture',
          rules: {},
          extensions: ['.ts'],
          capabilities: ['syntax'],
          run(): AnalyzerResult {
            throw new Error('registered analyzer threw');
          },
        });

        const { getAnalyzer } = await import('../lib/registry');
        const result = await runAnalyzer(getAnalyzer('throwing-analyzer'), contextFor(tree));
        // Without the wrapper this await would reject, and every caller would
        // have to invent its own reading of "the analyzer did not return".
        expect(result.status).toBe('failed');
      } finally {
        clearRegistryForTest();
      }
    } finally {
      tree.cleanup();
    }
  });
});
