/**
 * Regression fixtures for the source-integrity analyzer.
 *
 * Each fixture encodes a failure mode that was *observed in this repository*, not
 * invented. The point of the suite is that reconnaissance stops being a paragraph
 * in a report and becomes something CI can re-run.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  createClassifier,
  extractEdges,
  maskComments,
  moduleKey,
} from '../adapters/sourceIntegrity';
import { STUB_MARKER_LINE, createFixtureTree, stubContents } from './tree';
import { loadBuildManifest } from '../lib/buildManifest';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

describe('INT-001/002  full-path identity, never basename', () => {
  test('two modules with the same basename classify independently', () => {
    const tree = createFixtureTree();
    try {
      // Fixture A: the exact mistake the previous session made. `a/index.js` is a
      // stub; `b/index.js` is real. A basename-matched tool cannot tell them apart.
      tree.write('src/a/index.js', stubContents());
      tree.write('src/b/index.js', 'export const real = 1;\n');
      tree.track('src/a/index.js');
      tree.track('src/b/index.js');

      const classify = createClassifier({
        repoRoot: tree.root,
        trackedFiles: tree.tracked(),
        // Only `src/a/index` is declared. `src/b/index` must not inherit that.
        declaredStubs: new Map([['src/a/index', 'source-stub-paths']]),
      });

      const fromA = classify({
        importer: 'src/parent.ts',
        specifier: './a/index.js',
        kind: 'import-statement',
      });
      const fromB = classify({
        importer: 'src/parent.ts',
        specifier: './b/index.js',
        kind: 'import-statement',
      });

      expect(fromA.classification).toBe('declared-legacy-stub');
      expect(fromA.target).toBe('src/a/index.js');

      expect(fromB.classification).toBe('real-implementation');
      expect(fromB.target).toBe('src/b/index.js');

      // The decisive assertion: identity differs.
      expect(fromA.target).not.toBe(fromB.target);
    } finally {
      tree.cleanup();
    }
  });

  test('an undeclared stub with the same basename as a declared one still fails', () => {
    const tree = createFixtureTree();
    try {
      tree.write('src/a/index.js', stubContents());
      tree.write('src/b/index.js', stubContents());
      tree.track('src/a/index.js');
      tree.track('src/b/index.js');

      const classify = createClassifier({
        repoRoot: tree.root,
        trackedFiles: tree.tracked(),
        declaredStubs: new Map([['src/a/index', 'source-stub-paths']]),
      });

      expect(
        classify({ importer: 'src/p.js', specifier: './a/index.js', kind: 'import-statement' })
          .classification
      ).toBe('declared-legacy-stub');
      expect(
        classify({ importer: 'src/p.js', specifier: './b/index.js', kind: 'import-statement' })
          .classification
      ).toBe('unexpected-stub');
    } finally {
      tree.cleanup();
    }
  });
});

describe('INT-003  generated stub that is not declared', () => {
  test('a manufactured stub is new debt, not tolerated debt', () => {
    const tree = createFixtureTree();
    try {
      tree.write('src/foo/baz.js', stubContents());
      tree.track('src/foo/baz.js');

      const classify = createClassifier({
        repoRoot: tree.root,
        trackedFiles: tree.tracked(),
        declaredStubs: new Map(),
      });

      const finding = classify({
        importer: 'src/foo/bar.ts',
        specifier: './baz.js',
        kind: 'import-statement',
      });

      expect(finding.classification).toBe('unexpected-stub');
      expect(finding.rule).toBe('INT-003');
      expect(finding.severity).toBe('error');
    } finally {
      tree.cleanup();
    }
  });

  test('a declared historical stub is tolerated but still reported', () => {
    const tree = createFixtureTree();
    try {
      tree.write('src/utils/protectedNamespace.js', stubContents());
      tree.track('src/utils/protectedNamespace.js');

      const classify = createClassifier({
        repoRoot: tree.root,
        trackedFiles: tree.tracked(),
        declaredStubs: new Map([
          ['src/utils/protectedNamespace', 'source-stub-paths'],
        ]),
      });

      const finding = classify({
        importer: 'src/utils/envUtils.ts',
        specifier: './protectedNamespace.js',
        kind: 'require',
      });

      expect(finding.classification).toBe('declared-legacy-stub');
      expect(finding.rule).toBe('INT-002');
      // Tolerated, therefore warning - but never info, because it is not clean.
      expect(finding.severity).toBe('warning');
      expect(finding.evidence['declaredBy']).toBe('source-stub-paths');
    } finally {
      tree.cleanup();
    }
  });
});

describe('stub detection is not a marker substring test', () => {
  test('a specific stub with a custom body is still recognized', () => {
    const tree = createFixtureTree();
    try {
      // Faithful to src/utils/protectedNamespace.js: a build.ts SPECIFIC stub with
      // custom contents and NO marker comment. A marker-only detector reports
      // this as a real implementation and silently loses the debt.
      tree.write(
        'src/utils/protectedNamespace.js',
        [
          'export default {};',
          'export const PROTECTED_NAMESPACE_PREFIXES = [];',
          'export function isProtectedNamespace(_name) {',
          '  return false;',
          '}',
          '',
        ].join('\n')
      );
      tree.track('src/utils/protectedNamespace.js');

      const classify = createClassifier({
        repoRoot: tree.root,
        trackedFiles: tree.tracked(),
        declaredStubs: new Map([
          ['src/utils/protectedNamespace', 'source-stub-paths'],
        ]),
      });

      const finding = classify({
        importer: 'src/utils/envUtils.ts',
        specifier: './protectedNamespace.js',
        kind: 'require',
      });

      expect(finding.classification).toBe('declared-legacy-stub');
    } finally {
      tree.cleanup();
    }
  });

  test('a real implementation placed at a declared stub path wins', () => {
    const tree = createFixtureTree();
    try {
      // build.ts uses ensureFile, so a real module at a declared stub path is
      // never overwritten. It must NOT be reported as a stub.
      tree.write(
        'src/utils/protectedNamespace.js',
        [
          "import { isProtected } from '../security/namespace.js';",
          'export function isProtectedNamespace(name) {',
          "  return isProtected(name, 'ant');",
          '}',
          '',
        ].join('\n')
      );
      tree.track('src/utils/protectedNamespace.js');

      const classify = createClassifier({
        repoRoot: tree.root,
        trackedFiles: tree.tracked(),
        declaredStubs: new Map([
          ['src/utils/protectedNamespace', 'source-stub-paths'],
        ]),
      });

      const finding = classify({
        importer: 'src/utils/envUtils.ts',
        specifier: './protectedNamespace.js',
        kind: 'require',
      });

      expect(finding.classification).toBe('real-implementation');
    } finally {
      tree.cleanup();
    }
  });

  test("the analyzer's own source is not mistaken for a stub", () => {
    const tree = createFixtureTree();
    try {
      // The marker appears as a string literal in tooling source.
      tree.write(
        'scripts/quality/lib/thing.ts',
        [
          `const STUB_MARKER = '// Generated snapshot stub for missing research-only module.';`,
          'export const STUB_MAX_BYTES = 1024;',
          'export function check(text) { return text.startsWith(STUB_MARKER); }',
          '',
        ].join('\n')
      );
      tree.track('scripts/quality/lib/thing.ts');

      const classify = createClassifier({
        repoRoot: tree.root,
        trackedFiles: tree.tracked(),
        declaredStubs: new Map(),
      });

      const finding = classify({
        importer: 'scripts/quality/cli.ts',
        specifier: './lib/thing.js',
        kind: 'import-statement',
      });

      expect(finding.classification).toBe('real-implementation');
    } finally {
      tree.cleanup();
    }
  });
});

describe('INT-004  declaration without implementation', () => {
  test('a .d.ts alone does not satisfy runtime integrity', () => {
    const tree = createFixtureTree();
    try {
      tree.write('src/types/message.d.ts', 'export interface Message { id: string }\n');
      tree.track('src/types/message.d.ts');

      const classify = createClassifier({
        repoRoot: tree.root,
        trackedFiles: tree.tracked(),
        declaredStubs: new Map(),
      });

      // Faithful to the observed case: src/services/compact/compact.ts imports
      // "../../types/message.js" and that type layer simply is not in the tree.
      const finding = classify({
        importer: 'src/services/compact/compact.ts',
        specifier: '../../types/message.js',
        kind: 'import-statement',
      });

      expect(finding.classification).toBe('unexpected-missing');
      expect(finding.rule).toBe('INT-004');
      expect(finding.target).toBe('src/types/message.d.ts');
      expect(finding.detail).toContain('no runtime-loadable implementation');
    } finally {
      tree.cleanup();
    }
  });

  test('no file at all is a distinct classification from declaration-only', () => {
    const tree = createFixtureTree();
    try {
      const classify = createClassifier({
        repoRoot: tree.root,
        trackedFiles: [],
        declaredStubs: new Map(),
      });

      const finding = classify({
        importer: 'src/services/compact/compact.ts',
        specifier: '../../types/message.js',
        kind: 'import-statement',
      });

      expect(finding.classification).toBe('unresolved-no-implementation');
      expect(finding.target).toBeNull();
    } finally {
      tree.cleanup();
    }
  });
});

describe('INT-005  ambiguous resolution', () => {
  test('a specifier matching several implementations is a defect', () => {
    const tree = createFixtureTree();
    try {
      // `./thing` with both thing.ts and thing.tsx present.
      tree.write('src/thing.ts', 'export const a = 1;\n');
      tree.write('src/thing.tsx', 'export const b = 1;\n');
      tree.track('src/thing.ts');
      tree.track('src/thing.tsx');

      const classify = createClassifier({
        repoRoot: tree.root,
        trackedFiles: tree.tracked(),
        declaredStubs: new Map(),
      });

      const finding = classify({
        importer: 'src/parent.ts',
        specifier: './thing',
        kind: 'import-statement',
      });

      expect(finding.classification).toBe('ambiguous-resolution');
      expect(finding.rule).toBe('INT-005');
    } finally {
      tree.cleanup();
    }
  });
});

describe('INT-008  on-disk but untracked', () => {
  test('an untracked stub is the build-manufactured, irreproducible case', () => {
    const tree = createFixtureTree();
    try {
      // A stub on disk that no commit contains: this is the auto-stub condition.
      tree.write('src/foo/generated.js', stubContents());

      const classify = createClassifier({
        repoRoot: tree.root,
        trackedFiles: [],
        declaredStubs: new Map(),
      });

      const finding = classify({
        importer: 'src/foo/bar.ts',
        specifier: './generated.js',
        kind: 'import-statement',
      });

      expect(finding.classification).toBe('untracked-generated');
      expect(finding.rule).toBe('INT-008');
      expect(finding.evidence['tracked']).toBe(false);
      expect(finding.evidence['stub']).toBe(true);
    } finally {
      tree.cleanup();
    }
  });

  test('an untracked real file is mid-edit, not corruption', () => {
    const tree = createFixtureTree();
    try {
      tree.write('src/foo/in-progress.ts', 'export const x = 1;\n');

      const classify = createClassifier({
        repoRoot: tree.root,
        trackedFiles: [],
        declaredStubs: new Map(),
      });

      const finding = classify({
        importer: 'src/foo/bar.ts',
        specifier: './in-progress.js',
        kind: 'import-statement',
      });

      // Distinct from the build-stub case: the classifier must not accuse a
      // developer's uncommitted work of being irreproducible build output.
      expect(finding.classification).toBe('uncommitted-source');
      expect(finding.evidence['stub']).toBe(false);
      expect(finding.detail).toContain('do not baseline this');
    } finally {
      tree.cleanup();
    }
  });

  test('without a tracked universe the classifier makes no untracked claim', () => {
    const tree = createFixtureTree();
    try {
      tree.write('src/foo/thing.ts', 'export const x = 1;\n');

      const classify = createClassifier({
        repoRoot: tree.root,
        trackedFiles: [],
        hasTrackedUniverse: false,
        declaredStubs: new Map(),
      });

      const finding = classify({
        importer: 'src/foo/bar.ts',
        specifier: './thing.js',
        kind: 'import-statement',
      });

      expect(finding.classification).toBe('real-implementation');
    } finally {
      tree.cleanup();
    }
  });
});

describe('comment masking', () => {
  test('import-shaped text inside comments is not a dependency', () => {
    const source = `
// We must not import('../build.ts') - that module runs the build.
/* require('./not-real.js') is discussed here. */
import { real } from './real.js'
`;
    const edges = extractEdges(source, 'src/x.ts');
    const specifiers = edges.runtime.map((edge) => edge.specifier);

    expect(specifiers).toEqual(['./real.js']);
  });

  test('masking preserves offsets and line count', () => {
    const source = 'const a = 1;\n// hidden\nconst b = 2;\n';
    const masked = maskComments(source);
    expect(masked.split('\n').length).toBe(source.split('\n').length);
    expect(masked.indexOf('const b')).toBe(source.indexOf('const b'));
  });
});

describe('edge extraction: require() and dynamic import()', () => {
  test('require() is captured because Bun scan() omits it', () => {
    const source = `
import { a } from './a.js'
const b = require('./b.js')
async function f() { return import('./c.js') }
`;
    const edges = extractEdges(source, 'src/x.ts');
    const specifiers = edges.runtime.map((edge) => edge.specifier);

    expect(specifiers).toContain('./a.js');
    expect(specifiers).toContain('./b.js');
    expect(specifiers).toContain('./c.js');

    const requireEdge = edges.runtime.find((edge) => edge.specifier === './b.js');
    expect(requireEdge?.kind).toBe('require');
  });

  test('import type is not a runtime edge', () => {
    const source = `
import type { T } from './types.js'
import { real } from './real.js'
`;
    const edges = extractEdges(source, 'src/x.ts');
    const specifiers = edges.runtime.map((edge) => edge.specifier);

    expect(specifiers).toContain('./real.js');
    expect(specifiers).not.toContain('./types.js');
    expect(edges.typeOnlyCount).toBe(1);
  });

  test('a computed dynamic import is recorded but not asserted', () => {
    const source = 'const p = `./${name}.js`; const m = import(p);';
    const edges = extractEdges(source, 'src/x.ts');
    // Not a literal specifier: must not appear as a runtime edge with a fake path.
    expect(
      edges.runtime.some((edge) => edge.specifier.includes('${'))
    ).toBe(false);
  });
});

describe('moduleKey normalization', () => {
  test('moduleKey strips only source extensions', () => {
    expect(moduleKey('src/a/index.js')).toBe('src/a/index');
    expect(moduleKey('src/a/index.tsx')).toBe('src/a/index');
    expect(moduleKey('src/a/index.d.ts')).toBe('src/a/index.d');
  });

  test('STUB_MARKER_LINE is the marker the analyzer looks for', () => {
    expect(stubContents()).toContain(STUB_MARKER_LINE);
  });
});

describe('real repository: declared-stub authority is non-empty and includes both manifests', () => {
  test('build.ts extraction succeeds and unions both manifest shapes', () => {
    const manifest = loadBuildManifest(REPO_ROOT);

    expect(manifest.declaredStubs.size).toBeGreaterThan(80);
    // `SnapshotUpdateDialog` appears only in SPECIFIC_SOURCE_STUBS. If extraction
    // only read SOURCE_STUB_PATHS it would be missing, and a real stub would be
    // reported as unexpected new debt.
    expect(manifest.declaredStubs.has('src/components/agents/SnapshotUpdateDialog')).toBe(
      true
    );
    expect(manifest.manufacturedPackages.has('bundle')).toBe(true);
  });
});
