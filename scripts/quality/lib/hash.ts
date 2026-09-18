import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Order-independent digest over a set of entries.
 * Sorting + newline joining means a digest is reproducible across git versions
 * and filesystem enumeration order.
 */
export function setDigest(entries: Iterable<string>): string {
  const sorted = [...entries].sort();
  return sha256Hex(sorted.join('\n'));
}

export function fileDigest(absolutePath: string): string {
  try {
    return sha256Hex(readFileSync(absolutePath));
  } catch {
    return 'unreadable';
  }
}

/** Digest of the contents of every existing file in `candidates`. */
export function filesDigest(repoRoot: string, candidates: string[]): string {
  const parts: string[] = [];
  for (const candidate of [...candidates].sort()) {
    const absolute = join(repoRoot, candidate);
    parts.push(`${candidate}:${fileDigest(absolute)}`);
  }
  return sha256Hex(parts.join('\n'));
}

/**
 * Files whose contents decide what a rule is allowed to tolerate.
 *
 * `scripts/build.ts` is here because SOURCE_STUB_PATHS and SPECIFIC_SOURCE_STUBS
 * are exemption lists: widening them must be visible as a policy change, not as a
 * quiet edit that makes findings disappear. `tsconfig.json` is here because the
 * resolver reads `paths` from it.
 *
 * Anything that changes what is tolerated but is NOT in this list is a policy
 * hole. `package.json` is deliberately absent and lives in the toolchain digest
 * instead - adding a script does not change what quality means.
 */
export const POLICY_INPUTS = [
  'scripts/build.ts',
  'tsconfig.json',
  // The runtime-roots manifest declares which files are first-class runtime code,
  // and its own rationale states that it is hashed into policyDigest and that
  // widening or narrowing it invalidates accepted baselines. Neither was true
  // while the manifest had no reader, so a scope change was invisible to the
  // ratchet. Listed here so the manifest's claim about itself is enforced.
  '.quality/policy/runtime-roots.json',
];

/**
 * Files that describe the environment a measurement was taken in. A change here
 * means the measurement is not directly comparable to a previous one.
 */
export const TOOLCHAIN_INPUTS = [
  'package.json',
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'tsconfig.json',
];
