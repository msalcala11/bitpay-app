import {useEffect, useMemo, useRef, useState} from 'react';
import type {Wallet} from '../../../store/wallet/wallet.models';
import type {StoredWallet} from '../../core/types';
import type {PnlTimeframe} from '../../core/pnl/analysisStreaming';
import {useAppDispatch, useAppSelector} from '../../../utils/hooks';
import {
  buildCurrentRatesByAssetId,
  buildCommittedPortfolioRevisionToken,
  resolveActivePortfolioDisplayQuoteCurrency,
  getCurrentRatesByAssetIdSignature,
  getStoredWalletRequestSignature,
  mapWalletsToStoredWallets,
  resolveCurrentRatesAsOfMs,
} from '../common';

export type PortfolioRuntimeQueryState<T> = {
  data?: T;
  loading: boolean;
  error?: Error;
  quoteCurrency: string;
  storedWallets: StoredWallet[];
  eligibleWallets: Wallet[];
  requestKey: string;
  currentRatesByAssetId: Record<string, number>;
  currentRatesSignature: string;
  asOfMs: number;
};

function shouldLogPortfolioAssetDiagnostics(debugSource?: string): boolean {
  return /asset/i.test(String(debugSource || ''));
}

function summarizeRuntimeQueryResultShape(value: unknown): {
  walletCount: number;
  pointCount: number;
  assetSummaryCount: number;
} {
  const record = value as
    | {
        wallets?: unknown[];
        points?: unknown[];
        assetSummaries?: unknown[];
      }
    | undefined;

  return {
    walletCount: Array.isArray(record?.wallets) ? record.wallets.length : 0,
    pointCount: Array.isArray(record?.points) ? record.points.length : 0,
    assetSummaryCount: Array.isArray(record?.assetSummaries)
      ? record.assetSummaries.length
      : 0,
  };
}

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
    asOfMs: number;
    debugSource?: string;
  }) => Promise<T>;
  debugSource?: string;
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
    debugSource,
  } = args;
  const dispatch = useAppDispatch();
  const defaultAltCurrency = useAppSelector(({APP}) => APP.defaultAltCurrency);
  const rates = useAppSelector(({RATE}) => RATE.rates);
  const ratesUpdatedAt = useAppSelector(({RATE}) => RATE.ratesUpdatedAt);
  const committedPortfolioRevisionToken = useAppSelector(({PORTFOLIO}) => {
    return buildCommittedPortfolioRevisionToken({
      lastPopulatedAt: PORTFOLIO.lastPopulatedAt,
    });
  });
  const refreshToken = refreshTokenOverride ?? committedPortfolioRevisionToken;
  const clearDataToken = clearDataTokenOverride ?? refreshToken;
  const shouldLogDiagnostics = shouldLogPortfolioAssetDiagnostics(debugSource);

  const quoteCurrency = useMemo(() => {
    return resolveActivePortfolioDisplayQuoteCurrency({
      defaultAltCurrencyIsoCode: defaultAltCurrency?.isoCode,
    });
  }, [defaultAltCurrency?.isoCode]);

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
  const fallbackAsOfMsRef = useRef<number>(Date.now());
  const asOfMs = useMemo(() => {
    return (
      resolveCurrentRatesAsOfMs({
        ratesUpdatedAt,
        rates,
      }) ?? fallbackAsOfMsRef.current
    );
  }, [rates, ratesUpdatedAt]);

  const requestKey = useMemo(() => {
    return [
      quoteCurrency,
      timeframe,
      typeof maxPoints === 'number' ? String(maxPoints) : '',
      getStoredWalletRequestSignature(storedWallets),
      currentRatesSignature,
      String(asOfMs),
    ].join('|');
  }, [
    asOfMs,
    currentRatesSignature,
    maxPoints,
    quoteCurrency,
    storedWallets,
    timeframe,
  ]);
  const executeParamsRef = useRef({
    wallets: storedWallets,
    quoteCurrency,
    timeframe,
    maxPoints,
    currentRatesByAssetId,
    asOfMs,
    debugSource,
  });
  executeParamsRef.current = {
    wallets: storedWallets,
    quoteCurrency,
    timeframe,
    maxPoints,
    currentRatesByAssetId,
    asOfMs,
    debugSource,
  };
  const [data, setData] = useState<{
    requestKey: string;
    value?: T;
  }>({
    requestKey: '',
    value: undefined,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);
  const lastClearDataTokenRef = useRef(clearDataToken);
  const executionIdRef = useRef(0);
  const lastAppliedExecutionIdRef = useRef(0);
  const inFlightExecutionIdsRef = useRef(new Set<number>());
  const latestRequestKeyRef = useRef(requestKey);
  const latestClearDataTokenRef = useRef(clearDataToken);
  const latestEnabledRef = useRef(enabled !== false);
  const unmountedRef = useRef(false);
  const hasPendingRequest =
    enabled !== false &&
    !!storedWallets.length &&
    data.requestKey !== requestKey;

  latestRequestKeyRef.current = requestKey;
  latestClearDataTokenRef.current = clearDataToken;
  latestEnabledRef.current = enabled !== false;

  useEffect(() => {
    return () => {
      unmountedRef.current = true;
      inFlightExecutionIdsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!clearDataOnRefreshToken) {
      lastClearDataTokenRef.current = clearDataToken;
      return;
    }

    if (lastClearDataTokenRef.current !== clearDataToken) {
      if (shouldLogDiagnostics) {
        console.log('[portfolio-runtime-query] clear-data', {
          source: debugSource || 'unknown',
          previousClearDataToken: lastClearDataTokenRef.current,
          nextClearDataToken: clearDataToken,
          hadData: !!data.value,
          loading,
        });
      }
      setData({
        requestKey: '',
        value: undefined,
      });
      lastClearDataTokenRef.current = clearDataToken;
      return;
    }

    lastClearDataTokenRef.current = clearDataToken;
  }, [
    clearDataOnRefreshToken,
    clearDataToken,
    data.value,
    debugSource,
    loading,
    shouldLogDiagnostics,
  ]);
  useEffect(() => {
    if (enabled === false) {
      inFlightExecutionIdsRef.current.clear();
      setLoading(false);
      return;
    }

    const executeParams = executeParamsRef.current;

    if (!executeParams.wallets.length) {
      inFlightExecutionIdsRef.current.clear();
      setData({
        requestKey,
        value: undefined,
      });
      setLoading(false);
      return;
    }

    const executionId = executionIdRef.current + 1;
    executionIdRef.current = executionId;
    const startedAt = Date.now();
    inFlightExecutionIdsRef.current.add(executionId);

    if (shouldLogDiagnostics) {
      console.log('[portfolio-runtime-query] execute', {
        source: debugSource || 'unknown',
        executionId,
        timeframe,
        maxPoints: typeof maxPoints === 'number' ? maxPoints : null,
        enabled: enabled !== false,
        walletCount: wallets.length,
        storedWalletCount: executeParams.wallets.length,
        eligibleWalletCount: eligibleWallets.length,
        quoteCurrency: executeParams.quoteCurrency,
        currentRateAssetCount: Object.keys(
          executeParams.currentRatesByAssetId || {},
        ).length,
        asOfMs: executeParams.asOfMs,
        refreshToken,
        clearDataToken,
      });
    }

    setData(prev =>
      prev.requestKey === requestKey
        ? prev
        : {
            requestKey,
            value: undefined,
          },
    );
    setLoading(true);
    setError(undefined);

    execute(executeParams)
      .then(result => {
        const requestKeyMatches =
          latestRequestKeyRef.current === requestKey;
        const clearDataTokenMatches =
          latestClearDataTokenRef.current === clearDataToken;
        const compatibleSession =
          !unmountedRef.current &&
          latestEnabledRef.current &&
          requestKeyMatches &&
          clearDataTokenMatches;
        const accepted =
          compatibleSession &&
          executionId >= lastAppliedExecutionIdRef.current;

        if (shouldLogDiagnostics) {
          console.log('[portfolio-runtime-query] result', {
            source: debugSource || 'unknown',
            executionId,
            elapsedMs: Date.now() - startedAt,
            accepted,
            requestKeyMatches,
            clearDataTokenMatches,
            ...summarizeRuntimeQueryResultShape(result),
          });
        }

        if (!accepted) {
          return;
        }

        lastAppliedExecutionIdRef.current = executionId;
        setData({
          requestKey,
          value: result,
        });
        setError(undefined);
      })
      .catch(err => {
        const requestKeyMatches =
          latestRequestKeyRef.current === requestKey;
        const clearDataTokenMatches =
          latestClearDataTokenRef.current === clearDataToken;
        const accepted =
          !unmountedRef.current &&
          latestEnabledRef.current &&
          requestKeyMatches &&
          clearDataTokenMatches &&
          executionId === executionIdRef.current;

        if (shouldLogDiagnostics) {
          console.log('[portfolio-runtime-query] error', {
            source: debugSource || 'unknown',
            executionId,
            elapsedMs: Date.now() - startedAt,
            accepted,
            requestKeyMatches,
            clearDataTokenMatches,
            message: err instanceof Error ? err.message : String(err),
          });
        }
        if (!accepted) {
          return;
        }

        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        inFlightExecutionIdsRef.current.delete(executionId);
        if (unmountedRef.current) {
          return;
        }

        const nextLoading =
          latestEnabledRef.current &&
          inFlightExecutionIdsRef.current.size > 0;
        setLoading(prev => (prev === nextLoading ? prev : nextLoading));
      });
  }, [
    enabled,
    execute,
    clearDataToken,
    debugSource,
    eligibleWallets.length,
    maxPoints,
    requestKey,
    refreshToken,
    shouldLogDiagnostics,
    timeframe,
    wallets.length,
  ]);

  return {
    data: data.requestKey === requestKey ? data.value : undefined,
    loading: loading || hasPendingRequest,
    error,
    quoteCurrency,
    storedWallets,
    eligibleWallets,
    requestKey,
    currentRatesByAssetId,
    currentRatesSignature,
    asOfMs,
  };
}

export default usePortfolioRuntimeQuery;
