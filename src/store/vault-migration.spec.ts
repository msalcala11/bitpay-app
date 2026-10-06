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
let mockIssuedReceipt: string | undefined;
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
      if (this.id === 'bitpay.vault.migration' && key === 'migration') {
        try {
          const r = JSON.parse(value);
          const receipt =
            r.conversionPlan?.primaryReceipt ?? r.cleanup?.primaryReceipt;
          if (receipt !== undefined) mockIssuedReceipt = receipt;
        } catch {} // Invalid-record fixtures still reach the production parser.
      }
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
// Exact expected application state plus the annotation observed at its real
// record issuance. Never ignore APP or omit retained reducers from comparison.
const withIssuedReceipt = (state: any) => {
  expect(
    typeof mockIssuedReceipt === 'string' &&
      /^[a-f0-9]{32}$/.test(mockIssuedReceipt),
  ).toBe(true);
  return {
    ...state,
    APP: {...state.APP, bip02CleanupReceipt: mockIssuedReceipt},
  };
};
const seed = async (mode: Mode = 'fields') => {
  root.set('persist:root', await save(payload(), legacyKey, mode));
  root.set('persist:logs', '[]');
  seedKey(LEGACY_KEY_SERVICE, legacyKey);
  restart();
};
// Return from a conversion with only the scrub (and optionally AS deletion)
// deferred. Main is verified/current before the caller performs ordinary use.
// The reference records no separate conversion flag; tests assert observable
// lifecycle behavior rather than failing just because a future field is absent.
const convertedPending = async (state: any, retainAsync = false) => {
  const raw = await save(state);
  root.set('persist:root', raw);
  seedKey(LEGACY_KEY_SERVICE, legacyKey);
  if (retainAsync) mockAsync.set('persist:root', raw);
  const stat = RNFS.stat as jest.Mock,
    remove = AsyncStorage.removeItem as jest.Mock;
  const stating = stat.getMockImplementation()!,
    removing = remove.getMockImplementation()!;
  stat.mockRejectedValue(new Error('synthetic scrub metadata failure'));
  if (retainAsync)
    remove.mockRejectedValue(new Error('synthetic pending source'));
  let key: string;
  try {
    key = await prepareVault(root);
  } finally {
    stat.mockImplementation(stating);
    remove.mockImplementation(removing);
  }
  expect(complete()).toBe(false);
  const convertedApp = (await restore(root.getString('persist:root')!, key!))
    .APP;
  if (convertedApp.bip02CleanupReceipt !== undefined)
    state.APP = {
      ...state.APP,
      bip02CleanupReceipt: convertedApp.bip02CleanupReceipt,
    };
  expect(
    isEqual(
      (await restore(root.getString('persist:root')!, key!)).WALLET,
      state.WALLET,
    ),
  ).toBe(true);
  expect(
    isEqual(
      (await restore(mockFiles.get(VAULT_BACKUP)!, key!)).WALLET,
      state.WALLET,
    ),
  ).toBe(true);
  return key!;
};
// A completed conversion with a later ordinary edit requiring optional refresh.
const optionalRefreshPrimary = async (state: any = payload()) => {
  const key = await convertedPending(state);
  state.BITPAY_ID.apiToken = 'synthetic post-conversion edit';
  root.set('persist:root', await save(state, key, 'modern'));
  restart();
  return key;
};
const conversionRecorded = () => {
  const value = JSON.parse(record.getString(VAULT_RECORD_KEY) ?? 'null');
  return value?.status === 'complete' || value?.conversionComplete === true;
};
beforeEach(() => {
  mockIssuedReceipt = undefined;
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
      same(
        await restore(root.getString('persist:root')!, key),
        withIssuedReceipt(payload()),
      );
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

it('Stage A / T7: required first backup failure stops conversion and retains the original primary', async () => {
  await seed();
  const original = root.getString('persist:root');
  (RNFS.writeFile as jest.Mock).mockRejectedValueOnce(new Error('disk full'));
  await expect(migrateVault(root).then(() => undefined)).rejects.toThrow();
  expect(complete()).toBe(false);
  expect(conversionRecorded()).toBe(false);
  expect(mockCredentials.has(LEGACY_KEY_SERVICE)).toBe(true);
  expect(root.getString('persist:root') === original).toBe(true);
  expect(mockWrites.some(w => w === 'mmkv:default:set:persist:root')).toBe(
    false,
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
  seedFile(migrationTemp(VAULT_BACKUP), await save(payload()));
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
    same(
      await restore(root.getString('persist:root')!, key),
      withIssuedReceipt(payload()),
    );
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
    same(
      await restore(root.getString('persist:root')!, key),
      withIssuedReceipt(active),
    );
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
    same(
      await restore(root.getString('persist:root')!, key),
      withIssuedReceipt(source),
    );
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
  expect(root.contains('persist:root')).toBe(true);
  const retained = withIssuedReceipt(state);
  delete retained.MARKET_STATS;
  same(await restore(mockFiles.get(VAULT_BACKUP)!, key), retained);
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
  'Stage A / E: optional promotion defers three launches then succeeds (primary changes=%s)',
  async changed => {
    let current: any = payload();
    const key = await optionalRefreshPrimary(current);
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
  const key = await convertedPending(payload());
  root.set('persist:logs', '[]');
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
      expect(await attempt).toMatchObject(
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
        if (state === 'unchanged')
          expected.APP = withIssuedReceipt(expected).APP;
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
  await migrateVault(root);
  expect(root.getString('persist:root') === changedRaw).toBe(true);
  expect(mockAsync.has('persist:root')).toBe(true);
  expect(complete()).toBe(false);
});
it.each(['current', 'older', 'none', 'async'])(
  'Stage A / A1: backup-first closes earlier-write missing-current-copy gap: %s',
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
    let prepared = false;
    const set = root.set.bind(root);
    const spy = jest.spyOn(root, 'set').mockImplementation((key, value) => {
      if (key === 'persist:root') {
        prepared = mockFiles.has(VAULT_BACKUP);
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
    expect(prepared).toBe(true);
    expect(raw !== undefined).toBe(true);
    const state = await restore(raw!, key);
    expect(!!state.WALLET.keys.newer).toBe(true);
    expect(!!state.WALLET.keys.readonly).toBe(true);
    if (recovery === 'async') expect(mockAsync.has('persist:root')).toBe(false);
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
    if (purge) {
      await expect(migrateVault(root).then(() => undefined)).rejects.toThrow(
        'PRESERVATION_FAILURE',
      );
      expect(conversionRecorded()).toBe(true);
      return;
    }
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
it('Stage A / E: optional Android partial-target promotion and deletion failure stays deferrable across retries', async () => {
  const key = await optionalRefreshPrimary();
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
it('Stage A / E: verification errors in optional refresh preserve the primary across three launches', async () => {
  const key = await optionalRefreshPrimary();
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
describe('Stage B review backup-read regressions', () => {
  it.each(
    ['pending', 'complete'].flatMap(status =>
      ['exists', 'readFile'].flatMap(boundary =>
        ['missing', 'invalid'].map(primary => ({status, boundary, primary})),
      ),
    ),
  )(
    'recovers a $status wallet from bak after main $boundary rejection ($primary primary)',
    async ({status, boundary, primary}) => {
      const state = payload();
      const key = await convertedPending(state);
      if (status === 'complete') {
        await migrateVault(root);
        expect(complete()).toBe(true);
      }
      const backup = mockFiles.get(VAULT_BACKUP)!;
      seedFile(VAULT_OLDER_BACKUP, backup);
      if (primary === 'missing') root.delete('persist:root');
      else root.set('persist:root', 'synthetic damaged primary');
      const operation = RNFS[boundary as 'exists' | 'readFile'] as jest.Mock;
      const original = operation.getMockImplementation()!;
      operation.mockImplementation(async (path, ...args) => {
        if (path === VAULT_BACKUP) throw new Error('PRIVATE_MAIN_READ');
        return original(path, ...args);
      });
      restart();
      try {
        expect((await prepareVault(root)) === key).toBe(true);
        const recovered = await reduxStorage.getItem('persist:root');
        const expected: any = {...state, APP: {...state.APP}};
        if (status === 'pending') delete expected.APP.bip02CleanupReceipt;
        for (const reducer of [
          'MARKET_STATS',
          'PORTFOLIO',
          'PORTFOLIO_CHARTS',
          'RATE',
          'SHOP_CATALOG',
        ])
          delete expected[reducer];
        same(await restore(recovered!, key), expected);
        expect(root.getString('persist:root') === recovered).toBe(true);
        expect(mockFiles.get(VAULT_BACKUP) === backup).toBe(true);
        expect(mockFiles.get(VAULT_OLDER_BACKUP) === backup).toBe(true);
        expect(
          mockWrites.filter(w => w === 'mmkv:default:set:persist:root').length,
        ).toBe(1);
      } finally {
        operation.mockImplementation(original);
      }
    },
  );

  it.each(['exists', 'readFile'])(
    'does not interpret a failed %s as empty initialization when no backup is usable',
    async boundary => {
      await migrateVault(root); // Genuine initializing record, no first save.
      seedFile(VAULT_BACKUP, 'unreadable synthetic content');
      const operation = RNFS[boundary as 'exists' | 'readFile'] as jest.Mock;
      const original = operation.getMockImplementation()!;
      operation.mockImplementation(async (path, ...args) => {
        if (path === VAULT_BACKUP) throw new Error('PRIVATE_MAIN_READ');
        return original(path, ...args);
      });
      restart();
      try {
        await expect(reduxStorage.getItem('persist:root')).rejects.toThrow(
          'REQUIRED_COPY_FAILURE',
        );
        expect(root.contains('persist:root')).toBe(false);
        noWrites();
      } finally {
        operation.mockImplementation(original);
      }
    },
  );

  // Produce an owned temp through the real conversion/optional-refresh path.
  const pendingRefresh = async () => {
    const key = await optionalRefreshPrimary();
    const move = RNFS.moveFile as jest.Mock;
    const original = move.getMockImplementation()!;
    move.mockImplementation(async (from, to) => {
      if (to === VAULT_BACKUP) throw new Error('synthetic promotion failure');
      return original(from, to);
    });
    try {
      expect((await prepareVault(root)) === key).toBe(true);
    } finally {
      move.mockImplementation(original);
    }
    expect(mockFiles.has(migrationTemp(VAULT_BACKUP))).toBe(true);
    expect(complete()).toBe(false);
    return key;
  };

  it.each(
    ['exists', 'readFile'].flatMap(boundary =>
      [false, true].map(validTarget => ({boundary, validTarget})),
    ),
  )(
    'defers owned temp across repeated other-backup $boundary failures (valid target=$validTarget)',
    async ({boundary, validTarget}) => {
      const key = await pendingRefresh();
      if (validTarget)
        seedFile(VAULT_BACKUP, mockFiles.get(VAULT_OLDER_BACKUP)!);
      const primary = root.getString('persist:root')!;
      const files = new Map(mockFiles);
      const operation = RNFS[boundary as 'exists' | 'readFile'] as jest.Mock;
      const original = operation.getMockImplementation()!;
      let failures = 0;
      operation.mockImplementation(async (path, ...args) => {
        if (path === VAULT_OLDER_BACKUP) {
          failures++;
          throw new Error('PRIVATE_BAK_READ');
        }
        return original(path, ...args);
      });
      try {
        for (let launch = 1; launch <= 3; launch++) {
          restart(); // Completed-call retry, not a native-process restart.
          expect((await prepareVault(root)) === key).toBe(true);
          expect(root.getString('persist:root') === primary).toBe(true);
          expect((await reduxStorage.getItem('persist:root')) === primary).toBe(
            true,
          );
          expect(isEqual(mockFiles, files)).toBe(true);
          expect(complete()).toBe(false);
          expect(failures).toBe(launch); // No re-read of a known unreadable path.
          noWrites();
        }
      } finally {
        operation.mockImplementation(original);
      }
      restart();
      expect((await prepareVault(root)) === key).toBe(true);
      expect(root.getString('persist:root') === primary).toBe(true);
      expect(complete()).toBe(true);
    },
  );

  it.each(['usable', 'missing', 'invalid'])(
    'handles the post-operation temp read failure with a %s primary',
    async primaryState => {
      const key = await pendingRefresh();
      const primary = root.getString('persist:root')!;
      const exists = RNFS.exists as jest.Mock;
      const original = exists.getMockImplementation()!;
      let failed = false;
      exists.mockImplementation(async path => {
        if (path === migrationTemp(VAULT_BACKUP) && !mockFiles.has(path)) {
          failed = true;
          if (primaryState === 'missing') root.delete('persist:root');
          if (primaryState === 'invalid') root.set('persist:root', 'invalid');
          throw new Error('PRIVATE_POST_OPERATION_READ');
        }
        return original(path);
      });
      restart();
      try {
        if (primaryState === 'usable') {
          expect((await prepareVault(root)) === key).toBe(true);
          expect(root.getString('persist:root') === primary).toBe(true);
          expect(complete()).toBe(false);
        } else {
          await expect(prepareVault(root)).rejects.toThrow(
            'PRESERVATION_FAILURE',
          );
        }
        expect(failed).toBe(true);
      } finally {
        exists.mockImplementation(original);
      }
      if (primaryState === 'usable') {
        restart();
        expect((await prepareVault(root)) === key).toBe(true);
        expect(complete()).toBe(true);
      }
    },
  );
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
it('Stage A / E: unconverted old started record stops on required equivalent-temp promotion failure', async () => {
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
      await expect(migrateVault(root).then(() => undefined)).rejects.toThrow();
      expect(conversionRecorded()).toBe(false);
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
    await expect(migrateVault(root).then(() => undefined)).rejects.toThrow(
      'REQUIRED_COPY_FAILURE',
    );
    expect(complete()).toBe(false);
    const changed: any = payload();
    changed.WALLET.keys = {};
    const changedRaw = await save(changed, key, 'modern');
    root.set('persist:root', changedRaw);
    restart();
    await expect(migrateVault(root).then(() => undefined)).rejects.toThrow(
      'SOURCE_CONFLICT',
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
  expect(vaultDiagnostic(failure)).toMatchObject({
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
  // Owner ruling, 6 October: empty successful inventory is fresh on Android.
  await expect(
    prepareVault(root).then(() => undefined),
  ).resolves.toBeUndefined();
  expect(rkInitializing()).toBe(true);
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
  expect(rkComplete()).toBe(false);
  // A separate launch owns the native post-clean read after base cleanup used its budget.
  restart();
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
it('Stage A / RK: recover a converted wallet even when the cleanup bridge is unavailable', async () => {
  const key = await rkCompletedVault();
  const backup = mockFiles.get(VAULT_BACKUP)!;
  root.set('persist:root', 'invalid');
  restart();
  expect((await prepareVault(root)) === key).toBe(true);
  const recovered = await reduxStorage.getItem('persist:root');
  expect(
    recovered === backup && root.getString('persist:root') === backup,
  ).toBe(true);
  expect(
    isEqual((await restore(recovered!, key)).WALLET, payload().WALLET),
  ).toBe(true);
  expect(
    mockWrites.every(
      w =>
        w === 'mmkv:default:set:persist:root' ||
        w.startsWith(`mmkv:${VAULT_RECORD_ID}:set:`),
    ),
  ).toBe(true);
  expect(rkComplete()).toBe(false);
});
it.each([
  'CLEANED',
  'IO_DEFERRED',
  'LIFECYCLE_FAILURE',
  'PRESERVATION_FAILURE',
])(
  'Stage A / RK: usable converted wallet survives native %s without rollback',
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
    expect((await prepareVault(root)) === key).toBe(true);
    expect(root.getString('persist:root') === raw).toBe(true);
    expect(rkComplete()).toBe(false);
  },
);
it.each(['LIVE_SOURCE', 'CLEANED'])(
  'Stage A / RK: late live source at %s keeps cleanup pending without blocking access',
  async result => {
    const key = await rkCompletedVault();
    const primary = root.getString('persist:root');
    const bridge = rkBridge();
    const live = await save(payload());
    bridge.clean.mockImplementationOnce(async () => {
      mockAsync.set('persist:root', live);
      return result;
    });
    expect((await prepareVault(root)) === key).toBe(true);
    expect(root.getString('persist:root') === primary).toBe(true);
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
    await prepareVault(root, value => logs.push(value));
    expect(conversionRecorded()).toBe(true);
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
  await prepareVault(root);
  expect(conversionRecorded()).toBe(true);
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
  'Stage A / E: preservation across optional $boundary with $state primary on $platform',
  async ({platform, boundary, state}) => {
    Platform.OS = platform as 'ios' | 'android';
    const initial: any = payload();
    delete initial.MARKET_STATS;
    const key = await optionalRefreshPrimary(initial);
    const raw = await save(initial, key, 'modern');
    root.set('persist:root', raw);
    const metadata: any = JSON.parse(record.getString(VAULT_RECORD_KEY)!);
    if (boundary === 'promotion') {
      mockFiles.delete(VAULT_BACKUP); // Post-conversion loss; the owned temp is now the pending promotion.
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
  expect(rkComplete()).toBe(false);
  // A separate launch owns the native post-clean read after base cleanup used its budget.
  restart();
  await prepareVault(root);
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
    await convertedPending(payload(), boundary === 'async-delete');
    const raw = root.getString('persist:root')!;
    record.set(
      VAULT_RECORD_KEY,
      JSON.stringify({
        ...JSON.parse(record.getString(VAULT_RECORD_KEY)!),
        wipeDone: true,
      }),
    );
    for (const path of [VAULT_BACKUP, VAULT_OLDER_BACKUP, VAULT_BACKUP_TEMP])
      seedFile(path, raw);
    restart();
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
    if (allowed)
      same(
        await restore(root.getString('persist:root')!, key),
        withIssuedReceipt(active),
      );
    else expect(root.getString('persist:root') === live).toBe(true);
  },
);

it('Stage A / E: optional promotion remains deferrable after an actual additive EDDSA upgrade', async () => {
  const state = beforeEddsaUpgrade();
  const key = await optionalRefreshPrimary(state);
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

// Retained Stage A acceptance contract, now exercised against Stage B.
// Historical red results are preserved separately from implementation results.
// Output is limited to fixed labels, classifications, booleans and counts.
describe('Stage A', () => {
  const freshDiagnostics = new WeakMap<object, {code: string; phase: string}>();
  const outcome = async (label: string, operation: () => Promise<unknown>) => {
    const started = Date.now();
    const writes = mockWrites.length;
    let code = 'RESOLVED',
      phase = 'none';
    try {
      await operation();
    } catch (error) {
      const diagnostic =
        freshDiagnostics.get(error as object) ??
        getVaultDiagnostic(error as Error);
      code = diagnostic?.code ?? 'UNCLASSIFIED';
      phase = diagnostic?.phase ?? 'unknown';
    }
    console.info(
      'STAGE_A_RESULT ' +
        JSON.stringify({
          label,
          code,
          phase,
          elapsedMs: Date.now() - started,
          applicationMutations: mockWrites.length - writes,
        }),
    );
    return code;
  };
  const ordinarySave = async (state: any, key: string, rotate = true) => {
    // AppInitialization invokes this guarded importer before ordinary UI use.
    // Exercise the real flag update; a modern flag is not historical evidence.
    await (startMigrationMMKVStorage() as any)(
      (action: any) => {
        state.APP = require('./app/app.reducer').appReducer(state.APP, action);
      },
      () => state,
    );
    // Model actual rehydration of APP before the real reducer/save path. This
    // preserves migration-owned cleanup metadata without fabricating a receipt.
    const persisted = await restore(root.getString('persist:root')!, key);
    state.APP = {...persisted.APP, ...state.APP};
    const backup = require('./backup/fs-backup');
    const exists = jest
      .spyOn(backup, 'backupFileExists')
      .mockResolvedValue(!rotate);
    const write = jest.spyOn(backup, 'backupPersistRoot');
    const raw = await save(state, key, 'modern');
    try {
      await reduxStorage.setItem('persist:root', raw);
      // Await the actual queued backup work triggered by the adapter, so the
      // next modeled launch observes completed ordinary rotation, not a mock.
      for (const call of write.mock.results)
        if (call.type === 'return') await call.value;
    } finally {
      exists.mockRestore();
      write.mockRestore();
    }
    expect(root.getString('persist:root') === raw).toBe(true);
    return raw;
  };
  const stateWithSdkKey = (encrypted = false) => {
    const state: any = payload();
    const sdk = BwcProvider.getInstance().createKey({seedType: 'new'});
    if (encrypted) sdk.encrypt('synthetic-password-a');
    state.WALLET.keys.readonly.properties = sdk.toObj();
    state.WALLET.keys.readonly.totalBalance = 0;
    state.WALLET.portfolioBalance = {current: 0, lastDay: 0, previous: 0};
    state.SHOP.giftCards.livenet[0].status = 'UNREDEEMED';
    return state;
  };
  const edit = (state: any, kind: string) => {
    if (kind === 'delete-key') {
      state.WALLET = require('./wallet/wallet.reducer').walletReducer(
        state.WALLET,
        require('./wallet/wallet.actions').deleteKey({keyId: 'readonly'}),
      );
    } else if (kind === 'remove-gift') {
      state.SHOP = require('./shop/shop.reducer').shopReducer(
        state.SHOP,
        require('./shop/shop.actions').deletedUnsoldGiftCards({
          network: 'livenet',
        }),
      );
    } else {
      const item = state.WALLET.keys.readonly;
      const sdk = BwcProvider.getInstance().createKey({
        seedType: 'object',
        seedData: item.properties,
      });
      if (kind !== 'password-set') sdk.decrypt('synthetic-password-a');
      if (kind !== 'password-remove') sdk.encrypt('synthetic-password-b');
      state.WALLET = require('./wallet/wallet.reducer').walletReducer(
        state.WALLET,
        require('./wallet/wallet.actions').successImport({
          key: {...item, properties: sdk.toObj()},
        }),
      );
    }
  };
  const pending = async (source: 'main' | 'async', state: any) => {
    if (source === 'main') {
      const key = await convertedPending(state);
      state.BITPAY_ID.apiToken = 'ordinary change after conversion';
      await ordinarySave(state, key, false);
      const move = RNFS.moveFile as jest.Mock;
      const original = move.getMockImplementation()!;
      move.mockImplementation(async (from, to) => {
        if (to === VAULT_BACKUP)
          throw new Error('synthetic independent refresh failure');
        return original(from, to);
      });
      try {
        expect((await prepareVault(root)) === key).toBe(true);
      } finally {
        move.mockImplementation(original);
      }
      expect(complete()).toBe(false);
      expect(mockFiles.has(migrationTemp(VAULT_BACKUP))).toBe(true);
      return key;
    }
    const raw = await save(state);
    root.set('persist:root', raw);
    seedKey(LEGACY_KEY_SERVICE, legacyKey);
    mockAsync.set('persist:root', raw);
    const remove = AsyncStorage.removeItem as jest.Mock;
    const original = remove.getMockImplementation()!;
    remove.mockRejectedValue(new Error('synthetic pending cleanup'));
    let key: string;
    try {
      key = await prepareVault(root);
    } finally {
      remove.mockImplementation(original);
    }
    expect(complete()).toBe(false);
    expect(mockAsync.has('persist:root')).toBe(true);
    return key!;
  };
  const freshModules = (configure?: (asyncStorage: any) => void) => {
    let run: () => Promise<string> = () => prepareVault(root);
    let restoreRead = () => {};
    jest.isolateModules(() => {
      const native = require('react-native');
      native.Platform.OS = 'android';
      native.NativeModules.BitPayRKStorage = rkBridge();
      const asyncModule = require('@react-native-async-storage/async-storage');
      const asyncStorage = asyncModule.default ?? asyncModule;
      const reading = asyncStorage.getItem.getMockImplementation();
      configure?.(asyncStorage);
      restoreRead = () => asyncStorage.getItem.mockImplementation(reading);
      const fresh = require('./vault-rkstorage').prepareVault;
      const diagnostic = require('./vault-diagnostics').vaultDiagnostic;
      run = () =>
        fresh(root).catch((error: Error) => {
          const safe = diagnostic(error);
          if (safe) freshDiagnostics.set(error, safe);
          throw error;
        });
    });
    return run().finally(restoreRead); // JS reload only: the boundary maps/native view are preserved.
  };

  it.each(
    ['main', 'async'].flatMap(source =>
      [
        'delete-key',
        'password-set',
        'password-change',
        'password-remove',
        'remove-gift',
      ].map(change => ({source, change})),
    ),
  )('B lifecycle: $source after $change', async ({source, change}) => {
    const state = stateWithSdkKey(
      ['password-change', 'password-remove'].includes(change),
    );
    const key = await pending(source as 'main' | 'async', state);
    edit(state, change);
    const latest = await ordinarySave(state, key);
    restart();
    const code = await outcome(`B:${source}:${change}`, () => freshModules());
    expect(root.getString('persist:root') === latest).toBe(true);
    expect(code === 'RESOLVED').toBe(true);
    expect(complete()).toBe(true);
    expect(
      source === 'main'
        ? !mockFiles.has(migrationTemp(VAULT_BACKUP))
        : !mockAsync.has('persist:root'),
    ).toBe(true);
  });

  it('A lifecycle: obsolete bak temp after two ordinary backup rotations', async () => {
    const state = stateWithSdkKey();
    const key = await convertedPending(state);
    state.BITPAY_ID.apiToken = 'ordinary change after conversion';
    await ordinarySave(state, key, false);
    const move = RNFS.moveFile as jest.Mock;
    const original = move.getMockImplementation()!;
    move.mockImplementation(async (from, to) => {
      if (to === VAULT_OLDER_BACKUP)
        throw new Error('synthetic bak promotion failure');
      return original(from, to);
    });
    try {
      expect((await prepareVault(root)) === key).toBe(true);
    } finally {
      move.mockImplementation(original);
    }
    expect(complete()).toBe(false);
    expect(mockFiles.has(migrationTemp(VAULT_OLDER_BACKUP))).toBe(true);
    state.BITPAY_ID.apiToken = 'first ordinary test save';
    await ordinarySave(state, key);
    state.BITPAY_ID.apiToken = 'second ordinary test save';
    const latest = await ordinarySave(state, key);
    const backup = mockFiles.get(VAULT_OLDER_BACKUP);
    move.mockClear();
    restart();
    const code = await outcome('A:bak:rotated', () => freshModules());
    expect(root.getString('persist:root') === latest).toBe(true);
    expect(mockFiles.get(VAULT_OLDER_BACKUP) === backup).toBe(true);
    expect(code === 'RESOLVED').toBe(true);
    expect(complete()).toBe(true);
    expect(mockFiles.has(migrationTemp(VAULT_OLDER_BACKUP))).toBe(false);
  });

  it.each([true, false, undefined, 'true'])(
    'F pre-conversion source-selection qualification (legacy flag=%s)',
    async flag => {
      const state = stateWithSdkKey();
      if (flag === undefined) delete state.APP.migrationMMKVStorageComplete;
      else state.APP.migrationMMKVStorageComplete = flag;
      root.set('persist:root', await save(state));
      seedKey(LEGACY_KEY_SERVICE, legacyKey);
      const get = AsyncStorage.getItem as jest.Mock;
      const original = get.getMockImplementation()!;
      get.mockRejectedValue(new Error('synthetic unreadable AsyncStorage'));
      restart();
      let code: string;
      try {
        code = await outcome(
          `F:historical:${typeof flag}:${String(flag)}`,
          () => prepareVault(root),
        );
      } finally {
        get.mockImplementation(original);
      }
      expect(get.mock.calls.length).toBe(1);
      // Retain the narrow historical-CBC source-selection qualification. It is
      // not a conversion milestone: access still requires completed conversion.
      if (flag === true) {
        expect(code === 'RESOLVED').toBe(true);
        const key = mockCredentials.get(VAULT_KEY_SERVICE).password;
        expect(
          await matchesRetainedPayload(
            root.getString('persist:root'),
            key,
            includePlannedReceipt(state),
          ),
        ).toBe(true);
        expect(
          await matchesRetainedPayload(
            mockFiles.get(VAULT_BACKUP),
            key,
            includePlannedReceipt(state),
          ),
        ).toBe(true);
        expect(complete()).toBe(false);
      } else {
        expect(code !== 'RESOLVED').toBe(true);
        noWrites();
      }
    },
  );

  it.each(['same-attempt', 'fresh-modules'])(
    'F successful absence before unreadability: %s',
    async mode => {
      const state = stateWithSdkKey();
      root.set('persist:root', await save(state));
      seedKey(LEGACY_KEY_SERVICE, legacyKey);
      if (mode === 'same-attempt') {
        const get = AsyncStorage.getItem as jest.Mock;
        const original = get.getMockImplementation()!;
        get
          .mockResolvedValueOnce(null)
          .mockRejectedValue(new Error('synthetic later read failure'));
        try {
          const code = await outcome('F:absence:same-attempt', () =>
            prepareVault(root),
          );
          expect(code === 'RESOLVED').toBe(true);
          expect(get.mock.calls.length).toBe(2);
          expect(complete()).toBe(false);
        } finally {
          get.mockImplementation(original);
        }
      } else {
        await pending('main', state); // Its initial null read is real successful absence.
        const code = await outcome('F:absence:fresh-modules', () =>
          freshModules(asyncStorage =>
            asyncStorage.getItem.mockRejectedValue(
              new Error('synthetic later read failure'),
            ),
          ),
        );
        expect(code === 'RESOLVED').toBe(true);
        expect(complete()).toBe(false);
      }
    },
  );

  it('F consumed original source before unreadable next launch', async () => {
    const state = stateWithSdkKey();
    const key = await pending('async', state);
    edit(state, 'delete-key');
    const latest = await ordinarySave(state, key);
    const code = await outcome('F:consumed:unreadable', () =>
      freshModules(asyncStorage =>
        asyncStorage.getItem.mockRejectedValue(
          new Error('synthetic read failure'),
        ),
      ),
    );
    expect(root.getString('persist:root') === latest).toBe(true);
    expect(code === 'RESOLVED').toBe(true);
    expect(complete()).toBe(false);
    expect(mockAsync.has('persist:root')).toBe(true);
    expect(mockCredentials.has(LEGACY_KEY_SERVICE)).toBe(true);
  });

  it('F modern flag without historical evidence remains strict', async () => {
    const state = stateWithSdkKey();
    state.APP.migrationMMKVStorageComplete = true;
    const key = crypto.randomBytes(32).toString('base64');
    seedKey(VAULT_KEY_SERVICE, key);
    root.set('persist:root', await save(state, key, 'modern'));
    const get = AsyncStorage.getItem as jest.Mock;
    const original = get.getMockImplementation()!;
    get.mockRejectedValue(new Error('synthetic unreadable source'));
    restart();
    try {
      const code = await outcome('F:modern-flag:strict', () =>
        prepareVault(root),
      );
      expect(code !== 'RESOLVED').toBe(true);
      noWrites();
    } finally {
      get.mockImplementation(original);
    }
  });

  it('G converted wallet opens with undecodable leftovers after its last key is removed', async () => {
    const state = stateWithSdkKey();
    delete state.APP.identity;
    state.SHOP.giftCards.livenet = [];
    const key = crypto.randomBytes(32).toString('base64');
    seedKey(VAULT_KEY_SERVICE, key);
    root.set('persist:root', await save(state, key, 'modern'));
    mockAsync.set('persist:root', 'synthetic undecodable bytes');
    const remove = AsyncStorage.removeItem as jest.Mock;
    const removing = remove.getMockImplementation()!;
    remove.mockRejectedValue(new Error('synthetic delete failure'));
    try {
      await prepareVault(root);
    } finally {
      remove.mockImplementation(removing);
    }
    expect(complete()).toBe(false);
    edit(state, 'delete-key');
    const latest = await ordinarySave(state, key);
    restart();
    const code = await outcome('G:discard:empty-after-use', () =>
      freshModules(),
    );
    expect(code === 'RESOLVED').toBe(true);
    expect(root.getString('persist:root') === latest).toBe(true);
    expect(mockAsync.has('persist:root')).toBe(false);
    expect(Object.keys((await restore(latest, key)).WALLET.keys).length).toBe(
      0,
    );
    // Owner ruling, 6 October: deleting the last key does not retain a damaged row.
    expect(complete()).toBe(true);
    expect(
      mockWrites.every(
        w =>
          w.startsWith(`mmkv:${VAULT_RECORD_ID}:set:`) ||
          w === 'async:delete:persist:root',
      ),
    ).toBe(true);
  });

  it('J candidate UI seed is externally clearable with same-process preparation retry', async () => {
    seedFile(VAULT_BACKUP, JSON.stringify({bad: 'data'}));
    restart();
    const code = await outcome('J:candidate-seed', () => prepareVault(root));
    expect(code === 'INVALID_LEGACY_INPUT').toBe(true);
    noWrites();
    expect(mockCredentials.size).toBe(0);
    expect(record.contains(VAULT_RECORD_KEY)).toBe(false);
    mockFiles.delete(VAULT_BACKUP); // External fixture removal, not a production recovery action.
    expect(await outcome('J:candidate-cleared', () => prepareVault(root))).toBe(
      'RESOLVED',
    );
  });

  it('C lifecycle: independent bak and original AsyncStorage obligations', async () => {
    const state = stateWithSdkKey();
    const key = await convertedPending(state, true);
    state.BITPAY_ID.apiToken = 'ordinary change after conversion';
    await ordinarySave(state, key, false);
    const move = RNFS.moveFile as jest.Mock,
      remove = AsyncStorage.removeItem as jest.Mock;
    const moving = move.getMockImplementation()!,
      removing = remove.getMockImplementation()!;
    move.mockImplementation(async (from, to) => {
      if (to === VAULT_OLDER_BACKUP) throw new Error('synthetic pending bak');
      return moving(from, to);
    });
    remove.mockRejectedValue(new Error('synthetic pending source'));
    try {
      expect((await prepareVault(root)) === key).toBe(true);
    } finally {
      move.mockImplementation(moving);
      remove.mockImplementation(removing);
    }
    expect(
      mockFiles.has(migrationTemp(VAULT_OLDER_BACKUP)) &&
        mockAsync.has('persist:root'),
    ).toBe(true);
    edit(state, 'delete-key');
    await ordinarySave(state, key);
    state.BITPAY_ID.apiToken = 'second normal test save';
    const latest = await ordinarySave(state, key);
    restart();
    const code = await outcome('C:independent-bak-async', () => freshModules());
    expect(root.getString('persist:root') === latest).toBe(true);
    expect(code === 'RESOLVED').toBe(true);
    expect(complete()).toBe(true);
    expect(
      mockFiles.has(migrationTemp(VAULT_OLDER_BACKUP)) ||
        mockAsync.has('persist:root'),
    ).toBe(false);
  });

  it.each([false, true])(
    'C changed independent source preserves converted-wallet access (last key removed=%s)',
    async lastKeyRemoved => {
      const state = stateWithSdkKey();
      const key = await pending('async', state);
      if (lastKeyRemoved) {
        edit(state, 'delete-key');
        await ordinarySave(state, key);
      }
      const changed = stateWithSdkKey();
      const replacement = await save(changed);
      mockAsync.set('persist:root', replacement);
      const primary = root.getString('persist:root');
      restart();
      const code = await outcome('C:changed-source:strict', () =>
        freshModules(),
      );
      expect(code === 'RESOLVED').toBe(true);
      expect(
        mockAsync.get('persist:root') === replacement &&
          root.getString('persist:root') === primary,
      ).toBe(true);
      expect(complete()).toBe(false);
      expect(Buffer.from(key, 'base64').length).toBe(32);
      // Only a justified metadata update is permitted; no primary/source/key mutation.
      expect(
        mockWrites.every(w => w.startsWith(`mmkv:${VAULT_RECORD_ID}:set:`)),
      ).toBe(true);
    },
  );

  it.each(['inventory', 'pre-delete', 'verification'])(
    'F recorded conversion survives a later %s cleanup read rejection',
    async boundary => {
      const state = stateWithSdkKey();
      state.APP.migrationMMKVStorageComplete = true;
      await pending('main', state); // Required backup and primary verification have completed before this independent failure.
      const get = AsyncStorage.getItem as jest.Mock;
      const original = get.getMockImplementation()!;
      const failAt = {inventory: 1, 'pre-delete': 2, verification: 3}[
        boundary
      ]!;
      let reads = 0;
      get.mockImplementation(async name => {
        reads++;
        if (reads >= failAt) throw new Error('synthetic later read failure');
        return original(name);
      });
      restart();
      try {
        const code = await outcome(`F:historical-later:${boundary}`, () =>
          prepareVault(root),
        );
        expect(code === 'RESOLVED').toBe(true);
        expect(reads).toBe(failAt);
        expect(complete()).toBe(false);
        expect(mockCredentials.has(LEGACY_KEY_SERVICE)).toBe(true);
      } finally {
        get.mockImplementation(original);
      }
    },
  );

  it.each(['data-open', 'checksum-open'])(
    'CHARACTERIZATION E: cached %s has the same public observations as healthy loss',
    async model => {
      const state = stateWithSdkKey();
      await pending('async', state);
      let failedView = true,
        externalCausePresent = true,
        defaultWriteAttempts = 0;
      const originalGet = MMKV.prototype.getString,
        originalKeys = MMKV.prototype.getAllKeys,
        originalContains = MMKV.prototype.contains;
      const originalSet = MMKV.prototype.set;
      const getter = jest
        .spyOn(MMKV.prototype, 'getString')
        .mockImplementation(function (this: any, name) {
          return this.id === 'default' && failedView
            ? undefined
            : originalGet.call(this, name);
        });
      const keys = jest
        .spyOn(MMKV.prototype, 'getAllKeys')
        .mockImplementation(function (this: any) {
          return this.id === 'default' && failedView
            ? []
            : originalKeys.call(this);
        });
      const contains = jest
        .spyOn(MMKV.prototype, 'contains')
        .mockImplementation(function (this: any, name) {
          return this.id === 'default' && failedView
            ? false
            : originalContains.call(this, name);
        });
      const size = jest
        .spyOn(MMKV.prototype, 'size', 'get')
        .mockImplementation(function (this: any) {
          return this.id === 'default' && failedView ? 0 : this.model.actual;
        });
      const set = jest
        .spyOn(MMKV.prototype, 'set')
        .mockImplementation(function (this: any, name, value) {
          if (this.id === 'default' && failedView) defaultWriteAttempts++;
          if (this.id === 'default' && failedView && model === 'data-open')
            throw new Error('synthetic rejected failed-load write');
          return originalSet.call(this, name, value); // Checksum model WOULD accept a write.
        });
      try {
        // The harness knows the injected cause; production does not. Do not
        // impose opposite startup decisions on these identical observations.
        const observe = (instance: MMKV) => ({
          keys: instance.getAllKeys(),
          size: instance.size,
          contains: instance.contains('persist:root'),
          root: instance.getString('persist:root'),
        });
        const empty = new MMKV({id: 'healthy-empty-characterization'});
        expect(isEqual(observe(root), observe(empty))).toBe(true);
        externalCausePresent = false;
        expect(isEqual(observe(new MMKV()), observe(empty))).toBe(true);
        expect(externalCausePresent).toBe(false);
        expect(failedView).toBe(true);
        expect(defaultWriteAttempts).toBe(0); // No production call or probe required to observe aliasing.
        // A fixture-only write demonstrates the modeled capability difference.
        // This is not an allowed production health probe or a native experiment.
        const probe = () => root.set('characterization-probe', 'nonsecret');
        if (model === 'data-open') expect(probe).toThrow();
        else expect(probe).not.toThrow();
        expect(defaultWriteAttempts).toBe(1);
      } finally {
        getter.mockRestore();
        keys.mockRestore();
        contains.mockRestore();
        size.mockRestore();
        set.mockRestore();
      }
    },
  );

  it.each(['ios', 'android'])(
    'H completed records ignore new-extension leftovers on %s',
    async platform => {
      const key = await rkCompletedVault();
      const raw = root.getString('persist:root')!;
      root.delete('persist:root');
      const bridge = rkBridge();
      Platform.OS = platform as 'ios' | 'android';
      const size = jest
        .spyOn(MMKV.prototype, 'size', 'get')
        .mockImplementation(() => {
          throw new Error('new observation must not run');
        });
      try {
        for (const extension of [
          undefined,
          null,
          false,
          'invalid',
          [],
          {v: 999},
          {v: 1, unexpected: true},
        ]) {
          record.set(
            VAULT_RECORD_KEY,
            JSON.stringify({
              status: 'complete',
              wipeDone: true,
              conversionPlan: extension,
              cleanup: extension,
            }),
          );
          record.delete(RKSTORAGE_RECORD_KEY);
          restart();
          expect((await prepareVault(root)) === key).toBe(true);
          expect(
            mockWrites.every(
              w => w === `mmkv:${VAULT_RECORD_ID}:set:${RKSTORAGE_RECORD_KEY}`,
            ),
          ).toBe(true);
          const expectedBackup = mockFiles.get(VAULT_BACKUP)!;
          const recovered = await reduxStorage.getItem('persist:root');
          expect(
            recovered === expectedBackup &&
              root.getString('persist:root') === expectedBackup,
          ).toBe(true);
          expect(
            isEqual(
              (await restore(recovered!, key)).WALLET,
              (await restore(raw, key)).WALLET,
            ),
          ).toBe(true);
          expect(root.contains('persist:root')).toBe(true);
          root.delete('persist:root');
        }
        if (platform === 'android') expect(bridge.inspect).toHaveBeenCalled();
      } finally {
        size.mockRestore();
      }
    },
  );

  it('K pending launches have bounded reads and one deduplicated aggregate report', async () => {
    const state = stateWithSdkKey();
    state.APP.migrationMMKVStorageComplete = true;
    const key = await convertedPending(state);
    state.BITPAY_ID.apiToken = 'ordinary post-conversion change';
    await ordinarySave(state, key, false);
    const get = AsyncStorage.getItem as jest.Mock,
      move = RNFS.moveFile as jest.Mock;
    const getting = get.getMockImplementation()!,
      moving = move.getMockImplementation()!;
    let reads = 0;
    get.mockImplementation(async name => {
      reads++;
      if (reads === 3) throw new Error('synthetic verify failure');
      return getting(name);
    });
    move.mockImplementation(async (from, to) => {
      if (to === VAULT_BACKUP) throw new Error('synthetic optional failure');
      return moving(from, to);
    });
    const decrypt = jest.spyOn(require('./transforms/encrypt'), 'decryptValue');
    const outer = jest.spyOn(
      require('./transforms/encrypt'),
      'decryptPersistValue',
    );
    const strings = jest.spyOn(MMKV.prototype, 'getString');
    const keys = jest.spyOn(MMKV.prototype, 'getAllKeys');
    const sizes = jest.spyOn(MMKV.prototype, 'size', 'get');
    const log = jest.fn();
    const results: {reads: number; code: string; reports: number}[] = [];
    try {
      for (let launch = 0; launch < 3; launch++) {
        reads = 0;
        restart();
        jest.clearAllMocks(); // Counters only; neither native view nor stored data is reset.
        const code = await outcome(`K:retry:${launch}`, () =>
          prepareVault(root, log),
        );
        results.push({reads, code, reports: log.mock.calls.length});
        console.info(
          'STAGE_A_METRIC ' +
            JSON.stringify({
              launch,
              platformModel: 'android',
              hostTiming: 'Node',
              asyncReads: reads,
              fieldDecryptCalls: decrypt.mock.calls.length,
              reducerDecryptCalls: outer.mock.calls.length,
              mmkvStringReads: strings.mock.calls.length,
              mmkvKeyLists: keys.mock.calls.length,
              mmkvSizeReads: sizes.mock.calls.length,
              reportsThisAttempt: log.mock.calls.length,
              recordWrites: mockWrites.filter(w =>
                w.startsWith(`mmkv:${VAULT_RECORD_ID}:`),
              ).length,
            }),
        );
        expect(complete()).toBe(false);
      }
      expect(results.every(r => r.code === 'RESOLVED' && r.reads <= 3)).toBe(
        true,
      );
      expect(results.every(r => r.reports <= 1)).toBe(true);
      expect(results.reduce((sum, r) => sum + r.reports, 0) <= 2).toBe(true);
    } finally {
      get.mockImplementation(getting);
      move.mockImplementation(moving);
      decrypt.mockRestore();
      outer.mockRestore();
      strings.mockRestore();
      keys.mockRestore();
      sizes.mockRestore();
    }
  });

  it.each([
    'lost-empty',
    'deleted-loaded',
    'corrupt',
    'suspension-record-fails',
  ])(
    'E existing backup recovery remains available with pending cleanup: %s',
    async kind => {
      const state = stateWithSdkKey();
      const key = await pending('async', state);
      edit(state, 'password-set');
      await ordinarySave(state, key);
      // Recovery removes only the owned receipt; all retained application data remains.
      delete state.APP.bip02CleanupReceipt;
      const source = mockAsync.get('persist:root');
      const files = new Map(mockFiles);
      if (kind === 'lost-empty') {
        // Healthy newly opened empty store after modeled file loss. This is not
        // the failed-load view modeled above; public observations can alias.
        mockStores.set('default', new Map());
        mockModels.delete('default');
        expect(root.getAllKeys().length === 0 && root.size === 0).toBe(true);
      } else if (kind === 'corrupt')
        root.set('persist:root', 'synthetic corruption');
      else root.delete('persist:root');
      const original = MMKV.prototype.set;
      const set = jest
        .spyOn(MMKV.prototype, 'set')
        .mockImplementation(function (this: any, name, value) {
          if (kind === 'suspension-record-fails' && this.id === VAULT_RECORD_ID)
            throw new Error('synthetic cleanup metadata failure');
          return original.call(this, name, value);
        });
      restart();
      try {
        let openedKey: string | undefined, restored: string | null | undefined;
        const code = await outcome(`E:recovery:${kind}`, async () => {
          openedKey = await prepareVault(root);
          restored = await reduxStorage.getItem('persist:root');
        });
        expect(code === 'RESOLVED').toBe(true);
        expect(openedKey === key).toBe(true);
        expect(root.getString('persist:root') === restored).toBe(true);
        expect(
          await matchesRetainedPayload(restored ?? undefined, key, state),
        ).toBe(true);
        expect(
          isEqual((await restore(restored!, key)).WALLET, state.WALLET),
        ).toBe(true);
        expect(mockAsync.get('persist:root') === source).toBe(true);
        expect(isEqual(mockFiles, files)).toBe(true);
        expect(complete()).toBe(false);
        expect(mockCredentials.has(LEGACY_KEY_SERVICE)).toBe(true);
        expect(
          mockWrites.every(
            w =>
              w === 'mmkv:default:set:persist:root' ||
              w.startsWith(`mmkv:${VAULT_RECORD_ID}:set:`),
          ),
        ).toBe(true);
      } finally {
        set.mockRestore();
      }
      const recovered = root.getString('persist:root');
      // Recovery does not reopen legacy selection on the next JS-module launch.
      expect(
        await outcome(`E:recovered-retry:${kind}`, () =>
          freshModules(as =>
            as.getItem.mockRejectedValue(
              new Error('synthetic independent source failure'),
            ),
          ),
        ),
      ).toBe('RESOLVED');
      expect(root.getString('persist:root') === recovered).toBe(true);
    },
  );

  it.each(
    ['older-bak', 'current-main'].flatMap(recoveryKind =>
      ['recovery-call', 'completed-restore-cut'].map(entry => ({
        recoveryKind,
        entry,
      })),
    ),
  )(
    'E readable cleanup retry after failed suspension: $recoveryKind / $entry',
    async ({recoveryKind, entry}) => {
      const current = stateWithSdkKey();
      current.WALLET.keys.second = {
        ...stateWithSdkKey().WALLET.keys.readonly,
        id: 'second',
      };
      const older = JSON.parse(JSON.stringify(current));
      delete older.WALLET.keys.second;
      // The genuine conversion retains the exact A+B source after removal fails.
      // Do not fabricate future permission fields in this functional regression.
      const key = await pending('async', current);
      const source = mockAsync.get('persist:root')!;
      const savedRecord = record.getString(VAULT_RECORD_KEY);
      const hadConversion = conversionRecorded();
      seedFile(
        VAULT_OLDER_BACKUP,
        await save(retainedPayload(older), key, 'modern'),
      );
      const expected = recoveryKind === 'older-bak' ? older : current;
      root.delete('persist:root');
      if (recoveryKind === 'older-bak') mockFiles.delete(VAULT_BACKUP);
      const recoveryFiles = new Map(mockFiles);
      const original = MMKV.prototype.set;
      let rejectedRecordWrites = 0;
      const set = jest
        .spyOn(MMKV.prototype, 'set')
        .mockImplementation(function (this: any, name, value) {
          if (this.id === VAULT_RECORD_ID) {
            rejectedRecordWrites++;
            throw new Error('synthetic suspension persistence failure');
          }
          return original.call(this, name, value);
        });
      restart();
      let code: string;
      try {
        if (entry === 'completed-restore-cut') {
          // Explicit completed-call fixture, not evidence that the reference
          // actually reaches recovery. The rejected R leaves the old grant.
          root.set(
            'persist:root',
            await save(retainedPayload(expected), key, 'modern'),
          );
          expect(() => record.set(VAULT_RECORD_KEY, savedRecord!)).toThrow();
          code = 'RESOLVED';
        } else
          code = await outcome(
            `E:readable-recovery:${recoveryKind}`,
            async () => {
              await prepareVault(root);
              await reduxStorage.getItem('persist:root');
            },
          );
      } finally {
        set.mockRestore();
      }
      console.info(
        'STAGE_A_RECOVERY ' +
          JSON.stringify({
            label: `${recoveryKind}:${entry}`,
            code,
            rejectedRecordWrites,
            originalRecordRetained:
              record.getString(VAULT_RECORD_KEY) === savedRecord,
            sourceRetained: mockAsync.get('persist:root') === source,
          }),
      );
      expect(code === 'RESOLVED').toBe(true);
      expect(
        await matchesRetainedPayload(
          root.getString('persist:root'),
          key,
          expected,
        ),
      ).toBe(true);
      expect(mockAsync.get('persist:root') === source).toBe(true);
      expect(isEqual(mockFiles, recoveryFiles)).toBe(true);
      expect(record.getString(VAULT_RECORD_KEY) === savedRecord).toBe(true);
      expect(mockWrites.every(w => w === 'mmkv:default:set:persist:root')).toBe(
        true,
      );
      expect(complete()).toBe(false);
      // Readable source on a new JS realm: this is the previously missing case.
      // No read rejection may accidentally protect the old A+B copy.
      let successfulSourceReads = 0;
      for (let launch = 0; launch < 2; launch++) {
        restart();
        const before = root.getString('persist:root');
        const retry = await outcome(
          `E:readable-retry:${recoveryKind}:${launch}`,
          () =>
            freshModules(as => {
              const reading = as.getItem.getMockImplementation();
              as.getItem.mockImplementation(async (name: string) => {
                const raw = await reading(name);
                if (name === 'persist:root' && raw === source)
                  successfulSourceReads++;
                return raw;
              });
            }),
        );
        console.info(
          'STAGE_A_READABLE_RETRY ' +
            JSON.stringify({
              label: `${recoveryKind}:${entry}`,
              launch,
              code: retry,
              successfulSourceReads,
              sourceRetained: mockAsync.get('persist:root') === source,
            }),
        );
        expect(retry === 'RESOLVED').toBe(true);
        expect(root.getString('persist:root') === before).toBe(true);
        if (recoveryKind === 'older-bak') {
          expect(mockAsync.get('persist:root') === source).toBe(true);
          expect(complete()).toBe(false);
          expect(mockWrites.some(w => w.startsWith('async:delete:'))).toBe(
            false,
          );
        } else {
          // Fresh coverage can requalify disposal; recovery need not suspend it forever.
          expect(mockAsync.has('persist:root')).toBe(false);
          expect(complete()).toBe(true);
        }
      }
      expect(successfulSourceReads > 0).toBe(true);
      // Reference production has no separate milestone. Do not count an absent
      // future field as a functional red. Once recorded, however, it must survive.
      if (hadConversion) expect(conversionRecorded()).toBe(true);
      expect(mockCredentials.get(VAULT_KEY_SERVICE).password === key).toBe(
        true,
      );
    },
  );

  it('M optional post-conversion write failure remains nonblocking and retries', async () => {
    const state = stateWithSdkKey();
    const key = await convertedPending(state);
    state.BITPAY_ID.apiToken = 'synthetic ordinary edit';
    const current = await ordinarySave(state, key, false);
    (RNFS.writeFile as jest.Mock).mockRejectedValueOnce(
      new Error('synthetic optional write failure'),
    );
    restart();
    expect(await outcome('M:optional-write', () => prepareVault(root))).toBe(
      'RESOLVED',
    );
    expect(root.getString('persist:root') === current).toBe(true);
    expect(complete()).toBe(false);
    expect(mockCredentials.has(LEGACY_KEY_SERVICE)).toBe(true);
    expect(mockWrites.some(w => w.endsWith(':trim'))).toBe(false);
    restart();
    expect(
      await outcome('M:optional-write-retry', () => prepareVault(root)),
    ).toBe('RESOLVED');
    expect(complete()).toBe(true);
    expect(root.getString('persist:root') === current).toBe(true);
  });

  it.each(['missing', 'invalid', 'unreadable'])(
    'E %s modern key stops before any pending-state mutation',
    async kind => {
      await pending('main', stateWithSdkKey());
      if (kind === 'missing') mockCredentials.delete(VAULT_KEY_SERVICE);
      if (kind === 'invalid') seedKey(VAULT_KEY_SERVICE, 'invalid');
      if (kind === 'unreadable')
        (Keychain.getGenericPassword as jest.Mock).mockRejectedValueOnce(
          new Error('synthetic locked key'),
        );
      restart();
      const code = await outcome('E:key-unavailable', () => prepareVault(root));
      expect(code === 'MODERN_KEY_FAILURE').toBe(true);
      noWrites();
      expect(mockFiles.has(migrationTemp(VAULT_BACKUP))).toBe(true);
    },
  );

  it.each(['main', 'bak'])(
    'L converted wallet preserves an unexpected %s temp from deletion and overwrite',
    async slot => {
      const state = stateWithSdkKey();
      const key = await convertedPending(state);
      state.BITPAY_ID.apiToken =
        'ordinary change requiring optional backup refresh';
      const latest = await ordinarySave(state, key, false);
      const path = migrationTemp(
        slot === 'main' ? VAULT_BACKUP : VAULT_OLDER_BACKUP,
      );
      const unknown = await save(stateWithSdkKey(), key, 'modern');
      seedFile(path, unknown);
      const files = new Map(mockFiles);
      restart();
      const code = await outcome(`L:unknown-temp:${slot}`, () =>
        prepareVault(root),
      );
      expect(
        root.getString('persist:root') === latest &&
          mockFiles.get(path) === unknown,
      ).toBe(true);
      expect(isEqual(mockFiles, files)).toBe(true);
      expect(code === 'RESOLVED').toBe(true);
      expect(complete()).toBe(false);
      expect(
        mockWrites.every(w => w.startsWith(`mmkv:${VAULT_RECORD_ID}:set:`)),
      ).toBe(true);
    },
  );

  it('L failed independent cleanup-intent write withholds work, not the converted wallet', async () => {
    const state = stateWithSdkKey();
    const key = await convertedPending(state);
    state.BITPAY_ID.apiToken = 'ordinary change before optional refresh';
    const latest = await ordinarySave(state, key, false);
    const before = record.getString(VAULT_RECORD_KEY);
    const files = new Map(mockFiles);
    const original = MMKV.prototype.set;
    let denied = 0;
    const set = jest
      .spyOn(MMKV.prototype, 'set')
      .mockImplementation(function (this: any, name, value) {
        if (this.id === VAULT_RECORD_ID) {
          denied++;
          throw new Error('synthetic permission write denied');
        }
        return original.call(this, name, value);
      });
    restart();
    try {
      expect(
        await outcome('L:intent-write-denied', () => prepareVault(root)),
      ).toBe('RESOLVED');
      expect(denied > 0).toBe(true);
      expect(record.getString(VAULT_RECORD_KEY) === before).toBe(true);
      expect(root.getString('persist:root') === latest).toBe(true);
      expect(isEqual(mockFiles, files)).toBe(true);
      expect(complete()).toBe(false);
      noWrites();
    } finally {
      set.mockRestore();
    }
  });

  // These are exactly the five existing fs-backup exclusions. Apply no
  // additional wallet-only projection: BITPAY_ID and every other retained
  // reducer (including _persist) must compare in full.
  const includePlannedReceipt = (state: any) => {
    const value = JSON.parse(record.getString(VAULT_RECORD_KEY) ?? 'null');
    const receipt =
      value?.conversionPlan?.primaryReceipt ?? value?.cleanup?.primaryReceipt;
    if (receipt !== undefined) {
      expect(
        typeof receipt === 'string' && /^[a-f0-9]{32}$/.test(receipt),
      ).toBe(true);
      state.APP = {...state.APP, bip02CleanupReceipt: receipt};
    }
    return state;
  };
  const retainedPayload = (state: any) =>
    Object.fromEntries(
      Object.entries(state).filter(
        ([name]) =>
          ![
            'MARKET_STATS',
            'PORTFOLIO',
            'PORTFOLIO_CHARTS',
            'RATE',
            'SHOP_CATALOG',
          ].includes(name),
      ),
    );
  it('M retained-payload oracle rejects stale non-wallet data with identical wallet keys', async () => {
    const state = stateWithSdkKey();
    const key = crypto.randomBytes(32).toString('base64');
    const backup = require('./backup/fs-backup');
    await backup.backupPersistRoot(await save(state, key, 'modern'));
    expect(
      await matchesRetainedPayload(mockFiles.get(VAULT_BACKUP), key, state),
    ).toBe(true);
    const stale = {
      ...state,
      BITPAY_ID: {apiToken: 'synthetic stale retained token'},
    };
    expect(isEqual(stale.WALLET, state.WALLET)).toBe(true);
    expect(
      await matchesRetainedPayload(
        await save(stale, key, 'modern'),
        key,
        state,
      ),
    ).toBe(false);
    const excluded = {...state, MARKET_STATS: {downloadAgain: 'different'}};
    expect(
      await matchesRetainedPayload(
        await save(excluded, key, 'modern'),
        key,
        state,
      ),
    ).toBe(true);
  });

  const matchesRetainedPayload = async (
    raw: string | undefined,
    key: string | undefined,
    state: any,
  ) => {
    if (!raw || !key) return false;
    try {
      const decoded = await restore(raw, key);
      const actual = JSON.parse(JSON.stringify(retainedPayload(decoded)));
      const expected = JSON.parse(JSON.stringify(retainedPayload(state)));
      return isEqual(actual, expected);
    } catch {
      return false;
    }
  };

  it('M final-verification control detects omission after successful promotion', async () => {
    const {promoteVaultFile} = require('./backup/vault-files');
    const key = crypto.randomBytes(32).toString('base64');
    const state = stateWithSdkKey();
    const expected = await save(retainedPayload(state), key, 'modern');
    const wrong = await save(
      retainedPayload({
        ...state,
        BITPAY_ID: {apiToken: 'synthetic stale token'},
      }),
      key,
      'modern',
    );
    const move = RNFS.moveFile as jest.Mock;
    const moving = move.getMockImplementation()!;
    move.mockImplementation(async (...args) => {
      await moving(...args);
      if (args[1] === VAULT_BACKUP) mockFiles.set(VAULT_BACKUP, wrong);
    });
    try {
      for (const omitFinalVerification of [false, true]) {
        seedFile(migrationTemp(VAULT_BACKUP), expected);
        let checked = false;
        const attempt = promoteVaultFile(VAULT_BACKUP, (raw: string) => {
          // Deliberate test-only mutant: same real promotion, omitted check.
          if (omitFinalVerification) return;
          checked = true;
          if (raw !== expected) throw new Error('synthetic final mismatch');
        });
        const rejected = await attempt.then(
          () => false,
          () => true,
        );
        expect(rejected).toBe(!omitFinalVerification);
        expect(checked).toBe(!omitFinalVerification);
        expect(mockFiles.has(migrationTemp(VAULT_BACKUP))).toBe(false);
        expect(
          await matchesRetainedPayload(mockFiles.get(VAULT_BACKUP), key, state),
        ).toBe(false);
      }
    } finally {
      move.mockImplementation(moving);
    }
  });

  it.each(['root', 'root-with-older-backup', 'async'])(
    'M current backup is read and verified before the first conversion write: %s',
    async source => {
      const current = stateWithSdkKey();
      const raw = await save(current);
      if (source === 'async') mockAsync.set('persist:root', raw);
      else root.set('persist:root', raw);
      if (source === 'root-with-older-backup')
        seedFile(VAULT_BACKUP, await save(stateWithSdkKey()));
      seedKey(LEGACY_KEY_SERVICE, legacyKey);
      const read = RNFS.readFile as jest.Mock;
      const reading = read.getMockImplementation()!;
      let currentMainRead = false;
      read.mockImplementation(async (path, ...args) => {
        const value = await reading(path, ...args);
        if (path === VAULT_BACKUP)
          currentMainRead = await matchesRetainedPayload(
            value,
            mockCredentials.get(VAULT_KEY_SERVICE)?.password,
            includePlannedReceipt(current),
          );
        return value;
      });
      const original = MMKV.prototype.set;
      const readyAtRootWrite: boolean[] = [];
      const set = jest
        .spyOn(MMKV.prototype, 'set')
        .mockImplementation(function (this: any, name, value) {
          if (this.id === 'default' && name === 'persist:root')
            readyAtRootWrite.push(currentMainRead);
          return original.call(this, name, value);
        });
      try {
        expect(
          await outcome(`M:backup-first:${source}`, () => prepareVault(root)),
        ).toBe('RESOLVED');
        expect(
          readyAtRootWrite.length === 1 && readyAtRootWrite.every(Boolean),
        ).toBe(true);
        expect(currentMainRead).toBe(true);
      } finally {
        set.mockRestore();
        read.mockImplementation(reading);
      }
    },
  );

  it.each([
    'write',
    'promotion',
    'temp-read-error',
    'temp-wrong-retained',
    'final-read-error',
    'final-wrong-retained',
  ])(
    'M required current-backup %s failure preserves the original primary',
    async failure => {
      const state = stateWithSdkKey();
      const wrong = {
        ...state,
        BITPAY_ID: {apiToken: 'synthetic stale retained token'},
      };
      const raw = await save(state);
      root.set('persist:root', raw);
      seedKey(LEGACY_KEY_SERVICE, legacyKey);
      const operation = (
        failure === 'write'
          ? RNFS.writeFile
          : failure === 'promotion'
          ? RNFS.moveFile
          : RNFS.readFile
      ) as jest.Mock;
      const original = operation.getMockImplementation()!;
      let hit = false,
        promoted = false;
      const move = RNFS.moveFile as jest.Mock;
      const moving = move.getMockImplementation()!;
      // Arm final faults only after native promotion has actually succeeded.
      if (failure.startsWith('final-'))
        move.mockImplementation(async (...args) => {
          await moving(...args);
          if (args[1] === VAULT_BACKUP) promoted = true;
        });
      operation.mockImplementation(async (...args) => {
        const selected =
          failure === 'promotion'
            ? args[1] === VAULT_BACKUP
            : failure.startsWith('final-')
            ? promoted && args[0] === VAULT_BACKUP
            : args[0] === migrationTemp(VAULT_BACKUP);
        if (selected) {
          hit = true;
          if (failure.endsWith('wrong-retained'))
            return save(
              includePlannedReceipt(wrong),
              mockCredentials.get(VAULT_KEY_SERVICE).password,
              'modern',
            );
          throw new Error('synthetic required backup failure');
        }
        return original(...args);
      });
      restart();
      try {
        const code = await outcome(`M:backup-failure:${failure}`, () =>
          prepareVault(root),
        );
        expect(hit).toBe(true);
        if (failure.startsWith('final-')) expect(promoted).toBe(true);
        expect(code !== 'RESOLVED').toBe(true);
        expect(root.getString('persist:root') === raw).toBe(true);
        expect(
          mockWrites.some(w => w === 'mmkv:default:set:persist:root'),
        ).toBe(false);
        expect(mockCredentials.has(LEGACY_KEY_SERVICE)).toBe(true);
        expect(complete()).toBe(false);
        expect(conversionRecorded()).toBe(false);
      } finally {
        operation.mockImplementation(original);
        if (failure.startsWith('final-')) move.mockImplementation(moving);
      }
    },
  );

  it.each(['before-root-write', 'native-write-loss', 'before-marker'])(
    'N interrupted conversion resumes from its prepared backup: %s',
    async boundary => {
      const state = stateWithSdkKey();
      const raw = await save(state);
      root.set('persist:root', raw);
      mockAsync.set('persist:root', raw);
      seedKey(LEGACY_KEY_SERVICE, legacyKey);
      const read = RNFS.readFile as jest.Mock,
        reading = read.getMockImplementation()!;
      let mainVerified = false,
        written = false,
        rootReadBack = false,
        interrupted = false,
        backupBeforeFault = false;
      read.mockImplementation(async (path, ...args) => {
        const value = await reading(path, ...args);
        if (path === VAULT_BACKUP)
          mainVerified = await matchesRetainedPayload(
            value,
            mockCredentials.get(VAULT_KEY_SERVICE)?.password,
            includePlannedReceipt(state),
          );
        return value;
      });
      const originalSet = MMKV.prototype.set,
        originalGet = MMKV.prototype.getString;
      const get = jest
        .spyOn(MMKV.prototype, 'getString')
        .mockImplementation(function (this: any, name) {
          const value = originalGet.call(this, name);
          if (this.id === 'default' && name === 'persist:root' && written)
            rootReadBack = true;
          return value;
        });
      const set = jest
        .spyOn(MMKV.prototype, 'set')
        .mockImplementation(function (this: any, name, value) {
          if (this.id === 'default' && name === 'persist:root') {
            if (boundary !== 'before-marker') {
              if (boundary === 'native-write-loss')
                this.model.delete('persist:root'); // Model partial native failure, not an application clear.
              interrupted = true;
              backupBeforeFault = mainVerified;
              mockDead = true;
              throw new Error('modeled process interruption');
            }
            originalSet.call(this, name, value);
            written = true;
            return;
          }
          if (
            boundary === 'before-marker' &&
            this.id === VAULT_RECORD_ID &&
            written &&
            rootReadBack
          ) {
            interrupted = true;
            backupBeforeFault = mainVerified;
            mockDead = true;
            throw new Error('modeled record-boundary interruption');
          }
          return originalSet.call(this, name, value);
        });
      try {
        await outcome(`N:cut:${boundary}`, () => prepareVault(root));
      } finally {
        set.mockRestore();
        get.mockRestore();
        read.mockImplementation(reading);
      }
      restart();
      expect(interrupted).toBe(true);
      const key = mockCredentials.get(VAULT_KEY_SERVICE).password;
      const prepared = mockFiles.get(VAULT_BACKUP);
      const preparedRetained = await matchesRetainedPayload(
        prepared,
        key,
        state,
      );
      // A later independent source must not replace the selected/prepared wallet.
      const changedSource = await save(stateWithSdkKey());
      mockAsync.set('persist:root', changedSource);
      const code = await outcome(`N:resume:${boundary}`, () => freshModules());
      const selectedWalletRestored = await matchesRetainedPayload(
        root.getString('persist:root'),
        key,
        state,
      );
      const independentSourceRetained =
        mockAsync.get('persist:root') === changedSource;
      console.info(
        'STAGE_A_BOUNDARY ' +
          JSON.stringify({
            boundary,
            backupBeforeFault,
            preparedRetained,
            resumed: code === 'RESOLVED',
            selectedWalletRestored,
            independentSourceRetained,
          }),
      );
      expect(backupBeforeFault && preparedRetained).toBe(true);
      expect(code === 'RESOLVED').toBe(true);
      expect(
        await matchesRetainedPayload(
          root.getString('persist:root'),
          key,
          includePlannedReceipt(state),
        ),
      ).toBe(true);
      expect(mockAsync.get('persist:root') === changedSource).toBe(true);
      expect(mockCredentials.get(VAULT_KEY_SERVICE).password === key).toBe(
        true,
      );
      expect(complete()).toBe(false); // Changed independent source remains unresolved.
    },
  );

  it('N failure to record conversion blocks admission, then retries without legacy re-import', async () => {
    const state = stateWithSdkKey(),
      raw = await save(state);
    root.set('persist:root', raw);
    mockAsync.set('persist:root', raw);
    seedKey(LEGACY_KEY_SERVICE, legacyKey);
    const original = MMKV.prototype.set;
    let rootWritten = false,
      denied = 0;
    const set = jest
      .spyOn(MMKV.prototype, 'set')
      .mockImplementation(function (this: any, name, value) {
        if (this.id === VAULT_RECORD_ID && rootWritten) {
          denied++;
          throw new Error('synthetic milestone persistence failure');
        }
        original.call(this, name, value);
        if (this.id === 'default' && name === 'persist:root')
          rootWritten = true;
      });
    let code: string;
    try {
      code = await outcome('N:conversion-record-failed', () =>
        prepareVault(root),
      );
    } finally {
      set.mockRestore();
    }
    expect(denied > 0).toBe(true);
    expect(code !== 'RESOLVED').toBe(true);
    expect(complete()).toBe(false);
    expect(mockAsync.get('persist:root') === raw).toBe(true);
    const key = mockCredentials.get(VAULT_KEY_SERVICE).password;
    expect(
      await matchesRetainedPayload(
        mockFiles.get(VAULT_BACKUP),
        key,
        includePlannedReceipt(state),
      ),
    ).toBe(true);
    const changed = await save(stateWithSdkKey());
    mockAsync.set('persist:root', changed);
    expect(
      await outcome('N:conversion-record-retry', () => freshModules()),
    ).toBe('RESOLVED');
    expect(
      await matchesRetainedPayload(
        root.getString('persist:root'),
        key,
        includePlannedReceipt(state),
      ),
    ).toBe(true);
    expect(mockAsync.get('persist:root') === changed).toBe(true);
  });

  it.each(['legacy', 'modern-unrecorded'])(
    'P genuinely unresolved pre-conversion wallets remain read-only: %s',
    async kind => {
      const key = crypto.randomBytes(32).toString('base64');
      const modern = kind === 'modern-unrecorded';
      const current = await save(
        stateWithSdkKey(),
        modern ? key : legacyKey,
        modern ? 'modern' : 'fields',
      );
      const independent = await save(stateWithSdkKey());
      root.set('persist:root', current);
      mockAsync.set('persist:root', independent);
      seedKey(LEGACY_KEY_SERVICE, legacyKey);
      if (modern) seedKey(VAULT_KEY_SERVICE, key);
      restart();
      expect(
        await outcome(`P:preconversion-conflict:${kind}`, () =>
          prepareVault(root),
        ),
      ).toBe('SOURCE_CONFLICT');
      expect(
        root.getString('persist:root') === current &&
          mockAsync.get('persist:root') === independent,
      ).toBe(true);
      expect(mockCredentials.has(VAULT_KEY_SERVICE)).toBe(modern);
      if (modern)
        expect(mockCredentials.get(VAULT_KEY_SERVICE).password === key).toBe(
          true,
        );
      noWrites();
    },
  );
  describe('Stage B implementation', () => {
    it('issues one receipt with exact plan, record, primary and retained-backup agreement', async () => {
      const original = MMKV.prototype.set;
      let plannedReceipt: string | undefined, plannedDigest: string | undefined;
      const set = jest
        .spyOn(MMKV.prototype, 'set')
        .mockImplementation(function (this: any, name, value) {
          if (this.id === VAULT_RECORD_ID && name === VAULT_RECORD_KEY) {
            const r = JSON.parse(value as string);
            if (r.conversionPlan) {
              plannedReceipt = r.conversionPlan.primaryReceipt;
              plannedDigest = r.conversionPlan.mainDigest;
            }
          }
          return original.call(this, name, value);
        });
      const state = stateWithSdkKey(true);
      let key: string;
      try {
        key = await convertedPending(state, true);
      } finally {
        set.mockRestore();
      }
      const r = JSON.parse(record.getString(VAULT_RECORD_KEY)!);
      const primary = await restore(root.getString('persist:root')!, key!);
      const backup = await restore(mockFiles.get(VAULT_BACKUP)!, key!);
      expect(
        typeof plannedReceipt === 'string' &&
          /^[a-f0-9]{32}$/.test(plannedReceipt),
      ).toBe(true);
      expect(r.conversionComplete).toBe(true);
      expect(r.conversionPlan === undefined).toBe(true);
      expect(
        r.cleanup.primaryReceipt === plannedReceipt &&
          primary.APP.bip02CleanupReceipt === plannedReceipt &&
          backup.APP.bip02CleanupReceipt === plannedReceipt,
      ).toBe(true);
      expect(
        crypto
          .createHash('sha256')
          .update(mockFiles.get(VAULT_BACKUP)!)
          .digest('hex') === plannedDigest,
      ).toBe(true);
      same(backup, retainedPayload(primary));
      same(primary.WALLET, state.WALLET); // Opaque password fields survive.
    });

    it.each(['ios', 'android'] as const)(
      'keeps genuine fresh %s initialization distinct from a lost converted wallet',
      async platform => {
        Platform.OS = platform;
        const key = await migrateVault(root);
        expect(
          JSON.parse(record.getString(VAULT_RECORD_KEY)!).initializing,
        ).toBe(true);
        expect(await reduxStorage.getItem('persist:root')).toBeNull();
        const raw = await save(stateWithSdkKey(), key, 'modern');
        const write = jest.spyOn(
          require('./backup/fs-backup'),
          'backupPersistRoot',
        );
        try {
          await reduxStorage.setItem('persist:root', raw);
          for (const call of write.mock.results)
            if (call.type === 'return') await call.value;
        } finally {
          write.mockRestore();
        }
        expect(
          JSON.parse(record.getString(VAULT_RECORD_KEY)!).initializing ===
            undefined,
        ).toBe(true);
        root.delete('persist:root');
        mockFiles.clear();
        const legacy = await save(stateWithSdkKey());
        mockAsync.set('persist:root', legacy);
        restart();
        await expect(reduxStorage.getItem('persist:root')).rejects.toThrow(
          'PRESERVATION_FAILURE',
        );
        expect(root.contains('persist:root')).toBe(false);
        expect(mockAsync.get('persist:root') === legacy).toBe(true);
        expect(complete()).toBe(true);
        noWrites();
      },
    );

    it('does not re-import a legacy source after all converted modern copies are lost', async () => {
      const key = await pending('async', stateWithSdkKey());
      const source = mockAsync.get('persist:root');
      root.delete('persist:root');
      mockFiles.clear();
      restart();
      await expect(prepareVault(root).then(() => undefined)).rejects.toThrow(
        'PRESERVATION_FAILURE',
      );
      expect(mockAsync.get('persist:root') === source).toBe(true);
      expect(root.contains('persist:root')).toBe(false);
      expect(conversionRecorded()).toBe(true);
      expect(mockCredentials.get(VAULT_KEY_SERVICE).password === key).toBe(
        true,
      );
      noWrites();
    });
    it('does not replace a known unsupported modern primary using a recovery backup', async () => {
      await pending('async', stateWithSdkKey());
      const raw = JSON.parse(root.getString('persist:root')!);
      raw.PORTFOLIO_CHARTS = JSON.stringify(JSON.stringify({branchOnly: true}));
      const current = JSON.stringify(raw);
      root.set('persist:root', current);
      restart();
      await expect(prepareVault(root).then(() => undefined)).rejects.toThrow(
        'UNSUPPORTED_FORMAT',
      );
      expect(root.getString('persist:root') === current).toBe(true);
      expect(conversionRecorded()).toBe(true);
      noWrites();
    });

    it.each([false, true])(
      'real rehydration, APP reducer and persistence retain receipt state (recovered=%s)',
      async recovered => {
        const key = await pending('async', stateWithSdkKey());
        if (recovered) {
          root.delete('persist:root');
          await prepareVault(root);
        }
        const initial = await restore(root.getString('persist:root')!, key);
        const expected = initial.APP.bip02CleanupReceipt;
        expect(
          recovered ? expected === undefined : typeof expected === 'string',
        ).toBe(true);
        const originalRecord = record.getString(VAULT_RECORD_KEY);
        const {appReducer} = require('./app/app.reducer');
        const reducer = persistReducer(
          {
            key: 'root',
            storage: reduxStorage,
            transforms: [
              encryptSpecificFields(key),
              persistEncryptionTransform(key),
            ],
            timeout: 0,
          },
          (
            state: any = {APP: appReducer(undefined, {type: '@@fixture'})},
            action: any,
          ) => ({...state, APP: appReducer(state.APP, action)}),
        );
        const store = createStore(reducer);
        let persistor: ReturnType<typeof persistStore>;
        await new Promise<void>(resolve => {
          persistor = persistStore(store, undefined, resolve);
        });
        expect(store.getState().APP.bip02CleanupReceipt === expected).toBe(
          true,
        );
        store.dispatch(setMigrationMMKVStorageComplete());
        await persistor!.flush();
        persistor!.pause();
        const saved = await restore(root.getString('persist:root')!, key);
        expect(saved.APP.bip02CleanupReceipt === expected).toBe(true);
        expect(record.getString(VAULT_RECORD_KEY) === originalRecord).toBe(
          true,
        );
        same(saved.WALLET, initial.WALLET);
      },
    );

    it.each(['malformed', 'unreadable', 'lost-wallet'])(
      'RK marker failure is independent only with verified usable state: %s',
      async kind => {
        const key = await rkCompletedVault();
        record.set(RKSTORAGE_RECORD_KEY, 'malformed');
        if (kind === 'lost-wallet') {
          root.delete('persist:root');
          mockFiles.clear();
        }
        const original = MMKV.prototype.getString;
        const get = jest
          .spyOn(MMKV.prototype, 'getString')
          .mockImplementation(function (this: any, name) {
            if (name === RKSTORAGE_RECORD_KEY && kind === 'unreadable')
              throw new Error('PRIVATE_MARKER_ERROR');
            return original.call(this, name);
          });
        restart();
        try {
          if (kind === 'lost-wallet')
            await expect(
              prepareVault(root).then(() => undefined),
            ).rejects.toThrow('PRESERVATION_FAILURE');
          else expect((await prepareVault(root)) === key).toBe(true);
          expect(conversionRecorded()).toBe(true);
          expect(mockWrites.length).toBe(0);
        } finally {
          get.mockRestore();
        }
        expect(rkComplete()).toBe(false);
      },
    );

    it.each(['damaged', 'distinct-protected'])(
      'preserves an unresolved pre-conversion temp with no target: %s',
      async kind => {
        const key = crypto.randomBytes(32).toString('base64');
        seedKey(VAULT_KEY_SERVICE, key);
        root.set('persist:root', await save(stateWithSdkKey(), key, 'modern'));
        const temp =
          kind === 'damaged'
            ? 'synthetic partial unknown copy'
            : await save(stateWithSdkKey(), key, 'modern');
        seedFile(migrationTemp(VAULT_BACKUP), temp);
        const primary = root.getString('persist:root');
        restart();
        await expect(prepareVault(root).then(() => undefined)).rejects.toThrow(
          'SOURCE_CONFLICT',
        );
        expect(root.getString('persist:root') === primary).toBe(true);
        expect(mockFiles.get(migrationTemp(VAULT_BACKUP)) === temp).toBe(true);
        noWrites();
      },
    );

    it('strict promotion verifies source identity before removing a target', async () => {
      const {promoteVaultFile} = require('./backup/vault-files');
      seedFile(VAULT_BACKUP, 'prior-target');
      seedFile(migrationTemp(VAULT_BACKUP), 'independent-new-temp');
      restart();
      await expect(
        promoteVaultFile(VAULT_BACKUP, () => {}, undefined, 'owned-temp'),
      ).rejects.toThrow();
      expect(mockFiles.get(VAULT_BACKUP) === 'prior-target').toBe(true);
      expect(
        mockFiles.get(migrationTemp(VAULT_BACKUP)) === 'independent-new-temp',
      ).toBe(true);
      noWrites();
    });
    it('strict replacement cannot overwrite an occupied independent temp', async () => {
      const {replaceVaultFile} = require('./backup/vault-files');
      seedFile(VAULT_BACKUP, 'prior-target');
      seedFile(migrationTemp(VAULT_BACKUP), 'independent-temp');
      restart();
      await expect(
        replaceVaultFile(VAULT_BACKUP, 'planned-current', () => {}),
      ).rejects.toThrow();
      expect(mockFiles.get(VAULT_BACKUP) === 'prior-target').toBe(true);
      expect(
        mockFiles.get(migrationTemp(VAULT_BACKUP)) === 'independent-temp',
      ).toBe(true);
      noWrites();
    });

    it.each([
      'missing',
      'malformed',
      'mismatch',
      'obsolete-binding',
      'malformed-cleanup',
    ])(
      'withholds historical disposal without denying the converted wallet: %s',
      async kind => {
        const key = await pending('async', stateWithSdkKey());
        const source = mockAsync.get('persist:root');
        const state = await restore(root.getString('persist:root')!, key);
        edit(state, 'delete-key');
        if (kind === 'missing') delete state.APP.bip02CleanupReceipt;
        if (kind === 'malformed') state.APP.bip02CleanupReceipt = 'malformed';
        if (kind === 'mismatch') state.APP.bip02CleanupReceipt = '0'.repeat(32);
        const r = JSON.parse(record.getString(VAULT_RECORD_KEY)!);
        if (kind === 'obsolete-binding')
          r.cleanup.async.digest = '0'.repeat(64);
        if (kind === 'malformed-cleanup') r.cleanup = {v: 999};
        record.set(VAULT_RECORD_KEY, JSON.stringify(r));
        const raw = await save(state, key, 'modern');
        root.set('persist:root', raw);
        for (let launch = 0; launch < 2; launch++) {
          restart();
          expect((await freshModules()) === key).toBe(true);
          expect(root.getString('persist:root') === raw).toBe(true);
          expect(mockAsync.get('persist:root') === source).toBe(true);
          expect(conversionRecorded()).toBe(true);
          expect(complete()).toBe(false);
          expect(
            mockWrites.some(
              w => w.startsWith('keychain:') || w.startsWith('async:delete:'),
            ),
          ).toBe(false);
        }
      },
    );

    it.each(['main', 'bak'])(
      'restores %s without its matching receipt and does not replenish it through rehydration/saves',
      async source => {
        const current = stateWithSdkKey();
        current.WALLET.keys.second = {
          ...stateWithSdkKey().WALLET.keys.readonly,
          id: 'second',
        };
        const key = await pending('async', current);
        const oldSource = mockAsync.get('persist:root');
        const older = await restore(root.getString('persist:root')!, key);
        delete older.WALLET.keys.second;
        const path = source === 'main' ? VAULT_BACKUP : VAULT_OLDER_BACKUP;
        const copy = await save(retainedPayload(older), key, 'modern');
        seedFile(path, copy);
        if (source === 'bak') mockFiles.delete(VAULT_BACKUP);
        root.delete('persist:root');
        restart();
        await prepareVault(root);
        const restored = await reduxStorage.getItem('persist:root');
        const decoded = await restore(restored!, key);
        expect(decoded.APP.bip02CleanupReceipt === undefined).toBe(true);
        const expected = {...older, APP: {...older.APP}};
        delete expected.APP.bip02CleanupReceipt;
        same(decoded, retainedPayload(expected));
        expect(mockFiles.get(path) === copy).toBe(true);
        expect(
          mockWrites.filter(w => w === 'mmkv:default:set:persist:root').length,
        ).toBe(1);
        expect(mockAsync.get('persist:root') === oldSource).toBe(true);
        // Actual APP reducer and serializer retain absence, including a normal
        // importer-flag update. No fixture drops the receipt after this point.
        decoded.APP = require('./app/app.reducer').appReducer(
          decoded.APP,
          setMigrationMMKVStorageComplete(),
        );
        await ordinarySave(decoded, key);
        restart();
        await freshModules();
        const after = await restore(root.getString('persist:root')!, key);
        expect(after.APP.bip02CleanupReceipt === undefined).toBe(true);
        expect(after.WALLET.keys.second === undefined).toBe(true);
        expect(mockAsync.get('persist:root') === oldSource).toBe(true);
        expect(conversionRecorded()).toBe(true);
        expect(complete()).toBe(false);
      },
    );

    it.each(['main', 'bak'])(
      'completed receipt-free %s root write remains safe after failed suspension and a modeled process cut',
      async source => {
        const current = stateWithSdkKey();
        current.WALLET.keys.second = {
          ...stateWithSdkKey().WALLET.keys.readonly,
          id: 'second',
        };
        const key = await pending('async', current);
        const legacy = mockAsync.get('persist:root');
        const originalRecord = record.getString(VAULT_RECORD_KEY);
        const older = await restore(root.getString('persist:root')!, key);
        delete older.WALLET.keys.second;
        const path = source === 'main' ? VAULT_BACKUP : VAULT_OLDER_BACKUP;
        seedFile(path, await save(retainedPayload(older), key, 'modern'));
        if (source === 'bak') mockFiles.delete(VAULT_BACKUP);
        root.delete('persist:root');
        const original = MMKV.prototype.set;
        let denied = 0,
          cut = false;
        const set = jest
          .spyOn(MMKV.prototype, 'set')
          .mockImplementation(function (this: any, name, value) {
            if (this.id === VAULT_RECORD_ID) {
              denied++;
              throw new Error('synthetic denied suspension');
            }
            original.call(this, name, value);
            if (this.id === 'default' && name === 'persist:root') {
              cut = true;
              mockDead = true;
              throw new Error('synthetic completed-call cut');
            }
          });
        restart();
        try {
          await expect(
            prepareVault(root).then(() => undefined),
          ).rejects.toThrow();
        } finally {
          set.mockRestore();
          restart();
        }
        expect(cut && denied === 1).toBe(true);
        expect(record.getString(VAULT_RECORD_KEY) === originalRecord).toBe(
          true,
        );
        let reads = 0;
        expect(
          (await freshModules(as => {
            const read = as.getItem.getMockImplementation();
            as.getItem.mockImplementation(async (name: string) => {
              reads++;
              return read(name);
            });
          })) === key,
        ).toBe(true);
        expect(reads > 0 && reads <= 3).toBe(true);
        expect(
          (await restore(root.getString('persist:root')!, key)).APP
            .bip02CleanupReceipt === undefined,
        ).toBe(true);
        expect(mockAsync.get('persist:root') === legacy).toBe(true);
        expect(conversionRecorded()).toBe(true);
        expect(complete()).toBe(false);
      },
    );

    it('rechecks AsyncStorage identity after persisting fresh coverage intent', async () => {
      const key = await pending('async', stateWithSdkKey());
      root.delete('persist:root');
      await prepareVault(root);
      const primary = root.getString('persist:root');
      const changed = await save(stateWithSdkKey());
      const original = MMKV.prototype.set;
      let changedAtIntent = false;
      const set = jest
        .spyOn(MMKV.prototype, 'set')
        .mockImplementation(function (this: any, name, value) {
          original.call(this, name, value);
          if (
            this.id === VAULT_RECORD_ID &&
            JSON.parse(value as string).cleanup?.async?.origin ===
              'current-coverage' &&
            !changedAtIntent
          ) {
            changedAtIntent = true;
            mockAsync.set('persist:root', changed);
          }
        });
      restart();
      try {
        expect((await prepareVault(root)) === key).toBe(true);
        expect(changedAtIntent).toBe(true);
        expect(mockAsync.get('persist:root') === changed).toBe(true);
        expect(root.getString('persist:root') === primary).toBe(true);
        expect(complete()).toBe(false);
        expect(mockWrites.some(w => w.startsWith('async:delete:'))).toBe(false);
      } finally {
        set.mockRestore();
      }
    });

    it.each(['unreadable', 'invalid'])(
      'does not defer a mandatory record that becomes %s after an optional intent failure',
      async kind => {
        const state = stateWithSdkKey();
        const key = await convertedPending(state);
        state.BITPAY_ID.apiToken = 'synthetic post-conversion edit';
        const primary = await ordinarySave(state, key, false);
        const files = new Map(mockFiles);
        const originalSet = MMKV.prototype.set,
          originalGet = MMKV.prototype.getString;
        let broken = false;
        const set = jest
          .spyOn(MMKV.prototype, 'set')
          .mockImplementation(function (this: any, name, value) {
            if (
              this.id === VAULT_RECORD_ID &&
              Object.values(JSON.parse(value as string).cleanup ?? {}).some(
                (v: any) => v?.origin === 'optional-refresh',
              )
            ) {
              broken = true;
              throw new Error('synthetic intent rejection');
            }
            return originalSet.call(this, name, value);
          });
        const get = jest
          .spyOn(MMKV.prototype, 'getString')
          .mockImplementation(function (this: any, name) {
            if (this.id === VAULT_RECORD_ID && broken) {
              if (kind === 'unreadable') throw new Error('PRIVATE_RECORD_READ');
              return '{invalid';
            }
            return originalGet.call(this, name);
          });
        restart();
        try {
          await expect(
            prepareVault(root).then(() => undefined),
          ).rejects.toThrow('PRESERVATION_FAILURE');
          expect(broken).toBe(true);
          expect(root.getString('persist:root') === primary).toBe(true);
          expect(isEqual(mockFiles, files)).toBe(true);
          noWrites();
        } finally {
          set.mockRestore();
          get.mockRestore();
        }
        await prepareVault(root);
        expect(complete()).toBe(true);
        expect(root.getString('persist:root') === primary).toBe(true);
      },
    );

    it.each(['write', 'read-back', 'delete', 'changed-source'])(
      'current-coverage cleanup after recovery preserves data on %s failure and safely retries',
      async failure => {
        const key = await pending('async', stateWithSdkKey());
        const source = mockAsync.get('persist:root')!;
        root.delete('persist:root');
        await prepareVault(root); // Current backup: fresh coverage can qualify later.
        expect(
          (await restore(root.getString('persist:root')!, key)).APP
            .bip02CleanupReceipt === undefined,
        ).toBe(true);
        const originalSet = MMKV.prototype.set,
          originalGet = MMKV.prototype.getString;
        const read = AsyncStorage.getItem as jest.Mock,
          removing = AsyncStorage.removeItem as jest.Mock;
        const reading = read.getMockImplementation()!,
          remove = removing.getMockImplementation()!;
        let hit = false,
          readBack = false,
          reads = 0;
        const set = jest
          .spyOn(MMKV.prototype, 'set')
          .mockImplementation(function (this: any, name, value) {
            if (
              this.id === VAULT_RECORD_ID &&
              JSON.parse(value as string).cleanup?.async?.origin ===
                'current-coverage'
            ) {
              if (failure === 'write') {
                hit = true;
                throw new Error('synthetic intent write failure');
              }
              if (failure === 'read-back') {
                hit = true;
                readBack = true;
              }
            }
            return originalSet.call(this, name, value);
          });
        const get = jest
          .spyOn(MMKV.prototype, 'getString')
          .mockImplementation(function (this: any, name) {
            if (this.id === VAULT_RECORD_ID && readBack) {
              readBack = false;
              throw new Error('synthetic intent read-back failure');
            }
            return originalGet.call(this, name);
          });
        const changed = await save(stateWithSdkKey());
        read.mockImplementation(async (name: string) => {
          reads++;
          if (failure === 'changed-source' && reads === 2) {
            hit = true;
            mockAsync.set('persist:root', changed);
          }
          return reading(name);
        });
        if (failure === 'delete')
          removing.mockImplementation(async () => {
            hit = true;
            throw new Error('synthetic delete failure');
          });
        restart();
        try {
          expect((await prepareVault(root)) === key).toBe(true);
          expect(hit).toBe(true);
          expect(
            mockAsync.get('persist:root') ===
              (failure === 'changed-source' ? changed : source),
          ).toBe(true);
          expect(complete()).toBe(false);
          expect(conversionRecorded()).toBe(true);
          expect(reads <= 3).toBe(true);
        } finally {
          set.mockRestore();
          get.mockRestore();
          read.mockImplementation(reading);
          removing.mockImplementation(remove);
        }
        if (failure === 'changed-source') {
          await freshModules();
          expect(mockAsync.get('persist:root') === changed).toBe(true);
          expect(complete()).toBe(false);
        } else {
          await freshModules();
          expect(mockAsync.has('persist:root')).toBe(false);
          expect(complete()).toBe(true);
        }
      },
    );

    it.each(['missing', 'malformed', 'wrong'])(
      'rejects the final backup with a %s planned receipt before any primary conversion',
      async kind => {
        const state = stateWithSdkKey();
        const original = await save(state);
        root.set('persist:root', original);
        const read = RNFS.readFile as jest.Mock,
          reading = read.getMockImplementation()!;
        let hit = false;
        read.mockImplementation(async (path: string) => {
          const raw = await reading(path);
          if (path !== VAULT_BACKUP) return raw;
          hit = true;
          const key = mockCredentials.get(VAULT_KEY_SERVICE).password;
          const changed = await restore(raw, key);
          if (kind === 'missing') delete changed.APP.bip02CleanupReceipt;
          else
            changed.APP.bip02CleanupReceipt =
              kind === 'wrong' ? '0'.repeat(32) : 'malformed';
          return save(changed, key, 'modern');
        });
        restart();
        try {
          await expect(
            prepareVault(root).then(() => undefined),
          ).rejects.toThrow('REQUIRED_COPY_FAILURE');
          expect(hit).toBe(true);
          expect(root.getString('persist:root') === original).toBe(true);
          expect(
            mockWrites.some(w => w === 'mmkv:default:set:persist:root'),
          ).toBe(false);
          expect(conversionRecorded()).toBe(false);
        } finally {
          read.mockImplementation(reading);
        }
        await prepareVault(root);
        expect(conversionRecorded()).toBe(true);
      },
    );
  });

  // ---------------------------------------------------------------------------
  // Consolidated acceptance list for the two Stage B reviews. Written against
  // a09199e with production unchanged; see the disposition table that ships
  // with this diff for the rule behind each expectation.
  //
  // Each case states a starting state, an injected failure, what must stay
  // safe while the failure lasts, and what must happen once it clears. A case
  // marked "(control)" passes on a09199e and pins behaviour a repair must keep.
  // Assertions compare booleans, fixed outcome codes and the ids of synthetic
  // keys; they never print wallet contents.
  // The numbering follows the findings in the review of e386a91; finding 3 is
  // closed by a09199e's own tests and finding 10 is an accepted limit.
  // Every expectation here is settled: by an owner ruling of 6 October, or by
  // governing text that both reviewers read the same way.
  describe('Consolidated repair implementation', () => {
    const captureRefreshCut = async (state: any, key: string) => {
      await ordinarySave(state, key, false);
      const unlink = RNFS.unlink as jest.Mock;
      const original = unlink.getMockImplementation()!;
      let cut = false;
      unlink.mockImplementation(async path => {
        const result = await original(path);
        if (path === VAULT_BACKUP && mockFiles.has(migrationTemp(path))) {
          cut = true;
          mockDead = true;
          throw new Error('synthetic completed-call interruption');
        }
        return result;
      });
      try {
        await prepareVault(root).catch(() => undefined);
      } finally {
        unlink.mockImplementation(original);
        restart();
      }
      expect(cut).toBe(true);
    };

    it.each([false, true])(
      'section 4: replacement-temp recovery cannot revive a stale source grant (cut=%s)',
      async cut => {
        const state = stateWithSdkKey();
        state.WALLET.keys.extra = {
          id: 'extra',
          properties: {xPrivKey: 'synthetic extra key'},
          wallets: [],
        };
        const key = await convertedPending(state, true);
        const source = mockAsync.get('persist:root')!;
        delete state.WALLET.keys.extra; // Ordinary intentional deletion before the recovery.
        await captureRefreshCut(state, key);
        const beforeRecord = record.getString(VAULT_RECORD_KEY);
        root.delete('persist:root');
        const original = MMKV.prototype.set;
        let rootWrites = 0;
        const spy = jest
          .spyOn(MMKV.prototype, 'set')
          .mockImplementation(function (this: any, name, value) {
            if (this.id === VAULT_RECORD_ID)
              throw new Error('synthetic suspension rejection');
            const result = original.call(this, name, value);
            if (this.id === 'default' && name === 'persist:root') {
              rootWrites++;
              if (cut) {
                mockDead = true;
                throw new Error('synthetic post-restore cut');
              }
            }
            return result;
          });
        try {
          if (cut)
            await expect(
              prepareVault(root).then(() => undefined),
            ).rejects.toThrow();
          else expect((await prepareVault(root)) === key).toBe(true);
        } finally {
          spy.mockRestore();
          restart();
        }
        expect(rootWrites).toBe(1);
        expect(record.getString(VAULT_RECORD_KEY) === beforeRecord).toBe(true);
        const recovered = await restore(root.getString('persist:root')!, key);
        expect(recovered.APP.bip02CleanupReceipt === undefined).toBe(true);
        expect(Object.keys(recovered.WALLET.keys)).toEqual(['readonly']);
        // Successful source reads after fresh JS modules, ordinary persistence,
        // then another reload. This is not a native-process-restart claim.
        await freshModules();
        await ordinarySave(recovered, key);
        for (let attempt = 0; attempt < 2; attempt++) {
          restart();
          expect((await freshModules()) === key).toBe(true);
          expect(mockAsync.get('persist:root') === source).toBe(true);
          expect(
            (await restore(root.getString('persist:root')!, key)).APP
              .bip02CleanupReceipt === undefined,
          ).toBe(true);
          expect(complete()).toBe(false);
          expect(mockWrites.some(w => w.startsWith('async:delete:'))).toBe(
            false,
          );
        }
      },
    );

    it.each(['damaged', 'readable-uncovered'])(
      'section 4: a damaged row replaced before deletion is retained (%s)',
      async kind => {
        const state = stateWithSdkKey();
        const key = await convertedPending(state);
        mockAsync.set('persist:root', 'synthetic first damaged row');
        const larger = {
          ...state,
          WALLET: {
            ...state.WALLET,
            keys: {
              ...state.WALLET.keys,
              extra: {
                id: 'extra',
                properties: {xPrivKey: 'synthetic independent key'},
                wallets: [],
              },
            },
          },
        };
        const changed =
          kind === 'damaged'
            ? 'synthetic different damaged row'
            : await save(larger);
        const read = AsyncStorage.getItem as jest.Mock;
        const original = read.getMockImplementation()!;
        let reads = 0;
        read.mockImplementation(async name => {
          if (++reads === 2) mockAsync.set(name, changed);
          return original(name);
        });
        const primary = root.getString('persist:root');
        restart();
        try {
          expect((await prepareVault(root)) === key).toBe(true);
          expect(reads).toBe(2);
          expect(mockAsync.get('persist:root') === changed).toBe(true);
          expect(root.getString('persist:root') === primary).toBe(true);
          expect(mockWrites.some(w => w.startsWith('async:delete:'))).toBe(
            false,
          );
          expect(complete()).toBe(false);
        } finally {
          read.mockImplementation(original);
        }
      },
    );

    it.each(
      (['ios', 'android'] as const).flatMap(os =>
        ['old', 'modern', 'both'].flatMap(keys =>
          [false, true].map(completed => ({os, keys, completed})),
        ),
      ),
    )(
      'section 4: total loss stays a stop with established conversion ($os/$keys/complete=$completed)',
      async ({os, keys, completed}) => {
        Platform.OS = os;
        const key = await convertedPending(stateWithSdkKey());
        if (completed) await migrateVault(root);
        root.delete('persist:root');
        mockFiles.clear();
        if (keys === 'old') mockCredentials.delete(VAULT_KEY_SERVICE);
        if (keys !== 'modern') seedKey(LEGACY_KEY_SERVICE, legacyKey);
        else mockCredentials.delete(LEGACY_KEY_SERVICE);
        const before = record.getString(VAULT_RECORD_KEY);
        const credentials = new Map(mockCredentials);
        for (let attempt = 0; attempt < 2; attempt++) {
          restart();
          const result = await outcome(
            'consolidated:lost-converted',
            async () => {
              await prepareVault(root);
              await reduxStorage.getItem('persist:root');
            },
          );
          expect(result === 'RESOLVED').toBe(false);
          expect(record.getString(VAULT_RECORD_KEY) === before).toBe(true);
          expect(isEqual(mockCredentials, credentials)).toBe(true);
          expect(root.contains('persist:root')).toBe(false);
          noWrites();
        }
        expect(typeof key === 'string').toBe(true);
      },
    );

    it.each(
      ['required', 'optional'].flatMap(kind =>
        ['write', 'read-back'].map(failure => ({kind, failure})),
      ),
    )(
      'retires the partial-output permission before promotion ($kind/$failure)',
      async ({kind, failure}) => {
        const state = stateWithSdkKey();
        let key: string | undefined;
        if (kind === 'optional') {
          key = await convertedPending(state);
          state.BITPAY_ID.apiToken = 'synthetic optional change';
          await ordinarySave(state, key, false);
        } else {
          root.set('persist:root', await save(state));
          seedKey(LEGACY_KEY_SERVICE, legacyKey);
        }
        const primary = root.getString('persist:root');
        const main = mockFiles.get(VAULT_BACKUP),
          bak = mockFiles.get(VAULT_OLDER_BACKUP);
        const originalSet = MMKV.prototype.set,
          originalGet = MMKV.prototype.getString;
        let hit = false,
          rejectRead = false;
        const set = jest
          .spyOn(MMKV.prototype, 'set')
          .mockImplementation(function (this: any, name, value) {
            if (this.id === VAULT_RECORD_ID) {
              const next = JSON.parse(value as string);
              const verified =
                kind === 'required'
                  ? next.conversionPlan?.output?.phase === 'verified'
                  : Object.values(next.cleanup ?? {}).some(
                      (slot: any) => slot?.writePhase === 'verified',
                    );
              if (verified) {
                hit = true;
                if (failure === 'write')
                  throw new Error('synthetic phase write failure');
                rejectRead = true;
              }
            }
            return originalSet.call(this, name, value);
          });
        const get = jest
          .spyOn(MMKV.prototype, 'getString')
          .mockImplementation(function (this: any, name) {
            if (this.id === VAULT_RECORD_ID && rejectRead) {
              rejectRead = false;
              throw new Error('synthetic phase read failure');
            }
            return originalGet.call(this, name);
          });
        restart();
        try {
          if (kind === 'required')
            await expect(
              prepareVault(root).then(() => undefined),
            ).rejects.toThrow();
          else expect((await prepareVault(root)) === key).toBe(true);
          expect(hit).toBe(true);
          expect(root.getString('persist:root') === primary).toBe(true);
          expect(mockFiles.get(VAULT_BACKUP) === main).toBe(true);
          expect(mockFiles.get(VAULT_OLDER_BACKUP) === bak).toBe(true);
          expect(
            mockFiles.has(
              migrationTemp(
                kind === 'required' ? VAULT_BACKUP : VAULT_OLDER_BACKUP,
              ),
            ),
          ).toBe(true);
          expect(
            mockWrites.some(
              w => w.startsWith('unlink:') || w.startsWith('move:'),
            ),
          ).toBe(false);
          expect(complete()).toBe(false);
        } finally {
          set.mockRestore();
          get.mockRestore();
        }
        for (let attempt = 0; attempt < 2 && !complete(); attempt++) {
          restart();
          await prepareVault(root);
        }
        expect(complete()).toBe(true);
      },
    );

    it.each(['main', 'bak'] as const)(
      'a plan without a write at %s cannot claim an undecodable temp',
      async slot => {
        const state = stateWithSdkKey();
        root.set('persist:root', await save(state));
        seedKey(LEGACY_KEY_SERVICE, legacyKey);
        const write = RNFS.writeFile as jest.Mock,
          original = write.getMockImplementation()!;
        write.mockRejectedValue(new Error('synthetic preparation rejection'));
        try {
          await expect(
            prepareVault(root).then(() => undefined),
          ).rejects.toThrow();
        } finally {
          write.mockImplementation(original);
        }
        // Retain the valid selected-source plan, but remove its operation-specific
        // observation, modeling a reference plan rather than a newly armed write.
        const old = JSON.parse(record.getString(VAULT_RECORD_KEY)!);
        delete old.conversionPlan.output;
        record.set(VAULT_RECORD_KEY, JSON.stringify(old));
        const path = migrationTemp(
          slot === 'main' ? VAULT_BACKUP : VAULT_OLDER_BACKUP,
        );
        seedFile(path, 'synthetic unowned partial');
        const primary = root.getString('persist:root');
        restart();
        await expect(prepareVault(root).then(() => undefined)).rejects.toThrow(
          'SOURCE_CONFLICT',
        );
        expect(mockFiles.get(path) === 'synthetic unowned partial').toBe(true);
        expect(root.getString('persist:root') === primary).toBe(true);
        expect(conversionRecorded()).toBe(false);
      },
    );

    it.each(['main', 'bak'] as const)(
      'finished %s refresh cannot claim new garbage after target rotation',
      async slot => {
        const state = stateWithSdkKey();
        const key = await convertedPending(state);
        state.BITPAY_ID.apiToken = 'synthetic refresh edit';
        await ordinarySave(state, key, false);
        const stat = RNFS.stat as jest.Mock,
          original = stat.getMockImplementation()!;
        stat.mockRejectedValue(new Error('synthetic scrub deferral'));
        try {
          expect((await prepareVault(root)) === key).toBe(true);
        } finally {
          stat.mockImplementation(original);
        }
        const metadata = JSON.parse(record.getString(VAULT_RECORD_KEY)!);
        expect(metadata.cleanup[slot].writePhase).toBe('verified');
        // Two real ordinary backup rotations remove target/digest equality as an
        // accidental safeguard. The verified phase must still deny partial deletion.
        state.BITPAY_ID.apiToken = 'synthetic later edit one';
        await ordinarySave(state, key);
        state.BITPAY_ID.apiToken = 'synthetic later edit two';
        const primary = await ordinarySave(state, key);
        const path = migrationTemp(
          slot === 'main' ? VAULT_BACKUP : VAULT_OLDER_BACKUP,
        );
        seedFile(path, 'synthetic unknown after finished write');
        for (let attempt = 0; attempt < 2; attempt++) {
          restart();
          expect((await prepareVault(root)) === key).toBe(true);
          expect(root.getString('persist:root') === primary).toBe(true);
          expect(
            mockFiles.get(path) === 'synthetic unknown after finished write',
          ).toBe(true);
          expect(complete()).toBe(false);
        }
      },
    );
  });

  describe('Stage B acceptance', () => {
    const ROOT_KEY = 'persist:root';
    const attempt = async (operation: () => Promise<unknown>) => {
      try {
        await operation();
        return 'RESOLVED';
      } catch (error) {
        const safe = getVaultDiagnostic(error as Error) as any;
        return `${safe?.code ?? 'UNCLASSIFIED'}/${safe?.phase ?? 'unknown'}`;
      }
    };
    // One launch as the app performs it: startup preparation, then the
    // store's first read of the persisted root (which may restore a backup).
    const open = async () => {
      restart();
      let key: string | undefined;
      let raw: string | null | undefined;
      const result = await attempt(async () => {
        key = await prepareVault(root);
        raw = (await reduxStorage.getItem(ROOT_KEY)) as string | null;
      });
      return {outcome: result, key, raw};
    };
    // Launch until `done`, at most `max` times. Every launch must open. No
    // rule fixes how many launches cleanup may take, so one budget is used.
    const openUntil = async (done: () => boolean, max = 4) => {
      for (let n = 0; n < max && !done(); n++)
        expect((await open()).outcome).toBe('RESOLVED');
    };
    const walletIds = async (raw: string | null | undefined, key: string) => {
      if (raw === undefined || raw === null) return 'absent';
      try {
        return Object.keys((await restore(raw, key)).WALLET.keys)
          .sort()
          .join(',');
      } catch {
        return 'undecodable';
      }
    };
    const withoutReceipt = (state: any) => {
      const next = {...state, APP: {...state.APP}};
      delete next.APP.bip02CleanupReceipt;
      return next;
    };
    const recordNow = () =>
      JSON.parse(record.getString(VAULT_RECORD_KEY) ?? 'null');
    // The store's first ordinary save, awaiting the backup it queues.
    const firstSave = async (state: any, key: string) => {
      const raw = await save(state, key, 'modern');
      const write = jest.spyOn(
        require('./backup/fs-backup'),
        'backupPersistRoot',
      );
      try {
        await reduxStorage.setItem(ROOT_KEY, raw);
        for (const call of write.mock.results)
          if (call.type === 'return') await call.value;
      } finally {
        write.mockRestore();
      }
      return raw;
    };
    // A file write that fails every time while armed. 'half' and 'empty' model
    // a full disk or a killed process on a non-atomic write: the target is
    // left truncated. 'nothing' rejects without touching the target.
    const failingWrite = (
      target: string,
      leave: 'half' | 'empty' | 'nothing',
    ) => {
      const write = RNFS.writeFile as jest.Mock;
      const original = write.getMockImplementation()!;
      let hits = 0;
      write.mockImplementation(
        async (path: string, data: string, ...rest: any[]) => {
          const dir = path.slice(0, path.lastIndexOf('/'));
          if (path !== target || !mockDirs.has(dir))
            return original(path, data, ...rest);
          hits++;
          if (leave !== 'nothing')
            mockFiles.set(
              path,
              leave === 'empty'
                ? ''
                : data.slice(0, Math.floor(data.length / 2)),
            );
          throw new Error('ENOSPC: synthetic write failure');
        },
      );
      return {
        hits: () => hits,
        clear: () => write.mockImplementation(original),
      };
    };
    const failing = (mock: unknown, message: string) => {
      const fn = mock as jest.Mock;
      const original = fn.getMockImplementation()!;
      fn.mockImplementation(async () => {
        throw new Error(message);
      });
      return () => fn.mockImplementation(original);
    };

    // -------------------------------------------------------------------------
    // 1. Reinstall. Owner ruling: deleting and reinstalling never stops the
    //    app; it is a fresh install on both platforms. iOS keeps Keychain
    //    entries across an uninstall, so the old entry, the new entry or both
    //    can be present with no persisted data at all. Android removes them
    //    with the app, so a real Android reinstall is the "no keys" control.
    //    The Android old-key cases are the same state reached some other way
    //    (for example a released build stopped before its first save, or data
    //    that was lost or failed to load). The owner was told that opening
    //    there lets a first save overwrite data hidden by a failed load, and
    //    ruled that it opens as a fresh install. That reverses the existing
    //    test "RK: legacy credentials alone cannot establish fresh provenance".
    describe('1. A reinstall is a fresh install', () => {
      it.each(
        (['ios', 'android'] as const).flatMap(os =>
          [
            {keys: 'old key only', old: true, modern: false},
            {keys: 'old and new key', old: true, modern: true},
            {keys: 'new key only (control)', old: false, modern: true},
            {keys: 'no keys (control)', old: false, modern: false},
          ].map(state => ({os, ...state})),
        ),
      )(
        '$os, $keys, no persisted data: opens empty, takes a first save and reopens it',
        async ({os, old, modern}) => {
          Platform.OS = os;
          const bridge = os === 'android' ? rkBridge() : undefined;
          const surviving = crypto.randomBytes(32).toString('base64');
          if (old) seedKey(LEGACY_KEY_SERVICE, legacyKey);
          if (modern) seedKey(VAULT_KEY_SERVICE, surviving);
          let key = '';
          for (let n = 0; n < 2; n++) {
            const launch = await open();
            expect(launch.outcome).toBe('RESOLVED');
            expect(launch.raw === null).toBe(true);
            expect(root.contains(ROOT_KEY)).toBe(false);
            key = launch.key!;
          }
          // A surviving new key is reused, never replaced.
          if (modern) expect(key === surviving).toBe(true);
          expect(mockCredentials.has(LEGACY_KEY_SERVICE)).toBe(false);
          // No wallet exists yet, so the Android cleaner has nothing to act on.
          if (bridge) expect(bridge.clean).not.toHaveBeenCalled();
          const state = stateWithSdkKey();
          const raw = await firstSave(state, key);
          const again = await open();
          expect(again.outcome).toBe('RESOLVED');
          expect(again.raw === raw).toBe(true);
          same((await restore(again.raw!, again.key!)).WALLET, state.WALLET);
        },
      );

      it.each(['ios', 'android'] as const)(
        '%s, old key only: an unreadable AsyncStorage is not an empty one; once readable the app opens fresh',
        async os => {
          Platform.OS = os;
          seedKey(LEGACY_KEY_SERVICE, legacyKey);
          const clear = failing(AsyncStorage.getItem, 'synthetic read failure');
          try {
            for (let n = 0; n < 2; n++) {
              expect((await open()).outcome).not.toBe('RESOLVED');
              noWrites();
              expect(recordNow() === null).toBe(true);
              expect(mockCredentials.has(VAULT_KEY_SERVICE)).toBe(false);
            }
          } finally {
            clear();
          }
          const launch = await open();
          expect(launch.outcome).toBe('RESOLVED');
          expect(launch.raw === null).toBe(true);
        },
      );
    });

    // -------------------------------------------------------------------------
    // 2. The first conversion writes a backup temp and the write fails
    //    part-way. Stopping while the backup cannot be written is correct.
    //    Staying stopped after the write works again is the defect.
    describe('2. A partly written backup temp on the converting launch', () => {
      it.each([
        {
          slot: 'main',
          leave: 'half',
          title:
            'main temp left half written: stops safely while the write fails, converts and completes once it works',
        },
        {
          slot: 'main',
          leave: 'empty',
          title:
            'main temp left empty: stops safely while the write fails, converts and completes once it works',
        },
        {
          slot: 'bak',
          leave: 'half',
          title:
            '.bak temp left half written: stops safely while the write fails, converts and completes once it works',
        },
        {
          slot: 'main',
          leave: 'nothing',
          title:
            'main temp write rejected with nothing left behind: stops, then converts and completes (control)',
        },
        {
          slot: 'main',
          leave: 'none',
          title:
            'no failure, no earlier backup: converts and completes (control)',
        },
        {
          slot: 'bak',
          leave: 'none',
          title:
            'no failure, an earlier backup: converts and completes (control)',
        },
      ] as const)('$title', async ({slot, leave}) => {
        const state = stateWithSdkKey();
        state.APP.migrationMMKVStorageComplete = true;
        const legacyRaw = await save(state);
        root.set(ROOT_KEY, legacyRaw);
        seedKey(LEGACY_KEY_SERVICE, legacyKey);
        // With an earlier backup, the first temp written is its rotation
        // into .bak, which the conversion plan does not name.
        const earlier =
          slot === 'bak'
            ? await save({...state, BITPAY_ID: {apiToken: 'earlier backup'}})
            : undefined;
        if (earlier) seedFile(VAULT_BACKUP, earlier);
        const target = migrationTemp(
          slot === 'bak' ? VAULT_OLDER_BACKUP : VAULT_BACKUP,
        );
        if (leave !== 'none') {
          const failure = failingWrite(target, leave);
          try {
            for (let n = 0; n < 2; n++) {
              expect((await open()).outcome).not.toBe('RESOLVED');
              expect(root.getString(ROOT_KEY) === legacyRaw).toBe(true);
              expect(conversionRecorded()).toBe(false);
              if (earlier)
                expect(mockFiles.get(VAULT_BACKUP) === earlier).toBe(true);
            }
          } finally {
            failure.clear();
          }
          expect(failure.hits()).toBeGreaterThan(0);
        }
        // The write works again. Allow one launch to retire the migration's
        // own partial output and one to convert; the legacy primary must
        // stay untouched until conversion succeeds.
        let opened = await open();
        if (opened.outcome !== 'RESOLVED') {
          expect(root.getString(ROOT_KEY) === legacyRaw).toBe(true);
          opened = await open();
        }
        expect(opened.outcome).toBe('RESOLVED');
        const key = opened.key!;
        expect(conversionRecorded()).toBe(true);
        same(
          (await restore(root.getString(ROOT_KEY)!, key)).WALLET,
          state.WALLET,
        );
        same(
          (await restore(mockFiles.get(VAULT_BACKUP)!, key)).WALLET,
          state.WALLET,
        );
        await openUntil(complete);
        expect(complete()).toBe(true);
        expect(mockFiles.has(target)).toBe(false);
        expect(mockCredentials.has(LEGACY_KEY_SERVICE)).toBe(false);
      });

      it.each(
        (['main', 'bak'] as const).flatMap(slot =>
          (['bytes', 'empty'] as const).map(kind => ({slot, kind})),
        ),
      )(
        'a $slot temp ($kind) that was there before any plan was recorded is not the migration’s own output: preserved (control)',
        async ({slot, kind}) => {
          const legacyRaw = await save(stateWithSdkKey());
          root.set(ROOT_KEY, legacyRaw);
          seedKey(LEGACY_KEY_SERVICE, legacyKey);
          const path = migrationTemp(
            slot === 'bak' ? VAULT_OLDER_BACKUP : VAULT_BACKUP,
          );
          const unknown = kind === 'empty' ? '' : 'synthetic unknown copy';
          seedFile(path, unknown);
          for (let n = 0; n < 2; n++) {
            expect((await open()).outcome).not.toBe('RESOLVED');
            expect(mockFiles.get(path) === unknown).toBe(true);
            expect(root.getString(ROOT_KEY) === legacyRaw).toBe(true);
            noWrites();
          }
        },
      );
    });

    // -------------------------------------------------------------------------
    // 4. AsyncStorage cannot be read on the converting launch (the import is
    //    already done, so conversion may proceed without it). Once it can be
    //    read, fresh coverage by the converted wallet must be able to create
    //    the deletion permission that could not be recorded at conversion.
    describe('4. AsyncStorage unreadable on the converting launch', () => {
      it.each([
        {
          title:
            'later readable and holding the same wallet: the row is removed and cleanup completes',
          later: 'same',
          removed: true,
          unreadable: true,
        },
        {
          title:
            'later readable but undecodable: the row is removed and cleanup completes (the ruling covers a damaged row whenever it is found)',
          later: 'undecodable',
          removed: true,
          unreadable: true,
        },
        {
          title:
            'later readable and holding a key the wallet lacks: the row is kept and nothing is imported (control)',
          later: 'larger',
          removed: false,
          unreadable: true,
        },
        {
          title: 'later gone: cleanup completes (control)',
          later: 'gone',
          removed: true,
          unreadable: true,
        },
        {
          title:
            'readable from the start and holding the same wallet: removed, cleanup completes (control)',
          later: 'same',
          removed: true,
          unreadable: false,
        },
      ])('$title', async ({later, removed, unreadable}) => {
        const state = stateWithSdkKey();
        state.APP.migrationMMKVStorageComplete = true;
        const raw = await save(state);
        root.set(ROOT_KEY, raw);
        seedKey(LEGACY_KEY_SERVICE, legacyKey);
        const larger = JSON.parse(JSON.stringify(state));
        larger.WALLET.keys.extra = {
          id: 'extra',
          properties: {xPrivKey: 'synthetic key only in the old row'},
          wallets: [],
        };
        const row =
          later === 'same' || later === 'gone'
            ? raw
            : later === 'undecodable'
            ? 'synthetic undecodable bytes'
            : await save(larger);
        mockAsync.set(ROOT_KEY, row);
        if (unreadable) {
          const clear = failing(AsyncStorage.getItem, 'synthetic read failure');
          let first;
          try {
            first = await open();
          } finally {
            clear();
          }
          expect(first.outcome).toBe('RESOLVED');
          expect(conversionRecorded()).toBe(true);
          expect(complete()).toBe(false);
          expect(mockAsync.get(ROOT_KEY) === row).toBe(true);
          same((await restore(first.raw!, first.key!)).WALLET, state.WALLET);
        }
        if (later === 'gone') mockAsync.delete(ROOT_KEY);
        const settled = () => complete() && !mockAsync.has(ROOT_KEY);
        await openUntil(removed ? settled : () => false);
        const key = (await open()).key!;
        // The converted wallet is never replaced by, or merged with, the row.
        expect(await walletIds(root.getString(ROOT_KEY), key)).toBe('readonly');
        if (removed) {
          expect(mockAsync.has(ROOT_KEY)).toBe(false);
          expect(complete()).toBe(true);
          expect(mockCredentials.has(LEGACY_KEY_SERVICE)).toBe(false);
        } else {
          expect(mockAsync.get(ROOT_KEY) === row).toBe(true);
          expect(complete()).toBe(false);
        }
      });
    });

    // -------------------------------------------------------------------------
    // 5. A damaged old copy in AsyncStorage beside a wallet that holds keys.
    //    Owner ruling: always delete it once the wallet is safely converted
    //    and backed up, on the first attempt and on any retry. On a09199e the
    //    uninterrupted attempt deletes it and any interruption keeps it for good.
    describe('5. An undecodable AsyncStorage row beside a wallet with keys', () => {
      // A legacy snapshot of the same wallet in which one reducer other than
      // WALLET is damaged. The migration cannot decode the row as a whole.
      const damagedReducerRow = async (state: any) => {
        const outer = JSON.parse(await save(state));
        outer.APP = JSON.stringify('synthetic damaged reducer');
        return JSON.stringify(outer);
      };
      // Protected wallet fields in a row that still decrypt, with the
      // device-derived old key, to exactly the wallet's own values. Only the
      // two counts leave this function.
      const fieldsReadableWithOldKey = (row: string, state: any) => {
        const Utf8 = require('crypto-js/enc-utf8.js');
        let total = 0;
        let exact = 0;
        try {
          const wallet = JSON.parse(JSON.parse(JSON.parse(row).WALLET));
          for (const [id, item] of Object.entries(wallet.keys ?? {}) as any[])
            for (const [field, value] of Object.entries(item.properties ?? {}))
              if (typeof value === 'string' && value.startsWith('encrypted:')) {
                total++;
                try {
                  if (
                    Aes.decrypt(
                      value.slice('encrypted:'.length),
                      legacyKey,
                    ).toString(Utf8) === state.WALLET.keys[id].properties[field]
                  )
                    exact++;
                } catch {}
              }
        } catch {}
        return {total, exact};
      };

      it.each(
        (['arbitrary bytes', 'one damaged reducer'] as const).flatMap(row =>
          (
            [
              'no interruption (control)',
              'the removal fails on two launches',
              'the first attempt stops on a rejected backup write',
            ] as const
          ).map(interruption => ({row, interruption})),
        ),
      )(
        '$row, $interruption: the wallet opens whenever it safely can and the row is removed once the failure clears',
        async ({row, interruption}) => {
          const state = stateWithSdkKey();
          const legacyRaw = await save(state);
          root.set(ROOT_KEY, legacyRaw);
          seedKey(LEGACY_KEY_SERVICE, legacyKey);
          const damaged =
            row === 'arbitrary bytes'
              ? 'synthetic undecodable bytes'
              : await damagedReducerRow(state);
          mockAsync.set(ROOT_KEY, damaged);
          if (row === 'one damaged reducer') {
            // The damaged row is still an old-key copy of wallet secrets.
            const readable = fieldsReadableWithOldKey(damaged, state);
            expect(readable.total).toBeGreaterThan(0);
            expect(readable.exact).toBe(readable.total);
          }
          if (interruption.startsWith('the removal fails')) {
            const clear = failing(
              AsyncStorage.removeItem,
              'synthetic removal failure',
            );
            try {
              for (let n = 0; n < 2; n++) {
                const launch = await open();
                // A cleanup failure never locks out the converted wallet.
                expect(launch.outcome).toBe('RESOLVED');
                same(
                  (await restore(launch.raw!, launch.key!)).WALLET,
                  state.WALLET,
                );
                expect(mockAsync.get(ROOT_KEY) === damaged).toBe(true);
                expect(complete()).toBe(false);
              }
            } finally {
              clear();
            }
          }
          if (interruption.startsWith('the first attempt stops')) {
            const failure = failingWrite(
              migrationTemp(VAULT_BACKUP),
              'nothing',
            );
            try {
              // The required backup could not be written: stop, change nothing.
              expect((await open()).outcome).not.toBe('RESOLVED');
            } finally {
              failure.clear();
            }
            expect(failure.hits()).toBeGreaterThan(0);
            expect(root.getString(ROOT_KEY) === legacyRaw).toBe(true);
            expect(mockAsync.get(ROOT_KEY) === damaged).toBe(true);
            expect(conversionRecorded()).toBe(false);
          }
          const settled = () => complete() && !mockAsync.has(ROOT_KEY);
          await openUntil(settled);
          expect(mockAsync.has(ROOT_KEY)).toBe(false);
          expect(complete()).toBe(true);
          expect(mockCredentials.has(LEGACY_KEY_SERVICE)).toBe(false);
          const last = await open();
          expect(last.outcome).toBe('RESOLVED');
          same((await restore(last.raw!, last.key!)).WALLET, state.WALLET);
        },
      );

      // The ruling says "always". The row was classified when the wallet held
      // keys; a later deletion of the last key does not make it worth keeping,
      // and what it still holds is an old-key copy of the deleted keys.
      it('the removal fails and the user then deletes the last key: the row is still removed', async () => {
        const state = stateWithSdkKey();
        root.set(ROOT_KEY, await save(state));
        seedKey(LEGACY_KEY_SERVICE, legacyKey);
        const damaged = await damagedReducerRow(state);
        mockAsync.set(ROOT_KEY, damaged);
        const clear = failing(
          AsyncStorage.removeItem,
          'synthetic removal failure',
        );
        let first;
        try {
          first = await open();
        } finally {
          clear();
        }
        expect(first.outcome).toBe('RESOLVED');
        expect(mockAsync.get(ROOT_KEY) === damaged).toBe(true);
        expect(complete()).toBe(false);
        edit(state, 'delete-key');
        const latest = await ordinarySave(state, first.key!);
        const settled = () => complete() && !mockAsync.has(ROOT_KEY);
        await openUntil(settled);
        expect(mockAsync.has(ROOT_KEY)).toBe(false);
        expect(complete()).toBe(true);
        expect(root.getString(ROOT_KEY) === latest).toBe(true);
        expect(await walletIds(latest, first.key!)).toBe('');
      });

      // The rule is applied to the row's current bytes on each launch. No
      // permission is carried over from the row an earlier launch saw.
      it.each([
        {
          title:
            'the damaged row is replaced by different damaged bytes between attempts: the new row is removed',
          becomes: 'damaged',
        },
        {
          title:
            'the damaged row is replaced by a readable row holding a key the wallet lacks: the new row is kept and nothing is imported (control)',
          becomes: 'larger',
        },
      ])('$title', async ({becomes}) => {
        const state = stateWithSdkKey();
        root.set(ROOT_KEY, await save(state));
        seedKey(LEGACY_KEY_SERVICE, legacyKey);
        mockAsync.set(ROOT_KEY, await damagedReducerRow(state));
        const clear = failing(
          AsyncStorage.removeItem,
          'synthetic removal failure',
        );
        let first;
        try {
          first = await open();
        } finally {
          clear();
        }
        expect(first.outcome).toBe('RESOLVED');
        expect(conversionRecorded()).toBe(true);
        expect(complete()).toBe(false);
        const larger = JSON.parse(JSON.stringify(state));
        larger.WALLET.keys.extra = {
          id: 'extra',
          properties: {xPrivKey: 'synthetic key only in the old row'},
          wallets: [],
        };
        const next =
          becomes === 'damaged'
            ? 'other synthetic undecodable bytes'
            : await save(larger);
        mockAsync.set(ROOT_KEY, next);
        const settled = () => complete() && !mockAsync.has(ROOT_KEY);
        await openUntil(becomes === 'damaged' ? settled : () => false);
        const last = await open();
        expect(last.outcome).toBe('RESOLVED');
        expect(await walletIds(last.raw, last.key!)).toBe('readonly');
        if (becomes === 'damaged') {
          expect(mockAsync.has(ROOT_KEY)).toBe(false);
          expect(complete()).toBe(true);
        } else {
          expect(mockAsync.get(ROOT_KEY) === next).toBe(true);
          expect(complete()).toBe(false);
        }
      });

      // Authorization section 5: after a restore from a backup, a source that
      // cannot be decoded is preserved and cleanup stays pending. The ruling
      // does not reach past a restore; this keeps a repair from widening it.
      it('after the primary is lost and restored from the backup, the undecodable row is kept (control)', async () => {
        const state = stateWithSdkKey();
        root.set(ROOT_KEY, await save(state));
        seedKey(LEGACY_KEY_SERVICE, legacyKey);
        const damaged = await damagedReducerRow(state);
        mockAsync.set(ROOT_KEY, damaged);
        const clear = failing(
          AsyncStorage.removeItem,
          'synthetic removal failure',
        );
        let first;
        try {
          first = await open();
        } finally {
          clear();
        }
        expect(first.outcome).toBe('RESOLVED');
        expect(conversionRecorded()).toBe(true);
        root.delete(ROOT_KEY);
        for (let n = 0; n < 4; n++) {
          const launch = await open();
          expect(launch.outcome).toBe('RESOLVED');
          expect(await walletIds(launch.raw, first.key!)).toBe('readonly');
          expect(mockAsync.get(ROOT_KEY) === damaged).toBe(true);
          expect(complete()).toBe(false);
        }
      });

      it('when the undecodable row is the only possible source the migration stops and keeps it (control)', async () => {
        const damaged = 'synthetic undecodable bytes';
        mockAsync.set(ROOT_KEY, damaged);
        seedKey(LEGACY_KEY_SERVICE, legacyKey);
        for (let n = 0; n < 2; n++) {
          expect((await open()).outcome).not.toBe('RESOLVED');
          expect(mockAsync.get(ROOT_KEY) === damaged).toBe(true);
          expect(mockCredentials.has(VAULT_KEY_SERVICE)).toBe(false);
          expect(recordNow() === null).toBe(true);
          noWrites();
        }
      });
    });

    // -------------------------------------------------------------------------
    // 6. After conversion, an optional backup refresh writes a temp and the
    //    write fails part-way. The wallet must open, and once the write works
    //    the migration must retire its own partial output and finish.
    describe('6. A partly written optional-refresh temp after conversion', () => {
      it.each([
        {slot: 'main', leave: 'half', title: 'main temp left half written'},
        {slot: 'bak', leave: 'half', title: '.bak temp left half written'},
        {slot: 'main', leave: 'none', title: 'no failure (control)'},
      ] as const)(
        '$title: the wallet opens and cleanup completes once the write works',
        async ({slot, leave}) => {
          const state = stateWithSdkKey();
          const key = await convertedPending(state);
          // An ordinary save whose backup has not been written yet.
          state.BITPAY_ID = {apiToken: 'saved after conversion'};
          const primary = await save(state, key, 'modern');
          root.set(ROOT_KEY, primary);
          const target = migrationTemp(
            slot === 'bak' ? VAULT_OLDER_BACKUP : VAULT_BACKUP,
          );
          if (leave !== 'none') {
            const failure = failingWrite(target, leave);
            try {
              const launch = await open();
              expect(launch.outcome).toBe('RESOLVED');
              expect(launch.raw === primary).toBe(true);
            } finally {
              failure.clear();
            }
            expect(failure.hits()).toBeGreaterThan(0);
            expect(complete()).toBe(false);
          }
          await openUntil(complete);
          expect(complete()).toBe(true);
          expect(mockFiles.has(target)).toBe(false);
          expect(root.getString(ROOT_KEY) === primary).toBe(true);
          same(
            (await restore(mockFiles.get(VAULT_BACKUP)!, key)).BITPAY_ID,
            state.BITPAY_ID,
          );
          expect(mockCredentials.has(LEGACY_KEY_SERVICE)).toBe(false);
        },
      );

      // The refresh for this slot finished: its target already holds what the
      // recorded intent describes. A temp that then appears at the same path
      // cannot be that refresh's partial output.
      it('an undecodable main temp that appears after its recorded refresh already finished is preserved (control)', async () => {
        const state = stateWithSdkKey();
        const key = await convertedPending(state);
        state.BITPAY_ID = {apiToken: 'saved after conversion'};
        const primary = await save(state, key, 'modern');
        root.set(ROOT_KEY, primary);
        // The refresh completes; only the scrub is deferred.
        const clear = failing(RNFS.stat, 'synthetic scrub metadata failure');
        try {
          expect((await open()).outcome).toBe('RESOLVED');
        } finally {
          clear();
        }
        const path = migrationTemp(VAULT_BACKUP);
        expect(complete()).toBe(false);
        expect(mockFiles.has(path)).toBe(false);
        same(
          (await restore(mockFiles.get(VAULT_BACKUP)!, key)).BITPAY_ID,
          state.BITPAY_ID,
        );
        const unknown = 'synthetic unknown copy';
        seedFile(path, unknown);
        for (let n = 0; n < 3; n++) {
          const launch = await open();
          expect(launch.outcome).toBe('RESOLVED');
          expect(mockFiles.get(path) === unknown).toBe(true);
          expect(root.getString(ROOT_KEY) === primary).toBe(true);
          expect(complete()).toBe(false);
        }
      });

      it.each(['main', 'bak'] as const)(
        'an undecodable %s temp that no recorded refresh wrote is not the migration’s own output: preserved, wallet opens (control)',
        async slot => {
          const state = stateWithSdkKey();
          const key = await convertedPending(state);
          const primary = root.getString(ROOT_KEY);
          const path = migrationTemp(
            slot === 'bak' ? VAULT_OLDER_BACKUP : VAULT_BACKUP,
          );
          const unknown = 'synthetic unknown copy';
          seedFile(path, unknown);
          for (let n = 0; n < 3; n++) {
            const launch = await open();
            expect(launch.outcome).toBe('RESOLVED');
            expect(launch.key === key).toBe(true);
            expect(mockFiles.get(path) === unknown).toBe(true);
            expect(root.getString(ROOT_KEY) === primary).toBe(true);
            expect(complete()).toBe(false);
          }
        },
      );
    });

    // -------------------------------------------------------------------------
    // 7. After conversion the primary is present but this build cannot decode
    //    it. Corruption is repaired from the backup (owner decisions 2 and 10).
    //    A root that decodes as released-format data was written by another
    //    build, for example after a downgrade, and may hold keys no backup
    //    has. Both reviewers recommend keeping it and the owner had no
    //    preference, so it is kept. The cases require only that the root and
    //    the backups are left unchanged; they do not say whether startup
    //    stops or hands the root to the store. No support for downgraded data
    //    is added.
    describe('7. A present primary this build cannot decode', () => {
      const newerLegacyRoot = async (state: any) => {
        const next = JSON.parse(JSON.stringify(state));
        next.WALLET.keys.newer = {
          id: 'newer',
          properties: {xPrivKey: 'synthetic key written by another build'},
          wallets: [],
        };
        return save(next);
      };
      it.each(
        (['cleanup pending', 'Android follow-up pending'] as const).flatMap(
          stage =>
            [
              {
                stops: false,
                title:
                  'bytes that do not parse are repaired from the backup (control)',
              },
              {
                stops: true,
                title:
                  'a released-format root holding a newer key is not replaced from the backup',
              },
            ].map(kind => ({stage, ...kind})),
        ),
      )('$stage: $title', async ({stage, stops}) => {
        let key: string;
        const state: any =
          stage === 'cleanup pending' ? stateWithSdkKey() : payload();
        if (stage === 'cleanup pending') {
          key = await convertedPending(state);
        } else {
          Platform.OS = 'android';
          key = await rkCompletedVault();
          // Conversion left a current modern backup.
          expect(mockFiles.has(VAULT_BACKUP)).toBe(true);
          expect(complete()).toBe(true);
          rkBridge();
        }
        const bad = stops ? await newerLegacyRoot(state) : '{"APP":';
        root.set(ROOT_KEY, bad);
        const files = new Map(mockFiles);
        const launch = await open();
        if (stops) {
          expect(root.getString(ROOT_KEY) === bad).toBe(true);
          expect(isEqual(mockFiles, files)).toBe(true);
        } else {
          expect(launch.outcome).toBe('RESOLVED');
          expect(await walletIds(root.getString(ROOT_KEY), key)).toBe(
            'readonly',
          );
        }
      });
    });

    // -------------------------------------------------------------------------
    // 8. An optional refresh is cut after it removed the main backup and
    //    before it moved its verified temp into place; then the primary is
    //    lost. The temp is the newest copy of the current wallet and belongs
    //    to a recorded refresh, so recovery must use it.
    describe('8. Recovery when the newest backup is a replacement temp', () => {
      // Reach the cut through the production refresh path: a key is added by
      // an ordinary save, and the next launch's refresh stops after removing
      // the main backup and before moving its verified temp into place.
      const cutRefresh = async () => {
        const state = stateWithSdkKey();
        const key = await convertedPending(state);
        state.WALLET.keys.added = {
          id: 'added',
          properties: {xPrivKey: 'synthetic key added after conversion'},
          wallets: [],
        };
        await ordinarySave(state, key, false);
        const unlink = RNFS.unlink as jest.Mock;
        const original = unlink.getMockImplementation()!;
        let cut = false;
        unlink.mockImplementation(async (path: string) => {
          const result = await original(path);
          if (
            path === VAULT_BACKUP &&
            mockFiles.has(migrationTemp(VAULT_BACKUP)) &&
            !cut
          ) {
            cut = true;
            mockDead = true;
            throw new Error('process stopped');
          }
          return result;
        });
        try {
          await open();
        } finally {
          unlink.mockImplementation(original);
        }
        restart();
        const temp = mockFiles.get(migrationTemp(VAULT_BACKUP));
        const current = await restore(root.getString(ROOT_KEY)!, key);
        // The state the cut leaves: no main backup, a temp holding the
        // current wallet, and an older .bak without the added key.
        expect(cut).toBe(true);
        expect(mockFiles.has(VAULT_BACKUP)).toBe(false);
        expect(await walletIds(temp, key)).toBe('added,readonly');
        same(await restore(temp!, key), retainedPayload(current));
        expect(await walletIds(mockFiles.get(VAULT_OLDER_BACKUP), key)).toBe(
          'readonly',
        );
        return {key, current};
      };

      it.each(['an older .bak also exists', 'no other backup exists'])(
        'the refresh was cut between removing the main backup and promoting its temp, %s: the current wallet is recovered',
        async kind => {
          const {key, current} = await cutRefresh();
          if (kind.startsWith('no other')) mockFiles.delete(VAULT_OLDER_BACKUP);
          root.delete(ROOT_KEY);
          const launch = await open();
          expect(launch.outcome).toBe('RESOLVED');
          expect(await walletIds(launch.raw, key)).toBe('added,readonly');
          const restored = await restore(launch.raw!, key);
          // Authorization section 5: a restore made while cleanup is pending
          // writes the root without the cleanup receipt.
          expect(restored.APP.bip02CleanupReceipt === undefined).toBe(true);
          same(restored, withoutReceipt(retainedPayload(current)));
        },
      );

      // Authorization section 5, steps 3 to 5: the receipt is removed before
      // the one root write, never by a second write. A final-state check
      // cannot see the difference, so capture the write and stop right after.
      it('the restore from the replacement temp is a single receipt-free root write and survives a stop right after it', async () => {
        const {key, current} = await cutRefresh();
        root.delete(ROOT_KEY);
        const originalSet = MMKV.prototype.set;
        const written: string[] = [];
        const spy = jest
          .spyOn(MMKV.prototype, 'set')
          .mockImplementation(function (this: any, name: any, value: any) {
            const result = originalSet.call(this, name, value);
            if (this.id === 'default' && name === ROOT_KEY) {
              written.push(value);
              mockDead = true;
              throw new Error('process stopped');
            }
            return result;
          });
        try {
          await open();
        } finally {
          spy.mockRestore();
        }
        restart();
        expect(written.length).toBe(1);
        const first = await restore(written[0], key);
        expect(first.APP.bip02CleanupReceipt === undefined).toBe(true);
        same(first, withoutReceipt(retainedPayload(current)));
        const launch = await open();
        expect(launch.outcome).toBe('RESOLVED');
        expect(launch.raw === written[0]).toBe(true);
        expect(await walletIds(launch.raw, key)).toBe('added,readonly');
      });

      it('a different valid temp at the path of a recorded refresh is not adopted over the older backup (control)', async () => {
        const {key, current} = await cutRefresh();
        const other = await save(
          {...retainedPayload(current), BITPAY_ID: {apiToken: 'another temp'}},
          key,
          'modern',
        );
        seedFile(migrationTemp(VAULT_BACKUP), other);
        const bak = mockFiles.get(VAULT_OLDER_BACKUP);
        root.delete(ROOT_KEY);
        const launch = await open();
        expect(launch.outcome).toBe('RESOLVED');
        expect(await walletIds(launch.raw, key)).toBe('readonly');
        expect(mockFiles.get(migrationTemp(VAULT_BACKUP)) === other).toBe(true);
        expect(mockFiles.get(VAULT_OLDER_BACKUP) === bak).toBe(true);
      });

      it('a temp that no recorded refresh wrote is not adopted over a valid older backup (control)', async () => {
        const state = stateWithSdkKey();
        const key = await convertedPending(state);
        const current = retainedPayload(
          await restore(root.getString(ROOT_KEY)!, key),
        );
        const tempRaw = await save(
          {...current, BITPAY_ID: {apiToken: 'unrecorded temp'}},
          key,
          'modern',
        );
        const bakRaw = await save(
          {...current, BITPAY_ID: {apiToken: 'older backup'}},
          key,
          'modern',
        );
        mockFiles.delete(VAULT_BACKUP);
        seedFile(migrationTemp(VAULT_BACKUP), tempRaw);
        seedFile(VAULT_OLDER_BACKUP, bakRaw);
        root.delete(ROOT_KEY);
        const launch = await open();
        expect(launch.outcome).toBe('RESOLVED');
        expect(
          (await restore(launch.raw!, key)).BITPAY_ID.apiToken ===
            'older backup',
        ).toBe(true);
        expect(mockFiles.get(migrationTemp(VAULT_BACKUP)) === tempRaw).toBe(
          true,
        );
        expect(mockFiles.get(VAULT_OLDER_BACKUP) === bakRaw).toBe(true);
      });
    });

    // -------------------------------------------------------------------------
    // 9. The converted root was written but recording conversion failed, and
    //    the backup directory is then emptied (it lives under Caches). The
    //    plan records its receipt before the root write and the root carries
    //    the same value, so the surviving root is identifiably this plan's
    //    output: rebuild the backup from it and finish recording conversion.
    //    The receipt only ties the root to the pending plan. It does not choose
    //    between wallets: there is one plan, one key and one validated root.
    describe('9. Interrupted conversion followed by a cleared cache', () => {
      const interruptedThenCleared = async () => {
        await seed();
        const originalSet = MMKV.prototype.set;
        const spy = jest
          .spyOn(MMKV.prototype, 'set')
          .mockImplementation(function (this: any, name: any, value: any) {
            if (
              this.id === VAULT_RECORD_ID &&
              String(value).includes('"conversionComplete":true')
            )
              throw new Error('synthetic record failure');
            return originalSet.call(this, name, value);
          });
        let stopped: string;
        try {
          stopped = (await open()).outcome;
        } finally {
          spy.mockRestore();
        }
        restart();
        const key = mockCredentials.get(VAULT_KEY_SERVICE).password as string;
        const converted = await restore(root.getString(ROOT_KEY)!, key);
        const plan = recordNow()?.conversionPlan;
        // The interrupted state: stopped, not recorded, root already modern
        // and carrying the receipt its plan recorded.
        expect(stopped).not.toBe('RESOLVED');
        expect(conversionRecorded()).toBe(false);
        expect(
          typeof plan?.primaryReceipt === 'string' &&
            converted.APP.bip02CleanupReceipt === plan.primaryReceipt,
        ).toBe(true);
        mockFiles.clear();
        return {key, converted};
      };

      it('the surviving root carries the plan’s receipt: the backup is rebuilt and conversion is recorded', async () => {
        const {key, converted} = await interruptedThenCleared();
        let launch = await open();
        if (launch.outcome !== 'RESOLVED') launch = await open();
        expect(launch.outcome).toBe('RESOLVED');
        expect(launch.key === key).toBe(true);
        expect(conversionRecorded()).toBe(true);
        same((await restore(launch.raw!, key)).WALLET, payload().WALLET);
        same(
          await restore(mockFiles.get(VAULT_BACKUP)!, key),
          retainedPayload(converted),
        );
        await openUntil(complete);
        expect(complete()).toBe(true);
      });

      // Owner decisions 12 to 14: the verified current backup comes before
      // admission. A final-state check cannot see a repair that records
      // conversion first and rebuilds the backup afterwards.
      it('the backup is rebuilt before conversion is recorded: while no backup can be written the launch stops and nothing is recorded', async () => {
        const {key, converted} = await interruptedThenCleared();
        const primary = root.getString(ROOT_KEY);
        const write = RNFS.writeFile as jest.Mock;
        const original = write.getMockImplementation()!;
        let attempts = 0;
        write.mockImplementation(async () => {
          attempts++;
          throw new Error('ENOSPC: synthetic write failure');
        });
        try {
          for (let n = 0; n < 2; n++) {
            expect((await open()).outcome).not.toBe('RESOLVED');
            expect(conversionRecorded()).toBe(false);
            expect(root.getString(ROOT_KEY) === primary).toBe(true);
            expect(mockFiles.size).toBe(0);
          }
        } finally {
          write.mockImplementation(original);
        }
        // The stops above were the rebuild failing, not the plan being refused.
        expect(attempts).toBeGreaterThan(0);
        let launch = await open();
        if (launch.outcome !== 'RESOLVED') launch = await open();
        expect(launch.outcome).toBe('RESOLVED');
        expect(conversionRecorded()).toBe(true);
        same(
          await restore(mockFiles.get(VAULT_BACKUP)!, key),
          retainedPayload(converted),
        );
      });

      it.each(['a different receipt', 'no receipt', 'bytes that do not parse'])(
        'a surviving root with %s does not prove it is the plan’s output: still stops, nothing changes (control)',
        async kind => {
          const {key, converted} = await interruptedThenCleared();
          const other = {...converted, APP: {...converted.APP}};
          if (kind === 'a different receipt')
            other.APP.bip02CleanupReceipt = 'f'.repeat(32);
          else delete other.APP.bip02CleanupReceipt;
          const raw =
            kind === 'bytes that do not parse'
              ? '{"APP":'
              : await save(other, key, 'modern');
          root.set(ROOT_KEY, raw);
          for (let n = 0; n < 2; n++) {
            expect((await open()).outcome).not.toBe('RESOLVED');
            expect(root.getString(ROOT_KEY) === raw).toBe(true);
            expect(conversionRecorded()).toBe(false);
            expect(mockFiles.size).toBe(0);
          }
        },
      );
    });
  });
});
