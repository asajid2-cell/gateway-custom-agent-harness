/**
 * Unused-structure fixtures: DEAD-1 through DEAD-17.
 *
 * This analyzer answers a question the other three cannot: not "is the code that
 * exists correct" but "does the code that exists need to". Its findings are
 * ABOUT ABSENCE - a file nothing reaches, an export nothing imports - and that is
 * the hardest kind of finding to trust, because the two ways to produce an empty
 * result (nothing is dead / nothing was ever examined) look identical from the
 * outside.
 *
 * Every case below is therefore stated twice over: what the analyzer reports, and
 * what it did in order to be entitled to report it. knip is invoked for real, in
 * a throwaway git repository; nothing here mocks the walk.
 *
 *   DEAD-1  an unused exported function        -> a finding
 *   DEAD-2  an unused file                     -> a finding
 *   DEAD-3  an unused direct dependency        -> a finding
 *   DEAD-4  a call site removed                -> an unchanged export becomes unused
 *   DEAD-5  a CLI entrypoint                   -> live
 *   DEAD-6  a hook entrypoint                  -> live
 *   DEAD-7  a worker/child-process entrypoint  -> live
 *   DEAD-8  a package script or launcher target-> live
 *   DEAD-9  a loader reached by name           -> live under a declared contract
 *   DEAD-10 feature()-guarded code             -> live, not lost to bundler semantics
 *   DEAD-11 a USER_TYPE-guarded path           -> live
 *   DEAD-12 a test-only helper                 -> reported in production, live in full
 *   DEAD-13 a missing runtime-root manifest    -> INCOMPLETE
 *   DEAD-14 an invalid analyzer configuration  -> INCOMPLETE
 *   DEAD-15 a run over no files                -> INCOMPLETE
 *   DEAD-16 an internal exception              -> INCOMPLETE, never PASS
 *   DEAD-17 `.gitignore` changed               -> the evidence for the old scope is void
 *
 * The cases share three knip invocations rather than one each, because the walk
 * is the expensive part and three trees would measure the same mechanism three
 * times. Which cases share which run is stated at each run.
 */
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { runAnalyzer } from '../lib/registry';
import { ANALYZER_POLICY_INPUTS, policyDigest } from '../lib/identity';
import { POLICY_INPUTS } from '../lib/hash';
import { loadSourceUniverse } from '../lib/sourceUniverse';
import { createFixtureTree, type FixtureTree } from './tree';
import {
  unusedStructureAnalyzer,
  KNIP_TOOL,
  POLICY_PATH,
  RULES,
} from '../adapters/unusedStructure';
import { TOOL_HOME_ENV } from '../lib/toolHome';
import type { AnalyzerResult, Finding } from '../lib/types';
// `AnalyzerContext` lives in `registry.ts` with the analyzer interface it pairs
// with, because registry is the one extension surface. Importing it from
// `lib/types` is not a style preference - those names were never exported from
// there, so the import silently resolved to nothing and every use of it degraded
// to `any`. Two sibling fixtures still do this; they predate this file and are
// left alone rather than repaired here.
import type { AnalyzerContext } from '../lib/registry';

// The walk is real and the tool is spawned per run; the real repository takes
// well over a minute per invocation, and a fixture tree is two orders of
// magnitude smaller but still spawns a solver.
setDefaultTimeout(300_000);

const ANALYZER = 'unused-structure';

/**
 * The repository this fixture lives in - the only place with the tool home.
 *
 * The walker is no longer fetched by `bun x`, which resolved from anywhere and so
 * worked from a temporary tree by accident. It is installed in one place with a
 * lockfile, and a fixture tree cannot carry a copy of it (30 MB across a thousand
 * files, and copying one per fixture is the defect the acceptance harness already
 * paid for once with `.candidate-build`). Pointing the fixtures at the real home
 * is what exercises the real invocation path.
 */
const REAL_ROOT = resolve(import.meta.dir, '..', '..', '..');
const REAL_TOOL_HOME = join(REAL_ROOT, '.quality', 'tools');

/**
 * Run `fn` with the tool home pointed at `home`.
 *
 * Restores the previous value rather than deleting it, so a nested use does not
 * silently unset an outer override.
 */
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
 * A missing tool home is a FAILURE, not a skip.
 *
 * A skipped fixture and a passing fixture are the same colour in every test
 * report. If the walker is not installed, these cases are not being tested and
 * saying so is the only honest outcome.
 */
function requireRealToolHome(): void {
  if (!existsSync(join(REAL_TOOL_HOME, ...KNIP_TOOL.entrypoint.split('/')))) {
    throw new Error(
      `the pinned tool home is missing at ${REAL_TOOL_HOME}; run \`bun install\` ` +
        'inside it before running these fixtures'
    );
  }
}

/**
 * The tree the three real runs operate on.
 *
 * One tree rather than seventeen. Each file below exists to make exactly one case
 * observable, and the comments say which: the point of a shared tree is that a
 * single walk answers all of them without any of them being simulated.
 */
const FILES: Record<string, string> = {
  'package.json': `${JSON.stringify(
    {
      name: 'fixture-unused-structure',
      version: '1.0.0',
      // DEAD-5: the CLI entrypoint. Declared by manifest field, imported by nobody.
      main: 'src/cli.ts',
      bin: { 'fixture-cli': 'src/cli.ts' },
      // DEAD-8: a script target, executed by name.
      scripts: { bench: 'bun scripts/bench.ts' },
      // DEAD-3: declared, imported by nothing.
      dependencies: { 'declared-but-unused': '^1.0.0' },
    },
    null,
    2
  )}\n`,

  'tsconfig.json': `${JSON.stringify(
    {
      compilerOptions: {
        baseUrl: '.',
        // The alias exists so the fixture exercises the same resolution path the
        // real repository does - and so that a regression in absolutizing it
        // (which reported a whole clean scan while resolving nothing) fails here.
        paths: { '@/*': ['./src/*'] },
      },
    },
    null,
    2
  )}\n`,

  'src/cli.ts': `import { alpha } from './library.js'
import { usedByCli } from './used.js'
import { betaUser } from './consumer.js'
import { viaAlias } from '@/aliased.js'

declare function feature(name: string): boolean

async function boot(): Promise<void> {
  // DEAD-10: reached only from inside a bundler-substituted guard. A walk that
  // followed the bundler's semantics would look for the module in the bundle and
  // find nothing; the file is live in the source, so it must not be reported.
  if (feature('alpha')) {
    const guarded = await import('./feature-guarded.js')
    guarded.run()
  }
  // DEAD-11: the same shape on a USER_TYPE runtime path.
  if (process.env.USER_TYPE === 'internal') {
    const internalOnly = await import('./user-type-only.js')
    internalOnly.run()
  }
  // DEAD-9: a specifier no static analyzer can resolve. The loader is the
  // contract, and it is declared in the policy file, not guessed at.
  const plugin = process.env.FIXTURE_PLUGIN ?? 'alpha'
  const loaded = (await import(\`./plugins/\${plugin}.js\`)) as { run(): void }
  loaded.run()
  void usedByCli(alpha)
  void betaUser
  void viaAlias
}

void boot()
`,

  'src/library.ts': `export function alpha(): number {
  return 1
}

/**
 * DEAD-4's subject. Nothing edits this file in the fixture: the export stops
 * being used because a CALL SITE is removed, which is the case a changed-files
 * heuristic cannot see.
 */
export function beta(): number {
  return 2
}
`,

  /**
   * DEAD-9, second half: reached only through a tsconfig path alias.
   *
   * Written relative nowhere and imported nowhere by relative path, so the only
   * edge that keeps it alive is `@/aliased.js` -> `src/aliased.ts`. If the alias
   * map stops being applied, this file is reported dead - which is exactly what
   * happened when the alias targets were left relative to a config file that
   * lives in a cache directory.
   */
  'src/aliased.ts': `export function viaAlias(): number {
  return 4
}
`,

  'src/consumer.ts': `import { beta } from './library.js'

export const betaUser = beta
`,

  'src/used.ts': `export function usedByCli(value: number): number {
  return value + 1
}

/** DEAD-1: exported, reachable, and imported by nothing anywhere. */
export function nobodyUsesThis(): string {
  return 'unreachable'
}
`,

  /** DEAD-2: no importer at all. */
  'src/orphan.ts': `export function orphaned(): boolean {
  return true
}
`,

  'src/feature-guarded.ts': `export function run(): void {}
`,

  'src/user-type-only.ts': `export function run(): void {}
`,

  'src/plugins/alpha.ts': `export function run(): void {}
`,

  /** DEAD-12: a production file whose only user is a test. */
  'src/test-only-helper.ts': `export function seamUsedOnlyByTests(): number {
  return 3
}
`,

  'scripts/helper.test.ts': `import { seamUsedOnlyByTests } from '../src/test-only-helper.js'

export const observed = seamUsedOnlyByTests
`,

  /** DEAD-6: a hook entrypoint. Started by the host, imported by nothing. */
  'scripts/hook-entry.ts': `export function onHook(): void {}
`,

  /** DEAD-7: a worker started as a child process. */
  'scripts/worker-entry.ts': `export function work(): void {}
`,

  /** DEAD-8's target. */
  'scripts/bench.ts': `export function bench(): void {}
`,

  /**
   * Started by a launcher, which names it as TEXT. No import graph can see the
   * edge, and this repository's own `cc.ps1` -> `gateway-supervisor.mjs` chain is
   * the proof that the class is real.
   */
  'scripts/spawned-by-launcher.ts': `export function main(): void {}
`,

  'scripts/launch.ps1': `$Script = Join-Path $PSScriptRoot 'spawned-by-launcher.ts'
bun $Script
`,

  '.quality/policy/runtime-roots.json': `${JSON.stringify(
    {
      version: 1,
      owner: 'fixture',
      rationale: 'fixture',
      roots: [
        {
          path: 'src/cli.ts',
          kind: 'cli',
          owner: 'fixture',
          proof: 'package.json main',
        },
        {
          path: 'scripts/hook-entry.ts',
          kind: 'hook',
          owner: 'fixture',
          proof: 'declared hook entrypoint for the fixture',
        },
        {
          path: 'scripts/worker-entry.ts',
          kind: 'worker',
          owner: 'fixture',
          proof: 'declared worker entrypoint for the fixture',
        },
      ],
    },
    null,
    2
  )}\n`,
};

const POLICY_ENTRY = {
  path: 'src/plugins/alpha.ts',
  kind: 'loaded-by-name',
  owner: 'fixture',
  proof:
    'src/cli.ts loads it as `./plugins/${plugin}.js`, so the specifier that ' +
    'reaches this file is computed at runtime and no walk can follow it.',
};

type PolicyEntry = typeof POLICY_ENTRY;

function policy(profile: 'production' | 'full', entries: PolicyEntry[] = [POLICY_ENTRY]): string {
  return `${JSON.stringify(
    {
      version: 1,
      owner: 'fixture',
      profile,
      rationale: 'fixture',
      entries,
      exclude: [],
      excludedIssueTypes: {},
    },
    null,
    2
  )}\n`;
}

interface TreeOptions {
  profile?: 'production' | 'full';
  entries?: PolicyEntry[];
}

function buildTree(options: TreeOptions = {}): FixtureTree {
  const tree = createFixtureTree({ git: true });
  for (const [relative, contents] of Object.entries(FILES)) {
    tree.write(relative, contents);
  }
  tree.write(POLICY_PATH, policy(options.profile ?? 'full', options.entries));
  // `git add` rather than `git commit`: tracked-ness is what `git ls-files`
  // reports, and the launcher scanner reads the repository that way.
  const added = spawnSync('git', ['add', '-A'], { cwd: tree.root });
  if (added.status !== 0) {
    throw new Error(
      `fixture tree could not stage its files: ${added.stderr?.toString()}`
    );
  }
  // Written after `git add`, so it is untracked - which is how the real manifest
  // exists in this repository too.
  tree.write(
    '.quality/policy/source-universe.json',
    `${JSON.stringify(
      {
        version: 1,
        owner: 'fixture',
        rationale: 'fixture',
        roles: [
          {
            name: 'production-source',
            description: 'fixture',
            path: 'src',
            checks: ['unused-structure'],
            owner: 'fixture',
            proof: 'fixture',
          },
          {
            name: 'quality-tooling',
            description: 'fixture',
            path: 'scripts/quality',
            checks: ['unused-structure'],
            owner: 'fixture',
            proof: 'fixture',
          },
          {
            name: 'harness-test',
            description: 'fixture',
            glob: 'scripts/**/*.test.ts',
            checks: ['unused-structure'],
            owner: 'fixture',
            proof: 'fixture',
          },
          {
            name: 'harness-tooling',
            description: 'fixture',
            glob: 'scripts/**',
            checks: ['unused-structure'],
            owner: 'fixture',
            proof: 'fixture',
          },
        ],
      },
      null,
      2
    )}\n`
  );
  return tree;
}

/**
 * The context the CLI would build, in the order the CLI builds it.
 *
 * The eligible set comes from the source universe's own `eligibleFor`, not from a
 * hand-written list, so a fixture cannot accidentally measure a scope the role
 * model would never grant. The runtime roots are the three the manifest declares,
 * spelled out the way `loadRuntimeRoots` would resolve them.
 */
function contextFor(
  tree: FixtureTree,
  options: { runtimeRoots?: string[] } = {}
): AnalyzerContext {
  const universe = loadSourceUniverse(tree.root);
  const candidateFiles = universe.eligibleFor([ANALYZER]);
  return {
    repoRoot: tree.root,
    candidateFiles,
    universe,
    runtimeRoots: options.runtimeRoots ?? [
      'src/cli.ts',
      'scripts/hook-entry.ts',
      'scripts/worker-entry.ts',
    ],
    absolute: (relative: string) => join(tree.root, relative),
    trackedFiles: new Set(candidateFiles),
    cacheDir: join(tree.root, '.quality', '.cache', ANALYZER),
    notes: [],
  };
}

function ids(result: AnalyzerResult): Set<string> {
  return new Set(result.findings.map((finding: Finding) => finding.id));
}

function has(result: AnalyzerResult, rule: string, subject: string): boolean {
  return [...ids(result)].some(
    (id) => id.startsWith(`${rule}::${subject}::`) || id === `${rule}::${subject}`
  );
}

/**
 * The run's eligible count, as a number.
 *
 * `coverage.eligible` is `number | null`, and the null case is the engine's
 * encoding of "this analyzer cannot say what it was obliged to consider" - the
 * exact condition every assertion in this file exists to rule out. A type
 * assertion would compile by declaring that impossible case impossible; failing
 * here instead means a run that could not describe its own scope is reported as
 * the defect it is rather than crashing later on a null arithmetic operand.
 */
function eligibleOf(result: AnalyzerResult): number {
  const { eligible } = result.coverage;
  if (eligible === null) {
    throw new Error(
      'the run reported no eligible count; a measurement that cannot say what ' +
        'it covered is not a measurement'
    );
  }
  return eligible;
}

/** A run that may be cited: it ended, and it covered everything it claimed to. */
function expectMeasured(result: AnalyzerResult): void {
  expect(result.errors).toEqual([]);
  expect(result.status).toBe('complete');
  expect(result.complete).toBe(true);
  const eligible = eligibleOf(result);
  expect(eligible).toBeGreaterThan(0);
  expect(result.coverage.failed).toBe(0);
  expect(result.coverage.scanned).toBe(eligible);
}

describe('unused structure: what nothing needs, and what merely looks like it', () => {
  // Three real knip invocations, shared by every case below. They are set up in
  // the first three tests, in that order, because bun runs these serially and a
  // case that read a result before the run that produced it would be asserting
  // about `undefined`.
  let tree: FixtureTree;
  let full: AnalyzerResult;
  let production: AnalyzerResult;
  let mutated: AnalyzerResult;

  test('the full profile measures the whole tree', async () => {
    requireRealToolHome();
    tree = buildTree({ profile: 'full' });
    full = await withToolHome(REAL_TOOL_HOME, () =>
      runAnalyzer(unusedStructureAnalyzer, contextFor(tree))
    );
    expectMeasured(full);
    expect(full.notes.join(' ')).toContain('profile: full');
    // The tool's identity is recorded in the run's own words, not merely implied
    // by the fact that a walk happened. A run that used a different walker is a
    // different measurement and must be visible as one.
    expect(full.notes.join(' ')).toContain(`knip@${KNIP_TOOL.version} (verified)`);
  });

  test('the production profile measures the shipped tree', async () => {
    // The profile is POLICY, so it is switched by rewriting the policy file -
    // which is how a person would switch it. Nothing tells the analyzer at the
    // call site, because a profile passed as an argument would be a second
    // source of truth for the same question.
    tree.write(POLICY_PATH, policy('production'));
    production = await withToolHome(REAL_TOOL_HOME, () =>
      runAnalyzer(unusedStructureAnalyzer, contextFor(tree))
    );
    expectMeasured(production);
    expect(production.notes.join(' ')).toContain('profile: production');
    // One test file exists in this tree, and production does not measure it.
    expect(eligibleOf(production)).toBe(eligibleOf(full) - 1);
  });

  test('the mutation run: a call site and a contract are withdrawn', async () => {
    // One run, two mutations, because both are "a declaration or a call site was
    // removed" and separating them would double the walk to say the same thing.
    // The removal of the call site is DEAD-4; the removal of the policy entry is
    // DEAD-9's other direction - a declared contract that is withdrawn stops
    // protecting the file, and the file is then reported.
    tree.write(POLICY_PATH, policy('full', []));
    writeFileSync(tree.abs('src/consumer.ts'), 'export const betaUser = 1\n', 'utf8');
    mutated = await withToolHome(REAL_TOOL_HOME, () =>
      runAnalyzer(unusedStructureAnalyzer, contextFor(tree))
    );
    expectMeasured(mutated);
  });

  test('DEAD-1 an unused exported function is a finding', () => {
    expect(
      ids(full).has(`${RULES.unusedExport}::src/used.ts::export:nobodyUsesThis`)
    ).toBe(true);
    // The export beside it is imported by the CLI, so the finding is about the
    // symbol and not about the file.
    expect(
      ids(full).has(`${RULES.unusedExport}::src/used.ts::export:usedByCli`)
    ).toBe(false);
    expect(has(full, RULES.unusedFile, 'src/used.ts')).toBe(false);
  });

  test('DEAD-2 an unused file is a finding', () => {
    expect(has(full, RULES.unusedFile, 'src/orphan.ts')).toBe(true);
  });

  test('DEAD-3 an unused direct dependency is a finding', () => {
    expect(
      ids(full).has(
        `${RULES.unusedDependency}::package.json::declared-but-unused`
      )
    ).toBe(true);
  });

  test('DEAD-4 removing a call site makes an UNEDITED export unused', () => {
    // The subtle case: `src/library.ts` is untouched, and the export it declares
    // stops being used because someone else's import disappeared. A scan of the
    // changed files would report this file as clean, and the dead export would be
    // inherited by whoever reads it next.
    expect(
      ids(full).has(`${RULES.unusedExport}::src/library.ts::export:beta`)
    ).toBe(false);
    expect(
      ids(mutated).has(`${RULES.unusedExport}::src/library.ts::export:beta`)
    ).toBe(true);
    // Still live through the other export, which is what makes the finding about
    // the export rather than about the file.
    expect(has(mutated, RULES.unusedFile, 'src/library.ts')).toBe(false);
  });

  test('DEAD-5 a CLI entrypoint is live', () => {
    expect(has(full, RULES.unusedFile, 'src/cli.ts')).toBe(false);
  });

  test('DEAD-6 a hook entrypoint is live', () => {
    expect(has(full, RULES.unusedFile, 'scripts/hook-entry.ts')).toBe(false);
  });

  test('DEAD-7 a worker entrypoint is live', () => {
    expect(has(full, RULES.unusedFile, 'scripts/worker-entry.ts')).toBe(false);
  });

  test('DEAD-8 a package script target is live', () => {
    expect(has(full, RULES.unusedFile, 'scripts/bench.ts')).toBe(false);
  });

  test('DEAD-8 a launcher-started file is live', () => {
    // The launcher names it as text, so the declaration is the launcher's own
    // content rather than a list anyone maintained by hand.
    expect(has(full, RULES.unusedFile, 'scripts/spawned-by-launcher.ts')).toBe(
      false
    );
  });

  test('DEAD-9 a loader reached by name is live under a declared contract', () => {
    expect(has(full, RULES.unusedFile, 'src/plugins/alpha.ts')).toBe(false);
    // And withdrawing the contract withdraws the protection: the file is then
    // reported, which is what makes this a declaration rather than a mute.
    expect(has(mutated, RULES.unusedFile, 'src/plugins/alpha.ts')).toBe(true);
  });

  test('DEAD-9 an import through a tsconfig path alias is followed', () => {
    // Nothing imports `src/aliased.ts` by relative path; the only edge is
    // `@/aliased.js`. If the alias map is not applied to the walk, this file is
    // reported dead - a whole false-positive class wearing the look of a clean
    // scan.
    expect(has(full, RULES.unusedFile, 'src/aliased.ts')).toBe(false);
  });

  test('DEAD-10 feature()-guarded code is not lost to bundler semantics', () => {
    // The module is real source, reached from a branch the bundler may delete.
    // Reporting it would be the analyzer inventing a defect out of a build mode.
    expect(has(full, RULES.unusedFile, 'src/feature-guarded.ts')).toBe(false);
  });

  test('DEAD-11 a USER_TYPE-guarded path is live', () => {
    expect(has(full, RULES.unusedFile, 'src/user-type-only.ts')).toBe(false);
  });

  test('DEAD-12 a test-only helper is live in full and dead in production', () => {
    expect(has(full, RULES.unusedFile, 'src/test-only-helper.ts')).toBe(false);
    expect(has(production, RULES.unusedFile, 'src/test-only-helper.ts')).toBe(
      true
    );
    // And the test file itself is not reported: in the production profile it is
    // not a project file at all, so no claim is made about it either way.
    expect(has(production, RULES.unusedFile, 'scripts/helper.test.ts')).toBe(
      false
    );
    expect(
      production.coverage.exclusions?.[
        'test-and-fixture-files-excluded-by-the-production-profile'
      ]
    ).toBeGreaterThan(0);
  });

  test('the two profiles are a different question, not a different answer', () => {
    // Everything that is live in the full profile for a PRODUCTION reason is
    // still live in production. A profile that changed that would be measuring a
    // different tree, not a different universe of users.
    for (const subject of [
      'src/cli.ts',
      'src/aliased.ts',
      'scripts/hook-entry.ts',
      'scripts/worker-entry.ts',
      'scripts/bench.ts',
      'scripts/spawned-by-launcher.ts',
      'src/feature-guarded.ts',
      'src/user-type-only.ts',
      'src/plugins/alpha.ts',
    ]) {
      expect(has(production, RULES.unusedFile, subject)).toBe(false);
    }
    // And what production newly finds is exactly the test-only helper.
    expect(has(production, RULES.unusedFile, 'src/orphan.ts')).toBe(true);
    expect(has(production, RULES.unusedFile, 'src/used.ts')).toBe(false);
  });
});

describe('unused structure: a run that did not happen is never a clean run', () => {
  test('DEAD-13 a missing runtime-root manifest is INCOMPLETE', async () => {
    const tree = buildTree();
    rmSync(join(tree.root, '.quality', 'policy', 'runtime-roots.json'));
    const missing = await runAnalyzer(unusedStructureAnalyzer, contextFor(tree));
    expect(missing.status).toBe('failed');
    expect(missing.complete).toBe(false);
    expect(missing.findings).toEqual([]);
    expect(String(missing.errors[0]?.message)).toContain('runtime-roots');
    tree.cleanup();
  });

  test('DEAD-13 a manifest with roots but no entrypoint is INCOMPLETE', async () => {
    // The second form of the same hazard: the manifest is there and declares
    // roots, but no entrypoint reached the analyzer. An empty origin produces a
    // confident "nothing is reachable", which is the failure this check exists
    // for.
    const intact = buildTree();
    const emptyOrigin = await runAnalyzer(
      unusedStructureAnalyzer,
      contextFor(intact, { runtimeRoots: [] })
    );
    expect(emptyOrigin.status).toBe('failed');
    expect(emptyOrigin.complete).toBe(false);
    expect(emptyOrigin.findings).toEqual([]);
    expect(String(emptyOrigin.errors[0]?.message)).toContain('empty origin');
    intact.cleanup();
  });

  test('DEAD-14 an unknown profile is refused rather than defaulted', async () => {
    const tree = buildTree();
    tree.write(
      POLICY_PATH,
      `${JSON.stringify({
        version: 1,
        owner: 'fixture',
        profile: 'whatever',
        entries: [],
        exclude: [],
      })}\n`
    );
    const refused = await runAnalyzer(unusedStructureAnalyzer, contextFor(tree));
    expect(refused.status).toBe('failed');
    expect(refused.findings).toEqual([]);
    expect(String(refused.errors[0]?.message)).toContain('profile');
    tree.cleanup();
  });

  test('DEAD-14 a policy that declares nothing is refused', async () => {
    const tree = buildTree();
    tree.write(
      POLICY_PATH,
      `${JSON.stringify({ version: 1, owner: 'fixture', profile: 'full' })}\n`
    );
    const refused = await runAnalyzer(unusedStructureAnalyzer, contextFor(tree));
    expect(refused.status).toBe('failed');
    expect(refused.findings).toEqual([]);
    tree.cleanup();
  });

  test('DEAD-14 a tool configuration that cannot be written is INCOMPLETE', async () => {
    const tree = buildTree();
    // The analyzer writes its knip config into the cache directory. If that
    // directory is occupied by a FILE, the tool was never configured, so the run
    // is entitled to no conclusion - and must not conclude "nothing found".
    const cache = join(tree.root, '.quality', '.cache');
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, ANALYZER), 'not a directory', 'utf8');
    const unwritable = await runAnalyzer(
      unusedStructureAnalyzer,
      contextFor(tree)
    );
    expect(unwritable.status).toBe('failed');
    expect(unwritable.complete).toBe(false);
    expect(unwritable.findings).toEqual([]);
    tree.cleanup();
  });

  test('DEAD-14 an unreadable tsconfig makes aliases unknown, so nothing is claimed', async () => {
    const tree = buildTree();
    tree.write('tsconfig.json', '{ this is not json ');
    const unknownAliases = await runAnalyzer(
      unusedStructureAnalyzer,
      contextFor(tree)
    );
    expect(unknownAliases.status).toBe('failed');
    expect(unknownAliases.findings).toEqual([]);
    expect(String(unknownAliases.errors[0]?.message)).toContain('alias');
    tree.cleanup();
  });

  test('DEAD-15 a run over no files is INCOMPLETE', async () => {
    const tree = buildTree();
    const empty = await runAnalyzer(unusedStructureAnalyzer, {
      ...contextFor(tree),
      candidateFiles: [],
    });
    expect(empty.status).toBe('failed');
    expect(empty.complete).toBe(false);
    expect(empty.findings).toEqual([]);
    tree.cleanup();
  });

  test('DEAD-16 an internal exception is INCOMPLETE, never PASS', async () => {
    const tree = buildTree();
    tree.write(POLICY_PATH, '{ malformed');
    const threw = await runAnalyzer(unusedStructureAnalyzer, contextFor(tree));
    expect(threw.status).toBe('failed');
    expect(threw.complete).toBe(false);
    // The claim that matters: an empty finding list here is the ABSENCE of a
    // measurement. If the engine read it as "no findings", every baseline entry
    // for this analyzer would resolve at once and the debt would disappear
    // without a single line of code changing.
    expect(threw.findings).toEqual([]);
    expect(String(threw.errors[0]?.message).length).toBeGreaterThan(0);
    expect(threw.notes.join(' ')).toContain('no measurement was taken');
    tree.cleanup();
  });
});

describe('unused structure: the scope it measures is the scope it declares', () => {
  test('DEAD-17 an ignored file leaves the universe and voids the accepted evidence', () => {
    const tree = buildTree();
    // A file that was measured until now: added, not committed, and not ignored.
    tree.write('src/untracked-but-measured.ts', 'export const measured = 1\n');
    const universeBefore = loadSourceUniverse(tree.root);
    const policyFiles = [
      ...(ANALYZER_POLICY_INPUTS[ANALYZER] ?? []),
      ...(unusedStructureAnalyzer.policyFiles ?? []),
    ];
    const before = policyDigest(tree.root, policyFiles);
    expect(universeBefore.files).toContain('src/untracked-but-measured.ts');
    // The design claim under test, stated where a reader can find it: the file
    // that decides the source universe is itself a policy input.
    expect(POLICY_INPUTS).toContain('.gitignore');

    writeFileSync(
      join(tree.root, '.gitignore'),
      'src/untracked-but-measured.ts\n'
    );
    const universeAfter = loadSourceUniverse(tree.root);
    const after = policyDigest(tree.root, policyFiles);

    // Adding one line to `.gitignore` removes the file from the universe, so it
    // is no longer measured and no longer reportable: every measurement over it
    // silently improves. Without `.gitignore` in POLICY_INPUTS, this line held
    // and the debt vanished with every baseline still matching.
    expect(universeAfter.files).not.toContain('src/untracked-but-measured.ts');
    expect(after).not.toBe(before);
    tree.cleanup();
  });

  test('DEAD-17 removing an analyzer policy file also voids the evidence', () => {
    const tree = buildTree();
    const policyFiles = [...(unusedStructureAnalyzer.policyFiles ?? [])];
    const before = policyDigest(tree.root, policyFiles);
    rmSync(join(tree.root, dirname(POLICY_PATH), 'unused-structure.config.json'));
    expect(policyDigest(tree.root, policyFiles)).not.toBe(before);
    tree.cleanup();
  });
});
