export declare const ACCOUNT_NAME: RegExp

export type AccountRecord = {
  number: number
  name: string
  email?: string
  displayName?: string
}

export declare function accountRoot(
  envName: string,
  defaultDir: string,
  options?: { home?: string },
): string
export declare function listAccountNames(root: string, marker: string): Promise<string[]>
export declare function readRegistry(root: string): Promise<AccountRecord[]>
export declare function writeRegistry(root: string, accounts: AccountRecord[]): Promise<void>
export declare function accountRecords(
  root: string,
  names: string[],
): Promise<Map<string, AccountRecord>>
export declare function setAccountIdentity(
  root: string,
  name: string,
  identity: { email?: string | null; displayName?: string | null } | null,
): Promise<boolean>
export declare function readCurrent(root: string): Promise<string | null>
export declare function writeCurrent(root: string, name: string): Promise<void>
export declare function nextAccountName(
  root: string,
  options?: { marker?: string; prefix?: string },
): Promise<string>
export declare function nameFromEmail(
  email: string,
  options: { root: string; marker: string },
): Promise<string>
