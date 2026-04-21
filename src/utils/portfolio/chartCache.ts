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
import type {
  PnlAnalysisPoint,
  WalletForAnalysisMeta,
} from '../../portfolio/core/pnl/analysisStreaming';
import {getFiatRateSeriesAssetKey} from './core/fiatRateSeries';
import {getAtomicDecimals, parseAtomicToBigint} from './core/format';
import {atomicToUnitNumber} from './core/pnl/atomic';
import {
  normalizeGraphPointsForChart,
  recomputeMinMaxFromGraphPoints,
} from './chartGraph';

type PnlAnalysisExtremaPoint = {
  timestamp: number;
  totalFiatBalance: number;
};

type PnlAnalysisExactExtrema = {
  min: PnlAnalysisExtremaPoint;
  max: PnlAnalysisExtremaPoint;
  minExcludingEnd?: PnlAnalysisExtremaPoint;
  maxExcludingEnd?: PnlAnalysisExtremaPoint;
};

type LiveTailOverlay = {
  builtAt: number;
  timestamp: number;
  totalFiatBalance: number;
  totalPnlChange: number;
  totalUnrealizedPnlFiat: number;
  totalPnlPercent: number;
  lastSpotRatesByRateKey: Record<string, number>;
  exactExtrema?: PnlAnalysisExactExtrema;
};

export type CachedTimeframeStatus =
  | 'fresh'
  | 'patchable'
  | 'pending_historical'
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
const MAX_LIVE_TAIL_PATCH_GAP_INTERVAL_MULTIPLIER = 2;

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

const getMostRecentPositiveChartIntervalMs = (
  timestamps: unknown[],
  endIndexInclusive: number,
): number | undefined => {
  for (let endIndex = endIndexInclusive; endIndex >= 1; endIndex--) {
    const currentTs = toOptionalFiniteNumber(timestamps[endIndex]);
    const previousTs = toOptionalFiniteNumber(timestamps[endIndex - 1]);
    if (
      typeof currentTs === 'number' &&
      typeof previousTs === 'number' &&
      currentTs > previousTs
    ) {
      return currentTs - previousTs;
    }
  }

  return undefined;
};

const getMaxLiveTailPatchGapMs = (
  cachedTimeframe: CachedBalanceChartTimeframe,
): number | undefined => {
  const lastHistoricalIntervalMs = getMostRecentPositiveChartIntervalMs(
    cachedTimeframe.ts,
    cachedTimeframe.ts.length - 2,
  );
  const fallbackLastIntervalMs = getMostRecentPositiveChartIntervalMs(
    cachedTimeframe.ts,
    cachedTimeframe.ts.length - 1,
  );
  const referenceIntervalMs =
    lastHistoricalIntervalMs ?? fallbackLastIntervalMs;

  return typeof referenceIntervalMs === 'number' && referenceIntervalMs > 0
    ? referenceIntervalMs * MAX_LIVE_TAIL_PATCH_GAP_INTERVAL_MULTIPLIER
    : undefined;
};

const findNearestGraphPointIndexByTimestamp = (
  graphPoints: GraphPoint[],
  timestamp: number,
): number => {
  if (!graphPoints.length || !Number.isFinite(timestamp)) {
    return 0;
  }

  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < graphPoints.length; index++) {
    const pointTs = graphPoints[index]?.date?.getTime?.();
    if (!Number.isFinite(pointTs)) {
      continue;
    }

    const distance = Math.abs(pointTs - timestamp);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }

  return bestIndex;
};

export const resolveBalanceChartSeriesExtrema = (args: {
  graphPoints: GraphPoint[];
  balanceOffset?: number;
  exactExtrema?: PnlAnalysisExactExtrema;
}) => {
  if (!args.exactExtrema) {
    return recomputeMinMaxFromGraphPoints(args.graphPoints);
  }

  const balanceOffset = normalizeBalanceChartOffset(args.balanceOffset);
  const minIndex = findNearestGraphPointIndexByTimestamp(
    args.graphPoints,
    args.exactExtrema.min.timestamp,
  );
  const maxIndex = findNearestGraphPointIndexByTimestamp(
    args.graphPoints,
    args.exactExtrema.max.timestamp,
  );

  return {
    minIndex,
    maxIndex,
    minPoint: {
      date: new Date(args.exactExtrema.min.timestamp),
      value: args.exactExtrema.min.totalFiatBalance + balanceOffset,
    },
    maxPoint: {
      date: new Date(args.exactExtrema.max.timestamp),
      value: args.exactExtrema.max.totalFiatBalance + balanceOffset,
    },
  };
};

const getExactExtremaFromCachedTimeframe = (
  cachedTimeframe: CachedBalanceChartTimeframe,
): PnlAnalysisExactExtrema | undefined => {
  const minTotalFiatBalance = toOptionalFiniteNumber(
    cachedTimeframe.minTotalFiatBalance,
  );
  const minTotalFiatBalanceTs = toOptionalFiniteNumber(
    cachedTimeframe.minTotalFiatBalanceTs,
  );
  const maxTotalFiatBalance = toOptionalFiniteNumber(
    cachedTimeframe.maxTotalFiatBalance,
  );
  const maxTotalFiatBalanceTs = toOptionalFiniteNumber(
    cachedTimeframe.maxTotalFiatBalanceTs,
  );

  if (
    minTotalFiatBalance === undefined ||
    minTotalFiatBalanceTs === undefined ||
    maxTotalFiatBalance === undefined ||
    maxTotalFiatBalanceTs === undefined
  ) {
    return undefined;
  }

  const minExcludingEnd = (() => {
    const totalFiatBalance = toOptionalFiniteNumber(
      cachedTimeframe.minTotalFiatBalanceExcludingEnd,
    );
    const timestamp = toOptionalFiniteNumber(
      cachedTimeframe.minTotalFiatBalanceExcludingEndTs,
    );
    return totalFiatBalance === undefined || timestamp === undefined
      ? undefined
      : {timestamp, totalFiatBalance};
  })();

  const maxExcludingEnd = (() => {
    const totalFiatBalance = toOptionalFiniteNumber(
      cachedTimeframe.maxTotalFiatBalanceExcludingEnd,
    );
    const timestamp = toOptionalFiniteNumber(
      cachedTimeframe.maxTotalFiatBalanceExcludingEndTs,
    );
    return totalFiatBalance === undefined || timestamp === undefined
      ? undefined
      : {timestamp, totalFiatBalance};
  })();

  return {
    min: {
      timestamp: minTotalFiatBalanceTs,
      totalFiatBalance: minTotalFiatBalance,
    },
    max: {
      timestamp: maxTotalFiatBalanceTs,
      totalFiatBalance: maxTotalFiatBalance,
    },
    minExcludingEnd,
    maxExcludingEnd,
  };
};

const getLiveTailPatchState = (args: {
  cachedTimeframe: CachedBalanceChartTimeframe;
  currentSpotRatesByRateKey: Record<string, number>;
  patchedAt?: number;
}): {patchable: boolean; changed: boolean} => {
  const spotRateChange = getPatchableSpotRateChange({
    cachedTimeframe: args.cachedTimeframe,
    currentSpotRatesByRateKey: args.currentSpotRatesByRateKey,
  });

  if (!spotRateChange.patchable) {
    return spotRateChange;
  }

  const lastIndex = args.cachedTimeframe.ts.length - 1;
  const currentLastTimestamp =
    lastIndex >= 0
      ? toOptionalFiniteNumber(args.cachedTimeframe.ts[lastIndex])
      : undefined;
  const patchedAt =
    typeof args.patchedAt === 'number' && Number.isFinite(args.patchedAt)
      ? args.patchedAt
      : undefined;
  const timestampChanged =
    typeof patchedAt === 'number' &&
    (typeof currentLastTimestamp !== 'number' || patchedAt > currentLastTimestamp);

  if (
    typeof patchedAt === 'number' &&
    typeof currentLastTimestamp === 'number' &&
    patchedAt > currentLastTimestamp
  ) {
    const maxPatchGapMs = getMaxLiveTailPatchGapMs(args.cachedTimeframe);
    if (
      typeof maxPatchGapMs === 'number' &&
      patchedAt - currentLastTimestamp > maxPatchGapMs
    ) {
      return {
        patchable: false,
        changed: true,
      };
    }
  }

  return {
    patchable: true,
    changed: spotRateChange.changed || timestampChanged,
  };
};

const buildLiveTailOverlayFromSpotRates = (args: {
  cachedTimeframe: CachedBalanceChartTimeframe;
  currentSpotRatesByRateKey: Record<string, number>;
  patchedAt?: number;
}): LiveTailOverlay | undefined => {
  const liveTailPatchState = getLiveTailPatchState({
    cachedTimeframe: args.cachedTimeframe,
    currentSpotRatesByRateKey: args.currentSpotRatesByRateKey,
    patchedAt: args.patchedAt,
  });

  if (!liveTailPatchState.patchable || !liveTailPatchState.changed) {
    return undefined;
  }

  const lastIndex = args.cachedTimeframe.totalFiatBalance.length - 1;
  if (lastIndex < 0) {
    return undefined;
  }

  let latestTotalFiatBalance = 0;
  for (const [rateKey, entry] of Object.entries(
    args.cachedTimeframe.latestHoldingsByRateKey || {},
  )) {
    const units = toFiniteNumber(entry?.units, 0);
    const currentRate = args.currentSpotRatesByRateKey?.[rateKey];
    if (!(Number.isFinite(currentRate) && currentRate > 0)) {
      return undefined;
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
  const builtAt =
    typeof args.patchedAt === 'number' && Number.isFinite(args.patchedAt)
      ? args.patchedAt
      : Date.now();
  const originalLastTimestamp = toOptionalFiniteNumber(
    args.cachedTimeframe.ts[lastIndex],
  );
  const latestTimestamp = builtAt;
  const latestPoint = {
    timestamp: latestTimestamp,
    totalFiatBalance: latestTotalFiatBalance,
  };

  const baseExactExtrema = getExactExtremaFromCachedTimeframe(args.cachedTimeframe);
  const exactExtrema = (() => {
    if (!baseExactExtrema) {
      return undefined;
    }

    const historicalMin =
      originalLastTimestamp !== undefined &&
      baseExactExtrema.min.timestamp === originalLastTimestamp
        ? baseExactExtrema.minExcludingEnd
        : baseExactExtrema.min;
    const historicalMax =
      originalLastTimestamp !== undefined &&
      baseExactExtrema.max.timestamp === originalLastTimestamp
        ? baseExactExtrema.maxExcludingEnd
        : baseExactExtrema.max;
    const min =
      !historicalMin ||
      latestPoint.totalFiatBalance < historicalMin.totalFiatBalance
        ? latestPoint
        : historicalMin;
    const max =
      !historicalMax ||
      latestPoint.totalFiatBalance > historicalMax.totalFiatBalance
        ? latestPoint
        : historicalMax;

    return {
      min,
      max,
      minExcludingEnd: baseExactExtrema.minExcludingEnd,
      maxExcludingEnd: baseExactExtrema.maxExcludingEnd,
    };
  })();

  const nextLastSpotRatesByRateKey = {
    ...args.cachedTimeframe.lastSpotRatesByRateKey,
  };
  for (const rateKey of Object.keys(
    args.cachedTimeframe.latestHoldingsByRateKey || {},
  )) {
    const currentRate = args.currentSpotRatesByRateKey[rateKey];
    if (Number.isFinite(currentRate) && currentRate > 0) {
      nextLastSpotRatesByRateKey[rateKey] = currentRate;
    }
  }

  return {
    builtAt,
    timestamp: latestTimestamp,
    totalFiatBalance: latestTotalFiatBalance,
    totalPnlChange:
      latestTotalUnrealizedPnlFiat -
      toFiniteNumber(args.cachedTimeframe.totalUnrealizedPnlFiat[0], 0),
    totalUnrealizedPnlFiat: latestTotalUnrealizedPnlFiat,
    totalPnlPercent: latestTotalPnlPercent,
    lastSpotRatesByRateKey: nextLastSpotRatesByRateKey,
    exactExtrema,
  };
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

const getWalletHistoricalRateKey = (wallet: WalletForAnalysisMeta): string => {
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

export const stableRateMapRevision = (
  ratesByRateKey?: Record<string, number>,
): string => {
  return Object.entries(ratesByRateKey || {})
    .filter(([, rate]) => Number.isFinite(rate))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([rateKey, rate]) => `${rateKey}:${Number(rate)}`)
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

export const buildPortfolioDataRevisionSig = (args: {
  walletIds?: string[];
  dataRevisionSig?: string;
  portfolioRevision?: string;
}): string => {
  const revision = String(
    args.dataRevisionSig || args.portfolioRevision || '',
  ).trim();
  if (revision) {
    return revision;
  }

  return getSortedUniqueWalletIds(args.walletIds || []).join('|');
};

// Legacy alias retained during the migration away from snapshot-version keyed
// chart caches. New code should use buildPortfolioDataRevisionSig instead.
export const buildSnapshotVersionSig = (args: {
  walletIds?: string[];
  dataRevisionSig?: string;
  portfolioRevision?: string;
  walletSnapshotVersionById?: Record<string, number | undefined>;
}): string =>
  buildPortfolioDataRevisionSig({
    walletIds: args.walletIds,
    dataRevisionSig: args.dataRevisionSig,
    portfolioRevision: args.portfolioRevision,
  });

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

const getHistoricalRateDependencyStatus = (args: {
  historicalRateDeps: HistoricalRateDependencyMeta[];
  fiatRateSeriesCache: FiatRateSeriesCache | undefined;
}): 'unchanged' | 'pending' | 'changed' => {
  let hasPendingDependency = false;

  for (const dep of args.historicalRateDeps || []) {
    if (!dep?.cacheKey) {
      continue;
    }
    const current = getFiatRateSeriesCacheEntry(
      args.fiatRateSeriesCache,
      dep.cacheKey,
    );
    if (!current) {
      hasPendingDependency = true;
      continue;
    }
    const currentFetchedOn = toOptionalFiniteNumber(current.fetchedOn);
    const currentLastTs = getLatestSeriesPointTs(
      args.fiatRateSeriesCache,
      dep.cacheKey,
    );
    if (dep.fetchedOn !== currentFetchedOn || dep.lastTs !== currentLastTs) {
      return 'changed';
    }
  }

  return hasPendingDependency ? 'pending' : 'unchanged';
};

const isSpotRateDifferent = (a: number, b: number): boolean => {
  if (!(Number.isFinite(a) && Number.isFinite(b))) {
    return true;
  }
  return Math.abs(a - b) > SPOT_RATE_EPSILON;
};

const getPatchableSpotRateChange = (args: {
  cachedTimeframe: CachedBalanceChartTimeframe;
  currentSpotRatesByRateKey: Record<string, number>;
}): {patchable: boolean; changed: boolean} => {
  const relevantRateKeys = Object.keys(
    args.cachedTimeframe.latestHoldingsByRateKey || {},
  )
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  if (!relevantRateKeys.length) {
    return {patchable: false, changed: false};
  }

  let changed = false;
  for (const rateKey of relevantRateKeys) {
    const currentRate = args.currentSpotRatesByRateKey?.[rateKey];
    if (
      !(
        typeof currentRate === 'number' &&
        Number.isFinite(currentRate) &&
        currentRate > 0
      )
    ) {
      return {patchable: false, changed: true};
    }
    const cachedRate = args.cachedTimeframe.lastSpotRatesByRateKey?.[rateKey];
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
  dataRevisionSig: string;
  currentSpotRatesByRateKey: Record<string, number>;
  asOfMs?: number;
  fiatRateSeriesCache: FiatRateSeriesCache | undefined;
}): CachedTimeframeStatus => {
  const cachedTimeframe = args.cachedTimeframe;
  if (!cachedTimeframe) {
    return 'missing';
  }

  if (cachedTimeframe.schemaVersion !== BALANCE_CHART_CACHE_SCHEMA_VERSION) {
    return 'stale_historical';
  }

  if (cachedTimeframe.dataRevisionSig !== args.dataRevisionSig) {
    return 'stale_historical';
  }

  const historicalRateDependencyStatus = getHistoricalRateDependencyStatus({
    historicalRateDeps: cachedTimeframe.historicalRateDeps || [],
    fiatRateSeriesCache: args.fiatRateSeriesCache,
  });
  if (historicalRateDependencyStatus === 'changed') {
    return 'stale_historical';
  }
  if (historicalRateDependencyStatus === 'pending') {
    return 'pending_historical';
  }

  const liveTailPatchState = getLiveTailPatchState({
    cachedTimeframe,
    currentSpotRatesByRateKey: args.currentSpotRatesByRateKey,
    patchedAt: args.asOfMs,
  });
  if (liveTailPatchState.changed) {
    return liveTailPatchState.patchable ? 'patchable' : 'stale_historical';
  }

  return 'fresh';
};

export const buildBalanceChartTimeframeRevision = (args: {
  scopeId: string;
  timeframe: FiatRateInterval;
  dataRevisionSig: string;
  historicalRateDeps: HistoricalRateDependencyMeta[];
  currentSpotRatesByRateKey: Record<string, number>;
}): string => {
  return [
    `v${BALANCE_CHART_CACHE_SCHEMA_VERSION}`,
    args.scopeId,
    args.timeframe,
    args.dataRevisionSig,
    toHistoricalDepSignature(args.historicalRateDeps || []),
    stableRateMapRevision(args.currentSpotRatesByRateKey),
  ].join('|');
};

export const deserializeCachedTimeframeToComputedSeries = (
  cachedTimeframe: CachedBalanceChartTimeframe,
  options?: {
    currentSpotRatesByRateKey?: Record<string, number>;
    patchedAt?: number;
  },
): HydratedBalanceChartSeries => {
  const length = Math.min(
    cachedTimeframe.ts.length,
    cachedTimeframe.totalFiatBalance.length,
    cachedTimeframe.totalPnlChange.length,
    cachedTimeframe.totalUnrealizedPnlFiat.length,
    cachedTimeframe.totalPnlPercent.length,
  );
  const liveTailOverlay =
    options?.currentSpotRatesByRateKey &&
    Object.keys(options.currentSpotRatesByRateKey).length
      ? buildLiveTailOverlayFromSpotRates({
          cachedTimeframe,
          currentSpotRatesByRateKey: options.currentSpotRatesByRateKey,
          patchedAt: options.patchedAt,
        })
      : undefined;

  const analysisPoints: PnlAnalysisPoint[] = [];
  const rawGraphPoints: GraphPoint[] = [];

  for (let i = 0; i < length; i++) {
    const isPatchedLatestPoint = !!liveTailOverlay && i === length - 1;
    const timestamp = isPatchedLatestPoint
      ? liveTailOverlay.timestamp
      : toFiniteNumber(cachedTimeframe.ts[i], Date.now() + i);
    const totalFiatBalance = isPatchedLatestPoint
      ? liveTailOverlay.totalFiatBalance
      : toFiniteNumber(cachedTimeframe.totalFiatBalance[i], 0);
    const totalPnlChange = isPatchedLatestPoint
      ? liveTailOverlay.totalPnlChange
      : toFiniteNumber(cachedTimeframe.totalPnlChange[i], 0);
    const totalUnrealizedPnlFiat = isPatchedLatestPoint
      ? liveTailOverlay.totalUnrealizedPnlFiat
      : toFiniteNumber(cachedTimeframe.totalUnrealizedPnlFiat[i], 0);
    const totalRemainingCostBasisFiat =
      totalFiatBalance - totalUnrealizedPnlFiat;
    const totalPnlPercent = isPatchedLatestPoint
      ? liveTailOverlay.totalPnlPercent
      : toFiniteNumber(cachedTimeframe.totalPnlPercent[i], 0);

    analysisPoints.push({
      timestamp,
      totalFiatBalance,
      totalRemainingCostBasisFiat,
      totalUnrealizedPnlFiat,
      totalPnlChange,
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
    resolveBalanceChartSeriesExtrema({
      graphPoints,
      balanceOffset: cachedTimeframe.balanceOffset,
      exactExtrema:
        liveTailOverlay?.exactExtrema ??
        getExactExtremaFromCachedTimeframe(cachedTimeframe),
    });

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
  wallets: WalletForAnalysisMeta[];
}): {
  lastSpotRatesByRateKey: Record<string, number>;
  latestHoldingsByRateKey: Record<string, {units: number}>;
  latestRemainingCostBasisFiatTotal: number;
} => {
  const analysisPoints = args.analysisPoints || [];
  const latestPoint = analysisPoints.length
    ? analysisPoints[analysisPoints.length - 1]
    : undefined;

  const latestHoldingsByRateKey: Record<string, {units: number}> = {};
  const lastSpotRatesByRateKey: Record<string, number> = {};

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
      const rateKey = getWalletHistoricalRateKey(wallet);
      if (!latestHoldingsByRateKey[rateKey]) {
        latestHoldingsByRateKey[rateKey] = {units: 0};
      }
      latestHoldingsByRateKey[rateKey].units += units;

      if (
        !(rateKey in lastSpotRatesByRateKey) &&
        typeof walletPoint.markRate === 'number' &&
        Number.isFinite(walletPoint.markRate) &&
        walletPoint.markRate > 0
      ) {
        lastSpotRatesByRateKey[rateKey] = walletPoint.markRate;
      }
    }
  }

  return {
    lastSpotRatesByRateKey,
    latestHoldingsByRateKey,
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
  dataRevisionSig: string;
  historicalRateDeps: HistoricalRateDependencyMeta[];
  analysisPoints: PnlAnalysisPoint[];
  exactExtrema?: PnlAnalysisExactExtrema;
  patchMetadata: {
    lastSpotRatesByRateKey: Record<string, number>;
    latestHoldingsByRateKey: Record<string, {units: number}>;
    latestRemainingCostBasisFiatTotal: number;
  };
  builtAt?: number;
}): CachedBalanceChartTimeframe => {
  const ts: number[] = [];
  const totalFiatBalance: number[] = [];
  const totalPnlChange: number[] = [];
  const totalUnrealizedPnlFiat: number[] = [];
  const totalPnlPercent: number[] = [];

  for (const point of args.analysisPoints || []) {
    ts.push(toFiniteNumber(point?.timestamp, Date.now()));
    totalFiatBalance.push(toFiniteNumber(point?.totalFiatBalance, 0));
    totalPnlChange.push(toFiniteNumber(point?.totalPnlChange, 0));
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
    dataRevisionSig: args.dataRevisionSig,
    historicalRateDeps: (args.historicalRateDeps || [])
      .filter(dep => !!dep?.cacheKey)
      .slice()
      .sort((a, b) => a.cacheKey.localeCompare(b.cacheKey))
      .map(dep => ({
        cacheKey: dep.cacheKey,
        fetchedOn: toOptionalFiniteNumber(dep.fetchedOn),
        lastTs: toOptionalFiniteNumber(dep.lastTs),
      })),
    lastSpotRatesByRateKey: {
      ...(args.patchMetadata?.lastSpotRatesByRateKey || {}),
    },
    latestHoldingsByRateKey: {
      ...(args.patchMetadata?.latestHoldingsByRateKey || {}),
    },
    latestRemainingCostBasisFiatTotal: toFiniteNumber(
      args.patchMetadata?.latestRemainingCostBasisFiatTotal,
      0,
    ),
    ts,
    totalFiatBalance,
    totalPnlChange,
    totalUnrealizedPnlFiat,
    totalPnlPercent,
    minTotalFiatBalance: toOptionalFiniteNumber(
      args.exactExtrema?.min.totalFiatBalance,
    ),
    minTotalFiatBalanceTs: toOptionalFiniteNumber(
      args.exactExtrema?.min.timestamp,
    ),
    maxTotalFiatBalance: toOptionalFiniteNumber(
      args.exactExtrema?.max.totalFiatBalance,
    ),
    maxTotalFiatBalanceTs: toOptionalFiniteNumber(
      args.exactExtrema?.max.timestamp,
    ),
    minTotalFiatBalanceExcludingEnd: toOptionalFiniteNumber(
      args.exactExtrema?.minExcludingEnd?.totalFiatBalance,
    ),
    minTotalFiatBalanceExcludingEndTs: toOptionalFiniteNumber(
      args.exactExtrema?.minExcludingEnd?.timestamp,
    ),
    maxTotalFiatBalanceExcludingEnd: toOptionalFiniteNumber(
      args.exactExtrema?.maxExcludingEnd?.totalFiatBalance,
    ),
    maxTotalFiatBalanceExcludingEndTs: toOptionalFiniteNumber(
      args.exactExtrema?.maxExcludingEnd?.timestamp,
    ),
  };
};

export const patchCachedLatestPointWithSpotRates = (args: {
  cachedTimeframe: CachedBalanceChartTimeframe;
  currentSpotRatesByRateKey: Record<string, number>;
  patchedAt?: number;
}): CachedBalanceChartTimeframe => {
  const liveTailOverlay = buildLiveTailOverlayFromSpotRates(args);
  if (!liveTailOverlay) {
    return args.cachedTimeframe;
  }

  const lastIndex = args.cachedTimeframe.totalFiatBalance.length - 1;
  if (lastIndex < 0) {
    return args.cachedTimeframe;
  }

  const nextTs = args.cachedTimeframe.ts.slice();
  const nextTotalFiatBalance = args.cachedTimeframe.totalFiatBalance.slice();
  const nextTotalPnlChange = args.cachedTimeframe.totalPnlChange.slice();
  const nextTotalUnrealizedPnlFiat =
    args.cachedTimeframe.totalUnrealizedPnlFiat.slice();
  const nextTotalPnlPercent = args.cachedTimeframe.totalPnlPercent.slice();

  nextTs[lastIndex] = liveTailOverlay.timestamp;
  nextTotalFiatBalance[lastIndex] = liveTailOverlay.totalFiatBalance;
  nextTotalUnrealizedPnlFiat[lastIndex] =
    liveTailOverlay.totalUnrealizedPnlFiat;
  nextTotalPnlChange[lastIndex] = liveTailOverlay.totalPnlChange;
  nextTotalPnlPercent[lastIndex] = liveTailOverlay.totalPnlPercent;

  return {
    ...args.cachedTimeframe,
    builtAt: liveTailOverlay.builtAt,
    lastSpotRatesByRateKey: liveTailOverlay.lastSpotRatesByRateKey,
    ts: nextTs,
    totalFiatBalance: nextTotalFiatBalance,
    totalPnlChange: nextTotalPnlChange,
    totalUnrealizedPnlFiat: nextTotalUnrealizedPnlFiat,
    totalPnlPercent: nextTotalPnlPercent,
    minTotalFiatBalance:
      liveTailOverlay.exactExtrema?.min === undefined
        ? args.cachedTimeframe.minTotalFiatBalance
        : toOptionalFiniteNumber(liveTailOverlay.exactExtrema.min.totalFiatBalance),
    minTotalFiatBalanceTs:
      liveTailOverlay.exactExtrema?.min === undefined
        ? args.cachedTimeframe.minTotalFiatBalanceTs
        : toOptionalFiniteNumber(liveTailOverlay.exactExtrema.min.timestamp),
    maxTotalFiatBalance:
      liveTailOverlay.exactExtrema?.max === undefined
        ? args.cachedTimeframe.maxTotalFiatBalance
        : toOptionalFiniteNumber(liveTailOverlay.exactExtrema.max.totalFiatBalance),
    maxTotalFiatBalanceTs:
      liveTailOverlay.exactExtrema?.max === undefined
        ? args.cachedTimeframe.maxTotalFiatBalanceTs
        : toOptionalFiniteNumber(liveTailOverlay.exactExtrema.max.timestamp),
  };
};
