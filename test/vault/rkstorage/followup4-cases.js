// H/I/J/K process-restart cases. Native storage is real; faults are JS injections.
import {NativeModules} from 'react-native';
import {MMKV} from 'react-native-mmkv';
import RNFS from 'react-native-fs';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';
import getStoredState from 'redux-persist/lib/getStoredState';
import createPersistoid from 'redux-persist/lib/createPersistoid';
import {encryptSpecificFields} from '../../../src/store/transforms/transforms';
import {persistEncryptionTransform} from '../../../src/store/transforms/persist-encryption';
import {reduxStorage} from '../../../src/store';
import {backupPersistRoot} from '../../../src/store/backup/fs-backup';
import {
  VAULT_BACKUP,
  VAULT_OLDER_BACKUP,
  migrationTemp,
} from '../../../src/store/backup/vault-files';
import {
  VAULT_KEY_SERVICE,
  LEGACY_KEY_SERVICE,
} from '../../../src/store/encryption-key';
import {VAULT_RECORD_KEY} from '../../../src/store/vault-migration';
import {vaultDiagnostic} from '../../../src/store/vault-diagnostics';

export const runFollowup4 = async ({
  operation,
  fixture,
  storage,
  records,
  legacy,
  recode,
  prepareVault,
  RKSTORAGE_RECORD_KEY,
  assert,
  result,
}) => {
  const [, , kind, phase] = operation.split('-');
  const history = () => JSON.parse(records.getString(VAULT_RECORD_KEY));
  const decode = (raw, key) =>
    getStoredState({
      key: 'root',
      storage: {getItem: async () => raw},
      transforms: [encryptSpecificFields(key), persistEncryptionTransform(key)],
    });
  const save = async (state, key) => {
    const writer = createPersistoid({
      key: 'root',
      storage: reduxStorage,
      transforms: [encryptSpecificFields(key), persistEncryptionTransform(key)],
    });
    writer.update(state);
    await writer.flush();
    await backupPersistRoot(storage.getString('persist:root'));
  };
  const file = async path =>
    (await RNFS.exists(path)) ? RNFS.readFile(path, 'utf8') : null;
  const bridge = NativeModules.BitPayRKStorage;
  const inspect = bridge.inspect,
    clean = bridge.clean;
  let nativeCalls = 0;
  bridge.inspect = () => {
    nativeCalls++;
    return inspect();
  };
  bridge.clean = () => {
    nativeCalls++;
    return clean();
  };
  let key;
  if (phase === 'seed') {
    assert(!storage.contains('persist:root'), 'FOLLOWUP4_NOT_FRESH');
    await Keychain.setGenericPassword(LEGACY_KEY_SERVICE, legacy, {
      service: LEGACY_KEY_SERVICE,
    });
    await AsyncStorage.setItem(
      'followup4-library',
      'synthetic unrelated value',
    );
    if (kind === 'h' || kind.startsWith('k'))
      storage.set('persist:root', recode(fixture.cases.whole.raw));
  } else {
    const entry = await Keychain.getGenericPassword({
      service: VAULT_KEY_SERVICE,
    });
    assert(!!entry, 'FOLLOWUP4_KEY_MISSING');
    key = entry.password;
  }
  const before = storage.getString('persist:root');
  if (
    (kind.startsWith('k') && ['seed', 'check'].includes(phase)) ||
    (kind === 'i' && phase === 'seed')
  ) {
    const get = Keychain.getGenericPassword,
      remove = Keychain.resetGenericPassword;
    let deleted = false,
      reads = 0,
      deletes = 0;
    Keychain.getGenericPassword = async options => {
      if (options.service === LEGACY_KEY_SERVICE) {
        reads++;
        if (kind !== 'kabsent' || !deleted)
          throw Error('synthetic old key read rejection');
      }
      return get(options);
    };
    Keychain.resetGenericPassword = async options => {
      if (options.service === LEGACY_KEY_SERVICE) {
        deletes++;
        if (kind === 'kdelete')
          throw Error('synthetic old key delete rejection');
      }
      const value = await remove(options);
      deleted = true;
      return value;
    };
    try {
      key = await prepareVault(storage);
      if (phase === 'seed' || kind !== 'kabsent') {
        assert(reads > 0 && deletes === 1, 'FOLLOWUP4_KEY_FAULT_NOT_EXERCISED');
        assert(history().wipeDone, 'FOLLOWUP4_SCRUB_DID_NOT_FINISH');
        assert(
          (history().status === 'complete') === (kind === 'kabsent'),
          'FOLLOWUP4_FALSE_COMPLETION',
        );
      }
    } finally {
      Keychain.getGenericPassword = get;
      Keychain.resetGenericPassword = remove;
    }
    result.keyReadFailures = reads;
    result.keyRemovalAttempts = deletes;
  } else if (kind === 'h' && phase === 'seed') {
    const stat = RNFS.stat;
    RNFS.stat = async () => {
      throw Error('synthetic initial scrub deferral');
    };
    try {
      key = await prepareVault(storage);
    } finally {
      RNFS.stat = stat;
    }
  } else if (phase === 'seed') key = await prepareVault(storage);

  if (phase === 'seed' && (kind === 'i' || kind === 'j')) {
    assert(history().initializing, 'FOLLOWUP4_FRESH_PROVENANCE_MISSING');
    const set = MMKV.prototype.set;
    let rejected = 0;
    MMKV.prototype.set = function (name, value) {
      if (name === VAULT_RECORD_KEY && !JSON.parse(value).initializing) {
        rejected++;
        throw Error('synthetic retirement write failure');
      }
      return set.call(this, name, value);
    };
    try {
      await save(fixture.cases.plain.state, key);
    } finally {
      MMKV.prototype.set = set;
    }
    assert(
      rejected === 1 && history().initializing,
      'FOLLOWUP4_RETIREMENT_FAULT_NOT_EXERCISED',
    );
    assert(!!storage.getString('persist:root'), 'FOLLOWUP4_FIRST_SAVE_LOST');
    result.retirementRejections = rejected;
  } else if (phase === 'seed' && kind === 'h') {
    const state = await decode(storage.getString('persist:root'), key);
    state.WALLET.keys.newer = {...state.WALLET.keys.fixture, id: 'newer'};
    await save(state, key);
    await RNFS.writeFile(VAULT_BACKUP, 'synthetic damaged main', 'utf8');
    if (await RNFS.exists(VAULT_OLDER_BACKUP))
      await RNFS.unlink(VAULT_OLDER_BACKUP);
    const primary = storage.getString('persist:root');
    const unlink = RNFS.unlink;
    let hits = 0;
    RNFS.unlink = async path => {
      if (path === VAULT_BACKUP) {
        hits++;
        throw Error('synthetic target removal failure');
      }
      return unlink(path);
    };
    try {
      await prepareVault(storage);
    } finally {
      RNFS.unlink = unlink;
    }
    assert(
      hits > 0 && history().cleanup.main.writePhase === 'verified',
      'FOLLOWUP4_REPLACEMENT_NOT_VERIFIED',
    );
    assert(
      storage.getString('persist:root') === primary,
      'FOLLOWUP4_REFRESH_CHANGED_PRIMARY',
    );
    result.targetRemovalFailures = hits;
  } else if (phase === 'check' && kind === 'h') {
    storage.delete('persist:root');
    const main = await file(VAULT_BACKUP),
      bak = await file(VAULT_OLDER_BACKUP),
      temp = await file(migrationTemp(VAULT_BACKUP));
    const set = MMKV.prototype.set;
    let writes = 0;
    MMKV.prototype.set = function (name, value) {
      if (name === 'persist:root') writes++;
      return set.call(this, name, value);
    };
    try {
      await prepareVault(storage);
    } finally {
      MMKV.prototype.set = set;
    }
    const raw = await reduxStorage.getItem('persist:root');
    const state = await decode(raw, key);
    assert(
      writes === 1 && state.APP.bip02CleanupReceipt === undefined,
      'FOLLOWUP4_RECOVERY_WRITE_INVALID',
    );
    assert(
      Object.keys(state.WALLET.keys).length === 2,
      'FOLLOWUP4_NEWER_KEY_LOST',
    );
    assert(
      main === (await file(VAULT_BACKUP)) &&
        bak === (await file(VAULT_OLDER_BACKUP)) &&
        temp === (await file(migrationTemp(VAULT_BACKUP))),
      'FOLLOWUP4_RECOVERY_CHANGED_FILES',
    );
    result.rootWrites = writes;
    result.tempRecovery = true;
  } else if (phase === 'check' && (kind === 'i' || kind === 'j')) {
    const get = MMKV.prototype.getString,
      asRead = AsyncStorage.getItem;
    let hits = 0;
    if (kind === 'j')
      MMKV.prototype.getString = function (name) {
        if (name === RKSTORAGE_RECORD_KEY) {
          hits++;
          throw Error('synthetic marker read failure');
        }
        return get.call(this, name);
      };
    else
      AsyncStorage.getItem = async name => {
        if (name === 'persist:root') {
          hits++;
          throw Error('synthetic independent read failure');
        }
        return asRead(name);
      };
    try {
      await prepareVault(storage);
    } finally {
      MMKV.prototype.getString = get;
      AsyncStorage.getItem = asRead;
    }
    assert(
      hits > 0 &&
        !history().initializing &&
        (history().conversionComplete || history().status === 'complete'),
      'FOLLOWUP4_FIRST_SAVE_HISTORY_MISSING',
    );
    assert(
      storage.getString('persist:root') === before,
      'FOLLOWUP4_INITIALIZATION_CHANGED_PRIMARY',
    );
    result.injectedFailures = hits;
    result.firstSaveEstablished = true;
  } else if (phase === 'loss') {
    storage.delete('persist:root');
    for (const path of [VAULT_BACKUP, VAULT_OLDER_BACKUP])
      if (await RNFS.exists(path)) await RNFS.unlink(path);
    let code;
    try {
      await prepareVault(storage);
      await reduxStorage.getItem('persist:root');
    } catch (error) {
      code = vaultDiagnostic(error)?.code;
    }
    assert(
      code === 'PRESERVATION_FAILURE',
      'FOLLOWUP4_TOTAL_LOSS_OPENED_EMPTY',
    );
    result.totalLossStopped = true;
  } else if (phase !== 'seed' && !(kind.startsWith('k') && phase === 'check')) {
    await prepareVault(storage);
    assert(
      storage.getString('persist:root') === before,
      'FOLLOWUP4_RETRY_CHANGED_PRIMARY',
    );
  }
  if (phase !== 'loss') {
    const raw = await reduxStorage.getItem('persist:root');
    assert(
      !!raw &&
        Object.keys((await decode(raw, key)).WALLET.keys).length ===
          (kind === 'h' ? 2 : 1),
      'FOLLOWUP4_WALLET_NOT_USABLE',
    );
    if (phase === 'verify') {
      assert(
        history().status === 'complete' &&
          records.getString(RKSTORAGE_RECORD_KEY) === 'complete-v1',
        'FOLLOWUP4_CLEANUP_INCOMPLETE',
      );
      assert(
        !(await file(migrationTemp(VAULT_BACKUP))) &&
          !(await file(migrationTemp(VAULT_OLDER_BACKUP))),
        'FOLLOWUP4_TEMP_REMAINS',
      );
    }
  }
  assert(
    (await AsyncStorage.getItem('followup4-library')) ===
      'synthetic unrelated value',
    'FOLLOWUP4_UNRELATED_CHANGED',
  );
  result.nativeCalls = nativeCalls;
  result.cleanupPending =
    records.getString(RKSTORAGE_RECORD_KEY) !== 'complete-v1';
};
