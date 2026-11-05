export declare const ANTHROPIC_ACCOUNT_NAME: RegExp

export type AnthropicAccount = {
  number: number
  name: string
  home: string
  email?: string
  displayName?: string
}

export declare function anthropicAccountsRoot(options?: { home?: string }): string
export declare function anthropicHomeFor(name: string, options?: { root?: string }): string
export declare function anthropicCredentialPath(home: string): string
export declare function listAnthropicAccountNames(options?: { root?: string }): Promise<string[]>
export declare function anthropicAccounts(options?: { root?: string }): Promise<AnthropicAccount[]>
export declare function readAnthropicAccount(home: string): Promise<Record<string, unknown> | null>
export declare function writeAnthropicAccount(
  home: string,
  stored: Record<string, unknown>,
): Promise<void>
export declare function registerAnthropicAccount(options: {
  name: string
  stored: Record<string, unknown>
  identity?: { email?: string | null; displayName?: string | null } | null
  root?: string
}): Promise<AnthropicAccount>
export declare function removeAnthropicAccount(name: string, options?: { root?: string }): Promise<void>
export declare function findAnthropicAccount<T extends { number: number; name: string; email?: string }>(
  accounts: T[],
  target: string,
): T | undefined
export declare function currentAnthropicAccountName(options?: { root?: string }): Promise<string | null>
export declare function setCurrentAnthropicAccount(
  name: string,
  options?: { root?: string },
): Promise<void>
export declare function nextAnthropicAccountName(options?: {
  root?: string
  prefix?: string
}): Promise<string>
