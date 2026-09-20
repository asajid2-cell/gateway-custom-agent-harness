import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type {
  AnalyzerError,
  AnalyzerResult,
  Coverage,
  Finding,
  Severity,
} from '../lib/types';
import { coverageIsComplete } from '../lib/types';
import type { Analyzer, AnalyzerContext } from '../lib/registry';
import { ensureDir, isFile, readText } from '../lib/fsutil';
import { listTrackedFiles, listUntrackedFiles } from '../lib/git';
import { loadAliasConfig } from '../lib/resolve';
import { runTool } from '../lib/toolrun';
import { makeFinding } from '../lib/finding';
import { failedResult } from '../lib/failure';
import {
  probeToolVersion,
  resolveToolHome,
  toolEntrypointExists,
  TOOL_HOME,
  type PinnedTool,
} from '../lib/toolHome';
import { runtimeRootsPathFor } from '../lib/runtimeRoots';
import type { SourceUniverse } from '../lib/sourceUniverse';

/**
 * Unused structure: code an agent added that nothing needs.
 *
 * The three analyzers before this one asked "is the code that EXISTS correct?".
 * This one asks the opposite question: "does the code that exists need to?" A
 * dead export, an unused dependency and a file nothing reaches are not defects
 * in any line of code - every line passes lint, is duplicated nowhere, and
 * resolves correctly. They are defects in the SHAPE of the change, which is why
 * none of the other three can see them.
 *
 * That question cannot be answered by reading files. It is a reachability
 * question about the whole program, so the analyzer delegates the walk to knip
 * and owns the harder half: proving the walk's universe is this repository's.
 */

export const UNUSED_STRUCTURE_ANALYZER = 'unused-structure';

/**
 * Pinned here AND in the tool home.
 *
 * The old arrangement pinned only the VERSION, in this source, and ran knip
 * through `bun x` - which fixed knip's own version while leaving its transitive
 * resolution to whatever a package cache happened to hold. That limit was
 * recorded honestly and it was real: two machines could run the same pin and get
 * different reachability walks. The tool home removes it - knip and its graph are
 * resolved from `.quality/tools/bun.lock`, which `toolchainDigest` hashes.
 *
 * This constant survives because it is what the adapter VERIFIES the installed
 * tool against (`probeToolVersion`). A single pin could only be checked against
 * itself.
 */
export const KNIP_VERSION = '5.88.1';

/** knip as this engine installs it. See `lib/toolHome.ts` for why not `bun x`. */
export const KNIP_TOOL: PinnedTool = {
  package: 'knip',
  entrypoint: 'node_modules/knip/bin/knip.js',
  version: KNIP_VERSION,
};

export const POLICY_PATH = 'scripts/quality/policy/unused-structure.config.json';

export const RULES = {
  unusedFile: 'DEAD-001',
  unusedExport: 'DEAD-002',
  unusedType: 'DEAD-003',
  unusedDependency: 'DEAD-004',
  unlistedDependency: 'DEAD-005',
  missingEntrypoint: 'DEAD-006',
} as const;

export const RULE_DESCRIPTIONS: Record<string, string> = {
  'DEAD-001': 'File that nothing reaches from a declared entrypoint.',
  'DEAD-002': 'Exported value that nothing imports.',
  'DEAD-003': 'Exported type or interface that nothing imports.',
  'DEAD-004': 'Declared dependency that nothing imports.',
  'DEAD-005': 'Imported package that no manifest declares.',
  'DEAD-006': 'Declared entrypoint that does not exist on disk.',
};

export type RuleId = (typeof RULES)[keyof typeof RULES];

export type Classification =
  | 'unused-file'
  | 'unused-export'
  | 'unused-type'
  | 'unused-dependency'
  | 'unlisted-dependency'
  | 'missing-entrypoint';

/**
 * Issue classes knip can report that this analyzer does NOT turn into findings.
 *
 * These are counted, not dropped. Every one of them is a class where knip knows
 * something we have decided not to act on, and a class that is neither reported
 * nor counted is the silent hole the whole engine exists to close. The reasons
 * live in the policy file next to the decision, because "why is this not
 * measured" is a policy question and not an implementation detail.
 */
const EXCLUDED_ISSUE_TYPES = ['unresolved', 'catalog', 'duplicates', 'binaries'] as const;

/**
 * The classes knip is asked to compute.
 *
 * `nsExports`, `nsTypes` and `classMembers` are NOT in this list, and the reason
 * is measured rather than assumed: enabling them made knip exhaust a 4 GB heap
 * on this repository and die without producing a report. Every other class
 * contributes to the run, and the ones this analyzer does not report into are
 * counted into `exclusions` so a reader can see the size of what was set aside.
 *
 * The three that are omitted cannot be counted, because a class knip never
 * computes has no count to report. That is stated in the policy file rather than
 * papered over: the honest reading of their absence is "not measured", never
 * "measured and zero".
 */
const MEASURED_ISSUE_TYPES = [
  'files',
  'dependencies',
  'devDependencies',
  'optionalPeerDependencies',
  'unlisted',
  // `binaries` is ASKED FOR and COUNTED, but not reported - see
  // EXCLUDED_ISSUE_TYPES. Asking keeps the size of what was set aside visible in
  // the run record; dropping it from the request would hide it instead.
  'binaries',
  'unresolved',
  'exports',
  'types',
  'enumMembers',
  'duplicates',
  'catalog',
];

export const TIMEOUT_MS = 900_000;

/**
 * Directories the engine never measures, passed to knip because knip's own
 * default walk is wider than ours.
 *
 * `.candidate-build` is the one that mattered: it holds whole copies of this
 * repository made by the acceptance harness, and with `--no-gitignore` knip
 * walked into them, creating a second program over ~110 files that are not the
 * candidate. Measuring a copy of the repository as though it were the repository
 * is the exact failure this list prevents.
 */
const SCOPE_EXCLUDES = ['**/node_modules/**', '**/dist/**', '**/.candidate-build/**'];

const EXECUTABLE = /\.(?:[cm]?[jt]sx?)$/;

/**
 * The two reachability universes this analyzer can be asked about.
 *
 * `production` answers "what does the product need": test files and fixture
 * trees are not reachability starts, so a module that only a test imports is
 * reported. `full` answers "what does the repository need": tests are users,
 * so such a module is live.
 *
 * Which one is in force is POLICY - it lives in the analyzer's config file and
 * is covered by `policyDigest` - because the two answers are different rulers
 * over the same tree. Switching profiles invalidates accepted baselines instead
 * of quietly re-scoring them, which is the same rule that governs changing the
 * detector: a measurement belongs to the instrument that produced it.
 */
const PROFILES = ['production', 'full'] as const;
type Profile = (typeof PROFILES)[number];

/** A test file by name, used only when the source universe cannot classify it. */
const TEST_FILE_NAME = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/;

/**
 * Roles whose members are users of the product rather than parts of it.
 *
 * Read from the source universe rather than from a filename convention, so a
 * repository that keeps its tests somewhere unusual is not measured wrongly.
 * The filename is the fallback for a file the manifest does not classify - a
 * guess, but a visible one: an unclassified file is already reported by the
 * universe loader.
 */
const TEST_LIKE_ROLES = new Set(['harness-test', 'quality-fixture']);

function isTestOrFixture(path: string, universe: SourceUniverse): boolean {
  const role = universe.roleOf(path);
  if (role !== null && TEST_LIKE_ROLES.has(role)) return true;
  // The name is consulted even when a role exists, and that is deliberate rather
  // than belt-and-braces. Measured on this repository: `build-tooling` matches
  // `scripts/*.ts` and is declared BEFORE `harness-test` in the manifest's
  // priority order, so all 19 top-level `scripts/*.test.ts` files are classified
  // as build tooling while their `.mjs` siblings are classified as tests. A role
  // taxonomy that disagrees with itself about which files are tests cannot be the
  // only voice on whether tests may make product code look alive.
  return TEST_FILE_NAME.test(path);
}

/**
 * knip colorizes its debug stream whether or not it is writing to a terminal.
 * Every structural read of that stream has to strip these first, or the strings
 * being searched for are not in the text at all.
 */
const ANSI_ESCAPE = /\u001b\[[0-9;]*m/g;

interface PolicyFile {
  profile?: string;
  entries?: Array<{ path: string; kind: string; owner: string; proof: string }>;
  exclude?: string[];
  excludedIssueTypes?: Record<string, string>;
}

interface DeclaredEntry {
  path: string;
  source:
    | 'runtime-root'
    | 'package-script'
    | 'manifest-field'
    | 'test-file'
    | 'launcher'
    | 'policy';
  detail: string;
}

function readPolicy(repoRoot: string): PolicyFile {
  const raw = readFileSync(join(repoRoot, POLICY_PATH), 'utf8');
  const parsed = JSON.parse(raw) as PolicyFile;
  if (parsed.entries === undefined && parsed.exclude === undefined) {
    // A policy file that parses but declares nothing is not "no policy" - it is a
    // configuration whose meaning has gone missing, and treating it as empty would
    // quietly turn every declared entrypoint back into a dead file.
    throw new Error(`${POLICY_PATH} declares neither entries nor exclude`);
  }
  // There is deliberately no default. A missing profile would otherwise select one
  // of two different rulers for the same tree by accident, and the findings would
  // look exactly as authoritative either way.
  if (!PROFILES.includes(parsed.profile as Profile)) {
    throw new Error(
      `${POLICY_PATH}: profile must be one of ${PROFILES.join(', ')}; found ` +
        `${JSON.stringify(parsed.profile ?? null)}. This selects which files may ` +
        'make code reachable, so it cannot be inferred.'
    );
  }
  for (const entry of parsed.entries ?? []) {
    if (entry.proof.trim().length === 0 || entry.owner.trim().length === 0) {
      throw new Error(
        `${POLICY_PATH}: entry "${entry.path}" has no owner or proof. An entry ` +
          'makes a finding disappear, so it must say what executes the file.'
      );
    }
  }
  return parsed;
}

function profileOf(policy: PolicyFile): Profile {
  return policy.profile as Profile;
}

/**
 * The declared entrypoints must have arrived, or this run cannot conclude anything.
 *
 * Reachability is computed from where a walk starts, so "the manifest that says
 * where to start was not there" and "the manifest declares nowhere to start" both
 * mean the walk has no origin - and a walk with no origin reports every file dead.
 * That is a confident wrong answer, which is worse than no answer, so it is a
 * failed run. The check exists here rather than only in the loader because a
 * caller that caught the loader's throw and passed an empty list would otherwise
 * turn a missing declaration into a clean-looking measurement.
 */
function assertRootsDeclared(context: AnalyzerContext): void {
  const path = runtimeRootsPathFor(context.repoRoot);
  const raw = readText(path);
  if (raw === null) {
    throw new Error(
      `the runtime-roots manifest is missing at ${path}; without it the set of ` +
        'declared entrypoints is unknown, and unknown entrypoints make every ' +
        'unreachable file look dead'
    );
  }
  let parsed: { roots?: unknown };
  try {
    parsed = JSON.parse(raw) as { roots?: unknown };
  } catch (error) {
    throw new Error(
      `the runtime-roots manifest at ${path} is not valid JSON: ` +
        (error instanceof Error ? error.message : String(error))
    );
  }
  if (!Array.isArray(parsed.roots) || parsed.roots.length === 0) {
    throw new Error(
      `the runtime-roots manifest at ${path} declares no roots; a reachability ` +
        'analysis with nowhere to start reports every file as dead'
    );
  }
  if (context.runtimeRoots.length === 0) {
    throw new Error(
      `the runtime-roots manifest declares ${parsed.roots.length} root(s) but no ` +
        'entrypoint reached this analyzer; refusing to measure against an empty ' +
        'origin'
    );
  }
}

/**
 * Entry points, from declarations rather than from inference.
 *
 * Five sources, because five different things execute files here and no one of
 * them can see the others:
 *
 *  - the runtime-roots manifest, which already answers "where does a runtime
 *    reachability walk start" and is the same list that manifest exists for;
 *  - package.json, whose `main`, `bin` and every script command name files that
 *    are executed by name and imported by nothing;
 *  - shell and PowerShell launchers, which start modules by text;
 *  - the repository's own harness-test role, because `bun test` collects test
 *    files rather than importing them;
 *  - the policy file, for the residue: configs loaded by string, hand-run
 *    probes.
 *
 * The last is the dangerous one, so it is the only one that requires a proof
 * written by a person. The others are read from the repository, which means they
 * cannot be widened by an edit to this analyzer - only by an edit to the
 * repository, where a reviewer sees it.
 */
export function declaredEntries(
  repoRoot: string,
  runtimeRoots: string[],
  candidateFiles: string[],
  policy: PolicyFile
): DeclaredEntry[] {
  const declared = new Map<string, DeclaredEntry>();
  const add = (entry: DeclaredEntry): void => {
    if (!declared.has(entry.path)) declared.set(entry.path, entry);
  };

  for (const root of runtimeRoots) {
    add({ path: root, source: 'runtime-root', detail: 'entrypoint in the runtime-roots manifest' });
  }

  const manifest = join(repoRoot, 'package.json');
  if (existsSync(manifest)) {
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
      main?: string;
      bin?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    if (typeof pkg.main === 'string') {
      add({
        path: normalize(pkg.main),
        source: 'manifest-field',
        detail: 'package.json main',
      });
    }
    for (const [name, target] of Object.entries(pkg.bin ?? {})) {
      add({
        path: normalize(target),
        source: 'manifest-field',
        detail: `package.json bin.${name}`,
      });
    }
    for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
      // A script command names files to run; anything that looks like a path into
      // this repository is one. Deliberately read from the command text rather
      // than from a list of known scripts, so adding a script is enough to keep
      // its target alive without editing this analyzer.
      for (const match of command.matchAll(
        /(?:^|[\s&|("'])((?:\.\/)?(?:scripts|src)\/[A-Za-z0-9_./-]+\.[cm]?[jt]sx?)/g
      )) {
        add({
          path: normalize(match[1] as string),
          source: 'package-script',
          detail: `package.json scripts.${name}`,
        });
      }
    }
  }

  for (const entry of launcherEntries(repoRoot)) add(entry);

  for (const file of candidateFiles) {
    if (/\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/.test(file)) {
      add({ path: file, source: 'test-file', detail: 'collected by the test runner' });
    }
  }

  for (const entry of policy.entries ?? []) {
    add({
      path: entry.path,
      source: 'policy',
      detail: `${entry.kind} (${entry.owner}): ${entry.proof}`,
    });
  }

  return [...declared.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function normalize(target: string): string {
  return target.replace(/^\.\//, '').replace(/\\/g, '/');
}

const LAUNCHER_EXTENSIONS = ['.ps1', '.cmd', '.bat', '.sh'];

/** Any token in a launcher that names a file of source. */
const SOURCE_PATH_TOKEN = /([A-Za-z0-9_.\\/-]+\.(?:[cm]?[jt]sx?))/g;

/**
 * Launchers: the files that are not JavaScript and still start JavaScript.
 *
 * A shell or PowerShell script names the module it runs as TEXT - `Join-Path
 * $PSScriptRoot 'codex-subscription-bridge.mjs'` - and no import graph can see
 * that edge, so the file it starts looks like dead code from inside the project
 * set. This repository's own launcher chain is the proof that the class is
 * real: `cc.ps1` starts `scripts/gateway-supervisor.mjs`, which is why the
 * supervisor is a declared runtime root rather than a finding.
 *
 * A token is only accepted when it names a file that exists, either relative to
 * the repository or relative to the launcher - the two forms both occur here.
 * The proof recorded on the entry is the launcher itself, which is what a later
 * reader needs: the declaration can be re-checked by opening one file.
 */
function launcherEntries(repoRoot: string): DeclaredEntry[] {
  const entries: DeclaredEntry[] = [];
  const launchers = [
    ...listTrackedFiles(repoRoot),
    ...listUntrackedFiles(repoRoot),
  ].filter((file) => LAUNCHER_EXTENSIONS.some((ext) => file.endsWith(ext)));

  for (const launcher of launchers) {
    const raw = readText(join(repoRoot, launcher));
    if (raw === null) continue;
    const directory = dirname(launcher);
    for (const match of raw.matchAll(SOURCE_PATH_TOKEN)) {
      const token = normalize(match[1] as string);
      for (const candidate of [token, normalize(join(directory, token))]) {
        if (candidate.startsWith('..') || !isFile(join(repoRoot, candidate))) {
          continue;
        }
        entries.push({
          path: candidate,
          source: 'launcher',
          detail: `${launcher} starts it`,
        });
        break;
      }
    }
  }
  return entries;
}

interface KnipItem {
  name?: string;
  line?: number;
  col?: number;
  pos?: number;
  symbols?: Array<{ name?: string }>;
}

interface KnipRow {
  file: string;
  dependencies?: KnipItem[];
  devDependencies?: KnipItem[];
  optionalPeerDependencies?: KnipItem[];
  unlisted?: KnipItem[];
  binaries?: KnipItem[];
  exports?: KnipItem[];
  types?: KnipItem[];
  nsExports?: KnipItem[];
  nsTypes?: KnipItem[];
  classMembers?: Record<string, KnipItem[]>;
  enumMembers?: Record<string, KnipItem[]>;
  duplicates?: KnipItem[];
  catalog?: KnipItem[];
  unresolved?: KnipItem[];
}

interface KnipReport {
  files?: string[];
  issues?: KnipRow[];
}

/**
 * Recover the machine-readable report from a stream that also carries debug text.
 *
 * `--debug` and `--reporter json` both write to stdout, and `--debug` writes
 * first, so the report is the trailing object. It is found by locating the last
 * `{"files":` and then VALIDATING the shape: a run whose stdout merely looks
 * roughly right must not be read as a measurement. When the marker is absent or
 * the parse fails, the caller records a failed run rather than an empty one -
 * "knip printed something we could not read" and "knip found nothing" are the two
 * readings this function exists to keep apart.
 */
export function splitReport(stdout: string): {
  debug: string;
  report: KnipReport | null;
  failure: string | null;
} {
  const marker = stdout.lastIndexOf('{"files":');
  if (marker < 0) {
    return { debug: stdout, report: null, failure: 'no machine-readable report on stdout' };
  }
  try {
    const parsed = JSON.parse(stdout.slice(marker).trim()) as KnipReport;
    if (!Array.isArray(parsed.files) || !Array.isArray(parsed.issues)) {
      return {
        debug: stdout.slice(0, marker),
        report: null,
        failure: 'report is missing its files or issues list',
      };
    }
    return { debug: stdout.slice(0, marker), report: parsed, failure: null };
  } catch (error) {
    return {
      debug: stdout.slice(0, marker),
      report: null,
      failure: `report did not parse: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * The files knip actually took responsibility for.
 *
 * knip's JSON output lists only files that CARRY an issue, so it cannot answer
 * "what did you examine" - a clean project and an unexamined project both produce
 * a short list. The resolved project set is therefore read from the debug
 * stream's `[.] Finding project paths` block, which is a log and not an API, and
 * is why the caller treats an unreadable or empty result as a FAILED run rather
 * than as a clean one. Pinning the version is what makes reading a log
 * acceptable: the format is a property of a specific build.
 */
export function projectPathsFrom(debug: string): string[] | null {
  // Two measured details of the 5.88.1 debug stream, both of which silently
  // produced a null here before being read off a real run:
  //
  //  1. The marker is colorized. The stream carries the literal bytes
  //     `ESC[33m[.]ESC[39m Finding project paths`, so searching for the plain
  //     string `[.] Finding project paths` misses it - the escape sequence sits
  //     between the bullet and the phrase. A run that DID establish its scope
  //     was reported as one that had not.
  //  2. The block holds `patterns:` (the globs) and `paths:` (their expansion),
  //     in that order, and `patterns` contains the substring `s: [`. Anchoring
  //     on `paths: [` is therefore only safe if it is anchored per LINE - a
  //     loose indexOf from the marker reaches whichever array comes first.
  //
  // Both are line-level properties of a pinned build, which is the reason the
  // version is pinned rather than floated.
  const lines = debug.replace(ANSI_ESCAPE, '').split('\n');
  const marker = lines.findIndex(
    (line) => line.trim() === '[.] Finding project paths'
  );
  if (marker < 0) return null;
  const open = lines.findIndex(
    (line, index) => index > marker && /^\s*paths:\s*\[\s*$/.test(line)
  );
  if (open < 0) return null;

  const paths: string[] = [];
  for (let index = open + 1; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (/^\s*\]/.test(line)) return paths;
    const entry = /^\s*'(.*)',?\s*$/.exec(line);
    if (entry !== null) paths.push(entry[1] as string);
  }
  // The array never closed, so the stream was truncated: unknown, not empty.
  return null;
}

/** Windows-safe comparison key for a path from a tool that uses forward slashes. */
function key(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function toRepoRelative(repoRoot: string, reported: string): string | null {
  const normalized = reported.replace(/\\/g, '/');
  const root = repoRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    return normalized.slice(root.length + 1);
  }
  if (!normalized.startsWith('/') && !/^[a-z]:/i.test(normalized)) return normalized;
  return null;
}

interface Draft {
  rule: RuleId;
  classification: Classification;
  severity: Severity;
  subject: string;
  locator: string;
  anchor: string;
  detail: string;
  debt: boolean;
  evidence: Record<string, string | number | boolean | null>;
}

/**
 * Turn one knip row into findings.
 *
 * Identity is `rule::subject::anchor` where the anchor is the NAME of the thing
 * that is unused - an export name, a package name - not a line. A line number
 * would break the moment anyone edits above it, which for an unused-export
 * finding is the common case: the export is unused, so nothing stops someone
 * from moving it.
 */
export function findingsFromRow(row: KnipRow, inEligible: (path: string) => boolean): {
  drafts: Draft[];
  outsideScope: number;
  excluded: Record<string, number>;
} {
  const drafts: Draft[] = [];
  const excluded: Record<string, number> = {};
  for (const type of EXCLUDED_ISSUE_TYPES) {
    const value = row[type];
    if (value === undefined) continue;
    const count = countItems(value);
    if (count > 0) excluded[type] = (excluded[type] ?? 0) + count;
  }

  const subject = row.file;
  // A dependency is attributed to the manifest that declares it, which is not a
  // source file and so is never eligible; every other subject is source and must
  // be inside the scope the engine authorized. A finding about a file the engine
  // never asked about is not a measurement.
  const manifestScoped = /(?:^|\/)package\.json$/.test(subject);
  if (!manifestScoped && !inEligible(subject)) {
    return { drafts, outsideScope: countRow(row), excluded };
  }

  const where = (item: KnipItem): string =>
    item.line === undefined ? subject : `${subject}@${item.line}:${item.col ?? 0}`;

  // The two halves ask about different things - a manifest is judged on what it
  // declares, a source file on what it exports - and share only the locator. Split
  // so neither has to be read past the other, and so a change to the dependency
  // rules cannot alter how an unused export is reported.
  if (manifestScoped) {
    drafts.push(...manifestDrafts(row, where));
  } else {
    drafts.push(...sourceDrafts(row, subject, where));
  }

  return { drafts, outsideScope: 0, excluded };
}

/**
 * What a manifest declares and nothing uses.
 *
 * Two different verdicts live here and they are deliberately not the same rule:
 * an unused DECLARED dependency is tolerated debt, because a package can be
 * reached without an import. An UNLISTED one is an error, because it resolves
 * today only by accident of what happens to be installed.
 */
function manifestDrafts(
  row: KnipRow,
  where: (item: KnipItem) => string
): Draft[] {
  const drafts: Draft[] = [];
  for (const [type, classification] of [
    ['dependencies', 'unused-dependency'],
    ['devDependencies', 'unused-dependency'],
    ['optionalPeerDependencies', 'unused-dependency'],
  ] as const) {
    for (const item of row[type] ?? []) {
      const name = item.name ?? '<unnamed>';
      drafts.push({
        rule: RULES.unusedDependency,
        classification,
        severity: 'warning',
        subject: row.file,
        locator: where(item),
        anchor: name,
        detail:
          `${type === 'devDependencies' ? 'devDependency' : 'dependency'} ` +
          `"${name}" is declared but nothing imports it. Remove it, or declare ` +
          'what executes it if it is reached without an import.',
        debt: true,
        evidence: { package: name, dependencyType: type },
      });
    }
  }
  for (const item of row.unlisted ?? []) {
    const name = item.name ?? '<unnamed>';
    drafts.push({
      rule: RULES.unlistedDependency,
      classification: 'unlisted-dependency',
      severity: 'error',
      subject: row.file,
      locator: where(item),
      anchor: name,
      detail:
        `"${name}" is imported but no manifest declares it. It resolves today ` +
        'only because it happens to be installed, so a clean install can break ' +
        'the build with no source change.',
      debt: false,
      evidence: { package: name },
    });
  }
  return drafts;
}

/**
 * What a source file exports and nothing imports.
 *
 * The remedy for both cases is the same - delete it, or declare what reaches it -
 * which is why they share a rule family even though the anchor prefixes differ.
 * The prefixes keep an export and a type of the same name as two findings rather
 * than one, because they are two declarations and deleting one does not delete
 * the other.
 */
function sourceDrafts(
  row: KnipRow,
  subject: string,
  where: (item: KnipItem) => string
): Draft[] {
  const drafts: Draft[] = [];
  for (const item of row.exports ?? []) {
    const name = item.name ?? '<unnamed>';
    drafts.push({
      rule: RULES.unusedExport,
      classification: 'unused-export',
      severity: 'warning',
      subject,
      locator: where(item),
      anchor: `export:${name}`,
      detail:
        `"${name}" is exported and nothing imports it. Either it is the last ` +
        'remnant of a removed caller, or it is API that needs a declared ' +
        'entrypoint - decide, because it cannot be both.',
      debt: true,
      evidence: { symbol: name },
    });
  }
  for (const item of row.types ?? []) {
    const name = item.name ?? '<unnamed>';
    drafts.push({
      rule: RULES.unusedType,
      classification: 'unused-type',
      severity: 'warning',
      subject,
      locator: where(item),
      anchor: `type:${name}`,
      detail:
        `Type "${name}" is exported and nothing imports it. An unused type is ` +
        'the cheapest kind of dead code to add and the safest to delete; the ' +
        'cost of keeping it is that it must keep compiling.',
      debt: true,
      evidence: { symbol: name },
    });
  }
  return drafts;
}

/**
 * Every draft this report yields, with the scope accounting that goes beside it.
 *
 * The one place the "is this file inside the authorized scope" question is asked,
 * for both of the two lists knip returns: `issues` (what it found) and `files`
 * (what it judged unreachable). Asking it in one function is the point - a file
 * judged unreachable and a file carrying an issue must be subject to the same
 * boundary, or a scope that narrows would keep reporting dead code about files
 * the engine never asked about.
 *
 * `outsideScopePaths` is collected by name rather than by count because a count
 * says how much was set aside and not whether the reason was legitimate.
 */
function collectDrafts(
  context: AnalyzerContext,
  split: { report: KnipReport },
  eligible: string[]
): {
  drafts: Draft[];
  excluded: Record<string, number>;
  outsideScopePaths: Set<string>;
  outsideScope: number;
  filesOutsideScope: number;
  files: string[];
} {
  const drafts: Draft[] = [];
  const excluded: Record<string, number> = {};
  const outsideScopePaths = new Set<string>();
  let outsideScope = 0;
  const eligibleSet = new Set(eligible.map(key));
  for (const row of split.report.issues ?? []) {
    const rowSubject = toRepoRelative(context.repoRoot, row.file) ?? row.file;
    const produced = findingsFromRow(
      { ...row, file: rowSubject },
      (path) => eligibleSet.has(key(path))
    );
    drafts.push(...produced.drafts);
    outsideScope += produced.outsideScope;
    if (produced.outsideScope > 0) outsideScopePaths.add(rowSubject);
    appendCounts(excluded, produced.excluded);
  }

  const files = (split.report.files ?? []).map(
    (file) => toRepoRelative(context.repoRoot, file) ?? file
  );
  let filesOutsideScope = 0;
  for (const file of files) {
    if (!eligibleSet.has(key(file))) {
      filesOutsideScope += 1;
      outsideScopePaths.add(file);
      continue;
    }
    drafts.push({
      rule: RULES.unusedFile,
      classification: 'unused-file',
      severity: 'warning',
      subject: file,
      locator: file,
      anchor: file,
      detail:
        'Nothing reaches this file from any declared entrypoint. Either it is the ' +
        'remainder of a change that was rolled back by hand, or it is executed in ' +
        'a way the repository does not declare - and an undeclared entrypoint is ' +
        'its own defect, because nothing can tell it apart from dead code.',
      debt: true,
      evidence: { path: file },
    });
  }

  return {
    drafts,
    excluded,
    outsideScopePaths,
    outsideScope,
    filesOutsideScope,
    files,
  };
}

/**
 * How many issues a knip class contributes.
 *
 * Always an array of issue objects, so the count is its LENGTH. Recursing into
 * the objects was the first implementation and it was wrong in a way that read
 * as plausible: it summed the scalar fields of every issue, so a class with 200
 * entries each carrying three fields was reported as "600 excluded issues". A
 * number that is neither the issues nor anything else is worse than no number,
 * because the whole purpose of the exclusion counts is to let a reader size what
 * was set aside.
 */
function countItems(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value === undefined || value === null) return 0;
  return 1;
}

function countRow(row: KnipRow): number {
  let total = 0;
  for (const [name, value] of Object.entries(row)) {
    // `file` is the row's subject, not an issue found in it.
    if (name === 'file') continue;
    total += countItems(value);
  }
  return total;
}

function appendCounts(
  target: Record<string, number>,
  addition: Record<string, number>
): void {
  for (const [name, count] of Object.entries(addition)) {
    target[name] = (target[name] ?? 0) + count;
  }
}

async function run(context: AnalyzerContext): Promise<AnalyzerResult> {
  const errors: AnalyzerError[] = [];
  const notes: string[] = [];

  const policy = readPolicy(context.repoRoot);
  const profile = profileOf(policy);
  assertRootsDeclared(context);

  const aliases = loadAliasConfig(context.repoRoot);
  if (aliases.unreadable === true) {
    // Same distinction the resolver makes for the manifest it could not read:
    // "this repository declares no aliases" and "this repository's aliases are
    // unknown" produce the same empty map and opposite conclusions. Every import
    // written through an alias would resolve to nothing, so every file those
    // imports reach would be reported dead - a whole-repository false positive
    // wearing the appearance of a successful scan.
    return failed(
      context,
      [
        {
          kind: 'scan-failure',
          subject: 'tsconfig.json',
          message:
            'tsconfig.json exists but could not be read as JSON, so the path ' +
            'aliases that make aliased imports resolvable are unknown',
        },
      ],
      [
        'the alias map is unknown, so reachability cannot be established; this is ' +
          'not a clean run',
      ]
    );
  }

  const executable = context.candidateFiles
    .filter((file) => EXECUTABLE.test(file))
    .sort();
  const testFiles = executable.filter((file) =>
    isTestOrFixture(file, context.universe)
  );
  const namedButNotClassified = testFiles.filter(
    (file) => !TEST_LIKE_ROLES.has(context.universe.roleOf(file) ?? '')
  );
  // In the production profile the tests are removed from the PROJECT set as well
  // as from the entry set. Leaving them in the project would report each test file
  // as an unreachable file, which is true and useless: the runner reaches them.
  const eligible =
    profile === 'production'
      ? executable.filter((file) => !isTestOrFixture(file, context.universe))
      : executable;

  if (eligible.length === 0) {
    return failed(
      context,
      [
        {
          kind: 'scan-failure',
          subject: UNUSED_STRUCTURE_ANALYZER,
          message:
            'no file in the candidate is eligible for this analyzer, so there was ' +
            'nothing to reach a conclusion about',
        },
      ],
      [
        'the run covered no files; a tool that exits zero over nothing has ' +
          'measured nothing, and that is not a clean tree',
      ]
    );
  }

  // Only the `full` profile lets a test file be a reachability start. That single
  // line is the whole difference between the two rulers.
  const declared = declaredEntries(
    context.repoRoot,
    context.runtimeRoots,
    profile === 'full' ? executable : eligible,
    policy
  );

  // A declared entrypoint that is not on disk is a configuration mismatch: the
  // repository says something executes this file and nothing can. Reported as a
  // finding rather than as a note because it is durable - it stays wrong until
  // someone edits the declaration - and so it belongs in the ratchet.
  const entryFindings: Finding[] = [];
  const existingEntries: string[] = [];
  for (const entry of declared) {
    if (existsSync(join(context.repoRoot, entry.path))) {
      existingEntries.push(entry.path);
      continue;
    }
    entryFindings.push({
      id: `${RULES.missingEntrypoint}::${entry.path}::${entry.path}`,
      rule: RULES.missingEntrypoint,
      subject: entry.path,
      locator: entry.source,
      anchor: entry.path,
      classification: 'missing-entrypoint',
      status: 'fail',
      severity: 'error',
      detail:
        `Declared as an entrypoint by ${entry.detail}, but nothing exists at that ` +
        'path. Reachability starts nowhere, so every file that entry reached is ' +
        'now reported as dead - fix the declaration, not the findings it causes.',
      occurrences: 1,
      debt: false,
      evidence: { entrySource: entry.source, declaredBy: entry.detail },
    });
  }

  const configPath = join(context.cacheDir, 'knip.config.json');
  const config = {
    entry: existingEntries,
    // The project set IS the eligible set, written out explicitly rather than
    // re-derived by knip from globs. A glob would let knip's own defaults widen
    // the scope (it adds `server.js` and tsconfig patterns of its own), and a
    // scope that widens silently is the failure this analyzer is most exposed to.
    project: eligible,
    ignore: SCOPE_EXCLUDES,
    ignoreDependencies: [],
    // tsconfig path aliases, so a module reached through an alias is not reported
    // as dead. This repository maps `src/*` and imports it in 222 places; without
    // the alias map those edges are invisible to the walk and every file they
    // reach looks unreachable.
    //
    // Targets are written ABSOLUTE. knip resolves paths in a config relative to
    // that config file, and this config lives under a cache directory - so the
    // tsconfig's `./src/*` would have meant
    // `.quality/.cache/unused-structure/src/*`, matching nothing, and every
    // aliased import would have stayed invisible while the run reported a clean
    // 2,189/2,189 scan. Absolutizing takes the config's location out of the
    // meaning of the alias.
    paths: Object.fromEntries(
      Object.entries(aliases.paths).map(([pattern, targets]) => [
        pattern,
        targets.map((target) =>
          resolve(context.repoRoot, aliases.baseUrl, target)
        ),
      ])
    ),
    // An export used only inside the file that declares it is not dead - it is a
    // local value with a needless `export`. Reporting it would fill the ratchet
    // with findings whose remedy is deleting one keyword, and would bury the
    // question this analyzer exists to ask: did anyone add code nobody needs?
    ignoreExportsUsedInFile: true,
    include: MEASURED_ISSUE_TYPES,
  };
  try {
    ensureDir(context.cacheDir);
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  } catch (error) {
    errors.push({
      kind: 'scan-failure',
      subject: POLICY_PATH,
      message: `could not write knip config: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
    return failed(context, errors, ['knip config could not be written']);
  }

  if (namedButNotClassified.length > 0) {
    // Not a finding: the manifest's role order is a policy question with an
    // owner, and this analyzer is not its owner. Reported so the disagreement is
    // visible instead of being resolved silently in whichever direction this
    // adapter happens to prefer.
    notes.push(
      `${namedButNotClassified.length} file(s) named as tests are classified by ` +
        `the source universe as something else, and were treated as tests here: ` +
        `${namedButNotClassified.slice(0, 5).join(', ')}`
    );
  }
  notes.push(
    `profile: ${profile} - ` +
      (profile === 'production'
        ? 'test and fixture files are neither reachability starts nor project files'
        : 'test files are reachability starts')
  );
  notes.push(
    `entries: ${existingEntries.length} ` +
      `(${[...new Set(declared.map((entry) => entry.source))].sort().join(', ')})`
  );
  notes.push(`eligible files handed to knip as its project set: ${eligible.length}`);

  const home = resolveToolHome(context.repoRoot, KNIP_TOOL);
  if (!toolEntrypointExists(home)) {
    errors.push({
      kind: 'tool-missing',
      subject: home.entrypoint,
      message:
        `the pinned reachability walker is absent at ${home.entrypoint}. It is ` +
        `installed from ${TOOL_HOME}, not from the repository dependency graph ` +
        'on purpose, so run `bun install` inside it.',
    });
    return toolRefused(context, errors, notes, eligible.length, 'reachability-walker-missing');
  }

  // The pin in source is a claim; this is what makes it a fact. Without the
  // probe, a tool home left on an older install would be measured under the new
  // pin's identity - a reproducible ruler that is merely a documented one.
  const probe = probeToolVersion(context.repoRoot, home);
  if (probe.observed !== KNIP_TOOL.version) {
    errors.push({
      kind: 'tool-missing',
      subject: home.home,
      message:
        `pinned knip ${KNIP_TOOL.version} but the installed tool reports ` +
        `${probe.observed === '' ? '(nothing)' : JSON.stringify(probe.observed)}` +
        (probe.failure === null ? '' : ` - ${probe.failure}`),
    });
    return toolRefused(
      context,
      errors,
      notes,
      eligible.length,
      'reachability-walker-version-mismatch'
    );
  }
  notes.push(`reachability walker: knip@${probe.observed} (verified) at ${home.home}`);

  const outcome = runTool({
    command: process.execPath,
    args: [
      home.entrypoint,
      '--reporter',
      'json',
      '--no-progress',
      // Needed for coverage, and it writes to stdout alongside the report.
      '--debug',
      // Eligibility is computed by the engine and passed as an explicit project
      // list. Letting knip filter that list through .gitignore would make the
      // measured scope a function of a file outside the quality system, and the
      // difference would show up as findings that vanish without a code change.
      '--no-gitignore',
      '-c',
      configPath,
    ],
    cwd: context.repoRoot,
    timeoutMs: TIMEOUT_MS,
    // 0 = measured, clean. 1 = measured, issues found - the common case, and a
    // SUCCESS. 2 = knip refused to run, which is the only failure code it has.
    successCodes: [0, 1],
  });

  if (!outcome.ok) {
    errors.push({
      kind: 'scan-failure',
      subject: UNUSED_STRUCTURE_ANALYZER,
      message: outcome.failure ?? 'knip did not complete',
    });
    // stderr or stdout may still name the reason; keep the first lines so the
    // failure is diagnosable without re-running by hand.
    const detail = `${outcome.stderr}\n${outcome.stdout}`.trim().split('\n').slice(0, 4);
    return failed(context, errors, [
      'knip did not produce a measurement; the finding list is absent rather ' +
        'than empty',
      ...detail,
    ]);
  }

  const split = splitReport(outcome.stdout);
  if (split.report === null) {
    errors.push({
      kind: 'scan-failure',
      subject: UNUSED_STRUCTURE_ANALYZER,
      message: split.failure ?? 'unreadable report',
      });
    return failed(context, errors, [
      'knip exited successfully but its report could not be read, so this is not ' +
        'a clean run',
    ]);
  }

  // `report` is rebuilt into the object rather than passed as `split`, because
  // the null check above narrows the PROPERTY and not the object it sits on.
  // Passing `split` whole would hand `interpretReport` a type that still admits
  // null, and the function would have to re-establish a fact this caller has
  // already proven - or, worse, be written as if the report might be missing.
  return interpretReport({
    context,
    split: { report: split.report, debug: split.debug, failure: split.failure },
    eligible,
    entryFindings,
    profile,
    testFiles,
    errors,
    notes,
  });
}

/**
 * Turn knip's report into a measurement - or into a refusal to make one.
 *
 * Separated from `run` because it is the half of this analyzer that is a pure
 * function of the tool's output: it invokes nothing, resolves nothing, and reads
 * no environment. That makes it the half worth testing against a recorded
 * report, and it keeps the half that DOES invoke a pinned external tool small
 * enough to read as a sequence of preconditions.
 *
 * The scope check in here is why the debug stream is read at all: knip's JSON
 * cannot distinguish "examined 2188 files and found 29 unused" from "examined
 * nothing and found 29", because it only lists files that carry an issue.
 */
function interpretReport(input: {
  context: AnalyzerContext;
  split: { report: KnipReport; debug: string; failure: string | null };
  eligible: string[];
  entryFindings: Finding[];
  profile: Profile;
  testFiles: string[];
  errors: AnalyzerError[];
  notes: string[];
}): AnalyzerResult {
  const { context, split, eligible, entryFindings, profile, testFiles, errors, notes } =
    input;

  const resolvedProject = projectPathsFrom(split.debug);
  const resolved = new Set<string>();
  let unplaceable = 0;
  for (const path of resolvedProject ?? []) {
    const relative = toRepoRelative(context.repoRoot, path);
    if (relative === null) {
      unplaceable += 1;
      continue;
    }
    resolved.add(key(relative));
  }

  if (resolvedProject === null) {
    errors.push({
      kind: 'scan-failure',
      subject: UNUSED_STRUCTURE_ANALYZER,
      message:
        'the debug stream carried no "[.] Finding project paths" section, so the ' +
        'set of files knip examined cannot be established',
    });
    return failed(context, errors, [
      'knip reported successfully and its scan scope is unknown; a run whose ' +
        'scope cannot be established is not a clean run',
    ]);
  }

  const scannedFiles = eligible.filter((file) => resolved.has(key(file)));
  const dropped = eligible.filter((file) => !resolved.has(key(file)));
  const leaked = [...resolved].filter((file) => !eligible.some((f) => key(f) === file));

  for (const file of dropped.slice(0, 20)) {
    errors.push({
      kind: 'scan-failure',
      subject: file,
      message:
        'Authorized for measurement and absent from the set knip resolved, so no ' +
        'statement about it was made.',
    });
  }
  if (dropped.length > 20) {
    notes.push(`${dropped.length - 20} further dropped files not listed individually`);
  }

  const scope = collectDrafts(context, split, eligible);
  const { drafts, excluded, outsideScopePaths, outsideScope, filesOutsideScope, files } = scope;

  const findings = [
    ...entryFindings,
    ...drafts.map((draft) => ({
      ...makeFinding({
        rule: draft.rule,
        classification: draft.classification,
        subject: draft.subject,
        locator: draft.locator,
        anchor: draft.anchor,
        severity: draft.severity,
        detail: draft.detail,
        evidence: draft.evidence,
      }),
      // `debt` is the one field a draft decides and the shared constructor
      // cannot: a draft is built for both tolerated and blocking findings, and
      // which one it is depends on the rule rather than on the shape.
      debt: draft.debt,
    })),
  ];

  const skipReasons: Record<string, number> = {};
  const coverage: Coverage = {
    eligible: eligible.length,
    scanned: scannedFiles.length,
    skipped: 0,
    failed: dropped.length,
    skipReasons,
  };

  const exclusions: Record<string, number> = { ...excluded };
  if (profile === 'production' && testFiles.length > 0) {
    exclusions['test-and-fixture-files-excluded-by-the-production-profile'] =
      testFiles.length;
  }
  if (outsideScope > 0) exclusions['findings-on-files-outside-eligible-scope'] = outsideScope;
  if (filesOutsideScope > 0) {
    exclusions['unused-file-claims-outside-eligible-scope'] = filesOutsideScope;
  }
  if (leaked.length > 0) exclusions['files-knip-examined-that-were-not-authorized'] = leaked.length;
  if (unplaceable > 0) exclusions['knip-paths-that-could-not-be-placed-in-this-repository'] = unplaceable;

  const accounted: Coverage = {
    ...coverage,
    ...(Object.keys(exclusions).length > 0 ? { exclusions } : {}),
  };

  if (leaked.length > 0) {
    // Not a coverage failure - the arithmetic still holds - but it means knip's
    // walk was wider than the authorized scope, so the report is worth distrusting
    // in the direction of over-reporting dead code.
    notes.push(
      `knip examined ${leaked.length} file(s) that the source universe did not ` +
        `authorize; findings about them were discarded: ${leaked.slice(0, 5).join(', ')}`
    );
  }
  for (const [type, count] of Object.entries(excluded)) {
    notes.push(`${type}: ${count} issue(s) recorded as excluded, not reported`);
  }
  if (outsideScopePaths.size > 0) {
    // Named rather than counted. An exclusion count says how much was set aside;
    // it does not say whether the reason is legitimate. These paths can be read
    // and judged: a declared entrypoint the source universe does not measure is
    // expected, and a file inside the measured tree is not.
    notes.push(
      `outside the authorized scope, so not reported: ` +
        `${[...outsideScopePaths].sort().slice(0, 10).join(', ')}`
    );
  }
  notes.push(`unused files reported: ${files.length}`);
  notes.push(`files reaching knip's resolved project: ${scannedFiles.length}/${eligible.length}`);

  return {
    analyzer: UNUSED_STRUCTURE_ANALYZER,
    findings: findings.sort((a, b) => a.id.localeCompare(b.id)),
    errors,
    coverage: accounted,
    complete: coverageIsComplete(accounted),
    status: dropped.length > 0 ? 'incomplete' : 'complete',
    notes,
  };
}

/**
 * A run refused before the walk started, with the reason named in coverage.
 *
 * Both tool-home refusals produce the same record and differ only in which
 * `skipReasons` key explains them, so the shape is written once. The reason is a
 * named key rather than a free-text note because it is the part a reader or a
 * dashboard groups by, and "the walker was missing" and "the walker was the
 * wrong version" call for different remedies.
 */
function toolRefused(
  context: AnalyzerContext,
  errors: AnalyzerError[],
  notes: string[],
  eligibleCount: number,
  reason: string
): AnalyzerResult {
  return failedResult({
    analyzer: UNUSED_STRUCTURE_ANALYZER,
    reason,
    errors,
    notes,
    eligible: eligibleCount,
  });
}

/**
 * A failed run's finding list is empty because no measurement was taken, not
 * because nothing was found.
 *
 * Written as one function so every failure path in this analyzer says the same
 * thing: `status: 'failed'`, `complete: false`, and a coverage record in which
 * `failed` accounts for every file we were obliged to consider. The engine
 * refuses to read a failed run's findings as a resolution, which is the only
 * reason it is safe for this list to be empty.
 */
function failed(
  context: AnalyzerContext,
  errors: AnalyzerError[],
  notes: string[]
): AnalyzerResult {
  return failedResult({
    analyzer: UNUSED_STRUCTURE_ANALYZER,
    reason: 'knip-did-not-run',
    errors,
    notes,
    eligible: context.candidateFiles.length,
  });
}

export const unusedStructureAnalyzer: Analyzer = {
  id: UNUSED_STRUCTURE_ANALYZER,
  description:
    'Unused structure: files, exports, types and dependencies that nothing ' +
    'reaches, measured against declared entrypoints.',
  rules: RULE_DESCRIPTIONS,
  extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx'],
  capabilities: ['unused-structure'],
  // A reachability question cannot be answered from a sample of a repository:
  // "nothing imports this" is a statement about every file, so a sampled run
  // would produce a confident and wrong answer. Declared false so the engine
  // either hands over the whole candidate set or nothing.
  contentScoped: false,
  policyFiles: [POLICY_PATH],
  run,
};
