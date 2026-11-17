import {useEffect} from 'react';
import {AppState} from 'react-native';
import {checkNotifications, RESULTS} from 'react-native-permissions';
import {useStore} from 'react-redux';
import type {RootState} from '..';
import type {AppDispatch} from '../../utils/hooks';
import {subscribeCoinCatalog, seedCoinCatalog} from './coin-registry';
import {
  syncPriceAlerts,
  refreshAlertPreferences,
  reconcileWatchlistCatalog,
  setAlertPermission,
  priceAlertsContextKey,
} from './watchlist.effects';

// Root mounts only after redux-persist's bootstrap has completed. The queue
// additionally waits for appWasInit and the active network's identity.
export const useWatchlistLifecycle = () => {
  const store = useStore<RootState>();
  useEffect(() => {
    const dispatch = store.dispatch as AppDispatch;
    seedCoinCatalog(store.getState().WATCHLIST.items);
    let disposed = false;
    let fingerprint = '';
    const refresh = async () => {
      try {
        const {status} = await checkNotifications();
        if (disposed) {
          return;
        }
        dispatch(
          setAlertPermission(
            status === RESULTS.GRANTED || status === RESULTS.LIMITED,
          ),
        );
      } catch {
        /* A permission lookup failure does not disable the feature. */
      }
      if (!disposed) {
        void dispatch(syncPriceAlerts());
      }
    };
    const changed = () => {
      const {APP, WATCHLIST} = store.getState();
      const pub = APP.identity[APP.network]?.pub;
      const next = JSON.stringify([
        APP.appWasInit,
        pub ? priceAlertsContextKey(pub) : '',
        APP.brazeEid,
        APP.notificationsAccepted,
        WATCHLIST.permissionAllowed,
        WATCHLIST.priceAlertsEnabled,
        APP.defaultAltCurrency.isoCode,
      ]);
      if (next === fingerprint) {
        return;
      }
      fingerprint = next;
      dispatch(refreshAlertPreferences());
      void dispatch(syncPriceAlerts());
    };
    const unsubscribe = store.subscribe(changed);
    const unsubscribeCoins = subscribeCoinCatalog(() =>
      dispatch(reconcileWatchlistCatalog()),
    );
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') {
        void refresh();
      }
    });
    changed();
    void refresh();
    return () => {
      disposed = true;
      unsubscribe();
      unsubscribeCoins();
      subscription.remove();
    };
  }, [store]);
};
