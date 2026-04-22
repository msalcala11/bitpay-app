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
  disposePortfolioAnalysisSessionQuery: jest.fn(),
  getCurrentRatesByAssetIdSignature: jest.fn(() => ''),
  getStoredWalletRequestSignature: jest.fn(() => ''),
  preparePortfolioAnalysisSessionQuery: jest.fn(),
  runPortfolioAnalysisQuery: jest.fn(),
  runPortfolioAnalysisSessionScopeQuery: jest.fn(),
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
const mockPreparePortfolioAnalysisSessionQuery = jest.requireMock(
  '../common',
).preparePortfolioAnalysisSessionQuery as jest.Mock;
const mockRunPortfolioAnalysisQuery = jest.requireMock(
  '../common',
).runPortfolioAnalysisQuery as jest.Mock;
const mockRunPortfolioAnalysisSessionScopeQuery = jest.requireMock(
  '../common',
).runPortfolioAnalysisSessionScopeQuery as jest.Mock;
const mockDisposePortfolioAnalysisSessionQuery = jest.requireMock(
  '../common',
).disposePortfolioAnalysisSessionQuery as jest.Mock;

let latestResult: ReturnType<typeof usePortfolioAssetRows> | undefined;

const HookHarness = ({
  externalRefreshToken,
  gainLossMode = '1D',
  enabled,
}: {
  externalRefreshToken?: string | number;
  gainLossMode?: '1D' | 'ALL';
  enabled?: boolean;
}) => {
  latestResult = usePortfolioAssetRows({
    gainLossMode,
    externalRefreshToken,
    enabled,
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
    mockPreparePortfolioAnalysisSessionQuery.mockReset();
    mockPreparePortfolioAnalysisSessionQuery.mockResolvedValue({
      sessionId: 'session-1',
    });
    mockRunPortfolioAnalysisQuery.mockReset();
    mockRunPortfolioAnalysisQuery.mockResolvedValue(undefined);
    mockRunPortfolioAnalysisSessionScopeQuery.mockReset();
    mockRunPortfolioAnalysisSessionScopeQuery.mockResolvedValue(undefined);
    mockDisposePortfolioAnalysisSessionQuery.mockReset();
    mockDisposePortfolioAnalysisSessionQuery.mockResolvedValue(undefined);
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

  it('disables portfolio and scoped asset pnl queries until the section is enabled', async () => {
    mockGetVisibleWalletsFromKeys.mockReturnValue([
      {
        id: 'btc-wallet',
        currencyAbbreviation: 'btc',
        chain: 'btc',
        network: 'livenet',
      },
    ]);
    mockUsePortfolioAnalysis.mockReturnValue({
      data: undefined,
      committedData: undefined,
      currentData: undefined,
      error: undefined,
      loading: false,
      quoteCurrency: 'USD',
      storedWallets: [
        {
          summary: {
            walletId: 'btc-wallet',
            currencyAbbreviation: 'btc',
            chain: 'btc',
            network: 'livenet',
          },
        },
      ],
      eligibleWallets: [
        {
          id: 'btc-wallet',
          currencyAbbreviation: 'btc',
          chain: 'btc',
          network: 'livenet',
        },
      ],
      currentRatesByAssetId: {},
      currentRatesSignature: '',
      asOfMs: 100,
      requestKey: 'disabled-request',
    });

    render(<HookHarness enabled={false} />);

    expect(mockUsePortfolioAnalysis).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enabled: false,
      }),
    );

    await waitFor(() => {
      expect(mockPreparePortfolioAnalysisSessionQuery).not.toHaveBeenCalled();
      expect(mockRunPortfolioAnalysisQuery).not.toHaveBeenCalled();
      expect(mockRunPortfolioAnalysisSessionScopeQuery).not.toHaveBeenCalled();
    });

    expect(latestResult?.visibleItems).toEqual([]);
    expect(latestResult?.hasAnyPortfolioData).toBe(false);
  });

  it('uses an external refresh token to rerun rolling asset analysis without clearing committed data', () => {
    mockState.PORTFOLIO.lastPopulatedAt = 10;
    mockState.PORTFOLIO.populateStatus.finishedAt = 10;
    mockState.PORTFOLIO.populateStatus.stopReason = 'completed';

    const view = render(<HookHarness externalRefreshToken={0} />);

    expect(mockUsePortfolioAnalysis).toHaveBeenLastCalledWith(
      expect.objectContaining({
        refreshToken: '10|10|completed|0|0',
        clearDataToken: '10|10|completed|0',
        allowCurrentWhilePopulate: true,
      }),
    );

    view.rerender(<HookHarness externalRefreshToken={1} />);

    expect(mockUsePortfolioAnalysis).toHaveBeenLastCalledWith(
      expect.objectContaining({
        refreshToken: '10|10|completed|0|1',
        clearDataToken: '10|10|completed|0',
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

  it('keeps canonical analysis order stable during populate', () => {
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

    render(<HookHarness />);

    expect(mockSortAssetRowItemsByAssetFiatPriority).not.toHaveBeenCalled();
    expect(latestResult?.visibleItems.map(item => item.key)).toEqual(['btc', 'doge']);
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

  it('keeps the last non-empty asset rows visible across the post-populate hydration gap', () => {
    const row = {
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
    };
    let analysisResult: any = {
      data: {wallets: [{walletId: 'doge-wallet'}]},
      committedData: undefined,
      currentData: {wallets: [{walletId: 'doge-wallet'}]},
      error: undefined,
      loading: false,
      quoteCurrency: 'USD',
      requestKey: 'populate-request',
      currentRatesByAssetId: {},
      currentRatesSignature: '',
      eligibleWallets: [],
      storedWallets: [],
    };

    mockState.PORTFOLIO.populateStatus.inProgress = true;
    mockState.PORTFOLIO.populateStatus.startedAt = 11;
    mockUsePortfolioAnalysis.mockImplementation(() => analysisResult);
    mockBuildAssetRowsFromAnalysis.mockImplementation(({analysis}: any) =>
      analysis ? [row] : [],
    );

    const view = render(<HookHarness />);

    expect(latestResult?.visibleItems).toEqual([expect.objectContaining(row)]);

    analysisResult = {
      data: undefined,
      committedData: undefined,
      currentData: undefined,
      error: undefined,
      loading: true,
      quoteCurrency: 'USD',
      requestKey: 'post-populate-request',
      currentRatesByAssetId: {},
      currentRatesSignature: '',
      eligibleWallets: [],
      storedWallets: [],
    };
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

    expect(latestResult?.visibleItems).toEqual([expect.objectContaining(row)]);
    expect(latestResult?.hasAnyPortfolioData).toBe(true);

    analysisResult = {
      ...analysisResult,
      loading: false,
    };
    view.rerender(<HookHarness />);

    expect(latestResult?.visibleItems).toEqual([]);
  });

  it('keeps the previous visible order while the same asset keys are still loading', () => {
    const firstOrder = [
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
    ];
    const secondOrder = [firstOrder[1], firstOrder[0]];
    let analysisResult: any = {
      data: {wallets: [{walletId: 'doge-wallet'}, {walletId: 'btc-wallet'}]},
      committedData: undefined,
      currentData: {wallets: [{walletId: 'doge-wallet'}, {walletId: 'btc-wallet'}]},
      error: undefined,
      loading: false,
      quoteCurrency: 'USD',
      requestKey: 'steady-request',
      currentRatesByAssetId: {},
      currentRatesSignature: '',
      eligibleWallets: [],
      storedWallets: [],
    };

    mockUsePortfolioAnalysis.mockImplementation(() => analysisResult);
    mockBuildAssetRowsFromAnalysis
      .mockReturnValueOnce(firstOrder)
      .mockReturnValueOnce(secondOrder)
      .mockReturnValue(secondOrder);

    const view = render(<HookHarness />);

    expect(latestResult?.visibleItems.map(item => item.key)).toEqual([
      'doge',
      'btc',
    ]);

    analysisResult = {
      ...analysisResult,
      loading: true,
      requestKey: 'loading-request',
    };
    view.rerender(<HookHarness />);

    expect(latestResult?.visibleItems.map(item => item.key)).toEqual([
      'doge',
      'btc',
    ]);

    analysisResult = {
      ...analysisResult,
      loading: false,
      requestKey: 'settled-request',
    };
    view.rerender(<HookHarness />);

    expect(latestResult?.visibleItems.map(item => item.key)).toEqual([
      'btc',
      'doge',
    ]);
  });

  it('reveals a completed asset with portfolio-wide values, then upgrades it when scoped analysis arrives during populate', async () => {
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

    mockState.PORTFOLIO.populateStatus.inProgress = true;
    mockState.PORTFOLIO.populateStatus.startedAt = 11;
    mockState.PORTFOLIO.lastPopulatedAt = 10;
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
      asOfMs: 123456789,
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
    mockGetVisibleWalletsFromKeys.mockReturnValue([
      {
        id: 'btc-wallet',
        currencyAbbreviation: 'btc',
        chain: 'btc',
        network: 'livenet',
      },
    ]);
    mockGetPopulateLoadingByAssetKey.mockReturnValue({btc: false});
    mockPreparePortfolioAnalysisSessionQuery.mockResolvedValue({
      sessionId: 'session-btc',
    });
    mockRunPortfolioAnalysisSessionScopeQuery.mockImplementation(
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
            showPnlPlaceholder: false,
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
          showPnlPlaceholder: false,
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

    render(<HookHarness gainLossMode="ALL" />);

    await waitFor(() => {
      expect(latestResult?.visibleItems).toEqual([
        expect.objectContaining({
          key: 'btc',
          deltaFiat: '-$9.21',
          deltaPercent: '-1.80%',
          showScopedPnlLoading: true,
        }),
      ]);
      expect(latestResult?.isPopulateLoadingByKey).toEqual({btc: false});
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
          showScopedPnlLoading: false,
        }),
      ]);
    });
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
    mockPreparePortfolioAnalysisSessionQuery.mockResolvedValue({
      sessionId: 'session-btc',
    });
    mockRunPortfolioAnalysisSessionScopeQuery.mockImplementation(
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
      expect(mockPreparePortfolioAnalysisSessionQuery).toHaveBeenCalledWith(
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
      expect(mockRunPortfolioAnalysisSessionScopeQuery).toHaveBeenCalledWith({
        sessionId: 'session-btc',
        walletIds: ['btc-wallet'],
      });
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

  it('keeps a resolved scoped row visible during same-scope live refreshes until the next result arrives', async () => {
    const globalAnalysis = {
      driverCoin: 'eth',
      assetIds: ['btc-asset', 'eth-asset'],
      wallets: [{walletId: 'btc-wallet'}],
    };
    const firstScopedAnalysis = {
      driverCoin: 'btc',
      assetIds: ['btc-asset'],
      wallets: [{walletId: 'btc-wallet'}],
    };
    let analysisResult: any = {
      data: globalAnalysis,
      committedData: undefined,
      currentData: globalAnalysis,
      error: undefined,
      loading: false,
      quoteCurrency: 'USD',
      requestKey: 'portfolio-request-1',
      currentRatesByAssetId: {['btc-asset']: 74333.76},
      currentRatesSignature: 'btc-rate-1',
      asOfMs: 123456789,
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
    };
    const prepareResolvers: Array<(value: {sessionId: string}) => void> = [];
    const scopedResolvers: Array<(value: typeof firstScopedAnalysis) => void> = [];

    mockUsePortfolioAnalysis.mockImplementation(() => analysisResult);
    mockPreparePortfolioAnalysisSessionQuery.mockImplementation(
      () =>
        new Promise(resolve => {
          prepareResolvers.push(resolve as (value: {sessionId: string}) => void);
        }),
    );
    mockRunPortfolioAnalysisSessionScopeQuery.mockImplementation(
      () =>
        new Promise(resolve => {
          scopedResolvers.push(resolve as (value: typeof firstScopedAnalysis) => void);
        }),
    );
    mockBuildAssetRowsFromAnalysis.mockImplementation(({analysis}: any) => {
      if (analysis === firstScopedAnalysis) {
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
            showPnlPlaceholder: false,
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
          showPnlPlaceholder: false,
        },
      ];
    });

    const view = render(<HookHarness />);

    await act(async () => {
      prepareResolvers.shift()?.({sessionId: 'session-btc-1'});
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mockRunPortfolioAnalysisSessionScopeQuery).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      scopedResolvers.shift()?.(firstScopedAnalysis);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(latestResult?.visibleItems).toEqual([
        expect.objectContaining({
          key: 'btc',
          deltaFiat: '-$5.22',
          deltaPercent: '-1.64%',
          showScopedPnlLoading: false,
        }),
      ]);
    });

    analysisResult = {
      ...analysisResult,
      requestKey: 'portfolio-request-2',
      currentRatesSignature: 'btc-rate-2',
      asOfMs: 123456790,
    };
    view.rerender(<HookHarness />);

    await act(async () => {
      prepareResolvers.shift()?.({sessionId: 'session-btc-2'});
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mockRunPortfolioAnalysisSessionScopeQuery).toHaveBeenCalledTimes(2);
    });

    expect(latestResult?.visibleItems).toEqual([
      expect.objectContaining({
        key: 'btc',
        deltaFiat: '-$5.22',
        deltaPercent: '-1.64%',
        showScopedPnlLoading: false,
      }),
    ]);
  });

  it('shows a row-level loading state during ALL scoped-analysis transitions', async () => {
    const globalAnalysis = {
      driverCoin: 'eth',
      assetIds: ['btc-asset', 'eth-asset'],
      wallets: [{walletId: 'btc-wallet'}],
    };
    let resolveScopedAnalysis: ((value: typeof globalAnalysis) => void) | undefined;

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
    mockPreparePortfolioAnalysisSessionQuery.mockResolvedValue({
      sessionId: 'session-btc',
    });
    mockRunPortfolioAnalysisSessionScopeQuery.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveScopedAnalysis = resolve as (value: typeof globalAnalysis) => void;
        }),
    );
    mockBuildAssetRowsFromAnalysis.mockReturnValue([
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
    ]);

    render(<HookHarness gainLossMode="ALL" />);

    await waitFor(() => {
      expect(latestResult?.visibleItems).toEqual([
        expect.objectContaining({
          key: 'btc',
          showScopedPnlLoading: true,
        }),
      ]);
    });

    await act(async () => {
      resolveScopedAnalysis?.(globalAnalysis);
    });

    await waitFor(() => {
      expect(latestResult?.visibleItems).toEqual([
        expect.objectContaining({
          key: 'btc',
          showScopedPnlLoading: false,
        }),
      ]);
    });
  });

  it('treats the first scoped 1D bootstrap render as loading instead of placeholder-only', () => {
    const globalAnalysis = {
      driverCoin: 'btc',
      assetIds: ['btc-asset'],
      wallets: [{walletId: 'btc-wallet'}],
    };

    mockUsePortfolioAnalysis.mockReturnValue({
      data: globalAnalysis,
      committedData: globalAnalysis,
      currentData: globalAnalysis,
      error: undefined,
      loading: false,
      quoteCurrency: 'USD',
      requestKey: 'portfolio-1d',
      currentRatesByAssetId: {['btc-asset']: 74333.76},
      currentRatesSignature: 'btc-rate',
      asOfMs: 123456789,
      eligibleWallets: [
        {
          id: 'btc-wallet',
          currencyAbbreviation: 'btc',
          chain: 'btc',
        },
      ],
      storedWallets: [
        {
          summary: {
            walletId: 'btc-wallet',
            currencyAbbreviation: 'btc',
            chain: 'btc',
            network: 'livenet',
          },
          credentials: {
            keyId: 'key-id',
          },
        },
      ],
    });
    mockBuildAssetRowsFromAnalysis.mockImplementation(({analysis}: any) => {
      if (analysis === globalAnalysis) {
        return [
          {
            key: 'btc',
            currencyAbbreviation: 'btc',
            chain: 'btc',
            name: 'BTC',
            cryptoAmount: '0.00422258',
            fiatAmount: '$313.88',
            deltaFiat: '—',
            deltaPercent: '—',
            isPositive: false,
            hasRate: true,
            hasPnl: false,
            showPnlPlaceholder: true,
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
          deltaFiat: '-$5.22',
          deltaPercent: '-1.64%',
          isPositive: false,
          hasRate: true,
          hasPnl: true,
          showPnlPlaceholder: false,
        },
      ];
    });

    render(<HookHarness gainLossMode="1D" />);

    expect(latestResult?.visibleItems).toEqual([
      expect.objectContaining({
        key: 'btc',
        showPnlPlaceholder: true,
        showScopedPnlLoading: true,
      }),
    ]);
  });

  it('shows a row-level loading state when switching from ALL back to 1D until the new scoped analysis arrives', async () => {
    let resolveAllScopedAnalysis:
      | ((value: {
          driverCoin: string;
          assetIds: string[];
          wallets: {walletId: string}[];
        }) => void)
      | undefined;
    let resolveDayScopedAnalysis:
      | ((value: {
          driverCoin: string;
          assetIds: string[];
          wallets: {walletId: string}[];
        }) => void)
      | undefined;
    const allScopedAnalysis = {
      driverCoin: 'btc',
      assetIds: ['btc-asset'],
      wallets: [{walletId: 'btc-wallet'}],
    };
    const dayScopedAnalysis = {
      driverCoin: 'btc',
      assetIds: ['btc-asset'],
      wallets: [{walletId: 'btc-wallet'}],
    };
    const analysisByTimeframe = {
      ALL: {
        data: allScopedAnalysis,
        committedData: allScopedAnalysis,
        currentData: allScopedAnalysis,
        error: undefined,
        loading: false,
        quoteCurrency: 'USD',
        requestKey: 'portfolio-all',
        currentRatesByAssetId: {['btc-asset']: 74333.76},
        currentRatesSignature: 'btc-rate',
        asOfMs: 123456789,
        eligibleWallets: [
          {
            id: 'btc-wallet',
            currencyAbbreviation: 'btc',
            chain: 'btc',
          },
        ],
        storedWallets: [
          {
            summary: {
              walletId: 'btc-wallet',
              currencyAbbreviation: 'btc',
              chain: 'btc',
              network: 'livenet',
            },
            credentials: {
              keyId: 'key-id',
            },
          },
        ],
      },
      '1D': {
        data: dayScopedAnalysis,
        committedData: dayScopedAnalysis,
        currentData: dayScopedAnalysis,
        error: undefined,
        loading: false,
        quoteCurrency: 'USD',
        requestKey: 'portfolio-1d',
        currentRatesByAssetId: {['btc-asset']: 74333.76},
        currentRatesSignature: 'btc-rate',
        asOfMs: 123456789,
        eligibleWallets: [
          {
            id: 'btc-wallet',
            currencyAbbreviation: 'btc',
            chain: 'btc',
          },
        ],
        storedWallets: [
          {
            summary: {
              walletId: 'btc-wallet',
              currencyAbbreviation: 'btc',
              chain: 'btc',
              network: 'livenet',
            },
            credentials: {
              keyId: 'key-id',
            },
          },
        ],
      },
    } as const;

    mockState.PORTFOLIO.lastPopulatedAt = 5;
    mockUsePortfolioAnalysis.mockImplementation(({timeframe}) => {
      return analysisByTimeframe[timeframe as 'ALL' | '1D'];
    });
    mockPreparePortfolioAnalysisSessionQuery.mockResolvedValue({
      sessionId: 'session-btc',
    });
    let scopeRequestCount = 0;
    mockRunPortfolioAnalysisSessionScopeQuery.mockImplementation(() => {
      scopeRequestCount += 1;
      return new Promise(resolve => {
        if (scopeRequestCount === 1) {
          resolveAllScopedAnalysis = resolve as typeof resolveAllScopedAnalysis;
          return;
        }

        resolveDayScopedAnalysis = resolve as typeof resolveDayScopedAnalysis;
      });
    });
    mockBuildAssetRowsFromAnalysis.mockReturnValue([
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
    ]);

    const view = render(<HookHarness gainLossMode="ALL" />);

    await waitFor(() => {
      expect(latestResult?.visibleItems).toEqual([
        expect.objectContaining({
          key: 'btc',
          showScopedPnlLoading: true,
        }),
      ]);
    });

    await act(async () => {
      resolveAllScopedAnalysis?.(allScopedAnalysis);
    });

    await waitFor(() => {
      expect(latestResult?.visibleItems).toEqual([
        expect.objectContaining({
          key: 'btc',
          showScopedPnlLoading: false,
        }),
      ]);
    });

    view.rerender(<HookHarness gainLossMode="1D" />);

    await waitFor(() => {
      expect(latestResult?.visibleItems).toEqual([
        expect.objectContaining({
          key: 'btc',
          showScopedPnlLoading: true,
        }),
      ]);
    });
    await waitFor(() => {
      expect(scopeRequestCount).toBe(2);
    });

    await act(async () => {
      resolveDayScopedAnalysis?.(dayScopedAnalysis);
    });

    await waitFor(() => {
      expect(latestResult?.visibleItems).toEqual([
        expect.objectContaining({
          key: 'btc',
          showScopedPnlLoading: false,
        }),
      ]);
    });
  });

  it('falls back to a direct scoped query when a prepared session goes missing', async () => {
    const globalAnalysis = {
      driverCoin: 'eth',
      assetIds: ['btc-asset'],
      wallets: [{walletId: 'btc-wallet'}, {walletId: 'eth-wallet'}],
    };
    const scopedAnalysis = {
      driverCoin: 'btc',
      assetIds: ['btc-asset'],
      wallets: [{walletId: 'btc-wallet'}],
    };

    mockState.PORTFOLIO.lastPopulatedAt = 5;
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
      asOfMs: 123456789,
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
    mockPreparePortfolioAnalysisSessionQuery.mockResolvedValue({
      sessionId: 'session-btc',
    });
    mockRunPortfolioAnalysisSessionScopeQuery.mockRejectedValue(
      new Error('Prepared portfolio analysis session not found: session-btc'),
    );
    mockRunPortfolioAnalysisQuery.mockResolvedValue(scopedAnalysis);
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
      expect(mockRunPortfolioAnalysisQuery).toHaveBeenCalledWith({
        wallets: [
          expect.objectContaining({
            summary: expect.objectContaining({
              walletId: 'btc-wallet',
            }),
          }),
        ],
        quoteCurrency: 'USD',
        timeframe: '1D',
        maxPoints: 2,
        currentRatesByAssetId: expect.any(Object),
        asOfMs: 123456789,
      });
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

  it('reveals resolved asset-group rows before slower asset-group queries finish', async () => {
    const globalAnalysis = {
      driverCoin: 'eth',
      assetIds: ['btc-asset', 'doge-asset'],
      wallets: [{walletId: 'btc-wallet'}, {walletId: 'doge-wallet'}],
    };
    const btcScopedAnalysis = {
      driverCoin: 'btc',
      assetIds: ['btc-asset'],
      wallets: [{walletId: 'btc-wallet'}],
    };
    const dogeScopedAnalysis = {
      driverCoin: 'doge',
      assetIds: ['doge-asset'],
      wallets: [{walletId: 'doge-wallet'}],
    };
    let resolveBtcScopedAnalysis:
      | ((value: typeof btcScopedAnalysis) => void)
      | undefined;
    let resolveDogeScopedAnalysis:
      | ((value: typeof dogeScopedAnalysis) => void)
      | undefined;

    mockState.PORTFOLIO.lastPopulatedAt = 10;
    mockState.PORTFOLIO.populateStatus.inProgress = true;
    mockState.PORTFOLIO.populateStatus.startedAt = 11;

    mockUsePortfolioAnalysis.mockReturnValue({
      data: globalAnalysis,
      committedData: globalAnalysis,
      currentData: globalAnalysis,
      error: undefined,
      loading: false,
      quoteCurrency: 'USD',
      requestKey: 'portfolio-request',
      currentRatesByAssetId: {
        ['btc-asset']: 75000,
        ['doge-asset']: 0.12,
      },
      currentRatesSignature: 'btc-doge-rates',
      eligibleWallets: [
        {
          id: 'btc-wallet',
          currencyAbbreviation: 'btc',
          chain: 'btc',
        },
        {
          id: 'doge-wallet',
          currencyAbbreviation: 'doge',
          chain: 'doge',
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
        {
          walletId: 'doge-wallet',
          addedAt: 0,
          summary: {
            walletId: 'doge-wallet',
            walletName: 'Dogecoin',
            currencyAbbreviation: 'doge',
            chain: 'doge',
            tokenAddress: undefined,
            network: 'livenet',
            balanceAtomic: '100000000',
            balanceFormatted: '1',
          },
          credentials: {
            keyId: 'key-id',
          },
        },
      ],
    });

    mockPreparePortfolioAnalysisSessionQuery.mockResolvedValue({
      sessionId: 'session-multi',
    });
    mockRunPortfolioAnalysisSessionScopeQuery.mockImplementation(
      ({walletIds}: any) => {
        const walletId = walletIds?.[0];

        return new Promise(resolve => {
          if (walletId === 'btc-wallet') {
            resolveBtcScopedAnalysis =
              resolve as (value: typeof btcScopedAnalysis) => void;
            return;
          }

          resolveDogeScopedAnalysis =
            resolve as (value: typeof dogeScopedAnalysis) => void;
        });
      },
    );

    mockBuildAssetRowsFromAnalysis.mockImplementation(({analysis}: any) => {
      if (analysis === btcScopedAnalysis) {
        return [
          {
            key: 'btc',
            currencyAbbreviation: 'btc',
            chain: 'btc',
            name: 'BTC',
            cryptoAmount: '0.00422258',
            fiatAmount: '$316.86',
            deltaFiat: '-$3.84',
            deltaPercent: '-1.20%',
            isPositive: false,
            hasRate: true,
            hasPnl: true,
            showPnlPlaceholder: false,
          },
        ];
      }

      if (analysis === dogeScopedAnalysis) {
        return [
          {
            key: 'doge',
            currencyAbbreviation: 'doge',
            chain: 'doge',
            name: 'DOGE',
            cryptoAmount: '1',
            fiatAmount: '$0.12',
            deltaFiat: '+$0.01',
            deltaPercent: '+9.09%',
            isPositive: true,
            hasRate: true,
            hasPnl: true,
            showPnlPlaceholder: false,
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
          fiatAmount: '$316.86',
          deltaFiat: '—',
          deltaPercent: '—',
          isPositive: false,
          hasRate: true,
          hasPnl: false,
          showPnlPlaceholder: true,
        },
        {
          key: 'doge',
          currencyAbbreviation: 'doge',
          chain: 'doge',
          name: 'DOGE',
          cryptoAmount: '1',
          fiatAmount: '$0.12',
          deltaFiat: '—',
          deltaPercent: '—',
          isPositive: true,
          hasRate: true,
          hasPnl: false,
          showPnlPlaceholder: true,
        },
      ];
    });

    mockGetPopulateLoadingByAssetKey.mockReturnValue({
      btc: false,
      doge: true,
    });

    render(<HookHarness />);

    await waitFor(() => {
      expect(mockPreparePortfolioAnalysisSessionQuery).toHaveBeenCalledTimes(1);
      expect(mockRunPortfolioAnalysisSessionScopeQuery).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      resolveBtcScopedAnalysis?.(btcScopedAnalysis);
    });

    await waitFor(() => {
      expect(latestResult?.visibleItems).toEqual([
        expect.objectContaining({
          key: 'btc',
          deltaFiat: '-$3.84',
          deltaPercent: '-1.20%',
          showPnlPlaceholder: false,
        }),
        expect.objectContaining({
          key: 'doge',
          deltaFiat: '—',
          deltaPercent: '—',
          showPnlPlaceholder: true,
        }),
      ]);
    });

    expect(latestResult?.isPopulateLoadingByKey).toEqual({
      btc: false,
      doge: true,
    });

    await act(async () => {
      resolveDogeScopedAnalysis?.(dogeScopedAnalysis);
    });

    await waitFor(() => {
      expect(latestResult?.visibleItems).toEqual([
        expect.objectContaining({
          key: 'btc',
          deltaFiat: '-$3.84',
          deltaPercent: '-1.20%',
          showPnlPlaceholder: false,
        }),
        expect.objectContaining({
          key: 'doge',
          deltaFiat: '+$0.01',
          deltaPercent: '+9.09%',
          showPnlPlaceholder: false,
        }),
      ]);
    });
  });
});
