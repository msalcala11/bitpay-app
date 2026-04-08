import {
  createWorkletRuntime,
  getRuntimeKind,
  isRNRuntime,
  isWorkerRuntime,
  runOnRuntimeAsync,
  scheduleOnRN,
  type WorkletRuntime,
} from 'react-native-worklets';
import {Buffer as NodeBuffer} from 'buffer';
import processPolyfill from 'process';
import {BASE_BWS_URL} from '../constants/config';

export type RNRuntimeInfo = {
  runtimeKind: number;
  isRNRuntime: boolean;
};

export type WorkerQuickCryptoHashSmokeTestResult = {
  runtimeKind: number;
  isWorkerRuntime: boolean;
  workerRuntimeName: string;
  executedAtIso: string;
  input: string;
  expectedDigestHex: string;
  digestHex: string;
  matchesExpected: boolean;
  moduleKind: string;
  hasCreateHash: boolean;
  hasInstall: boolean;
  hasSetImmediate: boolean;
  hasProcessNextTick: boolean;
  exportedKeysPreview: string[];
};

export type WorkerTransferredNitroHashSmokeTestResult = {
  runtimeKind: number;
  isWorkerRuntime: boolean;
  workerRuntimeName: string;
  executedAtIso: string;
  input: string;
  expectedDigestHex: string;
  digestHex: string;
  matchesExpected: boolean;
  supportsSha256: boolean;
  opensslVersion?: string;
  hasCreateHash: boolean;
  hasUpdate: boolean;
  hasDigest: boolean;
  hasGetSupportedHashAlgorithms: boolean;
  hasGetOpenSSLVersion: boolean;
};

export type WorkerTransferredNitroBwsSigningSmokeTestResult = {
  runtimeKind: number;
  isWorkerRuntime: boolean;
  workerRuntimeName: string;
  executedAtIso: string;
  requestPath: string;
  requestMethod: 'get';
  signingMessage: string;
  sha256OnceHex: string;
  sha256TwiceHex: string;
  reversedDigestHex: string;
  nitroSignatureHex: string;
  bitcoreSignatureHex: string;
  exactSignatureMatch: boolean;
  bitcoreVerifiedNitroSignature: boolean;
  bitcoreVerifiedBitcoreSignature: boolean;
  derivedRequestPubKey: string;
  requestPubKey?: string;
  requestPubKeyMatchesDerived?: boolean;
  opensslVersion?: string;
};

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
  requestPubKey?: string;
  derivedRequestPubKey?: string;
  requestPubKeyMatchesDerived?: boolean;
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
  runtimeKind: number;
  isWorkerRuntime: boolean;
  workerRuntimeName: string;
  initializedAtIso: string;
  initializedAtMs: number;
  requestSequence: number;
  requestContext: {
    basePath: string;
    tokenAddress?: string;
    multisigContractAddress?: string;
  };
  wallet: WorkerTxHistoryWalletSummary;
};

export type WorkerTxHistoryPageResult = {
  pageIndex: number;
  skip: number;
  limit: number;
  endpoint: string;
  requestPath: string;
  status: number;
  ok: boolean;
  fetchedAtIso: string;
  durationMs: number;
  signaturePreview: string;
  requestPubKeyPreview?: string;
  derivedRequestPubKeyPreview?: string;
  requestPubKeyMatchesDerived?: boolean;
  responseBodyPreview?: string;
  responseBodyType: 'array' | 'object' | 'string' | 'null';
  txCount: number;
  transactionsPreview: WorkerTxHistoryPreviewItem[];
};

export type WorkerTxHistoryBatchResult = {
  runtimeKind: number;
  isWorkerRuntime: boolean;
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

type TxHistoryRequestWalletContext = Pick<
  WorkletsTxHistoryWalletSnapshot,
  'tokenAddress' | 'multisigContractAddress'
>;

type WorkerTxHistoryPreparedRequest = {
  pageIndex: number;
  skip: number;
  limit: number;
  requestPath: string;
  signature: string;
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

type WorkerTxHistoryRequestKeyDetails = {
  requestPubKey?: string;
  derivedRequestPubKey: string;
  requestPubKeyMatchesDerived?: boolean;
};

type NitroModulesLike = {
  createHybridObject<T = unknown>(name: string): T;
};

type QuickCryptoHashHybrid = {
  createHash(algorithm: string, outputLength?: number): void;
  update(data: ArrayBuffer | string): void;
  digest(encoding?: string): ArrayBuffer;
  getSupportedHashAlgorithms(): string[];
  getOpenSSLVersion(): string;
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

type TransferredNitroBwsSigningHybrids = {
  firstHash: QuickCryptoHashHybrid;
  secondHash: QuickCryptoHashHybrid;
  signHandle: QuickCryptoSignHybrid;
  privateKeyHandle: QuickCryptoKeyObjectHybrid;
  opensslVersion?: string;
};

type WorkerTransferredNitroBwsSigningPayload = Omit<
  WorkerTransferredNitroBwsSigningSmokeTestResult,
  | 'bitcoreSignatureHex'
  | 'exactSignatureMatch'
  | 'bitcoreVerifiedNitroSignature'
  | 'bitcoreVerifiedBitcoreSignature'
>;

const WORKER_RUNTIME_NAME = 'bitpay-txhistory-worker';
const BWC_CLIENT_VERSION_HEADER = 'bwc-11.7.0';
const DEFAULT_TXHISTORY_LIMIT = 10;
const DEFAULT_TXHISTORY_PAGE_COUNT = 3;
const WORKER_TXHISTORY_SESSION_KEY = '__bitpayTxHistoryWorkerSession';
const TXHISTORY_BASE_PATH = '/v1/txhistory/';
const QUICK_CRYPTO_SMOKE_TEST_INPUT = 'bitpay-worklets-quickcrypto-smoke-test';
const QUICK_CRYPTO_SMOKE_TEST_EXPECTED_SHA256 =
  '18291c43112406c1e201ab3306a9335ec47eff1bc34bab335757c045f937cddc';
const BWS_SIGNING_SMOKE_TEST_CACHE_BUST = 1700000000000;

let workletsBundleModeRuntime: WorkletRuntime | undefined;

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

const getQuickCryptoForWorker = () => {
  'worklet';

  const importedQuickCrypto = require('react-native-quick-crypto') as any;
  return importedQuickCrypto?.default || importedQuickCrypto;
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

const reverseNodeBuffer = (buffer: Buffer): Buffer => {
  'worklet';

  const clone = NodeBuffer.from(buffer);
  clone.reverse();
  return clone;
};

const buildSecp256k1Sec1PrivateKeyDer = (privateKeyBytes: Buffer): Buffer => {
  if (privateKeyBytes.length !== 32) {
    throw new Error(
      `Expected a 32-byte secp256k1 private key, received ${privateKeyBytes.length} bytes.`,
    );
  }

  return NodeBuffer.concat([
    NodeBuffer.from([
      0x30,
      0x2e,
      0x02,
      0x01,
      0x01,
      0x04,
      0x20,
    ]),
    privateKeyBytes,
    NodeBuffer.from([0xa0, 0x07, 0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x0a]),
  ]);
};

const getRequestPubKeyDetailsOnRN = (
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

const getBwsSigningMessage = (requestPath: string) => {
  'worklet';

  return `get|${requestPath}|{}`;
};

const getBwsSigningDigestDetailsOnRN = (requestPath: string) => {
  const bitcoreLib = getBitcoreLibForRN();
  const signingMessage = getBwsSigningMessage(requestPath);
  const messageBuffer = NodeBuffer.from(signingMessage);
  const sha256Once = NodeBuffer.from(bitcoreLib.crypto.Hash.sha256(messageBuffer));
  const sha256Twice = NodeBuffer.from(bitcoreLib.crypto.Hash.sha256sha256(messageBuffer));
  const reversedDigest = reverseNodeBuffer(sha256Twice);

  return {
    signingMessage,
    sha256Once,
    sha256Twice,
    reversedDigest,
  };
};

const createTransferredNitroBwsSigningHybridsOnRN = (
  requestPrivKey: string,
): TransferredNitroBwsSigningHybrids => {
  const bitcoreLib = getBitcoreLibForRN();
  const {KeyType, KFormatType, KeyEncoding} = getQuickCryptoEnumsForRN();
  const privateKey = new bitcoreLib.PrivateKey(requestPrivKey);
  const privateKeyBytes = NodeBuffer.from(privateKey.toBuffer());
  const sec1Der = buildSecp256k1Sec1PrivateKeyDer(privateKeyBytes);

  const firstHash = createQuickCryptoHashHybridOnRN();
  const secondHash = createQuickCryptoHashHybridOnRN();
  const signHandle = createQuickCryptoSignHybridOnRN();
  const privateKeyHandle = createQuickCryptoKeyObjectHybridOnRN();

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

  return {
    firstHash,
    secondHash,
    signHandle,
    privateKeyHandle,
    opensslVersion:
      typeof firstHash.getOpenSSLVersion === 'function'
        ? firstHash.getOpenSSLVersion()
        : undefined,
  };
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
  requestKey: WorkerTxHistoryRequestKeyDetails,
): WorkerTxHistoryWalletSummary => {
  'worklet';

  return {
    walletId: wallet.walletId,
    walletName: wallet.walletName,
    keyName: wallet.keyName,
    chain: wallet.chain,
    coin: wallet.coin,
    network: wallet.network,
    requestPubKey: requestKey.requestPubKey,
    derivedRequestPubKey: requestKey.derivedRequestPubKey,
    requestPubKeyMatchesDerived: requestKey.requestPubKeyMatchesDerived,
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
      'No wallet txhistory session is initialized on the worker runtime. Prime the worker with a wallet first.',
    );
  }

  return session;
};

const toWorkerTxHistorySessionSummary = (
  session: WorkerTxHistorySession,
): WorkerTxHistorySessionSummary => {
  'worklet';

  return {
    runtimeKind: getRuntimeKind(),
    isWorkerRuntime: isWorkerRuntime(),
    workerRuntimeName: session.workerRuntimeName,
    initializedAtIso: session.initializedAtIso,
    initializedAtMs: session.initializedAtMs,
    requestSequence: session.requestSequence,
    requestContext: {
      basePath: TXHISTORY_BASE_PATH,
      tokenAddress: session.wallet.tokenAddress,
      multisigContractAddress: session.wallet.multisigContractAddress,
    },
    wallet: toWalletSummary(session.wallet, session.requestKey),
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

const signBwsGetRequestOnRN = (requestPath: string, requestPrivKey: string) => {
  const bitcoreLib = getBitcoreLibForRN();

  if (!bitcoreLib?.PrivateKey) {
    throw new Error(
      '@bitpay-labs/bitcore-lib is unavailable on the RN runtime.',
    );
  }

  const message = `get|${requestPath}|{}`;
  const privateKey = new bitcoreLib.PrivateKey(requestPrivKey);
  const buffer = NodeBuffer.from(message);
  let hash = bitcoreLib.crypto.Hash.sha256sha256(buffer);
  hash = new bitcoreLib.encoding.BufferReader(hash).readReverse();

  return bitcoreLib.crypto.ECDSA.sign(hash, privateKey, {
    endian: 'little',
  }).toString();
};

const buildPreparedTxHistoryRequestsForSession = (
  session: WorkerTxHistorySessionSummary,
  requestPrivKey: string,
  initialSkip: number,
  pageSize: number,
  pageCount: number,
): WorkerTxHistoryPreparedRequest[] => {
  const requests: WorkerTxHistoryPreparedRequest[] = [];
  let nextSkip = initialSkip;

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const requestPath = buildTxHistoryRequestPath(
      session.wallet,
      nextSkip,
      pageSize,
      session.initializedAtMs + session.requestSequence + pageIndex + 1,
    );

    let signature: string;
    try {
      signature = signBwsGetRequestOnRN(requestPath, requestPrivKey);
    } catch (err: unknown) {
      throw new Error(
        `RN signing failed for txhistory page ${pageIndex + 1} (${requestPath}). ${
          toRuntimeError(err).message
        }`,
      );
    }

    requests.push({
      pageIndex,
      skip: nextSkip,
      limit: pageSize,
      requestPath,
      signature,
    });

    nextSkip += pageSize;
  }

  return requests;
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

const getResponseBodyType = (payload: unknown) => {
  'worklet';

  if (Array.isArray(payload)) {
    return 'array' as const;
  }
  if (payload === null) {
    return 'null' as const;
  }
  if (typeof payload === 'string') {
    return 'string' as const;
  }
  return 'object' as const;
};

const toResponseBodyPreview = (payload: unknown) => {
  'worklet';

  if (payload == null) {
    return undefined;
  }

  try {
    const serialized =
      typeof payload === 'string' ? payload : JSON.stringify(payload);
    return serialized.length > 1200
      ? `${serialized.slice(0, 1200)}…`
      : serialized;
  } catch {
    return String(payload);
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
  request: WorkerTxHistoryPreparedRequest,
): Promise<WorkerTxHistoryPageResult> => {
  'worklet';

  const startedAt = Date.now();
  const {pageIndex, skip, limit, requestPath, signature} = request;

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
  const parsedBody = tryParseJson(rawResponseText);
  const responseBodyPreview = toResponseBodyPreview(parsedBody);

  if (!response.ok) {
    throw new Error(
      `BWS txhistory request failed with status ${response.status}. ${
        responseBodyPreview || 'Empty response body.'
      }`,
    );
  }

  const transactions = Array.isArray(parsedBody) ? parsedBody : [];

  return {
    pageIndex,
    skip,
    limit,
    endpoint: `${session.baseBwsUrl}${requestPath}`,
    requestPath,
    status: response.status,
    ok: response.ok,
    fetchedAtIso: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    signaturePreview: `${signature.slice(0, 18)}…`,
    requestPubKeyPreview: toHexPreview(session.requestKey.requestPubKey),
    derivedRequestPubKeyPreview: toHexPreview(
      session.requestKey.derivedRequestPubKey,
    ),
    requestPubKeyMatchesDerived:
      session.requestKey.requestPubKeyMatchesDerived,
    responseBodyPreview,
    responseBodyType: getResponseBodyType(parsedBody),
    txCount: transactions.length,
    transactionsPreview: transactions.slice(0, limit).map((tx: any) => {
      return summarizeTx(tx);
    }),
  };
};

export const getWorkletsBundleModeRuntime = (): WorkletRuntime => {
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

export const getRNRuntimeInfo = (): RNRuntimeInfo => ({
  runtimeKind: getRuntimeKind(),
  isRNRuntime: isRNRuntime(),
});

export const runQuickCryptoHashSmokeTestOnWorker = async (): Promise<WorkerQuickCryptoHashSmokeTestResult> => {
  return runOnRuntimeAsync(
    getWorkletsBundleModeRuntime(),
    (
      input: string,
      expectedDigestHex: string,
      workerRuntimeName: string,
    ): WorkerQuickCryptoHashSmokeTestResult => {
      'worklet';

      ensureSigningGlobalsForWorker();

      const globalRef = globalThis as any;
      const hasSetImmediate = typeof globalRef.setImmediate === 'function';
      const hasProcessNextTick =
        typeof globalRef.process?.nextTick === 'function';

      try {
        const quickCrypto = getQuickCryptoForWorker();
        const digestHex = quickCrypto
          .createHash('sha256')
          .update(input)
          .digest('hex');

        return {
          runtimeKind: getRuntimeKind(),
          isWorkerRuntime: isWorkerRuntime(),
          workerRuntimeName,
          executedAtIso: new Date().toISOString(),
          input,
          expectedDigestHex,
          digestHex,
          matchesExpected: digestHex === expectedDigestHex,
          moduleKind: typeof quickCrypto,
          hasCreateHash: typeof quickCrypto?.createHash === 'function',
          hasInstall: typeof quickCrypto?.install === 'function',
          hasSetImmediate,
          hasProcessNextTick,
          exportedKeysPreview: Object.keys(quickCrypto || {}).slice(0, 20),
        };
      } catch (err: unknown) {
        throw new Error(
          `QuickCrypto worker hash smoke test failed. setImmediate=${
            hasSetImmediate ? 'yes' : 'no'
          }, process.nextTick=${
            hasProcessNextTick ? 'yes' : 'no'
          }. ${toWorkerErrorMessage(err)}`,
        );
      }
    },
    QUICK_CRYPTO_SMOKE_TEST_INPUT,
    QUICK_CRYPTO_SMOKE_TEST_EXPECTED_SHA256,
    WORKER_RUNTIME_NAME,
  );
};

export const runTransferredNitroHashSmokeTestOnWorker = async (): Promise<WorkerTransferredNitroHashSmokeTestResult> => {
  let hashHybrid: QuickCryptoHashHybrid;

  try {
    hashHybrid = createQuickCryptoHashHybridOnRN();
  } catch (err: unknown) {
    throw new Error(
      `RN Nitro Hash setup failed before crossing runtimes. ${
        toRuntimeError(err).message
      }`,
    );
  }

  return runOnRuntimeAsync(
    getWorkletsBundleModeRuntime(),
    (
      input: string,
      expectedDigestHex: string,
      workerRuntimeName: string,
      workerHashHybrid: QuickCryptoHashHybrid,
    ): WorkerTransferredNitroHashSmokeTestResult => {
      'worklet';

      ensureSigningGlobalsForWorker();

      const hasCreateHash =
        typeof workerHashHybrid?.createHash === 'function';
      const hasUpdate = typeof workerHashHybrid?.update === 'function';
      const hasDigest = typeof workerHashHybrid?.digest === 'function';
      const hasGetSupportedHashAlgorithms =
        typeof workerHashHybrid?.getSupportedHashAlgorithms === 'function';
      const hasGetOpenSSLVersion =
        typeof workerHashHybrid?.getOpenSSLVersion === 'function';

      try {
        const supportedAlgorithms = hasGetSupportedHashAlgorithms
          ? workerHashHybrid.getSupportedHashAlgorithms()
          : [];
        const supportsSha256 = supportedAlgorithms.includes('sha256');

        if (!hasCreateHash || !hasUpdate || !hasDigest) {
          throw new Error(
            `Transferred Hash hybrid object is missing required methods. createHash=${
              hasCreateHash ? 'yes' : 'no'
            }, update=${hasUpdate ? 'yes' : 'no'}, digest=${
              hasDigest ? 'yes' : 'no'
            }.`,
          );
        }

        workerHashHybrid.createHash('sha256');
        workerHashHybrid.update(input);
        const digestHex = NodeBuffer.from(workerHashHybrid.digest()).toString(
          'hex',
        );

        return {
          runtimeKind: getRuntimeKind(),
          isWorkerRuntime: isWorkerRuntime(),
          workerRuntimeName,
          executedAtIso: new Date().toISOString(),
          input,
          expectedDigestHex,
          digestHex,
          matchesExpected: digestHex === expectedDigestHex,
          supportsSha256,
          opensslVersion: hasGetOpenSSLVersion
            ? workerHashHybrid.getOpenSSLVersion()
            : undefined,
          hasCreateHash,
          hasUpdate,
          hasDigest,
          hasGetSupportedHashAlgorithms,
          hasGetOpenSSLVersion,
        };
      } catch (err: unknown) {
        throw new Error(
          `Transferred Nitro Hash worker smoke test failed. ${toWorkerErrorMessage(
            err,
          )}`,
        );
      }
    },
    QUICK_CRYPTO_SMOKE_TEST_INPUT,
    QUICK_CRYPTO_SMOKE_TEST_EXPECTED_SHA256,
    WORKER_RUNTIME_NAME,
    hashHybrid,
  );
};

export const runTransferredNitroBwsSigningSmokeTestOnWorker = async (
  wallet: WorkletsTxHistoryWalletSnapshot,
): Promise<WorkerTransferredNitroBwsSigningSmokeTestResult> => {
  if (!wallet?.requestPrivKey) {
    throw new Error(
      'A selected wallet with a requestPrivKey is required for the transferred Nitro signing smoke test.',
    );
  }

  const requestPath = buildTxHistoryRequestPath(
    wallet,
    0,
    DEFAULT_TXHISTORY_LIMIT,
    BWS_SIGNING_SMOKE_TEST_CACHE_BUST,
  );
  const requestKey = getRequestPubKeyDetailsOnRN(wallet);
  const bitcoreSignatureHex = signBwsGetRequestOnRN(
    requestPath,
    wallet.requestPrivKey,
  );
  const {sha256Twice} = getBwsSigningDigestDetailsOnRN(requestPath);

  let hybrids: TransferredNitroBwsSigningHybrids;
  try {
    hybrids = createTransferredNitroBwsSigningHybridsOnRN(
      wallet.requestPrivKey,
    );
  } catch (err: unknown) {
    throw new Error(
      `RN Nitro BWS signing setup failed before crossing runtimes. ${
        toRuntimeError(err).message
      }`,
    );
  }

  const workerPayload = await runOnRuntimeAsync(
    getWorkletsBundleModeRuntime(),
    (
      requestPathArg: string,
      requestPubKey: string | undefined,
      derivedRequestPubKey: string,
      requestPubKeyMatchesDerived: boolean | undefined,
      workerRuntimeName: string,
      firstHashHybrid: QuickCryptoHashHybrid,
      secondHashHybrid: QuickCryptoHashHybrid,
      signHandleHybrid: QuickCryptoSignHybrid,
      privateKeyHandle: QuickCryptoKeyObjectHybrid,
      opensslVersion: string | undefined,
    ): WorkerTransferredNitroBwsSigningPayload => {
      'worklet';

      ensureSigningGlobalsForWorker();

      try {
        const signingMessage = getBwsSigningMessage(requestPathArg);

        firstHashHybrid.createHash('sha256');
        firstHashHybrid.update(signingMessage);
        const sha256Once = NodeBuffer.from(firstHashHybrid.digest());

        secondHashHybrid.createHash('sha256');
        secondHashHybrid.update(nodeBufferToArrayBuffer(sha256Once));
        const sha256Twice = NodeBuffer.from(secondHashHybrid.digest());
        const reversedDigest = reverseNodeBuffer(sha256Twice);

        signHandleHybrid.init('');
        signHandleHybrid.update(nodeBufferToArrayBuffer(reversedDigest));
        const nitroSignatureHex = NodeBuffer.from(
          signHandleHybrid.sign(privateKeyHandle, undefined, undefined, 0),
        ).toString('hex');

        return {
          runtimeKind: getRuntimeKind(),
          isWorkerRuntime: isWorkerRuntime(),
          workerRuntimeName,
          executedAtIso: new Date().toISOString(),
          requestPath: requestPathArg,
          requestMethod: 'get',
          signingMessage,
          sha256OnceHex: sha256Once.toString('hex'),
          sha256TwiceHex: sha256Twice.toString('hex'),
          reversedDigestHex: reversedDigest.toString('hex'),
          nitroSignatureHex,
          derivedRequestPubKey,
          requestPubKey,
          requestPubKeyMatchesDerived,
          opensslVersion,
        };
      } catch (err: unknown) {
        throw new Error(
          `Transferred Nitro BWS signing worker smoke test failed. ${toWorkerErrorMessage(
            err,
          )}`,
        );
      }
    },
    requestPath,
    requestKey.requestPubKey,
    requestKey.derivedRequestPubKey,
    requestKey.requestPubKeyMatchesDerived,
    WORKER_RUNTIME_NAME,
    hybrids.firstHash,
    hybrids.secondHash,
    hybrids.signHandle,
    hybrids.privateKeyHandle,
    hybrids.opensslVersion,
  );

  const bitcoreLib = getBitcoreLibForRN();
  const privateKey = new bitcoreLib.PrivateKey(wallet.requestPrivKey);
  const publicKey = privateKey.toPublicKey();
  const nitroSignature = bitcoreLib.crypto.Signature.fromString(
    workerPayload.nitroSignatureHex,
  );
  const bitcoreSignature = bitcoreLib.crypto.Signature.fromString(
    bitcoreSignatureHex,
  );
  const bitcoreVerifiedNitroSignature = bitcoreLib.crypto.ECDSA.verify(
    NodeBuffer.from(sha256Twice),
    nitroSignature,
    publicKey,
    {endian: 'little'},
  );
  const bitcoreVerifiedBitcoreSignature = bitcoreLib.crypto.ECDSA.verify(
    NodeBuffer.from(sha256Twice),
    bitcoreSignature,
    publicKey,
    {endian: 'little'},
  );

  return {
    ...workerPayload,
    bitcoreSignatureHex,
    exactSignatureMatch:
      workerPayload.nitroSignatureHex === bitcoreSignatureHex,
    bitcoreVerifiedNitroSignature,
    bitcoreVerifiedBitcoreSignature,
  };
};

export const primeWalletTxHistoryWorkerSession = async (
  wallet: WorkletsTxHistoryWalletSnapshot,
): Promise<WorkerTxHistorySessionSummary> => {
  return runOnRuntimeAsync(
    getWorkletsBundleModeRuntime(),
    (
      workerWallet: WorkletsTxHistoryWalletSnapshot,
      baseBwsUrl: string,
      clientVersionHeader: string,
      workerRuntimeName: string,
    ): WorkerTxHistorySessionSummary => {
      'worklet';

      const session = createWorkerTxHistorySession(
        workerWallet,
        baseBwsUrl,
        clientVersionHeader,
        workerRuntimeName,
      );

      setWorkerTxHistorySession(session);
      return toWorkerTxHistorySessionSummary(session);
    },
    wallet,
    BASE_BWS_URL,
    BWC_CLIENT_VERSION_HEADER,
    WORKER_RUNTIME_NAME,
  );
};

export const getPrimedWalletTxHistoryWorkerSession = async (): Promise<
  WorkerTxHistorySessionSummary | null
> => {
  return runOnRuntimeAsync(
    getWorkletsBundleModeRuntime(),
    (): WorkerTxHistorySessionSummary | null => {
      'worklet';

      const session = getWorkerTxHistorySession();
      return session ? toWorkerTxHistorySessionSummary(session) : null;
    },
  );
};

export const fetchPrimedWalletTxHistoryPageOnWorker = async (opts?: {
  skip?: number;
  limit?: number;
  wallet?: WorkletsTxHistoryWalletSnapshot;
}): Promise<{
  session: WorkerTxHistorySessionSummary;
  page: WorkerTxHistoryPageResult;
}> => {
  const wallet = opts?.wallet;
  if (!wallet?.requestPrivKey) {
    throw new Error(
      'A selected wallet with a requestPrivKey is required for RN-side txhistory signing.',
    );
  }

  const batchResult = await fetchManyWalletTxHistoryPagesOnWorker({
    wallet,
    initialSkip: opts?.skip,
    pageSize: opts?.limit,
    pageCount: 1,
  });

  const [page] = batchResult.pages;
  if (!page) {
    throw new Error('The worker did not return a txhistory page result.');
  }

  return {
    session: batchResult.session,
    page,
  };
};

export const fetchManyWalletTxHistoryPagesOnWorker = async (opts?: {
  wallet?: WorkletsTxHistoryWalletSnapshot;
  initialSkip?: number;
  pageSize?: number;
  pageCount?: number;
}): Promise<WorkerTxHistoryBatchResult> => {
  const wallet = opts?.wallet;
  if (!wallet?.requestPrivKey) {
    throw new Error(
      'A selected wallet with a requestPrivKey is required for RN-side txhistory signing.',
    );
  }

  const initialSkip = Math.max(0, Math.floor(opts?.initialSkip ?? 0));
  const pageSize = normalizePositiveInt(opts?.pageSize, DEFAULT_TXHISTORY_LIMIT);
  const pageCount = normalizePositiveInt(
    opts?.pageCount,
    DEFAULT_TXHISTORY_PAGE_COUNT,
  );
  const activeSession = await getPrimedWalletTxHistoryWorkerSession();

  if (!activeSession) {
    throw new Error(
      'No wallet txhistory session is initialized on the worker runtime. Prime the worker with a wallet first.',
    );
  }

  const preparedRequests = buildPreparedTxHistoryRequestsForSession(
    activeSession,
    wallet.requestPrivKey,
    initialSkip,
    pageSize,
    pageCount,
  );

  return new Promise((resolve, reject) => {
    const rejectOnRN = (message: string) => {
      reject(new Error(message));
    };

    void runOnRuntimeAsync(
      getWorkletsBundleModeRuntime(),
      (
        signedRequests: WorkerTxHistoryPreparedRequest[],
        requestedPageCount: number,
        initialSkipArg: number,
        pageSizeArg: number,
        resolveOnRN: (value: WorkerTxHistoryBatchResult) => void,
        rejectOnRNWorklet: (message: string) => void,
      ): void => {
        'worklet';

        ensureSigningGlobalsForWorker();

        void (async () => {
          try {
            const session = requireWorkerTxHistorySession();
            const startedAt = Date.now();
            const pages: WorkerTxHistoryPageResult[] = [];

            let stopReason: 'empty_page' | 'short_page' | 'max_pages_reached' =
              'max_pages_reached';
            let stoppedEarly = false;
            let totalTransactionsAcrossPages = 0;

            for (const signedRequest of signedRequests) {
              const expectedRequestPath = buildTxHistoryRequestPath(
                session.wallet,
                signedRequest.skip,
                signedRequest.limit,
                session.initializedAtMs + session.requestSequence + 1,
              );
              if (expectedRequestPath !== signedRequest.requestPath) {
                throw new Error(
                  `Prepared txhistory request path for page ${
                    signedRequest.pageIndex + 1
                  } no longer matches the worker session. Prime the wallet again.`,
                );
              }

              session.requestSequence += 1;

              const page = await executePreparedTxHistoryRequestForPrimedWallet(
                session,
                signedRequest,
              );

              pages.push(page);
              totalTransactionsAcrossPages += page.txCount;

              if (page.txCount === 0) {
                stoppedEarly = true;
                stopReason = 'empty_page';
                break;
              }

              if (page.txCount < signedRequest.limit) {
                stoppedEarly = true;
                stopReason = 'short_page';
                break;
              }
            }

            scheduleOnRN(resolveOnRN, {
              runtimeKind: getRuntimeKind(),
              isWorkerRuntime: isWorkerRuntime(),
              workerRuntimeName: session.workerRuntimeName,
              fetchedAtIso: new Date().toISOString(),
              totalDurationMs: Date.now() - startedAt,
              requestedPageCount,
              executedPageCount: pages.length,
              pageSize: pageSizeArg,
              initialSkip: initialSkipArg,
              totalTransactionsAcrossPages,
              stoppedEarly,
              stopReason,
              session: toWorkerTxHistorySessionSummary(session),
              pages,
            });
          } catch (err: unknown) {
            scheduleOnRN(rejectOnRNWorklet, toWorkerErrorMessage(err));
          }
        })();
      },
      preparedRequests,
      pageCount,
      initialSkip,
      pageSize,
      resolve,
      rejectOnRN,
    ).catch(err => {
      reject(toRuntimeError(err));
    });
  });
};
