import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {InteractionManager} from 'react-native';
import {Network} from '../../constants';
import type {BalanceSnapshot} from '../../store/portfolio/portfolio.models';
import type {
  FiatRateInterval,
  FiatRateSeriesCache,
} from '../../store/rate/rate.models';
import {fetchFiatRateSeriesInterval} from '../../store/wallet/effects';
import type {Wallet} from '../../store/wallet/wallet.models';
import {
  buildWalletBalanceChartDataByInterval,
  DEFAULT_BALANCE_CHART_INTERVALS,
  defaultBalanceChartData,
  type BalanceChartData,
  type WalletBalanceChartDataByInterval,
} from '../assets';
import {
  getFiatRateSeriesIntervalForTimeframe,
  normalizeFiatRateSeriesCoin,
} from '../rate';
import {useAppDispatch} from './useAppDispatch';

type UseBalanceChartDataArgs = {
  wallets: Wallet[];
  snapshotsByWalletId: {[walletId: string]: BalanceSnapshot[] | undefined};
  fiatRateSeriesCache?: FiatRateSeriesCache;
  quoteCurrency?: string;
  intervals?: FiatRateInterval[];
  initialTimeframe?: FiatRateInterval;
  timeframe?: FiatRateInterval;
  onTimeframeChange?: (interval: FiatRateInterval) => void;
  deferUntilInteractions?: boolean;
};

type UseBalanceChartDataResult = {
  selectedTimeframe: FiatRateInterval;
  setSelectedTimeframe: (interval: FiatRateInterval) => void;
  dataByInterval: WalletBalanceChartDataByInterval;
  data: BalanceChartData;
  seriesIntervals: FiatRateInterval[];
};

export const useBalanceChartData = (
  args: UseBalanceChartDataArgs,
): UseBalanceChartDataResult => {
  const dispatch = useAppDispatch();
  const deferUntilInteractions = args.deferUntilInteractions !== false;
  const cacheRef = useRef<
    Partial<Record<FiatRateInterval, BalanceChartData>>
  >({});
  const cacheDepsRef = useRef({
    wallets: args.wallets,
    snapshotsByWalletId: args.snapshotsByWalletId,
    fiatRateSeriesCache: args.fiatRateSeriesCache,
    quoteCurrency: args.quoteCurrency,
  });
  const availableIntervals =
    args.intervals || DEFAULT_BALANCE_CHART_INTERVALS;
  const defaultTimeframe =
    args.initialTimeframe || availableIntervals[0] || 'ALL';
  const [internalTimeframe, setInternalTimeframe] =
    useState<FiatRateInterval>(defaultTimeframe);
  const selectedTimeframe = args.timeframe || internalTimeframe;
  const setSelectedTimeframe = useCallback(
    (interval: FiatRateInterval) => {
      if (args.timeframe) {
        args.onTimeframeChange?.(interval);
        return;
      }
      setInternalTimeframe(interval);
    },
    [args.onTimeframeChange, args.timeframe],
  );
  const [isReady, setIsReady] = useState(!deferUntilInteractions);
  const hasDeferredRef = useRef(false);

  useEffect(() => {
    if (!deferUntilInteractions) {
      setIsReady(true);
      return;
    }
    if (hasDeferredRef.current || isReady) {
      return;
    }
    hasDeferredRef.current = true;
    const task = InteractionManager.runAfterInteractions(() => {
      setIsReady(true);
    });
    return () => {
      task.cancel();
    };
  }, [deferUntilInteractions, isReady]);

  const nowMs = useMemo(() => Date.now(), [
    args.wallets,
    args.snapshotsByWalletId,
    args.fiatRateSeriesCache,
    args.quoteCurrency,
    selectedTimeframe,
  ]);

  const dataByInterval = useMemo(() => {
    if (!isReady) {
      return {[selectedTimeframe]: defaultBalanceChartData};
    }

    const prevDeps = cacheDepsRef.current;
    const depsChanged =
      prevDeps.wallets !== args.wallets ||
      prevDeps.snapshotsByWalletId !== args.snapshotsByWalletId ||
      prevDeps.fiatRateSeriesCache !== args.fiatRateSeriesCache ||
      prevDeps.quoteCurrency !== args.quoteCurrency;

    if (depsChanged) {
      cacheRef.current = {};
      cacheDepsRef.current = {
        wallets: args.wallets,
        snapshotsByWalletId: args.snapshotsByWalletId,
        fiatRateSeriesCache: args.fiatRateSeriesCache,
        quoteCurrency: args.quoteCurrency,
      };
    }

    const cached = cacheRef.current[selectedTimeframe];
    if (cached) {
      return {[selectedTimeframe]: cached};
    }

    const startMs = __DEV__ ? Date.now() : 0;
    const result = buildWalletBalanceChartDataByInterval({
      wallets: args.wallets,
      snapshotsByWalletId: args.snapshotsByWalletId,
      fiatRateSeriesCache: args.fiatRateSeriesCache,
      quoteCurrency: args.quoteCurrency,
      intervals: [selectedTimeframe],
      nowMs,
    });

    if (__DEV__) {
      const durationMs = Date.now() - startMs;
      if (durationMs > 100) {
        console.info(
          '[BalanceChart] buildWalletBalanceChartDataByInterval',
          {
            durationMs,
            timeframe: selectedTimeframe,
            wallets: args.wallets?.length || 0,
          },
        );
      }
    }

    const computed = result[selectedTimeframe] || defaultBalanceChartData;
    cacheRef.current[selectedTimeframe] = computed;
    return {[selectedTimeframe]: computed};
  }, [
    args.fiatRateSeriesCache,
    args.quoteCurrency,
    args.snapshotsByWalletId,
    args.wallets,
    isReady,
    nowMs,
    selectedTimeframe,
  ]);

  const data = dataByInterval[selectedTimeframe] || defaultBalanceChartData;

  const seriesIntervals = useMemo(() => {
    return [getFiatRateSeriesIntervalForTimeframe(selectedTimeframe)];
  }, [selectedTimeframe]);

  const walletCoins = useMemo(() => {
    const coins = new Set<string>();
    for (const wallet of args.wallets || []) {
      if (!wallet?.currencyAbbreviation || wallet.network !== Network.mainnet) {
        continue;
      }
      const coin = normalizeFiatRateSeriesCoin(wallet.currencyAbbreviation);
      if (coin) {
        coins.add(coin);
      }
    }
    return Array.from(coins).sort();
  }, [args.wallets]);

  useEffect(() => {
    if (!walletCoins.length) {
      return;
    }
    const quoteCurrency = (args.quoteCurrency || 'USD').toUpperCase();
    if (!quoteCurrency) {
      return;
    }

    walletCoins.forEach(coin => {
      seriesIntervals.forEach(interval => {
        dispatch(
          fetchFiatRateSeriesInterval({
            fiatCode: quoteCurrency,
            interval,
            coinForCacheCheck: coin,
          }) as any,
        );
      });
    });
  }, [dispatch, seriesIntervals, walletCoins, args.quoteCurrency]);

  useEffect(() => {
    if (args.timeframe) {
      return;
    }
    if (availableIntervals.includes(internalTimeframe)) {
      return;
    }
    setInternalTimeframe(defaultTimeframe);
  }, [availableIntervals, defaultTimeframe, internalTimeframe, args.timeframe]);

  return {
    selectedTimeframe,
    setSelectedTimeframe,
    dataByInterval,
    data,
    seriesIntervals,
  };
};
