import React from 'react';
import {render} from '../../../../test/render';
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

const HookHarness = () => {
  usePortfolioAssetRows({
    gainLossMode: '1D',
  });
  return null;
};

describe('usePortfolioAssetRows', () => {
  beforeEach(() => {
    mockUseIsFocused.mockReset();
    mockUseIsFocused.mockReturnValue(false);
    mockUseAppDispatch.mockReset();
    mockUseAppDispatch.mockReturnValue(jest.fn());
    mockUseAppSelector.mockReset();
    mockUseAppSelector.mockImplementation(selector =>
      selector({
        PORTFOLIO: {
          populateStatus: {
            inProgress: false,
          },
        },
        APP: {
          homeCarouselConfig: undefined,
        },
        WALLET: {
          keys: {},
        },
      }),
    );
    mockUsePortfolioAnalysis.mockReset();
    mockUsePortfolioAnalysis.mockReturnValue({
      data: undefined,
      committedData: undefined,
      loading: false,
      quoteCurrency: 'USD',
      storedWallets: [],
    });
  });

  it('disables runtime analysis queries while the screen is unfocused', () => {
    render(<HookHarness />);

    expect(mockUsePortfolioAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        timeframe: '1D',
        enabled: false,
      }),
    );
  });
});
