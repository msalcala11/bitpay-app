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
const mockFiles = new Map<string, string | Buffer>();
const mockRows = new Map<string, string>();
const mockCredentials = new Map<string, any>();
const mockEvents: string[] = [];
let mockWarm = false;
let mockOldKeyFailure = false;
let mockSetFailure = false;
let mockReadBackFailure = false;
let mockControlFailure = false;
let mockKeyMissing = false;
let mockPrimaryFailures = 0;
let mockPrimaryReads = 0;
let mockAsyncReadFailure = false;
const mockFileReads: string[] = [];
let mockHashCalls = 0;
let mockLegacyKeysFailure = false;
let mockPartialWritePath: string | undefined;
let mockRejectPartialWrite = true;
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
      if (this.id === 'mmkv.default' && mockLegacyKeysFailure)
        throw new Error('synthetic key inventory failure');
      return [...this.values.keys()];
    }
    contains(k: string) {
      return this.values.has(k);
    }
    getString(k: string) {
      if (this.id === 'mmkv.default' && k === 'persist:root') {
        mockPrimaryReads++;
        if (mockPrimaryFailures > 0) {
          mockPrimaryFailures--;
          throw new Error('synthetic primary read failure');
        }
      }
      if (this.id === 'bitpay.wallet.transfer.v2' && mockControlFailure)
        throw new Error('secret native message');
      return this.values.get(k);
    }
    set(k: string, value: string) {
      mockEvents.push('write:' + this.id + ':' + k);
      if (this.id === 'mmkv.default') throw new Error('old writer forbidden');
      if (this.id === 'bitpay.wallet.transfer.v2')
        mockEvents.push('control:' + JSON.parse(value).phase);
      this.values.set(k, value);
    }
  },
}));
jest.mock('react-native-fs', () => ({
  CachesDirectoryPath: '/cache',
  exists: async (p: string) => {
    const present = mockFiles.has(p);
    mockEvents.push('file:exists:' + p + ':' + present);
    return present;
  },
  readFile: async (p: string) => {
    mockFileReads.push(p);
    const value = mockFiles.get(p);
    return Buffer.isBuffer(value)
      ? new (require('util').TextDecoder)('utf-8', {fatal: true}).decode(value)
      : value;
  },
  hash: async (p: string) => {
    mockHashCalls++;
    return require('crypto')
      .createHash('sha256')
      .update(mockFiles.get(p))
      .digest('hex');
  },
  writeFile: async (p: string, value: string) => {
    mockEvents.push('file:write');
    mockFiles.set(p, value);
    if (p === mockPartialWritePath) {
      mockFiles.set(p, Buffer.from([0xc3, 0x28])); // invalid UTF-8, not just truncated JSON
      mockEvents.push('file:partial-write:' + p);
      if (mockRejectPartialWrite) throw new Error('synthetic partial write');
    }
  },
  mkdir: async () => {},
  unlink: async (p: string) => {
    mockEvents.push('file:unlink:' + p);
    mockFiles.delete(p);
  },
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: async (key: string) => {
    if (mockAsyncReadFailure)
      throw new Error('synthetic required AsyncStorage failure');
    return mockRows.get(key) ?? null;
  },
  getAllKeys: async () => [...mockRows.keys()],
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
  mockPrimaryFailures = mockPrimaryReads = mockHashCalls = 0;
  mockAsyncReadFailure = false;
  mockLegacyKeysFailure = false;
  mockPartialWritePath = undefined;
  mockRejectPartialWrite = true;
  mockFileReads.length = 0;
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

it('C: rereads a rejected primary once and transfers it instead of an older backup', async () => {
  seed();
  const {encodeSnapshot, decodeSnapshot} = require('./vault-codec');
  mockFiles.set(
    '/cache/bitpay/redux/persist-root.json',
    encodeSnapshot({...fixture.state, OLDER: {value: true}}, legacyKey),
  );
  mockPrimaryFailures = 1;
  const key = await start();
  expect(mockPrimaryReads).toBe(2);
  expect(mockPrimaryFailures).toBe(0);
  expect(
    isEqual(decodeSnapshot(modernRoot(), key).payload, fixture.state),
  ).toBe(true);
});

it.each(['main', 'bak', 'none'])(
  'C: two failed primary reads use %s fallback or stop without opening empty',
  async fallback => {
    seed();
    mockPrimaryFailures = 2;
    if (fallback !== 'none')
      mockFiles.set(
        '/cache/bitpay/redux/persist-root.json' +
          (fallback === 'bak' ? '.bak' : ''),
        fixture.raw,
      );
    if (fallback === 'none') {
      await fails(() => start());
      expect(modernRoot() === undefined).toBe(true);
    } else {
      const key = await start();
      const {decodeSnapshot} = require('./vault-codec');
      expect(
        isEqual(decodeSnapshot(modernRoot(), key).payload, fixture.state),
      ).toBe(true);
      jest.resetModules();
      mockWarm = false;
      await start();
      expect(mockFiles.has('/synthetic/mmkv/mmkv.default')).toBe(true);
      expect(mockFiles.has('/synthetic/mmkv/mmkv.default.crc')).toBe(true);
    }
    expect(mockPrimaryReads).toBe(2);
    expect(mockPrimaryFailures).toBe(0);
  },
);

it('C: fallback does not swallow a separate required AsyncStorage failure', async () => {
  seed();
  mockPrimaryFailures = 2;
  mockAsyncReadFailure = true;
  mockFiles.set('/cache/bitpay/redux/persist-root.json', fixture.raw);
  await fails(() => start());
  expect(mockPrimaryReads).toBe(2);
  expect(modernRoot() === undefined).toBe(true);
  expect(mockEvents.some(e => e.startsWith('key:write'))).toBe(false);
});

it('D policy: permitted old files changed after activation are removed without content reads', async () => {
  seed();
  await start();
  const before = modernRoot();
  mockFiles.set('/synthetic/mmkv/mmkv.default', 'changed after activation');
  mockFiles.set('/synthetic/mmkv/mmkv.default.crc', 'changed metadata');
  mockFileReads.length = 0;
  jest.resetModules();
  mockWarm = false;
  await start();
  expect(mockFiles.has('/synthetic/mmkv/mmkv.default')).toBe(false);
  expect(mockFiles.has('/synthetic/mmkv/mmkv.default.crc')).toBe(false);
  expect(modernRoot() === before).toBe(true);
  expect(mockFileReads.length).toBe(0);
  expect(mockHashCalls).toBe(0);
});

it.each(['unknown entry', 'failed inventory'])(
  'C/D: a recovered primary preserves an old instance with %s',
  async reason => {
    seed();
    mockCredentials.set('bitpay-app-encryption-key', {password: legacyKey});
    if (reason === 'unknown entry')
      mockStores.get('mmkv.default')!.set('unknown', 'retain');
    else mockLegacyKeysFailure = true;
    mockPrimaryFailures = 1;
    await start();
    expect(mockPrimaryReads).toBe(2);
    expect(modernRoot() !== undefined).toBe(true);
    jest.resetModules();
    mockWarm = false;
    await start();
    expect(mockFiles.has('/synthetic/mmkv/mmkv.default')).toBe(true);
    expect(mockFiles.has('/synthetic/mmkv/mmkv.default.crc')).toBe(true);
    expect(mockCredentials.has('bitpay-app-encryption-key')).toBe(true);
  },
);

it.each(['main', 'bak'] as const)(
  'A follow-up: malformed obsolete %s is removed through the real runtime adapter',
  async slot => {
    seed();
    const suffix = slot === 'bak' ? '.bak' : '';
    const oldPath = '/cache/bitpay/redux/persist-root.json' + suffix;
    const modernPath = '/cache/bitpay/redux-v2/persist-root.json' + suffix;
    mockFiles.set(oldPath, fixture.raw);
    mockPartialWritePath = modernPath;
    await fails(() => start(), 'REQUIRED_COPY_FAILURE');
    expect(mockEvents.includes('file:partial-write:' + modernPath)).toBe(true);
    expect(mockFiles.get(oldPath) === fixture.raw).toBe(true);
    expect(
      mockStores.get('mmkv.default')!.get('persist:root') === fixture.raw,
    ).toBe(true);
    expect(mockEvents.some(e => e.startsWith('file:unlink:'))).toBe(false);
    expect(Buffer.isBuffer(mockFiles.get(modernPath))).toBe(true);
    // This proves the boundary really rejects content reads while the bytes exist.
    await fails(() => require('react-native-fs').readFile(modernPath, 'utf8'));
    const key = mockCredentials.get('bitpay-app-vault-key-v1').password;
    mockFiles.delete('/cache/bitpay/redux/persist-root.json');
    mockFiles.delete('/cache/bitpay/redux/persist-root.json.bak');
    mockPartialWritePath = undefined;
    mockFileReads.length = 0;
    const retryStart = mockEvents.length;
    await start();
    const events = mockEvents.slice(retryStart);
    const removed = events.indexOf('file:unlink:' + modernPath);
    const verifiedAbsent = events.indexOf(
      'file:exists:' + modernPath + ':false',
      removed + 1,
    );
    const activated = events.indexOf('control:active');
    expect(
      removed >= 0 && verifiedAbsent > removed && activated > verifiedAbsent,
    ).toBe(true);
    expect(
      events.slice(0, activated).filter(e => e.startsWith('file:unlink:')),
    ).toEqual(['file:unlink:' + modernPath]);
    expect(mockFileReads.includes(modernPath)).toBe(false);
    expect(mockFiles.has(modernPath)).toBe(false);
    expect(
      mockCredentials.get('bitpay-app-vault-key-v1').password === key,
    ).toBe(true);
    expect(
      mockEvents.filter(e => e === 'key:write:bitpay-app-vault-key-v1').length,
    ).toBe(1);
    expect(
      mockStores.get('mmkv.default')!.get('persist:root') === fixture.raw,
    ).toBe(true);
    const {decodeSnapshot} = require('./vault-codec');
    expect(
      isEqual(decodeSnapshot(modernRoot(), key).payload, fixture.state),
    ).toBe(true);
  },
);

it('A follow-up: unreadable required output still fails content verification', async () => {
  seed();
  const modernPath = '/cache/bitpay/redux-v2/persist-root.json';
  mockFiles.set('/cache/bitpay/redux/persist-root.json', fixture.raw);
  mockPartialWritePath = modernPath;
  mockRejectPartialWrite = false; // write resolves, but the required copy is unreadable
  await fails(() => start());
  expect(mockEvents.includes('file:partial-write:' + modernPath)).toBe(true);
  expect(mockFileReads.includes(modernPath)).toBe(true);
  expect(mockEvents.includes('control:active')).toBe(false);
  expect(mockEvents.some(e => e.startsWith('file:unlink:'))).toBe(false);
  expect(
    mockFiles.get('/cache/bitpay/redux/persist-root.json') === fixture.raw,
  ).toBe(true);
  mockPartialWritePath = undefined;
  await start();
  expect(mockEvents.includes('control:active')).toBe(true);
  expect(
    mockEvents.filter(e => e === 'key:write:bitpay-app-vault-key-v1').length,
  ).toBe(1);
});
