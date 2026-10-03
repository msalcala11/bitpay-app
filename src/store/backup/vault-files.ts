import RNFS from 'react-native-fs';

// Migration-only operations. Ordinary backup and reduxStorage behavior is unchanged.
export const VAULT_BACKUP_DIR = RNFS.CachesDirectoryPath + '/bitpay/redux';
export const VAULT_BACKUP = VAULT_BACKUP_DIR + '/persist-root.json';
export const VAULT_OLDER_BACKUP = VAULT_BACKUP + '.bak';
export const VAULT_BACKUP_TEMP = VAULT_BACKUP + '.tmp';
export const migrationTemp = (path: string) => path + '.vault-migration';

type PreservationCheck = () => void;
const unchecked = () => {};
// Migration-only hook: validate the independent primary around each native
// boundary, including a rejected operation, before a subsequent file mutation.
const checkedIO = async <T>(
  operation: () => Promise<T>,
  check: PreservationCheck,
): Promise<T> => {
  check();
  try {
    return await operation();
  } finally {
    check();
  }
};

export const readVaultFile = async (
  path: string,
  check: PreservationCheck = unchecked,
): Promise<string | null> =>
  (await checkedIO(() => RNFS.exists(path), check))
    ? checkedIO(() => RNFS.readFile(path, 'utf8'), check)
    : null;

export const removeVaultFile = async (
  path: string,
  check: PreservationCheck = unchecked,
): Promise<void> => {
  if (await checkedIO(() => RNFS.exists(path), check)) {
    await checkedIO(() => RNFS.unlink(path), check);
  }
  if (await checkedIO(() => RNFS.exists(path), check)) {
    throw new Error('Vault file remains after deletion');
  }
};

export const promoteVaultFile = async (
  path: string,
  verify: (raw: string | null) => void,
  check: PreservationCheck = unchecked,
): Promise<void> => {
  await removeVaultFile(path, check);
  await checkedIO(() => RNFS.moveFile(migrationTemp(path), path), check);
  verify(await readVaultFile(path, check));
};

export const replaceVaultFile = async (
  path: string,
  raw: string,
  verify: (raw: string | null) => void,
  check: PreservationCheck = unchecked,
): Promise<void> => {
  if (!(await checkedIO(() => RNFS.exists(VAULT_BACKUP_DIR), check))) {
    await checkedIO(() => RNFS.mkdir(VAULT_BACKUP_DIR), check);
  }
  await checkedIO(
    () => RNFS.writeFile(migrationTemp(path), raw, 'utf8'),
    check,
  );
  verify(await readVaultFile(migrationTemp(path), check));
  // RNFS on iOS cannot overwrite a target. A verified temp survives this gap.
  await promoteVaultFile(path, verify, check);
};
