import React from 'react';
import {act, fireEvent, render} from '@testing-library/react-native';
import PriceAlertSheet from './PriceAlertSheet';
import {closePriceAlert} from './watchlistUi.effects';

let mockState: any;
let mockSave: Promise<boolean>;
const mockDispatch = jest.fn((action: any) =>
  action.type === 'SAVE' ? mockSave : action,
);
jest.mock('../../utils/hooks', () => ({
  useAppDispatch: () => mockDispatch,
  useAppSelector: (selector: any) => selector(mockState),
}));
jest.mock('../../contexts', () => ({useTheme: () => ({dark: false})}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({t: (text: string) => text}),
}));
jest.mock('../../store/watchlist/watchlist.selectors', () => ({
  selectAlertContext: (state: any) => state.context,
  selectAlertsAvailable: () => true,
}));
jest.mock('../../components/styled/Text', () => {
  const {Text} = require('react-native');
  return {BaseText: Text, H5: Text};
});
jest.mock('../../components/styled/Containers', () => ({
  SheetContainer: require('react-native').View,
}));
jest.mock('../../components/base/TouchableOpacity', () => ({
  TouchableOpacity: require('react-native').TouchableOpacity,
}));
jest.mock(
  '../../components/modal/base/sheet/SheetModal',
  () =>
    ({children}: any) =>
      children,
);
jest.mock('../../components/button/Button', () => {
  const ReactLib = require('react');
  const {Text: Label, TouchableOpacity: Touch} = require('react-native');
  return ({children, state, ...props}: any) =>
    ReactLib.createElement(
      Touch,
      {...props, testID: state || 'idle'},
      ReactLib.createElement(Label, null, children),
    );
});
jest.mock('../../store/app/app.actions', () => ({
  showBottomNotificationModal: (payload: any) => ({type: 'NOTICE', payload}),
}));
jest.mock('./watchlistUi.effects', () => ({
  saveAlertFromUi: () => ({type: 'SAVE'}),
  closePriceAlert: jest.fn(() => ({type: 'CLOSE'})),
  finishPriceAlert: () => ({type: 'FINISH'}),
  showPriceAlertError: () => ({type: 'ERROR'}),
  showWatchlistFull: () => ({type: 'FULL'}),
  turnOffAlertFromUi: () => ({type: 'OFF'}),
  skipPriceAlert: () => ({type: 'SKIP'}),
}));

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockState = {
    WATCHLIST: {
      alertSheet: {
        coin: {id: 'coin:btc', name: 'Bitcoin'},
        context: 'Watchlist',
        nonce: 42,
        open: true,
        isEdit: false,
        afterAdd: true,
      },
    },
    context: {alerts: {}},
  };
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

it('keeps Set mode through a confirmed first save and dismisses only after success', async () => {
  let resolve!: (saved: boolean) => void;
  mockSave = new Promise(done => {
    resolve = done;
  });
  const view = render(<PriceAlertSheet />);
  fireEvent.press(view.getByText('Save Price Alert'));
  expect(view.getByTestId('loading')).toBeTruthy();
  expect(closePriceAlert).not.toHaveBeenCalled();
  mockState.context.alerts['coin:btc'] = {alert: {thresholdPct: 10}};
  await act(async () => {
    resolve(true);
    await mockSave;
  });
  view.rerender(<PriceAlertSheet />);
  expect(view.getByTestId('success')).toBeTruthy();
  expect(view.getByText('Set Price Alert')).toBeTruthy();
  expect(view.queryByText('Edit Price Alert')).toBeNull();
  expect(view.queryByText('Turn Off Price Alert')).toBeNull();
  act(() => jest.advanceTimersByTime(899));
  expect(closePriceAlert).not.toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(1));
  expect(closePriceAlert).toHaveBeenCalledWith(true, 42);
});
