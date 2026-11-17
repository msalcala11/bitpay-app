import {t} from 'i18next';
import type {Effect} from '../../store';
import type {
  WatchlistCoin,
  WatchlistState,
} from '../../store/watchlist/watchlist.models';
import {updateWatchlist} from '../../store/watchlist/watchlist.reducer';
import {showBottomNotificationModal} from '../../store/app/app.actions';
import {selectAlertsAvailable} from '../../store/watchlist/watchlist.selectors';

export type AlertScreenContext = NonNullable<
  WatchlistState['alertSheet']
>['context'];
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
