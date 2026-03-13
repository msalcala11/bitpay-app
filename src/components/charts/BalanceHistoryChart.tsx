import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {InteractionManager, StyleProp, View, ViewStyle} from 'react-native';
import {useTranslation} from 'react-i18next';
import {useTheme} from 'styled-components/native';
import type {GraphPoint} from 'react-native-graph';
import Animated, {
  type SharedValue,
  useAnimatedStyle,
} from 'react-native-reanimated';
import {
  FIAT_RATE_SERIES_CACHED_INTERVALS,
  FIAT_RATE_SERIES_TARGET_POINTS,
  getFiatRateSeriesCacheKey,
  type FiatRateInterval,
  type FiatRateSeriesCache,
  type Rates,
} from '../../store/rate/rate.models';
import type {BalanceSnapshot} from '../../store/portfolio/portfolio.models';
import type {Wallet} from '../../store/wallet/wallet.models';
import {fetchFiatRateSeriesInterval} from '../../store/wallet/effects';
import {upsertBalanceChartScopeTimeframes} from '../../store/portfolio-charts';
import TimeframeSelector from './TimeframeSelector';
import InteractiveLineChart from './InteractiveLineChart';
import ChartSelectionDot from './ChartSelectionDot';
import ChartChangeRow from './ChartChangeRow';
import {useBalanceChartChangeRow} from './useBalanceChartChangeRow';
import {Action, LinkBlue, White} from '../../styles/colors';
import haptic from '../haptic-feedback/haptic';
import {
  buildPnlCurrentRatesByAssetIdFromWallets,
  buildPnlCurrentRatesByCoinFromWallets,
  buildPnlWalletInputsFromPortfolioSnapshots,
} from '../../utils/portfolio/assets';
import {useAppDispatch, useAppSelector} from '../../utils/hooks';
import {normalizeFiatRateSeriesCoin} from '../../utils/portfolio/core/pnl/rates';
import {buildPnlAnalysisSeries} from '../../utils/portfolio/core/pnl/analysis';
import {isNumberSharedValue} from './sharedValueGuards';
import {
  buildBalanceChartScopeId,
  buildHistoricalRateDependencyMetadataFromCache,
  buildLatestPointPatchMetadataFromAnalysis,
  deserializeCachedTimeframeToComputedSeries,
  getCachedTimeframeStatus,
  normalizeGraphPointsForChart,
  patchCachedLatestPointWithSpotRates,
  recomputeMinMaxFromGraphPoints,
  serializeComputedSeriesToCachedTimeframe,
} from '../../utils/portfolio/chartCache';
import {
  buildBalanceChartPointByTimestampMap,
  getSortedUniqueWalletIds,
} from '../../utils/portfolio/balanceChartShared';
import {
  getFiatChartTimeframeOptions,
  getSeriesIntervalForFiatTimeframe,
} from './fiatTimeframes';
import {useChartAxisLabelRenderers} from './useChartAxisLabelRenderers';
import type {ComputedSeries} from './balanceHistoryChart.types';

type TimeframeSeriesState = Partial<
  Record<FiatRateInterval, {revision: string; series: ComputedSeries}>
>;

type TimeframeStatus = 'idle' | 'loading' | 'ready' | 'error';
type TimeframeStatusState = Partial<Record<FiatRateInterval, TimeframeStatus>>;

const BALANCE_CHART_MEMORY_CACHE_MAX_ENTRIES = 24;
const balanceChartMemoryCache = new Map<string, ComputedSeries>();

const setBalanceChartMemoryCache = (
  revision: string,
  series: ComputedSeries,
): void => {
  if (!revision) {
    return;
  }

  if (balanceChartMemoryCache.has(revision)) {
    balanceChartMemoryCache.delete(revision);
  }
  balanceChartMemoryCache.set(revision, series);

  while (balanceChartMemoryCache.size > BALANCE_CHART_MEMORY_CACHE_MAX_ENTRIES) {
    const oldestKey = balanceChartMemoryCache.keys().next().value as
      | string
      | undefined;
    if (!oldestKey) {
      break;
    }
    balanceChartMemoryCache.delete(oldestKey);
  }
};

const hashStringFNV1a = (input: string): string => {
  let hash = 2166136261;

  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
};

const buildSnapshotsSignature = (args: {
  walletIds: string[];
  snapshotsByWalletId: {[walletId: string]: BalanceSnapshot[] | undefined};
}): string => {
  return args.walletIds
    .map(walletId => {
      const snapshots = Array.isArray(args.snapshotsByWalletId?.[walletId])
        ? (args.snapshotsByWalletId[walletId] as BalanceSnapshot[])
        : [];

      let earliestTs = Number.POSITIVE_INFINITY;
      let latestTs = Number.NEGATIVE_INFINITY;
      let signatureSource = '';

      for (const snapshot of snapshots) {
        const ts = Number(snapshot?.timestamp || 0);
        if (ts < earliestTs) {
          earliestTs = ts;
        }
        if (ts > latestTs) {
          latestTs = ts;
        }

        signatureSource += [
          ts,
          String(snapshot?.cryptoBalance || '0'),
          Number(snapshot?.remainingCostBasisFiat || 0),
          Number(snapshot?.unrealizedPnlFiat || 0),
          String(snapshot?.quoteCurrency || ''),
        ].join(':');
        signatureSource += '|';
      }

      return [
        walletId,
        snapshots.length,
        Number.isFinite(earliestTs) ? earliestTs : 0,
        Number.isFinite(latestTs) ? latestTs : 0,
        hashStringFNV1a(signatureSource),
      ].join(':');
    })
    .join('|');
};

const buildHistoricalRateCacheSignature = (args: {
  fiatRateSeriesCache: FiatRateSeriesCache | undefined;
  fiatCode: string;
  coins: string[];
}): string => {
  const fiatCode = String(args.fiatCode || '').toUpperCase();
  if (!fiatCode || !args.coins.length) {
    return '';
  }

  const parts: string[] = [];

  for (const coin of args.coins) {
    for (const interval of FIAT_RATE_SERIES_CACHED_INTERVALS) {
      const cacheKey = getFiatRateSeriesCacheKey(fiatCode, coin, interval);
      const series = args.fiatRateSeriesCache?.[cacheKey];
      const points = Array.isArray(series?.points) ? series.points : [];
      const lastTs = points.length ? Number(points[points.length - 1]?.ts || 0) : 0;
      parts.push(
        `${cacheKey}:${Number(series?.fetchedOn || 0)}:${points.length}:${lastTs}`,
      );
    }
  }

  return parts.join('|');
};

const buildComputedSeriesFromAnalysisPoints = (args: {
  analysisPoints: ComputedSeries['analysisPoints'];
  balanceOffset: number;
}): ComputedSeries | undefined => {
  const analysisPoints = args.analysisPoints || [];
  if (!analysisPoints.length) {
    return undefined;
  }

  const graphPoints = normalizeGraphPointsForChart(
    analysisPoints.map(point => ({
      date: new Date(point.timestamp),
      value: Number(point.totalFiatBalance || 0) + args.balanceOffset,
    })),
  );

  if (!graphPoints.length) {
    return undefined;
  }

  const {minIndex, maxIndex, minPoint, maxPoint} =
    recomputeMinMaxFromGraphPoints(graphPoints);

  return {
    graphPoints,
    analysisPoints,
    pointByTimestamp: buildBalanceChartPointByTimestampMap({
      graphPoints,
      analysisPoints,
    }),
    minIndex,
    maxIndex,
    minPoint,
    maxPoint,
  };
};

const isLikelyPendingHistoricalDataError = (error: unknown): boolean => {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
      ? error
      : '';

  if (!message) {
    return false;
  }

  return /missing cached rate|no usable points after filtering|no overlapping rate window|no usable rate window|returned no points/i.test(
    message,
  );
};

export type BalanceHistoryChartProps = {
  wallets: Wallet[];
  snapshotsByWalletId: {[walletId: string]: BalanceSnapshot[] | undefined};
  quoteCurrency: string;
  initialSelectedTimeframe?: FiatRateInterval;
  rates?: Rates;
  fiatRateSeriesCache?: FiatRateSeriesCache;
  lineColor?: string;
  lineThickness?: number;
  /**
   * If true, the computed ALL series is persisted in Redux/MMKV for this chart
   * scope and reused on the next app open.
   */
  persistAllTimeframe?: boolean;
  /**
   * Optional scale applied by an ancestor transform. When provided, chart
   * strokes (and guide line dash pattern) will be compensated so they remain
   * visually constant under scaling.
   */
  strokeScale?: number | SharedValue<number> | Readonly<SharedValue<number>>;
  /**
   * Optional lower bound for `strokeScale`. When provided, the chart can
   * reserve enough static path padding up-front to avoid edge clipping at the
   * smallest collapse scale.
   */
  minStrokeScale?: number;
  gradientStartColor?: string;
  showLoaderWhenNoSnapshots?: boolean;
  /**
   * Optional constant offset to add to rendered balance points.
   * Useful when a portion of the displayed balance cannot be historized.
   */
  balanceOffset?: number;
  onSelectedBalanceChange?: (balance?: number) => void;
  /**
   * Optional content rendered between the PnL change row and the line chart.
   */
  preChartContent?: React.ReactNode;
  /**
   * Optional top spacing for preChartContent. Defaults to 22.
   */
  preChartContentTopMargin?: number;
  /**
   * Optional style override for the PnL change row container.
   */
  changeRowStyle?: StyleProp<ViewStyle>;
  /**
   * Whether to render the top PnL change row. Defaults to true.
   */
  showChangeRow?: boolean;
  /**
   * Whether to render the timeframe selector row. Defaults to true.
   */
  showTimeframeSelector?: boolean;
  /**
   * Optional opacity for the timeframe selector row.
   */
  timeframeSelectorOpacity?:
    | number
    | SharedValue<number>
    | Readonly<SharedValue<number>>;
  /**
   * Disable chart scrubbing interactions.
   */
  disablePanGesture?: boolean;
  /**
   * Optional callback with computed change-row values.
   */
  onChangeRowData?: (data?: {
    percent: number;
    deltaFiatFormatted?: string;
    rangeLabel?: string;
  }) => void;
  /**
   * Optional opacity for min/max axis labels.
   */
  axisLabelOpacity?:
    | number
    | SharedValue<number>
    | Readonly<SharedValue<number>>;
  onSelectedTimeframeChange?: (timeframe: FiatRateInterval) => void;
};

const BalanceHistoryChart = ({
  wallets,
  snapshotsByWalletId,
  quoteCurrency,
  initialSelectedTimeframe = 'ALL',
  rates,
  fiatRateSeriesCache,
  lineColor,
  lineThickness,
  persistAllTimeframe = false,
  strokeScale,
  minStrokeScale,
  gradientStartColor,
  showLoaderWhenNoSnapshots = false,
  balanceOffset = 0,
  onSelectedBalanceChange,
  preChartContent,
  preChartContentTopMargin = 22,
  changeRowStyle,
  showChangeRow = true,
  showTimeframeSelector = true,
  timeframeSelectorOpacity = 1,
  disablePanGesture = false,
  onChangeRowData,
  axisLabelOpacity = 1,
  onSelectedTimeframeChange,
}: BalanceHistoryChartProps): React.ReactElement | null => {
  const {t} = useTranslation();
  const theme = useTheme();
  const dispatch = useAppDispatch();

  const normalizedQuoteCurrency = String(quoteCurrency || '').toUpperCase();
  const [selectedTimeframe, setSelectedTimeframe] = useState<FiatRateInterval>(
    initialSelectedTimeframe,
  );
  const [chartWidth, setChartWidth] = useState<number | undefined>(undefined);
  const [selectedPoint, setSelectedPoint] = useState<GraphPoint | undefined>();
  const [seriesByTimeframe, setSeriesByTimeframe] =
    useState<TimeframeSeriesState>({});
  const [statusByTimeframe, setStatusByTimeframe] =
    useState<TimeframeStatusState>({});

  const seriesByTimeframeRef = useRef(seriesByTimeframe);
  useEffect(() => {
    seriesByTimeframeRef.current = seriesByTimeframe;
  }, [seriesByTimeframe]);

  const statusByTimeframeRef = useRef(statusByTimeframe);
  useEffect(() => {
    statusByTimeframeRef.current = statusByTimeframe;
  }, [statusByTimeframe]);

  const gestureStarted = useRef(false);
  const lastHapticPointTsRef = useRef<number | undefined>(undefined);

  const onSelectedBalanceChangeRef = useRef(onSelectedBalanceChange);
  useEffect(() => {
    onSelectedBalanceChangeRef.current = onSelectedBalanceChange;
  }, [onSelectedBalanceChange]);

  const sortedWalletIds = useMemo(() => {
    return getSortedUniqueWalletIds(
      (wallets || []).map(wallet => String(wallet.id || '')),
    );
  }, [wallets]);

  const relevantWallets = useMemo(() => {
    const walletById = new Map<string, Wallet>();

    for (const wallet of wallets || []) {
      const walletId = String(wallet.id || '');
      if (!walletId || walletById.has(walletId)) {
        continue;
      }
      walletById.set(walletId, wallet);
    }

    return sortedWalletIds
      .map(walletId => walletById.get(walletId))
      .filter((wallet): wallet is Wallet => !!wallet);
  }, [sortedWalletIds, wallets]);

  const relevantSnapshotsByWalletId = useMemo(() => {
    const next: {[walletId: string]: BalanceSnapshot[] | undefined} = {};

    for (const walletId of sortedWalletIds) {
      next[walletId] = snapshotsByWalletId?.[walletId];
    }

    return next;
  }, [snapshotsByWalletId, sortedWalletIds]);

  const walletsSig = useMemo(() => {
    return relevantWallets
      .map(wallet => {
        const walletId = String(wallet.id || '');
        const currencyAbbreviation = String(
          wallet.currencyAbbreviation || '',
        ).toLowerCase();
        const chain = String(wallet.chain || '').toLowerCase();
        const tokenAddress = String(wallet.tokenAddress || '').toLowerCase();
        const network = String(wallet.network || '').toLowerCase();

        return [
          walletId,
          currencyAbbreviation,
          chain,
          tokenAddress,
          network,
        ].join(':');
      })
      .join(',');
  }, [relevantWallets]);

  const snapshotsSig = useMemo(() => {
    return buildSnapshotsSignature({
      walletIds: sortedWalletIds,
      snapshotsByWalletId: relevantSnapshotsByWalletId,
    });
  }, [relevantSnapshotsByWalletId, sortedWalletIds]);

  const totalSnapshotCount = useMemo(() => {
    return sortedWalletIds.reduce((count, walletId) => {
      const snapshots = relevantSnapshotsByWalletId?.[walletId];
      return count + (Array.isArray(snapshots) ? snapshots.length : 0);
    }, 0);
  }, [relevantSnapshotsByWalletId, sortedWalletIds]);

  const hasAnySnapshots = totalSnapshotCount > 0;

  const scopeId = useMemo(() => {
    return buildBalanceChartScopeId({
      walletIds: sortedWalletIds,
      quoteCurrency: normalizedQuoteCurrency,
      balanceOffset,
    });
  }, [balanceOffset, normalizedQuoteCurrency, sortedWalletIds]);

  const cachedScope = useAppSelector(
    state => state.PORTFOLIO_CHARTS.cacheByScopeId[scopeId],
  );
  const cachedAllTimeframe = cachedScope?.timeframes?.ALL;

  const currentSpotRatesByCoin = useMemo(() => {
    return buildPnlCurrentRatesByCoinFromWallets({
      wallets: relevantWallets,
      quoteCurrency: normalizedQuoteCurrency,
      rates,
    });
  }, [normalizedQuoteCurrency, rates, relevantWallets]);

  const currentSpotRatesByAssetId = useMemo(() => {
    return buildPnlCurrentRatesByAssetIdFromWallets({
      wallets: relevantWallets,
      quoteCurrency: normalizedQuoteCurrency,
      rates,
    });
  }, [normalizedQuoteCurrency, rates, relevantWallets]);

  const currentRatesRevision = useMemo(() => {
    const byCoinRevision = Object.entries(currentSpotRatesByCoin || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([coin, rate]) => `${coin}:${rate}`)
      .join('|');
    const byAssetIdRevision = Object.entries(currentSpotRatesByAssetId || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([assetId, rate]) => `${assetId}:${rate}`)
      .join('|');

    return `${byCoinRevision}||${byAssetIdRevision}`;
  }, [currentSpotRatesByAssetId, currentSpotRatesByCoin]);

  const selectedSeriesInterval = useMemo(() => {
    return getSeriesIntervalForFiatTimeframe(selectedTimeframe);
  }, [selectedTimeframe]);

  const fiatChartTimeframeOptions = useMemo(
    () => getFiatChartTimeframeOptions(t),
    [t],
  );

  const rateFetchAssets = useMemo(() => {
    const assets: Array<{
      coinForCacheCheck: string;
      chain?: string;
      tokenAddress?: string;
    }> = [];
    const seen = new Set<string>();

    for (const wallet of relevantWallets) {
      const coinForCacheCheck = normalizeFiatRateSeriesCoin(
        wallet.currencyAbbreviation || '',
      );
      if (!coinForCacheCheck) {
        continue;
      }

      const chainRaw = typeof wallet.chain === 'string' ? wallet.chain : '';
      const chain = chainRaw ? chainRaw.toLowerCase() : undefined;
      const tokenAddressRaw =
        typeof wallet.tokenAddress === 'string' ? wallet.tokenAddress : '';
      const tokenAddress = tokenAddressRaw
        ? tokenAddressRaw.toLowerCase()
        : undefined;
      const dedupeKey = `${coinForCacheCheck}|${chain || ''}|${
        tokenAddress || ''
      }`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);

      assets.push({
        coinForCacheCheck,
        chain: tokenAddress ? chain : undefined,
        tokenAddress,
      });
    }

    return assets;
  }, [relevantWallets]);

  const historicalRateCacheCoins = useMemo(() => {
    return Array.from(
      new Set(rateFetchAssets.map(asset => asset.coinForCacheCheck)),
    ).sort((a, b) => a.localeCompare(b));
  }, [rateFetchAssets]);

  const historicalRateCacheSignature = useMemo(() => {
    return buildHistoricalRateCacheSignature({
      fiatRateSeriesCache,
      fiatCode: normalizedQuoteCurrency,
      coins: historicalRateCacheCoins,
    });
  }, [fiatRateSeriesCache, historicalRateCacheCoins, normalizedQuoteCurrency]);

  const cachedAllStatus = useMemo(() => {
    return getCachedTimeframeStatus({
      cachedTimeframe: cachedAllTimeframe,
      snapshotVersionSig: snapshotsSig,
      currentSpotRatesByAssetId,
      fiatRateSeriesCache,
    });
  }, [
    cachedAllTimeframe,
    currentSpotRatesByAssetId,
    fiatRateSeriesCache,
    snapshotsSig,
  ]);

  const usableCachedAllTimeframe = useMemo(() => {
    if (!cachedAllTimeframe) {
      return undefined;
    }

    switch (cachedAllStatus) {
      case 'fresh':
        return cachedAllTimeframe;
      case 'patchable':
        return patchCachedLatestPointWithSpotRates({
          cachedTimeframe: cachedAllTimeframe,
          currentSpotRatesByAssetId,
        });
      default:
        return undefined;
    }
  }, [cachedAllStatus, cachedAllTimeframe, currentSpotRatesByAssetId]);

  useEffect(() => {
    if (
      !cachedAllTimeframe ||
      !usableCachedAllTimeframe ||
      cachedAllStatus !== 'patchable'
    ) {
      return;
    }

    dispatch(
      upsertBalanceChartScopeTimeframes({
        scopeId,
        walletIds: sortedWalletIds,
        quoteCurrency: normalizedQuoteCurrency,
        balanceOffset,
        timeframes: [usableCachedAllTimeframe],
      }),
    );
  }, [
    balanceOffset,
    cachedAllStatus,
    cachedAllTimeframe,
    dispatch,
    normalizedQuoteCurrency,
    scopeId,
    sortedWalletIds,
    usableCachedAllTimeframe,
  ]);

  const displayableCachedAllTimeframe = useMemo(() => {
    if (usableCachedAllTimeframe) {
      return usableCachedAllTimeframe;
    }

    if (
      !cachedAllTimeframe ||
      cachedAllTimeframe.snapshotVersionSig !== snapshotsSig
    ) {
      return undefined;
    }

    return patchCachedLatestPointWithSpotRates({
      cachedTimeframe: cachedAllTimeframe,
      currentSpotRatesByAssetId,
    });
  }, [
    cachedAllTimeframe,
    currentSpotRatesByAssetId,
    snapshotsSig,
    usableCachedAllTimeframe,
  ]);

  const reusablePersistedAllSeries = useMemo(() => {
    return usableCachedAllTimeframe
      ? deserializeCachedTimeframeToComputedSeries(usableCachedAllTimeframe)
      : undefined;
  }, [usableCachedAllTimeframe]);

  const displayablePersistedAllSeries = useMemo(() => {
    if (reusablePersistedAllSeries) {
      return reusablePersistedAllSeries;
    }

    return displayableCachedAllTimeframe
      ? deserializeCachedTimeframeToComputedSeries(displayableCachedAllTimeframe)
      : undefined;
  }, [displayableCachedAllTimeframe, reusablePersistedAllSeries]);

  const buildTimeframeRevision = useCallback(
    (timeframe: FiatRateInterval) => {
      return [
        scopeId,
        timeframe,
        walletsSig,
        snapshotsSig,
        historicalRateCacheSignature,
        currentRatesRevision,
      ].join('|');
    },
    [
      currentRatesRevision,
      historicalRateCacheSignature,
      scopeId,
      snapshotsSig,
      walletsSig,
    ],
  );

  const setTimeframeStatus = useCallback(
    (timeframe: FiatRateInterval, nextStatus: TimeframeStatus) => {
      setStatusByTimeframe(prev => {
        if (prev[timeframe] === nextStatus) {
          return prev;
        }
        return {
          ...prev,
          [timeframe]: nextStatus,
        };
      });
    },
    [],
  );

  const setTimeframeSeries = useCallback(
    (
      timeframe: FiatRateInterval,
      revision: string,
      nextSeries: ComputedSeries,
    ) => {
      setSeriesByTimeframe(prev => {
        const current = prev[timeframe];
        if (current?.revision === revision && current.series === nextSeries) {
          return prev;
        }
        return {
          ...prev,
          [timeframe]: {
            revision,
            series: nextSeries,
          },
        };
      });
    },
    [],
  );

  const ensureTimeframeSeries = useCallback(
    (
      timeframe: FiatRateInterval,
      options?: {persist?: boolean; background?: boolean},
    ) => {
      const revision = buildTimeframeRevision(timeframe);
      const existing = seriesByTimeframeRef.current[timeframe];
      if (existing?.revision === revision) {
        if (!options?.background) {
          setTimeframeStatus(timeframe, 'ready');
        }
        return () => undefined;
      }

      const cachedFromMemory = balanceChartMemoryCache.get(revision);
      if (cachedFromMemory) {
        setTimeframeSeries(timeframe, revision, cachedFromMemory);
        if (!options?.background) {
          setTimeframeStatus(timeframe, 'ready');
        }
        return () => undefined;
      }

      if (timeframe === 'ALL' && reusablePersistedAllSeries) {
        if (!options?.background) {
          setTimeframeStatus(timeframe, 'ready');
        }
        return () => undefined;
      }

      if (!options?.background) {
        setTimeframeStatus(timeframe, 'loading');
      }

      let cancelled = false;
      const task = InteractionManager.runAfterInteractions(() => {
        if (cancelled) {
          return;
        }

        try {
          if (!fiatRateSeriesCache) {
            return;
          }

          const historicalDepKeys = new Set<string>();
          const prepared = buildPnlWalletInputsFromPortfolioSnapshots({
            wallets: relevantWallets,
            snapshotsByWalletId: relevantSnapshotsByWalletId,
            quoteCurrency: normalizedQuoteCurrency,
            fiatRateSeriesCache,
            onHistoricalRateDependency: cacheKey => {
              if (cacheKey) {
                historicalDepKeys.add(cacheKey);
              }
            },
          });

          if (!prepared.wallets.length) {
            return;
          }

          const analysis = buildPnlAnalysisSeries({
            wallets: prepared.wallets,
            timeframe,
            quoteCurrency: prepared.quoteCurrency,
            fiatRateSeriesCache,
            currentRatesByCoin: currentSpotRatesByCoin,
            currentRatesByAssetId: currentSpotRatesByAssetId,
            maxPoints: FIAT_RATE_SERIES_TARGET_POINTS,
            outputMode: 'chart',
            onHistoricalRateDependency: cacheKey => {
              if (cacheKey) {
                historicalDepKeys.add(cacheKey);
              }
            },
          });

          const nextSeries = buildComputedSeriesFromAnalysisPoints({
            analysisPoints: analysis.points,
            balanceOffset,
          });

          if (!nextSeries || cancelled) {
            return;
          }

          setBalanceChartMemoryCache(revision, nextSeries);
          setTimeframeSeries(timeframe, revision, nextSeries);
          if (!options?.background) {
            setTimeframeStatus(timeframe, 'ready');
          }

          if (options?.persist && timeframe === 'ALL') {
            dispatch(
              upsertBalanceChartScopeTimeframes({
                scopeId,
                walletIds: sortedWalletIds,
                quoteCurrency: normalizedQuoteCurrency,
                balanceOffset,
                timeframes: [
                  serializeComputedSeriesToCachedTimeframe({
                    timeframe: 'ALL',
                    walletIds: sortedWalletIds,
                    quoteCurrency: normalizedQuoteCurrency,
                    balanceOffset,
                    snapshotVersionSig: snapshotsSig,
                    historicalRateDeps:
                      buildHistoricalRateDependencyMetadataFromCache({
                        depKeys: historicalDepKeys,
                        fiatRateSeriesCache,
                      }),
                    analysisPoints: analysis.points,
                    patchMetadata: buildLatestPointPatchMetadataFromAnalysis({
                      analysisPoints: analysis.points,
                      wallets: prepared.wallets,
                    }),
                  }),
                ],
              }),
            );
          }
        } catch (error) {
          if (cancelled || options?.background) {
            return;
          }

          const currentSeries =
            seriesByTimeframeRef.current[timeframe]?.revision === revision
              ? seriesByTimeframeRef.current[timeframe]?.series
              : timeframe === 'ALL'
              ? displayablePersistedAllSeries
              : undefined;

          const shouldKeepLoading =
            !currentSeries && isLikelyPendingHistoricalDataError(error);
          setTimeframeStatus(timeframe, shouldKeepLoading ? 'loading' : 'error');
        }
      });

      return () => {
        cancelled = true;
        task.cancel();
      };
    },
    [
      balanceOffset,
      buildTimeframeRevision,
      currentSpotRatesByAssetId,
      currentSpotRatesByCoin,
      dispatch,
      fiatRateSeriesCache,
      normalizedQuoteCurrency,
      displayablePersistedAllSeries,
      relevantSnapshotsByWalletId,
      reusablePersistedAllSeries,
      relevantWallets,
      scopeId,
      setTimeframeSeries,
      setTimeframeStatus,
      snapshotsSig,
      sortedWalletIds,
    ],
  );

  useEffect(() => {
    if (!hasAnySnapshots) {
      return;
    }

    const cleanups: Array<() => void> = [];
    cleanups.push(
      ensureTimeframeSeries(selectedTimeframe, {
        persist: persistAllTimeframe && selectedTimeframe === 'ALL',
      }),
    );

    if (persistAllTimeframe && selectedTimeframe !== 'ALL') {
      cleanups.push(
        ensureTimeframeSeries('ALL', {
          persist: true,
          background: true,
        }),
      );
    }

    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [
    ensureTimeframeSeries,
    hasAnySnapshots,
    persistAllTimeframe,
    selectedTimeframe,
  ]);

  const rateFetchIntervals = useMemo(() => {
    const intervals = new Set<FiatRateInterval>([selectedSeriesInterval]);
    if (persistAllTimeframe) {
      intervals.add('ALL');
    }
    return Array.from(intervals);
  }, [persistAllTimeframe, selectedSeriesInterval]);

  useEffect(() => {
    if (!hasAnySnapshots || !normalizedQuoteCurrency || !rateFetchAssets.length) {
      return;
    }

    for (const asset of rateFetchAssets) {
      for (const interval of rateFetchIntervals) {
        dispatch(
          fetchFiatRateSeriesInterval({
            fiatCode: normalizedQuoteCurrency,
            interval,
            coinForCacheCheck: asset.coinForCacheCheck,
            chain: asset.chain,
            tokenAddress: asset.tokenAddress,
          }) as any,
        );
      }
    }
  }, [
    dispatch,
    hasAnySnapshots,
    normalizedQuoteCurrency,
    rateFetchAssets,
    rateFetchIntervals,
  ]);

  const selectedRevision = useMemo(
    () => buildTimeframeRevision(selectedTimeframe),
    [buildTimeframeRevision, selectedTimeframe],
  );

  useEffect(() => {
    gestureStarted.current = false;
    lastHapticPointTsRef.current = undefined;
    setSelectedPoint(undefined);
    onSelectedBalanceChangeRef.current?.(undefined);
  }, [selectedRevision]);

  const timeframeSelectorOpacityIsSharedValue = isNumberSharedValue(
    timeframeSelectorOpacity,
  );
  const sharedTimeframeSelectorOpacity = timeframeSelectorOpacityIsSharedValue
    ? timeframeSelectorOpacity
    : undefined;
  const timeframeSelectorOpacityNumber =
    typeof timeframeSelectorOpacity === 'number' ? timeframeSelectorOpacity : 1;

  const timeframeSelectorAnimatedStyle = useAnimatedStyle(() => {
    return {
      opacity: sharedTimeframeSelectorOpacity
        ? sharedTimeframeSelectorOpacity.value
        : timeframeSelectorOpacityNumber,
    };
  }, [sharedTimeframeSelectorOpacity, timeframeSelectorOpacityNumber]);

  const selectedSeries = useMemo(() => {
    const entry = seriesByTimeframe[selectedTimeframe];
    if (entry?.revision === selectedRevision) {
      return entry.series;
    }

    return selectedTimeframe === 'ALL'
      ? displayablePersistedAllSeries
      : undefined;
  }, [
    displayablePersistedAllSeries,
    selectedRevision,
    selectedTimeframe,
    seriesByTimeframe,
  ]);

  const hasAnyRenderableSeries = !!selectedSeries?.graphPoints?.length;
  const selectedStatus = statusByTimeframe[selectedTimeframe];
  const isChartLoadingRaw =
    hasAnySnapshots &&
    !hasAnyRenderableSeries &&
    selectedStatus !== 'ready' &&
    selectedStatus !== 'error';
  const isChartLoaderVisible = isChartLoadingRaw;

  const fallbackLastAnalysisPoint = useMemo(() => {
    const points = selectedSeries?.analysisPoints || [];
    return points.length ? points[points.length - 1] : undefined;
  }, [selectedSeries]);

  const {displayedChangeRowData} = useBalanceChartChangeRow({
    activeSeries: selectedSeries,
    fallbackAnalysisPoint: fallbackLastAnalysisPoint,
    selectedPoint,
    selectedTimeframe,
    displayedTimeframe: selectedTimeframe,
    quoteCurrency: normalizedQuoteCurrency,
    t,
    resetCacheKey: scopeId,
  });

  useEffect(() => {
    if (!onChangeRowData) {
      return;
    }

    if (!displayedChangeRowData) {
      onChangeRowData(undefined);
      return;
    }

    onChangeRowData({
      percent: displayedChangeRowData.percent,
      deltaFiatFormatted: displayedChangeRowData.deltaFiatFormatted,
      rangeLabel: displayedChangeRowData.rangeLabel,
    });
  }, [displayedChangeRowData, onChangeRowData]);

  const {MinAxisLabel, MaxAxisLabel} = useChartAxisLabelRenderers({
    minLabel: selectedSeries
      ? {
          value: selectedSeries.minPoint.value,
          index: selectedSeries.minIndex,
          arrayLength: selectedSeries.graphPoints.length,
        }
      : undefined,
    maxLabel: selectedSeries
      ? {
          value: selectedSeries.maxPoint.value,
          index: selectedSeries.maxIndex,
          arrayLength: selectedSeries.graphPoints.length,
        }
      : undefined,
    quoteCurrency: normalizedQuoteCurrency,
    chartWidth,
    contentOpacity: axisLabelOpacity,
  });

  const onGestureStarted = useCallback(() => {
    gestureStarted.current = true;
    lastHapticPointTsRef.current = undefined;
  }, []);

  const onGestureEnded = useCallback(() => {
    haptic('impactLight');
    gestureStarted.current = false;
    lastHapticPointTsRef.current = undefined;
    setSelectedPoint(undefined);
    onSelectedBalanceChangeRef.current?.(undefined);
  }, []);

  const onPointSelected = useCallback(
    (point: GraphPoint) => {
      if (!gestureStarted.current || !selectedSeries) {
        return;
      }

      setSelectedPoint(point);
      const pointTs = point.date.getTime();
      if (lastHapticPointTsRef.current !== pointTs) {
        haptic('impactLight');
        lastHapticPointTsRef.current = pointTs;
      }

      const analysisPoint = selectedSeries.pointByTimestamp.get(pointTs);
      const actualBalance =
        typeof analysisPoint?.totalFiatBalance === 'number'
          ? analysisPoint.totalFiatBalance + balanceOffset
          : point.value;
      onSelectedBalanceChangeRef.current?.(actualBalance);
    },
    [balanceOffset, selectedSeries],
  );

  const chartColor = lineColor || (theme.dark ? LinkBlue : Action);
  const gradientBackgroundColor =
    gradientStartColor || (theme.dark ? 'transparent' : White);

  const onChartLayout = useCallback(({nativeEvent: {layout}}) => {
    const nextWidth = Math.round(layout.width);
    if (nextWidth > 0) {
      setChartWidth(prevWidth =>
        prevWidth === nextWidth ? prevWidth : nextWidth,
      );
    }
  }, []);

  if (!hasAnySnapshots) {
    if (showLoaderWhenNoSnapshots) {
      return (
        <View style={{width: '100%'}} onLayout={onChartLayout}>
          {preChartContent ? (
            <View style={{marginTop: preChartContentTopMargin}}>
              {preChartContent}
            </View>
          ) : null}
          <InteractiveLineChart
            points={[]}
            color={chartColor}
            lineThickness={lineThickness}
            chartWidth={chartWidth}
            strokeScale={strokeScale}
            minStrokeScale={minStrokeScale}
            gradientFillColors={[
              gradientBackgroundColor,
              theme.dark ? 'transparent' : White,
            ]}
            isLoading
            hideLineWhileLoading
            enablePanGesture={false}
          />
        </View>
      );
    }

    return preChartContent ? (
      <View style={{marginTop: preChartContentTopMargin}}>
        {preChartContent}
      </View>
    ) : null;
  }

  return (
    <View style={{width: '100%'}} onLayout={onChartLayout}>
      {showChangeRow && displayedChangeRowData ? (
        <ChartChangeRow
          percent={displayedChangeRowData.percent}
          deltaFiatFormatted={displayedChangeRowData.deltaFiatFormatted}
          rangeLabel={displayedChangeRowData.rangeLabel}
          style={changeRowStyle}
        />
      ) : null}
      {preChartContent ? (
        <View style={{marginTop: preChartContentTopMargin}}>
          {preChartContent}
        </View>
      ) : null}

      <InteractiveLineChart
        points={selectedSeries?.graphPoints || []}
        color={chartColor}
        lineThickness={lineThickness}
        strokeScale={strokeScale}
        minStrokeScale={minStrokeScale}
        gradientFillColors={[
          gradientBackgroundColor,
          theme.dark ? 'transparent' : White,
        ]}
        chartWidth={chartWidth}
        showFirstPointGuideLine={hasAnyRenderableSeries}
        isLoading={isChartLoaderVisible}
        hideLineWhileLoading={!hasAnyRenderableSeries}
        enablePanGesture={!isChartLoadingRaw && !disablePanGesture}
        SelectionDot={ChartSelectionDot}
        TopAxisLabel={MaxAxisLabel}
        BottomAxisLabel={MinAxisLabel}
        onGestureStart={onGestureStarted}
        onGestureEnd={onGestureEnded}
        onPointSelected={onPointSelected}
      />

      {showTimeframeSelector ? (
        <Animated.View style={timeframeSelectorAnimatedStyle}>
          <TimeframeSelector
            options={fiatChartTimeframeOptions}
            selected={selectedTimeframe}
            width={chartWidth}
            onSelect={timeframe => {
              setSelectedPoint(undefined);
              onSelectedBalanceChangeRef.current?.(undefined);
              onSelectedTimeframeChange?.(timeframe);
              setSelectedTimeframe(timeframe);
            }}
          />
        </Animated.View>
      ) : null}
    </View>
  );
};

export default BalanceHistoryChart;
