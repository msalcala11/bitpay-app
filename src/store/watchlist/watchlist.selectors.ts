import type {RootState} from '..';
import {priceAlertsContextKey} from './watchlist.effects';
import {alertsDeliverable} from './coins';

export const selectAlertContext = ({APP, WATCHLIST}: RootState) => {
  const pub = APP.identity[APP.network]?.pub;
  return pub ? WATCHLIST.contexts[priceAlertsContextKey(pub)] : undefined;
};
export const selectAlertsAvailable = (state: RootState) =>
  !selectAlertContext(state)?.disabled;
export const selectAlertsDeliverable = ({APP, WATCHLIST}: RootState) =>
  alertsDeliverable(
    WATCHLIST.permissionAllowed === true,
    APP.notificationsAccepted,
    WATCHLIST.priceAlertsEnabled,
  );
