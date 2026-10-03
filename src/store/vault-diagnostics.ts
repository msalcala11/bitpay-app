import * as Sentry from '@sentry/react-native';

export type VaultCode =
  | 'MODERN_KEY_FAILURE'
  | 'NEW_KEY_VERIFICATION'
  | 'INVALID_LEGACY_INPUT'
  | 'UNSUPPORTED_FORMAT'
  | 'SOURCE_CONFLICT'
  | 'REQUIRED_COPY_FAILURE'
  | 'OPTIONAL_REFRESH_DEFERRED'
  | 'LEGACY_KEY_UNREADABLE'
  | 'CLEANUP_DEFERRED'
  | 'UNKNOWN_STORAGE_KEY'
  | 'SCRUB_MEASUREMENT_DEFERRED'
  | 'SCRUB_COVERAGE_DEFERRED'
  | 'SCRUB_WRITE_REJECTED'
  | 'SCRUB_STATE_CHANGED'
  | 'PRESERVATION_FAILURE'
  | 'RKSTORAGE_DEFERRED'
  | 'RKSTORAGE_BUSY'
  | 'RKSTORAGE_UNSUPPORTED'
  | 'RKSTORAGE_CORRUPT'
  | 'RKSTORAGE_SIDECARS'
  | 'RKSTORAGE_ACTIVE_PENDING'
  | 'RKSTORAGE_STATE_CHANGED'
  | 'STARTUP_FAILURE';
export type VaultPhase =
  | 'key'
  | 'inventory'
  | 'classify'
  | 'required-copy'
  | 'root-write'
  | 'refresh'
  | 'scrub'
  | 'cleanup'
  | 'persist'
  | 'startup'
  | 'rkstorage';

// Only errors created here carry a classification. Never inspect arbitrary
// native/parser messages, getters, nested causes, or reporting objects.
const diagnostics = new WeakMap<Error, {code: VaultCode; phase: VaultPhase}>();
export const vaultError = (code: VaultCode, phase: VaultPhase): Error => {
  const error = new Error(`Vault migration failed: ${code} (${phase})`);
  diagnostics.set(error, Object.freeze({code, phase}));
  return error;
};
export const safeVaultError = (
  error: unknown,
  code: VaultCode = 'STARTUP_FAILURE',
  phase: VaultPhase = 'startup',
): Error => {
  // WeakMap identity lookup does not invoke getters or Proxy prototype traps.
  const known = diagnostics.get(error as Error);
  return vaultError(known?.code ?? code, known?.phase ?? phase);
};
export const vaultDiagnostic = (error: Error) => diagnostics.get(error);
export const vaultDeferredMessage = (code: VaultCode, phase: VaultPhase) =>
  `Vault migration deferred: ${code} (${phase})`;

// Called once by the existing getStore rejection handler. No raw error or cause
// reaches Sentry; Retry UI and the in-memory initialization log remain unchanged.
export const reportVaultStartupFailure = (error: unknown): void => {
  const safe = safeVaultError(error);
  const diagnostic = diagnostics.get(safe)!;
  Sentry.captureException(safe, {
    level: 'error',
    tags: {vaultCode: diagnostic.code, vaultPhase: diagnostic.phase},
  });
};
