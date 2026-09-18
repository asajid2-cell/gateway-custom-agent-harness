import type { AnalyzerResult, GateResult } from './types';

/**
 * SARIF is an interchange format, not an authentication mechanism.
 *
 * The `baselineState` field below describes what *this run* observed relative to
 * the tool's own accepted baseline. It is not evidence that a result was reviewed
 * by a human, and it must not be treated as one.
 */
export function toSarif(
  result: AnalyzerResult,
  gate: GateResult
): Record<string, unknown> {
  const newIds = new Set(gate.newFindings.map((finding) => finding.id));
  const movedIds = new Set(gate.movedFindings.map((entry) => entry.to.id));
  const worsenedIds = new Set(gate.worsened.map((entry) => entry.after.id));
  const improvedIds = new Set(gate.improvedFindings.map((entry) => entry.id));

  const rules = new Map<string, Record<string, unknown>>();
  for (const finding of result.findings) {
    if (rules.has(finding.rule)) continue;
    rules.set(finding.rule, {
      id: finding.rule,
      name: finding.rule,
      shortDescription: { text: finding.classification },
      defaultConfiguration: {
        level: finding.severity === 'error' ? 'error' : 'warning',
      },
    });
  }

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'gateway-quality',
            informationUri: 'https://github.com/asajid2-cell/gateway',
            rules: [...rules.values()],
          },
        },
        invocations: [
          {
            executionSuccessful: gate.decision !== 'INCOMPLETE',
            exitCode: gate.decision === 'PASS' ? 0 : gate.decision === 'FAIL' ? 1 : 2,
          },
        ],
        results: result.findings
          .filter((finding) => finding.status === 'fail')
          .map((finding) => ({
            ruleId: finding.rule,
            level: 'error',
            message: { text: finding.detail },
            /**
             * SARIF's four baseline states, mapped from the engine's dispositions.
             * A relocated finding is `updated`, not `unchanged`: the engine has
             * positive evidence the identity persisted, but the location the
             * previous run reported is no longer where it lives.
             */
            baselineState: newIds.has(finding.id)
              ? 'new'
              : movedIds.has(finding.id) ||
                  worsenedIds.has(finding.id) ||
                  improvedIds.has(finding.id)
                ? 'updated'
                : 'unchanged',
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: finding.subject },
                  ...(finding.evidence.line !== undefined &&
                  finding.evidence.line !== null
                    ? {
                        region: {
                          startLine: Number(finding.evidence.line),
                          ...(finding.evidence.column !== undefined &&
                          finding.evidence.column !== null
                            ? { startColumn: Number(finding.evidence.column) }
                            : {}),
                        },
                      }
                    : {}),
                },
              },
            ],
            properties: {
              classification: finding.classification,
              debt: finding.debt,
              occurrences: finding.occurrences,
              locator: finding.locator,
            },
          })),
      },
    ],
  };
}
