import {useEffect, useMemo, useState} from 'react';
import type {Wallet} from '../../../store/wallet/wallet.models';
import type {StoredWallet} from '../../core/types';
import type {PnlTimeframe} from '../../core/pnl/analysisStreaming';
import {useAppDispatch, useAppSelector} from '../../../utils/hooks';
import {
  getStoredWalletRequestSignature,
  mapWalletsToStoredWallets,
  resolvePortfolioQuoteCurrency,
} from '../common';

export type PortfolioRuntimeQueryState<T> = {
  data?: T;
  loading: boolean;
  error?: Error;
  quoteCurrency: string;
  storedWallets: StoredWallet[];
  eligibleWallets: Wallet[];
  requestKey: string;
};

export function usePortfolioRuntimeQuery<T>(args: {
  wallets: Wallet[];
  timeframe: PnlTimeframe;
  maxPoints?: number;
  enabled?: boolean;
  execute: (params: {
    wallets: StoredWallet[];
    quoteCurrency: string;
    timeframe: PnlTimeframe;
    maxPoints?: number;
  }) => Promise<T>;
}): PortfolioRuntimeQueryState<T> {
  const dispatch = useAppDispatch();
  const defaultAltCurrency = useAppSelector(({APP}) => APP.defaultAltCurrency);
  const portfolioQuoteCurrency = useAppSelector(({PORTFOLIO}) => PORTFOLIO.quoteCurrency);
  const populateRefreshToken = useAppSelector(({PORTFOLIO}) => {
    const status = PORTFOLIO.populateStatus;

    return [
      typeof PORTFOLIO.lastPopulatedAt === 'number'
        ? String(PORTFOLIO.lastPopulatedAt)
        : '',
      status?.inProgress ? '1' : '0',
      status?.currentWalletId || '',
      typeof status?.walletsCompleted === 'number'
        ? String(status.walletsCompleted)
        : '',
    ].join('|');
  });

  const quoteCurrency = useMemo(() => {
    return resolvePortfolioQuoteCurrency({
      portfolioQuoteCurrency,
      defaultAltCurrencyIsoCode: defaultAltCurrency?.isoCode,
    });
  }, [defaultAltCurrency?.isoCode, portfolioQuoteCurrency]);

  const {eligibleWallets, storedWallets} = useMemo(() => {
    return mapWalletsToStoredWallets({
      dispatch,
      wallets: args.wallets,
    });
  }, [args.wallets, dispatch]);

  const requestKey = useMemo(() => {
    return [
      quoteCurrency,
      args.timeframe,
      typeof args.maxPoints === 'number' ? String(args.maxPoints) : '',
      getStoredWalletRequestSignature(storedWallets),
    ].join('|');
  }, [args.maxPoints, args.timeframe, quoteCurrency, storedWallets]);

  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);

  useEffect(() => {
    setData(undefined);
    setLoading(false);
    setError(undefined);
  }, [requestKey]);

  useEffect(() => {
    if (args.enabled === false) {
      setLoading(false);
      return;
    }

    if (!storedWallets.length) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(undefined);

    args
      .execute({
        wallets: storedWallets,
        quoteCurrency,
        timeframe: args.timeframe,
        maxPoints: args.maxPoints,
      })
      .then(result => {
        if (cancelled) {
          return;
        }
        setData(result);
        setLoading(false);
      })
      .catch(err => {
        if (cancelled) {
          return;
        }
        setLoading(false);
        setError(err instanceof Error ? err : new Error(String(err)));
      });

    return () => {
      cancelled = true;
    };
  }, [
    args.enabled,
    args.execute,
    args.maxPoints,
    args.timeframe,
    quoteCurrency,
    requestKey,
    storedWallets,
    populateRefreshToken,
  ]);

  return {
    data,
    loading,
    error,
    quoteCurrency,
    storedWallets,
    eligibleWallets,
    requestKey,
  };
}

export default usePortfolioRuntimeQuery;
