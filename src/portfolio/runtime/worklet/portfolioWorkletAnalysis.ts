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
import {type FiatRatePoint} from '../../core/fiatRatesShared';
import {normalizeFiatRateSeriesCoin} from '../../core/pnl/rates';
import type {ComputeAnalysisArgs} from '../../core/engine/portfolioEngine';
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

async function findFirstNonZeroBalanceTs(
  config: PortfolioWorkletKvConfig,
  walletIds: string[],
): Promise<number | null> {
  'worklet';

  let best: number | null = null;
  for (const walletId of walletIds) {
    const idx = await loadWorkletSnapshotIndex(config, walletId);
    const ts = idx?.checkpoint?.firstNonZeroTs;
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) {
      continue;
    }
    if (best === null || ts < best) {
      best = ts;
    }
  }

  return best;
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
): Promise<PreparedWorkletAnalysisInputs> {
  'worklet';

  const targetQuoteCurrency = String(args.quoteCurrency || 'USD').toUpperCase();
  const walletMetas: WalletForAnalysisMeta[] = args.wallets.map(wallet => ({
    walletId: wallet.summary.walletId,
    walletName: wallet.summary.walletName,
    assetId: getAssetIdFromWallet(wallet.summary),
    rateCoin: normalizeFiatRateSeriesCoin(wallet.summary.currencyAbbreviation),
    currencyAbbreviation: wallet.summary.currencyAbbreviation,
    chain: wallet.summary.chain
      ? String(wallet.summary.chain).toLowerCase()
      : undefined,
    tokenAddress: wallet.summary.tokenAddress
      ? String(wallet.summary.tokenAddress).toLowerCase()
      : undefined,
    credentials: wallet.credentials,
  }));
  const walletMetaByWalletId = new Map(
    walletMetas.map(meta => [meta.walletId, meta] as const),
  );

  const baseAssets = Array.from(
    new Map(
      args.wallets.map(wallet => {
        const coin = normalizeFiatRateSeriesCoin(
          wallet.summary.currencyAbbreviation,
        );
        const chain = wallet.summary.chain
          ? String(wallet.summary.chain).toLowerCase()
          : undefined;
        const tokenAddress = wallet.summary.tokenAddress
          ? String(wallet.summary.tokenAddress).toLowerCase()
          : undefined;
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

  const firstNonZeroTs =
    args.timeframe === 'ALL'
      ? await findFirstNonZeroBalanceTs(
          config,
          args.wallets.map(wallet => wallet.summary.walletId),
        )
      : null;

  const resolved = resolvePnlAnalysisPreloadWindow({
    cfg: {quoteCurrency: targetQuoteCurrency},
    wallets: walletMetas,
    timeframe: args.timeframe,
    ratePointsByAssetId,
    firstNonZeroTs,
    nowMs: args.nowMs,
    maxPoints: args.maxPoints,
  });

  const wallets: WalletForStreamedAnalysis[] = [];
  for (const wallet of args.wallets) {
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
