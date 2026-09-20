import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  AnalyzerError,
  AnalyzerResult,
  Coverage,
  Finding,
  Severity,
} from '../lib/types';
import { coverageIsComplete } from '../lib/types';
import type { Analyzer, AnalyzerContext } from '../lib/registry';
import { compileGlob } from '../lib/glob';
import { ensureDir, isFile, readText } from '../lib/fsutil';
import { runTool, parseJsonReport } from '../lib/toolrun';
import { makeFinding } from '../lib/finding';
import { failedResult } from '../lib/failure';

/**
 * Architecture: the shape of the dependency graph.
 *
 * The four analyzers before this one each ask about a file. Source integrity asks
 * whether a file's specifiers resolve; maintainability whether a file's code is
 * too tangled; duplication whether two files are the same file; unused structure
 * whether a file, export or dependency is needed at all. This one asks about the
 * RELATIONSHIPS BETWEEN files, and about nothing else. A cycle, an inverted layer
 * and a dependency that crosses an ownership boundary are not defects in any line
 * of code - every line parses, resolves, passes lint and may be needed - so no
 * analyzer that reads one file at a time can see them.
 *
 * The division of labour is the same as the other adapters and is worth stating
 * precisely, because it is what keeps this file small: dependency-cruiser is the
 * RESOLVER and this adapter is the RULES. The tool produces a module graph; this
 * file decides that a strongly connected component of size two or more is a
 * defect and that an edge from src/utils to src/components is one. That is why
 * the generated tool config carries no `forbidden` array at all - putting rules
 * in there as well would give the repository two places to look for the same
 * decision, and only one of them would be covered by policyDigest.
 */

export const ARCHITECTURE_ANALYZER = 'architecture';

/**
 * Pinned here rather than in the dependency graph.
 *
 * The version alone is not the fix - see TOOL_HOME. The two are one decision and
 * reading either without the other will mislead, so the reasoning is in one place.
 */
export const DEPCRUISE_VERSION = '18.3.1';

/**
 * The tool home: a self-contained project holding the pinned tool and its
 * resolution dependencies, with its own lockfile.
 *
 * `bun x dependency-cruiser` was the obvious invocation and it was measured
 * against this repository rather than assumed, which is the only reason its
 * defects are known. Two separate ones, both of which produce a confident wrong
 * answer while exiting zero:
 *
 *  1. RESOLVER DEGRADATION. dependency-cruiser picks its TypeScript support up
 *     from a `typescript` package it resolves from its own location. Under
 *     `bun x` there is none, so it falls back to a non-TypeScript parser and
 *     cannot map a `./x.js` specifier to `x.ts`. Measured over this repository:
 *     287 modules cruised with 300 of 331 edges unresolved, versus 2,176 modules
 *     with 60 unresolved through the tool home. A graph whose edges are almost
 *     all missing cannot form cycles, so the cycle rule would have reported
 *     almost nothing and read as a clean architecture.
 *
 *  2. SCOPE VANISHING. Under `bun x`, passing a directory name as the argument
 *     cruises ZERO modules: exit 0, well-formed JSON, `totalCruised: 0`, empty
 *     stderr. Passing a glob works. The same command under the tool home handles
 *     both. This is not a subtle difference in results; it is a run that measured
 *     nothing looking exactly like a run that found nothing.
 *
 * A `bun x` pin also has no lockfile entry, so its transitive resolution is
 * whatever a package cache happens to hold. The tool home has one, and the
 * lockfile plus package.json are hashed into `toolchainDigest`, which means a
 * changed pin invalidates accepted baselines instead of silently re-scoring the
 * tree under a different instrument. This is the end state the duplication and
 * unused-structure adapters could not reach by pinning a version in source, and
 * it is the reason this adapter does not use `bun x` at all.
 */
export const TOOL_HOME = '.quality/tools';

/**
 * The instrument's location may be overridden, and it is safe to allow because
 * the version probe below turns a wrong location into a FAILED run rather than a
 * different measurement.
 *
 * The seam exists because the tool home is 30 MB across 1,166 files, so a fixture
 * tree cannot carry its own copy - and copying one per fixture is the defect the
 * acceptance harness already paid for once with `.candidate-build`. Pointing a
 * fixture at the repository's own tool home is the only way to exercise the real
 * invocation path without that cost.
 *
 * What it can NOT do is change what is measured: the probe compares the installed
 * tool's own reported version against the pin, so an override that lands on a
 * different build fails the run instead of silently re-scoring the tree. The
 * location used is recorded in the run's notes for the same reason.
 */
export const TOOL_HOME_ENV = 'QUALITY_ARCHITECTURE_TOOL_HOME';

export const TOOL_ENTRYPOINT_RELATIVE =
  'node_modules/dependency-cruiser/bin/dependency-cruiser.mjs';

export const POLICY_PATH = 'scripts/quality/policy/architecture.config.json';

/** The tool home in force, and the binary inside it. */
export function resolveToolHome(repoRoot: string): {
  home: string;
  entrypoint: string;
} {
  const override = process.env[TOOL_HOME_ENV];
  const declared =
    override !== undefined && override.trim().length > 0 ? override.trim() : TOOL_HOME;
  const home = resolve(repoRoot, declared);
  return { home, entrypoint: join(home, TOOL_ENTRYPOINT_RELATIVE) };
}


export const RULES = {
  forbiddenEdge: 'ARCH-001',
  runtimeCycle: 'ARCH-002',
  boundaryViolation: 'ARCH-004',
} as const;

/**
 * ARCH-003 and ARCH-005 have no rule ids here, and in both cases that is a
 * decision rather than an omission. The reasons differ, and both are worth the
 * two paragraphs they cost.
 *
 * ARCH-003, "an accepted cycle expands", is implemented as the METRIC on the
 * ARCH-002 finding rather than as a second finding. The reason is arithmetic: a
 * cycle is one structural fact, and giving its growth its own id would put two
 * entries in the baseline for one cycle - one that says "this cycle exists" and
 * one that says "and it is bigger" - which is how a ratchet teaches people to
 * distrust its counts. The `metric` field is exactly the mechanism for this, and
 * it is not a comment: when a cycle with an accepted baseline entry grows, the
 * id is unchanged (the subject is the lexicographically smallest member, so no
 * member has to be renamed), `lib/compare.ts` reads both metrics and pushes
 * `worsened: {reason: 'metric-worsened'}`, and the gate blocks. The fixture
 * asserts that through the real gate rather than through this sentence. Nothing
 * here would work if the metric were a number nobody compared, so the rule is
 * declared where it acts - `metric` below - and NOT in `rules`, because a rule
 * id this analyzer cannot emit has no business in a registry whose contract is
 * "ids this analyzer can emit".
 *
 * ARCH-005, "unresolved internal graph edge", was proposed as a finding rule and
 * is deliberately NOT one. The source-integrity analyzer already reports every
 * unresolved internal specifier as INT-004, and 52 of them are accepted baseline
 * entries - including `src/hooks/useReplBridge.tsx::../bridge/webhookSanitizer.js`,
 * which is one of the 13 edges this analyzer sees. A second id would report one
 * defect twice, in two baselines. It is handled as a PRECONDITION instead, which
 * is strictly stronger: a finding can be accepted into a baseline and forgotten,
 * while a failed precondition makes the run INCOMPLETE and cannot be accepted at
 * all. It is declared in the policy file as `fidelity`, with the measurement
 * behind each threshold written next to it.
 */
export const RULE_DESCRIPTIONS: Record<string, string> = {
  'ARCH-001': 'Dependency edge that a declared layer boundary forbids.',
  'ARCH-002':
    'Set of files that import each other, so no order exists among them. The ' +
    'member count is the metric; a cycle that gains members worsens it.',
  'ARCH-004': 'Dependency that crosses a source-universe ownership boundary.',
};

export type Classification =
  | 'forbidden-edge'
  | 'runtime-cycle'
  | 'boundary-violation';

export const TIMEOUT_MS = 900_000;

/**
 * The rule count ceiling, above which the graph is not trusted.
 *
 * Lives in the policy file. Read here as a fallback so a policy missing the key
 * is an explicit error rather than an accidental zero.
 */
const FIDELITY_KEYS = [
  'maxUnresolvedInternalFraction',
  'requireEveryEligibleFileCruised',
] as const;

interface ForbiddenEdge {
  id: string;
  name: string;
  from: string;
  to: string;
  reason: string;
  measuredEdgesWhenDeclared?: number;
}

interface RoleImport {
  id: string;
  from: string;
  allowed: string[];
  reason: string;
}

/**
 * Exported because the rules are evaluated against a hand-built graph in the
 * fixtures, and a rule's input type is part of that test surface. A private type
 * would force the fixture to declare a structurally identical copy, which would
 * then drift from this one silently - the fixture would keep passing while
 * testing a shape the adapter no longer reads.
 */
export interface ArchitecturePolicy {
  version: number;
  owner: string;
  rationale: string;
  ruler: { typeAware: boolean; rationale: string };
  fidelity: {
    maxUnresolvedInternalFraction: number;
    requireEveryEligibleFileCruised: boolean;
    rationale: string;
  };
  forbiddenEdges: ForbiddenEdge[];
  roleImports: RoleImport[];
  notDeclared: Array<{ name: string; measuredEdges: number; reason: string }>;
}

/** One dependency-cruiser module record, narrowed to the fields we consume. */
interface CruisedModule {
  source: string;
  couldNotResolve?: boolean;
  coreModule?: boolean;
  dependencyTypes?: string[];
  dependencies?: CruisedDependency[];
}

interface CruisedDependency {
  module: string;
  resolved?: string;
  couldNotResolve?: boolean;
  dynamic?: boolean;
  dependencyTypes?: string[];
  circular?: boolean;
}

interface CruiseReport {
  modules: CruisedModule[];
  summary: {
    totalCruised: number;
    totalDependenciesCruised: number;
    violations: unknown[];
    optionsUsed?: { environment?: { version?: string } };
  };
}

/**
 * Read and validate the policy.
 *
 * Every field is required, and a missing or malformed one throws. The engine's
 * `runAnalyzer` turns that throw into a FAILED execution, which is the correct
 * outcome for "the rules could not be read": the alternative - defaulting to an
 * empty rule set - would report a repository with no declared boundaries as a
 * repository with no boundary violations, and those are opposite claims.
 */
export function readPolicy(repoRoot: string): ArchitecturePolicy {
  const raw = readText(join(repoRoot, POLICY_PATH));
  if (raw === null) {
    throw new Error(`architecture policy not found at ${POLICY_PATH}`);
  }
  let parsed: ArchitecturePolicy;
  try {
    parsed = JSON.parse(raw) as ArchitecturePolicy;
  } catch (error) {
    throw new Error(
      `architecture policy at ${POLICY_PATH} is not valid JSON: ` +
        (error instanceof Error ? error.message : String(error))
    );
  }
  if (typeof parsed.ruler?.typeAware !== 'boolean') {
    throw new Error(
      `${POLICY_PATH} must declare ruler.typeAware as a boolean; the ruler is ` +
        'not a preference that can be defaulted, because the two rulers disagree ' +
        'about the graph rather than about the threshold'
    );
  }
  validateFidelity(parsed);
  validateBoundaries(parsed);
  return parsed;
}

/**
 * The fidelity block, checked field by field.
 *
 * Separate from `readPolicy` because it validates one section of the file and
 * shares no state with the others: a reader asking "what must the fidelity block
 * contain" gets one function instead of a slice of a longer ladder.
 */
function validateFidelity(parsed: ArchitecturePolicy): void {
  const fidelity = parsed.fidelity;
  if (fidelity === undefined) {
    throw new Error(`${POLICY_PATH} must declare a fidelity block`);
  }
  for (const key of FIDELITY_KEYS) {
    if (!(key in fidelity)) {
      throw new Error(`${POLICY_PATH} fidelity block is missing ${key}`);
    }
  }
  if (
    typeof fidelity.maxUnresolvedInternalFraction !== 'number' ||
    fidelity.maxUnresolvedInternalFraction < 0 ||
    fidelity.maxUnresolvedInternalFraction > 1
  ) {
    throw new Error(
      `${POLICY_PATH} fidelity.maxUnresolvedInternalFraction must be a number ` +
        'between 0 and 1'
    );
  }
}

/**
 * The boundary rules, checked so that a malformed entry cannot read as "no rule".
 *
 * An empty rule list is refused rather than accepted: it would report this
 * repository as having no architectural constraints, when what actually happened
 * is that none were declared. Those are opposite claims and the report cannot
 * tell them apart on its own.
 */
function validateBoundaries(parsed: ArchitecturePolicy): void {
  if (!Array.isArray(parsed.forbiddenEdges) || !Array.isArray(parsed.roleImports)) {
    throw new Error(
      `${POLICY_PATH} must declare both forbiddenEdges and roleImports as arrays; ` +
        'omitting one would silently narrow the architecture rules'
    );
  }
  if (parsed.forbiddenEdges.length === 0 && parsed.roleImports.length === 0) {
    throw new Error(
      `${POLICY_PATH} declares no boundaries at all, which would report this ` +
        'repository as having no architectural constraints rather than as having ' +
        'none declared'
    );
  }
  for (const rule of parsed.forbiddenEdges) {
    for (const field of ['id', 'name', 'from', 'to', 'reason'] as const) {
      if (typeof rule[field] !== 'string' || rule[field].length === 0) {
        throw new Error(
          `${POLICY_PATH} forbiddenEdges entry ${JSON.stringify(rule.id)} is ` +
            `missing a non-empty ${field}`
        );
      }
    }
  }
  for (const rule of parsed.roleImports) {
    if (typeof rule.id !== 'string' || !Array.isArray(rule.allowed)) {
      throw new Error(
        `${POLICY_PATH} roleImports entry ${JSON.stringify(rule.id)} must carry an ` +
          'id and an allowed array'
      );
    }
  }
}

/**
 * Generate the tool config.
 *
 * `forbidden` is intentionally empty: the rules live in this adapter so that a
 * reader has one place to look and policyDigest has one thing to cover. The only
 * content is the resolution behaviour the graph depends on, and each option is
 * here because leaving it out changes the graph rather than the threshold.
 */
export function toolConfig(policy: ArchitecturePolicy): string {
  const options = {
    doNotFollow: { path: ['node_modules'] },
    // The same three exclusions the unused-structure adapter declares. A copy of
    // this repository under `.candidate-build` is a different program, and the
    // quality engine's own directory is not the product.
    exclude: {
      path: '(^|/)(node_modules|dist|\\.candidate-build|\\.quality)/',
    },
    // The ruler, from policy. See the measurement recorded there.
    tsPreCompilationDeps: policy.ruler.typeAware,
    tsConfig: { fileName: 'tsconfig.json' },
  };
  return `// Generated by the architecture analyzer. Do not edit; see ${POLICY_PATH}.\nmodule.exports = ${JSON.stringify({ forbidden: [], options }, null, 2)};\n`;
}

/**
 * Tarjan's algorithm, written iteratively.
 *
 * Iterative rather than recursive on purpose. This runs over a graph that
 * currently contains a 604-file component, and a recursive walk's failure mode is
 * a stack overflow deep inside the traversal - which arrives as a thrown
 * exception, becomes a FAILED run, and is indistinguishable from a graph problem.
 * An explicit stack cannot overflow, so "the walk completed" stays a fact about
 * the graph instead of a fact about the interpreter's limits.
 */
export function stronglyConnectedComponents(
  nodes: string[],
  adjacency: Map<string, string[]>
): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  for (const root of nodes) {
    if (index.has(root)) continue;

    // Frame: the node being explored, and how far through its successors we are.
    const frames: Array<{ node: string; successors: string[]; next: number }> = [
      { node: root, successors: adjacency.get(root) ?? [], next: 0 },
    ];
    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (frame.next < frame.successors.length) {
        const successor = frame.successors[frame.next];
        frame.next += 1;
        if (!index.has(successor)) {
          index.set(successor, counter);
          low.set(successor, counter);
          counter += 1;
          stack.push(successor);
          onStack.add(successor);
          frames.push({
            node: successor,
            successors: adjacency.get(successor) ?? [],
            next: 0,
          });
        } else if (onStack.has(successor)) {
          low.set(
            frame.node,
            Math.min(low.get(frame.node) as number, index.get(successor) as number)
          );
        }
        continue;
      }

      frames.pop();
      const finished = frame.node;
      if (frames.length > 0) {
        const parent = frames[frames.length - 1].node;
        low.set(parent, Math.min(low.get(parent) as number, low.get(finished) as number));
      }
      if (low.get(finished) === index.get(finished)) {
        const component: string[] = [];
        let popped: string;
        do {
          popped = stack.pop() as string;
          onStack.delete(popped);
          component.push(popped);
        } while (popped !== finished);
        components.push(component);
      }
    }
  }
  return components;
}

/**
 * The internal graph: nodes a file can be, edges that stay inside the repository.
 *
 * An edge is internal only when BOTH ends are eligible files. An edge to an
 * installed package, to a Node builtin or to a file the universe does not measure
 * is not a statement about this repository's architecture, and counting it would
 * inflate the graph with nodes that have no importer's obligations attached.
 */
export interface InternalGraph {
  nodes: string[];
  adjacency: Map<string, string[]>;
  edges: Array<{ from: string; to: string; specifier: string }>;
  externalEdges: number;
  unresolvedInternal: Array<{ from: string; specifier: string }>;
  cruised: Set<string>;
}

/**
 * A specifier whose target is not a literal: `import(name)`,
 * `import('./plugins/' + name + '.js')`, `import(`./plugins/${name}.js`)`.
 *
 * Counted from SOURCE TEXT, by a deliberately conservative test - the first
 * character after the paren is not a quote - because the resolver cannot be asked
 * for these at all. MEASURED on the pinned tool, four shapes in one file
 * (template literal, bare identifier, concatenation, and a computed `require`):
 * dependency-cruiser 18.3.1 emitted ONE dependency record, the literal-but-absent
 * `./does-not-exist.js`, and NOTHING for the four computed ones. They are not
 * reported as unresolved. They are absent.
 *
 * That is exactly the kind of silence this engine exists to refuse, and it cannot
 * be caught by the unresolved-fraction ceiling: there is no unresolvable edge to
 * count. So it is counted here instead, as a number, and stated in the run notes
 * for what it is - a bounded, known blind spot in the edge set. The consequence
 * is stated rather than implied: a cycle that runs only through a computed
 * specifier cannot be seen by the cycle rule, and a reader is told how many files
 * could hide one.
 *
 * This is a visibility aid, not a finding, and the detector is text-based on
 * purpose: a comment or a string containing `import(` inflates the count, and the
 * count is not used to decide anything. Making it a finding would require a
 * parser, and a wrong finding is worse than a slightly generous note.
 */
export const SPECIFIER_CALL = /(?:\bimport|\brequire)\s*\(/g;

/** A single quoted string and nothing else. */
const LITERAL_ARGUMENT = /^\s*(?:'[^']*'|"[^"]*")\s*$/;

export function hasComputedSpecifier(text: string): boolean {
  for (const match of text.matchAll(SPECIFIER_CALL)) {
    const start = (match.index ?? 0) + match[0].length;
    const rest = text.slice(start);
    // The argument expression is what stands before the closing paren. Nested
    // parens inside a literal argument would truncate this early, which is why the
    // verdict below is "is this exactly one quoted string" rather than any attempt
    // to parse an expression: truncation can only ever make a literal look
    // shorter, and a shorter literal still starts and ends with the same quote.
    const close = rest.indexOf(')');
    const argument = close === -1 ? rest.slice(0, 200) : rest.slice(0, close);
    if (!LITERAL_ARGUMENT.test(argument)) return true;
  }
  return false;
}

export function filesWithComputedSpecifiers(
  files: Array<{ path: string; text: string }>
): string[] {
  return files
    .filter((file) => hasComputedSpecifier(file.text))
    .map((file) => file.path)
    .sort();
}

export function buildInternalGraph(
  report: CruiseReport,
  eligible: Iterable<string>
): InternalGraph {
  const eligibleSet = new Set(eligible);
  const nodes = new Set<string>();
  const cruised = new Set<string>();
  const adjacency = new Map<string, string[]>();
  const edges: InternalGraph['edges'] = [];
  const unresolvedInternal: InternalGraph['unresolvedInternal'] = [];
  let externalEdges = 0;

  const isRelative = (specifier: string): boolean =>
    specifier.startsWith('./') || specifier.startsWith('../');

  for (const record of report.modules) {
    const source = record.source;
    if (!eligibleSet.has(source)) continue;
    cruised.add(source);
    nodes.add(source);
    const successors: string[] = [];
    for (const dependency of record.dependencies ?? []) {
      const target = dependency.resolved;
      if (target !== undefined && eligibleSet.has(target)) {
        successors.push(target);
        edges.push({ from: source, to: target, specifier: dependency.module });
        continue;
      }
      if (dependency.couldNotResolve === true) {
        const specifier = dependency.module;
        if (isRelative(specifier) || specifier.startsWith('src/')) {
          // Deliberately NOT filtered by `dependency.dynamic`. Measured on this
          // repository: 24 unresolved dependencies are dynamic, and 7 of those are
          // relative paths to files that genuinely do not exist
          // (`src/main.tsx -> ./cli/rollback.js`). They are `await import()` of a
          // literal path, not a computed one, so excluding every dynamic edge
          // would have hidden seven real missing modules behind a flag that only
          // means "the import is deferred".
          unresolvedInternal.push({ from: source, specifier });
        } else {
          externalEdges += 1;
        }
        continue;
      }
      externalEdges += 1;
    }
    successors.sort();
    adjacency.set(source, [...new Set(successors)]);
  }

  return {
    nodes: [...nodes].sort(),
    adjacency,
    edges,
    externalEdges,
    unresolvedInternal,
    cruised,
  };
}

function isTestOrFixturePath(path: string): boolean {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) || path.includes('/fixtures/');
}

export function finding(input: {
  rule: string;
  classification: Classification;
  subject: string;
  locator: string;
  anchor: string;
  severity: Severity;
  detail: string;
  evidence: Finding['evidence'];
  metric?: Finding['metric'];
}): Finding {
  // Delegates rather than rebuilding the object. The identity expression
  // `${rule}::${subject}::${anchor}` is the one string the ratchet depends on
  // matching between an analyzer and a baseline entry, and this adapter and
  // unusedStructure had grown separate copies of it.
  return makeFinding(input);
}

/**
 * The boundary rules, evaluated against the graph.
 *
 * Separated from `run` so the rule evaluation is testable against a graph built
 * by hand, without a tool invocation - which is what lets the fixtures assert
 * that a rule fires without also depending on dependency-cruiser's own behaviour.
 */
export function boundaryFindings(
  graph: InternalGraph,
  policy: ArchitecturePolicy,
  roleOf: (path: string) => string | null
): Finding[] {
  const findings: Finding[] = [];

  for (const rule of policy.forbiddenEdges) {
    const fromMatches = compileGlob(rule.from);
    const toMatches = compileGlob(rule.to);
    for (const edge of graph.edges) {
      if (!fromMatches(edge.from) || !toMatches(edge.to)) continue;
      findings.push(
        finding({
          rule: RULES.forbiddenEdge,
          classification: 'forbidden-edge',
          subject: edge.from,
          locator: edge.specifier,
          anchor: `${rule.id}::${edge.specifier}`,
          severity: 'error',
          detail: `${rule.name}. ${rule.reason}`,
          evidence: { boundary: rule.id, boundaryName: rule.name, target: edge.to },
        })
      );
    }
  }

  for (const rule of policy.roleImports) {
    const allowed = new Set(rule.allowed);
    for (const edge of graph.edges) {
      const fromRole = roleOf(edge.from);
      const toRole = roleOf(edge.to);
      if (fromRole !== rule.from) continue;
      if (toRole === null) continue;
      if (allowed.has(toRole)) continue;
      findings.push(
        finding({
          rule: RULES.boundaryViolation,
          classification: 'boundary-violation',
          subject: edge.from,
          locator: edge.specifier,
          anchor: `${rule.id}:${fromRole}->${toRole}::${edge.specifier}`,
          severity: 'error',
          detail: `${fromRole} may not depend on ${toRole}. ${rule.reason}`,
          evidence: { boundary: rule.id, fromRole, toRole, target: edge.to },
        })
      );
    }
  }

  return findings;
}

/**
 * Cycle findings: one per strongly connected component, not one per edge.
 *
 * The distinction is the difference between a usable ratchet and an unusable one.
 * dependency-cruiser's own `no-circular` rule reported 1,397 violations on this
 * repository; the same graph has SIX components. Reporting per edge would put
 * 1,397 entries in a baseline for six facts, and any genuine improvement - one
 * file leaving the big component - would move hundreds of entries at once,
 * making the ratchet unreadable exactly when someone is trying to read it.
 *
 * Identity is the lexicographically smallest member path, which is stable under
 * the change that matters: a component that GAINS members keeps its identity, so
 * the growth shows up as the same finding's metric rising rather than as one
 * finding resolving and another appearing. `metric` carries the member count with
 * `limit: null` and `lower-is-better`, which the engine already turns into
 * `worsened: metric-worsened`; that is how ARCH-003 is realized. A component that
 * shrinks reports as `improved`.
 */
export function cycleFindings(graph: InternalGraph): Finding[] {
  const components = stronglyConnectedComponents(graph.nodes, graph.adjacency);
  const findings: Finding[] = [];
  for (const component of components) {
    if (component.length < 2) continue;
    const members = [...component].sort();
    const subject = members[0];
    const shown = members.slice(0, 12);
    findings.push(
      finding({
        rule: RULES.runtimeCycle,
        classification: 'runtime-cycle',
        subject,
        locator: `${members.length} files`,
        anchor: subject,
        severity: 'error',
        detail:
          `Import cycle of ${members.length} runtime files. No member can be built, ` +
          `loaded or tested without the others. Members: ` +
          `${shown.join(', ')}${members.length > shown.length ? `, and ${members.length - shown.length} more` : ''}`,
        evidence: {
          cycleSize: members.length,
          cycleDigest: members.join('\n'),
          containsTests: members.some(isTestOrFixturePath) ? 'true' : 'false',
        },
        metric: {
          name: 'cycle-members',
          value: members.length,
          limit: null,
          direction: 'lower-is-better',
        },
      })
    );
  }
  return findings.sort((a, b) => a.id.localeCompare(b.id));
}

function failed(
  context: AnalyzerContext,
  errors: AnalyzerError[],
  notes: string[]
): AnalyzerResult {
  return failedResult({
    analyzer: ARCHITECTURE_ANALYZER,
    reason: 'run-did-not-produce-a-measurement',
    errors,
    notes: [
      'the finding list is empty because no measurement was taken, not because ' +
        'the architecture is clean',
      ...notes,
    ],
    eligible: context.candidateFiles.length,
  });
}

export const architectureAnalyzer: Analyzer = {
  id: ARCHITECTURE_ANALYZER,
  description:
    'Dependency-graph shape: import cycles, forbidden layer edges and ownership ' +
    'boundary crossings, resolved by a pinned dependency-cruiser.',
  rules: RULE_DESCRIPTIONS,
  extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx'],
  policyFiles: [POLICY_PATH],
  // The graph semantics, borrowed deliberately: see capabilitiesRationale in the
  // policy file. This is the executable universe and nothing else.
  capabilities: ['import-integrity'],
  // A graph analyzer must not be handed a sample - a sample cannot support any
  // statement about a graph, so the engine gives this analyzer the whole
  // candidate set or the run is refused.
  contentScoped: false,

  async run(context: AnalyzerContext): Promise<AnalyzerResult> {
    const errors: AnalyzerError[] = [];
    const notes: string[] = [];

    let policy: ArchitecturePolicy;
    try {
      policy = readPolicy(context.repoRoot);
    } catch (error) {
      errors.push({
        kind: 'scan-failure',
        subject: POLICY_PATH,
        message: error instanceof Error ? error.message : String(error),
      });
      return failed(context, errors, [
        'the architecture rules could not be read, so no statement about the ' +
          'graph was made',
      ]);
    }

    const eligible = [...context.candidateFiles].sort();
    if (eligible.length === 0) {
      errors.push({
        kind: 'scan-failure',
        subject: ARCHITECTURE_ANALYZER,
        message: 'no eligible files, so the graph would be empty by construction',
      });
      return failed(context, errors, [
        'nothing was eligible for measurement; an empty graph is not a clean graph',
      ]);
    }

    const tool = resolvePinnedResolver(context, errors, notes);
    if (tool === null) {
      return failed(context, errors, [
        'the resolver that is installed is not the resolver this analyzer pinned, ' +
          'so the run would be attributed to the wrong instrument',
      ]);
    }
    const toolBinary = tool.entrypoint;

    const configPath = join(context.cacheDir, 'architecture.dependency-cruiser.cjs');
    try {
      ensureDir(context.cacheDir);
      writeFileSync(configPath, toolConfig(policy), 'utf8');
    } catch (error) {
      errors.push({
        kind: 'scan-failure',
        subject: POLICY_PATH,
        message: `could not write the tool config: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      return failed(context, errors, ['the resolver config could not be written']);
    }

    // The walk is rooted at the two directories that contain every eligible
    // file. Measured: eligibleFor(['import-integrity']) is 2,188 files and all of
    // them live under src/ or scripts/, so rooting here cannot silently narrow
    // the scope - and if it ever did, the per-file reconciliation below catches
    // it rather than trusting this sentence.
    const roots = [...new Set(eligible.map((file) => file.split('/')[0]))].sort();
    notes.push(`roots: ${roots.join(', ')}`);
    notes.push(
      `ruler: ${policy.ruler.typeAware ? 'type-aware' : 'runtime value edges only'}`
    );
    notes.push(
      `declared boundaries: ${policy.forbiddenEdges.length} forbidden edge rule(s), ` +
        `${policy.roleImports.length} ownership rule(s)`
    );

    const outcome = runTool({
      // `node`, not `bun x`. See TOOL_HOME for the two measured reasons.
      command: process.execPath,
      args: [
        toolBinary,
        '--config',
        configPath,
        '--output-type',
        'json',
        ...roots,
      ],
      cwd: context.repoRoot,
      timeoutMs: TIMEOUT_MS,
      // In JSON mode dependency-cruiser's exit code does NOT encode violations -
      // measured: a run with violations and a run with none both exit 0. Only a
      // run that did not happen exits non-zero, and it does so with EMPTY stdout.
      // So the exit code is a necessary condition and never a sufficient one, and
      // the report parse below is what actually decides whether a measurement
      // was taken. Accepting 0 alone here would be the classic mistake this
      // engine exists to prevent.
      successCodes: [0],
    });

    if (!outcome.ok) {
      errors.push({
        kind: 'scan-failure',
        subject: ARCHITECTURE_ANALYZER,
        message: outcome.failure ?? 'the resolver did not complete',
      });
      const detail = `${outcome.stderr}\n${outcome.stdout}`
        .trim()
        .split('\n')
        .slice(0, 4);
      return failed(context, errors, [
        'the resolver did not produce a graph; the finding list is absent rather ' +
          'than empty',
        ...detail,
      ]);
    }

    const parsed = parseJsonReport<CruiseReport>(outcome.stdout);
    if (!parsed.ok) {
      errors.push({
        kind: 'scan-failure',
        subject: ARCHITECTURE_ANALYZER,
        message: parsed.reason,
      });
      return failed(context, errors, [
        'the resolver exited successfully but its graph could not be read, so this ' +
          'is not a clean run',
      ]);
    }
    const report = parsed.value;
    if (!report.summary || !Array.isArray(report.modules)) {
      errors.push({
        kind: 'scan-failure',
        subject: ARCHITECTURE_ANALYZER,
        message: 'the report has no summary or module list',
      });
      return failed(context, errors, [
        'the resolver reported a shape this adapter does not recognize; an ' +
          'unrecognized report is not an empty one',
      ]);
    }

    const graph = buildInternalGraph(report, eligible);

    const fidelity = assessGraphFidelity({ context, graph, policy, eligible, notes });
    errors.push(...fidelity.errors);
    if (fidelity.reasons.length > 0) {
      return failed(context, errors, fidelity.reasons);
    }

    const roleOf = (path: string): string | null => context.universe.roleOf(path);
    const findings = [
      ...boundaryFindings(graph, policy, roleOf),
      ...cycleFindings(graph),
    ].sort((a, b) => a.id.localeCompare(b.id));

    // Cycles involving test or fixture files are reported, not filtered. The
    // source universe already decided these files are graph-eligible, and a test
    // file in an import cycle is still a real structural fact; filtering them
    // here would be this adapter silently narrowing a scope the manifest owns.
    const cycleCount = findings.filter((f) => f.rule === RULES.runtimeCycle).length;
    if (cycleCount > 0) {
      notes.push(
        `${cycleCount} cyclic component(s); each is reported once with its member ` +
          'count as the metric, so growth is visible as a worsened metric'
      );
    }

    const coverage: Coverage = {
      eligible: eligible.length,
      scanned: graph.cruised.size,
      skipped: eligible.length - graph.cruised.size,
      failed: 0,
      skipReasons: {},
      // Edges, not files. Counted in a different unit so they cannot be folded
      // into an arithmetic that counts files - see Coverage.exclusions. The
      // second unit is the blind spot described below: files whose edges the
      // resolver never reported, which is the one class of missing edge the
      // unresolved-fraction ceiling is structurally unable to count.
      exclusions: {
        'edges-leaving-the-repository': graph.externalEdges,
        'files-with-a-computed-specifier': fidelity.withComputed.length,
      },
    };

    return {
      analyzer: ARCHITECTURE_ANALYZER,
      findings,
      errors,
      coverage,
      complete: coverageIsComplete(coverage),
      status: 'complete',
      notes,
    };
  },
};

/**
 * Find the pinned resolver, prove it is the pinned resolver, or refuse.
 *
 * Two checks, both about the same thing: the binary this run executes must be the
 * one the pin names, because `measurementDigest` covers the version string in
 * this file and nothing about the tool home on disk.
 *
 *  - Absence: `bun x` is NOT the fallback. Measured, it cruises ZERO modules for
 *    a directory argument while exiting 0, so falling back would produce a
 *    silently empty graph that every later stage reads as a clean tree.
 *  - Version: a pin in source is a claim; the probe makes it a fact. Without it a
 *    tool home left on an older install is measured under the new pin's identity,
 *    which is the difference between a reproducible ruler and a documented one.
 *
 * Returns null after recording the reason, so the caller has one place where a
 * refusal becomes an AnalyzerResult.
 */
function resolvePinnedResolver(
  context: AnalyzerContext,
  errors: AnalyzerError[],
  notes: string[]
): { home: string; entrypoint: string } | null {
  const tool = resolveToolHome(context.repoRoot);
  if (!isFile(tool.entrypoint)) {
    errors.push({
      kind: 'tool-missing',
      subject: tool.home,
      message:
        `the pinned tool home is not installed (no ${TOOL_ENTRYPOINT_RELATIVE} ` +
        `under ${tool.home}); run \`bun install\` inside it. This analyzer does ` +
        'not fall back to `bun x`, because that invocation was measured to ' +
        'cruise zero modules for a directory argument while exiting 0',
    });
    return null;
  }

  const versionProbe = runTool({
    command: process.execPath,
    args: [tool.entrypoint, '--version'],
    cwd: context.repoRoot,
    timeoutMs: 120_000,
    successCodes: [0],
  });
  const observedVersion = versionProbe.ok ? versionProbe.stdout.trim() : '';
  if (observedVersion !== DEPCRUISE_VERSION) {
    errors.push({
      kind: 'tool-missing',
      subject: tool.home,
      message:
        `pinned dependency-cruiser ${DEPCRUISE_VERSION} but the installed tool ` +
        `reports ${observedVersion === '' ? '(nothing)' : JSON.stringify(observedVersion)}` +
        (versionProbe.ok ? '' : ` - the probe failed: ${versionProbe.failure ?? 'unknown'}`),
    });
    return null;
  }

  notes.push(
    `resolver: dependency-cruiser@${observedVersion} (verified) at ` +
      `${tool.home}${process.env[TOOL_HOME_ENV] ? ' (overridden by ' + TOOL_HOME_ENV + ')' : ''}`
  );
  return tool;
}

/**
 * Whether the graph is a faithful enough picture of the candidate to judge.
 *
 * Every check here answers the same question in a different way: "could this
 * graph be missing an edge?" A missing edge cannot form a cycle, so a low cycle
 * count over a degraded graph is a fact about the resolver and not about the
 * architecture - which is why each of these refuses the run instead of reporting
 * fewer findings. The failure reasons are returned rather than thrown so the
 * caller keeps one place where a refusal becomes an AnalyzerResult.
 *
 * The unresolved-fraction ceiling is the precondition that stands in for
 * ARCH-005. It is not a rule id because it is not a finding about the code: it is
 * the statement that no finding about the code can be made yet, which is exactly
 * what a precondition is.
 */
function assessGraphFidelity(input: {
  context: AnalyzerContext;
  graph: InternalGraph;
  policy: ArchitecturePolicy;
  eligible: string[];
  notes: string[];
}): { errors: AnalyzerError[]; reasons: string[]; withComputed: string[] } {
  const { context, graph, policy, eligible, notes } = input;
  const errors: AnalyzerError[] = [];

  // Every eligible file must have been cruised. A file the resolver never
  // parsed is an edge that cannot exist in the graph, so its absence would
  // quietly remove constraints rather than report them.
  const missed = eligible.filter((file) => !graph.cruised.has(file));
  if (missed.length > 0 && policy.fidelity.requireEveryEligibleFileCruised) {
    for (const file of missed.slice(0, 20)) {
      errors.push({
        kind: 'scan-failure',
        subject: file,
        message:
          'Eligible for the graph and absent from the cruised module set, so ' +
          'its edges were never considered.',
      });
    }
    return {
      errors,
      withComputed: [],
      reasons: [
        `${missed.length} eligible file(s) were not cruised, so the graph is not ` +
          'the graph of this candidate',
      ],
    };
  }

  const internalEdgeCount = graph.edges.length;
  const unresolvedFraction =
    internalEdgeCount + graph.unresolvedInternal.length === 0
      ? 0
      : graph.unresolvedInternal.length /
        (internalEdgeCount + graph.unresolvedInternal.length);
  notes.push(
    `graph: ${graph.nodes.length} files, ${internalEdgeCount} internal edges, ` +
      `${graph.externalEdges} edges leaving the repository, ` +
      `${graph.unresolvedInternal.length} unresolved internal specifiers ` +
      `(${(unresolvedFraction * 100).toFixed(3)}%, ceiling ` +
      `${(policy.fidelity.maxUnresolvedInternalFraction * 100).toFixed(1)}%)`
  );

  // The edge set the rules run over is the set of STATICALLY WRITTEN specifiers,
  // and that is a limit of the resolver rather than of the graph. Counted and
  // stated rather than assumed away: an unreported edge is not an unresolved one,
  // so the fidelity ceiling cannot see it, and only this number can tell a reader
  // how much of the program the cycle rule was blind to.
  const withComputed: string[] = [];
  for (const file of eligible) {
    const text = readText(context.absolute(file));
    if (text !== null && hasComputedSpecifier(text)) withComputed.push(file);
  }
  if (withComputed.length > 0) {
    notes.push(
      `${withComputed.length} file(s) contain a specifier the resolver does not ` +
        'report at all (a computed dynamic import); measured: dependency-cruiser ' +
        `${DEPCRUISE_VERSION} emits no dependency record for those, so their edges ` +
        'are absent from the graph rather than unresolved, and a cycle that runs ' +
        'only through one cannot be seen by ARCH-002. Files: ' +
        `${withComputed.slice(0, 5).join(', ')}` +
        `${withComputed.length > 5 ? `, and ${withComputed.length - 5} more` : ''}`
    );
  }

  if (unresolvedFraction > policy.fidelity.maxUnresolvedInternalFraction) {
    errors.push({
      kind: 'resolution-error',
      subject: ARCHITECTURE_ANALYZER,
      message:
        `${(unresolvedFraction * 100).toFixed(2)}% of internal specifiers did not ` +
        `resolve, above the declared ceiling of ` +
        `${(policy.fidelity.maxUnresolvedInternalFraction * 100).toFixed(1)}%. A ` +
        'graph with missing edges cannot form cycles, so a low cycle count here ' +
        'would be a fact about the resolver rather than about the architecture',
    });
    return {
      errors,
      withComputed,
      reasons: [
        'the resolved graph is too incomplete to judge; this is the exact failure ' +
          'a degraded resolver produces while exiting zero',
      ],
    };
  }

  // A graph with no internal edges is an empty graph wearing a valid report.
  if (internalEdgeCount === 0) {
    errors.push({
      kind: 'scan-failure',
      subject: ARCHITECTURE_ANALYZER,
      message:
        `the resolver cruised ${graph.nodes.length} file(s) but found no internal ` +
        'dependency edges at all, which cannot be true of this repository',
    });
    return {
      errors,
      withComputed,
      reasons: ['a graph with no edges is not a clean graph; nothing was compared'],
    };
  }

  // Roots the manifest declares that this analyzer cannot see, split from the
  // case that would be a defect. The distinction matters because the two look
  // identical in a filename list: `scripts/quality/fixtures` is declared as a
  // runtime root for the fixture harness and is NOT eligible for a graph
  // analyzer, because the source universe withholds `import-integrity` from
  // fixture trees - expected, and recorded so a reader does not have to guess
  // why the graph lacks files the manifest names. An ELIGIBLE root absent from
  // the cruised graph, by contrast, cannot reach this point at all: the
  // per-file reconciliation above refuses the run for any such file, so a note
  // here can never be the only trace of a real gap.
  if (context.runtimeRoots.length === 0) {
    errors.push({
      kind: 'scan-failure',
      subject: '.quality/policy/runtime-roots.json',
      message:
        'no runtime roots were resolved, so the entrypoints the product is ' +
        'actually started from are unknown and the graph has no anchors',
    });
    return {
      errors,
      withComputed,
      reasons: [
        'the runtime-root manifest resolved no entrypoints; a graph without ' +
          'anchors cannot be shown to describe the shipped program',
      ],
    };
  }

  const eligibleSet = new Set(eligible);
  const runtimeRootsMissing = context.runtimeRoots.filter(
    (root) => !eligibleSet.has(root)
  );
  if (runtimeRootsMissing.length > 0) {
    notes.push(
      `${runtimeRootsMissing.length} declared runtime root(s) are outside this ` +
        "analyzer's scope by policy - declared as entrypoints, but not eligible " +
        'for `import-integrity` - so they are recorded here rather than silently ' +
        `absent from the graph: ${runtimeRootsMissing.slice(0, 5).join(', ')}`
    );
  }

  return { errors, reasons: [], withComputed };
}

/** Reported by the CLI so an operator can see the pin and the resolution. */
export function toolIdentity(): { version: string; entrypoint: string } {
  return {
    version: DEPCRUISE_VERSION,
    entrypoint: `${TOOL_HOME}/${TOOL_ENTRYPOINT_RELATIVE}`,
  };
}
