// INTERNAL ONLY - DO NOT MERGE. Remove this entire commit from user builds.
import {MMKV} from 'react-native-mmkv';
import RNFS from 'react-native-fs';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {parseTransferRecord, TransferRecord} from './vault-transfer';
import {LEGACY_RETIREMENT_ENABLED} from './vault-retirement-policy';

export const INTERNAL_VAULT_REPLAY = true;
export const INTERNAL_REPLAY_STORE = 'bitpay.internal.vault-replay';
const STATE = 'state';
type ReplayState = 'armed' | 'wiping';
type StringStore = Pick<MMKV, 'getString' | 'contains' | 'set' | 'delete'>;
type KeyStore = Pick<MMKV, 'getAllKeys' | 'delete'>;
export type ReplayAccess = {
  control: StringStore & KeyStore;
  wallet: KeyStore;
  legacyPair(): {data: string; crc: string};
  legacyFiles(): {main: string; bak: string};
  modernFiles(): {main: string; bak: string; temp: string};
};

const readString = (store: StringStore, key: string): string | null => {
  const value = store.getString(key);
  if (value === undefined && store.contains(key) === false) return null;
  if (typeof value !== 'string') throw new Error('Stored string is unreadable');
  return value;
};

export const createReplayState = (getStore: () => StringStore) => {
  const read = (): ReplayState | null => {
    const value = readString(getStore(), STATE);
    if (value === null || value === 'armed' || value === 'wiping') return value;
    throw new Error('Internal replay state is invalid');
  };
  return {
    read,
    write(value: ReplayState) {
      getStore().set(STATE, value);
      if (read() !== value)
        throw new Error('Replay state write was not verified');
    },
    clear() {
      getStore().delete(STATE);
      if (read() !== null)
        throw new Error('Replay cancellation was not verified');
    },
  };
};

let marker: MMKV | undefined;
const replayState = createReplayState(
  () => (marker ??= new MMKV({id: INTERNAL_REPLAY_STORE})),
);
export type ReplayEligibility =
  | {kind: 'passes'; record: TransferRecord}
  | {kind: 'fails' | 'unknown'; condition: string};
type Overrides = {
  state?: ReturnType<typeof createReplayState>;
  files?: Pick<typeof RNFS, 'exists' | 'unlink'>;
  asyncKeys?: () => Promise<readonly string[]>;
  retirementEnabled?: () => boolean;
};

const keys = (store: KeyStore) => {
  const result = store.getAllKeys();
  if (!Array.isArray(result) || result.some(key => typeof key !== 'string'))
    throw new Error('MMKV key set is unreadable');
  return result;
};

export const createInternalVaultReplay = (
  getAccess: () => ReplayAccess,
  {
    state = replayState,
    files = RNFS,
    asyncKeys = () => AsyncStorage.getAllKeys(),
    retirementEnabled = () => LEGACY_RETIREMENT_ENABLED,
  }: Overrides = {},
) => {
  const exists = async (path: string) => {
    const present = await files.exists(path);
    if (present !== true && present !== false)
      throw new Error('File presence is unreadable');
    return present;
  };
  const eligibility = async (
    access?: ReplayAccess,
    observedRecord?: string,
  ): Promise<ReplayEligibility> => {
    let condition = 'Legacy retirement must be disabled';
    try {
      const retirement = retirementEnabled();
      if (typeof retirement !== 'boolean')
        throw new Error('Retirement policy is unreadable');
      if (retirement) return {kind: 'fails', condition};
      condition = 'Transfer record must be readable';
      const stores = access ?? getAccess();
      const raw = observedRecord ?? readString(stores.control, 'transfer');
      if (raw === null)
        return {kind: 'fails', condition: 'Transfer record is missing'};
      condition = 'Transfer record must parse as version 3';
      const record = parseTransferRecord(raw);
      if (record.phase !== 'active')
        return {kind: 'fails', condition: 'Transfer record must be active'};
      const source = record.copies.root;
      if (source === null)
        return {
          kind: 'fails',
          condition: 'Fresh installs have no legacy root source',
        };
      condition = `Retained legacy ${source} location must exist`;
      let present: boolean;
      if (source === 'mmkv') {
        const pair = stores.legacyPair();
        present = (await exists(pair.data)) && (await exists(pair.crc));
      } else if (source === 'async') {
        const names = await asyncKeys();
        if (
          !Array.isArray(names) ||
          names.some(name => typeof name !== 'string')
        )
          throw new Error('AsyncStorage key set is unreadable');
        present = names.includes('persist:root');
      } else {
        present = await exists(stores.legacyFiles()[source]);
      }
      return present ? {kind: 'passes', record} : {kind: 'fails', condition};
    } catch {
      return {kind: 'unknown', condition};
    }
  };
  const clearKeys = (store: KeyStore, last?: string) => {
    const names = keys(store);
    for (const key of names.filter(k => k !== last)) store.delete(key);
    if (last !== undefined) {
      // Keep the authorization record until other control keys are verified gone.
      if (keys(store).some(key => key !== last))
        throw new Error('Modern MMKV wipe was not verified');
      if (names.includes(last)) store.delete(last);
    }
    if (keys(store).length)
      throw new Error('Modern MMKV wipe was not verified');
  };
  const finishWipe = () => {
    try {
      state.clear();
    } catch (error) {
      // A clear may have succeeded before its read-back failed. Retain the fence
      // if possible, but never enter migration on an unverified clear.
      try {
        state.write('wiping');
      } catch {}
      throw error;
    }
  };
  const startup = async () => {
    const request = state.read();
    if (request === null) return; // No access to any other store or source paths.
    let access: ReplayAccess;
    if (request === 'wiping') {
      access = getAccess();
      const raw = readString(access.control, 'transfer');
      if (raw === null) {
        if (keys(access.wallet).length || keys(access.control).length)
          throw new Error('Replay record is absent but modern keys remain');
        for (const path of Object.values(access.modernFiles()))
          if (await exists(path))
            throw new Error('Replay record is absent but modern files remain');
        finishWipe();
        return;
      }
      const result = await eligibility(access, raw);
      if (result.kind !== 'passes') throw new Error(result.condition);
    } else {
      const result = await eligibility();
      if (result.kind === 'fails') {
        state.clear();
        return;
      }
      if (result.kind === 'unknown') throw new Error(result.condition);
      access = getAccess();
      state.write('wiping');
    }
    const paths = access.modernFiles();
    for (const path of [paths.main, paths.bak, paths.temp])
      if (await exists(path)) await files.unlink(path);
    for (const path of [paths.main, paths.bak, paths.temp])
      if (await exists(path))
        throw new Error('Modern backup wipe was not verified');
    clearKeys(access.wallet);
    clearKeys(access.control, 'transfer');
    finishWipe();
  };
  return {state, eligibility, startup};
};
