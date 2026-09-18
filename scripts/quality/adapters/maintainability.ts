import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type {
  AnalyzerError,
  AnalyzerResult,
  Coverage,
  Finding,
  MetricValue,
  Severity,
} from '../lib/types';
import { coverageIsComplete } from '../lib/types';
import type { Analyzer, AnalyzerContext } from '../lib/registry';
import { isFile } from '../lib/fsutil';
import { parseJsonReport, runTool } from '../lib/toolrun';
import { assignAnchors, lineAnchor } from '../lib/anchor';

export const MAINTAINABILITY_ANALYZER = 'maintainability';

/** Rules whose numeric value is worth tracking so improvement is visible. */
const METRIC_RULES: Record<
  string,
  { name: string; direction: 'lower-is-better' | 'higher-is-better' }
> = {
  complexity: { name: 'cyclomatic-complexity', direction: 'lower-is-better' },
  'max-depth': { name: 'nesting-depth', direction: 'lower-is-better' },
  'max-lines-per-function': { name: 'function-lines', direction: 'lower-is-better' },
  'max-lines': { name: 'file-lines', direction: 'lower-is-better' },
  'max-statements': { name: 'function-statements', direction: 'lower-is-better' },
  'max-params': { name: 'parameter-count', direction: 'lower-is-better' },
  'max-nested-callbacks': { name: 'nested-callbacks', direction: 'lower-is-better' },
  'sonarjs/cognitive-complexity': {
    name: 'cognitive-complexity',
    direction: 'lower-is-better',
  },
};

/**
 * The limit for each rule, read from the ESLint config rather than duplicated.
 *
 * A `null` limit means the analyzer could not determine one, in which case
 * improvement tracking for that rule is disabled rather than guessed at. A wrong
 * limit would produce confident, wrong "this improved" reports.
 *
 * The key may be quoted or bare. That is not pedantry: `complexity` is the one
 * rule ESLint declares at the top level of a config and the one this repository
 * writes unquoted, and an earlier version of this function required quotes on the
 * key. It silently returned null for `complexity` alone - which disabled metric
 * tracking for that rule and made 689 findings permanently invisible to
 * improvement detection, while every neighbouring rule worked. A partly-working
 * heuristic is harder to notice than a wholly broken one.
 *
 * Both value shapes are accepted: a bare number and an options object with `max`.
 */
function limitFor(ruleId: string, configText: string): number | null {
  const escaped = ruleId.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&');
  const key = `['"]?${escaped}['"]?`;
  const arrayForm = new RegExp(
    `${key}\\s*:\\s*\\[\\s*['"][a-z]+['"]\\s*,\\s*(\\d+)`,
    'i'
  );
  const objectForm = new RegExp(
    `${key}\\s*:\\s*\\[\\s*['"][a-z]+['"]\\s*,\\s*\\{[^}]*\\bmax\\s*:\\s*(\\d+)`,
    'i'
  );
  const match = objectForm.exec(configText) ?? arrayForm.exec(configText);
  if (match === null) return null;
  const value = Number.parseInt(match[1] as string, 10);
  return Number.isNaN(value) ? null : value;
}

interface EslintMessage {
  ruleId: string | null;
  severity: number;
  message: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  messageId?: string;
  /** True for parse failures. Distinguishes a crash from a clean file. */
  fatal?: boolean;
}

interface EslintFileResult {
  filePath: string;
  messages: EslintMessage[];
  suppressedMessages?: EslintMessage[];
  errorCount: number;
  warningCount: number;
  fatalErrorCount: number;
}

const CONFIG_PATH = 'scripts/quality/policy/maintainability.config.mjs';

/**
 * Every rule this analyzer can report, including the ones that are not size or
 * complexity measurements.
 *
 * The declaration has to be complete, or `quality rules` under-reports the rule
 * set. It did: the config names twenty-two rules and this list named eleven, so
 * the type-safety, duplicate-branch and collapsibility rules that generate over a
 * sixth of the analyzer's findings were enforced but undocumented. A rule ID that
 * appears in a baseline but in no registry is a rule nobody can look up.
 *
 * A drift guard, not a promise: `fixture-maintainability-rules` fails if the
 * config names a rule this map does not.
 */
export const RULE_DESCRIPTIONS: Record<string, string> = {
  // Size and shape.
  complexity: 'Cyclomatic complexity over threshold.',
  'sonarjs/cognitive-complexity': 'Cognitive complexity over threshold.',
  'max-depth': 'Block nesting deeper than allowed.',
  'max-lines': 'File longer than allowed.',
  'max-lines-per-function': 'Function longer than allowed.',
  'max-statements': 'Function with too many statements.',
  'max-params': 'Function with too many parameters.',
  'max-nested-callbacks': 'Callbacks nested too deeply.',

  // Type-safety escapes.
  '@typescript-eslint/no-explicit-any': 'Explicit any in the source.',
  '@typescript-eslint/no-non-null-assertion': 'Non-null assertion.',
  '@typescript-eslint/no-unsafe-function-type': 'Function type without a signature.',
  '@typescript-eslint/no-empty-object-type': 'Empty object type.',
  '@typescript-eslint/no-unsafe-declaration-merging': 'Unsafe declaration merging.',
  '@typescript-eslint/consistent-type-assertions': 'Type assertion other than `as`.',

  // Suppression debt.
  'no-warning-comments': 'Comment carrying a suppression directive.',
  'MAINT-020': 'Suppression directive silencing the linter.',

  // Correctness rules that reduce rather than add noise.
  'sonarjs/no-nested-conditional': 'Nested conditional expression.',
  'sonarjs/no-duplicate-in-composite': 'Duplicate element in a composite type.',
  'sonarjs/no-duplicated-branches': 'Two branches with identical bodies.',
  'sonarjs/no-all-duplicated-branches': 'Every branch with an identical body.',
  'sonarjs/no-identical-expressions': 'Identical expressions on both sides.',
  'sonarjs/no-collapsible-if': 'Nested if that could be one condition.',
  'sonarjs/no-invariant-returns': 'Every return with the same value.',
  'sonarjs/no-redundant-jump': 'Return or continue that does nothing.',
  'sonarjs/no-gratuitous-expressions': 'Expression with a constant truth value.',
  'sonarjs/no-same-line-conditional': 'Conditional and its body on one line.',
  'sonarjs/no-useless-catch': 'Catch that only rethrows.',
};

function severityFor(eslintSeverity: number): Severity {
  return eslintSeverity >= 2 ? 'error' : 'warning';
}

/**
 * ESLint's own report of ignoring a file.
 *
 * Verified against ESLint 9.39.5: an ignored file still appears in the JSON report
 * as `fatal: false` with a single message whose `ruleId` is null and whose text
 * begins "File ignored". It is NOT silently absent, which is what makes honest
 * coverage accounting possible.
 */
const IGNORE_NOTICE = /^File ignored because/;

/**
 * ESLint's report that the config named a rule it could not load.
 *
 * Verified against ESLint 9.39.5: the message is
 * `Definition for rule '<id>' was not found.`, it carries severity 2 and the
 * *unloadable* rule id, so in the report it is indistinguishable from a genuine
 * violation of that rule. That is how 198 records for a rule this analyzer never
 * configures reached a baseline proposal.
 *
 * A message that says the rule was not found is not a measurement, and it must not
 * be recorded as one. It is a finding about the configuration, so the whole run is
 * reported as a tool failure rather than as lint output.
 */
const RULE_NOT_FOUND = /^Definition for rule '?[^']*'? was not found\.?$/;

/**
 * Probe that the configured plugins actually load.
 *
 * A config can name plugins it never imports, and ESLint will run, exit 0 and
 * produce a report full of "rule not found" entries. The probe lints one always-
 * present file with the config's own plugin set and asks whether any diagnostic
 * came back; if one did, the rule set is not the one configured and every finding
 * from the run is suspect.
 */
const LOAD_PROBE_FILE = 'scripts/quality/policy/maintainability.config.mjs';

function bootstrapDiagnostic(stdout: string): string | null {
  const parsed = parseJsonReport<EslintFileResult[]>(stdout);
  if (!parsed.ok) {
    // An unparseable probe is not evidence that the plugins loaded.
    return `load probe produced no usable report (${parsed.reason})`;
  }
  for (const file of parsed.value) {
    for (const message of file.messages) {
      if (RULE_NOT_FOUND.test(message.message)) return message.message;
    }
  }
  return null;
}

interface FileOutcome {
  kind: 'scanned' | 'ignored' | 'fatal' | 'foreign';
  /** Set when kind is 'fatal' or 'foreign'. */
  message?: string;
}

function classifyFileResult(file: EslintFileResult): FileOutcome {
  if (file.fatalErrorCount > 0) {
    const fatal = file.messages.find((message) => message.fatal === true);
    return { kind: 'fatal', message: fatal?.message ?? 'unparseable source' };
  }

  const ignoreNotice = file.messages.find(
    (message) => message.ruleId === null && IGNORE_NOTICE.test(message.message)
  );
  if (ignoreNotice !== undefined) return { kind: 'ignored' };

  return { kind: 'scanned' };
}

function relativeFrom(repoRoot: string, absolutePath: string): string {
  const normalizedRoot = repoRoot.replace(/\\/g, '/').replace(/\/$/, '');
  const normalizedPath = absolutePath.replace(/\\/g, '/');
  if (normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }
  return normalizedPath;
}

/**
 * How many characters of file paths one ESLint invocation may carry.
 *
 * The Windows CreateProcess command line caps at 32,768 characters including the
 * executable, flags and environment. 20,000 leaves ample room and still keeps the
 * batch count small (roughly 5 for this repository's path lengths).
 *
 * The bound is a constant rather than a computed value because computing the real
 * limit requires knowing the platform's exact accounting, and being wrong about
 * it means an invocation that silently fails. Under-filling a batch costs one
 * extra process; over-filling one costs the run.
 */
const ARG_BUDGET = 20_000;

/**
 * Split paths into command-line-sized groups.
 *
 * A single path longer than the budget becomes its own batch rather than being
 * dropped: an oversized path is ESLint's problem to report, and dropping it would
 * make the file invisible to coverage accounting.
 */
export function batchPaths(paths: string[], budget: number): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let used = 0;

  for (const path of paths) {
    const cost = path.length + 3; // quoting and separator
    if (current.length > 0 && used + cost > budget) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(path);
    used += cost;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

function run(context: AnalyzerContext): AnalyzerResult {
  const errors: AnalyzerError[] = [];
  const notes: string[] = [];

  const configAbsolute = join(context.repoRoot, CONFIG_PATH);
  if (!isFile(configAbsolute)) {
    return {
      analyzer: MAINTAINABILITY_ANALYZER,
      findings: [],
      errors: [
        {
          kind: 'tool-missing',
          subject: CONFIG_PATH,
          message: 'Maintainability ESLint config is absent.',
        },
      ],
      coverage: {
        eligible: null,
        scanned: 0,
        skipped: 0,
        failed: 0,
        skipReasons: {},
      },
      complete: false,
      notes: ['cannot run without a config'],
    };
  }

  const targetFiles = context.candidateFiles.filter((file: string) =>
    isMaintainabilitySource(file)
  );
  const targetSet = new Set(targetFiles);

  if (targetFiles.length === 0) {
    return {
      analyzer: MAINTAINABILITY_ANALYZER,
      findings: [],
      errors: [
        {
          kind: 'scan-failure',
          subject: '<run>',
          message: 'No candidate files matched the analyzer extensions.',
        },
      ],
      coverage: {
        eligible: 0,
        scanned: 0,
        skipped: 0,
        failed: 0,
        skipReasons: {},
      },
      complete: false,
      notes,
    };
  }

  // ESLint is invoked over the candidate set in batches, not once.
  //
  // This is not an optimization. On Windows the command line caps at 32,767
  // characters, and this repository has 2,168 candidate source files whose paths
  // alone exceed 130,000 characters. A single invocation dies with ENAMETOOLONG
  // before ESLint starts, which is a hard failure the gate must never confuse
  // with "found nothing".
  //
  // Batching is sound for this rule set because none of the configured rules
  // depend on cross-file state: complexity, size, nesting, type-safety escapes
  // and suppression directives are all properties of a single file. There is no
  // duplicate-code rule here; when one is added it will need whole-program
  // analysis and must not be batched this way.
  const batches = batchPaths(targetFiles, ARG_BUDGET);
  const reports: EslintFileResult[] = [];
  let failedBatches = 0;

  for (const batch of batches) {
    const outcome = runTool({
      command: 'bun',
      args: [
        'x',
        'eslint',
        '--format',
        'json',
        '--no-error-on-unmatched-pattern',
        '--config',
        CONFIG_PATH,
        ...batch,
      ],
      cwd: context.repoRoot,
      // 0 = clean, 1 = findings present, 2 = config/lint error. Only 0 and 1 mean
      // ESLint actually completed; 2 must not be read as "no findings".
      successCodes: [0, 1],
      timeoutMs: 15 * 60 * 1000,
      bootstrap: {
        args: [
          'x',
          'eslint',
          '--format',
          'json',
          '--no-error-on-unmatched-pattern',
          '--config',
          CONFIG_PATH,
          LOAD_PROBE_FILE,
        ],
        diagnostic: bootstrapDiagnostic,
      },
    });

    if (!outcome.ok) {
      failedBatches += 1;
      errors.push({
        kind: outcome.timedOut ? 'scan-failure' : 'tool-missing',
        subject: `eslint[${reports.length}..${reports.length + batch.length}]`,
        message: outcome.failure ?? 'eslint did not complete',
      });
      continue;
    }

    const parsedBatch = parseJsonReport<EslintFileResult[]>(outcome.stdout);
    if (!parsedBatch.ok) {
      failedBatches += 1;
      errors.push({
        kind: 'scan-failure',
        subject: `eslint[${reports.length}..${reports.length + batch.length}]`,
        message: parsedBatch.reason,
      });
      continue;
    }

    reports.push(...parsedBatch.value);
  }

  // Fail closed. A batch that did not run is not a batch that found nothing, and
  // a partial report must never be summed into a complete-looking total.
  if (failedBatches > 0) {
    notes.push(`batches: ${batches.length}, failed: ${failedBatches}`);
    return {
      analyzer: MAINTAINABILITY_ANALYZER,
      findings: [],
      errors,
      coverage: {
        eligible: targetFiles.length,
        scanned: 0,
        skipped: 0,
        failed: targetFiles.length,
        skipReasons: { 'eslint-not-complete': targetFiles.length },
      },
      complete: false,
      notes,
    };
  }

  notes.push(`eslint batches: ${batches.length}`);
  const parsed = { ok: true as const, value: reports };

  const configText = readConfigText(configAbsolute);
  const findings: Finding[] = [];
  const notLoadedRules = new Set<string>();
  const skipReasons: Record<string, number> = {};
  const foreignFiles: string[] = [];
  /** Eligible files ESLint returned no result for at all. */
  const unaccounted: string[] = [];
  let scanned = 0;
  let skippedEligible = 0;
  let skippedOther = 0;
  let failed = 0;

  for (const file of parsed.value) {
    const subject = relativeFrom(context.repoRoot, file.filePath);
    const outcome = classifyFileResult(file);
    const inScope = targetSet.has(subject);

    if (outcome.kind === 'ignored') {
      // ESLint deliberately declines to lint this file. That is an exclusion, and
      // it must be counted as one, or `eligible` silently shrinks and the analyzer
      // reports "complete" over files it never examined. Only an ignored file that
      // was in scope belongs in that arithmetic.
      if (inScope) {
        skippedEligible += 1;
        skipReasons['excluded-by-lint-config'] =
          (skipReasons['excluded-by-lint-config'] ?? 0) + 1;
      } else {
        skippedOther += 1;
      }
      continue;
    }

    if (outcome.kind === 'fatal') {
      if (!inScope) {
        foreignFiles.push(subject);
        continue;
      }
      failed += 1;
      errors.push({
        kind: 'scan-failure',
        subject,
        message: outcome.message ?? 'ESLint reported a fatal parse error.',
      });
      continue;
    }

    // ESLint resolves its arguments through its own file model, which can pull in
    // files this analyzer never asked about - the lint config's `ignores` are
    // re-read here rather than duplicated, because two copies of an exclusion list
    // will diverge and the divergence would be invisible.
    if (!inScope) {
      foreignFiles.push(subject);
      continue;
    }

    scanned += 1;

    // The finding's identity comes from this file's own text, so it is read once
    // here rather than once per message. `id` is filled in after the loop by
    // assignAnchors, which is the only place that knows which findings collide.
    const sourceLines = readSourceLines(file.filePath);

    for (const message of file.messages) {
      if (message.ruleId === null) continue;
      // The probe should already have aborted the run. This is the second line of
      // defence, and it exists because the probe can only test one file: a plugin
      // that loads for the probe but not for a source file would otherwise write a
      // "rule not found" message into the baseline as though it were a measurement.
      if (RULE_NOT_FOUND.test(message.message)) {
        notLoadedRules.add(message.ruleId);
        continue;
      }
      const severity = severityFor(message.severity);
      const metric = metricFor(message, configText);

      findings.push({
        id: '',
        rule: message.ruleId,
        subject,
        locator: `${message.line}:${message.column}`,
        anchor: lineAnchor(sourceLines, message.line),
        classification: classificationFor(message.ruleId),
        status: severity === 'error' ? 'fail' : 'pass',
        severity,
        detail: message.message,
        occurrences: 1,
        debt: false,
        ...(metric !== undefined ? { metric } : {}),
        evidence: {
          line: message.line,
          column: message.column,
          ...(message.endLine !== undefined ? { endLine: message.endLine } : {}),
          ...(message.endColumn !== undefined
            ? { endColumn: message.endColumn }
            : {}),
        },
      });
    }

    // A suppression directive is itself maintainability debt, recorded
    // separately so that "we silenced the linter here" is visible in the baseline
    // rather than optimised away.
    for (const suppressed of file.suppressedMessages ?? []) {
      findings.push({
        id: '',
        rule: 'MAINT-020',
        subject,
        locator: `${suppressed.line}:${suppressed.column}`,
        anchor: lineAnchor(sourceLines, suppressed.line),
        classification: 'suppression-directive',
        status: 'pass',
        severity: 'warning',
        detail:
          `Suppression directive for ${suppressed.ruleId ?? 'unknown rule'}. ` +
          'Silenced findings are debt that the report otherwise cannot see.',
        occurrences: 1,
        debt: true,
        evidence: {
          line: suppressed.line,
          suppressedRule: suppressed.ruleId ?? 'unknown',
        },
      });
    }
  }

  // A file the analyzer asked for but ESLint never reported on.
  //
  // ESLint omits a file from its JSON report in more than one situation - an ignore
  // pattern matched under `--no-warn-ignored`, a path that vanished between the
  // candidate snapshot and the invocation, and any resolver behaviour that filters
  // input. In every one of those the file is neither scanned nor skipped, so it
  // silently leaves the arithmetic. That is not a hypothetical: a run reported
  // `eligible 2172 != scanned 2164 + skipped 7` and the *cause* had to be
  // reconstructed by hand, because nothing in the report named the missing file.
  //
  // Naming them makes the imbalance self-explaining, and it is robust to the
  // candidate set changing under the analyzer. Whether the file still exists on
  // disk is irrelevant to the diagnosis: it was in the eligible set, so it must be
  // accounted for somewhere. A file that genuinely disappeared is a scan failure,
  // not a silence.
  const reportedSubjects = new Set(
    parsed.value.map((file) => relativeFrom(context.repoRoot, file.filePath))
  );
  for (const target of targetFiles) {
    if (!reportedSubjects.has(target)) unaccounted.push(target);
  }
  for (const missing of unaccounted) {
    failed += 1;
    errors.push({
      kind: 'scan-failure',
      subject: missing,
      message:
        'Eligible for this analyzer but absent from ESLint\u2019s report: neither ' +
        'scanned nor explicitly excluded. The file may have been ignored, or it ' +
        'may have changed or disappeared between the candidate snapshot and the ' +
        'invocation.',
    });
  }
  if (foreignFiles.length > 0) {
    errors.push({
      kind: 'resolution-error',
      subject: '<run>',
      message:
        `ESLint reported ${foreignFiles.length} file(s) outside the candidate set ` +
        `(${foreignFiles.slice(0, 3).join(', ')}). Coverage accounting cannot be ` +
        'trusted; refusing to claim completeness.',
    });
  }

  if (notLoadedRules.size > 0) {
    errors.push({
      kind: 'tool-missing',
      subject: '<run>',
      message:
        `${notLoadedRules.size} configured rule(s) did not load: ` +
        `${[...notLoadedRules].sort().slice(0, 5).join(', ')}. ESLint reported ` +
        'these as missing rule definitions rather than as lint results, so the ' +
        'report reflects a rule set other than the one configured. Their messages ' +
        'were not recorded as findings.',
    });
  }

  notes.push(`eslint reported on ${parsed.value.length} file(s)`);
  if (skippedEligible > 0) {
    notes.push(
      `eligible files excluded by the lint config: ${skippedEligible} (counted as ` +
        'skipped, not silently dropped from coverage)'
    );
  }
  if (skippedOther > 0) {
    notes.push(`files outside the eligible set ESLint still reported: ${skippedOther}`);
  }

  const coverage: Coverage = {
    eligible: targetFiles.length,
    scanned,
    skipped: skippedEligible + skippedOther,
    failed,
    skipReasons,
  };

  if (notLoadedRules.size > 0) {
    notes.push(
      `refusing to report findings: ${[...notLoadedRules].sort().join(', ')} did ` +
        'not load, so the configured rule set was not the one enforced'
    );
  }

  return {
    analyzer: MAINTAINABILITY_ANALYZER,
    // A run whose rule set is not the configured one reports nothing rather than a
    // partial truth: findings from the rules that did load would otherwise be
    // mixed with silence from the rules that did not, and the silence is what a
    // baseline would freeze.
    //
    // assignAnchors runs before collapseOccurrences because it is what gives a
    // finding its id. Collapsing first would group by an empty string and merge
    // every distinct finding in a file into one.
    findings:
      notLoadedRules.size > 0
        ? []
        : collapseOccurrences(assignAnchors(findings)),
    errors,
    coverage: notLoadedRules.size > 0 ? zeroCoverage(targetFiles.length, failed) : coverage,
    complete:
      notLoadedRules.size === 0 &&
      foreignFiles.length === 0 &&
      coverageComplete(coverage, parsed.value.length),
    notes,
  };
}

/** Coverage for a run that must not be trusted to vouch for anything. */
function zeroCoverage(eligible: number, failed: number): Coverage {
  return {
    eligible,
    scanned: 0,
    skipped: 0,
    failed: Math.max(failed, 1),
    skipReasons: { 'rules-not-loaded': 1 },
  };
}

/** The engine's uniform completeness rule, plus ESLint's own "nothing reported". */
function coverageComplete(coverage: Coverage, reportedFiles: number): boolean {
  if (coverage.eligible === null || coverage.eligible === 0) return false;
  if (coverage.scanned === 0) return false;
  if (coverage.failed > 0) return false;
  // ESLint reports only files it processed. If it returned nothing for a
  // non-empty candidate set, the analyzer cannot claim coverage, even if its own
  // arithmetic happens to balance.
  if (reportedFiles === 0) return false;
  return coverageIsComplete(coverage);
}

function readConfigText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * The file's lines, for turning a reported position into an identity.
 *
 * A read failure is not fatal here: an unreadable file yields no anchors, so its
 * findings fall back to ordinal-only identity rather than to a shared empty
 * anchor. A file ESLint just linted will normally read, so this is the rare path
 * - a file deleted mid-run, or a transient handle error.
 */
function readSourceLines(absolutePath: string): string[] {
  try {
    return readFileSync(absolutePath, 'utf8').split('\n');
  } catch {
    return [];
  }
}

function classificationFor(ruleId: string): string {
  if (ruleId.startsWith('sonarjs/')) return 'sonar-maintainability';
  if (ruleId === 'no-warning-comments') return 'suppression-directive';
  if (
    ruleId === 'complexity' ||
    ruleId === 'max-depth' ||
    ruleId === 'max-lines' ||
    ruleId === 'max-statements' ||
    ruleId === 'max-params' ||
    ruleId === 'max-nested-callbacks' ||
    ruleId === 'max-lines-per-function'
  ) {
    return 'size-or-complexity';
  }
  return 'type-safety-escape';
}

function metricFor(
  message: EslintMessage,
  configText: string
): MetricValue | undefined {
  if (message.ruleId === null) return undefined;
  const spec = METRIC_RULES[message.ruleId];
  if (spec === undefined) return undefined;

  const limit = limitFor(message.ruleId, configText);
  const value = extractReportedValue(message.message, limit);
  if (value === null) return undefined;

  return {
    name: spec.name,
    value,
    limit,
    direction: spec.direction,
  };
}

/**
 * Pull the measured number out of the rule's own message.
 *
 * ESLint rule messages are written for humans, so this is a deliberate, narrow
 * parse. The trap is that a message carries *two* numbers: the measurement and
 * the threshold, and the two plugins state them in opposite orders.
 *
 *     ESLint : Function 'complex' has a complexity of 7. Maximum allowed is 3.
 *     SonarJS: Refactor this function to reduce its Cognitive Complexity from
 *              91 to the 25 allowed.
 *
 * Two earlier versions were wrong and both failed silently, which is why this is
 * written the way it is:
 *
 *  1. "Accept only messages with exactly one number." Every size and complexity
 *     message has two, so metric tracking switched itself off entirely. The
 *     improvement path would have reported "nothing improved" forever.
 *  2. "Take the last number before the word 'maximum' or 'allowed'." Correct for
 *     ESLint's shape and exactly wrong for SonarJS's, where 'allowed' trails the
 *     threshold - it reported a cognitive complexity of 25 for all 612 findings,
 *     because 25 was the limit being echoed back.
 *
 * Positional guessing is the thing that keeps breaking, so this does not guess.
 * The limit is known independently from the rule's configuration; the measurement
 * is the number that is not the limit. A violation is by definition on the wrong
 * side of the limit, so the two can never coincide.
 */
function extractReportedValue(message: string, limit: number | null): number | null {
  const numbers: number[] = [];
  for (const match of message.matchAll(/\d+(?:\.\d+)?/g)) {
    const value = Number.parseFloat(match[0]);
    if (!Number.isNaN(value)) numbers.push(value);
  }

  if (numbers.length === 0) return null;
  if (numbers.length === 1) return numbers[0] as number;

  if (numbers.length === 2 && limit !== null) {
    const [first, second] = numbers as [number, number];
    if (first === limit && second !== limit) return second;
    if (second === limit && first !== limit) return first;
    return null;
  }

  // Three or more numbers, or an unknown limit: the message shape is not one this
  // parse understands, and a metric is omitted rather than invented.
  return null;
}

function collapseOccurrences(findings: Finding[]): Finding[] {
  const byId = new Map<string, Finding>();
  for (const finding of findings) {
    const existing = byId.get(finding.id);
    if (existing === undefined) {
      byId.set(finding.id, finding);
      continue;
    }
    existing.occurrences += 1;
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx'];

export function isMaintainabilitySource(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  return EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export const maintainabilityAnalyzer: Analyzer = {
  id: MAINTAINABILITY_ANALYZER,
  description:
    'Maintainability shape: cyclomatic and cognitive complexity, size, nesting, ' +
    'type-safety escapes and suppression directives.',
  rules: RULE_DESCRIPTIONS,
  extensions: EXTENSIONS,
  /**
   * The lint config decides every threshold this analyzer enforces, so editing it
   * changes what is tolerable. Declaring it here is what stops "raise the limit
   * until the gate passes" from being invisible to the baseline.
   */
  policyFiles: [CONFIG_PATH],
  contentScoped: true,
  run,
};
