import React, {useMemo, useState} from 'react';
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
import {syncPortfolioTxEventsForWallet} from '../../../../../store/portfolio';
import {useNavigation} from '@react-navigation/native';
import {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {AboutGroupParamList, AboutScreens} from '../AboutGroup';

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

const PortfolioStorageDebug: React.FC = () => {
  const {t} = useTranslation();
  const dispatch = useAppDispatch();
  const navigation =
    useNavigation<NativeStackNavigationProp<AboutGroupParamList>>();
  const PORTFOLIO = useAppSelector(({PORTFOLIO}) => PORTFOLIO);
  const keys = useAppSelector(({WALLET}) => WALLET.keys) as Keys;
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string>('');

  const wallets = useMemo(() => {
    return Object.values(keys)
      .flatMap(k => k.wallets)
      .filter(w => !w.hideWallet && !w.hideWalletByAccount);
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

    setSyncing(true);
    setSyncStatus(t('Syncing...'));

    try {
      let totalEvents = 0;
      for (const wallet of wallets) {
        const events = await dispatch(syncPortfolioTxEventsForWallet(wallet));
        totalEvents += events.length;
      }

      setSyncStatus(
        t('Synced wallets: {{count}}. Total events: {{events}}', {
          count: wallets.length,
          events: totalEvents,
        }),
      );
    } catch (e) {
      const err = e instanceof Error ? e.message : JSON.stringify(e);
      setSyncStatus(err);
    } finally {
      setSyncing(false);
    }
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
              <Button buttonType="pill">{syncing ? t('Syncing') : t('Run')}</Button>
            </Setting>
            {syncStatus ? (
              <Setting>
                <SettingTitle>{syncStatus}</SettingTitle>
              </Setting>
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
        <Setting>
          <SettingTitle>{t('Total')}</SettingTitle>
          <Button buttonType="pill">{formatBytes(derived.totalBytes)}</Button>
        </Setting>
      </ScrollContainer>
    </SettingsContainer>
  );
};

export default PortfolioStorageDebug;
