import {
  createWorkletRuntime,
  runOnRuntimeAsync,
  scheduleOnRN,
  type WorkletRuntime,
} from 'react-native-worklets';
import {MMKV, type NativeMMKV} from 'react-native-mmkv';
import {Buffer as NodeBuffer} from 'buffer';
import processPolyfill from 'process';
import {BASE_BWS_URL} from '../constants/config';

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

type NitroModulesLike = {
  createHybridObject<T = unknown>(name: string): T;
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

type TransferredNitroBwsSigningBatchHybrids = {
  firstHash: QuickCryptoHashHybrid;
  signHandles: QuickCryptoSignHybrid[];
  privateKeyHandle: QuickCryptoKeyObjectHybrid;
};

type WorkerMmkvStorageBridge = Pick<
  NativeMMKV,
  'contains' | 'delete' | 'getString' | 'set'
>;

const WORKER_RUNTIME_NAME = 'bitpay-txhistory-worker';
const BWC_CLIENT_VERSION_HEADER = 'bwc-11.7.0';
const DEFAULT_TXHISTORY_LIMIT = 10;
const DEFAULT_TXHISTORY_PAGE_COUNT = 3;
const WORKER_TXHISTORY_SESSION_KEY = '__bitpayTxHistoryWorkerSession';
const WORKER_MMKV_STORAGE_ID = 'bitpay.worklets.bundle.mode.demo';
const WORKER_MMKV_KEY_PREFIX = 'worklets-mmkv-roundtrip';
const TXHISTORY_BASE_PATH = '/v1/txhistory/';

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

const getWorkletsBundleModeDemoNativeStorageOnRN =
  (): WorkerMmkvStorageBridge => {
    const nativeStorage = (
      getWorkletsBundleModeDemoStorageOnRN() as unknown as {
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
        'react-native-mmkv nativeInstance is unavailable on the RN runtime.',
      );
    }

    return nativeStorage;
  };

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
  if (!globalRef.Buffer) {
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

const getBitcoreLibForWorker = () => {
  'worklet';

  const importedBitcoreLib = require('@bitpay-labs/bitcore-lib') as any;
  return importedBitcoreLib?.default || importedBitcoreLib;
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

const getWorkerRequestKeyDetails = (
  wallet: WorkletsTxHistoryWalletSnapshot,
): WorkerTxHistoryRequestKeyDetails => {
  'worklet';

  ensureSigningGlobalsForWorker();
  const bitcoreLib = getBitcoreLibForWorker();

  if (!bitcoreLib?.PrivateKey) {
    throw new Error(
      '@bitpay-labs/bitcore-lib is unavailable inside the worker runtime.',
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
  baseBwsUrl: string,
  clientVersionHeader: string,
  workerRuntimeName: string,
): WorkerTxHistorySession => {
  'worklet';

  ensureSigningGlobalsForWorker();
  const requestKey = getWorkerRequestKeyDetails(wallet);
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
  const sha256Once = NodeBuffer.from(firstHashHybrid.digest());

  signHandleHybrid.init('sha256');
  signHandleHybrid.update(nodeBufferToArrayBuffer(sha256Once));

  const bitcoreLib = getBitcoreLibForWorker();
  const rawNitroSignatureHex = NodeBuffer.from(
    signHandleHybrid.sign(privateKeyHandle, undefined, undefined, 0),
  ).toString('hex');
  const nitroSignature = bitcoreLib.crypto.Signature.fromString(
    rawNitroSignatureHex,
  );

  return nitroSignature.hasLowS()
    ? rawNitroSignatureHex
    : new bitcoreLib.crypto.Signature({
        r: nitroSignature.r,
        s: bitcoreLib.crypto.Point.getN().sub(nitroSignature.s),
        compressed: nitroSignature.compressed,
        isSchnorr: nitroSignature.isSchnorr,
        nhashtype: nitroSignature.nhashtype,
        i: nitroSignature.i,
      }).toString();
};

const tryParseJson = (text: string) => {
  'worklet';

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
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
  session: WorkerTxHistorySession,
  pageIndex: number,
  skip: number,
  limit: number,
  requestPath: string,
  signature: string,
): Promise<WorkerTxHistoryPageResult> => {
  'worklet';

  const startedAt = Date.now();

  let response: Response;
  try {
    response = await fetch(`${session.baseBwsUrl}${requestPath}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'x-client-version': session.clientVersionHeader,
        'x-identity': session.wallet.copayerId,
        'x-signature': signature,
      },
    });
  } catch (err: unknown) {
    throw new Error(
      `Worker fetch failed for txhistory page ${pageIndex + 1} (${requestPath}). ${toWorkerErrorMessage(
        err,
      )}`,
    );
  }

  const rawResponseText = await response.text();
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
    const mmkvStorage = getWorkletsBundleModeDemoNativeStorageOnRN();
    const probeKey = `${WORKER_MMKV_KEY_PREFIX}:${Date.now()}:${Math.random()
      .toString(36)
      .slice(2, 10)}`;

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
          storageId: string,
          storageBridge: WorkerMmkvStorageBridge,
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

            storageBridge.set(key, valueWritten);

            const valueReadOnWorker = storageBridge.getString(key);
            const workerContainsKeyAfterWrite = storageBridge.contains(key);

            scheduleOnRN(resolveOnRN, {
              workerRuntimeName,
              storageId,
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
        WORKER_MMKV_STORAGE_ID,
        mmkvStorage,
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
      valueReadOnRN = mmkvStorage.getString(probeKey);
      rnContainsKeyAfterWorkerWrite = mmkvStorage.contains(probeKey);
    } finally {
      try {
        mmkvStorage.delete(probeKey);
        cleanupRemovedKeyOnRN = !mmkvStorage.contains(probeKey);
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
        baseBwsUrl: string,
        clientVersionHeader: string,
        workerRuntimeName: string,
        requestedPageCount: number,
        initialSkipArg: number,
        pageSizeArg: number,
        firstHashHybrid: QuickCryptoHashHybrid,
        signHandleHybrids: QuickCryptoSignHybrid[],
        privateKeyHandle: QuickCryptoKeyObjectHybrid,
        resolveOnRN: (value: WorkerTxHistoryBatchResult) => void,
        rejectOnRNWorklet: (message: string) => void,
      ): void => {
        'worklet';

        ensureSigningGlobalsForWorker();

        (async () => {
          try {
            let session = getWorkerTxHistorySession();

            if (!walletSnapshotsMatch(session?.wallet, workerWallet)) {
              session = setWorkerTxHistorySession(
                createWorkerTxHistorySession(
                  workerWallet,
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
                activeSession.initializedAtMs + activeSession.requestSequence + 1,
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
      BASE_BWS_URL,
      BWC_CLIENT_VERSION_HEADER,
      WORKER_RUNTIME_NAME,
      pageCount,
      initialSkip,
      pageSize,
      signingHybrids.firstHash,
      signingHybrids.signHandles,
      signingHybrids.privateKeyHandle,
      resolve,
      rejectOnRN,
    ).catch(err => {
      reject(toRuntimeError(err));
    });
  });
};
