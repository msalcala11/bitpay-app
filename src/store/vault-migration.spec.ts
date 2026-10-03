import crypto from 'crypto';
import Aes from 'crypto-js/aes.js';
import isEqual from 'lodash.isequal';
import {NativeModules, Platform} from 'react-native';
import {MMKV} from 'react-native-mmkv';
import * as Keychain from 'react-native-keychain';
import RNFS from 'react-native-fs';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {createTransform, persistReducer, persistStore} from 'redux-persist';
import createPersistoid from 'redux-persist/lib/createPersistoid';
import getStoredState from 'redux-persist/lib/getStoredState';
import {createStore} from 'redux';
import {BwcProvider} from '../lib/bwc';
import {
  migrateVault,
  recordVaultInitializationSave,
  VAULT_RECORD_ID,
  VAULT_RECORD_KEY,
  VAULT_SCRUB_KEY,
} from './vault-migration';
import {LEGACY_KEY_SERVICE, VAULT_KEY_SERVICE} from './encryption-key';
import {
  migrationTemp,
  VAULT_BACKUP,
  VAULT_OLDER_BACKUP,
  VAULT_BACKUP_TEMP,
  VAULT_BACKUP_DIR,
} from './backup/vault-files';
import {encryptSpecificFields} from './transforms/transforms';
import {
  persistEncryptionTransform,
  unencryptedPersistStores,
} from './transforms/persist-encryption';
import {decryptPersistValue, decryptValue} from './transforms/encrypt';
import {reduxStorage} from './index';
import {
  startAddEDDSAKey,
  startMigrationMMKVStorage,
} from './wallet/effects/import/import';
import {setMigrationMMKVStorageComplete} from './app/app.actions';
import {vaultDiagnostic as getVaultDiagnostic} from './vault-diagnostics';
import {prepareVault, RKSTORAGE_RECORD_KEY} from './vault-rkstorage';

// Only platform boundaries are replaced. The mutation hook can model a process
// dying immediately AFTER any native state change; every subsequent call fails.
const mockStores = new Map<string, Map<string, any>>();
const mockFiles = new Map<string, string>();
const mockDirs = new Set<string>();
const mockCredentials = new Map<string, any>();
const mockAsync = new Map<string, string>();
const mockModels = new Map<
  string,
  import('../../test/vault/mmkv-model').MmkvModel
>();
let mockWrites: string[] = [];
let mockStopAt = Infinity;
let mockDead = false;
const mockAlive = () => {
  if (mockDead) {
    throw new Error('process stopped');
  }
};
const mockChanged = (name: string) => {
  mockWrites.push(name);
  if (mockWrites.length === mockStopAt) {
    mockDead = true;
    throw new Error('process stopped');
  }
};

jest.mock('react-native-mmkv', () => ({
  MMKV: class {
    id: string;
    constructor(options?: {id: string}) {
      this.id = options?.id ?? 'default';
    }
    get data() {
      mockAlive();
      if (!mockStores.has(this.id)) {
        mockStores.set(this.id, new Map());
      }
      return mockStores.get(this.id)!;
    }
    get model() {
      const data = this.data;
      if (mockModels.get(this.id)?.values !== data) {
        const {MmkvModel} = require('../../test/vault/mmkv-model');
        mockModels.set(this.id, new MmkvModel(data));
      }
      return mockModels.get(this.id)!;
    }
    get size() {
      return this.model.actual;
    }
    trim() {
      this.model.trim();
      mockChanged(`mmkv:${this.id}:trim`);
    }
    contains(key: string) {
      return this.data.has(key);
    }
    getString(key: string) {
      const value = this.data.get(key);
      return typeof value === 'string' ? value : undefined;
    }
    getAllKeys() {
      return [...this.data.keys()];
    }
    set(key: string, value: any) {
      this.model.set(key, value);
      mockChanged(`mmkv:${this.id}:set:${key}`);
    }
    delete(key: string) {
      this.model.delete(key);
      mockChanged(`mmkv:${this.id}:delete:${key}`);
    }
    clearAll() {
      throw new Error('Migration must not deliberately clear MMKV');
    }
  },
}));
jest.mock('react-native-keychain', () => ({
  getGenericPassword: jest.fn(async ({service}) => {
    mockAlive();
    return mockCredentials.get(service) ?? false;
  }),
  setGenericPassword: jest.fn(
    async (username, password, {service, storage}) => {
      mockAlive();
      const value = {username, password, service, storage: storage ?? 'ios'};
      mockCredentials.set(service, value);
      mockChanged('keychain:set');
      return {service, storage: value.storage};
    },
  ),
  resetGenericPassword: jest.fn(async ({service}) => {
    mockAlive();
    mockCredentials.delete(service);
    mockChanged(`keychain:delete:${service}`);
    return true;
  }),
  ACCESSIBLE: {AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'device-local'},
  STORAGE_TYPE: {AES_GCM_NO_AUTH: 'KeystoreAESGCM_NoAuth'},
  SECURITY_LEVEL: {SECURE_SOFTWARE: 'software'},
}));
jest.mock('react-native-device-info', () => {
  const info = require('react-native-device-info/jest/react-native-device-info-mock');
  return {
    ...info,
    __esModule: true,
    default: info,
    getUniqueId: jest.fn(() => 'synthetic-legacy-fixture-key'),
  };
});
jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/test-documents',
  CachesDirectoryPath: '/test-cache',
  stat: jest.fn(async () => {
    mockAlive();
    return {
      isFile: () => true,
      size: mockModels.get('default')?.bytes.length ?? 4096,
    };
  }),
  exists: jest.fn(async (path: string) => {
    mockAlive();
    return mockFiles.has(path) || mockDirs.has(path);
  }),
  readFile: jest.fn(async (path: string) => {
    mockAlive();
    if (!mockFiles.has(path)) {
      throw new Error('missing file');
    }
    return mockFiles.get(path);
  }),
  mkdir: jest.fn(async (path: string) => {
    mockAlive();
    mockDirs.add(path);
    mockChanged(`mkdir:${path}`);
  }),
  writeFile: jest.fn(async (path: string, value: string) => {
    mockAlive();
    if (!mockDirs.has(path.slice(0, path.lastIndexOf('/')))) {
      throw new Error('missing directory');
    }
    mockFiles.set(path, value);
    mockChanged(`write:${path}`);
  }),
  unlink: jest.fn(async (path: string) => {
    mockAlive();
    mockFiles.delete(path);
    mockChanged(`unlink:${path}`);
  }),
  moveFile: jest.fn(async (from: string, to: string) => {
    mockAlive();
    if (mockFiles.has(to) || !mockFiles.has(from)) {
      throw new Error('invalid move');
    }
    mockFiles.set(to, mockFiles.get(from)!);
    mockFiles.delete(from);
    mockChanged(`move:${to}`);
  }),
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => {
    mockAlive();
    return mockAsync.get(key) ?? null;
  }),
  removeItem: jest.fn(async (key: string) => {
    mockAlive();
    mockAsync.delete(key);
    mockChanged(`async:delete:${key}`);
  }),
  getAllKeys: jest.fn(async () => [...mockAsync.keys()]),
  multiRemove: jest.fn(),
}));
jest.mock('react-native-restart', () => ({restart: jest.fn()}));

const legacyKey = 'synthetic-legacy-fixture-key';
const root = new MMKV();
const record = new MMKV({id: VAULT_RECORD_ID});
const walletFields = [
  'mnemonic',
  'mnemonicEncrypted',
  'xPrivKey',
  'xPrivKeyEncrypted',
  'xPrivKeyEDDSA',
  'xPrivKeyEDDSAEncrypted',
];
const shopFields = [
  'accessKey',
  'barcodeData',
  'barcodeImage',
  'claimCode',
  'claimLink',
  'pin',
];
const payload = () => ({
  APP: {
    migrationMMKVStorageComplete: false,
    identity: {livenet: {priv: 'synthetic identity'}},
  },
  WALLET: {
    keys: {
      readonly: {
        id: 'readonly',
        properties: Object.fromEntries(
          walletFields.map(field => [
            field,
            field.endsWith('Encrypted')
              ? JSON.stringify({
                  ct: 'synthetic opaque password ciphertext',
                  iv: 'synthetic',
                })
              : `synthetic ${field}`,
          ]),
        ),
        wallets: [],
      },
    },
  },
  SHOP: {
    giftCards: {
      livenet: [
        {
          invoiceId: 'synthetic-invoice',
          ...Object.fromEntries(
            shopFields.map(field => [field, `synthetic ${field}`]),
          ),
        },
      ],
    },
  },
  BITPAY_ID: {apiToken: 'synthetic token'},
  MARKET_STATS: {downloadAgain: true},
  _persist: {version: -1, rehydrated: true},
});

type Mode = 'whole' | 'fields' | 'both' | 'modern';
const save = async (
  state: any,
  key = legacyKey,
  mode: Mode = 'fields',
): Promise<string> => {
  let raw = '';
  const legacyFields = createTransform((value: any, reducer) => {
    const next = JSON.parse(JSON.stringify(value));
    const fields = (obj: any, names: string[]) => {
      if (obj) {
        for (const field of names) {
          if (
            typeof obj[field] === 'string' &&
            obj[field] &&
            !obj[field].startsWith('encrypted:')
          ) {
            obj[field] = `encrypted:${Aes.encrypt(obj[field], key).toString()}`;
          }
        }
      }
    };
    if (reducer === 'WALLET') {
      Object.values(next.keys ?? {}).forEach((item: any) =>
        fields(item.properties, walletFields),
      );
    }
    if (reducer === 'APP') {
      fields(next.identity?.livenet, ['priv']);
    }
    if (reducer === 'SHOP') {
      next.giftCards?.livenet?.forEach((card: any) => fields(card, shopFields));
    }
    return next;
  });
  // Exact master transform semantics: CryptoJS CBC + unencryptedStores patch.
  const legacyOuter = createTransform((reducerState: any, reducer) =>
    mode === 'fields' && unencryptedPersistStores.has(String(reducer))
      ? JSON.stringify(reducerState)
      : Aes.encrypt(JSON.stringify(reducerState), key).toString(),
  );
  const transforms =
    mode === 'modern'
      ? [encryptSpecificFields(key), persistEncryptionTransform(key)]
      : [...(mode === 'whole' ? [] : [legacyFields]), legacyOuter];
  const persistoid = createPersistoid({
    key: 'root',
    storage: {
      setItem: async (_name: string, value: string) => {
        raw = value;
      },
    },
    transforms,
  } as any);
  persistoid.update(state);
  await persistoid.flush();
  return raw;
};
const restore = async (
  raw: string,
  key: string,
): Promise<Record<string, any>> => {
  const state = await getStoredState({
    key: 'root',
    storage: {getItem: async () => raw},
    transforms: [encryptSpecificFields(key), persistEncryptionTransform(key)],
  } as any);
  if (!state) {
    throw new Error('Expected restored fixture');
  }
  return state;
};
const seedFile = (path: string, raw: string) => {
  mockDirs.add(VAULT_BACKUP_DIR);
  mockFiles.set(path, raw);
};
const seedKey = (
  service: string,
  password: string,
  storage = 'KeystoreAESGCM_NoAuth',
) =>
  mockCredentials.set(service, {service, password, username: service, storage});
const restart = () => {
  mockDead = false;
  mockStopAt = Infinity;
  mockWrites = [];
};
const noWrites = () => expect(mockWrites.length).toBe(0);
const complete = () =>
  JSON.parse(record.getString(VAULT_RECORD_KEY) ?? 'null')?.status ===
  'complete';
const same = (a: any, b: any) =>
  expect(
    isEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b))),
  ).toBe(true);
const seed = async (mode: Mode = 'fields') => {
  root.set('persist:root', await save(payload(), legacyKey, mode));
  root.set('persist:logs', '[]');
  seedKey(LEGACY_KEY_SERVICE, legacyKey);
  restart();
};
beforeEach(() => {
  mockModels.clear();
  mockDead = false;
  mockStopAt = Infinity;
  mockWrites = [];
  mockStores.clear();
  mockFiles.clear();
  mockDirs.clear();
  mockCredentials.clear();
  mockAsync.clear();
  jest.clearAllMocks();
  Platform.OS = 'android';
  delete NativeModules.BitPayRKStorage;
});

it.each(['ios', 'android'] as const)(
  'T1 completes a fresh %s install, reuses its key, and never persists or logs it',
  async platform => {
    Platform.OS = platform;
    const logs: string[] = [];
    const key = await migrateVault(root, message => logs.push(message));
    expect(Buffer.from(key, 'base64').length).toBe(32);
    expect(complete()).toBe(true);
    expect(
      JSON.stringify(
        [...mockStores.values()].map(value => [...value]),
      ).includes(key),
    ).toBe(false);
    expect(JSON.stringify([...mockFiles]).includes(key)).toBe(false);
    expect(logs.join('').includes(key)).toBe(false);
    restart();
    expect((await migrateVault(root)) === key).toBe(true);
    noWrites();
  },
);
it.each(['whole', 'fields', 'both'] as const)(
  'T2 migrates %s encryption including every protected field and opaque password values',
  async mode => {
    for (const hasKey of [true, false]) {
      await seed(mode);
      if (!hasKey) {
        mockCredentials.delete(LEGACY_KEY_SERVICE);
      }
      const key = await migrateVault(root);
      same(await restore(root.getString('persist:root')!, key), payload());
      expect(key !== legacyKey).toBe(true);
      const raw = root.getString('persist:root')!;
      expect(raw.includes('U2FsdGVkX1')).toBe(false);
      const outer = JSON.parse(raw);
      expect(() =>
        decryptPersistValue(
          JSON.parse(outer._persist),
          legacyKey,
          'persist:_persist',
        ),
      ).toThrow();
      const wallet = JSON.parse(JSON.parse(outer.WALLET));
      for (const field of walletFields) {
        expect(() =>
          decryptValue(
            wallet.keys.readonly.properties[field],
            legacyKey,
            `WALLET.keys.readonly.properties.${field}`,
          ),
        ).toThrow();
      }
      mockStores.clear();
      mockCredentials.clear();
      mockFiles.clear();
      restart();
    }
  },
);
it('T3 traverses real production transforms and reduxStorage: old save, migration, rehydration, persist and reopen', async () => {
  await seed('both');
  const key = await migrateVault(root);
  const config = {
    key: 'root',
    storage: reduxStorage,
    transforms: [encryptSpecificFields(key), persistEncryptionTransform(key)],
  };
  const reducer = persistReducer(config as any, (state: any = {}) => state);
  const store = createStore(reducer);
  let persistor: ReturnType<typeof persistStore>;
  await new Promise<void>(resolve => {
    persistor = persistStore(store, undefined, resolve);
  });
  same(store.getState().WALLET, payload().WALLET);
  same(store.getState().SHOP, payload().SHOP);
  await persistor!.flush();
  persistor!.pause();
  await new Promise(resolve => setTimeout(resolve, 0));
  const reopened: any = await getStoredState(config as any);
  same(reopened.WALLET, payload().WALLET);
  same(reopened.SHOP, payload().SHOP);
});
it.each(['main', 'bak', 'async'] as const)(
  'T4 uses %s when it is the only source',
  async source => {
    const raw = await save(payload());
    if (source === 'async') {
      mockAsync.set('persist:root', raw);
    } else {
      seedFile(source === 'main' ? VAULT_BACKUP : VAULT_OLDER_BACKUP, raw);
    }
    const key = await migrateVault(root);
    expect(complete()).toBe(true);
    expect(mockAsync.has('persist:root')).toBe(false);
    const kept =
      root.getString('persist:root') ??
      mockFiles.get(source === 'bak' ? VAULT_OLDER_BACKUP : VAULT_BACKUP)!;
    same((await restore(kept, key)).WALLET, payload().WALLET);
  },
);
it('T4 discards an AsyncStorage leftover and marks the importer complete even if deletion fails', async () => {
  await seed();
  mockAsync.set(
    'persist:root',
    await save({...payload(), BITPAY_ID: {apiToken: 'older'}}),
  );
  (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(
    new Error('cannot delete'),
  );
  const key = await migrateVault(root);
  expect(complete()).toBe(false);
  same(
    (await restore(root.getString('persist:root')!, key)).BITPAY_ID,
    payload().BITPAY_ID,
  );
  const dispatch = jest.fn();
  await (startMigrationMMKVStorage() as any)(dispatch, () => ({}));
  expect(dispatch).toHaveBeenCalledWith(setMigrationMMKVStorageComplete());
  expect(AsyncStorage.multiRemove).not.toHaveBeenCalled();
  await migrateVault(root);
  expect(complete()).toBe(true);
  expect(mockAsync.has('persist:root')).toBe(false);
});
it.each(['damaged-bak', 'unparsable-main'] as const)(
  'T4 refresh preserves the valid snapshot at a formerly damaged path: %s',
  async scenario => {
    await seed();
    const older = {...payload(), BITPAY_ID: {apiToken: 'older'}};
    if (scenario === 'damaged-bak') {
      seedFile(VAULT_BACKUP, await save(older));
      seedFile(VAULT_OLDER_BACKUP, '{"bad":"data"}');
    } else {
      seedFile(VAULT_BACKUP, 'truncated');
      seedFile(VAULT_OLDER_BACKUP, await save(older));
    }
    const key = await migrateVault(root);
    expect(complete()).toBe(true);
    same(
      (await restore(mockFiles.get(VAULT_OLDER_BACKUP)!, key)).BITPAY_ID,
      older.BITPAY_ID,
    );
    same(
      (await restore(mockFiles.get(VAULT_BACKUP)!, key)).BITPAY_ID,
      payload().BITPAY_ID,
    );
  },
);
it('T4 an unparsable main allows a valid bak; a parseable damaged main blocks AsyncStorage', async () => {
  seedFile(VAULT_BACKUP, 'truncated');
  seedFile(VAULT_OLDER_BACKUP, await save(payload()));
  await migrateVault(root);
  expect(complete()).toBe(true);
  mockStores.clear();
  mockCredentials.clear();
  mockFiles.clear();
  seedFile(VAULT_BACKUP, '{"bad":"data"}');
  mockAsync.set('persist:root', await save(payload()));
  restart();
  await expect(migrateVault(root).then(() => undefined)).rejects.toThrow();
  noWrites();
  expect(mockAsync.has('persist:root')).toBe(true);
});

it.each([true, false])(
  'T5 interrupts every state-changing operation and resumes (logical root present: %s)',
  async hasRoot => {
    const setup = async () => {
      mockStores.clear();
      mockCredentials.clear();
      mockFiles.clear();
      mockDirs.clear();
      mockAsync.clear();
      restart();
      const raw = await save(payload());
      if (hasRoot) {
        root.set('persist:root', raw);
      }
      seedFile(VAULT_BACKUP, raw);
      seedFile(
        VAULT_OLDER_BACKUP,
        await save({...payload(), BITPAY_ID: {apiToken: 'older'}}),
      );
      seedFile(VAULT_BACKUP_TEMP, 'unfinished');
      mockAsync.set('persist:root', raw);
      root.set('persist:logs', '[]');
      seedKey(LEGACY_KEY_SERVICE, legacyKey);
      restart();
    };
    await setup();
    await migrateVault(root);
    const count = mockWrites.length;
    expect(
      mockWrites.some(write => write.endsWith(`set:${VAULT_SCRUB_KEY}`)),
    ).toBe(true);
    for (let stop = 1; stop <= count; stop++) {
      await setup();
      mockStopAt = stop;
      try {
        await migrateVault(root);
      } catch {}
      restart();
      const key = await migrateVault(root);
      expect(complete()).toBe(true);
      expect(root.contains(VAULT_SCRUB_KEY)).toBe(false);
      const raw =
        root.getString('persist:root') ?? mockFiles.get(VAULT_BACKUP)!;
      same((await restore(raw, key)).WALLET, payload().WALLET);
      restart();
      await migrateVault(root);
      noWrites();
    }
  },
);
it.each(['missing', 'partial', 'valid'] as const)(
  'T5 resumes a verified temp beside a %s target',
  async target => {
    const key = crypto.randomBytes(32).toString('base64');
    seedKey(VAULT_KEY_SERVICE, key);
    record.set(
      VAULT_RECORD_KEY,
      JSON.stringify({status: 'started', wipeDone: false}),
    );
    const modern = await save(payload(), key, 'modern');
    seedFile(migrationTemp(VAULT_BACKUP), modern);
    if (target === 'partial') {
      seedFile(VAULT_BACKUP, '{"APP":');
    }
    if (target === 'valid') {
      seedFile(VAULT_BACKUP, await save(payload()));
    }
    restart();
    await migrateVault(root);
    expect(complete()).toBe(true);
    same(
      (await restore(mockFiles.get(VAULT_BACKUP)!, key)).WALLET,
      payload().WALLET,
    );
    expect(mockFiles.has(migrationTemp(VAULT_BACKUP))).toBe(false);
  },
);
it.each(['started', 'complete'])(
  'T6 missing key with %s record stops before any mutation, even with CBC only',
  async status => {
    await seed();
    record.set(
      VAULT_RECORD_KEY,
      JSON.stringify({status, wipeDone: status === 'complete'}),
    );
    restart();
    await expect(migrateVault(root).then(() => undefined)).rejects.toThrow();
    noWrites();
  },
);
it.each(['root', 'main', 'bak', 'async', 'temp'])(
  'T6 AES-GCM in %s without a versioned key never creates a key or cleans up',
  async location => {
    const raw = await save(
      payload(),
      crypto.randomBytes(32).toString('base64'),
      'modern',
    );
    seedKey(LEGACY_KEY_SERVICE, legacyKey);
    if (location === 'root') {
      root.set('persist:root', raw);
    } else if (location === 'async') {
      mockAsync.set('persist:root', raw);
    } else {
      seedFile(
        location === 'main'
          ? VAULT_BACKUP
          : location === 'bak'
          ? VAULT_OLDER_BACKUP
          : migrationTemp(VAULT_BACKUP),
        raw,
      );
    }
    restart();
    await expect(migrateVault(root).then(() => undefined)).rejects.toThrow();
    noWrites();
    expect((Keychain.setGenericPassword as jest.Mock).mock.calls.length).toBe(
      0,
    );
  },
);
it.each(['source', 'target'])(
  'T6 unreadable replacement %s prevents all modifications to both files',
  async location => {
    const key = crypto.randomBytes(32).toString('base64');
    seedKey(VAULT_KEY_SERVICE, key);
    const raw = await save(payload(), key, 'modern');
    seedFile(VAULT_BACKUP, raw);
    seedFile(migrationTemp(VAULT_BACKUP), raw);
    const read = RNFS.readFile as jest.Mock;
    const implementation = read.getMockImplementation()!;
    read.mockImplementationOnce(async (path: string, ...args: any[]) => {
      if (location === 'target') {
        throw new Error('unreadable');
      }
      return implementation(path, ...args);
    });
    if (location === 'source') {
      read.mockRejectedValueOnce(new Error('unreadable'));
    }
    restart();
    await expect(migrateVault(root).then(() => undefined)).rejects.toThrow();
    noWrites();
    expect(mockFiles.size).toBe(2);
  },
);
it.each(['root', 'async'])(
  'T6 invalid legacy %s source causes no key/record write or cleanup',
  async location => {
    const raw = await save(payload(), 'wrong legacy key');
    if (location === 'root') {
      root.set('persist:root', raw);
    } else {
      mockAsync.set('persist:root', raw);
    }
    restart();
    await expect(migrateVault(root).then(() => undefined)).rejects.toThrow();
    noWrites();
  },
);
it('T6 rejects mixed formats, incorrect backend and Keychain read errors before data changes', async () => {
  await seed();
  const key = crypto.randomBytes(32).toString('base64');
  seedKey(VAULT_KEY_SERVICE, key);
  const modern = JSON.parse(await save(payload(), key, 'modern'));
  const old = JSON.parse(root.getString('persist:root')!);
  old.APP = modern.APP;
  root.set('persist:root', JSON.stringify(old));
  restart();
  await expect(migrateVault(root).then(() => undefined)).rejects.toThrow();
  noWrites();
  mockStores.clear();
  seedKey(VAULT_KEY_SERVICE, key, 'wrong');
  root.set('persist:root', await save(payload(), key, 'modern'));
  restart();
  await expect(migrateVault(root).then(() => undefined)).rejects.toThrow();
  noWrites();
  (Keychain.getGenericPassword as jest.Mock).mockRejectedValueOnce(
    new Error('locked'),
  );
  await expect(migrateVault(root).then(() => undefined)).rejects.toThrow();
  noWrites();
});
it('T6 replaces a rejected wrong-backend entry only before any record or GCM data', async () => {
  seedKey(VAULT_KEY_SERVICE, 'rejected value', 'wrong');
  await migrateVault(root);
  expect(complete()).toBe(true);
  const deletion = mockWrites.indexOf(`keychain:delete:${VAULT_KEY_SERVICE}`);
  expect(deletion >= 0 && deletion < mockWrites.indexOf('keychain:set')).toBe(
    true,
  );
});
it('T6 failed wrong-backend deletion never overwrites the entry', async () => {
  seedKey(VAULT_KEY_SERVICE, 'rejected value', 'wrong');
  (Keychain.resetGenericPassword as jest.Mock).mockResolvedValueOnce(false);
  await expect(migrateVault(root).then(() => undefined)).rejects.toThrow();
  noWrites();
  expect((Keychain.setGenericPassword as jest.Mock).mock.calls.length).toBe(0);
});
it.each([true, false])(
  'T6 reuses a versioned key without its record (data present: %s)',
  async data => {
    const key = crypto.randomBytes(32).toString('base64');
    seedKey(VAULT_KEY_SERVICE, key);
    if (data) {
      root.set('persist:root', await save(payload()));
    }
    restart();
    expect((await migrateVault(root)) === key).toBe(true);
    expect((Keychain.setGenericPassword as jest.Mock).mock.calls.length).toBe(
      0,
    );
    expect(complete()).toBe(true);
  },
);
it('T6 concurrent callers await one attempt', async () => {
  await seed();
  const first = migrateVault(root);
  const second = migrateVault(root);
  expect(first === second).toBe(true);
  const keys = await Promise.all([first, second]);
  expect(keys[0] === keys[1]).toBe(true);
  expect(Keychain.setGenericPassword).toHaveBeenCalledTimes(1);
});
it('T7 unknown keys defer the scrub; removing the unknown key lets the next launch complete', async () => {
  await seed();
  root.set('unknown', true);
  restart();
  const key = await migrateVault(root);
  expect(complete()).toBe(false);
  expect(mockWrites.some(write => write.endsWith(':clear'))).toBe(false);
  expect(root.contains('unknown')).toBe(true);
  root.delete('unknown');
  await migrateVault(root);
  expect(complete()).toBe(true);
  same(
    (await restore(root.getString('persist:root')!, key)).WALLET,
    payload().WALLET,
  );
});
it('T7 scrubs an empty store and does not invent a root', async () => {
  await migrateVault(root);
  expect(mockWrites.some(write => write.endsWith(':trim'))).toBe(true);
  expect(root.contains('persist:root')).toBe(false);
  expect(complete()).toBe(true);
});
it('T7 completed startup ignores damaged backups, temps and AsyncStorage leftovers', async () => {
  const key = await migrateVault(root);
  seedFile(VAULT_BACKUP, '{"bad":"data"}');
  seedFile(VAULT_OLDER_BACKUP, 'truncated');
  seedFile(VAULT_BACKUP_TEMP, 'incomplete');
  seedFile(migrationTemp(VAULT_BACKUP), 'incomplete');
  mockAsync.set('persist:root', 'old');
  restart();
  expect((await migrateVault(root)) === key).toBe(true);
  noWrites();
  expect(RNFS.readFile).not.toHaveBeenCalled();
});

it('T5 covers interruption during a fresh, root-absent scrub with no backup', async () => {
  await migrateVault(root);
  const operations = [...mockWrites];
  for (let stop = 1; stop <= operations.length; stop++) {
    mockStores.clear();
    mockCredentials.clear();
    mockFiles.clear();
    restart();
    mockStopAt = stop;
    try {
      await migrateVault(root);
    } catch {}
    restart();
    await migrateVault(root);
    expect(complete()).toBe(true);
    expect(root.contains('persist:root')).toBe(false);
    expect(root.contains(VAULT_SCRUB_KEY)).toBe(false);
  }
});

it('T5 resumes the pinned Android move fallback leaving a partial target and a verified temp', async () => {
  seedFile(VAULT_BACKUP, await save(payload()));
  (RNFS.moveFile as jest.Mock).mockImplementationOnce(
    async (_from: string, to: string) => {
      mockFiles.set(to, '{"partial":');
      throw new Error('copy interrupted');
    },
  );
  await expect(migrateVault(root).then(() => undefined)).rejects.toThrow();
  expect(mockFiles.has(migrationTemp(VAULT_BACKUP))).toBe(true);
  const key = await migrateVault(root);
  same(
    (await restore(mockFiles.get(VAULT_BACKUP)!, key)).WALLET,
    payload().WALLET,
  );
  expect(complete()).toBe(true);
});

it('T6 rejected backend writes leave a replaceable entry; restart verifies deletion before generating once', async () => {
  (Keychain.setGenericPassword as jest.Mock).mockImplementationOnce(
    async (username, password, {service}) => {
      mockCredentials.set(service, {
        username,
        password,
        service,
        storage: 'wrong',
      });
      mockChanged('keychain:set');
      return {service, storage: 'wrong'};
    },
  );
  await expect(migrateVault(root).then(() => undefined)).rejects.toThrow();
  expect(record.contains(VAULT_RECORD_KEY)).toBe(false);
  restart();
  await migrateVault(root);
  expect(complete()).toBe(true);
  expect(mockWrites.filter(write => write === 'keychain:set').length).toBe(1);
  expect(mockWrites[0]).toBe(`keychain:delete:${VAULT_KEY_SERVICE}`);
});

it('T6 standalone #2278 GCM cannot use even the matching unversioned key', async () => {
  const key = crypto.randomBytes(32).toString('base64');
  root.set('persist:root', await save(payload(), key, 'modern'));
  seedKey(LEGACY_KEY_SERVICE, key);
  restart();
  await expect(migrateVault(root).then(() => undefined)).rejects.toThrow();
  noWrites();
});

it('T6 Keychain failure never invokes the device-ID candidate', async () => {
  await seed();
  const {getUniqueId} = require('react-native-device-info');
  (Keychain.getGenericPassword as jest.Mock).mockRejectedValueOnce(
    new Error('locked'),
  );
  await expect(migrateVault(root).then(() => undefined)).rejects.toThrow();
  noWrites();
  expect(getUniqueId).not.toHaveBeenCalled();
});

it('T7 refresh failure defers destruction and retains the old key and incomplete record', async () => {
  await seed();
  (RNFS.writeFile as jest.Mock).mockRejectedValueOnce(new Error('disk full'));
  const key = await migrateVault(root);
  expect(complete()).toBe(false);
  expect(mockCredentials.has(LEGACY_KEY_SERVICE)).toBe(true);
  expect(mockWrites.some(write => write.endsWith(':clear'))).toBe(false);
  same(
    (await restore(root.getString('persist:root')!, key)).WALLET,
    payload().WALLET,
  );
  await migrateVault(root);
  expect(complete()).toBe(true);
});

it('T7 failed retirement is retried without using the old key', async () => {
  await seed();
  (Keychain.resetGenericPassword as jest.Mock).mockRejectedValueOnce(
    new Error('unavailable'),
  );
  const key = await migrateVault(root);
  expect(complete()).toBe(false);
  expect(mockCredentials.has(LEGACY_KEY_SERVICE)).toBe(true);
  expect((await migrateVault(root)) === key).toBe(true);
  expect(complete()).toBe(true);
});

it('T7 completion removes every supported legacy copy and every temp', async () => {
  await seed();
  seedFile(VAULT_BACKUP, await save(payload(), legacyKey, 'whole'));
  seedFile(VAULT_OLDER_BACKUP, await save(payload(), legacyKey, 'both'));
  seedFile(VAULT_BACKUP_TEMP, 'incomplete');
  seedFile(migrationTemp(VAULT_BACKUP), 'incomplete');
  mockAsync.set('persist:root', await save(payload()));
  mockAsync.set('unrelated', 'keep');
  const key = await migrateVault(root);
  expect(complete()).toBe(true);
  expect(mockCredentials.has(LEGACY_KEY_SERVICE)).toBe(false);
  expect(mockAsync.get('unrelated')).toBe('keep');
  expect(mockAsync.has('persist:root')).toBe(false);
  for (const raw of [
    root.getString('persist:root')!,
    mockFiles.get(VAULT_BACKUP)!,
    mockFiles.get(VAULT_OLDER_BACKUP)!,
  ]) {
    expect(raw.includes('U2FsdGVkX1')).toBe(false);
    same((await restore(raw, key)).WALLET, payload().WALLET);
    await expect(
      restore(raw, legacyKey).then(() => undefined),
    ).rejects.toThrow();
  }
  expect(
    [...mockFiles.keys()].some(
      path => path.endsWith('.tmp') || path.endsWith('.vault-migration'),
    ),
  ).toBe(false);
});

it('T3 preserves the gift-card AAD when invoiceId is absent (no fallback)', async () => {
  const state = payload();
  delete (state.SHOP.giftCards.livenet[0] as any).invoiceId;
  root.set('persist:root', await save(state));
  const key = await migrateVault(root);
  same((await restore(root.getString('persist:root')!, key)).SHOP, state.SHOP);
});

it('T6 an unreadable versioned key after completion stops without fallback or writes', async () => {
  await migrateVault(root);
  restart();
  (Keychain.getGenericPassword as jest.Mock).mockRejectedValueOnce(
    new Error('locked'),
  );
  await expect(migrateVault(root).then(() => undefined)).rejects.toThrow();
  noWrites();
});

it('T6 a deleted versioned key after completion stops without regeneration', async () => {
  await migrateVault(root);
  mockCredentials.delete(VAULT_KEY_SERVICE);
  restart();
  await expect(migrateVault(root).then(() => undefined)).rejects.toThrow();
  noWrites();
});

it('T4 an already migrated bak remains byte-for-byte intact when the main file is unparsable', async () => {
  const key = crypto.randomBytes(32).toString('base64');
  seedKey(VAULT_KEY_SERVICE, key);
  root.set('persist:root', await save(payload()));
  seedFile(VAULT_BACKUP, 'truncated');
  const bak = await save(
    {...payload(), BITPAY_ID: {apiToken: 'older'}},
    key,
    'modern',
  );
  seedFile(VAULT_OLDER_BACKUP, bak);
  await migrateVault(root);
  expect(mockFiles.get(VAULT_OLDER_BACKUP) === bak).toBe(true);
  expect(complete()).toBe(true);
});

it('T2 tries the unversioned entry as one whole-snapshot candidate', async () => {
  const oldKey = crypto.randomBytes(32).toString('base64');
  seedKey(LEGACY_KEY_SERVICE, oldKey);
  root.set('persist:root', await save(payload(), oldKey));
  const key = await migrateVault(root);
  same(
    (await restore(root.getString('persist:root')!, key)).WALLET,
    payload().WALLET,
  );
  await expect(
    restore(root.getString('persist:root')!, oldKey),
  ).rejects.toThrow();
  await expect(
    restore(root.getString('persist:root')!, legacyKey),
  ).rejects.toThrow();
});

it('T6 never combines different CBC candidate keys within a snapshot', async () => {
  const other = crypto.randomBytes(32).toString('base64');
  seedKey(LEGACY_KEY_SERVICE, other);
  const first = JSON.parse(await save(payload(), other));
  const second = JSON.parse(await save(payload()));
  first.APP = second.APP;
  root.set('persist:root', JSON.stringify(first));
  restart();
  await expect(migrateVault(root).then(() => undefined)).rejects.toThrow();
  noWrites();
});

it('T2/T8 preserves a real wallet-password-encrypted key and its password behavior', async () => {
  const provider = BwcProvider.getInstance();
  const walletKey = provider.createKey({seedType: 'new'});
  const password = crypto.randomBytes(24).toString('base64');
  walletKey.encrypt(password);
  const state = payload();
  state.WALLET.keys.readonly.properties = walletKey.toObj() as any;
  root.set('persist:root', await save(state, legacyKey, 'both'));
  const vaultKey = await migrateVault(root);
  const restored = await restore(root.getString('persist:root')!, vaultKey);
  const reopened = provider.createKey({
    seedType: 'object',
    seedData: restored.WALLET.keys.readonly.properties,
  });
  expect(reopened.checkPassword(password)).toBe(true);
  expect(reopened.checkPassword('incorrect test password')).toBe(false);
  expect(reopened.fingerPrint === walletKey.fingerPrint).toBe(true);
});

it('T6 GCM inside a CBC reducer also stops key creation even in a damaged older copy', async () => {
  await seed();
  const modernKey = crypto.randomBytes(32).toString('base64');
  const modern = JSON.parse(await save(payload(), modernKey, 'modern'));
  const mixed = JSON.parse(await save(payload(), legacyKey, 'whole'));
  const modernWallet = JSON.parse(JSON.parse(modern.WALLET));
  mixed.WALLET = JSON.stringify(
    Aes.encrypt(JSON.stringify(modernWallet), legacyKey).toString(),
  );
  seedFile(VAULT_OLDER_BACKUP, JSON.stringify(mixed));
  restart();
  await expect(migrateVault(root).then(() => undefined)).rejects.toThrow();
  noWrites();
});

it('T2 public marker text is not mistaken for a protected GCM value', async () => {
  const state = payload();
  (state.WALLET.keys.readonly as any).name =
    'field-aesgcm-v1: public wallet name';
  root.set('persist:root', await save(state));
  const key = await migrateVault(root);
  same(
    (await restore(root.getString('persist:root')!, key)).WALLET,
    state.WALLET,
  );
});

it('T7 writes one bounded non-secret scrub payload through the public API', async () => {
  const set = jest.spyOn(root, 'set');
  try {
    await migrateVault(root);
    const scrubs = set.mock.calls.filter(([key]) => key === VAULT_SCRUB_KEY);
    expect(scrubs.length).toBe(1);
    expect(
      scrubs.every(
        ([, value]) =>
          typeof value === 'string' &&
          value.length > 0 &&
          value.length <= 64 * 1024 &&
          /^0+$/.test(value),
      ),
    ).toBe(true);
  } finally {
    set.mockRestore();
  }
});

// Defensive snapshots below are not claimed to have been produced by a tagged app.
const emptyPending = (flag: any = false): any => ({
  APP: {
    migrationMMKVStorageComplete: flag,
    identity: {livenet: {priv: '', pub: '', sin: ''}},
  },
  WALLET: {keys: {}},
  SHOP: {giftCards: {livenet: []}},
  _persist: {version: -1, rehydrated: true},
});
it.each(['plain', 'passwordOperation', 'constructorPassword'])(
  'B: archived 14.32 serializer fixture %s migrates through real persistence and reopen',
  async name => {
    const fixture = require('../../test/vault/fixtures/legacy-14.32.json');
    const {raw, state} = fixture.cases[name];
    root.set('persist:root', raw);
    seedKey(LEGACY_KEY_SERVICE, legacyKey);
    const key = await migrateVault(root);
    const config = {
      key: 'root',
      storage: reduxStorage,
      transforms: [encryptSpecificFields(key), persistEncryptionTransform(key)],
    };
    const store = createStore(
      persistReducer(config as any, (s: any = {}) => s),
    );
    let persistor: ReturnType<typeof persistStore>;
    await new Promise<void>(resolve => {
      persistor = persistStore(store, undefined, resolve);
    });
    same(store.getState().WALLET, state.WALLET);
    await persistor!.flush();
    persistor!.pause();
    const reopened: any = await getStoredState(config as any);
    same(reopened.WALLET, state.WALLET);
    const props = reopened.WALLET.keys.fixture.properties;
    if (name !== 'plain') {
      const reopenedKey = BwcProvider.getInstance().createKey({
        seedType: 'object',
        seedData: props,
      });
      expect(reopenedKey.checkPassword(fixture.password)).toBe(true);
      expect(reopenedKey.checkPassword('wrong fixture password')).toBe(false);
    }
    const saved = JSON.parse(
      JSON.parse(JSON.parse(root.getString('persist:root')!).WALLET),
    );
    for (const field of walletFields)
      if (props[field])
        expect(
          saved.keys.fixture.properties[field].startsWith('field-aesgcm-v1:'),
        ).toBe(true);
    expect(complete()).toBe(true);
  },
);
it.each(['mnemonic', 'xPrivKey', 'xPrivKeyEDDSA', 'xPrivKeyEDDSAEncrypted'])(
  'B: modern unwrapped %s is rejected without writes',
  async field => {
    const key = crypto.randomBytes(32).toString('base64');
    seedKey(VAULT_KEY_SERVICE, key);
    const raw = JSON.parse(await save(payload(), key, 'modern'));
    const wallet = JSON.parse(JSON.parse(raw.WALLET));
    wallet.keys.readonly.properties[field] = 'unwrapped-sentinel';
    raw.WALLET = JSON.stringify(JSON.stringify(wallet));
    root.set('persist:root', JSON.stringify(raw));
    restart();
    await expect(migrateVault(root).then(() => undefined)).rejects.toThrow();
    noWrites();
  },
);
it.each(['mnemonic', 'xPrivKey'])(
  'B: legacy exception does not accept plaintext %s',
  async field => {
    const raw = JSON.parse(await save(payload()));
    const wallet = JSON.parse(JSON.parse(raw.WALLET));
    wallet.keys.readonly.properties[field] = 'unwrapped-sentinel';
    raw.WALLET = JSON.stringify(JSON.stringify(wallet));
    root.set('persist:root', JSON.stringify(raw));
    restart();
    await expect(migrateVault(root).then(() => undefined)).rejects.toThrow();
    noWrites();
  },
);
it.each([
  'encrypted:broken',
  'field-aesgcm-v1:broken',
  'persist-aesgcm-v1:broken',
])(
  'B: malformed EDDSA envelope is never treated as plaintext (%s)',
  async envelope => {
    const f = require('../../test/vault/fixtures/legacy-14.32.json').cases
      .plain;
    const raw = JSON.parse(f.raw);
    const wallet = JSON.parse(JSON.parse(raw.WALLET));
    wallet.keys.fixture.properties.xPrivKeyEDDSA = envelope;
    raw.WALLET = JSON.stringify(JSON.stringify(wallet));
    root.set('persist:root', JSON.stringify(raw));
    restart();
    await expect(migrateVault(root).then(() => undefined)).rejects.toThrow();
    noWrites();
  },
);
it.each([undefined, null, ''])(
  'B: absent/empty optional legacy EDDSA (%s) stays optional',
  async value => {
    const f = require('../../test/vault/fixtures/legacy-14.32.json').cases
      .plain;
    const raw = JSON.parse(f.raw);
    const wallet = JSON.parse(JSON.parse(raw.WALLET));
    wallet.keys.fixture.properties.xPrivKeyEDDSA = value;
    raw.WALLET = JSON.stringify(JSON.stringify(wallet));
    root.set('persist:root', JSON.stringify(raw));
    await migrateVault(root);
    expect(complete()).toBe(true);
  },
);
it.each(['mmkv', 'mmkv-and-cache', 'cache-only'])(
  'C: unfinished import selected from %s preserves the AsyncStorage wallet',
  async origin => {
    const empty = await save(emptyPending());
    if (origin !== 'cache-only') root.set('persist:root', empty);
    if (origin !== 'mmkv') seedFile(VAULT_BACKUP, empty);
    mockAsync.set('persist:root', await save(payload(), legacyKey, 'whole'));
    mockAsync.set('unrelated', 'keep');
    restart();
    const key = await migrateVault(root);
    same(await restore(root.getString('persist:root')!, key), payload());
    expect(mockAsync.has('persist:root')).toBe(false);
    expect(mockAsync.get('unrelated')).toBe('keep');
    expect(complete()).toBe(true);
  },
);
it.each([false, true, undefined])(
  'C: equivalent protected contents preserve newer active state regardless of flag %s',
  async flag => {
    const active: any = payload();
    active.APP.migrationMMKVStorageComplete = flag;
    active.BITPAY_ID.apiToken = 'newer';
    root.set('persist:root', await save(active));
    mockAsync.set('persist:root', await save(payload()));
    const key = await migrateVault(root);
    same(await restore(root.getString('persist:root')!, key), active);
    expect(mockAsync.has('persist:root')).toBe(false);
  },
);
it.each([
  'identity',
  'gift',
  'wallet',
  'opaque',
  'identity-context',
  'gift-context',
  'readonly',
  'associations',
])('C: unique/conflicting %s is preserved read-only', async kind => {
  const active: any = payload();
  const source: any = payload();
  if (kind === 'identity') source.APP.identity.livenet.priv = 'different';
  if (kind === 'gift') source.SHOP.giftCards.livenet[0].pin = 'different';
  if (kind === 'wallet')
    source.WALLET.keys.readonly.properties.xPrivKey = 'different';
  if (kind === 'opaque')
    source.WALLET.keys.readonly.properties.xPrivKeyEncrypted =
      'different opaque password blob';
  if (kind === 'identity-context') {
    active.APP.identity.livenet.pub = 'one';
    source.APP.identity.livenet.pub = 'two';
  }
  if (kind === 'gift-context')
    source.SHOP.giftCards.livenet[0].invoiceId = 'other';
  if (kind === 'readonly')
    source.WALLET.keys.watch = {
      properties: {},
      readOnly: true,
      wallets: [{id: 'watch', credentials: {xPubKey: 'public'}}],
    };
  if (kind === 'associations') {
    active.WALLET.keys.readonly.wallets = [
      {id: 'same', credentials: {xPubKey: 'public-one'}},
    ];
    source.WALLET.keys.readonly.wallets = [
      {id: 'same', credentials: {xPubKey: 'public-two'}},
    ];
  }
  const live = await save(active);
  const old = await save(source);
  root.set('persist:root', live);
  mockAsync.set('persist:root', old);
  restart();
  await expect(migrateVault(root).then(() => undefined)).rejects.toThrow(
    'SOURCE_CONFLICT',
  );
  noWrites();
  expect(
    root.getString('persist:root') === live &&
      mockAsync.get('persist:root') === old,
  ).toBe(true);
});
it.each(['identity', 'gift'])(
  'C: empty pending root imports %s-only protected material',
  async kind => {
    const source = emptyPending();
    if (kind === 'identity')
      source.APP.identity.livenet.priv = 'synthetic identity';
    else
      source.SHOP.giftCards.livenet = [
        {invoiceId: 'gift', pin: 'synthetic pin'},
      ];
    root.set('persist:root', await save(emptyPending()));
    mockAsync.set('persist:root', await save(source));
    const key = await migrateVault(root);
    same(await restore(root.getString('persist:root')!, key), source);
  },
);
it('C: an empty projection does not authorize losing read-only associations', async () => {
  const active = emptyPending();
  active.WALLET.keys.watch = {
    properties: {},
    readOnly: true,
    wallets: [{id: 'watch', credentials: {xPubKey: 'public-watch'}}],
  };
  root.set('persist:root', await save(active));
  mockAsync.set('persist:root', await save(payload()));
  restart();
  await expect(migrateVault(root).then(() => undefined)).rejects.toThrow(
    'SOURCE_CONFLICT',
  );
  noWrites();
});
it('C: a selected recovery copy covering AsyncStorage keeps its distinct newer contents', async () => {
  const state: any = payload();
  state.BITPAY_ID.apiToken = 'newer';
  seedFile(VAULT_BACKUP, await save(state));
  mockAsync.set('persist:root', await save(payload()));
  const key = await migrateVault(root);
  expect(root.contains('persist:root')).toBe(false);
  same(await restore(mockFiles.get(VAULT_BACKUP)!, key), state);
  expect(mockAsync.has('persist:root')).toBe(false);
});
it.each([true, false])(
  'C: pending import source deletion failure retries without old importer overwrite (cache=%s)',
  async cache => {
    const empty = await save(emptyPending());
    root.set('persist:root', empty);
    if (cache) seedFile(VAULT_BACKUP, empty);
    const raw = await save(payload(), legacyKey, 'whole');
    mockAsync.set('persist:root', raw);
    (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(
      new Error('delete failed'),
    );
    const key = await migrateVault(root);
    expect(complete()).toBe(false);
    expect(mockAsync.get('persist:root') === raw).toBe(true);
    same(
      (await restore(root.getString('persist:root')!, key)).WALLET,
      payload().WALLET,
    );
    const dispatch = jest.fn();
    await (startMigrationMMKVStorage() as any)(dispatch, () => ({}));
    expect(dispatch).toHaveBeenCalledWith(setMigrationMMKVStorageComplete());
    expect(AsyncStorage.multiRemove).not.toHaveBeenCalled();
    restart();
    await migrateVault(root);
    expect(complete()).toBe(true);
  },
);
it('D: unreadable legacy service is a candidate-read exception and unresolved retirement', async () => {
  await seed();
  const get = Keychain.getGenericPassword as jest.Mock;
  const implementation = get.getMockImplementation()!;
  get.mockImplementation(async options => {
    if (options.service === LEGACY_KEY_SERVICE)
      throw new Error('private sentinel');
    return implementation(options);
  });
  try {
    let key: string | undefined;
    for (let i = 0; i < 3; i++) {
      restart();
      const next = await migrateVault(root);
      if (key) expect(next === key).toBe(true);
      key = next;
      expect(complete()).toBe(false);
      same(
        (await restore(root.getString('persist:root')!, next)).WALLET,
        payload().WALLET,
      );
    }
  } finally {
    get.mockImplementation(implementation);
  }
  restart();
  await migrateVault(root);
  expect(complete()).toBe(true);
});
it('D: a wrong read-only identifier candidate and unreadable old service cannot modify sources', async () => {
  root.set('persist:root', await save(payload(), 'other legacy candidate'));
  (Keychain.getGenericPassword as jest.Mock)
    .mockResolvedValueOnce(false)
    .mockRejectedValueOnce(new Error('unreadable'));
  restart();
  await expect(migrateVault(root).then(() => undefined)).rejects.toThrow(
    'INVALID_LEGACY_INPUT',
  );
  noWrites();
});
it('D: failed new-key verification still stops after an unreadable legacy service', async () => {
  await seed();
  const get = Keychain.getGenericPassword as jest.Mock;
  get
    .mockResolvedValueOnce(false)
    .mockRejectedValueOnce(new Error('legacy read'))
    .mockRejectedValueOnce(new Error('versioned read-back'));
  const before = root.getString('persist:root');
  await expect(migrateVault(root).then(() => undefined)).rejects.toThrow(
    'NEW_KEY_VERIFICATION',
  );
  expect(root.getString('persist:root') === before).toBe(true);
  expect(record.contains(VAULT_RECORD_KEY)).toBe(false);
  expect(mockWrites.every(write => write === 'keychain:set')).toBe(true);
});
it.each([false, true])(
  'E: optional promotion defers three launches then succeeds (primary changes=%s)',
  async changed => {
    const key = crypto.randomBytes(32).toString('base64');
    seedKey(VAULT_KEY_SERVICE, key);
    let current: any = payload();
    root.set('persist:root', await save(current, key, 'modern'));
    restart();
    const move = RNFS.moveFile as jest.Mock;
    const implementation = move.getMockImplementation()!;
    move.mockImplementation(async (from, to) => {
      if (to === VAULT_BACKUP) throw new Error('persistent move failure');
      return implementation(from, to);
    });
    try {
      for (let i = 0; i < 3; i++) {
        if (changed && i === 1) {
          current = {
            ...payload(),
            BITPAY_ID: {apiToken: 'legitimate new primary'},
          };
          root.set('persist:root', await save(current, key, 'modern'));
        }
        restart();
        await migrateVault(root);
        expect(complete()).toBe(false);
        expect(mockFiles.has(migrationTemp(VAULT_BACKUP))).toBe(true);
        expect(mockWrites.some(w => w.endsWith(':trim'))).toBe(false);
        same(await restore(root.getString('persist:root')!, key), current);
      }
    } finally {
      move.mockImplementation(implementation);
    }
    restart();
    await migrateVault(root);
    expect(complete()).toBe(true);
    expect(mockFiles.has(migrationTemp(VAULT_BACKUP))).toBe(false);
    same(await restore(root.getString('persist:root')!, key), current);
  },
);
it.each(['sole', 'distinct'])(
  'E: %s temp promotion is required and not silently deferred',
  async kind => {
    const key = crypto.randomBytes(32).toString('base64');
    seedKey(VAULT_KEY_SERVICE, key);
    if (kind === 'distinct')
      root.set('persist:root', await save(payload(), key, 'modern'));
    const older = {
      ...payload(),
      BITPAY_ID: {apiToken: 'distinct required snapshot'},
    };
    const path = kind === 'sole' ? VAULT_BACKUP : VAULT_OLDER_BACKUP;
    seedFile(migrationTemp(path), await save(older, key, 'modern'));
    restart();
    const move = RNFS.moveFile as jest.Mock;
    const implementation = move.getMockImplementation()!;
    move.mockRejectedValue(new Error('persistent promotion failure'));
    try {
      for (let i = 0; i < 3; i++) {
        await expect(migrateVault(root).then(() => undefined)).rejects.toThrow(
          'REQUIRED_COPY_FAILURE',
        );
        expect(mockFiles.has(migrationTemp(path))).toBe(true);
        expect(complete()).toBe(false);
      }
    } finally {
      move.mockImplementation(implementation);
    }
    await migrateVault(root);
    expect(complete()).toBe(true);
    same((await restore(mockFiles.get(path)!, key)).BITPAY_ID, older.BITPAY_ID);
  },
);
it('F: branch-only plaintext PORTFOLIO_CHARTS fails read-only with a fixed code', async () => {
  const raw = JSON.parse(await save(payload()));
  raw.PORTFOLIO_CHARTS = JSON.stringify(JSON.stringify({byWallet: {}}));
  root.set('persist:root', JSON.stringify(raw));
  restart();
  await expect(migrateVault(root).then(() => undefined)).rejects.toThrow(
    'UNSUPPORTED_FORMAT',
  );
  noWrites();
});
it('F: missing modern key takes priority over unsupported branch-only plaintext', async () => {
  const raw = JSON.parse(
    await save(payload(), crypto.randomBytes(32).toString('base64'), 'modern'),
  );
  raw.PORTFOLIO_CHARTS = JSON.stringify(JSON.stringify({byWallet: {}}));
  root.set('persist:root', JSON.stringify(raw));
  restart();
  await expect(migrateVault(root).then(() => undefined)).rejects.toThrow(
    'MODERN_KEY_FAILURE',
  );
  noWrites();
});

it('A: rejected filler allocation plus cache purge keeps the migrated primary usable', async () => {
  const key = crypto.randomBytes(32).toString('base64');
  seedKey(VAULT_KEY_SERVICE, key);
  root.set('persist:root', await save(payload(), key, 'modern'));
  root.set('persist:logs', '[]');
  seedKey(LEGACY_KEY_SERVICE, legacyKey);
  const model = (root as any).model;
  model.rejectGrowth = true;
  for (let launch = 0; launch < 3; launch++) {
    restart();
    await migrateVault(root);
    expect(complete()).toBe(false);
    same(
      (await restore(root.getString('persist:root')!, key)).WALLET,
      payload().WALLET,
    );
    expect(root.getString('persist:logs')).toBe('[]');
    expect(mockCredentials.has(LEGACY_KEY_SERVICE)).toBe(true);
    mockFiles.clear();
    mockDirs.clear(); // modeled OS cache purge, never a primary clear
  }
  model.rejectGrowth = false;
  await migrateVault(root);
  expect(complete()).toBe(true);
});
it('A: backup prerequisite exists before first trim, and primary remains present while stat is pending', async () => {
  await seed();
  let release!: (v: any) => void;
  let entered!: () => void;
  const pending = new Promise<void>(resolve => {
    entered = resolve;
  });
  (RNFS.stat as jest.Mock).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        release = resolve;
        entered();
      }),
  );
  const attempt = migrateVault(root);
  await pending;
  const key = mockCredentials.get(VAULT_KEY_SERVICE).password;
  same(
    (await restore(root.getString('persist:root')!, key)).WALLET,
    payload().WALLET,
  );
  same(
    (await restore(mockFiles.get(VAULT_BACKUP)!, key)).WALLET,
    payload().WALLET,
  );
  expect(complete()).toBe(false);
  expect(migrateVault(root) === attempt).toBe(true);
  mockDead = true;
  release({isFile: () => true, size: mockModels.get('default')!.bytes.length});
  await expect(attempt.then(() => undefined)).rejects.toThrow();
  restart();
  await migrateVault(root);
  expect(complete()).toBe(true);
});
it.each(
  (['stat', 'backup'] as const).flatMap(boundary =>
    (['missing', 'invalid', 'changed', 'unchanged'] as const).map(state => ({
      boundary,
      state,
    })),
  ),
)(
  'A: backup-check ordering with $state primary during $boundary and no AsyncStorage source',
  async ({boundary, state}) => {
    await seed();
    expect(mockAsync.size).toBe(0);
    const stat = RNFS.stat as jest.Mock;
    const exists = RNFS.exists as jest.Mock;
    const originalStat = stat.getMockImplementation()!;
    const originalExists = exists.getMockImplementation()!;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const pending = new Promise<void>(resolve => {
      entered = resolve;
    });
    let measuring = false;
    stat.mockImplementationOnce(async () => {
      measuring = true;
      if (boundary === 'stat') {
        entered();
        await gate;
      }
      return originalStat();
    });
    exists.mockImplementation(async (path: string) => {
      if (boundary === 'backup' && measuring && path === VAULT_BACKUP) {
        measuring = false;
        entered();
        await gate;
      }
      return originalExists(path);
    });
    // Consume the rejection immediately without exposing the returned vault key.
    const attempt = migrateVault(root).then(
      () => ({status: 'resolved'}),
      error => ({status: 'rejected', ...getVaultDiagnostic(error)}),
    );
    try {
      await pending;
      const key = mockCredentials.get(VAULT_KEY_SERVICE).password;
      expect(mockFiles.has(VAULT_BACKUP)).toBe(true);
      const expected = payload();
      if (state === 'missing') root.delete('persist:root');
      if (state === 'invalid') root.set('persist:root', 'invalid root');
      if (state === 'changed') {
        expected.WALLET.keys.readonly.properties.xPrivKey =
          'new signing material';
        root.set('persist:root', await save(expected, key, 'modern'));
      }
      const currentRoot = root.getString('persist:root');
      mockFiles.delete(VAULT_BACKUP);
      const writesBeforeResume = mockWrites.length;
      release();
      const unsafe = state === 'missing' || state === 'invalid';
      expect(await attempt).toEqual(
        unsafe
          ? {status: 'rejected', code: 'PRESERVATION_FAILURE', phase: 'scrub'}
          : {status: 'resolved'},
      );
      expect(mockWrites.slice(writesBeforeResume)).toEqual([]);
      expect(root.getString('persist:root') === currentRoot).toBe(true);
      expect(root.getString('persist:logs')).toBe('[]');
      expect(JSON.parse(record.getString(VAULT_RECORD_KEY)!)).toMatchObject({
        status: 'started',
        wipeDone: false,
      });
      expect(mockCredentials.has(LEGACY_KEY_SERVICE)).toBe(true);
      expect(Keychain.resetGenericPassword).not.toHaveBeenCalled();
      expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
      if (!unsafe) {
        same(await restore(currentRoot!, key), expected);
        restart();
        await migrateVault(root);
        expect(complete()).toBe(true);
        same(await restore(root.getString('persist:root')!, key), expected);
      }
    } finally {
      release();
      await attempt;
      stat.mockImplementation(originalStat);
      exists.mockImplementation(originalExists);
    }
  },
);
it('A/C: a valid newer primary during stat is never rolled back and cannot authorize stale AsyncStorage deletion', async () => {
  await seed();
  mockAsync.set('persist:root', await save(payload()));
  let changedRaw = '';
  (RNFS.stat as jest.Mock).mockImplementationOnce(async () => {
    const key = mockCredentials.get(VAULT_KEY_SERVICE).password;
    const changed: any = payload();
    changed.WALLET.keys.readonly.properties.xPrivKey = 'new signing material';
    changedRaw = await save(changed, key, 'modern');
    root.set('persist:root', changedRaw);
    return {isFile: () => true, size: (root as any).model.bytes.length};
  });
  await expect(migrateVault(root).then(() => undefined)).rejects.toThrow(
    'SOURCE_CONFLICT',
  );
  expect(root.getString('persist:root') === changedRaw).toBe(true);
  expect(mockAsync.has('persist:root')).toBe(true);
  expect(complete()).toBe(false);
});
it.each(['current', 'older', 'none', 'async'])(
  'A1: modeled native loss during the earlier migrated-root write reports actual surviving source: %s',
  async recovery => {
    const current: any = payload();
    current.WALLET.keys.newer = {
      id: 'newer',
      properties: {xPrivKey: 'newly added protected material'},
      wallets: [],
    };
    const oldRaw = await save(current);
    root.set('persist:root', oldRaw);
    root.set('persist:logs', '[]');
    seedKey(LEGACY_KEY_SERVICE, legacyKey);
    if (recovery === 'current') seedFile(VAULT_BACKUP, oldRaw);
    if (recovery === 'older') seedFile(VAULT_BACKUP, await save(payload()));
    if (recovery === 'async') mockAsync.set('persist:root', oldRaw);
    const set = root.set.bind(root);
    const spy = jest.spyOn(root, 'set').mockImplementation((key, value) => {
      if (key === 'persist:root') {
        // Native-compaction loss model, distinct from rejected-call atomicity.
        mockStores.get('default')!.clear();
        mockModels.delete('default');
        mockDead = true;
        throw new Error('killed inside compaction');
      }
      set(key, value);
    });
    try {
      await expect(migrateVault(root).then(() => undefined)).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    restart();
    const key = await migrateVault(root);
    const raw = root.getString('persist:root') ?? mockFiles.get(VAULT_BACKUP);
    if (recovery === 'none') {
      // Explicit bounded residual: no current scrub backup was ever prepared.
      // There is no usable surviving local source, even without cache purge.
      expect(raw === undefined && mockAsync.size === 0).toBe(true);
    } else {
      const state = await restore(raw!, key);
      expect(!!state.WALLET.keys.newer).toBe(recovery !== 'older');
      expect(!!state.WALLET.keys.readonly).toBe(true);
      if (recovery === 'async')
        expect(mockAsync.has('persist:root')).toBe(false);
    }
  },
);
it.each([false, true])(
  'A1: modeled inside-scrub compaction loss uses current backup, with separate purge residual (purge=%s)',
  async purge => {
    await seed();
    const trim = (root as any).trim.bind(root);
    let killed = false;
    const spy = jest.spyOn(root, 'trim').mockImplementation(() => {
      if (!killed) {
        killed = true;
        expect(mockFiles.has(VAULT_BACKUP)).toBe(true);
        mockStores.get('default')!.clear();
        mockModels.delete('default');
        mockDead = true;
        throw new Error('native kill');
      }
      trim();
    });
    try {
      await expect(migrateVault(root).then(() => undefined)).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    if (purge) {
      mockFiles.clear();
      mockDirs.clear();
    }
    restart();
    const key = await migrateVault(root);
    const raw = root.getString('persist:root') ?? mockFiles.get(VAULT_BACKUP);
    if (purge) expect(raw).toBeUndefined();
    else same((await restore(raw!, key)).WALLET, payload().WALLET);
  },
);

it('E: a valid target does not authorize deleting an unmarked distinct recovery temp', async () => {
  const key = crypto.randomBytes(32).toString('base64');
  seedKey(VAULT_KEY_SERVICE, key);
  root.set('persist:root', await save(payload(), key, 'modern'));
  seedFile(
    VAULT_BACKUP,
    await save({...payload(), BITPAY_ID: {apiToken: 'target'}}, key, 'modern'),
  );
  seedFile(
    migrationTemp(VAULT_BACKUP),
    await save(
      {...payload(), BITPAY_ID: {apiToken: 'distinct temp'}},
      key,
      'modern',
    ),
  );
  restart();
  await expect(migrateVault(root).then(() => undefined)).rejects.toThrow(
    'SOURCE_CONFLICT',
  );
  noWrites();
  expect(mockFiles.has(migrationTemp(VAULT_BACKUP))).toBe(true);
});
it('E: optional Android partial-target promotion and deletion failure stays deferrable across retries', async () => {
  const key = crypto.randomBytes(32).toString('base64');
  seedKey(VAULT_KEY_SERVICE, key);
  root.set('persist:root', await save(payload(), key, 'modern'));
  const move = RNFS.moveFile as jest.Mock,
    unlink = RNFS.unlink as jest.Mock;
  const moving = move.getMockImplementation()!,
    deleting = unlink.getMockImplementation()!;
  move.mockImplementation(async (from, to) => {
    if (to === VAULT_BACKUP) {
      mockFiles.set(to, '{"partial":');
      throw new Error('copy fallback failed');
    }
    return moving(from, to);
  });
  try {
    await migrateVault(root);
    expect(complete()).toBe(false);
    expect(mockFiles.has(migrationTemp(VAULT_BACKUP))).toBe(true);
    unlink.mockImplementation(async path => {
      if (path === VAULT_BACKUP) throw new Error('delete denied');
      return deleting(path);
    });
    for (let i = 0; i < 3; i++) {
      restart();
      await migrateVault(root);
      expect(complete()).toBe(false);
      expect(mockWrites.some(w => w.endsWith(':trim'))).toBe(false);
      same(
        (await restore(root.getString('persist:root')!, key)).WALLET,
        payload().WALLET,
      );
      expect(mockFiles.has(migrationTemp(VAULT_BACKUP))).toBe(true);
    }
  } finally {
    move.mockImplementation(moving);
    unlink.mockImplementation(deleting);
  }
  await migrateVault(root);
  expect(complete()).toBe(true);
});
it('E: verification errors in optional refresh preserve the primary across three launches', async () => {
  const key = crypto.randomBytes(32).toString('base64');
  seedKey(VAULT_KEY_SERVICE, key);
  root.set('persist:root', await save(payload(), key, 'modern'));
  const move = RNFS.moveFile as jest.Mock;
  const implementation = move.getMockImplementation()!;
  move.mockImplementation(async (from, to) => {
    await implementation(from, to);
    if (to === VAULT_BACKUP) mockFiles.set(to, '{"incomplete":');
  });
  try {
    for (let i = 0; i < 3; i++) {
      restart();
      await migrateVault(root);
      expect(complete()).toBe(false);
      expect(mockWrites.some(w => w.endsWith(':trim'))).toBe(false);
      same(
        (await restore(root.getString('persist:root')!, key)).WALLET,
        payload().WALLET,
      );
    }
  } finally {
    move.mockImplementation(implementation);
  }
  await migrateVault(root);
  expect(complete()).toBe(true);
});
it('D/F: a modern field hidden inside CBC is detected without trying identifier-based GCM decryption', async () => {
  const encryption = require('./transforms/encrypt');
  const spy = jest.spyOn(encryption, 'decryptValue');
  try {
    const modernKey = crypto.randomBytes(32).toString('base64');
    const state: any = payload();
    state.WALLET.keys.readonly.properties.xPrivKey = encryption.encryptValue(
      'synthetic modern secret',
      modernKey,
      'WALLET.keys.readonly.properties.xPrivKey',
    );
    root.set('persist:root', await save(state, legacyKey, 'whole'));
    restart();
    await expect(migrateVault(root).then(() => undefined)).rejects.toThrow(
      'MODERN_KEY_FAILURE',
    );
    noWrites();
    expect(
      spy.mock.calls.some(
        ([value, key]: any[]) =>
          String(value).startsWith('field-aesgcm-v1:') && key === legacyKey,
      ),
    ).toBe(false);
  } finally {
    spy.mockRestore();
  }
});

it('F: native/parser/user-key sentinels stay out of deferred logs and startup reporting', async () => {
  const sentinel = 'PRIVATE_SENTINEL_NEVER_REPORT';
  const Sentry = require('@sentry/react-native');
  const capture = jest
    .spyOn(Sentry, 'captureException')
    .mockImplementation(() => undefined);
  const {reportVaultStartupFailure} = require('./vault-diagnostics');
  try {
    await seed();
    root.set(sentinel, true);
    const logs: string[] = [];
    await migrateVault(root, m => logs.push(m));
    expect(logs.some(m => m.includes('UNKNOWN_STORAGE_KEY'))).toBe(true);
    expect(logs.join('').includes(sentinel)).toBe(false);
    mockStores.clear();
    mockCredentials.clear();
    mockFiles.clear();
    mockDirs.clear();
    restart();
    root.set('persist:root', '{"' + sentinel + '":');
    restart();
    try {
      await migrateVault(root);
    } catch (parserFailure) {
      reportVaultStartupFailure(parserFailure);
    }
    const nativeFailure = new Error(sentinel);
    (nativeFailure as any).cause = {nativePath: sentinel, snapshot: sentinel};
    (Keychain.getGenericPassword as jest.Mock).mockRejectedValueOnce(
      nativeFailure,
    );
    try {
      await migrateVault(root);
    } catch (startupFailure) {
      reportVaultStartupFailure(startupFailure);
    }
    expect(capture).toHaveBeenCalledTimes(2);
    const reports = capture.mock.calls.map(([e, options]: any[]) => ({
      message: e.message,
      stack: e.stack,
      ...e,
      options,
    }));
    expect(JSON.stringify(reports).includes(sentinel)).toBe(false);
    expect(reports.map((r: any) => r.options.tags.vaultCode)).toEqual([
      'INVALID_LEGACY_INPUT',
      'MODERN_KEY_FAILURE',
    ]);
  } finally {
    capture.mockRestore();
  }
});

it('D: public CBC marker text in a modern snapshot never requests a device-ID candidate', async () => {
  const key = crypto.randomBytes(32).toString('base64');
  seedKey(VAULT_KEY_SERVICE, key);
  const state: any = payload();
  state.WALLET.keys.readonly.name = 'U2FsdGVkX1 public wallet label';
  root.set('persist:root', await save(state, key, 'modern'));
  restart();
  await migrateVault(root);
  expect(
    require('react-native-device-info').getUniqueId,
  ).not.toHaveBeenCalled();
});

it('C: mutable wallet display metadata does not roll back an authoritative snapshot', async () => {
  const active: any = payload(),
    old: any = payload();
  active.WALLET.keys.readonly.wallets = [
    {
      id: 'wallet',
      credentials: {
        walletId: 'wallet',
        xPubKey: 'same public key',
        walletName: 'new name',
      },
      balance: {total: 2},
    },
  ];
  old.WALLET.keys.readonly.wallets = [
    {
      id: 'wallet',
      credentials: {
        walletId: 'wallet',
        xPubKey: 'same public key',
        walletName: 'old name',
      },
      balance: {total: 1},
    },
  ];
  root.set('persist:root', await save(active));
  mockAsync.set('persist:root', await save(old));
  const key = await migrateVault(root);
  same(
    (await restore(root.getString('persist:root')!, key)).WALLET,
    active.WALLET,
  );
  expect(mockAsync.has('persist:root')).toBe(false);
});

it.each([false, true, undefined])(
  'C: an invalid AsyncStorage copy is not disposable beside empty active state (flag=%s)',
  async flag => {
    root.set('persist:root', await save(emptyPending(flag)));
    const raw = await save(payload(), 'wrong identifier');
    mockAsync.set('persist:root', raw);
    restart();
    await expect(migrateVault(root).then(() => undefined)).rejects.toThrow(
      'INVALID_LEGACY_INPUT',
    );
    noWrites();
    expect(mockAsync.get('persist:root') === raw).toBe(true);
  },
);
it('C: an authoritative superset keeps newer signing material as well as all older material', async () => {
  const active: any = payload();
  active.WALLET.keys.added = {
    properties: {xPrivKey: 'new protected material'},
    wallets: [],
  };
  root.set('persist:root', await save(active));
  mockAsync.set('persist:root', await save(payload()));
  const key = await migrateVault(root);
  same(
    (await restore(root.getString('persist:root')!, key)).WALLET,
    active.WALLET,
  );
  expect(mockAsync.has('persist:root')).toBe(false);
});
it.each([undefined, false, true])(
  'C: empty-state flag %s does not override preservation policy',
  async flag => {
    root.set('persist:root', await save(emptyPending(flag)));
    mockAsync.set('persist:root', await save(payload()));
    restart();
    if (flag === true) {
      await expect(migrateVault(root).then(() => undefined)).rejects.toThrow(
        'SOURCE_CONFLICT',
      );
      noWrites();
      expect(mockAsync.has('persist:root')).toBe(true);
    } else {
      const key = await migrateVault(root);
      same(
        (await restore(root.getString('persist:root')!, key)).WALLET,
        payload().WALLET,
      );
    }
  },
);
it('E: an old started record without refresh metadata safely retries an equivalent optional temp', async () => {
  const key = crypto.randomBytes(32).toString('base64');
  seedKey(VAULT_KEY_SERVICE, key);
  const state: any = payload();
  delete state.MARKET_STATS;
  const raw = await save(state, key, 'modern');
  root.set('persist:root', raw);
  seedFile(migrationTemp(VAULT_BACKUP), raw);
  record.set(
    VAULT_RECORD_KEY,
    JSON.stringify({status: 'started', wipeDone: false}),
  );
  const move = RNFS.moveFile as jest.Mock,
    implementation = move.getMockImplementation()!;
  move.mockRejectedValue(new Error('persistent move failure'));
  try {
    for (let i = 0; i < 3; i++) {
      await migrateVault(root);
      expect(complete()).toBe(false);
      expect(root.getString('persist:root') === raw).toBe(true);
    }
  } finally {
    move.mockImplementation(implementation);
  }
  await migrateVault(root);
  expect(complete()).toBe(true);
});

it.each(['xPrivKeyEDDSA', 'xPrivKeyEDDSAEncrypted'])(
  'B/A: the unwrapped %s exception rejects arbitrary short plaintext',
  async field => {
    const f = require('../../test/vault/fixtures/legacy-14.32.json').cases
      .plain;
    const raw = JSON.parse(f.raw);
    const wallet = JSON.parse(JSON.parse(raw.WALLET));
    wallet.keys.fixture.properties[field] = 'abc';
    raw.WALLET = JSON.stringify(JSON.stringify(wallet));
    root.set('persist:root', JSON.stringify(raw));
    restart();
    await expect(migrateVault(root).then(() => undefined)).rejects.toThrow(
      'INVALID_LEGACY_INPUT',
    );
    noWrites();
  },
);

it('B/D: synthetic opaque password metadata containing a public marker is not a GCM envelope', async () => {
  const f = require('../../test/vault/fixtures/legacy-14.32.json').cases
    .constructorPassword;
  const raw = JSON.parse(f.raw);
  const wallet = JSON.parse(JSON.parse(raw.WALLET));
  const blob = JSON.parse(
    wallet.keys.fixture.properties.xPrivKeyEDDSAEncrypted,
  );
  // Deliberately synthetic opaque metadata: no claim this modified inner tag is valid.
  blob.adata = 'field-aesgcm-v1: public metadata';
  const opaque = JSON.stringify(blob);
  wallet.keys.fixture.properties.xPrivKeyEDDSAEncrypted = opaque;
  raw.WALLET = JSON.stringify(JSON.stringify(wallet));
  root.set('persist:root', JSON.stringify(raw));
  const key = await migrateVault(root);
  expect(
    (await restore(root.getString('persist:root')!, key)).WALLET.keys.fixture
      .properties.xPrivKeyEDDSAEncrypted === opaque,
  ).toBe(true);
});

it('E: optional provenance cannot discard protected material no longer covered by the primary', async () => {
  const key = crypto.randomBytes(32).toString('base64');
  seedKey(VAULT_KEY_SERVICE, key);
  root.set('persist:root', await save(payload(), key, 'modern'));
  const move = RNFS.moveFile as jest.Mock,
    implementation = move.getMockImplementation()!;
  move.mockRejectedValue(new Error('move failed'));
  try {
    await migrateVault(root);
    expect(complete()).toBe(false);
    const changed: any = payload();
    changed.WALLET.keys = {};
    const changedRaw = await save(changed, key, 'modern');
    root.set('persist:root', changedRaw);
    restart();
    await expect(migrateVault(root).then(() => undefined)).rejects.toThrow(
      'REQUIRED_COPY_FAILURE',
    );
    expect(root.getString('persist:root') === changedRaw).toBe(true);
    expect(mockFiles.has(migrationTemp(VAULT_BACKUP))).toBe(true);
  } finally {
    move.mockImplementation(implementation);
  }
});
it('F: a malformed record is classified without leaking parser input or claiming key loss', async () => {
  record.set(VAULT_RECORD_KEY, '{"PRIVATE_RECORD_SENTINEL":');
  restart();
  let failure: unknown;
  try {
    await migrateVault(root);
  } catch (error) {
    failure = error;
  }
  const {vaultDiagnostic} = require('./vault-diagnostics');
  expect(vaultDiagnostic(failure)).toEqual({
    code: 'PRESERVATION_FAILURE',
    phase: 'inventory',
  });
  expect(String(failure).includes('PRIVATE_RECORD_SENTINEL')).toBe(false);
  noWrites();
});

it('F: malformed serialized reducer names cannot manufacture an inherited persistence marker', async () => {
  const raw: any = Object.create(null);
  Object.defineProperty(raw, '__proto__', {
    enumerable: true,
    value: JSON.stringify(
      Aes.encrypt(
        JSON.stringify({
          _persist: {version: -1, rehydrated: true},
          WALLET: payload().WALLET,
        }),
        legacyKey,
      ).toString(),
    ),
  });
  const input = JSON.stringify(raw);
  root.set('persist:root', input);
  restart();
  await expect(migrateVault(root).then(() => undefined)).rejects.toThrow(
    'INVALID_LEGACY_INPUT',
  );
  noWrites();
  expect(root.getString('persist:root') === input).toBe(true);
});

it('F: completed-startup rehydration sends one sanitized error through the actual logging/Sentry boundary', async () => {
  const key = crypto.randomBytes(32).toString('base64');
  seedKey(VAULT_KEY_SERVICE, key);
  record.set(
    VAULT_RECORD_KEY,
    JSON.stringify({status: 'complete', wipeDone: true}),
  );
  const raw = JSON.parse(await save(payload(), key, 'modern'));
  const wallet = JSON.parse(JSON.parse(raw.WALLET));
  wallet.keys.PRIVATE_CONTEXT_SENTINEL = wallet.keys.readonly;
  delete wallet.keys.readonly;
  wallet.keys.PRIVATE_CONTEXT_SENTINEL.properties.mnemonic =
    'unwrapped PRIVATE_VALUE_SENTINEL';
  raw.WALLET = JSON.stringify(JSON.stringify(wallet));
  root.set('persist:root', JSON.stringify(raw));
  const Sentry = require('@sentry/react-native');
  const capture = jest
    .spyOn(Sentry, 'captureException')
    .mockImplementation(() => undefined);
  const initLogs = require('./log/initLogs');
  const log = jest.spyOn(initLogs, 'add');
  const {reportVaultStartupFailure} = require('./vault-diagnostics');
  try {
    let failed = false;
    try {
      await require('./index').default();
    } catch (startupFailure) {
      failed = true;
      expect(capture).not.toHaveBeenCalled();
      reportVaultStartupFailure(startupFailure);
    }
    expect(failed).toBe(true);
    expect(capture).toHaveBeenCalledTimes(1);
    const safe = capture.mock.calls.map(([error, options]: any[]) => ({
      message: error.message,
      stack: error.stack,
      ...error,
      options,
    }));
    expect(
      JSON.stringify([safe, log.mock.calls]).includes(
        'PRIVATE_CONTEXT_SENTINEL',
      ),
    ).toBe(false);
    expect(
      JSON.stringify([safe, log.mock.calls]).includes('PRIVATE_VALUE_SENTINEL'),
    ).toBe(false);
    expect((safe[0] as any).options.tags.vaultCode).toBe(
      'PRESERVATION_FAILURE',
    );
  } finally {
    capture.mockRestore();
    log.mockRestore();
  }
});

// Android SQL/executor behavior is covered by the on-device production-helper
// harness. These tests exercise the real serialized migration/startup integration.
const rkBridge = () => {
  const bridge = {
    inspect: jest.fn(async () => 'PRESENT'),
    clean: jest.fn(async () => 'CLEANED'),
  };
  NativeModules.BitPayRKStorage = bridge;
  return bridge;
};
const rkCompletedVault = async () => {
  await seed();
  const key = await migrateVault(root);
  restart();
  return key;
};
const rkComplete = () =>
  record.getString(RKSTORAGE_RECORD_KEY) === 'complete-v1';
const rkInitializing = () =>
  JSON.parse(record.getString(VAULT_RECORD_KEY) ?? 'null')?.initializing ===
  true;
const rkRelaunch = (bridge: ReturnType<typeof rkBridge>) => {
  let prepare = prepareVault;
  jest.isolateModules(() => {
    const native = require('react-native');
    native.Platform.OS = 'android';
    native.NativeModules.BitPayRKStorage = bridge;
    prepare = require('./vault-rkstorage').prepareVault;
  });
  return prepare(root);
};

it.each(['same process', 'fresh modules'])(
  'RK: fresh initialization survives repeated %s retries before its first save',
  async kind => {
    const bridge = rkBridge();
    const key = await prepareVault(root);
    expect(complete()).toBe(true);
    for (let launch = 0; launch < 3; launch++) {
      restart();
      const next =
        kind === 'fresh modules'
          ? await rkRelaunch(bridge)
          : await prepareVault(root);
      expect(next === key).toBe(true);
      expect(root.contains('persist:root')).toBe(false);
      expect(rkComplete()).toBe(false);
      expect(rkInitializing()).toBe(true);
      expect(bridge.clean).not.toHaveBeenCalled();
      noWrites();
    }
  },
);

it('RK: every interrupted fresh migration boundary retains initialization provenance', async () => {
  const bridge = rkBridge();
  await prepareVault(root);
  const count = mockWrites.length;
  expect(count).toBeGreaterThan(3);
  for (let stop = 1; stop <= count; stop++) {
    mockStores.clear();
    mockModels.clear();
    mockCredentials.clear();
    mockFiles.clear();
    mockDirs.clear();
    restart();
    mockStopAt = stop;
    try {
      await prepareVault(root);
    } catch {}
    expect(mockDead).toBe(true);
    restart();
    const key = await rkRelaunch(bridge);
    expect(complete()).toBe(true);
    expect(rkInitializing()).toBe(true);
    expect((await rkRelaunch(bridge)) === key).toBe(true);
    expect(root.contains('persist:root')).toBe(false);
    expect(rkComplete()).toBe(false);
  }
  expect(bridge.clean).not.toHaveBeenCalled();
});

it.each(['BUSY', 'IO_DEFERRED', 'UNSUPPORTED', 'missing bridge'])(
  'RK: fresh initialization remains retryable after %s inventory',
  async outcome => {
    const bridge = rkBridge();
    if (outcome === 'missing bridge') delete NativeModules.BitPayRKStorage;
    else bridge.inspect.mockResolvedValue(outcome);
    const key = await prepareVault(root);
    expect((await prepareVault(root)) === key).toBe(true);
    expect(rkInitializing()).toBe(true);
    expect(rkComplete()).toBe(false);
    expect(bridge.clean).not.toHaveBeenCalled();
  },
);

it('RK: ordinary first save retires provenance before any later startup', async () => {
  const bridge = rkBridge();
  const key = await prepareVault(root);
  const raw = await save(payload(), key, 'modern');
  // Keep the existing optional backup policy out of this primary-save test.
  const backup = jest
    .spyOn(require('./backup/fs-backup'), 'backupFileExists')
    .mockResolvedValue(true);
  try {
    await reduxStorage.setItem('persist:root', raw);
    expect(root.getString('persist:root') === raw).toBe(true);
    expect(rkInitializing()).toBe(false);
    expect(complete()).toBe(true);
    expect(rkComplete()).toBe(false);
    restart();
    await reduxStorage.setItem('persist:root', raw);
    expect(mockWrites).toEqual(['mmkv:default:set:persist:root']);
    // Even before a second startup/cleanup, this is now an established save.
    root.delete('persist:root');
    mockFiles.clear();
    await expect(rkRelaunch(bridge)).rejects.toThrow('PRESERVATION_FAILURE');
    expect(bridge.clean).not.toHaveBeenCalled();
  } finally {
    backup.mockRestore();
  }
});

it.each([1, 2])(
  'RK: restart after first-save state change %s verifies the root and retires provenance',
  async stop => {
    const bridge = rkBridge();
    const key = await prepareVault(root);
    const raw = await save(payload(), key, 'modern');
    restart();
    mockStopAt = stop;
    try {
      root.set('persist:root', raw);
      recordVaultInitializationSave(root, 'persist:root', raw);
    } catch {}
    expect(mockDead).toBe(true);
    restart();
    // Exercise retirement even when native maintenance cannot proceed yet.
    bridge.inspect.mockResolvedValueOnce('BUSY');
    expect((await rkRelaunch(bridge)) === key).toBe(true);
    expect(root.getString('persist:root') === raw).toBe(true);
    expect(rkInitializing()).toBe(false);
    expect(rkComplete()).toBe(false);
    await rkRelaunch(bridge);
    expect(rkComplete()).toBe(true);
  },
);

it('RK: rejected first write does not retire initialization; rejected retirement preserves the root', async () => {
  const bridge = rkBridge();
  const key = await prepareVault(root);
  const raw = await save(payload(), key, 'modern');
  expect(() =>
    recordVaultInitializationSave(root, 'persist:root', raw),
  ).toThrow('PRESERVATION_FAILURE');
  expect(rkInitializing()).toBe(true);
  const original = MMKV.prototype.set;
  const backup = jest
    .spyOn(require('./backup/fs-backup'), 'backupFileExists')
    .mockResolvedValue(true);
  const rejected = jest.spyOn(MMKV.prototype, 'set').mockImplementation(() => {
    throw new Error('synthetic rejected allocation');
  });
  try {
    await reduxStorage.setItem('persist:root', raw);
    expect(root.contains('persist:root')).toBe(false);
    expect(rkInitializing()).toBe(true);
  } finally {
    rejected.mockRestore();
    backup.mockRestore();
  }
  expect((await prepareVault(root)) === key).toBe(true);
  root.set('persist:root', raw);
  const set = jest
    .spyOn(MMKV.prototype, 'set')
    .mockImplementation(function (this: MMKV, name, value) {
      if (name === VAULT_RECORD_KEY)
        throw new Error('synthetic record failure');
      return original.call(this, name, value);
    });
  try {
    expect(() =>
      recordVaultInitializationSave(root, 'persist:root', raw),
    ).toThrow();
    expect(root.getString('persist:root') === raw).toBe(true);
    expect(rkInitializing()).toBe(true);
    await expect(prepareVault(root)).rejects.toThrow('PRESERVATION_FAILURE');
    expect(bridge.clean).not.toHaveBeenCalled();
  } finally {
    set.mockRestore();
  }
  await rkRelaunch(bridge);
  expect(rkInitializing()).toBe(false);
  expect(rkComplete()).toBe(true);
});

it('RK: discovering a validated backup retires fresh provenance without inventing a root', async () => {
  const bridge = rkBridge();
  const key = await prepareVault(root);
  seedFile(VAULT_BACKUP, await save(payload(), key, 'modern'));
  bridge.inspect.mockResolvedValueOnce('BUSY');
  await rkRelaunch(bridge);
  expect(root.contains('persist:root')).toBe(false);
  expect(rkInitializing()).toBe(false);
  expect(rkComplete()).toBe(false);
  mockFiles.clear();
  await expect(rkRelaunch(bridge)).rejects.toThrow('PRESERVATION_FAILURE');
  expect(bridge.clean).not.toHaveBeenCalled();
});

it.each([false, 'true', 1, null])(
  'RK: invalid initialization provenance %s stops without native work',
  async initializing => {
    await prepareVault(root);
    record.set(
      VAULT_RECORD_KEY,
      JSON.stringify({status: 'complete', wipeDone: true, initializing}),
    );
    const bridge = rkBridge();
    restart();
    await expect(prepareVault(root)).rejects.toThrow('PRESERVATION_FAILURE');
    expect(bridge.inspect).not.toHaveBeenCalled();
    noWrites();
  },
);

it('RK: legacy credentials alone cannot establish fresh provenance', async () => {
  seedKey(LEGACY_KEY_SERVICE, legacyKey);
  const bridge = rkBridge();
  await expect(prepareVault(root)).rejects.toThrow('PRESERVATION_FAILURE');
  expect(rkInitializing()).toBe(false);
  expect(bridge.clean).not.toHaveBeenCalled();
});

it('RK: old completed installation runs once, without rekeying or MMKV scrub', async () => {
  const key = await rkCompletedVault();
  const bridge = rkBridge();
  expect((await prepareVault(root)) === key).toBe(true);
  expect(rkComplete()).toBe(true);
  expect(mockWrites).toEqual([
    `mmkv:${VAULT_RECORD_ID}:set:${RKSTORAGE_RECORD_KEY}`,
  ]);
  restart();
  await prepareVault(root);
  expect(bridge.inspect).toHaveBeenCalledTimes(1);
  expect(bridge.clean).toHaveBeenCalledTimes(1);
  noWrites();
});
it('RK: incomplete base migration cannot authorize SQLite cleanup', async () => {
  await seed();
  root.set('unknown-library-key', 'keep');
  const bridge = rkBridge();
  await prepareVault(root);
  expect(complete()).toBe(false);
  expect(rkComplete()).toBe(false);
  expect(bridge.inspect).not.toHaveBeenCalled();
});
it('RK: unfinished live import is preserved before physical cleanup', async () => {
  const empty = {
    APP: {migrationMMKVStorageComplete: false},
    WALLET: {keys: {}},
    _persist: {version: -1, rehydrated: true},
  };
  root.set('persist:root', await save(empty));
  seedFile(VAULT_BACKUP, await save(empty));
  mockAsync.set('persist:root', await save(payload()));
  const bridge = rkBridge();
  bridge.clean.mockImplementation(async () => {
    expect(complete()).toBe(true);
    expect(mockAsync.has('persist:root')).toBe(false);
    const key = mockCredentials.get(VAULT_KEY_SERVICE).password;
    same(
      (await restore(root.getString('persist:root')!, key)).WALLET,
      payload().WALLET,
    );
    return 'CLEANED';
  });
  await prepareVault(root);
  expect(rkComplete()).toBe(true);
});
it.each(['BUSY', 'IO_DEFERRED', 'UNSUPPORTED', 'CORRUPT', 'SIDECARS'])(
  'RK: %s remains pending, preserves active data, then retries',
  async result => {
    const key = await rkCompletedVault();
    const original = root.getString('persist:root');
    const bridge = rkBridge();
    bridge.clean.mockResolvedValueOnce(result);
    await prepareVault(root);
    expect(rkComplete()).toBe(false);
    expect(root.getString('persist:root') === original).toBe(true);
    expect(complete()).toBe(true);
    noWrites();
    await prepareVault(root);
    expect(rkComplete()).toBe(true);
    same(
      (await restore(root.getString('persist:root')!, key)).WALLET,
      payload().WALLET,
    );
  },
);
it.each(['missing', 'invalid', 'unreadable'])(
  'RK: %s versioned key stops before native access',
  async kind => {
    await rkCompletedVault();
    const bridge = rkBridge();
    const get = Keychain.getGenericPassword as jest.Mock;
    if (kind === 'missing') mockCredentials.delete(VAULT_KEY_SERVICE);
    if (kind === 'invalid') seedKey(VAULT_KEY_SERVICE, 'invalid');
    if (kind === 'unreadable')
      get.mockRejectedValueOnce(new Error('PRIVATE_NATIVE_SENTINEL'));
    await expect(prepareVault(root).then(() => undefined)).rejects.toThrow();
    expect(rkComplete()).toBe(false);
    expect(bridge.inspect).not.toHaveBeenCalled();
    noWrites();
  },
);
it.each(['stat', 'clean'])(
  'RK: lost primary plus failed %s check is a preservation stop',
  async boundary => {
    await rkCompletedVault();
    const bridge = rkBridge();
    const operation = boundary === 'stat' ? bridge.inspect : bridge.clean;
    operation.mockImplementationOnce(async () => {
      root.delete('persist:root');
      mockFiles.clear();
      return 'IO_DEFERRED';
    });
    await expect(prepareVault(root).then(() => undefined)).rejects.toThrow(
      'PRESERVATION_FAILURE',
    );
    expect(rkComplete()).toBe(false);
  },
);
it('RK: invalid active state is strict even when the bridge is unavailable', async () => {
  await rkCompletedVault();
  root.set('persist:root', 'invalid');
  await expect(prepareVault(root).then(() => undefined)).rejects.toThrow(
    'PRESERVATION_FAILURE',
  );
  expect(rkComplete()).toBe(false);
});
it.each(['CLEANED', 'IO_DEFERRED', 'LIFECYCLE_FAILURE'])(
  'RK: a changed valid primary across native %s is never rolled back',
  async result => {
    const key = await rkCompletedVault();
    const bridge = rkBridge();
    const changed = payload();
    changed.WALLET.keys.readonly.properties.xPrivKey = 'newer protected value';
    const raw = await save(changed, key, 'modern');
    bridge.clean.mockImplementationOnce(async () => {
      root.set('persist:root', raw);
      return result;
    });
    if (result === 'LIFECYCLE_FAILURE')
      await expect(prepareVault(root).then(() => undefined)).rejects.toThrow(
        'PRESERVATION_FAILURE',
      );
    else await prepareVault(root);
    expect(root.getString('persist:root') === raw).toBe(true);
    expect(rkComplete()).toBe(false);
  },
);
it.each(['LIVE_SOURCE', 'CLEANED'])(
  'RK: a late live source at %s is preserved and stops completion',
  async result => {
    await rkCompletedVault();
    const bridge = rkBridge();
    const live = await save(payload());
    bridge.clean.mockImplementationOnce(async () => {
      mockAsync.set('persist:root', live);
      return result;
    });
    await expect(prepareVault(root).then(() => undefined)).rejects.toThrow(
      'SOURCE_CONFLICT',
    );
    expect(mockAsync.get('persist:root') === live).toBe(true);
    expect(rkComplete()).toBe(false);
  },
);
it('RK: absent database requires no active snapshot and no SQL/AsyncStorage opening', async () => {
  const key = crypto.randomBytes(32).toString('base64');
  seedKey(VAULT_KEY_SERVICE, key);
  record.set(
    VAULT_RECORD_KEY,
    JSON.stringify({status: 'complete', wipeDone: true}),
  );
  const bridge = rkBridge();
  bridge.inspect.mockResolvedValue('ABSENT');
  jest.clearAllMocks();
  await prepareVault(root);
  expect(rkComplete()).toBe(true);
  expect(bridge.clean).not.toHaveBeenCalled();
  expect(AsyncStorage.getItem).not.toHaveBeenCalled();
});
it('RK: existing database without a surviving active source is not disposable', async () => {
  await rkCompletedVault();
  root.delete('persist:root');
  mockFiles.clear();
  const bridge = rkBridge();
  await expect(prepareVault(root).then(() => undefined)).rejects.toThrow(
    'PRESERVATION_FAILURE',
  );
  expect(bridge.clean).not.toHaveBeenCalled();
  expect(rkComplete()).toBe(false);
});
it('RK: fresh startup defers existing empty database until real persistence exists', async () => {
  const bridge = rkBridge();
  const key = await prepareVault(root);
  expect(complete()).toBe(true);
  expect(rkComplete()).toBe(false);
  expect(bridge.clean).not.toHaveBeenCalled();
  root.set('persist:root', await save(payload(), key, 'modern'));
  await prepareVault(root);
  expect(rkComplete()).toBe(true);
});
it('RK: validated backup-only active state is eligible without a fabricated MMKV root', async () => {
  const key = await rkCompletedVault();
  root.delete('persist:root');
  const bridge = rkBridge();
  await prepareVault(root);
  expect(bridge.clean).toHaveBeenCalledTimes(1);
  expect(rkComplete()).toBe(true);
  expect(root.contains('persist:root')).toBe(false);
  same(
    (await restore(mockFiles.get(VAULT_BACKUP)!, key)).WALLET,
    payload().WALLET,
  );
});
it('RK: simultaneous callers share startup and the native maintenance attempt', async () => {
  await rkCompletedVault();
  const bridge = rkBridge();
  const first = prepareVault(root);
  const second = prepareVault(root);
  expect(first === second).toBe(true);
  await Promise.all([first, second]);
  expect(bridge.clean).toHaveBeenCalledTimes(1);
});
it('RK: a failed marker write retries idempotently without resetting base completion', async () => {
  await rkCompletedVault();
  rkBridge();
  const original = MMKV.prototype.set;
  const set = jest
    .spyOn(MMKV.prototype, 'set')
    .mockImplementation(function (this: MMKV, key, value) {
      if (key === RKSTORAGE_RECORD_KEY)
        throw new Error('synthetic marker write failure');
      return original.call(this, key, value);
    });
  try {
    await prepareVault(root);
    expect(rkComplete()).toBe(false);
    expect(complete()).toBe(true);
  } finally {
    set.mockRestore();
  }
  await prepareVault(root);
  expect(rkComplete()).toBe(true);
});
it('RK: iOS never accesses the Android module or marker', async () => {
  await seed();
  Platform.OS = 'ios';
  Object.defineProperty(NativeModules, 'BitPayRKStorage', {
    configurable: true,
    get() {
      throw new Error('Android module accessed on iOS');
    },
  });
  await prepareVault(root);
  expect(complete()).toBe(true);
  expect(rkComplete()).toBe(false);
});

it.each(['constructor', '__proto__', 'PRIVATE_NATIVE_SENTINEL', null])(
  'RK: unknown native outcome %s cannot complete or enter diagnostics',
  async result => {
    await rkCompletedVault();
    const bridge = rkBridge();
    bridge.clean.mockResolvedValueOnce(result as any);
    const logs: string[] = [];
    await expect(
      prepareVault(root, value => logs.push(value)).then(() => undefined),
    ).rejects.toThrow('PRESERVATION_FAILURE');
    expect(rkComplete()).toBe(false);
    expect(logs.join('').includes('PRIVATE_NATIVE_SENTINEL')).toBe(false);
    noWrites();
  },
);

it.each(['BUSY', 'UNSUPPORTED', 'CORRUPT', 'IO_DEFERRED'])(
  'RK: %s inventory cannot justify startup without an existing active source',
  async outcome => {
    await rkCompletedVault();
    root.delete('persist:root');
    mockFiles.clear();
    const bridge = rkBridge();
    bridge.inspect.mockResolvedValueOnce(outcome);
    await expect(prepareVault(root).then(() => undefined)).rejects.toThrow(
      'PRESERVATION_FAILURE',
    );
    expect(bridge.clean).not.toHaveBeenCalled();
    expect(rkComplete()).toBe(false);
  },
);
it('RK: a database disappearing after inventory is not verified absence', async () => {
  await rkCompletedVault();
  const bridge = rkBridge();
  bridge.clean.mockResolvedValueOnce('ABSENT');
  await expect(prepareVault(root).then(() => undefined)).rejects.toThrow(
    'PRESERVATION_FAILURE',
  );
  expect(rkComplete()).toBe(false);
  noWrites();
});

// Optional filesystem failure must not bypass the independent-primary guard.
it.each(
  ['ios', 'android'].flatMap(platform =>
    ['write', 'promotion', 'verification'].flatMap(boundary =>
      ['unchanged', 'changed', 'missing', 'invalid'].map(state => ({
        platform,
        boundary,
        state,
      })),
    ),
  ),
)(
  'E: preservation across optional $boundary with $state primary on $platform',
  async ({platform, boundary, state}) => {
    Platform.OS = platform as 'ios' | 'android';
    const key = crypto.randomBytes(32).toString('base64');
    seedKey(VAULT_KEY_SERVICE, key);
    seedKey(LEGACY_KEY_SERVICE, legacyKey);
    const initial: any = payload();
    delete initial.MARKET_STATS;
    const raw = await save(initial, key, 'modern');
    root.set('persist:root', raw);
    const metadata: any = {status: 'started', wipeDone: false};
    if (boundary === 'promotion') {
      seedFile(migrationTemp(VAULT_BACKUP), raw);
      metadata.refresh = {
        path: 'main',
        digest: crypto.createHash('sha256').update(raw).digest('hex'),
      };
    }
    if (boundary === 'verification') seedFile(VAULT_BACKUP, raw);
    record.set(VAULT_RECORD_KEY, JSON.stringify(metadata));
    seedFile(VAULT_BACKUP_TEMP, raw);
    const changed = await save(
      {...initial, BITPAY_ID: {apiToken: 'new public test value'}},
      key,
      'modern',
    );
    const operation = (
      boundary === 'write'
        ? RNFS.writeFile
        : boundary === 'promotion'
        ? RNFS.moveFile
        : RNFS.readFile
    ) as jest.Mock;
    const original = operation.getMockImplementation()!;
    let hit = false,
      failureWriteCount = -1,
      reads = 0;
    operation.mockImplementation(async (...args) => {
      const target = boundary === 'promotion' ? args[1] : args[0];
      if (
        target ===
          (boundary === 'write' ? migrationTemp(VAULT_BACKUP) : VAULT_BACKUP) &&
        (boundary !== 'verification' || ++reads === 3)
      ) {
        hit = true;
        if (state === 'missing') root.delete('persist:root');
        if (state === 'invalid') root.set('persist:root', 'invalid');
        if (state === 'changed') root.set('persist:root', changed);
        failureWriteCount = mockWrites.length;
        throw new Error('injected optional operation failure');
      }
      return original(...args);
    });
    const bridge = rkBridge();
    const unsafe = state === 'missing' || state === 'invalid';
    try {
      const attempt = prepareVault(root).then(() => undefined);
      if (unsafe) await expect(attempt).rejects.toThrow('PRESERVATION_FAILURE');
      else await attempt;
      expect(hit).toBe(true);
      expect(complete()).toBe(false);
      expect(JSON.parse(record.getString(VAULT_RECORD_KEY)!).wipeDone).toBe(
        false,
      );
      expect(mockCredentials.has(LEGACY_KEY_SERVICE)).toBe(true);
      expect(bridge.inspect).not.toHaveBeenCalled();
      expect(mockWrites.some(w => w.endsWith(':trim'))).toBe(false);
      if (unsafe) {
        expect(mockWrites.slice(failureWriteCount)).toEqual([]);
        expect(mockFiles.get(VAULT_BACKUP_TEMP) === raw).toBe(true);
        if (boundary === 'promotion')
          expect(mockFiles.get(migrationTemp(VAULT_BACKUP)) === raw).toBe(true);
      } else
        expect(
          root.getString('persist:root') ===
            (state === 'changed' ? changed : raw),
        ).toBe(true);
    } finally {
      operation.mockImplementation(original);
    }
    if (!unsafe) {
      await prepareVault(root);
      expect(complete()).toBe(true);
      expect(
        root.getString('persist:root') ===
          (state === 'changed' ? changed : raw),
      ).toBe(true);
    }
  },
);

// Synthetic pre-upgrade serialized key, built with the pinned SDK. The current
// new-key constructor already includes EDDSA; remove just those two additions to
// model the released pre-upgrade shape. No claim of historical fixture provenance.
const beforeEddsaUpgrade = () => {
  const state: any = payload();
  state.WALLET.keys.readonly.properties = BwcProvider.getInstance()
    .createKey({seedType: 'new'})
    .toObj();
  delete state.WALLET.keys.readonly.properties.xPrivKeyEDDSA;
  delete state.WALLET.keys.readonly.properties.fingerPrintEDDSA;
  return state;
};
const upgradeEddsa = async (state: any) => {
  const before = JSON.parse(
    JSON.stringify(state.WALLET.keys.readonly.properties),
  );
  state.WALLET.keys.readonly.methods = BwcProvider.getInstance().createKey({
    seedType: 'object',
    seedData: before,
  });
  const dispatch = jest.fn();
  await (startAddEDDSAKey() as any)(dispatch, () => state);
  const properties = state.WALLET.keys.readonly.properties;
  expect(
    typeof properties.xPrivKeyEDDSA === 'string' &&
      properties.xPrivKeyEDDSA.length > 0,
  ).toBe(true);
  expect(
    typeof properties.fingerPrintEDDSA === 'string' &&
      /^[a-f0-9]{8}$/.test(properties.fingerPrintEDDSA),
  ).toBe(true);
  expect(
    Object.keys(before).every(name => isEqual(properties[name], before[name])),
  ).toBe(true);
  expect(
    Object.keys(properties)
      .filter(name => !Object.prototype.hasOwnProperty.call(before, name))
      .sort(),
  ).toEqual(['fingerPrintEDDSA', 'xPrivKeyEDDSA']);
  delete state.WALLET.keys.readonly.methods;
};
it('C: preservation after deferred AsyncStorage cleanup and the normal EDDSA upgrade', async () => {
  const raw = await save(beforeEddsaUpgrade());
  root.set('persist:root', raw);
  mockAsync.set('persist:root', raw);
  seedKey(LEGACY_KEY_SERVICE, legacyKey);
  rkBridge();
  (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(
    new Error('injected remove failure'),
  );
  const key = await prepareVault(root);
  expect(complete()).toBe(false);
  expect(mockAsync.get('persist:root') === raw).toBe(true);
  const state = await restore(root.getString('persist:root')!, key);
  await upgradeEddsa(state);
  const updated = await save(state, key, 'modern');
  const backup = jest
    .spyOn(require('./backup/fs-backup'), 'backupFileExists')
    .mockResolvedValue(true);
  try {
    await reduxStorage.setItem('persist:root', updated);
  } finally {
    backup.mockRestore();
  }
  restart();
  await rkRelaunch(rkBridge());
  expect(mockAsync.has('persist:root')).toBe(false);
  expect(root.getString('persist:root') === updated).toBe(true);
  same((await restore(updated, key)).WALLET, state.WALLET);
  expect(complete()).toBe(true);
  expect(rkComplete()).toBe(true);
});

it.each(
  ['exists', 'read', 'unlink', 'async-read', 'async-delete'].flatMap(boundary =>
    ['missing', 'invalid'].flatMap(state =>
      [false, true].map(rejected => ({boundary, state, rejected})),
    ),
  ),
)(
  'E: preservation during cleanup $boundary ($state, rejected=$rejected)',
  async ({boundary, state, rejected}) => {
    const key = crypto.randomBytes(32).toString('base64');
    seedKey(VAULT_KEY_SERVICE, key);
    seedKey(LEGACY_KEY_SERVICE, legacyKey);
    const raw = await save(payload(), key, 'modern');
    root.set('persist:root', raw);
    record.set(
      VAULT_RECORD_KEY,
      JSON.stringify({status: 'started', wipeDone: true}),
    );
    for (const path of [VAULT_BACKUP, VAULT_OLDER_BACKUP, VAULT_BACKUP_TEMP])
      seedFile(path, raw);
    if (boundary === 'async-delete') mockAsync.set('persist:root', raw);
    const operation = {
      exists: RNFS.exists,
      read: RNFS.readFile,
      unlink: RNFS.unlink,
      'async-read': AsyncStorage.getItem,
      'async-delete': AsyncStorage.removeItem,
    }[boundary] as jest.Mock;
    const original = operation.getMockImplementation()!;
    let calls = 0,
      hit = false,
      writesAtFailure = -1;
    operation.mockImplementation(async (...args) => {
      const target = args[0];
      const selected =
        boundary === 'read'
          ? target === VAULT_BACKUP
          : boundary.startsWith('async-')
          ? target === 'persist:root'
          : target === VAULT_BACKUP_TEMP;
      const value = await original(...args);
      if (
        selected &&
        ++calls ===
          (['exists', 'read', 'async-read'].includes(boundary) ? 2 : 1)
      ) {
        hit = true;
        if (state === 'missing') root.delete('persist:root');
        else root.set('persist:root', 'invalid');
        writesAtFailure = mockWrites.length;
        if (rejected) throw new Error('injected cleanup failure');
      }
      return value;
    });
    const bridge = rkBridge();
    try {
      await expect(prepareVault(root).then(() => undefined)).rejects.toThrow(
        'PRESERVATION_FAILURE',
      );
      expect(hit).toBe(true);
      expect(mockWrites.slice(writesAtFailure)).toEqual([]);
      expect(mockCredentials.has(LEGACY_KEY_SERVICE)).toBe(true);
      expect(
        mockFiles.get(VAULT_BACKUP) === raw &&
          mockFiles.get(VAULT_OLDER_BACKUP) === raw,
      ).toBe(true);
      if (boundary === 'exists')
        expect(mockFiles.get(VAULT_BACKUP_TEMP) === raw).toBe(true);
      expect(complete()).toBe(false);
      expect(bridge.inspect).not.toHaveBeenCalled();
    } finally {
      operation.mockImplementation(original);
    }
  },
);

it.each(
  ['async', 'temp'].flatMap(source =>
    [
      'fingerprint-only',
      'eddsa-addition',
      'changed-fingerprint',
      'removed-fingerprint',
      'added-derivation',
      'changed-derivation',
      'changed-private',
      'invalid-fingerprint',
      'null-fingerprint',
    ].map(change => ({source, change})),
  ),
)(
  'C/E: EDDSA metadata coverage for $source with $change',
  async ({source, change}) => {
    const key = crypto.randomBytes(32).toString('base64');
    seedKey(VAULT_KEY_SERVICE, key);
    const old: any = payload();
    delete old.MARKET_STATS;
    delete old.WALLET.keys.readonly.properties.xPrivKeyEDDSA;
    delete old.WALLET.keys.readonly.properties.xPrivKeyEDDSAEncrypted;
    old.WALLET.keys.readonly.properties.compliantDerivation = true;
    if (['changed-fingerprint', 'removed-fingerprint'].includes(change))
      old.WALLET.keys.readonly.properties.fingerPrintEDDSA = '11223344';
    if (change === 'null-fingerprint')
      old.WALLET.keys.readonly.properties.fingerPrintEDDSA = null;
    const active = JSON.parse(JSON.stringify(old));
    const properties = active.WALLET.keys.readonly.properties;
    properties.fingerPrintEDDSA = '55667788';
    if (change === 'eddsa-addition')
      properties.xPrivKeyEDDSA = 'synthetic new protected EDDSA value';
    if (change === 'removed-fingerprint') delete properties.fingerPrintEDDSA;
    if (change === 'added-derivation') properties.BIP45 = true;
    if (change === 'changed-derivation') properties.compliantDerivation = false;
    if (change === 'changed-private')
      properties.xPrivKey = 'changed protected value';
    if (change === 'invalid-fingerprint')
      properties.fingerPrintEDDSA = 'invalid';
    const live = await save(active, key, 'modern');
    root.set('persist:root', live);
    const metadata: any = {status: 'started', wipeDone: true};
    const oldRaw = await save(
      old,
      source === 'async' ? legacyKey : key,
      source === 'async' ? 'fields' : 'modern',
    );
    if (source === 'async') mockAsync.set('persist:root', oldRaw);
    else {
      seedFile(VAULT_BACKUP, live);
      seedFile(migrationTemp(VAULT_BACKUP), oldRaw);
      metadata.refresh = {
        path: 'main',
        digest: crypto.createHash('sha256').update(oldRaw).digest('hex'),
      };
    }
    record.set(VAULT_RECORD_KEY, JSON.stringify(metadata));
    restart();
    const allowed = ['fingerprint-only', 'eddsa-addition'].includes(change);
    if (allowed) {
      await migrateVault(root);
      expect(complete()).toBe(true);
      expect(mockAsync.has('persist:root')).toBe(false);
      expect(mockFiles.has(migrationTemp(VAULT_BACKUP))).toBe(false);
    } else {
      await expect(migrateVault(root).then(() => undefined)).rejects.toThrow(
        'SOURCE_CONFLICT',
      );
      noWrites();
      expect(
        (source === 'async'
          ? mockAsync.get('persist:root')
          : mockFiles.get(migrationTemp(VAULT_BACKUP))) === oldRaw,
      ).toBe(true);
    }
    expect(root.getString('persist:root') === live).toBe(true);
  },
);

it('E: optional promotion remains deferrable after an actual additive EDDSA upgrade', async () => {
  const key = crypto.randomBytes(32).toString('base64');
  seedKey(VAULT_KEY_SERVICE, key);
  const state = beforeEddsaUpgrade();
  const old = await save(state, key, 'modern');
  root.set('persist:root', old);
  const move = RNFS.moveFile as jest.Mock;
  const original = move.getMockImplementation()!;
  move.mockImplementation(async (from, to) => {
    if (to === VAULT_BACKUP) throw new Error('injected promotion failure');
    return original(from, to);
  });
  let enriched: string;
  try {
    await migrateVault(root);
    expect(complete()).toBe(false);
    expect(mockFiles.has(migrationTemp(VAULT_BACKUP))).toBe(true);
    await upgradeEddsa(state);
    enriched = await save(state, key, 'modern');
    root.set('persist:root', enriched);
    for (let attempt = 0; attempt < 2; attempt++) {
      restart();
      await migrateVault(root);
      expect(complete()).toBe(false);
      expect(root.getString('persist:root') === enriched).toBe(true);
      expect(mockFiles.has(migrationTemp(VAULT_BACKUP))).toBe(true);
      expect(mockWrites.some(w => w.endsWith(':trim'))).toBe(false);
    }
  } finally {
    move.mockImplementation(original);
  }
  await migrateVault(root);
  expect(complete()).toBe(true);
  expect(root.getString('persist:root') === enriched!).toBe(true);
  expect(mockFiles.has(migrationTemp(VAULT_BACKUP))).toBe(false);
});
