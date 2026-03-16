import React from 'react';
import {act, cleanup, fireEvent, render} from '@testing-library/react-native';
import {HISTORIC_RATES_CACHE_DURATION} from '../../constants/wallet';
import {FIAT_RATE_SERIES_TARGET_POINTS} from '../../store/rate/rate.models';
import {getFiatRateSeriesCacheKey} from '../../store/rate/rate.models';
import type {BalanceSnapshot} from '../../store/portfolio/portfolio.models';
import type {Wallet} from '../../store/wallet/wallet.models';
import BalanceHistoryChart from './BalanceHistoryChart';

const mockBuildPnlAnalysisSeriesAsync = jest.fn();
const mockBuildBalanceChartTimeframeRevision = jest.fn(
  ({
    timeframe,
    historicalRateDeps = [],
  }: {
    timeframe: string;
    historicalRateDeps?: Array<{
      cacheKey?: string;
      fetchedOn?: number;
      lastTs?: number;
    }>;
  }) =>
    `revision:${timeframe}:${historicalRateDeps
      .map(
        dep =>
          `${dep.cacheKey || 'na'}:${dep.fetchedOn ?? 'na'}:${
            dep.lastTs ?? 'na'
          }`,
      )
      .join(',')}`,
);
const mockBuildPnlCurrentRatesByRateKeyFromPortfolioSnapshots = jest.fn(
  () => ({}),
);
const mockBuildPnlWalletInputsFromPortfolioSnapshotsAsync = jest.fn();
jest.mock('react-native-reanimated', () => {
  const ReactNative = require('react-native');

  return {
    __esModule: true,
    default: {
      View: ReactNative.View,
    },
    useAnimatedStyle: () => ({}),
  };
});
jest.mock('../../utils/helper-methods', () => ({
  formatFiatAmount: () => '$0',
}));
jest.mock('../../utils/portfolio/chartCache', () => {
  const actual = jest.requireActual('../../utils/portfolio/chartCache');

  return {
    ...actual,
    buildBalanceChartScopeId: () => 'scope-1',
    buildBalanceChartTimeframeRevision: (...args: unknown[]) =>
      mockBuildBalanceChartTimeframeRevision(...args),
    buildSnapshotVersionSig: () => 'snapshot-sig',
    getCachedTimeframeStatus: () => 'missing',
    getSortedUniqueWalletIds: (walletIds: string[]) => walletIds,
  };
});
jest.mock('../../utils/scheduleAfterInteractionsAndFrames', () => ({
  scheduleAfterInteractionsAndFrames: ({
    callback,
    onError,
  }: {
    callback: (signal: AbortSignal) => void | Promise<void>;
    onError?: (error: unknown) => void;
  }) => {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let resolveDone: (() => void) | undefined;
    const done = new Promise<void>(resolve => {
      resolveDone = resolve;
    });

    timeout = setTimeout(() => {
      Promise.resolve()
        .then(() => callback(controller.signal))
        .catch(error => {
          if (!controller.signal.aborted) {
            onError?.(error);
          }
        })
        .finally(() => {
          resolveDone?.();
          resolveDone = undefined;
        });
    }, 0);

    return {
      cancel: () => {
        controller.abort();
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        resolveDone?.();
        resolveDone = undefined;
      },
      done,
      signal: controller.signal,
    };
  },
}));
jest.mock('../../utils/portfolio/core/pnl/analysis', () => ({
  buildPnlAnalysisSeriesAsync: (...args: unknown[]) =>
    mockBuildPnlAnalysisSeriesAsync(...args),
}));
jest.mock('../../utils/portfolio/assets', () => ({
  buildPnlCurrentRatesByRateKeyFromPortfolioSnapshots: (...args: unknown[]) =>
    mockBuildPnlCurrentRatesByRateKeyFromPortfolioSnapshots.apply(
      undefined,
      args,
    ),
  buildPnlWalletInputsFromPortfolioSnapshotsAsync: (...args: unknown[]) =>
    mockBuildPnlWalletInputsFromPortfolioSnapshotsAsync.apply(undefined, args),
  getPortfolioWalletChainLower: (wallet?: {chain?: string}) =>
    String(wallet?.chain || '').toLowerCase(),
  getPortfolioWalletCurrencyAbbreviation: (wallet?: {
    currencyAbbreviation?: string;
  }) => String(wallet?.currencyAbbreviation || ''),
  getPortfolioWalletId: (wallet?: {id?: string}) => String(wallet?.id || ''),
  getPortfolioWalletSnapshots: (
    snapshotsByWalletId: Record<string, unknown[] | undefined> | undefined,
    walletId: string,
  ) => snapshotsByWalletId?.[walletId] || [],
  getPortfolioWalletTokenAddressNormalized: (wallet?: {
    chain?: string;
    tokenAddress?: string;
  }) => {
    const tokenAddress = String(wallet?.tokenAddress || '');
    if (!tokenAddress) {
      return undefined;
    }

    return String(wallet?.chain || '').toLowerCase() === 'sol'
      ? tokenAddress
      : tokenAddress.toLowerCase();
  },
}));

const mockDispatch = jest.fn();
const mockState = {
  PORTFOLIO_CHARTS: {
    walletSnapshotVersionById: {},
    cacheByScopeId: {},
  },
};
jest.mock('../../utils/hooks', () => ({
  useAppDispatch: () => mockDispatch,
  useAppSelector: (selector: (state: typeof mockState) => unknown) =>
    selector(mockState),
}));

jest.mock('../../store/wallet/effects', () => ({
  fetchFiatRateSeriesInterval: (args: unknown) => ({
    type: 'FETCH_FIAT_RATE_SERIES_INTERVAL',
    payload: args,
  }),
}));

jest.mock('../../store/portfolio-charts', () => ({
  patchBalanceChartScopeLatestPoints: (args: unknown) => ({
    type: 'PATCH_BALANCE_CHART_SCOPE_LATEST_POINTS',
    payload: args,
  }),
  touchBalanceChartScope: (args: unknown) => ({
    type: 'TOUCH_BALANCE_CHART_SCOPE',
    payload: args,
  }),
  upsertBalanceChartScopeTimeframes: (args: unknown) => ({
    type: 'UPSERT_BALANCE_CHART_SCOPE_TIMEFRAMES',
    payload: args,
  }),
}));

const mockLogError = jest.fn();
jest.mock('../../managers/LogManager', () => ({
  logManager: {
    error: (...args: unknown[]) => mockLogError(...args),
  },
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));
jest.mock('styled-components/native', () => ({
  useTheme: () => ({
    dark: false,
  }),
}));

jest.mock('./TimeframeSelector', () => {
  const ReactNative = require('react-native');

  return ({
    onSelect,
    options = [],
  }: {
    onSelect?: (timeframe: string) => void;
    options?: Array<{label: string; value: string}>;
  }) => (
    <ReactNative.View>
      {options.map(option => (
        <ReactNative.Pressable
          key={option.value}
          testID={`timeframe-${option.value}`}
          onPress={() => onSelect?.(option.value)}>
          <ReactNative.Text>{option.label}</ReactNative.Text>
        </ReactNative.Pressable>
      ))}
    </ReactNative.View>
  );
});
jest.mock('./ChartAxisLabel', () => () => null);
jest.mock('./ChartSelectionDot', () => () => null);
jest.mock('./ChartChangeRow', () => () => null);
jest.mock('../haptic-feedback/haptic', () => jest.fn());
jest.mock('./InteractiveLineChart', () => {
  const ReactNative = require('react-native');

  return ({isLoading, points}: {isLoading?: boolean; points?: unknown[]}) => (
    <ReactNative.Text testID="interactive-line-chart">
      {isLoading ? 'loading' : `ready:${points?.length ?? 0}`}
    </ReactNative.Text>
  );
});

const wallet = {
  id: 'wallet-1',
  walletName: 'Wallet 1',
  chain: 'btc',
  network: 'livenet',
  currencyAbbreviation: 'btc',
  credentials: {
    coin: 'btc',
    chain: 'btc',
    network: 'livenet',
  },
  balance: {
    sat: 0,
    crypto: '0',
  },
} as Wallet;

const snapshot = {
  id: 'snapshot-1',
  walletId: 'wallet-1',
  chain: 'btc',
  coin: 'btc',
  network: 'livenet',
  assetId: 'btc:livenet',
  timestamp: 1_000,
  eventType: 'tx',
  cryptoBalance: '1',
  remainingCostBasisFiat: 40_000,
  avgCostFiatPerUnit: 40_000,
  unrealizedPnlFiat: 0,
  costBasisRateFiat: 40_000,
  quoteCurrency: 'USD',
} as BalanceSnapshot;

const svmTokenAddress = 'AbCDeFGHJKLMNPQRSTuvWXYZ123456789';
const svmWallet = {
  ...wallet,
  id: 'wallet-sol-1',
  walletName: 'Sol Wallet 1',
  chain: 'sol',
  currencyAbbreviation: 'usdc',
  tokenAddress: svmTokenAddress,
} as Wallet;

const svmSnapshot = {
  ...snapshot,
  id: 'snapshot-sol-1',
  walletId: 'wallet-sol-1',
  chain: 'sol',
  coin: 'usdc',
  assetId: `sol:usdc:${svmTokenAddress}`,
} as BalanceSnapshot;

const createDeferred = <T,>() => {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>(res => {
    resolve = res;
  });

  return {
    promise,
    resolve,
  };
};

const flushAsyncWork = async (iterations = 4) => {
  for (let i = 0; i < iterations; i += 1) {
    await act(async () => {
      jest.runOnlyPendingTimers();
      await Promise.resolve();
    });
  }
};

const createMockAnalysisPoints = (args?: {
  walletId?: string;
  baseBalance?: number;
}) => {
  const walletId = args?.walletId || 'wallet-eth-1';
  const baseBalance = args?.baseBalance ?? 100;

  return Array.from({length: FIAT_RATE_SERIES_TARGET_POINTS}, (_, index) => ({
    timestamp: 1_000 + index * 1_000,
    totalFiatBalance: baseBalance + index,
    totalRemainingCostBasisFiat: baseBalance - 20 + index,
    totalUnrealizedPnlFiat: 20,
    totalPnlPercent: 5,
    byWalletId: {
      [walletId]: {
        balanceAtomic: '1',
        formattedCryptoBalance: '1',
        fiatBalance: baseBalance + index,
        remainingCostBasisFiat: baseBalance - 20 + index,
        unrealizedPnlFiat: 20,
        markRate: baseBalance + index,
        ratePercentChange: 2,
        pnlPercent: 5,
      },
    },
  }));
};

const createMockAnalysisSeriesResult = (args: {
  timeframe: string;
  walletId?: string;
  baseBalance?: number;
  quoteCurrency?: string;
}) => {
  const baseBalance = args.baseBalance ?? 100;

  return {
    points: createMockAnalysisPoints({
      walletId: args.walletId,
      baseBalance,
    }),
    timeframe: args.timeframe,
    quoteCurrency: args.quoteCurrency || 'USD',
    driverRateKey: 'eth',
    rateKeys: ['eth'],
    wallets: [],
    assetSummaries: [],
    totalSummary: {
      pnlStart: baseBalance - 20,
      pnlEnd: baseBalance,
      pnlChange: 20,
      pnlPercent: 25,
    },
  };
};

const getIntervalFetchDispatches = () =>
  mockDispatch.mock.calls
    .map(([action]) => action)
    .filter(action => action?.type === 'FETCH_FIAT_RATE_SERIES_INTERVAL');

describe('BalanceHistoryChart', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-15T12:00:00.000Z'));
    jest.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    jest.restoreAllMocks();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('logs preparation failures and clears the loader', async () => {
    mockBuildPnlWalletInputsFromPortfolioSnapshotsAsync.mockRejectedValue(
      new Error('prepare boom'),
    );

    const screen = render(
      <BalanceHistoryChart
        wallets={[wallet]}
        snapshotsByWalletId={{
          [wallet.id]: [snapshot],
        }}
        quoteCurrency="USD"
        fiatRateSeriesCache={{}}
      />,
    );

    await flushAsyncWork();
    screen.rerender(
      <BalanceHistoryChart
        wallets={[wallet]}
        snapshotsByWalletId={{
          [wallet.id]: [snapshot],
        }}
        quoteCurrency="USD"
        fiatRateSeriesCache={{}}
        rates={{}}
      />,
    );
    await flushAsyncWork();

    expect(
      mockBuildPnlWalletInputsFromPortfolioSnapshotsAsync,
    ).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        signal: expect.any(Object),
      }),
    );
    expect(mockLogError).toHaveBeenCalledWith(
      '[BalanceHistoryChart] prepare failed',
      'prepare boom',
    );
    expect(screen.getByTestId('interactive-line-chart')).toHaveTextContent(
      'ready:0',
    );
  });

  it('prepares analysis inputs on initial mount and remount', async () => {
    mockBuildPnlWalletInputsFromPortfolioSnapshotsAsync.mockResolvedValue({
      wallets: [],
      currentRatesByRateKey: {},
      quoteCurrency: 'USD',
    });

    const firstRender = render(
      <BalanceHistoryChart
        wallets={[wallet]}
        snapshotsByWalletId={{
          [wallet.id]: [snapshot],
        }}
        quoteCurrency="USD"
        fiatRateSeriesCache={{}}
      />,
    );

    await flushAsyncWork();

    expect(
      mockBuildPnlWalletInputsFromPortfolioSnapshotsAsync,
    ).toHaveBeenCalledTimes(1);

    firstRender.unmount();
    mockBuildPnlWalletInputsFromPortfolioSnapshotsAsync.mockClear();

    render(
      <BalanceHistoryChart
        wallets={[wallet]}
        snapshotsByWalletId={{
          [wallet.id]: [snapshot],
        }}
        quoteCurrency="USD"
        fiatRateSeriesCache={{}}
      />,
    );

    await flushAsyncWork();

    expect(
      mockBuildPnlWalletInputsFromPortfolioSnapshotsAsync,
    ).toHaveBeenCalledTimes(1);
  });

  it('preserves SVM token address case in fiat-rate fetch requests', async () => {
    mockBuildPnlWalletInputsFromPortfolioSnapshotsAsync.mockResolvedValue({
      wallets: [],
      currentRatesByRateKey: {},
      quoteCurrency: 'USD',
    });

    render(
      <BalanceHistoryChart
        wallets={[svmWallet]}
        snapshotsByWalletId={{
          [svmWallet.id]: [svmSnapshot],
        }}
        quoteCurrency="USD"
        fiatRateSeriesCache={{}}
      />,
    );

    await flushAsyncWork(1);

    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'FETCH_FIAT_RATE_SERIES_INTERVAL',
        payload: expect.objectContaining({
          chain: 'sol',
          tokenAddress: svmTokenAddress,
        }),
      }),
    );
  });

  it('skips selected-interval fetches when the cache entry is already fresh', async () => {
    mockBuildPnlWalletInputsFromPortfolioSnapshotsAsync.mockResolvedValue({
      wallets: [],
      currentRatesByRateKey: {},
      quoteCurrency: 'USD',
    });

    render(
      <BalanceHistoryChart
        wallets={[wallet]}
        snapshotsByWalletId={{
          [wallet.id]: [snapshot],
        }}
        quoteCurrency="USD"
        fiatRateSeriesCache={{
          [getFiatRateSeriesCacheKey('USD', 'btc', 'ALL')]: {
            fetchedOn: Date.now() - 1_000,
            points: [{ts: 1_000, rate: 40_000}],
          },
        }}
      />,
    );

    await flushAsyncWork(1);

    expect(getIntervalFetchDispatches()).toHaveLength(0);
  });

  it('still fetches selected-interval history when the cache entry is stale', async () => {
    mockBuildPnlWalletInputsFromPortfolioSnapshotsAsync.mockResolvedValue({
      wallets: [],
      currentRatesByRateKey: {},
      quoteCurrency: 'USD',
    });

    render(
      <BalanceHistoryChart
        wallets={[wallet]}
        snapshotsByWalletId={{
          [wallet.id]: [snapshot],
        }}
        quoteCurrency="USD"
        fiatRateSeriesCache={{
          [getFiatRateSeriesCacheKey('USD', 'btc', 'ALL')]: {
            fetchedOn:
              Date.now() - (HISTORIC_RATES_CACHE_DURATION * 1000 + 1_000),
            points: [{ts: 1_000, rate: 40_000}],
          },
        }}
      />,
    );

    await flushAsyncWork(1);

    expect(getIntervalFetchDispatches()).toEqual([
      expect.objectContaining({
        type: 'FETCH_FIAT_RATE_SERIES_INTERVAL',
        payload: expect.objectContaining({
          fiatCode: 'USD',
          interval: 'ALL',
          coinForCacheCheck: 'btc',
          chain: undefined,
          tokenAddress: undefined,
        }),
      }),
    ]);
  });

  it('dispatches exactly once per unique missing asset identity', async () => {
    mockBuildPnlWalletInputsFromPortfolioSnapshotsAsync.mockResolvedValue({
      wallets: [],
      currentRatesByRateKey: {},
      quoteCurrency: 'USD',
    });

    const usdcEthWallet = {
      ...wallet,
      id: 'wallet-usdc-eth',
      chain: 'eth',
      currencyAbbreviation: 'usdc',
      credentials: {
        coin: 'usdc',
        chain: 'eth',
        network: 'livenet',
      },
    } as Wallet;
    const usdcBaseWallet = {
      ...wallet,
      id: 'wallet-usdc-base',
      chain: 'base',
      currencyAbbreviation: 'usdc',
      credentials: {
        coin: 'usdc',
        chain: 'base',
        network: 'livenet',
      },
    } as Wallet;
    const usdcEthSnapshot = {
      ...snapshot,
      id: 'snapshot-usdc-eth',
      walletId: usdcEthWallet.id,
      chain: 'eth',
      coin: 'usdc',
      assetId: 'eth:usdc',
    } as BalanceSnapshot;
    const usdcBaseSnapshot = {
      ...snapshot,
      id: 'snapshot-usdc-base',
      walletId: usdcBaseWallet.id,
      chain: 'base',
      coin: 'usdc',
      assetId: 'base:usdc',
    } as BalanceSnapshot;

    render(
      <BalanceHistoryChart
        wallets={[usdcEthWallet, usdcBaseWallet]}
        snapshotsByWalletId={{
          [usdcEthWallet.id]: [usdcEthSnapshot],
          [usdcBaseWallet.id]: [usdcBaseSnapshot],
        }}
        quoteCurrency="USD"
        fiatRateSeriesCache={{}}
      />,
    );

    await flushAsyncWork(1);

    expect(getIntervalFetchDispatches()).toEqual([
      expect.objectContaining({
        type: 'FETCH_FIAT_RATE_SERIES_INTERVAL',
        payload: expect.objectContaining({
          fiatCode: 'USD',
          interval: 'ALL',
          coinForCacheCheck: 'usdc',
          chain: undefined,
          tokenAddress: undefined,
        }),
      }),
    ]);
  });

  it('still evaluates selected-timeframe fetches when the timeframe changes', async () => {
    mockBuildPnlWalletInputsFromPortfolioSnapshotsAsync.mockResolvedValue({
      wallets: [],
      currentRatesByRateKey: {},
      quoteCurrency: 'USD',
    });

    const screen = render(
      <BalanceHistoryChart
        wallets={[wallet]}
        snapshotsByWalletId={{
          [wallet.id]: [snapshot],
        }}
        quoteCurrency="USD"
        fiatRateSeriesCache={{
          [getFiatRateSeriesCacheKey('USD', 'btc', 'ALL')]: {
            fetchedOn: Date.now() - 1_000,
            points: [{ts: 1_000, rate: 40_000}],
          },
        }}
      />,
    );

    await flushAsyncWork(1);
    expect(getIntervalFetchDispatches()).toHaveLength(0);

    fireEvent.press(screen.getByTestId('timeframe-1D'));
    await flushAsyncWork(1);

    expect(getIntervalFetchDispatches()).toEqual([
      expect.objectContaining({
        type: 'FETCH_FIAT_RATE_SERIES_INTERVAL',
        payload: expect.objectContaining({
          fiatCode: 'USD',
          interval: '1D',
          coinForCacheCheck: 'btc',
        }),
      }),
    ]);
  });

  it('does not swap to a stale completed timeframe while a newer selection is pending', async () => {
    const ethWallet = {
      ...wallet,
      id: 'wallet-eth-1',
      chain: 'eth',
      currencyAbbreviation: 'eth',
      credentials: {
        coin: 'eth',
        chain: 'eth',
        network: 'livenet',
      },
    } as Wallet;
    const ethSnapshot = {
      ...snapshot,
      id: 'snapshot-eth-rapid-switch',
      walletId: 'wallet-eth-1',
      chain: 'eth',
      coin: 'eth',
      assetId: 'eth:livenet',
    } as BalanceSnapshot;
    const oneWeekCompute =
      createDeferred<ReturnType<typeof createMockAnalysisSeriesResult>>();
    const oneMonthCompute =
      createDeferred<ReturnType<typeof createMockAnalysisSeriesResult>>();
    const onChangeRowData = jest.fn();

    mockBuildPnlWalletInputsFromPortfolioSnapshotsAsync.mockResolvedValue({
      wallets: [
        {
          walletId: 'wallet-eth-1',
          walletName: 'Wallet ETH 1',
          currencyAbbreviation: 'eth',
          credentials: {
            coin: 'eth',
            chain: 'eth',
            network: 'livenet',
          },
          snapshots: [],
        },
      ],
      currentRatesByRateKey: {
        eth: 2500,
      },
      quoteCurrency: 'USD',
    });
    mockBuildPnlAnalysisSeriesAsync.mockImplementation(
      async ({timeframe}: {timeframe: string}) => {
        switch (timeframe) {
          case '1D':
            return createMockAnalysisSeriesResult({
              timeframe,
              walletId: 'wallet-eth-1',
              baseBalance: 100,
            });
          case '1W':
            return oneWeekCompute.promise;
          case '1M':
            return oneMonthCompute.promise;
          default:
            throw new Error(`Unexpected timeframe ${timeframe}`);
        }
      },
    );

    const screen = render(
      <BalanceHistoryChart
        wallets={[ethWallet]}
        snapshotsByWalletId={{
          [ethWallet.id]: [ethSnapshot],
        }}
        quoteCurrency="USD"
        initialSelectedTimeframe="1D"
        fiatRateSeriesCache={{}}
        onChangeRowData={onChangeRowData}
      />,
    );

    await flushAsyncWork(6);

    expect(onChangeRowData).toHaveBeenLastCalledWith(
      expect.objectContaining({
        rangeLabel: 'Last Day',
      }),
    );

    fireEvent.press(screen.getByTestId('timeframe-1W'));
    await flushAsyncWork(2);

    fireEvent.press(screen.getByTestId('timeframe-1M'));
    await flushAsyncWork(2);

    expect(onChangeRowData).toHaveBeenLastCalledWith(
      expect.objectContaining({
        rangeLabel: 'Last Day',
      }),
    );

    oneWeekCompute.resolve(
      createMockAnalysisSeriesResult({
        timeframe: '1W',
        walletId: 'wallet-eth-1',
        baseBalance: 200,
      }),
    );
    await flushAsyncWork(4);

    expect(onChangeRowData).toHaveBeenLastCalledWith(
      expect.objectContaining({
        rangeLabel: 'Last Day',
      }),
    );

    oneMonthCompute.resolve(
      createMockAnalysisSeriesResult({
        timeframe: '1M',
        walletId: 'wallet-eth-1',
        baseBalance: 300,
      }),
    );
    await flushAsyncWork(4);

    expect(onChangeRowData).toHaveBeenLastCalledWith(
      expect.objectContaining({
        rangeLabel: 'Past Month',
      }),
    );
  });

  it('does not rerun analysis-input preparation on unrelated cache or snapshot writes', async () => {
    mockBuildPnlWalletInputsFromPortfolioSnapshotsAsync.mockResolvedValue({
      wallets: [],
      currentRatesByRateKey: {},
      quoteCurrency: 'USD',
    });
    const rates = {};

    const relevantSnapshots = [snapshot];
    const unrelatedSnapshotsA = [
      {
        ...snapshot,
        id: 'snapshot-2',
        walletId: 'wallet-2',
      },
    ] as BalanceSnapshot[];
    const unrelatedSnapshotsB = [
      {
        ...snapshot,
        id: 'snapshot-3',
        walletId: 'wallet-2',
      },
    ] as BalanceSnapshot[];

    const screen = render(
      <BalanceHistoryChart
        wallets={[wallet]}
        snapshotsByWalletId={{
          [wallet.id]: relevantSnapshots,
          'wallet-2': unrelatedSnapshotsA,
        }}
        quoteCurrency="USD"
        fiatRateSeriesCache={{
          'USD:eth:ALL': {
            fetchedOn: 100,
            points: [],
          },
        }}
        rates={rates}
      />,
    );

    await flushAsyncWork();

    expect(
      mockBuildPnlWalletInputsFromPortfolioSnapshotsAsync,
    ).toHaveBeenCalledTimes(1);

    screen.rerender(
      <BalanceHistoryChart
        wallets={[wallet]}
        snapshotsByWalletId={{
          [wallet.id]: relevantSnapshots,
          'wallet-2': unrelatedSnapshotsB,
        }}
        quoteCurrency="USD"
        fiatRateSeriesCache={{
          'USD:eth:ALL': {
            fetchedOn: 101,
            points: [],
          },
        }}
        rates={rates}
      />,
    );

    await flushAsyncWork();

    expect(
      mockBuildPnlWalletInputsFromPortfolioSnapshotsAsync,
    ).toHaveBeenCalledTimes(1);
  });

  it('reruns prep and selected-timeframe compute when a prep-only FX cache key changes', async () => {
    const ethWallet = {
      ...wallet,
      id: 'wallet-eth-1',
      chain: 'eth',
      currencyAbbreviation: 'eth',
      credentials: {
        coin: 'eth',
        chain: 'eth',
        network: 'livenet',
      },
    } as Wallet;
    const usdSnapshot = {
      ...snapshot,
      id: 'snapshot-eth-1',
      walletId: 'wallet-eth-1',
      chain: 'eth',
      coin: 'eth',
      assetId: 'eth:livenet',
      quoteCurrency: 'USD',
    } as BalanceSnapshot;
    const prepOnlyFxCacheKey = 'USD:btc:ALL';
    const stableChartRateCacheKey = 'EUR:eth:1D';

    mockBuildPnlWalletInputsFromPortfolioSnapshotsAsync.mockImplementation(
      async ({onHistoricalRateDependency}) => {
        onHistoricalRateDependency?.(prepOnlyFxCacheKey);
        return {
          wallets: [
            {
              walletId: 'wallet-eth-1',
              walletName: 'Wallet ETH 1',
              currencyAbbreviation: 'eth',
              credentials: {
                coin: 'eth',
                chain: 'eth',
                network: 'livenet',
              },
              snapshots: [],
            },
          ],
          currentRatesByRateKey: {
            eth: 2500,
          },
          quoteCurrency: 'EUR',
        };
      },
    );
    mockBuildPnlAnalysisSeriesAsync.mockResolvedValue({
      points: createMockAnalysisPoints(),
      timeframe: '1D',
      quoteCurrency: 'EUR',
      driverRateKey: 'eth',
      rateKeys: ['eth'],
      wallets: [],
      assetSummaries: [],
      totalSummary: {
        pnlStart: 80,
        pnlEnd: 100,
        pnlChange: 20,
        pnlPercent: 25,
      },
    });

    const screen = render(
      <BalanceHistoryChart
        wallets={[ethWallet]}
        snapshotsByWalletId={{
          [ethWallet.id]: [usdSnapshot],
        }}
        quoteCurrency="EUR"
        initialSelectedTimeframe="1D"
        fiatRateSeriesCache={{
          [prepOnlyFxCacheKey]: {
            fetchedOn: 100,
            points: [{ts: 1_000, rate: 1.1}],
          },
          [stableChartRateCacheKey]: {
            fetchedOn: 200,
            points: [{ts: 1_000, rate: 2_500}],
          },
        }}
      />,
    );

    await flushAsyncWork(6);

    expect(
      mockBuildPnlWalletInputsFromPortfolioSnapshotsAsync,
    ).toHaveBeenCalledTimes(1);
    expect(mockBuildPnlAnalysisSeriesAsync).toHaveBeenCalledTimes(1);

    screen.rerender(
      <BalanceHistoryChart
        wallets={[ethWallet]}
        snapshotsByWalletId={{
          [ethWallet.id]: [usdSnapshot],
        }}
        quoteCurrency="EUR"
        initialSelectedTimeframe="1D"
        fiatRateSeriesCache={{
          [prepOnlyFxCacheKey]: {
            fetchedOn: 101,
            points: [{ts: 2_000, rate: 1.2}],
          },
          [stableChartRateCacheKey]: {
            fetchedOn: 200,
            points: [{ts: 1_000, rate: 2_500}],
          },
        }}
      />,
    );

    await flushAsyncWork(6);

    expect(
      mockBuildPnlWalletInputsFromPortfolioSnapshotsAsync,
    ).toHaveBeenCalledTimes(2);
    expect(mockBuildPnlAnalysisSeriesAsync).toHaveBeenCalledTimes(2);
  });
});
