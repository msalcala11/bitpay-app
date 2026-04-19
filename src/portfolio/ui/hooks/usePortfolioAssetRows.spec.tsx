import React from 'react';
import {act, render, waitFor} from '../../../../test/render';
import {
  clearPortfolioAssetRowsCommittedCacheForTests,
  usePortfolioAssetRows,
} from './usePortfolioAssetRows';
import {useIsFocused} from '@react-navigation/native';
import {useAppDispatch, useAppSelector} from '../../../utils/hooks';
import {
  mapWalletsToStoredWallets,
  runPortfolioAssetRowsQuery,
} from '../common';
import {getVisibleWalletsFromKeys} from '../../../utils/portfolio/assets';

jest.mock('@react-navigation/native', () => {
  const actualNav = jest.requireActual('@react-navigation/native');
  return {
    ...actualNav,
    useIsFocused: jest.fn(),
  };
});

jest.mock('../../../utils/hooks', () => ({
  useAppDispatch: jest.fn(),
  useAppSelector: jest.fn(),
}));

jest.mock('../../../utils/helper-methods', () => ({
  getRateByCurrencyName: jest.fn((rates, currencyAbbreviation) => {
    const assetKey = String(currencyAbbreviation || '').toLowerCase();
    return rates?.[assetKey] || rates?.[currencyAbbreviation];
  }),
  formatCurrencyAbbreviation: jest.fn(value => String(value || '').toUpperCase()),
  formatFiatAmount: jest.fn((value, quoteCurrency) => {
    return `${String(quoteCurrency || 'USD').toUpperCase()} ${Number(value || 0).toFixed(0)}`;
  }),
}));

jest.mock('../../../store/portfolio', () => ({
  maybePopulatePortfolioForWallets: jest.fn(() => ({type: 'TEST_MAYBE_POPULATE'})),
}));

jest.mock('../../../utils/portfolio/assets', () => ({
  buildWalletIdsByAssetGroupKey: jest.fn(() => ({})),
  getDisplayAssetRowItems: jest.fn(items => items),
  getPopulateLoadingByAssetKey: jest.fn(() => undefined),
  getVisibleWalletsFromKeys: jest.fn(() => []),
}));

jest.mock('../common', () => ({
  getStoredWalletRequestSignature: jest.fn(() => 'wallet-sig'),
  mapWalletsToStoredWallets: jest.fn(() => ({
    eligibleWallets: [],
    storedWallets: [],
  })),
  resolveCommittedPortfolioQuoteCurrency: jest.fn(() => 'USD'),
  runPortfolioAssetRowsQuery: jest.fn(),
}));

const mockUseIsFocused = useIsFocused as jest.Mock;
const mockUseAppDispatch = useAppDispatch as jest.Mock;
const mockUseAppSelector = useAppSelector as jest.Mock;
const mockMapWalletsToStoredWallets = mapWalletsToStoredWallets as jest.Mock;
const mockRunPortfolioAssetRowsQuery = runPortfolioAssetRowsQuery as jest.Mock;
const mockGetVisibleWalletsFromKeys = getVisibleWalletsFromKeys as jest.Mock;
const mockAssetId = 'btc:btc';

const mockWallet = {id: 'wallet-1'} as any;
const mockStoredWallet = {
  walletId: 'wallet-1',
  addedAt: 0,
  credentials: {},
  summary: {
    walletId: 'wallet-1',
    walletName: 'Bitcoin',
    chain: 'btc',
    network: 'livenet',
    currencyAbbreviation: 'btc',
    balanceAtomic: '100000000',
    balanceFormatted: '1',
  },
};

const emptyAssetRowsResult = {
  timeframe: '1D',
  quoteCurrency: 'USD',
  startTs: 0,
  endTs: 0,
  generatedAt: 0,
  rows: [],
};

function createAssetRowsResult(args: {
  timeframe: '1D' | 'ALL';
  displayPercentRatio: number;
  deltaFiatValue: number;
}) {
  return {
    timeframe: args.timeframe,
    quoteCurrency: 'USD',
    startTs: 0,
    endTs: 0,
    generatedAt: 0,
    rows: [
      {
        key: 'btc',
        assetId: 'btc',
        currencyAbbreviation: 'btc',
        chain: 'btc',
        tokenAddress: undefined,
        balanceAtomic: '100000000',
        unitDecimals: 8,
        cryptoAmount: '1.0 BTC',
        fiatValue: 100,
        deltaFiatValue: args.deltaFiatValue,
        displayPercentRatio: args.displayPercentRatio,
        pnlPercentRatio: args.displayPercentRatio,
        pricePercentRatio: args.displayPercentRatio,
        hasRate: true,
        hasPnl: true,
        hasActivityInWindow: true,
        showPnlPlaceholder: false,
        isPositive: args.deltaFiatValue >= 0,
        sortValueFiat: 100,
      },
    ],
  } as any;
}

function createUsdRate(rate: number) {
  return [
    {
      code: 'USD',
      fetchedOn: 0,
      name: 'US Dollar',
      rate,
      ts: 0,
    },
  ];
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {promise, resolve, reject};
}

let latestResult: ReturnType<typeof usePortfolioAssetRows> | undefined;

const HookHarness = ({
  gainLossMode = '1D',
  maxVisibleItems,
}: {
  gainLossMode?: any;
  maxVisibleItems?: number;
}) => {
  latestResult = usePortfolioAssetRows({
    gainLossMode,
    maxVisibleItems,
  });
  return null;
};

describe('usePortfolioAssetRows', () => {
  let mockState: any;
  let dispatchSpy: jest.Mock;

  beforeEach(() => {
    clearPortfolioAssetRowsCommittedCacheForTests();
    latestResult = undefined;
    mockUseIsFocused.mockReset();
    mockUseIsFocused.mockReturnValue(false);
    mockUseAppDispatch.mockReset();
    dispatchSpy = jest.fn();
    mockUseAppDispatch.mockReturnValue(dispatchSpy);
    mockUseAppSelector.mockReset();
    mockState = {
      PORTFOLIO: {
        lastPopulatedAt: undefined,
        quoteCurrency: 'USD',
        populateStatus: {
          inProgress: false,
          finishedAt: undefined,
          stopReason: undefined,
          errors: [],
        },
      },
      APP: {
        defaultAltCurrency: {isoCode: 'USD'},
        homeCarouselConfig: undefined,
      },
      RATE: {
        rates: {},
      },
      WALLET: {
        keys: {},
      },
    };
    mockUseAppSelector.mockImplementation(selector => selector(mockState));
    mockGetVisibleWalletsFromKeys.mockReset();
    mockGetVisibleWalletsFromKeys.mockReturnValue([mockWallet]);
    mockMapWalletsToStoredWallets.mockReset();
    mockMapWalletsToStoredWallets.mockReturnValue({
      eligibleWallets: [mockWallet],
      storedWallets: [mockStoredWallet],
    });
    mockRunPortfolioAssetRowsQuery.mockReset();
    mockRunPortfolioAssetRowsQuery.mockResolvedValue(emptyAssetRowsResult);
  });

  it('does not run the asset-row RPC while the screen is unfocused', () => {
    mockState.PORTFOLIO.lastPopulatedAt = 10;

    render(<HookHarness />);

    expect(mockRunPortfolioAssetRowsQuery).not.toHaveBeenCalled();
  });

  it('refreshes asset rows only after populate completes', async () => {
    mockUseIsFocused.mockReturnValue(true);
    mockState.PORTFOLIO.lastPopulatedAt = 10;
    mockState.PORTFOLIO.populateStatus.finishedAt = 10;
    mockState.PORTFOLIO.populateStatus.stopReason = 'completed';
    mockRunPortfolioAssetRowsQuery.mockImplementation(
      () => new Promise(() => {}),
    );

    const view = render(<HookHarness />);

    await waitFor(() => {
      expect(mockRunPortfolioAssetRowsQuery).toHaveBeenCalledTimes(1);
    });

    mockState = {
      ...mockState,
      PORTFOLIO: {
        ...mockState.PORTFOLIO,
        populateStatus: {
          ...mockState.PORTFOLIO.populateStatus,
          inProgress: true,
          finishedAt: undefined,
          stopReason: undefined,
        },
      },
    };
    view.rerender(<HookHarness />);

    expect(mockRunPortfolioAssetRowsQuery).toHaveBeenCalledTimes(1);

    mockState = {
      ...mockState,
      PORTFOLIO: {
        ...mockState.PORTFOLIO,
        lastPopulatedAt: 20,
        populateStatus: {
          ...mockState.PORTFOLIO.populateStatus,
          inProgress: false,
          finishedAt: 20,
          stopReason: 'completed',
        },
      },
    };
    view.rerender(<HookHarness />);

    await waitFor(() => {
      expect(mockRunPortfolioAssetRowsQuery).toHaveBeenCalledTimes(2);
    });
  });

  it('does not auto-populate on refocus when committed portfolio data already exists', () => {
    mockUseIsFocused.mockReturnValue(true);
    mockState.PORTFOLIO.lastPopulatedAt = 10;
    mockRunPortfolioAssetRowsQuery.mockImplementation(
      () => new Promise(() => {}),
    );

    render(<HookHarness />);

    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('can limit visible rows without changing the shared asset-row source of truth', async () => {
    mockUseIsFocused.mockReturnValue(true);
    mockState.PORTFOLIO.lastPopulatedAt = 10;
    mockState.PORTFOLIO.populateStatus.finishedAt = 10;
    mockState.PORTFOLIO.populateStatus.stopReason = 'completed';

    const deferredRows = createDeferred<any>();

    mockRunPortfolioAssetRowsQuery.mockReturnValue(deferredRows.promise);

    render(<HookHarness maxVisibleItems={4} />);

    await act(async () => {
      deferredRows.resolve({
      timeframe: '1D',
      quoteCurrency: 'USD',
      startTs: 0,
      endTs: 0,
      generatedAt: 0,
      rows: Array.from({length: 5}).map((_, index) => ({
        key: `asset-${index}`,
        assetId: `asset-${index}`,
        currencyAbbreviation: `coin${index}`,
        chain: `chain${index}`,
        balanceAtomic: '1',
        unitDecimals: 8,
        cryptoAmount: '1',
        fiatValue: 100 - index,
        deltaFiatValue: index,
        displayPercentRatio: 0.01,
        pnlPercentRatio: 0.01,
        pricePercentRatio: 0.01,
        hasRate: true,
        hasPnl: true,
        hasActivityInWindow: true,
        showPnlPlaceholder: false,
        isPositive: true,
        sortValueFiat: 100 - index,
      })),
      });
    });

    await waitFor(() => {
      expect(latestResult?.visibleItems).toHaveLength(4);
      expect(latestResult?.visibleItems[0]?.key).toBe('asset-0');
      expect(latestResult?.visibleItems[3]?.key).toBe('asset-3');
    });
  });

  it('switches timeframes without exposing stale final asset-row values', async () => {
    mockUseIsFocused.mockReturnValue(true);
    mockState.PORTFOLIO.lastPopulatedAt = 10;
    mockState.PORTFOLIO.populateStatus.finishedAt = 10;
    mockState.PORTFOLIO.populateStatus.stopReason = 'completed';

    const oneDay = createDeferred<any>();
    const allTime = createDeferred<any>();

    mockRunPortfolioAssetRowsQuery.mockImplementation(({timeframe}) => {
      return timeframe === 'ALL' ? allTime.promise : oneDay.promise;
    });

    const view = render(<HookHarness gainLossMode="1D" />);

    expect(latestResult?.isFiatLoading).toBe(true);
    expect(latestResult?.isPnlLoading).toBe(true);

    await act(async () => {
      oneDay.resolve(
        createAssetRowsResult({
          timeframe: '1D',
          displayPercentRatio: 0.01,
          deltaFiatValue: 1,
        }),
      );
    });

    await waitFor(() => {
      expect(latestResult?.isFiatLoading).toBe(false);
      expect(latestResult?.isPnlLoading).toBe(false);
      expect(latestResult?.visibleItems[0]?.deltaPercent).toBe('+1.0%');
    });

    view.rerender(<HookHarness gainLossMode="ALL" />);

    expect(mockRunPortfolioAssetRowsQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({
        timeframe: 'ALL',
      }),
    );
    expect(latestResult?.isFiatLoading).toBe(true);
    expect(latestResult?.isPnlLoading).toBe(true);
    expect(latestResult?.visibleItems).toHaveLength(1);

    await act(async () => {
      allTime.resolve(
        createAssetRowsResult({
          timeframe: 'ALL',
          displayPercentRatio: 0.12,
          deltaFiatValue: 12,
        }),
      );
    });

    await waitFor(() => {
      expect(latestResult?.isFiatLoading).toBe(false);
      expect(latestResult?.isPnlLoading).toBe(false);
      expect(latestResult?.visibleItems[0]?.deltaPercent).toBe('+12.0%');
      expect(latestResult?.visibleItems[0]?.deltaFiat).toContain('12');
    });
  });

  it('keeps committed right-side values visible during a live-rate-only refresh', async () => {
    mockUseIsFocused.mockReturnValue(true);
    mockState.PORTFOLIO.lastPopulatedAt = 10;
    mockState.PORTFOLIO.populateStatus.finishedAt = 10;
    mockState.PORTFOLIO.populateStatus.stopReason = 'completed';
    mockState.RATE.rates = {
      btc: createUsdRate(100),
    };

    const initialRate = createDeferred<any>();
    const refreshedRate = createDeferred<any>();

    mockRunPortfolioAssetRowsQuery.mockImplementation(({currentRatesByAssetId}) => {
      return currentRatesByAssetId?.[mockAssetId] === 101
        ? refreshedRate.promise
        : initialRate.promise;
    });

    const view = render(<HookHarness gainLossMode="1D" />);

    await act(async () => {
      initialRate.resolve(
        createAssetRowsResult({
          timeframe: '1D',
          displayPercentRatio: 0.01,
          deltaFiatValue: 1,
        }),
      );
    });

    await waitFor(() => {
      expect(latestResult?.isFiatLoading).toBe(false);
      expect(latestResult?.isPnlLoading).toBe(false);
      expect(latestResult?.visibleItems[0]?.deltaPercent).toBe('+1.0%');
    });

    mockState = {
      ...mockState,
      RATE: {
        ...mockState.RATE,
        rates: {
          btc: createUsdRate(101),
        },
      },
    };
    view.rerender(<HookHarness gainLossMode="1D" />);

    await waitFor(() => {
      expect(mockRunPortfolioAssetRowsQuery).toHaveBeenCalledTimes(2);
    });

    expect(mockRunPortfolioAssetRowsQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({
        currentRatesByAssetId: {[mockAssetId]: 101},
      }),
    );
    expect(latestResult?.isFiatLoading).toBe(false);
    expect(latestResult?.isPnlLoading).toBe(false);
    expect(latestResult?.visibleItems[0]?.deltaPercent).toBe('+1.0%');

    await act(async () => {
      refreshedRate.resolve(
        createAssetRowsResult({
          timeframe: '1D',
          displayPercentRatio: 0.02,
          deltaFiatValue: 2,
        }),
      );
    });

    await waitFor(() => {
      expect(latestResult?.isFiatLoading).toBe(false);
      expect(latestResult?.isPnlLoading).toBe(false);
      expect(latestResult?.visibleItems[0]?.deltaPercent).toBe('+2.0%');
    });
  });

  it('ignores a stale live-rate success after a newer execution starts for the same base key', async () => {
    mockUseIsFocused.mockReturnValue(true);
    mockState.PORTFOLIO.lastPopulatedAt = 10;
    mockState.PORTFOLIO.populateStatus.finishedAt = 10;
    mockState.PORTFOLIO.populateStatus.stopReason = 'completed';
    mockState.RATE.rates = {
      btc: createUsdRate(100),
    };

    const initialRate = createDeferred<any>();
    const staleRate = createDeferred<any>();
    const latestRate = createDeferred<any>();

    mockRunPortfolioAssetRowsQuery.mockImplementation(({currentRatesByAssetId}) => {
      switch (currentRatesByAssetId?.[mockAssetId]) {
        case 101:
          return staleRate.promise;
        case 102:
          return latestRate.promise;
        default:
          return initialRate.promise;
      }
    });

    const view = render(<HookHarness gainLossMode="1D" />);

    await act(async () => {
      initialRate.resolve(
        createAssetRowsResult({
          timeframe: '1D',
          displayPercentRatio: 0.01,
          deltaFiatValue: 1,
        }),
      );
    });

    await waitFor(() => {
      expect(latestResult?.visibleItems[0]?.deltaPercent).toBe('+1.0%');
    });

    mockState = {
      ...mockState,
      RATE: {
        ...mockState.RATE,
        rates: {
          btc: createUsdRate(101),
        },
      },
    };
    view.rerender(<HookHarness gainLossMode="1D" />);

    mockState = {
      ...mockState,
      RATE: {
        ...mockState.RATE,
        rates: {
          btc: createUsdRate(102),
        },
      },
    };
    view.rerender(<HookHarness gainLossMode="1D" />);

    await waitFor(() => {
      expect(mockRunPortfolioAssetRowsQuery).toHaveBeenCalledTimes(3);
    });

    await act(async () => {
      staleRate.resolve(
        createAssetRowsResult({
          timeframe: '1D',
          displayPercentRatio: 0.02,
          deltaFiatValue: 2,
        }),
      );
    });

    expect(latestResult?.visibleItems[0]?.deltaPercent).toBe('+1.0%');

    await act(async () => {
      latestRate.resolve(
        createAssetRowsResult({
          timeframe: '1D',
          displayPercentRatio: 0.03,
          deltaFiatValue: 3,
        }),
      );
    });

    await waitFor(() => {
      expect(latestResult?.isPnlLoading).toBe(false);
      expect(latestResult?.visibleItems[0]?.deltaPercent).toBe('+3.0%');
    });
  });

  it('ignores a late 1D response after switching to ALL before the 1D request resolves', async () => {
    mockUseIsFocused.mockReturnValue(true);
    mockState.PORTFOLIO.lastPopulatedAt = 10;
    mockState.PORTFOLIO.populateStatus.finishedAt = 10;
    mockState.PORTFOLIO.populateStatus.stopReason = 'completed';

    const oneDay = createDeferred<any>();
    const allTime = createDeferred<any>();

    mockRunPortfolioAssetRowsQuery.mockImplementation(({timeframe}) => {
      return timeframe === 'ALL' ? allTime.promise : oneDay.promise;
    });

    const view = render(<HookHarness gainLossMode="1D" />);
    view.rerender(<HookHarness gainLossMode="ALL" />);

    expect(mockRunPortfolioAssetRowsQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({
        timeframe: 'ALL',
      }),
    );
    expect(latestResult?.isPnlLoading).toBe(true);
    expect(latestResult?.visibleItems).toEqual([]);

    await act(async () => {
      oneDay.resolve(
        createAssetRowsResult({
          timeframe: '1D',
          displayPercentRatio: 0.01,
          deltaFiatValue: 1,
        }),
      );
    });

    expect(latestResult?.isPnlLoading).toBe(true);
    expect(latestResult?.visibleItems).toEqual([]);

    await act(async () => {
      allTime.resolve(
        createAssetRowsResult({
          timeframe: 'ALL',
          displayPercentRatio: 0.12,
          deltaFiatValue: 12,
        }),
      );
    });

    await waitFor(() => {
      expect(latestResult?.isPnlLoading).toBe(false);
      expect(latestResult?.visibleItems[0]?.deltaPercent).toBe('+12.0%');
    });
  });

  it('ignores a stale live-rate failure while a newer execution is still loading', async () => {
    mockUseIsFocused.mockReturnValue(true);
    mockState.PORTFOLIO.lastPopulatedAt = 10;
    mockState.PORTFOLIO.populateStatus.finishedAt = 10;
    mockState.PORTFOLIO.populateStatus.stopReason = 'completed';
    mockState.RATE.rates = {
      btc: createUsdRate(100),
    };

    const staleRate = createDeferred<any>();
    const latestRate = createDeferred<any>();

    mockRunPortfolioAssetRowsQuery.mockImplementation(({currentRatesByAssetId}) => {
      return currentRatesByAssetId?.[mockAssetId] === 101
        ? latestRate.promise
        : staleRate.promise;
    });

    const view = render(<HookHarness gainLossMode="1D" />);

    await waitFor(() => {
      expect(mockRunPortfolioAssetRowsQuery).toHaveBeenCalledTimes(1);
      expect(latestResult?.isPnlLoading).toBe(true);
    });

    mockState = {
      ...mockState,
      RATE: {
        ...mockState.RATE,
        rates: {
          btc: createUsdRate(101),
        },
      },
    };
    view.rerender(<HookHarness gainLossMode="1D" />);

    await waitFor(() => {
      expect(mockRunPortfolioAssetRowsQuery).toHaveBeenCalledTimes(2);
      expect(latestResult?.isPnlLoading).toBe(true);
    });

    await act(async () => {
      staleRate.reject(new Error('stale rate failure'));
    });

    await waitFor(() => {
      expect(latestResult?.isPnlLoading).toBe(true);
      expect(latestResult?.visibleItems).toEqual([]);
    });

    await act(async () => {
      latestRate.resolve(
        createAssetRowsResult({
          timeframe: '1D',
          displayPercentRatio: 0.04,
          deltaFiatValue: 4,
        }),
      );
    });

    await waitFor(() => {
      expect(latestResult?.isPnlLoading).toBe(false);
      expect(latestResult?.visibleItems[0]?.deltaPercent).toBe('+4.0%');
    });
  });
});
