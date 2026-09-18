import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CandidateIdentity } from './types';
import { git, headOid, isCheckoutDirty, listUntrackedFiles } from './git';
import { fileDigest, sha256Hex, setDigest } from './hash';
import { POLICY_INPUTS, TOOLCHAIN_INPUTS } from './hash';
import { readText } from './fsutil';

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
    a.toolchainDigest === b.toolchainDigest
  );
}

export function shortIdentity(identity: CandidateIdentity): string {
  return [
    identity.head.slice(0, 8),
    identity.trackedChangesDigest.slice(0, 8),
    identity.relevantUntrackedDigest.slice(0, 8),
    identity.policyDigest.slice(0, 8),
    identity.toolchainDigest.slice(0, 8),
  ].join('/');
}
