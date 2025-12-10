import {useEffect, useMemo} from 'react';
import {useAppDispatch, useAppSelector} from '../../utils/hooks';
import {EntityRef, Timeframe} from './portfolio.types';
import {
  selectPortfolioQuoteCurrency,
  selectPortfolioSeriesByKey,
  selectPortfolioStatusByKey,
  selectCryptoTimelineByKey,
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
