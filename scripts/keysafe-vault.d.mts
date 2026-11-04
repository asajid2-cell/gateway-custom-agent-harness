export type MasterKeyBackend = 'dpapi' | 'keychain' | 'libsecret' | 'file'
export type CredentialMode = 'bundled' | 'external'

export type RunResult = { code: number; stdout: string; stderr: string }
export type RunFn = (file: string, args: string[], stdin: string) => Promise<RunResult>

export type KeysafeOptions = {
  vaultDir?: string
  backend?: MasterKeyBackend
  platform?: NodeJS.Platform
  run?: RunFn
}

export type KeysafeEntry = { name: string; envVar: string; updatedAt: string }

export type RecordFile = {
  version: 1
  name: string
  envVar: string
  cipher: 'aes-256-gcm'
  nonce: string
  tag: string
  data: string
  createdAt: string
  updatedAt: string
}

export function envVarForRecord(name: string): string | null
export function isValidRecordName(name: string): boolean
export function defaultVaultDir(env?: NodeJS.ProcessEnv): string
export function clearMasterKeyCache(): void

export function gatewayCredentialsMode(env?: NodeJS.ProcessEnv): CredentialMode
export function keysafeMode(env?: NodeJS.ProcessEnv): CredentialMode
export function oauthMode(env?: NodeJS.ProcessEnv): CredentialMode
export function credentialModeMatrix(env?: NodeJS.ProcessEnv): {
  mode: CredentialMode
  keysafe: CredentialMode
  oauth: CredentialMode
  vaultDir: string
}

export const defaultRun: RunFn
export function resolveMasterKey(options?: KeysafeOptions): Promise<{
  key: Buffer
  backend: MasterKeyBackend
  warning?: string
}>

export function captureSecret(name: string, secret: string, options?: KeysafeOptions): Promise<void>
export function readSecret(name: string, options?: KeysafeOptions): Promise<string | null>
export function hasSecret(name: string, options?: KeysafeOptions): Promise<boolean>
export function removeSecret(name: string, options?: KeysafeOptions): Promise<boolean>
export function listSecrets(options?: KeysafeOptions): Promise<KeysafeEntry[]>
export function secretsEnv(options?: KeysafeOptions): Promise<Record<string, string>>
export function peekVault(vaultDir?: string): Promise<{
  vaultDir: string
  created: boolean
  backend: MasterKeyBackend | null
  records: boolean
}>
