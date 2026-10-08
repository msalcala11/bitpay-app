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
  | 'rkstorage'
  | 'conversion'
  | 'recovery';

export type VaultReason =
  | 'KEY_UNAVAILABLE'
  | 'KEY_INVALID'
  | 'KEY_STORAGE'
  | 'KEY_RETIREMENT'
  | 'RECORD_INVALID'
  | 'RECORD_READ'
  | 'RECORD_WRITE'
  | 'PRIMARY_READ'
  | 'PRIMARY_INVALID'
  | 'PRIMARY_CHANGED'
  | 'RECOVERY_UNAVAILABLE'
  | 'SOURCE_REMOVE'
  | 'SOURCE_READ'
  | 'SOURCE_CHANGED'
  | 'SOURCE_UNRESOLVED'
  | 'SOURCE_INVALID'
  | 'PLAN_INVALID'
  | 'COPY_WRITE'
  | 'COPY_VERIFICATION'
  | 'CONVERSION_WRITE'
  | 'PERMISSION_WRITE'
  | 'CLEANUP_PENDING'
  | 'NATIVE_RESULT'
  | 'REHYDRATION';
export type VaultSource =
  | 'key'
  | 'record'
  | 'mmkv'
  | 'async'
  | 'main'
  | 'bak'
  | 'main-temp'
  | 'bak-temp'
  | 'rkstorage';
type Diagnostic = {
  code: VaultCode;
  phase: VaultPhase;
  reason?: VaultReason;
  source?: VaultSource;
};
// Identity lookup never touches native messages, getters, causes or prototypes.
const diagnostics = new WeakMap<Error, Readonly<Diagnostic>>();
export const vaultError = (
  code: VaultCode,
  phase: VaultPhase,
  reason?: VaultReason,
  source?: VaultSource,
): Error => {
  const error = new Error(`Vault migration failed: ${code} (${phase})`);
  error.stack = undefined;
  diagnostics.set(
    error,
    Object.freeze({
      code,
      phase,
      ...(reason ? {reason} : {}),
      ...(source ? {source} : {}),
    }),
  );
  return error;
};
export const safeVaultError = (
  error: unknown,
  code: VaultCode = 'STARTUP_FAILURE',
  phase: VaultPhase = 'startup',
  reason?: VaultReason,
  source?: VaultSource,
): Error =>
  diagnostics.has(error as Error)
    ? (error as Error)
    : vaultError(code, phase, reason, source);
export const vaultDiagnostic = (error: Error) => diagnostics.get(error);
export const vaultDeferredMessage = (code: VaultCode, phase: VaultPhase) =>
  `Vault migration deferred: ${code} (${phase})`;

const previousDeferrals = new WeakMap<object, string>();
export const vaultReporter = (
  owner: object,
  log: (message: string) => void,
) => {
  const pending = new Set<string>();
  let asyncReads = 0;
  return {
    get canReadAsync() {
      return asyncReads < 3;
    },
    readAsync: <T>(operation: () => Promise<T>): Promise<T> => {
      if (asyncReads >= 3)
        throw vaultError(
          'CLEANUP_DEFERRED',
          'cleanup',
          'CLEANUP_PENDING',
          'async',
        );
      asyncReads++;
      return operation();
    },
    defer: (
      code: VaultCode,
      phase: VaultPhase,
      reason?: VaultReason,
      source?: VaultSource,
    ) => {
      pending.add(
        `${code} (${[phase, reason, source].filter(Boolean).join(':')})`,
      );
    },
    finish: () => {
      const signature = [...pending].sort().join('; ');
      const changed = previousDeferrals.get(owner) !== signature;
      previousDeferrals.set(owner, signature);
      if (signature && changed) {
        try {
          log(`Vault migration deferred: ${signature}`);
        } catch {}
      }
    },
  };
};
export type VaultReporter = ReturnType<typeof vaultReporter>;

export const reportVaultStartupFailure = (error: unknown): void => {
  const known = diagnostics.get(error as Error);
  // Construct a fresh reporting object even for classified errors. A caller
  // may have attached a cause/stack or replaced a property after creation.
  const safe = vaultError(
    known?.code ?? 'STARTUP_FAILURE',
    known?.phase ?? 'startup',
    known?.reason,
    known?.source,
  );
  const diagnostic = diagnostics.get(safe)!;
  try {
    Sentry.captureException(safe, {
      level: 'error',
      tags: {
        vaultCode: diagnostic.code,
        vaultPhase: diagnostic.phase,
        ...(diagnostic.reason ? {vaultReason: diagnostic.reason} : {}),
        ...(diagnostic.source ? {vaultSource: diagnostic.source} : {}),
      },
    });
  } catch {}
};
