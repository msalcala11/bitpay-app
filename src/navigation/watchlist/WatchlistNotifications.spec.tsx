import React from 'react';
import {render} from '@testing-library/react-native';
import {WatchlistNotificationsBanner} from './WatchlistNotifications';
let mockPermission: boolean | undefined;
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({navigate: jest.fn()}),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({t: (value: string) => value}),
}));
jest.mock('../../utils/hooks', () => ({
  useAppDispatch: () => jest.fn(),
  useAppSelector: (select: any) =>
    select({
      APP: {
        network: 'livenet',
        identity: {livenet: {pub: 'pub'}},
        notificationsAccepted: true,
      },
      WATCHLIST: {
        permissionAllowed: mockPermission,
        priceAlertsEnabled: true,
        contexts: {context: {alerts: {btc: {}}}},
      },
    }),
}));
jest.mock('../../store/watchlist/watchlist.effects', () => ({
  priceAlertsContextKey: () => 'context',
}));
jest.mock('./notificationPrompts.effects', () => ({}));
jest.mock('../../components/banner/Banner', () => {
  const ReactLib = require('react'),
    {Text} = require('react-native');
  return ({title}: any) => ReactLib.createElement(Text, null, title);
});
it('hides the delivery-off banner until permission has been checked', () => {
  mockPermission = undefined;
  const view = render(<WatchlistNotificationsBanner />);
  expect(view.queryByText('Price alerts are off')).toBeNull();
  mockPermission = false;
  view.rerender(<WatchlistNotificationsBanner />);
  expect(view.getByText('Price alerts are off')).toBeTruthy();
});
