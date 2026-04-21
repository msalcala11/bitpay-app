import React from 'react';
import {render} from '@testing-library/react-native';
import {usePortfolioGainLossSummary} from './usePortfolioGainLossSummary';
import {useIsFocused} from '@react-navigation/native';
import {useAppDispatch} from '../../../utils/hooks';
import {runPortfolioChartQuery} from '../common';
import {
  BALANCE_GAIN_LOSS_SUMMARY_CACHE_IDENTITY_KEY,
  getCachedBalanceChartTimeframe,
  getCachedTimeframeStatus,
  deserializeCachedTimeframeToComputedSeries,
} from '../../../utils/portfolio/chartCache';
import {usePortfolioBalanceChartScope} from './usePortfolioBalanceChartScope';
import usePortfolioHistoricalRateDepsCache from './usePortfolioHistoricalRateDepsCache';

jest.mock('@react-navigation/native', () => {
  return {
    useIsFocused: jest.fn(),
  };
});

jest.mock('../../../utils/hooks', () => ({
  useAppDispatch: jest.fn(),
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
    runPortfolioChartQuery: jest.fn(),
  };
});

jest.mock('./usePortfolioBalanceChartScope', () => ({
  usePortfolioBalanceChartScope: jest.fn(),
}));

jest.mock('./usePortfolioHistoricalRateDepsCache', () => jest.fn());

jest.mock('../../../utils/portfolio/chartCache', () => {
  const actual = jest.requireActual('../../../utils/portfolio/chartCache');
  return {
    ...actual,
    getCachedBalanceChartTimeframe: jest.fn(),
    getCachedTimeframeStatus: jest.fn(),
    deserializeCachedTimeframeToComputedSeries: jest.fn(),
  };
});

const mockUseAppDispatch = useAppDispatch as jest.Mock;
const mockUseIsFocused = useIsFocused as jest.Mock;
const mockRunPortfolioChartQuery = runPortfolioChartQuery as jest.Mock;
const mockGetCachedBalanceChartTimeframe =
  getCachedBalanceChartTimeframe as jest.Mock;
const mockGetCachedTimeframeStatus = getCachedTimeframeStatus as jest.Mock;
const mockDeserializeCachedTimeframeToComputedSeries =
  deserializeCachedTimeframeToComputedSeries as jest.Mock;
const mockUsePortfolioBalanceChartScope =
  usePortfolioBalanceChartScope as jest.Mock;
const mockUsePortfolioHistoricalRateDepsCache =
  usePortfolioHistoricalRateDepsCache as jest.Mock;

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
  beforeEach(() => {
    latestResult = undefined;

    mockUseAppDispatch.mockReset();
    mockUseAppDispatch.mockReturnValue(jest.fn());
    mockUseIsFocused.mockReset();
    mockUseIsFocused.mockReturnValue(true);
    mockRunPortfolioChartQuery.mockReset();
    mockUsePortfolioBalanceChartScope.mockReset();
    mockUsePortfolioBalanceChartScope.mockReturnValue({
      asOfMs: 1234,
      cachedScope: {
        scopeId: 'scope-1',
        walletIds: ['wallet-1'],
        quoteCurrency: 'USD',
        balanceOffset: 0,
        lastAccessedAt: 1234,
        timeframes: {},
      },
      chartDataRevisionSig: 'USD|1|1234',
      currentRatesByAssetId: {'btc-asset': 74333.76},
      currentRatesSignature: 'rates-sig',
      currentSpotRatesByRateKey: {'btc:btc': 74333.76},
      currentSpotRatesSignature: 'spot-sig',
      eligibleWallets: [sampleWallet],
      quoteCurrency: 'USD',
      scopeId: 'scope-1',
      sortedWalletIds: ['wallet-1'],
      storedWalletRequestSig: 'wallet-sig',
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
    mockUsePortfolioHistoricalRateDepsCache.mockReset();
    mockUsePortfolioHistoricalRateDepsCache.mockReturnValue({
      cache: {},
      loading: false,
      error: undefined,
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

    expect(mockUsePortfolioBalanceChartScope).toHaveBeenCalledWith(
      expect.objectContaining({
        balanceOffset: 0,
        cacheIdentityKey: BALANCE_GAIN_LOSS_SUMMARY_CACHE_IDENTITY_KEY,
        wallets: [sampleWallet],
      }),
    );
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

  it('does not recompute summaries while cached chart timeframes are pending historical dependency validation', () => {
    mockGetCachedTimeframeStatus.mockReturnValue('pending_historical');

    render(<HookHarness />);

    expect(mockRunPortfolioChartQuery).not.toHaveBeenCalled();
  });
});
