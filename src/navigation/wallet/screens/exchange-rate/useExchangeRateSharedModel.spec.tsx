import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import useExchangeRateSharedModel from './useExchangeRateSharedModel';

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let latestSharedModel: ReturnType<typeof useExchangeRateSharedModel> | undefined;
let mockRouteParams: any;
let mockState: any;
const mockDispatch = jest.fn();
const mockSetOptions = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    setOptions: mockSetOptions,
  }),
  useRoute: () => ({
    params: mockRouteParams,
  }),
}));

jest.mock('styled-components/native', () => {
  const styled = (Component: any) => () => Component;

  return {
    __esModule: true,
    default: styled,
    useTheme: () => ({
      dark: false,
    }),
  };
});

jest.mock('../../../../components/back/HeaderBackButton', () => () => null);
jest.mock('../../../../components/styled/Text', () => ({
  HeaderTitle: 'HeaderTitle',
}));

jest.mock('../../../../constants/currencies', () => ({
  BitpaySupportedCoins: {
    btc: {
      name: 'Bitcoin',
      img: 'btc-image',
      theme: {},
    },
    eth: {
      name: 'Ethereum',
      img: 'eth-image',
      theme: {},
    },
  },
}));

jest.mock('../../../../constants/SupportedCurrencyOptions', () => ({
  SupportedCurrencyOptions: [],
}));

jest.mock('../../../../store/market-stats', () => ({
  fetchMarketStats: jest.fn((args: unknown) => ({
    type: 'FETCH_MARKET_STATS',
    payload: args,
  })),
  getMarketStatsCacheKey: jest.fn(() => 'market-stats-key'),
}));

jest.mock('../../../../store/wallet/utils/wallet', () => ({
  buildUIFormattedWallet: jest.fn(() => ({
    fiatBalance: 0,
    fiatBalanceFormat: '$0.00',
  })),
}));

jest.mock('../../../../utils/helper-methods', () => ({
  formatCurrencyAbbreviation: jest.fn((value: string) =>
    String(value || '').toUpperCase(),
  ),
  formatFiat: jest.fn(() => '$0.00'),
  formatFiatAmount: jest.fn((value: number) => String(value)),
  getRateByCurrencyName: jest.fn(
    (
      rates: Record<string, Array<{code: string; rate: number}>>,
      currencyAbbreviation: string,
    ) => rates[currencyAbbreviation] || [],
  ),
}));

jest.mock('../../../../utils/hooks', () => ({
  useAppDispatch: () => mockDispatch,
  useAppSelector: (selector: (state: any) => any) => selector(mockState),
}));

jest.mock('../../../../utils/hooks/useDevRenderTrace', () => ({
  useDevRenderTrace: jest.fn(),
}));

jest.mock('../../../../utils/portfolio/assetTheme', () => ({
  getAssetTheme: jest.fn(() => undefined),
}));

jest.mock('../../../../portfolio/ui/common', () => ({
  resolveCurrentRatesAsOfMs: jest.fn(() => 1234),
}));

jest.mock('../../../../utils/portfolio/assets', () => ({
  findSupportedCurrencyOptionForAsset: jest.fn(() => undefined),
  getWalletLiveFiatBalance: jest.fn(() => 0),
  getWalletsMatchingExchangeRateAsset: jest.fn(() => []),
  getVisibleWalletsFromKeys: jest.fn(() => []),
}));

jest.mock('../../../../utils/portfolio/core/pnl/rates', () => ({
  normalizeFiatRateSeriesCoin: jest.fn((value: string) =>
    String(value || '').toLowerCase(),
  ),
}));

jest.mock('../../../../store/wallet/utils/currency', () => ({
  IsSVMChain: jest.fn(() => false),
}));

jest.mock('../ExchangeRate.utils', () => ({
  formatCompactCurrency: jest.fn(() => '--'),
  formatSupply: jest.fn(() => '--'),
  POLYGON_ABOUT_FALLBACK: '',
}));

const HookHarness = () => {
  latestSharedModel = useExchangeRateSharedModel();
  return null;
};

describe('useExchangeRateSharedModel', () => {
  beforeEach(() => {
    latestSharedModel = undefined;
    mockDispatch.mockReset();
    mockSetOptions.mockReset();
    mockRouteParams = {
      currencyAbbreviation: 'eth',
      chain: 'eth',
      currencyName: 'Ethereum',
    };
    mockState = {
      APP: {
        defaultAltCurrency: {isoCode: 'EUR'},
        hideAllBalances: false,
        homeCarouselConfig: undefined,
      },
      MARKET_STATS: {
        itemsByKey: {},
      },
      PORTFOLIO: {
        quoteCurrency: 'USD',
      },
      RATE: {
        rates: {
          eth: [
            {code: 'USD', rate: 2000},
            {code: 'EUR', rate: 999999},
          ],
          btc: [
            {code: 'USD', rate: 40000},
            {code: 'EUR', rate: 36000},
          ],
        },
        ratesUpdatedAt: 1234,
      },
      WALLET: {
        keys: {},
      },
    };
  });

  it('derives the live display-quote spot rate from canonical USD plus the BTC bridge', async () => {
    await act(async () => {
      TestRenderer.create(<HookHarness />);
    });

    expect(latestSharedModel?.resolvedQuoteCurrency).toBe('EUR');
    expect(latestSharedModel?.currentFiatRate).toBeCloseTo(1800, 8);
  });
});
