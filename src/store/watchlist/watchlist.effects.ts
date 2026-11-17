import type {Effect, RootState} from '..';
import type {AppDispatch} from '../../utils/hooks';
import {PriceAlertsApi, identityHex} from '../../api/price-alerts';
import {BASE_PRICE_ALERTS_URL} from '../../constants/config';
import type {PriceAlertThreshold} from '../../api/price-alerts/price-alerts.types';
import {getCoinCatalog} from './coin-registry';
import {PriceAlertQueue} from './price-alerts.queue';
import {updateWatchlist} from './watchlist.reducer';
import type {WatchlistCoin} from './watchlist.models';

const queues = new WeakMap<object, PriceAlertQueue>();
export const priceAlertsContextKey = (
  pub: string | Uint8Array,
  baseUrl = BASE_PRICE_ALERTS_URL,
) => JSON.stringify([identityHex(pub), baseUrl.replace(/\/+$/, '')]);

export const queueFor = (dispatch: AppDispatch, getState: () => RootState) => {
  let queue = queues.get(dispatch);
  if (!queue) {
    queue = new PriceAlertQueue({
      read: () => getState().WATCHLIST,
      write: state => {
        dispatch(updateWatchlist(state));
      },
      catalog: getCoinCatalog,
      api: () => {
        const {APP} = getState();
        return new PriceAlertsApi(
          BASE_PRICE_ALERTS_URL,
          APP.identity[APP.network],
        );
      },
      environment: () => {
        const {APP, WATCHLIST} = getState();
        const identity = APP.identity[APP.network];
        return {
          context:
            APP.appWasInit && identity?.pub && identity?.priv
              ? priceAlertsContextKey(identity.pub)
              : undefined,
          externalUserId: APP.brazeEid,
          pushEnabled: APP.notificationsAccepted && WATCHLIST.permissionAllowed,
          currency: APP.defaultAltCurrency.isoCode,
        };
      },
    });
    queues.set(dispatch, queue);
  }
  return queue;
};

export const syncPriceAlerts =
  (): Effect<Promise<void>> => (dispatch, getState) =>
    queueFor(dispatch, getState).sync();
export const refreshAlertPreferences = (): Effect => (dispatch, getState) => {
  void queueFor(dispatch, getState).preferencesChanged();
};
export const reconcileWatchlistCatalog = (): Effect => (dispatch, getState) =>
  queueFor(dispatch, getState).catalogChanged();
export const addWatchlistCoin =
  (coin: WatchlistCoin): Effect<boolean> =>
  (dispatch, getState) =>
    queueFor(dispatch, getState).add(coin);
export const removeWatchlistCoin =
  (coin: WatchlistCoin): Effect<ReturnType<PriceAlertQueue['remove']>> =>
  (dispatch, getState) =>
    queueFor(dispatch, getState).remove(coin);
export const reorderWatchlist =
  (id: string, to: number): Effect<ReturnType<PriceAlertQueue['reorder']>> =>
  (dispatch, getState) =>
    queueFor(dispatch, getState).reorder(id, to);
export const savePriceAlert =
  (
    coin: WatchlistCoin,
    threshold: PriceAlertThreshold,
  ): Effect<ReturnType<PriceAlertQueue['save']>> =>
  (dispatch, getState) =>
    queueFor(dispatch, getState).save(coin, threshold);
export const turnOffPriceAlert =
  (coin: WatchlistCoin): Effect<ReturnType<PriceAlertQueue['turnOff']>> =>
  (dispatch, getState) =>
    queueFor(dispatch, getState).turnOff(coin);
export const setPriceAlertsEnabled =
  (enabled: boolean): Effect<Promise<void>> =>
  (dispatch, getState) =>
    queueFor(dispatch, getState).setEnabled(enabled);
export const setAlertPermission =
  (allowed: boolean): Effect =>
  (dispatch, getState) => {
    if (getState().WATCHLIST.permissionAllowed !== allowed) {
      dispatch(
        updateWatchlist({...getState().WATCHLIST, permissionAllowed: allowed}),
      );
    }
  };
export const markAlertPermissionPromptShown =
  (): Effect => (dispatch, getState) =>
    dispatch(
      updateWatchlist({...getState().WATCHLIST, permissionPromptShown: true}),
    );
