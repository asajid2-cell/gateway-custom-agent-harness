import { join } from 'node:path';
import type { AnalyzerResult, CandidateIdentity, RunRecord } from './types';
import { ensureDir, writeJson } from './fsutil';
import { runsDir } from './baseline';

export function runIdFor(analyzer: string, startedAt: string): string {
  const stamp = startedAt.replace(/[:.]/g, '-');
  return `${stamp}-${analyzer}`;
}

export function writeRun(
  repoRoot: string,
  input: {
    analyzer: string;
    profile: string;
    startedAt: string;
    finishedAt: string;
    candidate: CandidateIdentity;
    candidateAtFinish: CandidateIdentity;
    candidateStable: boolean;
    result: AnalyzerResult;
  }
): { record: RunRecord; path: string } {
  const record: RunRecord = {
    schemaVersion: 1,
    runId: runIdFor(input.analyzer, input.startedAt),
    analyzer: input.analyzer,
    profile: input.profile,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    candidate: input.candidate,
    candidateAtFinish: input.candidateAtFinish,
    candidateStable: input.candidateStable,
    coverage: input.result.coverage,
    complete: input.result.complete,
    counts: countFindings(input.result),
    errors: input.result.errors,
    notes: input.result.notes,
  };

  const dir = runsDir(repoRoot);
  ensureDir(dir);
  const path = join(dir, `${record.runId}.json`);
  writeJson(path, record);

  // Full finding body lives beside the run, so the summary stays readable and the
  // evidence stays available without re-running the analyzer.
  writeJson(join(dir, `${record.runId}.findings.json`), {
    analyzer: input.analyzer,
    runId: record.runId,
    findings: input.result.findings,
  });

  return { record, path };
}

function countFindings(result: AnalyzerResult): Record<string, number> {
  const counts: Record<string, number> = {};
  const bump = (key: string): void => {
    counts[key] = (counts[key] ?? 0) + 1;
  };
  for (const finding of result.findings) {
    if (finding.debt) {
      bump('debt');
    } else {
      bump(finding.status);
    }
    bump(`class:${finding.classification}`);
    bump(`rule:${finding.rule}`);
  }
  return counts;
}
