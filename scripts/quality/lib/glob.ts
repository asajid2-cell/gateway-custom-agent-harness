/**
 * Minimal glob matching for runtime-root and exclusion patterns.
 *
 * This exists instead of pulling in `picomatch` for three reasons:
 *  1. The patterns involved are authored by us and few, not user input.
 *  2. `picomatch` ships no type declarations here, so importing it adds a
 *     TS7016 to a repo whose type baseline is already the thing being measured.
 *  3. A quality tool that cannot typecheck itself undercuts its own argument.
 *
 * Supported: `*` (within a path segment), `**` (across segments), `?` (one char),
 * `{a,b}` alternation, and an optional trailing `/**` that also matches the
 * directory itself.
 *
 * Brace alternation is here because the source-universe manifest needs to name
 * "every test file" and "every script extension" without repeating itself, and a
 * role glob that silently matches nothing is indistinguishable from a role with
 * no members - which is exactly the failure the manifest's `unclassified` report
 * exists to catch. Supporting the syntax is cheaper than explaining to a future
 * reader why `{test,spec}` did not work in a glob.
 */

const REGEX_SPECIALS = /[.+^$()|[\]\\]/g;

export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/');
  let source = '';
  let index = 0;

  while (index < normalized.length) {
    const char = normalized[index] as string;

    if (char === '{') {
      const close = normalized.indexOf('}', index);
      if (close === -1) {
        // An unmatched brace is a literal, not an error: rejecting it here would
        // make a typo in a role glob throw at load time, and a manifest that
        // cannot be parsed is worse than one that matches too little - the
        // latter still reports its unclassified files.
        source += '\\{';
        index += 1;
        continue;
      }
      // Each alternative is compiled as its own pattern body so nesting works
      // naturally through recursion.
      const body = normalized.slice(index + 1, close);
      const alternatives = splitAlternatives(body).map((part) =>
        globBodyToSource(part)
      );
      source += `(?:${alternatives.join('|')})`;
      index = close + 1;
      continue;
    }

    if (char === '*') {
      const isDouble = normalized[index + 1] === '*';
      if (isDouble) {
        // `**/` may match zero segments, so it must be optional.
        if (normalized[index + 2] === '/') {
          source += '(?:[^/]+/)*';
          index += 3;
          continue;
        }
        source += '.*';
        index += 2;
        continue;
      }
      source += '[^/]*';
      index += 1;
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }

    source += char.replace(REGEX_SPECIALS, '\\$&');
    index += 1;
  }

  // `a/**` should match `a` as well as `a/b`.
  const optionalSelf = source.endsWith('/.*') ? '?' : '';
  return new RegExp(`^${source}${optionalSelf}$`);
}

/** The body of a `{...}` group, converted with the same rules as a whole glob. */
function globBodyToSource(body: string): string {
  const regex = globToRegExp(body);
  // Strip the anchors globToRegExp adds so the body can be embedded in a group.
  return regex.source.replace(/^\^/, '').replace(/\$$/, '');
}

function splitAlternatives(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of body) {
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

export function compileGlob(pattern: string): (candidate: string) => boolean {
  const regex = globToRegExp(pattern);
  return (candidate: string) => regex.test(candidate.replace(/\\/g, '/'));
}

export function looksLikeGlob(pattern: string): boolean {
  return /[*?[\]{}]/.test(pattern);
}
