import {
  createWorkletRuntime,
  getRuntimeKind,
  isRNRuntime,
  isWorkerRuntime,
  runOnRuntimeAsync,
  type WorkletRuntime,
} from 'react-native-worklets';
import * as CWC from '@bitpay-labs/crypto-wallet-core';
import {Buffer as NodeBuffer} from 'buffer';
import processPolyfill from 'process';
import {BASE_BWS_URL} from '../constants/config';

export type RNRuntimeInfo = {
  runtimeKind: number;
  isRNRuntime: boolean;
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
  runtimeKind: number;
  isWorkerRuntime: boolean;
  workerRuntimeName: string;
  initializedAtIso: string;
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

type WorkerTxHistorySession = {
  wallet: WorkletsTxHistoryWalletSnapshot;
  baseBwsUrl: string;
  clientVersionHeader: string;
  workerRuntimeName: string;
  initializedAtIso: string;
  initializedAtMs: number;
  requestSequence: number;
};

const BitcoreLib = (CWC as any).BitcoreLib || (CWC as any).default?.BitcoreLib;
const WORKER_RUNTIME_NAME = 'bitpay-txhistory-worker';
const BWC_CLIENT_VERSION_HEADER = 'bwc-11.7.0';
const DEFAULT_TXHISTORY_LIMIT = 10;
const DEFAULT_TXHISTORY_PAGE_COUNT = 3;
const WORKER_TXHISTORY_SESSION_KEY = '__bitpayTxHistoryWorkerSession';
const TXHISTORY_BASE_PATH = '/v1/txhistory/';

let workletsBundleModeRuntime: WorkletRuntime | undefined;

const normalizePositiveInt = (value: number | undefined, fallback: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  const normalized = Math.max(0, Math.floor(value));
  return normalized > 0 ? normalized : fallback;
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
    requestSequence: session.requestSequence,
    requestContext: {
      basePath: TXHISTORY_BASE_PATH,
      tokenAddress: session.wallet.tokenAddress,
      multisigContractAddress: session.wallet.multisigContractAddress,
    },
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

  return {
    wallet,
    baseBwsUrl,
    clientVersionHeader,
    workerRuntimeName,
    initializedAtIso: new Date().toISOString(),
    initializedAtMs: Date.now(),
    requestSequence: 0,
  };
};

const nextSessionCacheBust = (session: WorkerTxHistorySession): number => {
  'worklet';

  session.requestSequence += 1;
  return session.initializedAtMs + session.requestSequence;
};

const buildTxHistoryRequestPath = (
  wallet: WorkletsTxHistoryWalletSnapshot,
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

const signBwsGetRequest = (requestPath: string, requestPrivKey: string) => {
  'worklet';

  ensureSigningGlobalsForWorker();

  if (!BitcoreLib) {
    throw new Error(
      'crypto-wallet-core BitcoreLib is unavailable inside the worker runtime.',
    );
  }

  const message = `get|${requestPath}|{}`;
  const privateKey = new BitcoreLib.PrivateKey(requestPrivKey);
  const buffer = NodeBuffer.from(message);
  let hash = BitcoreLib.crypto.Hash.sha256sha256(buffer);
  hash = new BitcoreLib.encoding.BufferReader(hash).readReverse();

  return BitcoreLib.crypto.ECDSA.sign(hash, privateKey, {
    endian: 'little',
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

const executeTxHistoryRequestForPrimedWallet = async (
  session: WorkerTxHistorySession,
  pageIndex: number,
  skip: number,
  limit: number,
): Promise<WorkerTxHistoryPageResult> => {
  'worklet';

  const startedAt = Date.now();
  const requestPath = buildTxHistoryRequestPath(
    session.wallet,
    skip,
    limit,
    nextSessionCacheBust(session),
  );
  const signature = signBwsGetRequest(
    requestPath,
    session.wallet.requestPrivKey,
  );

  const response = await fetch(`${session.baseBwsUrl}${requestPath}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'x-client-version': session.clientVersionHeader,
      'x-identity': session.wallet.copayerId,
      'x-signature': signature,
    },
  });

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
}): Promise<{
  session: WorkerTxHistorySessionSummary;
  page: WorkerTxHistoryPageResult;
}> => {
  return runOnRuntimeAsync(
    getWorkletsBundleModeRuntime(),
    async (
      skip: number,
      limit: number,
    ): Promise<{
      session: WorkerTxHistorySessionSummary;
      page: WorkerTxHistoryPageResult;
    }> => {
      'worklet';

      ensureSigningGlobalsForWorker();

      const session = requireWorkerTxHistorySession();
      const page = await executeTxHistoryRequestForPrimedWallet(
        session,
        0,
        skip,
        limit,
      );

      return {
        session: toWorkerTxHistorySessionSummary(session),
        page,
      };
    },
    opts?.skip ?? 0,
    normalizePositiveInt(opts?.limit, DEFAULT_TXHISTORY_LIMIT),
  );
};

export const fetchManyWalletTxHistoryPagesOnWorker = async (opts?: {
  initialSkip?: number;
  pageSize?: number;
  pageCount?: number;
}): Promise<WorkerTxHistoryBatchResult> => {
  return runOnRuntimeAsync(
    getWorkletsBundleModeRuntime(),
    async (
      initialSkip: number,
      pageSize: number,
      pageCount: number,
    ): Promise<WorkerTxHistoryBatchResult> => {
      'worklet';

      ensureSigningGlobalsForWorker();

      const session = requireWorkerTxHistorySession();
      const startedAt = Date.now();
      const pages: WorkerTxHistoryPageResult[] = [];

      let stopReason: 'empty_page' | 'short_page' | 'max_pages_reached' =
        'max_pages_reached';
      let stoppedEarly = false;
      let totalTransactionsAcrossPages = 0;
      let nextSkip = initialSkip;

      for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
        const page = await executeTxHistoryRequestForPrimedWallet(
          session,
          pageIndex,
          nextSkip,
          pageSize,
        );

        pages.push(page);
        totalTransactionsAcrossPages += page.txCount;

        if (page.txCount === 0) {
          stoppedEarly = true;
          stopReason = 'empty_page';
          break;
        }

        if (page.txCount < pageSize) {
          stoppedEarly = true;
          stopReason = 'short_page';
          break;
        }

        nextSkip += pageSize;
      }

      return {
        runtimeKind: getRuntimeKind(),
        isWorkerRuntime: isWorkerRuntime(),
        workerRuntimeName: session.workerRuntimeName,
        fetchedAtIso: new Date().toISOString(),
        totalDurationMs: Date.now() - startedAt,
        requestedPageCount: pageCount,
        executedPageCount: pages.length,
        pageSize,
        initialSkip,
        totalTransactionsAcrossPages,
        stoppedEarly,
        stopReason,
        session: toWorkerTxHistorySessionSummary(session),
        pages,
      };
    },
    Math.max(0, Math.floor(opts?.initialSkip ?? 0)),
    normalizePositiveInt(opts?.pageSize, DEFAULT_TXHISTORY_LIMIT),
    normalizePositiveInt(opts?.pageCount, DEFAULT_TXHISTORY_PAGE_COUNT),
  );
};
