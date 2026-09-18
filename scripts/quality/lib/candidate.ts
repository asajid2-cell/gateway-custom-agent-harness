import { join } from 'node:path';
import { listTrackedFiles, listUntrackedFiles } from './git';
import { isRelevantUntracked } from './identity';

/**
 * The candidate file set: everything an analyzer is allowed to consider.
 *
 *   baseline  = trusted repository state (HEAD)
 *   candidate = tracked files
 *             + relevant untracked source files
 *
 * Deleted files are absent from both lists simply because they do not exist.
 * Working-tree and staged edits are included automatically: they are edits to
 * tracked paths, which are always in this set. That matters because almost all
 * agent work happens as uncommitted modification, and a candidate model that
 * excluded uncommitted work would be blind to the case it is used for.
 */
export interface Candidate {
  repoRoot: string;
  /** Repo-relative, sorted, de-duplicated. */
  files: string[];
  trackedFiles: Set<string>;
  untrackedFiles: string[];
  /** True when git's view was readable and non-empty. */
  hasTrackedUniverse: boolean;
  notes: string[];
}

export function loadCandidate(repoRoot: string): Candidate {
  const notes: string[] = [];
  let tracked: string[] = [];
  let untracked: string[] = [];

  try {
    tracked = listTrackedFiles(repoRoot);
    untracked = listUntrackedFiles(repoRoot);
  } catch (error) {
    notes.push(
      'git could not enumerate files; candidate excludes tracked source ' +
        `(${error instanceof Error ? error.message : String(error)})`
    );
  }

  const relevantUntracked = untracked.filter(isRelevantUntracked);
  const files = [...new Set([...tracked, ...relevantUntracked])].sort();

  if (relevantUntracked.length > 0) {
    notes.push(
      `candidate includes ${relevantUntracked.length} untracked source file(s)`
    );
  }

  return {
    repoRoot,
    files,
    trackedFiles: new Set(tracked),
    untrackedFiles: relevantUntracked,
    hasTrackedUniverse: tracked.length > 0,
    notes,
  };
}

export function absoluteFor(repoRoot: string, relativePath: string): string {
  return join(repoRoot, relativePath);
}
