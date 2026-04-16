import type {
  WorkerMethod,
  WorkerRequest,
  WorkerResponse,
} from '../../core/engine/workerProtocol';
import type {WalletCredentials, WalletSummary, Tx} from '../../core/types';
import type {
  PrepareWalletSessionResult,
  ProcessNextPageSessionResult,
  FinishWalletSessionResult,
  SnapshotIngestConfig,
} from '../../core/engine/portfolioEngine';
import {
  dedupeTxHistoryPage,
  getTxHistoryLogicalPageSize,
} from '../../core/txHistoryPaging';
import type {BwsConfig} from '../../core/shared/bws';
import {DEFAULT_PORTFOLIO_MMKV_REGISTRY_KEY} from '../../adapters/rn/mmkvKvStore';
import type {WorkletMmkvStorageBridge} from '../../adapters/rn/mmkvKvStore';
import {fetchPortfolioTxHistoryPageByRequest} from '../../adapters/rn/txHistoryRequest';
import {
  appendWorkletSnapshotChunk,
  buildWorkletWalletMetaForStore,
  ensureWorkletWalletIndex,
  updateWorkletSnapshotCheckpoint,
} from './portfolioWorkletSnapshots';
import {
  createPortfolioSnapshotBuilderState,
  getPortfolioSnapshotBuilderCheckpoint,
  portfolioSnapshotBuilderFinish,
  portfolioSnapshotBuilderFlushPendingCarryoverGroup,
  portfolioSnapshotBuilderHasPendingCarryoverGroup,
  portfolioSnapshotBuilderIngestPageWithSnapshotLimit,
  type PortfolioSnapshotBuilderState,
} from './portfolioWorkletSnapshotBuilder';
import {ensureWorkletSnapshotRateSeriesCache} from './portfolioWorkletRates';
import type {PortfolioWorkletKvConfig} from './portfolioWorkletKv';

export type PortfolioPopulateWorkletConfig = {
  storage: WorkletMmkvStorageBridge;
  storageId?: string;
  registryKey?: string;
};

export type PortfolioPopulateWorkletSession = {
  wallet: WalletSummary;
  credentials: WalletCredentials;
  builder: PortfolioSnapshotBuilderState;
  meta: ReturnType<typeof buildWorkletWalletMetaForStore>;
  fetch: {
    cfg: BwsConfig;
    pageSize: number;
    emitRows: number | null;
    pendingTxs: Tx[];
  };
};

export type PortfolioPopulateWorkletState = {
  sessionsByWalletId: Record<string, PortfolioPopulateWorkletSession | undefined>;
  serialTail?: Promise<void>;
  storageId?: string;
  registryKey?: string;
};

type GlobalWithPortfolioPopulateState = typeof globalThis & {
  __bitpayPortfolioPopulateWorkletStateV1__?: PortfolioPopulateWorkletState;
};

const PORTFOLIO_POPULATE_STATE_GLOBAL_KEY =
  '__bitpayPortfolioPopulateWorkletStateV1__';

export function getOrCreatePortfolioPopulateWorkletState(
  config: PortfolioPopulateWorkletConfig,
): PortfolioPopulateWorkletState {
  'worklet';

  const globalWithState = globalThis as GlobalWithPortfolioPopulateState;
  const normalizedRegistryKey =
    config.registryKey || DEFAULT_PORTFOLIO_MMKV_REGISTRY_KEY;
  const existing = globalWithState[PORTFOLIO_POPULATE_STATE_GLOBAL_KEY];

  if (existing) {
    const sameStorageId = existing.storageId === config.storageId;
    const sameRegistryKey = existing.registryKey === normalizedRegistryKey;
    if (!sameStorageId || !sameRegistryKey) {
      throw new Error(
        'Portfolio populate worklet is already initialized with a different MMKV configuration.',
      );
    }
    return existing;
  }

  const created: PortfolioPopulateWorkletState = {
    sessionsByWalletId: {},
    storageId: config.storageId,
    registryKey: normalizedRegistryKey,
  };

  globalWithState[PORTFOLIO_POPULATE_STATE_GLOBAL_KEY] = created;
  return created;
}

function getKvConfig(
  config: PortfolioPopulateWorkletConfig,
): PortfolioWorkletKvConfig {
  'worklet';

  return {
    storage: config.storage,
    registryKey: config.registryKey,
  };
}

export function runSerialOnPopulateWorklet<T>(
  state: PortfolioPopulateWorkletState,
  task: () => Promise<T>,
): Promise<T> {
  'worklet';

  const tail = state.serialTail || Promise.resolve();
  const next = tail.then(task, task);
  state.serialTail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function isFinitePositiveInteger(value: unknown): boolean {
  'worklet';
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function normalizeEmitRows(value: unknown): number | null {
  'worklet';

  if (!isFinitePositiveInteger(value)) {
    return null;
  }
  return Math.trunc(Number(value));
}

function requireSession(
  state: PortfolioPopulateWorkletState,
  walletId: string,
): PortfolioPopulateWorkletSession {
  'worklet';

  const session = state.sessionsByWalletId[walletId];
  if (!session) {
    throw new Error(`Wallet session not prepared for background fetch: ${walletId}`);
  }
  return session;
}

export async function handlePrepareWalletOnPopulateWorklet(
  config: PortfolioPopulateWorkletConfig,
  state: PortfolioPopulateWorkletState,
  params: {
    cfg: BwsConfig;
    wallet: WalletSummary;
    credentials: WalletCredentials;
    ingest: SnapshotIngestConfig;
    pageSize: number;
    emitRows?: number;
  },
): Promise<PrepareWalletSessionResult> {
  'worklet';

  const meta = buildWorkletWalletMetaForStore({
    wallet: params.wallet,
    credentials: params.credentials as any,
    quoteCurrency: params.ingest.quoteCurrency,
    compressionEnabled: params.ingest.compressionEnabled,
    chunkRows: params.ingest.chunkRows,
    snapshotDebugMode: params.ingest.snapshotDebugMode ?? 'none',
  });

  const kvConfig = getKvConfig(config);
  const index = await ensureWorkletWalletIndex(kvConfig, meta);
  const fiatRateSeriesCache = await ensureWorkletSnapshotRateSeriesCache({
    ...kvConfig,
    cfg: params.cfg,
    quoteCurrency: params.ingest.quoteCurrency,
    wallet: params.wallet,
  });

  const builder = createPortfolioSnapshotBuilderState({
    wallet: params.wallet,
    credentials: params.credentials as any,
    quoteCurrency: params.ingest.quoteCurrency,
    fiatRateSeriesCache,
    compressionEnabled: params.ingest.compressionEnabled,
    snapshotDebugMode: meta.snapshotDebugMode ?? 'none',
    checkpoint: index.checkpoint,
  });

  state.sessionsByWalletId[params.wallet.walletId] = {
    wallet: params.wallet,
    credentials: params.credentials,
    builder,
    meta,
    fetch: {
      cfg: params.cfg,
      pageSize: Math.max(1, Math.trunc(Number(params.pageSize || 1))),
      emitRows: normalizeEmitRows(params.emitRows),
      pendingTxs: [],
    },
  };

  return {
    checkpoint: getPortfolioSnapshotBuilderCheckpoint(builder),
  };
}

export async function handleCloseWalletSessionOnPopulateWorklet(
  state: PortfolioPopulateWorkletState,
  walletId: string,
): Promise<void> {
  'worklet';

  delete state.sessionsByWalletId[walletId];
}

export async function handleProcessNextPageOnPopulateWorklet(
  config: PortfolioPopulateWorkletConfig,
  state: PortfolioPopulateWorkletState,
  walletId: string,
): Promise<ProcessNextPageSessionResult> {
  'worklet';

  const session = requireSession(state, walletId);
  const checkpoint = getPortfolioSnapshotBuilderCheckpoint(session.builder);
  const skip = checkpoint.nextSkip;
  const kvConfig = getKvConfig(config);

  while (true) {
    let txs = session.fetch.pendingTxs;
    let fetchedTxs = 0;
    let fetchMs = 0;

    if (!txs.length) {
      const fetchStartedAt = Date.now();
      txs = await fetchPortfolioTxHistoryPageByRequest({
        credentials: session.credentials,
        cfg: session.fetch.cfg,
        skip,
        limit: session.fetch.pageSize,
        reverse: true,
      });
      fetchMs = Math.max(0, Date.now() - fetchStartedAt);
      fetchedTxs = txs.length;
      session.fetch.pendingTxs = dedupeTxHistoryPage(txs);

      const logicalPageSize = txs.length ? getTxHistoryLogicalPageSize(txs) : 0;
      if (!txs.length || logicalPageSize <= 0) {
        session.fetch.pendingTxs = [];
        if (portfolioSnapshotBuilderHasPendingCarryoverGroup(session.builder)) {
          const computeStartedAt = Date.now();
          const snapshots = portfolioSnapshotBuilderFlushPendingCarryoverGroup(
            session.builder,
          );
          const nextCheckpoint = getPortfolioSnapshotBuilderCheckpoint(
            session.builder,
          );
          if (snapshots.length) {
            await appendWorkletSnapshotChunk({
              ...kvConfig,
              meta: session.meta,
              snapshots,
              checkpoint: nextCheckpoint,
            });
          } else {
            await updateWorkletSnapshotCheckpoint({
              ...kvConfig,
              walletId,
              checkpoint: nextCheckpoint,
            });
          }
          return {
            checkpoint: nextCheckpoint,
            appendedSnapshots: snapshots.length,
            fetchedTxs,
            logicalPageSize,
            done: true,
            fetchMs,
            computeMs: Math.max(0, Date.now() - computeStartedAt),
          };
        }

        return {
          checkpoint: getPortfolioSnapshotBuilderCheckpoint(session.builder),
          appendedSnapshots: 0,
          fetchedTxs,
          logicalPageSize,
          done: true,
          fetchMs,
          computeMs: 0,
        };
      }
    }

    const computeStartedAt = Date.now();
    const consumed = portfolioSnapshotBuilderIngestPageWithSnapshotLimit(
      session.builder,
      session.fetch.pendingTxs,
      session.fetch.emitRows ?? undefined,
    );
    const nextCheckpoint = getPortfolioSnapshotBuilderCheckpoint(session.builder);

    if (consumed.snapshots.length) {
      await appendWorkletSnapshotChunk({
        ...kvConfig,
        meta: session.meta,
        snapshots: consumed.snapshots,
        checkpoint: nextCheckpoint,
      });
    } else if (consumed.logicalPageSize > 0) {
      await updateWorkletSnapshotCheckpoint({
        ...kvConfig,
        walletId,
        checkpoint: nextCheckpoint,
      });
    }

    const consumedRawCount = Math.max(
      0,
      Math.min(
        session.fetch.pendingTxs.length,
        Number(consumed.consumedRawCount ?? 0),
      ),
    );
    session.fetch.pendingTxs =
      consumedRawCount > 0
        ? session.fetch.pendingTxs.slice(consumedRawCount)
        : [];

    if (!consumed.logicalPageSize && !consumed.snapshots.length) {
      if (!session.fetch.pendingTxs.length) {
        continue;
      }
    }

    return {
      checkpoint: nextCheckpoint,
      appendedSnapshots: consumed.snapshots.length,
      fetchedTxs,
      logicalPageSize: consumed.logicalPageSize,
      done: false,
      fetchMs,
      computeMs: Math.max(0, Date.now() - computeStartedAt),
    };
  }
}

export async function handleFinishWalletOnPopulateWorklet(
  config: PortfolioPopulateWorkletConfig,
  state: PortfolioPopulateWorkletState,
  walletId: string,
): Promise<FinishWalletSessionResult> {
  'worklet';

  const session = requireSession(state, walletId);
  const snapshots = portfolioSnapshotBuilderFinish(session.builder);
  const checkpoint = getPortfolioSnapshotBuilderCheckpoint(session.builder);
  const kvConfig = getKvConfig(config);

  if (snapshots.length) {
    await appendWorkletSnapshotChunk({
      ...kvConfig,
      meta: session.meta,
      snapshots,
      checkpoint,
    });
  } else {
    await updateWorkletSnapshotCheckpoint({
      ...kvConfig,
      walletId,
      checkpoint,
    });
  }

  delete state.sessionsByWalletId[walletId];

  return {
    checkpoint,
    appendedSnapshots: snapshots.length,
  };
}

export function canHandlePortfolioPopulateRequestOnRuntime(
  method: WorkerMethod,
): boolean {
  'worklet';

  return (
    method === 'snapshots.prepareWallet' ||
    method === 'snapshots.processNextPage' ||
    method === 'snapshots.finishWallet' ||
    method === 'snapshots.closeWalletSession'
  );
}

export async function handlePortfolioPopulateRequestOnRuntime(
  config: PortfolioPopulateWorkletConfig,
  request: WorkerRequest,
): Promise<WorkerResponse> {
  'worklet';

  const state = getOrCreatePortfolioPopulateWorkletState(config);

  return runSerialOnPopulateWorklet(state, async () => {
    try {
      switch (request.method) {
        case 'snapshots.prepareWallet': {
          const result = await handlePrepareWalletOnPopulateWorklet(
            config,
            state,
            request.params as any,
          );
          return {
            id: request.id,
            ok: true,
            result,
          } as WorkerResponse;
        }

        case 'snapshots.closeWalletSession': {
          await handleCloseWalletSessionOnPopulateWorklet(
            state,
            String((request.params as any)?.walletId || ''),
          );
          return {
            id: request.id,
            ok: true,
            result: undefined,
          } as WorkerResponse;
        }

        case 'snapshots.processNextPage': {
          const result = await handleProcessNextPageOnPopulateWorklet(
            config,
            state,
            String((request.params as any)?.walletId || ''),
          );
          return {
            id: request.id,
            ok: true,
            result,
          } as WorkerResponse;
        }

        case 'snapshots.finishWallet': {
          const result = await handleFinishWalletOnPopulateWorklet(
            config,
            state,
            String((request.params as any)?.walletId || ''),
          );
          return {
            id: request.id,
            ok: true,
            result,
          } as WorkerResponse;
        }

        default:
          throw new Error(
            `Unsupported portfolio populate worklet method: ${String(
              request.method,
            )}`,
          );
      }
    } catch (error: unknown) {
      const runtimeError =
        error instanceof Error ? error : new Error(String(error));
      return {
        id: request.id,
        ok: false,
        error: runtimeError.message || String(runtimeError),
        stack: runtimeError.stack,
      } as WorkerResponse;
    }
  });
}
