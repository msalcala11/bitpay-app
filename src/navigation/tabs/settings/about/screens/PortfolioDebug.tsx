import React, {useCallback, useMemo, useState} from 'react';
import {InteractionManager, Pressable, ScrollView} from 'react-native';
import styled from 'styled-components/native';
import {useTranslation} from 'react-i18next';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import Clipboard from '@react-native-clipboard/clipboard';
import {useAppDispatch, useAppSelector} from '../../../../../utils/hooks';
import {AboutGroupParamList, AboutScreens} from '../AboutGroup';
import {
  DebugButtonRow,
  DebugButtonSpacer,
  DebugHeaderContainer,
  DebugHeaderText,
  DebugPillButton,
  DebugPillButtonText,
  DebugScreenContainer,
} from '../components/DebugUI';
import {
  clearPortfolio,
  populatePortfolio,
} from '../../../../../store/portfolio';
import type {BalanceSnapshot} from '../../../../../store/portfolio/portfolio.models';
import type {Wallet} from '../../../../../store/wallet/wallet.models';
import {
  BitpaySupportedCoins,
  BitpaySupportedTokens,
} from '../../../../../constants/currencies';
import {getCurrencyAbbreviation} from '../../../../../utils/helper-methods';
import {getLatestSnapshot} from '../../../../../utils/portfolio/assets';
import {Network} from '../../../../../constants';

type PortfolioDebugScreenProps = NativeStackScreenProps<
  AboutGroupParamList,
  AboutScreens.PORTFOLIO_DEBUG
>;

const WalletRow = styled(Pressable)`
  padding: 14px 12px;
  border-top-width: 1px;
  border-top-color: ${({theme}) => theme.colors.border};
`;

const WalletRowTitle = styled.Text`
  color: ${({theme}) => theme.colors.text};
  font-size: 14px;
  line-height: 18px;
`;

const WalletRowSubTitle = styled.Text`
  color: ${({theme}) => theme.colors.text};
  font-size: 12px;
  line-height: 16px;
  opacity: 0.7;
`;

const WalletRowMismatchText = styled(WalletRowSubTitle)`
  color: ${({theme}) => theme.colors.notification};
  opacity: 1;
`;

const getUnitDecimalsForWallet = (wallet: Wallet | undefined): number => {
  if (!wallet) {
    return 0;
  }
  const chain = (wallet.chain || '').toLowerCase();
  const tokenAddress = wallet.tokenAddress;

  if (tokenAddress) {
    const currencyName = getCurrencyAbbreviation(tokenAddress, chain);
    const unitDecimals =
      BitpaySupportedTokens[currencyName]?.unitInfo?.unitDecimals;
    return typeof unitDecimals === 'number' ? unitDecimals : 0;
  }

  const unitDecimals = BitpaySupportedCoins[chain]?.unitInfo?.unitDecimals;
  return typeof unitDecimals === 'number' ? unitDecimals : 0;
};

const csvEscape = (v: unknown): string => {
  const s = v == null ? '' : String(v);
  if (/[^\x20-\x7E]|[\n\r,\"]/g.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
};

type DerivedMismatch = {
  deltaUnits: string;
  liveUnits: string;
  snapshotUnits: string;
};

const PortfolioDebug = ({navigation}: PortfolioDebugScreenProps) => {
  const {t} = useTranslation();
  const dispatch = useAppDispatch();

  const portfolio = useAppSelector(({PORTFOLIO}) => PORTFOLIO);
  const walletKeys = useAppSelector(({WALLET}) => WALLET?.keys || {});

  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [isCopyingAudit, setIsCopyingAudit] = useState<boolean>(false);
  const [copyAuditState, setCopyAuditState] = useState<'idle' | 'copied'>(
    'idle',
  );

  const walletIds = useMemo(() => {
    const ids = Object.keys(portfolio.snapshotsByWalletId || {});
    ids.sort();
    return ids;
  }, [portfolio.snapshotsByWalletId]);

  const {walletNameById, walletById, allWallets} = useMemo(() => {
    const nameMap: {[walletId: string]: string | undefined} = {};
    const walletMap: {[walletId: string]: Wallet | undefined} = {};
    const all: Wallet[] = [];
    for (const key of Object.values(walletKeys || {}) as any[]) {
      const wallets: Wallet[] = Array.isArray(key?.wallets) ? key.wallets : [];
      for (const w of wallets) {
        all.push(w);
        if (w?.id) {
          nameMap[w.id] = w.walletName;
          walletMap[w.id] = w;
        }
      }
    }
    return {walletNameById: nameMap, walletById: walletMap, allWallets: all};
  }, [walletKeys]);

  const {mainnetWallets, testnetWallets, mainnetWalletsWithZeroBalance} =
    useMemo(() => {
      const mainnet = allWallets.filter(w => w?.network === Network.mainnet);
      const testnet = allWallets.filter(w => w?.network !== Network.mainnet);
      const zero = mainnet.filter(w => {
        const sat = (w as any)?.balance?.sat;
        const crypto = (w as any)?.balance?.crypto;
        if (typeof sat === 'number') {
          return sat === 0;
        }
        if (typeof crypto === 'string') {
          const n = Number(crypto);
          return Number.isFinite(n) ? n === 0 : false;
        }
        return false;
      });
      return {
        mainnetWallets: mainnet,
        testnetWallets: testnet,
        mainnetWalletsWithZeroBalance: zero,
      };
    }, [allWallets]);

  const totalSnapshots = useMemo(() => {
    let count = 0;
    for (const v of Object.values(portfolio.snapshotsByWalletId || {})) {
      count += Array.isArray(v) ? v.length : 0;
    }
    return count;
  }, [portfolio.snapshotsByWalletId]);

  const walletHasInitialIncomingTxSnapshotById = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const walletId of walletIds) {
      const snapshots = portfolio.snapshotsByWalletId?.[walletId] as
        | BalanceSnapshot[]
        | undefined;

      map[walletId] =
        Array.isArray(snapshots) &&
        snapshots[0]?.eventType === 'tx' &&
        snapshots[0]?.direction === 'incoming';
    }
    return map;
  }, [portfolio.snapshotsByWalletId, walletIds]);

  const walletMismatchById = useMemo(() => {
    const map: Record<string, DerivedMismatch> = {};
    for (const walletId of walletIds) {
      const mismatch =
        portfolio.snapshotBalanceMismatchesByWalletId?.[walletId];
      if (mismatch) {
        map[walletId] = {
          deltaUnits: mismatch.delta,
          liveUnits: mismatch.currentWalletBalance,
          snapshotUnits: mismatch.computedUnitsHeld,
        };
      }
    }
    return map;
  }, [portfolio.snapshotBalanceMismatchesByWalletId, walletIds]);

  const totalWalletMismatches = useMemo(
    () => Object.keys(walletMismatchById).length,
    [walletMismatchById],
  );

  const clear = useCallback(() => {
    if (isGenerating) {
      return;
    }
    setIsGenerating(true);

    const task = InteractionManager.runAfterInteractions(() => {
      try {
        dispatch(clearPortfolio());
      } catch (e) {
      } finally {
        setIsGenerating(false);
      }
    });

    return () => task.cancel();
  }, [dispatch, isGenerating]);

  const populate = useCallback(() => {
    if (isGenerating || portfolio.populateStatus?.inProgress) {
      return;
    }

    setIsGenerating(true);

    const task = InteractionManager.runAfterInteractions(async () => {
      try {
        await dispatch(populatePortfolio());
      } catch (e) {
      } finally {
        setIsGenerating(false);
      }
    });

    return () => task.cancel();
  }, [dispatch, isGenerating, portfolio.populateStatus?.inProgress]);

  const copySnapshotAuditCsv = useCallback(() => {
    if (isCopyingAudit) {
      return;
    }

    setIsCopyingAudit(true);

    const task = InteractionManager.runAfterInteractions(() => {
      try {
        const wallets = [...(allWallets || [])].filter((w: any) => !!w?.id);
        wallets.sort((a: any, b: any) =>
          String(a.id).localeCompare(String(b.id)),
        );

        const headers = [
          'walletId',
          'walletName',
          'keyId',
          'chain',
          'coin',
          'tokenAddress',
          'network',
          'hidden',
          'balance.crypto',
          'balance.sat',
          'snapshots',
          'txSnapshots',
          'dailySnapshots',
          'dailyTxIdsTotal',
          'duplicateSnapshotIds',
          'firstSnapshotTs',
          'lastSnapshotTs',
        ];

        const rows = wallets.map((w: any) => {
          const walletId = String(w.id);
          const name = walletNameById[walletId] || w.walletName || '';
          const snapsRaw = (portfolio.snapshotsByWalletId || {})[walletId];
          const snaps: BalanceSnapshot[] = Array.isArray(snapsRaw)
            ? (snapsRaw as BalanceSnapshot[])
            : [];
          const total = snaps.length;
          const txCount = snaps.filter(
            s => (s as any)?.eventType === 'tx',
          ).length;
          const dailyCount = total - txCount;
          const dailyTxIdsTotal = snaps.reduce((sum, s: any) => {
            const txIds = s?.txIds;
            return sum + (Array.isArray(txIds) ? txIds.length : 0);
          }, 0);
          const uniqueIds = new Set(
            snaps.map(s => String((s as any)?.id || '')),
          ).size;
          const dupIds = total - uniqueIds;
          const firstTs = total ? (snaps[0] as any)?.timestamp ?? '' : '';
          const lastTs = total
            ? (snaps[total - 1] as any)?.timestamp ?? ''
            : '';

          return [
            walletId,
            name,
            w.keyId || '',
            w.chain || '',
            w.currencyAbbreviation || '',
            w.tokenAddress || '',
            w.network || '',
            w.hideWallet ? 'yes' : '',
            w.balance?.crypto ?? '',
            typeof w.balance?.sat === 'number' ? w.balance.sat : '',
            total,
            txCount,
            dailyCount,
            dailyTxIdsTotal,
            dupIds,
            firstTs,
            lastTs,
          ]
            .map(csvEscape)
            .join(',');
        });

        const csv = [headers.join(','), ...rows].join('\n');
        Clipboard.setString(csv);
        setCopyAuditState('copied');
        setTimeout(() => setCopyAuditState('idle'), 1500);
      } finally {
        setIsCopyingAudit(false);
      }
    });

    return () => task.cancel();
  }, [
    allWallets,
    isCopyingAudit,
    portfolio.snapshotsByWalletId,
    walletNameById,
  ]);

  return (
    <DebugScreenContainer>
      <DebugHeaderContainer>
        <DebugHeaderText>
          {t('Wallets')} (with snapshots): {walletIds.length} | {t('Snapshots')}
          : {totalSnapshots}
        </DebugHeaderText>
        <DebugHeaderText>
          {t('Mainnet Wallets')}: {mainnetWallets.length} |{' '}
          {t('Testnet Wallets')}: {testnetWallets.length} |{' '}
          {t('Mainnet Zero-Balance Wallets')}:{' '}
          {mainnetWalletsWithZeroBalance.length}
        </DebugHeaderText>
        <DebugHeaderText>
          inProgress: {portfolio.populateStatus?.inProgress ? 'yes' : 'no'} |{' '}
          walletsCompleted: {portfolio.populateStatus?.walletsCompleted ?? 0}/
          {portfolio.populateStatus?.walletsTotal ?? 0} | txsProcessed:{' '}
          {portfolio.populateStatus?.txsProcessed ?? 0} | errors:{' '}
          {portfolio.populateStatus?.errors?.length ?? 0} | mismatches:{' '}
          {totalWalletMismatches}
        </DebugHeaderText>

        <DebugButtonRow>
          <DebugPillButton onPress={() => (isGenerating ? null : clear())}>
            <DebugPillButtonText>
              {t('Clear Portfolio Store')}
            </DebugPillButtonText>
          </DebugPillButton>
          <DebugButtonSpacer />
          <DebugPillButton
            onPress={() => (isGenerating ? null : populate())}
            selected={portfolio.populateStatus?.inProgress}>
            <DebugPillButtonText
              selected={portfolio.populateStatus?.inProgress}>
              {t('Populate Portfolio Store')}
            </DebugPillButtonText>
          </DebugPillButton>
        </DebugButtonRow>

        <DebugButtonRow>
          <DebugPillButton
            onPress={() => (isCopyingAudit ? null : copySnapshotAuditCsv())}
            selected={copyAuditState === 'copied'}>
            <DebugPillButtonText selected={copyAuditState === 'copied'}>
              {copyAuditState === 'copied'
                ? 'Copied Snapshot Audit CSV'
                : 'Copy Snapshot Audit CSV'}
            </DebugPillButtonText>
          </DebugPillButton>
        </DebugButtonRow>
      </DebugHeaderContainer>

      <ScrollView style={{flex: 1}} contentContainerStyle={{paddingBottom: 40}}>
        {walletIds.map(walletId => {
          const snapshots = portfolio.snapshotsByWalletId?.[walletId];
          const count = snapshots?.length ?? 0;
          const walletName = walletNameById[walletId];
          const mismatch = walletMismatchById[walletId];
          const hasInitialIncomingTxSnapshot =
            walletHasInitialIncomingTxSnapshotById[walletId];
          return (
            <WalletRow
              key={walletId}
              onPress={() =>
                navigation.navigate(AboutScreens.PORTFOLIO_WALLET_DEBUG, {
                  walletId,
                })
              }>
              <WalletRowTitle>
                {(walletName || walletId).trim()} ({count})
              </WalletRowTitle>
              {walletName ? (
                <WalletRowSubTitle>{walletId}</WalletRowSubTitle>
              ) : null}
              {mismatch ? (
                <WalletRowMismatchText>
                  mismatch delta: {mismatch.deltaUnits}
                </WalletRowMismatchText>
              ) : null}
            </WalletRow>
          );
        })}
      </ScrollView>
    </DebugScreenContainer>
  );
};

export default PortfolioDebug;
