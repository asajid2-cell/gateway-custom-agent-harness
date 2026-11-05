export declare const BUNDLED_CODEX_VERSION: string

export declare function codexResourceDir(options?: {
  root?: string
  platform?: string
  arch?: string
  version?: string
}): string
export declare function bundledCodexPath(options?: {
  root?: string
  platform?: string
  arch?: string
  version?: string
}): string
export declare function resolveBundledCodex(options?: {
  root?: string
  platform?: string
  arch?: string
  version?: string
}): string | null
