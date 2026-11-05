export declare const CODEX_ACCOUNT_NAME: RegExp

export declare function codexAccountsRoot(options?: { home?: string }): string
export declare function codexHomeFor(name: string, options?: { root?: string }): string
export declare function codexAuthPath(home: string): string
export declare function listCodexAccountNames(options?: { root?: string }): Promise<string[]>

export type CodexAccount = { number: number; name: string; home: string }

export declare function codexAccounts(options?: { root?: string }): Promise<CodexAccount[]>
export declare function currentCodexAccountName(options?: { root?: string }): Promise<string | null>
export declare function setCurrentCodexAccount(
  name: string,
  options?: { root?: string },
): Promise<void>
export declare function nextCodexAccountName(options?: {
  root?: string
  prefix?: string
}): Promise<string>
export declare function readCodexAuth(
  home: string,
): Promise<{ accessToken: string; accountId: string } | null>
