import React, {useCallback, useMemo, useRef, useState} from 'react';
import {
  InteractionManager,
  Platform,
  Pressable,
  ScrollView,
  View,
} from 'react-native';
import styled from 'styled-components/native';
import {useTranslation} from 'react-i18next';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {AboutGroupParamList, AboutScreens} from '../AboutGroup';
import {useAppSelector} from '../../../../../utils/hooks';
import type {FiatRateInterval} from '../../../../../store/rate/rate.models';
import {
  getFiatRateSeriesCacheKey,
  type FiatRateSeriesCache,
} from '../../../../../store/rate/rate.models';
import type {Wallet, Key} from '../../../../../store/wallet/wallet.models';
import type {BalanceSnapshot} from '../../../../../store/portfolio/portfolio.models';
import {Network} from '../../../../../constants';
import {
  getFiatRateSeriesIntervalForTimeframe,
  normalizeFiatRateSeriesCoin,
} from '../../../../../utils/rate';
import {
  buildAggregatedFiatBalanceSeries,
  type FiatBalancePoint,
} from '../../../../../utils/fiat-balance-series';
import {logManager} from '../../../../../managers/LogManager';
import {
  DebugButtonRow,
  DebugButtonSpacer,
  DebugHeaderContainer,
  DebugHeaderText,
  DebugPillButton,
  DebugPillButtonText,
  DebugScreenContainer,
} from '../components/DebugUI';

type FiatBalanceSeriesDebugScreenProps = NativeStackScreenProps<
  AboutGroupParamList,
  AboutScreens.FIAT_BALANCE_SERIES_DEBUG
>;

type Scope = 'all' | 'key' | 'asset' | 'wallet';

type BenchmarkResult = {
  id: string;
  createdAt: number;
  scope: Scope;
  selectionLabel: string;
  timeframe: FiatRateInterval;
  fiatCode: string;
  wallets: number;
  coins: number;
  snapshots: number;
  points: number;
  warmupMs?: number;
  runs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  timesMs: number[];
  firstPoint?: FiatBalancePoint;
  lastPoint?: FiatBalancePoint;
  missingRateCoins?: string[];
  error?: string;
};

const Row = styled(Pressable)<{selected?: boolean}>`
  padding: 12px;
  border-top-width: 1px;
  border-top-color: ${({theme}) => theme.colors.border};
`;

const RowTitle = styled.Text`
  color: ${({theme}) => theme.colors.text};
  font-size: 14px;
  line-height: 18px;
`;

const RowSubTitle = styled.Text`
  color: ${({theme}) => theme.colors.text};
  font-size: 12px;
  line-height: 16px;
  opacity: 0.7;
`;

const MonoText = styled.Text`
  padding: 12px;
  font-size: 12px;
  line-height: 16px;
  font-family: ${Platform.OS === 'ios' ? 'Menlo' : 'monospace'};
  color: ${({theme}) => theme.colors.text};
`;

const getPerfNowMs = (): number => {
  // RN supports global.performance in most modern runtimes (e.g. Hermes),
  // but we fall back to Date.now() safely.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const perf: any = (global as any)?.performance;
  if (perf && typeof perf.now === 'function') {
    return perf.now();
  }
  return Date.now();
};

const buildWalletSelectionLabel = (args: {
  scope: Scope;
  key?: Key;
  asset?: string;
  wallet?: Wallet;
}): string => {
  switch (args.scope) {
    case 'key':
      return args.key?.keyName
        ? `key:${args.key.keyName}`
        : args.key?.id
        ? `key:${args.key.id}`
        : 'key:unknown';
    case 'asset':
      return args.asset ? `asset:${args.asset.toUpperCase()}` : 'asset:unknown';
    case 'wallet':
      return args.wallet?.walletName
        ? `wallet:${args.wallet.walletName}`
        : args.wallet?.id
        ? `wallet:${args.wallet.id}`
        : 'wallet:unknown';
    case 'all':
    default:
      return 'all-wallets';
  }
};

const getWalletsFromKey = (key: Key | undefined): Wallet[] => {
  const wallets = Array.isArray(key?.wallets) ? key!.wallets : [];
  return wallets as Wallet[];
};

const isWalletIncluded = (args: {
  wallet: Wallet;
  includeHidden: boolean;
  includeTestnet: boolean;
}): boolean => {
  const w = args.wallet;
  if (!w) {
    return false;
  }
  if (!args.includeHidden && (w.hideWallet || w.hideWalletByAccount)) {
    return false;
  }
  if (!args.includeTestnet && w.network !== Network.mainnet) {
    return false;
  }
  return true;
};

const computeWalletStats = (args: {
  wallets: Wallet[];
  snapshotsByWalletId: {[walletId: string]: BalanceSnapshot[] | undefined};
  fiatRateSeriesCache: FiatRateSeriesCache | undefined;
  fiatCode: string;
  timeframe: FiatRateInterval;
}): {
  coins: string[];
  snapshotCount: number;
  missingRateCoins: string[];
} => {
  const coinSet = new Set<string>();
  let snapshotCount = 0;

  for (const w of args.wallets) {
    const wid = (w as any)?.id as string | undefined;
    if (wid) {
      const snaps = args.snapshotsByWalletId?.[wid];
      snapshotCount += Array.isArray(snaps) ? snaps.length : 0;
    }

    const coin = normalizeFiatRateSeriesCoin(
      (w as any)?.currencyAbbreviation as string | undefined,
    );
    if (coin) {
      coinSet.add(coin);
    }
  }

  const coins = Array.from(coinSet).sort((a, b) => a.localeCompare(b));
  const missingRateCoins: string[] = [];

  const seriesInterval = getFiatRateSeriesIntervalForTimeframe(args.timeframe);
  const fiatCode = (args.fiatCode || '').toUpperCase();

  for (const coin of coins) {
    const cacheKey = getFiatRateSeriesCacheKey(fiatCode, coin, seriesInterval);
    const series = args.fiatRateSeriesCache?.[cacheKey];
    const hasPoints = Array.isArray(series?.points) && series!.points.length > 0;
    if (!hasPoints) {
      missingRateCoins.push(coin);
    }
  }

  return {coins, snapshotCount, missingRateCoins};
};

const FiatBalanceSeriesDebug = ({}: FiatBalanceSeriesDebugScreenProps) => {
  const {t} = useTranslation();

  const fiatCode = useAppSelector(({APP}) => APP?.defaultAltCurrency?.isoCode) || 'USD';
  const keysById = useAppSelector(({WALLET}) => WALLET?.keys || {});
  const snapshotsByWalletId = useAppSelector(
    ({PORTFOLIO}) => PORTFOLIO?.snapshotsByWalletId || {},
  );
  const fiatRateSeriesCache = useAppSelector(
    ({RATE}) => RATE?.fiatRateSeriesCache,
  );

  const intervals: FiatRateInterval[] = useMemo(
    () => ['ALL', '1D', '1W', '1M', '3M', '1Y', '5Y'],
    [],
  );

  const [timeframe, setTimeframe] = useState<FiatRateInterval>('1M');
  const [scope, setScope] = useState<Scope>('all');
  const [includeHidden, setIncludeHidden] = useState<boolean>(false);
  const [includeTestnet, setIncludeTestnet] = useState<boolean>(false);
  const [selectedKeyId, setSelectedKeyId] = useState<string | undefined>();
  const [selectedAsset, setSelectedAsset] = useState<string | undefined>();
  const [selectedWalletId, setSelectedWalletId] = useState<string | undefined>();

  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [results, setResults] = useState<BenchmarkResult[]>([]);

  const lastTaskRef = useRef<{cancel: () => void} | null>(null);

  const allKeys: Key[] = useMemo(() => {
    const list = Object.values(keysById || {}) as Key[];
    list.sort((a, b) => {
      const an = (a?.keyName || a?.id || '').toLowerCase();
      const bn = (b?.keyName || b?.id || '').toLowerCase();
      return an.localeCompare(bn);
    });
    return list;
  }, [keysById]);

  const allWallets: Wallet[] = useMemo(() => {
    const wallets: Wallet[] = [];
    for (const key of allKeys) {
      for (const w of getWalletsFromKey(key)) {
        if (isWalletIncluded({wallet: w, includeHidden, includeTestnet})) {
          wallets.push(w);
        }
      }
    }

    wallets.sort((a, b) => {
      const an = ((a as any)?.walletName || (a as any)?.id || '').toLowerCase();
      const bn = ((b as any)?.walletName || (b as any)?.id || '').toLowerCase();
      return an.localeCompare(bn);
    });
    return wallets;
  }, [allKeys, includeHidden, includeTestnet]);

  const walletsById: Record<string, Wallet> = useMemo(() => {
    const map: Record<string, Wallet> = {};
    for (const w of allWallets) {
      if ((w as any)?.id) {
        map[(w as any).id] = w;
      }
    }
    return map;
  }, [allWallets]);

  const walletsByKeyId: Record<string, Wallet[]> = useMemo(() => {
    const map: Record<string, Wallet[]> = {};
    for (const key of allKeys) {
      const keyWallets = getWalletsFromKey(key).filter(w =>
        isWalletIncluded({wallet: w, includeHidden, includeTestnet}),
      );
      map[key.id] = keyWallets;
    }
    return map;
  }, [allKeys, includeHidden, includeTestnet]);

  const assets: Array<{coin: string; wallets: Wallet[]}> = useMemo(() => {
    const map = new Map<string, Wallet[]>();
    for (const w of allWallets) {
      const coin = normalizeFiatRateSeriesCoin(
        (w as any)?.currencyAbbreviation as string | undefined,
      );
      if (!coin) {
        continue;
      }
      const list = map.get(coin);
      if (list) {
        list.push(w);
      } else {
        map.set(coin, [w]);
      }
    }
    const out = Array.from(map.entries())
      .map(([coin, wallets]) => ({coin, wallets}))
      .sort((a, b) => b.wallets.length - a.wallets.length || a.coin.localeCompare(b.coin));
    return out;
  }, [allWallets]);

  // Ensure defaults are set once data loads.
  React.useEffect(() => {
    if (!selectedKeyId && allKeys.length) {
      setSelectedKeyId(allKeys[0].id);
    }
  }, [allKeys, selectedKeyId]);

  React.useEffect(() => {
    if (!selectedAsset && assets.length) {
      setSelectedAsset(assets[0].coin);
    }
  }, [assets, selectedAsset]);

  React.useEffect(() => {
    if (!selectedWalletId && allWallets.length) {
      setSelectedWalletId((allWallets[0] as any)?.id);
    }
  }, [allWallets, selectedWalletId]);

  const selectedKey = useMemo(
    () => allKeys.find(k => k.id === selectedKeyId),
    [allKeys, selectedKeyId],
  );

  const selectedWallet = useMemo(
    () => (selectedWalletId ? walletsById[selectedWalletId] : undefined),
    [selectedWalletId, walletsById],
  );

  const selectedAssetWallets = useMemo(() => {
    if (!selectedAsset) {
      return [];
    }
    const entry = assets.find(a => a.coin === selectedAsset);
    return entry?.wallets || [];
  }, [assets, selectedAsset]);

  const selectionWallets: Wallet[] = useMemo(() => {
    switch (scope) {
      case 'key':
        return selectedKeyId ? walletsByKeyId[selectedKeyId] || [] : [];
      case 'asset':
        return selectedAssetWallets;
      case 'wallet':
        return selectedWallet ? [selectedWallet] : [];
      case 'all':
      default:
        return allWallets;
    }
  }, [scope, selectedKeyId, walletsByKeyId, selectedAssetWallets, selectedWallet, allWallets]);

  const selectionLabel = useMemo(
    () =>
      buildWalletSelectionLabel({
        scope,
        key: selectedKey,
        asset: selectedAsset,
        wallet: selectedWallet,
      }),
    [scope, selectedKey, selectedAsset, selectedWallet],
  );

  const selectionStats = useMemo(() => {
    return computeWalletStats({
      wallets: selectionWallets,
      snapshotsByWalletId,
      fiatRateSeriesCache,
      fiatCode,
      timeframe,
    });
  }, [selectionWallets, snapshotsByWalletId, fiatRateSeriesCache, fiatCode, timeframe]);

  const cancelPendingTask = useCallback(() => {
    if (lastTaskRef.current) {
      try {
        lastTaskRef.current.cancel();
      } catch (_) {}
      lastTaskRef.current = null;
    }
  }, []);

  React.useEffect(() => {
    return () => {
      cancelPendingTask();
    };
  }, [cancelPendingTask]);

  const clearResults = useCallback(() => {
    if (isRunning) {
      return;
    }
    setResults([]);
  }, [isRunning]);

  const runBenchmarkOnce = useCallback(
    (args: {timeframe: FiatRateInterval; runs: number}) => {
      if (isRunning) {
        return;
      }

      cancelPendingTask();
      setIsRunning(true);

      const task = InteractionManager.runAfterInteractions(() => {
        try {
          const wallets = selectionWallets;
          const runs = Math.max(1, Math.trunc(args.runs));

          const {coins, snapshotCount, missingRateCoins} = computeWalletStats({
            wallets,
            snapshotsByWalletId,
            fiatRateSeriesCache,
            fiatCode,
            timeframe: args.timeframe,
          });

          // Warm-up run (not measured) to reduce noise.
          let warmupMs: number | undefined;
          try {
            const w0 = getPerfNowMs();
            buildAggregatedFiatBalanceSeries({
              wallets,
              snapshotsByWalletId,
              fiatRateSeriesCache,
              fiatCode,
              timeframe: args.timeframe,
              nowMs: Date.now(),
              targetLen: 91,
            });
            const w1 = getPerfNowMs();
            warmupMs = Math.max(0, w1 - w0);
          } catch (_) {
            warmupMs = undefined;
          }

          const times: number[] = [];
          let lastPoints: FiatBalancePoint[] = [];

          for (let i = 0; i < runs; i++) {
            const t0 = getPerfNowMs();
            lastPoints = buildAggregatedFiatBalanceSeries({
              wallets,
              snapshotsByWalletId,
              fiatRateSeriesCache,
              fiatCode,
              timeframe: args.timeframe,
              nowMs: Date.now(),
              targetLen: 91,
            });
            const t1 = getPerfNowMs();
            times.push(Math.max(0, t1 - t0));
          }

          const avgMs = times.reduce((a, b) => a + b, 0) / times.length;
          const minMs = times.reduce((m, v) => (v < m ? v : m), times[0]);
          const maxMs = times.reduce((m, v) => (v > m ? v : m), times[0]);

          const result: BenchmarkResult = {
            id: `${Date.now()}`,
            createdAt: Date.now(),
            scope,
            selectionLabel,
            timeframe: args.timeframe,
            fiatCode: (fiatCode || 'USD').toUpperCase(),
            wallets: wallets.length,
            coins: coins.length,
            snapshots: snapshotCount,
            points: lastPoints.length,
            warmupMs,
            runs,
            avgMs,
            minMs,
            maxMs,
            timesMs: times,
            firstPoint: lastPoints[0],
            lastPoint: lastPoints[lastPoints.length - 1],
            missingRateCoins: missingRateCoins.length ? missingRateCoins : undefined,
          };

          setResults(prev => [result, ...prev]);

          logManager.debug(
            '[FiatBalanceSeriesBench]',
            `selection=${result.selectionLabel}`,
            `scope=${result.scope}`,
            `timeframe=${result.timeframe}`,
            `fiat=${result.fiatCode}`,
            `wallets=${result.wallets}`,
            `coins=${result.coins}`,
            `snapshots=${result.snapshots}`,
            `points=${result.points}`,
            `avgMs=${result.avgMs.toFixed(2)}`,
            `minMs=${result.minMs.toFixed(2)}`,
            `maxMs=${result.maxMs.toFixed(2)}`,
          );

          if (result.missingRateCoins?.length) {
            logManager.warn(
              '[FiatBalanceSeriesBench]',
              `missingRateCoins=${result.missingRateCoins.join(',')}`,
            );
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          const result: BenchmarkResult = {
            id: `${Date.now()}`,
            createdAt: Date.now(),
            scope,
            selectionLabel,
            timeframe: args.timeframe,
            fiatCode: (fiatCode || 'USD').toUpperCase(),
            wallets: selectionWallets.length,
            coins: selectionStats.coins.length,
            snapshots: selectionStats.snapshotCount,
            points: 0,
            runs: args.runs,
            avgMs: 0,
            minMs: 0,
            maxMs: 0,
            timesMs: [],
            error: message,
          };

          setResults(prev => [result, ...prev]);
          logManager.error('[FiatBalanceSeriesBench]', message);
        } finally {
          setIsRunning(false);
        }
      });

      lastTaskRef.current = task;
    },
    [
      isRunning,
      cancelPendingTask,
      selectionWallets,
      snapshotsByWalletId,
      fiatRateSeriesCache,
      fiatCode,
      scope,
      selectionLabel,
      selectionStats,
    ],
  );

  const runAllIntervalsOnce = useCallback(
    (args: {runs: number}) => {
      if (isRunning) {
        return;
      }

      cancelPendingTask();
      setIsRunning(true);

      const task = InteractionManager.runAfterInteractions(() => {
        try {
          const wallets = selectionWallets;
          const runs = Math.max(1, Math.trunc(args.runs));

          const batchResults: BenchmarkResult[] = [];

          for (const tf of intervals) {
            const {coins, snapshotCount, missingRateCoins} = computeWalletStats({
              wallets,
              snapshotsByWalletId,
              fiatRateSeriesCache,
              fiatCode,
              timeframe: tf,
            });

            // Warm-up (not measured)
            let warmupMs: number | undefined;
            try {
              const w0 = getPerfNowMs();
              buildAggregatedFiatBalanceSeries({
                wallets,
                snapshotsByWalletId,
                fiatRateSeriesCache,
                fiatCode,
                timeframe: tf,
                nowMs: Date.now(),
                targetLen: 91,
              });
              warmupMs = Math.max(0, getPerfNowMs() - w0);
            } catch (_) {
              warmupMs = undefined;
            }

            const times: number[] = [];
            let lastPoints: FiatBalancePoint[] = [];

            for (let i = 0; i < runs; i++) {
              const t0 = getPerfNowMs();
              lastPoints = buildAggregatedFiatBalanceSeries({
                wallets,
                snapshotsByWalletId,
                fiatRateSeriesCache,
                fiatCode,
                timeframe: tf,
                nowMs: Date.now(),
                targetLen: 91,
              });
              const t1 = getPerfNowMs();
              times.push(Math.max(0, t1 - t0));
            }

            const avgMs = times.reduce((a, b) => a + b, 0) / times.length;
            const minMs = times.reduce((m, v) => (v < m ? v : m), times[0]);
            const maxMs = times.reduce((m, v) => (v > m ? v : m), times[0]);

            const result: BenchmarkResult = {
              id: `${Date.now()}-${tf}`,
              createdAt: Date.now(),
              scope,
              selectionLabel,
              timeframe: tf,
              fiatCode: (fiatCode || 'USD').toUpperCase(),
              wallets: wallets.length,
              coins: coins.length,
              snapshots: snapshotCount,
              points: lastPoints.length,
              warmupMs,
              runs,
              avgMs,
              minMs,
              maxMs,
              timesMs: times,
              firstPoint: lastPoints[0],
              lastPoint: lastPoints[lastPoints.length - 1],
              missingRateCoins: missingRateCoins.length ? missingRateCoins : undefined,
            };
            batchResults.push(result);

            logManager.debug(
              '[FiatBalanceSeriesBench]',
              `selection=${result.selectionLabel}`,
              `scope=${result.scope}`,
              `timeframe=${result.timeframe}`,
              `wallets=${result.wallets}`,
              `coins=${result.coins}`,
              `snapshots=${result.snapshots}`,
              `points=${result.points}`,
              `avgMs=${result.avgMs.toFixed(2)}`,
            );
          }

          setResults(prev => [...batchResults.reverse(), ...prev]);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          logManager.error('[FiatBalanceSeriesBench]', message);
        } finally {
          setIsRunning(false);
        }
      });

      lastTaskRef.current = task;
    },
    [
      isRunning,
      cancelPendingTask,
      selectionWallets,
      intervals,
      snapshotsByWalletId,
      fiatRateSeriesCache,
      fiatCode,
      scope,
      selectionLabel,
    ],
  );

  const jsonResults = useMemo(() => {
    try {
      return JSON.stringify(
        {
          selection: {
            scope,
            label: selectionLabel,
            timeframe,
            fiatCode: (fiatCode || 'USD').toUpperCase(),
            includeHidden,
            includeTestnet,
            walletCount: selectionWallets.length,
            coins: selectionStats.coins,
            snapshots: selectionStats.snapshotCount,
            missingRateCoins: selectionStats.missingRateCoins,
          },
          results,
        },
        null,
        2,
      );
    } catch (e) {
      return String(e);
    }
  }, [
    scope,
    selectionLabel,
    timeframe,
    fiatCode,
    includeHidden,
    includeTestnet,
    selectionWallets.length,
    selectionStats,
    results,
  ]);

  const displayJson = useMemo(() => {
    const limit = 220000;
    if (jsonResults.length > limit) {
      return (
        jsonResults.slice(0, limit) +
        `\n...TRUNCATED (${jsonResults.length} chars)`
      );
    }
    return jsonResults;
  }, [jsonResults]);

  return (
    <DebugScreenContainer>
      <DebugHeaderContainer>
        <DebugHeaderText>
          {t('Fiat Balance Series Benchmark')}
          {isRunning ? ` (${t('running')}...)` : ''}
        </DebugHeaderText>
        <DebugHeaderText>
          selection: {selectionLabel} | wallets: {selectionWallets.length} | coins:{' '}
          {selectionStats.coins.length} | snapshots: {selectionStats.snapshotCount} | fiat:{' '}
          {(fiatCode || 'USD').toUpperCase()} | timeframe: {timeframe}
        </DebugHeaderText>

        {selectionStats.missingRateCoins.length ? (
          <DebugHeaderText>
            missing rates ({selectionStats.missingRateCoins.length}):{' '}
            {selectionStats.missingRateCoins.join(', ')}
          </DebugHeaderText>
        ) : null}

        <DebugButtonRow>
          <DebugPillButton
            selected={scope === 'all'}
            onPress={() => setScope('all')}>
            <DebugPillButtonText selected={scope === 'all'}>
              {t('All')}
            </DebugPillButtonText>
          </DebugPillButton>
          <DebugPillButton
            selected={scope === 'key'}
            onPress={() => setScope('key')}>
            <DebugPillButtonText selected={scope === 'key'}>
              {t('Key')}
            </DebugPillButtonText>
          </DebugPillButton>
          <DebugPillButton
            selected={scope === 'asset'}
            onPress={() => setScope('asset')}>
            <DebugPillButtonText selected={scope === 'asset'}>
              {t('Asset')}
            </DebugPillButtonText>
          </DebugPillButton>
          <DebugPillButton
            selected={scope === 'wallet'}
            onPress={() => setScope('wallet')}>
            <DebugPillButtonText selected={scope === 'wallet'}>
              {t('Wallet')}
            </DebugPillButtonText>
          </DebugPillButton>
        </DebugButtonRow>

        <DebugButtonRow>
          <DebugPillButton
            selected={includeHidden}
            onPress={() => setIncludeHidden(v => !v)}>
            <DebugPillButtonText selected={includeHidden}>
              {t('Include hidden')}
            </DebugPillButtonText>
          </DebugPillButton>

          <DebugPillButton
            selected={includeTestnet}
            onPress={() => setIncludeTestnet(v => !v)}>
            <DebugPillButtonText selected={includeTestnet}>
              {t('Include testnet')}
            </DebugPillButtonText>
          </DebugPillButton>
        </DebugButtonRow>

        <DebugButtonRow>
          <DebugPillButton
            onPress={() =>
              isRunning ? null : runBenchmarkOnce({timeframe, runs: 1})
            }>
            <DebugPillButtonText>{t('Run')}</DebugPillButtonText>
          </DebugPillButton>
          <DebugButtonSpacer />
          <DebugPillButton
            onPress={() =>
              isRunning ? null : runBenchmarkOnce({timeframe, runs: 5})
            }>
            <DebugPillButtonText>{t('Run x5')}</DebugPillButtonText>
          </DebugPillButton>
          <DebugButtonSpacer />
          <DebugPillButton
            onPress={() => (isRunning ? null : runAllIntervalsOnce({runs: 1}))}>
            <DebugPillButtonText>{t('Run ALL intervals')}</DebugPillButtonText>
          </DebugPillButton>
          <DebugButtonSpacer />
          <DebugPillButton onPress={() => (isRunning ? null : clearResults())}>
            <DebugPillButtonText>{t('Clear')}</DebugPillButtonText>
          </DebugPillButton>
        </DebugButtonRow>

        <DebugButtonRow>
          {intervals.map(i => (
            <DebugPillButton
              key={i}
              selected={timeframe === i}
              onPress={() => setTimeframe(i)}>
              <DebugPillButtonText selected={timeframe === i}>
                {i}
              </DebugPillButtonText>
            </DebugPillButton>
          ))}
        </DebugButtonRow>

        {scope === 'all' ? null : (
          <View style={{marginTop: 10}}>
            <DebugHeaderText>
              {t('Select')} {scope === 'key' ? t('Key') : scope === 'asset' ? t('Asset') : t('Wallet')}:
            </DebugHeaderText>
          </View>
        )}
      </DebugHeaderContainer>

      <ScrollView style={{flex: 1}} contentContainerStyle={{paddingBottom: 60}}>
        {scope === 'key'
          ? allKeys.map(k => {
              const keyWalletCount = walletsByKeyId[k.id]?.length ?? 0;
              const selected = k.id === selectedKeyId;
              return (
                <Row
                  key={k.id}
                  selected={selected}
                  onPress={() => setSelectedKeyId(k.id)}>
                  <RowTitle>{k.keyName || k.id}</RowTitle>
                  <RowSubTitle>
                    id: {k.id} | wallets: {keyWalletCount}
                  </RowSubTitle>
                </Row>
              );
            })
          : null}

        {scope === 'asset'
          ? assets.map(a => {
              const selected = a.coin === selectedAsset;
              return (
                <Row
                  key={a.coin}
                  selected={selected}
                  onPress={() => setSelectedAsset(a.coin)}>
                  <RowTitle>{a.coin.toUpperCase()}</RowTitle>
                  <RowSubTitle>wallets: {a.wallets.length}</RowSubTitle>
                </Row>
              );
            })
          : null}

        {scope === 'wallet'
          ? allWallets.map(w => {
              const id = (w as any)?.id as string | undefined;
              if (!id) {
                return null;
              }
              const selected = id === selectedWalletId;
              return (
                <Row
                  key={id}
                  selected={selected}
                  onPress={() => setSelectedWalletId(id)}>
                  <RowTitle>
                    {(w as any)?.walletName || id} ({(w as any)?.currencyAbbreviation?.toUpperCase?.() || '?'})
                  </RowTitle>
                  <RowSubTitle>
                    id: {id} | chain: {(w as any)?.chain} | keyId: {(w as any)?.keyId}
                  </RowSubTitle>
                </Row>
              );
            })
          : null}

        <MonoText selectable>{displayJson}</MonoText>
      </ScrollView>
    </DebugScreenContainer>
  );
};

export default FiatBalanceSeriesDebug;
