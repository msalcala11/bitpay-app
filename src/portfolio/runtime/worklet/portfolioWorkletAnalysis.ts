import {
  buildPnlAnalysisChartSeriesFromStreamed,
  buildPnlAnalysisSeriesFromStreamed,
  buildPnlAnalysisSeriesFromPreloaded,
  resolvePnlAnalysisPreloadWindow,
  type PnlAnalysisChartResult,
  type PnlAnalysisResult,
  type WalletForAnalysisMeta,
  type WalletForStreamedAnalysis,
} from '../../core/pnl/analysisStreaming';
import {getAssetIdFromWallet} from '../../core/pnl/assetId';
import {
  normalizeFiatRateSeriesChain,
  normalizeFiatRateSeriesTokenAddress,
  type FiatRatePoint,
} from '../../core/fiatRatesShared';
import {normalizeFiatRateSeriesCoin} from '../../core/pnl/rates';
import type {ComputeAnalysisArgs} from '../../core/engine/portfolioEngine';
import {
  buildPortfolioAssetRowsResult,
  type ComputeAssetRowsArgs,
  type PortfolioAssetRowsResult,
} from '../../core/pnl/assetRows';
import type {PortfolioWorkletKvConfig} from './portfolioWorkletKv';
import {
  ensureWorkletCanonicalAndFxRates,
  getWorkletRateSeriesWithFx,
} from './portfolioWorkletRates';
import {
  findWorkletLastPointAtOrBefore,
  iterateWorkletPoints,
  loadWorkletSnapshotIndex,
} from './portfolioWorkletSnapshots';

function sanitizeRatePoints(pointsRaw: FiatRatePoint[] | undefined): FiatRatePoint[] {
  'worklet';

  if (!Array.isArray(pointsRaw)) {
    return [];
  }

  return pointsRaw
    .map(point => ({ts: Number(point.ts), rate: Number(point.rate)}))
    .filter(point => Number.isFinite(point.ts) && Number.isFinite(point.rate))
    .sort((a, b) => a.ts - b.ts);
}

function snapshotIndexHasRows(
  index:
    | {
        chunks?: Array<{
          rows?: number;
        }>;
      }
    | null
    | undefined,
): boolean {
  'worklet';

  if (!Array.isArray(index?.chunks) || !index?.chunks.length) {
    return false;
  }

  return index.chunks.some(chunk => Number(chunk?.rows) > 0);
}

type PreparedWorkletAnalysisInputs = {
  quoteCurrency: string;
  firstNonZeroTs: number | null;
  resolved: ReturnType<typeof resolvePnlAnalysisPreloadWindow>;
  wallets: WalletForStreamedAnalysis[];
};

async function prepareWorkletStreamedAnalysisInputs(
  config: PortfolioWorkletKvConfig,
  args: ComputeAnalysisArgs,
  options?: {allowMissingRates?: boolean},
): Promise<PreparedWorkletAnalysisInputs> {
  'worklet';

  const targetQuoteCurrency = String(args.quoteCurrency || 'USD').toUpperCase();
  const walletMetas: WalletForAnalysisMeta[] = args.wallets.map(wallet => ({
    walletId: wallet.summary.walletId,
    walletName: wallet.summary.walletName,
    assetId: getAssetIdFromWallet(wallet.summary),
    rateCoin: normalizeFiatRateSeriesCoin(wallet.summary.currencyAbbreviation),
    currencyAbbreviation: wallet.summary.currencyAbbreviation,
    chain: normalizeFiatRateSeriesChain(wallet.summary.chain),
    tokenAddress: normalizeFiatRateSeriesTokenAddress(
      wallet.summary.chain,
      wallet.summary.tokenAddress,
    ),
    credentials: wallet.credentials,
  }));
  const walletMetaByWalletId = new Map(
    walletMetas.map(meta => [meta.walletId, meta] as const),
  );

  const snapshotIndexesByWalletId = new Map(
    await Promise.all(
      args.wallets.map(async wallet => {
        return [
          wallet.summary.walletId,
          await loadWorkletSnapshotIndex(config, wallet.summary.walletId),
        ] as const;
      }),
    ),
  );

  const walletIdsWithSnapshots = new Set(
    args.wallets
      .filter(wallet =>
        snapshotIndexHasRows(
          snapshotIndexesByWalletId.get(wallet.summary.walletId),
        ),
      )
      .map(wallet => wallet.summary.walletId),
  );
  const walletsWithSnapshots = args.wallets.filter(wallet =>
    walletIdsWithSnapshots.has(wallet.summary.walletId),
  );
  const walletMetasWithSnapshots = walletMetas.filter(meta =>
    walletIdsWithSnapshots.has(meta.walletId),
  );

  if (!walletsWithSnapshots.length) {
    return {
      quoteCurrency: targetQuoteCurrency,
      firstNonZeroTs: null,
      resolved: resolvePnlAnalysisPreloadWindow({
        cfg: {quoteCurrency: targetQuoteCurrency},
        wallets: [],
        timeframe: args.timeframe,
        ratePointsByAssetId: {},
        nowMs: args.nowMs,
        maxPoints: args.maxPoints,
      }),
      wallets: [],
    };
  }

  const baseAssets = Array.from(
    new Map(
      walletsWithSnapshots.map(wallet => {
        const coin = normalizeFiatRateSeriesCoin(
          wallet.summary.currencyAbbreviation,
        );
        const chain = normalizeFiatRateSeriesChain(wallet.summary.chain);
        const tokenAddress = normalizeFiatRateSeriesTokenAddress(
          wallet.summary.chain,
          wallet.summary.tokenAddress,
        );
        const assetId = getAssetIdFromWallet(wallet.summary);
        return [
          assetId,
          {
            assetId,
            coin,
            chain,
            tokenAddress,
          },
        ] as const;
      }),
    ).values(),
  );

  await ensureWorkletCanonicalAndFxRates({
    storage: config.storage,
    registryKey: config.registryKey,
    cfg: args.cfg,
    quoteCurrency: targetQuoteCurrency,
    timeframe: args.timeframe,
    assets: baseAssets,
  });

  const ratePointsByAssetId: Record<string, FiatRatePoint[]> = {};
  for (const asset of baseAssets) {
    const series = await getWorkletRateSeriesWithFx({
      storage: config.storage,
      registryKey: config.registryKey,
      quoteCurrency: targetQuoteCurrency,
      coin: asset.coin,
      interval: args.timeframe,
      chain: asset.chain,
      tokenAddress: asset.tokenAddress,
    });
    const points = sanitizeRatePoints(series?.points);
    if (points.length) {
      ratePointsByAssetId[asset.assetId] = points;
    }
  }

  const analysisWalletsWithSnapshots = options?.allowMissingRates
    ? walletsWithSnapshots.filter(wallet => {
        const assetId = getAssetIdFromWallet(wallet.summary);
        return !!ratePointsByAssetId[assetId]?.length;
      })
    : walletsWithSnapshots;
  const analysisWalletIdsWithSnapshots = new Set(
    analysisWalletsWithSnapshots.map(wallet => wallet.summary.walletId),
  );
  const analysisWalletMetasWithSnapshots = walletMetasWithSnapshots.filter(meta =>
    analysisWalletIdsWithSnapshots.has(meta.walletId),
  );

  if (options?.allowMissingRates && !analysisWalletsWithSnapshots.length) {
    return {
      quoteCurrency: targetQuoteCurrency,
      firstNonZeroTs: null,
      resolved: resolvePnlAnalysisPreloadWindow({
        cfg: {quoteCurrency: targetQuoteCurrency},
        wallets: [],
        timeframe: args.timeframe,
        ratePointsByAssetId: {},
        nowMs: args.nowMs,
        maxPoints: args.maxPoints,
      }),
      wallets: [],
    };
  }

  const firstNonZeroTs =
    args.timeframe === 'ALL'
      ? analysisWalletMetasWithSnapshots.reduce<number | null>((best, walletMeta) => {
          const index = snapshotIndexesByWalletId.get(walletMeta.walletId);
          const ts = index?.checkpoint?.firstNonZeroTs;
          if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) {
            return best;
          }
          if (best === null || ts < best) {
            return ts;
          }
          return best;
        }, null)
      : null;

  const resolved = resolvePnlAnalysisPreloadWindow({
    cfg: {quoteCurrency: targetQuoteCurrency},
    wallets: analysisWalletMetasWithSnapshots,
    timeframe: args.timeframe,
    ratePointsByAssetId,
    firstNonZeroTs,
    nowMs: args.nowMs,
    maxPoints: args.maxPoints,
  });

  const wallets: WalletForStreamedAnalysis[] = [];
  for (const wallet of analysisWalletsWithSnapshots) {
    const walletId = wallet.summary.walletId;
    const basePoint = await findWorkletLastPointAtOrBefore({
      storage: config.storage,
      registryKey: config.registryKey,
      walletId,
      tsMs: resolved.startTs,
    });
    const walletMeta = walletMetaByWalletId.get(walletId);
    if (!walletMeta) {
      throw new Error(`Missing analysis wallet metadata for ${walletId}.`);
    }
    wallets.push({
      wallet: walletMeta,
      basePoint,
      points: iterateWorkletPoints({
        storage: config.storage,
        registryKey: config.registryKey,
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

export async function computeWorkletAnalysis(
  config: PortfolioWorkletKvConfig,
  args: ComputeAnalysisArgs,
): Promise<PnlAnalysisResult> {
  'worklet';

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

  const prepared = await prepareWorkletStreamedAnalysisInputs(config, args);
  return buildPnlAnalysisSeriesFromStreamed({
    cfg: {quoteCurrency: prepared.quoteCurrency},
    wallets: prepared.wallets,
    timeframe: args.timeframe,
    ratePointsByAssetId: prepared.resolved.rawPointsByAssetId,
    firstNonZeroTs: prepared.firstNonZeroTs,
    startTs: prepared.resolved.startTs,
    endTs: prepared.resolved.endTs,
    nowMs: prepared.resolved.nowMs,
    maxPoints: args.maxPoints,
    resolvedWindow: prepared.resolved,
  });
}

export async function computeWorkletAssetRows(
  config: PortfolioWorkletKvConfig,
  args: ComputeAssetRowsArgs,
): Promise<PortfolioAssetRowsResult> {
  'worklet';

  const quoteCurrency = String(args.quoteCurrency || 'USD').toUpperCase();
  const generatedAt =
    typeof args.nowMs === 'number' && Number.isFinite(args.nowMs)
      ? args.nowMs
      : Date.now();
  const rowArgs: ComputeAssetRowsArgs = {
    ...args,
    quoteCurrency,
    nowMs: generatedAt,
    maxPoints: 2,
  };

  if (!rowArgs.wallets.length) {
    return buildPortfolioAssetRowsResult({
      storedWallets: [],
      analysis: undefined,
      ratePointsByAssetId: {},
      quoteCurrency,
      timeframe: rowArgs.timeframe,
      nowMs: rowArgs.nowMs,
      generatedAt,
      collapseAcrossChains: rowArgs.collapseAcrossChains,
      currentRatesByAssetId: rowArgs.currentRatesByAssetId,
    });
  }

  const prepared = await prepareWorkletStreamedAnalysisInputs(
    config,
    rowArgs,
    {allowMissingRates: true},
  );
  const analysis = await buildPnlAnalysisSeriesFromStreamed({
    cfg: {quoteCurrency: prepared.quoteCurrency},
    wallets: prepared.wallets,
    timeframe: rowArgs.timeframe,
    ratePointsByAssetId: prepared.resolved.rawPointsByAssetId,
    firstNonZeroTs: prepared.firstNonZeroTs,
    startTs: prepared.resolved.startTs,
    endTs: prepared.resolved.endTs,
    nowMs: prepared.resolved.nowMs,
    maxPoints: 2,
    resolvedWindow: prepared.resolved,
  });

  return buildPortfolioAssetRowsResult({
    storedWallets: rowArgs.wallets,
    analysis,
    ratePointsByAssetId: prepared.resolved.rawPointsByAssetId,
    quoteCurrency: prepared.quoteCurrency,
    timeframe: rowArgs.timeframe,
    nowMs: rowArgs.nowMs,
    generatedAt,
    collapseAcrossChains: rowArgs.collapseAcrossChains,
    currentRatesByAssetId: rowArgs.currentRatesByAssetId,
  });
}

export async function computeWorkletAnalysisChart(
  config: PortfolioWorkletKvConfig,
  args: ComputeAnalysisArgs,
): Promise<PnlAnalysisChartResult> {
  'worklet';

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

  const prepared = await prepareWorkletStreamedAnalysisInputs(config, args);
  return buildPnlAnalysisChartSeriesFromStreamed({
    cfg: {quoteCurrency: prepared.quoteCurrency},
    wallets: prepared.wallets,
    timeframe: args.timeframe,
    ratePointsByAssetId: prepared.resolved.rawPointsByAssetId,
    firstNonZeroTs: prepared.firstNonZeroTs,
    startTs: prepared.resolved.startTs,
    endTs: prepared.resolved.endTs,
    nowMs: prepared.resolved.nowMs,
    maxPoints: args.maxPoints,
    resolvedWindow: prepared.resolved,
  });
}
