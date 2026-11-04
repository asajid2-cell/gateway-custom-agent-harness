/**
 * Where a packaged artifact keeps the codex binary.
 *
 * The release ruling is that tool binaries are versioned resources beside the
 * executable, never PATH: `resources/codex/<version>/<platform>-<arch>/`.
 * A release is a directory, not one file: it carries a codex-package.json that
 * names the entrypoint plus the exec-server, resources and path directories the
 * binary expects beside it, so the whole tree is staged and the entrypoint is
 * read from that manifest.
 *
 * A development checkout has no such directory and falls back to the installed
 * lookup.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const BUNDLED_CODEX_VERSION = '0.166.0'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

export function codexResourceDir({
  root = ROOT,
  platform = process.platform,
  arch = process.arch,
  version = BUNDLED_CODEX_VERSION,
} = {}) {
  return path.join(root, 'resources', 'codex', version, `${platform}-${arch}`)
}

/** The entrypoint named by the staged package, else the conventional name. */
export function bundledCodexPath(options = {}) {
  const dir = codexResourceDir(options)
  try {
    const manifest = JSON.parse(readFileSync(path.join(dir, 'codex-package.json'), 'utf8'))
    if (typeof manifest?.entrypoint === 'string' && !manifest.entrypoint.includes('..')) {
      return path.join(dir, manifest.entrypoint)
    }
  } catch {}
  return path.join(dir, (options.platform ?? process.platform) === 'win32' ? 'codex.exe' : 'codex')
}

/**
 * The bundled binary, or null. `MODEL_GATEWAY_CODEX_BIN` is the explicit
 * override the tests and the lanes use to point at a staged tree.
 */
export function resolveBundledCodex(options = {}) {
  const explicit = process.env.MODEL_GATEWAY_CODEX_BIN
  if (explicit) return existsSync(explicit) ? explicit : null
  const candidate = bundledCodexPath(options)
  return existsSync(candidate) ? candidate : null
}
