import React, {useMemo, useState} from 'react';
import {InteractionManager, View} from 'react-native';
import styled from 'styled-components/native';
import {SettingsContainer} from '../../SettingsRoot';
import {
  Hr,
  ScreenGutter,
  Setting,
  SettingTitle,
} from '../../../../../components/styled/Containers';
import Button from '../../../../../components/button/Button';
import {useTranslation} from 'react-i18next';
import {Black, Feather, LightBlack, White} from '../../../../../styles/colors';
import {useAppDispatch, useAppSelector} from '../../../../../utils/hooks';
import {logManager} from '../../../../../managers/LogManager';
import {LogLevel} from '../../../../../store/log/log.models';
import {Keys} from '../../../../../store/wallet/wallet.reducer';
import Clipboard from '@react-native-clipboard/clipboard';
import {
  buildCursorForWalletInterval,
  buildAllCursors,
  clearRateCacheUsd,
  resetPortfolio,
  syncPortfolioTxEventsForWallet,
  setWalletIntervalCursors,
  buildWalletIntervalCursor,
} from '../../../../../store/portfolio';
import {getPortfolioIntervalGrid} from '../../../../../store/portfolio/portfolio.grid';
import {useNavigation} from '@react-navigation/native';
import {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {AboutGroupParamList, AboutScreens} from '../AboutGroup';
import {
  PortfolioInterval,
  PortfolioTxEvent,
  WalletIntervalCursor,
} from '../../../../../store/portfolio/portfolio.types';

const ScrollContainer = styled.ScrollView``;

const HeaderTitle = styled(Setting)`
  margin-top: 20px;
  background-color: ${({theme: {dark}}) => (dark ? LightBlack : Feather)};
  padding: 0 ${ScreenGutter};
  border-bottom-width: 1px;
  border-bottom-color: ${({theme: {dark}}) => (dark ? Black : White)};
`;

const formatBytes = (bytes: number, decimals = 2): string => {
  if (!+bytes) {
    return '0 Bytes';
  }

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
};

const formatDuration = (ms: number | null): string => {
  if (ms == null || ms < 0) {
    return 'n/a';
  }
  if (ms < 1000) {
    return `${ms} ms`;
  }
  return `${(ms / 1000).toFixed(2)} s`;
};

const PortfolioStorageDebug: React.FC = () => {
  const {t} = useTranslation();
  const dispatch = useAppDispatch();
  const navigation =
    useNavigation<NativeStackNavigationProp<AboutGroupParamList>>();
  const PORTFOLIO = useAppSelector(({PORTFOLIO}) => PORTFOLIO);
  const keys = useAppSelector(({WALLET}) => WALLET.keys) as Keys;
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string>('');
  const [lastRequestCount, setLastRequestCount] = useState<number>(0);
  const [lastRateRequestCount, setLastRateRequestCount] = useState<number>(0);
  const [lastRateFetchedCount, setLastRateFetchedCount] = useState<number>(0);
  const [runCount, setRunCount] = useState<number>(0);
  const [lastRunAt, setLastRunAt] = useState<string>('');
  const [lastSummary, setLastSummary] = useState<string>('');
  const [currentWalletLabel, setCurrentWalletLabel] = useState<string>('');
  const [lastDurationMs, setLastDurationMs] = useState<number | null>(null);
  const cursorIntervals: PortfolioInterval[] = [
    'day',
    'week',
    'month',
    '3months',
    'year',
    '5years',
    'all',
  ];
  const [buildingCursors, setBuildingCursors] = useState(false);
  const [buildingWalletLabel, setBuildingWalletLabel] = useState<string>('');
  const [buildingInterval, setBuildingInterval] =
    useState<PortfolioInterval | null>(null);
  const [buildingRateCoin, setBuildingRateCoin] = useState<string>('');
  const [buildingRateRequested, setBuildingRateRequested] = useState<number>(0);
  const [buildingRateFetched, setBuildingRateFetched] = useState<number>(0);
  const [rateRequestsByCoin, setRateRequestsByCoin] = useState<
    Record<string, {requested: number; fetched: number}>
  >({});
  const [prefetching, setPrefetching] = useState(false);

  const escapeRegExp = (str: string) =>
    str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const wallets = useMemo(() => {
    return Object.values(keys)
      .flatMap(k => k.wallets)
      .filter(
        w =>
          !w.hideWallet &&
          !w.hideWalletByAccount &&
          (w.network === 'livenet' || w.credentials?.network === 'livenet'),
      );
  }, [keys]);

  const walletRows = useMemo(() => {
    return wallets
      .map(w => {
        const count = PORTFOLIO.txEventsByWalletId[w.id]?.length || 0;
        const label = `${w.walletName || w.id} (${w.currencyAbbreviation?.toUpperCase()})`;
        return {id: w.id, label, count};
      })
      .sort((a, b) => b.count - a.count);
  }, [PORTFOLIO.txEventsByWalletId, wallets]);

  const derived = useMemo(() => {
    const walletIds = Object.keys(PORTFOLIO.txEventsByWalletId || {});
    const walletsWithTxEventsCount = walletIds.length;
    const totalTxEvents = walletIds.reduce(
      (sum, walletId) => sum + (PORTFOLIO.txEventsByWalletId[walletId]?.length || 0),
      0,
    );

    const cursorWalletIds = Object.keys(PORTFOLIO.walletIntervalCursorsByWalletId || {});
    const cursorRows = cursorWalletIds.reduce((sum, walletId) => {
      const cursors = PORTFOLIO.walletIntervalCursorsByWalletId[walletId] || {};
      return sum + Object.keys(cursors).length;
    }, 0);

    const txEventsBytes = (() => {
      try {
        return JSON.stringify(PORTFOLIO.txEventsByWalletId || {}).length;
      } catch (_) {
        return 0;
      }
    })();

    const cursorsBytes = (() => {
      try {
        return JSON.stringify(PORTFOLIO.walletIntervalCursorsByWalletId || {}).length;
      } catch (_) {
        return 0;
      }
    })();

    const rateCacheBytes = (() => {
      try {
        return JSON.stringify(PORTFOLIO.rateCacheUsd || {}).length;
      } catch (_) {
        return 0;
      }
    })();

    const fxCacheBytes = (() => {
      try {
        return JSON.stringify(PORTFOLIO.fxCache || {}).length;
      } catch (_) {
        return 0;
      }
    })();

    const totalBytes = txEventsBytes + cursorsBytes + rateCacheBytes + fxCacheBytes;

    return {
      walletsWithTxEventsCount,
      totalTxEvents,
      cursorRows,
      txEventsBytes,
      cursorsBytes,
      rateCacheBytes,
      fxCacheBytes,
      totalBytes,
    };
  }, [PORTFOLIO]);

  const rateCacheJson = useMemo(() => {
    try {
      return JSON.stringify(PORTFOLIO.rateCacheUsd || {}, null, 2);
    } catch (_) {
      return '';
    }
  }, [PORTFOLIO.rateCacheUsd]);

  const rateCachePreview = useMemo(() => {
    if (!rateCacheJson) {
      return '';
    }
    const limit = 600;
    return rateCacheJson.length > limit
      ? `${rateCacheJson.slice(0, limit)}...`
      : rateCacheJson;
  }, [rateCacheJson]);

  const rateCacheCounts = useMemo(() => {
    return Object.entries(PORTFOLIO.rateCacheUsd || {}).map(([assetId, buckets]) => ({
      assetId,
      count: Object.keys(buckets || {}).length,
    }));
  }, [PORTFOLIO.rateCacheUsd]);

  const copyRateCache = () => {
    if (!rateCacheJson) {
      return;
    }
    Clipboard.setString(rateCacheJson);
    setSyncStatus(t('Copied rate cache JSON'));
  };

  const copyDebugLogs = () => {
    try {
      const walletIds = walletRows.map(w => w.id).filter(Boolean);
      const logs = logManager.getLogs();
      const lines = logs.map(log => {
        const level = LogLevel[log.level] || 'Log';
        return `[${log.timestamp}] [${level}] ${log.message}`;
      });
      const redact = (text: string) => {
        // Redact wallet IDs
        let next = walletIds.reduce((acc, id) => {
          const pattern = new RegExp(escapeRegExp(id), 'gi');
          return acc.replace(pattern, 'redacted');
        }, text);
        // Redact EVM addresses (0x-prefixed, 40 hex chars)
        next = next.replace(/0x[a-fA-F0-9]{40}/g, 'redacted');
        return next;
      };
      const payload = redact(lines.join('\n'));
      Clipboard.setString(payload);
      setSyncStatus(t('Copied debug logs (wallet IDs redacted)'));
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      setSyncStatus(err);
    }
  };

  const syncAllWalletTxEvents = async () => {
    if (syncing) {
      return;
    }

    const nextRun = runCount + 1;
    setRunCount(nextRun);

    if (!wallets.length) {
      setSyncStatus(`Run ${nextRun}: no wallets found`);
      setLastRequestCount(0);
      setLastRunAt(new Date().toISOString());
      setLastSummary(`Run ${nextRun}: no wallets found`);
      return;
    }

    setSyncing(true);
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    setSyncStatus(`Run ${nextRun}: syncing... started at ${startedAt}`);
    setLastRequestCount(0);
    setLastRunAt(startedAt);
    setLastSummary(`Running... (started at ${startedAt})`);

    try {
      let totalEvents = 0;
      let totalRequests = 0;
      let totalRateRequests = 0;
      let totalRateFetched = 0;

      for (const wallet of wallets) {
        const {events, requestCount, rateRequestCount, rateFetchedCount} = await dispatch(
          syncPortfolioTxEventsForWallet(wallet),
        );
        totalEvents += events.length;
        totalRequests += requestCount;
        totalRateRequests += rateRequestCount || 0;
        totalRateFetched += rateFetchedCount || 0;
        setLastRequestCount(totalRequests);
        setLastRateRequestCount(totalRateRequests);
        setLastRateFetchedCount(totalRateFetched);
        const label = `${wallet.walletName || wallet.id} (${
          wallet.currencyAbbreviation?.toUpperCase() || ''
        })`;
        setCurrentWalletLabel(label);
        setSyncStatus(
          `Run ${nextRun}: syncing wallet ${label} (req ${totalRequests})`,
        );
      }

      setSyncStatus(
        `Run ${nextRun} - Synced wallets: ${wallets.length}. Total events: ${totalEvents}. Tx requests: ${totalRequests}. Rate requests: ${totalRateRequests} (fetched ${totalRateFetched})`,
      );
      setLastRequestCount(totalRequests);
      setLastRateRequestCount(totalRateRequests);
      setLastRateFetchedCount(totalRateFetched);
      const finishedAt = new Date().toISOString();
      setLastRunAt(finishedAt);
      setLastDurationMs(Date.now() - startedMs);
      setLastSummary(
        `Last summary: run ${nextRun} at ${finishedAt} (events ${totalEvents}, tx requests ${totalRequests}, rate requests ${totalRateRequests}, rates fetched ${totalRateFetched})`,
      );
    } catch (e) {
      const err = e instanceof Error ? e.message : JSON.stringify(e);
      setSyncStatus(err);
      const finishedAt = new Date().toISOString();
      setLastRunAt(finishedAt);
      setLastDurationMs(Date.now() - startedMs);
      setLastSummary(err);
    } finally {
      setSyncing(false);
    }
  };

  const clearPortfolioData = () => {
    dispatch(resetPortfolio());
    setSyncStatus(t('Cleared all portfolio data'));
    setLastRequestCount(0);
  };

  const clearRateCache = () => {
    dispatch(clearRateCacheUsd());
    setRateRequestsByCoin({});
    setBuildingRateCoin('');
    setBuildingRateRequested(0);
    setBuildingRateFetched(0);
    setSyncStatus(t('Cleared rate cache'));
  };

  const prefetchRates = () => {
    if (syncing || prefetching || buildingCursors) {
      return;
    }
    setPrefetching(true);
    setLastDurationMs(null);
    setBuildingWalletLabel('');
    setBuildingInterval(null);
    setBuildingRateCoin('');
    setBuildingRateRequested(0);
    setBuildingRateFetched(0);
    setRateRequestsByCoin({});
    setSyncStatus('Starting rate prefetch (all intervals)...');
    InteractionManager.runAfterInteractions(() => {
      setTimeout(async () => {
        const startedMs = Date.now();
        const startedAt = new Date().toISOString();
        setSyncStatus(`Prefetching rates... started at ${startedAt}`);
        const pause = () => new Promise(resolve => setTimeout(resolve, 0));
        try {
          let prefetched = 0;
          let skipped = 0;
          const rateTotals: Record<string, {requested: number; fetched: number}> = {};
          const runToken = `prefetch-${Date.now()}`;
          for (const wallet of wallets) {
            const eventCount =
              PORTFOLIO.txEventsByWalletId[wallet.id]?.length || 0;
            if (eventCount === 0) {
              skipped++;
              continue;
            }
            const walletLabel = `${wallet.walletName || wallet.id} (${
              wallet.currencyAbbreviation?.toUpperCase() || ''
            })`;
            setBuildingWalletLabel(walletLabel);
            let progressFired = false;
            const prefillResult = await dispatch(
              buildCursorForWalletInterval(wallet.id, 'day', {
                skipPrefill: false,
                prefillOnly: true,
                runToken: `${runToken}-${wallet.id}`,
                onPrefillProgress: p => {
                  progressFired = true;
                  const prev = rateTotals[p.coin] || {requested: 0, fetched: 0};
                  const nextTotals = {
                    ...rateTotals,
                    [p.coin]: {
                      requested: Math.max(prev.requested, p.requested),
                      fetched: Math.max(prev.fetched, p.fetched),
                    },
                  };
                  Object.assign(rateTotals, nextTotals);
                  setBuildingRateCoin(p.coin.toUpperCase());
                  setBuildingRateRequested(p.requested);
                  setBuildingRateFetched(p.fetched);
                  setRateRequestsByCoin({...nextTotals});
                },
              }),
            );
            if (!progressFired && prefillResult?.coin) {
              const prev = rateTotals[prefillResult.coin] || {requested: 0, fetched: 0};
              const nextTotals = {
                ...rateTotals,
                [prefillResult.coin]: {
                  requested: Math.max(prev.requested, prefillResult.rateRequested || 0),
                  fetched: Math.max(prev.fetched, prefillResult.rateFetched || 0),
                },
              };
              Object.assign(rateTotals, nextTotals);
              setBuildingRateCoin(prefillResult.coin.toUpperCase());
              setBuildingRateRequested(prefillResult.rateRequested || 0);
              setBuildingRateFetched(prefillResult.rateFetched || 0);
              setRateRequestsByCoin({...nextTotals});
            }
            prefetched++;
            if (prefetched % 5 === 0) {
              await pause();
            }
          }
          const finishedAt = new Date().toISOString();
          setLastRunAt(finishedAt);
          setLastDurationMs(Date.now() - startedMs);
          setSyncStatus(
            `Prefetch complete for ${prefetched} wallet(s); skipped ${skipped} with no txs`,
          );
          setLastSummary(
            `Prefetch: wallets processed ${prefetched}, skipped ${skipped}, finished at ${finishedAt}`,
          );
        } catch (e) {
          const err = e instanceof Error ? e.message : JSON.stringify(e);
          setSyncStatus(err);
          setLastSummary(err);
        } finally {
          setBuildingWalletLabel('');
          setBuildingInterval(null);
          setBuildingRateCoin('');
          setBuildingRateRequested(0);
          setBuildingRateFetched(0);
          setPrefetching(false);
        }
      }, 0);
    });
  };

  const buildCursors = () => {
    if (syncing || buildingCursors) {
      return;
    }
    // Reset totals and per-coin counts before a new build run.
    setBuildingCursors(true);
    setLastDurationMs(null);
    setBuildingWalletLabel('');
    setBuildingInterval(null);
    setBuildingRateCoin('');
    setBuildingRateRequested(0);
    setBuildingRateFetched(0);
    setRateRequestsByCoin({});
    setSyncStatus('Starting cursor build...');
    (async () => {
      const startedMs = Date.now();
      const startedAt = new Date().toISOString();
      setSyncStatus(`Building cursors (all intervals)... started at ${startedAt}`);
      logManager.info(`[portfolio-debug] buildAllCursors start at ${startedAt}`);
      try {
        const {built, skipped, durationMs} = await dispatch(buildAllCursors(cursorIntervals));
        const finishedAt = new Date().toISOString();
        setLastRunAt(finishedAt);
        setLastDurationMs(durationMs);
        setSyncStatus(
          `Built ${built} cursors (all intervals) for ${wallets.length - skipped} wallet(s) at ${finishedAt} (skipped ${skipped} with no txs)`,
        );
        setLastSummary(
          `Cursors: intervals ${cursorIntervals.join(
            ',',
          )}, wallets processed ${wallets.length - skipped}, skipped ${skipped}, finished at ${finishedAt}`,
        );
      } catch (e) {
        const err = e instanceof Error ? e.message : JSON.stringify(e);
        setSyncStatus(err);
        setLastSummary(err);
      } finally {
        setBuildingWalletLabel('');
        setBuildingInterval(null);
        setBuildingRateCoin('');
        setBuildingRateRequested(0);
        setBuildingRateFetched(0);
        setBuildingCursors(false);
      }
    })();
  };

  return (
    <SettingsContainer>
      <ScrollContainer>
        {__DEV__ ? (
          <>
            <HeaderTitle>
              <SettingTitle>{t('Actions')}</SettingTitle>
            </HeaderTitle>
            <Setting onPress={syncAllWalletTxEvents}>
              <SettingTitle>{t('Sync Portfolio Tx Events')}</SettingTitle>
              <Button
                buttonType="pill"
                onPress={syncAllWalletTxEvents}
                disabled={syncing}>
                {syncing ? t('Syncing') : t('Run')}
              </Button>
            </Setting>
            <Hr />
            <Setting onPress={clearPortfolioData}>
              <SettingTitle>{t('Clear Portfolio Data')}</SettingTitle>
              <Button buttonType="pill" onPress={clearPortfolioData}>
                {t('Clear')}
              </Button>
            </Setting>
            <Hr />
            <Setting onPress={clearRateCache}>
              <SettingTitle>{t('Clear Rate Cache')}</SettingTitle>
              <Button buttonType="pill" onPress={clearRateCache}>
                {t('Clear')}
              </Button>
            </Setting>
            <Hr />
            <Setting onPress={copyDebugLogs}>
              <SettingTitle>{t('Copy Debug Logs (redacted wallet IDs)')}</SettingTitle>
              <Button buttonType="pill" onPress={copyDebugLogs}>
                {t('Copy')}
              </Button>
            </Setting>
            <Hr />
            <Setting onPress={prefetchRates}>
              <SettingTitle>{t('Prefetch Rates')} ({t('all intervals')})</SettingTitle>
              <Button
                buttonType="pill"
                onPress={prefetchRates}
                disabled={syncing || prefetching || buildingCursors}>
                {prefetching ? t('Prefetching...') : t('Prefetch')}
              </Button>
            </Setting>
            <Hr />
            <Setting onPress={buildCursors}>
              <SettingTitle>
                {t('Build Cursors')} ({t('all intervals')})
              </SettingTitle>
              <Button
                buttonType="pill"
                onPress={buildCursors}
                disabled={syncing || buildingCursors || prefetching}>
                {buildingCursors ? t('Building...') : t('Build')}
              </Button>
            </Setting>
            <Hr />
            <Setting
              style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                alignItems: 'center',
                height: 'auto',
                paddingTop: 20,
              }}>
              <Button buttonType="pill" style={{marginBottom: 6, marginRight: 6}}>
                {t('Run') + ': ' + (runCount || 0)}
              </Button>
              <Button buttonType="pill" style={{marginBottom: 6, marginRight: 6}}>
                {t('Tx Requests') + ': ' + (lastRequestCount || 0)}
              </Button>
              <Button buttonType="pill" style={{marginBottom: 6, marginRight: 6}}>
                {t('Rate Req') + ': ' + (lastRateRequestCount || 0)}
              </Button>
              <Button buttonType="pill" style={{marginBottom: 6, marginRight: 6}}>
                {t('Rate Fetched') + ': ' + (lastRateFetchedCount || 0)}
              </Button>
              {buildingCursors && buildingRateCoin ? (
                <>
                  <Button
                    buttonType="pill"
                    style={{marginBottom: 6, marginRight: 6}}>
                    {t('Rate Coin') + ': ' + buildingRateCoin}
                  </Button>
                  <Button
                    buttonType="pill"
                    style={{marginBottom: 6, marginRight: 6}}>
                    {t('Rate Req (curr)') + ': ' + buildingRateRequested}
                  </Button>
                  <Button
                    buttonType="pill"
                    style={{marginBottom: 6, marginRight: 6}}>
                    {t('Rate Fetched (curr)') + ': ' + buildingRateFetched}
                  </Button>
                </>
              ) : null}
              {buildingCursors ? (
                <>
                  <Button
                    buttonType="pill"
                    style={{marginBottom: 6, marginRight: 6}}>
                    {t('Wallet') + ': ' + (buildingWalletLabel || t('n/a'))}
                  </Button>
                  <Button
                    buttonType="pill"
                    style={{marginBottom: 6, marginRight: 6}}>
                    {t('Interval') +
                      ': ' +
                      (buildingInterval?.toUpperCase?.() || t('n/a'))}
                  </Button>
                </>
              ) : null}
              <Button buttonType="pill" style={{marginBottom: 6, marginRight: 6}}>
                {t('Current') + ': ' + (currentWalletLabel || t('n/a'))}
              </Button>
              <Button buttonType="pill" style={{marginBottom: 6, marginRight: 6}}>
                {t('Last Run') + ': ' + (lastRunAt || t('n/a'))}
              </Button>
              <Button buttonType="pill" style={{marginBottom: 6, marginRight: 6}}>
                {t('Duration') + ': ' + formatDuration(lastDurationMs)}
              </Button>
            </Setting>
            {Object.keys(rateRequestsByCoin).length ? (
              <>
                <View
                  style={{
                    width: '100%',
                    paddingVertical: 12,
                    marginBottom: 16,
                    flexDirection: 'column',
                    gap: 6,
                  }}>
                  <SettingTitle style={{marginBottom: 4, width: '100%'}}>
                    {t('Rate Requests by Coin')}
                  </SettingTitle>
                  {Object.entries(rateRequestsByCoin).map(([coin, totals]) => (
                    <View
                      key={coin}
                      style={{
                        width: '100%',
                        paddingVertical: 4,
                      }}>
                      <SettingTitle style={{lineHeight: 20}}>
                        {coin.toUpperCase()}: {totals.requested} req / {totals.fetched} fetched
                      </SettingTitle>
                    </View>
                  ))}
                </View>
                <Hr />
              </>
            ) : null}
          </>
        ) : null}

        <HeaderTitle>
          <SettingTitle>{t('Wallets')}</SettingTitle>
        </HeaderTitle>
        {walletRows.map(w => (
          <React.Fragment key={w.id}>
            <Setting
              onPress={() =>
                navigation.navigate(AboutScreens.PORTFOLIO_WALLET_TX_EVENTS_DEBUG, {
                  walletId: w.id,
                })
              }>
              <SettingTitle>
                {w.label} ({w.count})
              </SettingTitle>
            </Setting>
            <Hr />
          </React.Fragment>
        ))}

        <HeaderTitle>
          <SettingTitle>{t('Counts')}</SettingTitle>
        </HeaderTitle>
        <Setting>
          <SettingTitle>{t('Wallets with Tx History')}</SettingTitle>
          <Button buttonType="pill">{derived.walletsWithTxEventsCount}</Button>
        </Setting>
        <Hr />
        <Setting>
          <SettingTitle>{t('Total Tx Events')}</SettingTitle>
          <Button buttonType="pill">{derived.totalTxEvents}</Button>
        </Setting>
        <Hr />
        <Setting>
          <SettingTitle>{t('Cursor Rows')}</SettingTitle>
          <Button buttonType="pill">{derived.cursorRows}</Button>
        </Setting>

        <HeaderTitle>
          <SettingTitle>{t('Approx Size')}</SettingTitle>
        </HeaderTitle>
        <Setting>
          <SettingTitle>{t('Tx Events')}</SettingTitle>
          <Button buttonType="pill">{formatBytes(derived.txEventsBytes)}</Button>
        </Setting>
        <Hr />
        <Setting>
          <SettingTitle>{t('Cursors')}</SettingTitle>
          <Button buttonType="pill">{formatBytes(derived.cursorsBytes)}</Button>
        </Setting>
        <Hr />
        <Setting>
          <SettingTitle>{t('Rate Cache (USD)')}</SettingTitle>
          <Button buttonType="pill">{formatBytes(derived.rateCacheBytes)}</Button>
        </Setting>
        <Hr />
        <Setting>
          <SettingTitle>{t('FX Cache')}</SettingTitle>
          <Button buttonType="pill">{formatBytes(derived.fxCacheBytes)}</Button>
        </Setting>
        <Hr />

        <HeaderTitle>
          <SettingTitle>{t('Rate Cache')}</SettingTitle>
        </HeaderTitle>
        <Setting>
          <Button buttonType="pill" onPress={copyRateCache} style={{marginTop: 8}}>
            {t('Copy Rate Cache JSON')}
          </Button>
          <SettingTitle style={{marginTop: 8}} numberOfLines={6}>
            {rateCachePreview || t('No rate cache data')}
          </SettingTitle>
        </Setting>
        {rateCacheCounts.length ? (
          rateCacheCounts.map(rc => (
            <Setting key={rc.assetId} style={{marginTop: 4}}>
              <SettingTitle>{rc.assetId}</SettingTitle>
              <Button buttonType="pill">{rc.count}</Button>
            </Setting>
          ))
        ) : null}
        <Hr />

        <HeaderTitle>
          <SettingTitle>{t('Totals')}</SettingTitle>
        </HeaderTitle>
        <Setting>
          <SettingTitle>{t('Total Size')}</SettingTitle>
          <Button buttonType="pill">{formatBytes(derived.totalBytes)}</Button>
        </Setting>
      </ScrollContainer>
    </SettingsContainer>
  );
};

export default PortfolioStorageDebug;