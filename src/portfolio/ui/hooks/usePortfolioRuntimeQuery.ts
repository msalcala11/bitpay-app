import {useEffect, useMemo, useState} from 'react';
import type {Wallet} from '../../../store/wallet/wallet.models';
import type {StoredWallet} from '../../core/types';
import type {PnlTimeframe} from '../../core/pnl/analysisStreaming';
import {useAppDispatch, useAppSelector} from '../../../utils/hooks';
import {
  buildCommittedPortfolioRevisionToken,
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

type RuntimeQueryInternalState<T> = {
  requestKey: string;
  refreshToken: string;
  data?: T;
  dataRequestKey?: string;
  dataRefreshToken?: string;
  loading: boolean;
  error?: Error;
};

function getInitialRuntimeQueryState<T>(args: {
  requestKey: string;
  refreshToken: string;
  enabled: boolean;
  storedWallets: StoredWallet[];
}): RuntimeQueryInternalState<T> {
  return {
    requestKey: args.requestKey,
    refreshToken: args.refreshToken,
    data: undefined,
    dataRequestKey: undefined,
    dataRefreshToken: undefined,
    loading: args.enabled && args.storedWallets.length > 0,
    error: undefined,
  };
}

function canExposeRuntimeQueryData<T>(args: {
  state: Pick<
    RuntimeQueryInternalState<T>,
    'dataRequestKey' | 'dataRefreshToken'
  >;
  requestKey: string;
  refreshToken: string;
  clearDataOnRefreshToken?: boolean;
}): boolean {
  return (
    args.state.dataRequestKey === args.requestKey &&
    (args.state.dataRefreshToken === args.refreshToken ||
      args.clearDataOnRefreshToken === false)
  );
}

export function usePortfolioRuntimeQuery<T>(args: {
  wallets: Wallet[];
  timeframe: PnlTimeframe;
  maxPoints?: number;
  enabled?: boolean;
  refreshToken?: string;
  clearDataOnRefreshToken?: boolean;
  execute: (params: {
    wallets: StoredWallet[];
    quoteCurrency: string;
    timeframe: PnlTimeframe;
    maxPoints?: number;
  }) => Promise<T>;
}): PortfolioRuntimeQueryState<T> {
  const dispatch = useAppDispatch();
  const defaultAltCurrency = useAppSelector(({APP}) => APP.defaultAltCurrency);
  const portfolioQuoteCurrency = useAppSelector(
    ({PORTFOLIO}) => PORTFOLIO.quoteCurrency,
  );
  const committedPortfolioRevisionToken = useAppSelector(({PORTFOLIO}) => {
    return buildCommittedPortfolioRevisionToken({
      quoteCurrency: PORTFOLIO.quoteCurrency,
      lastPopulatedAt: PORTFOLIO.lastPopulatedAt,
    });
  });
  const refreshToken = args.refreshToken ?? committedPortfolioRevisionToken;
  const enabled = args.enabled !== false;

  const quoteCurrency = useMemo(() => {
    return resolveCommittedPortfolioQuoteCurrency({
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

  const [queryState, setQueryState] = useState<RuntimeQueryInternalState<T>>(
    () =>
      getInitialRuntimeQueryState<T>({
        requestKey,
        refreshToken,
        enabled,
        storedWallets,
      }),
  );

  useEffect(() => {
    if (!enabled) {
      setQueryState(prev => {
        if (
          prev.requestKey === requestKey &&
          prev.refreshToken === refreshToken &&
          prev.loading === false &&
          prev.error === undefined
        ) {
          return prev;
        }

        return {
          ...prev,
          requestKey,
          refreshToken,
          loading: false,
          error: undefined,
        };
      });
      return;
    }

    if (!storedWallets.length) {
      setQueryState(prev => {
        if (
          prev.requestKey === requestKey &&
          prev.refreshToken === refreshToken &&
          prev.loading === false &&
          prev.error === undefined &&
          prev.data === undefined &&
          prev.dataRequestKey === undefined &&
          prev.dataRefreshToken === undefined
        ) {
          return prev;
        }

        return {
          requestKey,
          refreshToken,
          data: undefined,
          dataRequestKey: undefined,
          dataRefreshToken: undefined,
          loading: false,
          error: undefined,
        };
      });
      return;
    }

    let cancelled = false;

    setQueryState(prev => {
      const isSameRequestIdentity =
        prev.requestKey === requestKey && prev.refreshToken === refreshToken;
      const shouldKeepVisibleData = canExposeRuntimeQueryData({
        state: prev,
        requestKey,
        refreshToken,
        clearDataOnRefreshToken: args.clearDataOnRefreshToken,
      });

      if (
        isSameRequestIdentity &&
        prev.loading &&
        prev.error === undefined &&
        (shouldKeepVisibleData || prev.data === undefined)
      ) {
        return prev;
      }

      return {
        ...prev,
        requestKey,
        refreshToken,
        loading: true,
        error: undefined,
        data: shouldKeepVisibleData ? prev.data : undefined,
        dataRequestKey: shouldKeepVisibleData ? prev.dataRequestKey : undefined,
        dataRefreshToken: shouldKeepVisibleData
          ? prev.dataRefreshToken
          : undefined,
      };
    });

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

        setQueryState({
          requestKey,
          refreshToken,
          data: result,
          dataRequestKey: requestKey,
          dataRefreshToken: refreshToken,
          loading: false,
          error: undefined,
        });
      })
      .catch(err => {
        if (cancelled) {
          return;
        }

        setQueryState(prev => {
          const shouldKeepVisibleData = canExposeRuntimeQueryData({
            state: prev,
            requestKey,
            refreshToken,
            clearDataOnRefreshToken: args.clearDataOnRefreshToken,
          });

          return {
            ...prev,
            requestKey,
            refreshToken,
            loading: false,
            error: err instanceof Error ? err : new Error(String(err)),
            data: shouldKeepVisibleData ? prev.data : undefined,
            dataRequestKey: shouldKeepVisibleData
              ? prev.dataRequestKey
              : undefined,
            dataRefreshToken: shouldKeepVisibleData
              ? prev.dataRefreshToken
              : undefined,
          };
        });
      });

    return () => {
      cancelled = true;
    };
  }, [
    args.clearDataOnRefreshToken,
    args.execute,
    args.maxPoints,
    args.timeframe,
    enabled,
    quoteCurrency,
    refreshToken,
    requestKey,
    storedWallets,
  ]);

  const data = canExposeRuntimeQueryData({
    state: queryState,
    requestKey,
    refreshToken,
    clearDataOnRefreshToken: args.clearDataOnRefreshToken,
  })
    ? queryState.data
    : undefined;
  const error =
    queryState.requestKey === requestKey &&
    queryState.refreshToken === refreshToken
      ? queryState.error
      : undefined;
  const loading =
    enabled &&
    storedWallets.length > 0 &&
    (queryState.requestKey !== requestKey ||
      queryState.refreshToken !== refreshToken ||
      queryState.loading);

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
