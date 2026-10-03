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
  vaultDeferredMessage,
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

const prepare = async (storage: MMKV, log: (message: string) => void) => {
  // iOS keeps its original startup path, without touching a cleanup marker/module.
  if (Platform.OS !== 'android') return migrateVault(storage, log);
  const key = await migrateVault(storage, log);
  if (!hasCompletedVaultMigration()) return key;
  const records = new MMKV({id: VAULT_RECORD_ID});
  const marker = records.getString(RKSTORAGE_RECORD_KEY);
  if (marker === COMPLETE) return key;
  if (marker !== undefined || records.contains(RKSTORAGE_RECORD_KEY))
    throw vaultError('PRESERVATION_FAILURE', 'rkstorage');
  const state = await captureVaultCleanupState(storage, key);
  const initializing = hasPendingVaultInitialization();
  // Retire before any native await, including a failed/deferred inventory. Old
  // records without provenance are never retroactively labeled fresh.
  if (state.present && initializing) finishVaultInitialization();
  const defer = (code: VaultCode) =>
    log(vaultDeferredMessage(code, 'rkstorage'));
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
    if (result === 'PRESERVATION_FAILURE' || result === 'LIFECYCLE_FAILURE')
      throw vaultError('PRESERVATION_FAILURE', 'rkstorage');
    if (result === 'LIVE_SOURCE')
      throw vaultError('SOURCE_CONFLICT', 'rkstorage');
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
    )
      throw vaultError('PRESERVATION_FAILURE', 'rkstorage');
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
    result = await call(() => native.clean());
    if (!result) return key;
    if (result !== 'CLEANED')
      throw vaultError('PRESERVATION_FAILURE', 'rkstorage');
    // Catch a queued provider write after ownership was released, before the marker.
    const live = await AsyncStorage.getItem('persist:root');
    const current = await guard();
    if (live !== null) throw vaultError('SOURCE_CONFLICT', 'rkstorage');
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
    inFlight = prepare(storage, log)
      .catch(error => {
        throw safeVaultError(error, 'PRESERVATION_FAILURE', 'rkstorage');
      })
      .finally(() => {
        inFlight = undefined;
      });
  }
  return inFlight;
};
