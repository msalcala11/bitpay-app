import React from 'react';
import {act, render, waitFor} from '@testing-library/react-native';
import {usePortfolioAssetRows} from './usePortfolioAssetRows';
import {usePortfolioAnalysis} from './usePortfolioAnalysis';
import {useAppDispatch, useAppSelector} from '../../../utils/hooks';

jest.mock('../../../utils/hooks', () => ({
  useAppDispatch: jest.fn(),
  useAppSelector: jest.fn(),
}));

jest.mock('../../../utils/portfolio/assets', () => ({
  buildWalletIdsByAssetGroupKey: jest.fn(() => ({})),
  getDisplayAssetRowItems: jest.fn(items => items),
  getPortfolioWalletCurrencyAbbreviationLower: jest.fn(wallet =>
    String(wallet?.currencyAbbreviation || '').toLowerCase(),
  ),
  getPopulateLoadingByAssetKey: jest.fn(() => undefined),
  getVisibleWalletsFromKeys: jest.fn(() => []),
  sortAssetRowItemsByAssetFiatPriority: jest.fn(args => args.items),
}));

jest.mock('../selectors/buildAssetRowsFromAnalysis', () => ({
  __esModule: true,
  default: jest.fn(() => []),
}));

jest.mock('../common', () => ({
  getCurrentRatesByAssetIdSignature: jest.fn(() => ''),
  getStoredWalletRequestSignature: jest.fn(() => ''),
  runPortfolioAnalysisQuery: jest.fn(),
}));

jest.mock('./usePortfolioAnalysis', () => ({
  usePortfolioAnalysis: jest.fn(),
}));

const mockUsePortfolioAnalysis = usePortfolioAnalysis as jest.Mock;
const mockUseAppDispatch = useAppDispatch as jest.Mock;
const mockUseAppSelector = useAppSelector as jest.Mock;
const mockBuildAssetRowsFromAnalysis = jest.requireMock(
  '../selectors/buildAssetRowsFromAnalysis',
).default as jest.Mock;
const mockGetPopulateLoadingByAssetKey = jest.requireMock(
  '../../../utils/portfolio/assets',
).getPopulateLoadingByAssetKey as jest.Mock;
const mockGetVisibleWalletsFromKeys = jest.requireMock(
  '../../../utils/portfolio/assets',
).getVisibleWalletsFromKeys as jest.Mock;
const mockSortAssetRowItemsByAssetFiatPriority = jest.requireMock(
  '../../../utils/portfolio/assets',
).sortAssetRowItemsByAssetFiatPriority as jest.Mock;
const mockRunPortfolioAnalysisQuery = jest.requireMock(
  '../common',
).runPortfolioAnalysisQuery as jest.Mock;

let latestResult: ReturnType<typeof usePortfolioAssetRows> | undefined;

const HookHarness = () => {
  latestResult = usePortfolioAssetRows({
    gainLossMode: '1D',
  });
  return null;
};

describe('usePortfolioAssetRows', () => {
  let mockState: any;

  beforeEach(() => {
    latestResult = undefined;
    mockUseAppDispatch.mockReset();
    mockUseAppDispatch.mockReturnValue(jest.fn());
    mockUseAppSelector.mockReset();
    mockState = {
      PORTFOLIO: {
        lastPopulatedAt: undefined,
        populateStatus: {
          inProgress: false,
          finishedAt: undefined,
          stopReason: undefined,
          errors: [],
        },
      },
      APP: {
        homeCarouselConfig: undefined,
      },
      WALLET: {
        keys: {},
      },
    };
    mockUseAppSelector.mockImplementation(selector => selector(mockState));
    mockUsePortfolioAnalysis.mockReset();
    mockUsePortfolioAnalysis.mockReturnValue({
      data: undefined,
      committedData: undefined,
      currentData: undefined,
      error: undefined,
      loading: false,
      quoteCurrency: 'USD',
      storedWallets: [],
    });
    mockBuildAssetRowsFromAnalysis.mockReset();
    mockBuildAssetRowsFromAnalysis.mockReturnValue([]);
    mockGetPopulateLoadingByAssetKey.mockReset();
    mockGetPopulateLoadingByAssetKey.mockReturnValue(undefined);
    mockGetVisibleWalletsFromKeys.mockReset();
    mockGetVisibleWalletsFromKeys.mockReturnValue([]);
    mockSortAssetRowItemsByAssetFiatPriority.mockReset();
    mockSortAssetRowItemsByAssetFiatPriority.mockImplementation(args => args.items);
    mockRunPortfolioAnalysisQuery.mockReset();
    mockRunPortfolioAnalysisQuery.mockResolvedValue(undefined);
  });

  it('keeps runtime analysis queries enabled even when the screen is unfocused', () => {
    render(<HookHarness />);

    expect(mockUsePortfolioAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        timeframe: '1D',
        allowCurrentWhilePopulate: true,
      }),
    );
  });

  it('refreshes asset analysis as populate progress changes and after completion', async () => {
    mockState.PORTFOLIO.lastPopulatedAt = 10;
    mockState.PORTFOLIO.populateStatus.finishedAt = 10;
    mockState.PORTFOLIO.populateStatus.stopReason = 'completed';

    const view = render(<HookHarness />);

    expect(mockUsePortfolioAnalysis).toHaveBeenLastCalledWith(
      expect.objectContaining({
        refreshToken: '10|10|completed|0',
        clearDataToken: '10|10|completed|0',
        allowCurrentWhilePopulate: true,
      }),
    );

    mockState = {
      ...mockState,
      PORTFOLIO: {
        ...mockState.PORTFOLIO,
        populateStatus: {
          ...mockState.PORTFOLIO.populateStatus,
          inProgress: true,
          startedAt: 11,
          finishedAt: undefined,
          stopReason: undefined,
        },
      },
    };
    view.rerender(<HookHarness />);

    expect(mockUsePortfolioAnalysis).toHaveBeenLastCalledWith(
      expect.objectContaining({
        refreshToken: '10|||0|1|11|0|0',
        clearDataToken: '10|||0|1|11',
        allowCurrentWhilePopulate: true,
      }),
    );

    mockState = {
      ...mockState,
      PORTFOLIO: {
        ...mockState.PORTFOLIO,
        populateStatus: {
          ...mockState.PORTFOLIO.populateStatus,
          walletsCompleted: 1,
        },
      },
    };
    view.rerender(<HookHarness />);

    expect(mockUsePortfolioAnalysis).toHaveBeenLastCalledWith(
      expect.objectContaining({
        refreshToken: '10|||0|1|11|1|0',
        clearDataToken: '10|||0|1|11',
        allowCurrentWhilePopulate: true,
      }),
    );

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
      expect(mockUsePortfolioAnalysis).toHaveBeenLastCalledWith(
        expect.objectContaining({
          refreshToken: '20|20|completed|0',
          clearDataToken: '20|20|completed|0',
          allowCurrentWhilePopulate: true,
        }),
      );
    });
  });

  it('does not auto-populate on refocus even when committed portfolio data is missing', () => {
    mockUsePortfolioAnalysis.mockReturnValue({
      data: undefined,
      committedData: undefined,
      currentData: undefined,
      loading: false,
      quoteCurrency: 'USD',
      storedWallets: [],
    });

    render(<HookHarness />);

    expect(mockUseAppDispatch).not.toHaveBeenCalled();
  });

  it('keeps all asset rows in loading state while a fresh populate has no committed analysis yet', () => {
    mockState.PORTFOLIO.populateStatus.inProgress = true;
    mockBuildAssetRowsFromAnalysis.mockReturnValue([
      {
        key: 'doge',
        currencyAbbreviation: 'doge',
        chain: 'doge',
        tokenAddress: undefined,
        name: 'DOGE',
        cryptoAmount: '22.6',
        fiatAmount: '$0',
        deltaFiat: '—',
        deltaPercent: '—',
        isPositive: true,
        hasRate: false,
        hasPnl: false,
        showPnlPlaceholder: true,
      },
    ]);

    render(<HookHarness />);

    expect(latestResult?.isPopulateLoadingByKey).toEqual({doge: true});
    expect(mockGetPopulateLoadingByAssetKey).not.toHaveBeenCalled();
  });

  it('keeps asset ordering stable by wallet fiat priority during populate', () => {
    mockState.PORTFOLIO.populateStatus.inProgress = true;
    mockGetVisibleWalletsFromKeys.mockReturnValue([
      {
        id: 'doge-wallet',
        currencyAbbreviation: 'doge',
        chain: 'doge',
        network: 'livenet',
        balance: {fiat: 500},
      },
      {
        id: 'btc-wallet',
        currencyAbbreviation: 'btc',
        chain: 'btc',
        network: 'livenet',
        balance: {fiat: 100},
      },
    ]);
    mockBuildAssetRowsFromAnalysis.mockReturnValue([
      {
        key: 'btc',
        currencyAbbreviation: 'btc',
        chain: 'btc',
        name: 'BTC',
        cryptoAmount: '1',
        fiatAmount: '$100',
        deltaFiat: '+$1',
        deltaPercent: '+1%',
        isPositive: true,
        hasRate: true,
        hasPnl: true,
      },
      {
        key: 'doge',
        currencyAbbreviation: 'doge',
        chain: 'doge',
        name: 'DOGE',
        cryptoAmount: '2',
        fiatAmount: '$500',
        deltaFiat: '+$5',
        deltaPercent: '+2%',
        isPositive: true,
        hasRate: true,
        hasPnl: true,
      },
    ]);
    mockSortAssetRowItemsByAssetFiatPriority.mockReturnValue([
      {
        key: 'doge',
        currencyAbbreviation: 'doge',
        chain: 'doge',
        name: 'DOGE',
        cryptoAmount: '2',
        fiatAmount: '$500',
        deltaFiat: '+$5',
        deltaPercent: '+2%',
        isPositive: true,
        hasRate: true,
        hasPnl: true,
      },
      {
        key: 'btc',
        currencyAbbreviation: 'btc',
        chain: 'btc',
        name: 'BTC',
        cryptoAmount: '1',
        fiatAmount: '$100',
        deltaFiat: '+$1',
        deltaPercent: '+1%',
        isPositive: true,
        hasRate: true,
        hasPnl: true,
      },
    ]);

    render(<HookHarness />);

    expect(mockSortAssetRowItemsByAssetFiatPriority).toHaveBeenCalledWith({
      items: expect.any(Array),
      wallets: expect.any(Array),
    });
    expect(latestResult?.visibleItems.map(item => item.key)).toEqual([
      'doge',
      'btc',
    ]);
  });

  it('keeps an asset revealed after it resolves once during the active populate session', () => {
    mockState.PORTFOLIO.populateStatus.inProgress = true;
    mockState.PORTFOLIO.populateStatus.startedAt = 11;
    mockUsePortfolioAnalysis.mockReturnValue({
      data: {wallets: [{}]},
      committedData: undefined,
      currentData: {wallets: [{}]},
      loading: false,
      quoteCurrency: 'USD',
      storedWallets: [],
    });
    mockGetVisibleWalletsFromKeys.mockReturnValue([
      {
        id: 'doge-wallet',
        currencyAbbreviation: 'doge',
        chain: 'doge',
        network: 'livenet',
        balance: {fiat: 500},
      },
    ]);
    mockBuildAssetRowsFromAnalysis.mockReturnValue([
      {
        key: 'doge',
        currencyAbbreviation: 'doge',
        chain: 'doge',
        name: 'DOGE',
        cryptoAmount: '2',
        fiatAmount: '$500',
        deltaFiat: '+$5',
        deltaPercent: '+2%',
        isPositive: true,
        hasRate: true,
        hasPnl: true,
      },
    ]);
    mockGetPopulateLoadingByAssetKey
      .mockReturnValueOnce({doge: false})
      .mockReturnValueOnce({doge: true});

    const view = render(<HookHarness />);

    expect(latestResult?.isPopulateLoadingByKey).toEqual({doge: false});

    mockState = {
      ...mockState,
      PORTFOLIO: {
        ...mockState.PORTFOLIO,
        populateStatus: {
          ...mockState.PORTFOLIO.populateStatus,
          txRequestsMade: 1,
        },
      },
    };
    view.rerender(<HookHarness />);

    expect(latestResult?.isPopulateLoadingByKey).toEqual({doge: false});
  });

  it('keeps a resolved asset row stable after later populate refreshes transiently degrade it', () => {
    mockState.PORTFOLIO.populateStatus.inProgress = true;
    mockState.PORTFOLIO.populateStatus.startedAt = 11;
    mockGetVisibleWalletsFromKeys.mockReturnValue([
      {
        id: 'doge-wallet',
        currencyAbbreviation: 'doge',
        chain: 'doge',
        network: 'livenet',
        balance: {fiat: 500},
      },
    ]);
    mockBuildAssetRowsFromAnalysis
      .mockReturnValueOnce([
        {
          key: 'doge',
          currencyAbbreviation: 'doge',
          chain: 'doge',
          name: 'DOGE',
          cryptoAmount: '2',
          fiatAmount: '$500',
          deltaFiat: '+$5',
          deltaPercent: '+2%',
          isPositive: true,
          hasRate: true,
          hasPnl: true,
          showPnlPlaceholder: false,
        },
      ])
      .mockReturnValueOnce([
        {
          key: 'doge',
          currencyAbbreviation: 'doge',
          chain: 'doge',
          name: 'DOGE',
          cryptoAmount: '2',
          fiatAmount: '$0',
          deltaFiat: '—',
          deltaPercent: '—',
          isPositive: true,
          hasRate: false,
          hasPnl: false,
          showPnlPlaceholder: true,
        },
      ]);
    mockGetPopulateLoadingByAssetKey
      .mockReturnValueOnce({doge: false})
      .mockReturnValueOnce({doge: true});

    const view = render(<HookHarness />);

    expect(latestResult?.visibleItems).toEqual([
      expect.objectContaining({
        key: 'doge',
        fiatAmount: '$500',
        deltaFiat: '+$5',
        deltaPercent: '+2%',
        hasRate: true,
        hasPnl: true,
        showPnlPlaceholder: false,
      }),
    ]);

    mockState = {
      ...mockState,
      PORTFOLIO: {
        ...mockState.PORTFOLIO,
        populateStatus: {
          ...mockState.PORTFOLIO.populateStatus,
          txRequestsMade: 1,
        },
      },
    };
    view.rerender(<HookHarness />);

    expect(latestResult?.visibleItems).toEqual([
      expect.objectContaining({
        key: 'doge',
        fiatAmount: '$500',
        deltaFiat: '+$5',
        deltaPercent: '+2%',
        hasRate: true,
        hasPnl: true,
        showPnlPlaceholder: false,
      }),
    ]);
  });

  it('replaces portfolio-wide row pnl with asset-group scoped analysis when available', async () => {
    const globalAnalysis = {
      driverCoin: 'eth',
      assetIds: ['btc-asset', 'eth-asset'],
      wallets: [{walletId: 'btc-wallet'}],
    };
    const scopedAnalysis = {
      driverCoin: 'btc',
      assetIds: ['btc-asset'],
      wallets: [{walletId: 'btc-wallet'}],
    };
    let resolveScopedAnalysis:
      | ((value: typeof scopedAnalysis) => void)
      | undefined;

    mockUsePortfolioAnalysis.mockReturnValue({
      data: globalAnalysis,
      committedData: globalAnalysis,
      currentData: globalAnalysis,
      error: undefined,
      loading: false,
      quoteCurrency: 'USD',
      requestKey: 'portfolio-request',
      currentRatesByAssetId: {['btc-asset']: 74333.76},
      currentRatesSignature: 'btc-rate',
      eligibleWallets: [
        {
          id: 'btc-wallet',
          currencyAbbreviation: 'btc',
          chain: 'btc',
        },
      ],
      storedWallets: [
        {
          walletId: 'btc-wallet',
          addedAt: 0,
          summary: {
            walletId: 'btc-wallet',
            walletName: 'Bitcoin',
            currencyAbbreviation: 'btc',
            chain: 'btc',
            tokenAddress: undefined,
            network: 'livenet',
            balanceAtomic: '422258',
            balanceFormatted: '0.00422258',
          },
          credentials: {
            keyId: 'key-id',
          },
        },
      ],
    });
    mockRunPortfolioAnalysisQuery.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveScopedAnalysis = resolve as (value: typeof scopedAnalysis) => void;
        }),
    );
    mockBuildAssetRowsFromAnalysis.mockImplementation(({analysis}: any) => {
      if (analysis !== globalAnalysis) {
        return [
          {
            key: 'btc',
            currencyAbbreviation: 'btc',
            chain: 'btc',
            name: 'BTC',
            cryptoAmount: '0.00422258',
            fiatAmount: '$313.88',
            deltaFiat: '-$5.22',
            deltaPercent: '-1.64%',
            isPositive: false,
            hasRate: true,
            hasPnl: true,
            debugCopyPayload: {
              aggregatedSummary: {
                fiatValue: 313.88024830079996,
                pnlChange: -5.217464442377093,
                pnlPercent: -1.6350679538014496,
              },
            },
          },
        ];
      }

      return [
        {
          key: 'btc',
          currencyAbbreviation: 'btc',
          chain: 'btc',
          name: 'BTC',
          cryptoAmount: '0.00422258',
          fiatAmount: '$313.88',
          deltaFiat: '-$9.21',
          deltaPercent: '-1.80%',
          isPositive: false,
          hasRate: true,
          hasPnl: true,
          debugCopyPayload: {
            aggregatedSummary: {
              fiatValue: 313.88024830079996,
              pnlChange: -9.208673313419354,
              pnlPercent: -1.8038049153872324,
            },
          },
        },
      ];
    });

    render(<HookHarness />);

    await waitFor(() => {
      expect(mockRunPortfolioAnalysisQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          timeframe: '1D',
          quoteCurrency: 'USD',
          wallets: expect.arrayContaining([
            expect.objectContaining({
              summary: expect.objectContaining({
                currencyAbbreviation: 'btc',
              }),
            }),
          ]),
        }),
      );
    });

    await act(async () => {
      resolveScopedAnalysis?.(scopedAnalysis);
    });

    await waitFor(() => {
      expect(latestResult?.visibleItems).toEqual([
        expect.objectContaining({
          key: 'btc',
          deltaFiat: '-$5.22',
          deltaPercent: '-1.64%',
        }),
      ]);
    });
  });
});
