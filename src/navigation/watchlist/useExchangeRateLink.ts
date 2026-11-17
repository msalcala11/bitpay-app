import {useEffect, useSyncExternalStore, useRef} from 'react';
import {useAppDispatch, useAppSelector} from '../../utils/hooks';
import {
  getCoinCatalog,
  subscribeCoinCatalog,
} from '../../store/watchlist/coin-registry';
import {Analytics} from '../../store/analytics/analytics.effects';
import {
  resolveExchangeRateLink,
  type ExchangeRateLink,
} from './exchangeRateLink';
export const useExchangeRateLink = (
  link: ExchangeRateLink | undefined,
  navigation: any,
  focused: boolean,
) => {
  const catalog = useSyncExternalStore(subscribeCoinCatalog, getCoinCatalog);
  const ready = useAppSelector(state => state.APP.tokensDataLoaded);
  const dispatch = useAppDispatch();
  const handled = useRef<ExchangeRateLink | undefined>(undefined);
  useEffect(() => {
    if (!link || !focused || handled.current === link) {
      return;
    }
    const resolved = resolveExchangeRateLink(link, catalog, ready);
    if (resolved.status === 'waiting') {
      return;
    }
    handled.current = link;
    navigation.setParams({
      exchangeRateLink: undefined,
      currencyAbbreviation: undefined,
    });
    if (resolved.status !== 'resolved') {
      return;
    }
    if (link.notification_type === 'price_alert') {
      dispatch(
        Analytics.track('Price Alert Opened', {
          coin: resolved.coin.symbol.toLowerCase(),
        }),
      );
    }
    navigation.getParent()?.navigate('ExchangeRate', {
      ...resolved.asset,
      currencyName: resolved.coin.name,
    });
  }, [catalog, dispatch, focused, link, navigation, ready]);
};
