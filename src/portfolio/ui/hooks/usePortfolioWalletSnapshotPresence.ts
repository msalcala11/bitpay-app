import {useEffect, useMemo, useState} from 'react';
import type {SnapshotIndexV2} from '../../core/pnl/snapshotStore';
import {getPortfolioRuntimeClient} from '../../runtime/portfolioRuntime';
import {buildCommittedPortfolioRevisionToken} from '../common';
import type {Wallet} from '../../../store/wallet/wallet.models';
import {useAppSelector} from '../../../utils/hooks';

type PortfolioWalletSnapshotPresenceState = {
  hasAnySnapshots: boolean;
  loading: boolean;
  checked: boolean;
};

function snapshotIndexHasRows(index: SnapshotIndexV2 | null | undefined): boolean {
  if (!Array.isArray(index?.chunks) || !index.chunks.length) {
    return false;
  }

  return index.chunks.some(chunk => Number(chunk?.rows) > 0);
}

function getSortedUniqueWalletIds(wallets: Wallet[]): string[] {
  return Array.from(
    new Set(
      (Array.isArray(wallets) ? wallets : [])
        .map(wallet => String(wallet?.id || '').trim())
        .filter(Boolean),
    ),
  ).sort();
}

export default function usePortfolioWalletSnapshotPresence(args: {
  wallets: Wallet[];
  enabled?: boolean;
}): PortfolioWalletSnapshotPresenceState {
  const committedPortfolioRevisionToken = useAppSelector(({PORTFOLIO}) => {
    return buildCommittedPortfolioRevisionToken({
      quoteCurrency: PORTFOLIO.quoteCurrency,
      lastPopulatedAt: PORTFOLIO.lastPopulatedAt,
    });
  });

  const walletIds = useMemo(() => {
    return getSortedUniqueWalletIds(args.wallets);
  }, [args.wallets]);
  const walletIdsKey = useMemo(() => walletIds.join('|'), [walletIds]);

  const [state, setState] = useState<PortfolioWalletSnapshotPresenceState>({
    hasAnySnapshots: false,
    loading: false,
    checked: false,
  });

  useEffect(() => {
    if (args.enabled === false) {
      setState({
        hasAnySnapshots: false,
        loading: false,
        checked: true,
      });
      return;
    }

    const requestedWalletIds = walletIdsKey ? walletIdsKey.split('|') : [];

    if (!requestedWalletIds.length) {
      setState({
        hasAnySnapshots: false,
        loading: false,
        checked: true,
      });
      return;
    }

    let cancelled = false;
    setState(prev => ({
      hasAnySnapshots: prev.hasAnySnapshots,
      loading: true,
      checked: prev.checked,
    }));

    Promise.all(
      requestedWalletIds.map(async walletId => {
        const index = await getPortfolioRuntimeClient().getSnapshotIndex({
          walletId,
        });
        return snapshotIndexHasRows(index);
      }),
    )
      .then(results => {
        if (cancelled) {
          return;
        }

        setState({
          hasAnySnapshots: results.some(Boolean),
          loading: false,
          checked: true,
        });
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        setState({
          hasAnySnapshots: false,
          loading: false,
          checked: true,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [args.enabled, committedPortfolioRevisionToken, walletIdsKey]);

  return state;
}
