/**
 * The rule registry is a contract: a rule ID that appears in a baseline must be
 * lookable-up, and a rule that is enforced must appear in the registry.
 *
 * This is a fixture about a *documentation* invariant rather than an analyzer
 * behaviour, and it exists because the invariant was broken. The maintainability
 * config named twenty-two rules while the analyzer declared eleven, so thirteen
 * rules - including the duplicate-branch and collapsibility rules that produce
 * several hundred findings - were enforced but absent from `quality rules`. A
 * baseline citing them pointed at nothing.
 *
 * The check is deliberately a parse of the config rather than a hand-written list,
 * because a hand-written list is the thing that drifted.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAnalyzer, listAnalyzers } from '../lib/registry';
import '../adapters/index';

const ROOT = join(import.meta.dir, '..', '..', '..');

/** The body of the first `rules: { ... }` block, by brace matching. */
function rulesBlock(text: string): string {
  const start = text.search(/\brules\s*:\s*\{/);
  if (start === -1) return '';
  const open = text.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    else if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, index);
    }
  }
  return text.slice(open + 1);
}

/**
 * Rule IDs an ESLint flat config enables.
 *
 * Only keys at the top level of the `rules` block count. Option objects nested
 * inside a rule's configuration contain keys like `assertionStyle` and `terms`
 * that are structurally indistinguishable from rule names, and a depth-blind
 * match reported them as undocumented rules - which is how the first two versions
 * of this fixture failed, on its own false positives rather than on the drift it
 * exists to catch.
 *
 * A rule set to `off` is skipped: it is not part of the enforced rule set, so
 * requiring it in the registry would make the registry describe something other
 * than what runs.
 */
function enabledRuleIds(block: string): Set<string> {
  const ids = new Set<string>();
  const lines = block.split('\n');
  let depth = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    const atTopLevel = depth === 0;
    const key = atTopLevel
      ? /^\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z@][\w@/-]*))\s*:\s*(.*)$/.exec(line)
      : null;

    if (key !== null) {
      const id = key[1] ?? key[2] ?? key[3];
      const rest = (key[4] ?? '').trim();
      let severity: string | undefined;
      const inline = /^(?:'([^']*)'|"([^"]*)"|(\d))/.exec(rest);
      if (inline !== null) {
        severity = inline[1] ?? inline[2] ?? inline[3];
      } else if (rest.startsWith('[')) {
        // Severity on the following line, as in `rule: [\n  'error', ...`.
        const next = lines[index + 1] ?? '';
        const following = /^\s*(?:'([^']*)'|"([^"]*)"|(\d))/.exec(next);
        if (following !== null) {
          severity = following[1] ?? following[2] ?? following[3];
        }
      }
      if (id !== undefined && severity !== undefined) {
        if (severity !== 'off' && severity !== '0') ids.add(id);
      }
    }

    for (const char of line) {
      if (char === '{' || char === '[') depth += 1;
      else if (char === '}' || char === ']') depth -= 1;
    }
  }
  return ids;
}

describe('the maintainability rule registry matches the configured rule set', () => {
  const analyzer = getAnalyzer('maintainability');
  const configText = readFileSync(
    join(ROOT, 'scripts', 'quality', 'policy', 'maintainability.config.mjs'),
    'utf8'
  );
  const configured = enabledRuleIds(rulesBlock(configText));

  test('the config states a plausible number of rules', () => {
    expect(configured.size).toBeGreaterThan(15);
  });

  test('every configured rule is declared, with a description', () => {
    const declared = new Set(Object.keys(analyzer.rules));
    const undocumented = [...configured].filter((rule) => !declared.has(rule));
    expect(undocumented).toEqual([]);
  });

  test('every declared rule has a non-empty description', () => {
    for (const [id, description] of Object.entries(analyzer.rules)) {
      expect(description.length).toBeGreaterThan(0);
      void id;
    }
  });

  test('the synthetic suppression rule is declared but never configured', () => {
    // MAINT-020 is manufactured by the analyzer from ESLint's suppressed-message
    // list; it is not a rule ESLint runs. Declaring it and not configuring it is
    // therefore correct, and this pins the reason rather than the coincidence.
    expect(Object.keys(analyzer.rules)).toContain('MAINT-020');
    expect(configured.has('MAINT-020')).toBe(false);
  });
});

describe('every analyzer declares a usable rule registry', () => {
  test('ids are unique and each analyzer declares at least one rule', () => {
    const seen = new Set<string>();
    for (const analyzer of listAnalyzers()) {
      expect(seen.has(analyzer.id)).toBe(false);
      seen.add(analyzer.id);
      expect(Object.keys(analyzer.rules).length).toBeGreaterThan(0);
      for (const [id, description] of Object.entries(analyzer.rules)) {
        expect(id.length).toBeGreaterThan(0);
        expect(description.length).toBeGreaterThan(0);
      }
    }
  });

  test('analyzers that own policy declare it, and it exists', () => {
    // Identity is built from these paths. A declared-but-absent policy file
    // digests as "absent", so the policy digest would silently stop covering the
    // very thing it is meant to cover.
    for (const analyzer of listAnalyzers()) {
      for (const rel of analyzer.policyFiles ?? []) {
        const absolute = join(ROOT, rel);
        expect(readFileSync(absolute, 'utf8').length).toBeGreaterThan(0);
      }
    }
  });
});
