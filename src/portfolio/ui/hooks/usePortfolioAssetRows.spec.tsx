import React from 'react';
import {render, waitFor} from '../../../../test/render';
import {usePortfolioAssetRows} from './usePortfolioAssetRows';
import {usePortfolioAnalysis} from './usePortfolioAnalysis';
import {useIsFocused} from '@react-navigation/native';
import {useAppDispatch, useAppSelector} from '../../../utils/hooks';

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

jest.mock('../../../store/portfolio', () => ({
  maybePopulatePortfolioForWallets: jest.fn(() => ({type: 'TEST_MAYBE_POPULATE'})),
}));

jest.mock('../../../utils/portfolio/assets', () => ({
  buildWalletIdsByAssetGroupKey: jest.fn(() => ({})),
  getDisplayAssetRowItems: jest.fn(items => items),
  getPopulateLoadingByAssetKey: jest.fn(() => undefined),
  getVisibleWalletsFromKeys: jest.fn(() => []),
  sortAssetRowItemsByAssetFiatPriority: jest.fn(args => args.items),
}));

jest.mock('../selectors/buildAssetRowsFromAnalysis', () => ({
  __esModule: true,
  default: jest.fn(() => []),
}));

jest.mock('./usePortfolioAnalysis', () => ({
  usePortfolioAnalysis: jest.fn(),
}));

const mockUsePortfolioAnalysis = usePortfolioAnalysis as jest.Mock;
const mockUseIsFocused = useIsFocused as jest.Mock;
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

let latestResult: ReturnType<typeof usePortfolioAssetRows> | undefined;

const HookHarness = () => {
  latestResult = usePortfolioAssetRows({
    gainLossMode: '1D',
  });
  return null;
};

describe('usePortfolioAssetRows', () => {
  let mockState: any;
  let dispatchSpy: jest.Mock;

  beforeEach(() => {
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
  });

  it('disables runtime analysis queries while the screen is unfocused', () => {
    render(<HookHarness />);

    expect(mockUsePortfolioAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        timeframe: '1D',
        enabled: false,
        allowCurrentWhilePopulate: true,
      }),
    );
  });

  it('refreshes asset analysis as populate progress changes and after completion', async () => {
    mockUseIsFocused.mockReturnValue(true);
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

  it('does not auto-populate on refocus when committed portfolio data already exists', () => {
    mockUseIsFocused.mockReturnValue(true);
    mockState.PORTFOLIO.lastPopulatedAt = 10;
    mockUsePortfolioAnalysis.mockReturnValue({
      data: undefined,
      committedData: {
        points: [],
        assetSummaries: [],
      },
      loading: false,
      quoteCurrency: 'USD',
      storedWallets: [],
    });

    render(<HookHarness />);

    expect(dispatchSpy).not.toHaveBeenCalled();
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
});
