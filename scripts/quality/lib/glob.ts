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
 * and an optional trailing `/**` that also matches the directory itself.
 */

const REGEX_SPECIALS = /[.+^${}()|[\]\\]/g;

export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/');
  let source = '';
  let index = 0;

  while (index < normalized.length) {
    const char = normalized[index] as string;

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

export function compileGlob(pattern: string): (candidate: string) => boolean {
  const regex = globToRegExp(pattern);
  return (candidate: string) => regex.test(candidate.replace(/\\/g, '/'));
}

export function looksLikeGlob(pattern: string): boolean {
  return /[*?[\]{}]/.test(pattern);
}
