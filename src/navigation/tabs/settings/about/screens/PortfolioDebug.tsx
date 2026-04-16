import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Pressable, ScrollView} from 'react-native';
import styled from 'styled-components/native';
import Clipboard from '@react-native-clipboard/clipboard';
import {useTranslation} from 'react-i18next';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {Network} from '../../../../../constants';
import {useAppDispatch, useAppSelector} from '../../../../../utils/hooks';
import {getPortfolioRuntimeClient} from '../../../../../portfolio/runtime/portfolioRuntime';
import type {SnapshotIndexV2} from '../../../../../portfolio/core/pnl/snapshotStore';
import type {Wallet} from '../../../../../store/wallet/wallet.models';
import type {SnapshotBalanceMismatch} from '../../../../../store/portfolio/portfolio.models';
import {clearPortfolioWithRuntime, populatePortfolio} from '../../../../../store/portfolio';
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
import {logManager} from '../../../../../managers/LogManager';

type PortfolioDebugScreenProps = NativeStackScreenProps<
  AboutGroupParamList,
  AboutScreens.PORTFOLIO_DEBUG
>;

type RuntimeWalletRow = {
  wallet: Wallet;
  index: SnapshotIndexV2 | null;
  rowCount: number;
  chunkCount: number;
  mismatch?: SnapshotBalanceMismatch;
};

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

const SectionText = styled.Text`
  padding: 0 12px 12px;
  color: ${({theme}) => theme.colors.text};
  font-size: 12px;
  line-height: 18px;
`;

const ErrorText = styled(SectionText)`
  color: ${({theme}) => theme.colors.notification};
`;

const EmptyStateText = styled(SectionText)`
  opacity: 0.7;
`;

const formatBytes = (bytes?: number): string => {
  const safeBytes = Number(bytes);
  if (!Number.isFinite(safeBytes) || safeBytes <= 0) {
    return '0 Bytes';
  }

  const units = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(
    Math.floor(Math.log(safeBytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = safeBytes / Math.pow(1024, index);
  const fixed = value >= 100 ? value.toFixed(0) : value.toFixed(2);
  return `${Number(fixed)} ${units[index]}`;
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

const getWalletBalanceLabel = (wallet?: Wallet): string => {
  const crypto = (wallet as any)?.balance?.crypto;
  if (typeof crypto === 'string' && crypto.length) {
    return crypto;
  }

  const sat = (wallet as any)?.balance?.sat;
  if (typeof sat === 'number' && Number.isFinite(sat)) {
    return String(sat);
  }

  return '0';
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

const getAllMainnetWallets = (walletKeys: Record<string, any>): Wallet[] => {
  const rows: Wallet[] = [];

  Object.values(walletKeys || {}).forEach((key: any) => {
    const wallets = Array.isArray(key?.wallets) ? key.wallets : [];
    wallets.forEach((wallet: Wallet) => {
      if ((wallet as any)?.network === Network.mainnet) {
        rows.push(wallet);
      }
    });
  });

  return rows.sort((a, b) => {
    const aName = String((a as any)?.walletName || (a as any)?.id || '');
    const bName = String((b as any)?.walletName || (b as any)?.id || '');
    return aName.localeCompare(bName);
  });
};

const PortfolioDebug = ({navigation}: PortfolioDebugScreenProps) => {
  const {t} = useTranslation();
  const dispatch = useAppDispatch();

  const portfolio = useAppSelector(({PORTFOLIO}) => PORTFOLIO);
  const walletKeys = useAppSelector(({WALLET}) => WALLET?.keys || {});

  const [walletRows, setWalletRows] = useState<RuntimeWalletRow[]>([]);
  const [rateEntries, setRateEntries] = useState<any[]>([]);
  const [kvStats, setKvStats] = useState<any | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const [runtimeError, setRuntimeError] = useState<string>('');
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | undefined>();

  const wallets = useMemo(() => getAllMainnetWallets(walletKeys), [walletKeys]);

  const refreshToken = useMemo(() => {
    return [
      portfolio.lastPopulatedAt || 0,
      portfolio.populateStatus?.inProgress ? 1 : 0,
      portfolio.populateStatus?.errors?.length || 0,
      wallets.length,
    ].join(':');
  }, [portfolio.lastPopulatedAt, portfolio.populateStatus, wallets.length]);

  const load = useCallback(async () => {
    setIsLoading(true);
    setRuntimeError('');

    try {
      const client = getPortfolioRuntimeClient();
      const [nextKvStats, nextRateEntries, indexes] = await Promise.all([
        client.kvStats(),
        client.listRates({}),
        Promise.all(
          wallets.map(async wallet => {
            try {
              return await client.getSnapshotIndex({walletId: wallet.id});
            } catch {
              return null;
            }
          }),
        ),
      ]);

      const nextRows = wallets
        .map((wallet, index): RuntimeWalletRow => {
          const snapshotIndex = indexes[index] || null;
          return {
            wallet,
            index: snapshotIndex,
            rowCount: getRowCount(snapshotIndex),
            chunkCount: snapshotIndex?.chunks?.length || 0,
            mismatch: portfolio.snapshotBalanceMismatchesByWalletId?.[wallet.id],
          };
        })
        .sort((a, b) => {
          const scoreA = (a.index ? 1 : 0) + (a.mismatch ? 1 : 0);
          const scoreB = (b.index ? 1 : 0) + (b.mismatch ? 1 : 0);
          if (scoreA !== scoreB) {
            return scoreB - scoreA;
          }
          const aName = String((a.wallet as any)?.walletName || a.wallet.id || '');
          const bName = String((b.wallet as any)?.walletName || b.wallet.id || '');
          return aName.localeCompare(bName);
        });

      setWalletRows(nextRows);
      setRateEntries(nextRateEntries || []);
      setKvStats(nextKvStats || null);
      setLastRefreshedAt(Date.now());
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logManager.error('[PortfolioDebug] refresh failed', message);
      setRuntimeError(message);
      setWalletRows([]);
      setRateEntries([]);
      setKvStats(null);
    } finally {
      setIsLoading(false);
    }
  }, [portfolio.snapshotBalanceMismatchesByWalletId, wallets]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  const summary = useMemo(() => {
    const walletsWithSnapshots = walletRows.filter(row => !!row.index).length;
    const totalRows = walletRows.reduce((total, row) => total + row.rowCount, 0);
    const totalChunks = walletRows.reduce(
      (total, row) => total + row.chunkCount,
      0,
    );
    const mismatchCount = walletRows.filter(row => !!row.mismatch).length;

    return {
      walletsTotal: wallets.length,
      walletsWithSnapshots,
      totalRows,
      totalChunks,
      mismatchCount,
      rateEntries: rateEntries.length,
      kvStats,
      populateStatus: portfolio.populateStatus,
      lastPopulatedAt: portfolio.lastPopulatedAt,
      lastRefreshedAt,
    };
  }, [kvStats, lastRefreshedAt, portfolio.lastPopulatedAt, portfolio.populateStatus, rateEntries.length, walletRows, wallets.length]);

  const copySummary = useCallback(() => {
    const payload = {
      summary,
      wallets: walletRows.map(row => ({
        walletId: row.wallet.id,
        walletName: (row.wallet as any)?.walletName,
        chain: (row.wallet as any)?.chain,
        currencyAbbreviation: (row.wallet as any)?.currencyAbbreviation,
        network: (row.wallet as any)?.network,
        rowCount: row.rowCount,
        chunkCount: row.chunkCount,
        updatedAt: row.index?.updatedAt,
        mismatch: row.mismatch || null,
      })),
      rates: rateEntries,
    };

    Clipboard.setString(JSON.stringify(payload, null, 2));
    setCopyState('copied');
    setTimeout(() => setCopyState('idle'), 1200);
  }, [rateEntries, summary, walletRows]);

  const repopulate = useCallback(async () => {
    try {
      await dispatch(populatePortfolio() as any);
      void load();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      setRuntimeError(message);
    }
  }, [dispatch, load]);

  const clearAll = useCallback(async () => {
    try {
      await dispatch(clearPortfolioWithRuntime({populateDisabled: false}) as any);
      void load();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      setRuntimeError(message);
    }
  }, [dispatch, load]);

  const clearRates = useCallback(async () => {
    try {
      await getPortfolioRuntimeClient().clearRateStorage();
      await load();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      setRuntimeError(message);
    }
  }, [load]);

  return (
    <DebugScreenContainer>
      <ScrollView>
        <DebugHeaderContainer>
          <DebugHeaderText>
            {t('Runtime-backed portfolio debug info. Redux snapshot arrays are no longer used in production.')}
          </DebugHeaderText>

          <DebugButtonRow>
            <DebugPillButton onPress={() => void load()}>
              <DebugPillButtonText>{isLoading ? t('Loading...') : t('Refresh')}</DebugPillButtonText>
            </DebugPillButton>
            <DebugPillButton onPress={() => void repopulate()}>
              <DebugPillButtonText>{t('Populate')}</DebugPillButtonText>
            </DebugPillButton>
            <DebugPillButton onPress={() => void clearRates()}>
              <DebugPillButtonText>{t('Clear Rates')}</DebugPillButtonText>
            </DebugPillButton>
            <DebugPillButton onPress={() => void clearAll()}>
              <DebugPillButtonText>{t('Clear All')}</DebugPillButtonText>
            </DebugPillButton>
            <DebugPillButton onPress={copySummary}>
              <DebugPillButtonText>{copyState === 'copied' ? t('Copied') : t('Copy JSON')}</DebugPillButtonText>
            </DebugPillButton>
          </DebugButtonRow>
        </DebugHeaderContainer>

        {runtimeError ? <ErrorText>{runtimeError}</ErrorText> : null}

        <SectionText>
          {`Wallets: ${summary.walletsWithSnapshots}/${summary.walletsTotal} with runtime data\n`}
          {`Snapshot rows: ${summary.totalRows}\n`}
          {`Snapshot chunks: ${summary.totalChunks}\n`}
          {`Runtime keys: ${summary.kvStats?.totalKeys || 0}\n`}
          {`Runtime bytes: ${formatBytes(summary.kvStats?.totalBytes)}\n`}
          {`Snapshot bytes: ${formatBytes(summary.kvStats?.snapBytes)}\n`}
          {`Rate bytes: ${formatBytes(summary.kvStats?.rateBytes)}\n`}
          {`Rate entries: ${summary.rateEntries}\n`}
          {`Populate in progress: ${summary.populateStatus?.inProgress ? 'yes' : 'no'}\n`}
          {`Wallets completed: ${summary.populateStatus?.walletsCompleted || 0}/${summary.populateStatus?.walletsTotal || 0}\n`}
          {`Errors: ${summary.populateStatus?.errors?.length || 0}\n`}
          {`Stop reason: ${summary.populateStatus?.stopReason || '—'}\n`}
          {`Mismatches: ${summary.mismatchCount}\n`}
          {`Last populated: ${toIso(summary.lastPopulatedAt)}\n`}
          {`Last refreshed: ${toIso(summary.lastRefreshedAt)}`}
        </SectionText>

        {!walletRows.length ? (
          <EmptyStateText>{t('No mainnet wallets found.')}</EmptyStateText>
        ) : null}

        {walletRows.map(row => {
          const walletName = String(
            (row.wallet as any)?.walletName || (row.wallet as any)?.name || row.wallet.id,
          );
          const subtitle = [
            String((row.wallet as any)?.chain || '').toUpperCase(),
            String((row.wallet as any)?.currencyAbbreviation || '').toUpperCase(),
            String((row.wallet as any)?.network || '').toLowerCase(),
            getWalletBalanceLabel(row.wallet),
          ]
            .filter(Boolean)
            .join(' • ');

          return (
            <WalletRow
              key={row.wallet.id}
              onPress={() =>
                navigation.navigate(AboutScreens.PORTFOLIO_WALLET_DEBUG, {
                  walletId: row.wallet.id,
                })
              }>
              <WalletRowTitle>{walletName}</WalletRowTitle>
              <WalletRowSubTitle>{subtitle}</WalletRowSubTitle>
              <WalletRowSubTitle>
                {row.index
                  ? `rows ${row.rowCount} • chunks ${row.chunkCount} • updated ${toIso(
                      row.index.updatedAt,
                    )}`
                  : 'no runtime snapshot index'}
              </WalletRowSubTitle>
              {row.mismatch ? (
                <WalletRowMismatchText>
                  {`mismatch Δ ${row.mismatch.delta} • live ${row.mismatch.currentWalletBalance} • stored ${row.mismatch.computedUnitsHeld}`}
                </WalletRowMismatchText>
              ) : null}
            </WalletRow>
          );
        })}

        <DebugButtonSpacer />
      </ScrollView>
    </DebugScreenContainer>
  );
};

export default PortfolioDebug;
