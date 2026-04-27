import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  isStoredFiatRateInterval,
  type FiatRateAssetRef,
  type FiatRateCacheRequest,
  type StoredFiatRateInterval,
} from '../../core/fiatRatesShared';
import type {FiatRateSeriesCache} from '../../../store/rate/rate.models';
import {
  buildRuntimeFiatRateCacheRequestKey,
  loadRuntimeFiatRateSeriesCache,
  normalizeRuntimeFiatRateCacheRequests,
} from '../fiatRateSeries';
import {onHistoricalRatesPersisted} from '../../v2/triggers';
import type {NormalizedFormulaRecomputeInput} from '../../v2/recompute';

export type RuntimeFiatRateSeriesCacheState = {
  cache: FiatRateSeriesCache;
  loading: boolean;
  error?: Error;
  reload: (opts?: {force?: boolean}) => Promise<FiatRateSeriesCache>;
};

function normalizeQuoteCurrency(value: unknown): string | undefined {
  const normalized = String(value || '')
    .trim()
    .toUpperCase();
  return normalized || undefined;
}

function resolveStoredInterval(
  interval: unknown,
): StoredFiatRateInterval | undefined {
  const value = String(interval || '').trim();
  if (value === '3M' || value === '1Y' || value === '5Y') {
    return 'ALL';
  }
  return isStoredFiatRateInterval(value) ? value : undefined;
}

function hasCacheEntries(cache: FiatRateSeriesCache): boolean {
  return Object.values(cache).some(Boolean);
}

function buildHistoricalRatesPersistedMetadata(args: {
  quoteCurrency: string;
  requests: readonly FiatRateCacheRequest[];
}):
  | Readonly<{
      quoteCurrency: string;
      assetRefs: readonly FiatRateAssetRef[];
      intervals: readonly StoredFiatRateInterval[];
    }>
  | undefined {
  const quoteCurrency = normalizeQuoteCurrency(args.quoteCurrency);
  if (!quoteCurrency || !args.requests.length) {
    return undefined;
  }

  const assetRefs: FiatRateAssetRef[] = [];
  const intervalSet = new Set<StoredFiatRateInterval>();
  for (const request of args.requests) {
    const coin = String(request.coin || '').trim();
    if (!coin) {
      continue;
    }

    assetRefs.push({
      coin,
      ...(request.chain ? {chain: request.chain} : {}),
      ...(request.tokenAddress ? {tokenAddress: request.tokenAddress} : {}),
    });

    for (const interval of request.intervals) {
      const storedInterval = resolveStoredInterval(interval);
      if (storedInterval) {
        intervalSet.add(storedInterval);
      }
    }
  }

  const intervals = Array.from(intervalSet).sort((left, right) =>
    left.localeCompare(right),
  );
  return assetRefs.length && intervals.length
    ? {quoteCurrency, assetRefs, intervals}
    : undefined;
}

export function useRuntimeFiatRateSeriesCache(args: {
  quoteCurrency: string;
  requests: FiatRateCacheRequest[];
  maxAgeMs?: number;
  enabled?: boolean;
  refreshToken?: string | number;
  clearOnRequestChange?: boolean;
  notifyHistoricalRatesPersisted?: boolean;
  historicalRatesPersistedNormalizedFormulaInput?: NormalizedFormulaRecomputeInput;
}): RuntimeFiatRateSeriesCacheState {
  const enabled = args.enabled !== false;
  const rawRequestsRef = useRef(args.requests);
  rawRequestsRef.current = args.requests;
  const normalizedRequestsKey = useMemo(
    () =>
      buildRuntimeFiatRateCacheRequestKey({
        quoteCurrency: '',
        requests: args.requests,
      }),
    [args.requests],
  );
  const normalizedRequestsStateRef = useRef<{
    key: string;
    value: FiatRateCacheRequest[];
  }>({
    key: '',
    value: [],
  });
  if (normalizedRequestsStateRef.current.key !== normalizedRequestsKey) {
    normalizedRequestsStateRef.current = {
      key: normalizedRequestsKey,
      value: normalizeRuntimeFiatRateCacheRequests(rawRequestsRef.current),
    };
  }
  const requests = normalizedRequestsStateRef.current.value;
  const requestKey = useMemo(
    () =>
      [
        String(args.quoteCurrency || '')
          .trim()
          .toUpperCase(),
        typeof args.maxAgeMs === 'number' && Number.isFinite(args.maxAgeMs)
          ? String(args.maxAgeMs)
          : '',
        normalizedRequestsKey,
      ].join('|'),
    [args.maxAgeMs, args.quoteCurrency, normalizedRequestsKey],
  );
  const emptyCacheRef = useRef<FiatRateSeriesCache>({});
  const [cache, setCache] = useState<FiatRateSeriesCache>(emptyCacheRef.current);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);
  const activeRequestIdRef = useRef(0);

  const runLoad = useCallback(
    async (opts?: {force?: boolean}): Promise<FiatRateSeriesCache> => {
      if (!enabled || !requests.length || !args.quoteCurrency) {
        setCache(prev =>
          prev === emptyCacheRef.current ? prev : emptyCacheRef.current,
        );
        setLoading(false);
        setError(undefined);
        return emptyCacheRef.current;
      }

      const requestId = activeRequestIdRef.current + 1;
      activeRequestIdRef.current = requestId;
      setLoading(true);
      setError(undefined);

      try {
        const nextCache = await loadRuntimeFiatRateSeriesCache({
          quoteCurrency: args.quoteCurrency,
          requests,
          maxAgeMs: args.maxAgeMs,
          force: opts?.force,
        });

        if (activeRequestIdRef.current === requestId) {
          setCache(nextCache);
          setLoading(false);
          if (
            args.notifyHistoricalRatesPersisted &&
            hasCacheEntries(nextCache)
          ) {
            const metadata = buildHistoricalRatesPersistedMetadata({
              quoteCurrency: args.quoteCurrency,
              requests,
            });
            if (metadata) {
              onHistoricalRatesPersisted({
                ...metadata,
                source: 'exchangeRateScreen',
                normalizedFormulaInput:
                  args.historicalRatesPersistedNormalizedFormulaInput,
              });
            }
          }
        }

        return nextCache;
      } catch (err) {
        const runtimeError =
          err instanceof Error ? err : new Error(String(err));
        if (activeRequestIdRef.current === requestId) {
          setLoading(false);
          setError(runtimeError);
        }
        throw runtimeError;
      }
    },
    [
      args.historicalRatesPersistedNormalizedFormulaInput,
      args.maxAgeMs,
      args.notifyHistoricalRatesPersisted,
      args.quoteCurrency,
      enabled,
      requests,
    ],
  );

  useEffect(() => {
    if (!enabled || !requests.length || !args.quoteCurrency) {
      activeRequestIdRef.current += 1;
      setCache(prev =>
        prev === emptyCacheRef.current ? prev : emptyCacheRef.current,
      );
      setLoading(false);
      setError(undefined);
      return;
    }

    if (args.clearOnRequestChange) {
      setCache(prev =>
        prev === emptyCacheRef.current ? prev : emptyCacheRef.current,
      );
    }

    runLoad().catch(() => undefined);
  }, [
    args.clearOnRequestChange,
    args.quoteCurrency,
    args.refreshToken,
    enabled,
    requestKey,
    requests.length,
    runLoad,
  ]);

  return {
    cache,
    loading,
    error,
    reload: runLoad,
  };
}

export default useRuntimeFiatRateSeriesCache;
