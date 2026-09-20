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
  // The source-universe manifest decides ELIGIBILITY: which roles grant which
  // capability, and therefore which files each analyzer is allowed to see. It has
  // the same defect class as `runtime-roots.json` above and a wider blast radius,
  // because it is the manifest every analyzer's scope is derived from - and it was
  // covered by no digest. Measured: rewriting this file's owner and role table
  // left `policyDigest` byte-identical, because it is loaded only by `cli.ts` and
  // resolved only as an ANALYZER_POLICY_INPUTS entry, which never contained it.
  //
  // Its own rationale claims the opposite ("this file is hashed into policyDigest
  // and invalidates accepted baselines"). A scope manifest that can be narrowed
  // while every baseline keeps matching is the ratchet bypass this file exists to
  // close: removing a role from `checks` drops a whole subsystem from every
  // measurement, and without this entry the run reports a smaller scope under an
  // unchanged digest, so nothing reports that anything changed.
  '.quality/policy/source-universe.json',
  // `.gitignore` decides what `git ls-files --others --exclude-standard` reports,
  // and the SOURCE UNIVERSE is built from exactly that: an ignored file is not in
  // the universe at all, so it is not measured and not reportable. Ignoring a
  // file is therefore a scope change made in a file no analyzer reads, and it was
  // covered by no digest - a candidate could remove debt from every measurement by
  // adding one line to `.gitignore`, and every baseline would still match. It is a
  // policy input for that reason and not because it configures a tool.
  '.gitignore',
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
  // The architecture analyzer does not run its resolver out of the repository's
  // own dependency graph: `bun x` was measured resolving a DIFFERENT typescript
  // than the one pinned here, which silently degrades dependency-cruiser to a
  // non-TS parser (287 modules and 300 of 331 edges unresolved in one file,
  // against 2,176 modules and 60 unresolved through the pinned home). So the
  // instrument is the tool home, and its pin is the two files below.
  //
  // They were covered by no digest, because `engineImplementationFiles` walks
  // only `scripts/quality` and `computeCandidateIdentity` passes no extra files.
  // That made the analyzer's own doc comment - "the lockfile plus package.json
  // are hashed into toolchainDigest" - false, which is precisely the state a
  // reproducible instrument must not be in: a pin could move and accepted
  // baselines would keep matching, re-scoring the same tree under a different
  // ruler with no epoch change. Listed here so the claim is enforced.
  '.quality/tools/package.json',
  '.quality/tools/bun.lock',
];
