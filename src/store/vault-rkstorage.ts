import {NativeModules, Platform} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {MMKV} from 'react-native-mmkv';
import {
  captureVaultCleanupState,
  finishVaultInitialization,
  hasCompletedVaultMigration,
  hasPendingVaultInitialization,
  migrateVault,
  VAULT_RECORD_ID,
} from './vault-migration';
import {
  safeVaultError,
  VaultCode,
  vaultReporter,
  VaultReporter,
  vaultError,
} from './vault-diagnostics';

export const RKSTORAGE_RECORD_KEY = 'rkstorage-cleanup-v1';
const COMPLETE = 'complete-v1';
type NativeResult =
  | 'CLEANED'
  | 'ABSENT'
  | 'PRESENT'
  | 'LIVE_SOURCE'
  | 'BUSY'
  | 'IO_DEFERRED'
  | 'UNSUPPORTED'
  | 'CORRUPT'
  | 'SIDECARS'
  | 'PRESERVATION_FAILURE'
  | 'LIFECYCLE_FAILURE';
type Bridge = {
  inspect(): Promise<NativeResult>;
  clean(): Promise<NativeResult>;
};
let inFlight: Promise<string> | undefined;

const prepare = async (
  storage: MMKV,
  log: (message: string) => void,
  reporter: VaultReporter,
) => {
  // iOS keeps its original startup path, without touching a cleanup marker/module.
  if (Platform.OS !== 'android') return migrateVault(storage, log, reporter);
  const key = await migrateVault(storage, log, reporter);
  if (!hasCompletedVaultMigration()) return key;
  const records = new MMKV({id: VAULT_RECORD_ID});
  let marker: string | undefined;
  let markerUnavailable = false;
  try {
    marker = records.getString(RKSTORAGE_RECORD_KEY);
    markerUnavailable =
      marker !== COMPLETE &&
      (marker !== undefined || records.contains(RKSTORAGE_RECORD_KEY));
  } catch {
    markerUnavailable = true;
  }
  if (marker === COMPLETE) return key;
  if (markerUnavailable) {
    // This marker records cleanup, not conversion. Its failure cannot mask
    // loss of the independently required wallet/recovery source.
    const active = await captureVaultCleanupState(storage, key);
    if (!active.present && !hasPendingVaultInitialization())
      throw vaultError('PRESERVATION_FAILURE', 'rkstorage');
    reporter.defer('RKSTORAGE_DEFERRED', 'rkstorage');
    return key;
  }
  const state = await captureVaultCleanupState(storage, key);
  const initializing = hasPendingVaultInitialization();
  // Retire before any native await, including a failed/deferred inventory. Old
  // records without provenance are never retroactively labeled fresh.
  if (state.present && initializing) finishVaultInitialization();
  const defer = (code: VaultCode) => reporter.defer(code, 'rkstorage');
  const guard = async () => {
    const current = await state.verifyCurrent();
    if (!current) defer('RKSTORAGE_STATE_CHANGED');
    return current;
  };
  const native = NativeModules.BitPayRKStorage as Bridge | undefined;
  if (
    !native ||
    typeof native.inspect !== 'function' ||
    typeof native.clean !== 'function'
  ) {
    await guard();
    if (!initializing && !state.present)
      throw vaultError('PRESERVATION_FAILURE', 'rkstorage');
    defer('RKSTORAGE_DEFERRED');
    return key;
  }
  const call = async (operation: () => Promise<NativeResult>) => {
    let result: NativeResult;
    try {
      result = await operation();
    } catch {
      result = 'IO_DEFERRED';
    }
    // No failed native/metadata result may short-circuit active-state validation.
    const current = await guard();
    if (
      ['PRESERVATION_FAILURE', 'LIFECYCLE_FAILURE', 'LIVE_SOURCE'].includes(
        result,
      )
    ) {
      if (!state.present && !initializing)
        throw vaultError('PRESERVATION_FAILURE', 'rkstorage');
      defer('RKSTORAGE_DEFERRED');
      return;
    }
    if (
      ![
        'CLEANED',
        'ABSENT',
        'PRESENT',
        'BUSY',
        'IO_DEFERRED',
        'UNSUPPORTED',
        'CORRUPT',
        'SIDECARS',
      ].includes(result)
    ) {
      if (!state.present && !initializing)
        throw vaultError('PRESERVATION_FAILURE', 'rkstorage');
      defer('RKSTORAGE_DEFERRED');
      return;
    }
    if (!current) return;
    const codes: Partial<Record<NativeResult, VaultCode>> = {
      BUSY: 'RKSTORAGE_BUSY',
      IO_DEFERRED: 'RKSTORAGE_DEFERRED',
      UNSUPPORTED: 'RKSTORAGE_UNSUPPORTED',
      CORRUPT: 'RKSTORAGE_CORRUPT',
      SIDECARS: 'RKSTORAGE_SIDECARS',
    };
    const code = codes[result];
    if (code) {
      defer(code);
      return;
    }
    if (!['CLEANED', 'ABSENT', 'PRESENT'].includes(result))
      throw vaultError('PRESERVATION_FAILURE', 'rkstorage');
    return result;
  };
  let result = await call(() => native.inspect());
  if (!result) {
    if (!initializing && !state.present)
      throw vaultError('PRESERVATION_FAILURE', 'rkstorage');
    return key;
  }
  if (result === 'CLEANED')
    throw vaultError('PRESERVATION_FAILURE', 'rkstorage');
  if (result === 'PRESENT') {
    if (!state.present) {
      if (!initializing) throw vaultError('PRESERVATION_FAILURE', 'rkstorage');
      defer('RKSTORAGE_ACTIVE_PENDING');
      return key;
    }
    // Base cleanup may have spent the three permitted AsyncStorage reads.
    // Leave native maintenance for the next launch rather than dropping its
    // required post-clean live-row check or adding an unbounded extra read.
    if (!reporter.canReadAsync) {
      defer('RKSTORAGE_DEFERRED');
      return key;
    }
    result = await call(() => native.clean());
    if (!result) return key;
    if (result !== 'CLEANED') {
      defer('RKSTORAGE_DEFERRED');
      return key;
    }
    // Catch a queued provider write after ownership was released, before the marker.
    let live: string | null;
    try {
      live = await reporter.readAsync(() =>
        AsyncStorage.getItem('persist:root'),
      );
    } catch {
      await guard();
      defer('RKSTORAGE_DEFERRED');
      return key;
    }
    const current = await guard();
    if (live !== null) {
      defer('RKSTORAGE_ACTIVE_PENDING');
      return key;
    }
    if (!current) return key;
  }
  try {
    records.set(RKSTORAGE_RECORD_KEY, COMPLETE);
    if (records.getString(RKSTORAGE_RECORD_KEY) !== COMPLETE) throw new Error();
  } catch {
    await guard();
    defer('RKSTORAGE_DEFERRED');
  }
  return key;
};

export const prepareVault = (
  storage: MMKV,
  log: (message: string) => void = () => {},
): Promise<string> => {
  if (!inFlight) {
    const reporter = vaultReporter(storage, log);
    inFlight = prepare(storage, log, reporter)
      .catch(error => {
        throw safeVaultError(error, 'PRESERVATION_FAILURE', 'rkstorage');
      })
      .finally(() => {
        reporter.finish();
        inFlight = undefined;
      });
  }
  return inFlight;
};
