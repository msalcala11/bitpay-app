import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import AssetBalanceHistoryScreen from './AssetBalanceHistoryScreen';

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let latestBalanceHistoryChartProps: any;

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (value: string) => value,
  }),
}));

jest.mock('../../../../components/charts/BalanceHistoryChart', () => {
  return (props: any) => {
    latestBalanceHistoryChartProps = props;
    return null;
  };
});

jest.mock('../../../../components/styled/Containers', () => ({
  ScreenGutter: 16,
}));

jest.mock('../../../../portfolio/ui/hooks/usePortfolioWalletSnapshotPresence', () =>
  jest.fn(() => ({
    hasAnySnapshots: true,
    hasAllSnapshots: true,
    checked: true,
  })),
);

jest.mock('../../../../portfolio/ui/hooks/usePortfolioAnalysis', () => ({
  usePortfolioAnalysis: jest.fn(() => ({
    storedWallets: [],
    eligibleWallets: [],
    data: undefined,
    quoteCurrency: 'USD',
    currentData: undefined,
    committedData: undefined,
    error: undefined,
    requestKey: 'analysis-request',
    currentRatesByAssetId: {},
    currentRatesSignature: 'rates-sig',
  })),
}));

jest.mock('../../../../portfolio/ui/debug/buildAssetPnlDebugPayload', () =>
  jest.fn(() => ({})),
);

jest.mock('../../../../utils/helper-methods', () => ({
  formatFiatAmount: jest.fn(() => '$100.00'),
}));

jest.mock('../../../../utils/hooks', () => ({
  useAppSelector: jest.fn((selector: (state: any) => any) =>
    selector({
      PORTFOLIO: {
        populateStatus: undefined,
      },
    }),
  ),
}));

jest.mock('../../../../utils/portfolio/assets', () => ({
  isPopulateLoadingForWallets: jest.fn(() => false),
}));

jest.mock('../../../../utils/fiatAmountText', () => ({
  shouldUseCompactFiatAmountText: jest.fn(() => false),
}));

jest.mock('./ExchangeRateScreenLayout', () => {
  return ({chartSection}: {chartSection: React.ReactNode}) => <>{chartSection}</>;
});

jest.mock('./assetBalanceHistorySummary', () => ({
  buildAssetBalanceHistoryIdleSummary: jest.fn(() => ({
    assetBalance: 100,
    changeRow: {
      percent: 10,
      deltaFiatFormatted: '$10.00',
      rangeLabel: '1D',
    },
    assetMetrics: {
      hasRate: true,
      hasPnl: true,
      showPnlPlaceholder: false,
      fiatValue: 100,
      pnlFiat: 10,
      pnlPercent: 10,
      debugCopyPayload: undefined,
    },
  })),
  buildAssetBalanceHistoryDisplayedSummary: jest.fn(
    ({idleSummary}: {idleSummary: {assetBalance?: number; changeRow?: any}}) => ({
      assetBalance: idleSummary.assetBalance,
      changeRow: idleSummary.changeRow,
      source: 'idle',
    }),
  ),
}));

jest.mock('./useAssetScreenRefresh', () =>
  jest.fn(() => ({
    isRefreshing: false,
    onRefresh: jest.fn(),
  })),
);

const {usePortfolioAnalysis} = jest.requireMock(
  '../../../../portfolio/ui/hooks/usePortfolioAnalysis',
) as {
  usePortfolioAnalysis: jest.Mock;
};
const mockUsePortfolioWalletSnapshotPresence = jest.requireMock(
  '../../../../portfolio/ui/hooks/usePortfolioWalletSnapshotPresence',
) as jest.Mock;

const sharedFactory = () =>
  ({
    walletsForAsset: [{wallet: {id: 'wallet-1'}}],
    assetWallets: [{id: 'wallet-1'}],
    hasWalletsForAsset: true,
    assetContext: {
      chain: 'btc',
      currencyAbbreviation: 'btc',
      tokenAddress: undefined,
    },
    resolvedQuoteCurrency: 'USD',
    assetTotalFiatBalance: 100,
    rates: {},
    chartLineColor: '#123456',
    gradientBackgroundColor: '#abcdef',
    hideAllBalances: false,
    formatDisplayPrice: () => '$100.00',
    currentFiatRate: 100,
    currencyAbbreviation: 'BTC',
  }) as any;

describe('AssetBalanceHistoryScreen', () => {
  beforeEach(() => {
    latestBalanceHistoryChartProps = undefined;
    usePortfolioAnalysis.mockClear();
    mockUsePortfolioWalletSnapshotPresence.mockClear();
    mockUsePortfolioWalletSnapshotPresence.mockReturnValue({
      hasAnySnapshots: true,
      hasAllSnapshots: true,
      checked: true,
    });
  });

  it('keeps parent analysis pinned to the currently displayed timeframe until the chart reports the new displayed timeframe', async () => {
    await act(async () => {
      TestRenderer.create(<AssetBalanceHistoryScreen shared={sharedFactory()} />);
    });

    expect(latestBalanceHistoryChartProps.showLoaderWhenNoSnapshots).toBe(false);
    expect(usePortfolioAnalysis).toHaveBeenCalledTimes(1);
    expect(usePortfolioAnalysis).toHaveBeenLastCalledWith(
      expect.objectContaining({
        timeframe: '1D',
      }),
    );

    await act(async () => {
      latestBalanceHistoryChartProps.onSelectedTimeframeChange('1W');
    });

    expect(latestBalanceHistoryChartProps.showLoaderWhenNoSnapshots).toBe(true);
    expect(usePortfolioAnalysis).toHaveBeenCalledTimes(2);
    expect(usePortfolioAnalysis).toHaveBeenLastCalledWith(
      expect.objectContaining({
        timeframe: '1D',
      }),
    );

    await act(async () => {
      latestBalanceHistoryChartProps.onDiagnosticsChange({
        displayedTimeframe: '1W',
      });
    });

    expect(latestBalanceHistoryChartProps.showLoaderWhenNoSnapshots).toBe(false);
    expect(usePortfolioAnalysis).toHaveBeenCalledTimes(3);
    expect(usePortfolioAnalysis).toHaveBeenLastCalledWith(
      expect.objectContaining({
        timeframe: '1W',
      }),
    );
  });

  it('uses the historical chart wallet scope for snapshot gating instead of the display wallet list', async () => {
    const shared = sharedFactory();
    shared.walletsForAsset = [];
    shared.assetWallets = [{id: 'historical-wallet-1'}];
    shared.hasWalletsForAsset = true;

    await act(async () => {
      TestRenderer.create(<AssetBalanceHistoryScreen shared={shared} />);
    });

    expect(mockUsePortfolioWalletSnapshotPresence).toHaveBeenCalledWith({
      wallets: shared.assetWallets,
      enabled: true,
    });
    expect(latestBalanceHistoryChartProps).toBeDefined();
  });

  it('renders the chart when the historical asset scope has at least one snapshot even if not all wallets do', async () => {
    mockUsePortfolioWalletSnapshotPresence.mockReturnValue({
      hasAnySnapshots: true,
      hasAllSnapshots: false,
      checked: true,
    });

    await act(async () => {
      TestRenderer.create(<AssetBalanceHistoryScreen shared={sharedFactory()} />);
    });

    expect(latestBalanceHistoryChartProps).toBeDefined();
  });

  it('does not pre-hide the chart when snapshot presence is empty so the chart query can resolve scoped data', async () => {
    mockUsePortfolioWalletSnapshotPresence.mockReturnValue({
      hasAnySnapshots: false,
      hasAllSnapshots: false,
      checked: true,
    });

    await act(async () => {
      TestRenderer.create(<AssetBalanceHistoryScreen shared={sharedFactory()} />);
    });

    expect(latestBalanceHistoryChartProps).toBeDefined();
  });
});
