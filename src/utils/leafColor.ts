/**
 * The colour depth a leaf must paint with.
 *
 * A leaf's fd 1 is a pipe, so chalk finds no colour support there and drops
 * every theme colour: the leaf renders black and white even though its bytes
 * are drawn by the terminal that owns it, which has colour. The depth therefore
 * has to travel in the leaf's environment rather than be applied inside the
 * leaf, because the bundled CLI has chalk loaded before the leaf installs its
 * streams and chalk reads the environment once - an assignment after that is
 * silently ignored.
 */
export function leafColorEnv(
  stdout: { getColorDepth?: () => number; hasColors?: () => boolean } = process.stdout,
): Record<string, string> {
  // node reports depth in bits (1 = none, 4, 8, 24 = truecolor) and chalk takes
  // a level (0-3). node's 1 means "no colour", not "16 colours", so it must map
  // to 0 rather than being clamped into a colour level.
  const bits = stdout.getColorDepth?.() ?? (stdout.hasColors?.() ? 24 : 1)
  const level = bits >= 24 ? 3 : bits >= 8 ? 2 : bits >= 4 ? 1 : 0
  const env: Record<string, string> = { GATEWAY_LEAF_COLOR_DEPTH: String(level) }
  // An explicit request from the user outranks this: NO_COLOR, or a FORCE_COLOR
  // already in the environment, reaches the leaf through the inherited spread
  // either way, so re-declaring it here would override the person asking.
  if (level > 0 && !('FORCE_COLOR' in process.env) && !process.env.NO_COLOR) {
    env.FORCE_COLOR = String(level)
  }
  return env
}
