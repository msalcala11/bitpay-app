import type {KvStore} from '../kv/types';
import type {BwsConfig} from '../shared/bws';
import type {
  FiatRateAssetRef,
  FiatRateCacheRequest,
  FiatRateInterval,
  FiatRatePoint,
  FiatRateSeriesCache,
} from '../fiatRatesShared';
import {
  CANONICAL_FIAT_QUOTE,
  DEFAULT_STORED_FIAT_RATE_INTERVALS,
  FX_BRIDGE_COIN,
  getFiatRateSeriesCacheKey,
  normalizeFiatRateSeriesChain,
  normalizeFiatRateSeriesTokenAddress,
  resolveStoredFiatRateInterval,
} from '../fiatRatesShared';
import type {
  StoredWallet,
  Tx,
  WalletCredentials,
  WalletSummary,
} from '../types';
import {
  BalanceSnapshotStreamBuilder,
  type SnapshotStreamCheckpoint,
} from '../pnl/snapshotStream';
import {SnapshotStore} from '../pnl/snapshotStore';
import type {
  SnapshotIndexV2,
  SnapshotPersistDebugMode,
  SnapshotStoreWalletMeta,
} from '../pnl/snapshotStore';
import {buildWalletMetaForStore} from '../pnl/snapshotStore';
import type {SnapshotInvalidHistoryMarkerV1} from '../pnl/invalidHistory';
import {
  isSnapshotInvalidHistoryError,
  toSnapshotInvalidHistoryMarker,
} from '../pnl/invalidHistory';
import {
  FiatRateStore,
  parseStoredFiatRateSeries,
  type FiatRateProvider,
} from '../pnl/fiatRateStore';
import {
  buildPnlAnalysisChartSeriesFromStreamed,
  buildPnlAnalysisSeriesFromStreamed,
  buildPnlAnalysisSeriesFromPreloaded,
  resolvePnlAnalysisPreloadWindow,
  type PnlTimeframe,
  type PnlAnalysisChartResult,
  type PnlAnalysisResult,
  type ResolvedPnlAnalysisPreloadWindow,
  type WalletForAnalysisMeta,
  type WalletForStreamedAnalysis,
} from '../pnl/analysisStreaming';
import {getAssetIdFromWallet} from '../pnl/assetId';
import type {BalanceSnapshotStored} from '../pnl/types';
import {getFiatRateAssetRef, normalizeFiatRateSeriesCoin} from '../pnl/rates';
import {
  dedupeTxHistoryPage,
  getTxHistoryLogicalPageSize,
} from '../txHistoryPaging';

export type SnapshotIngestConfig = {
  quoteCurrency: string;
  compressionEnabled: boolean;
  chunkRows: number;
  snapshotDebugMode?: SnapshotPersistDebugMode;
};

export type PrepareWalletSessionResult = {
  checkpoint: SnapshotStreamCheckpoint;
};

export type FinishWalletSessionResult = {
  checkpoint: SnapshotStreamCheckpoint;
  appendedSnapshots: number;
};

export type ProcessNextPageSessionResult = {
  checkpoint: SnapshotStreamCheckpoint;
  appendedSnapshots: number;
  fetchedTxs: number;
  logicalPageSize: number;
  done: boolean;
  fetchMs: number;
  computeMs: number;
};

export type ComputeAnalysisArgs = {
  cfg: BwsConfig;
  wallets: StoredWallet[];
  quoteCurrency: string;
  timeframe: PnlTimeframe;
  nowMs?: number;
  maxPoints?: number;
  currentRatesByAssetId?: Record<string, number>;
};

type PreparedStreamedAnalysisInputs = {
  quoteCurrency: string;
  firstNonZeroTs: number | null;
  resolved: ResolvedPnlAnalysisPreloadWindow;
  wallets: WalletForStreamedAnalysis[];
};

function buildEmptyPreparedStreamedAnalysisInputs(args: {
  quoteCurrency: string;
  timeframe: ComputeAnalysisArgs['timeframe'];
  nowMs: ComputeAnalysisArgs['nowMs'];
  maxPoints: ComputeAnalysisArgs['maxPoints'];
}): PreparedStreamedAnalysisInputs {
  return {
    quoteCurrency: args.quoteCurrency,
    firstNonZeroTs: null,
    resolved: resolvePnlAnalysisPreloadWindow({
      cfg: {quoteCurrency: args.quoteCurrency},
      wallets: [],
      timeframe: args.timeframe,
      ratePointsByAssetId: {},
      nowMs: args.nowMs,
      maxPoints: args.maxPoints,
    }),
    wallets: [],
  };
}

export type TxHistoryPageFetcher = (args: {
  credentials: WalletCredentials;
  cfg: BwsConfig;
  skip: number;
  limit: number;
  reverse?: boolean;
}) => Promise<Tx[]>;

export type KvStats = {
  totalKeys: number;
  totalBytes: number;
  snapKeys: number;
  snapBytes: number;
  rateKeys: number;
  rateBytes: number;
  otherKeys: number;
  otherBytes: number;
};

type MeasureNow = () => number;

type GlobalRuntimePrimitives = typeof globalThis & {
  performance?: {now?: () => number};
  TextEncoder?: new () => {encode(input: string): Uint8Array};
};

function defaultMeasureNow(): MeasureNow {
  const perf = (globalThis as GlobalRuntimePrimitives).performance;
  const perfNow = typeof perf?.now === 'function' ? perf.now.bind(perf) : null;
  return typeof perfNow === 'function' ? perfNow : () => Date.now();
}

export type PortfolioEngineOptions = {
  rateProvider?: FiatRateProvider;
  txHistoryPageFetcher?: TxHistoryPageFetcher;
  measureNow?: MeasureNow;
};

export class PortfolioEngine {
  readonly snapshotStore: SnapshotStore;
  readonly rateStore: FiatRateStore;

  private kv: KvStore;
  private txHistoryPageFetcher: TxHistoryPageFetcher | null;
  private measureNow: MeasureNow;

  private builders = new Map<string, BalanceSnapshotStreamBuilder>();
  private sessionMetaByWalletId = new Map<string, SnapshotStoreWalletMeta>();
  private sessionFetchByWalletId = new Map<
    string,
    {
      credentials: WalletCredentials;
      cfg: BwsConfig;
      pageSize: number;
      emitRows: number | null;
      pendingTxs: Tx[];
    }
  >();

  constructor(kv: KvStore, opts?: PortfolioEngineOptions) {
    this.kv = kv;
    this.snapshotStore = new SnapshotStore(kv);
    this.rateStore = new FiatRateStore(kv, {provider: opts?.rateProvider});
    this.txHistoryPageFetcher = opts?.txHistoryPageFetcher ?? null;
    this.measureNow = opts?.measureNow ?? defaultMeasureNow();
  }

  async ensureRates(args: {
    cfg: BwsConfig;
    quoteCurrency: string;
    interval: FiatRateInterval;
    coins: string[];
    assets?: FiatRateAssetRef[];
    maxAgeMs?: number;
    force?: boolean;
  }): Promise<void> {
    await this.rateStore.ensureRates({
      cfg: args.cfg,
      quoteCurrency: args.quoteCurrency,
      interval: args.interval,
      coins: args.coins,
      assets: args.assets,
      maxAgeMs: args.maxAgeMs,
      force: args.force,
    });
  }

  async getRateSeriesCache(args: {
    cfg: BwsConfig;
    quoteCurrency: string;
    requests: FiatRateCacheRequest[];
    maxAgeMs?: number;
    force?: boolean;
  }): Promise<FiatRateSeriesCache> {
    const quoteCurrency = String(args.quoteCurrency || 'USD').toUpperCase();
    const requests = Array.isArray(args.requests) ? args.requests : [];
    const assetsByInterval = new Map<
      FiatRateInterval,
      {coins: Set<string>; assets: Map<string, FiatRateAssetRef>}
    >();
    const cacheReads: Array<{
      coin: string;
      interval: FiatRateInterval;
      chain?: string;
      tokenAddress?: string;
    }> = [];
    const seenReads = new Set<string>();

    for (const request of requests) {
      const asset = getFiatRateAssetRef({
        currencyAbbreviation: request?.coin,
        chain: request?.chain,
        tokenAddress: request?.tokenAddress,
      });
      const intervals = Array.from(
        new Set(
          (Array.isArray(request?.intervals) ? request.intervals : []).map(
            resolveStoredFiatRateInterval,
          ),
        ),
      );

      if (!asset.coin || !intervals.length) {
        continue;
      }

      for (const interval of intervals) {
        const bucket = assetsByInterval.get(interval) ?? {
          coins: new Set<string>(),
          assets: new Map<string, FiatRateAssetRef>(),
        };
        assetsByInterval.set(interval, bucket);

        if (asset.tokenAddress) {
          const assetKey = `${asset.coin}|${asset.chain || ''}|${
            asset.tokenAddress
          }`;
          bucket.assets.set(assetKey, asset);
        } else {
          bucket.coins.add(asset.coin);
        }

        const readKey = getFiatRateSeriesCacheKey(
          quoteCurrency,
          asset.coin,
          interval,
          {
            chain: asset.chain,
            tokenAddress: asset.tokenAddress,
          },
        );
        if (seenReads.has(readKey)) {
          continue;
        }
        seenReads.add(readKey);
        cacheReads.push({
          coin: asset.coin,
          interval,
          chain: asset.chain,
          tokenAddress: asset.tokenAddress,
        });
      }
    }

    for (const [interval, bucket] of assetsByInterval.entries()) {
      await this.rateStore.ensureRates({
        cfg: args.cfg,
        quoteCurrency,
        interval,
        coins: Array.from(bucket.coins).sort((a, b) => a.localeCompare(b)),
        assets: Array.from(bucket.assets.values()).sort((a, b) =>
          `${a.coin}|${a.chain || ''}|${a.tokenAddress || ''}`.localeCompare(
            `${b.coin}|${b.chain || ''}|${b.tokenAddress || ''}`,
          ),
        ),
        maxAgeMs: args.maxAgeMs,
        force: args.force,
      });
    }

    const cache: FiatRateSeriesCache = {};
    for (const read of cacheReads) {
      const series = await this.rateStore.getSeriesWithFx({
        quoteCurrency,
        coin: read.coin,
        interval: read.interval,
        chain: read.chain,
        tokenAddress: read.tokenAddress,
      });
      if (!series?.points?.length) {
        continue;
      }
      cache[
        getFiatRateSeriesCacheKey(quoteCurrency, read.coin, read.interval, {
          chain: read.chain,
          tokenAddress: read.tokenAddress,
        })
      ] = series;
    }

    return cache;
  }

  async getSnapshotIndex(walletId: string): Promise<SnapshotIndexV2 | null> {
    return this.snapshotStore.loadIndex(walletId);
  }

  async getInvalidHistoryMarker(
    walletId: string,
  ): Promise<SnapshotInvalidHistoryMarkerV1 | null> {
    return this.snapshotStore.loadInvalidHistoryMarker(walletId);
  }

  async clearWallet(walletId: string): Promise<void> {
    this.builders.delete(walletId);
    this.sessionMetaByWalletId.delete(walletId);
    this.sessionFetchByWalletId.delete(walletId);
    await this.snapshotStore.clearWallet(walletId);
  }

  /** Harness/debug helper: clears ALL persistent portfolio data (rates + snapshots). */
  async clearAllData(): Promise<void> {
    this.builders.clear();
    this.sessionMetaByWalletId.clear();
    this.sessionFetchByWalletId.clear();
    this.snapshotStore.clearMemoryCache();
    this.rateStore.clearMemoryCache();
    await this.kv.clearAll();
  }

  /** Harness/debug helper: clears cached fiat-rate series while leaving snapshots intact. */
  async clearRates(args?: {quoteCurrency?: string}): Promise<void> {
    const quote = args?.quoteCurrency ? args.quoteCurrency.toUpperCase() : null;
    const prefix = quote ? `rate:v1:${quote}:` : 'rate:v1:';
    const keys = await this.kv.listKeys(prefix);

    this.rateStore.clearMemoryCache();
    for (const key of keys) {
      await this.kv.delete(key);
    }
  }

  /** Harness/debug helper: lists cached fiat-rate series stored in KV. */
  async listCachedRates(args?: {quoteCurrency?: string}): Promise<
    Array<{
      key: string;
      quoteCurrency: string;
      coin: string;
      interval: FiatRateInterval;
      fetchedOn: number;
      points: number;
      firstTs: number | null;
      lastTs: number | null;
      bytes: number;
    }>
  > {
    const quote = args?.quoteCurrency ? args.quoteCurrency.toUpperCase() : null;
    const prefix = quote ? `rate:v1:${quote}:` : 'rate:v1:';
    const keys = (await this.kv.listKeys(prefix)).sort();

    const TextEncoderCtor = (globalThis as GlobalRuntimePrimitives).TextEncoder;
    const enc = TextEncoderCtor ? new TextEncoderCtor() : null;
    const byteLen = (s: string): number => {
      if (!s) return 0;
      try {
        return enc ? enc.encode(s).length : s.length;
      } catch {
        return s.length;
      }
    };

    const out: Array<{
      key: string;
      quoteCurrency: string;
      coin: string;
      interval: FiatRateInterval;
      fetchedOn: number;
      points: number;
      firstTs: number | null;
      lastTs: number | null;
      bytes: number;
    }> = [];

    for (const key of keys) {
      const raw = await this.kv.getString(key);
      if (!raw) continue;
      const bytes = byteLen(raw);
      const series = parseStoredFiatRateSeries(raw);
      if (!series) continue;

      // rate:v1:<QUOTE>:<coin>:<interval>
      const parts = key.split(':');
      const quoteCurrency = parts[2] ?? '';
      const coin = parts[3] ?? '';
      const interval = (parts[4] ?? '') as FiatRateInterval;

      const pts = Array.isArray(series.points) ? series.points : [];
      const firstTs = pts.length ? Number(pts[0].ts) : null;
      const lastTs = pts.length ? Number(pts[pts.length - 1].ts) : null;

      out.push({
        key,
        quoteCurrency,
        coin,
        interval,
        fetchedOn: Number(series.fetchedOn ?? 0),
        points: pts.length,
        firstTs: Number.isFinite(firstTs as any) ? firstTs : null,
        lastTs: Number.isFinite(lastTs as any) ? lastTs : null,
        bytes,
      });
    }

    return out;
  }

  /** Harness/debug helper: returns approximate key count + bytes for the whole KV store. */
  async getKvStats(): Promise<KvStats> {
    // Prefer a KV-native fast path when available (IdbKvStore.stats).
    const kvAny = this.kv as any;
    if (typeof kvAny?.stats === 'function') {
      return (await kvAny.stats()) as KvStats;
    }

    const keys = await this.kv.listKeys();
    const out: KvStats = {
      totalKeys: keys.length,
      totalBytes: 0,
      snapKeys: 0,
      snapBytes: 0,
      rateKeys: 0,
      rateBytes: 0,
      otherKeys: 0,
      otherBytes: 0,
    };

    for (const k of keys) {
      const raw = await this.kv.getString(k);
      const bytes = raw ? raw.length : 0;
      out.totalBytes += bytes;
      if (k.startsWith('snap:')) {
        out.snapKeys += 1;
        out.snapBytes += bytes;
      } else if (k.startsWith('rate:')) {
        out.rateKeys += 1;
        out.rateBytes += bytes;
      } else {
        out.otherKeys += 1;
        out.otherBytes += bytes;
      }
    }

    return out;
  }

  private async buildSnapshotRateSeriesCache(args: {
    cfg: BwsConfig;
    quoteCurrency: string;
    wallet: WalletSummary;
  }): Promise<FiatRateSeriesCache> {
    const quoteCurrency = String(args.quoteCurrency || 'USD').toUpperCase();
    const coin = normalizeFiatRateSeriesCoin(args.wallet.currencyAbbreviation);
    const chain = normalizeFiatRateSeriesChain(args.wallet.chain);
    const tokenAddress = normalizeFiatRateSeriesTokenAddress(
      chain,
      args.wallet.tokenAddress,
    );
    const storedIntervals = Array.from(
      new Set(
        DEFAULT_STORED_FIAT_RATE_INTERVALS.map(resolveStoredFiatRateInterval),
      ),
    );

    for (const interval of storedIntervals) {
      await this.rateStore.ensureRates({
        cfg: args.cfg,
        quoteCurrency,
        interval,
        coins: tokenAddress ? [] : [coin],
        assets: tokenAddress ? [{coin, chain, tokenAddress}] : undefined,
      });
    }

    const cache: FiatRateSeriesCache = {};
    for (const interval of storedIntervals) {
      const series = await this.rateStore.getSeries({
        quoteCurrency,
        coin,
        interval,
        chain,
        tokenAddress,
      });
      if (!series) continue;
      cache[
        getFiatRateSeriesCacheKey(quoteCurrency, coin, interval, {
          chain,
          tokenAddress,
        })
      ] = series;
    }
    return cache;
  }

  private async findFirstNonZeroBalanceTs(
    walletIds: string[],
  ): Promise<number | null> {
    let best: number | null = null;
    for (const walletId of walletIds) {
      const idx = await this.snapshotStore.loadIndex(walletId);
      const ts = idx?.checkpoint?.firstNonZeroTs;
      if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) continue;
      if (best === null || ts < best) best = ts;
    }
    return best;
  }

  async prepareWalletSession(args: {
    wallet: WalletSummary;
    credentials: WalletCredentials;
    ingest: SnapshotIngestConfig;
    checkpoint?: SnapshotStreamCheckpoint | null;
    fiatRateSeriesCache?: FiatRateSeriesCache;
    fetch?: {
      cfg: BwsConfig;
      pageSize: number;
      emitRows?: number;
    };
  }): Promise<PrepareWalletSessionResult> {
    const meta = buildWalletMetaForStore({
      wallet: args.wallet,
      credentials: args.credentials as any,
      quoteCurrency: args.ingest.quoteCurrency,
      compressionEnabled: args.ingest.compressionEnabled,
      chunkRows: args.ingest.chunkRows,
      snapshotDebugMode: args.ingest.snapshotDebugMode ?? 'none',
    });
    const index = await this.snapshotStore.ensureWalletIndex(meta);
    const fiatRateSeriesCache =
      args.fiatRateSeriesCache ??
      (args.fetch
        ? await this.buildSnapshotRateSeriesCache({
            cfg: args.fetch.cfg,
            quoteCurrency: args.ingest.quoteCurrency,
            wallet: args.wallet,
          })
        : null);
    if (!fiatRateSeriesCache) {
      throw new Error(
        'prepareWalletSession requires either a fiatRateSeriesCache or fetch config.',
      );
    }

    const builder = new BalanceSnapshotStreamBuilder({
      wallet: args.wallet,
      credentials: args.credentials as any,
      quoteCurrency: args.ingest.quoteCurrency,
      fiatRateSeriesCache,
      compressionEnabled: args.ingest.compressionEnabled,
      snapshotDebugMode: meta.snapshotDebugMode ?? 'none',
      checkpoint:
        args.checkpoint === undefined ? index.checkpoint : args.checkpoint,
    });

    this.builders.set(args.wallet.walletId, builder);
    this.sessionMetaByWalletId.set(args.wallet.walletId, meta);
    if (args.fetch) {
      this.sessionFetchByWalletId.set(args.wallet.walletId, {
        credentials: args.credentials,
        cfg: args.fetch.cfg,
        pageSize: args.fetch.pageSize,
        emitRows:
          Number.isFinite(Number(args.fetch.emitRows)) &&
          Number(args.fetch.emitRows) > 0
            ? Math.trunc(Number(args.fetch.emitRows))
            : null,
        pendingTxs: [],
      });
    } else {
      this.sessionFetchByWalletId.delete(args.wallet.walletId);
    }
    return {checkpoint: builder.getCheckpoint()};
  }

  async closeWalletSession(walletId: string): Promise<void> {
    this.builders.delete(walletId);
    this.sessionMetaByWalletId.delete(walletId);
    this.sessionFetchByWalletId.delete(walletId);
  }

  private async handleInvalidHistoryError(
    walletId: string,
    error: unknown,
  ): Promise<void> {
    if (!isSnapshotInvalidHistoryError(error)) {
      return;
    }

    const marker = toSnapshotInvalidHistoryMarker({
      walletId,
      error,
    });
    if (marker) {
      await this.snapshotStore.saveInvalidHistoryMarker(marker);
    }
    await this.snapshotStore.clearWallet(walletId, {
      preserveInvalidHistoryMarker: true,
    });
    await this.closeWalletSession(walletId);
  }

  async processNextPageSession(
    walletId: string,
  ): Promise<ProcessNextPageSessionResult> {
    try {
      const builder = this.builders.get(walletId);
      const meta = this.sessionMetaByWalletId.get(walletId);
      const fetchCfg = this.sessionFetchByWalletId.get(walletId);
      if (!builder || !meta || !fetchCfg) {
        throw new Error(
          `Wallet session not prepared for background fetch: ${walletId}`,
        );
      }
      if (!this.txHistoryPageFetcher) {
        throw new Error(
          'PortfolioEngine cannot fetch tx history pages without an injected txHistoryPageFetcher.',
        );
      }

      const skip = builder.getCheckpoint().nextSkip;
      while (true) {
        let txs = fetchCfg.pendingTxs;
        let fetchedTxs = 0;
        let fetchMs = 0;

        if (!txs.length) {
          const tFetch0 = this.measureNow();
          txs = await this.txHistoryPageFetcher({
            credentials: fetchCfg.credentials,
            cfg: fetchCfg.cfg,
            skip,
            limit: fetchCfg.pageSize,
            reverse: true,
          });
          const tFetch1 = this.measureNow();
          fetchMs = Math.max(0, tFetch1 - tFetch0);
          fetchedTxs = txs.length;
          fetchCfg.pendingTxs = dedupeTxHistoryPage(txs);

          const logicalPageSize = txs.length
            ? getTxHistoryLogicalPageSize(txs)
            : 0;
          if (!txs.length || logicalPageSize <= 0) {
            fetchCfg.pendingTxs = [];
            if (builder.hasPendingCarryoverGroup()) {
              const tCompute0 = this.measureNow();
              const snapshots = builder.flushPendingCarryoverGroup();
              const checkpoint = builder.getCheckpoint();
              if (snapshots.length) {
                await this.snapshotStore.appendChunk({
                  meta,
                  snapshots,
                  checkpoint,
                });
              } else {
                await this.snapshotStore.updateCheckpoint({
                  walletId,
                  checkpoint,
                });
              }
              const tCompute1 = this.measureNow();
              return {
                checkpoint,
                appendedSnapshots: snapshots.length,
                fetchedTxs,
                logicalPageSize,
                done: true,
                fetchMs,
                computeMs: Math.max(0, tCompute1 - tCompute0),
              };
            }
            return {
              checkpoint: builder.getCheckpoint(),
              appendedSnapshots: 0,
              fetchedTxs,
              logicalPageSize,
              done: true,
              fetchMs,
              computeMs: 0,
            };
          }
        }

        const tCompute0 = this.measureNow();
        const consumed = builder.ingestPageWithSnapshotLimit(
          fetchCfg.pendingTxs,
          fetchCfg.emitRows ?? undefined,
        );
        const checkpoint = builder.getCheckpoint();
        if (consumed.snapshots.length) {
          await this.snapshotStore.appendChunk({
            meta,
            snapshots: consumed.snapshots,
            checkpoint,
          });
        } else if (consumed.logicalPageSize > 0) {
          await this.snapshotStore.updateCheckpoint({walletId, checkpoint});
        }
        const tCompute1 = this.measureNow();

        const consumedRawCount = Math.max(
          0,
          Math.min(
            fetchCfg.pendingTxs.length,
            Number(consumed.consumedRawCount ?? 0),
          ),
        );
        fetchCfg.pendingTxs =
          consumedRawCount > 0
            ? fetchCfg.pendingTxs.slice(consumedRawCount)
            : [];

        if (!consumed.logicalPageSize && !consumed.snapshots.length) {
          if (!fetchCfg.pendingTxs.length) {
            continue;
          }
        }

        return {
          checkpoint,
          appendedSnapshots: consumed.snapshots.length,
          fetchedTxs,
          logicalPageSize: consumed.logicalPageSize,
          done: false,
          fetchMs,
          computeMs: Math.max(0, tCompute1 - tCompute0),
        };
      }
    } catch (error: unknown) {
      await this.handleInvalidHistoryError(walletId, error);
      throw error;
    }
  }

  async finishWalletSession(
    walletId: string,
  ): Promise<FinishWalletSessionResult> {
    try {
      const builder = this.builders.get(walletId);
      const meta = this.sessionMetaByWalletId.get(walletId);
      if (!builder || !meta) {
        throw new Error(`Wallet session not prepared: ${walletId}`);
      }

      const snapshots = builder.finish();
      const checkpoint = builder.getCheckpoint();
      if (snapshots.length) {
        await this.snapshotStore.appendChunk({
          meta,
          snapshots,
          checkpoint,
        });
      } else {
        await this.snapshotStore.updateCheckpoint({walletId, checkpoint});
      }
      await this.snapshotStore.clearInvalidHistoryMarker(walletId);
      this.builders.delete(walletId);
      this.sessionMetaByWalletId.delete(walletId);
      this.sessionFetchByWalletId.delete(walletId);

      return {
        checkpoint,
        appendedSnapshots: snapshots.length,
      };
    } catch (error: unknown) {
      await this.handleInvalidHistoryError(walletId, error);
      throw error;
    }
  }

  async getLatestSnapshot(
    walletId: string,
  ): Promise<BalanceSnapshotStored | null> {
    return this.snapshotStore.getLatestSnapshot(walletId);
  }

  async listSnapshots(walletId: string): Promise<BalanceSnapshotStored[]> {
    return this.snapshotStore.listSnapshots(walletId);
  }

  async computeAnalysisChart(
    args: ComputeAnalysisArgs,
  ): Promise<PnlAnalysisChartResult> {
    if (!args.wallets.length) {
      return buildPnlAnalysisChartSeriesFromStreamed({
        cfg: {quoteCurrency: String(args.quoteCurrency || 'USD').toUpperCase()},
        wallets: [],
        timeframe: args.timeframe,
        ratePointsByAssetId: {},
        nowMs: args.nowMs,
        maxPoints: args.maxPoints,
      });
    }

    const prepared = await this.prepareStreamedAnalysisInputs(args);
    return buildPnlAnalysisChartSeriesFromStreamed({
      cfg: {quoteCurrency: prepared.quoteCurrency},
      wallets: prepared.wallets,
      timeframe: args.timeframe,
      ratePointsByAssetId: prepared.resolved.rawPointsByAssetId,
      currentRatesByAssetId: args.currentRatesByAssetId,
      firstNonZeroTs: prepared.firstNonZeroTs,
      startTs: prepared.resolved.startTs,
      endTs: prepared.resolved.endTs,
      nowMs: prepared.resolved.nowMs,
      maxPoints: args.maxPoints,
      resolvedWindow: prepared.resolved,
    });
  }

  async computeAnalysis(args: ComputeAnalysisArgs): Promise<PnlAnalysisResult> {
    if (!args.wallets.length) {
      return buildPnlAnalysisSeriesFromPreloaded({
        cfg: {quoteCurrency: String(args.quoteCurrency || 'USD').toUpperCase()},
        wallets: [],
        timeframe: args.timeframe,
        ratePointsByAssetId: {},
        nowMs: args.nowMs,
        maxPoints: args.maxPoints,
      });
    }

    const prepared = await this.prepareStreamedAnalysisInputs(args);
    return buildPnlAnalysisSeriesFromStreamed({
      cfg: {quoteCurrency: prepared.quoteCurrency},
      wallets: prepared.wallets,
      timeframe: args.timeframe,
      ratePointsByAssetId: prepared.resolved.rawPointsByAssetId,
      currentRatesByAssetId: args.currentRatesByAssetId,
      firstNonZeroTs: prepared.firstNonZeroTs,
      startTs: prepared.resolved.startTs,
      endTs: prepared.resolved.endTs,
      nowMs: prepared.resolved.nowMs,
      maxPoints: args.maxPoints,
      resolvedWindow: prepared.resolved,
    });
  }

  private async prepareStreamedAnalysisInputs(
    args: ComputeAnalysisArgs,
  ): Promise<PreparedStreamedAnalysisInputs> {
    const targetQuoteCurrency = String(
      args.quoteCurrency || 'USD',
    ).toUpperCase();
    const walletMetas: WalletForAnalysisMeta[] = args.wallets.map(w => ({
      walletId: w.summary.walletId,
      walletName: w.summary.walletName,
      assetId: getAssetIdFromWallet(w.summary),
      rateCoin: normalizeFiatRateSeriesCoin(w.summary.currencyAbbreviation),
      currencyAbbreviation: w.summary.currencyAbbreviation,
      chain: normalizeFiatRateSeriesChain(w.summary.chain),
      tokenAddress: normalizeFiatRateSeriesTokenAddress(
        w.summary.chain,
        w.summary.tokenAddress,
      ),
      credentials: w.credentials,
    }));
    const walletMetaByWalletId = new Map(
      walletMetas.map(meta => [meta.walletId, meta]),
    );

    const baseAssets = Array.from(
      new Map(
        args.wallets.map(w => {
          const assetRef = getFiatRateAssetRef({
            currencyAbbreviation: w.summary.currencyAbbreviation,
            chain: w.summary.chain,
            tokenAddress: w.summary.tokenAddress,
          });
          const assetId = getAssetIdFromWallet(w.summary);
          return [
            assetId,
            {
              assetId,
              coin: assetRef.coin,
              chain: assetRef.chain,
              tokenAddress: assetRef.tokenAddress,
            },
          ];
        }),
      ).values(),
    );

    const defaultCoins = Array.from(
      new Set([
        ...baseAssets
          .filter(asset => !asset.tokenAddress)
          .map(asset => normalizeFiatRateSeriesCoin(asset.coin)),
        FX_BRIDGE_COIN,
      ]),
    );
    const explicitAssets = baseAssets.filter(asset => !!asset.tokenAddress);

    await this.rateStore.ensureRates({
      cfg: args.cfg,
      quoteCurrency: CANONICAL_FIAT_QUOTE,
      interval: args.timeframe,
      coins: defaultCoins,
      assets: explicitAssets,
    });
    if (targetQuoteCurrency !== CANONICAL_FIAT_QUOTE) {
      await this.rateStore.ensureRates({
        cfg: args.cfg,
        quoteCurrency: targetQuoteCurrency,
        interval: args.timeframe,
        coins: [FX_BRIDGE_COIN],
      });
    }

    const ratePointsByAssetId: Record<string, FiatRatePoint[]> = {};
    for (const asset of baseAssets) {
      const series = await this.rateStore.getSeriesWithFx({
        quoteCurrency: targetQuoteCurrency,
        coin: asset.coin,
        interval: args.timeframe,
        chain: asset.chain,
        tokenAddress: asset.tokenAddress,
      });
      const points = (series?.points ?? [])
        .map(p => ({ts: Number(p.ts), rate: Number(p.rate)}))
        .filter(p => Number.isFinite(p.ts) && Number.isFinite(p.rate))
        .sort((a, b) => a.ts - b.ts);
      if (points.length) {
        ratePointsByAssetId[asset.assetId] = points;
      }
    }

    const walletMetasWithRates = walletMetas.filter(
      meta => (ratePointsByAssetId[meta.assetId]?.length ?? 0) > 0,
    );
    const walletIdsWithRates = new Set(
      walletMetasWithRates.map(meta => meta.walletId),
    );
    const walletsWithRates = args.wallets.filter(w =>
      walletIdsWithRates.has(w.summary.walletId),
    );

    if (!walletsWithRates.length) {
      return buildEmptyPreparedStreamedAnalysisInputs({
        quoteCurrency: targetQuoteCurrency,
        timeframe: args.timeframe,
        nowMs: args.nowMs,
        maxPoints: args.maxPoints,
      });
    }

    const firstNonZeroTs =
      args.timeframe === 'ALL'
        ? await this.findFirstNonZeroBalanceTs(
            walletsWithRates.map(w => w.summary.walletId),
          )
        : null;

    const resolved = resolvePnlAnalysisPreloadWindow({
      cfg: {quoteCurrency: targetQuoteCurrency},
      wallets: walletMetasWithRates,
      timeframe: args.timeframe,
      ratePointsByAssetId,
      firstNonZeroTs,
      nowMs: args.nowMs,
      maxPoints: args.maxPoints,
    });

    const wallets: WalletForStreamedAnalysis[] = [];
    for (const wallet of walletsWithRates) {
      const walletId = wallet.summary.walletId;
      const basePoint = await this.snapshotStore.findLastPointAtOrBefore(
        walletId,
        resolved.startTs,
      );
      const walletMeta = walletMetaByWalletId.get(walletId);
      if (!walletMeta) {
        throw new Error(`Missing analysis wallet metadata for ${walletId}.`);
      }
      wallets.push({
        wallet: walletMeta,
        basePoint,
        points: this.snapshotStore.iteratePoints({
          walletId,
          fromExclusive: resolved.startTs,
          toInclusive: resolved.endTs,
        }),
      });
    }

    return {
      quoteCurrency: targetQuoteCurrency,
      firstNonZeroTs,
      resolved,
      wallets,
    };
  }
}
