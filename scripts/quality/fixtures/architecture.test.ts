/**
 * Architecture fixtures: ARCH-1 through ARCH-17.
 *
 * This analyzer answers a question none of the four before it can: not "is this
 * file correct" and not even "is this file needed", but "is the shape of the
 * graph between files what it must be". Its findings are about RELATIONSHIPS, and
 * a relationship has a property the other analyzers' subjects do not: it can be
 * created by a file that nobody edited. Removing one import in file A can place an
 * untouched file B inside an import cycle, and B's contents will be byte-identical
 * to the version that was fine.
 *
 * That is why the cases below are stated twice over, exactly as the other
 * fixtures are: what the analyzer reports, and what it did in order to be entitled
 * to report it. The graph is produced by the real pinned dependency-cruiser; the
 * only thing stubbed anywhere in this file is the tool's own exit behaviour, and
 * only where the case under test IS an exit behaviour.
 *
 *   ARCH-1  a declared forbidden edge              -> a finding
 *   ARCH-2  a set of files importing each other     -> ONE finding, not one per edge
 *   ARCH-3  a known cycle that grows                -> same identity, higher metric
 *   ARCH-4  one edit puts an UNCHANGED file in a cycle -> a finding for a file nobody touched
 *   ARCH-5  a CLI entrypoint                        -> in the graph, not reported
 *   ARCH-6  a hook entrypoint                       -> in the graph, not reported
 *   ARCH-7  a worker/child-process entrypoint       -> in the graph, not reported
 *   ARCH-8  a package-script target                 -> in the graph, not reported
 *   ARCH-9  a loader reached by name                -> excluded from fidelity, not hidden
 *   ARCH-10 feature()-guarded code                  -> a real edge, not lost to bundler semantics
 *   ARCH-11 a USER_TYPE-guarded path                -> a real edge
 *   ARCH-12 a fixture-role tree                     -> not eligible at all, by policy
 *   ARCH-13 a missing runtime-root manifest         -> FAILED, the finding list absent
 *   ARCH-14 an invalid analyzer configuration       -> FAILED, never an empty rule set
 *   ARCH-15 the tool exits zero having analysed nothing -> FAILED, never PASS
 *   ARCH-16 a resolver that throws / a report we cannot read -> FAILED, never PASS
 *   ARCH-17 the policy file changed                 -> the accepted evidence is void
 *
 * ARCH-005 is in this file too, and it is deliberately NOT a finding rule: it is
 * the fidelity precondition that a degraded resolver cannot be read as a clean
 * architecture. Its case is stated with the other refusals, because a refusal is
 * what it produces.
 *
 * The positive cases share three real resolver invocations rather than one each;
 * which cases share which run is stated at each run. The fidelity cases use a
 * stub resolver with a matching version string, because the behaviour under test
 * IS the resolver's exit behaviour and a real one cannot be asked to lie.
 */
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { runAnalyzer } from '../lib/registry';
import { computeCandidateIdentity, policyDigest, policyFilesFor } from '../lib/identity';
import { compare } from '../lib/compare';
import { proposeBaseline } from '../lib/baseline';
import { loadSourceUniverse } from '../lib/sourceUniverse';
import { TOOLCHAIN_INPUTS } from '../lib/hash';
import { parseJsonReport, runTool } from '../lib/toolrun';
import { createFixtureTree, type FixtureTree } from './tree';
import {
  architectureAnalyzer,
  boundaryFindings,
  buildInternalGraph,
  cycleFindings,
  DEPCRUISE_VERSION,
  filesWithComputedSpecifiers,
  hasComputedSpecifier,
  POLICY_PATH,
  RULES,
  resolveToolHome,
  stronglyConnectedComponents,
  toolConfig,
  TOOL_ENTRYPOINT_RELATIVE,
  TOOL_HOME_ENV,
  type ArchitecturePolicy,
} from '../adapters/architecture';
import type { AnalyzerContext } from '../lib/registry';
import type { AnalyzerResult, Finding } from '../lib/types';

// The resolver is real and spawns a solver per invocation.
setDefaultTimeout(300_000);

const ANALYZER = 'architecture';

/** The repository this fixture lives in - the only place with the tool home. */
const REAL_ROOT = resolve(import.meta.dir, '..', '..', '..');
const REAL_TOOL_HOME = join(REAL_ROOT, '.quality', 'tools');

const UNIVERSE_PATH = '.quality/policy/source-universe.json';
const RUNTIME_ROOTS_PATH = '.quality/policy/runtime-roots.json';

const POLICY_BASE = {
  version: 1,
  owner: 'fixture',
  rationale: 'fixture policy',
  ruler: { typeAware: false, rationale: 'fixture ruler' },
  fidelity: {
    maxUnresolvedInternalFraction: 0.05,
    requireEveryEligibleFileCruised: true,
    rationale: 'fixture fidelity',
  },
};

/**
 * The control policy: a boundary in force that this tree does not cross.
 *
 * It must not be empty - `readPolicy` refuses a policy that declares nothing,
 * because "no boundaries" and "the boundaries could not be read" are opposite
 * claims - so the control declares a rule whose measured edge count here is
 * zero. The tree's `src/types/shape.ts -> src/components/Widget.js` edge is
 * present in both runs, so the boundary policy's one finding can only come from
 * the declaration, which is exactly what the control is for.
 */
const POLICY_OPEN = JSON.stringify({
  ...POLICY_BASE,
  forbiddenEdges: [
    {
      id: 'fixture-unviolated',
      name: 'components must not import types',
      from: 'src/components/**',
      to: 'src/types/**',
      reason: 'fixture: declared in force, and this tree does not cross it',
      measuredEdgesWhenDeclared: 0,
    },
  ],
  roleImports: [],
  notDeclared: [],
});

/** Declares the forbidden layer edge the fixture tree violates on purpose. */
const POLICY_BOUNDARY = JSON.stringify({
  ...POLICY_BASE,
  forbiddenEdges: [
    {
      id: 'fixture-types-are-bottom',
      name: 'types must not import components',
      from: 'src/types/**',
      to: 'src/components/**',
      reason: 'fixture: the bottom layer must not depend on the top',
      measuredEdgesWhenDeclared: 0,
    },
  ],
  roleImports: [
    {
      id: 'fixture-role-rule',
      from: 'build-tooling',
      allowed: ['build-tooling'],
      reason: 'fixture: build tooling may not reach into the product',
    },
  ],
  notDeclared: [],
});

/**
 * A source universe for the fixture tree.
 *
 * `quality-fixture` is declared BEFORE the broader `scripts/**` role, the same
 * priority order the real manifest uses, so ARCH-12 can show that a fixture tree
 * is not eligible for a graph analyzer even though it is a repository file.
 */
const UNIVERSE = JSON.stringify({
  version: 1,
  owner: 'fixture',
  rationale: 'fixture universe',
  extensions: ['.ts', '.tsx'],
  roles: [
    {
      name: 'production-source',
      description: 'the product',
      path: 'src',
      checks: ['import-integrity'],
      owner: 'fixture',
      proof: 'fixture',
    },
    {
      name: 'build-tooling',
      description: 'build machinery',
      glob: 'scripts/*.ts',
      checks: ['import-integrity'],
      owner: 'fixture',
      proof: 'fixture',
    },
    {
      name: 'quality-fixture',
      description: 'fixture trees',
      glob: 'scripts/fixtures/**',
      checks: ['syntax'],
      owner: 'fixture',
      proof: 'fixture',
    },
    {
      name: 'harness-tooling',
      description: 'ops scripts',
      glob: 'scripts/**',
      checks: ['import-integrity'],
      owner: 'fixture',
      proof: 'fixture',
    },
  ],
  exclude: ['**/node_modules/**'],
  unclassified: 'report',
});

const RUNTIME_ROOTS = JSON.stringify({
  version: 1,
  owner: 'fixture',
  rationale: 'fixture runtime roots',
  roots: [
    {
      path: 'src/entrypoints',
      kind: 'process-entry',
      owner: 'fixture',
      proof: 'fixture',
    },
  ],
});

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    module: 'nodenext',
    moduleResolution: 'nodenext',
    target: 'esnext',
    strict: true,
  },
  include: ['src', 'scripts'],
});

/**
 * The fixture program.
 *
 * Every entrypoint shape the engine must keep alive is present, and each is kept
 * alive by a DIFFERENT mechanism, because the point of ARCH-5 through ARCH-11 is
 * that liveness has more than one source: a declared runtime root, a package
 * script, a package manifest field, a name-based dynamic loader, a `feature()`
 * branch and a `USER_TYPE` branch.
 */
const FILES: Record<string, string> = {
  'package.json': JSON.stringify(
    {
      name: 'fixture',
      private: true,
      type: 'module',
      main: 'src/entrypoints/cli.ts',
      bin: { fixture: 'scripts/bench.ts' },
    },
    null,
    2
  ),
  'tsconfig.json': TSCONFIG,
  [UNIVERSE_PATH]: UNIVERSE,
  [RUNTIME_ROOTS_PATH]: RUNTIME_ROOTS,

  // ARCH-5/6/7: three entrypoint shapes, each with a real outgoing edge.
  'src/entrypoints/cli.ts': `import { handler } from '../lib/handler.js'
export const cli = (): string => handler()
`,
  'src/entrypoints/hook.ts': `import { helper } from '../utils/helper.js'
export const hook = (): string => helper()
`,
  'src/entrypoints/worker.ts': `import { helper } from '../utils/helper.js'
export const work = (): string => helper()
`,

  'src/lib/handler.ts': `import { helper } from '../utils/helper.js'
import { shapeOf } from '../types/shape.js'
import { boot } from '../utils/guarded.js'
export const handler = (): string => helper() + shapeOf() + String(boot)
`,

  // ARCH-1: the bottom layer reaching into the top. One edge, one finding.
  'src/types/shape.ts': `import { widget } from '../components/Widget.js'
export const shapeOf = (): string => widget()
`,
  'src/components/Widget.tsx': `export const widget = (): string => 'w'
`,

  'src/utils/helper.ts': `export const helper = (): string => 'h'
`,

  // ARCH-10/11/9: a module reached only through a `feature()` branch, one only
  // through a `USER_TYPE` branch, and one only through a name-based loader.
  'src/utils/guarded.ts': `import { run } from './branchGuarded.js'
import { load } from './loader.js'
declare function feature(name: string): boolean
export async function boot(): Promise<string> {
  if (feature('alpha')) return run()
  if (process.env.USER_TYPE === 'internal') {
    const internal = await import('./userTypeOnly.js')
    return internal.run()
  }
  const plugin = await load(process.env.FIXTURE_PLUGIN ?? 'alpha')
  return plugin.run()
}
`,
  'src/utils/branchGuarded.ts': `export const run = (): string => 'guarded'
`,
  'src/utils/userTypeOnly.ts': `export const run = (): string => 'internal'
`,
  'src/utils/loader.ts': `export async function load(name: string): Promise<{ run(): string }> {
  const module_ = (await import(\`./plugins/\${name}.js\`)) as { run(): string }
  return module_
}
`,
  'src/utils/plugins/alpha.ts': `export const run = (): string => 'alpha'
`,

  // ARCH-2: a two-member cycle. ARCH-3 grows it to three.
  'src/cycles/twoA.ts': `import { b } from './twoB.js'
export const a = (): string => b()
`,
  'src/cycles/twoB.ts': `import { a } from './twoA.js'
export const b = (): string => a()
`,

  // ARCH-2/ARCH-4: a chain that is NOT a cycle until one unrelated file changes.
  'src/chain/r1.ts': `import { r2 } from './r2.js'
export const r1 = (): string => r2()
`,
  'src/chain/r2.ts': `import { shared } from './shared.js'
export const r2 = (): string => shared()
`,
  'src/chain/shared.ts': `export const shared = (): string => 's'
`,

  // ARCH-8: a package-script target and the file it spawns by name.
  'scripts/bench.ts': `import { spawned } from './spawned-by-launcher.js'
export const bench = (): string => spawned()
`,
  'scripts/spawned-by-launcher.ts': `export const spawned = (): string => 'spawned'
`,

  // ARCH-4 (role rule): build tooling reaching into the product.
  'scripts/build-helper.ts': `import { helper } from '../src/utils/helper.js'
export const buildHelper = (): string => helper()
`,

  // ARCH-12: a fixture-role file. Not eligible for a graph analyzer at all.
  'scripts/fixtures/planted.ts': `import { doesNotExist } from './nowhere.js'
export const planted = doesNotExist
`,
};

interface Fixture {
  tree: FixtureTree;
  /** Writes the policy in force. Re-invoked to change the policy mid-fixture. */
  policy(contents: string): void;
}

function buildTree(policy: string = POLICY_OPEN): Fixture {
  const tree = createFixtureTree({ git: true });
  for (const [path, contents] of Object.entries(FILES)) tree.write(path, contents);
  tree.write(POLICY_PATH, `${policy}\n`);
  return {
    tree,
    policy(contents: string): void {
      tree.write(POLICY_PATH, `${contents}\n`);
    },
  };
}

function contextFor(
  tree: FixtureTree,
  options: { runtimeRoots?: string[] } = {}
): AnalyzerContext {
  const universe = loadSourceUniverse(tree.root);
  const candidateFiles = universe.eligibleFor(architectureAnalyzer.capabilities);
  return {
    repoRoot: tree.root,
    candidateFiles,
    universe,
    runtimeRoots: options.runtimeRoots ?? [
      'src/entrypoints/cli.ts',
      'src/entrypoints/hook.ts',
      'src/entrypoints/worker.ts',
    ],
    absolute: (relative: string) => join(tree.root, relative),
    trackedFiles: new Set(candidateFiles),
    cacheDir: join(tree.root, '.quality', '.cache', ANALYZER),
    notes: [],
  };
}

/**
 * Point the analyzer at the real pinned tool home for the duration of `fn`.
 *
 * The tool home is 30 MB across 1,166 files, so a fixture tree cannot carry its
 * own copy - and copying one per fixture is the defect the acceptance harness
 * already paid for once with `.candidate-build`. The override is safe because the
 * adapter verifies the installed tool's own reported version against its pin, so
 * a wrong target fails the run rather than changing the measurement.
 *
 * The restore is a `finally` rather than a call each test remembers to make,
 * because a leaked override is not a harmless leftover here: the next test's
 * measurement would be taken through whichever home this one left behind.
 */
async function withToolHome<T>(
  home: string,
  fn: () => T | Promise<T>
): Promise<T> {
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
 * A missing instrument FAILS the fixture suite; it does not skip it.
 *
 * A skipped fixture and a passing fixture are the same colour in every test
 * report, which is the "nothing ran looks like nothing found" failure this engine
 * exists to refuse - so the absence of the pinned resolver is loud.
 */
function requireRealToolHome(): void {
  if (!existsSync(join(REAL_TOOL_HOME, TOOL_ENTRYPOINT_RELATIVE))) {
    throw new Error(
      `the pinned tool home is missing at ${REAL_TOOL_HOME}; run \`bun install\` ` +
        'inside it before running these fixtures'
    );
  }
}

/**
 * A stub resolver, used ONLY where the case under test is the resolver's exit
 * behaviour. A real tool cannot be asked to exit zero having cruised nothing, so
 * the case that matters most - "a successful-looking run that measured nothing" -
 * is only reachable by writing the lie deliberately.
 *
 * It answers `--version` with the pinned version so the adapter's version probe
 * does not refuse the run before the behaviour under test is reached; that probe
 * has its own case, with a deliberately wrong version.
 */
function installStub(tree: FixtureTree, body: string): string {
  tree.write(
    `.quality/tools/${TOOL_ENTRYPOINT_RELATIVE}`,
    [
      '#!/usr/bin/env node',
      `if (process.argv.includes('--version')) { process.stdout.write('${DEPCRUISE_VERSION}\\n'); process.exit(0) }`,
      body,
      '',
    ].join('\n')
  );
  return tree.abs('.quality/tools');
}

/**
 * A resolver report over the fixture's own eligible set, with the edges the case
 * needs. Built from the real universe rather than a fixed list so that a case
 * about the graph does not accidentally become a case about the per-file
 * reconciliation - that check has its own case, which cruises nothing.
 */
function stubReport(
  tree: FixtureTree,
  options: {
    edges?: Array<[string, string]>;
    unresolved?: Array<[string, string]>;
  } = {}
): string {
  const edges = options.edges ?? [];
  const unresolved = options.unresolved ?? [];
  const universe = loadSourceUniverse(tree.root);
  const eligible = universe.eligibleFor(architectureAnalyzer.capabilities).sort();
  const modules = new Map(
    eligible.map((source) => [
      source,
      { source, dependencies: [] as Array<Record<string, unknown>> },
    ])
  );
  for (const [from, to] of edges) {
    modules.get(from)?.dependencies.push({
      module: `./${to.split('/').pop()}`,
      resolved: to,
    });
  }
  for (const [from, specifier] of unresolved) {
    modules.get(from)?.dependencies.push({
      module: specifier,
      couldNotResolve: true,
    });
  }
  const report = {
    modules: [...modules.values()],
    summary: {
      totalCruised: modules.size,
      totalDependenciesCruised: edges.length + unresolved.length,
      violations: [],
    },
  };
  return `process.stdout.write(${JSON.stringify(JSON.stringify(report))})\nprocess.exit(0)\n`;
}

function ids(result: AnalyzerResult): Set<string> {
  return new Set(result.findings.map((finding: Finding) => finding.id));
}

function has(result: AnalyzerResult, rule: string, subject: string): boolean {
  return [...ids(result)].some(
    (id) => id.startsWith(`${rule}::${subject}::`) || id === `${rule}::${subject}`
  );
}

function titled(result: AnalyzerResult, rule: string, subject: string): Finding | null {
  return (
    result.findings.find(
      (finding) => finding.rule === rule && finding.subject === subject
    ) ?? null
  );
}

function byRule(result: AnalyzerResult, rule: string): Finding[] {
  return result.findings.filter((finding) => finding.rule === rule);
}

/** A measured run: complete, and entitled to its findings. */
function expectMeasured(result: AnalyzerResult): void {
  expect(result.errors).toEqual([]);
  expect(result.status).toBe('complete');
  expect(result.complete).toBe(true);
  expect(result.coverage.eligible).not.toBeNull();
  expect(result.coverage.failed).toBe(0);
  expect(result.coverage.scanned).toBe(result.coverage.eligible as number);
}

/**
 * A refused run.
 *
 * ARCH-13 through ARCH-16 and the fidelity precondition all land here. Each is a
 * FAILED execution whose finding list is EMPTY, and the assertion that matters is
 * not the emptiness - it is that `complete` is false and the status is `failed`,
 * because that is what stops the engine reading an absent measurement as a
 * resolved one. The engine's own note is asserted too, so that a future edit
 * cannot quietly turn "no measurement was taken" into a plausible-looking empty
 * result.
 */
function expectRefused(result: AnalyzerResult): void {
  expect(result.findings).toEqual([]);
  expect(result.status).toBe('failed');
  expect(result.complete).toBe(false);
  expect(result.errors.length).toBeGreaterThan(0);
  expect(result.notes.join(' ')).toContain(
    'no measurement was taken, not because the architecture is clean'
  );
}

/**
 * Run the real resolver the way the adapter does, and return the graph.
 *
 * Assertions about which nodes and edges exist are made against the resolver's
 * actual output rather than against a hand-built graph, so a claim like "the
 * feature()-guarded module is a real edge" is evidence about the pinned tool and
 * not about this test's ability to construct a Map.
 */
function measureGraph(tree: FixtureTree): {
  graph: ReturnType<typeof buildInternalGraph>;
  failure: string | null;
} {
  const { entrypoint } = resolveToolHome(tree.root);
  const policy = JSON.parse(
    // Read through the fixture tree so the graph is measured under the policy in
    // force at the time of the call, not the one the file was created with.
    readFileSync(tree.abs(POLICY_PATH), 'utf8')
  ) as ArchitecturePolicy;
  const configPath = tree.abs('.quality/.cache/architecture.test.cjs');
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, toolConfig(policy), 'utf8');
  const universe = loadSourceUniverse(tree.root);
  const eligible = universe.eligibleFor(architectureAnalyzer.capabilities);
  const roots = [...new Set(eligible.map((file) => file.split('/')[0]))].sort();
  const outcome = runTool({
    command: process.execPath,
    args: [entrypoint, '--config', configPath, '--output-type', 'json', ...roots],
    cwd: tree.root,
    timeoutMs: 300_000,
    successCodes: [0],
  });
  if (!outcome.ok) return { graph: null as never, failure: outcome.failure };
  const parsed = parseJsonReport<{
    modules: never[];
    summary: { totalCruised: number; totalDependenciesCruised: number; violations: unknown[] };
  }>(outcome.stdout);
  if (!parsed.ok) return { graph: null as never, failure: parsed.reason };
  return { graph: buildInternalGraph(parsed.value, eligible), failure: null };
}

describe('architecture: the graph the analyzer is entitled to report on', () => {
  // ARCH-5, ARCH-6, ARCH-7, ARCH-8, ARCH-9, ARCH-10, ARCH-11 and ARCH-12 are all
  // observations about ONE real resolver run over the fixture program, because
  // they are all the same question: does the graph contain what the repository
  // actually contains. Splitting them into eight invocations would measure the
  // same mechanism eight times.
  test('the guarded paths, entrypoints and loader targets are all real edges', async () => {
    requireRealToolHome();
    const fixture = buildTree(POLICY_BOUNDARY);
    try {
      const measured = await withToolHome(REAL_TOOL_HOME, () =>
        measureGraph(fixture.tree)
      );
      expect(measured.failure).toBeNull();
      const graph = measured.graph;

      // ARCH-12 first, because it is a negative: a fixture-role tree is not
      // eligible for a graph analyzer at all, and the deliberate broken specifier
      // it contains must therefore never reach the graph. If the role priority in
      // the manifest were reversed, this file would be measured and would report
      // an unresolved specifier as architecture debt.
      const universe = loadSourceUniverse(fixture.tree.root);
      expect(universe.roleOf('scripts/fixtures/planted.ts')).toBe('quality-fixture');
      expect(universe.eligibleFor(architectureAnalyzer.capabilities)).not.toContain(
        'scripts/fixtures/planted.ts'
      );
      expect(graph.nodes).not.toContain('scripts/fixtures/planted.ts');

      // ARCH-5, ARCH-6, ARCH-7: declared runtime roots are in the graph.
      for (const entrypoint of [
        'src/entrypoints/cli.ts',
        'src/entrypoints/hook.ts',
        'src/entrypoints/worker.ts',
      ]) {
        expect(graph.nodes).toContain(entrypoint);
        expect(graph.edges.some((edge) => edge.from === entrypoint)).toBe(true);
      }

      // ARCH-8: a package-script / bin target, reached by name from the manifest
      // rather than by any import.
      expect(graph.nodes).toContain('scripts/bench.ts');
      expect(graph.edges).toContainEqual({
        from: 'scripts/bench.ts',
        to: 'scripts/spawned-by-launcher.ts',
        specifier: './spawned-by-launcher.js',
      });

      // ARCH-10: a module imported only inside an `if (feature(...))` branch. The
      // resolver does not evaluate conditions, and must not be asked to: a
      // bundler-aware analyzer that pruned this branch would report the module as
      // unreachable and the edge as absent.
      expect(graph.edges).toContainEqual({
        from: 'src/utils/guarded.ts',
        to: 'src/utils/branchGuarded.ts',
        specifier: './branchGuarded.js',
      });

      // ARCH-11: a module imported only inside the USER_TYPE branch. Same
      // reasoning; the runtime path must not become a false absence.
      expect(graph.nodes).toContain('src/utils/userTypeOnly.ts');

      // ARCH-9: a name-based loader. MEASURED, and the measurement is the point:
      // dependency-cruiser emits NO dependency record for a template-literal
      // import - not an unresolved one, none at all - so the target is not missing
      // from the graph because it was dropped, it was never an edge. An earlier
      // design classified these as a "computed specifier" category; that category
      // was unreachable, because nothing ever arrives to classify. The honest
      // treatment is to count the blind spot from source text and say so, so a
      // reader knows how many files a cycle could hide in; the loader's target is
      // still a node because the walk is directory-rooted.
      expect(graph.unresolvedInternal.some((e) => e.from === 'src/utils/loader.ts')).toBe(
        false
      );
      expect(graph.edges.some((edge) => edge.from === 'src/utils/loader.ts')).toBe(
        false
      );
      expect(graph.nodes).toContain('src/utils/plugins/alpha.ts');
    } finally {
      fixture.tree.cleanup();
    }
  });

  // ARCH-1 and ARCH-2, and the control that makes them meaningful: the same tree
  // under a policy that declares no layer boundary produces no boundary finding.
  test('a declared forbidden edge is a finding, and only when it is declared', async () => {
    requireRealToolHome();

    const open = buildTree(POLICY_OPEN);
    let control: AnalyzerResult;
    try {
      control = await withToolHome(REAL_TOOL_HOME, () =>
        runAnalyzer(architectureAnalyzer, contextFor(open.tree))
      );
    } finally {
      open.tree.cleanup();
    }
    // The control run: measured, and free of boundary findings. Without this the
    // next assertion would pass if the rule fired unconditionally.
    expect(control.errors).toEqual([]);
    expect(control.status).toBe('complete');
    expect(byRule(control, RULES.forbiddenEdge)).toEqual([]);
    expect(byRule(control, RULES.boundaryViolation)).toEqual([]);

    const boundary = buildTree(POLICY_BOUNDARY);
    try {
      const result = await withToolHome(REAL_TOOL_HOME, () =>
        runAnalyzer(architectureAnalyzer, contextFor(boundary.tree))
      );
      expectMeasured(result);

      // ARCH-1: exactly one edge violates the declared layer boundary, and the
      // finding names the importer as its subject so it survives the target being
      // renamed.
      const forbidden = byRule(result, RULES.forbiddenEdge);
      expect(forbidden.length).toBe(1);
      expect(forbidden[0].subject).toBe('src/types/shape.ts');
      expect(forbidden[0].locator).toBe('../components/Widget.js');
      expect(forbidden[0].evidence.boundary).toBe('fixture-types-are-bottom');

      // ARCH-4: the ownership rule, which the layer rule cannot express because
      // it is about ROLES rather than paths. build-tooling may not reach into the
      // product, and `scripts/build-helper.ts` does.
      const crossings = byRule(result, RULES.boundaryViolation);
      expect(crossings.length).toBe(1);
      expect(crossings[0].subject).toBe('scripts/build-helper.ts');
      expect(crossings[0].evidence.fromRole).toBe('build-tooling');
      expect(crossings[0].evidence.toRole).toBe('production-source');

      // ARCH-2: ONE finding for the two-member cycle, not one per participating
      // edge. A ratchet that reported per edge would put two entries in the
      // baseline for one structural fact, and a component of 604 - as this
      // repository has - would put hundreds.
      const cycles = byRule(result, RULES.runtimeCycle);
      expect(cycles.length).toBe(1);
      expect(cycles[0].subject).toBe('src/cycles/twoA.ts');
      expect(cycles[0].metric?.value).toBe(2);
      expect(cycles[0].evidence.cycleSize).toBe(2);
      // The chain r1 -> r2 -> shared is NOT a cycle yet, and saying otherwise
      // would be the classic false positive of a reachability-shaped rule.
      expect(has(result, RULES.runtimeCycle, 'src/chain/r1.ts')).toBe(false);

      // The analyzer is entitled to the graph it reported on.
      expect(result.notes.join(' ')).toContain('resolver: dependency-cruiser@');
      expect(result.notes.join(' ')).toContain('(verified)');
      expect(result.notes.join(' ')).toContain('ruler: runtime value edges only');
    } finally {
      boundary.tree.cleanup();
    }
  });

  // ARCH-3 and ARCH-4: one mutation, two distinct promises.
  test('a grown cycle keeps its identity and a single edit implicates an untouched file', async () => {
    requireRealToolHome();
    const fixture = buildTree(POLICY_BOUNDARY);
    try {
      const before = await withToolHome(REAL_TOOL_HOME, () =>
        runAnalyzer(architectureAnalyzer, contextFor(fixture.tree))
      );
      expectMeasured(before);
      const cycleBefore = titled(before, RULES.runtimeCycle, 'src/cycles/twoA.ts');
      expect(cycleBefore).not.toBeNull();
      expect(cycleBefore?.metric?.value).toBe(2);

      // Two edits, both of which are the kind of change a person makes casually.
      //
      // 1. A third file joins the existing cycle. No member is renamed, so the
      //    finding's identity must not change: the same cycle got worse, and a
      //    ratchet that reported "one resolved, one new" would show the
      //    architecture as unchanged.
      fixture.tree.write(
        'src/cycles/twoC.ts',
        `import { a } from './twoA.js'\nexport const c = (): string => a()\n`
      );
      fixture.tree.write(
        'src/cycles/twoB.ts',
        `import { a } from './twoA.js'\nimport { c } from './twoC.js'\nexport const b = (): string => a() + c()\n`
      );

      // 2. ONE file changes, and it is not in the chain: `shared.ts` gains an
      //    import of r1. r1.ts and r2.ts keep byte-identical contents and are
      //    placed inside a cycle by someone else's edit - the property that makes
      //    this analyzer's findings different in kind from the other four.
      fixture.tree.write(
        'src/chain/shared.ts',
        `import { r1 } from './r1.js'\nexport const shared = (): string => r1()\n`
      );

      const after = await withToolHome(REAL_TOOL_HOME, () =>
        runAnalyzer(architectureAnalyzer, contextFor(fixture.tree))
      );
      expectMeasured(after);

      // ARCH-3: same identity, larger metric.
      const cycleAfter = titled(after, RULES.runtimeCycle, 'src/cycles/twoA.ts');
      expect(cycleAfter).not.toBeNull();
      expect(cycleAfter?.id).toBe(cycleBefore?.id);
      expect(cycleAfter?.metric?.value).toBe(3);
      expect(cycleAfter?.metric?.direction).toBe('lower-is-better');
      expect(cycleAfter?.metric?.limit).toBeNull();

      // ARCH-3, the part that decides whether the rule is real: the growth must
      // BLOCK. A metric nobody compares is a number in a report, so this goes
      // through the actual gate over an actual accepted baseline rather than
      // asserting the field. The identity is unchanged, so the finding is
      // `accepted-legacy` AND worsened at the same time - which is the point:
      // accepting a cycle does not license making it bigger.
      const identity = computeCandidateIdentity(fixture.tree.root, [
        ...policyFilesFor(ANALYZER),
        ...(architectureAnalyzer.policyFiles ?? []),
      ]);
      const accepted = proposeBaseline(fixture.tree.root, ANALYZER, before, identity, {
        reason: 'fixture: accept the cycles as they stand',
        acceptedBy: 'fixture',
      });
      const gate = compare({
        analyzer: ANALYZER,
        profile: 'fixture',
        baseline: accepted.baseline,
        result: after,
        candidateAtStart: identity,
        candidateAtFinish: identity,
        repoRoot: fixture.tree.root,
      });
      expect(gate.worsened.map((entry) => `${entry.id}:${entry.reason}`)).toEqual([
        `${cycleAfter?.id}:metric-worsened`,
      ]);
      expect(gate.dispositions['accepted-legacy']).toBeGreaterThan(0);
      expect(gate.completeness).toBe('complete');

      // ARCH-4 (the untouched-file case): the chain is now a cycle whose smallest
      // member is r1.ts, which nobody edited.
      const chain = titled(after, RULES.runtimeCycle, 'src/chain/r1.ts');
      expect(chain).not.toBeNull();
      expect(chain?.metric?.value).toBe(3);
      expect(String(chain?.evidence.cycleDigest)).toContain('src/chain/r2.ts');
      expect(byRule(after, RULES.runtimeCycle).length).toBe(2);
    } finally {
      fixture.tree.cleanup();
    }
  });
});

describe('architecture: a run that did not measure is never a clean run', () => {
  // ARCH-15. This is the case the whole analyzer was rebuilt around, and it is
  // not hypothetical: `bun x dependency-cruiser@18.3.1 ... <directory>` was
  // measured doing EXACTLY this on this repository - exit 0, well-formed JSON,
  // `totalCruised: 0`, empty stderr. The stub reproduces the tool's behaviour so
  // the adapter's response to it can be tested without depending on which bun
  // release is installed.
  test('ARCH-15 the resolver exits zero having cruised nothing', async () => {
    const fixture = buildTree(POLICY_OPEN);
    try {
      const home = installStub(
        fixture.tree,
        `process.stdout.write(JSON.stringify({ modules: [], summary: { totalCruised: 0, totalDependenciesCruised: 0, violations: [] } }))\nprocess.exit(0)\n`
      );
      const result = await withToolHome(home, () =>
        runAnalyzer(architectureAnalyzer, contextFor(fixture.tree))
      );
      // The finding list being empty is NOT the assertion. A clean graph also has
      // an empty finding list, and the difference is entirely in these four.
      expectRefused(result);
      // And the specific reason: files were eligible and never cruised. The
      // reconciliation is what catches this, because the report itself is a valid
      // graph of nothing.
      expect(result.errors[0].message).toContain(
        'absent from the cruised module set'
      );
      expect(result.notes.join(' ')).toContain('were not cruised');
    } finally {
      fixture.tree.cleanup();
    }
  });

  // The ARCH-005 precondition, which is what a genuinely degraded resolver looks
  // like: every file cruised, most edges unresolved, exit zero. This is the shape
  // `bun x` produced on this repository (300 of 331 unresolved) and it must not be
  // readable as a clean architecture. It is a precondition rather than a finding
  // rule because a finding can be accepted into a baseline and forgotten, while
  // this cannot be accepted at all.
  test('ARCH-005 a resolver that cannot resolve most edges is refused, not read as clean', async () => {
    const fixture = buildTree(POLICY_OPEN);
    try {
      const home = installStub(
        fixture.tree,
        stubReport(fixture.tree, {
          edges: [['src/utils/helper.ts', 'src/lib/handler.ts']],
          // Literal relative paths that do not exist, which is the degraded
          // resolver's signature. Deliberately NOT computed specifiers: those are
          // excluded from the fraction, and using them here would test the
          // exclusion instead of the ceiling.
          unresolved: Array.from({ length: 40 }, (_, index) => [
            'src/utils/helper.ts',
            `./missing-${index}.js`,
          ]) as Array<[string, string]>,
        })
      );
      const result = await withToolHome(home, () =>
        runAnalyzer(architectureAnalyzer, contextFor(fixture.tree))
      );
      expectRefused(result);
      expect(result.errors[0].kind).toBe('resolution-error');
      expect(result.errors[0].message).toContain('did not resolve');
      expect(result.errors[0].message).toContain('ceiling');
      // The error says what a low cycle count here would have meant, so a reader
      // of the record can see the failure the ceiling exists to prevent.
      expect(result.errors[0].message).toContain('cannot form cycles');
    } finally {
      fixture.tree.cleanup();
    }
  });

  // ARCH-16, first form: the resolver refuses. A non-zero exit with empty stdout
  // is the ONLY failure signal dependency-cruiser gives in JSON mode - measured:
  // a run with 1,397 violations and a run with none both exit 0, so the exit code
  // is a necessary condition and never a sufficient one.
  test('ARCH-16 the resolver exits non-zero, and a report we cannot read', async () => {
    const refused = buildTree(POLICY_OPEN);
    try {
      const home = installStub(
        refused.tree,
        `process.stderr.write('ERROR: config is not valid\\n')\nprocess.exit(1)\n`
      );
      const result = await withToolHome(home, () =>
        runAnalyzer(architectureAnalyzer, contextFor(refused.tree))
      );
      expectRefused(result);
      expect(result.errors[0].kind).toBe('scan-failure');
      // This is the one path where the absent finding list is stated explicitly,
      // because the exit code is the only thing that says so.
      expect(result.notes.join(' ')).toContain(
        'the finding list is absent rather than empty'
      );
    } finally {
      refused.tree.cleanup();
    }

    // A report that is present but truncated. `parseJsonReport` distinguishes
    // "absent" from "malformed" precisely so this cannot read as an empty one.
    const truncated = buildTree(POLICY_OPEN);
    try {
      const home = installStub(
        truncated.tree,
        `process.stdout.write('{"modules": [{"source"\\n')\nprocess.exit(0)\n`
      );
      const result = await withToolHome(home, () =>
        runAnalyzer(architectureAnalyzer, contextFor(truncated.tree))
      );
      expectRefused(result);
      expect(result.errors[0].message).toContain('not valid JSON');
    } finally {
      truncated.tree.cleanup();
    }

    // A report that parses but is not a graph. Exit zero, valid JSON, no summary.
    const empty = buildTree(POLICY_OPEN);
    try {
      const home = installStub(
        empty.tree,
        `process.stdout.write(JSON.stringify({ ok: true }))\nprocess.exit(0)\n`
      );
      const result = await withToolHome(home, () =>
        runAnalyzer(architectureAnalyzer, contextFor(empty.tree))
      );
      expectRefused(result);
      expect(result.errors[0].message).toContain('no summary or module list');
    } finally {
      empty.tree.cleanup();
    }
  });

  // ARCH-16, second form: the engine's own guard. An analyzer that throws must
  // not degrade into "zero findings", because the engine's next step would be to
  // compare that empty list against the baseline and report the debt as RESOLVED.
  test('ARCH-16 an analyzer that throws yields a failed result, never a pass', async () => {
    const fixture = buildTree(POLICY_OPEN);
    try {
      const result = await runAnalyzer(
        {
          id: 'architecture-throwing-fixture',
          description: 'throws',
          rules: { 'X-001': 'x' },
          extensions: ['.ts'],
          capabilities: ['import-integrity'],
          contentScoped: false,
          run(): never {
            throw new Error('traversal exploded');
          },
        },
        contextFor(fixture.tree)
      );
      expect(result.status).toBe('failed');
      expect(result.complete).toBe(false);
      expect(result.findings).toEqual([]);
      expect(result.errors[0].kind).toBe('scan-failure');
      // The note is the whole point: the empty list is explicitly NOT a claim.
      expect(result.notes.join(' ')).toContain('not because nothing was found');
    } finally {
      fixture.tree.cleanup();
    }
  });

  // ARCH-13: the runtime-root manifest resolved nothing. A graph without anchors
  // cannot be shown to describe the program that ships, so the run is refused
  // rather than reported as clean. The stub cruises every eligible file with one
  // real edge, so the refusal cannot come from any of the checks before this one.
  test('ARCH-13 no runtime roots resolved', async () => {
    const fixture = buildTree(POLICY_OPEN);
    try {
      const home = installStub(
        fixture.tree,
        stubReport(fixture.tree, {
          edges: [['src/lib/handler.ts', 'src/utils/helper.ts']],
        })
      );
      const result = await withToolHome(home, () =>
        runAnalyzer(
          architectureAnalyzer,
          contextFor(fixture.tree, { runtimeRoots: [] })
        )
      );
      expectRefused(result);
      expect(result.errors.map((error) => error.subject)).toContain(
        '.quality/policy/runtime-roots.json'
      );
    } finally {
      fixture.tree.cleanup();
    }
  });

  // ARCH-14: an unusable policy must not be read as "no boundaries declared".
  // The difference between those two is the difference between a repository that
  // has no architectural constraints and one that has none written down.
  test('ARCH-14 an invalid analyzer configuration is refused, never defaulted', async () => {
    const cases: Array<{ name: string; policy: string; expect: string }> = [
      {
        name: 'not JSON at all',
        policy: '{ this is not json',
        expect: 'not valid JSON',
      },
      {
        name: 'no boundaries anywhere',
        policy: JSON.stringify({ ...POLICY_BASE, forbiddenEdges: [], roleImports: [] }),
        expect: 'no boundaries at all',
      },
      {
        name: 'boundary rule missing its reason',
        policy: JSON.stringify({
          ...POLICY_BASE,
          forbiddenEdges: [{ id: 'x', name: 'x', from: 'a/**', to: 'b/**' }],
          roleImports: [],
        }),
        expect: 'missing a non-empty reason',
      },
      {
        name: 'the ruler is not declared',
        policy: JSON.stringify({
          version: 1,
          owner: 'fixture',
          rationale: 'x',
          ruler: {},
          fidelity: POLICY_BASE.fidelity,
          forbiddenEdges: [
            { id: 'x', name: 'x', from: 'a/**', to: 'b/**', reason: 'x' },
          ],
          roleImports: [],
        }),
        expect: 'must declare ruler.typeAware',
      },
      {
        name: 'the fidelity block is absent',
        policy: JSON.stringify({
          version: 1,
          owner: 'fixture',
          rationale: 'x',
          ruler: POLICY_BASE.ruler,
          forbiddenEdges: [
            { id: 'x', name: 'x', from: 'a/**', to: 'b/**', reason: 'x' },
          ],
          roleImports: [],
        }),
        expect: 'must declare a fidelity block',
      },
      {
        name: 'the fidelity ceiling is out of range',
        policy: JSON.stringify({
          ...POLICY_BASE,
          fidelity: {
            ...POLICY_BASE.fidelity,
            maxUnresolvedInternalFraction: 4,
          },
          forbiddenEdges: [
            { id: 'x', name: 'x', from: 'a/**', to: 'b/**', reason: 'x' },
          ],
          roleImports: [],
        }),
        expect: 'between 0 and 1',
      },
    ];

    for (const fixtureCase of cases) {
      const fixture = buildTree(fixtureCase.policy);
      try {
        // No stub: the policy is read before the tool is ever resolved, which is
        // itself the claim - a broken rule set must not be able to reach the
        // measuring step at all.
        const result = await runAnalyzer(
          architectureAnalyzer,
          contextFor(fixture.tree)
        );
        expectRefused(result);
        expect(result.errors[0].subject).toBe(POLICY_PATH);
        expect(result.errors[0].message).toContain(fixtureCase.expect);
      } finally {
        fixture.tree.cleanup();
      }
    }
  });

  // A graph with nodes but no edges. The report is valid and the resolver exited
  // zero, but nothing was compared, so nothing can be concluded. "No edges" is a
  // measurement of zero, and it must not read as a clean architecture.
  test('a graph with no edges is refused rather than reported clean', async () => {
    const fixture = buildTree(POLICY_OPEN);
    try {
      // Every eligible file cruised, so the per-file reconciliation is satisfied
      // and the refusal is about the edges themselves.
      const home = installStub(fixture.tree, stubReport(fixture.tree));
      const result = await withToolHome(home, () =>
        runAnalyzer(architectureAnalyzer, contextFor(fixture.tree))
      );
      expectRefused(result);
      expect(result.errors[0].message).toContain(
        'found no internal dependency edges'
      );
    } finally {
      fixture.tree.cleanup();
    }
  });

  // The pin being wrong must fail the run rather than silently measuring with a
  // different instrument. This is what makes the tool-home override safe.
  test('a resolver whose version is not the pinned one is refused', async () => {
    const fixture = buildTree(POLICY_OPEN);
    try {
      fixture.tree.write(
        `.quality/tools/${TOOL_ENTRYPOINT_RELATIVE}`,
        `if (process.argv.includes('--version')) { process.stdout.write('17.0.0\\n'); process.exit(0) }\nprocess.exit(0)\n`
      );
      const result = await withToolHome(fixture.tree.abs('.quality/tools'), () =>
        runAnalyzer(architectureAnalyzer, contextFor(fixture.tree))
      );
      expectRefused(result);
      expect(result.errors[0].kind).toBe('tool-missing');
      expect(result.errors[0].message).toContain(DEPCRUISE_VERSION);
      expect(result.errors[0].message).toContain('17.0.0');
    } finally {
      fixture.tree.cleanup();
    }
  });

  // A missing tool home must not fall back to `bun x`. The fallback is the thing
  // that was measured to cruise zero modules for a directory argument while
  // exiting zero, so falling back to it would rebuild the exact defect.
  test('a missing tool home is refused, not silently replaced by an unpinned run', async () => {
    const fixture = buildTree(POLICY_OPEN);
    try {
      const result = await withToolHome(
        fixture.tree.abs('.quality/absent-tools'),
        () => runAnalyzer(architectureAnalyzer, contextFor(fixture.tree))
      );
      expectRefused(result);
      expect(result.errors[0].kind).toBe('tool-missing');
      expect(result.errors[0].message).toContain('does not fall back');
    } finally {
      fixture.tree.cleanup();
    }
  });
});

describe('architecture: the graph rules, independent of the resolver', () => {
  // These cases exercise the rules over a graph written by hand. They are here
  // for the cases the fixture tree cannot state cheaply - a component of one, an
  // edge that leaves the repository - and because a rule that is only ever tested
  // through a tool is a rule whose failures are attributed to the tool.
  function graphOf(
    edges: Array<[string, string, string?]>
  ): ReturnType<typeof buildInternalGraph> {
    const modules = new Map<string, { source: string; dependencies: unknown[] }>();
    for (const [from, to, specifier] of edges) {
      if (!modules.has(from)) modules.set(from, { source: from, dependencies: [] });
      if (!modules.has(to)) modules.set(to, { source: to, dependencies: [] });
      modules.get(from)?.dependencies.push({
        module: specifier ?? `./${to.split('/').pop()}`,
        resolved: to,
      });
    }
    return buildInternalGraph(
      {
        modules: [...modules.values()] as never,
        summary: {
          totalCruised: modules.size,
          totalDependenciesCruised: edges.length,
          violations: [],
        },
      },
      [...modules.keys()]
    );
  }

  const policy: ArchitecturePolicy = {
    version: 1,
    owner: 'fixture',
    rationale: 'fixture',
    ruler: { typeAware: false, rationale: 'fixture' },
    fidelity: {
      maxUnresolvedInternalFraction: 0.05,
      requireEveryEligibleFileCruised: true,
      rationale: 'fixture',
    },
    forbiddenEdges: [
      {
        id: 'layer',
        name: 'bottom must not import top',
        from: 'src/types/**',
        to: 'src/components/**',
        reason: 'fixture',
      },
    ],
    roleImports: [],
    notDeclared: [],
  };

  test('a self-import and a two-file loop are told apart', () => {
    // A module importing itself is a one-member component, and a component of one
    // is not a cycle. Reporting it would open the baseline with a finding per
    // self-referential file.
    const self = graphOf([['src/a.ts', 'src/a.ts']]);
    expect(cycleFindings(self)).toEqual([]);

    const pair = graphOf([
      ['src/b.ts', 'src/a.ts'],
      ['src/a.ts', 'src/b.ts'],
    ]);
    const findings = cycleFindings(pair);
    expect(findings.length).toBe(1);
    // Identity is the lexicographically smallest member, so the finding does not
    // depend on which file the traversal happened to start from.
    expect(findings[0].subject).toBe('src/a.ts');
    expect(findings[0].metric?.value).toBe(2);
  });

  test('a deep chain of 5,000 files does not overflow the walk', () => {
    // Iterative Tarjan, for a reason that is about honesty rather than
    // performance: a recursive walk's failure mode is a stack overflow deep
    // inside the traversal, which arrives as a thrown exception and becomes a
    // FAILED run - indistinguishable from a problem with the graph. An explicit
    // stack cannot overflow, so "the walk completed" stays a fact about the graph.
    const edges: Array<[string, string]> = [];
    for (let index = 0; index < 5_000; index += 1) {
      edges.push([`src/deep/f${index}.ts`, `src/deep/f${index + 1}.ts`]);
    }
    const graph = graphOf(edges);
    expect(cycleFindings(graph)).toEqual([]);
    const components = stronglyConnectedComponents(graph.nodes, graph.adjacency);
    expect(components.length).toBe(5_001);
  });

  test('an edge that leaves the repository is counted, not reported', () => {
    // `src/a.ts` importing an installed package is normal and must not be a
    // finding, but it must also not vanish: it is counted in its own unit so a
    // reader can see how much of the graph was not this repository's.
    const graph = buildInternalGraph(
      {
        modules: [
          {
            source: 'src/a.ts',
            dependencies: [
              { module: 'zod', resolved: 'zod', dependencyTypes: ['npm'] },
            ],
          },
        ] as never,
        summary: { totalCruised: 1, totalDependenciesCruised: 1, violations: [] },
      },
      ['src/a.ts']
    );
    expect(graph.edges).toEqual([]);
    expect(graph.externalEdges).toBe(1);
    expect(cycleFindings(graph)).toEqual([]);
    expect(boundaryFindings(graph, policy, () => null)).toEqual([]);
  });

  test('a role rule with no role to compare against does not fire', () => {
    // An edge to a file the universe does not classify has no ownership to
    // violate. Firing here would make every unclassified file a boundary
    // violation, which is a report about the manifest rather than about the code.
    const graph = graphOf([['src/a.ts', 'src/types/b.ts']]);
    const rolePolicy: ArchitecturePolicy = {
      ...policy,
      forbiddenEdges: [],
      roleImports: [
        { id: 'r', from: 'production-source', allowed: ['production-source'], reason: 'fixture' },
      ],
    };
    const roles = new Map([
      ['src/a.ts', 'production-source'],
      ['src/types/b.ts', 'production-source'],
    ]);
    expect(boundaryFindings(graph, rolePolicy, (p) => roles.get(p) ?? null)).toEqual([]);
    const violations = boundaryFindings(
      graph,
      {
        ...rolePolicy,
        roleImports: [
          { id: 'r', from: 'production-source', allowed: [], reason: 'fixture' },
        ],
      },
      (p) => roles.get(p) ?? null
    );
    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe(RULES.boundaryViolation);
  });

  test('a literal-but-absent specifier is unresolved even when it is dynamic', () => {
    const graph = buildInternalGraph(
      {
        modules: [
          {
            source: 'src/loader.ts',
            dependencies: [
              { module: './absent.js', couldNotResolve: true, dynamic: true },
              { module: 'zod', couldNotResolve: true },
            ],
          },
        ] as never,
        summary: { totalCruised: 1, totalDependenciesCruised: 2, violations: [] },
      },
      ['src/loader.ts']
    );
    // The literal-but-absent one IS unresolved-internal, even though it is
    // dynamic. Measured on the real repository: 24 unresolved dependencies are
    // dynamic and 7 are relative paths to files that genuinely do not exist.
    // Filtering by `dynamic` would hide seven real missing modules behind a flag
    // that only means "the import is deferred".
    expect(graph.unresolvedInternal.length).toBe(1);
    expect(graph.unresolvedInternal[0].specifier).toBe('./absent.js');
    expect(graph.externalEdges).toBe(1);
  });

  test('the computed-specifier detector counts what the resolver cannot report', () => {
    // The detector exists because the resolver is SILENT about these, not because
    // it fails on them - so the shapes it must catch are exactly the shapes a
    // person writes when loading a plugin by name, and the shapes it must not
    // catch are ordinary literal imports, which the resolver already handles.
    const counted = filesWithComputedSpecifiers([
      { path: 'src/a.ts', text: "await import(name)\n" },
      { path: 'src/b.ts', text: "await import('./plugins/' + name + '.js')\n" },
      {
        path: 'src/c.ts',
        text: 'const p = (await import(`./plugins/${name}.js`)) as Plugin\n',
      },
      { path: 'src/d.ts', text: "const m = require(`./plugins/${name}.js`)\n" },
      { path: 'src/e.ts', text: "await import('./literal.js')\n" },
      { path: 'src/f.ts', text: 'const m = require("./literal.js")\n' },
      { path: 'src/g.ts', text: "import { x } from './static.js'\n" },
    ]);
    expect(counted).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);

    // The over-reporting direction is the safe one and is stated rather than
    // hidden: a computed specifier mentioned inside a comment or a string is
    // counted, because the alternative - a parser - is a second implementer of the
    // same question, and being wrong there would be a wrong FINDING. This count is
    // only ever a note and an exclusion.
    expect(hasComputedSpecifier("// see import(name) above\n")).toBe(true);
    expect(hasComputedSpecifier("await import('./a.js')\nawait import(`./b.js`)\n")).toBe(
      true
    );
    expect(hasComputedSpecifier("await import('./a.js')\nrequire('./b.js')\n")).toBe(
      false
    );
  });
});

describe('architecture: the evidence is tied to the rules that produced it', () => {
  // ARCH-17. The policy file is what turns a graph observation into a finding, so
  // editing it changes what the accepted baseline MEANS. If it were not a policy
  // input, a boundary could be deleted from the file and every finding it produced
  // would disappear while every baseline entry still matched - the ratchet would
  // silently forgive the debt.
  test('ARCH-17 the policy is a declared input, and changing it voids the evidence', () => {
    const fixture = buildTree(POLICY_OPEN);
    try {
      // Exactly the list `cli.ts` folds into `computeCandidateIdentity`, so the
      // assertion is about the identity the engine actually computes rather than
      // about a list this test assembled.
      const policyFiles = [
        ...policyFilesFor(ANALYZER),
        ...(architectureAnalyzer.policyFiles ?? []),
      ];
      expect(architectureAnalyzer.policyFiles).toContain(POLICY_PATH);
      const before = policyDigest(fixture.tree.root, policyFiles);

      // Declaring a boundary is a policy change, not a code change, and it must
      // move the digest: the accepted evidence describes a repository whose
      // allowed graph was the one in force when it was accepted.
      fixture.policy(POLICY_BOUNDARY);
      const after = policyDigest(fixture.tree.root, policyFiles);
      expect(after).not.toBe(before);
    } finally {
      fixture.tree.cleanup();
    }
  });

  test('removing the policy file also voids the evidence', () => {
    const fixture = buildTree(POLICY_OPEN);
    try {
      const policyFiles = [
        ...policyFilesFor(ANALYZER),
        ...(architectureAnalyzer.policyFiles ?? []),
      ];
      const before = policyDigest(fixture.tree.root, policyFiles);
      rmSync(fixture.tree.abs(POLICY_PATH));
      expect(policyDigest(fixture.tree.root, policyFiles)).not.toBe(before);
    } finally {
      fixture.tree.cleanup();
    }
  });

  test('the pin, the ruler and the tool path are declared where a reader can find them', () => {
    // These are the three facts a future reader needs in order to re-run this
    // measurement by hand, and each is asserted rather than described: the
    // version the adapter verifies, the ruler it declares, and the resolution of
    // the tool home.
    expect(DEPCRUISE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(architectureAnalyzer.rules).toHaveProperty(RULES.forbiddenEdge);
    expect(architectureAnalyzer.rules).toHaveProperty(RULES.runtimeCycle);
    expect(architectureAnalyzer.rules).toHaveProperty(RULES.boundaryViolation);
    // ARCH-003 and ARCH-005 have no rule id, and the registry must not claim
    // otherwise. A rule id this analyzer cannot emit would show up in
    // `quality rules` and in no run record or baseline, which is how a registry
    // stops being evidence a reader can check. ARCH-003 is the ARCH-002 metric
    // (proved through the real gate in the grown-cycle case); ARCH-005 is the
    // fidelity precondition (proved in its own case above).
    expect(architectureAnalyzer.rules).not.toHaveProperty('ARCH-003');
    expect(architectureAnalyzer.rules).not.toHaveProperty('ARCH-005');
    // The rule set that IS declared says what it emits, including how the growth
    // guarantee is expressed, so a reader of `quality rules` is not left to infer
    // it from the metric's absence.
    expect(architectureAnalyzer.rules[RULES.runtimeCycle]).toContain('metric');

    const fixture = buildTree(POLICY_OPEN);
    try {
      const { home, entrypoint } = resolveToolHome(fixture.tree.root);
      expect(home).toBe(join(fixture.tree.root, '.quality', 'tools'));
      expect(entrypoint).toBe(join(home, ...TOOL_ENTRYPOINT_RELATIVE.split('/')));
    } finally {
      fixture.tree.cleanup();
    }
  });

  test('the tool home pin moves the toolchain digest, so a new instrument is a new epoch', () => {
    // The adapter's TOOL_HOME comment claims the tool home's lockfile and
    // package.json are hashed into `toolchainDigest`. That claim was false until
    // the two paths were listed in TOOLCHAIN_INPUTS - `engineImplementationFiles`
    // walks only `scripts/quality`, so the tool home was covered by no digest at
    // all, and a pin could move while every accepted baseline kept matching.
    //
    // Asserting membership alone would be a tautology, so this measures the
    // property that matters: on a tree that HAS a tool home, changing the pin
    // changes the digest, and the digest is stable when nothing changes.
    const homeFiles = [
      '.quality/tools/package.json',
      '.quality/tools/bun.lock',
    ];
    for (const file of homeFiles) expect(TOOLCHAIN_INPUTS).toContain(file);

    const fixture = buildTree(POLICY_OPEN);
    try {
      const written: Array<[string, string]> = [
        ['.quality/tools/package.json', JSON.stringify({ name: 'fixture-tools', dependencies: { 'dependency-cruiser': DEPCRUISE_VERSION } })],
        ['.quality/tools/bun.lock', '# fixture lock\n'],
      ];
      for (const [rel, body] of written) {
        mkdirSync(dirname(fixture.tree.abs(rel)), { recursive: true });
        writeFileSync(fixture.tree.abs(rel), body, 'utf8');
      }

      const before = computeCandidateIdentity(fixture.tree.root, []).toolchainDigest;
      expect(computeCandidateIdentity(fixture.tree.root, []).toolchainDigest).toBe(before);

      writeFileSync(
        fixture.tree.abs('.quality/tools/bun.lock'),
        '# fixture lock\n# a moved pin\n',
        'utf8'
      );
      const after = computeCandidateIdentity(fixture.tree.root, []).toolchainDigest;
      expect(after).not.toBe(before);
    } finally {
      fixture.tree.cleanup();
    }
  });
});
