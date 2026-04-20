import type {GraphPoint} from 'react-native-graph';
import type {FiatRateInterval, Rates} from '../../store/rate/rate.models';
import type {Wallet} from '../../store/wallet/wallet.models';
import {
  getPortfolioWalletChainLower,
  getPortfolioWalletTokenAddress,
} from './assets';
import {getRateByCurrencyName} from '../helper-methods';
import {getFiatRateSeriesAssetKey} from './core/fiatRateSeries';
import type {
  CachedBalanceChartTimeframe,
  HistoricalRateDependencyMeta,
} from '../../store/portfolio-charts';
import {
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
    fiatRateSeriesCache: undefined,
  });

  if (status === 'missing' || status === 'stale_historical') {
    return {
      status,
      series: undefined,
    };
  }

  return {
    status,
    series: deserializeCachedTimeframeToComputedSeries(
      args.cachedTimeframe,
      status === 'patchable'
        ? {
            currentSpotRatesByRateKey: args.currentSpotRatesByRateKey,
            patchedAt: args.asOfMs,
          }
        : undefined,
    ),
  };
}
