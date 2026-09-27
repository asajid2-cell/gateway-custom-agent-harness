import { spawnSync } from 'node:child_process';

export interface GitCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
}

export function git(args: string[], cwd: string): GitCommandResult {
  const proc = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // git is a console program: from a console-less parent it would open a visible
    // console window that Windows Terminal then foregrounds.
    windowsHide: true,
  });
  return {
    ok: proc.status === 0,
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
    status: proc.status,
  };
}

export function requireGit(args: string[], cwd: string): string {
  const result = git(args, cwd);
  if (!result.ok) {
    throw new Error(
      `git ${args.join(' ')} failed (${result.status ?? 'no-status'}): ${result.stderr.trim()}`
    );
  }
  return result.stdout;
}

export function listTrackedFiles(repoRoot: string): string[] {
  const out = requireGit(['ls-files', '-z', '--', '.'], repoRoot);
  return out.split('\0').filter((entry) => entry.length > 0);
}

export function listUntrackedFiles(repoRoot: string): string[] {
  const out = requireGit(
    ['ls-files', '-z', '--others', '--exclude-standard', '--', '.'],
    repoRoot
  );
  return out.split('\0').filter((entry) => entry.length > 0);
}

export function headOid(repoRoot: string): string {
  try {
    return requireGit(['rev-parse', 'HEAD'], repoRoot).trim();
  } catch {
    return 'unknown-head';
  }
}

export function isCheckoutDirty(repoRoot: string): boolean {
  const result = git(['status', '--porcelain', '--', '.'], repoRoot);
  if (!result.ok) return false;
  return result.stdout.trim().length > 0;
}
