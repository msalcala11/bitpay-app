import React from 'react';
import {act, cleanup, render} from '@testing-library/react-native';
import type {BalanceSnapshot} from '../../store/portfolio/portfolio.models';
import type {Wallet} from '../../store/wallet/wallet.models';
import BalanceHistoryChart from './BalanceHistoryChart';

const mockBuildPnlAnalysisSeriesAsync = jest.fn();
const mockBuildPnlCurrentRatesByCoinFromPortfolioSnapshots = jest.fn(
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
    buildBalanceChartTimeframeRevision: ({timeframe}: {timeframe: string}) =>
      `revision:${timeframe}`,
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
  buildPnlCurrentRatesByCoinFromPortfolioSnapshots: (...args: unknown[]) =>
    mockBuildPnlCurrentRatesByCoinFromPortfolioSnapshots.apply(undefined, args),
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

jest.mock('./TimeframeSelector', () => () => null);
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

const flushAsyncWork = async (iterations = 4) => {
  for (let i = 0; i < iterations; i += 1) {
    await act(async () => {
      jest.runOnlyPendingTimers();
      await Promise.resolve();
    });
  }
};

describe('BalanceHistoryChart', () => {
  beforeEach(() => {
    jest.useFakeTimers();
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

  it('preserves SVM token address case in fiat-rate fetch requests', async () => {
    mockBuildPnlWalletInputsFromPortfolioSnapshotsAsync.mockResolvedValue({
      wallets: [],
      currentRatesByCoin: {},
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

  it('does not rerun analysis-input preparation on unrelated cache or snapshot writes', async () => {
    mockBuildPnlWalletInputsFromPortfolioSnapshotsAsync.mockResolvedValue({
      wallets: [],
      currentRatesByCoin: {},
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
      />,
    );

    await flushAsyncWork();

    screen.rerender(
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

    expect(mockBuildPnlWalletInputsFromPortfolioSnapshotsAsync).toHaveBeenCalledTimes(
      1,
    );

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

    expect(mockBuildPnlWalletInputsFromPortfolioSnapshotsAsync).toHaveBeenCalledTimes(
      1,
    );
  });
});
