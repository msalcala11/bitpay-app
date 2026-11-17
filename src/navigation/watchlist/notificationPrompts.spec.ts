import {checkNotifications, RESULTS} from 'react-native-permissions';
import {
  fixAlertNotifications,
  notificationFix,
} from './notificationPrompts.effects';
import {notificationPermissionAllowed} from '../tabs/settings/notifications/notificationPermission';
import {AppEffects} from '../../store/app';
import {setPriceAlertsEnabled} from '../../store/watchlist/watchlist.effects';

jest.mock('../../store/app', () => ({
  AppEffects: {
    setNotifications: jest.fn(value => ({type: 'PUSH', value})),
    requestNotificationsPermissions: jest.fn(async () => true),
    checkNotificationsPermissions: jest.fn(async () => true),
  },
}));
jest.mock('../../store/app/app.actions', () => ({
  showBottomNotificationModal: (payload: unknown) => ({type: 'SHEET', payload}),
}));
jest.mock('../../store/watchlist/watchlist.effects', () => ({
  markAlertPermissionPromptShown: () => ({type: 'SHOWN'}),
  setAlertPermission: (value: boolean) => ({type: 'PERMISSION', value}),
  setPriceAlertsEnabled: jest.fn(value => ({type: 'ALERTS', value})),
}));
jest.mock('../../store/watchlist/watchlist.selectors', () => ({
  selectAlertsAvailable: () => true,
  selectAlertsDeliverable: (state: any) =>
    state.WATCHLIST.permissionAllowed &&
    state.APP.notificationsAccepted &&
    state.WATCHLIST.priceAlertsEnabled,
}));

it('uses granted or limited throughout, with separate in-app preferences', () => {
  expect(notificationPermissionAllowed(RESULTS.LIMITED)).toBe(true);
  expect(notificationFix(RESULTS.GRANTED, true, false)).toBe('inapp');
  expect(notificationFix(RESULTS.LIMITED, true, true)).toBe('none');
  expect(notificationFix(RESULTS.BLOCKED, true, true)).toBe('blocked');
  expect(notificationFix(RESULTS.DENIED, true, true)).toBe('os');
});
it('asks once in saved installation state and turns on push through the existing app effect', async () => {
  (checkNotifications as jest.Mock).mockResolvedValue({
    status: RESULTS.GRANTED,
  });
  const state = {
    APP: {notificationsAccepted: true},
    WATCHLIST: {
      permissionPromptShown: false,
      permissionAllowed: true,
      priceAlertsEnabled: false,
    },
  };
  const actions: any[] = [];
  const dispatch = (action: any): any => {
    if (typeof action === 'function') {
      return action(dispatch, () => state, undefined);
    }
    actions.push(action);
    if (action.type === 'SHOWN') {
      state.WATCHLIST.permissionPromptShown = true;
    }
    return action;
  };
  await dispatch(fixAlertNotifications('Watchlist', true, jest.fn()));
  const sheet = actions.find(action => action.type === 'SHEET').payload;
  expect(sheet.title).toBe('Price alerts are off');
  expect(state.WATCHLIST.permissionPromptShown).toBe(true);
  await sheet.actions[0].action();
  expect(AppEffects.setNotifications).toHaveBeenCalledWith(true);
  expect(setPriceAlertsEnabled).toHaveBeenCalledWith(true);
  await dispatch(fixAlertNotifications('Watchlist', true, jest.fn()));
  expect(actions.filter(action => action.type === 'SHEET')).toHaveLength(1);
});
