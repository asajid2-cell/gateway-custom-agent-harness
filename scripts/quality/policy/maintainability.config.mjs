/**
 * Maintainability rule set.
 *
 * Scope discipline: these rules measure *shape*, not taste. Every rule here maps
 * to a number a reviewer can reason about. Stylistic and preference rules are
 * deliberately absent - a quality gate that argues about formatting loses the
 * argument it actually needs to win about complexity.
 *
 * A rule added here changes what the analyzer reports, so the analyzer hashes
 * this file into its policy digest alongside scripts/build.ts and tsconfig.json.
 *
 * This rule set is deliberately closed and self-contained. It once was not, and
 * the cost was invisible. Files in this repository carry
 * `// eslint-disable-next-line custom-rules/...` directives, and when a config
 * does not load that plugin ESLint reports "Definition for rule
 * 'custom-rules/...' was not found" as an `error` whose `ruleId` is the
 * unloadable rule name - so the report looked exactly like 198 findings for a
 * rule this analyzer never configures. The 82 `react-hooks` and `eslint-plugin-n`
 * entries were the same artifact: those directives name plugins this config does
 * not declare, and `reportUnusedDisableDirectives: 'off'` would otherwise have
 * absorbed them silently.
 *
 * `noInlineConfig` is what closes it: a file may not change the rule set that
 * measures it. The analyzer independently refuses to record a finding whose own
 * text says the rule was not found, so neither half depends on the other.
 */
import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';

export default tseslint.config(
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs', '**/*.jsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      sonarjs,
    },
    linterOptions: {
      // A file-local directive may not alter the rule set that is measuring it.
      noInlineConfig: true,
      // Suppression directives are themselves the subject of MAINT-020, so they
      // must be visible rather than swallowed by the linter.
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      // --- size and shape ------------------------------------------------
      complexity: ['error', { max: 20 }],
      'max-depth': ['error', 5],
      'max-nested-callbacks': ['error', 4],
      'max-params': ['error', 6],
      'max-lines-per-function': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
      'max-statements': ['error', 60],
      'max-lines': ['error', { max: 1200, skipBlankLines: true, skipComments: true }],

      // Sonar cognitive complexity: weights nesting, unlike ESLint's complexity.
      'sonarjs/cognitive-complexity': ['error', 25],
      'sonarjs/no-nested-conditional': 'error',
      'sonarjs/no-duplicate-in-composite': 'error',

      // --- type safety escapes -------------------------------------------
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unsafe-function-type': 'error',
      '@typescript-eslint/no-empty-object-type': 'error',
      '@typescript-eslint/no-unsafe-declaration-merging': 'error',
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as', objectLiteralTypeAssertions: 'never' },
      ],

      // --- suppression debt ----------------------------------------------
      'no-warning-comments': [
        'error',
        { terms: ['eslint-disable', 'ts-ignore', 'ts-expect-error', 'ts-nocheck'], location: 'anywhere' },
      ],

      // --- correctness rules that reduce rather than add noise ------------
      'sonarjs/no-identical-functions': 'off',
      'sonarjs/no-duplicated-branches': 'error',
      'sonarjs/no-all-duplicated-branches': 'error',
      'sonarjs/no-identical-expressions': 'error',
      'sonarjs/no-collapsible-if': 'error',
      'sonarjs/no-invariant-returns': 'error',
      'sonarjs/no-redundant-jump': 'error',
      'sonarjs/no-gratuitous-expressions': 'error',
      'sonarjs/no-same-line-conditional': 'error',
      'sonarjs/no-useless-catch': 'error',
    },
  },
  {
    // These are genuinely exempt from size limits - generated or declarative.
    ignores: [
      'node_modules/**',
      'dist/**',
      '.quality/**',
      'scripts/quality/fixtures/**',
      'src/utils/protectedNamespace.js',
      'src/**/*.generated.*',
    ],
  }
);
