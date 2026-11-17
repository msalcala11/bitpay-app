import {useMemo} from 'react';
import {useAppSelector} from '../../utils/hooks';
import useRuntimeFiatRateSeriesCache from '../../portfolio/ui/hooks/useRuntimeFiatRateSeriesCache';
import {HISTORIC_RATES_CACHE_DURATION} from '../../constants/wallet';
import {buildWatchlistRows, watchlistAsset} from './watchlistRows';

export const useWatchlistRows = () => {
  const items = useAppSelector(state => state.WATCHLIST.items);
  const rates = useAppSelector(state => state.RATE.rates);
  const lastDayRates = useAppSelector(state => state.RATE.lastDayRates);
  const code = useAppSelector(state => state.APP.defaultAltCurrency.isoCode);
  const requests = useMemo(
    () =>
      items.map(item => {
        const asset = watchlistAsset(item);
        return {
          coin: asset.currencyAbbreviation,
          intervals: ['1D' as const],
          ...(asset.tokenAddress
            ? {chain: asset.chain, tokenAddress: asset.tokenAddress}
            : {}),
        };
      }),
    [items],
  );
  const {cache} = useRuntimeFiatRateSeriesCache({
    quoteCurrency: code,
    requests,
    maxAgeMs: HISTORIC_RATES_CACHE_DURATION * 1000,
  });
  return useMemo(
    () => buildWatchlistRows(items, rates, lastDayRates, code, cache),
    [items, rates, lastDayRates, code, cache],
  );
};
