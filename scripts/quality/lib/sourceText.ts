/**
 * Source text with comments blanked out, byte- and line-for-byte.
 *
 * Shared because two independent analyzers need the same thing for the same
 * reason, and a second copy of it would be a duplicate block in the very tree
 * the duplication analyzer measures. One definition, imported by both.
 *
 * The masking preserves byte offsets and line structure - comment characters are
 * replaced by spaces, newlines are kept - so a masked string can be scanned with
 * the same line numbers and the same regular expressions as the original. That
 * property is what makes it usable for two different purposes:
 *
 *   - source integrity scans the masked text so that this repository's own
 *     comments, which legitimately discuss `import('../build.ts')` and
 *     `require()` in prose, are not reported as dependencies;
 *   - clone detection normalizes a clone region over the masked text so that a
 *     comment edited in one copy of a block does not split it into two families.
 *
 * Deliberately NOT a tokenizer. It knows only about quotes, line comments and
 * block comments, which is the amount of syntax needed to know where a comment
 * ends. A template literal's `${}` is not descended into, so a `//` inside an
 * interpolation is treated as a comment - acceptable here because both callers
 * use the result to look for patterns rather than to reconstruct source.
 */
export function maskComments(source: string): string {
  const out = source.split('');
  let index = 0;
  let quote: string | null = null;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (quote !== null) {
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      index += 1;
      continue;
    }

    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        out[index] = ' ';
        index += 1;
      }
      continue;
    }

    if (char === '/' && next === '*') {
      out[index] = ' ';
      out[index + 1] = ' ';
      index += 2;
      while (index < source.length) {
        if (source[index] === '*' && source[index + 1] === '/') {
          out[index] = ' ';
          out[index + 1] = ' ';
          index += 2;
          break;
        }
        if (source[index] !== '\n') out[index] = ' ';
        index += 1;
      }
      continue;
    }

    index += 1;
  }

  return out.join('');
}
