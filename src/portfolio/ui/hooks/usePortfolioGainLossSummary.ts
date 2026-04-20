import {useEffect, useMemo, useRef, useState} from 'react';
import {useIsFocused} from '@react-navigation/native';
import type {FiatRateInterval} from '../../../store/rate/rate.models';
import type {Wallet} from '../../../store/wallet/wallet.models';
import {useAppDispatch} from '../../../utils/hooks';
import type {PortfolioGainLossSummary} from '../../../utils/portfolio/assets';
import {
  getCachedBalanceChartTimeframe,
} from '../../../utils/portfolio/chartCache';
import {upsertBalanceChartScopeTimeframes} from '../../../store/portfolio-charts';
import {
  buildCachedTimeframeFromRuntimeChart,
  resolveCachedBalanceChartSeries,
} from '../../../utils/portfolio/balanceChartData';
import {runPortfolioChartQuery} from '../common';
import {usePortfolioBalanceChartScope} from './usePortfolioBalanceChartScope';

const SUMMARY_TIMEFRAMES: FiatRateInterval[] = ['1D', 'ALL'];

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
  });

  const summaryByTimeframe = useMemo(() => {
    const next = new Map<FiatRateInterval, PortfolioGainLossSummary['today']>();

    for (const timeframe of SUMMARY_TIMEFRAMES) {
      const cachedTimeframe = getCachedBalanceChartTimeframe(
        cachedScope?.timeframes,
        timeframe,
      );
      if (!cachedTimeframe) {
        next.set(timeframe, buildUnavailableSummaryPart());
        continue;
      }

      const {series} = resolveCachedBalanceChartSeries({
        cachedTimeframe,
        currentSpotRatesByRateKey,
        dataRevisionSig: chartDataRevisionSig,
        asOfMs,
      });
      const lastPoint = series?.analysisPoints?.[
        (series.analysisPoints?.length || 1) - 1
      ];

      if (!lastPoint) {
        next.set(timeframe, buildUnavailableSummaryPart());
        continue;
      }

      next.set(
        timeframe,
        buildSummaryPart({
          totalFiatBalance: lastPoint?.totalFiatBalance,
          totalPnlChange: lastPoint?.totalPnlChange,
          totalPnlPercent: lastPoint?.totalPnlPercent,
          liveFiatTotal: args.liveFiatTotal,
        }),
      );
    }

    return next;
  }, [
    args.liveFiatTotal,
    asOfMs,
    cachedScope?.timeframes,
    chartDataRevisionSig,
    currentSpotRatesByRateKey,
  ]);

  const inFlightRequestKeyByTimeframeRef = useRef<
    Partial<Record<FiatRateInterval, string>>
  >({});
  const [loadingByTimeframe, setLoadingByTimeframe] = useState<
    Partial<Record<FiatRateInterval, boolean>>
  >({});
  const [error, setError] = useState<Error | undefined>(undefined);

  useEffect(() => {
    if (!isFocused || !storedWallets.length) {
      setLoadingByTimeframe({});
      return;
    }

    let cancelled = false;

    for (const timeframe of SUMMARY_TIMEFRAMES) {
      const cachedTimeframe = getCachedBalanceChartTimeframe(
        cachedScope?.timeframes,
        timeframe,
      );
      const {status} = resolveCachedBalanceChartSeries({
        cachedTimeframe,
        currentSpotRatesByRateKey,
        dataRevisionSig: chartDataRevisionSig,
        asOfMs,
      });
      if (status === 'fresh' || status === 'patchable') {
        continue;
      }

      const requestKey = [
        timeframe,
        scopeId,
        chartDataRevisionSig,
        storedWalletRequestSig,
        currentRatesSignature,
      ].join('|');
      if (inFlightRequestKeyByTimeframeRef.current[timeframe] === requestKey) {
        continue;
      }

      inFlightRequestKeyByTimeframeRef.current[timeframe] = requestKey;
      setLoadingByTimeframe(prev => ({
        ...prev,
        [timeframe]: true,
      }));

      runPortfolioChartQuery({
        wallets: storedWallets,
        quoteCurrency,
        timeframe,
        maxPoints: 2,
        currentRatesByAssetId,
        asOfMs,
      })
        .then(chart => {
          if (
            cancelled ||
            inFlightRequestKeyByTimeframeRef.current[timeframe] !== requestKey
          ) {
            return;
          }

          const cacheEntry = buildCachedTimeframeFromRuntimeChart({
            chart,
            timeframe,
            walletIds: sortedWalletIds,
            quoteCurrency,
            balanceOffset: 0,
            dataRevisionSig: chartDataRevisionSig,
          });
          if (!cacheEntry) {
            return;
          }

          dispatch(
            upsertBalanceChartScopeTimeframes({
              scopeId,
              walletIds: sortedWalletIds,
              quoteCurrency,
              balanceOffset: 0,
              timeframes: [cacheEntry],
            }),
          );
          setError(undefined);
        })
        .catch(err => {
          if (
            cancelled ||
            inFlightRequestKeyByTimeframeRef.current[timeframe] !== requestKey
          ) {
            return;
          }

          setError(err instanceof Error ? err : new Error(String(err)));
        })
        .finally(() => {
          if (
            cancelled ||
            inFlightRequestKeyByTimeframeRef.current[timeframe] !== requestKey
          ) {
            return;
          }

          delete inFlightRequestKeyByTimeframeRef.current[timeframe];
          setLoadingByTimeframe(prev => ({
            ...prev,
            [timeframe]: false,
          }));
        });
    }

    return () => {
      cancelled = true;
    };
  }, [
    asOfMs,
    cachedScope?.timeframes,
    chartDataRevisionSig,
    currentRatesByAssetId,
    currentRatesSignature,
    currentSpotRatesByRateKey,
    dispatch,
    isFocused,
    quoteCurrency,
    scopeId,
    sortedWalletIds,
    storedWalletRequestSig,
    storedWallets,
  ]);

  const summary: PortfolioGainLossSummary = useMemo(() => {
    return {
      quoteCurrency,
      today:
        summaryByTimeframe.get('1D') || buildUnavailableSummaryPart(),
      total:
        summaryByTimeframe.get('ALL') || buildUnavailableSummaryPart(),
    };
  }, [quoteCurrency, summaryByTimeframe]);

  return {
    summary,
    loading:
      !!loadingByTimeframe['1D'] ||
      !!loadingByTimeframe.ALL,
    error,
  };
}

export default usePortfolioGainLossSummary;
