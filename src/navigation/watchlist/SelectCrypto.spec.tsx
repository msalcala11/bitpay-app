import React from 'react';
import {act, fireEvent, render} from '@testing-library/react-native';
import SelectCrypto from './SelectCrypto';
import {addCoinFromUi, openPriceAlert} from './watchlistUi.effects';

const mockCoin = {
  id: 'coin:btc',
  name: 'Bitcoin',
  symbol: 'BTC',
  image: {builtin: 'btc'},
  assets: [{currencyAbbreviation: 'btc', chain: 'btc'}],
  selector: {coin: 'btc'},
};
const mockCatalog = {coins: [mockCoin]};
const mockNavigation = {goBack: jest.fn(), setOptions: jest.fn()};
const mockDispatch = jest.fn((action: any) =>
  action.type === 'ADD' ? true : action,
);
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
}));
jest.mock('../../contexts', () => ({
  useTheme: () => ({dark: false, colors: {background: 'white'}}),
}));
jest.mock('../../utils/hooks', () => ({
  useAppDispatch: () => mockDispatch,
  useAppSelector: (selector: any) => selector({WATCHLIST: {items: []}}),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({t: (text: string) => text}),
}));
jest.mock('../../store/watchlist/coin-registry', () => ({
  getCoinCatalog: () => mockCatalog,
  subscribeCoinCatalog: () => () => {},
}));
jest.mock('./coinSearch', () => ({
  searchWatchlistCoins: (_catalog: unknown, _items: unknown, query: string) =>
    query ? [] : mockCatalog.coins,
}));
jest.mock('./watchlistRows', () => ({watchlistImage: () => ''}));
jest.mock('./watchlistUi.effects', () => ({
  addCoinFromUi: jest.fn(() => ({type: 'ADD'})),
  openPriceAlert: jest.fn(() => ({type: 'OPEN'})),
}));
jest.mock('../../store/wallet/effects/rates/rates', () => ({
  startGetRates: () => ({type: 'RATES'}),
}));
jest.mock('../../components/currency-image/CurrencyImage', () => ({
  CurrencyImage: () => null,
}));
jest.mock('../../components/modal/close/Close', () => () => null);
jest.mock('../../components/styled/Text', () => {
  const {Text} = require('react-native');
  return {HeaderTitle: Text, BaseText: Text, H4: Text};
});
jest.mock('../../components/base/TouchableOpacity', () => ({
  TouchableOpacity: require('react-native').TouchableOpacity,
}));
jest.mock('../../components/chain-search/ChainSearch', () => {
  const ReactLib = require('react');
  const {TextInput} = require('react-native');
  return (props: any) =>
    ReactLib.createElement(TextInput, {
      ...props,
      onChangeText: props.setSearchVal,
      testID: 'search',
    });
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

it('renders a modal title and close control, with ticker-safe search input', () => {
  const view = render(<SelectCrypto />);
  expect(view.getByText('Select Crypto')).toBeTruthy();
  expect(view.getByTestId('search').props).toMatchObject({
    autoCorrect: false,
    autoCapitalize: 'none',
  });
  fireEvent.press(view.getByLabelText('Close'));
  expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
});

it('opens the after-add sheet after the picker unmounts, without a transition callback', () => {
  const view = render(<SelectCrypto />);
  fireEvent.press(view.getByLabelText('Bitcoin BTC'));
  fireEvent.press(view.getByLabelText('Bitcoin BTC'));
  expect(addCoinFromUi).toHaveBeenCalledTimes(1);
  expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
  view.unmount();
  act(() => jest.advanceTimersByTime(699));
  expect(openPriceAlert).not.toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(1));
  expect(openPriceAlert).toHaveBeenCalledWith(mockCoin, 'Watchlist', true);
});

it('shows No Results for an unmatched search and restores browse when cleared', () => {
  const view = render(<SelectCrypto />);
  expect(view.queryByText('No Results')).toBeNull();
  expect(view.getByLabelText('Bitcoin BTC')).toBeTruthy();
  fireEvent.changeText(view.getByTestId('search'), 'no-such-coin');
  expect(view.getByText('No Results')).toBeTruthy();
  expect(view.queryByLabelText('Bitcoin BTC')).toBeNull();
  fireEvent.changeText(view.getByTestId('search'), '');
  expect(view.queryByText('No Results')).toBeNull();
  expect(view.getByLabelText('Bitcoin BTC')).toBeTruthy();
});
