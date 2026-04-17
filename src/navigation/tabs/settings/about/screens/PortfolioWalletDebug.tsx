import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Platform, ScrollView} from 'react-native';
import {NavigationProp, useNavigation} from '@react-navigation/native';
import styled from 'styled-components/native';
import Clipboard from '@react-native-clipboard/clipboard';
import {useTranslation} from 'react-i18next';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import type {RootStackParamList} from '../../../../../Root';
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
import {getPortfolioRuntimeClient} from '../../../../../portfolio/runtime/portfolioRuntime';
import type {SnapshotIndexV2} from '../../../../../portfolio/core/pnl/snapshotStore';
import type {BalanceSnapshotStored} from '../../../../../portfolio/core/pnl/types';
import type {Wallet} from '../../../../../store/wallet/wallet.models';
import {WalletScreens} from '../../../../wallet/WalletGroup';
import {clearWalletPortfolioDataWithRuntime, populatePortfolio} from '../../../../../store/portfolio';
import {logManager} from '../../../../../managers/LogManager';

type PortfolioWalletDebugScreenProps = NativeStackScreenProps<
  AboutGroupParamList,
  AboutScreens.PORTFOLIO_WALLET_DEBUG
>;

const JsonLineText = styled.Text`
  padding: 12px;
  font-size: 12px;
  line-height: 16px;
  font-family: ${Platform.OS === 'ios' ? 'Menlo' : 'monospace'};
  color: ${({theme}) => theme.colors.text};
`;

const SectionTitle = styled.Text`
  padding: 0 12px;
  color: ${({theme}) => theme.colors.text};
  font-size: 13px;
  line-height: 18px;
  font-weight: 600;
`;

const SectionText = styled.Text`
  padding: 0 12px 12px;
  color: ${({theme}) => theme.colors.text};
  font-size: 12px;
  line-height: 18px;
`;

const ErrorText = styled(SectionText)`
  color: ${({theme}) => theme.colors.notification};
`;

const csvEscape = (value: unknown): string => {
  const nextValue = value == null ? '' : String(value);
  if (/[,"\n\r]/.test(nextValue)) {
    return `"${nextValue.replace(/"/g, '""')}"`;
  }
  return nextValue;
};

const toIso = (value?: number): string => {
  if (!Number.isFinite(value)) {
    return '—';
  }

  try {
    return new Date(value as number).toISOString();
  } catch {
    return '—';
  }
};

const getRowCount = (index: SnapshotIndexV2 | null | undefined): number => {
  if (!index?.chunks?.length) {
    return 0;
  }

  return index.chunks.reduce((total, chunk) => {
    const rows = Number(chunk?.rows);
    return total + (Number.isFinite(rows) ? rows : 0);
  }, 0);
};

const findWalletById = (walletKeys: Record<string, any>, walletId: string): Wallet | undefined => {
  for (const key of Object.values(walletKeys || {})) {
    const wallets = Array.isArray((key as any)?.wallets) ? (key as any).wallets : [];
    const match = wallets.find((wallet: Wallet) => wallet?.id === walletId);
    if (match) {
      return match;
    }
  }
  return undefined;
};

const toCsv = (snapshots: BalanceSnapshotStored[]): string => {
  const headers = [
    'id',
    'walletId',
    'chain',
    'coin',
    'network',
    'assetId',
    'timestamp',
    'iso',
    'eventType',
    'cryptoBalance',
    'remainingCostBasisFiat',
    'markRate',
    'quoteCurrency',
    'createdAt',
    'txIds',
  ];

  const rows = snapshots.map(snapshot => {
    return [
      snapshot.id,
      snapshot.walletId,
      snapshot.chain,
      snapshot.coin,
      snapshot.network,
      snapshot.assetId,
      snapshot.timestamp,
      toIso(snapshot.timestamp),
      snapshot.eventType,
      snapshot.cryptoBalance,
      snapshot.remainingCostBasisFiat,
      snapshot.markRate,
      snapshot.quoteCurrency,
      snapshot.createdAt,
      Array.isArray(snapshot.txIds) ? snapshot.txIds.join('|') : '',
    ]
      .map(csvEscape)
      .join(',');
  });

  return [headers.join(','), ...rows].join('\n');
};

const PortfolioWalletDebug = ({route}: PortfolioWalletDebugScreenProps) => {
  const {t} = useTranslation();
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const dispatch = useAppDispatch();
  const {walletId} = route.params;

  const walletKeys = useAppSelector(({WALLET}) => WALLET?.keys || {});
  const mismatch = useAppSelector(
    ({PORTFOLIO}) => PORTFOLIO.snapshotBalanceMismatchesByWalletId?.[walletId],
  );

  const [index, setIndex] = useState<SnapshotIndexV2 | null>(null);
  const [latestSnapshot, setLatestSnapshot] = useState<BalanceSnapshotStored | null>(null);
  const [snapshots, setSnapshots] = useState<BalanceSnapshotStored[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [runtimeError, setRuntimeError] = useState<string>('');
  const [copyJsonState, setCopyJsonState] = useState<'idle' | 'copied'>('idle');
  const [copyCsvState, setCopyCsvState] = useState<'idle' | 'copied'>('idle');

  const wallet = useMemo(
    () => findWalletById(walletKeys, walletId),
    [walletId, walletKeys],
  );

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setRuntimeError('');

    try {
      const client = getPortfolioRuntimeClient();
      const [nextIndex, nextLatestSnapshot, nextSnapshots] = await Promise.all([
        client.getSnapshotIndex({walletId}),
        client.getLatestSnapshot({walletId}),
        client.listSnapshots({walletId}),
      ]);

      setIndex(nextIndex || null);
      setLatestSnapshot(nextLatestSnapshot || null);
      setSnapshots(Array.isArray(nextSnapshots) ? nextSnapshots : []);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logManager.error('[PortfolioWalletDebug] refresh failed', message);
      setRuntimeError(message);
      setIndex(null);
      setLatestSnapshot(null);
      setSnapshots([]);
    } finally {
      setIsLoading(false);
    }
  }, [walletId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const previewJson = useMemo(() => {
    const payload = {
      wallet: wallet
        ? {
            walletId: wallet.id,
            walletName: (wallet as any)?.walletName,
            chain: (wallet as any)?.chain,
            currencyAbbreviation: (wallet as any)?.currencyAbbreviation,
            network: (wallet as any)?.network,
            balance: (wallet as any)?.balance || null,
          }
        : null,
      mismatch: mismatch || null,
      index,
      latestSnapshot,
      snapshotsPreview: {
        total: snapshots.length,
        first: snapshots.slice(0, 10),
        last: snapshots.slice(-10),
      },
    };

    return JSON.stringify(payload, null, 2);
  }, [index, latestSnapshot, mismatch, snapshots, wallet]);

  const copyJson = useCallback(() => {
    Clipboard.setString(
      JSON.stringify(
        {
          wallet,
          mismatch,
          index,
          latestSnapshot,
          snapshots,
        },
        null,
        2,
      ),
    );
    setCopyJsonState('copied');
    setTimeout(() => setCopyJsonState('idle'), 1200);
  }, [index, latestSnapshot, mismatch, snapshots, wallet]);

  const copyCsv = useCallback(() => {
    Clipboard.setString(toCsv(snapshots));
    setCopyCsvState('copied');
    setTimeout(() => setCopyCsvState('idle'), 1200);
  }, [snapshots]);

  const clearWallet = useCallback(async () => {
    try {
      await dispatch(clearWalletPortfolioDataWithRuntime({walletIds: [walletId]}) as any);
      await refresh();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      setRuntimeError(message);
    }
  }, [dispatch, refresh, walletId]);

  const repopulateWallet = useCallback(async () => {
    try {
      await dispatch(
        populatePortfolio(
          wallet
            ? {wallets: [wallet], walletIds: [walletId]}
            : {walletIds: [walletId]},
        ) as any,
      );
      await refresh();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      setRuntimeError(message);
    }
  }, [dispatch, refresh, wallet, walletId]);

  const viewWallet = useCallback(() => {
    if (!wallet) {
      return;
    }

    navigation.navigate(WalletScreens.WALLET_DETAILS, {
      walletId: wallet.id,
    });
  }, [navigation, wallet]);

  const rowsCount = getRowCount(index);
  const latestTimestamp = latestSnapshot?.timestamp;
  const latestBalance = latestSnapshot?.cryptoBalance;

  return (
    <DebugScreenContainer>
      <ScrollView>
        <DebugHeaderContainer>
          <DebugHeaderText>
            {t('Runtime wallet debug view for a single portfolio wallet.')}
          </DebugHeaderText>
          <DebugButtonRow>
            <DebugPillButton onPress={refresh}>
              <DebugPillButtonText>{isLoading ? t('Loading...') : t('Refresh')}</DebugPillButtonText>
            </DebugPillButton>
            <DebugPillButton disabled={!wallet} onPress={viewWallet}>
              <DebugPillButtonText>{t('View Wallet')}</DebugPillButtonText>
            </DebugPillButton>
            <DebugPillButton onPress={repopulateWallet}>
              <DebugPillButtonText>{t('Populate Wallet')}</DebugPillButtonText>
            </DebugPillButton>
            <DebugPillButton onPress={clearWallet}>
              <DebugPillButtonText>{t('Clear Wallet')}</DebugPillButtonText>
            </DebugPillButton>
            <DebugPillButton onPress={copyJson}>
              <DebugPillButtonText>{copyJsonState === 'copied' ? t('Copied') : t('Copy JSON')}</DebugPillButtonText>
            </DebugPillButton>
            <DebugPillButton onPress={copyCsv}>
              <DebugPillButtonText>{copyCsvState === 'copied' ? t('Copied') : t('Copy CSV')}</DebugPillButtonText>
            </DebugPillButton>
          </DebugButtonRow>
        </DebugHeaderContainer>

        {runtimeError ? <ErrorText>{runtimeError}</ErrorText> : null}

        <SectionTitle>{t('Wallet')}</SectionTitle>
        <SectionText>
          {wallet
            ? [
                `walletId: ${wallet.id}`,
                `walletName: ${String((wallet as any)?.walletName || (wallet as any)?.name || wallet.id)}`,
                `chain: ${String((wallet as any)?.chain || '')}`,
                `coin: ${String((wallet as any)?.currencyAbbreviation || '')}`,
                `network: ${String((wallet as any)?.network || '')}`,
              ].join('\n')
            : `walletId: ${walletId}\nwallet not found in current Redux wallet state`}
        </SectionText>

        <SectionTitle>{t('Runtime snapshot index')}</SectionTitle>
        <SectionText>
          {index
            ? [
                `rows: ${rowsCount}`,
                `chunks: ${index.chunks?.length || 0}`,
                `chunkRows: ${index.chunkRows}`,
                `compressionEnabled: ${index.compressionEnabled ? 'yes' : 'no'}`,
                `checkpoint.nextSkip: ${index.checkpoint?.nextSkip ?? 0}`,
                `updatedAt: ${toIso(index.updatedAt)}`,
              ].join('\n')
            : 'No runtime snapshot index'}
        </SectionText>

        <SectionTitle>{t('Latest snapshot')}</SectionTitle>
        <SectionText>
          {latestSnapshot
            ? [
                `id: ${latestSnapshot.id}`,
                `timestamp: ${latestSnapshot.timestamp}`,
                `iso: ${toIso(latestTimestamp)}`,
                `eventType: ${latestSnapshot.eventType}`,
                `cryptoBalance: ${latestBalance}`,
                `remainingCostBasisFiat: ${latestSnapshot.remainingCostBasisFiat}`,
                `markRate: ${latestSnapshot.markRate}`,
                `quoteCurrency: ${latestSnapshot.quoteCurrency}`,
              ].join('\n')
            : 'No latest snapshot'}
        </SectionText>

        <SectionTitle>{t('Mismatch')}</SectionTitle>
        <SectionText>
          {mismatch
            ? [
                `delta: ${mismatch.delta}`,
                `currentWalletBalance: ${mismatch.currentWalletBalance}`,
                `computedUnitsHeld: ${mismatch.computedUnitsHeld}`,
              ].join('\n')
            : 'No recorded mismatch'}
        </SectionText>

        <SectionTitle>{t('Raw preview')}</SectionTitle>
        <JsonLineText>{previewJson}</JsonLineText>
        <DebugButtonSpacer />
      </ScrollView>
    </DebugScreenContainer>
  );
};

export default PortfolioWalletDebug;
