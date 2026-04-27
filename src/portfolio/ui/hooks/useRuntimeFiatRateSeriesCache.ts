import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  isStoredFiatRateInterval,
  normalizeFiatRateSeriesChain,
  normalizeFiatRateSeriesTokenAddress,
  resolveStoredFiatRateInterval,
  type FiatRateCacheRequest,
  type FiatRateInterval,
} from '../../core/fiatRatesShared';
import type {FiatRateSeriesCache} from '../../../store/rate/rate.models';
import {
  onHistoricalRatesPersisted,
  type HistoricalRatesPersistedTriggerArgs,
} from '../../v2/triggers';
import {
  buildRuntimeFiatRateCacheRequestKey,
  loadRuntimeFiatRateSeriesCache,
  normalizeRuntimeFiatRateCacheRequests,
} from '../fiatRateSeries';

type HistoricalRatesPersistedSource =
  HistoricalRatesPersistedTriggerArgs['source'];

export type RuntimeFiatRateSeriesCacheState = {
  cache: FiatRateSeriesCache;
  loading: boolean;
  error?: Error;
  reload: (opts?: {force?: boolean}) => Promise<FiatRateSeriesCache>;
};

const STORED_INTERVAL_SORT_ORDER = new Map([
  ['1D', 0],
  ['1W', 1],
  ['1M', 2],
  ['ALL', 3],
]);

function hasCacheEntries(cache: FiatRateSeriesCache): boolean {
  return Object.values(cache).some(Boolean);
}

function notifyHistoricalRatesPersisted(args: {
  quoteCurrency: string;
  requests: readonly FiatRateCacheRequest[];
  cache: FiatRateSeriesCache;
  source: HistoricalRatesPersistedSource;
}): void {
  const quoteCurrency = String(args.quoteCurrency || '')
    .trim()
    .toUpperCase();
  if (!quoteCurrency || !args.requests.length || !hasCacheEntries(args.cache)) {
    return;
  }

  const assetRefsByKey = new Map<
    string,
    {coin: string; chain?: string; tokenAddress?: string}
  >();
  const storedIntervals = new Set<
    HistoricalRatesPersistedTriggerArgs['intervals'][number]
  >();

  for (const request of args.requests) {
    const coin = String(request.coin || '')
      .trim()
      .toLowerCase();
    if (!coin) {
      continue;
    }

    const chain = normalizeFiatRateSeriesChain(request.chain);
    const tokenAddress = normalizeFiatRateSeriesTokenAddress(
      chain,
      request.tokenAddress,
    );
    const assetRef = {
      coin,
      ...(chain && tokenAddress ? {chain} : {}),
      ...(tokenAddress ? {tokenAddress} : {}),
    };
    assetRefsByKey.set(JSON.stringify(assetRef), assetRef);

    for (const interval of request.intervals || []) {
      const storedInterval = resolveStoredFiatRateInterval(
        interval as FiatRateInterval,
      );
      if (isStoredFiatRateInterval(storedInterval)) {
        storedIntervals.add(storedInterval);
      }
    }
  }

  if (!assetRefsByKey.size || !storedIntervals.size) {
    return;
  }

  onHistoricalRatesPersisted({
    quoteCurrency,
    assetRefs: Array.from(assetRefsByKey.values()).sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    ),
    intervals: Array.from(storedIntervals).sort(
      (left, right) =>
        (STORED_INTERVAL_SORT_ORDER.get(left) ?? 99) -
        (STORED_INTERVAL_SORT_ORDER.get(right) ?? 99),
    ),
    source: args.source,
  });
}

export function useRuntimeFiatRateSeriesCache(args: {
  quoteCurrency: string;
  requests: FiatRateCacheRequest[];
  maxAgeMs?: number;
  enabled?: boolean;
  refreshToken?: string | number;
  clearOnRequestChange?: boolean;
  notifyHistoricalRatesPersisted?: boolean;
  historicalRatesPersistedSource?: HistoricalRatesPersistedSource;
}): RuntimeFiatRateSeriesCacheState {
  const enabled = args.enabled !== false;
  const historicalRatesPersistedNotificationRef = useRef<{
    enabled: boolean;
    source: HistoricalRatesPersistedSource;
  }>({
    enabled: args.notifyHistoricalRatesPersisted === true,
    source: args.historicalRatesPersistedSource || 'externalEffect',
  });
  historicalRatesPersistedNotificationRef.current = {
    enabled: args.notifyHistoricalRatesPersisted === true,
    source: args.historicalRatesPersistedSource || 'externalEffect',
  };
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
  const [cache, setCache] = useState<FiatRateSeriesCache>(
    emptyCacheRef.current,
  );
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
        }

        const notification = historicalRatesPersistedNotificationRef.current;
        if (notification.enabled) {
          notifyHistoricalRatesPersisted({
            quoteCurrency: args.quoteCurrency,
            requests,
            cache: nextCache,
            source: notification.source,
          });
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
    [args.maxAgeMs, args.quoteCurrency, enabled, requests],
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
