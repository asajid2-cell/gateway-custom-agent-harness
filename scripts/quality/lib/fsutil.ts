import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

export function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function toPosix(path: string): string {
  return path.split(sep).join('/');
}

export function repoRelative(repoRoot: string, absolutePath: string): string {
  return toPosix(relative(repoRoot, absolutePath));
}

/** Directory names never worth walking. */
export const SKIP_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  '.build-cache',
  '.quality/runs',
  '.quality/.cache',
  'coverage',
  '.turbo',
]);

const SKIP_NAMES = new Set(['.git', 'node_modules', 'dist', 'coverage', '.turbo']);

/**
 * Bounded recursive file walk. Returns absolute paths.
 * `extensions` are matched case-insensitively with a leading dot.
 */
export function walkFiles(
  root: string,
  options: { extensions?: string[]; maxFiles?: number } = {}
): { files: string[]; truncated: boolean } {
  const extensions = options.extensions?.map((ext) => ext.toLowerCase());
  const maxFiles = options.maxFiles ?? Number.POSITIVE_INFINITY;
  const files: string[] = [];
  let truncated = false;

  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (SKIP_NAMES.has(entry)) continue;
      const absolute = join(current, entry);
      if (isDirectory(absolute)) {
        stack.push(absolute);
        continue;
      }
      if (extensions) {
        const lower = entry.toLowerCase();
        if (!extensions.some((ext) => lower.endsWith(ext))) continue;
      }
      files.push(absolute);
      if (files.length >= maxFiles) {
        truncated = true;
        return { files, truncated };
      }
    }
  }

  files.sort();
  return { files, truncated };
}

export function resolveFromRepo(repoRoot: string, candidate: string): string {
  return resolve(repoRoot, candidate);
}

export { existsSync };
