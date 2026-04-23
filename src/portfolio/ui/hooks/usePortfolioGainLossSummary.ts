import {useEffect, useMemo, useRef, useState} from 'react';
import {useIsFocused} from '@react-navigation/native';
import type {FiatRateInterval} from '../../../store/rate/rate.models';
import type {Wallet} from '../../../store/wallet/wallet.models';
import {HISTORIC_RATES_CACHE_DURATION} from '../../../constants/wallet';
import {useAppDispatch} from '../../../utils/hooks';
import type {PortfolioGainLossSummary} from '../../../utils/portfolio/assets';
import {
  BALANCE_GAIN_LOSS_SUMMARY_CACHE_IDENTITY_KEY,
  getCachedBalanceChartTimeframe,
} from '../../../utils/portfolio/chartCache';
import {upsertBalanceChartScopeTimeframes} from '../../../store/portfolio-charts';
import {
  areBalanceChartHistoricalRatesReady,
  buildBalanceChartHistoricalRateDeps,
  buildBalanceChartHistoricalRateRequests,
  getBalanceChartHistoricalRateCacheKeys,
  getBalanceChartHistoricalRateCacheRevision,
  resolveCachedBalanceChartSeries,
  buildCachedTimeframeFromRuntimeChart,
} from '../../../utils/portfolio/balanceChartData';
import {runPortfolioChartQuery} from '../common';
import {usePortfolioBalanceChartScope} from './usePortfolioBalanceChartScope';
import usePortfolioHistoricalRateDepsCache from './usePortfolioHistoricalRateDepsCache';

function buildUnavailableSummaryPart(): PortfolioGainLossSummary['today'] {
  return {
    deltaFiat: 0,
    percentRatio: 0,
    available: false,
  };
}

function buildSummaryPart(args: {
  totalFiatBalance: number | undefined;
  totalPnlChange: number | undefined;
  totalPnlPercent: number | undefined;
  liveFiatTotal: number;
}): PortfolioGainLossSummary['today'] {
  const hasRuntimeData =
    (typeof args.totalFiatBalance === 'number' && args.totalFiatBalance > 0) ||
    !(args.liveFiatTotal > 0);

  if (!hasRuntimeData) {
    return buildUnavailableSummaryPart();
  }

  return {
    deltaFiat:
      typeof args.totalPnlChange === 'number' && Number.isFinite(args.totalPnlChange)
        ? args.totalPnlChange
        : 0,
    percentRatio:
      typeof args.totalPnlPercent === 'number' && Number.isFinite(args.totalPnlPercent)
        ? args.totalPnlPercent / 100
        : 0,
    available: true,
  };
}

function usePortfolioGainLossSummaryTimeframe(args: {
  asOfMs: number;
  cachedTimeframes: Parameters<typeof getCachedBalanceChartTimeframe>[0];
  chartDataRevisionSig: string;
  currentRatesByAssetId: Record<string, number>;
  currentRatesSignature: string;
  currentSpotRatesByRateKey: Record<string, number>;
  dispatch: ReturnType<typeof useAppDispatch>;
  isFocused: boolean;
  liveFiatTotal: number;
  quoteCurrency: string;
  scopeId: string;
  sortedWalletIds: string[];
  storedWalletRequestSig: string;
  storedWallets: ReturnType<typeof usePortfolioBalanceChartScope>['storedWallets'];
  timeframe: FiatRateInterval;
}) {
  const historicalRateRequests = useMemo(() => {
    return buildBalanceChartHistoricalRateRequests({
      wallets: args.storedWallets,
      quoteCurrency: args.quoteCurrency,
      timeframes: [args.timeframe],
    });
  }, [args.quoteCurrency, args.storedWallets, args.timeframe]);

  const {
    cache: fiatRateSeriesCache,
    error: fiatRateSeriesCacheError,
    loading: fiatRateSeriesCacheLoading,
  } = usePortfolioHistoricalRateDepsCache({
    wallets: args.storedWallets,
    quoteCurrency: args.quoteCurrency,
    timeframes: [args.timeframe],
    maxAgeMs: HISTORIC_RATES_CACHE_DURATION * 1000,
    enabled:
      !!args.quoteCurrency &&
      historicalRateRequests.some(group => group.requests.length > 0),
  });

  const historicalRateDepKeys = useMemo(() => {
    return getBalanceChartHistoricalRateCacheKeys({
      wallets: args.storedWallets,
      quoteCurrency: args.quoteCurrency,
      timeframes: [args.timeframe],
    });
  }, [args.quoteCurrency, args.storedWallets, args.timeframe]);

  const historicalRateCacheReady = useMemo(() => {
    return (
      !historicalRateDepKeys.length ||
      areBalanceChartHistoricalRatesReady({
        depKeys: historicalRateDepKeys,
        fiatRateSeriesCache,
      })
    );
  }, [fiatRateSeriesCache, historicalRateDepKeys]);

  const historicalRateCacheRevision = useMemo(() => {
    return getBalanceChartHistoricalRateCacheRevision({
      depKeys: historicalRateDepKeys,
      fiatRateSeriesCache,
    });
  }, [fiatRateSeriesCache, historicalRateDepKeys]);

  const cachedTimeframe = useMemo(() => {
    return getCachedBalanceChartTimeframe(
      args.cachedTimeframes,
      args.timeframe,
    );
  }, [args.cachedTimeframes, args.timeframe]);

  const cachedSeriesResult = useMemo(() => {
    return resolveCachedBalanceChartSeries({
      cachedTimeframe,
      currentSpotRatesByRateKey: args.currentSpotRatesByRateKey,
      dataRevisionSig: args.chartDataRevisionSig,
      asOfMs: args.asOfMs,
      fiatRateSeriesCache: historicalRateCacheReady
        ? fiatRateSeriesCache
        : undefined,
    });
  }, [
    args.asOfMs,
    args.chartDataRevisionSig,
    args.currentSpotRatesByRateKey,
    cachedTimeframe,
    fiatRateSeriesCache,
    historicalRateCacheReady,
  ]);

  const summaryPart = useMemo(() => {
    const lastPoint = cachedSeriesResult.series?.analysisPoints?.[
      (cachedSeriesResult.series.analysisPoints?.length || 1) - 1
    ];

    if (!lastPoint) {
      return buildUnavailableSummaryPart();
    }

    return buildSummaryPart({
      totalFiatBalance: lastPoint.totalFiatBalance,
      totalPnlChange: lastPoint.totalPnlChange,
      totalPnlPercent: lastPoint.totalPnlPercent,
      liveFiatTotal: args.liveFiatTotal,
    });
  }, [args.liveFiatTotal, cachedSeriesResult.series]);

  const inFlightRequestKeyRef = useRef<string | undefined>(undefined);
  const isMountedRef = useRef(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!args.isFocused || !args.storedWallets.length) {
      inFlightRequestKeyRef.current = undefined;
      setLoading(false);
      setError(undefined);
      return;
    }

    const cachedStatus = cachedSeriesResult.status;
    if (
      cachedStatus === 'fresh' ||
      cachedStatus === 'patchable' ||
      cachedStatus === 'pending_historical'
    ) {
      inFlightRequestKeyRef.current = undefined;
      setLoading(false);
      setError(undefined);
      return;
    }

    if (
      historicalRateDepKeys.length &&
      !historicalRateCacheReady &&
      !fiatRateSeriesCacheError &&
      fiatRateSeriesCacheLoading
    ) {
      setLoading(true);
      setError(undefined);
      return;
    }

    const requestKey = [
      args.timeframe,
      args.scopeId,
      args.chartDataRevisionSig,
      args.storedWalletRequestSig,
      args.currentRatesSignature,
      historicalRateCacheRevision,
    ].join('|');
    if (inFlightRequestKeyRef.current === requestKey) {
      return;
    }

    inFlightRequestKeyRef.current = requestKey;
    setLoading(true);
    setError(undefined);

    runPortfolioChartQuery({
      wallets: args.storedWallets,
      quoteCurrency: args.quoteCurrency,
      timeframe: args.timeframe,
      maxPoints: 2,
      currentRatesByAssetId: args.currentRatesByAssetId,
      asOfMs: args.asOfMs,
      debugSource: 'portfolio_gain_loss_summary',
    })
      .then(chart => {
        if (
          !isMountedRef.current ||
          inFlightRequestKeyRef.current !== requestKey
        ) {
          return;
        }

        const cacheEntry = buildCachedTimeframeFromRuntimeChart({
          chart,
          timeframe: args.timeframe,
          walletIds: args.sortedWalletIds,
          quoteCurrency: args.quoteCurrency,
          balanceOffset: 0,
          dataRevisionSig: args.chartDataRevisionSig,
          historicalRateDeps: buildBalanceChartHistoricalRateDeps({
            wallets: args.storedWallets,
            quoteCurrency: args.quoteCurrency,
            timeframes: [args.timeframe],
            fiatRateSeriesCache,
          }),
        });
        if (!cacheEntry) {
          return;
        }

        args.dispatch(
          upsertBalanceChartScopeTimeframes({
            scopeId: args.scopeId,
            walletIds: args.sortedWalletIds,
            quoteCurrency: args.quoteCurrency,
            balanceOffset: 0,
            timeframes: [cacheEntry],
          }),
        );
        setError(undefined);
      })
      .catch(err => {
        if (
          !isMountedRef.current ||
          inFlightRequestKeyRef.current !== requestKey
        ) {
          return;
        }

        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (
          !isMountedRef.current ||
          inFlightRequestKeyRef.current !== requestKey
        ) {
          return;
        }

        inFlightRequestKeyRef.current = undefined;
        setLoading(false);
      });
  }, [
    args.asOfMs,
    args.chartDataRevisionSig,
    args.currentRatesByAssetId,
    args.currentRatesSignature,
    args.dispatch,
    args.isFocused,
    args.quoteCurrency,
    args.scopeId,
    args.sortedWalletIds,
    args.storedWalletRequestSig,
    args.storedWallets,
    args.timeframe,
    cachedSeriesResult.status,
    fiatRateSeriesCache,
    fiatRateSeriesCacheError,
    fiatRateSeriesCacheLoading,
    historicalRateCacheReady,
    historicalRateCacheRevision,
    historicalRateDepKeys.length,
  ]);

  return {
    error,
    loading,
    summaryPart,
  };
}

export function usePortfolioGainLossSummary(args: {
  wallets: Wallet[];
  liveFiatTotal: number;
}) {
  const isFocused = useIsFocused();
  const dispatch = useAppDispatch();
  const {
    asOfMs,
    cachedScope,
    chartDataRevisionSig,
    currentRatesByAssetId,
    currentRatesSignature,
    currentSpotRatesByRateKey,
    quoteCurrency,
    scopeId,
    sortedWalletIds,
    storedWalletRequestSig,
    storedWallets,
  } = usePortfolioBalanceChartScope({
    wallets: args.wallets,
    balanceOffset: 0,
    cacheIdentityKey: BALANCE_GAIN_LOSS_SUMMARY_CACHE_IDENTITY_KEY,
  });

  const today = usePortfolioGainLossSummaryTimeframe({
    asOfMs,
    cachedTimeframes: cachedScope?.timeframes,
    chartDataRevisionSig,
    currentRatesByAssetId,
    currentRatesSignature,
    currentSpotRatesByRateKey,
    dispatch,
    isFocused,
    liveFiatTotal: args.liveFiatTotal,
    quoteCurrency,
    scopeId,
    sortedWalletIds,
    storedWalletRequestSig,
    storedWallets,
    timeframe: '1D',
  });
  const total = usePortfolioGainLossSummaryTimeframe({
    asOfMs,
    cachedTimeframes: cachedScope?.timeframes,
    chartDataRevisionSig,
    currentRatesByAssetId,
    currentRatesSignature,
    currentSpotRatesByRateKey,
    dispatch,
    isFocused,
    liveFiatTotal: args.liveFiatTotal,
    quoteCurrency,
    scopeId,
    sortedWalletIds,
    storedWalletRequestSig,
    storedWallets,
    timeframe: 'ALL',
  });

  const summary: PortfolioGainLossSummary = useMemo(() => {
    return {
      quoteCurrency,
      today: today.summaryPart,
      total: total.summaryPart,
    };
  }, [quoteCurrency, today.summaryPart, total.summaryPart]);

  return {
    summary,
    loading: today.loading || total.loading,
    error: today.error || total.error,
  };
}

export default usePortfolioGainLossSummary;
