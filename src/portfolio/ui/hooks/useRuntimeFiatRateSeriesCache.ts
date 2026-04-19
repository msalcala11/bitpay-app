import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import type {FiatRateCacheRequest} from '../../core/fiatRatesShared';
import type {FiatRateSeriesCache} from '../../../store/rate/rate.models';
import {
  buildRuntimeFiatRateCacheRequestKey,
  loadRuntimeFiatRateSeriesCache,
  normalizeRuntimeFiatRateCacheRequests,
} from '../fiatRateSeries';

export type RuntimeFiatRateSeriesCacheState = {
  cache: FiatRateSeriesCache;
  loading: boolean;
  error?: Error;
  reload: (opts?: {force?: boolean}) => Promise<FiatRateSeriesCache>;
};

export function useRuntimeFiatRateSeriesCache(args: {
  quoteCurrency: string;
  requests: FiatRateCacheRequest[];
  maxAgeMs?: number;
  enabled?: boolean;
  refreshToken?: string | number;
  clearOnRequestChange?: boolean;
}): RuntimeFiatRateSeriesCacheState {
  const enabled = args.enabled !== false;
  const requests = useMemo(
    () => normalizeRuntimeFiatRateCacheRequests(args.requests),
    [args.requests],
  );
  const requestKey = useMemo(
    () =>
      buildRuntimeFiatRateCacheRequestKey({
        quoteCurrency: args.quoteCurrency,
        requests,
        maxAgeMs: args.maxAgeMs,
      }),
    [args.maxAgeMs, args.quoteCurrency, requests],
  );
  const [cache, setCache] = useState<FiatRateSeriesCache>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);
  const activeRequestIdRef = useRef(0);

  const runLoad = useCallback(
    async (opts?: {force?: boolean}): Promise<FiatRateSeriesCache> => {
      if (!enabled || !requests.length || !args.quoteCurrency) {
        const empty: FiatRateSeriesCache = {};
        setCache(empty);
        setLoading(false);
        setError(undefined);
        return empty;
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
      setCache({});
      setLoading(false);
      setError(undefined);
      return;
    }

    if (args.clearOnRequestChange) {
      setCache({});
    }

    void runLoad().catch(() => undefined);
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
