import {useMemo} from 'react';
import type {FiatRateInterval, FiatRateSeriesCache} from '../../../store/rate/rate.models';
import type {StoredWallet} from '../../core/types';
import {buildBalanceChartHistoricalRateRequests} from '../../../utils/portfolio/balanceChartData';
import useRuntimeFiatRateSeriesCache from './useRuntimeFiatRateSeriesCache';

export function usePortfolioHistoricalRateDepsCache(args: {
  wallets: StoredWallet[];
  quoteCurrency: string;
  timeframes: FiatRateInterval[];
  maxAgeMs?: number;
  enabled?: boolean;
}) {
  const requestGroups = useMemo(() => {
    return buildBalanceChartHistoricalRateRequests({
      wallets: args.wallets,
      quoteCurrency: args.quoteCurrency,
      timeframes: args.timeframes,
    });
  }, [args.quoteCurrency, args.timeframes, args.wallets]);

  const canonicalGroup = useMemo(
    () => requestGroups.find(group => group.quoteCurrency === 'USD'),
    [requestGroups],
  );
  const displayQuoteGroup = useMemo(
    () =>
      requestGroups.find(
        group =>
          group.quoteCurrency ===
          String(args.quoteCurrency || 'USD').trim().toUpperCase(),
      ),
    [args.quoteCurrency, requestGroups],
  );

  const canonicalCacheState = useRuntimeFiatRateSeriesCache({
    quoteCurrency: canonicalGroup?.quoteCurrency || 'USD',
    requests: canonicalGroup?.requests || [],
    maxAgeMs: args.maxAgeMs,
    enabled:
      args.enabled !== false && !!canonicalGroup?.requests?.length,
  });
  const displayQuoteCacheState = useRuntimeFiatRateSeriesCache({
    quoteCurrency: displayQuoteGroup?.quoteCurrency || '',
    requests:
      displayQuoteGroup?.quoteCurrency === 'USD'
        ? []
        : displayQuoteGroup?.requests || [],
    maxAgeMs: args.maxAgeMs,
    enabled:
      args.enabled !== false &&
      displayQuoteGroup?.quoteCurrency !== 'USD' &&
      !!displayQuoteGroup?.requests?.length,
  });

  const cache = useMemo<FiatRateSeriesCache>(() => {
    return {
      ...(canonicalCacheState.cache || {}),
      ...(displayQuoteCacheState.cache || {}),
    };
  }, [canonicalCacheState.cache, displayQuoteCacheState.cache]);

  return {
    cache,
    loading: canonicalCacheState.loading || displayQuoteCacheState.loading,
    error: canonicalCacheState.error || displayQuoteCacheState.error,
  };
}

export default usePortfolioHistoricalRateDepsCache;
