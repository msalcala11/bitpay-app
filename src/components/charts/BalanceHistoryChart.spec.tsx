import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import BalanceHistoryChart from './BalanceHistoryChart';
import {useAppDispatch} from '../../utils/hooks';
import {usePortfolioBalanceChartScope} from '../../portfolio/ui/hooks/usePortfolioBalanceChartScope';
import usePortfolioHistoricalRateDepsCache from '../../portfolio/ui/hooks/usePortfolioHistoricalRateDepsCache';
import {runPortfolioChartQuery} from '../../portfolio/ui/common';

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return {promise, resolve};
}

let latestInteractiveLineChartProps: any;
let latestTimeframeSelectorProps: any;
let mockHistoricalRatesReady = true;
let mockOneWeekCachedSeriesStatus: 'fresh' | 'pending_historical' | 'stale' =
  'stale';
const mockEmptyHistoricalRateDeps: any[] = [];
let mockHistoricalRateRequests: any[] = [];
let mockHistoricalRateCacheKeys: any[] = [];
const mockReadyHistoricalRateCache = {
  ready: {
    points: [],
  },
};
const mockPendingHistoricalRateCache = {};

const mockOneDayPoint = {date: new Date(1_000), value: 100};
const mockOneWeekPoint = {date: new Date(2_000), value: 150};
const mockUpdatedOneDayPoint = {date: new Date(3_000), value: 115};

const mockOneDaySeries = {
  graphPoints: [mockOneDayPoint],
  analysisPoints: [
    {
      timestamp: mockOneDayPoint.date.getTime(),
      totalFiatBalance: 100,
      totalPnlChange: 10,
      totalPnlPercent: 10,
    },
  ],
  pointByTimestamp: new Map([
    [
      mockOneDayPoint.date.getTime(),
      {
        timestamp: mockOneDayPoint.date.getTime(),
        totalFiatBalance: 100,
        totalPnlChange: 10,
        totalPnlPercent: 10,
      },
    ],
  ]),
  maxPoint: mockOneDayPoint,
  minPoint: mockOneDayPoint,
  maxIndex: 0,
  minIndex: 0,
};

const mockOneWeekSeries = {
  graphPoints: [mockOneWeekPoint],
  analysisPoints: [
    {
      timestamp: mockOneWeekPoint.date.getTime(),
      totalFiatBalance: 150,
      totalPnlChange: 20,
      totalPnlPercent: 15,
    },
  ],
  pointByTimestamp: new Map([
    [
      mockOneWeekPoint.date.getTime(),
      {
        timestamp: mockOneWeekPoint.date.getTime(),
        totalFiatBalance: 150,
        totalPnlChange: 20,
        totalPnlPercent: 15,
      },
    ],
  ]),
  maxPoint: mockOneWeekPoint,
  minPoint: mockOneWeekPoint,
  maxIndex: 0,
  minIndex: 0,
};

const mockUpdatedOneDaySeries = {
  graphPoints: [mockUpdatedOneDayPoint],
  analysisPoints: [
    {
      timestamp: mockUpdatedOneDayPoint.date.getTime(),
      totalFiatBalance: 115,
      totalPnlChange: 15,
      totalPnlPercent: 12,
    },
  ],
  pointByTimestamp: new Map([
    [
      mockUpdatedOneDayPoint.date.getTime(),
      {
        timestamp: mockUpdatedOneDayPoint.date.getTime(),
        totalFiatBalance: 115,
        totalPnlChange: 15,
        totalPnlPercent: 12,
      },
    ],
  ]),
  maxPoint: mockUpdatedOneDayPoint,
  minPoint: mockUpdatedOneDayPoint,
  maxIndex: 0,
  minIndex: 0,
};

jest.mock('react-native-reanimated', () => {
  const ReactLib = require('react');
  const {View} = require('react-native');
  return {
    __esModule: true,
    default: {
      View: ({children, ...props}: any) =>
        ReactLib.createElement(View, props, children),
    },
    useAnimatedStyle: () => ({}),
  };
});

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (value: string) => value,
  }),
}));

jest.mock('styled-components/native', () => ({
  useTheme: () => ({
    dark: false,
    colors: {
      text: 'black',
    },
  }),
}));

jest.mock('../../utils/hooks', () => ({
  useAppDispatch: jest.fn(),
}));

jest.mock('./InteractiveLineChart', () => {
  return (props: any) => {
    latestInteractiveLineChartProps = props;
    return null;
  };
});

jest.mock('./TimeframeSelector', () => {
  return (props: any) => {
    latestTimeframeSelectorProps = props;
    return null;
  };
});

jest.mock('./ChartSelectionDot', () => () => null);
jest.mock('./ChartChangeRow', () => () => null);

jest.mock('./useStableBalanceHistoryChartAxisLabels', () => ({
  useStableBalanceHistoryChartAxisLabels: () => ({
    MaxAxisLabel: () => null,
    MinAxisLabel: () => null,
  }),
}));

jest.mock('../../store/portfolio-charts', () => ({
  touchBalanceChartScope: (payload: any) => ({
    type: 'TOUCH_BALANCE_CHART_SCOPE',
    payload,
  }),
  upsertBalanceChartScopeTimeframes: (payload: any) => ({
    type: 'UPSERT_BALANCE_CHART_SCOPE_TIMEFRAMES',
    payload,
  }),
}));

jest.mock('../../utils/errors/formatUnknownError', () => ({
  formatUnknownError: (err: unknown) => String(err),
}));

jest.mock('../haptic-feedback/haptic', () => jest.fn());

jest.mock('../../portfolio/ui/hooks/usePortfolioBalanceChartScope', () => ({
  usePortfolioBalanceChartScope: jest.fn(),
}));

jest.mock('../../portfolio/ui/hooks/usePortfolioHistoricalRateDepsCache', () =>
  jest.fn(),
);

jest.mock('../../portfolio/ui/common', () => ({
  runPortfolioChartQuery: jest.fn(),
}));

jest.mock('../../utils/portfolio/chartCache', () => ({
  BALANCE_HISTORY_CHART_CACHE_IDENTITY_KEY: 'balance_history_chart:89',
  getCachedBalanceChartTimeframe: jest.fn(
    (
      timeframes: Record<string, {timeframe: string}> | undefined,
      timeframe: string,
    ) => timeframes?.[timeframe],
  ),
}));

jest.mock('../../utils/portfolio/balanceChartData', () => ({
  areBalanceChartHistoricalRatesReady: jest.fn(() => mockHistoricalRatesReady),
  buildBalanceChartHistoricalRateDeps: jest.fn(() => mockEmptyHistoricalRateDeps),
  buildBalanceChartHistoricalRateRequests: jest.fn(
    () => mockHistoricalRateRequests,
  ),
  buildCachedTimeframeFromRuntimeChart: jest.fn(() => undefined),
  buildHydratedSeriesFromRuntimeChart: jest.fn((args: {chart: {__series: any}}) => {
    return args.chart.__series;
  }),
  getBalanceChartHistoricalRateCacheKeys: jest.fn(
    () => mockHistoricalRateCacheKeys,
  ),
  getBalanceChartHistoricalRateCacheRevision: jest.fn(() => 'hist-rev'),
  resolveCachedBalanceChartSeries: jest.fn(
    (args: {cachedTimeframe?: {timeframe?: string}}) => {
      if (args.cachedTimeframe?.timeframe === '1D') {
        return {
          status: 'fresh',
          series: mockOneDaySeries,
        };
      }

       if (args.cachedTimeframe?.timeframe === '1W') {
         if (mockOneWeekCachedSeriesStatus === 'fresh') {
           return {
             status: 'fresh',
             series: mockOneWeekSeries,
           };
         }

         if (mockOneWeekCachedSeriesStatus === 'pending_historical') {
           return {
             status: 'pending_historical',
             series: mockOneWeekSeries,
           };
         }
       }

      return {
        status: 'stale_historical',
        series: undefined,
      };
    },
  ),
}));

jest.mock('./balanceHistoryChartSelection', () => ({
  buildBalanceHistoryChartChangeRowData: jest.fn(() => undefined),
  getDisplayedBalanceHistoryAnalysisPoint: jest.fn(
    ({activeSeries}: {activeSeries?: {analysisPoints?: any[]}}) =>
      activeSeries?.analysisPoints?.[activeSeries.analysisPoints.length - 1],
  ),
  getSelectedBalanceHistoryValue: jest.fn(
    ({point}: {point: {value: number}}) => point.value,
  ),
}));

jest.mock('./fiatTimeframes', () => ({
  DEFAULT_BALANCE_CHART_TIMEFRAME: '1D',
  getFiatChartTimeframeOptions: jest.fn(() => [
    {value: '1D', label: '1D'},
    {value: '1W', label: '1W'},
  ]),
  getRangeLabelForFiatTimeframe: jest.fn((_t: unknown, timeframe: string) => timeframe),
  formatRangeOrSelectedPointLabel: jest.fn(({rangeLabel}: {rangeLabel?: string}) => rangeLabel),
}));

const mockUseAppDispatch = useAppDispatch as jest.Mock;
const mockUsePortfolioBalanceChartScope =
  usePortfolioBalanceChartScope as jest.Mock;
const mockUsePortfolioHistoricalRateDepsCache =
  usePortfolioHistoricalRateDepsCache as jest.Mock;
const mockRunPortfolioChartQuery = runPortfolioChartQuery as jest.Mock;

describe('BalanceHistoryChart', () => {
  beforeEach(() => {
    jest.useRealTimers();
    latestInteractiveLineChartProps = undefined;
    latestTimeframeSelectorProps = undefined;
    mockHistoricalRatesReady = true;
    mockOneWeekCachedSeriesStatus = 'stale';
    mockHistoricalRateRequests = [];
    mockHistoricalRateCacheKeys = [];
    mockUseAppDispatch.mockReset();
    mockUseAppDispatch.mockReturnValue(jest.fn());
    mockUsePortfolioHistoricalRateDepsCache.mockReset();
    mockUsePortfolioHistoricalRateDepsCache.mockImplementation(() => ({
      cache: mockHistoricalRatesReady
        ? mockReadyHistoricalRateCache
        : mockPendingHistoricalRateCache,
      loading: !mockHistoricalRatesReady,
      error: undefined,
    }));
    mockUsePortfolioBalanceChartScope.mockReset();
    mockUsePortfolioBalanceChartScope.mockReturnValue({
      asOfMs: 1234,
      cachedScope: {
        timeframes: {
          '1D': {timeframe: '1D'},
        },
      },
      chartDataRevisionSig: 'chart-rev',
      currentRatesByAssetId: {},
      currentRatesSignature: 'rates-rev',
      currentSpotRatesByRateKey: {},
      currentSpotRatesSignature: 'spot-rev',
      quoteCurrency: 'USD',
      scopeId: 'scope-1',
      sortedWalletIds: ['wallet-1'],
      storedWalletRequestSig: 'wallet-req',
      storedWallets: [
        {
          summary: {
            walletId: 'wallet-1',
          },
        },
      ],
    });
    mockRunPortfolioChartQuery.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('avoids flashing the loader when an uncached timeframe switch resolves before the pending overlay delay', async () => {
    jest.useFakeTimers();
    const deferred = createDeferred<{__series: typeof mockOneWeekSeries}>();
    mockRunPortfolioChartQuery.mockReturnValue(deferred.promise);

    await act(async () => {
      TestRenderer.create(
        <BalanceHistoryChart
          wallets={[
            {
              id: 'wallet-1',
            } as any,
          ]}
          quoteCurrency="USD"
          showLoaderWhenNoSnapshots
        />,
      );
    });

    expect(latestInteractiveLineChartProps.points).toBe(
      mockOneDaySeries.graphPoints,
    );
    expect(latestInteractiveLineChartProps.isLoading).toBe(false);

    await act(async () => {
      latestTimeframeSelectorProps.onSelect('1W');
    });

    expect(mockRunPortfolioChartQuery).toHaveBeenCalledTimes(1);
    expect(latestInteractiveLineChartProps.isLoading).toBe(false);
    expect(latestInteractiveLineChartProps.points).toBe(
      mockOneDaySeries.graphPoints,
    );

    await act(async () => {
      jest.advanceTimersByTime(100);
      deferred.resolve({__series: mockOneWeekSeries});
      await deferred.promise;
    });

    expect(latestInteractiveLineChartProps.isLoading).toBe(false);
    expect(latestInteractiveLineChartProps.points).toBe(
      mockOneWeekSeries.graphPoints,
    );
  });

  it('shows the delayed loader over the previous series during a slow uncached timeframe switch', async () => {
    jest.useFakeTimers();
    const deferred = createDeferred<{__series: typeof mockOneWeekSeries}>();
    mockRunPortfolioChartQuery.mockReturnValue(deferred.promise);

    await act(async () => {
      TestRenderer.create(
        <BalanceHistoryChart
          wallets={[
            {
              id: 'wallet-1',
            } as any,
          ]}
          quoteCurrency="USD"
          showLoaderWhenNoSnapshots
        />,
      );
    });

    await act(async () => {
      latestTimeframeSelectorProps.onSelect('1W');
    });

    expect(latestInteractiveLineChartProps.isLoading).toBe(false);
    expect(latestInteractiveLineChartProps.points).toBe(
      mockOneDaySeries.graphPoints,
    );

    await act(async () => {
      jest.advanceTimersByTime(119);
    });

    expect(latestInteractiveLineChartProps.isLoading).toBe(false);
    expect(latestInteractiveLineChartProps.points).toBe(
      mockOneDaySeries.graphPoints,
    );

    await act(async () => {
      jest.advanceTimersByTime(1);
    });

    expect(latestInteractiveLineChartProps.isLoading).toBe(true);
    expect(latestInteractiveLineChartProps.points).toBe(
      mockOneDaySeries.graphPoints,
    );

    await act(async () => {
      deferred.resolve({__series: mockOneWeekSeries});
      await deferred.promise;
    });

    expect(latestInteractiveLineChartProps.isLoading).toBe(false);
    expect(latestInteractiveLineChartProps.points).toBe(
      mockOneWeekSeries.graphPoints,
    );
  });

  it('keeps the previous series visible and shows the delayed loader while a pending historical timeframe hydrates', async () => {
    jest.useFakeTimers();
    mockHistoricalRatesReady = false;
    mockOneWeekCachedSeriesStatus = 'pending_historical';
    mockHistoricalRateRequests = [
      {
        quoteCurrency: 'USD',
        requests: [{coin: 'btc', intervals: ['1W']}],
      },
    ];
    mockHistoricalRateCacheKeys = ['USD:BTC:1W'];
    mockUsePortfolioBalanceChartScope.mockReturnValue({
      asOfMs: 1234,
      cachedScope: {
        timeframes: {
          '1D': {timeframe: '1D'},
          '1W': {timeframe: '1W'},
        },
      },
      chartDataRevisionSig: 'chart-rev',
      currentRatesByAssetId: {},
      currentRatesSignature: 'rates-rev',
      currentSpotRatesByRateKey: {},
      currentSpotRatesSignature: 'spot-rev',
      quoteCurrency: 'USD',
      scopeId: 'scope-1',
      sortedWalletIds: ['wallet-1'],
      storedWalletRequestSig: 'wallet-req',
      storedWallets: [
        {
          summary: {
            walletId: 'wallet-1',
          },
        },
      ],
    });

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <BalanceHistoryChart
          wallets={[
            {
              id: 'wallet-1',
            } as any,
          ]}
          quoteCurrency="USD"
          showLoaderWhenNoSnapshots
        />,
      );
    });

    expect(latestInteractiveLineChartProps.points).toBe(
      mockOneDaySeries.graphPoints,
    );

    await act(async () => {
      latestTimeframeSelectorProps.onSelect('1W');
    });

    expect(mockRunPortfolioChartQuery).not.toHaveBeenCalled();
    expect(latestInteractiveLineChartProps.isLoading).toBe(false);
    expect(latestInteractiveLineChartProps.points).toBe(
      mockOneDaySeries.graphPoints,
    );

    await act(async () => {
      jest.advanceTimersByTime(119);
    });

    expect(latestInteractiveLineChartProps.isLoading).toBe(false);
    expect(latestInteractiveLineChartProps.points).toBe(
      mockOneDaySeries.graphPoints,
    );

    await act(async () => {
      jest.advanceTimersByTime(1);
    });

    expect(latestInteractiveLineChartProps.isLoading).toBe(true);
    expect(latestInteractiveLineChartProps.points).toBe(
      mockOneDaySeries.graphPoints,
    );

    mockHistoricalRatesReady = true;
    mockOneWeekCachedSeriesStatus = 'fresh';

    await act(async () => {
      renderer.update(
        <BalanceHistoryChart
          wallets={[
            {
              id: 'wallet-1',
            } as any,
          ]}
          quoteCurrency="USD"
          showLoaderWhenNoSnapshots
        />,
      );
    });

    expect(latestInteractiveLineChartProps.isLoading).toBe(false);
    expect(latestInteractiveLineChartProps.points).toBe(
      mockOneWeekSeries.graphPoints,
    );
  });

  it('keeps the current same-quote timeframe series visible while a new query revision hydrates', async () => {
    jest.useFakeTimers();
    const deferred = createDeferred<{__series: typeof mockUpdatedOneDaySeries}>();
    mockRunPortfolioChartQuery.mockReturnValue(deferred.promise);

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <BalanceHistoryChart
          wallets={[
            {
              id: 'wallet-1',
            } as any,
          ]}
          quoteCurrency="USD"
          showLoaderWhenNoSnapshots
        />,
      );
    });

    expect(latestInteractiveLineChartProps.points).toBe(
      mockOneDaySeries.graphPoints,
    );
    expect(latestInteractiveLineChartProps.isLoading).toBe(false);

    mockUsePortfolioBalanceChartScope.mockReturnValue({
      asOfMs: 1235,
      cachedScope: {
        timeframes: {},
      },
      chartDataRevisionSig: 'chart-rev-2',
      currentRatesByAssetId: {},
      currentRatesSignature: 'rates-rev-2',
      currentSpotRatesByRateKey: {},
      currentSpotRatesSignature: 'spot-rev-2',
      quoteCurrency: 'USD',
      scopeId: 'scope-1',
      sortedWalletIds: ['wallet-1'],
      storedWalletRequestSig: 'wallet-req',
      storedWallets: [
        {
          summary: {
            walletId: 'wallet-1',
          },
        },
      ],
    });

    await act(async () => {
      renderer.update(
        <BalanceHistoryChart
          wallets={[
            {
              id: 'wallet-1',
            } as any,
          ]}
          quoteCurrency="USD"
          showLoaderWhenNoSnapshots
        />,
      );
    });

    expect(mockRunPortfolioChartQuery).toHaveBeenCalledTimes(1);
    expect(latestInteractiveLineChartProps.points).toBe(
      mockOneDaySeries.graphPoints,
    );
    expect(latestInteractiveLineChartProps.isLoading).toBe(false);

    await act(async () => {
      jest.advanceTimersByTime(120);
    });

    expect(latestInteractiveLineChartProps.isLoading).toBe(true);
    expect(latestInteractiveLineChartProps.points).toBe(
      mockOneDaySeries.graphPoints,
    );

    await act(async () => {
      deferred.resolve({__series: mockUpdatedOneDaySeries});
      await deferred.promise;
    });

    expect(latestInteractiveLineChartProps.isLoading).toBe(false);
    expect(latestInteractiveLineChartProps.points).toBe(
      mockUpdatedOneDaySeries.graphPoints,
    );
  });

  it('does not keep the previous series visible across a quote change while the new quote hydrates', async () => {
    const deferred = createDeferred<{__series: typeof mockOneWeekSeries}>();
    mockRunPortfolioChartQuery.mockReturnValue(deferred.promise);

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <BalanceHistoryChart
          wallets={[
            {
              id: 'wallet-1',
            } as any,
          ]}
          quoteCurrency="USD"
          showLoaderWhenNoSnapshots
        />,
      );
    });

    expect(latestInteractiveLineChartProps.points).toBe(
      mockOneDaySeries.graphPoints,
    );

    mockUsePortfolioBalanceChartScope.mockReturnValue({
      asOfMs: 1235,
      cachedScope: {
        timeframes: {},
      },
      chartDataRevisionSig: 'chart-rev-eur',
      currentRatesByAssetId: {},
      currentRatesSignature: 'rates-rev-eur',
      currentSpotRatesByRateKey: {},
      currentSpotRatesSignature: 'spot-rev-eur',
      quoteCurrency: 'EUR',
      scopeId: 'scope-1',
      sortedWalletIds: ['wallet-1'],
      storedWalletRequestSig: 'wallet-req',
      storedWallets: [
        {
          summary: {
            walletId: 'wallet-1',
          },
        },
      ],
    });

    await act(async () => {
      renderer.update(
        <BalanceHistoryChart
          wallets={[
            {
              id: 'wallet-1',
            } as any,
          ]}
          quoteCurrency="EUR"
          showLoaderWhenNoSnapshots
        />,
      );
    });

    expect(mockRunPortfolioChartQuery).toHaveBeenCalledTimes(1);
    expect(latestInteractiveLineChartProps.isLoading).toBe(true);
    expect(latestInteractiveLineChartProps.points).toEqual([]);

    await act(async () => {
      deferred.resolve({__series: mockOneWeekSeries});
      await deferred.promise;
    });
  });
});
