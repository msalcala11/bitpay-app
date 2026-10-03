import AsyncStorage from '@react-native-async-storage/async-storage';
import {getUniqueId} from 'react-native-device-info';
import * as Keychain from 'react-native-keychain';
import {MMKV} from 'react-native-mmkv';
import {Platform} from 'react-native';
import crypto from 'crypto';
import bs58 from 'bs58';
import {scrubVault, VAULT_SCRUB_KEY} from './vault-scrub';
import {
  safeVaultError,
  vaultError,
  vaultDiagnostic,
  vaultDeferredMessage,
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

const ROOT = 'persist:root';
const REGISTERED_KEYS = [ROOT, 'persist:logs']; // Both use getString/set.
export const VAULT_RECORD_ID = 'bitpay.vault.migration';
export const VAULT_RECORD_KEY = 'migration';

type RecordState = {
  status: 'started' | 'complete';
  wipeDone: boolean;
  refresh?: {path: 'main' | 'bak'; digest: string};
  // Android only: strict initial inventory found no persisted root/copy. This
  // survives base completion until the first ordinary save becomes observable.
  initializing?: true;
};
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

function fail(message: string): never {
  const code: VaultCode =
    message.includes('vault key') ||
    message.includes('backend') ||
    message.includes('AES-GCM data')
      ? 'MODERN_KEY_FAILURE'
      : message.includes('read-back') || message.includes('written snapshot')
      ? 'REQUIRED_COPY_FAILURE'
      : message.includes('MMKV') || message.includes('record')
      ? 'PRESERVATION_FAILURE'
      : 'INVALID_LEGACY_INPUT';
  throw vaultError(code, code === 'MODERN_KEY_FAILURE' ? 'key' : 'classify');
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

const readRecord = (): RecordState | undefined => {
  const raw = records().getString(VAULT_RECORD_KEY);
  if (raw === undefined) {
    if (records().contains(VAULT_RECORD_KEY)) {
      fail('invalid migration record');
    }
    return undefined;
  }
  const value = JSON.parse(raw);
  if (
    !object(value) ||
    !['started', 'complete'].includes(value.status) ||
    typeof value.wipeDone !== 'boolean' ||
    (value.status === 'complete' && !value.wipeDone) ||
    (value.initializing !== undefined && value.initializing !== true) ||
    (value.refresh !== undefined &&
      (!object(value.refresh) ||
        !['main', 'bak'].includes(value.refresh.path) ||
        typeof value.refresh.digest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.refresh.digest)))
  ) {
    fail('invalid migration record');
  }
  return value as RecordState;
};

const writeRecord = (record: RecordState) => {
  const raw = JSON.stringify(record);
  records().set(VAULT_RECORD_KEY, raw);
  if (records().getString(VAULT_RECORD_KEY) !== raw) {
    fail('migration record read-back failed');
  }
};

export const hasVaultMigrationStarted = async (): Promise<boolean> =>
  records().contains(VAULT_RECORD_KEY) || !!(await readVaultKey());

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
export const captureVaultCleanupState = async (storage: MMKV, key: string) => {
  const validate = (raw: string) => {
    try {
      if (decode(raw, key).format === 'gcm') return;
    } catch {}
    throw vaultError('PRESERVATION_FAILURE', 'rkstorage');
  };
  const read = async () => {
    const primary = () => {
      const raw = readRegistered(storage).get(ROOT);
      if (raw === undefined) return;
      validate(raw);
      return {source: ROOT, raw};
    };
    const live = primary();
    if (live) return live;
    for (const path of [VAULT_BACKUP, VAULT_OLDER_BACKUP]) {
      const raw = await readVaultFile(path);
      const changed = primary();
      if (changed) return changed;
      if (raw !== null) {
        validate(raw);
        return {source: path, raw};
      }
    }
  };
  const initial = await read();
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

const verify = (raw: string | null, secret: string, payload: Payload): void => {
  if (raw === null) {
    fail('written snapshot is missing');
  }
  const actual = decode(raw, secret);
  if (actual.format !== 'gcm' || !isEqual(actual.payload, payload)) {
    fail('snapshot read-back failed');
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

const readRegistered = (storage: MMKV): Map<string, string> => {
  const values = new Map<string, string>();
  for (const key of REGISTERED_KEYS) {
    if (storage.contains(key)) {
      const value = storage.getString(key);
      if (value === undefined) {
        fail('registered MMKV value is not a string');
      }
      values.set(key, value);
    }
  }
  return values;
};

const migrate = async (
  storage: MMKV,
  log: (message: string) => void,
  run: {phase: VaultPhase},
): Promise<string> => {
  let record: RecordState | undefined;
  try {
    record = readRecord();
    initializationPending = record?.initializing === true;
  } catch (error) {
    throw safeVaultError(error, 'PRESERVATION_FAILURE', 'inventory');
  }
  const entry = await readVaultKey();
  if (record && !entry) {
    fail('migration record exists without its vault key');
  }
  if (record?.status === 'complete') {
    return validatedVaultKey(entry); // No copy inventory or cleanup after completion.
  }
  const wrongBackend = !!entry && !hasRequiredBackend(entry);
  if (wrongBackend && record) {
    fail('recorded vault key has the wrong backend');
  }
  let secret = entry && !wrongBackend ? validatedVaultKey(entry) : undefined;
  let legacy: Awaited<ReturnType<typeof Keychain.getGenericPassword>> = false;
  let legacyUnreadable = false;
  try {
    legacy = await Keychain.getGenericPassword({service: LEGACY_KEY_SERVICE});
  } catch {
    legacyUnreadable = true;
  }
  run.phase = 'inventory';
  const keys = storage.getAllKeys();
  const live = readRegistered(storage);
  const rootRaw = live.get(ROOT) ?? null;
  // Complete strict inventory before classification, key writes, or temp cleanup.
  const rawFiles = [];
  for (const path of [VAULT_BACKUP, VAULT_OLDER_BACKUP]) {
    rawFiles.push({
      path,
      target: await readVaultFile(path),
      temp: await readVaultFile(migrationTemp(path)),
    });
  }
  const backupTemp = await readVaultFile(VAULT_BACKUP_TEMP);
  const asyncRaw = await AsyncStorage.getItem(ROOT);
  const raws = [
    rootRaw,
    asyncRaw,
    backupTemp,
    ...rawFiles.flatMap(file => [file.target, file.temp]),
  ];
  const modernHints = new Map(raws.map(raw => [raw, hasModernProtection(raw)]));
  if (!secret && [...modernHints.values()].some(Boolean)) {
    fail('AES-GCM data exists without a usable versioned key');
  }
  run.phase = 'classify';
  const unsupported = raws.some(unsupportedBranchFormat);
  const legacyCandidates: string[] = [];
  if (raws.some(raw => !modernHints.get(raw) && hasLegacyProtection(raw))) {
    if (legacy && legacy.password) {
      legacyCandidates.push(legacy.password);
    }
    const deviceKey = getUniqueId(); // Read-only, only for released CBC snapshots.
    if (!legacyCandidates.includes(deviceKey)) {
      legacyCandidates.push(deviceKey);
    }
  }
  let observedModern = false;
  const classify = (raw: string | null) =>
    inspect(
      raw,
      modernHints.get(raw) ? (secret ? [secret] : []) : legacyCandidates,
      () => {
        observedModern = true;
      },
    );
  const root = classify(rootRaw);
  const files: FileCopy[] = rawFiles.map(file => {
    const target = classify(file.target);
    const temp = classify(file.temp);
    return {
      path: file.path,
      target,
      temp,
      effective:
        !target.snapshot && temp.snapshot?.format === 'gcm' ? temp : target,
    };
  });
  let fromAsync =
    rootRaw === null &&
    !files.some(file => file.effective.parseable) &&
    asyncRaw !== null;
  const asyncCopy = classify(asyncRaw);
  classify(backupTemp);
  if (!secret && observedModern) {
    fail('AES-GCM data exists without a usable versioned key');
  }
  if (unsupported) throw vaultError('UNSUPPORTED_FORMAT', 'classify');
  if (rootRaw !== null && !root.snapshot) {
    fail('invalid primary snapshot');
  }
  let hasValidPredecessor = !!root.snapshot;
  for (const file of files) {
    if (
      file.effective.parseable &&
      !file.effective.snapshot &&
      !hasValidPredecessor
    ) {
      fail('damaged filesystem restore source');
    }
    hasValidPredecessor ||= !!file.effective.snapshot;
  }
  if (fromAsync && !asyncCopy?.snapshot) {
    fail('invalid AsyncStorage migration source');
  }
  const markedMainRefresh = (file: FileCopy) =>
    file.path === VAULT_BACKUP &&
    record?.refresh?.path === 'main' &&
    !!file.temp.snapshot &&
    record.refresh.digest === digest(file.temp.snapshot.raw);
  const duplicatedTemp = (file: FileCopy) =>
    !!file.temp.snapshot &&
    ((!!root.snapshot &&
      isEqual(
        backupPayload(root.snapshot.payload),
        file.temp.snapshot.payload,
      )) ||
      files.some(
        other =>
          !!other.target.snapshot &&
          isEqual(other.target.snapshot.payload, file.temp.snapshot!.payload),
      ));
  const optionalTemp = (file: FileCopy) =>
    root.snapshot?.format === 'gcm' &&
    (duplicatedTemp(file) ||
      (markedMainRefresh(file) &&
        !!file.temp.snapshot &&
        preservesProtected(root.snapshot.payload, file.temp.snapshot.payload)));
  // A valid target does not make a distinct, independently required temp
  // disposable. Resolve this before any write; known optional refresh temps
  // have separate provenance and never replace a newer authoritative primary.
  for (const file of files) {
    if (
      file.target.snapshot &&
      file.temp.snapshot &&
      !duplicatedTemp(file) &&
      !optionalTemp(file)
    )
      throw vaultError('SOURCE_CONFLICT', 'classify');
  }

  const selected =
    root.snapshot ??
    files.find(file => file.effective.snapshot)?.effective.snapshot;
  if (asyncRaw !== null && selected) {
    const active = protectedProjection(selected.payload);
    if (!asyncCopy.snapshot) {
      // A first-launch/empty active state does not turn the only potential
      // imported protected data into disposable garbage merely by existing.
      if (active.fields.size === 0)
        fail('invalid AsyncStorage migration source');
    } else {
      const incoming = protectedProjection(asyncCopy.snapshot.payload);
      if (!projectionCovers(active, incoming)) {
        const pendingEmpty =
          active.fields.size === 0 &&
          selected.payload.APP?.migrationMMKVStorageComplete !== true;
        if (pendingEmpty && projectionCovers(incoming, active))
          fromAsync = true;
        else throw vaultError('SOURCE_CONFLICT', 'classify');
      }
    }
  }

  // All stop conditions above are read-only, including lost-key cases.
  run.phase = 'key';
  if (wrongBackend) {
    await removeKeyAndVerify(VAULT_KEY_SERVICE);
  }
  try {
    secret ??= await createVaultKey();
  } catch (error) {
    throw safeVaultError(error, 'NEW_KEY_VERIFICATION', 'key');
  }
  if (!record) {
    record = {
      status: 'started',
      wipeDone: false,
      ...(Platform.OS === 'android' &&
      !legacy &&
      !legacyUnreadable &&
      raws.every(raw => raw === null)
        ? {initializing: true as const}
        : {}),
    };
    writeRecord(record);
    initializationPending = record.initializing === true;
  }
  const vaultKey = secret;
  let deferred = false;
  const reported = new Set<string>();
  const defer = (code: VaultCode, at: VaultPhase) => {
    deferred = true;
    const message = vaultDeferredMessage(code, at);
    if (!reported.has(message)) {
      reported.add(message);
      log(message);
    }
  };
  if (legacyUnreadable) log('Vault migration: LEGACY_KEY_UNREADABLE (key)');
  let verifiedLive = root.snapshot;
  let primaryChanged = false;
  const checkPrimary = () => {
    try {
      const raw = readRegistered(storage).get(ROOT);
      if (raw === verifiedLive?.raw) return;
      if (raw === undefined) throw new Error();
      const current = decode(raw, vaultKey);
      if (current.format !== 'gcm') throw new Error();
      verifiedLive = current;
    } catch {
      throw vaultError('PRESERVATION_FAILURE', run.phase);
    }
    primaryChanged = true;
    defer('SCRUB_STATE_CHANGED', 'scrub');
  };
  const rethrowPreservation = (error: unknown) => {
    if (vaultDiagnostic(error as Error)?.code === 'PRESERVATION_FAILURE')
      throw error;
    checkPrimary();
  };
  checkPrimary();
  const optionalRefresh = async (
    path: string,
    raw: string,
    payload: Payload,
  ) => {
    checkPrimary();
    record = {
      ...record!,
      refresh: {
        path: path === VAULT_BACKUP ? 'main' : 'bak',
        digest: digest(raw),
      },
    };
    writeRecord(record);
    await replaceVaultFile(
      path,
      raw,
      value => verify(value, vaultKey, payload),
      checkPrimary,
    );
    checkPrimary();
    record = {...record};
    delete record.refresh;
    writeRecord(record);
  };
  const deferDeletion = async (operation: () => Promise<void>) => {
    checkPrimary();
    try {
      await operation();
    } catch (error) {
      rethrowPreservation(error);
      defer('CLEANUP_DEFERRED', 'cleanup');
    } finally {
      checkPrimary();
    }
  };

  run.phase = 'required-copy';
  let refreshBlocked = false;
  // Finish interrupted replacements only after all reads and source validation.
  for (const file of files) {
    if (file.effective === file.temp && file.temp.snapshot) {
      // A temp from our optional main refresh is resumable optional work when
      // an independently verified modern primary still exists. The digest binds
      // provenance to the exact temp, not merely its path. Unmarked distinct
      // temps and sole recovery sources keep strict promotion semantics.
      const optional = optionalTemp(file);
      try {
        await promoteVaultFile(
          file.path,
          raw => verify(raw, vaultKey, file.temp.snapshot!.payload),
          checkPrimary,
        );
      } catch (error) {
        rethrowPreservation(error);
        if (!optional) throw error;
        refreshBlocked = true;
        defer('OPTIONAL_REFRESH_DEFERRED', 'refresh');
      }
    } else if (file.temp.raw !== null) {
      await deferDeletion(() =>
        removeVaultFile(migrationTemp(file.path), checkPrimary),
      );
    }
    const snapshot = file.effective.snapshot;
    if (snapshot?.format === 'cbc') {
      await replaceVaultFile(
        file.path,
        encode(snapshot.payload, vaultKey),
        raw => verify(raw, vaultKey, snapshot.payload),
        checkPrimary,
      );
    }
  }
  run.phase = 'root-write';
  checkPrimary();
  if (primaryChanged) return vaultKey; // Never overwrite a valid concurrent save.
  const source = fromAsync ? asyncCopy.snapshot : root.snapshot;
  if (source && (source.format === 'cbc' || rootRaw === null || fromAsync)) {
    const raw = encode(source.payload, vaultKey);
    storage.set(ROOT, raw);
    verify(storage.getString(ROOT) ?? null, vaultKey, source.payload);
    verifiedLive = {raw, payload: source.payload, format: 'gcm'};
  }

  run.phase = 'refresh';
  if (!record.wipeDone) {
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
        const final = inspect(await readVaultFile(VAULT_BACKUP, checkPrimary), [
          vaultKey,
        ]);
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
              key => !REGISTERED_KEYS.includes(key) && key !== VAULT_SCRUB_KEY,
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
              record = {...record, wipeDone: true};
              writeRecord(record);
            }
          }
        }
      }
    }
  }

  run.phase = 'cleanup';
  checkPrimary();
  await deferDeletion(() => removeVaultFile(VAULT_BACKUP_TEMP, checkPrimary));
  for (const path of [VAULT_BACKUP, VAULT_OLDER_BACKUP]) {
    // Inspect CURRENT contents: pre-wipe rotation can replace a damaged .bak.
    const current = inspect(await readVaultFile(path, checkPrimary), [
      vaultKey,
    ]);
    if (current.raw !== null && !current.snapshot) {
      await deferDeletion(() => removeVaultFile(path, checkPrimary));
    }
    // A failed refresh may have left a verified temp needed on restart. Never
    // delete it if its target is absent/invalid; the resume rule owns that pair.
    const temp = inspect(
      await readVaultFile(migrationTemp(path), checkPrimary),
      [vaultKey],
    );
    if (temp.raw !== null && (current.snapshot || !temp.snapshot)) {
      await deferDeletion(() =>
        removeVaultFile(migrationTemp(path), checkPrimary),
      );
    } else if (temp.raw !== null) {
      deferred = true;
    }
  }
  let latestAsync: string | null;
  try {
    latestAsync = await AsyncStorage.getItem(ROOT);
  } finally {
    checkPrimary();
  }
  if (latestAsync !== null && latestAsync !== asyncRaw)
    throw vaultError('SOURCE_CONFLICT', 'cleanup');
  if (latestAsync !== null) {
    // A usable concurrent primary change may have deferred the scrub. Do not
    // delete AsyncStorage based on the now-stale pre-mutation comparison.
    const liveRaw = storage.getString(ROOT);
    let active: Snapshot | undefined;
    if (liveRaw !== undefined)
      active =
        liveRaw === verifiedLive?.raw
          ? verifiedLive
          : decode(liveRaw, vaultKey);
    else {
      for (const path of [VAULT_BACKUP, VAULT_OLDER_BACKUP]) {
        const raw = await readVaultFile(path, checkPrimary);
        if (raw !== null) {
          active = decode(raw, vaultKey);
          break;
        }
      }
    }
    if (!active || active.format !== 'gcm')
      throw vaultError('PRESERVATION_FAILURE', 'cleanup');
    if (
      asyncCopy.snapshot &&
      !preservesProtected(active.payload, asyncCopy.snapshot.payload)
    )
      throw vaultError('SOURCE_CONFLICT', 'cleanup');
  }
  await deferDeletion(async () => {
    if (asyncRaw !== null) {
      await AsyncStorage.removeItem(ROOT);
      checkPrimary();
    }
    if ((await AsyncStorage.getItem(ROOT)) !== null) {
      fail('AsyncStorage copy remains');
    }
  });
  checkPrimary();
  if (deferred || !record.wipeDone) {
    return vaultKey;
  }
  if (legacy || legacyUnreadable) {
    await deferDeletion(() => removeKeyAndVerify(LEGACY_KEY_SERVICE));
  }
  checkPrimary();
  if (!deferred) {
    writeRecord({...record, status: 'complete', wipeDone: true});
    log('Vault migration complete');
  }
  return vaultKey;
};

export const migrateVault = (
  storage: MMKV,
  log: (message: string) => void = () => {},
): Promise<string> => {
  if (!inFlight) {
    const run: {phase: VaultPhase} = {phase: 'key'};
    inFlight = migrate(storage, log, run)
      .catch(error => {
        const {phase} = run;
        const code: VaultCode =
          phase === 'key'
            ? 'MODERN_KEY_FAILURE'
            : phase === 'root-write' || phase === 'scrub'
            ? 'PRESERVATION_FAILURE'
            : phase === 'classify'
            ? 'INVALID_LEGACY_INPUT'
            : 'REQUIRED_COPY_FAILURE';
        throw safeVaultError(error, code, phase);
      })
      .finally(() => {
        inFlight = undefined;
      });
  }
  return inFlight;
};
