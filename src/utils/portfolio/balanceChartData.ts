import type {GraphPoint} from 'react-native-graph';
import type {
  FiatRateInterval,
  FiatRateSeriesCache,
  Rates,
} from '../../store/rate/rate.models';
import {getFiatRateSeriesCacheKey} from '../../store/rate/rate.models';
import type {Wallet} from '../../store/wallet/wallet.models';
import {
  getPortfolioWalletChainLower,
  getPortfolioWalletTokenAddress,
} from './assets';
import {getRateByCurrencyName} from '../helper-methods';
import type {FiatRateCacheRequest} from '../../portfolio/core/fiatRatesShared';
import {resolveStoredFiatRateInterval} from '../../portfolio/core/fiatRatesShared';
import type {StoredWallet} from '../../portfolio/core/types';
import {
  getFiatRateSeriesAssetKey,
  normalizeFiatRateSeriesChain,
  normalizeFiatRateSeriesCoin,
  normalizeFiatRateSeriesTokenAddress,
} from './core/fiatRateSeries';
import type {
  CachedBalanceChartTimeframe,
  HistoricalRateDependencyMeta,
} from '../../store/portfolio-charts';
import {
  buildHistoricalRateDependencyMetadataFromCache,
  deserializeCachedTimeframeToComputedSeries,
  getCachedTimeframeStatus,
  serializeComputedSeriesToCachedTimeframe,
  type CachedTimeframeStatus,
  type HydratedBalanceChartSeries,
} from './chartCache';
import {
  normalizeGraphPointsForChart,
  recomputeMinMaxFromGraphPoints,
} from './chartGraph';
import type {
  PnlAnalysisChartResult,
  PnlAnalysisPoint,
} from '../../portfolio/core/pnl/analysisStreaming';

const getHistoricalRateAssetFromStoredWallet = (
  wallet: StoredWallet,
):
  | {
      coin: string;
      chain?: string;
      tokenAddress?: string;
    }
  | undefined => {
  const coin = normalizeFiatRateSeriesCoin(wallet?.summary?.currencyAbbreviation);
  if (!coin) {
    return undefined;
  }

  const rawTokenAddress =
    typeof wallet?.summary?.tokenAddress === 'string'
      ? wallet.summary.tokenAddress
      : undefined;
  const chain = rawTokenAddress
    ? normalizeFiatRateSeriesChain(wallet?.summary?.chain)
    : undefined;
  const tokenAddress = normalizeFiatRateSeriesTokenAddress(
    chain,
    rawTokenAddress,
  );

  return {
    coin,
    ...(chain ? {chain} : {}),
    ...(tokenAddress ? {tokenAddress} : {}),
  };
};

export function buildBalanceChartHistoricalRateRequests(args: {
  wallets: StoredWallet[];
  timeframes: FiatRateInterval[];
}): FiatRateCacheRequest[] {
  const requestsByAssetKey = new Map<string, FiatRateCacheRequest>();

  for (const wallet of args.wallets || []) {
    const asset = getHistoricalRateAssetFromStoredWallet(wallet);
    if (!asset) {
      continue;
    }

    const assetKey = getFiatRateSeriesAssetKey(asset.coin, {
      chain: asset.chain,
      tokenAddress: asset.tokenAddress,
    });
    if (!assetKey) {
      continue;
    }

    const existing = requestsByAssetKey.get(assetKey);
    if (existing) {
      existing.intervals = Array.from(
        new Set([...(existing.intervals || []), ...(args.timeframes || [])]),
      ).sort((a, b) => a.localeCompare(b)) as FiatRateCacheRequest['intervals'];
      continue;
    }

    requestsByAssetKey.set(assetKey, {
      coin: asset.coin,
      ...(asset.chain ? {chain: asset.chain} : {}),
      ...(asset.tokenAddress ? {tokenAddress: asset.tokenAddress} : {}),
      intervals: Array.from(new Set(args.timeframes || [])).sort((a, b) =>
        a.localeCompare(b),
      ) as FiatRateCacheRequest['intervals'],
    });
  }

  return Array.from(requestsByAssetKey.values()).sort((a, b) =>
    getFiatRateSeriesAssetKey(a.coin, {
      chain: a.chain,
      tokenAddress: a.tokenAddress,
    }).localeCompare(
      getFiatRateSeriesAssetKey(b.coin, {
        chain: b.chain,
        tokenAddress: b.tokenAddress,
      }),
    ),
  );
}

export function getBalanceChartHistoricalRateCacheKeys(args: {
  wallets: StoredWallet[];
  quoteCurrency: string;
  timeframes: FiatRateInterval[];
}): string[] {
  const quoteCurrency = String(args.quoteCurrency || 'USD').toUpperCase();
  const cacheKeys = new Set<string>();

  for (const wallet of args.wallets || []) {
    const asset = getHistoricalRateAssetFromStoredWallet(wallet);
    if (!asset) {
      continue;
    }

    for (const timeframe of args.timeframes || []) {
      cacheKeys.add(
        getFiatRateSeriesCacheKey(
          quoteCurrency,
          asset.coin,
          resolveStoredFiatRateInterval(timeframe),
          {
            chain: asset.chain,
            tokenAddress: asset.tokenAddress,
          },
        ),
      );
    }
  }

  return Array.from(cacheKeys).sort((a, b) => a.localeCompare(b));
}

export function areBalanceChartHistoricalRatesReady(args: {
  depKeys: string[];
  fiatRateSeriesCache?: FiatRateSeriesCache;
}): boolean {
  return (args.depKeys || []).every(cacheKey => !!args.fiatRateSeriesCache?.[cacheKey]);
}

export function getBalanceChartHistoricalRateCacheRevision(args: {
  depKeys: string[];
  fiatRateSeriesCache?: FiatRateSeriesCache;
}): string {
  let keysPresentCount = 0;
  let maxFetchedOn = 0;
  const fetchedOnSignatureParts: string[] = [];
  const cache = args.fiatRateSeriesCache;

  for (const key of Array.from(new Set(args.depKeys || [])).sort((a, b) =>
    a.localeCompare(b),
  )) {
    if (!Object.prototype.hasOwnProperty.call(cache || {}, key)) {
      fetchedOnSignatureParts.push(`${key}:missing`);
      continue;
    }

    keysPresentCount += 1;

    const entry = cache?.[key];
    const fetchedOn = entry?.fetchedOn;
    const fetchedOnSig =
      typeof fetchedOn === 'number' && Number.isFinite(fetchedOn)
        ? fetchedOn
        : 'na';
    const points = Array.isArray(entry?.points) ? entry.points : undefined;
    const lastPointTs = points?.length
      ? Number(points[points.length - 1]?.ts)
      : NaN;
    const lastTsSig = Number.isFinite(lastPointTs) ? lastPointTs : 'na';
    fetchedOnSignatureParts.push(`${key}:${fetchedOnSig}:${lastTsSig}`);

    if (typeof fetchedOn === 'number' && Number.isFinite(fetchedOn)) {
      maxFetchedOn = Math.max(maxFetchedOn, fetchedOn);
    }
  }

  return [
    `${keysPresentCount}:${maxFetchedOn}`,
    fetchedOnSignatureParts.join('|'),
  ].join(':');
}

export function buildBalanceChartHistoricalRateDeps(args: {
  wallets: StoredWallet[];
  quoteCurrency: string;
  timeframes: FiatRateInterval[];
  fiatRateSeriesCache?: FiatRateSeriesCache;
}): HistoricalRateDependencyMeta[] {
  return buildHistoricalRateDependencyMetadataFromCache({
    depKeys: getBalanceChartHistoricalRateCacheKeys({
      wallets: args.wallets,
      quoteCurrency: args.quoteCurrency,
      timeframes: args.timeframes,
    }),
    fiatRateSeriesCache: args.fiatRateSeriesCache,
  });
}

export function buildCurrentSpotRatesByRateKey(args: {
  wallets: Wallet[];
  rates?: Rates;
  quoteCurrency: string;
}): Record<string, number> {
  const quoteCurrency = String(args.quoteCurrency || 'USD').toUpperCase();
  const out: Record<string, number> = {};

  for (const wallet of args.wallets || []) {
    const tokenAddress = getPortfolioWalletTokenAddress(wallet);
    const rateKey = getFiatRateSeriesAssetKey(wallet.currencyAbbreviation, {
      chain: tokenAddress ? getPortfolioWalletChainLower(wallet) : undefined,
      tokenAddress,
    });

    if (!rateKey || rateKey in out) {
      continue;
    }

    const walletRates = getRateByCurrencyName(
      args.rates || {},
      wallet.currencyAbbreviation,
      wallet.chain,
      wallet.tokenAddress,
    );
    const currentRate = walletRates?.find(
      rate => String(rate.code || '').toUpperCase() === quoteCurrency,
    )?.rate;

    if (
      typeof currentRate === 'number' &&
      Number.isFinite(currentRate) &&
      currentRate > 0
    ) {
      out[rateKey] = currentRate;
    }
  }

  return out;
}

export function getCurrentSpotRatesByRateKeySignature(
  currentSpotRatesByRateKey: Record<string, number>,
): string {
  return Object.keys(currentSpotRatesByRateKey || {})
    .sort()
    .map(rateKey => `${rateKey}:${String(currentSpotRatesByRateKey[rateKey])}`)
    .join('|');
}

export function buildAnalysisPointsFromRuntimeChart(
  chart: PnlAnalysisChartResult,
): PnlAnalysisPoint[] {
  const length = Math.min(
    chart.timestamps.length,
    chart.totalFiatBalance.length,
    chart.totalRemainingCostBasisFiat.length,
    chart.totalUnrealizedPnlFiat.length,
    chart.totalPnlChange.length,
    chart.totalPnlPercent.length,
  );

  const analysisPoints: PnlAnalysisPoint[] = [];

  for (let index = 0; index < length; index++) {
    const timestamp = Number(chart.timestamps[index]);
    const totalFiatBalance = Number(chart.totalFiatBalance[index]);
    const totalRemainingCostBasisFiat = Number(
      chart.totalRemainingCostBasisFiat[index],
    );
    const totalUnrealizedPnlFiat = Number(chart.totalUnrealizedPnlFiat[index]);
    const totalPnlChange = Number(chart.totalPnlChange[index]);
    const totalPnlPercent = Number(chart.totalPnlPercent[index]);

    if (
      ![
        timestamp,
        totalFiatBalance,
        totalRemainingCostBasisFiat,
        totalUnrealizedPnlFiat,
        totalPnlChange,
        totalPnlPercent,
      ].every(Number.isFinite)
    ) {
      continue;
    }

    analysisPoints.push({
      timestamp,
      totalFiatBalance,
      totalRemainingCostBasisFiat,
      totalUnrealizedPnlFiat,
      totalPnlChange,
      totalPnlPercent,
      byWalletId: {},
    });
  }

  return analysisPoints;
}

export function buildHydratedSeriesFromRuntimeChart(args: {
  chart: PnlAnalysisChartResult;
  balanceOffset: number;
}): HydratedBalanceChartSeries | undefined {
  const analysisPoints = buildAnalysisPointsFromRuntimeChart(args.chart);
  if (!analysisPoints.length) {
    return undefined;
  }

  const rawGraphPoints: GraphPoint[] = analysisPoints.map(point => ({
    date: new Date(point.timestamp),
    value: point.totalFiatBalance + args.balanceOffset,
  }));
  const graphPoints = normalizeGraphPointsForChart(rawGraphPoints);
  const pointByTimestamp = new Map<number, PnlAnalysisPoint>();

  for (
    let index = 0;
    index < Math.min(graphPoints.length, analysisPoints.length);
    index++
  ) {
    pointByTimestamp.set(
      graphPoints[index].date.getTime(),
      analysisPoints[index],
    );
  }

  const extrema = recomputeMinMaxFromGraphPoints(graphPoints);
  return {
    graphPoints,
    analysisPoints,
    pointByTimestamp,
    ...extrema,
  };
}

export function buildCachedTimeframeFromRuntimeChart(args: {
  chart: PnlAnalysisChartResult;
  timeframe: FiatRateInterval;
  walletIds: string[];
  quoteCurrency: string;
  balanceOffset: number;
  dataRevisionSig: string;
  historicalRateDeps?: HistoricalRateDependencyMeta[];
}): CachedBalanceChartTimeframe | undefined {
  const analysisPoints = buildAnalysisPointsFromRuntimeChart(args.chart);
  if (!analysisPoints.length) {
    return undefined;
  }

  return serializeComputedSeriesToCachedTimeframe({
    timeframe: args.timeframe,
    walletIds: args.walletIds,
    quoteCurrency: args.quoteCurrency,
    balanceOffset: args.balanceOffset,
    dataRevisionSig: args.dataRevisionSig,
    historicalRateDeps: args.historicalRateDeps || [],
    analysisPoints,
    patchMetadata: {
      lastSpotRatesByRateKey: args.chart.lastSpotRatesByRateKey,
      latestHoldingsByRateKey: args.chart.latestHoldingsByRateKey,
      latestRemainingCostBasisFiatTotal:
        args.chart.latestRemainingCostBasisFiatTotal,
    },
  });
}

export function resolveCachedBalanceChartSeries(args: {
  cachedTimeframe: CachedBalanceChartTimeframe | undefined;
  dataRevisionSig: string;
  currentSpotRatesByRateKey: Record<string, number>;
  asOfMs?: number;
  fiatRateSeriesCache?: FiatRateSeriesCache;
}): {
  status: CachedTimeframeStatus;
  series?: HydratedBalanceChartSeries;
} {
  if (!args.cachedTimeframe) {
    return {
      status: 'missing',
      series: undefined,
    };
  }

  const status = getCachedTimeframeStatus({
    cachedTimeframe: args.cachedTimeframe,
    dataRevisionSig: args.dataRevisionSig,
    currentSpotRatesByRateKey: args.currentSpotRatesByRateKey,
    fiatRateSeriesCache: args.fiatRateSeriesCache,
  });

  if (
    status === 'missing' ||
    status === 'stale_historical'
  ) {
    return {
      status,
      series: undefined,
    };
  }

  return {
    status,
    series: deserializeCachedTimeframeToComputedSeries(
      args.cachedTimeframe,
      status === 'patchable' || status === 'pending_historical'
        ? {
            currentSpotRatesByRateKey: args.currentSpotRatesByRateKey,
            patchedAt: args.asOfMs,
          }
        : undefined,
    ),
  };
}
