import type { AnalyzerResult } from './types';

/**
 * The analyzer contract.
 *
 * This is the whole extension surface. An analyzer receives a resolved
 * environment and returns findings; it does not know that baselines, gates,
 * profiles, SARIF or run records exist. If a new analyzer needs to touch any of
 * those, the engine is wrong, not the analyzer.
 *
 * Deliberately NOT here: a plugin system, an event bus, a factory, a lifecycle.
 * There are two analyzers. A registry object with a Map is the correct amount of
 * machinery until that stops being true.
 */
export interface AnalyzerContext {
  repoRoot: string;
  /** Repo-relative files the analyzer may consider, in stable sorted order. */
  candidateFiles: string[];
  /** Absolute path for a repo-relative path. */
  absolute(relativePath: string): string;
  /** Repo-relative paths git tracks. */
  trackedFiles: Set<string>;
  /** Cache directory the analyzer may use. Created on demand. */
  cacheDir: string;
  notes: string[];
}

/**
 * What an analyzer contributed to the run's identity beyond its findings.
 *
 * This is the seam that keeps the engine analyzer-independent: an analyzer that
 * reads files as *policy* - a lint config, a manifest of exemptions - declares
 * them here, and the engine folds them into policyDigest without knowing what a
 * lint threshold is. Without this, a threshold edit would be invisible to the
 * baseline and "lower the limit until it passes" would be a silent ratchet bypass.
 */
export interface AnalyzerIdentityContribution {
  policyFiles: string[];
}

export interface Analyzer {
  /** Stable id. Appears in baselines, run records and CLI arguments. */
  id: string;
  /** One line, shown by `quality analyzers`. */
  description: string;
  /**
   * Rule ids this analyzer can emit, mapped to a human description.
   * Declared up front so `quality rules` needs no run and so an unknown rule id
   * in a baseline is detectable.
   */
  rules: Record<string, string>;
  /** File extensions this analyzer considers. Empty means "all". */
  extensions: string[];
  /**
   * Files whose contents decide what this analyzer tolerates. Declared, not
   * discovered: the engine cannot infer that a lint config is policy.
   */
  policyFiles?: string[];
  /**
   * Whether this analyzer analyses file *contents* rather than the file graph.
   *
   * A pure file-graph analyzer (imports, reachability, architecture) should not
   * be handed a 40-file sample of a repository with tens of thousands of files:
   * a sample cannot support any statement about the graph, so sampling it would
   * produce a confident, wrong report. Such an analyzer declares `false` and is
   * either given the whole candidate set or nothing, and says so.
   */
  contentScoped?: boolean;
  run(context: AnalyzerContext): AnalyzerResult | Promise<AnalyzerResult>;
}

const REGISTRY = new Map<string, Analyzer>();

export function registerAnalyzer(analyzer: Analyzer): void {
  if (REGISTRY.has(analyzer.id)) {
    throw new Error(
      `analyzer "${analyzer.id}" is already registered; ids must be unique because ` +
        'baselines and run records cite them'
    );
  }
  REGISTRY.set(analyzer.id, analyzer);
}

export function getAnalyzer(id: string): Analyzer {
  const analyzer = REGISTRY.get(id);
  if (analyzer === undefined) {
    throw new Error(
      `unknown analyzer "${id}"; registered: ${
        [...REGISTRY.keys()].sort().join(', ') || '(none)'
      }`
    );
  }
  return analyzer;
}

export function listAnalyzers(): Analyzer[] {
  return [...REGISTRY.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function hasAnalyzer(id: string): boolean {
  return REGISTRY.has(id);
}

/** Test seam: lets fixtures assert registration behaviour without global state. */
export function clearRegistryForTest(): void {
  REGISTRY.clear();
}

/**
 * A note the engine hands to an analyzer whose content-scoped policy excluded it
 * from a sample. Recorded rather than silent, so a report can never imply that an
 * analyzer ran over files it never saw.
 */
export const SAMPLED_RUN_REASON = 'run-was-sampled-analyzer-is-graph-scoped';
