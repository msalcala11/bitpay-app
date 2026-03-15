import type {GraphPoint} from 'react-native-graph';
import type {
  FiatRateSeriesCache,
  FiatRateSeriesCacheEntry,
  FiatRateInterval,
} from '../../store/rate/rate.models';
import type {
  CachedBalanceChartTimeframe,
  CachedBalanceChartTimeframes,
  HistoricalRateDependencyMeta,
} from '../../store/portfolio-charts/portfolio-charts.models';
import {BALANCE_CHART_CACHE_SCHEMA_VERSION} from '../../store/portfolio-charts/portfolio-charts.models';
import type {PnlAnalysisPoint, WalletForAnalysis} from './core/pnl/analysis';
import {getFiatRateSeriesAssetKey} from './core/fiatRateSeries';
import {getAtomicDecimals, parseAtomicToBigint} from './core/format';
import {atomicToUnitNumber} from './core/pnl/atomic';
import {
  normalizeGraphPointsForChart,
  recomputeMinMaxFromGraphPoints,
} from './chartGraph';

export type CachedTimeframeStatus =
  | 'fresh'
  | 'patchable'
  | 'stale_historical'
  | 'missing';

export type HydratedBalanceChartSeries = {
  graphPoints: GraphPoint[];
  analysisPoints: PnlAnalysisPoint[];
  pointByTimestamp: Map<number, PnlAnalysisPoint>;
  minIndex: number;
  maxIndex: number;
  minPoint: GraphPoint;
  maxPoint: GraphPoint;
};

const SPOT_RATE_EPSILON = 1e-9;

const toFiniteNumber = (value: unknown, fallback = 0): number => {
  const normalized = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(normalized) ? normalized : fallback;
};

const toOptionalFiniteNumber = (value: unknown): number | undefined => {
  const normalized = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(normalized) ? normalized : undefined;
};

export const normalizeBalanceChartOffset = (value: unknown): number => {
  return toFiniteNumber(value, 0);
};

export const getFiatRateSeriesCacheEntry = (
  cache: FiatRateSeriesCache | undefined,
  cacheKey: string,
): FiatRateSeriesCacheEntry | undefined => {
  if (!cacheKey) {
    return undefined;
  }

  return cache?.[cacheKey];
};

export const getCachedBalanceChartTimeframe = (
  timeframes: CachedBalanceChartTimeframes | undefined,
  timeframe: FiatRateInterval,
): CachedBalanceChartTimeframe | undefined => {
  return timeframes?.[timeframe];
};

export const getSortedUniqueWalletIds = (walletIds: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const walletId of walletIds || []) {
    const normalized = String(walletId || '');
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out.sort((a, b) => a.localeCompare(b));
};

const getWalletHistoricalRateKey = (wallet: WalletForAnalysis): string => {
  const rawTokenAddress = wallet?.credentials?.token?.address;
  const tokenAddress =
    typeof rawTokenAddress === 'string' && rawTokenAddress.trim()
      ? rawTokenAddress
      : undefined;

  return getFiatRateSeriesAssetKey(wallet.currencyAbbreviation, {
    chain:
      tokenAddress && wallet?.credentials?.chain
        ? String(wallet.credentials.chain)
        : undefined,
    tokenAddress,
  });
};

const toRateSignature = (ratesByCoin: Record<string, number>): string => {
  return Object.entries(ratesByCoin || {})
    .filter(([, rate]) => Number.isFinite(rate))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([coin, rate]) => `${coin}:${Number(rate)}`)
    .join('|');
};

const toHistoricalDepSignature = (
  historicalRateDeps: HistoricalRateDependencyMeta[],
): string => {
  return (historicalRateDeps || [])
    .filter(dep => !!dep?.cacheKey)
    .slice()
    .sort((a, b) => a.cacheKey.localeCompare(b.cacheKey))
    .map(
      dep => `${dep.cacheKey}:${dep.fetchedOn ?? 'na'}:${dep.lastTs ?? 'na'}`,
    )
    .join('|');
};

export const buildBalanceChartScopeId = (args: {
  walletIds: string[];
  quoteCurrency: string;
  balanceOffset?: number;
}): string => {
  const walletIds = getSortedUniqueWalletIds(args.walletIds || []);
  const quoteCurrency = String(args.quoteCurrency || '').toUpperCase();
  const balanceOffset = normalizeBalanceChartOffset(args.balanceOffset);

  return [
    `v${BALANCE_CHART_CACHE_SCHEMA_VERSION}`,
    quoteCurrency,
    balanceOffset,
    walletIds.join(','),
  ].join('|');
};

export const buildSnapshotVersionSig = (args: {
  walletIds: string[];
  walletSnapshotVersionById: Record<string, number | undefined>;
}): string => {
  return getSortedUniqueWalletIds(args.walletIds || [])
    .map(
      walletId =>
        `${walletId}:${Math.max(
          0,
          Math.floor(args.walletSnapshotVersionById?.[walletId] || 0),
        )}`,
    )
    .join('|');
};

const getLatestSeriesPointTs = (
  cache: FiatRateSeriesCache | undefined,
  cacheKey: string,
): number | undefined => {
  const points = getFiatRateSeriesCacheEntry(cache, cacheKey)?.points;
  if (!Array.isArray(points) || !points.length) {
    return undefined;
  }
  const ts = Number(points[points.length - 1]?.ts);
  return Number.isFinite(ts) ? ts : undefined;
};

export const buildHistoricalRateDependencyMetadataFromCache = (args: {
  depKeys: Iterable<string>;
  fiatRateSeriesCache: FiatRateSeriesCache | undefined;
}): HistoricalRateDependencyMeta[] => {
  const cache = args.fiatRateSeriesCache;
  const cacheKeys = Array.from(new Set(Array.from(args.depKeys || [])))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  return cacheKeys.map(cacheKey => ({
    cacheKey,
    fetchedOn: toOptionalFiniteNumber(
      getFiatRateSeriesCacheEntry(cache, cacheKey)?.fetchedOn,
    ),
    lastTs: getLatestSeriesPointTs(cache, cacheKey),
  }));
};

const haveHistoricalRateDependenciesChanged = (args: {
  historicalRateDeps: HistoricalRateDependencyMeta[];
  fiatRateSeriesCache: FiatRateSeriesCache | undefined;
}): boolean => {
  for (const dep of args.historicalRateDeps || []) {
    if (!dep?.cacheKey) {
      continue;
    }
    const current = getFiatRateSeriesCacheEntry(
      args.fiatRateSeriesCache,
      dep.cacheKey,
    );
    if (!current) {
      return true;
    }
    const currentFetchedOn = toOptionalFiniteNumber(current.fetchedOn);
    const currentLastTs = getLatestSeriesPointTs(
      args.fiatRateSeriesCache,
      dep.cacheKey,
    );
    if (dep.fetchedOn !== currentFetchedOn || dep.lastTs !== currentLastTs) {
      return true;
    }
  }
  return false;
};

const isSpotRateDifferent = (a: number, b: number): boolean => {
  if (!(Number.isFinite(a) && Number.isFinite(b))) {
    return true;
  }
  return Math.abs(a - b) > SPOT_RATE_EPSILON;
};

const getPatchableSpotRateChange = (args: {
  cachedTimeframe: CachedBalanceChartTimeframe;
  currentSpotRatesByCoin: Record<string, number>;
}): {patchable: boolean; changed: boolean} => {
  const relevantCoins = Object.keys(
    args.cachedTimeframe.latestHoldingsByCoin || {},
  )
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  if (!relevantCoins.length) {
    return {patchable: false, changed: false};
  }

  let changed = false;
  for (const coin of relevantCoins) {
    const currentRate = args.currentSpotRatesByCoin?.[coin];
    if (
      !(
        typeof currentRate === 'number' &&
        Number.isFinite(currentRate) &&
        currentRate > 0
      )
    ) {
      return {patchable: false, changed};
    }
    const cachedRate = args.cachedTimeframe.lastSpotRatesByCoin?.[coin];
    if (
      !(
        typeof cachedRate === 'number' &&
        Number.isFinite(cachedRate) &&
        cachedRate > 0
      )
    ) {
      changed = true;
      continue;
    }
    if (isSpotRateDifferent(currentRate, cachedRate)) {
      changed = true;
    }
  }

  return {
    patchable: true,
    changed,
  };
};

export const getCachedTimeframeStatus = (args: {
  cachedTimeframe?: CachedBalanceChartTimeframe;
  snapshotVersionSig: string;
  currentSpotRatesByCoin: Record<string, number>;
  fiatRateSeriesCache: FiatRateSeriesCache | undefined;
}): CachedTimeframeStatus => {
  const cachedTimeframe = args.cachedTimeframe;
  if (!cachedTimeframe) {
    return 'missing';
  }

  if (cachedTimeframe.schemaVersion !== BALANCE_CHART_CACHE_SCHEMA_VERSION) {
    return 'stale_historical';
  }

  if (cachedTimeframe.snapshotVersionSig !== args.snapshotVersionSig) {
    return 'stale_historical';
  }

  if (
    haveHistoricalRateDependenciesChanged({
      historicalRateDeps: cachedTimeframe.historicalRateDeps || [],
      fiatRateSeriesCache: args.fiatRateSeriesCache,
    })
  ) {
    return 'stale_historical';
  }

  const spotRateChange = getPatchableSpotRateChange({
    cachedTimeframe,
    currentSpotRatesByCoin: args.currentSpotRatesByCoin,
  });
  if (spotRateChange.patchable && spotRateChange.changed) {
    return 'patchable';
  }

  return 'fresh';
};

export const buildBalanceChartTimeframeRevision = (args: {
  scopeId: string;
  timeframe: FiatRateInterval;
  snapshotVersionSig: string;
  historicalRateDeps: HistoricalRateDependencyMeta[];
  currentSpotRatesByCoin: Record<string, number>;
}): string => {
  return [
    `v${BALANCE_CHART_CACHE_SCHEMA_VERSION}`,
    args.scopeId,
    args.timeframe,
    args.snapshotVersionSig,
    toHistoricalDepSignature(args.historicalRateDeps || []),
    toRateSignature(args.currentSpotRatesByCoin || {}),
  ].join('|');
};

export const deserializeCachedTimeframeToComputedSeries = (
  cachedTimeframe: CachedBalanceChartTimeframe,
): HydratedBalanceChartSeries => {
  const length = Math.min(
    cachedTimeframe.ts.length,
    cachedTimeframe.totalFiatBalance.length,
    cachedTimeframe.totalUnrealizedPnlFiat.length,
    cachedTimeframe.totalPnlPercent.length,
  );

  const analysisPoints: PnlAnalysisPoint[] = [];
  const rawGraphPoints: GraphPoint[] = [];

  for (let i = 0; i < length; i++) {
    const timestamp = toFiniteNumber(cachedTimeframe.ts[i], Date.now() + i);
    const totalFiatBalance = toFiniteNumber(
      cachedTimeframe.totalFiatBalance[i],
      0,
    );
    const totalUnrealizedPnlFiat = toFiniteNumber(
      cachedTimeframe.totalUnrealizedPnlFiat[i],
      0,
    );
    const totalRemainingCostBasisFiat =
      totalFiatBalance - totalUnrealizedPnlFiat;
    const totalPnlPercent = toFiniteNumber(
      cachedTimeframe.totalPnlPercent[i],
      0,
    );

    analysisPoints.push({
      timestamp,
      totalFiatBalance,
      totalRemainingCostBasisFiat,
      totalUnrealizedPnlFiat,
      totalPnlPercent,
      byWalletId: {},
    });
    rawGraphPoints.push({
      date: new Date(timestamp),
      value:
        totalFiatBalance +
        normalizeBalanceChartOffset(cachedTimeframe.balanceOffset),
    });
  }

  const graphPoints = normalizeGraphPointsForChart(rawGraphPoints);
  const pointByTimestamp = new Map<number, PnlAnalysisPoint>();
  for (let i = 0; i < graphPoints.length; i++) {
    pointByTimestamp.set(graphPoints[i].date.getTime(), analysisPoints[i]);
  }

  const {minIndex, maxIndex, minPoint, maxPoint} =
    recomputeMinMaxFromGraphPoints(graphPoints);

  return {
    graphPoints,
    analysisPoints,
    pointByTimestamp,
    minIndex,
    maxIndex,
    minPoint,
    maxPoint,
  };
};

export const buildLatestPointPatchMetadataFromAnalysis = (args: {
  analysisPoints: PnlAnalysisPoint[];
  wallets: WalletForAnalysis[];
}): {
  lastSpotRatesByCoin: Record<string, number>;
  latestHoldingsByCoin: Record<string, {units: number}>;
  latestRemainingCostBasisFiatTotal: number;
} => {
  const analysisPoints = args.analysisPoints || [];
  const latestPoint = analysisPoints.length
    ? analysisPoints[analysisPoints.length - 1]
    : undefined;

  const latestHoldingsByCoin: Record<string, {units: number}> = {};
  const lastSpotRatesByCoin: Record<string, number> = {};

  if (latestPoint) {
    for (const wallet of args.wallets || []) {
      const walletPoint = latestPoint.byWalletId?.[wallet.walletId];
      if (!walletPoint) {
        continue;
      }
      const decimals = getAtomicDecimals(wallet.credentials);
      const units = atomicToUnitNumber(
        parseAtomicToBigint(walletPoint.balanceAtomic || '0'),
        decimals,
      );
      const coin = getWalletHistoricalRateKey(wallet);
      if (!latestHoldingsByCoin[coin]) {
        latestHoldingsByCoin[coin] = {units: 0};
      }
      latestHoldingsByCoin[coin].units += units;

      if (
        !(coin in lastSpotRatesByCoin) &&
        typeof walletPoint.markRate === 'number' &&
        Number.isFinite(walletPoint.markRate) &&
        walletPoint.markRate > 0
      ) {
        lastSpotRatesByCoin[coin] = walletPoint.markRate;
      }
    }
  }

  return {
    lastSpotRatesByCoin,
    latestHoldingsByCoin,
    latestRemainingCostBasisFiatTotal: toFiniteNumber(
      latestPoint?.totalRemainingCostBasisFiat,
      0,
    ),
  };
};

export const serializeComputedSeriesToCachedTimeframe = (args: {
  timeframe: FiatRateInterval;
  walletIds: string[];
  quoteCurrency: string;
  balanceOffset: number;
  snapshotVersionSig: string;
  historicalRateDeps: HistoricalRateDependencyMeta[];
  analysisPoints: PnlAnalysisPoint[];
  patchMetadata: {
    lastSpotRatesByCoin: Record<string, number>;
    latestHoldingsByCoin: Record<string, {units: number}>;
    latestRemainingCostBasisFiatTotal: number;
  };
  builtAt?: number;
}): CachedBalanceChartTimeframe => {
  const ts: number[] = [];
  const totalFiatBalance: number[] = [];
  const totalUnrealizedPnlFiat: number[] = [];
  const totalPnlPercent: number[] = [];

  for (const point of args.analysisPoints || []) {
    ts.push(toFiniteNumber(point?.timestamp, Date.now()));
    totalFiatBalance.push(toFiniteNumber(point?.totalFiatBalance, 0));
    totalUnrealizedPnlFiat.push(
      toFiniteNumber(point?.totalUnrealizedPnlFiat, 0),
    );
    totalPnlPercent.push(toFiniteNumber(point?.totalPnlPercent, 0));
  }

  return {
    timeframe: args.timeframe,
    builtAt:
      typeof args.builtAt === 'number' && Number.isFinite(args.builtAt)
        ? args.builtAt
        : Date.now(),
    schemaVersion: BALANCE_CHART_CACHE_SCHEMA_VERSION,
    quoteCurrency: String(args.quoteCurrency || '').toUpperCase(),
    balanceOffset: normalizeBalanceChartOffset(args.balanceOffset),
    walletIds: getSortedUniqueWalletIds(args.walletIds || []),
    snapshotVersionSig: args.snapshotVersionSig,
    historicalRateDeps: (args.historicalRateDeps || [])
      .filter(dep => !!dep?.cacheKey)
      .slice()
      .sort((a, b) => a.cacheKey.localeCompare(b.cacheKey))
      .map(dep => ({
        cacheKey: dep.cacheKey,
        fetchedOn: toOptionalFiniteNumber(dep.fetchedOn),
        lastTs: toOptionalFiniteNumber(dep.lastTs),
      })),
    lastSpotRatesByCoin: {...(args.patchMetadata?.lastSpotRatesByCoin || {})},
    latestHoldingsByCoin: {...(args.patchMetadata?.latestHoldingsByCoin || {})},
    latestRemainingCostBasisFiatTotal: toFiniteNumber(
      args.patchMetadata?.latestRemainingCostBasisFiatTotal,
      0,
    ),
    ts,
    totalFiatBalance,
    totalUnrealizedPnlFiat,
    totalPnlPercent,
  };
};

export const patchCachedLatestPointWithSpotRates = (args: {
  cachedTimeframe: CachedBalanceChartTimeframe;
  currentSpotRatesByCoin: Record<string, number>;
  patchedAt?: number;
}): CachedBalanceChartTimeframe => {
  const spotRateChange = getPatchableSpotRateChange({
    cachedTimeframe: args.cachedTimeframe,
    currentSpotRatesByCoin: args.currentSpotRatesByCoin,
  });

  if (!spotRateChange.patchable || !spotRateChange.changed) {
    return args.cachedTimeframe;
  }

  const lastIndex = args.cachedTimeframe.totalFiatBalance.length - 1;
  if (lastIndex < 0) {
    return args.cachedTimeframe;
  }

  let latestTotalFiatBalance = 0;
  for (const [coin, entry] of Object.entries(
    args.cachedTimeframe.latestHoldingsByCoin || {},
  )) {
    const units = toFiniteNumber(entry?.units, 0);
    const currentRate = args.currentSpotRatesByCoin?.[coin];
    if (!(Number.isFinite(currentRate) && currentRate > 0)) {
      return args.cachedTimeframe;
    }
    latestTotalFiatBalance += units * currentRate;
  }

  const latestRemainingCostBasisFiatTotal = toFiniteNumber(
    args.cachedTimeframe.latestRemainingCostBasisFiatTotal,
    0,
  );
  const latestTotalUnrealizedPnlFiat =
    latestTotalFiatBalance - latestRemainingCostBasisFiatTotal;
  const latestTotalPnlPercent =
    latestRemainingCostBasisFiatTotal > 0
      ? (latestTotalUnrealizedPnlFiat / latestRemainingCostBasisFiatTotal) * 100
      : 0;

  const nextTotalFiatBalance = args.cachedTimeframe.totalFiatBalance.slice();
  const nextTotalUnrealizedPnlFiat =
    args.cachedTimeframe.totalUnrealizedPnlFiat.slice();
  const nextTotalPnlPercent = args.cachedTimeframe.totalPnlPercent.slice();

  nextTotalFiatBalance[lastIndex] = latestTotalFiatBalance;
  nextTotalUnrealizedPnlFiat[lastIndex] = latestTotalUnrealizedPnlFiat;
  nextTotalPnlPercent[lastIndex] = latestTotalPnlPercent;

  const nextLastSpotRatesByCoin = {
    ...args.cachedTimeframe.lastSpotRatesByCoin,
  };
  for (const coin of Object.keys(
    args.cachedTimeframe.latestHoldingsByCoin || {},
  )) {
    const currentRate = args.currentSpotRatesByCoin[coin];
    if (Number.isFinite(currentRate) && currentRate > 0) {
      nextLastSpotRatesByCoin[coin] = currentRate;
    }
  }

  return {
    ...args.cachedTimeframe,
    builtAt:
      typeof args.patchedAt === 'number' && Number.isFinite(args.patchedAt)
        ? args.patchedAt
        : Date.now(),
    lastSpotRatesByCoin: nextLastSpotRatesByCoin,
    totalFiatBalance: nextTotalFiatBalance,
    totalUnrealizedPnlFiat: nextTotalUnrealizedPnlFiat,
    totalPnlPercent: nextTotalPnlPercent,
  };
};
