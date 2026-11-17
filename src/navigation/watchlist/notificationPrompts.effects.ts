import {t} from 'i18next';
import {checkNotifications, RESULTS} from 'react-native-permissions';
import type {Effect} from '../../store';
import {AppEffects} from '../../store/app';
import {showBottomNotificationModal} from '../../store/app/app.actions';
import {
  selectAlertsAvailable,
  selectAlertsDeliverable,
} from '../../store/watchlist/watchlist.selectors';
import {
  markAlertPermissionPromptShown,
  setAlertPermission,
  setPriceAlertsEnabled,
} from '../../store/watchlist/watchlist.effects';
import {updateWatchlist} from '../../store/watchlist/watchlist.reducer';
import {
  showPriceAlertError,
  type AlertScreenContext,
} from './watchlistUi.effects';
import {
  notificationPermissionAllowed,
  showNotificationsDisabled,
  type PermissionPromptResult,
} from '../tabs/settings/notifications/notificationPermission';

export type NotificationFix = 'none' | 'os' | 'blocked' | 'inapp';
export const notificationFix = (
  status: string,
  push: boolean,
  alerts: boolean,
): NotificationFix => {
  if (!notificationPermissionAllowed(status)) {
    return status === RESULTS.BLOCKED || status === RESULTS.UNAVAILABLE
      ? 'blocked'
      : 'os';
  }
  return push && alerts ? 'none' : 'inapp';
};

export const turnOnAlertNotifications =
  (): Effect<Promise<void>> => async dispatch => {
    dispatch(AppEffects.setNotifications(true));
    await dispatch(setPriceAlertsEnabled(true));
  };

export const fixAlertNotifications =
  (
    _context: AlertScreenContext,
    afterSave: boolean,
    openSettings: () => void,
    onResult?: (result: PermissionPromptResult) => void,
  ): Effect<Promise<void>> =>
  async (dispatch, getState) => {
    if (!selectAlertsAvailable(getState())) {
      return;
    }
    if (afterSave && getState().WATCHLIST.permissionPromptShown) {
      return;
    }
    const {status} = await checkNotifications().catch(() => ({
      status: RESULTS.UNAVAILABLE,
    }));
    dispatch(setAlertPermission(notificationPermissionAllowed(status)));
    if (selectAlertsDeliverable(getState())) {
      return;
    }
    if (afterSave && getState().WATCHLIST.permissionPromptShown) {
      return;
    }
    const {APP, WATCHLIST} = getState();
    const fix = notificationFix(
      status,
      APP.notificationsAccepted,
      WATCHLIST.priceAlertsEnabled,
    );
    if (afterSave) {
      dispatch(markAlertPermissionPromptShown());
    }
    if (fix === 'blocked') {
      showNotificationsDisabled(onResult);
    } else if (fix === 'os') {
      await AppEffects.requestNotificationsPermissions();
      const allowed = await AppEffects.checkNotificationsPermissions();
      dispatch(setAlertPermission(allowed));
      if (allowed) {
        try {
          await dispatch(turnOnAlertNotifications());
        } catch {
          dispatch(showPriceAlertError());
        }
      }
      onResult?.(allowed ? 'allowed' : 'denied');
    } else if (fix === 'inapp') {
      if (!afterSave) {
        openSettings();
        return;
      }
      dispatch(
        showBottomNotificationModal({
          type: 'info',
          title: t('Price alerts are off'),
          message: t('Turn them on to get notified when the price moves.'),
          modalLibrary: 'bottom-sheet',
          enableBackdropDismiss: true,
          onBackdropDismiss: () => onResult?.('dismissed'),
          actions: [
            {
              text: t('Turn On'),
              primary: true,
              action: async () => {
                try {
                  await dispatch(turnOnAlertNotifications());
                  onResult?.('allowed');
                } catch {
                  dispatch(showPriceAlertError());
                  onResult?.('dismissed');
                }
              },
            },
            {text: t('Not Now'), action: () => onResult?.('denied')},
          ],
        }),
      );
    }
  };

export const consumeAlertNotificationPrompt =
  (): Effect<AlertScreenContext | undefined> => (dispatch, getState) => {
    const state = getState().WATCHLIST;
    const context = state.pendingNotificationPrompt;
    if (context) {
      dispatch(
        updateWatchlist({...state, pendingNotificationPrompt: undefined}),
      );
    }
    return context;
  };
