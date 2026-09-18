/**
 * Source-universe and runtime-root fixtures.
 *
 * These pin the separation of two questions that used to share one list:
 *
 *   SOURCE UNIVERSE - which files may be inspected, and under which role.
 *   RUNTIME ROOTS   - from where a reachability walk starts.
 *
 * The defect being prevented is specific and was measured on this repository:
 * using the runtime-root list as scope authority drops `globals.d.ts` and
 * `scripts/quality/fixtures/*`, because nothing imports them at runtime. Those
 * files are read by reviewers and carry accepted findings. They are not
 * unreachable code; they were simply never runtime artifacts. One list cannot
 * hold both facts without one silently winning.
 */
import { describe, expect, test } from 'bun:test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createFixtureTree } from './tree';
import { loadSourceUniverse } from '../lib/sourceUniverse';
import { loadRuntimeRoots } from '../lib/runtimeRoots';
import { globToRegExp } from '../lib/glob';

function manifest(tree: ReturnType<typeof createFixtureTree>, body: unknown): void {
  mkdirSync(join(tree.root, '.quality', 'policy'), { recursive: true });
  writeFileSync(
    join(tree.root, '.quality', 'policy', 'source-universe.json'),
    JSON.stringify(body, null, 2),
    'utf8'
  );
}

const BASE_MANIFEST = {
  version: 1,
  owner: 'fixture',
  rationale: 'fixture',
  extensions: ['.ts', '.mjs', '.d.ts'],
  roles: [
    {
      name: 'production-source',
      description: 'shipped',
      path: 'src',
      checks: ['lint', 'clones', 'import-integrity'],
      owner: 'fixture',
      proof: 'fixture',
    },
    {
      name: 'declarations',
      description: 'ambient types',
      path: 'globals.d.ts',
      checks: ['lint'],
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
    {
      name: 'harness-tooling',
      description: 'everything else under scripts',
      glob: 'scripts/**/*.{ts,mjs}',
      checks: ['lint', 'clones'],
      owner: 'fixture',
      proof: 'fixture',
    },
  ],
};

describe('the universe is role-based, not root-based', () => {
  test('a file that no runtime walk reaches is still in the universe', () => {
    const tree = createFixtureTree({ git: true });
    try {
      tree.write('globals.d.ts', 'declare const x: number;\n');
      tree.write('src/a.ts', 'export const a = 1;\n');
      manifest(tree, BASE_MANIFEST);

      const universe = loadSourceUniverse(tree.root);
      // The whole point: nothing imports globals.d.ts, so no reachability walk
      // arrives at it, and it is nonetheless inspected - as a declaration, with
      // its own capability set.
      expect(universe.roleOf('globals.d.ts')).toBe('declarations');
      expect(universe.files).toContain('globals.d.ts');
      expect(universe.eligibleFor(['lint'])).toContain('globals.d.ts');
      // ...but it has no runtime imports, so an analyzer asking about import
      // integrity must not be handed it.
      expect(universe.eligibleFor(['import-integrity'])).not.toContain(
        'globals.d.ts'
      );
    } finally {
      tree.cleanup();
    }
  });

  test('a fixture is inspected for syntax but not for clones or complexity', () => {
    const tree = createFixtureTree({ git: true });
    try {
      tree.write('scripts/quality/fixtures/planted.ts', 'import "./missing.js";\n');
      tree.write('scripts/other.mjs', 'export const x = 1;\n');
      manifest(tree, BASE_MANIFEST);

      const universe = loadSourceUniverse(tree.root);
      const planted = 'scripts/quality/fixtures/planted.ts';
      expect(universe.roleOf(planted)).toBe('quality-fixture');
      // Fixtures deliberately contain unresolved specifiers and planted clones.
      // An engine that judges production code must not judge these, or every
      // fixture that tests a failure blocks the repository it tests.
      expect(universe.eligibleFor(['syntax'])).toContain(planted);
      expect(universe.eligibleFor(['clones'])).not.toContain(planted);
      expect(universe.eligibleFor(['complexity'])).not.toContain(planted);
    } finally {
      tree.cleanup();
    }
  });

  test('role order decides, so a narrow role is not absorbed by a broad one', () => {
    const tree = createFixtureTree({ git: true });
    try {
      tree.write('scripts/quality/fixtures/planted.ts', 'export const x = 1;\n');
      // Same manifest, reversed role order: the broad `scripts/**` glob now
      // matches first and the fixture inherits lint and clone checks. That is
      // the failure a manifest must not be able to make accidentally, so the
      // order is load-bearing and asserted.
      const reversed = {
        ...BASE_MANIFEST,
        roles: [...BASE_MANIFEST.roles].reverse(),
      };
      manifest(tree, reversed);

      const universe = loadSourceUniverse(tree.root);
      expect(universe.roleOf('scripts/quality/fixtures/planted.ts')).toBe(
        'harness-tooling'
      );
    } finally {
      tree.cleanup();
    }
  });

  test('a file matching no role is reported, not dropped', () => {
    const tree = createFixtureTree({ git: true });
    try {
      tree.write('src/a.ts', 'export const a = 1;\n');
      tree.write('loose/orphan.ts', 'export const o = 1;\n');
      manifest(tree, BASE_MANIFEST);

      const universe = loadSourceUniverse(tree.root);
      // Silence here is how a file stays unmeasured while every report says the
      // run was complete. The universe still contains it - it is in `files` -
      // but no analyzer is eligible for it and the run must say so.
      expect(universe.unclassified).toEqual(['loose/orphan.ts']);
      expect(universe.files).toContain('loose/orphan.ts');
      expect(universe.roleOf('loose/orphan.ts')).toBeNull();
      expect(universe.eligibleFor(['lint'])).not.toContain('loose/orphan.ts');
    } finally {
      tree.cleanup();
    }
  });

  test('an explicit exclude removes a file from the universe entirely', () => {
    const tree = createFixtureTree({ git: true });
    try {
      tree.write('src/a.ts', 'export const a = 1;\n');
      tree.write('src/generated.ts', 'export const g = 1;\n');
      manifest(tree, {
        ...BASE_MANIFEST,
        exclude: ['**/generated.ts'],
      });

      const universe = loadSourceUniverse(tree.root);
      // Exclusion is the only path out of the universe, and it is written down
      // as policy: an excluded file is absent rather than unclassified, which
      // means it cannot hide behind the "nothing matched" report either.
      expect(universe.files).not.toContain('src/generated.ts');
      expect(universe.unclassified).not.toContain('src/generated.ts');
    } finally {
      tree.cleanup();
    }
  });

  test('a manifest with no roles is refused rather than treated as empty', () => {
    const tree = createFixtureTree({ git: true });
    try {
      tree.write('src/a.ts', 'export const a = 1;\n');
      manifest(tree, { ...BASE_MANIFEST, roles: [] });
      // An empty role set makes every file unclassified, so the run would report
      // zero eligible files and look like a clean sweep of a smaller repository.
      expect(() => loadSourceUniverse(tree.root)).toThrow(/declares no roles/);
    } finally {
      tree.cleanup();
    }
  });
});

describe('runtime roots are entrypoints and nothing else', () => {
  function rootsManifest(
    tree: ReturnType<typeof createFixtureTree>,
    body: unknown
  ): void {
    mkdirSync(join(tree.root, '.quality', 'policy'), { recursive: true });
    writeFileSync(
      join(tree.root, '.quality', 'policy', 'runtime-roots.json'),
      JSON.stringify(body, null, 2),
      'utf8'
    );
  }

  test('roots resolve to entrypoint files, including a single-file root', () => {
    const tree = createFixtureTree({ git: true });
    try {
      tree.write('src/entrypoints/cli.tsx', 'export const cli = 1;\n');
      tree.write('src/other.ts', 'export const other = 1;\n');
      tree.write('scripts/model-gateway.mjs', 'export const gw = 1;\n');
      rootsManifest(tree, {
        version: 2,
        owner: 'fixture',
        rationale: 'fixture',
        extensions: ['.ts', '.tsx', '.mjs'],
        roots: [
          { path: 'src/entrypoints/cli.tsx', kind: 'cli', owner: 'f', proof: 'f' },
          { path: 'scripts/model-gateway.mjs', kind: 'gateway', owner: 'f', proof: 'f' },
        ],
      });

      const roots = loadRuntimeRoots(tree.root);
      // A file root must match itself. `src/entrypoints/cli.tsx/**` matches
      // nothing, which would silently produce a root set that looks declared
      // and resolves to zero entrypoints.
      expect(roots.entrypoints).toEqual([
        'scripts/model-gateway.mjs',
        'src/entrypoints/cli.tsx',
      ]);
      expect(roots.unmatchedRoots).toEqual([]);
    } finally {
      tree.cleanup();
    }
  });

  test('a directory root resolves to the files beneath it', () => {
    const tree = createFixtureTree({ git: true });
    try {
      tree.write('scripts/quality/fixtures/tree.ts', 'export const t = 1;\n');
      tree.write('scripts/quality/fixtures/a.test.ts', 'export const a = 1;\n');
      rootsManifest(tree, {
        version: 2,
        owner: 'fixture',
        rationale: 'fixture',
        extensions: ['.ts'],
        roots: [
          {
            path: 'scripts/quality/fixtures',
            kind: 'fixture-harness',
            owner: 'f',
            proof: 'f',
          },
        ],
      });

      const roots = loadRuntimeRoots(tree.root);
      expect(roots.entrypoints).toEqual([
        'scripts/quality/fixtures/a.test.ts',
        'scripts/quality/fixtures/tree.ts',
      ]);
    } finally {
      tree.cleanup();
    }
  });

  test('a root that matches nothing is reported, not silently ignored', () => {
    const tree = createFixtureTree({ git: true });
    try {
      tree.write('src/a.ts', 'export const a = 1;\n');
      rootsManifest(tree, {
        version: 2,
        owner: 'fixture',
        rationale: 'fixture',
        extensions: ['.ts'],
        roots: [
          { path: 'src', kind: 'product', owner: 'f', proof: 'f' },
          { path: 'scripts/vanished.ts', kind: 'gone', owner: 'f', proof: 'f' },
        ],
      });

      const roots = loadRuntimeRoots(tree.root);
      // A dead root is a silent scope change: reachability keeps working and
      // simply concludes less. Naming it is the difference between a narrower
      // measurement and a broken one.
      expect(roots.unmatchedRoots).toEqual(['scripts/vanished.ts']);
    } finally {
      tree.cleanup();
    }
  });

  test('an entrypoint need not be in any source role', () => {
    const tree = createFixtureTree({ git: true });
    try {
      // The two concepts are independent in BOTH directions. A launcher in a
      // language the analyzers do not parse is still where a walk starts.
      tree.write('scripts/launcher.mjs', 'export const l = 1;\n');
      rootsManifest(tree, {
        version: 2,
        owner: 'fixture',
        rationale: 'fixture',
        extensions: ['.mjs'],
        roots: [
          { path: 'scripts/launcher.mjs', kind: 'launcher', owner: 'f', proof: 'f' },
        ],
      });

      const roots = loadRuntimeRoots(tree.root);
      expect(roots.entrypoints).toContain('scripts/launcher.mjs');
    } finally {
      tree.cleanup();
    }
  });

  test('a manifest with no roots is refused rather than yielding an empty walk', () => {
    const tree = createFixtureTree({ git: true });
    try {
      rootsManifest(tree, {
        version: 2,
        owner: 'fixture',
        rationale: 'fixture',
        extensions: ['.ts'],
        roots: [],
      });
      // No roots means every file is unreachable, which is a confident wrong
      // answer rather than an empty one - so it is refused at load.
      expect(() => loadRuntimeRoots(tree.root)).toThrow(/declares no roots/);
    } finally {
      tree.cleanup();
    }
  });
});

describe('brace alternation in role globs', () => {
  test('{a,b} alternates within a segment', () => {
    const match = globToRegExp('scripts/**/*.{test,spec}.ts');
    expect(match.test('scripts/foo.test.ts')).toBe(true);
    expect(match.test('scripts/foo.spec.ts')).toBe(true);
    expect(match.test('scripts/nested/deep/foo.test.ts')).toBe(true);
    expect(match.test('scripts/foo.ts')).toBe(false);
  });

  test('braces may appear more than once in a pattern', () => {
    const match = globToRegExp('scripts/**/*.{test,spec}.{ts,mjs}');
    expect(match.test('scripts/a.test.mjs')).toBe(true);
    expect(match.test('scripts/a.spec.ts')).toBe(true);
    expect(match.test('scripts/a.ts')).toBe(false);
  });

  test('an unmatched brace is a literal, not a load-time throw', () => {
    // A typo in a role glob must not make the manifest unparseable: a manifest
    // that loads and matches too little still reports its unclassified files,
    // which is recoverable. One that throws at load is not.
    const match = globToRegExp('scripts/a{b.ts');
    expect(match.test('scripts/a{b.ts')).toBe(true);
    expect(match.test('scripts/ab.ts')).toBe(false);
  });
});
