import crypto from 'crypto';
import isEqual from 'lodash.isequal';

jest.mock('react-native', () => ({
  Platform: {OS: 'android'},
  TurboModuleRegistry: {
    getEnforcing: (name: string) => {
      if (name === 'MmkvCxx') return {claimLegacyRetirement: () => !mockWarm};
      if (name === 'MmkvPlatformContext')
        return {getBaseDirectory: () => '/synthetic/mmkv'};
      throw new Error('Unexpected module');
    },
  },
}));

const mockStores = new Map<string, Map<string, string>>();
const mockFiles = new Map<string, string>();
const mockRows = new Map<string, string>();
const mockCredentials = new Map<string, any>();
const mockEvents: string[] = [];
let mockWarm = false;
let mockOldKeyFailure = false;
let mockSetFailure = false;
let mockReadBackFailure = false;
let mockControlFailure = false;
let mockKeyMissing = false;
const legacyKey = 'synthetic-legacy-fixture-key';
const fixture = require('../../test/vault/fixtures/legacy-14.32.json').cases
  .plain;

jest.mock('react-native-mmkv', () => ({
  MMKV: class {
    values: Map<string, string>;
    id: string;
    constructor(config: any) {
      this.id = config.id;
      mockEvents.push('open:' + this.id);
      if (this.id === 'mmkv.default') {
        mockWarm = true;
        if (!config.readOnly) throw new Error('legacy not read only');
      }
      if (!mockStores.has(this.id)) mockStores.set(this.id, new Map());
      this.values = mockStores.get(this.id)!;
    }
    getAllKeys() {
      return [...this.values.keys()];
    }
    contains(k: string) {
      return this.values.has(k);
    }
    getString(k: string) {
      if (this.id === 'bitpay.wallet.transfer.v2' && mockControlFailure)
        throw new Error('secret native message');
      return this.values.get(k);
    }
    set(k: string, value: string) {
      mockEvents.push('write:' + this.id + ':' + k);
      if (this.id === 'mmkv.default') throw new Error('old writer forbidden');
      this.values.set(k, value);
    }
  },
}));
jest.mock('react-native-fs', () => ({
  CachesDirectoryPath: '/cache',
  exists: async (p: string) => mockFiles.has(p),
  readFile: async (p: string) => mockFiles.get(p),
  hash: async (p: string) =>
    require('crypto')
      .createHash('sha256')
      .update(mockFiles.get(p))
      .digest('hex'),
  writeFile: async (p: string, value: string) => {
    mockEvents.push('file:write');
    mockFiles.set(p, value);
  },
  mkdir: async () => {},
  unlink: async (p: string) => {
    mockFiles.delete(p);
  },
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: async (key: string) => mockRows.get(key) ?? null,
  removeItem: async (key: string) => {
    mockRows.delete(key);
  },
  multiRemove: () => {
    throw new Error('broad deletion forbidden');
  },
}));
jest.mock('react-native-device-info', () => ({
  ...require('react-native-device-info/jest/react-native-device-info-mock'),
  getUniqueId: () => 'synthetic-legacy-fixture-key',
}));
jest.mock('react-native-keychain', () => ({
  getGenericPassword: async ({service}: any) => {
    if (service === 'bitpay-app-encryption-key' && mockOldKeyFailure)
      throw new Error('native sensitive error');
    if (service === 'bitpay-app-vault-key-v1' && mockKeyMissing) return false;
    const entry = mockCredentials.get(service);
    return entry && mockReadBackFailure
      ? {...entry, password: 'wrong'}
      : entry ?? false;
  },
  setGenericPassword: async (
    username: string,
    password: string,
    options: any,
  ) => {
    mockEvents.push('key:write:' + options.service);
    if (mockSetFailure) return false;
    mockCredentials.set(options.service, {
      username,
      password,
      storage: options.storage,
    });
    return {storage: options.storage};
  },
  resetGenericPassword: async ({service}: any) => {
    mockCredentials.delete(service);
    return true;
  },
  ACCESSIBLE: {AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'local'},
  STORAGE_TYPE: {AES_GCM_NO_AUTH: 'aes-gcm'},
  SECURITY_LEVEL: {SECURE_SOFTWARE: 'software'},
}));
jest.mock('./log/initLogs', () => ({add: jest.fn()}));
jest.mock('./log', () => ({
  LogActions: {persistLog: (x: any) => x, warn: () => ({})},
}));

beforeEach(() => {
  jest.resetModules();
  mockStores.clear();
  mockFiles.clear();
  mockRows.clear();
  mockCredentials.clear();
  mockEvents.length = 0;
  mockWarm =
    mockOldKeyFailure =
    mockSetFailure =
    mockReadBackFailure =
    mockControlFailure =
    mockKeyMissing =
      false;
});
const start = () => require('./vault-runtime').prepareModernVault();
const modernRoot = () =>
  mockStores.get('bitpay.wallet.v2')?.get('persist:root');
const seed = () => {
  mockStores.set(
    'mmkv.default',
    new Map([
      ['persist:root', fixture.raw],
      ['persist:logs', 'old standalone logs'],
    ]),
  );
  mockFiles.set('/synthetic/mmkv/mmkv.default', 'data');
  mockFiles.set('/synthetic/mmkv/mmkv.default.crc', 'crc');
};

it('uses a whole-snapshot device-ID candidate after old Keychain rejection without writing that service', async () => {
  seed();
  mockOldKeyFailure = true;
  const key = await start();
  expect(key !== legacyKey && Buffer.from(key, 'base64').length === 32).toBe(
    true,
  );
  const {decodeSnapshot} = require('./vault-codec');
  expect(
    isEqual(decodeSnapshot(modernRoot(), key).payload, fixture.state),
  ).toBe(true);
  expect(mockEvents.includes('key:write:bitpay-app-encryption-key')).toBe(
    false,
  );
  expect(mockStores.get('bitpay.wallet.v2')!.has('persist:logs')).toBe(false);
  expect(
    mockStores.get('mmkv.default')!.get('persist:root') === fixture.raw,
  ).toBe(true);
});

it('direct AsyncStorage transfer preserves unrelated provider data and never opens old MMKV', async () => {
  const outer = JSON.parse(fixture.raw);
  outer.APP = JSON.stringify(
    JSON.stringify({...fixture.state.APP, migrationMMKVStorageComplete: false}),
  );
  mockRows.set('persist:root', JSON.stringify(outer));
  mockRows.set('walletconnect', 'retained');
  await start();
  expect(mockEvents.includes('open:mmkv.default')).toBe(false);
  expect(mockRows.get('walletconnect')).toBe('retained');
  expect(mockRows.has('persist:root')).toBe(false);
});

it.each(['creation', 'read-back'])(
  'stops before ciphertext or control writes on failed modern key %s',
  async kind => {
    seed();
    mockSetFailure = kind === 'creation';
    mockReadBackFailure = kind === 'read-back';
    await fails(() => start(), 'NEW_KEY_VERIFICATION');
    expect(modernRoot() === undefined).toBe(true);
    expect(mockStores.get('bitpay.wallet.transfer.v2')!.size).toBe(0);
    expect(
      mockStores.get('mmkv.default')!.get('persist:root') === fixture.raw,
    ).toBe(true);
    mockSetFailure = mockReadBackFailure = false;
    await start();
    expect(modernRoot() !== undefined).toBe(true);
  },
);

it('never generates a replacement or falls back when an active modern key is missing', async () => {
  seed();
  await start();
  const before = modernRoot();
  jest.resetModules();
  mockKeyMissing = true;
  mockEvents.length = 0;
  await fails(() => start(), 'MODERN_KEY_FAILURE');
  expect(modernRoot() === before).toBe(true);
  expect(mockEvents.some(e => e.startsWith('key:write'))).toBe(false);
  expect(mockEvents.includes('open:mmkv.default')).toBe(false);
});

it('a failed control read stops before source access and never exposes native messages', async () => {
  seed();
  mockControlFailure = true;
  let error: any;
  try {
    await start();
  } catch (e) {
    error = e;
  }
  expect(error?.message.includes('secret')).toBe(false);
  expect(mockEvents.includes('open:mmkv.default')).toBe(false);
  expect(modernRoot() === undefined).toBe(true);
  mockControlFailure = false;
  await start();
  expect(modernRoot() !== undefined).toBe(true);
});

it('preserves a different-key source when the old credential fails', async () => {
  seed();
  const {encodeSnapshot} = require('./vault-codec');
  const raw = encodeSnapshot(fixture.state, 'different-synthetic-key');
  mockStores.get('mmkv.default')!.set('persist:root', raw);
  mockOldKeyFailure = true;
  await fails(() => start(), 'INVALID_LEGACY_INPUT');
  expect(modernRoot() === undefined).toBe(true);
  expect(mockStores.get('mmkv.default')!.get('persist:root') === raw).toBe(
    true,
  );
  expect(mockEvents.some(e => e.startsWith('key:write'))).toBe(false);
});

it('JS reload retains warm retirement deferral; a modeled cold process removes only the old pair', async () => {
  seed();
  await start();
  mockFiles.set('/synthetic/mmkv/other-instance', 'keep');
  mockFiles.set('/synthetic/mmkv/unexpected', 'keep');
  jest.resetModules();
  await start();
  expect(mockFiles.has('/synthetic/mmkv/mmkv.default')).toBe(true);
  jest.resetModules();
  mockWarm = false;
  await start();
  expect(mockFiles.has('/synthetic/mmkv/mmkv.default')).toBe(false);
  expect(mockFiles.has('/synthetic/mmkv/other-instance')).toBe(true);
  expect(mockFiles.has('/synthetic/mmkv/unexpected')).toBe(true);
});

it('reuses an existing valid modern key and rejects an invalid backend', async () => {
  const password = crypto.randomBytes(32).toString('base64');
  mockCredentials.set('bitpay-app-vault-key-v1', {password, storage: 'wrong'});
  await fails(() => start(), 'MODERN_KEY_FAILURE');
  mockCredentials.set('bitpay-app-vault-key-v1', {
    password,
    storage: 'aes-gcm',
  });
  expect((await start()) === password).toBe(true);
  expect(mockEvents.some(e => e.startsWith('key:write'))).toBe(false);
});

// Never let Jest render a resolved key, ciphertext, payload, or source digest.
const fails = async (operation: () => Promise<unknown>, code?: string) => {
  let failed = false;
  try {
    await operation();
  } catch (error) {
    failed =
      code === undefined ||
      (error instanceof Error && error.message.includes(code));
  }
  expect(failed).toBe(true);
};
