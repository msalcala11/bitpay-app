import React from 'react';
import {fireEvent, render} from '@testing-library/react-native';
import {WatchlistRow} from './WatchlistRow';
import {buildCoinCatalog} from '../../store/watchlist/coins';
import {SupportedCurrencyOptions} from '../../constants/SupportedCurrencyOptions';
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({navigate: mockNavigate}),
}));
jest.mock('../../contexts', () => ({
  useTheme: () => ({dark: false, colors: {background: 'white'}}),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({t: (s: string) => s}),
}));
jest.mock('../../utils/hooks', () => ({
  useAppDispatch: () => jest.fn(),
  useAppSelector: (select: any) =>
    select({
      APP: {defaultAltCurrency: {isoCode: 'USD'}},
      WATCHLIST: {items: []},
    }),
}));
jest.mock('../../store/watchlist/watchlist.selectors', () => ({
  selectAlertContext: () => undefined,
  selectAlertsAvailable: () => true,
}));
jest.mock('./watchlistUi.effects', () => ({
  removeCoinFromUi: jest.fn(),
  reorderFromUi: jest.fn(),
}));
jest.mock('react-native-reorderable-list', () => ({
  useReorderableDrag: () => jest.fn(),
}));
jest.mock('react-native-gesture-handler/ReanimatedSwipeable', () => ({
  __esModule: true,
  default: ({children}: any) => children,
}));
jest.mock('../../components/styled/Containers', () => ({ScreenGutter: '16'}));
jest.mock('../../components/styled/Text', () => ({
  BaseText: require('react-native').Text,
}));
jest.mock('../../components/base/TouchableOpacity', () => ({
  TouchableOpacity: require('react-native').TouchableOpacity,
}));
jest.mock('../tabs/home/components/exchange-rates/ExchangeRateItem', () => ({
  __esModule: true,
  default: ({onPress}: any) =>
    require('react').createElement(require('react-native').TouchableOpacity, {
      testID: 'row',
      onPress,
    }),
}));
it('navigates the EURC row using euroc and its chosen contract, not the displayed ticker', () => {
  const catalog = buildCoinCatalog(SupportedCurrencyOptions, {
    tokenOptionsByAddress: {},
    tokenDataByAddress: {},
  });
  const coin = catalog.byId.get('coin:eurc')!;
  const row: any = {
    currencyAbbreviation: 'EURC',
    currencyName: coin.name,
    chain: 'eth',
    ...coin.selector,
  };
  const view = render(<WatchlistRow coin={coin} row={row} />);
  fireEvent.press(view.getByTestId('row'));
  expect(mockNavigate).toHaveBeenCalledWith(
    'ExchangeRate',
    expect.objectContaining({
      currencyAbbreviation: 'euroc',
      chain: 'eth',
      tokenAddress: '0x1abaea1f7c830bd89acc67ec4af516284b1bc33c',
    }),
  );
});

jest.mock('../tabs/home/homeExchangeRates', () => jest.fn(() => []));
jest.mock('../../utils/helper-methods', () => ({
  getCurrencyAbbreviation: jest.fn(),
  calculatePercentageDifference: jest.fn(),
}));
jest.mock('../../utils/portfolio/displayCurrency', () => ({
  getAssetCurrentDisplayQuoteRate: jest.fn(),
}));
