import { relative } from 'node:path';
import type { AnalyzerResult, Coverage, Disposition, GateResult } from './types';

const COLOR = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  green: '\u001b[32m',
  cyan: '\u001b[36m',
};

export function colorEnabled(): boolean {
  return process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
}

function paint(text: string, color: keyof typeof COLOR): string {
  if (!colorEnabled()) return text;
  return `${COLOR[color]}${text}${COLOR.reset}`;
}

export function relativeToCwd(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel.startsWith('..') ? path : rel;
}

/** Coverage rendered as arithmetic, because "complete" must not be a vibe. */
function renderCoverage(coverage: Coverage, complete: boolean): string[] {
  const lines: string[] = [];
  const eligible = coverage.eligible === null ? 'unknown' : String(coverage.eligible);
  lines.push(
    `  coverage         : eligible ${eligible}, scanned ${coverage.scanned}, ` +
      `skipped ${coverage.skipped}, failed ${coverage.failed}`
  );
  lines.push(
    `  completeness     : ${complete ? paint('complete', 'green') : paint('INCOMPLETE', 'yellow')}`
  );
  for (const [reason, count] of Object.entries(coverage.skipReasons)) {
    lines.push(`    ${paint(reason, 'dim')}: ${count}`);
  }
  // Exclusions are reported under their own label because they are counted in a
  // different unit from the arithmetic above. Printing them identically would
  // invite the reading that they are part of it.
  for (const [reason, count] of Object.entries(coverage.exclusions ?? {})) {
    lines.push(
      `    ${paint(`excluded (not in the arithmetic): ${reason}`, 'dim')}: ${count}`
    );
  }
  return lines;
}

export function renderRunSummary(
  analyzer: string,
  profile: string,
  result: AnalyzerResult
): string {
  const lines: string[] = [];
  const counts = { pass: 0, fail: 0, debt: 0 };
  const byClass = new Map<string, number>();

  for (const finding of result.findings) {
    if (finding.debt) counts.debt += 1;
    else if (finding.status === 'fail') counts.fail += 1;
    else counts.pass += 1;
    byClass.set(
      finding.classification,
      (byClass.get(finding.classification) ?? 0) + 1
    );
  }

  lines.push(
    `${paint('quality run', 'bold')} ${analyzer} ${paint(`(${profile})`, 'dim')}`
  );
  lines.push('');
  lines.push(...renderCoverage(result.coverage, result.complete));
  lines.push('');
  lines.push(`  pass             : ${counts.pass}`);
  lines.push(
    `  fail             : ${counts.fail > 0 ? paint(String(counts.fail), 'red') : '0'}`
  );
  lines.push(
    `  known debt       : ${counts.debt > 0 ? paint(String(counts.debt), 'yellow') : '0'}`
  );
  lines.push('');

  for (const [classification, count] of [...byClass.entries()].sort(
    (a, b) => b[1] - a[1]
  )) {
    lines.push(`    ${classification.padEnd(30)} ${count}`);
  }

  if (result.errors.length > 0) {
    lines.push('');
    lines.push(paint('  analyzer errors', 'yellow'));
    for (const error of result.errors.slice(0, 25)) {
      lines.push(`    ${error.kind} ${error.subject}: ${error.message}`);
    }
    if (result.errors.length > 25) {
      lines.push(`    ... and ${result.errors.length - 25} more`);
    }
  }

  if (result.notes.length > 0) {
    lines.push('');
    for (const note of result.notes) lines.push(`  ${paint(note, 'dim')}`);
  }

  return lines.join('\n');
}

const DISPOSITION_LABEL: Record<Disposition, string> = {
  'active-blocker': 'active blocker',
  'accepted-legacy': 'accepted legacy',
  'temporary-waiver': 'temporary waiver',
  'review-required': 'review required',
  unresolved: 'unresolved',
};

export function renderGateSummary(gate: GateResult): string {
  const lines: string[] = [];
  const decisionPaint =
    gate.decision === 'PASS' ? 'green' : gate.decision === 'FAIL' ? 'red' : 'yellow';

  lines.push(
    `${paint(`quality gate ${gate.decision}`, 'bold')} ${gate.analyzer} ` +
      `${paint(`(${gate.profile})`, 'dim')}`
  );
  lines.push('');

  if (gate.decision === 'INCOMPLETE') {
    for (const reason of gate.incompleteReasons) {
      lines.push(`  ${paint('!', 'yellow')} ${reason}`);
    }
    lines.push('');
    lines.push(
      '  INCOMPLETE is not a pass. The analyzer could not vouch for coverage, the ' +
        'candidate moved, or no accepted baseline exists.'
    );
    return lines.join('\n');
  }

  // What was measured, before what it means. A verdict is unreadable without
  // it: a PASS reached over a fraction of the scope looks identical to a PASS
  // over all of it, and a grader cannot tell which it is being shown.
  lines.push(
    ...renderCoverage(gate.coverage, gate.completeness === 'complete')
  );
  lines.push('');

  if (gate.newFindings.length > 0) {
    lines.push(paint(`  new findings: ${gate.newFindings.length}`, 'red'));
    for (const finding of gate.newFindings.slice(0, 30)) {
      lines.push(`    ${finding.rule} ${finding.subject} ${finding.locator}`);
      lines.push(`      ${paint(finding.detail, 'dim')}`);
    }
    if (gate.newFindings.length > 30) {
      lines.push(`    ... and ${gate.newFindings.length - 30} more`);
    }
    lines.push('');
  }

  if (gate.worsened.length > 0) {
    lines.push(paint(`  worsened: ${gate.worsened.length}`, 'red'));
    for (const entry of gate.worsened.slice(0, 30)) {
      const movement =
        entry.before.metric !== undefined && entry.after.metric !== undefined
          ? `${entry.before.metric.value} -> ${entry.after.metric.value}`
          : `${entry.before.occurrences} -> ${entry.after.occurrences}`;
      lines.push(`    ${entry.id} (${entry.reason}: ${movement})`);
    }
    lines.push('');
  }

  if (gate.movedFindings.length > 0) {
    lines.push(
      `  recognized as relocated (not new debt): ${gate.movedFindings.length}`
    );
    for (const entry of gate.movedFindings.slice(0, 20)) {
      lines.push(`    ${entry.from.subject} -> ${entry.to.subject}`);
    }
    lines.push('');
  }

  if (gate.improvedFindings.length > 0) {
    lines.push(
      paint(`  improved but still above limit: ${gate.improvedFindings.length}`, 'cyan')
    );
    for (const entry of gate.improvedFindings.slice(0, 20)) {
      lines.push(
        `    ${entry.id} (${entry.metric.name}: ${entry.from.value} -> ` +
          `${entry.metric.value}, limit ${entry.metric.limit ?? 'n/a'})`
      );
    }
    lines.push('');
  }

  lines.push('  dispositions:');
  for (const [disposition, count] of Object.entries(gate.dispositions)) {
    if (count === 0) continue;
    const label = DISPOSITION_LABEL[disposition as Disposition];
    lines.push(`    ${label.padEnd(20)} ${count}`);
  }

  lines.push('');
  lines.push(`  resolved since baseline    : ${gate.resolvedFindings.length}`);

  if (gate.resolvedFindings.length > 0) {
    lines.push('');
    lines.push(
      '  Resolution is discovered here but NOT applied. The accepted baseline is\n' +
        '  unchanged until someone accepts the update:'
    );
    for (const finding of gate.resolvedFindings.slice(0, 20)) {
      lines.push(`    - ${finding.rule} ${finding.subject} ${finding.locator}`);
    }
    if (gate.resolvedFindings.length > 20) {
      lines.push(`    ... and ${gate.resolvedFindings.length - 20} more`);
    }
    lines.push('');
    lines.push(`    quality baseline ${gate.analyzer} --accept-resolution [--write]`);
  }

  return lines.join('\n');
}
