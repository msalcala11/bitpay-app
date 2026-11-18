import React from 'react';
import {FlatList} from 'react-native';
import {act, render} from '@testing-library/react-native';
import WatchlistScreen from './WatchlistScreen';
let mockState: any;
const mockNavigation = {setOptions: jest.fn(), navigate: jest.fn()};
const mockDispatch = (action: any): any => {
  if (typeof action === 'function')
    return action(mockDispatch, () => mockState, undefined);
  if (action.type === 'WATCHLIST/UPDATE') mockState.WATCHLIST = action.payload;
  return action;
};
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useFocusEffect: (callback: any) =>
    require('react').useEffect(callback, [callback]),
}));
jest.mock('../../contexts', () => ({
  useTheme: () => ({dark: false, colors: {background: 'white'}}),
}));
jest.mock('../../utils/hooks', () => ({
  useAppDispatch: () => mockDispatch,
  useAppSelector: (select: any) => select(mockState),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({t: (value: string) => value}),
}));
jest.mock('../utils/headerHelpers', () => ({
  useStackScreenOptions: () => ({}),
}));
jest.mock('../../store/watchlist/watchlist.effects', () => ({
  syncPriceAlerts: () => ({type: 'SYNC'}),
}));
jest.mock('./useWatchlistRows', () => ({useWatchlistRows: () => [{}]}));
jest.mock('./WatchlistNotifications', () => ({
  WatchlistNotificationsBanner: () => null,
}));
jest.mock('react-native-reorderable-list', () => () => null);
jest.mock('../tabs/home/components/AddSvg', () => () => null);
jest.mock('../tabs/home/components/CustomizeSvg', () => () => null);
jest.mock('../../components/button/Button', () => () => null);
jest.mock('../../components/styled/Text', () => ({
  HeaderTitle: require('react-native').Text,
  H5: require('react-native').Text,
}));
jest.mock('./WatchlistRow', () => {
  const ReactLib = require('react'),
    {Text} = require('react-native');
  return {
    WatchlistRow: ({highlighted}: any) =>
      ReactLib.createElement(
        Text,
        {testID: highlighted ? 'highlighted' : 'row'},
        'Bitcoin',
      ),
    EditableWatchlistRow: () => null,
  };
});
jest.mock('../../store/analytics/analytics.effects', () => ({
  Analytics: {track: () => ({type: 'ANALYTICS'})},
}));
jest.mock('../../store/app/app.actions', () => ({
  showBottomNotificationModal: () => ({type: 'NOTICE'}),
}));

beforeEach(() => {
  jest.useFakeTimers();
  mockState = {
    WATCHLIST: {
      items: [{id: 'coin:btc', name: 'Bitcoin'}],
      lastAdded: {id: 'coin:btc', nonce: 1},
    },
  };
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});
it('scrolls/highlights once for an add, keeps the full interval, and does not replay on remount', () => {
  const scroll = jest
    .spyOn(FlatList.prototype, 'scrollToEnd')
    .mockImplementation(() => {});
  const view = render(<WatchlistScreen />);
  expect(view.getByTestId('highlighted')).toBeTruthy();
  act(() => jest.advanceTimersByTime(100));
  expect(scroll).toHaveBeenCalledTimes(1);
  act(() => jest.advanceTimersByTime(1399));
  expect(view.getByTestId('highlighted')).toBeTruthy();
  act(() => jest.advanceTimersByTime(1));
  expect(view.queryByTestId('highlighted')).toBeNull();
  view.unmount();
  const reopened = render(<WatchlistScreen />);
  expect(reopened.queryByTestId('highlighted')).toBeNull();
  act(() => jest.advanceTimersByTime(1500));
  expect(scroll).toHaveBeenCalledTimes(1);
});
