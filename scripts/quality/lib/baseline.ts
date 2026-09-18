import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Acceptance,
  AnalyzerResult,
  Baseline,
  BaselineFinding,
  CandidateIdentity,
  Finding,
} from './types';
import { readText, writeJson } from './fsutil';
import { fileDigest } from './hash';

export function baselinesDir(repoRoot: string): string {
  return join(repoRoot, '.quality', 'baselines');
}

export function baselinePath(repoRoot: string, analyzer: string): string {
  return join(baselinesDir(repoRoot), `${analyzer}.json`);
}

export function runsDir(repoRoot: string): string {
  return join(repoRoot, '.quality', 'runs');
}

export function subjectDigestFor(
  repoRoot: string,
  finding: Finding
): string | null {
  if (finding.subject === '') return null;
  return fileDigest(join(repoRoot, finding.subject));
}

function toBaselineFinding(
  repoRoot: string,
  finding: Finding,
  acceptance: Acceptance
): BaselineFinding {
  return {
    rule: finding.rule,
    classification: finding.classification,
    status: finding.status,
    severity: finding.severity,
    subject: finding.subject,
    locator: finding.locator,
    anchor: finding.anchor,
    subjectDigest: subjectDigestFor(repoRoot, finding),
    occurrences: finding.occurrences,
    debt: finding.debt,
    ...(finding.metric !== undefined ? { metric: finding.metric } : {}),
    // The analyzer's words, kept with the decision. Without this the baseline says
    // what was tolerated but not what was observed, and a reviewer accepting a
    // proposal has only the identity string to go on.
    ...(finding.detail !== undefined ? { detail: finding.detail } : {}),
    acceptance,
  };
}

export interface BaselineProposalOptions {
  reason: string;
  acceptedBy: string;
  owner?: string | null;
  expiresAt?: string | null;
}

export interface BaselineProposal {
  baseline: Baseline;
  /** Findings tolerated because they are known-unverified. */
  debt: Finding[];
  /**
   * Findings that fail today. Freezing them is what stops the baseline from being
   * unenforceable on day one. The gate blocks *new* failures, not this backlog.
   */
  grandfathered: Finding[];
  passing: Finding[];
  /** Findings that cannot be recorded at all; see Finding.reviewRequired. */
  unrecordable: Finding[];
}

export function proposeBaseline(
  repoRoot: string,
  analyzer: string,
  result: AnalyzerResult,
  candidate: CandidateIdentity,
  options: BaselineProposalOptions
): BaselineProposal {
  // A run that cannot vouch for its own coverage proposes nothing.
  //
  // This closes a real hole rather than a hypothetical one: a maintainability run
  // whose ESLint batches all failed to load still produced a well-formed proposal
  // recording zero findings, because the analyzer had correctly reported no
  // findings - it had not run. Accepting that proposal would have *erased* the
  // ratchet, which is precisely the "scanner bug erases debt" failure the whole
  // gated-shrink design exists to prevent. `compare` already refused; the proposal
  // path did not, so the two disagreed about what an incomplete run authorizes.
  const recordable = result.complete
    ? result.findings.filter((finding) => finding.reviewRequired !== true)
    : [];
  const debt = recordable.filter((finding) => finding.debt);
  const grandfathered = recordable.filter(
    (finding) => finding.status === 'fail' && !finding.debt
  );
  const passing = recordable.filter(
    (finding) => finding.status === 'pass' && !finding.debt
  );

  const acceptance: Acceptance = {
    reason: options.reason,
    acceptedBy: options.acceptedBy,
    acceptedAt: new Date().toISOString(),
    owner: options.owner ?? null,
    expiresAt: options.expiresAt ?? null,
  };

  // Only tolerated and failing findings belong in a ratchet. Recording tens of
  // thousands of ordinary passes would bloat the file and, worse, turn an
  // ordinary file move into thousands of "new findings".
  const findings: Record<string, BaselineFinding> = {};
  for (const finding of [...debt, ...grandfathered]) {
    findings[finding.id] = toBaselineFinding(repoRoot, finding, acceptance);
  }

  return {
    baseline: {
      schemaVersion: BASELINE_SCHEMA_VERSION,
      analyzer,
      policyDigest: candidate.policyDigest,
      // The epoch this baseline was recorded under. A later measurement change
      // compares against it rather than assuming the old numbers still mean the
      // same thing; see lib/migration.ts.
      measurementDigest: candidate.measurementDigest,
      recordedEligible: result.coverage.eligible,
      createdAt: new Date().toISOString(),
      candidate,
      findings,
    },
    debt,
    grandfathered,
    passing,
    unrecordable: result.findings.filter(
      (finding) => finding.reviewRequired === true
    ),
  };
}

/**
 * Build the baseline that WOULD result from accepting the current resolution.
 *
 * This is the only way a baseline shrinks. The gate discovers resolution; this
 * computes the consequence; a human or a trusted CI job accepts it. Scanner bugs
 * therefore cannot erase debt, because nothing writes this automatically.
 */
export function proposeResolutionUpdate(
  baseline: Baseline,
  resolvedIds: string[],
  acceptedBy: string
): { updated: Baseline; removed: BaselineFinding[] } {
  const removed: BaselineFinding[] = [];
  const findings: Record<string, BaselineFinding> = {};

  const resolved = new Set(resolvedIds);
  for (const [id, entry] of Object.entries(baseline.findings)) {
    if (resolved.has(id)) {
      removed.push(entry);
      continue;
    }
    findings[id] = entry;
  }

  return {
    updated: {
      ...baseline,
      createdAt: new Date().toISOString(),
      findings,
    },
    removed,
  };
}

const NOT_A_BASELINE = /\.proposed\.json$/;

export function writeBaseline(repoRoot: string, baseline: Baseline): string {
  const path = baselinePath(repoRoot, baseline.analyzer);
  writeJson(path, baseline);
  return path;
}

export function writeProposal(repoRoot: string, baseline: Baseline): string {
  const path = join(baselinesDir(repoRoot), `${baseline.analyzer}.proposed.json`);
  writeJson(path, baseline);
  return path;
}

/**
 * v3: entries carry `anchor`, and finding ids are position-independent.
 *
 * A v2 baseline is not readable by this engine and must not be. Its ids encode
 * `line:column`, so under v3 identity every one of its entries would fail to
 * match the finding it was written for - the entire baseline would read as
 * resolved-and-replaced, which is the loudest possible version of the silent
 * wrong answer this engine is built to avoid. Regenerating is a reviewed act.
 */
export const BASELINE_SCHEMA_VERSION = 3;

/**
 * Read an accepted baseline, refusing anything the current engine cannot
 * actually interpret.
 *
 * The cast at the end is only safe because of the checks above it. A baseline is
 * the record of what debt has been tolerated, so the failure mode to design
 * against is not "the file fails to parse" - that is loud and harmless. It is "a
 * file from an older schema parses into a structure that looks plausible", which
 * silently changes what the ratchet tolerates. A v1 entry has no `acceptance`
 * field; read as v2 it produces entries whose provenance is `undefined`, and
 * every downstream reader that trusts the type is then reading a lie.
 *
 * Refusing is the only safe response. An old baseline can always be regenerated
 * by proposing a new one, and that regeneration is a reviewed decision.
 */
export function readBaseline(repoRoot: string, analyzer: string): Baseline | null {
  const path = baselinePath(repoRoot, analyzer);
  const raw = readText(path);
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `baseline at ${path} is not valid JSON: ` +
        (error instanceof Error ? error.message : String(error))
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`baseline at ${path} is not a JSON object`);
  }

  const version = (parsed as { schemaVersion?: unknown }).schemaVersion;
  if (version !== BASELINE_SCHEMA_VERSION) {
    throw new Error(
      `baseline at ${path} has schemaVersion ${String(version)}; this engine ` +
        `reads version ${BASELINE_SCHEMA_VERSION}. Regenerate it with ` +
        `\`quality baseline ${analyzer} --propose --write\` rather than editing ` +
        'it, so the new tolerance is a reviewed decision.'
    );
  }

  const findings = (parsed as { findings?: unknown }).findings;
  if (typeof findings !== 'object' || findings === null) {
    throw new Error(`baseline at ${path} has no findings table`);
  }

  for (const [id, entry] of Object.entries(findings as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`baseline at ${path} entry "${id}" is not an object`);
    }
    const acceptance = (entry as { acceptance?: unknown }).acceptance;
    if (typeof acceptance !== 'object' || acceptance === null) {
      throw new Error(
        `baseline at ${path} entry "${id}" has no acceptance record; every ` +
          'tolerated finding must be answerable for who accepted it and why'
      );
    }
  }

  return parsed as Baseline;
}

export function listBaselines(repoRoot: string): string[] {
  const dir = baselinesDir(repoRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith('.json') && !NOT_A_BASELINE.test(entry))
    .map((entry) => entry.replace(/\.json$/, ''))
    .sort();
}

/**
 * Waivers that have passed their expiry. Reported every run so that an expiry is
 * never discovered only at the moment it blocks someone.
 */
export function expiredWaivers(baseline: Baseline, now: Date): BaselineFinding[] {
  return Object.values(baseline.findings).filter((entry) => {
    if (entry.acceptance.expiresAt === null) return false;
    const at = Date.parse(entry.acceptance.expiresAt);
    return Number.isNaN(at) || at <= now.getTime();
  });
}
