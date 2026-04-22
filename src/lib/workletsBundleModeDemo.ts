import {
  createSynchronizable,
  createWorkletRuntime,
  runOnRuntimeAsync,
  scheduleOnRN,
  type Synchronizable,
  type WorkletRuntime,
} from 'react-native-worklets';
import {MMKV, type NativeMMKV} from 'react-native-mmkv';
import {
  NitroFetch as NitroFetchSingleton,
  NitroRequest as NitroFetchRequest,
  NitroResponse as NitroFetchResponse,
} from 'react-native-nitro-fetch';
import {Buffer as NodeBuffer} from 'buffer';
import processPolyfill from 'process';
import {BASE_BWS_URL} from '../constants/config';
import {storage as appSharedMmkvStorage} from '../store';

export type WorkletsTxHistoryWalletSnapshot = {
  walletId: string;
  walletName?: string;
  keyName?: string;
  chain?: string;
  coin?: string;
  network?: string;
  copayerId: string;
  requestPrivKey: string;
  requestPubKey?: string;
  tokenAddress?: string;
  multisigContractAddress?: string;
};

export type WorkerTxHistoryWalletSummary = {
  walletId: string;
  walletName?: string;
  keyName?: string;
  chain?: string;
  coin?: string;
  network?: string;
  tokenAddress?: string;
  multisigContractAddress?: string;
  isTokenWallet: boolean;
  isMultisigContractWallet: boolean;
};

export type WorkerTxHistoryPreviewItem = {
  txid?: string;
  action?: string;
  amount?: number | string;
  fees?: number | string;
  time?: number;
  confirmations?: number;
  addressTo?: string;
};

export type WorkerTxHistorySessionSummary = {
  workerRuntimeName: string;
  initializedAtIso: string;
  requestSequence: number;
  wallet: WorkerTxHistoryWalletSummary;
};

export type WorkerTxHistoryPageResult = {
  pageIndex: number;
  skip: number;
  limit: number;
  requestPath: string;
  status: number;
  fetchedAtIso: string;
  durationMs: number;
  signaturePreview: string;
  txCount: number;
  transactionsPreview: WorkerTxHistoryPreviewItem[];
};

export type WorkerTxHistoryBatchResult = {
  workerRuntimeName: string;
  fetchedAtIso: string;
  totalDurationMs: number;
  requestedPageCount: number;
  executedPageCount: number;
  pageSize: number;
  initialSkip: number;
  totalTransactionsAcrossPages: number;
  stoppedEarly: boolean;
  stopReason: 'empty_page' | 'short_page' | 'max_pages_reached';
  session: WorkerTxHistorySessionSummary;
  pages: WorkerTxHistoryPageResult[];
};

export type WorkerMmkvRoundTripResult = {
  workerRuntimeName: string;
  storageId: string;
  key: string;
  startedAtIso: string;
  completedAtIso: string;
  durationMs: number;
  valueWritten: string;
  valueReadOnWorker?: string;
  workerReadMatchesWrite: boolean;
  workerContainsKeyAfterWrite: boolean;
  valueReadOnRN?: string;
  rnReadMatchesWrite: boolean;
  rnContainsKeyAfterWorkerWrite: boolean;
  cleanupRemovedKeyOnRN: boolean;
};

export type WorkerMmkvStressTestResult = {
  workerRuntimeName: string;
  storageId: string;
  iterationCount: number;
  startedAtIso: string;
  completedAtIso: string;
  workerDurationMs: number;
  totalDurationMs: number;
  workerWriteReadMatches: number;
  workerContainsChecksPassed: number;
  rnReadMatches: number;
  rnContainsChecksPassed: number;
  cleanupRemovedKeyCount: number;
  cleanupFullySucceeded: boolean;
  firstKey: string;
  lastKey: string;
  firstValueWritten: string;
  lastValueWritten: string;
};

export type WorkerMmkvContentionTestResult = {
  workerRuntimeName: string;
  storageId: string;
  key: string;
  iterationCountPerRuntime: number;
  startedAtIso: string;
  completedAtIso: string;
  rnDurationMs: number;
  workerDurationMs: number;
  totalDurationMs: number;
  rnImmediateSelfReadMatches: number;
  workerImmediateSelfReadMatches: number;
  rnStaleOwnReadCount: number;
  workerStaleOwnReadCount: number;
  rnObservedWorkerWrites: number;
  workerObservedRnWrites: number;
  rnUnexpectedValueCount: number;
  workerUnexpectedValueCount: number;
  rnContainsChecksPassed: number;
  workerContainsChecksPassed: number;
  finalValuePreview?: string;
  finalValueWriter?: 'rn' | 'worker';
  finalValueIteration?: number;
  cleanupRemovedKeyOnRN: boolean;
};

export type WorkerNitroFetchSmokeResult = {
  workerRuntimeName: string;
  requestedUrl: string;
  responseUrl: string;
  startedAtIso: string;
  completedAtIso: string;
  durationMs: number;
  status: number;
  statusText: string;
  ok: boolean;
  redirected: boolean;
  responseHeadersCount: number;
  responseHeaderPreview: string[];
  bodyLength: number;
  bodyPreview: string;
  quoteCurrency: string;
  rateCoin: string;
  returnedCoinKeys: string[];
  parsedPointCount: number;
  firstPointTs?: number;
  firstPointRate?: number;
  latestPointTs?: number;
  latestPointRate?: number;
};

type TxHistoryRequestWalletContext = Pick<
  WorkletsTxHistoryWalletSnapshot,
  'tokenAddress' | 'multisigContractAddress'
>;

type WorkerTxHistoryRequestKeyDetails = {
  requestPubKey?: string;
  derivedRequestPubKey: string;
  requestPubKeyMatchesDerived?: boolean;
};

type WorkerTxHistorySession = {
  wallet: WorkletsTxHistoryWalletSnapshot;
  requestKey: WorkerTxHistoryRequestKeyDetails;
  baseBwsUrl: string;
  clientVersionHeader: string;
  workerRuntimeName: string;
  initializedAtIso: string;
  initializedAtMs: number;
  requestSequence: number;
};

type BoxedHybridObjectLike<T> = {
  unbox(): T;
};

type NitroModulesLike = {
  createHybridObject<T = unknown>(name: string): T;
  box?<T = unknown>(obj: T): BoxedHybridObjectLike<T>;
};

type QuickCryptoHashHybrid = {
  createHash(algorithm: string, outputLength?: number): void;
  update(data: ArrayBuffer | string): void;
  digest(encoding?: string): ArrayBuffer;
};

type QuickCryptoKeyObjectHybrid = {
  init(
    keyType: number,
    key: string | ArrayBuffer,
    format?: number,
    type?: number,
    passphrase?: ArrayBuffer,
  ): boolean;
};

type QuickCryptoSignHybrid = {
  init(algorithm: string): void;
  update(data: ArrayBuffer): void;
  sign(
    keyHandle: QuickCryptoKeyObjectHybrid,
    padding?: number,
    saltLength?: number,
    dsaEncoding?: number,
  ): ArrayBuffer;
};

type QuickCryptoEnums = {
  KeyType: {
    PRIVATE: number;
  };
  KFormatType: {
    DER: number;
  };
  KeyEncoding: {
    SEC1: number;
  };
};

type NitroFetchClientHybrid = {
  request(req: NitroFetchRequest): Promise<NitroFetchResponse>;
  requestSync(req: NitroFetchRequest): NitroFetchResponse;
};

type NitroFetchHybrid = {
  createClient(): NitroFetchClientHybrid;
};

type TransferredNitroBwsSigningBatchHybrids = {
  firstHash: QuickCryptoHashHybrid;
  signHandles: QuickCryptoSignHybrid[];
  privateKeyHandle: QuickCryptoKeyObjectHybrid;
};

type WorkerMmkvStorageBridge = Pick<
  NativeMMKV,
  'contains' | 'delete' | 'getString' | 'set'
>;

type WorkerMmkvStressTestEntry = {
  iteration: number;
  key: string;
  value: string;
};

type MmkvContentionActor = 'rn' | 'worker';

type WorkerMmkvContentionReadSummary = {
  writer: MmkvContentionActor;
  iteration: number;
};

type WorkerMmkvContentionLoopResult = {
  durationMs: number;
  immediateSelfReadMatches: number;
  staleOwnReadCount: number;
  observedOtherWrites: number;
  unexpectedValueCount: number;
  containsChecksPassed: number;
};

type MmkvContentionBarrierPhase =
  | 'ready_to_write'
  | 'write_completed'
  | 'read_completed';

type WorkerMmkvContentionBarrierState = {
  rnReadyToWriteIteration: number;
  workerReadyToWriteIteration: number;
  rnWriteCompletedIteration: number;
  workerWriteCompletedIteration: number;
  rnReadCompletedIteration: number;
  workerReadCompletedIteration: number;
};

const WORKER_RUNTIME_NAME = 'bitpay-txhistory-worker';
const BWC_CLIENT_VERSION_HEADER = 'bwc-11.7.0';
const DEFAULT_TXHISTORY_LIMIT = 10;
const DEFAULT_TXHISTORY_PAGE_COUNT = 3;
const DEFAULT_WORKER_MMKV_CONTENTION_ITERATION_COUNT = 250;
const DEFAULT_WORKER_MMKV_CONTENTION_WAIT_TIMEOUT_MS = 5000;
const DEFAULT_WORKER_MMKV_STRESS_TEST_ITERATION_COUNT = 250;
const APP_SHARED_MMKV_STORAGE_LABEL = 'app-shared-store-mmkv';
const WORKER_TXHISTORY_SESSION_KEY = '__bitpayTxHistoryWorkerSession';
const WORKER_MMKV_STORAGE_ID = 'bitpay.worklets.bundle.mode.demo';
const WORKER_MMKV_SHARED_APP_KEY_PREFIX = 'worklets-mmkv-shared-app-roundtrip';
const WORKER_MMKV_CONTENTION_KEY_PREFIX = 'worklets-mmkv-contention';
const WORKER_MMKV_KEY_PREFIX = 'worklets-mmkv-roundtrip';
const WORKER_MMKV_STRESS_KEY_PREFIX = 'worklets-mmkv-stress';
const TXHISTORY_BASE_PATH = '/v1/txhistory/';
const DEFAULT_NITRO_FETCH_TIMEOUT_MS = 15000;
const SECP256K1_CURVE_ORDER_HEX =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141';
const SECP256K1_CURVE_HALF_ORDER_HEX =
  '7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0';
const NITRO_FETCH_SMOKE_TEST_QUOTE_CURRENCY = 'USD';
const NITRO_FETCH_SMOKE_TEST_RATE_COIN = 'btc';
const NITRO_FETCH_SMOKE_TEST_URL = `${BASE_BWS_URL}/v4/fiatrates/${NITRO_FETCH_SMOKE_TEST_QUOTE_CURRENCY}?days=1&coin=${NITRO_FETCH_SMOKE_TEST_RATE_COIN}`;

let workletsBundleModeRuntime: WorkletRuntime | undefined;
let workletsBundleModeDemoStorage: MMKV | undefined;

const normalizePositiveInt = (value: number | undefined, fallback: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  const normalized = Math.max(0, Math.floor(value));
  return normalized > 0 ? normalized : fallback;
};

const toRuntimeError = (err: unknown) => {
  if (err instanceof Error) {
    return err;
  }

  try {
    return new Error(JSON.stringify(err));
  } catch {
    return new Error(String(err));
  }
};

const toWorkerErrorMessage = (err: unknown) => {
  'worklet';

  if (err instanceof Error) {
    return err.message;
  }

  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
};

const getWorkletsBundleModeDemoStorageOnRN = () => {
  if (!workletsBundleModeDemoStorage) {
    workletsBundleModeDemoStorage = new MMKV({
      id: WORKER_MMKV_STORAGE_ID,
    });
  }

  return workletsBundleModeDemoStorage;
};

const getNativeStorageBridgeOnRN = (
  storageInstance: MMKV,
  storageLabel: string,
): WorkerMmkvStorageBridge => {
  const nativeStorage = (
    storageInstance as unknown as {
      nativeInstance?: WorkerMmkvStorageBridge;
    }
  ).nativeInstance;

  if (
    !nativeStorage ||
    typeof nativeStorage.set !== 'function' ||
    typeof nativeStorage.getString !== 'function' ||
    typeof nativeStorage.contains !== 'function' ||
    typeof nativeStorage.delete !== 'function'
  ) {
    throw new Error(
      `${storageLabel} react-native-mmkv nativeInstance is unavailable on the RN runtime.`,
    );
  }

  return nativeStorage;
};

const getWorkletsBundleModeDemoNativeStorageOnRN =
  (): WorkerMmkvStorageBridge => {
    return getNativeStorageBridgeOnRN(
      getWorkletsBundleModeDemoStorageOnRN(),
      'Demo MMKV storage',
    );
  };

const getAppSharedNativeStorageOnRN = (): WorkerMmkvStorageBridge => {
  return getNativeStorageBridgeOnRN(
    appSharedMmkvStorage,
    'App shared MMKV storage',
  );
};

const buildWorkerMmkvKey = (prefix: string, iteration?: number) => {
  const parts = [
    prefix,
    String(Date.now()),
    Math.random().toString(36).slice(2, 10),
  ];

  if (typeof iteration === 'number') {
    parts.push(String(iteration));
  }

  return parts.join(':');
};

const buildWorkerMmkvStressTestEntries = (
  iterationCount: number,
): WorkerMmkvStressTestEntry[] => {
  return Array.from({length: iterationCount}, (_, iteration) => {
    const key = buildWorkerMmkvKey(WORKER_MMKV_STRESS_KEY_PREFIX, iteration);
    const value = JSON.stringify({
      key,
      probe: 'worker_mmkv_stress',
      iteration,
      createdAtIso: new Date().toISOString(),
    });

    return {
      iteration,
      key,
      value,
    };
  });
};

function createWorkerMmkvContentionBarrierState(): WorkerMmkvContentionBarrierState {
  return {
    rnReadyToWriteIteration: -1,
    workerReadyToWriteIteration: -1,
    rnWriteCompletedIteration: -1,
    workerWriteCompletedIteration: -1,
    rnReadCompletedIteration: -1,
    workerReadCompletedIteration: -1,
  };
}

function buildWorkerMmkvContentionValue(
  writer: MmkvContentionActor,
  key: string,
  iteration: number,
) {
  'worklet';

  return JSON.stringify({
    key,
    probe: 'worker_mmkv_contention',
    writer,
    iteration,
    writtenAtIso: new Date().toISOString(),
  });
}

function summarizeWorkerMmkvContentionRead(
  key: string,
  rawValue: string | undefined,
): WorkerMmkvContentionReadSummary | null {
  'worklet';

  let parsedValue: unknown;
  try {
    parsedValue = rawValue ? JSON.parse(rawValue) : null;
  } catch {
    parsedValue = rawValue;
  }

  if (!parsedValue || typeof parsedValue !== 'object') {
    return null;
  }

  const probe = (parsedValue as any)?.probe;
  const parsedKey = (parsedValue as any)?.key;
  const writer = (parsedValue as any)?.writer;
  const iteration = (parsedValue as any)?.iteration;

  if (
    probe !== 'worker_mmkv_contention' ||
    parsedKey !== key ||
    (writer !== 'rn' && writer !== 'worker') ||
    typeof iteration !== 'number'
  ) {
    return null;
  }

  return {
    writer,
    iteration,
  };
}

function summarizeWorkerMmkvContentionValuePreview(
  value: string | undefined,
  maxLength = 140,
) {
  if (!value) {
    return undefined;
  }

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}...`;
}

function getWorkerMmkvContentionBarrierIteration(
  state: WorkerMmkvContentionBarrierState,
  actor: MmkvContentionActor,
  phase: MmkvContentionBarrierPhase,
) {
  'worklet';

  if (actor === 'rn') {
    switch (phase) {
      case 'ready_to_write':
        return state.rnReadyToWriteIteration;
      case 'write_completed':
        return state.rnWriteCompletedIteration;
      case 'read_completed':
        return state.rnReadCompletedIteration;
    }
  }

  switch (phase) {
    case 'ready_to_write':
      return state.workerReadyToWriteIteration;
    case 'write_completed':
      return state.workerWriteCompletedIteration;
    case 'read_completed':
      return state.workerReadCompletedIteration;
  }
}

function setWorkerMmkvContentionBarrierIteration(
  barrier: Synchronizable<WorkerMmkvContentionBarrierState>,
  actor: MmkvContentionActor,
  phase: MmkvContentionBarrierPhase,
  iteration: number,
) {
  'worklet';

  barrier.setBlocking(prev => {
    if (actor === 'rn') {
      switch (phase) {
        case 'ready_to_write':
          return {
            ...prev,
            rnReadyToWriteIteration: iteration,
          };
        case 'write_completed':
          return {
            ...prev,
            rnWriteCompletedIteration: iteration,
          };
        case 'read_completed':
          return {
            ...prev,
            rnReadCompletedIteration: iteration,
          };
      }
    }

    switch (phase) {
      case 'ready_to_write':
        return {
          ...prev,
          workerReadyToWriteIteration: iteration,
        };
      case 'write_completed':
        return {
          ...prev,
          workerWriteCompletedIteration: iteration,
        };
      case 'read_completed':
        return {
          ...prev,
          workerReadCompletedIteration: iteration,
        };
    }
  });
}

function waitForWorkerMmkvContentionBarrierIteration(
  barrier: Synchronizable<WorkerMmkvContentionBarrierState>,
  actor: MmkvContentionActor,
  phase: MmkvContentionBarrierPhase,
  iteration: number,
) {
  'worklet';

  const startedAtMs = Date.now();

  while (true) {
    const state = barrier.getBlocking();
    if (
      getWorkerMmkvContentionBarrierIteration(state, actor, phase) >= iteration
    ) {
      return;
    }

    if (
      Date.now() - startedAtMs >=
      DEFAULT_WORKER_MMKV_CONTENTION_WAIT_TIMEOUT_MS
    ) {
      throw new Error(
        `Timed out waiting for ${actor} ${phase} iteration ${iteration}. Last barrier state: ${JSON.stringify(
          state,
        )}`,
      );
    }
  }
}

function executeWorkerMmkvContentionLoop(
  actor: MmkvContentionActor,
  key: string,
  iterationCount: number,
  storageBridge: WorkerMmkvStorageBridge,
  barrier: Synchronizable<WorkerMmkvContentionBarrierState>,
): WorkerMmkvContentionLoopResult {
  'worklet';

  const startedAtMs = Date.now();
  const otherActor: MmkvContentionActor = actor === 'rn' ? 'worker' : 'rn';
  let immediateSelfReadMatches = 0;
  let staleOwnReadCount = 0;
  let observedOtherWrites = 0;
  let unexpectedValueCount = 0;
  let containsChecksPassed = 0;

  for (let iteration = 0; iteration < iterationCount; iteration += 1) {
    setWorkerMmkvContentionBarrierIteration(
      barrier,
      actor,
      'ready_to_write',
      iteration,
    );
    waitForWorkerMmkvContentionBarrierIteration(
      barrier,
      otherActor,
      'ready_to_write',
      iteration,
    );

    const nextValue = buildWorkerMmkvContentionValue(actor, key, iteration);
    storageBridge.set(key, nextValue);

    setWorkerMmkvContentionBarrierIteration(
      barrier,
      actor,
      'write_completed',
      iteration,
    );
    waitForWorkerMmkvContentionBarrierIteration(
      barrier,
      otherActor,
      'write_completed',
      iteration,
    );

    const immediateRead = storageBridge.getString(key);
    if (immediateRead === nextValue) {
      immediateSelfReadMatches += 1;
    } else {
      const summarizedRead = summarizeWorkerMmkvContentionRead(
        key,
        immediateRead,
      );

      if (!summarizedRead) {
        unexpectedValueCount += 1;
      } else if (summarizedRead.writer === actor) {
        staleOwnReadCount += 1;
      } else {
        observedOtherWrites += 1;
      }
    }

    if (storageBridge.contains(key)) {
      containsChecksPassed += 1;
    }

    setWorkerMmkvContentionBarrierIteration(
      barrier,
      actor,
      'read_completed',
      iteration,
    );
    waitForWorkerMmkvContentionBarrierIteration(
      barrier,
      otherActor,
      'read_completed',
      iteration,
    );
  }

  return {
    durationMs: Date.now() - startedAtMs,
    immediateSelfReadMatches,
    staleOwnReadCount,
    observedOtherWrites,
    unexpectedValueCount,
    containsChecksPassed,
  };
}

const toHexPreview = (value: string | undefined, visible = 12) => {
  'worklet';

  if (!value) {
    return undefined;
  }

  if (value.length <= visible * 2 + 1) {
    return value;
  }

  return `${value.slice(0, visible)}...${value.slice(-visible)}`;
};

const walletSnapshotsMatch = (
  left: WorkletsTxHistoryWalletSnapshot | undefined,
  right: WorkletsTxHistoryWalletSnapshot,
) => {
  'worklet';

  if (!left) {
    return false;
  }

  return (
    left.walletId === right.walletId &&
    left.copayerId === right.copayerId &&
    left.requestPrivKey === right.requestPrivKey &&
    left.requestPubKey === right.requestPubKey &&
    (left.tokenAddress || '') === (right.tokenAddress || '') &&
    (left.multisigContractAddress || '') ===
      (right.multisigContractAddress || '')
  );
};

const ensureSigningGlobalsForWorker = () => {
  'worklet';

  const globalRef = globalThis as any;

  if (!globalRef.global) {
    globalRef.global = globalRef;
  }
  if (!globalRef.self) {
    globalRef.self = globalRef;
  }
  if (!globalRef.window) {
    globalRef.window = globalRef;
  }
  if (
    !globalRef.Buffer &&
    typeof (NodeBuffer as {from?: unknown})?.from === 'function'
  ) {
    globalRef.Buffer = NodeBuffer;
  }
  if (!globalRef.process) {
    globalRef.process = processPolyfill;
  }

  const processRef = globalRef.process as typeof processPolyfill;
  if (typeof processRef.browser === 'undefined') {
    processRef.browser = true;
  }
};

const getBitcoreLibForRN = () => {
  const importedBitcoreLib = require('@bitpay-labs/bitcore-lib') as any;
  return importedBitcoreLib?.default || importedBitcoreLib;
};

const getNitroModulesForRN = (): NitroModulesLike => {
  const importedNitroModules = require('react-native-nitro-modules') as any;
  const nitroModules =
    importedNitroModules?.NitroModules ||
    importedNitroModules?.default?.NitroModules;

  if (typeof nitroModules?.createHybridObject !== 'function') {
    throw new Error(
      'react-native-nitro-modules.NitroModules.createHybridObject() is unavailable on the RN runtime.',
    );
  }

  return nitroModules as NitroModulesLike;
};

const createQuickCryptoHashHybridOnRN = (): QuickCryptoHashHybrid => {
  return getNitroModulesForRN().createHybridObject<QuickCryptoHashHybrid>(
    'Hash',
  );
};

const createQuickCryptoKeyObjectHybridOnRN = (): QuickCryptoKeyObjectHybrid => {
  return getNitroModulesForRN().createHybridObject<QuickCryptoKeyObjectHybrid>(
    'KeyObjectHandle',
  );
};

const createQuickCryptoSignHybridOnRN = (): QuickCryptoSignHybrid => {
  return getNitroModulesForRN().createHybridObject<QuickCryptoSignHybrid>(
    'SignHandle',
  );
};

const createBoxedNitroFetchHybridOnRN =
  (): BoxedHybridObjectLike<NitroFetchHybrid> => {
    const nitroModules = getNitroModulesForRN();

    if (typeof nitroModules.box !== 'function') {
      throw new Error(
        'react-native-nitro-modules.NitroModules.box() is unavailable on the RN runtime.',
      );
    }

    return nitroModules.box(NitroFetchSingleton as NitroFetchHybrid);
  };

const getQuickCryptoEnumsForRN = (): QuickCryptoEnums => {
  const quickCrypto = require('react-native-quick-crypto') as any;

  if (
    typeof quickCrypto?.KeyType?.PRIVATE !== 'number' ||
    typeof quickCrypto?.KFormatType?.DER !== 'number' ||
    typeof quickCrypto?.KeyEncoding?.SEC1 !== 'number'
  ) {
    throw new Error(
      'react-native-quick-crypto key import enums are unavailable on the RN runtime.',
    );
  }

  return quickCrypto as QuickCryptoEnums;
};

const nodeBufferToArrayBuffer = (buffer: Buffer): ArrayBuffer => {
  'worklet';

  const view = Uint8Array.from(buffer);
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
};

const bytesToHex = (bytes: ArrayLike<number>): string => {
  'worklet';

  let hex = '';

  for (let index = 0; index < bytes.length; index += 1) {
    hex += Number(bytes[index]).toString(16).padStart(2, '0');
  }

  return hex;
};

const hexToBytes = (hex: string): Uint8Array => {
  'worklet';

  const normalizedHex = hex.length % 2 === 0 ? hex : `0${hex}`;
  const bytes = new Uint8Array(normalizedHex.length / 2);

  for (let index = 0; index < normalizedHex.length; index += 2) {
    const byteHex = normalizedHex.slice(index, index + 2);
    bytes[index / 2] = Number.parseInt(byteHex, 16);
  }

  return bytes;
};

const concatBytes = (...parts: Uint8Array[]): Uint8Array => {
  'worklet';

  let totalLength = 0;
  for (const part of parts) {
    totalLength += part.length;
  }

  const result = new Uint8Array(totalLength);
  let offset = 0;

  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
};

const buildSecp256k1Sec1PrivateKeyDer = (privateKeyBytes: Buffer): Buffer => {
  if (privateKeyBytes.length !== 32) {
    throw new Error(
      `Expected a 32-byte secp256k1 private key, received ${privateKeyBytes.length} bytes.`,
    );
  }

  return NodeBuffer.concat([
    NodeBuffer.from([0x30, 0x2e, 0x02, 0x01, 0x01, 0x04, 0x20]),
    privateKeyBytes,
    NodeBuffer.from([0xa0, 0x07, 0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x0a]),
  ]);
};

const getWorkerRequestKeyDetailsOnRN = (
  wallet: WorkletsTxHistoryWalletSnapshot,
): WorkerTxHistoryRequestKeyDetails => {
  const bitcoreLib = getBitcoreLibForRN();

  if (!bitcoreLib?.PrivateKey) {
    throw new Error(
      '@bitpay-labs/bitcore-lib is unavailable on the RN runtime.',
    );
  }

  const privateKey = new bitcoreLib.PrivateKey(wallet.requestPrivKey);
  const derivedRequestPubKey = privateKey.toPublicKey().toString();
  const requestPubKey =
    typeof wallet.requestPubKey === 'string' ? wallet.requestPubKey : undefined;

  return {
    requestPubKey,
    derivedRequestPubKey,
    requestPubKeyMatchesDerived: requestPubKey
      ? requestPubKey === derivedRequestPubKey
      : undefined,
  };
};

const assertWorkerRequestKeyDetails = (
  requestKey: WorkerTxHistoryRequestKeyDetails,
) => {
  'worklet';

  if (
    requestKey.requestPubKey &&
    requestKey.requestPubKeyMatchesDerived === false
  ) {
    throw new Error(
      `Stored requestPubKey ${toHexPreview(
        requestKey.requestPubKey,
      )} does not match the derived requestPubKey ${toHexPreview(
        requestKey.derivedRequestPubKey,
      )}.`,
    );
  }
};

const parseDerSignature = (signatureHex: string) => {
  'worklet';

  const signatureBytes = hexToBytes(signatureHex);
  if (signatureBytes.length < 8) {
    throw new Error(
      `Expected a DER-encoded ECDSA signature, received ${signatureBytes.length} bytes.`,
    );
  }

  if (signatureBytes[0] !== 0x30) {
    throw new Error(
      `Expected DER sequence prefix 0x30, received 0x${signatureBytes[0].toString(
        16,
      )}.`,
    );
  }

  const sequenceLength = signatureBytes[1];
  if (sequenceLength !== signatureBytes.length - 2) {
    throw new Error(
      `Unexpected DER sequence length ${sequenceLength}; actual payload length is ${
        signatureBytes.length - 2
      }.`,
    );
  }

  if (signatureBytes[2] !== 0x02) {
    throw new Error(
      `Expected DER integer marker for r, received 0x${signatureBytes[2].toString(
        16,
      )}.`,
    );
  }

  const rLength = signatureBytes[3];
  const rStart = 4;
  const rEnd = rStart + rLength;

  if (signatureBytes[rEnd] !== 0x02) {
    throw new Error(
      `Expected DER integer marker for s, received 0x${signatureBytes[rEnd].toString(
        16,
      )}.`,
    );
  }

  const sLength = signatureBytes[rEnd + 1];
  const sStart = rEnd + 2;
  const sEnd = sStart + sLength;

  if (sEnd !== signatureBytes.length) {
    throw new Error(
      `Unexpected DER signature tail length ${signatureBytes.length - sEnd}.`,
    );
  }

  const rBytes = signatureBytes.subarray(rStart, rEnd);
  const sBytes = signatureBytes.subarray(sStart, sEnd);

  if (!rBytes.length || !sBytes.length) {
    throw new Error('DER signature is missing an r or s component.');
  }

  return {
    r: BigInt(`0x${bytesToHex(rBytes)}`),
    s: BigInt(`0x${bytesToHex(sBytes)}`),
  };
};

const encodeDerInteger = (value: bigint): Uint8Array => {
  'worklet';

  if (value < 0n) {
    throw new Error('DER integer encoding only supports non-negative values.');
  }

  let hex = value.toString(16);
  if (hex.length % 2 !== 0) {
    hex = `0${hex}`;
  }

  let bytes = hex.length > 0 ? hexToBytes(hex) : Uint8Array.of(0x00);

  while (bytes.length > 1 && bytes[0] === 0x00 && bytes[1] < 0x80) {
    bytes = bytes.subarray(1);
  }

  if (bytes[0] >= 0x80) {
    bytes = concatBytes(Uint8Array.of(0x00), bytes);
  }

  return bytes;
};

const encodeDerSignature = (r: bigint, s: bigint): string => {
  'worklet';

  const rBytes = encodeDerInteger(r);
  const sBytes = encodeDerInteger(s);
  const totalLength = 2 + rBytes.length + 2 + sBytes.length;

  if (totalLength >= 0x80) {
    throw new Error(
      `DER signature payload is too large to encode (${totalLength} bytes).`,
    );
  }

  return bytesToHex(
    concatBytes(
      Uint8Array.of(0x30, totalLength, 0x02, rBytes.length),
      rBytes,
      Uint8Array.of(0x02, sBytes.length),
      sBytes,
    ),
  );
};

const normalizeSecp256k1LowSSignatureHex = (signatureHex: string): string => {
  'worklet';

  const {r, s} = parseDerSignature(signatureHex);
  const curveHalfOrder = BigInt(`0x${SECP256K1_CURVE_HALF_ORDER_HEX}`);

  if (s <= curveHalfOrder) {
    return signatureHex;
  }

  const curveOrder = BigInt(`0x${SECP256K1_CURVE_ORDER_HEX}`);
  return encodeDerSignature(r, curveOrder - s);
};

const toWalletSummary = (
  wallet: WorkletsTxHistoryWalletSnapshot,
): WorkerTxHistoryWalletSummary => {
  'worklet';

  return {
    walletId: wallet.walletId,
    walletName: wallet.walletName,
    keyName: wallet.keyName,
    chain: wallet.chain,
    coin: wallet.coin,
    network: wallet.network,
    tokenAddress: wallet.tokenAddress,
    multisigContractAddress: wallet.multisigContractAddress,
    isTokenWallet: !!wallet.tokenAddress,
    isMultisigContractWallet: !!wallet.multisigContractAddress,
  };
};

const getWorkerTxHistorySession = (): WorkerTxHistorySession | undefined => {
  'worklet';

  return (globalThis as any)[WORKER_TXHISTORY_SESSION_KEY] as
    | WorkerTxHistorySession
    | undefined;
};

const setWorkerTxHistorySession = (session: WorkerTxHistorySession) => {
  'worklet';

  (globalThis as any)[WORKER_TXHISTORY_SESSION_KEY] = session;
  return session;
};

const requireWorkerTxHistorySession = (): WorkerTxHistorySession => {
  'worklet';

  const session = getWorkerTxHistorySession();
  if (!session) {
    throw new Error(
      'No wallet txhistory session is initialized on the worker runtime.',
    );
  }

  return session;
};

const toWorkerTxHistorySessionSummary = (
  session: WorkerTxHistorySession,
): WorkerTxHistorySessionSummary => {
  'worklet';

  return {
    workerRuntimeName: session.workerRuntimeName,
    initializedAtIso: session.initializedAtIso,
    requestSequence: session.requestSequence,
    wallet: toWalletSummary(session.wallet),
  };
};

const createWorkerTxHistorySession = (
  wallet: WorkletsTxHistoryWalletSnapshot,
  requestKey: WorkerTxHistoryRequestKeyDetails,
  baseBwsUrl: string,
  clientVersionHeader: string,
  workerRuntimeName: string,
): WorkerTxHistorySession => {
  'worklet';

  ensureSigningGlobalsForWorker();
  assertWorkerRequestKeyDetails(requestKey);

  return {
    wallet,
    requestKey,
    baseBwsUrl,
    clientVersionHeader,
    workerRuntimeName,
    initializedAtIso: new Date().toISOString(),
    initializedAtMs: Date.now(),
    requestSequence: 0,
  };
};

const buildTxHistoryRequestPath = (
  wallet: TxHistoryRequestWalletContext,
  skip: number,
  limit: number,
  cacheBust: number,
) => {
  'worklet';

  const args: string[] = [];
  if (skip) {
    args.push(`skip=${skip}`);
  }
  if (limit) {
    args.push(`limit=${limit}`);
  }
  if (wallet.tokenAddress) {
    args.push(`tokenAddress=${encodeURIComponent(wallet.tokenAddress)}`);
  }
  if (wallet.multisigContractAddress) {
    args.push(
      `multisigContractAddress=${encodeURIComponent(
        wallet.multisigContractAddress,
      )}`,
    );
  }

  let requestPath = TXHISTORY_BASE_PATH;
  if (args.length) {
    requestPath += `?${args.join('&')}`;
  }

  requestPath += requestPath.includes('?') ? '&' : '?';
  requestPath += `r=${cacheBust}`;

  return requestPath;
};

const createTransferredNitroBwsSigningBatchHybridsOnRN = (
  requestPrivKey: string,
  requestCount: number,
): TransferredNitroBwsSigningBatchHybrids => {
  const bitcoreLib = getBitcoreLibForRN();
  const {KeyType, KFormatType, KeyEncoding} = getQuickCryptoEnumsForRN();
  const privateKey = new bitcoreLib.PrivateKey(requestPrivKey);
  const privateKeyBytes = NodeBuffer.from(privateKey.toBuffer());
  const sec1Der = buildSecp256k1Sec1PrivateKeyDer(privateKeyBytes);

  const firstHash = createQuickCryptoHashHybridOnRN();
  const privateKeyHandle = createQuickCryptoKeyObjectHybridOnRN();
  const signHandles: QuickCryptoSignHybrid[] = [];

  const initialized = privateKeyHandle.init(
    KeyType.PRIVATE,
    nodeBufferToArrayBuffer(sec1Der),
    KFormatType.DER,
    KeyEncoding.SEC1,
  );

  if (!initialized) {
    throw new Error(
      'QuickCrypto KeyObjectHandle.init() returned false for the secp256k1 request key.',
    );
  }

  while (signHandles.length < Math.max(1, Math.floor(requestCount))) {
    signHandles.push(createQuickCryptoSignHybridOnRN());
  }

  return {
    firstHash,
    signHandles,
    privateKeyHandle,
  };
};

const signBwsGetRequestWithTransferredNitro = (
  requestPath: string,
  firstHashHybrid: QuickCryptoHashHybrid,
  signHandleHybrid: QuickCryptoSignHybrid,
  privateKeyHandle: QuickCryptoKeyObjectHybrid,
) => {
  'worklet';

  const signingMessage = `get|${requestPath}|{}`;

  firstHashHybrid.createHash('sha256');
  firstHashHybrid.update(signingMessage);
  const sha256Once = firstHashHybrid.digest();

  signHandleHybrid.init('sha256');
  signHandleHybrid.update(sha256Once);

  const rawNitroSignatureHex = bytesToHex(
    new Uint8Array(
      signHandleHybrid.sign(privateKeyHandle, undefined, undefined, 0),
    ),
  );

  return normalizeSecp256k1LowSSignatureHex(rawNitroSignatureHex);
};

function tryParseJson(text: string) {
  'worklet';

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

type WorkerFiatRatePoint = {
  ts: number;
  rate: number;
};

const parseWorkerFiatRatePoints = (
  payload: unknown,
  rateCoin: string,
): WorkerFiatRatePoint[] => {
  'worklet';

  let rawPoints: unknown;
  if (Array.isArray(payload)) {
    rawPoints = payload;
  } else if (payload && typeof payload === 'object') {
    const payloadRecord = payload as Record<string, unknown>;
    rawPoints =
      payloadRecord[rateCoin] ??
      payloadRecord[rateCoin.toUpperCase()] ??
      payloadRecord[rateCoin.toLowerCase()];
  }

  if (!Array.isArray(rawPoints)) {
    return [];
  }

  const parsedPoints = rawPoints
    .map(point => ({
      ts: Number((point as any)?.ts),
      rate: Number((point as any)?.rate),
    }))
    .filter(point => Number.isFinite(point.ts) && Number.isFinite(point.rate));

  if (!parsedPoints.length) {
    return [];
  }

  parsedPoints.sort((a, b) => a.ts - b.ts);
  return parsedPoints;
};

const summarizeTx = (tx: any): WorkerTxHistoryPreviewItem => {
  'worklet';

  const firstOutputAddress = Array.isArray(tx?.outputs)
    ? tx.outputs.find((output: any) => typeof output?.toAddress === 'string')
        ?.toAddress
    : undefined;

  return {
    txid: typeof tx?.txid === 'string' ? tx.txid : undefined,
    action: typeof tx?.action === 'string' ? tx.action : undefined,
    amount:
      typeof tx?.amount === 'number' || typeof tx?.amount === 'string'
        ? tx.amount
        : undefined,
    fees:
      typeof tx?.fees === 'number' || typeof tx?.fees === 'string'
        ? tx.fees
        : undefined,
    time: typeof tx?.time === 'number' ? tx.time : undefined,
    confirmations:
      typeof tx?.confirmations === 'number' ? tx.confirmations : undefined,
    addressTo:
      typeof tx?.addressTo === 'string' ? tx.addressTo : firstOutputAddress,
  };
};

const executePreparedTxHistoryRequestForPrimedWallet = async (
  nitroFetchClient: NitroFetchClientHybrid,
  session: WorkerTxHistorySession,
  pageIndex: number,
  skip: number,
  limit: number,
  requestPath: string,
  signature: string,
): Promise<WorkerTxHistoryPageResult> => {
  'worklet';

  const startedAt = Date.now();

  let response: NitroFetchResponse;
  try {
    response = nitroFetchClient.requestSync({
      url: `${session.baseBwsUrl}${requestPath}`,
      method: 'GET',
      headers: [
        {key: 'Accept', value: 'application/json'},
        {key: 'Cache-Control', value: 'no-store'},
        {key: 'x-client-version', value: session.clientVersionHeader},
        {key: 'x-identity', value: session.wallet.copayerId},
        {key: 'x-signature', value: signature},
      ],
      timeoutMs: DEFAULT_NITRO_FETCH_TIMEOUT_MS,
      followRedirects: true,
    });
  } catch (err: unknown) {
    throw new Error(
      `Worker Nitro Fetch failed for txhistory page ${
        pageIndex + 1
      } (${requestPath}). ${toWorkerErrorMessage(err)}`,
    );
  }

  const rawResponseText =
    typeof response.bodyString === 'string' ? response.bodyString : '';
  if (!response.ok) {
    const responsePreview = rawResponseText
      ? rawResponseText.slice(0, 400)
      : 'Empty response body.';
    throw new Error(
      `BWS txhistory request failed with status ${response.status}. ${responsePreview}`,
    );
  }

  const parsedBody = tryParseJson(rawResponseText);
  const transactions = Array.isArray(parsedBody) ? parsedBody : [];

  return {
    pageIndex,
    skip,
    limit,
    requestPath,
    status: response.status,
    fetchedAtIso: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    signaturePreview: `${signature.slice(0, 18)}…`,
    txCount: transactions.length,
    transactionsPreview: transactions.slice(0, 3).map((tx: any) => {
      return summarizeTx(tx);
    }),
  };
};

const getWorkletsBundleModeRuntime = (): WorkletRuntime => {
  if (!workletsBundleModeRuntime) {
    workletsBundleModeRuntime = createWorkletRuntime({
      name: WORKER_RUNTIME_NAME,
      initializer: () => {
        'worklet';
        ensureSigningGlobalsForWorker();
      },
      enableEventLoop: true,
    });
  }

  return workletsBundleModeRuntime;
};

export const probeMmkvRoundTripOnWorker =
  async (): Promise<WorkerMmkvRoundTripResult> => {
    return probeMmkvRoundTripOnWorkerWithStorage({
      keyPrefix: WORKER_MMKV_KEY_PREFIX,
      storageBridge: getWorkletsBundleModeDemoNativeStorageOnRN(),
      storageId: WORKER_MMKV_STORAGE_ID,
    });
  };

const probeMmkvRoundTripOnWorkerWithStorage = async (opts: {
  keyPrefix: string;
  storageBridge: WorkerMmkvStorageBridge;
  storageId: string;
}): Promise<WorkerMmkvRoundTripResult> => {
  const {keyPrefix, storageBridge, storageId} = opts;
  const probeKey = buildWorkerMmkvKey(keyPrefix);

  const workerResult = await new Promise<
    Omit<
      WorkerMmkvRoundTripResult,
      | 'cleanupRemovedKeyOnRN'
      | 'rnContainsKeyAfterWorkerWrite'
      | 'rnReadMatchesWrite'
      | 'valueReadOnRN'
    >
  >((resolve, reject) => {
    const rejectOnRN = (message: string) => {
      reject(new Error(message));
    };

    runOnRuntimeAsync(
      getWorkletsBundleModeRuntime(),
      (
        workerRuntimeName: string,
        roundTripStorageId: string,
        workerStorageBridge: WorkerMmkvStorageBridge,
        key: string,
        resolveOnRN: (
          value: Omit<
            WorkerMmkvRoundTripResult,
            | 'cleanupRemovedKeyOnRN'
            | 'rnContainsKeyAfterWorkerWrite'
            | 'rnReadMatchesWrite'
            | 'valueReadOnRN'
          >,
        ) => void,
        rejectOnRNWorklet: (message: string) => void,
      ): void => {
        'worklet';

        try {
          const startedAtMs = Date.now();
          const startedAtIso = new Date(startedAtMs).toISOString();
          const valueWritten = JSON.stringify({
            key,
            probe: 'worker_mmkv_roundtrip',
            runtimeKind: globalThis.__RUNTIME_KIND,
            runtimeName: workerRuntimeName,
            writtenAtIso: startedAtIso,
          });

          workerStorageBridge.set(key, valueWritten);

          const valueReadOnWorker = workerStorageBridge.getString(key);
          const workerContainsKeyAfterWrite = workerStorageBridge.contains(key);

          scheduleOnRN(resolveOnRN, {
            workerRuntimeName,
            storageId: roundTripStorageId,
            key,
            startedAtIso,
            completedAtIso: new Date().toISOString(),
            durationMs: Date.now() - startedAtMs,
            valueWritten,
            valueReadOnWorker,
            workerReadMatchesWrite: valueReadOnWorker === valueWritten,
            workerContainsKeyAfterWrite,
          });
        } catch (err: unknown) {
          scheduleOnRN(
            rejectOnRNWorklet,
            `Worker MMKV roundtrip failed. ${toWorkerErrorMessage(err)}`,
          );
        }
      },
      WORKER_RUNTIME_NAME,
      storageId,
      storageBridge,
      probeKey,
      resolve,
      rejectOnRN,
    ).catch(err => {
      reject(toRuntimeError(err));
    });
  });

  let valueReadOnRN: string | undefined;
  let rnContainsKeyAfterWorkerWrite = false;
  let cleanupRemovedKeyOnRN = false;

  try {
    valueReadOnRN = storageBridge.getString(probeKey);
    rnContainsKeyAfterWorkerWrite = storageBridge.contains(probeKey);
  } finally {
    try {
      storageBridge.delete(probeKey);
      cleanupRemovedKeyOnRN = !storageBridge.contains(probeKey);
    } catch {}
  }

  return {
    ...workerResult,
    valueReadOnRN,
    rnReadMatchesWrite: valueReadOnRN === workerResult.valueWritten,
    rnContainsKeyAfterWorkerWrite,
    cleanupRemovedKeyOnRN,
  };
};

export const probeSharedAppMmkvRoundTripOnWorker =
  async (): Promise<WorkerMmkvRoundTripResult> => {
    return probeMmkvRoundTripOnWorkerWithStorage({
      keyPrefix: WORKER_MMKV_SHARED_APP_KEY_PREFIX,
      storageBridge: getAppSharedNativeStorageOnRN(),
      storageId: APP_SHARED_MMKV_STORAGE_LABEL,
    });
  };

export const stressTestMmkvOnWorker = async (opts?: {
  iterationCount?: number;
}): Promise<WorkerMmkvStressTestResult> => {
  const mmkvStorage = getWorkletsBundleModeDemoNativeStorageOnRN();
  const iterationCount = normalizePositiveInt(
    opts?.iterationCount,
    DEFAULT_WORKER_MMKV_STRESS_TEST_ITERATION_COUNT,
  );
  const entries = buildWorkerMmkvStressTestEntries(iterationCount);
  const totalStartedAtMs = Date.now();

  const workerResult = await new Promise<
    Omit<
      WorkerMmkvStressTestResult,
      | 'cleanupFullySucceeded'
      | 'cleanupRemovedKeyCount'
      | 'rnContainsChecksPassed'
      | 'rnReadMatches'
      | 'totalDurationMs'
    >
  >((resolve, reject) => {
    const rejectOnRN = (message: string) => {
      reject(new Error(message));
    };

    runOnRuntimeAsync(
      getWorkletsBundleModeRuntime(),
      (
        workerRuntimeName: string,
        storageId: string,
        storageBridge: WorkerMmkvStorageBridge,
        workerEntries: WorkerMmkvStressTestEntry[],
        resolveOnRN: (
          value: Omit<
            WorkerMmkvStressTestResult,
            | 'cleanupFullySucceeded'
            | 'cleanupRemovedKeyCount'
            | 'rnContainsChecksPassed'
            | 'rnReadMatches'
            | 'totalDurationMs'
          >,
        ) => void,
        rejectOnRNWorklet: (message: string) => void,
      ): void => {
        'worklet';

        try {
          const startedAtMs = Date.now();
          const startedAtIso = new Date(startedAtMs).toISOString();
          let workerWriteReadMatches = 0;
          let workerContainsChecksPassed = 0;

          for (const entry of workerEntries) {
            storageBridge.set(entry.key, entry.value);

            const valueReadOnWorker = storageBridge.getString(entry.key);
            if (valueReadOnWorker !== entry.value) {
              throw new Error(
                `Worker read mismatch at iteration ${
                  entry.iteration
                }. Expected ${entry.value.length} bytes, received ${
                  valueReadOnWorker?.length ?? 0
                }.`,
              );
            }
            workerWriteReadMatches += 1;

            const containsKey = storageBridge.contains(entry.key);
            if (!containsKey) {
              throw new Error(
                `Worker contains() returned false at iteration ${entry.iteration} for key ${entry.key}.`,
              );
            }
            workerContainsChecksPassed += 1;
          }

          const firstEntry = workerEntries[0];
          const lastEntry = workerEntries[workerEntries.length - 1];

          if (!firstEntry || !lastEntry) {
            throw new Error(
              'Worker MMKV stress test did not receive any entries.',
            );
          }

          scheduleOnRN(resolveOnRN, {
            workerRuntimeName,
            storageId,
            iterationCount: workerEntries.length,
            startedAtIso,
            completedAtIso: new Date().toISOString(),
            workerDurationMs: Date.now() - startedAtMs,
            workerWriteReadMatches,
            workerContainsChecksPassed,
            firstKey: firstEntry.key,
            lastKey: lastEntry.key,
            firstValueWritten: firstEntry.value,
            lastValueWritten: lastEntry.value,
          });
        } catch (err: unknown) {
          scheduleOnRN(
            rejectOnRNWorklet,
            `Worker MMKV stress test failed. ${toWorkerErrorMessage(err)}`,
          );
        }
      },
      WORKER_RUNTIME_NAME,
      WORKER_MMKV_STORAGE_ID,
      mmkvStorage,
      entries,
      resolve,
      rejectOnRN,
    ).catch(err => {
      reject(toRuntimeError(err));
    });
  });

  let rnReadMatches = 0;
  let rnContainsChecksPassed = 0;
  let cleanupRemovedKeyCount = 0;
  let cleanupFullySucceeded = false;

  try {
    for (const entry of entries) {
      const valueReadOnRN = mmkvStorage.getString(entry.key);
      if (valueReadOnRN !== entry.value) {
        throw new Error(
          `RN read mismatch at iteration ${entry.iteration}. Expected ${
            entry.value.length
          } bytes, received ${valueReadOnRN?.length ?? 0}.`,
        );
      }
      rnReadMatches += 1;

      const containsKey = mmkvStorage.contains(entry.key);
      if (!containsKey) {
        throw new Error(
          `RN contains() returned false at iteration ${entry.iteration} for key ${entry.key}.`,
        );
      }
      rnContainsChecksPassed += 1;
    }
  } finally {
    for (const entry of entries) {
      try {
        mmkvStorage.delete(entry.key);
        if (!mmkvStorage.contains(entry.key)) {
          cleanupRemovedKeyCount += 1;
        }
      } catch {}
    }

    cleanupFullySucceeded = cleanupRemovedKeyCount === entries.length;
  }

  return {
    ...workerResult,
    rnReadMatches,
    rnContainsChecksPassed,
    cleanupRemovedKeyCount,
    cleanupFullySucceeded,
    totalDurationMs: Date.now() - totalStartedAtMs,
  };
};

export const contentionTestMmkvOnWorker = async (opts?: {
  iterationCount?: number;
}): Promise<WorkerMmkvContentionTestResult> => {
  const mmkvStorage = getWorkletsBundleModeDemoNativeStorageOnRN();
  const contentionBarrier = createSynchronizable(
    createWorkerMmkvContentionBarrierState(),
  );
  const iterationCount = normalizePositiveInt(
    opts?.iterationCount,
    DEFAULT_WORKER_MMKV_CONTENTION_ITERATION_COUNT,
  );
  const key = buildWorkerMmkvKey(WORKER_MMKV_CONTENTION_KEY_PREFIX);
  const totalStartedAtMs = Date.now();
  const startedAtIso = new Date(totalStartedAtMs).toISOString();

  try {
    mmkvStorage.delete(key);
  } catch {}

  let notifyWorkerStartedOnRN: (() => void) | undefined;
  const workerStartedPromise = new Promise<void>(resolve => {
    notifyWorkerStartedOnRN = resolve;
  });

  const workerPromise = new Promise<{
    workerRuntimeName: string;
    storageId: string;
    workerDurationMs: number;
    workerImmediateSelfReadMatches: number;
    workerStaleOwnReadCount: number;
    workerObservedRnWrites: number;
    workerUnexpectedValueCount: number;
    workerContainsChecksPassed: number;
  }>((resolve, reject) => {
    const rejectOnRN = (message: string) => {
      reject(new Error(message));
    };

    runOnRuntimeAsync(
      getWorkletsBundleModeRuntime(),
      (
        workerRuntimeName: string,
        storageId: string,
        storageBridge: WorkerMmkvStorageBridge,
        barrier: Synchronizable<WorkerMmkvContentionBarrierState>,
        contentionKey: string,
        requestedIterationCount: number,
        markWorkerStartedOnRN: () => void,
        resolveOnRN: (value: {
          workerRuntimeName: string;
          storageId: string;
          workerDurationMs: number;
          workerImmediateSelfReadMatches: number;
          workerStaleOwnReadCount: number;
          workerObservedRnWrites: number;
          workerUnexpectedValueCount: number;
          workerContainsChecksPassed: number;
        }) => void,
        rejectOnRNWorklet: (message: string) => void,
      ): void => {
        'worklet';

        try {
          scheduleOnRN(markWorkerStartedOnRN);

          const loopResult = executeWorkerMmkvContentionLoop(
            'worker',
            contentionKey,
            requestedIterationCount,
            storageBridge,
            barrier,
          );

          scheduleOnRN(resolveOnRN, {
            workerRuntimeName,
            storageId,
            workerDurationMs: loopResult.durationMs,
            workerImmediateSelfReadMatches: loopResult.immediateSelfReadMatches,
            workerStaleOwnReadCount: loopResult.staleOwnReadCount,
            workerObservedRnWrites: loopResult.observedOtherWrites,
            workerUnexpectedValueCount: loopResult.unexpectedValueCount,
            workerContainsChecksPassed: loopResult.containsChecksPassed,
          });
        } catch (err: unknown) {
          scheduleOnRN(
            rejectOnRNWorklet,
            `Worker MMKV contention test failed. ${toWorkerErrorMessage(err)}`,
          );
        }
      },
      WORKER_RUNTIME_NAME,
      WORKER_MMKV_STORAGE_ID,
      mmkvStorage,
      contentionBarrier,
      key,
      iterationCount,
      () => notifyWorkerStartedOnRN?.(),
      resolve,
      rejectOnRN,
    ).catch(err => {
      reject(toRuntimeError(err));
    });
  });

  await Promise.race([
    workerStartedPromise,
    workerPromise.then(() => undefined),
  ]);

  const rnLoopResult = executeWorkerMmkvContentionLoop(
    'rn',
    key,
    iterationCount,
    mmkvStorage,
    contentionBarrier,
  );

  const workerResult = await workerPromise;
  const finalValue = mmkvStorage.getString(key);
  const finalValueSummary = summarizeWorkerMmkvContentionRead(key, finalValue);

  let cleanupRemovedKeyOnRN = false;
  try {
    mmkvStorage.delete(key);
    cleanupRemovedKeyOnRN = !mmkvStorage.contains(key);
  } catch {}

  return {
    workerRuntimeName: workerResult.workerRuntimeName,
    storageId: workerResult.storageId,
    key,
    iterationCountPerRuntime: iterationCount,
    startedAtIso,
    completedAtIso: new Date().toISOString(),
    rnDurationMs: rnLoopResult.durationMs,
    workerDurationMs: workerResult.workerDurationMs,
    totalDurationMs: Date.now() - totalStartedAtMs,
    rnImmediateSelfReadMatches: rnLoopResult.immediateSelfReadMatches,
    workerImmediateSelfReadMatches: workerResult.workerImmediateSelfReadMatches,
    rnStaleOwnReadCount: rnLoopResult.staleOwnReadCount,
    workerStaleOwnReadCount: workerResult.workerStaleOwnReadCount,
    rnObservedWorkerWrites: rnLoopResult.observedOtherWrites,
    workerObservedRnWrites: workerResult.workerObservedRnWrites,
    rnUnexpectedValueCount: rnLoopResult.unexpectedValueCount,
    workerUnexpectedValueCount: workerResult.workerUnexpectedValueCount,
    rnContainsChecksPassed: rnLoopResult.containsChecksPassed,
    workerContainsChecksPassed: workerResult.workerContainsChecksPassed,
    finalValuePreview: summarizeWorkerMmkvContentionValuePreview(finalValue),
    finalValueWriter: finalValueSummary?.writer,
    finalValueIteration: finalValueSummary?.iteration,
    cleanupRemovedKeyOnRN,
  };
};

export const smokeTestNitroFetchRequestOnWorker =
  async (): Promise<WorkerNitroFetchSmokeResult> => {
    const boxedNitroFetch = createBoxedNitroFetchHybridOnRN();

    return new Promise((resolve, reject) => {
      const rejectOnRN = (message: string) => {
        reject(new Error(message));
      };

      runOnRuntimeAsync(
        getWorkletsBundleModeRuntime(),
        (
          workerRuntimeName: string,
          requestedUrl: string,
          timeoutMs: number,
          boxedNitroFetchOnWorker: BoxedHybridObjectLike<NitroFetchHybrid>,
          resolveOnRN: (value: WorkerNitroFetchSmokeResult) => void,
          rejectOnRNWorklet: (message: string) => void,
        ): void => {
          'worklet';

          try {
            const startedAtMs = Date.now();
            const startedAtIso = new Date(startedAtMs).toISOString();

            const nitroFetch = boxedNitroFetchOnWorker.unbox();
            const client = nitroFetch.createClient();
            const response = client.requestSync({
              url: requestedUrl,
              method: 'GET',
              headers: [
                {key: 'Accept', value: 'application/json'},
                {key: 'Cache-Control', value: 'no-store'},
              ],
              timeoutMs,
              followRedirects: true,
            });

            const bodyString =
              typeof response.bodyString === 'string'
                ? response.bodyString
                : '';

            if (!response.ok) {
              const bodyPreview = bodyString
                ? bodyString.slice(0, 240)
                : 'Empty response body.';
              throw new Error(
                `Nitro Fetch request failed with status ${response.status}. ${bodyPreview}`,
              );
            }

            const parsedBody = tryParseJson(bodyString) as any;
            const returnedCoinKeys =
              parsedBody &&
              typeof parsedBody === 'object' &&
              !Array.isArray(parsedBody)
                ? Object.keys(parsedBody as Record<string, unknown>).slice(
                    0,
                    12,
                  )
                : [];
            const ratePoints = parseWorkerFiatRatePoints(
              parsedBody,
              NITRO_FETCH_SMOKE_TEST_RATE_COIN,
            );
            const firstRatePoint = ratePoints[0];
            const latestRatePoint = ratePoints[ratePoints.length - 1];
            const responseHeaderPreview = Array.isArray(response.headers)
              ? response.headers
                  .slice(0, 6)
                  .map(header => `${header.key}: ${header.value}`)
              : [];

            if (!ratePoints.length) {
              const payloadCoins = returnedCoinKeys.length
                ? returnedCoinKeys.join(', ')
                : 'none';
              throw new Error(
                `BTC v4 rates payload did not contain any valid points. Returned coin keys: ${payloadCoins}.`,
              );
            }

            scheduleOnRN(resolveOnRN, {
              workerRuntimeName,
              requestedUrl,
              responseUrl: response.url,
              startedAtIso,
              completedAtIso: new Date().toISOString(),
              durationMs: Date.now() - startedAtMs,
              status: response.status,
              statusText: response.statusText,
              ok: response.ok,
              redirected: response.redirected,
              responseHeadersCount: Array.isArray(response.headers)
                ? response.headers.length
                : 0,
              responseHeaderPreview,
              bodyLength: bodyString.length,
              bodyPreview: bodyString.slice(0, 240),
              quoteCurrency: NITRO_FETCH_SMOKE_TEST_QUOTE_CURRENCY,
              rateCoin: NITRO_FETCH_SMOKE_TEST_RATE_COIN,
              returnedCoinKeys,
              parsedPointCount: ratePoints.length,
              firstPointTs: firstRatePoint?.ts,
              firstPointRate: firstRatePoint?.rate,
              latestPointTs: latestRatePoint?.ts,
              latestPointRate: latestRatePoint?.rate,
            });
          } catch (err: unknown) {
            scheduleOnRN(
              rejectOnRNWorklet,
              `Worker Nitro Fetch smoke test failed. ${toWorkerErrorMessage(
                err,
              )}`,
            );
          }
        },
        WORKER_RUNTIME_NAME,
        NITRO_FETCH_SMOKE_TEST_URL,
        DEFAULT_NITRO_FETCH_TIMEOUT_MS,
        boxedNitroFetch,
        resolve,
        rejectOnRN,
      ).catch(err => {
        reject(toRuntimeError(err));
      });
    });
  };

export const fetchWalletTxHistoryPagesOnWorker = async (opts: {
  wallet: WorkletsTxHistoryWalletSnapshot;
  initialSkip?: number;
  pageSize?: number;
  pageCount?: number;
}): Promise<WorkerTxHistoryBatchResult> => {
  const {wallet} = opts;
  if (!wallet?.requestPrivKey) {
    throw new Error(
      'A selected wallet with a requestPrivKey is required for worker txhistory signing.',
    );
  }

  const initialSkip = Math.max(0, Math.floor(opts.initialSkip ?? 0));
  const pageSize = normalizePositiveInt(opts.pageSize, DEFAULT_TXHISTORY_LIMIT);
  const pageCount = normalizePositiveInt(
    opts.pageCount,
    DEFAULT_TXHISTORY_PAGE_COUNT,
  );

  let requestKey: WorkerTxHistoryRequestKeyDetails;
  try {
    requestKey = getWorkerRequestKeyDetailsOnRN(wallet);
  } catch (err: unknown) {
    throw new Error(
      `RN txhistory request-key setup failed before crossing runtimes. ${
        toRuntimeError(err).message
      }`,
    );
  }

  let boxedNitroFetch: BoxedHybridObjectLike<NitroFetchHybrid>;
  try {
    boxedNitroFetch = createBoxedNitroFetchHybridOnRN();
  } catch (err: unknown) {
    throw new Error(
      `RN Nitro Fetch txhistory transport setup failed before crossing runtimes. ${
        toRuntimeError(err).message
      }`,
    );
  }

  let signingHybrids: TransferredNitroBwsSigningBatchHybrids;
  try {
    signingHybrids = createTransferredNitroBwsSigningBatchHybridsOnRN(
      wallet.requestPrivKey,
      pageCount,
    );
  } catch (err: unknown) {
    throw new Error(
      `RN Nitro txhistory signing setup failed before crossing runtimes. ${
        toRuntimeError(err).message
      }`,
    );
  }

  return new Promise((resolve, reject) => {
    const rejectOnRN = (message: string) => {
      reject(new Error(message));
    };

    runOnRuntimeAsync(
      getWorkletsBundleModeRuntime(),
      (
        workerWallet: WorkletsTxHistoryWalletSnapshot,
        workerRequestKey: WorkerTxHistoryRequestKeyDetails,
        baseBwsUrl: string,
        clientVersionHeader: string,
        workerRuntimeName: string,
        requestedPageCount: number,
        initialSkipArg: number,
        pageSizeArg: number,
        firstHashHybrid: QuickCryptoHashHybrid,
        signHandleHybrids: QuickCryptoSignHybrid[],
        privateKeyHandle: QuickCryptoKeyObjectHybrid,
        boxedNitroFetchOnWorker: BoxedHybridObjectLike<NitroFetchHybrid>,
        resolveOnRN: (value: WorkerTxHistoryBatchResult) => void,
        rejectOnRNWorklet: (message: string) => void,
      ): void => {
        'worklet';

        ensureSigningGlobalsForWorker();

        (async () => {
          try {
            const nitroFetch = boxedNitroFetchOnWorker.unbox();
            const nitroFetchClient = nitroFetch.createClient();
            let session = getWorkerTxHistorySession();

            if (!walletSnapshotsMatch(session?.wallet, workerWallet)) {
              session = setWorkerTxHistorySession(
                createWorkerTxHistorySession(
                  workerWallet,
                  workerRequestKey,
                  baseBwsUrl,
                  clientVersionHeader,
                  workerRuntimeName,
                ),
              );
            }

            const activeSession = requireWorkerTxHistorySession();
            const startedAt = Date.now();
            const pages: WorkerTxHistoryPageResult[] = [];

            let stopReason: 'empty_page' | 'short_page' | 'max_pages_reached' =
              'max_pages_reached';
            let stoppedEarly = false;
            let totalTransactionsAcrossPages = 0;
            let nextSkip = initialSkipArg;

            for (
              let pageIndex = 0;
              pageIndex < requestedPageCount;
              pageIndex += 1
            ) {
              const signHandleHybrid = signHandleHybrids[pageIndex];
              if (!signHandleHybrid) {
                throw new Error(
                  `No transferred Nitro SignHandle is available for txhistory page ${
                    pageIndex + 1
                  }.`,
                );
              }

              const requestPath = buildTxHistoryRequestPath(
                activeSession.wallet,
                nextSkip,
                pageSizeArg,
                activeSession.initializedAtMs +
                  activeSession.requestSequence +
                  1,
              );

              let signature: string;
              try {
                signature = signBwsGetRequestWithTransferredNitro(
                  requestPath,
                  firstHashHybrid,
                  signHandleHybrid,
                  privateKeyHandle,
                );
              } catch (err: unknown) {
                throw new Error(
                  `Worker Nitro signing failed for txhistory page ${
                    pageIndex + 1
                  } (${requestPath}). ${toWorkerErrorMessage(err)}`,
                );
              }

              activeSession.requestSequence += 1;

              const page = await executePreparedTxHistoryRequestForPrimedWallet(
                nitroFetchClient,
                activeSession,
                pageIndex,
                nextSkip,
                pageSizeArg,
                requestPath,
                signature,
              );

              pages.push(page);
              totalTransactionsAcrossPages += page.txCount;
              nextSkip += pageSizeArg;

              if (page.txCount === 0) {
                stoppedEarly = true;
                stopReason = 'empty_page';
                break;
              }

              if (page.txCount < pageSizeArg) {
                stoppedEarly = true;
                stopReason = 'short_page';
                break;
              }
            }

            scheduleOnRN(resolveOnRN, {
              workerRuntimeName: activeSession.workerRuntimeName,
              fetchedAtIso: new Date().toISOString(),
              totalDurationMs: Date.now() - startedAt,
              requestedPageCount,
              executedPageCount: pages.length,
              pageSize: pageSizeArg,
              initialSkip: initialSkipArg,
              totalTransactionsAcrossPages,
              stoppedEarly,
              stopReason,
              session: toWorkerTxHistorySessionSummary(activeSession),
              pages,
            });
          } catch (err: unknown) {
            scheduleOnRN(rejectOnRNWorklet, toWorkerErrorMessage(err));
          }
        })();
      },
      wallet,
      requestKey,
      BASE_BWS_URL,
      BWC_CLIENT_VERSION_HEADER,
      WORKER_RUNTIME_NAME,
      pageCount,
      initialSkip,
      pageSize,
      signingHybrids.firstHash,
      signingHybrids.signHandles,
      signingHybrids.privateKeyHandle,
      boxedNitroFetch,
      resolve,
      rejectOnRN,
    ).catch(err => {
      reject(toRuntimeError(err));
    });
  });
};
