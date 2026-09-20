/**
 * Ownership fixtures.
 *
 * The condition these exist for, measured on this repository before the fix:
 * all three accepted baselines - 8,001 entries - carried
 * `acceptance.owner === null`. Every one. `acceptedBy` was filled in for all of
 * them, so the engine knew who had *approved* the tolerance and had no idea who
 * was answerable for it. "Accepted legacy, owned by nobody" is debt that can only
 * be repaid by someone who decides, unprompted, to go looking for it.
 *
 * The theme is the same as every other fixture here: a field that is present and
 * empty must never be read as a field that is fine. So these cases pin the
 * derivation, the reasons it can fail, and the fact that a role reassignment
 * moves findings visibly instead of quietly.
 */
import { describe, expect, test } from 'bun:test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createFixtureTree } from './tree';
import { loadSourceUniverse } from '../lib/sourceUniverse';
import { attributeSubject, ownershipDrift } from '../lib/ownership';

/**
 * The universe is enumerated from git, not from the filesystem - that is how the
 * engine tells a tracked file from a generated one. A fixture tree that is not a
 * repository therefore cannot exercise it at all, and `requireGit` throws rather
 * than returning an empty list, which is the correct behaviour: an empty universe
 * that looks like a measured one is the failure mode every other fixture here
 * exists to prevent. So these trees are real repositories.
 */
const GIT = { git: true } as const;

const MANIFEST = {
  version: 1,
  owner: 'gateway-maintainers',
  rationale: 'fixture',
  extensions: ['.ts'],
  roles: [
    {
      name: 'production-source',
      description: 'shipped',
      glob: 'src/**/*.ts',
      checks: ['lint'],
      owner: 'product-team',
      proof: 'fixture',
    },
    {
      name: 'harness-tooling',
      description: 'scripts',
      glob: 'scripts/**/*.ts',
      checks: ['lint'],
      owner: 'tooling-team',
      proof: 'fixture',
    },
  ],
};

function universeFor(
  tree: ReturnType<typeof createFixtureTree>,
  body: unknown = MANIFEST
) {
  // The universe is enumerated from the files that EXIST and are tracked, so a
  // manifest alone yields an empty universe and every subject reads as
  // unclassified - which would make these fixtures pass the "unowned" cases for
  // entirely the wrong reason. The files are written first, then the manifest.
  tree.write('src/cli/print.ts', 'export const a = 1;\n');
  tree.write('src/a.ts', 'export const b = 2;\n');
  tree.write('scripts/build.ts', 'export const c = 3;\n');

  mkdirSync(join(tree.root, '.quality', 'policy'), { recursive: true });
  writeFileSync(
    join(tree.root, '.quality', 'policy', 'source-universe.json'),
    JSON.stringify(body, null, 2),
    'utf8'
  );
  return loadSourceUniverse(tree.root);
}

describe('an owner is inherited from the role that owns the file', () => {
  test('the owner of a finding is the owner of the code it is about', () => {
    const tree = createFixtureTree(GIT);
    try {
      const universe = universeFor(tree);

      const shipped = attributeSubject(universe, 'src/cli/print.ts');
      expect(shipped.owner).toBe('product-team');
      expect(shipped.source).toBe('inherited');
      expect(shipped.role).toBe('production-source');

      const tooling = attributeSubject(universe, 'scripts/build.ts');
      expect(tooling.owner).toBe('tooling-team');
      expect(tooling.role).toBe('harness-tooling');
    } finally {
      tree.cleanup();
    }
  });

  test('the reason names the role, so the derivation can be checked', () => {
    const tree = createFixtureTree(GIT);
    try {
      const universe = universeFor(tree);
      const attribution = attributeSubject(universe, 'src/cli/print.ts');
      expect(attribution.reason).toContain('production-source');
      expect(attribution.reason).toContain('src/cli/print.ts');
      expect(attribution.reason.trim()).not.toBe('');
    } finally {
      tree.cleanup();
    }
  });

  test('a repository-level finding is unowned WITH A REASON, never defaulted', () => {
    const tree = createFixtureTree(GIT);
    try {
      const universe = universeFor(tree);
      // `subject === ''` is real - some findings are about the repository rather
      // than a file. A plausible fallback owner here would be the worst outcome:
      // an unattributable finding that looks routed to a team that never saw it.
      const attribution = attributeSubject(universe, '');
      expect(attribution.owner).toBeNull();
      expect(attribution.source).toBe('unattributable');
      expect(attribution.reason).toContain('no file subject');
    } finally {
      tree.cleanup();
    }
  });

  test('a subject no role claims is unowned, and says so as a condition to fix', () => {
    const tree = createFixtureTree(GIT);
    try {
      const universe = universeFor(tree);
      const attribution = attributeSubject(universe, 'docs/readme.ts');
      expect(attribution.owner).toBeNull();
      expect(attribution.role).toBeNull();
      expect(attribution.reason).toContain('matches no source-universe role');
      expect(attribution.reason).toContain('nobody has decided how to measure');
    } finally {
      tree.cleanup();
    }
  });

  test('a role with a blank owner is a manifest defect, not a silent null', () => {
    const tree = createFixtureTree(GIT);
    try {
      const universe = universeFor(tree, {
        ...MANIFEST,
        roles: MANIFEST.roles.map((role) =>
          role.name === 'production-source' ? { ...role, owner: '  ' } : role
        ),
      });
      const attribution = attributeSubject(universe, 'src/a.ts');
      expect(attribution.owner).toBeNull();
      expect(attribution.reason).toContain('declares no owner');
      expect(attribution.reason).toContain('fix the role');
    } finally {
      tree.cleanup();
    }
  });
});

describe('a reassignment is visible rather than quiet', () => {
  test('findings that change hands are reported, with the direction', () => {
    const tree = createFixtureTree(GIT);
    try {
      const universe = universeFor(tree);
      const entries = [
        {
          id: 'MAINT-001::src/a.ts::1',
          subject: 'src/a.ts',
          acceptance: {
            owner: 'product-team',
            ownerSource: 'inherited' as const,
            ownerRole: 'production-source',
          },
        },
      ];
      expect(ownershipDrift(universe, entries)).toHaveLength(0);

      // The legitimate policy edit: src moves from the product team to tooling.
      const moved = universeFor(
        tree,
        {
          ...MANIFEST,
          roles: MANIFEST.roles.map((role) =>
            role.name === 'production-source'
              ? { ...role, owner: 'tooling-team' }
              : role
          ),
        }
      );
      const drift = ownershipDrift(moved, entries);
      expect(drift).toHaveLength(1);
      expect(drift[0].recordedOwner).toBe('product-team');
      expect(drift[0].currentOwner).toBe('tooling-team');
      expect(drift[0].recordedRole).toBe('production-source');
    } finally {
      tree.cleanup();
    }
  });

  test('an explicitly named owner is not reported as drift', () => {
    const tree = createFixtureTree(GIT);
    try {
      const universe = universeFor(tree);
      // A human named an accountable team for this specific acceptance. A later
      // manifest edit does not overturn that decision, and reporting it would be
      // noise - and noise is how a real transfer gets ignored.
      const drift = ownershipDrift(universe, [
        {
          id: 'MAINT-001::src/a.ts::1',
          subject: 'src/a.ts',
          acceptance: {
            owner: 'someone-who-said-yes',
            ownerSource: 'explicit',
            ownerRole: null,
          },
        },
      ]);
      expect(drift).toHaveLength(0);
    } finally {
      tree.cleanup();
    }
  });

  test('an entry with no recorded provenance is not reported, because nothing was claimed', () => {
    const tree = createFixtureTree(GIT);
    try {
      const universe = universeFor(tree);
      // Every entry in the three existing baselines is shaped exactly like this:
      // owner null, no source, no role. They are the reason the feature exists,
      // and the honest reading of them is "ownership was never derived" - not
      // "ownership drifted". Reporting 8,001 drifts would bury the real ones.
      const drift = ownershipDrift(universe, [
        {
          id: 'MAINT-001::src/a.ts::1',
          subject: 'src/a.ts',
          acceptance: {
            owner: null,
            ownerSource: undefined,
            ownerRole: undefined,
          },
        },
      ]);
      expect(drift).toHaveLength(0);
    } finally {
      tree.cleanup();
    }
  });
});
