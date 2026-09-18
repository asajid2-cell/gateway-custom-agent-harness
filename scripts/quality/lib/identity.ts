import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { CandidateIdentity } from './types';
import { git, headOid, isCheckoutDirty, listUntrackedFiles } from './git';
import { fileDigest, sha256Hex, setDigest } from './hash';
import { POLICY_INPUTS, TOOLCHAIN_INPUTS } from './hash';
import { readText, toPosix, walkFiles } from './fsutil';

/**
 * A candidate is a *state of the working tree*, not a commit.
 *
 *   baseline  = trusted repository state
 *   candidate = baseline
 *             + tracked edits
 *             + staged edits
 *             + relevant untracked source files
 *             - deleted files
 *
 * Working-tree edits are the normal case for this repository's workflow, so they
 * are the candidate. A new untracked source file is part of the candidate and is
 * analyzed; the only thing a missing git tracked-universe suppresses is the
 * *accusation* that an artifact is irreproducible, never the file's inclusion.
 */

/**
 * Files whose *content* is evidence for a quality run, regardless of whether git
 * tracks them. This closes on-disk/git divergence: a stub written by the build is
 * untracked, yet it is exactly what the integrity analyzer must see.
 */
export const RELEVANT_UNTRACKED_PATTERNS: RegExp[] = [
  /^src\/.*\.(js|mjs|cjs|jsx|ts|tsx)$/,
  /^src\/.*\.d\.ts$/,
  /^scripts\/.*\.(js|mjs|cjs|jsx|ts|tsx)$/,
];

export function isRelevantUntracked(relPath: string): boolean {
  return RELEVANT_UNTRACKED_PATTERNS.some((pattern) => pattern.test(relPath));
}

/**
 * Files that describe the environment a measurement was taken in - dependency
 * versions, runtimes and lockfiles. A change here means the measurement is not
 * directly comparable to a previous one.
 */
export function toolchainDigest(repoRoot: string): string {
  const versionPart = `bun:${(globalThis as { Bun?: { version: string } }).Bun?.version ?? 'unknown'}`;
  const nodePart = `node:${process.version}`;
  const manifestPart = TOOLCHAIN_INPUTS.filter((name) =>
    existsSync(join(repoRoot, name))
  )
    .map((name) => `${name}:${fileDigest(join(repoRoot, name))}`)
    .join(',');
  return sha256Hex(`${versionPart}|${nodePart}|${manifestPart}`);
}

/**
 * POLICY_INPUTS is re-exported, never re-declared. There is exactly one list, in
 * hash.ts, and this module cannot drift from it.
 *
 * An analyzer whose policy lives outside those inputs declares it here, so that
 * "what decides what is tolerated" stays answerable from one place. The lint
 * config is an analyzer policy input because changing a threshold changes which
 * findings are tolerable - and a threshold edit must therefore invalidate a
 * baseline rather than quietly shrinking it.
 */
export { POLICY_INPUTS, TOOLCHAIN_INPUTS };

export const ANALYZER_POLICY_INPUTS: Record<string, string[]> = {
  maintainability: ['scripts/quality/policy/maintainability.config.mjs'],
};

export function policyFilesFor(analyzer: string): string[] {
  return ANALYZER_POLICY_INPUTS[analyzer] ?? [];
}

/**
 * Every source file the engine and its analyzers are implemented in.
 *
 * Why hashing the implementation rather than trusting the declared policy list:
 * a declared input only covers what someone remembered to declare. The analyzer
 * that decides which findings exist was not covered at all, so editing the code
 * that emits a finding re-scored the whole tree under an unchanged policyDigest
 * and the baseline matched - "change the ruler, keep the measurement" was a
 * silent ratchet bypass, and a candidate could edit the very code that judges
 * it. Deriving the set from the tree also covers the engine itself, which is the
 * same defect one level up: this very fix would otherwise not invalidate the
 * baselines it corrects.
 *
 * The whole `scripts/quality` tree is hashed, including the declared policy file
 * the analyzer already names. Over-covering costs a re-accept; under-covering
 * costs correctness.
 */
export function engineImplementationFiles(repoRoot: string): string[] {
  // A missing or unreadable quality tree is a real condition (the engine may be
  // invoked from a checkout that lacks it), so its absence degrades to the
  // declared inputs rather than throwing during identity computation. The
  // distinction between "absent" and "walk failed" is not recoverable here and
  // is not silently swallowed: `assertMeasurementCoverage` reports it, so an
  // empty result can never pass for a measured one.
  let files: string[];
  try {
    files = walkFiles(join(repoRoot, 'scripts', 'quality')).files;
  } catch {
    return [];
  }
  return files
    .map((absolute) => toPosix(relative(repoRoot, absolute)))
    .filter((rel) => rel.length > 0 && !rel.includes('/.quality/runs/'))
    .sort();
}

/**
 * How the measurement is OBSERVED, as distinct from what it ALLOWS.
 *
 * The implementation that produces findings is not policy: it does not say what
 * is tolerable, it says what is visible. Keeping the two digests apart is what
 * lets `lib/migration.ts` ask "did the observation change, and if so what
 * changed about it" instead of treating every analyzer edit as a policy edit
 * whose only remedy is re-recording the baseline.
 */
export function measurementDigest(
  repoRoot: string,
  extraFiles: string[] = []
): string {
  const inputs = [
    ...new Set([...engineImplementationFiles(repoRoot), ...extraFiles]),
  ].sort();
  const parts = inputs.map((rel) => {
    const text = readText(join(repoRoot, rel));
    return `${rel}:${text === null ? 'absent' : sha256Hex(text)}`;
  });
  // The input LIST is part of the digest, not just the contents. Adding a file
  // to the measurement system changes what is observed even when every existing
  // file is byte-identical, and a digest over contents alone would miss it.
  return sha256Hex(`inputs:${inputs.join(',')}\n${parts.join('\n')}`);
}

/**
 * Policy inputs for an analyzer: the declared files plus anything the analyzer
 * names. Deliberately does NOT include the engine implementation - that is
 * `measurementDigest`, and folding it in here is what made a measurement change
 * indistinguishable from a policy change.
 */
export function measurementInputs(analyzer: string): string[] {
  return policyFilesFor(analyzer);
}

export function policyDigest(
  repoRoot: string,
  extraPolicyFiles: string[] = []
): string {
  const inputs = [...new Set([...POLICY_INPUTS, ...extraPolicyFiles])].sort();
  const parts = inputs.map((rel) => {
    const text = readText(join(repoRoot, rel));
    return `${rel}:${text === null ? 'absent' : sha256Hex(text)}`;
  });
  return sha256Hex(parts.join('\n'));
}

export function computeCandidateIdentity(
  repoRoot: string,
  policyFiles: string[] = []
): CandidateIdentity {
  let untracked: string[] = [];
  try {
    untracked = listUntrackedFiles(repoRoot);
  } catch {
    untracked = [];
  }

  const relevantUntracked = untracked.filter(isRelevantUntracked);

  // Change set: status code + path + content digest for every changed tracked
  // file. A path alone is too weak; two different edits would collide.
  const trackedChanges: string[] = [];
  const status = git(['status', '--porcelain', '--', '.'], repoRoot);
  if (!status.ok) {
    trackedChanges.push('status-unavailable');
  } else {
    for (const line of status.stdout.split('\n')) {
      if (line.length < 4) continue;
      const code = line.slice(0, 2);
      const path = line.slice(3).trim();
      if (code === '??') continue;
      trackedChanges.push(`${code} ${path}:${fileDigest(join(repoRoot, path))}`);
    }
  }

  // Also digest the content of every relevant untracked file. Digesting only the
  // name set would let an edit to an untracked file pass unnoticed - which is the
  // normal case while an agent is working.
  const untrackedParts = relevantUntracked
    .sort()
    .map((rel) => `${rel}:${fileDigest(join(repoRoot, rel))}`);

  const trackedChangesDigest = setDigest(trackedChanges);
  const relevantUntrackedDigest = setDigest(untrackedParts);

  return {
    head: headOid(repoRoot),
    headDirty: isCheckoutDirty(repoRoot),
    trackedChangesDigest,
    relevantUntrackedDigest,
    policyDigest: policyDigest(repoRoot, policyFiles),
    measurementDigest: measurementDigest(repoRoot),
    toolchainDigest: toolchainDigest(repoRoot),
    computedAt: new Date().toISOString(),
    sourceDigest: sha256Hex(
      `${trackedChangesDigest}|${relevantUntrackedDigest}`
    ),
  };
}

/**
 * Two candidates are the same measurement subject.
 *
 * This compares the *components* rather than the derived `sourceDigest`. The two
 * are equivalent when identity is constructed by computeCandidateIdentity, but a
 * component comparison is strictly stronger: if any caller ever assembles an
 * identity whose `sourceDigest` does not actually cover its parts, comparing the
 * derived value would silently certify a measurement of something else. The
 * derived field stays in the type because it is useful to cite, not because it is
 * authoritative.
 *
 * `computedAt` is deliberately not compared: it is a timestamp, not state.
 */
export function identityEqual(a: CandidateIdentity, b: CandidateIdentity): boolean {
  return (
    a.head === b.head &&
    a.trackedChangesDigest === b.trackedChangesDigest &&
    a.relevantUntrackedDigest === b.relevantUntrackedDigest &&
    a.policyDigest === b.policyDigest &&
    a.measurementDigest === b.measurementDigest &&
    a.toolchainDigest === b.toolchainDigest
  );
}

export function shortIdentity(identity: CandidateIdentity): string {
  return [
    identity.head.slice(0, 8),
    identity.trackedChangesDigest.slice(0, 8),
    identity.relevantUntrackedDigest.slice(0, 8),
    identity.policyDigest.slice(0, 8),
    identity.measurementDigest.slice(0, 8),
    identity.toolchainDigest.slice(0, 8),
  ].join('/');
}
