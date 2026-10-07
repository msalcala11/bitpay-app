// E/F/G device cases. Faults are at the JS boundary; all storage is native.
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

export const runFollowup2 = async ({
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
  const transforms = key => [
    encryptSpecificFields(key),
    persistEncryptionTransform(key),
  ];
  const decode = (raw, key) =>
    getStoredState({
      key: 'root',
      storage: {getItem: async () => raw},
      transforms: transforms(key),
    });
  const writeState = async (state, key, rotate) => {
    const writer = createPersistoid({
      key: 'root',
      storage: reduxStorage,
      transforms: transforms(key),
    });
    writer.update(state);
    await writer.flush();
    const raw = storage.getString('persist:root');
    if (rotate) await backupPersistRoot(raw);
  };
  const add = (state, id) => {
    state.WALLET.keys[id] = {
      ...fixture.cases.plain.state.WALLET.keys.fixture,
      id,
    };
  };
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
  if (kind === 'sql' && (phase === 'seed' || phase === 'check'))
    bridge.inspect = async () => {
      nativeCalls++;
      return 'BUSY';
    };
  if (phase === 'seed') {
    assert(!storage.contains('persist:root'), 'FOLLOWUP2_NOT_FRESH');
    await Keychain.setGenericPassword(LEGACY_KEY_SERVICE, legacy, {
      service: LEGACY_KEY_SERVICE,
    });
    await AsyncStorage.setItem(
      'followup2-library',
      'synthetic unrelated value',
    );
    storage.set('persist:root', recode(fixture.cases.whole.raw));
    const stat = RNFS.stat;
    if (kind !== 'sql')
      RNFS.stat = async () => {
        throw Error('synthetic initial scrub deferral');
      };
    let key;
    try {
      key = await prepareVault(storage);
    } finally {
      RNFS.stat = stat;
    }
    if (kind === 'sql') {
      assert(
        JSON.parse(records.getString(VAULT_RECORD_KEY)).status === 'complete',
        'FOLLOWUP2_BASE_NOT_COMPLETE',
      );
      assert(
        !records.contains(RKSTORAGE_RECORD_KEY),
        'FOLLOWUP2_SQL_NOT_PENDING',
      );
    } else {
      const state = await decode(storage.getString('persist:root'), key);
      add(state, 'newer');
      await writeState(state, key, false);
      if (kind === 'temp') {
        const write = RNFS.writeFile;
        let hits = 0;
        RNFS.writeFile = async (path, value, encoding) => {
          hits++;
          assert(
            path === migrationTemp(VAULT_OLDER_BACKUP),
            'FOLLOWUP2_WRONG_PARTIAL_SLOT',
          );
          await write(
            path,
            value.slice(0, Math.floor(value.length / 2)),
            encoding,
          );
          throw Error('synthetic partial write rejection');
        };
        try {
          assert(
            (await prepareVault(storage)) === key,
            'FOLLOWUP2_KEY_CHANGED',
          );
        } finally {
          RNFS.writeFile = write;
        }
        assert(hits === 1, 'FOLLOWUP2_PARTIAL_NOT_INJECTED');
        assert(
          await RNFS.exists(migrationTemp(VAULT_OLDER_BACKUP)),
          'FOLLOWUP2_PARTIAL_MISSING',
        );
        assert(
          JSON.parse(records.getString(VAULT_RECORD_KEY)).cleanup.bak
            .writePhase === 'writing',
          'FOLLOWUP2_WRITING_MISSING',
        );
        add(state, 'latest');
        await writeState(state, key, true);
        result.partialNativeWrite = true;
        result.ordinaryRotation = true;
      } else {
        const backup = await decode(
          await RNFS.readFile(VAULT_BACKUP, 'utf8'),
          key,
        );
        assert(
          Object.keys(backup.WALLET.keys).length === 1 &&
            Object.keys(state.WALLET.keys).length === 2,
          'FOLLOWUP2_PRIMARY_NOT_AHEAD',
        );
      }
    }
    result.cleanupPending = true;
  } else {
    const entry = await Keychain.getGenericPassword({
      service: VAULT_KEY_SERVICE,
    });
    assert(!!entry, 'FOLLOWUP2_MODERN_KEY_MISSING');
    const primary = storage.getString('persist:root');
    const main = await RNFS.readFile(VAULT_BACKUP, 'utf8');
    const bak = (await RNFS.exists(VAULT_OLDER_BACKUP))
      ? await RNFS.readFile(VAULT_OLDER_BACKUP, 'utf8')
      : null;
    const history = records.getString(VAULT_RECORD_KEY);
    const get = MMKV.prototype.getString,
      set = MMKV.prototype.set;
    let broken = phase === 'check' && kind !== 'temp',
      hits = 0,
      writes = 0;
    MMKV.prototype.getString = function (name) {
      if (name === 'persist:root' && broken) {
        hits++;
        if (kind === 'once') broken = false;
        throw Error('synthetic primary read failure');
      }
      return get.call(this, name);
    };
    MMKV.prototype.set = function (name, value) {
      const answer = set.call(this, name, value);
      if (name === 'persist:root') {
        writes++;
        broken = false;
      }
      return answer;
    };
    let raw;
    try {
      assert(
        (await prepareVault(storage)) === entry.password,
        'FOLLOWUP2_KEY_CHANGED',
      );
      raw = await reduxStorage.getItem('persist:root');
    } finally {
      MMKV.prototype.getString = get;
      MMKV.prototype.set = set;
    }
    const state = await decode(raw, entry.password);
    const expectedKeys = kind === 'once' ? 2 : kind === 'sql' ? 1 : 3;
    assert(
      Object.keys(state.WALLET.keys).length === expectedKeys,
      'FOLLOWUP2_WALLET_CHANGED',
    );
    if (phase === 'check') {
      assert(
        (await RNFS.readFile(VAULT_BACKUP, 'utf8')) === main,
        'FOLLOWUP2_MAIN_CHANGED',
      );
      assert(
        ((await RNFS.exists(VAULT_OLDER_BACKUP))
          ? await RNFS.readFile(VAULT_OLDER_BACKUP, 'utf8')
          : null) === bak,
        'FOLLOWUP2_BAK_CHANGED',
      );
      if (kind === 'once') {
        assert(
          hits === 1 && writes === 0 && raw === primary,
          'FOLLOWUP2_GOOD_PRIMARY_REPLACED',
        );
        assert(
          records.getString(VAULT_RECORD_KEY) === history,
          'FOLLOWUP2_FALSE_RECOVERY_RECORD',
        );
        result.exactPrimaryPreserved = true;
      } else if (kind === 'sql') {
        assert(hits > 0 && writes === 1, 'FOLLOWUP2_SQL_RECOVERY_COUNT');
        assert(
          !records.contains(RKSTORAGE_RECORD_KEY),
          'FOLLOWUP2_BUSY_MARKED_COMPLETE',
        );
        result.recoveredBeforeSqlCleanup = true;
      } else {
        assert(
          raw === primary && writes === 0,
          'FOLLOWUP2_TEMP_CHANGED_PRIMARY',
        );
        assert(
          !(await RNFS.exists(migrationTemp(VAULT_OLDER_BACKUP))),
          'FOLLOWUP2_PARTIAL_REMAINS',
        );
        assert(
          JSON.parse(records.getString(VAULT_RECORD_KEY)).status === 'complete',
          'FOLLOWUP2_BASE_INCOMPLETE',
        );
        assert(
          !(await Keychain.getGenericPassword({service: LEGACY_KEY_SERVICE})),
          'FOLLOWUP2_LEGACY_REMAINS',
        );
        result.partialRetired = true;
      }
      result.injectedReads = hits;
      result.rootWrites = writes;
    }
    assert(
      (await AsyncStorage.getItem('followup2-library')) ===
        'synthetic unrelated value',
      'FOLLOWUP2_UNRELATED_CHANGED',
    );
    if (phase === 'verify') {
      assert(
        records.getString(RKSTORAGE_RECORD_KEY) === 'complete-v1',
        'FOLLOWUP2_SQL_INCOMPLETE',
      );
      assert(
        !(await Keychain.getGenericPassword({service: LEGACY_KEY_SERVICE})),
        'FOLLOWUP2_LEGACY_REMAINS',
      );
    }
    result.cleanupPending =
      records.getString(RKSTORAGE_RECORD_KEY) !== 'complete-v1';
    result.verifiedKeyCount = expectedKeys;
  }
  result.nativeCalls = nativeCalls;
};
