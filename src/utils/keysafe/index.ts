/**
 * Typed facade over the bundled keysafe core.
 *
 * The implementation lives in scripts/keysafe-vault.mjs on purpose: the plain
 * node supervisor and launcher must import the same vault without a bun/TS
 * build step. Keep this file exports-only so there is exactly one
 * implementation.
 */
export {
  captureSecret,
  clearMasterKeyCache,
  credentialModeMatrix,
  defaultVaultDir,
  envVarForRecord,
  gatewayCredentialsMode,
  hasSecret,
  isValidRecordName,
  keysafeMode,
  listSecrets,
  oauthMode,
  readSecret,
  removeSecret,
  resolveMasterKey,
  secretsEnv,
} from '../../../scripts/keysafe-vault.mjs'

export type {
  CredentialMode,
  KeysafeEntry,
  KeysafeOptions,
  MasterKeyBackend,
  RecordFile,
  RunFn,
  RunResult,
} from '../../../scripts/keysafe-vault.mjs'
