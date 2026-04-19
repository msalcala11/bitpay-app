import React from 'react';
import {fireEvent, render} from '../../../../../test/render';
import {useNavigation} from '@react-navigation/native';
import {useAppSelector} from '../../../../utils/hooks';
import usePortfolioAssetRows from '../hooks/usePortfolioAssetRows';
import AssetsSection from './AssetsSection';

jest.mock('@react-navigation/native', () => ({
  useNavigation: jest.fn(),
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

jest.mock('../../../../utils/hooks', () => ({
  useAppSelector: jest.fn(),
}));

jest.mock('../hooks/usePortfolioAssetRows', () => ({
  __esModule: true,
  default: jest.fn(),
}));


jest.mock('../../../../components/button/Button', () => {
  const React = require('react');
  const {Text, TouchableOpacity} = require('react-native');
  return ({children, onPress}: {children: React.ReactNode; onPress?: () => void}) => {
    return (
      <TouchableOpacity onPress={onPress}>
        <Text>{children}</Text>
      </TouchableOpacity>
    );
  };
});

jest.mock('./AssetsList', () => {
  const React = require('react');
  const {Text} = require('react-native');
  return ({
    items,
    showSkeletonRows,
  }: {
    items: Array<{key: string}>;
    showSkeletonRows?: boolean;
  }) => {
    return (
      <>
        <Text testID="assets-list-count">{String(items.length)}</Text>
        {showSkeletonRows ? (
          <Text testID="assets-list-skeleton-state">skeletons</Text>
        ) : null}
      </>
    );
  };
});

jest.mock('./AssetsGainLossDropdown', () => {
  const React = require('react');
  return () => null;
});

describe('AssetsSection', () => {
  const mockUseNavigation = useNavigation as jest.Mock;
  const mockUseAppSelector = useAppSelector as jest.Mock;
  const mockUsePortfolioAssetRows = usePortfolioAssetRows as jest.Mock;

  beforeEach(() => {
    mockUseNavigation.mockReset();
    mockUseAppSelector.mockReset();
    mockUsePortfolioAssetRows.mockReset();

    mockUseNavigation.mockReturnValue({navigate: jest.fn()});
    mockUseAppSelector.mockImplementation(selector =>
      selector({
        PORTFOLIO: {
          populateStatus: {inProgress: false},
        },
      }),
    );
    mockUsePortfolioAssetRows.mockReturnValue({
      visibleItems: [
        {key: 'a'},
        {key: 'b'},
        {key: 'c'},
        {key: 'd'},
      ],
      isFiatLoading: false,
      isPnlLoading: false,
      isPopulateLoadingByKey: undefined,
      hasAnyPortfolioData: true,
    });
  });

  it('requests the shared asset-row hook with a home limit of four rows', () => {
    const {getByTestId} = render(<AssetsSection />);

    expect(mockUsePortfolioAssetRows).toHaveBeenCalledWith({
      gainLossMode: '1D',
      maxVisibleItems: 4,
    });
    expect(getByTestId('assets-list-count').props.children).toBe('4');
  });



  it('shows skeleton rows instead of returning null while populate is active and rows are not ready', () => {
    mockUseAppSelector.mockImplementation(selector =>
      selector({
        PORTFOLIO: {
          populateStatus: {inProgress: true},
        },
      }),
    );
    mockUsePortfolioAssetRows.mockReturnValue({
      visibleItems: [],
      isFiatLoading: false,
      isPnlLoading: false,
      isPopulateLoadingByKey: undefined,
      hasAnyPortfolioData: true,
    });

    const {getByTestId, getByText} = render(<AssetsSection />);

    expect(getByText('Assets')).toBeTruthy();
    expect(getByTestId('assets-list-count').props.children).toBe('0');
    expect(getByTestId('assets-list-skeleton-state')).toBeTruthy();
  });

  it('shows skeleton rows instead of placeholders while the asset-row RPC is loading with no committed rows', () => {
    mockUsePortfolioAssetRows.mockReturnValue({
      visibleItems: [],
      isFiatLoading: false,
      isPnlLoading: true,
      isPopulateLoadingByKey: undefined,
      hasAnyPortfolioData: true,
    });

    const {getByTestId} = render(<AssetsSection />);

    expect(getByTestId('assets-list-count').props.children).toBe('0');
    expect(getByTestId('assets-list-skeleton-state')).toBeTruthy();
  });

  it('keeps the see all assets navigation action', () => {
    const navigate = jest.fn();
    mockUseNavigation.mockReturnValue({navigate});

    const {getByText} = render(<AssetsSection />);
    fireEvent.press(getByText('See All Assets'));

    expect(navigate).toHaveBeenCalledWith('AllAssets');
  });
});
