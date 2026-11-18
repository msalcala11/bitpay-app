import {Analytics} from '../../store/analytics/analytics.effects';
import type {
  PriceAlert,
  PriceAlertThreshold,
} from '../../api/price-alerts/price-alerts.types';
import {t} from 'i18next';
import type {Effect} from '../../store';
import type {
  WatchlistCoin,
  WatchlistState,
} from '../../store/watchlist/watchlist.models';
import {updateWatchlist} from '../../store/watchlist/watchlist.reducer';
import {showBottomNotificationModal} from '../../store/app/app.actions';
import {selectAlertsAvailable} from '../../store/watchlist/watchlist.selectors';
import {selectAlertContext} from '../../store/watchlist/watchlist.selectors';
import {
  addWatchlistCoin,
  removeWatchlistCoin,
  reorderWatchlist,
  savePriceAlert,
  turnOffPriceAlert,
  setPriceAlertsEnabled,
} from '../../store/watchlist/watchlist.effects';

export type AlertScreenContext = NonNullable<
  WatchlistState['alertSheet']
>['context'];

export const showWatchlistFull =
  (context: AlertScreenContext = 'Watchlist'): Effect =>
  dispatch => {
    dispatch(Analytics.track('Watchlist Limit Reached', {context}));
    dispatch(
      showBottomNotificationModal({
        type: 'info',
        title: t('Watchlist is full'),
        message: t('You can watch up to 20 coins. Remove one to add another.'),
        modalLibrary: 'bottom-sheet',
        enableBackdropDismiss: true,
        actions: [{text: t('OK'), primary: true, action: () => {}}],
      }),
    );
  };
export const canAddWatchlistCoin =
  (): Effect<boolean> => (dispatch, getState) => {
    // Do not present a native picker until the previous alert sheet's native
    // dismissal has completed (finishPriceAlert clears it in onModalHide).
    if (getState().WATCHLIST.alertSheet) {
      return false;
    }
    if (getState().WATCHLIST.items.length >= 20) {
      dispatch(showWatchlistFull());
      return false;
    }
    return true;
  };
export const addCoinFromUi =
  (
    coin: WatchlistCoin,
    context: 'GlobalSelect' | 'PriceChart' | 'WalletDetails',
  ): Effect<boolean> =>
  (dispatch, getState) => {
    try {
      const added = dispatch(addWatchlistCoin(coin));
      if (added) {
        dispatch(
          Analytics.track('Watchlist Asset Added', {
            coin: coin.symbol.toLowerCase(),
            context,
            watchlist_count: getState().WATCHLIST.items.length,
          }),
        );
      }
      return added;
    } catch {
      dispatch(
        showWatchlistFull(context === 'GlobalSelect' ? 'Watchlist' : context),
      );
      return false;
    }
  };
export const confirmRemoveWatchlistCoin =
  (coin: WatchlistCoin, context: 'PriceChart' | 'WalletDetails'): Effect =>
  (dispatch, getState) => {
    const hasAlert = !!selectAlertContext(getState())?.alerts[coin.id];
    dispatch(
      showBottomNotificationModal({
        type: 'warning',
        title: t('Remove from watchlist?'),
        message: hasAlert
          ? t('{{coin}} and its price alert will be removed.', {
              coin: coin.name,
            })
          : t('{{coin}} will be removed from your watchlist.', {
              coin: coin.name,
            }),
        modalLibrary: 'bottom-sheet',
        enableBackdropDismiss: true,
        actions: [
          {
            text: t('Remove'),
            primary: true,
            action: () => dispatch(removeCoinFromUi(coin, context)),
          },
          {text: t('Cancel'), action: () => {}},
        ],
      }),
    );
  };
export const showPriceAlertError = (): Effect => dispatch =>
  dispatch(
    showBottomNotificationModal({
      type: 'error',
      title: t('Something went wrong'),
      message: t('Unable to update price alerts. Please try again.'),
      modalLibrary: 'bottom-sheet',
      enableBackdropDismiss: true,
      actions: [{text: t('OK'), primary: true, action: () => {}}],
    }),
  );

export const openPriceAlert =
  (
    coin: WatchlistCoin,
    context: AlertScreenContext,
    afterAdd = false,
  ): Effect =>
  (dispatch, getState) => {
    if (!selectAlertsAvailable(getState())) {
      if (afterAdd) {
        dispatch(
          updateWatchlist({
            ...getState().WATCHLIST,
            lastAdded: {id: coin.id, nonce: Date.now()},
          }),
        );
      }
      return;
    }
    dispatch(
      updateWatchlist({
        ...getState().WATCHLIST,
        alertSheet: {
          coin,
          context,
          afterAdd,
          isEdit: !!selectAlertContext(getState())?.alerts[coin.id],
          open: true,
          nonce: Date.now(),
        },
      }),
    );
  };
export const closePriceAlert =
  (saved = false, nonce?: number): Effect =>
  (dispatch, getState) => {
    const state = getState().WATCHLIST;
    if (
      state.alertSheet &&
      (nonce === undefined || state.alertSheet.nonce === nonce)
    ) {
      dispatch(
        updateWatchlist({
          ...state,
          alertSheet: {...state.alertSheet, open: false, saved},
        }),
      );
    }
  };
export const finishPriceAlert = (): Effect => (dispatch, getState) => {
  const state = getState().WATCHLIST;
  if (!state.alertSheet || state.alertSheet.open) {
    return;
  }
  const {coin, afterAdd, saved, context} = state.alertSheet;
  dispatch(
    updateWatchlist({
      ...state,
      alertSheet: undefined,
      ...(afterAdd ? {lastAdded: {id: coin.id, nonce: Date.now()}} : {}),
      ...(saved ? {pendingNotificationPrompt: context} : {}),
    }),
  );
};

export const consumeWatchlistAddition =
  (): Effect<WatchlistState['lastAdded']> => (dispatch, getState) => {
    const state = getState().WATCHLIST;
    const addition = state.lastAdded;
    if (addition) {
      dispatch(updateWatchlist({...state, lastAdded: undefined}));
    }
    return addition;
  };

export const removeCoinFromUi =
  (coin: WatchlistCoin, context: 'HomeRoot' | AlertScreenContext): Effect =>
  (dispatch, getState) => {
    if (!getState().WATCHLIST.items.some(item => item.id === coin.id)) {
      return;
    }
    const alert = dispatch(removeWatchlistCoin(coin));
    dispatch(
      Analytics.track('Watchlist Asset Removed', {
        coin: coin.symbol.toLowerCase(),
        context,
        had_alert: !!alert,
      }),
    );
    if (alert) {
      dispatch(
        Analytics.track('Price Alert Turned Off', {
          coin: coin.symbol.toLowerCase(),
          threshold_pct: alert.thresholdPct,
          method: 'removed_from_watchlist',
          context,
        }),
      );
    }
  };
export const reorderFromUi =
  (id: string, to: number): Effect =>
  dispatch => {
    const properties = dispatch(reorderWatchlist(id, to));
    if (properties) {
      dispatch(Analytics.track('Watchlist Reordered', properties));
    }
  };
export const saveAlertFromUi =
  (
    coin: WatchlistCoin,
    threshold: PriceAlertThreshold,
    context: AlertScreenContext,
  ): Effect<Promise<PriceAlert | undefined>> =>
  async (dispatch, getState) => {
    const previous = selectAlertContext(getState())?.alerts[coin.id]?.alert;
    const watched = getState().WATCHLIST.items.some(
      item => item.id === coin.id,
    );
    const saved = await dispatch(savePriceAlert(coin, threshold));
    if (saved) {
      if (!watched) {
        dispatch(
          Analytics.track('Watchlist Asset Added', {
            coin: coin.symbol.toLowerCase(),
            context,
            watchlist_count: getState().WATCHLIST.items.length,
          }),
        );
      }
      dispatch(
        Analytics.track('Price Alert Saved', {
          coin: coin.symbol.toLowerCase(),
          threshold_pct: saved.thresholdPct,
          is_edit: !!previous,
          ...(previous ? {previous_threshold_pct: previous.thresholdPct} : {}),
          context,
        }),
      );
      if (!getState().WATCHLIST.alertSheet) {
        dispatch(
          updateWatchlist({
            ...getState().WATCHLIST,
            pendingNotificationPrompt: context,
          }),
        );
      }
    }
    return saved;
  };
export const turnOffAlertFromUi =
  (coin: WatchlistCoin, context: AlertScreenContext): Effect<Promise<void>> =>
  async dispatch => {
    const alert = await dispatch(turnOffPriceAlert(coin));
    if (alert) {
      dispatch(
        Analytics.track('Price Alert Turned Off', {
          coin: coin.symbol.toLowerCase(),
          threshold_pct: alert.thresholdPct,
          method: 'turn_off',
          context,
        }),
      );
    }
  };
export const skipPriceAlert =
  (coin: WatchlistCoin): Effect =>
  dispatch => {
    dispatch(
      Analytics.track('Price Alert Skipped', {coin: coin.symbol.toLowerCase()}),
    );
    dispatch(closePriceAlert());
  };
export const changePriceAlertsFromUi =
  (enabled: boolean): Effect<Promise<void>> =>
  async (dispatch, getState) => {
    const previous = getState().WATCHLIST.priceAlertsEnabled;
    await dispatch(setPriceAlertsEnabled(enabled));
    if (
      previous !== enabled &&
      getState().WATCHLIST.priceAlertsEnabled === enabled
    ) {
      dispatch(Analytics.track('Price Alerts Setting Changed', {enabled}));
    }
  };
