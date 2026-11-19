import React from 'react';
import {act, fireEvent, render} from '@testing-library/react-native';
import SelectCrypto from './SelectCrypto';
import {buildCoinCatalog} from '../../store/watchlist/coins';
import {addCoinFromUi, openPriceAlert} from './watchlistUi.effects';

const mockCoin = {
  id: 'coin:btc',
  displayKey: 'coin:btc',
  name: 'Bitcoin',
  symbol: 'BTC',
  image: {builtin: 'btc'},
  selector: {coin: 'btc'},
};
const mockDefaultCatalog = buildCoinCatalog([], {
  tokenOptionsByAddress: {},
  tokenDataByAddress: {},
});
let mockCatalog: any = {...mockDefaultCatalog, coins: [mockCoin]};
let mockItems: any[] = [];
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
  useAppSelector: (selector: any) => selector({WATCHLIST: {items: mockItems}}),
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
  mockItems = [];
  mockCatalog = {...mockDefaultCatalog, coins: [mockCoin]};
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
  expect(openPriceAlert).toHaveBeenCalledWith(
    expect.objectContaining({id: mockCoin.id, selector: mockCoin.selector}),
    'Watchlist',
    true,
  );
  expect((openPriceAlert as jest.Mock).mock.calls[0][0]).not.toHaveProperty(
    'displayKey',
  );
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

it('dims all distinct search entries for one ticker and refuses picking them', () => {
  mockCatalog = buildCoinCatalog([], {
    tokenDataByAddress: {},
    tokenOptionsByAddress: {
      '0xa_e': {
        name: 'First',
        symbol: 'SAME',
        address: '0xa',
        decimals: 18,
        logoURI: 'a.png',
      },
      '0xb_m': {
        name: 'Second',
        symbol: 'SAME',
        address: '0xb',
        decimals: 18,
        logoURI: 'b.png',
      },
    },
  });
  mockItems = [mockCatalog.fromSelector({chain: 'eth', tokenAddress: '0xa'})];
  const view = render(<SelectCrypto />);
  expect(view.getAllByText('On Watchlist')).toHaveLength(2);
  const buttons = view
    .getAllByRole('button')
    .filter(button => button.props.accessibilityState?.disabled);
  expect(buttons).toHaveLength(2);
  for (const button of buttons) fireEvent.press(button);
  expect(addCoinFromUi).not.toHaveBeenCalled();
  const list = view.UNSAFE_getByType(require('react-native').FlatList);
  expect(
    new Set(
      mockCatalog.coins.map((entry: any) => list.props.keyExtractor(entry)),
    ).size,
  ).toBe(2);
});

it('dims a renamed token through its exact contract even when the stored ticker differs', () => {
  mockCatalog = buildCoinCatalog([], {
    tokenDataByAddress: {},
    tokenOptionsByAddress: {
      '0xa_e': {name: 'Renamed', symbol: 'NEW', address: '0xa', decimals: 18},
    },
  });
  mockItems = [
    {
      id: 'coin:old',
      name: 'Original',
      symbol: 'OLD',
      image: {uri: ''},
      selector: {chain: 'eth', tokenAddress: '0xa'},
    },
  ];
  const view = render(<SelectCrypto />);
  expect(view.getByText('On Watchlist')).toBeTruthy();
  expect(
    view
      .getAllByRole('button')
      .some(button => button.props.accessibilityState?.disabled),
  ).toBe(true);
});
