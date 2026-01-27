import React, {useCallback, useMemo, useState} from 'react';
import {InteractionManager, Platform, ScrollView} from 'react-native';
import styled from 'styled-components/native';
import {useTheme} from 'styled-components/native';
import {useTranslation} from 'react-i18next';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import Clipboard from '@react-native-clipboard/clipboard';
import {useAppSelector} from '../../../../../utils/hooks';
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
import {WalletScreens} from '../../../../wallet/WalletGroup';
import type {
  BalanceSnapshot,
  SnapshotBalanceMismatch,
} from '../../../../../store/portfolio/portfolio.models';
import type {Wallet} from '../../../../../store/wallet/wallet.models';

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

const csvEscape = (v: unknown): string => {
  const s = v == null ? '' : String(v);
  if (/[\n\r,\"]/g.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
};

const formatTimestampForCsv = (timestamp: unknown): string => {
  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum)) {
    return '';
  }
  const d = new Date(tsNum);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) {
    return '';
  }
  return d.toISOString();
};

const getImpliedRateForCsv = (s: BalanceSnapshot): string => {
  const balanceNum = Number(s.cryptoBalance);
  if (!(Number.isFinite(balanceNum) && balanceNum > 0)) {
    return '';
  }
  const basisNum = Number(s.remainingCostBasisFiat);
  const pnlNum = Number(s.unrealizedPnlFiat);
  if (!(Number.isFinite(basisNum) && Number.isFinite(pnlNum))) {
    return '';
  }
  const rate = (basisNum + pnlNum) / balanceNum;
  return Number.isFinite(rate) ? String(rate) : '';
};

const PortfolioWalletDebug = ({
  route,
  navigation,
}: PortfolioWalletDebugScreenProps) => {
  const {t} = useTranslation();
  const theme = useTheme();

  const {walletId} = route.params;
  const portfolio = useAppSelector(({PORTFOLIO}) => PORTFOLIO);
  const walletKeys = useAppSelector(({WALLET}) => WALLET?.keys || {});

  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [copyCsvState, setCopyCsvState] = useState<'idle' | 'copied'>('idle');

  const walletSnapshots: BalanceSnapshot[] = useMemo(() => {
    return (portfolio.snapshotsByWalletId?.[walletId] ||
      []) as BalanceSnapshot[];
  }, [portfolio.snapshotsByWalletId, walletId]);

  const wallet = useMemo(() => {
    for (const key of Object.values(walletKeys || {}) as any[]) {
      const wallets: Wallet[] = Array.isArray(key?.wallets) ? key.wallets : [];
      const found = wallets.find((w: Wallet) => w?.id === walletId);
      if (found) {
        return found;
      }
    }
    return undefined;
  }, [walletId, walletKeys]);

  const cryptoBalanceString = useMemo(() => {
    if (!wallet) {
      return '—';
    }
    if (typeof wallet.balance?.crypto === 'string') {
      return wallet.balance.crypto;
    }
    if (typeof wallet.balance?.sat === 'number') {
      return wallet.balance.sat.toString();
    }
    return '0';
  }, [wallet]);

  const cryptoBalanceSatString = useMemo(() => {
    if (typeof wallet?.balance?.sat === 'number') {
      return wallet.balance.sat;
    }
    return '—';
  }, [wallet]);

  const snapshotCryptoBalanceString = useMemo(() => {
    const last = walletSnapshots.length
      ? walletSnapshots[walletSnapshots.length - 1]
      : undefined;
    return last?.cryptoBalance ?? '—';
  }, [walletSnapshots]);

  const mismatch = useMemo(() => {
    return (portfolio.snapshotBalanceMismatchesByWalletId || {})[walletId] as
      | SnapshotBalanceMismatch
      | undefined;
  }, [portfolio.snapshotBalanceMismatchesByWalletId, walletId]);

  const jsonString = useMemo(() => {
    const json = {
      walletId,
      quoteCurrency: portfolio.quoteCurrency,
      lastPopulatedAt: portfolio.lastPopulatedAt,
      populateStatus: portfolio.populateStatus,
      balanceMismatch: mismatch,
      snapshots: walletSnapshots,
    };

    try {
      return JSON.stringify(json, null, 2);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return JSON.stringify(
        {error: 'Failed to stringify wallet portfolio debug data', message},
        null,
        2,
      );
    }
  }, [mismatch, portfolio, walletId, walletSnapshots]);

  const displayJson = useMemo(() => {
    const limit = 200000;
    if (jsonString.length > limit) {
      return (
        jsonString.slice(0, limit) +
        `\n...TRUNCATED (${jsonString.length} chars)`
      );
    }
    return jsonString;
  }, [jsonString]);

  const copyCsv = useCallback(() => {
    if (isGenerating) {
      return;
    }

    setIsGenerating(true);
    const task = InteractionManager.runAfterInteractions(() => {
      try {
        const headers = [
          'chain',
          'coin',
          'network',
          'assetId',
          'timestamp',
          'date',
          'dayStartMs',
          'eventType',
          'direction',
          'cryptoBalance',
          'cryptoDelta',
          'avgCostFiatPerUnit',
          'remainingCostBasisFiat',
          'unrealizedPnlFiat',
          'impliedRateFiatPerUnit',
          'costBasisRateFiat',
          'quoteCurrency',
          'createdAt',
        ];

        const rows = walletSnapshots.map(
          (s: BalanceSnapshot, index: number) => {
            const prevBalance =
              index > 0 ? walletSnapshots[index - 1].cryptoBalance : '0';
            const currentBalanceNum = Number(s.cryptoBalance);
            const prevBalanceNum = Number(prevBalance);
            const cryptoDelta =
              Number.isFinite(currentBalanceNum) &&
              Number.isFinite(prevBalanceNum)
                ? (currentBalanceNum - prevBalanceNum).toString()
                : '';

            return [
              s.chain,
              s.coin,
              s.network,
              s.assetId,
              s.timestamp,
              formatTimestampForCsv(s.timestamp),
              s.dayStartMs ?? '',
              s.eventType,
              s.direction ?? '',
              s.cryptoBalance,
              cryptoDelta,
              s.avgCostFiatPerUnit,
              s.remainingCostBasisFiat,
              s.unrealizedPnlFiat,
              getImpliedRateForCsv(s),
              s.costBasisRateFiat ?? '',
              s.quoteCurrency,
              s.createdAt ?? '',
            ]
              .map(csvEscape)
              .join(',');
          },
        );

        const csv = [headers.join(','), ...rows].join('\n');
        Clipboard.setString(csv);
        setCopyCsvState('copied');
        setTimeout(() => setCopyCsvState('idle'), 1500);
      } finally {
        setIsGenerating(false);
      }
    });

    return () => task.cancel();
  }, [isGenerating, walletSnapshots]);

  return (
    <DebugScreenContainer>
      <DebugHeaderContainer>
        <DebugHeaderText>
          {t('Wallet')}: {walletId}
        </DebugHeaderText>
        <DebugHeaderText>
          {t('Snapshots')}: {walletSnapshots.length} | mismatches:{' '}
          {mismatch ? 'yes' : 'no'}
        </DebugHeaderText>
        <DebugHeaderText>
          {t('Crypto balance')}: {cryptoBalanceString}
        </DebugHeaderText>
        <DebugHeaderText>
          {t('Crypto balance (sat)')}: {cryptoBalanceSatString}
        </DebugHeaderText>
        <DebugHeaderText>
          {t('Snapshot-based crypto balance')}: {snapshotCryptoBalanceString}
        </DebugHeaderText>

        <DebugButtonRow>
          <DebugPillButton onPress={() => (isGenerating ? null : copyCsv())}>
            <DebugPillButtonText>
              {copyCsvState === 'copied' ? t('Copied') : t('Copy CSV')}
            </DebugPillButtonText>
          </DebugPillButton>
          <DebugButtonSpacer />
          <DebugPillButton
            onPress={() =>
              navigation.navigate(WalletScreens.WALLET_DETAILS as any, {
                walletId,
              })
            }>
            <DebugPillButtonText>{t('Wallet Details')}</DebugPillButtonText>
          </DebugPillButton>
        </DebugButtonRow>
      </DebugHeaderContainer>

      <ScrollView
        style={{flex: 1}}
        contentContainerStyle={{
          paddingBottom: 40,
          backgroundColor: theme.colors.background,
        }}>
        <JsonLineText selectable>{displayJson}</JsonLineText>
      </ScrollView>
    </DebugScreenContainer>
  );
};

export default PortfolioWalletDebug;
