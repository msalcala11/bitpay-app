import React, {useMemo, useState} from 'react';
import {InteractionManager} from 'react-native';
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
import {Keys} from '../../../../../store/wallet/wallet.reducer';
import {
  buildCursorForWalletInterval,
  resetPortfolio,
  syncPortfolioTxEventsForWallet,
} from '../../../../../store/portfolio';
import {useNavigation} from '@react-navigation/native';
import {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {AboutGroupParamList, AboutScreens} from '../AboutGroup';
import {PortfolioInterval} from '../../../../../store/portfolio/portfolio.types';

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
    setCurrentWalletLabel('');
    setLastDurationMs(null);

    try {
      let totalEvents = 0;
      let totalRequests = 0;
      let totalRateRequests = 0;
      let totalRateFetched = 0;
      for (const wallet of wallets) {
        if (wallet.network !== 'livenet' && wallet.credentials?.network !== 'livenet') {
          continue;
        }
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
        const label = `${wallet.walletName || wallet.id} (${wallet.currencyAbbreviation?.toUpperCase() || ''})`;
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

  const buildCursors = () => {
    if (syncing || buildingCursors) {
      return;
    }
    setBuildingCursors(true);
    setLastDurationMs(null);
    setBuildingWalletLabel('');
    setBuildingInterval(null);
    setSyncStatus('Starting cursor build...');
    InteractionManager.runAfterInteractions(() => {
      setTimeout(async () => {
        const startedMs = Date.now();
        const startedAt = new Date().toISOString();
        setSyncStatus(`Building cursors (all intervals)... started at ${startedAt}`);
        const pause = () => new Promise(resolve => setTimeout(resolve, 0));
        try {
          let built = 0;
          let skipped = 0;
          for (const wallet of wallets) {
            const eventCount =
              PORTFOLIO.txEventsByWalletId[wallet.id]?.length || 0;
            if (eventCount === 0) {
              skipped++;
              continue;
            }
            for (const interval of cursorIntervals) {
              const walletLabel = `${wallet.walletName || wallet.id} (${
                wallet.currencyAbbreviation?.toUpperCase() || ''
              })`;
              setBuildingWalletLabel(walletLabel);
              setBuildingInterval(interval);
              await dispatch(buildCursorForWalletInterval(wallet.id, interval));
              built++;
              if (built % 5 === 0) {
                await pause();
              }
            }
          }
          const finishedAt = new Date().toISOString();
          setLastRunAt(finishedAt);
          setLastDurationMs(Date.now() - startedMs);
          setSyncStatus(
            `Built ${built} cursors (all intervals) for ${
              wallets.length - skipped
            } wallet(s) at ${finishedAt} (skipped ${skipped} with no txs)`,
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
          setBuildingCursors(false);
        }
      }, 0);
    });
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
            <Setting onPress={buildCursors}>
              <SettingTitle>
                {t('Build Cursors')} ({t('all intervals')})
              </SettingTitle>
              <Button
                buttonType="pill"
                onPress={buildCursors}
                disabled={syncing || buildingCursors}>
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
              {/* {syncStatus ? (
                <SettingTitle style={{marginRight: 8}}>{syncStatus}</SettingTitle>
              ) : null} */}
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
              {buildingCursors ? (
                <>
                  <Button
                    buttonType="pill"
                    style={{marginBottom: 6, marginRight: 6}}>
                    {t('Wallet') +
                      ': ' +
                      (buildingWalletLabel || t('n/a'))}
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
        <Setting>
          <SettingTitle>{t('Total')}</SettingTitle>
          <Button buttonType="pill">{formatBytes(derived.totalBytes)}</Button>
        </Setting>
      </ScrollContainer>
    </SettingsContainer>
  );
};

export default PortfolioStorageDebug;
