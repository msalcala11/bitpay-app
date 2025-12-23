import {
  createWorkletRuntime,
  runOnRuntime,
  scheduleOnRN,
  WorkletRuntime,
} from 'react-native-worklets';

import {buildWalletIntervalCursor} from './portfolio.cursor';
import {getPortfolioIntervalGrid} from './portfolio.grid';
import {
  PortfolioInterval,
  PortfolioTxEvent,
  WalletIntervalCursor,
} from './portfolio.types';

export type BuildWalletIntervalCursorsResult = {
  walletId: string;
  cursors: Partial<Record<PortfolioInterval, WalletIntervalCursor>>;
  built: number;
};

type BuildWalletIntervalCursorsRunner = (
  walletId: string,
  intervals: PortfolioInterval[],
  events: PortfolioTxEvent[],
  assetRateCache: Record<number, number> | undefined,
  nowMs: number,
  onComplete: (result: BuildWalletIntervalCursorsResult) => void,
  onError: (walletId: string, error: string) => void,
) => void;

let portfolioWorkletRuntime: WorkletRuntime | null = null;
let runBuildWalletIntervalCursors: BuildWalletIntervalCursorsRunner | null = null;
let portfolioWorkletRuntimeInitFailed = false;

const buildWalletIntervalCursorsWorklet = (
  walletId: string,
  intervals: PortfolioInterval[],
  events: PortfolioTxEvent[],
  assetRateCache: Record<number, number> | undefined,
  nowMs: number,
  onComplete: (result: BuildWalletIntervalCursorsResult) => void,
  onError: (walletId: string, error: string) => void,
) => {
  'worklet';
  try {
    if (!events?.length) {
      scheduleOnRN(onComplete, {walletId, cursors: {}, built: 0});
      return;
    }

    const sortedEvents = [...events].sort((a, b) => a.time - b.time);

    let firstReceiveTimeSec: number | undefined;
    let firstEventTimeSec: number | undefined;

    for (let i = 0; i < sortedEvents.length; i++) {
      const e = sortedEvents[i];
      if (firstEventTimeSec == null || e.time < firstEventTimeSec) {
        firstEventTimeSec = e.time;
      }
      if (e.category === 'receive') {
        if (firstReceiveTimeSec == null || e.time < firstReceiveTimeSec) {
          firstReceiveTimeSec = e.time;
        }
      }
    }

    const startTsForAll = firstReceiveTimeSec ?? firstEventTimeSec;

    const gridByInterval: Partial<
      Record<PortfolioInterval, ReturnType<typeof getPortfolioIntervalGrid>>
    > = {};

    for (let i = 0; i < intervals.length; i++) {
      const interval = intervals[i];
      gridByInterval[interval] = getPortfolioIntervalGrid(
        interval,
        nowMs,
        startTsForAll,
      );
    }

    const cursors: Partial<Record<PortfolioInterval, WalletIntervalCursor>> = {};
    let built = 0;

    for (let i = 0; i < intervals.length; i++) {
      const interval = intervals[i];
      const cursor = buildWalletIntervalCursor(
        walletId,
        interval,
        sortedEvents,
        assetRateCache,
        startTsForAll,
        {
          sortedEvents,
          grid: gridByInterval[interval],
        },
      );
      cursors[interval] = cursor;
      built++;
    }

    scheduleOnRN(onComplete, {walletId, cursors, built});
  } catch (e) {
    scheduleOnRN(onError, walletId, String(e));
  }
};

const getRunBuildWalletIntervalCursors = (): BuildWalletIntervalCursorsRunner => {
  if (portfolioWorkletRuntimeInitFailed) {
    throw new Error('Portfolio worklet runtime initialization failed');
  }

  try {
    if (!portfolioWorkletRuntime) {
      portfolioWorkletRuntime = createWorkletRuntime('portfolio');
    }
    if (!runBuildWalletIntervalCursors) {
      runBuildWalletIntervalCursors = runOnRuntime(
        portfolioWorkletRuntime,
        buildWalletIntervalCursorsWorklet,
      );
    }
    return runBuildWalletIntervalCursors;
  } catch (e) {
    portfolioWorkletRuntimeInitFailed = true;
    throw e instanceof Error ? e : new Error(String(e));
  }
};

export const buildWalletIntervalCursorsOnWorkletRuntime = (
  walletId: string,
  intervals: PortfolioInterval[],
  events: PortfolioTxEvent[],
  assetRateCache: Record<number, number> | undefined,
  nowMs: number,
): Promise<BuildWalletIntervalCursorsResult> =>
  new Promise((resolve, reject) => {
    const timeoutId: ReturnType<typeof setTimeout> = setTimeout(() => {
      reject(new Error('Portfolio worklet cursor build timed out'));
    }, 30000);

    try {
      const runOnPortfolioRuntime = getRunBuildWalletIntervalCursors();
      const onComplete = (result: BuildWalletIntervalCursorsResult) => {
        clearTimeout(timeoutId);
        resolve(result);
      };
      const onError = (_walletId: string, error: string) => {
        clearTimeout(timeoutId);
        reject(new Error(error));
      };

      runOnPortfolioRuntime(
        walletId,
        intervals,
        events,
        assetRateCache,
        nowMs,
        onComplete,
        onError,
      );
    } catch (e) {
      clearTimeout(timeoutId);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
