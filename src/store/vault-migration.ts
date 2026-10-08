import AsyncStorage from '@react-native-async-storage/async-storage';
import {getUniqueId} from 'react-native-device-info';
import * as Keychain from 'react-native-keychain';
import {MMKV} from 'react-native-mmkv';
import crypto from 'crypto';
import bs58 from 'bs58';
import {scrubVault, VAULT_SCRUB_KEY} from './vault-scrub';
import {
  safeVaultError,
  vaultError,
  vaultDiagnostic,
  vaultReporter,
  VaultReporter,
  VaultReason,
  VaultSource,
  VaultCode,
  VaultPhase,
} from './vault-diagnostics';
export {VAULT_SCRUB_KEY} from './vault-scrub';
import isEqual from 'lodash.isequal';
import {Network} from '../constants';
import {
  createVaultKey,
  hasRequiredBackend,
  LEGACY_KEY_SERVICE,
  readVaultKey,
  removeKeyAndVerify,
  validatedVaultKey,
  VAULT_KEY_SERVICE,
} from './encryption-key';
import {
  migrationTemp,
  promoteVaultFile,
  readVaultFile,
  removeVaultFile,
  replaceVaultFile,
  VAULT_BACKUP,
  VAULT_BACKUP_TEMP,
  VAULT_OLDER_BACKUP,
} from './backup/vault-files';
import {
  decryptPersistValue,
  decryptValue,
  encryptPersistValue,
  encryptValue,
} from './transforms/encrypt';
import {unencryptedPersistStores} from './transforms/persist-encryption';
import {
  VaultRecord,
  parseVaultRecord,
  conversionEstablished,
  CLEANUP_RECEIPT,
  validReceipt,
  CleanupSlot,
  CleanupState,
  SourceKind,
} from './vault-repair-state';

const ROOT = 'persist:root';
const REGISTERED_KEYS = [ROOT, 'persist:logs']; // Both use getString/set.
export const VAULT_RECORD_ID = 'bitpay.vault.migration';
export const VAULT_RECORD_KEY = 'migration';

type RecordState = VaultRecord;
type Payload = Record<string, any>;
type Snapshot = {raw: string; payload: Payload; format: 'cbc' | 'gcm'};
type Inspected = {raw: string | null; parseable: boolean; snapshot?: Snapshot};
type FileCopy = {
  path: string;
  target: Inspected;
  temp: Inspected;
  effective: Inspected;
};

let recordStorage: MMKV | undefined;
let inFlight: Promise<string> | undefined;
let initializationPending = false;
const records = () => (recordStorage ??= new MMKV({id: VAULT_RECORD_ID}));

function fail(_message: string): never {
  // Parser checks are fixed classification sites, never native-message inference.
  throw vaultError('INVALID_LEGACY_INPUT', 'classify', 'SOURCE_INVALID');
}

const object = (value: any): value is Payload =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// Read-only syntax checks for the two historically unwrapped fields. These do
// not instantiate/normalize wallet clients or unlock inner password ciphertext.
// Rejecting arbitrary short plaintext also matters to the scrub's <=3-byte
// terminal-fragment argument: a supported bare EDDSA key is an extended key.
const legacyEddsaValue = (value: string, field: string): boolean => {
  try {
    if (field === 'xPrivKeyEDDSA') {
      const data = Buffer.from(bs58.decode(value));
      if (data.length !== 82 || data[45] !== 0) return false;
      if (![0x0488ade4, 0x04358394].includes(data.readUInt32BE(0)))
        return false;
      const checksum = crypto
        .createHash('sha256')
        .update(
          crypto.createHash('sha256').update(data.subarray(0, 78)).digest(),
        )
        .digest()
        .subarray(0, 4);
      return checksum.equals(data.subarray(78)) && bs58.encode(data) === value;
    }
    const blob = JSON.parse(value);
    if (!object(blob)) return false;
    for (const name of ['ct', 'iv', 'salt']) {
      if (
        typeof blob[name] !== 'string' ||
        !blob[name].length ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(blob[name])
      )
        return false;
    }
    return Buffer.from(blob.ct, 'base64').length >= 16;
  } catch {
    return false;
  }
};

const readRecord = (
  phase: VaultPhase = 'inventory',
): RecordState | undefined => {
  try {
    const raw = records().getString(VAULT_RECORD_KEY);
    if (raw === undefined) {
      if (records().contains(VAULT_RECORD_KEY))
        throw vaultError(
          'PRESERVATION_FAILURE',
          phase,
          'RECORD_INVALID',
          'record',
        );
      return;
    }
    return parseVaultRecord(raw, phase);
  } catch (error) {
    throw safeVaultError(
      error,
      'PRESERVATION_FAILURE',
      phase,
      'RECORD_READ',
      'record',
    );
  }
};
const writeRecord = (record: RecordState, phase: VaultPhase = 'conversion') => {
  try {
    const raw = JSON.stringify(record);
    if (records().getString(VAULT_RECORD_KEY) === raw) return;
    records().set(VAULT_RECORD_KEY, raw);
    if (records().getString(VAULT_RECORD_KEY) !== raw)
      throw vaultError('PRESERVATION_FAILURE', phase, 'RECORD_WRITE', 'record');
  } catch (error) {
    throw safeVaultError(
      error,
      'PRESERVATION_FAILURE',
      phase,
      'RECORD_WRITE',
      'record',
    );
  }
};
export const hasConvertedVault = () => conversionEstablished(readRecord());

export const hasVaultMigrationStarted = async (): Promise<boolean> => {
  try {
    return records().contains(VAULT_RECORD_KEY) || !!(await readVaultKey());
  } catch (error) {
    throw safeVaultError(
      error,
      'PRESERVATION_FAILURE',
      'inventory',
      'RECORD_READ',
      'record',
    );
  }
};

// The Android residual cleanup has its own marker and never resets these flags.
export const hasCompletedVaultMigration = (): boolean =>
  readRecord()?.status === 'complete';

export const hasPendingVaultInitialization = (): boolean =>
  readRecord()?.initializing === true;

// Called only after a verified active snapshot or a read-back-verified first
// ordinary root write. A failed retirement leaves the root intact and retries
// on the next save/startup; it must never authorize SQLite cleanup by itself.
export const finishVaultInitialization = () => {
  const record = readRecord();
  if (record?.initializing) {
    const established = {...record};
    // Only our admitted fresh-install provenance plus a verified first save
    // establishes this history. Cleanup remains an independent obligation.
    if (established.status === 'started') established.conversionComplete = true;
    delete established.initializing;
    writeRecord(established);
  }
  initializationPending = false;
};

export const recordVaultInitializationSave = (
  storage: MMKV,
  name: string,
  value: string,
) => {
  // No additional MMKV reads/writes on ordinary established saves.
  if (!initializationPending || name !== ROOT) return;
  if (storage.getString(ROOT) !== value)
    throw vaultError('PRESERVATION_FAILURE', 'rkstorage');
  finishVaultInitialization();
};

// Narrow read-only reuse of the serialized-snapshot validator. No source import,
// key fallback, normalization or ordinary restore write is performed here.
const readRecoveryCopy = async (
  path: string,
  record: RecordState,
  key: string,
): Promise<string | null> => {
  const raw = await readVaultFile(path);
  if (
    record.status === 'complete' ||
    (raw !== null && inspect(raw, [key]).snapshot?.format === 'gcm')
  )
    return raw;
  const slot = path === VAULT_BACKUP ? 'main' : 'bak';
  const binding = record.cleanup?.[slot];
  if (
    !binding ||
    (binding.origin !== 'optional-refresh' && binding.writePhase !== 'verified')
  )
    return null;
  const temp = await readVaultFile(migrationTemp(path));
  if (
    temp === null ||
    digest(temp) !== binding.digest ||
    inspect(temp, [key]).snapshot?.format !== 'gcm'
  )
    return null;
  if (path === VAULT_BACKUP) {
    // This backup context belongs to this main write, not another slot's intent.
    let bak: string | null;
    try {
      bak = await readRecoveryCopy(VAULT_OLDER_BACKUP, record, key);
    } catch (error) {
      throw safeVaultError(
        error,
        'REQUIRED_COPY_FAILURE',
        'recovery',
        'SOURCE_READ',
        'bak',
      );
    }
    if (
      bak !== null &&
      inspect(bak, [key]).snapshot?.format === 'gcm' &&
      (binding.bakDigest === undefined || digest(bak) !== binding.bakDigest)
    )
      return bak; // Normal backup precedence; mismatch alone does not prove age.
  }
  return temp; // Matching context, or successful reads found no other usable copy.
};

export const captureVaultCleanupState = async (storage: MMKV, key: string) => {
  const validate = (raw: string) => {
    try {
      if (decode(raw, key).format === 'gcm') return;
    } catch {}
    throw vaultError(
      'PRESERVATION_FAILURE',
      'rkstorage',
      'PRIMARY_INVALID',
      'mmkv',
    );
  };
  let primaryReadFailed = false;
  const read = async () => {
    const primary = () => {
      const raw = readRegistered(storage, () => {
        primaryReadFailed = true;
      }).get(ROOT);
      if (raw === undefined) return;
      validate(raw);
      return {source: ROOT, raw};
    };
    const live = primary();
    if (live) return live;
    let failure: Error | undefined;
    for (const path of [VAULT_BACKUP, VAULT_OLDER_BACKUP]) {
      let raw: string | null = null;
      try {
        const history = readRecord('recovery');
        if (!history || !conversionEstablished(history))
          throw vaultError(
            'PRESERVATION_FAILURE',
            'recovery',
            'RECORD_INVALID',
            'record',
          );
        raw = await readRecoveryCopy(path, history, key);
      } catch (error) {
        failure ??= safeVaultError(
          error,
          'REQUIRED_COPY_FAILURE',
          'recovery',
          'SOURCE_READ',
          path === VAULT_BACKUP ? 'main' : 'bak',
        );
      }
      const changed = primary();
      if (changed) return changed;
      if (raw !== null) {
        if (inspect(raw, [key]).snapshot?.format === 'gcm')
          return {source: path, raw};
        failure ??= vaultError(
          'PRESERVATION_FAILURE',
          'recovery',
          'RECOVERY_UNAVAILABLE',
        );
      }
    }
    if (failure) throw failure;
  };
  let initial: Awaited<ReturnType<typeof read>>;
  try {
    initial = await read();
  } catch (error) {
    if (
      !primaryReadFailed &&
      vaultDiagnostic(error as Error)?.reason !== 'PRIMARY_INVALID'
    )
      throw error;
    await recoverConvertedVault(storage, key);
    initial = await read();
  }
  return {
    present: initial !== undefined,
    verifyCurrent: async () => {
      if (initial?.source === ROOT && !storage.contains(ROOT))
        throw vaultError('PRESERVATION_FAILURE', 'rkstorage');
      const current = await read();
      if (initial && !current)
        throw vaultError('PRESERVATION_FAILURE', 'rkstorage');
      return isEqual(initial, current);
    },
  };
};

// Visit exactly the fields protected by #2278. Password-encrypted wallet values
// remain opaque strings. This does not bootstrap clients or rebuild reducer state.
const mapFields = (
  state: Payload,
  reducer: string,
  transform: (value: string, context: string, field: string) => string,
  copy = true,
): Payload => {
  const result = copy ? JSON.parse(JSON.stringify(state)) : state;
  const fields = (container: any, names: string[], context: string) => {
    if (!object(container)) {
      fail('invalid protected-field container');
    }
    for (const name of names) {
      const value = container[name];
      if (value === undefined || value === null || value === '') {
        continue;
      }
      if (typeof value !== 'string') {
        fail('invalid protected-field value');
      }
      container[name] = transform(value, `${context}.${name}`, name);
    }
  };
  if (reducer === 'WALLET' && result.keys != null) {
    if (!object(result.keys)) {
      fail('invalid wallet key map');
    }
    for (const [id, key] of Object.entries(result.keys)) {
      if (!object(key)) {
        fail('invalid wallet key');
      }
      if (key.properties != null) {
        fields(
          key.properties,
          [
            'mnemonic',
            'mnemonicEncrypted',
            'xPrivKey',
            'xPrivKeyEncrypted',
            'xPrivKeyEDDSA',
            'xPrivKeyEDDSAEncrypted',
          ],
          `WALLET.keys.${id}.properties`,
        );
      }
    }
  }
  if (reducer === 'APP' && result.identity != null) {
    if (!object(result.identity)) {
      fail('invalid identity map');
    }
    if (result.identity[Network.mainnet] != null) {
      fields(
        result.identity[Network.mainnet],
        ['priv'],
        `APP.identity.${Network.mainnet}`,
      );
    }
  }
  if (reducer === 'SHOP' && result.giftCards != null) {
    if (!object(result.giftCards)) {
      fail('invalid gift card map');
    }
    const cards = result.giftCards[Network.mainnet];
    if (cards != null) {
      if (!Array.isArray(cards)) {
        fail('invalid gift card list');
      }
      for (const card of cards) {
        if (!object(card)) {
          fail('invalid gift card');
        }
        fields(
          card,
          [
            'accessKey',
            'barcodeData',
            'barcodeImage',
            'claimCode',
            'claimLink',
            'pin',
          ],
          `SHOP.giftCards.${Network.mainnet}.${card.invoiceId}`,
        );
      }
    }
  }
  return result;
};

// Inspect actual encryption envelopes and protected fields, not public text that
// happens to contain a format prefix. Damaged encodings are treated conservatively.
const hasModernProtection = (raw: string | null): boolean => {
  if (raw === null) {
    return false;
  }
  const marker = (value: string) =>
    value.includes('persist-aesgcm-v1:') || value.includes('field-aesgcm-v1:');
  let outer: any;
  try {
    outer = JSON.parse(raw);
  } catch {
    return marker(raw);
  }
  if (!object(outer)) {
    return marker(raw);
  }
  let modern = false;
  for (const [reducer, encoded] of Object.entries(outer)) {
    try {
      if (typeof encoded !== 'string') {
        continue;
      }
      const value = JSON.parse(encoded);
      if (typeof value !== 'string') {
        continue;
      }
      if (value.startsWith('persist-aesgcm-v1:')) {
        modern = true;
      } else if (
        unencryptedPersistStores.has(reducer) &&
        !value.startsWith('U2FsdGVkX1')
      ) {
        const state = JSON.parse(value);
        if (object(state)) {
          mapFields(
            state,
            reducer,
            field => {
              modern ||=
                field.startsWith('field-aesgcm-v1:') ||
                field.startsWith('persist-aesgcm-v1:');
              return field;
            },
            false,
          );
        }
      }
    } catch {
      modern ||= typeof encoded === 'string' && marker(encoded);
    }
  }
  return modern;
};

const hasLegacyProtection = (raw: string | null): boolean => {
  if (raw === null) return false;
  try {
    const outer = JSON.parse(raw);
    if (!object(outer)) return false;
    for (const [reducer, encoded] of Object.entries(outer)) {
      if (typeof encoded !== 'string') continue;
      const value = JSON.parse(encoded);
      if (typeof value !== 'string') continue;
      if (value.startsWith('U2FsdGVkX1')) return true;
      if (
        unencryptedPersistStores.has(reducer) &&
        !value.startsWith('persist-aesgcm-v1:')
      ) {
        const state = JSON.parse(value);
        let legacy = false;
        if (object(state))
          mapFields(
            state,
            reducer,
            field => {
              legacy ||= field.startsWith('encrypted:');
              return field;
            },
            false,
          );
        if (legacy) return true;
      }
    }
  } catch {}
  return false;
};

const decode = (
  raw: string,
  secret: string,
  observedModern: () => void = () => {},
): Snapshot => {
  const outer = JSON.parse(raw);
  if (!object(outer)) {
    fail('expected Redux Persist JSON');
  }
  const kinds = new Set<'cbc' | 'gcm'>();
  let unwrappedEddsa = false;
  // Serialized reducer names must remain own data properties, never setters on
  // Object.prototype (in particular they cannot supply an inherited _persist).
  const payload: Payload = Object.create(null);
  for (const [reducer, encoded] of Object.entries(outer)) {
    if (typeof encoded !== 'string') {
      fail('invalid serialized reducer');
    }
    // redux-persist deserializes each value before reversing the transforms.
    const value = JSON.parse(encoded);
    if (typeof value !== 'string') {
      fail('expected transform output to be a string');
    }
    let state: any;
    let wholeCbc = false;
    if (value.startsWith('persist-aesgcm-v1:')) {
      kinds.add('gcm');
      observedModern();
      if (kinds.size !== 1) fail('invalid or mixed-format snapshot');
      state = decryptPersistValue(value, secret, `persist:${reducer}`);
    } else if (value.startsWith('U2FsdGVkX1')) {
      kinds.add('cbc');
      if (kinds.size !== 1) fail('invalid or mixed-format snapshot');
      wholeCbc = true;
      state = decryptPersistValue(value, secret, `persist:${reducer}`);
    } else if (unencryptedPersistStores.has(reducer)) {
      state = JSON.parse(value);
    } else {
      fail('unexpected plaintext reducer');
    }
    if (!object(state)) {
      fail('invalid reducer payload');
    }
    payload[reducer] = mapFields(state, reducer, (field, context, name) => {
      if (field.startsWith('encrypted:')) {
        kinds.add('cbc');
      } else if (field.startsWith('field-aesgcm-v1:')) {
        kinds.add('gcm');
        observedModern();
      } else if (field.startsWith('persist-aesgcm-v1:')) {
        observedModern();
        return fail('invalid protected-field envelope');
      } else if (wholeCbc) {
        return field; // Historical whole-reducer CBC protected these strings.
      } else if (
        reducer === 'WALLET' &&
        ['xPrivKeyEDDSA', 'xPrivKeyEDDSAEncrypted'].includes(name) &&
        legacyEddsaValue(field, name)
      ) {
        // v.14.32.0 omitted these two fields. Only an otherwise validated CBC
        // snapshot can authorize this legacy-only normalization. Inner password
        // ciphertext remains opaque; ordinary modern rehydration stays strict.
        unwrappedEddsa = true;
        return field;
      } else {
        return fail('unexpected plaintext protected field');
      }
      // In particular, a GCM field hidden inside a CBC reducer must never be
      // passed a legacy/device-ID candidate, even for a doomed validation try.
      if (kinds.size !== 1) fail('invalid or mixed-format snapshot');
      const plain = decryptValue(field, secret, context);
      if (typeof plain !== 'string' || plain.length === 0) {
        fail('invalid decrypted field');
      }
      return plain;
    });
  }
  if (
    !object(payload._persist) ||
    typeof payload._persist.version !== 'number' ||
    typeof payload._persist.rehydrated !== 'boolean' ||
    kinds.size !== 1 ||
    (unwrappedEddsa && !kinds.has('cbc'))
  ) {
    fail('invalid or mixed-format snapshot');
  }
  return {raw, payload, format: kinds.has('gcm') ? 'gcm' : 'cbc'};
};

const encode = (payload: Payload, secret: string): string => {
  const outer: Record<string, string> = Object.create(null);
  for (const [reducer, state] of Object.entries(payload)) {
    const fields = mapFields(state, reducer, (value, context) =>
      encryptValue(value, secret, context),
    );
    outer[reducer] = JSON.stringify(
      unencryptedPersistStores.has(reducer)
        ? JSON.stringify(fields)
        : encryptPersistValue(fields, secret, `persist:${reducer}`),
    );
  }
  return JSON.stringify(outer);
};

const inspect = (
  raw: string | null,
  candidates: string[],
  observedModern?: () => void,
): Inspected => {
  if (raw === null) {
    return {raw, parseable: false};
  }
  try {
    JSON.parse(raw);
  } catch {
    return {raw, parseable: false};
  }
  // A single candidate must validate the entire copy. Never combine keys.
  for (const candidate of candidates) {
    try {
      return {
        raw,
        parseable: true,
        snapshot: decode(raw, candidate, observedModern),
      };
    } catch {}
  }
  return {raw, parseable: true};
};

const verify = (
  raw: string | null,
  secret: string,
  payload: Payload,
  phase: VaultPhase = 'required-copy',
): void => {
  try {
    if (raw === null) throw new Error();
    const actual = decode(raw, secret);
    if (actual.format !== 'gcm' || !isEqual(actual.payload, payload))
      throw new Error();
  } catch {
    throw vaultError('REQUIRED_COPY_FAILURE', phase, 'COPY_VERIFICATION');
  }
};

const backupPayload = (payload: Payload): Payload => {
  const result = {...payload};
  for (const key of [
    'MARKET_STATS',
    'PORTFOLIO',
    'PORTFOLIO_CHARTS',
    'RATE',
    'SHOP_CATALOG',
  ]) {
    delete result[key];
  }
  return result;
};

const digest = (raw: string) =>
  crypto.createHash('sha256').update(raw).digest('hex');

const unsupportedBranchFormat = (raw: string | null): boolean => {
  if (raw === null) return false;
  try {
    const encoded = JSON.parse(raw).PORTFOLIO_CHARTS;
    if (encoded === undefined) return false;
    const value = JSON.parse(encoded);
    return (
      typeof value !== 'string' ||
      (!value.startsWith('U2FsdGVkX1') &&
        !value.startsWith('persist-aesgcm-v1:'))
    );
  } catch {
    return false;
  }
};

const protectedProjection = (payload: Payload) => {
  const fields = new Map<string, string>();
  const associations = new Map<string, any>();
  for (const name of ['APP', 'WALLET', 'SHOP']) {
    if (payload[name] !== undefined)
      mapFields(
        payload[name],
        name,
        (value, context) => {
          if (fields.has(context) && fields.get(context) !== value)
            throw vaultError('SOURCE_CONFLICT', 'classify');
          fields.set(context, value);
          return value;
        },
        false,
      );
  }
  for (const [id, key] of Object.entries(payload.WALLET?.keys ?? {}) as [
    string,
    any,
  ][]) {
    const properties = {...key.properties};
    for (const name of [
      'mnemonic',
      'mnemonicEncrypted',
      'xPrivKey',
      'xPrivKeyEncrypted',
      'xPrivKeyEDDSA',
      'xPrivKeyEDDSAEncrypted',
    ])
      delete properties[name];
    associations.set(`key:${id}`, {
      properties,
      readOnly: key.readOnly ?? false,
    });
    if (key.wallets !== undefined && !Array.isArray(key.wallets))
      fail('invalid wallet associations');
    for (const wallet of key.wallets ?? []) {
      if (!object(wallet) || typeof wallet.id !== 'string')
        fail('invalid wallet association');
      const credentials: Payload = {};
      if (wallet.credentials != null) {
        if (!object(wallet.credentials)) fail('invalid wallet credentials');
        // Address/signing associations, not balances, display names, service
        // metadata, or a new conflict policy for the entire wallet reducer.
        for (const name of [
          'walletId',
          'network',
          'coin',
          'chain',
          'm',
          'n',
          'xPubKey',
          'publicKeyRing',
          'rootPath',
          'account',
          'derivationStrategy',
          'addressType',
        ]) {
          if (wallet.credentials[name] !== undefined)
            credentials[name] = wallet.credentials[name];
        }
      }
      associations.set(`wallet:${id}:${wallet.id}`, {
        credentials,
        coin: wallet.coin,
        chain: wallet.chain,
        network: wallet.network,
      });
    }
  }
  const identity = payload.APP?.identity?.[Network.mainnet];
  if (identity && (identity.pub || identity.sin))
    associations.set('identity:livenet', {
      pub: identity.pub,
      sin: identity.sin,
    });
  const occurrences = new Map<string, number>();
  for (const card of payload.SHOP?.giftCards?.[Network.mainnet] ?? []) {
    const id = JSON.stringify(card.invoiceId ?? null);
    const occurrence = occurrences.get(id) ?? 0;
    occurrences.set(id, occurrence + 1);
    associations.set(`gift:${id}:${occurrence}`, {invoiceId: card.invoiceId});
  }
  return {fields, associations};
};
const projectionCovers = (
  a: ReturnType<typeof protectedProjection>,
  b: ReturnType<typeof protectedProjection>,
): boolean =>
  [...b.fields].every(([key, value]) => a.fields.get(key) === value) &&
  [...b.associations].every(([key, value]) => {
    if (!a.associations.has(key)) return false;
    const current = a.associations.get(key);
    // The normal EDDSA upgrade adds this fingerprint beside a new protected
    // key. Only an absent -> valid fingerprint addition is allowed; existing
    // fingerprints and every other derivation/association property stay exact.
    if (
      key.startsWith('key:') &&
      !Object.prototype.hasOwnProperty.call(
        value.properties,
        'fingerPrintEDDSA',
      ) &&
      typeof current.properties.fingerPrintEDDSA === 'string' &&
      /^[a-f0-9]{8}$/.test(current.properties.fingerPrintEDDSA)
    ) {
      const properties = {...current.properties};
      delete properties.fingerPrintEDDSA;
      return isEqual({...current, properties}, value);
    }
    return isEqual(current, value);
  });
const preservesProtected = (target: Payload, source: Payload): boolean =>
  projectionCovers(protectedProjection(target), protectedProjection(source));

const readRegistered = (
  storage: MMKV,
  primaryReadFailed?: () => void,
): Map<string, string> => {
  const values = new Map<string, string>();
  for (const key of REGISTERED_KEYS) {
    let present: boolean, value: string | undefined;
    try {
      present = storage.contains(key);
      value = present ? storage.getString(key) : undefined;
    } catch (error) {
      if (key === ROOT) primaryReadFailed?.();
      throw error;
    }
    if (present) {
      if (value === undefined) {
        throw vaultError(
          'PRESERVATION_FAILURE',
          'inventory',
          'PRIMARY_READ',
          'mmkv',
        );
      }
      values.set(key, value);
    }
  }
  return values;
};

// The receipt is removed from the serialized APP reducer alone. Other reducers
// and opaque field/password ciphertext are preserved byte-for-byte.
const withoutCleanupReceipt = (raw: string, secret: string): string => {
  const outer = JSON.parse(raw);
  if (outer.APP === undefined) return raw;
  const encoded = JSON.parse(outer.APP);
  const encrypted = encoded.startsWith('persist-aesgcm-v1:');
  const app = encrypted
    ? decryptPersistValue(encoded, secret, 'persist:APP')
    : JSON.parse(encoded);
  if (!Object.prototype.hasOwnProperty.call(app, CLEANUP_RECEIPT)) return raw;
  delete app[CLEANUP_RECEIPT];
  outer.APP = JSON.stringify(
    encrypted
      ? encryptPersistValue(app, secret, 'persist:APP')
      : JSON.stringify(app),
  );
  return JSON.stringify(outer);
};

// Shared by pre-store preparation and the adapter's pending-base recovery path.
// Completed records keep their existing adapter fast path.
export const recoverConvertedVault = async (
  storage: MMKV,
  key: string,
  allowFreshEmpty = false,
): Promise<string | null> => {
  const record = readRecord('recovery');
  if (!record || !conversionEstablished(record))
    throw vaultError(
      'PRESERVATION_FAILURE',
      'recovery',
      'RECORD_INVALID',
      'record',
    );
  let primary: string | null = null;
  let primaryReadFailure: Error | undefined;
  try {
    primary = storage.getString(ROOT) ?? null;
  } catch (error) {
    primaryReadFailure = safeVaultError(
      error,
      'PRESERVATION_FAILURE',
      'recovery',
      'PRIMARY_READ',
      'mmkv',
    );
  }
  if (hasLegacyProtection(primary) || unsupportedBranchFormat(primary))
    throw vaultError(
      'UNSUPPORTED_FORMAT',
      'recovery',
      'PRIMARY_INVALID',
      'mmkv',
    );
  // A transient read failure is not a restoration. Keep an authenticated
  // primary exactly as read, including its receipt and cleanup permissions.
  if (primary !== null && inspect(primary, [key]).snapshot?.format === 'gcm')
    return primary;
  let selected: Snapshot | undefined;
  let copyPresent = false;
  let readFailure: Error | undefined;
  for (const path of [VAULT_BACKUP, VAULT_OLDER_BACKUP]) {
    let raw: string | null;
    try {
      raw = await readRecoveryCopy(path, record, key);
    } catch (error) {
      readFailure ??= safeVaultError(
        error,
        'REQUIRED_COPY_FAILURE',
        'recovery',
        'SOURCE_READ',
        path === VAULT_BACKUP ? 'main' : 'bak',
      );
      continue; // A failed main read does not disqualify a valid modern bak.
    }
    if (raw !== null) {
      copyPresent = true;
      const candidate = inspect(raw, [key]).snapshot;
      if (candidate?.format === 'gcm') {
        selected = candidate;
        break;
      }
    }
  }
  if (!selected) {
    // Unknown/unreadable is never evidence of a never-persisted empty install.
    if (readFailure) throw readFailure;
    if (
      allowFreshEmpty &&
      !primaryReadFailure &&
      !copyPresent &&
      record.initializing === true
    )
      return null;
    throw vaultError(
      'PRESERVATION_FAILURE',
      'recovery',
      'RECOVERY_UNAVAILABLE',
      'mmkv',
    );
  }
  // This optional write may fail. The primary write below itself carries the
  // absence of permission, so the stale separate record cannot revive it.
  if (record.status !== 'complete' && !record.cleanup?.suspended) {
    try {
      writeRecord(
        {...record, cleanup: {...record.cleanup, v: 1, suspended: true}},
        'recovery',
      );
    } catch {
      if (!conversionEstablished(readRecord('recovery')))
        throw vaultError(
          'PRESERVATION_FAILURE',
          'recovery',
          'RECORD_INVALID',
          'record',
        );
    }
  }
  const raw =
    record.status === 'complete'
      ? selected.raw
      : withoutCleanupReceipt(selected.raw, key);
  const expected = {
    ...selected.payload,
    ...(selected.payload.APP ? {APP: {...selected.payload.APP}} : {}),
  };
  if (record.status !== 'complete' && expected.APP)
    delete expected.APP[CLEANUP_RECEIPT];
  verify(raw, key, expected, 'recovery');
  try {
    storage.set(ROOT, raw);
    if (storage.getString(ROOT) !== raw) throw new Error();
    verify(storage.getString(ROOT) ?? null, key, expected, 'recovery');
  } catch (error) {
    throw safeVaultError(
      error,
      'PRESERVATION_FAILURE',
      'recovery',
      'COPY_VERIFICATION',
      'mmkv',
    );
  }
  return raw;
};
export const recoverVaultForRead = async (
  storage: MMKV,
  missing: boolean,
): Promise<string | null | undefined> => {
  const record = readRecord('recovery');
  if (!record || !conversionEstablished(record)) return;
  // Completed records keep their normal present-root fast path. On a missing
  // root, only explicit never-persisted initialization permits an empty result;
  // loss of a converted wallet must not bootstrap an empty replacement.
  return recoverConvertedVault(
    storage,
    validatedVaultKey(await readVaultKey()),
    missing,
  );
};

const migrate = async (
  storage: MMKV,
  log: (message: string) => void,
  run: {phase: VaultPhase},
  report: VaultReporter,
): Promise<string> => {
  let record = readRecord();
  initializationPending = record?.initializing === true;
  const entry = await readVaultKey();
  if (record && !entry)
    throw vaultError('MODERN_KEY_FAILURE', 'key', 'KEY_UNAVAILABLE', 'key');
  if (record?.status === 'complete') return validatedVaultKey(entry);
  let wasConverted = conversionEstablished(record);
  const wrongBackend = !!entry && !hasRequiredBackend(entry);
  if (wrongBackend && record)
    throw vaultError('MODERN_KEY_FAILURE', 'key', 'KEY_INVALID', 'key');
  let secret = entry && !wrongBackend ? validatedVaultKey(entry) : undefined;
  run.phase = 'inventory';
  const keys = storage.getAllKeys();
  let primaryReadFailed = false;
  let live: Map<string, string>;
  try {
    live = readRegistered(storage, () => {
      primaryReadFailed = true;
    });
  } catch (error) {
    if (!wasConverted || !primaryReadFailed) throw error;
    await recoverConvertedVault(storage, secret!);
    report.defer('CLEANUP_DEFERRED', 'recovery', 'PRIMARY_READ', 'mmkv');
    return secret!; // No cleanup or other inventory on the recovery launch.
  }
  const rootRaw = live.get(ROOT) ?? null;
  // A verified first save may outlive its failed retirement write. Recognize
  // that history before optional source inventory or backup refresh can fail.
  // An arbitrary started record carries no such fresh-install evidence.
  if (
    !wasConverted &&
    record?.initializing &&
    secret &&
    inspect(rootRaw, [secret]).snapshot?.format === 'gcm'
  ) {
    finishVaultInitialization();
    record = readRecord();
    wasConverted = conversionEstablished(record);
  }
  // A known unsupported format is not evidence of ordinary corruption.
  // Never replace it from an older backup, even after recorded conversion.
  if (secret && unsupportedBranchFormat(rootRaw))
    throw vaultError(
      'UNSUPPORTED_FORMAT',
      'classify',
      'SOURCE_INVALID',
      'mmkv',
    );
  let root: Inspected = {raw: rootRaw, parseable: rootRaw !== null};
  if (wasConverted) {
    root = inspect(rootRaw, [secret!]);
    if (root.snapshot?.format !== 'gcm') {
      await recoverConvertedVault(storage, secret!);
      report.defer('CLEANUP_DEFERRED', 'recovery');
      return secret!; // No source cleanup in the recovery attempt.
    }
  }
  let deferred = false;
  const defer = (
    code: VaultCode,
    phase: VaultPhase,
    reason?: VaultReason,
    source?: VaultSource,
  ) => {
    deferred = true;
    report.defer(code, phase, reason, source);
  };
  let verifiedLive = root.snapshot;
  const checkPrimary = () => {
    try {
      const raw = readRegistered(storage).get(ROOT);
      if (raw === verifiedLive?.raw || (!verifiedLive && raw === rootRaw))
        return;
      if (raw === undefined || !secret) throw new Error();
      const current = decode(raw, secret);
      if (current.format !== 'gcm') throw new Error();
      // Before conversion, no ordinary save is authorized: never overwrite a
      // different modern primary using a stale selected plan.
      if (!conversionEstablished(record)) throw new Error();
      verifiedLive = current;
    } catch {
      throw vaultError(
        'PRESERVATION_FAILURE',
        run.phase,
        'PRIMARY_CHANGED',
        'mmkv',
      );
    }
    defer('SCRUB_STATE_CHANGED', 'scrub');
  };
  const rethrowPreservation = (error: unknown) => {
    checkPrimary();
    const diagnostic = vaultDiagnostic(error as Error);
    // Optional record-write errors are handled inside persistOptional. Any
    // preservation error escaping it is a required primary/history failure.
    if (diagnostic?.code === 'PRESERVATION_FAILURE') throw error;
  };
  let legacy: Awaited<ReturnType<typeof Keychain.getGenericPassword>> = false;
  let legacyUnreadable = false;
  try {
    legacy = await Keychain.getGenericPassword({service: LEGACY_KEY_SERVICE});
  } catch {
    legacyUnreadable = true;
  }
  const rawFiles: {
    path: string;
    target: string | null;
    temp: string | null;
    unreadable?: true;
  }[] = [];
  for (const path of [VAULT_BACKUP, VAULT_OLDER_BACKUP]) {
    try {
      rawFiles.push({
        path,
        target: await readVaultFile(
          path,
          wasConverted ? checkPrimary : undefined,
        ),
        temp: await readVaultFile(
          migrationTemp(path),
          wasConverted ? checkPrimary : undefined,
        ),
      });
    } catch (error) {
      if (!wasConverted)
        throw safeVaultError(
          error,
          'REQUIRED_COPY_FAILURE',
          'inventory',
          'SOURCE_READ',
          path === VAULT_BACKUP ? 'main' : 'bak',
        );
      rethrowPreservation(error);
      defer(
        'OPTIONAL_REFRESH_DEFERRED',
        'inventory',
        'SOURCE_READ',
        path === VAULT_BACKUP ? 'main' : 'bak',
      );
      rawFiles.push({path, target: null, temp: null, unreadable: true});
    }
  }
  let backupTemp: string | null = null,
    backupTempUnreadable = false;
  try {
    backupTemp = await readVaultFile(
      VAULT_BACKUP_TEMP,
      wasConverted ? checkPrimary : undefined,
    );
  } catch (error) {
    if (!wasConverted)
      throw safeVaultError(
        error,
        'REQUIRED_COPY_FAILURE',
        'inventory',
        'SOURCE_READ',
      );
    rethrowPreservation(error);
    backupTempUnreadable = true;
    defer('CLEANUP_DEFERRED', 'inventory', 'SOURCE_READ');
  }
  let asyncRaw: string | null = null,
    asyncUnreadable = false;
  try {
    asyncRaw = await report.readAsync(() => AsyncStorage.getItem(ROOT));
  } catch {
    asyncUnreadable = true;
  } finally {
    if (wasConverted) checkPrimary();
  }
  const raws = [
    rootRaw,
    asyncRaw,
    backupTemp,
    ...rawFiles.flatMap(f => [f.target, f.temp]),
  ];
  const modernHints = new Map(raws.map(raw => [raw, hasModernProtection(raw)]));
  if (!secret && [...modernHints.values()].some(Boolean))
    throw vaultError('MODERN_KEY_FAILURE', 'key', 'KEY_UNAVAILABLE', 'key');
  const legacyCandidates: string[] = [];
  if (raws.some(raw => !modernHints.get(raw) && hasLegacyProtection(raw))) {
    if (legacy && legacy.password) legacyCandidates.push(legacy.password);
    const deviceKey = getUniqueId();
    if (!legacyCandidates.includes(deviceKey)) legacyCandidates.push(deviceKey);
  }
  let observedModern = false;
  const classify = (raw: string | null) => {
    const inspected = inspect(
      raw,
      hasModernProtection(raw) ? (secret ? [secret] : []) : legacyCandidates,
      () => {
        observedModern = true;
      },
    );
    // A missing candidate is not evidence of damage. Remember every unresolved
    // observed copy for this attempt, even if existing cleanup later removes it.
    // Read failures already defer separately; successful absence is resolved.
    if (legacyUnreadable && raw !== null && !inspected.snapshot)
      defer('LEGACY_KEY_UNREADABLE', 'key');
    return inspected;
  };
  if (!wasConverted) root = classify(rootRaw);
  verifiedLive = root.snapshot;
  const files: FileCopy[] = rawFiles.map(f => {
    const target = classify(f.target),
      temp = classify(f.temp);
    return {
      path: f.path,
      target,
      temp,
      effective:
        !target.snapshot && temp.snapshot?.format === 'gcm' ? temp : target,
    };
  });
  const asyncCopy = classify(asyncRaw);
  classify(backupTemp);
  if (!secret && observedModern)
    throw vaultError('MODERN_KEY_FAILURE', 'key', 'KEY_UNAVAILABLE', 'key');
  run.phase = 'classify';
  const pathSlot = (path: string): 'main' | 'bak' =>
    path === VAULT_BACKUP ? 'main' : 'bak';
  const duplicatedTemp = (f: FileCopy) =>
    !!f.temp.snapshot &&
    ((!!root.snapshot &&
      isEqual(backupPayload(root.snapshot.payload), f.temp.snapshot.payload)) ||
      files.some(
        other =>
          !!other.target.snapshot &&
          isEqual(other.target.snapshot.payload, f.temp.snapshot!.payload),
      ));
  if (!wasConverted) {
    const plan = record?.conversionPlan;
    if (!plan && raws.some(unsupportedBranchFormat))
      throw vaultError('UNSUPPORTED_FORMAT', 'classify');
    if (!plan && rootRaw !== null && !root.snapshot)
      throw vaultError(
        'INVALID_LEGACY_INPUT',
        'classify',
        'PRIMARY_INVALID',
        'mmkv',
      );
    if (
      asyncUnreadable &&
      !(
        root.snapshot?.format === 'cbc' &&
        root.snapshot.payload.APP?.migrationMMKVStorageComplete === true
      ) &&
      !plan
    )
      throw vaultError(
        'REQUIRED_COPY_FAILURE',
        'inventory',
        'SOURCE_READ',
        'async',
      );
    const selectedFile = files.find(f => f.effective.snapshot);
    let selected = root.snapshot ?? selectedFile?.effective.snapshot;
    let source: SourceKind = root.snapshot
      ? 'mmkv'
      : selectedFile
      ? selectedFile.effective === selectedFile.temp
        ? (`${pathSlot(selectedFile.path)}-temp` as SourceKind)
        : pathSlot(selectedFile.path)
      : 'async';
    if (!plan) {
      let predecessor = !!root.snapshot;
      for (const f of files) {
        if (f.effective.parseable && !f.effective.snapshot && !predecessor)
          fail('damaged filesystem restore source');
        predecessor ||= !!f.effective.snapshot;
      }
      if (!selected && asyncRaw !== null) {
        if (!asyncCopy.snapshot) fail('invalid AsyncStorage migration source');
        selected = asyncCopy.snapshot;
        source = 'async';
      } else if (selected && asyncRaw !== null) {
        const active = protectedProjection(selected.payload);
        if (!asyncCopy.snapshot) {
          if (active.fields.size === 0)
            fail('invalid AsyncStorage migration source');
        } else if (
          !preservesProtected(selected.payload, asyncCopy.snapshot.payload)
        ) {
          const incoming = protectedProjection(asyncCopy.snapshot.payload);
          if (
            active.fields.size === 0 &&
            selected.payload.APP?.migrationMMKVStorageComplete !== true &&
            projectionCovers(incoming, active)
          ) {
            selected = asyncCopy.snapshot;
            source = 'async';
          } else
            throw vaultError(
              'SOURCE_CONFLICT',
              'classify',
              'SOURCE_UNRESOLVED',
              'async',
            );
        }
      }
      for (const f of files) {
        const oldMarked =
          record?.refresh?.path === pathSlot(f.path) &&
          f.temp.raw !== null &&
          record.refresh.digest === digest(f.temp.raw);
        const markedAndCovered =
          oldMarked &&
          root.snapshot?.format === 'gcm' &&
          !!f.temp.snapshot &&
          preservesProtected(root.snapshot.payload, f.temp.snapshot.payload);
        const requiredSole =
          !f.target.snapshot &&
          f.temp.snapshot?.format === 'gcm' &&
          !!selected &&
          preservesProtected(selected.payload, f.temp.snapshot.payload);
        const selectedDuplicate =
          !!f.temp.snapshot &&
          !!selected &&
          isEqual(backupPayload(selected.payload), f.temp.snapshot.payload);
        if (
          f.temp.raw !== null &&
          !duplicatedTemp(f) &&
          !selectedDuplicate &&
          !markedAndCovered &&
          !requiredSole
        )
          throw vaultError(
            'SOURCE_CONFLICT',
            'classify',
            'SOURCE_UNRESOLVED',
            `${pathSlot(f.path)}-temp`,
          );
      }
    }
    run.phase = 'key';
    if (wrongBackend) await removeKeyAndVerify(VAULT_KEY_SERVICE);
    try {
      secret ??= await createVaultKey();
    } catch (error) {
      throw safeVaultError(
        error,
        'NEW_KEY_VERIFICATION',
        'key',
        'KEY_STORAGE',
        'key',
      );
    }
    if (!record) {
      record = {
        status: 'started',
        wipeDone: false,
        ...(raws.every(raw => raw === null) && !asyncUnreadable
          ? {initializing: true as const}
          : {}),
      };
      writeRecord(record);
      initializationPending = record.initializing === true;
    }
    if (plan) {
      const preparedFile = files[0];
      const boundMain = [
        preparedFile.target.snapshot,
        preparedFile.temp.snapshot,
      ].find(s => s?.format === 'gcm' && digest(s.raw) === plan.mainDigest);
      const boundSource = [
        root.snapshot,
        asyncCopy.snapshot,
        ...files.flatMap(f => [f.target.snapshot, f.temp.snapshot]),
      ].find(s => s && digest(s.raw) === plan.sourceDigest);
      if (boundMain) {
        if (boundMain.payload.APP?.[CLEANUP_RECEIPT] !== plan.primaryReceipt)
          throw vaultError(
            'PRESERVATION_FAILURE',
            'conversion',
            'PLAN_INVALID',
            'record',
          );
        selected = boundMain;
        if (
          root.snapshot?.format === 'gcm' &&
          !isEqual(backupPayload(root.snapshot.payload), boundMain.payload)
        )
          throw vaultError(
            'SOURCE_CONFLICT',
            'conversion',
            'PRIMARY_CHANGED',
            'mmkv',
          );
      } else if (
        root.snapshot?.format === 'gcm' &&
        root.snapshot.payload.APP?.[CLEANUP_RECEIPT] === plan.primaryReceipt
      ) {
        selected = root.snapshot;
      } else {
        if (!boundSource)
          throw vaultError(
            'PRESERVATION_FAILURE',
            'conversion',
            'PLAN_INVALID',
            'record',
          );
        selected = boundSource;
      }
      source = plan.source;
    }
    if (selected) {
      run.phase = 'required-copy';
      const receipt =
        plan?.primaryReceipt ?? crypto.randomBytes(16).toString('hex');
      const payload = {
        ...selected.payload,
        APP: {...selected.payload.APP, [CLEANUP_RECEIPT]: receipt},
      };
      const expectedBackup = backupPayload(payload);
      const main = files[0];
      const existing = plan
        ? [main.target.snapshot, main.temp.snapshot].find(
            s => s?.format === 'gcm' && digest(s.raw) === plan.mainDigest,
          )
        : undefined;
      const plannedRaw = existing?.raw ?? encode(expectedBackup, secret);
      const descriptor = {
        v: 1 as const,
        source,
        sourceDigest: plan?.sourceDigest ?? digest(selected.raw),
        mainDigest: digest(plannedRaw),
        primaryReceipt: receipt,
        ...(plan?.output ? {output: plan.output} : {}),
      };
      record = {...record, conversionPlan: descriptor};
      writeRecord(record);
      const guard = () => {
        const now = storage.getString(ROOT) ?? null;
        if (now !== rootRaw)
          throw vaultError(
            'PRESERVATION_FAILURE',
            'required-copy',
            'PRIMARY_CHANGED',
            'mmkv',
          );
      };
      const verifiedOutput = (path: string, raw: string) => {
        const output = record!.conversionPlan?.output;
        if (
          output?.phase === 'writing' &&
          output.path === pathSlot(path) &&
          output.digest === digest(raw)
        ) {
          record = {
            ...record!,
            conversionPlan: {
              ...record!.conversionPlan!,
              output: {...output, phase: 'verified'},
            },
          };
          writeRecord(record, 'required-copy');
        }
      };
      // Resolve only proven duplicate or legacy-marked temps. Never overwrite an
      // independent occupied path merely because a new plan needs that path.
      for (const f of files) {
        if (
          f.temp.raw === null ||
          (f.path === VAULT_BACKUP &&
            digest(f.temp.raw) === descriptor.mainDigest)
        )
          continue;
        const output = plan?.output;
        if (
          output?.phase === 'writing' &&
          output.path === pathSlot(f.path) &&
          !f.temp.snapshot &&
          digest(f.temp.raw) !== output.digest &&
          (f.target.raw === null || digest(f.target.raw) !== output.digest)
        ) {
          // This path was proved absent before this specific write was armed.
          // selected is independently validated above; never claim an old temp
          // from a plan without this per-operation observation.
          if (
            (await readVaultFile(migrationTemp(f.path), guard)) !== f.temp.raw
          )
            throw vaultError(
              'SOURCE_CONFLICT',
              'required-copy',
              'SOURCE_CHANGED',
            );
          await removeVaultFile(migrationTemp(f.path), guard);
          f.temp = {raw: null, parseable: false};
          continue;
        }
        const oldMarked =
          record.refresh?.path === pathSlot(f.path) &&
          record.refresh.digest === digest(f.temp.raw);
        const markedAndCovered =
          oldMarked &&
          root.snapshot?.format === 'gcm' &&
          !!f.temp.snapshot &&
          preservesProtected(root.snapshot.payload, f.temp.snapshot.payload);
        const requiredSole =
          !f.target.snapshot &&
          f.temp.snapshot?.format === 'gcm' &&
          preservesProtected(selected.payload, f.temp.snapshot.payload);
        if (
          !duplicatedTemp(f) &&
          !markedAndCovered &&
          !requiredSole &&
          !(
            source === `${pathSlot(f.path)}-temp` && f.temp.raw === selected.raw
          )
        )
          throw vaultError(
            'SOURCE_CONFLICT',
            'required-copy',
            'SOURCE_UNRESOLVED',
            `${pathSlot(f.path)}-temp`,
          );
        if (f.temp.snapshot) verifiedOutput(f.path, f.temp.raw);
        if (!f.target.snapshot && f.temp.snapshot) {
          await promoteVaultFile(
            f.path,
            raw => verify(raw, secret!, f.temp.snapshot!.payload),
            guard,
            f.temp.raw ?? undefined,
          );
          f.target = f.temp;
        } else await removeVaultFile(migrationTemp(f.path), guard);
        f.temp = {raw: null, parseable: false};
      }
      const requiredWrite = async (
        path: string,
        raw: string,
        expected: Payload,
      ) => {
        if (
          path === VAULT_OLDER_BACKUP &&
          (await readVaultFile(path, guard)) === raw
        ) {
          verify(raw, secret!, expected);
          return;
        }
        return replaceVaultFile(
          path,
          raw,
          value => verify(value, secret!, expected),
          guard,
          phase => {
            guard();
            record = {
              ...record!,
              conversionPlan: {
                ...descriptor,
                output: {path: pathSlot(path), digest: digest(raw), phase},
              },
            };
            writeRecord(record, 'required-copy');
          },
        );
      };
      if (existing && existing.raw === main.target.raw) {
        verify(
          await readVaultFile(VAULT_BACKUP, guard),
          secret,
          expectedBackup,
        );
      } else if (
        main.temp.raw !== null &&
        digest(main.temp.raw) === descriptor.mainDigest
      ) {
        verify(main.temp.raw, secret, expectedBackup);
        verifiedOutput(VAULT_BACKUP, main.temp.raw);
        await promoteVaultFile(
          VAULT_BACKUP,
          raw => verify(raw, secret!, expectedBackup),
          guard,
          plannedRaw,
        );
      } else {
        // Retain the previous main under the existing rolling-backup policy.
        if (
          main.target.snapshot &&
          main.target.raw !== selected.raw &&
          !isEqual(main.target.snapshot.payload, expectedBackup)
        ) {
          const previous = main.target.snapshot;
          await requiredWrite(
            VAULT_OLDER_BACKUP,
            previous.format === 'gcm'
              ? previous.raw
              : encode(previous.payload, secret),
            previous.payload,
          );
        }
        await requiredWrite(VAULT_BACKUP, plannedRaw, expectedBackup);
      }
      // Final-path verification is mandatory even after a successful promotion.
      verify(await readVaultFile(VAULT_BACKUP, guard), secret, expectedBackup);
      guard();
      run.phase = 'root-write';
      const current =
        root.snapshot?.format === 'gcm' &&
        isEqual(backupPayload(root.snapshot.payload), expectedBackup)
          ? root.snapshot.raw
          : encode(payload, secret);
      if (storage.getString(ROOT) !== current) storage.set(ROOT, current);
      if (storage.getString(ROOT) !== current)
        throw vaultError(
          'PRESERVATION_FAILURE',
          'root-write',
          'COPY_VERIFICATION',
          'mmkv',
        );
      verify(
        current,
        secret,
        current === root.snapshot?.raw ? root.snapshot.payload : payload,
        'root-write',
      );
      verifiedLive = decode(current, secret);
      run.phase = 'conversion';
      const cleanup: CleanupState = {
        ...record.cleanup,
        v: 1,
        primaryReceipt: receipt,
      };
      if (
        asyncCopy.snapshot &&
        preservesProtected(verifiedLive.payload, asyncCopy.snapshot.payload)
      )
        cleanup.async = {
          origin: 'converted-source',
          digest: digest(asyncCopy.snapshot.raw),
        };
      record = {...record, conversionComplete: true, cleanup};
      delete record.conversionPlan;
      delete record.initializing;
      writeRecord(record);
      initializationPending = false;
    }
  }
  const vaultKey = secret!;
  if (!record)
    throw vaultError(
      'PRESERVATION_FAILURE',
      'conversion',
      'RECORD_INVALID',
      'record',
    );
  if (asyncUnreadable)
    defer('CLEANUP_DEFERRED', 'inventory', 'SOURCE_READ', 'async');
  checkPrimary();
  const ensureMandatory = () => {
    const current = readRecord(run.phase);
    if (
      !current ||
      (conversionEstablished(record) && !conversionEstablished(current))
    )
      throw vaultError(
        'PRESERVATION_FAILURE',
        run.phase,
        'RECORD_INVALID',
        'record',
      );
  };
  const persistOptional = (
    next: RecordState,
    source?: VaultSource,
  ): boolean => {
    try {
      writeRecord(next, run.phase);
      record = next;
      return true;
    } catch {
      ensureMandatory();
      checkPrimary();
      defer(
        'CLEANUP_DEFERRED',
        run.phase,
        source ? 'PERMISSION_WRITE' : 'RECORD_WRITE',
        source ?? 'record',
      );
      return false;
    }
  };
  const receiptMatches = () =>
    !!verifiedLive &&
    validReceipt(record!.cleanup?.primaryReceipt) &&
    !record!.cleanup?.suspended &&
    verifiedLive.payload.APP?.[CLEANUP_RECEIPT] ===
      record!.cleanup.primaryReceipt;
  const bindCoverage = (slot: CleanupSlot, raw: string): boolean =>
    persistOptional(
      {
        ...record!,
        cleanup: {
          ...record!.cleanup,
          v: 1,
          [slot]: {
            origin: 'current-coverage',
            digest: digest(raw),
            ...(slot !== 'async' &&
            record!.cleanup?.[slot]?.digest === digest(raw) &&
            record!.cleanup?.[slot]?.writePhase
              ? {
                  writePhase: 'verified' as const,
                  ...(slot === 'main' &&
                  record!.cleanup?.main?.bakDigest !== undefined
                    ? {bakDigest: record!.cleanup.main.bakDigest}
                    : {}),
                }
              : {}),
          },
        },
      },
      slot === 'async' ? 'async' : `${slot}-temp`,
    );
  const canRemove = (
    slot: CleanupSlot,
    item: Inspected,
    issueCoverage = true,
  ): boolean => {
    checkPrimary();
    if (item.raw === null) return true;
    const binding = record!.cleanup?.[slot];
    const bound = !!binding && binding.digest === digest(item.raw);
    if (slot !== 'async' && !bound) return false;
    if (bound && binding!.origin !== 'current-coverage' && receiptMatches())
      return true;
    if (
      !item.snapshot ||
      !verifiedLive ||
      !preservesProtected(verifiedLive.payload, item.snapshot.payload)
    )
      return false;
    // After the final identity read, never introduce another state-changing
    // permission write. A newly needed coverage intent waits for the next try.
    return issueCoverage
      ? bindCoverage(slot, item.raw)
      : bound && binding!.origin === 'current-coverage';
  };
  const damagedAsync = (item: Inspected) =>
    !legacyUnreadable &&
    conversionEstablished(record) &&
    item.raw !== null &&
    !item.snapshot &&
    receiptMatches();
  const deferDeletion = async (
    operation: () => Promise<void>,
    source?: VaultSource,
  ) => {
    checkPrimary();
    try {
      await operation();
    } catch (error) {
      rethrowPreservation(error);
      const diagnostic = vaultDiagnostic(error as Error);
      defer(
        'CLEANUP_DEFERRED',
        'cleanup',
        diagnostic?.reason ?? 'CLEANUP_PENDING',
        diagnostic?.source ?? source,
      );
    } finally {
      checkPrimary();
    }
  };
  const retireOptionalWrite = (slot: 'main' | 'bak'): boolean => {
    const binding = record!.cleanup?.[slot];
    if (
      binding?.origin !== 'optional-refresh' ||
      binding.writePhase !== 'writing'
    )
      return true;
    return persistOptional(
      {
        ...record!,
        cleanup: {
          ...record!.cleanup,
          v: 1,
          [slot]: {...binding, writePhase: 'verified'},
        },
      },
      `${slot}-temp`,
    );
  };
  const optionalRefresh = async (
    path: string,
    raw: string,
    payload: Payload,
  ) => {
    checkPrimary();
    const slot = pathSlot(path);
    const existing = await readVaultFile(migrationTemp(path), checkPrimary);
    if (existing !== null) {
      defer('OPTIONAL_REFRESH_DEFERRED', 'refresh');
      throw vaultError(
        'OPTIONAL_REFRESH_DEFERRED',
        'refresh',
        'SOURCE_UNRESOLVED',
        `${slot}-temp`,
      );
    }
    if (
      path === VAULT_OLDER_BACKUP &&
      (await readVaultFile(path, checkPrimary)) === raw
    ) {
      verify(raw, vaultKey, payload, 'refresh');
      return;
    }
    // A successful observation is recorded in this main write's own intent.
    // Absence is explicit; an unreadable context defers the refresh.
    const bak =
      path === VAULT_BACKUP
        ? await readVaultFile(VAULT_OLDER_BACKUP, checkPrimary)
        : undefined;
    const context =
      bak === undefined ? {} : {bakDigest: bak === null ? null : digest(bak)};
    await replaceVaultFile(
      path,
      raw,
      value => verify(value, vaultKey, payload, 'refresh'),
      checkPrimary,
      phase => {
        if (
          !persistOptional(
            {
              ...record!,
              cleanup: {
                ...record!.cleanup,
                v: 1,
                [slot]: {
                  origin: 'optional-refresh',
                  digest: digest(raw),
                  writePhase: phase,
                  ...context,
                },
              },
            },
            `${slot}-temp`,
          )
        )
          throw vaultError(
            'OPTIONAL_REFRESH_DEFERRED',
            'refresh',
            'PERMISSION_WRITE',
            'record',
          );
      },
    );
  };

  // Old refresh fields prove only that specific temp's origin. New conversion
  // does not turn unrelated modern temps into owned disposable data.
  if (record.refresh && !record.cleanup?.[record.refresh.path]) {
    persistOptional({
      ...record,
      cleanup: {
        ...record.cleanup,
        v: 1,
        [record.refresh.path]: {
          origin: 'current-coverage',
          digest: record.refresh.digest,
        },
      },
    });
  }
  if (
    asyncRaw !== null &&
    !canRemove('async', asyncCopy, false) &&
    !(
      asyncCopy.snapshot &&
      verifiedLive &&
      preservesProtected(verifiedLive.payload, asyncCopy.snapshot.payload)
    ) &&
    !damagedAsync(asyncCopy)
  )
    defer('CLEANUP_DEFERRED', 'cleanup', 'SOURCE_UNRESOLVED', 'async');
  run.phase = 'refresh';
  let refreshBlocked = rawFiles.some(f => f.unreadable);
  for (const f of files) {
    if (rawFiles.find(raw => raw.path === f.path)?.unreadable) continue;
    const slot = pathSlot(f.path);
    // Re-read after required preparation; the initial inventory may be stale.
    let target: Inspected, temp: Inspected;
    try {
      target = classify(await readVaultFile(f.path, checkPrimary));
      temp = classify(await readVaultFile(migrationTemp(f.path), checkPrimary));
    } catch (error) {
      rethrowPreservation(error);
      defer('OPTIONAL_REFRESH_DEFERRED', 'refresh', 'SOURCE_READ', slot);
      refreshBlocked = true;
      continue;
    }
    if (temp.raw !== null) {
      const otherPath =
        f.path === VAULT_BACKUP ? VAULT_OLDER_BACKUP : VAULT_BACKUP;
      // Do not revisit a path whose inventory already failed, or dispose of
      // unresolved copies while that recovery slot cannot be examined.
      if (rawFiles.find(raw => raw.path === otherPath)?.unreadable) {
        refreshBlocked = true;
        continue;
      }
      const binding = record.cleanup?.[slot];
      const incompleteOutput =
        binding?.origin === 'optional-refresh' &&
        binding.writePhase === 'writing' &&
        !temp.snapshot &&
        digest(temp.raw) !== binding.digest;
      if (!incompleteOutput && !canRemove(slot, temp)) {
        defer(
          'CLEANUP_DEFERRED',
          'cleanup',
          'SOURCE_UNRESOLVED',
          `${slot}-temp`,
        );
        refreshBlocked = true;
        continue;
      }
      // A completed write recovered before promotion must retire the partial
      // output grant too. Otherwise later ordinary rotations could hide that
      // the recorded refresh already finished.
      if (
        temp.snapshot &&
        binding?.writePhase === 'writing' &&
        digest(temp.raw) === binding.digest
      ) {
        if (
          !persistOptional(
            {
              ...record,
              cleanup: {
                ...record.cleanup,
                v: 1,
                [slot]: {...record.cleanup![slot]!, writePhase: 'verified'},
              },
            },
            `${slot}-temp`,
          )
        ) {
          refreshBlocked = true;
          continue;
        }
      }
      let otherValid = false;
      if (!target.snapshot) {
        try {
          const other = await readVaultFile(otherPath, checkPrimary);
          otherValid =
            other !== null &&
            inspect(other, [vaultKey]).snapshot?.format === 'gcm';
        } catch (error) {
          rethrowPreservation(error);
          defer(
            'OPTIONAL_REFRESH_DEFERRED',
            'refresh',
            'SOURCE_READ',
            pathSlot(otherPath),
          );
          refreshBlocked = true;
          continue;
        }
      }
      if (
        !target.snapshot &&
        !otherValid &&
        temp.snapshot?.format === 'gcm' &&
        !!verifiedLive &&
        (slot !== 'main' ||
          isEqual(backupPayload(verifiedLive.payload), temp.snapshot.payload))
      ) {
        try {
          await promoteVaultFile(
            f.path,
            raw => verify(raw, vaultKey, temp.snapshot!.payload, 'refresh'),
            checkPrimary,
            temp.raw ?? undefined,
          );
          target = temp;
        } catch (error) {
          rethrowPreservation(error);
          defer('OPTIONAL_REFRESH_DEFERRED', 'refresh');
          refreshBlocked = true;
          continue;
        }
      } else {
        // Disposal already requires a bound obsolete copy and an independently
        // verified primary (or fresh content coverage). Never promote a stale
        // owned value over current use. Unknown/required sole temps are excluded.
        await deferDeletion(async () => {
          if (
            (await readVaultFile(migrationTemp(f.path), checkPrimary)) !==
              temp.raw ||
            (!incompleteOutput && !canRemove(slot, temp, false))
          )
            throw vaultError(
              'CLEANUP_DEFERRED',
              'cleanup',
              'SOURCE_CHANGED',
              `${slot}-temp`,
            );
          await removeVaultFile(migrationTemp(f.path), checkPrimary);
        }, `${slot}-temp`);
      }
      try {
        if (
          (await readVaultFile(migrationTemp(f.path), checkPrimary)) !== null
        ) {
          refreshBlocked = true;
          continue;
        }
      } catch (error) {
        rethrowPreservation(error);
        defer(
          'OPTIONAL_REFRESH_DEFERRED',
          'refresh',
          'SOURCE_READ',
          `${slot}-temp`,
        );
        refreshBlocked = true;
        continue;
      }
    }
    // Confirmed absence closes an unfinished/abandoned partial-output grant,
    // even if ordinary rotation or the .bak skip makes another write needless.
    // Stop this cleanup attempt if its write/read-back fails: later metadata
    // writes must not copy a stale in-memory `writing` phase back over it.
    if (!retireOptionalWrite(slot)) return vaultKey;
    if (target.snapshot?.format === 'cbc') {
      try {
        await optionalRefresh(
          f.path,
          encode(target.snapshot.payload, vaultKey),
          target.snapshot.payload,
        );
      } catch (error) {
        rethrowPreservation(error);
        defer('OPTIONAL_REFRESH_DEFERRED', 'refresh');
        refreshBlocked = true;
      }
    }
  }

  try {
    run.phase = 'refresh';
    if (!record!.wipeDone) {
      const unexpected = keys.filter(
        key => !REGISTERED_KEYS.includes(key) && key !== VAULT_SCRUB_KEY,
      );
      if (unexpected.length) {
        defer('UNKNOWN_STORAGE_KEY', 'scrub');
      } else {
        let crashCopyReady = !refreshBlocked;
        let verifiedBackup: string | null = null;
        const currentRoot = storage.getString(ROOT);
        if (crashCopyReady && currentRoot !== undefined) {
          const payload = backupPayload(decode(currentRoot, vaultKey).payload);
          // Reads are strict; a write failure during this refresh is deferrable.
          const final = inspect(
            await readVaultFile(VAULT_BACKUP, checkPrimary),
            [vaultKey],
          );
          const bak = inspect(
            await readVaultFile(VAULT_OLDER_BACKUP, checkPrimary),
            [vaultKey],
          );
          if (!final.snapshot || !isEqual(final.snapshot.payload, payload)) {
            try {
              if (final.snapshot) {
                await optionalRefresh(
                  VAULT_OLDER_BACKUP,
                  final.snapshot.raw,
                  final.snapshot.payload,
                );
              }
              await optionalRefresh(
                VAULT_BACKUP,
                encode(payload, vaultKey),
                payload,
              );
              if (final.snapshot) {
                verify(
                  await readVaultFile(VAULT_OLDER_BACKUP, checkPrimary),
                  vaultKey,
                  final.snapshot.payload,
                );
              } else if (bak.snapshot) {
                verify(
                  await readVaultFile(VAULT_OLDER_BACKUP, checkPrimary),
                  vaultKey,
                  bak.snapshot.payload,
                );
              }
            } catch (error) {
              rethrowPreservation(error);
              crashCopyReady = false;
              defer('OPTIONAL_REFRESH_DEFERRED', 'refresh');
            }
          }
          if (crashCopyReady) {
            try {
              verifiedBackup = await readVaultFile(VAULT_BACKUP, checkPrimary);
              verify(verifiedBackup, vaultKey, payload);
            } catch (error) {
              rethrowPreservation(error);
              crashCopyReady = false;
              defer('OPTIONAL_REFRESH_DEFERRED', 'refresh');
            }
          }
        }
        if (crashCopyReady) {
          // Recheck keys immediately before destruction; never coerce unknown values.
          if (
            storage
              .getAllKeys()
              .some(
                key =>
                  !REGISTERED_KEYS.includes(key) && key !== VAULT_SCRUB_KEY,
              )
          ) {
            defer('UNKNOWN_STORAGE_KEY', 'scrub');
          } else {
            run.phase = 'scrub';
            const values = readRegistered(storage);
            if (values.get(ROOT) !== currentRoot) {
              const changed = values.get(ROOT);
              if (
                changed === undefined ||
                decode(changed, vaultKey).format !== 'gcm'
              )
                throw vaultError('PRESERVATION_FAILURE', 'scrub');
              defer('SCRUB_STATE_CHANGED', 'scrub');
            }
            const guard = () => {
              const now = readRegistered(storage);
              const beforeRoot = values.get(ROOT);
              const nowRoot = now.get(ROOT);
              if (beforeRoot !== undefined && nowRoot === undefined)
                throw vaultError('PRESERVATION_FAILURE', 'scrub');
              if (nowRoot !== beforeRoot && nowRoot !== undefined) {
                try {
                  if (decode(nowRoot, vaultKey).format !== 'gcm')
                    throw new Error();
                } catch {
                  throw vaultError('PRESERVATION_FAILURE', 'scrub');
                }
              }
              if (
                !isEqual(now, values) ||
                storage
                  .getAllKeys()
                  .some(
                    key =>
                      !REGISTERED_KEYS.includes(key) && key !== VAULT_SCRUB_KEY,
                  )
              ) {
                defer('SCRUB_STATE_CHANGED', 'scrub');
                return false;
              }
              return true;
            };
            const backupCurrent = async () => {
              if (currentRoot === undefined) return true;
              const raw = await readVaultFile(VAULT_BACKUP, checkPrimary);
              if (raw !== verifiedBackup || raw === null) {
                defer('OPTIONAL_REFRESH_DEFERRED', 'refresh');
                return false;
              }
              return true;
            };
            if (
              !deferred &&
              (await scrubVault(
                storage,
                values,
                guard,
                code => defer(code, 'scrub'),
                backupCurrent,
              ))
            ) {
              checkPrimary();
              if (!deferred) {
                persistOptional({...record!, wipeDone: true});
              }
            }
          }
        }
      }
    }
  } catch (error) {
    rethrowPreservation(error);
    defer('OPTIONAL_REFRESH_DEFERRED', run.phase);
  }
  run.phase = 'cleanup';
  checkPrimary();
  // The ordinary writer's tmp is existing cleanup scope. Do not act on an
  // unreadable path or a path that changed since this inventory.
  if (!backupTempUnreadable && backupTemp !== null)
    await deferDeletion(async () => {
      if ((await readVaultFile(VAULT_BACKUP_TEMP, checkPrimary)) !== backupTemp)
        throw vaultError('CLEANUP_DEFERRED', 'cleanup', 'SOURCE_CHANGED');
      await removeVaultFile(VAULT_BACKUP_TEMP, checkPrimary);
    });
  for (const f of files) {
    if (rawFiles.find(raw => raw.path === f.path)?.unreadable) continue;
    try {
      const raw = await readVaultFile(f.path, checkPrimary);
      const current = inspect(raw, [vaultKey]);
      if (raw !== null && !current.snapshot) {
        // Current primary must be usable before disposing of damaged optional
        // restore bytes; supported CBC is never silently called damaged.
        if (classify(raw).snapshot || !verifiedLive) {
          defer('CLEANUP_DEFERRED', 'cleanup');
          continue;
        }
        await deferDeletion(
          () => removeVaultFile(f.path, checkPrimary),
          pathSlot(f.path),
        );
      }
      if ((await readVaultFile(migrationTemp(f.path), checkPrimary)) !== null)
        defer('CLEANUP_DEFERRED', 'cleanup');
    } catch (error) {
      rethrowPreservation(error);
      defer('CLEANUP_DEFERRED', 'cleanup');
    }
  }
  if (!asyncUnreadable) {
    // Establish/read-back the intent before the final source identity await.
    const qualified =
      asyncRaw === null ||
      canRemove('async', asyncCopy) ||
      damagedAsync(asyncCopy);
    let latest: string | null;
    try {
      latest = await report.readAsync(() => AsyncStorage.getItem(ROOT));
    } catch {
      asyncUnreadable = true;
      defer('CLEANUP_DEFERRED', 'cleanup', 'SOURCE_READ', 'async');
    } finally {
      checkPrimary();
    }
    if (!asyncUnreadable) {
      if (latest! !== asyncRaw)
        defer('CLEANUP_DEFERRED', 'cleanup', 'SOURCE_CHANGED', 'async');
      else {
        if (!qualified)
          defer('CLEANUP_DEFERRED', 'cleanup', 'SOURCE_UNRESOLVED', 'async');
        else {
          await deferDeletion(async () => {
            // Coverage permission is re-proved after the identity await. A
            // historical receipt bypasses content comparison only when still
            // present in this exact, validated current primary.
            if (asyncRaw !== null) {
              checkPrimary();
              if (
                !canRemove('async', asyncCopy, false) &&
                !damagedAsync(classify(latest!))
              )
                throw vaultError(
                  'CLEANUP_DEFERRED',
                  'cleanup',
                  'SOURCE_UNRESOLVED',
                  'async',
                );
              try {
                await AsyncStorage.removeItem(ROOT);
              } catch (error) {
                throw safeVaultError(
                  error,
                  'CLEANUP_DEFERRED',
                  'cleanup',
                  'SOURCE_REMOVE',
                  'async',
                );
              }
              checkPrimary();
            }
            let verified: string | null;
            try {
              verified = await report.readAsync(() =>
                AsyncStorage.getItem(ROOT),
              );
            } catch (error) {
              throw safeVaultError(
                error,
                'CLEANUP_DEFERRED',
                'cleanup',
                'SOURCE_READ',
                'async',
              );
            }
            if (verified !== null)
              throw vaultError(
                'CLEANUP_DEFERRED',
                'cleanup',
                'SOURCE_CHANGED',
                'async',
              );
          });
        }
      }
    }
  }
  checkPrimary();
  if (deferred || !record!.wipeDone) return vaultKey;
  if (legacy || legacyUnreadable)
    await deferDeletion(() => removeKeyAndVerify(LEGACY_KEY_SERVICE), 'key');
  checkPrimary();
  if (!deferred) {
    const completed: RecordState = {
      ...record!,
      status: 'complete',
      wipeDone: true,
    };
    delete completed.conversionPlan;
    delete completed.cleanup;
    delete completed.refresh;
    if (persistOptional(completed)) {
      try {
        log('Vault base cleanup complete');
      } catch {} // Diagnostics cannot revoke successful admission.
    }
  }
  return vaultKey;
};

export const migrateVault = (
  storage: MMKV,
  log: (message: string) => void = () => {},
  sharedReporter?: VaultReporter,
): Promise<string> => {
  if (!inFlight) {
    const run: {phase: VaultPhase} = {phase: 'key'};
    const reporter = sharedReporter ?? vaultReporter(storage, log);
    inFlight = migrate(storage, log, run, reporter)
      .catch(error => {
        const {phase} = run;
        const code: VaultCode =
          phase === 'key'
            ? 'MODERN_KEY_FAILURE'
            : ['root-write', 'scrub', 'conversion', 'recovery'].includes(phase)
            ? 'PRESERVATION_FAILURE'
            : phase === 'classify'
            ? 'INVALID_LEGACY_INPUT'
            : 'REQUIRED_COPY_FAILURE';
        throw safeVaultError(error, code, phase);
      })
      .finally(() => {
        if (!sharedReporter) reporter.finish();
        inFlight = undefined;
      });
  }
  return inFlight;
};
