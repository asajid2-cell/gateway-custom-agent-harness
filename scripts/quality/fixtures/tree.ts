import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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

export interface FixtureTreeOptions {
  /**
   * Initialize a real git repository in the fixture root.
   *
   * Some loaders read the repository through git (`ls-files`, `ls-files
   * --others`) rather than the filesystem, because that is how the engine tells
   * a tracked file from a generated one. A fixture tree that is not a git
   * repository cannot exercise them at all: `listTrackedFiles` throws, and a
   * `catch` around it would silently report an empty universe - the exact
   * "found nothing" masquerade the engine's completeness rule forbids.
   */
  git?: boolean;
}

export function createFixtureTree(options: FixtureTreeOptions = {}): FixtureTree {
  const root = mkdtempSync(join(tmpdir(), 'quality-fixture-'));
  const trackedPaths = new Set<string>();

  if (options.git === true) {
    // `-b main` keeps the initial branch name off the machine's git config, so
    // the fixture does not depend on `init.defaultBranch`.
    const init = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    if (init.status !== 0) {
      throw new Error(
        `fixture tree could not initialize git in ${root}: ` +
          `${init.stderr?.toString() ?? 'no stderr'}`
      );
    }
  }

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
