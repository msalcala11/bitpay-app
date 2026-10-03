import {Platform} from 'react-native';
import * as Keychain from 'react-native-keychain';
import {
  createVaultKey,
  hasRequiredBackend,
  validatedVaultKey,
  VAULT_KEY_SERVICE,
} from './encryption-key';

jest.mock('react-native-keychain', () => ({
  getGenericPassword: jest.fn(),
  setGenericPassword: jest.fn(),
  ACCESSIBLE: {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'device-local-after-unlock',
  },
  STORAGE_TYPE: {AES_GCM_NO_AUTH: 'KeystoreAESGCM_NoAuth'},
  SECURITY_LEVEL: {SECURE_SOFTWARE: 'software'},
}));

const read = Keychain.getGenericPassword as jest.Mock;
const write = Keychain.setGenericPassword as jest.Mock;
beforeEach(() => {
  jest.clearAllMocks();
  Platform.OS = 'android';
  write.mockImplementation(async (_user, password, options) => {
    read.mockResolvedValue({
      password,
      service: options.service,
      storage: 'KeystoreAESGCM_NoAuth',
    });
    return {service: options.service, storage: 'KeystoreAESGCM_NoAuth'};
  });
});

it.each(['ios', 'android'] as const)(
  'generates and verifies a 32-byte random %s key with the required options',
  async platform => {
    Platform.OS = platform;
    const key = await createVaultKey();
    expect(Buffer.from(key, 'base64').length).toBe(32);
    const [, saved, options] = write.mock.calls[0];
    expect(saved === key).toBe(true);
    expect(options).toEqual(
      platform === 'ios'
        ? {
            service: VAULT_KEY_SERVICE,
            accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
          }
        : {
            service: VAULT_KEY_SERVICE,
            storage: Keychain.STORAGE_TYPE.AES_GCM_NO_AUTH,
            securityLevel: Keychain.SECURITY_LEVEL.SECURE_SOFTWARE,
          },
    );
    expect(read.mock.calls).toEqual([[{service: VAULT_KEY_SERVICE}]]);
  },
);

it.each([false, {storage: 'wrong-backend'}])(
  'rejects unsuccessful Android writes',
  async result => {
    write.mockResolvedValue(result);
    await expect(createVaultKey().then(() => undefined)).rejects.toThrow(
      'required backend',
    );
  },
);
it('rejects failed writes and read-back mismatch', async () => {
  write.mockRejectedValueOnce(new Error('unavailable'));
  await expect(createVaultKey().then(() => undefined)).rejects.toThrow(
    'unavailable',
  );
  write.mockResolvedValue({storage: 'KeystoreAESGCM_NoAuth'});
  read.mockResolvedValue(false);
  await expect(createVaultKey().then(() => undefined)).rejects.toThrow();
});
it('checks Android read backend but does not check it on iOS', () => {
  const entry = {storage: 'other'} as unknown as Keychain.UserCredentials;
  expect(hasRequiredBackend(entry)).toBe(false);
  Platform.OS = 'ios';
  expect(hasRequiredBackend(entry)).toBe(true);
});
it.each(['', 'invalid', 'A'.repeat(44)])(
  'rejects invalid versioned material',
  password => {
    expect(() =>
      validatedVaultKey({
        password,
        username: '',
        service: VAULT_KEY_SERVICE,
        storage: Keychain.STORAGE_TYPE.AES_GCM_NO_AUTH,
      }),
    ).toThrow();
  },
);
