import React from 'react';
import {render} from '../../../../../test/render';
import {useAppSelector} from '../../../../utils/hooks';
import AssetRow from './AssetRow';
import type {AssetRowItem} from '../../../../utils/portfolio/assets';

jest.mock('@react-navigation/native', () => ({
  useNavigation: jest.fn(() => ({navigate: jest.fn()})),
}));

jest.mock('react-native-skeleton-placeholder', () => {
  const React = require('react');
  const {View} = require('react-native');

  const SkeletonPlaceholder = ({children}: {children: React.ReactNode}) => (
    <View testID="asset-row-skeleton-placeholder">{children}</View>
  );
  SkeletonPlaceholder.Item = ({children}: {children?: React.ReactNode}) => (
    <View testID="asset-row-skeleton-item">{children}</View>
  );

  return SkeletonPlaceholder;
});

jest.mock('../../../../components/currency-image/CurrencyImage', () => {
  const React = require('react');
  const {View} = require('react-native');
  return {
    CurrencyImage: () => <View testID="asset-row-currency-image" />,
  };
});

jest.mock('./ChevronRightSvg', () => {
  const React = require('react');
  const {View} = require('react-native');
  return () => <View testID="asset-row-chevron" />;
});

jest.mock('../hooks/portfolioAssetHistoryRequests', () => ({
  getHistoricalRateAssetRequestFromItem: jest.fn(() => undefined),
  hasHistoricalRateSeriesForAsset: jest.fn(() => false),
}));

jest.mock('../../../../utils/hooks', () => ({
  useAppSelector: jest.fn(),
}));

const mockUseAppSelector = useAppSelector as jest.Mock;

const placeholderItem: AssetRowItem = {
  key: 'btc',
  currencyAbbreviation: 'btc',
  chain: 'btc',
  tokenAddress: undefined,
  name: 'Bitcoin',
  cryptoAmount: '1 BTC',
  fiatAmount: '— ',
  deltaFiat: '—     ',
  deltaPercent: '  —  %',
  isPositive: true,
  hasRate: true,
  hasPnl: false,
  showPnlPlaceholder: true,
};

function renderRow(props?: Partial<React.ComponentProps<typeof AssetRow>>) {
  return render(
    <AssetRow
      item={placeholderItem}
      isLast={false}
      {...props}
    />,
  );
}

describe('AssetRow loading and placeholder rendering', () => {
  beforeEach(() => {
    mockUseAppSelector.mockImplementation(selector =>
      selector({
        APP: {
          hideAllBalances: false,
          defaultAltCurrency: {isoCode: 'USD'},
        },
        RATE: {
          fiatRateSeriesCache: {},
        },
      }),
    );
  });

  it('renders steady-state PnL placeholders only after loading has finished', () => {
    const {getByText, queryAllByTestId} = renderRow();

    expect(getByText(/—\s*%/)).toBeTruthy();
    expect(queryAllByTestId('asset-row-skeleton-placeholder')).toHaveLength(0);
  });

  it('lets loading skeletons take precedence over PnL placeholders', () => {
    const {queryByText, queryAllByTestId} = renderRow({
      isPnlLoading: true,
    });

    expect(queryByText(/—\s*%/)).toBeNull();
    expect(queryAllByTestId('asset-row-skeleton-placeholder').length).toBeGreaterThan(0);
  });

  it('also hides placeholder percentages while populate loading is active', () => {
    const {queryByText, queryAllByTestId} = renderRow({
      isPopulateLoading: true,
    });

    expect(queryByText(/—\s*%/)).toBeNull();
    expect(queryAllByTestId('asset-row-skeleton-placeholder').length).toBeGreaterThan(0);
  });
});
