import type {GraphPoint} from 'react-native-graph';
import type {FiatRateSeriesCache, FiatRateInterval} from '../../store/rate/rate.models';
import type {
  CachedBalanceChartTimeframe,
  HistoricalRateDependencyMeta,
} from '../../store/portfolio-charts/portfolio-charts.models';
import {BALANCE_CHART_CACHE_SCHEMA_VERSION} from '../../store/portfolio-charts/portfolio-charts.models';
import type {PnlAnalysisPoint, WalletForAnalysis} from './core/pnl/analysis';
import {normalizeFiatRateSeriesCoin} from './core/pnl/rates';
import {getAtomicDecimals, parseAtomicToBigint} from './core/format';
import {atomicToUnitNumber} from './core/pnl/atomic';
import {buildPortfolioAssetKey} from './assetKey';

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

const GRAPH_DRAWABLE_EPSILON = 0.0001;
const SPOT_RATE_EPSILON = 1e-9;

export const buildBalanceChartAssetKey = buildPortfolioAssetKey;

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
    .map(dep => `${dep.cacheKey}:${dep.fetchedOn ?? 'na'}:${dep.lastTs ?? 'na'}`)
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
  const points = cache?.[cacheKey]?.points;
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
    fetchedOn: toOptionalFiniteNumber(cache?.[cacheKey]?.fetchedOn),
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
    const current = args.fiatRateSeriesCache?.[dep.cacheKey];
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
  currentSpotRatesByAssetKey: Record<string, number>;
}): {patchable: boolean; changed: boolean} => {
  const relevantAssetKeys = Object.keys(
    args.cachedTimeframe.latestHoldingsByAssetKey || {},
  )
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  if (!relevantAssetKeys.length) {
    return {patchable: false, changed: false};
  }

  let changed = false;
  for (const assetKey of relevantAssetKeys) {
    const currentRate = args.currentSpotRatesByAssetKey?.[assetKey];
    if (!(typeof currentRate === 'number' && Number.isFinite(currentRate) && currentRate > 0)) {
      return {patchable: false, changed};
    }
    const cachedRate = args.cachedTimeframe.lastSpotRatesByAssetKey?.[assetKey];
    if (
      !(typeof cachedRate === 'number' && Number.isFinite(cachedRate) && cachedRate > 0)
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
  currentSpotRatesByAssetKey: Record<string, number>;
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
    currentSpotRatesByAssetKey: args.currentSpotRatesByAssetKey,
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
  currentSpotRatesByAssetKey: Record<string, number>;
}): string => {
  return [
    `v${BALANCE_CHART_CACHE_SCHEMA_VERSION}`,
    args.scopeId,
    args.timeframe,
    args.snapshotVersionSig,
    toHistoricalDepSignature(args.historicalRateDeps || []),
    toRateSignature(args.currentSpotRatesByAssetKey || {}),
  ].join('|');
};

export const normalizeGraphPointsForChart = (
  points: GraphPoint[],
): GraphPoint[] => {
  if (!points.length) {
    return points;
  }

  const normalized: GraphPoint[] = [];
  const fallbackTsBase = Date.now();
  let prevTs = Number.NEGATIVE_INFINITY;
  let minV = Number.POSITIVE_INFINITY;
  let maxV = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < points.length; i++) {
    const src = points[i];
    const rawTs =
      src?.date instanceof Date ? src.date.getTime() : Number((src as any)?.date);
    let ts = Number.isFinite(rawTs) ? rawTs : fallbackTsBase + i;
    if (Number.isFinite(prevTs) && ts <= prevTs) {
      ts = prevTs + 1;
    }

    const fallbackValue = normalized.length
      ? normalized[normalized.length - 1].value
      : 0;
    const value = Number.isFinite(src?.value) ? src.value : fallbackValue;

    normalized.push({
      date: new Date(ts),
      value,
    });
    prevTs = ts;

    if (value < minV) {
      minV = value;
    }
    if (value > maxV) {
      maxV = value;
    }
  }

  if (normalized.length >= 2 && minV === maxV) {
    normalized[normalized.length - 1] = {
      ...normalized[normalized.length - 1],
      value: normalized[normalized.length - 1].value + GRAPH_DRAWABLE_EPSILON,
    };
  }

  return normalized;
};

export const recomputeMinMaxFromGraphPoints = (points: GraphPoint[]) => {
  let minIndex = 0;
  let maxIndex = 0;
  let minValue = Number.POSITIVE_INFINITY;
  let maxValue = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < points.length; i++) {
    const value = points[i]?.value;
    if (value < minValue) {
      minValue = value;
      minIndex = i;
    }
    if (value > maxValue) {
      maxValue = value;
      maxIndex = i;
    }
  }

  return {
    minIndex,
    maxIndex,
    minPoint: points[minIndex],
    maxPoint: points[maxIndex],
  };
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
    const totalFiatBalance = toFiniteNumber(cachedTimeframe.totalFiatBalance[i], 0);
    const totalUnrealizedPnlFiat = toFiniteNumber(
      cachedTimeframe.totalUnrealizedPnlFiat[i],
      0,
    );
    const totalRemainingCostBasisFiat = totalFiatBalance - totalUnrealizedPnlFiat;
    const totalPnlPercent = toFiniteNumber(cachedTimeframe.totalPnlPercent[i], 0);

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
      value: totalFiatBalance + normalizeBalanceChartOffset(cachedTimeframe.balanceOffset),
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
  lastSpotRatesByAssetKey: Record<string, number>;
  latestHoldingsByAssetKey: Record<string, {units: number}>;
  latestRemainingCostBasisFiatTotal: number;
} => {
  const analysisPoints = args.analysisPoints || [];
  const latestPoint = analysisPoints.length
    ? analysisPoints[analysisPoints.length - 1]
    : undefined;

  const latestHoldingsByAssetKey: Record<string, {units: number}> = {};
  const lastSpotRatesByAssetKey: Record<string, number> = {};

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
      const assetKey = buildBalanceChartAssetKey({
        currencyAbbreviation: wallet.currencyAbbreviation,
        chain: wallet.credentials.chain,
        tokenAddress: wallet.credentials.token?.address,
      });
      if (!assetKey) {
        continue;
      }

      if (!latestHoldingsByAssetKey[assetKey]) {
        latestHoldingsByAssetKey[assetKey] = {units: 0};
      }
      latestHoldingsByAssetKey[assetKey].units += units;

      if (
        !(assetKey in lastSpotRatesByAssetKey) &&
        typeof walletPoint.markRate === 'number' &&
        Number.isFinite(walletPoint.markRate) &&
        walletPoint.markRate > 0
      ) {
        lastSpotRatesByAssetKey[assetKey] = walletPoint.markRate;
      }
    }
  }

  return {
    lastSpotRatesByAssetKey,
    latestHoldingsByAssetKey,
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
    lastSpotRatesByAssetKey: Record<string, number>;
    latestHoldingsByAssetKey: Record<string, {units: number}>;
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
    totalUnrealizedPnlFiat.push(toFiniteNumber(point?.totalUnrealizedPnlFiat, 0));
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
    lastSpotRatesByAssetKey: {
      ...(args.patchMetadata?.lastSpotRatesByAssetKey || {}),
    },
    latestHoldingsByAssetKey: Object.fromEntries(
      Object.entries(args.patchMetadata?.latestHoldingsByAssetKey || {}).map(
        ([assetKey, holding]) => [
          assetKey,
          {
            units: toFiniteNumber(holding?.units, 0),
          },
        ],
      ),
    ),
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
  currentSpotRatesByAssetKey: Record<string, number>;
  patchedAt?: number;
}): CachedBalanceChartTimeframe => {
  const spotRateChange = getPatchableSpotRateChange({
    cachedTimeframe: args.cachedTimeframe,
    currentSpotRatesByAssetKey: args.currentSpotRatesByAssetKey,
  });

  if (!spotRateChange.patchable || !spotRateChange.changed) {
    return args.cachedTimeframe;
  }

  const lastIndex = args.cachedTimeframe.totalFiatBalance.length - 1;
  if (lastIndex < 0) {
    return args.cachedTimeframe;
  }

  let latestTotalFiatBalance = 0;
  for (const [assetKey, entry] of Object.entries(
    args.cachedTimeframe.latestHoldingsByAssetKey || {},
  )) {
    const units = toFiniteNumber(entry?.units, 0);
    const currentRate = args.currentSpotRatesByAssetKey?.[assetKey];
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

  const nextLastSpotRatesByAssetKey = {
    ...args.cachedTimeframe.lastSpotRatesByAssetKey,
  };
  for (const assetKey of Object.keys(
    args.cachedTimeframe.latestHoldingsByAssetKey || {},
  )) {
    const currentRate = args.currentSpotRatesByAssetKey[assetKey];
    if (Number.isFinite(currentRate) && currentRate > 0) {
      nextLastSpotRatesByAssetKey[assetKey] = currentRate;
    }
  }

  return {
    ...args.cachedTimeframe,
    builtAt:
      typeof args.patchedAt === 'number' && Number.isFinite(args.patchedAt)
        ? args.patchedAt
        : Date.now(),
    lastSpotRatesByAssetKey: nextLastSpotRatesByAssetKey,
    totalFiatBalance: nextTotalFiatBalance,
    totalUnrealizedPnlFiat: nextTotalUnrealizedPnlFiat,
    totalPnlPercent: nextTotalPnlPercent,
  };
};
