import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

export const STUB_MARKER_LINE =
  '// Generated snapshot stub for missing research-only module.';

export interface FixtureTree {
  root: string;
  /** Writes a file, creating parent directories. Path is repo-relative. */
  write(relPath: string, contents: string): string;
  /** Declares a path as tracked by the (simulated) repository. */
  track(relPath: string): void;
  /** Paths that will be reported as tracked. */
  tracked(): string[];
  /** Absolute path for a repo-relative path. */
  abs(relPath: string): string;
  cleanup(): void;
}

export function createFixtureTree(): FixtureTree {
  const root = mkdtempSync(join(tmpdir(), 'quality-fixture-'));
  const trackedPaths = new Set<string>();

  return {
    root,
    write(relPath: string, contents: string): string {
      const absolute = join(root, relPath);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, contents, 'utf8');
      return absolute;
    },
    track(relPath: string): void {
      trackedPaths.add(relPath.replace(/\\/g, '/'));
    },
    tracked(): string[] {
      return [...trackedPaths].sort();
    },
    abs(relPath: string): string {
      return join(root, relPath);
    },
    cleanup(): void {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function stubContents(): string {
  return `${STUB_MARKER_LINE}\nexport default {};\n`;
}
