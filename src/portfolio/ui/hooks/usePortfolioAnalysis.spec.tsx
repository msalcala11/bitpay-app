import React from 'react';
import {render, waitFor} from '../../../../test/render';
import {
  clearPortfolioAnalysisCommittedCacheForTests,
  usePortfolioAnalysis,
} from './usePortfolioAnalysis';
import {usePortfolioRuntimeQuery} from './usePortfolioRuntimeQuery';
import {useAppSelector} from '../../../utils/hooks';

jest.mock('../../../utils/hooks', () => ({
  useAppSelector: jest.fn(),
}));

jest.mock('./usePortfolioRuntimeQuery', () => ({
  usePortfolioRuntimeQuery: jest.fn(),
}));

const mockUsePortfolioRuntimeQuery = usePortfolioRuntimeQuery as jest.Mock;
const mockUseAppSelector = useAppSelector as jest.Mock;

let latestResult: ReturnType<typeof usePortfolioAnalysis> | undefined;

const HookHarness = () => {
  latestResult = usePortfolioAnalysis({
    wallets: [],
    timeframe: '1D',
    refreshToken: 'refresh-token',
    freezeWhilePopulate: true,
    allowCurrentWhilePopulate: false,
  });

  return null;
};

describe('usePortfolioAnalysis', () => {
  let mockState: any;

  beforeEach(() => {
    clearPortfolioAnalysisCommittedCacheForTests();
    latestResult = undefined;
    mockState = {
      PORTFOLIO: {
        lastPopulatedAt: undefined,
        populateStatus: {
          inProgress: false,
        },
      },
    };
    mockUseAppSelector.mockReset();
    mockUseAppSelector.mockImplementation(selector => selector(mockState));
    mockUsePortfolioRuntimeQuery.mockReset();
  });

  it('reuses the last committed analysis while populate is in progress', async () => {
    const completedAnalysis = {
      points: [],
      assetSummaries: [],
    } as any;
    const inProgressAnalysis = {
      points: [{ts: 1}],
      assetSummaries: [{assetId: 'btc'}],
    } as any;

    mockState = {
      PORTFOLIO: {
        lastPopulatedAt: 1,
        populateStatus: {
          inProgress: false,
        },
      },
    };
    mockUseAppSelector.mockImplementation(selector => selector(mockState));
    mockUsePortfolioRuntimeQuery.mockReturnValue({
      data: completedAnalysis,
      loading: false,
      error: undefined,
      quoteCurrency: 'USD',
      storedWallets: [],
      eligibleWallets: [],
      requestKey: 'req-1',
    });

    const first = render(<HookHarness />);

    await waitFor(() => {
      expect(latestResult?.committedData).toBe(completedAnalysis);
    });

    expect(mockUsePortfolioRuntimeQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({
        refreshToken: 'refresh-token',
        clearDataOnRefreshToken: true,
      }),
    );

    first.unmount();

    mockState = {
      PORTFOLIO: {
        lastPopulatedAt: 1,
        populateStatus: {
          inProgress: true,
        },
      },
    };
    mockUseAppSelector.mockImplementation(selector => selector(mockState));
    mockUsePortfolioRuntimeQuery.mockReturnValue({
      data: inProgressAnalysis,
      loading: false,
      error: undefined,
      quoteCurrency: 'USD',
      storedWallets: [],
      eligibleWallets: [],
      requestKey: 'req-1',
    });

    render(<HookHarness />);

    expect(latestResult?.currentData).toBe(inProgressAnalysis);
    expect(latestResult?.committedData).toBe(completedAnalysis);
    expect(latestResult?.data).toBe(completedAnalysis);
  });

  it('drops committed analysis after portfolio data has been cleared', async () => {
    const completedAnalysis = {
      points: [],
      assetSummaries: [],
    } as any;
    const inProgressAnalysis = {
      points: [{ts: 1}],
      assetSummaries: [{assetId: 'btc'}],
    } as any;

    mockState = {
      PORTFOLIO: {
        lastPopulatedAt: 1,
        populateStatus: {
          inProgress: false,
        },
      },
    };
    mockUseAppSelector.mockImplementation(selector => selector(mockState));
    mockUsePortfolioRuntimeQuery.mockReturnValue({
      data: completedAnalysis,
      loading: false,
      error: undefined,
      quoteCurrency: 'USD',
      storedWallets: [],
      eligibleWallets: [],
      requestKey: 'req-1',
    });

    const first = render(<HookHarness />);

    await waitFor(() => {
      expect(latestResult?.committedData).toBe(completedAnalysis);
    });

    first.unmount();

    mockState = {
      PORTFOLIO: {
        lastPopulatedAt: undefined,
        populateStatus: {
          inProgress: true,
        },
      },
    };
    mockUseAppSelector.mockImplementation(selector => selector(mockState));
    mockUsePortfolioRuntimeQuery.mockReturnValue({
      data: inProgressAnalysis,
      loading: false,
      error: undefined,
      quoteCurrency: 'USD',
      storedWallets: [],
      eligibleWallets: [],
      requestKey: 'req-1',
    });

    render(<HookHarness />);

    await waitFor(() => {
      expect(latestResult?.committedData).toBeUndefined();
      expect(latestResult?.data).toBeUndefined();
    });
    expect(latestResult?.currentData).toBe(inProgressAnalysis);
  });
});
