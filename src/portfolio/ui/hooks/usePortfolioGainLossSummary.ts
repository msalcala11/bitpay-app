import {useEffect, useMemo, useRef, useState} from 'react';
import {useIsFocused} from '@react-navigation/native';
import type {FiatRateInterval, Rates} from '../../../store/rate/rate.models';
import type {Wallet} from '../../../store/wallet/wallet.models';
import {useAppDispatch, useAppSelector} from '../../../utils/hooks';
import type {PortfolioGainLossSummary} from '../../../utils/portfolio/assets';
import {
  getPortfolioWalletChainLower,
  getPortfolioWalletTokenAddress,
} from '../../../utils/portfolio/assets';
import {getRateByCurrencyName} from '../../../utils/helper-methods';
import {getFiatRateSeriesAssetKey} from '../../../utils/portfolio/core/fiatRateSeries';
import {
  buildBalanceChartScopeId,
  deserializeCachedTimeframeToComputedSeries,
  getCachedBalanceChartTimeframe,
  getCachedTimeframeStatus,
  getSortedUniqueWalletIds,
  serializeComputedSeriesToCachedTimeframe,
} from '../../../utils/portfolio/chartCache';
import {upsertBalanceChartScopeTimeframes} from '../../../store/portfolio-charts';
import type {
  PnlAnalysisChartResult,
  PnlAnalysisPoint,
} from '../../core/pnl/analysisStreaming';
import {
  buildCurrentRatesByAssetId,
  buildCommittedPortfolioRevisionToken,
  getCurrentRatesByAssetIdSignature,
  getStoredWalletRequestSignature,
  mapWalletsToStoredWallets,
  resolveCurrentRatesAsOfMs,
  resolveCommittedPortfolioQuoteCurrency,
  runPortfolioChartQuery,
} from '../common';

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

function buildCurrentSpotRatesByRateKey(args: {
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

function buildAnalysisPointsFromRuntimeChart(
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

function buildCachedTimeframeFromRuntimeChart(args: {
  chart: PnlAnalysisChartResult;
  timeframe: FiatRateInterval;
  walletIds: string[];
  quoteCurrency: string;
  dataRevisionSig: string;
}) {
  const analysisPoints = buildAnalysisPointsFromRuntimeChart(args.chart);
  if (!analysisPoints.length) {
    return undefined;
  }

  return serializeComputedSeriesToCachedTimeframe({
    timeframe: args.timeframe,
    walletIds: args.walletIds,
    quoteCurrency: args.quoteCurrency,
    balanceOffset: 0,
    dataRevisionSig: args.dataRevisionSig,
    historicalRateDeps: [],
    analysisPoints,
    patchMetadata: {
      lastSpotRatesByRateKey: args.chart.lastSpotRatesByRateKey,
      latestHoldingsByRateKey: args.chart.latestHoldingsByRateKey,
      latestRemainingCostBasisFiatTotal:
        args.chart.latestRemainingCostBasisFiatTotal,
    },
  });
}

export function usePortfolioGainLossSummary(args: {
  wallets: Wallet[];
  liveFiatTotal: number;
}) {
  const isFocused = useIsFocused();
  const dispatch = useAppDispatch();
  const defaultAltCurrency = useAppSelector(({APP}) => APP.defaultAltCurrency);
  const portfolioQuoteCurrency = useAppSelector(
    ({PORTFOLIO}) => PORTFOLIO.quoteCurrency,
  );
  const rates = useAppSelector(({RATE}) => RATE.rates);
  const ratesUpdatedAt = useAppSelector(({RATE}) => RATE.ratesUpdatedAt);
  const committedPortfolioRevisionToken = useAppSelector(({PORTFOLIO}) => {
    return buildCommittedPortfolioRevisionToken({
      quoteCurrency: PORTFOLIO.quoteCurrency,
      lastPopulatedAt: PORTFOLIO.lastPopulatedAt,
    });
  });

  const quoteCurrency = useMemo(() => {
    return resolveCommittedPortfolioQuoteCurrency({
      portfolioQuoteCurrency,
      defaultAltCurrencyIsoCode: defaultAltCurrency?.isoCode,
    });
  }, [defaultAltCurrency?.isoCode, portfolioQuoteCurrency]);
  const fallbackAsOfMsRef = useRef<number>(Date.now());
  const asOfMs = useMemo(() => {
    return (
      resolveCurrentRatesAsOfMs({
        ratesUpdatedAt,
        rates,
      }) ?? fallbackAsOfMsRef.current
    );
  }, [rates, ratesUpdatedAt]);
  const chartDataRevisionSig = useMemo(() => {
    return [committedPortfolioRevisionToken, String(asOfMs)].join('|');
  }, [asOfMs, committedPortfolioRevisionToken]);

  const {eligibleWallets, storedWallets} = useMemo(() => {
    return mapWalletsToStoredWallets({
      dispatch,
      wallets: args.wallets,
    });
  }, [args.wallets, dispatch]);
  const sortedWalletIds = useMemo(
    () =>
      getSortedUniqueWalletIds(eligibleWallets.map(wallet => String(wallet?.id || ''))),
    [eligibleWallets],
  );
  const storedWalletRequestSig = useMemo(
    () => getStoredWalletRequestSignature(storedWallets),
    [storedWallets],
  );
  const currentRatesByAssetId = useMemo(() => {
    return buildCurrentRatesByAssetId({
      storedWallets,
      quoteCurrency,
      rates,
    });
  }, [quoteCurrency, rates, storedWallets]);
  const currentRatesSignature = useMemo(() => {
    return getCurrentRatesByAssetIdSignature(currentRatesByAssetId);
  }, [currentRatesByAssetId]);
  const currentSpotRatesByRateKey = useMemo(() => {
    return buildCurrentSpotRatesByRateKey({
      wallets: eligibleWallets,
      rates,
      quoteCurrency,
    });
  }, [eligibleWallets, quoteCurrency, rates]);
  const scopeId = useMemo(() => {
    return buildBalanceChartScopeId({
      walletIds: sortedWalletIds,
      quoteCurrency,
      balanceOffset: 0,
    });
  }, [quoteCurrency, sortedWalletIds]);
  const cachedScope = useAppSelector(
    ({PORTFOLIO_CHARTS}) => PORTFOLIO_CHARTS.cacheByScopeId?.[scopeId],
  );

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

      const status = getCachedTimeframeStatus({
        cachedTimeframe,
        dataRevisionSig: chartDataRevisionSig,
        currentSpotRatesByRateKey,
        fiatRateSeriesCache: undefined,
      });
      if (status === 'missing' || status === 'stale_historical') {
        next.set(timeframe, buildUnavailableSummaryPart());
        continue;
      }

      const series = deserializeCachedTimeframeToComputedSeries(
        cachedTimeframe,
        status === 'patchable'
          ? {
              currentSpotRatesByRateKey,
              patchedAt: asOfMs,
            }
          : undefined,
      );
      const lastPoint =
        series?.analysisPoints?.[(series.analysisPoints?.length || 1) - 1];

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
      const status = getCachedTimeframeStatus({
        cachedTimeframe,
        dataRevisionSig: chartDataRevisionSig,
        currentSpotRatesByRateKey,
        fiatRateSeriesCache: undefined,
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
