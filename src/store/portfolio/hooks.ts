import {useEffect, useMemo} from 'react';
import {useAppDispatch, useAppSelector} from '../../utils/hooks';
import {EntityRef, Timeframe, BreakevenResult} from './portfolio.types';
import {
  selectPortfolioQuoteCurrency,
  selectPortfolioSeriesByKey,
  selectPortfolioStatusByKey,
  selectCryptoTimelineByKey,
  selectBreakevenByKey,
} from './selectors';
import {buildSeriesKey} from './utils';
import {loadBalanceSeries} from './thunks';

interface UseBalanceSeriesArgs {
  entity: EntityRef;
  timeframe: Timeframe;
  quoteCurrency?: string;
}

export const useBalanceSeries = ({
  entity,
  timeframe,
  quoteCurrency,
}: UseBalanceSeriesArgs) => {
  const dispatch = useAppDispatch();
  const defaultQuoteCurrency = useAppSelector(selectPortfolioQuoteCurrency);
  const resolvedQuoteCurrency = quoteCurrency || defaultQuoteCurrency;
  const scopeKey = useMemo(
    () => buildSeriesKey(entity, timeframe, resolvedQuoteCurrency),
    [entity, timeframe, resolvedQuoteCurrency],
  );

  const data = useAppSelector(state => selectPortfolioSeriesByKey(state, scopeKey));
  const cryptoTimeline = useAppSelector(state => selectCryptoTimelineByKey(state, scopeKey));
  const status = useAppSelector(state => selectPortfolioStatusByKey(state, scopeKey));

  useEffect(() => {
    // Only auto-load if we have no status yet (initial load)
    // Don't auto-retry on failure - let the user manually refresh
    if (!status) {
      dispatch(loadBalanceSeries({entity, timeframe, quoteCurrency: resolvedQuoteCurrency}));
    }
  }, [dispatch, scopeKey, status, entity, timeframe, resolvedQuoteCurrency]);

  const reload = async () => {
    await dispatch(loadBalanceSeries({entity, timeframe, quoteCurrency: resolvedQuoteCurrency}));
  };

  return {
    data,
    cryptoTimeline,
    status,
    isLoading: status?.state === 'loading',
    reload,
  };
};

interface UseBreakevenArgs {
  entity: EntityRef;
  quoteCurrency?: string;
}

/**
 * Hook to access breakeven/cost basis data for a wallet.
 * Breakeven data is computed as part of loadBalanceSeries, so this hook
 * only reads from Redux - it doesn't trigger any data loading.
 * 
 * @returns breakeven result or undefined if not yet computed
 */
export const useBreakeven = ({
  entity,
  quoteCurrency,
}: UseBreakevenArgs): BreakevenResult | undefined => {
  const defaultQuoteCurrency = useAppSelector(selectPortfolioQuoteCurrency);
  const resolvedQuoteCurrency = quoteCurrency || defaultQuoteCurrency;
  
  // Breakeven is stored per entity scope, not per timeframe
  const breakevenScopeKey = useMemo(() => {
    if (entity.type === 'wallet' && entity.id) {
      return `wallet:${entity.id}:${resolvedQuoteCurrency}`;
    }
    if (entity.type === 'key' && entity.id) {
      return `key:${entity.id}:${resolvedQuoteCurrency}`;
    }
    // TODO: Support account and portfolio scope aggregation
    return null;
  }, [entity, resolvedQuoteCurrency]);

  const breakeven = useAppSelector(state => 
    breakevenScopeKey ? selectBreakevenByKey(state, breakevenScopeKey) : undefined
  );

  return breakeven;
};
