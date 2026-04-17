import React from 'react';
import {render} from '../../../../test/render';
import {usePortfolioGainLossSummary} from './usePortfolioGainLossSummary';
import {usePortfolioChart} from './usePortfolioChart';
import {useIsFocused} from '@react-navigation/native';

jest.mock('@react-navigation/native', () => {
  const actualNav = jest.requireActual('@react-navigation/native');
  return {
    ...actualNav,
    useIsFocused: jest.fn(),
  };
});

jest.mock('./usePortfolioChart', () => ({
  usePortfolioChart: jest.fn(),
}));

const mockUsePortfolioChart = usePortfolioChart as jest.Mock;
const mockUseIsFocused = useIsFocused as jest.Mock;

const HookHarness = () => {
  usePortfolioGainLossSummary({
    wallets: [],
    liveFiatTotal: 0,
  });
  return null;
};

describe('usePortfolioGainLossSummary', () => {
  beforeEach(() => {
    mockUsePortfolioChart.mockReset();
    mockUsePortfolioChart.mockReturnValue({
      data: undefined,
      quoteCurrency: 'USD',
      loading: false,
      error: undefined,
    });
    mockUseIsFocused.mockReset();
  });

  it('disables runtime chart queries while the screen is unfocused', () => {
    mockUseIsFocused.mockReturnValue(false);

    render(<HookHarness />);

    expect(mockUsePortfolioChart).toHaveBeenCalledTimes(2);
    expect(mockUsePortfolioChart).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        timeframe: '1D',
        enabled: false,
      }),
    );
    expect(mockUsePortfolioChart).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        timeframe: 'ALL',
        enabled: false,
      }),
    );
  });
});
