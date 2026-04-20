import {useEffect, useMemo, useRef, useState} from 'react';
import type {Wallet} from '../../../store/wallet/wallet.models';
import type {StoredWallet} from '../../core/types';
import type {PnlTimeframe} from '../../core/pnl/analysisStreaming';
import {useAppDispatch, useAppSelector} from '../../../utils/hooks';
import {
  buildCurrentRatesByAssetId,
  buildCommittedPortfolioRevisionToken,
  getCurrentRatesByAssetIdSignature,
  getStoredWalletRequestSignature,
  mapWalletsToStoredWallets,
  resolveCommittedPortfolioQuoteCurrency,
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
  refreshToken?: string;
  clearDataToken?: string;
  clearDataOnRefreshToken?: boolean;
  execute: (params: {
    wallets: StoredWallet[];
    quoteCurrency: string;
    timeframe: PnlTimeframe;
    maxPoints?: number;
    currentRatesByAssetId?: Record<string, number>;
  }) => Promise<T>;
}): PortfolioRuntimeQueryState<T> {
  const {
    wallets,
    timeframe,
    maxPoints,
    enabled,
    refreshToken: refreshTokenOverride,
    clearDataToken: clearDataTokenOverride,
    clearDataOnRefreshToken,
    execute,
  } = args;
  const dispatch = useAppDispatch();
  const defaultAltCurrency = useAppSelector(({APP}) => APP.defaultAltCurrency);
  const portfolioQuoteCurrency = useAppSelector(
    ({PORTFOLIO}) => PORTFOLIO.quoteCurrency,
  );
  const rates = useAppSelector(({RATE}) => RATE.rates);
  const committedPortfolioRevisionToken = useAppSelector(({PORTFOLIO}) => {
    return buildCommittedPortfolioRevisionToken({
      quoteCurrency: PORTFOLIO.quoteCurrency,
      lastPopulatedAt: PORTFOLIO.lastPopulatedAt,
    });
  });
  const refreshToken = refreshTokenOverride ?? committedPortfolioRevisionToken;
  const clearDataToken = clearDataTokenOverride ?? refreshToken;

  const quoteCurrency = useMemo(() => {
    return resolveCommittedPortfolioQuoteCurrency({
      portfolioQuoteCurrency,
      defaultAltCurrencyIsoCode: defaultAltCurrency?.isoCode,
    });
  }, [defaultAltCurrency?.isoCode, portfolioQuoteCurrency]);

  const {eligibleWallets, storedWallets} = useMemo(() => {
    return mapWalletsToStoredWallets({
      dispatch,
      wallets,
    });
  }, [dispatch, wallets]);
  const currentRatesByAssetId = useMemo(() => {
    return buildCurrentRatesByAssetId({
      storedWallets,
      quoteCurrency,
      rates,
    });
  }, [quoteCurrency, rates, storedWallets]);
  const currentRatesSignature = useMemo(() => {
    return getCurrentRatesByAssetIdSignature(currentRatesByAssetId);
  }, [currentRatesByAssetId]);

  const requestKey = useMemo(() => {
    return [
      quoteCurrency,
      timeframe,
      typeof maxPoints === 'number' ? String(maxPoints) : '',
      getStoredWalletRequestSignature(storedWallets),
      currentRatesSignature,
    ].join('|');
  }, [currentRatesSignature, maxPoints, quoteCurrency, storedWallets, timeframe]);
  const executeParamsRef = useRef({
    wallets: storedWallets,
    quoteCurrency,
    timeframe,
    maxPoints,
    currentRatesByAssetId,
  });
  executeParamsRef.current = {
    wallets: storedWallets,
    quoteCurrency,
    timeframe,
    maxPoints,
    currentRatesByAssetId,
  };
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);
  const lastClearDataTokenRef = useRef(clearDataToken);

  useEffect(() => {
    if (!clearDataOnRefreshToken) {
      lastClearDataTokenRef.current = clearDataToken;
      return;
    }

    if (lastClearDataTokenRef.current !== clearDataToken) {
      setData(undefined);
      lastClearDataTokenRef.current = clearDataToken;
      return;
    }

    lastClearDataTokenRef.current = clearDataToken;
  }, [clearDataOnRefreshToken, clearDataToken]);
  useEffect(() => {
    if (enabled === false) {
      setLoading(false);
      return;
    }

    const executeParams = executeParamsRef.current;

    if (!executeParams.wallets.length) {
      setData(undefined);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(undefined);

    execute(executeParams)
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
    enabled,
    execute,
    requestKey,
    refreshToken,
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
