// Instrumentation-only entry; never included by the production app entry point.
import 'react-native-get-random-values';
import {install} from 'react-native-quick-crypto';
import '@ethersproject/shims';
import '../../../shim';
import '@walletconnect/react-native-compat';
import 'react-native-url-polyfill/auto';
import {NativeModules} from 'react-native';
import RNFS from 'react-native-fs';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';
import {getUniqueId} from 'react-native-device-info';
import {MMKV} from 'react-native-mmkv';
import C from 'crypto-js';
import {Buffer} from 'buffer';

install();
const output = RNFS.DocumentDirectoryPath + '/rkstorage-react-result.json';
const input = RNFS.DocumentDirectoryPath + '/rkstorage-react-case.json';
const assert = (condition, code) => {
  if (!condition) throw Error(code);
};
(async () => {
  let stage = 'load';
  try {
    const {operation} = JSON.parse(await RNFS.readFile(input, 'utf8'));
    const fixture = require('../fixtures/legacy-14.32.json');
    const {
      prepareVault,
      RKSTORAGE_RECORD_KEY,
    } = require('../../../src/store/vault-rkstorage');
    const {
      VAULT_RECORD_ID,
      VAULT_RECORD_KEY,
    } = require('../../../src/store/vault-migration');
    const {
      LEGACY_KEY_SERVICE,
      VAULT_KEY_SERVICE,
    } = require('../../../src/store/encryption-key');
    const storage = new MMKV();
    const records = new MMKV({id: VAULT_RECORD_ID});
    const legacy = await getUniqueId();
    const recode = raw =>
      raw.replace(/U2FsdGVkX1[A-Za-z0-9+/=]+/g, value =>
        C.AES.encrypt(
          recode(
            C.AES.decrypt(value, 'synthetic-legacy-fixture-key').toString(
              C.enc.Utf8,
            ),
          ),
          legacy,
        ).toString(),
      );
    const result = {
      operation,
      newArchitectureBridge: !!NativeModules.BitPayRKStorage,
    };
    assert(result.newArchitectureBridge, 'BRIDGE_MISSING');
    stage = 'seed';
    if (operation.startsWith('react-eddsa-')) {
      const {BwcProvider} = require('../../../src/lib/bwc');
      const provider = BwcProvider.getInstance();
      const equal = require('lodash.isequal');
      const getStoredState =
        require('redux-persist/lib/getStoredState').default;
      const {
        encryptSpecificFields,
      } = require('../../../src/store/transforms/transforms');
      const {
        persistEncryptionTransform,
      } = require('../../../src/store/transforms/persist-encryption');
      const transforms = key => [
        encryptSpecificFields(key),
        persistEncryptionTransform(key),
      ];
      const restore = key =>
        getStoredState({
          key: 'root',
          storage: {getItem: async () => storage.getString('persist:root')},
          transforms: transforms(key),
        });
      let nativeCalls = 0;
      for (const method of ['inspect', 'clean']) {
        const original = NativeModules.BitPayRKStorage[method];
        NativeModules.BitPayRKStorage[method] = () => {
          nativeCalls++;
          return original();
        };
      }
      if (operation === 'react-eddsa-seed') {
        assert(!records.contains(VAULT_RECORD_KEY), 'NOT_FRESH');
        const state = JSON.parse(JSON.stringify(fixture.cases.whole.state));
        const properties = provider.createKey({seedType: 'new'}).toObj();
        // Synthetic pre-upgrade shape, not an archived historical SDK fixture.
        delete properties.xPrivKeyEDDSA;
        delete properties.fingerPrintEDDSA;
        state.WALLET.keys.fixture.properties = properties;
        const raw = JSON.stringify(
          Object.fromEntries(
            Object.entries(state).map(([name, value]) => [
              name,
              JSON.stringify(
                C.AES.encrypt(JSON.stringify(value), legacy).toString(),
              ),
            ]),
          ),
        );
        await Keychain.setGenericPassword(LEGACY_KEY_SERVICE, legacy, {
          service: LEGACY_KEY_SERVICE,
        });
        storage.set('persist:root', raw);
        await AsyncStorage.setItem('persist:root', raw);
      } else if (operation === 'react-eddsa-upgrade') {
        stage = 'deferred-async-delete';
        const remove = AsyncStorage.removeItem;
        AsyncStorage.removeItem = async name => {
          assert(name === 'persist:root', 'UNEXPECTED_REMOVE');
          throw Error('INJECTED_DELETE_FAILURE');
        };
        let key;
        try {
          key = await prepareVault(storage);
        } finally {
          AsyncStorage.removeItem = remove;
        }
        assert(
          JSON.parse(records.getString(VAULT_RECORD_KEY)).status === 'started',
          'BASE_NOT_DEFERRED',
        );
        assert(
          (await AsyncStorage.getItem('persist:root')) !== null,
          'OLD_SOURCE_LOST',
        );
        assert(
          nativeCalls === 0 && !records.contains(RKSTORAGE_RECORD_KEY),
          'EARLY_SQL_CLEANUP',
        );
        stage = 'eddsa-upgrade';
        const state = await restore(key);
        const item = state.WALLET.keys.fixture;
        const before = JSON.parse(JSON.stringify(item.properties));
        item.methods = provider.createKey({
          seedType: 'object',
          seedData: before,
        });
        await require('../../../src/store/wallet/effects/import/import').startAddEDDSAKey()(
          () => {},
          () => state,
        );
        assert(
          Object.keys(before).every(name =>
            equal(before[name], item.properties[name]),
          ),
          'OLDER_PROPERTIES_CHANGED',
        );
        assert(
          typeof item.properties.xPrivKeyEDDSA === 'string' &&
            /^[a-f0-9]{8}$/.test(item.properties.fingerPrintEDDSA),
          'UPGRADE_MISSING',
        );
        delete item.methods;
        const persistoid =
          require('redux-persist/lib/createPersistoid').default({
            key: 'root',
            storage: require('../../../src/store').reduxStorage,
            transforms: transforms(key),
          });
        persistoid.update(state);
        await persistoid.flush();
        assert(
          equal((await restore(key)).WALLET, state.WALLET),
          'UPGRADE_NOT_PERSISTED',
        );
        result.upgradedWithoutChangingOldProperties = true;
        result.cleanupDeferred = true;
      } else {
        stage = 'eddsa-retry';
        const entry = await Keychain.getGenericPassword({
          service: VAULT_KEY_SERVICE,
        });
        assert(!!entry, 'VAULT_KEY_MISSING');
        const before = storage.getString('persist:root');
        const state = await restore(entry.password);
        const properties = state.WALLET.keys.fixture.properties;
        assert(
          typeof properties.xPrivKeyEDDSA === 'string' &&
            /^[a-f0-9]{8}$/.test(properties.fingerPrintEDDSA),
          'UPGRADE_LOST',
        );
        const source = await AsyncStorage.getItem('persist:root');
        if (operation === 'react-eddsa-retry') {
          assert(source !== null, 'RETRY_SOURCE_MISSING');
          const oldWallet = JSON.parse(
            C.AES.decrypt(
              JSON.parse(JSON.parse(source).WALLET),
              legacy,
            ).toString(C.enc.Utf8),
          );
          assert(
            Object.keys(oldWallet.keys.fixture.properties).every(name =>
              equal(oldWallet.keys.fixture.properties[name], properties[name]),
            ),
            'OLD_PROPERTY_NOT_PRESERVED',
          );
          assert(
            !records.contains(RKSTORAGE_RECORD_KEY),
            'RETRY_ALREADY_COMPLETE',
          );
        } else assert(source === null, 'SOURCE_REAPPEARED');
        await prepareVault(storage);
        assert(
          storage.getString('persist:root') === before,
          'ENRICHED_PRIMARY_REWRITTEN',
        );
        assert(
          (await AsyncStorage.getItem('persist:root')) === null,
          'SOURCE_NOT_RETIRED',
        );
        assert(
          records.getString(RKSTORAGE_RECORD_KEY) === 'complete-v1',
          'RK_INCOMPLETE',
        );
        assert(
          JSON.parse(records.getString(VAULT_RECORD_KEY)).status === 'complete',
          'BASE_INCOMPLETE',
        );
        assert(
          !(await Keychain.getGenericPassword({service: LEGACY_KEY_SERVICE})),
          'LEGACY_NOT_RETIRED',
        );
        if (operation === 'react-eddsa-verify')
          assert(nativeCalls === 0, 'REPEATED_CLEANUP');
        result.enrichedPrimaryPreserved = true;
        result.completed = true;
      }
      result.nativeCalls = nativeCalls;
    } else if (operation.startsWith('react-fresh-')) {
      if (operation === 'react-fresh-start') {
        assert(!records.contains(VAULT_RECORD_KEY), 'NOT_FRESH');
        await AsyncStorage.setItem('react-library', '🧭 unrelated live data');
      }
      assert(!storage.contains('persist:root'), 'PREMATURE_ROOT');
      let cleanCalls = 0;
      const clean = NativeModules.BitPayRKStorage.clean;
      NativeModules.BitPayRKStorage.clean = () => {
        cleanCalls++;
        return clean();
      };
      stage = 'fresh-prepare';
      const key = await prepareVault(storage);
      for (let retry = 0; retry < 3; retry++)
        assert((await prepareVault(storage)) === key, 'FRESH_REKEYED');
      const base = JSON.parse(records.getString(VAULT_RECORD_KEY));
      assert(
        base.status === 'complete' && base.initializing === true,
        'FRESH_PROVENANCE',
      );
      assert(!records.contains(RKSTORAGE_RECORD_KEY), 'FRESH_MARKER_PREMATURE');
      assert(!storage.contains('persist:root'), 'FABRICATED_ROOT');
      assert(cleanCalls === 0, 'FRESH_ERASURE');
      result.initializationRetries = 3;
      result.nativeCleanCalls = cleanCalls;
      if (operation === 'react-fresh-save') {
        stage = 'first-save';
        const {reduxStorage} = require('../../../src/store');
        const createPersistoid =
          require('redux-persist/lib/createPersistoid').default;
        const {
          encryptSpecificFields,
        } = require('../../../src/store/transforms/transforms');
        const {
          persistEncryptionTransform,
        } = require('../../../src/store/transforms/persist-encryption');
        const persistoid = createPersistoid({
          key: 'root',
          storage: reduxStorage,
          transforms: [
            encryptSpecificFields(key),
            persistEncryptionTransform(key),
          ],
        });
        persistoid.update(fixture.cases.whole.state);
        await persistoid.flush();
        assert(storage.contains('persist:root'), 'FIRST_SAVE_MISSING');
        assert(
          !JSON.parse(records.getString(VAULT_RECORD_KEY)).initializing,
          'PROVENANCE_NOT_RETIRED',
        );
        result.firstOrdinarySave = true;
      }
    } else if (
      [
        'react-seed',
        'react-base-only',
        'react-async-only',
        'react-empty-import',
      ].includes(operation)
    ) {
      assert(
        !storage.contains('persist:root') &&
          !records.contains(VAULT_RECORD_KEY),
        'NOT_DISPOSABLE_FRESH_STATE',
      );
      await Keychain.setGenericPassword(LEGACY_KEY_SERVICE, legacy, {
        service: LEGACY_KEY_SERVICE,
      });
      await AsyncStorage.setItem('react-library', '🧭 unrelated live data');
      for (const sample of Object.values(fixture.cases))
        await AsyncStorage.setItem('persist:root', recode(sample.raw));
      if (
        operation === 'react-async-only' ||
        operation === 'react-empty-import'
      ) {
        await AsyncStorage.setItem(
          'persist:root',
          recode(fixture.cases.whole.raw),
        );
        if (operation === 'react-empty-import') {
          const empty = {
            APP: {migrationMMKVStorageComplete: false},
            WALLET: {keys: {}},
            SHOP: {giftCards: {livenet: []}},
            CONTACT: {list: []},
            _persist: {version: -1, rehydrated: true},
          };
          const raw = JSON.stringify({
            ...Object.fromEntries(
              Object.entries(empty).map(([name, state]) => [
                name,
                JSON.stringify(
                  C.AES.encrypt(JSON.stringify(state), legacy).toString(),
                ),
              ]),
            ),
          });
          storage.set('persist:root', raw);
          const {
            VAULT_BACKUP_DIR,
            VAULT_BACKUP,
          } = require('../../../src/store/backup/vault-files');
          await RNFS.mkdir(VAULT_BACKUP_DIR);
          await RNFS.writeFile(VAULT_BACKUP, raw, 'utf8');
        }
      } else {
        storage.set('persist:root', recode(fixture.cases.whole.raw));
        await AsyncStorage.removeItem('persist:root');
      }
      if (operation === 'react-base-only') {
        await require('../../../src/store/vault-migration').migrateVault(
          storage,
        );
        assert(
          JSON.parse(records.getString(VAULT_RECORD_KEY)).status === 'complete',
          'OLD_BASE_INCOMPLETE',
        );
        assert(!records.contains(RKSTORAGE_RECORD_KEY), 'NEW_MARKER_PREMATURE');
        result.oldBaseCompleted = true;
      }
    } else {
      const rootBefore = storage.getString('persist:root');
      const oldKey = await Keychain.getGenericPassword({
        service: VAULT_KEY_SERVICE,
      });
      const alreadyClean = records.contains(RKSTORAGE_RECORD_KEY);
      let nativeCalls = 0;
      const originalClean = NativeModules.BitPayRKStorage.clean;
      const originalInspect = NativeModules.BitPayRKStorage.inspect;
      NativeModules.BitPayRKStorage.clean = () => {
        nativeCalls++;
        return originalClean();
      };
      NativeModules.BitPayRKStorage.inspect = () => {
        nativeCalls++;
        return originalInspect();
      };
      stage = 'prepare';
      await prepareVault(storage);
      if (alreadyClean) assert(nativeCalls === 0, 'REPEATED_CLEANUP');
      if (oldKey)
        assert(
          storage.getString('persist:root') === rootBefore,
          'OLD_COMPLETE_REWROTE_PRIMARY',
        );
      result.nativeCalls = nativeCalls;
      stage = 'completion';
      assert(
        JSON.parse(records.getString(VAULT_RECORD_KEY)).status === 'complete',
        'BASE_INCOMPLETE',
      );
      assert(
        records.getString(RKSTORAGE_RECORD_KEY) === 'complete-v1',
        'RK_INCOMPLETE',
      );
      assert(
        (await AsyncStorage.getItem('react-library')) ===
          '🧭 unrelated live data',
        'UNRELATED_CHANGED',
      );
      const key = await Keychain.getGenericPassword({
        service: VAULT_KEY_SERVICE,
      });
      assert(!!key && key.password !== legacy, 'INDEPENDENT_KEY_MISSING');
      assert(
        !(await Keychain.getGenericPassword({service: LEGACY_KEY_SERVICE})),
        'LEGACY_NOT_RETIRED',
      );
      if (oldKey)
        assert(key.password === oldKey.password, 'OLD_COMPLETE_REKEYED');
      const getStoredState =
        require('redux-persist/lib/getStoredState').default;
      const {
        encryptSpecificFields,
      } = require('../../../src/store/transforms/transforms');
      const {
        persistEncryptionTransform,
      } = require('../../../src/store/transforms/persist-encryption');
      const restored = await getStoredState({
        key: 'root',
        storage: {getItem: async () => storage.getString('persist:root')},
        transforms: [
          encryptSpecificFields(key.password),
          persistEncryptionTransform(key.password),
        ],
      });
      assert(
        require('lodash.isequal')(
          restored.WALLET,
          fixture.cases.whole.state.WALLET,
        ),
        'WALLET_CHANGED',
      );
      result.walletRestoredExactly = true;
      result.completed = true;
    }
    // Test-only raw scan uses the app's own identifier in memory. Neither it nor
    // any protected material is exported in the fixed-count result file.
    stage = 'scan';
    let decryptable = 0,
      bareEddsa = 0,
      opaqueEddsa = 0;
    const bare =
      fixture.cases.plain.state.WALLET.keys.fixture.properties.xPrivKeyEDDSA;
    const opaque = JSON.parse(
      fixture.cases.constructorPassword.state.WALLET.keys.fixture.properties
        .xPrivKeyEDDSAEncrypted,
    ).ct;
    for (const suffix of ['', '-wal', '-journal', '-shm']) {
      const path =
        RNFS.DocumentDirectoryPath + '/../databases/RKStorage' + suffix;
      if (!(await RNFS.exists(path))) continue;
      const bytes = Buffer.from(await RNFS.readFile(path, 'base64'), 'base64')
        .toString('latin1')
        .replace(/\\+\//g, '/');
      for (const candidate of bytes.match(/U2FsdGVkX1[A-Za-z0-9+/=]+/g) || []) {
        try {
          if (C.AES.decrypt(candidate, legacy).toString(C.enc.Utf8).length)
            decryptable++;
        } catch {}
      }
      bareEddsa += bytes.split(bare).length - 1;
      opaqueEddsa += bytes.split(opaque).length - 1;
    }
    Object.assign(result, {decryptable, bareEddsa, opaqueEddsa});
    if (
      [
        'react-seed',
        'react-base-only',
        'react-async-only',
        'react-empty-import',
      ].includes(operation) ||
      ['react-eddsa-seed', 'react-eddsa-upgrade'].includes(operation)
    )
      assert(decryptable > 0, 'NO_VULNERABLE_CONTROL');
    else assert(!decryptable && !bareEddsa && !opaqueEddsa, 'RESIDUE_REMAINS');
    await RNFS.writeFile(output, JSON.stringify(result), 'utf8');
  } catch (error) {
    const {vaultDiagnostic} = require('../../../src/store/vault-diagnostics');
    await RNFS.writeFile(
      output,
      JSON.stringify({failed: true, stage, diagnostic: vaultDiagnostic(error)}),
      'utf8',
    );
  }
})();
