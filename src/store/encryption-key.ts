import crypto from 'crypto';
import {Platform} from 'react-native';
import * as Keychain from 'react-native-keychain';
import {vaultError, safeVaultError} from './vault-diagnostics';

export const LEGACY_KEY_SERVICE = 'bitpay-app-encryption-key';
export const VAULT_KEY_SERVICE = 'bitpay-app-vault-key-v1';

export const readVaultKey = async () => {
  try {
    return await Keychain.getGenericPassword({service: VAULT_KEY_SERVICE});
  } catch (error) {
    throw safeVaultError(
      error,
      'MODERN_KEY_FAILURE',
      'key',
      'KEY_UNAVAILABLE',
      'key',
    );
  }
};

export const hasRequiredBackend = (
  entry: Pick<Keychain.UserCredentials, 'storage'>,
): boolean =>
  Platform.OS !== 'android' ||
  entry.storage === Keychain.STORAGE_TYPE.AES_GCM_NO_AUTH;

export const validatedVaultKey = (
  entry: false | Keychain.UserCredentials,
): string => {
  if (!entry || !hasRequiredBackend(entry)) {
    throw vaultError('MODERN_KEY_FAILURE', 'key', 'KEY_UNAVAILABLE', 'key');
  }
  const key = entry.password;
  if (
    typeof key !== 'string' ||
    !/^[A-Za-z0-9+/]{43}=$/.test(key) ||
    Buffer.from(key, 'base64').length !== 32 ||
    Buffer.from(key, 'base64').toString('base64') !== key
  ) {
    throw vaultError('MODERN_KEY_FAILURE', 'key', 'KEY_INVALID', 'key');
  }
  return key;
};

export const createVaultKey = async (): Promise<string> => {
  const key = crypto.randomBytes(32).toString('base64');
  const options: Keychain.SetOptions = {
    service: VAULT_KEY_SERVICE,
    ...(Platform.OS === 'ios'
      ? {accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY}
      : {
          storage: Keychain.STORAGE_TYPE.AES_GCM_NO_AUTH,
          securityLevel: Keychain.SECURITY_LEVEL.SECURE_SOFTWARE,
        }),
  };
  const result = await Keychain.setGenericPassword(
    VAULT_KEY_SERVICE,
    key,
    options,
  );
  if (!result || !hasRequiredBackend(result)) {
    throw vaultError('NEW_KEY_VERIFICATION', 'key', 'KEY_STORAGE', 'key');
  }
  try {
    if (validatedVaultKey(await readVaultKey()) !== key) throw new Error();
  } catch {
    throw vaultError('NEW_KEY_VERIFICATION', 'key', 'COPY_VERIFICATION', 'key');
  }
  return key;
};

export const removeKeyAndVerify = async (service: string): Promise<void> => {
  if (!(await Keychain.resetGenericPassword({service}))) {
    throw new Error('Keychain did not remove the entry');
  }
  if (await Keychain.getGenericPassword({service})) {
    throw new Error('Keychain entry remains after deletion');
  }
};

// Historical helpers retained for existing consumers/tests; modern startup uses only the verified vault service.
type SelectNewEncryptionKeyOptions = {
  hasPersistedRoot: () => boolean;
  hasBackup: () => Promise<boolean>;
  getLegacyKey: () => string;
  getRandomKey: () => string;
};

export const selectNewEncryptionKey = async ({
  hasPersistedRoot,
  hasBackup,
  getLegacyKey,
  getRandomKey,
}: SelectNewEncryptionKeyOptions): Promise<{
  key: string;
  legacyCompatible: boolean;
}> => {
  const legacyCompatible = hasPersistedRoot() || (await hasBackup());

  return {
    key: legacyCompatible ? getLegacyKey() : getRandomKey(),
    legacyCompatible,
  };
};

type SetGenericPassword =
  typeof import('react-native-keychain').setGenericPassword;

export const storeEncryptionKey = async (
  encryptionKeyId: string,
  key: string,
  setGenericPassword: SetGenericPassword,
): Promise<void> => {
  const result = await setGenericPassword(encryptionKeyId, key, {
    service: encryptionKeyId,
  });

  if (!result) {
    throw new Error('Keychain did not store the encryption key');
  }
};
