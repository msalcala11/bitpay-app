import React from 'react';
import {render} from '@testing-library/react-native';
import {usePortfolioGainLossSummary} from './usePortfolioGainLossSummary';
import {useIsFocused} from '@react-navigation/native';
import {useAppDispatch, useAppSelector} from '../../../utils/hooks';
import {runPortfolioChartQuery, mapWalletsToStoredWallets} from '../common';
import {
  getCachedBalanceChartTimeframe,
  getCachedTimeframeStatus,
  deserializeCachedTimeframeToComputedSeries,
} from '../../../utils/portfolio/chartCache';

jest.mock('@react-navigation/native', () => {
  return {
    useIsFocused: jest.fn(),
  };
});

jest.mock('../../../utils/hooks', () => ({
  useAppDispatch: jest.fn(),
  useAppSelector: jest.fn(),
}));

jest.mock('../../../utils/portfolio/assets', () => ({
  getPortfolioWalletChainLower: jest.fn(() => 'btc'),
  getPortfolioWalletTokenAddress: jest.fn(() => undefined),
}));

jest.mock('../../../utils/helper-methods', () => ({
  getRateByCurrencyName: jest.fn(() => []),
}));

jest.mock('../common', () => {
  return {
    mapWalletsToStoredWallets: jest.fn(),
    buildCurrentRatesByAssetId: jest.fn(() => ({'btc-asset': 74333.76})),
    buildCommittedPortfolioRevisionToken: jest.fn(() => 'USD|1'),
    getCurrentRatesByAssetIdSignature: jest.fn(() => 'rates-sig'),
    getStoredWalletRequestSignature: jest.fn(() => 'wallet-sig'),
    resolveCurrentRatesAsOfMs: jest.fn(() => 1234),
    resolveCommittedPortfolioQuoteCurrency: jest.fn(() => 'USD'),
    runPortfolioChartQuery: jest.fn(),
  };
});

jest.mock('../../../utils/portfolio/chartCache', () => {
  const actual = jest.requireActual('../../../utils/portfolio/chartCache');
  return {
    ...actual,
    buildBalanceChartScopeId: jest.fn(() => 'scope-1'),
    getSortedUniqueWalletIds: jest.fn(walletIds => walletIds),
    getCachedBalanceChartTimeframe: jest.fn(),
    getCachedTimeframeStatus: jest.fn(),
    deserializeCachedTimeframeToComputedSeries: jest.fn(),
  };
});

const mockUseAppDispatch = useAppDispatch as jest.Mock;
const mockUseAppSelector = useAppSelector as jest.Mock;
const mockUseIsFocused = useIsFocused as jest.Mock;
const mockRunPortfolioChartQuery = runPortfolioChartQuery as jest.Mock;
const mockMapWalletsToStoredWallets = mapWalletsToStoredWallets as jest.Mock;
const mockGetCachedBalanceChartTimeframe =
  getCachedBalanceChartTimeframe as jest.Mock;
const mockGetCachedTimeframeStatus = getCachedTimeframeStatus as jest.Mock;
const mockDeserializeCachedTimeframeToComputedSeries =
  deserializeCachedTimeframeToComputedSeries as jest.Mock;

let latestResult: ReturnType<typeof usePortfolioGainLossSummary> | undefined;

const sampleWallet = {
  id: 'wallet-1',
  currencyAbbreviation: 'btc',
  chain: 'btc',
  tokenAddress: undefined,
} as any;

const HookHarness = ({
  wallets = [sampleWallet],
  liveFiatTotal = 100,
}: {
  wallets?: any[];
  liveFiatTotal?: number;
}) => {
  latestResult = usePortfolioGainLossSummary({
    wallets,
    liveFiatTotal,
  });
  return null;
};

describe('usePortfolioGainLossSummary', () => {
  let mockState: any;

  beforeEach(() => {
    latestResult = undefined;
    mockState = {
      APP: {
        defaultAltCurrency: {
          isoCode: 'USD',
        },
      },
      PORTFOLIO: {
        quoteCurrency: 'USD',
        lastPopulatedAt: 1,
      },
      RATE: {
        rates: {},
        ratesUpdatedAt: 1234,
      },
      PORTFOLIO_CHARTS: {
        cacheByScopeId: {
          'scope-1': {
            timeframes: {},
          },
        },
      },
    };

    mockUseAppDispatch.mockReset();
    mockUseAppDispatch.mockReturnValue(jest.fn());
    mockUseAppSelector.mockReset();
    mockUseAppSelector.mockImplementation(selector => selector(mockState));
    mockUseIsFocused.mockReset();
    mockUseIsFocused.mockReturnValue(true);
    mockRunPortfolioChartQuery.mockReset();
    mockMapWalletsToStoredWallets.mockReset();
    mockMapWalletsToStoredWallets.mockReturnValue({
      eligibleWallets: [sampleWallet],
      storedWallets: [
        {
          summary: {
            walletId: 'wallet-1',
            currencyAbbreviation: 'btc',
            chain: 'btc',
            tokenAddress: undefined,
          },
        },
      ],
    });
    mockGetCachedBalanceChartTimeframe.mockReset();
    mockGetCachedBalanceChartTimeframe.mockImplementation(
      (_timeframes, timeframe) =>
        ({
          timeframe,
        }) as any,
    );
    mockGetCachedTimeframeStatus.mockReset();
    mockGetCachedTimeframeStatus.mockReturnValue('fresh');
    mockDeserializeCachedTimeframeToComputedSeries.mockReset();
    mockDeserializeCachedTimeframeToComputedSeries.mockImplementation(
      (cachedTimeframe: {timeframe: '1D' | 'ALL'}) => ({
        analysisPoints: [
          {
            timestamp: cachedTimeframe.timeframe === '1D' ? 100 : 200,
            totalFiatBalance: 100,
            totalPnlChange: cachedTimeframe.timeframe === '1D' ? 5 : 20,
            totalPnlPercent: cachedTimeframe.timeframe === '1D' ? 10 : 25,
          },
        ],
      }),
    );
  });

  it('does not compute gain-loss charts while the screen is unfocused', () => {
    mockUseIsFocused.mockReturnValue(false);

    render(<HookHarness />);

    expect(mockRunPortfolioChartQuery).not.toHaveBeenCalled();
  });

  it('derives today and all-time summary values from cached balance chart timeframes', () => {
    render(<HookHarness />);

    expect(mockRunPortfolioChartQuery).not.toHaveBeenCalled();
    expect(latestResult?.summary).toEqual({
      quoteCurrency: 'USD',
      today: {
        deltaFiat: 5,
        percentRatio: 0.1,
        available: true,
      },
      total: {
        deltaFiat: 20,
        percentRatio: 0.25,
        available: true,
      },
    });
  });
});
