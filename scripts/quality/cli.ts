#!/usr/bin/env bun
/**
 * quality - the quality engine entry point.
 *
 * The CLI is the system; hooks and CI are transport. Commands are analyzer-
 * independent: `run`, `compare`, `gate` and `baseline` take an analyzer id and
 * work identically for every registered analyzer.
 *
 * Exit codes are part of the contract:
 *   0 PASS   1 FAIL   2 INCOMPLETE
 */
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { AnalyzerResult, CandidateIdentity } from './lib/types';
import {
  computeCandidateIdentity,
  identityEqual,
  policyFilesFor,
  shortIdentity,
} from './lib/identity';
import { resolveProfile } from './lib/profile';
import {
  expiredWaivers,
  listBaselines,
  proposeBaseline,
  proposeResolutionUpdate,
  readBaseline,
  writeBaseline,
  writeProposal,
} from './lib/baseline';
import { compare } from './lib/compare';
import { writeRun } from './lib/runStore';
import {
  renderGateSummary,
  renderRunSummary,
  relativeToCwd,
} from './lib/report';
import { writeJson } from './lib/fsutil';
import { toSarif } from './lib/sarif';
import { loadCandidate } from './lib/candidate';
import { getAnalyzer, listAnalyzers } from './lib/registry';
// Registration side effect: importing this module populates the registry.
import './adapters/index';

const EXIT = { PASS: 0, FAIL: 1, INCOMPLETE: 2 } as const;

interface ParsedArgs {
  command: string;
  analyzer: string | null;
  profile: string;
  repoRoot: string;
  flags: Set<string>;
  options: Map<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Set<string>();
  const options = new Map<string, string>();
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token.startsWith('--')) {
      const [name, inlineValue] = token.slice(2).split('=');
      if (name === undefined) continue;
      if (inlineValue !== undefined) {
        options.set(name, inlineValue);
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('-')) {
        options.set(name, next);
        index += 1;
        continue;
      }
      flags.add(name);
      continue;
    }
    positional.push(token);
  }

  const second = positional[1];
  return {
    command: positional[0] ?? 'help',
    analyzer: second !== undefined && !second.startsWith('-') ? second : null,
    profile: options.get('profile') ?? 'research',
    repoRoot: resolve(
      options.get('repo') ?? inferRepoRootFromScript() ?? process.cwd()
    ),
    flags,
    options,
  };
}

function inferRepoRootFromScript(): string | null {
  const here = import.meta.dir.replace(/\\/g, '/');
  const marker = '/scripts/quality';
  const index = here.indexOf(marker);
  return index === -1 ? null : here.slice(0, index);
}

interface AnalyzerRun {
  result: AnalyzerResult;
  candidate: CandidateIdentity;
  candidateAtFinish: CandidateIdentity;
}

async function executeAnalyzer(args: ParsedArgs): Promise<AnalyzerRun> {
  if (args.analyzer === null) {
    throw new Error(
      `an analyzer is required; registered: ${listAnalyzers()
        .map((analyzer) => analyzer.id)
        .join(', ')}`
    );
  }

  const analyzer = getAnalyzer(args.analyzer);

  // Identity is computed with this analyzer's declared policy inputs, so a lint
  // threshold edit invalidates a maintainability baseline without the engine
  // needing to know what a threshold is.
  const policyFiles = [
    ...policyFilesFor(analyzer.id),
    ...(analyzer.policyFiles ?? []),
  ];
  const candidateStart = computeCandidateIdentity(args.repoRoot, policyFiles);
  const candidateModel = loadCandidate(args.repoRoot);

  if (!candidateModel.hasTrackedUniverse) {
    // An analyzer that receives an empty tracked set cannot tell a missing file
    // from an untracked one, so it would either miss real findings or invent
    // them. Recorded as a note here and reflected in the run record; the analyzer
    // sees the same empty set it would have got anyway, but no longer silently.
    candidateModel.notes.push(
      'git reported no tracked files; findings that distinguish tracked from ' +
        'untracked cannot be trusted this run'
    );
  }

  const notes: string[] = [...candidateModel.notes];

  const result = await analyzer.run({
    repoRoot: args.repoRoot,
    candidateFiles: candidateModel.files,
    absolute: (relativePath) => resolve(args.repoRoot, relativePath),
    trackedFiles: candidateModel.trackedFiles,
    cacheDir: join(args.repoRoot, '.quality', '.cache', analyzer.id),
    notes,
  });

  // The finish identity must be computed with the SAME policy inputs as the start
  // identity. Omitting them here would make an edit to the analyzer's own policy
  // invisible to the mid-run comparison, so "raise the lint limit while the gate
  // runs" would slip through the one check that exists to catch it.
  const candidateAtFinish = computeCandidateIdentity(args.repoRoot, policyFiles);
  return { result, candidate: candidateStart, candidateAtFinish };
}

async function commandRun(args: ParsedArgs): Promise<number> {
  const startedAt = new Date().toISOString();
  const run = await executeAnalyzer(args);
  const finishedAt = new Date().toISOString();

  const { record, path } = writeRun(args.repoRoot, {
    analyzer: run.result.analyzer,
    profile: args.profile,
    startedAt,
    finishedAt,
    candidate: run.candidate,
    candidateAtFinish: run.candidateAtFinish,
    candidateStable: identityEqual(run.candidate, run.candidateAtFinish),
    result: run.result,
  });

  const jsonOut = args.options.get('json');
  if (jsonOut !== undefined) {
    writeJson(resolve(jsonOut), {
      identity: shortIdentity(run.candidate),
      runId: record.runId,
      findings: run.result.findings,
      counts: record.counts,
      notes: run.result.notes,
    });
  }

  if (args.flags.has('quiet') || jsonOut !== undefined) {
    process.stdout.write(
      `${run.result.findings.length} findings; run record ${record.runId}\n`
    );
  } else {
    process.stdout.write(
      `${renderRunSummary(run.result.analyzer, args.profile, run.result)}\n`
    );
    process.stdout.write(`\n  run record: ${relativeToCwd(path)}\n`);
    process.stdout.write(`  identity  : ${shortIdentity(run.candidate)}\n`);
  }

  return run.result.complete ? EXIT.PASS : EXIT.INCOMPLETE;
}

/**
 * `compare` reports what the gate would find, without the baseline being written.
 * It is the discovery half; `baseline propose` is the acceptance half.
 */
async function commandCompare(args: ParsedArgs): Promise<number> {
  const run = await executeAnalyzer(args);
  const baseline = readBaseline(args.repoRoot, run.result.analyzer);

  const gate = compare({
    analyzer: run.result.analyzer,
    profile: args.profile,
    baseline,
    result: run.result,
    candidateAtStart: run.candidate,
    candidateAtFinish: run.candidateAtFinish,
    repoRoot: args.repoRoot,
  });

  const jsonOut = args.options.get('json');
  if (jsonOut !== undefined) writeJson(resolve(jsonOut), gate);

  process.stdout.write(`${renderGateSummary(gate)}\n`);

  if (gate.resolvedFindings.length > 0) {
    process.stdout.write(
      `\n  ${gate.resolvedFindings.length} legacy finding(s) are resolved.\n` +
        '  The accepted baseline has NOT been modified. To accept this:\n' +
        `    quality baseline ${run.result.analyzer} --accept-resolution ` +
        '--accepted-by <name>\n'
    );
  }

  return EXIT[gate.decision];
}

async function commandGate(args: ParsedArgs): Promise<number> {
  const run = await executeAnalyzer(args);
  const baseline = readBaseline(args.repoRoot, run.result.analyzer);

  const gate = compare({
    analyzer: run.result.analyzer,
    profile: args.profile,
    baseline,
    result: run.result,
    candidateAtStart: run.candidate,
    candidateAtFinish: run.candidateAtFinish,
    repoRoot: args.repoRoot,
  });

  const sarifOut = args.options.get('sarif');
  if (sarifOut !== undefined) {
    writeJson(resolve(sarifOut), toSarif(run.result, gate));
  }
  const jsonOut = args.options.get('json');
  if (jsonOut !== undefined) writeJson(resolve(jsonOut), gate);

  process.stdout.write(`${renderGateSummary(gate)}\n`);

  if (baseline !== null) {
    const expiring = expiredWaivers(baseline, new Date());
    if (expiring.length > 0) {
      process.stdout.write(
        `\n  ${expiring.length} waiver(s) have expired and now block.\n`
      );
    }
  }

  return EXIT[gate.decision];
}

async function commandBaseline(args: ParsedArgs): Promise<number> {
  const action =
    args.options.get('action') ??
    (args.flags.has('propose')
      ? 'propose'
      : args.flags.has('accept-resolution')
        ? 'accept-resolution'
        : 'list');

  if (action === 'list') {
    const baselines = listBaselines(args.repoRoot);
    if (baselines.length === 0) {
      process.stdout.write('no accepted baselines\n');
      return EXIT.PASS;
    }
    for (const name of baselines) {
      const baseline = readBaseline(args.repoRoot, name);
      if (baseline === null) continue;
      const entries = Object.values(baseline.findings);
      const expiring = expiredWaivers(baseline, new Date()).length;
      const owners = new Set(
        entries.map((entry) => entry.acceptance.owner ?? '(unowned)')
      );
      process.stdout.write(
        `${name}: ${entries.length} recorded findings\n` +
          `    schema        : v${baseline.schemaVersion}\n` +
          `    oldest accept : ${oldestAcceptance(entries) ?? 'unknown'}\n` +
          `    owners        : ${[...owners].sort().join(', ')}\n` +
          `    expired waiver: ${expiring}\n`
      );
    }
    return EXIT.PASS;
  }

  if (args.analyzer === null) {
    throw new Error(`baseline ${action} requires an analyzer name`);
  }

  if (action === 'accept-resolution') {
    const baseline = readBaseline(args.repoRoot, args.analyzer);
    if (baseline === null) {
      throw new Error(`no accepted baseline for "${args.analyzer}"`);
    }
    const run = await executeAnalyzer(args);
    const gate = compare({
      analyzer: run.result.analyzer,
      profile: args.profile,
      baseline,
      result: run.result,
      candidateAtStart: run.candidate,
      candidateAtFinish: run.candidateAtFinish,
      repoRoot: args.repoRoot,
    });

    // Only a run that can vouch for its own completeness is allowed to erase
    // debt. A partial scan reporting fewer findings must never shrink a baseline.
    if (gate.decision === 'INCOMPLETE') {
      process.stderr.write(
        'refusing to update the baseline: the run is INCOMPLETE.\n'
      );
      for (const reason of gate.incompleteReasons) {
        process.stderr.write(`  ! ${reason}\n`);
      }
      return EXIT.INCOMPLETE;
    }

    if (gate.newFindings.length > 0 || gate.worsened.length > 0) {
      process.stderr.write(
        'refusing to update the baseline: the candidate has new or worsened ' +
          'findings. Resolve those first; accepting a shrinking baseline while ' +
          'adding debt defeats the ratchet.\n'
      );
      return EXIT.FAIL;
    }

    // Reconstructed from `anchor`, the same component Finding.id uses. Building
    // it from the locator would produce keys no baseline entry can carry.
    const resolvedIds = gate.resolvedFindings.map(
      (entry) => `${entry.rule}::${entry.subject}::${entry.anchor}`
    );

    // The ids recorded in a baseline are its own keys, not reconstructed ones.
    const actualIds = Object.entries(baseline.findings)
      .filter(([, entry]) =>
        gate.resolvedFindings.some(
          (resolved) =>
            resolved.rule === entry.rule &&
            resolved.subject === entry.subject &&
            resolved.anchor === entry.anchor
        )
      )
      .map(([id]) => id);

    const { updated, removed } = proposeResolutionUpdate(
      baseline,
      actualIds.length > 0 ? actualIds : resolvedIds,
      args.options.get('accepted-by') ?? 'unreviewed'
    );

    process.stdout.write(`  removed: ${removed.length}\n`);
    for (const entry of removed.slice(0, 60)) {
      process.stdout.write(`    - ${entry.rule} ${entry.subject} ${entry.locator}\n`);
    }

    if (args.flags.has('write')) {
      const path = writeBaseline(args.repoRoot, updated);
      process.stdout.write(
        `\n  baseline updated: ${relativeToCwd(path)}\n` +
          `  ${Object.keys(baseline.findings).length} -> ${Object.keys(updated.findings).length} findings\n`
      );
      return EXIT.PASS;
    }

    const proposalPath = writeProposal(args.repoRoot, updated);
    process.stdout.write(
      `\n  proposal written (NOT accepted): ${relativeToCwd(proposalPath)}\n`
    );
    return EXIT.PASS;
  }

  if (action !== 'propose') {
    throw new Error(`unknown baseline action "${action}"`);
  }

  const run = await executeAnalyzer(args);
  const proposal = proposeBaseline(
    args.repoRoot,
    run.result.analyzer,
    run.result,
    run.candidate,
    {
      reason:
        args.options.get('reason') ??
        'Initial baseline: existing findings recorded as the ratchet point.',
      acceptedBy: args.options.get('accepted-by') ?? 'unreviewed',
      owner: args.options.get('owner') ?? null,
      expiresAt: args.options.get('expires') ?? null,
    }
  );

  process.stdout.write(
    `${renderRunSummary(run.result.analyzer, args.profile, run.result)}\n\n`
  );

  const counted = Object.keys(proposal.baseline.findings).length;
  process.stdout.write(`  proposal records        : ${counted}\n`);
  process.stdout.write(
    `    tolerated debt        : ${proposal.debt.length}\n`
  );
  process.stdout.write(
    `    accepted legacy       : ${proposal.grandfathered.length}\n`
  );
  process.stdout.write(
    `    ordinary passes       : ${proposal.passing.length} (not recorded)\n`
  );
  if (proposal.unrecordable.length > 0) {
    process.stdout.write(
      `    review required       : ${proposal.unrecordable.length} (NOT recorded; ` +
        'blocks until resolved)\n'
    );
    for (const finding of proposal.unrecordable.slice(0, 20)) {
      process.stdout.write(
        `      ! ${finding.rule} ${finding.subject} ${finding.locator}\n`
      );
    }
    if (proposal.unrecordable.length > 20) {
      process.stdout.write(
        `      ... and ${proposal.unrecordable.length - 20} more\n`
      );
    }
  }

  if (args.flags.has('write')) {
    const path = writeBaseline(args.repoRoot, proposal.baseline);
    process.stdout.write(
      `\n  accepted baseline written: ${relativeToCwd(path)}\n` +
        `  accepted by: ${proposal.baseline.findings[Object.keys(proposal.baseline.findings)[0] ?? '']?.acceptance.acceptedBy ?? 'n/a'}\n`
    );
    return EXIT.PASS;
  }

  const proposalPath = writeProposal(args.repoRoot, proposal.baseline);
  process.stdout.write(
    `\n  proposal written (NOT accepted): ${relativeToCwd(proposalPath)}\n` +
      '  Review it. A baseline is a decision about what is tolerated.\n'
  );
  return EXIT.PASS;
}

function oldestAcceptance(
  entries: Array<{ acceptance: { acceptedAt: string } }>
): string | null {
  if (entries.length === 0) return null;
  return entries
    .map((entry) => entry.acceptance.acceptedAt)
    .sort()[0] ?? null;
}

function commandAnalyzers(): number {
  process.stdout.write('registered analyzers\n\n');
  for (const analyzer of listAnalyzers()) {
    process.stdout.write(`  ${analyzer.id}\n      ${analyzer.description}\n`);
  }
  return EXIT.PASS;
}

function commandRules(args: ParsedArgs): number {
  const analyzers =
    args.analyzer === null ? listAnalyzers() : [getAnalyzer(args.analyzer)];
  for (const analyzer of analyzers) {
    process.stdout.write(`${analyzer.id}\n`);
    for (const [id, description] of Object.entries(analyzer.rules)) {
      process.stdout.write(`  ${id.padEnd(42)} ${description}\n`);
    }
    process.stdout.write('\n');
  }
  process.stdout.write(
    '  Rule IDs are stable. Retire a rule by leaving it declared and marked\n' +
      '  deprecated; never renumber, because baselines cite these strings.\n'
  );
  return EXIT.PASS;
}

function commandTest(args: ParsedArgs): number {
  const proc = spawnSync('bun', ['test', 'scripts/quality/fixtures'], {
    cwd: args.repoRoot,
    stdio: 'inherit',
  });
  return proc.status ?? EXIT.INCOMPLETE;
}

function commandDoctor(args: ParsedArgs): number {
  const problems: string[] = [];
  const warnings: string[] = [];

  if (!existsSync(join(args.repoRoot, 'scripts', 'build.ts'))) {
    warnings.push('missing scripts/build.ts (declared-stub authority)');
  }
  if (!existsSync(join(args.repoRoot, '.quality', 'policy'))) {
    problems.push('missing .quality/policy directory');
  }

  const gitCheck = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: args.repoRoot,
    encoding: 'utf8',
  });
  if (gitCheck.status !== 0) {
    problems.push('not a git checkout; candidate identity will be degraded');
  }

  const candidate = loadCandidate(args.repoRoot);
  if (!candidate.hasTrackedUniverse) {
    problems.push('git returned no tracked files; candidate model is blind');
  }

  for (const analyzer of listAnalyzers()) {
    if (Object.keys(analyzer.rules).length === 0) {
      problems.push(`analyzer ${analyzer.id} declares no rules`);
    }
  }

  for (const warning of warnings) process.stdout.write(`~ ${warning}\n`);
  if (problems.length === 0) {
    process.stdout.write(
      `environment OK (${candidate.files.length} candidate files, ` +
        `${listAnalyzers().length} analyzers)\n`
    );
    return EXIT.PASS;
  }
  for (const problem of problems) process.stdout.write(`! ${problem}\n`);
  return EXIT.INCOMPLETE;
}

function usage(): string {
  return [
    'quality - deterministic quality control',
    '',
    '  quality run <analyzer> [--profile <name>] [--json <path>] [--quiet]',
    '  quality compare <analyzer> [--json <path>]        discovery only, read-only',
    '  quality gate <analyzer> [--sarif <path>] [--json <path>]',
    '  quality baseline <analyzer> --propose [--write] [--accepted-by <n>]',
    '  quality baseline <analyzer> --accept-resolution [--write] [--accepted-by <n>]',
    '  quality baseline --list',
    '  quality analyzers | rules [<analyzer>] | test | doctor',
    '',
    '  profiles : research | development | release',
    '  exit     : 0 pass, 1 fail, 2 incomplete',
    '',
    '  The gate never writes a baseline. Resolution is discovered automatically',
    '  and accepted separately, so scanner bugs cannot erase debt.',
    '',
  ].join('\n');
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  resolveProfile(args.profile);
  // Registration is a side effect of importing ./adapters/index; the import at
  // the top of this module is what makes every registered analyzer visible.

  switch (args.command) {
    case 'run':
      return commandRun(args);
    case 'compare':
      return commandCompare(args);
    case 'gate':
      return commandGate(args);
    case 'baseline':
      return commandBaseline(args);
    case 'analyzers':
      return commandAnalyzers();
    case 'rules':
      return commandRules(args);
    case 'test':
      return commandTest(args);
    case 'doctor':
      return commandDoctor(args);
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(usage());
      return EXIT.PASS;
    default:
      process.stderr.write(`unknown command "${args.command}"\n\n${usage()}`);
      return EXIT.INCOMPLETE;
  }
}

if (import.meta.main) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exitCode = EXIT.INCOMPLETE;
    });
}

export { main, parseArgs };

