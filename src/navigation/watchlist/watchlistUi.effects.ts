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
} from '../../store/watchlist/watchlist.effects';

export type AlertScreenContext = NonNullable<
  WatchlistState['alertSheet']
>['context'];

export const showWatchlistFull = (): Effect => dispatch =>
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
export const canAddWatchlistCoin =
  (): Effect<boolean> => (dispatch, getState) => {
    if (getState().WATCHLIST.items.length >= 20) {
      dispatch(showWatchlistFull());
      return false;
    }
    return true;
  };
export const addCoinFromUi =
  (
    coin: WatchlistCoin,
    _context: 'GlobalSelect' | 'PriceChart' | 'WalletDetails',
  ): Effect<boolean> =>
  dispatch => {
    try {
      return dispatch(addWatchlistCoin(coin));
    } catch {
      dispatch(showWatchlistFull());
      return false;
    }
  };
export const confirmRemoveWatchlistCoin =
  (coin: WatchlistCoin, _context: 'PriceChart' | 'WalletDetails'): Effect =>
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
            action: () => dispatch(removeWatchlistCoin(coin)),
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
        alertSheet: {coin, context, afterAdd, open: true, nonce: Date.now()},
      }),
    );
  };
export const closePriceAlert =
  (saved = false): Effect =>
  (dispatch, getState) => {
    const state = getState().WATCHLIST;
    if (state.alertSheet) {
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
