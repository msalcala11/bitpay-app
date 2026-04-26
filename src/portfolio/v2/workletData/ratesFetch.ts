import type {NitroResponse as NitroFetchResponse} from 'react-native-nitro-fetch';

import {
  CANONICAL_FIAT_QUOTE,
  FX_BRIDGE_COIN,
  assertStoredFiatRateInterval,
  getFiatRateSeriesUrl,
  type FiatRateSeries,
  type FiatRateSeriesResponse,
} from '../../core/fiatRatesShared';
import {
  normalizeStoredFiatRateSeriesPoints,
  parseStoredFiatRateSeriesRaw,
  stringifyStoredFiatRateSeries,
} from '../../core/pnl/storedFiatRateSeries';
import {
  DEFAULT_PORTFOLIO_NITRO_FETCH_TIMEOUT_MS,
  getPortfolioNitroFetchClientOnRuntime,
} from '../../adapters/rn/txHistorySigning';
import {
  RATE_FETCH_RETRY_BASE_MS,
  RATE_FETCH_RETRY_MAX_MS,
} from '../constants';
import {getPortfolioKvStore, writePortfolioMmkvString} from '../kvStore';
import {logPortfolioRuntimeError} from '../logPortfolioRuntimeError';
import type {
  BwsConfig,
  FiatRateAssetRef,
  RateFetchRetryState,
  StoredRateInterval,
} from '../model';
import {getCurrentPortfolioWorkEpoch} from '../sharedState';
import {
  getRateKey,
  getRateSourceKey,
  normalizeRateAssetRef,
} from './ratesKv';
import {
  getPortfolioRateFetchRuntime,
  runOnPortfolioRuntimeAsync,
} from '../runtimes';

export type RateFetchErrorKind =
  | 'network'
  | 'bws'
  | 'parse'
  | 'rateLimit'
  | 'unknown';

export type RateFetchDependency = Readonly<{
  quoteCurrency: string;
  asset: FiatRateAssetRef;
  storedInterval: StoredRateInterval;
}>;

export type EnsureFreshArgs = Readonly<{
  quoteCurrency: string;
  assetRefs: readonly FiatRateAssetRef[];
  intervals: readonly StoredRateInterval[];
  cfg?: BwsConfig;
  force?: boolean;
  maxAgeMs?: number;
  startEpoch?: number;
}>;

export type RateFetchRuntimeResult = Readonly<{
  dependency: RateFetchDependency;
  series?: FiatRateSeries;
  errorKind?: RateFetchErrorKind;
}>;

type RateFetchExecutor = (
  dependencies: readonly RateFetchDependency[],
  cfg: BwsConfig,
) => Promise<readonly RateFetchRuntimeResult[]>;

// Phase 2 keeps rate-fetch retry backoff in memory. App restart intentionally
// clears the backoff and may try each stale dependency once after launch.
const retryByDependencyKey = new Map<string, RateFetchRetryState>();
let rateFetchExecutorForTesting: RateFetchExecutor | undefined;

function wallClockNowMs(): number {
  'worklet';

  return Date.now();
}

function dependencyKey(dependency: RateFetchDependency): string {
  'worklet';

  return getRateKey({
    quoteCurrency: dependency.quoteCurrency,
    asset: dependency.asset,
    storedInterval: dependency.storedInterval,
  });
}

function normalizeQuoteCurrency(quoteCurrency: string): string {
  'worklet';

  return String(quoteCurrency || CANONICAL_FIAT_QUOTE).toUpperCase();
}

function normalizeStoredInterval(interval: StoredRateInterval): StoredRateInterval {
  'worklet';

  return assertStoredFiatRateInterval(interval) as StoredRateInterval;
}

function uniqueDependencies(
  dependencies: readonly RateFetchDependency[],
): readonly RateFetchDependency[] {
  const byKey = new Map<string, RateFetchDependency>();
  for (const dependency of dependencies) {
    const normalized: RateFetchDependency = {
      quoteCurrency: normalizeQuoteCurrency(dependency.quoteCurrency),
      asset: normalizeRateAssetRef(dependency.asset),
      storedInterval: normalizeStoredInterval(dependency.storedInterval),
    };
    if (!normalized.asset.coin) continue;
    byKey.set(dependencyKey(normalized), normalized);
  }
  return Array.from(byKey.values()).sort((left, right) =>
    dependencyKey(left).localeCompare(dependencyKey(right)),
  );
}

export function buildEnsureFreshDependencies(
  args: EnsureFreshArgs,
): readonly RateFetchDependency[] {
  const targetQuoteCurrency = normalizeQuoteCurrency(args.quoteCurrency);
  const intervals = Array.from(
    new Set((args.intervals || []).map(normalizeStoredInterval)),
  );
  const dependencies: RateFetchDependency[] = [];

  for (const interval of intervals) {
    for (const assetRef of args.assetRefs || []) {
      dependencies.push({
        quoteCurrency: CANONICAL_FIAT_QUOTE,
        asset: assetRef,
        storedInterval: interval,
      });
    }

    dependencies.push({
      quoteCurrency: CANONICAL_FIAT_QUOTE,
      asset: {coin: FX_BRIDGE_COIN},
      storedInterval: interval,
    });

    if (targetQuoteCurrency !== CANONICAL_FIAT_QUOTE) {
      dependencies.push({
        quoteCurrency: targetQuoteCurrency,
        asset: {coin: FX_BRIDGE_COIN},
        storedInterval: interval,
      });
    }
  }

  return uniqueDependencies(dependencies);
}

function isFresh(series: FiatRateSeries | null, maxAgeMs?: number): boolean {
  if (!series?.points?.length || !(series.fetchedOn > 0)) {
    return false;
  }
  if (typeof maxAgeMs !== 'number' || !Number.isFinite(maxAgeMs)) {
    return true;
  }
  return wallClockNowMs() - Number(series.fetchedOn) <= Math.max(0, maxAgeMs);
}

async function readStoredSeries(key: string): Promise<FiatRateSeries | null> {
  return parseStoredFiatRateSeriesRaw(await getPortfolioKvStore().getString(key));
}

function computeRetryState(args: {
  dependency: RateFetchDependency;
  previous?: RateFetchRetryState;
  errorKind: RateFetchErrorKind;
}): RateFetchRetryState {
  const attempt = (args.previous?.attempt ?? 0) + 1;
  const now = wallClockNowMs();
  const backoffMs = Math.min(
    RATE_FETCH_RETRY_MAX_MS,
    RATE_FETCH_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1),
  );
  const jitterMs = Math.floor(Math.min(5_000, backoffMs * 0.2) * 0.5);

  return {
    quoteCurrency: normalizeQuoteCurrency(args.dependency.quoteCurrency),
    storedInterval: args.dependency.storedInterval,
    rateSourceKey: getRateSourceKey(args.dependency.asset),
    attempt,
    nextRetryAtMs: now + backoffMs + jitterMs,
    lastErrorKind: args.errorKind,
    lastErrorAtMs: now,
  };
}

function shouldSkipForRetry(dependency: RateFetchDependency, force?: boolean): boolean {
  if (force) return false;
  const retry = retryByDependencyKey.get(dependencyKey(dependency));
  return !!retry && retry.nextRetryAtMs > wallClockNowMs();
}

function extractSeries(
  raw: FiatRateSeriesResponse | Record<string, unknown> | unknown,
  coin: string,
): FiatRateSeries | null {
  'worklet';

  const directPoints = normalizeStoredFiatRateSeriesPoints(raw);
  if (directPoints.length) {
    return {fetchedOn: wallClockNowMs(), points: directPoints};
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const candidate =
    record[coin] ?? record[coin.toLowerCase()] ?? record[coin.toUpperCase()];
  const points = normalizeStoredFiatRateSeriesPoints((candidate as any)?.points ?? candidate);
  if (points.length) {
    const fetchedOn = Number((candidate as any)?.fetchedOn);
    return {
      fetchedOn:
        Number.isFinite(fetchedOn) && fetchedOn > 0
          ? fetchedOn
          : wallClockNowMs(),
      points,
    };
  }

  const values = Object.values(record);
  if (values.length === 1) {
    return extractSeries(values[0], coin);
  }

  return null;
}

function classifyFetchError(error: unknown): RateFetchErrorKind {
  'worklet';

  const message =
    error instanceof Error ? error.message : String(error || '').toLowerCase();
  if (/429|rate.?limit/i.test(message)) return 'rateLimit';
  if (/parse|json/i.test(message)) return 'parse';
  if (/bws|status|http|failed to fetch/i.test(message)) return 'bws';
  if (/network|timeout|offline|request/i.test(message)) return 'network';
  return 'unknown';
}

function isFailedRuntimeResult(result: RateFetchRuntimeResult): boolean {
  'worklet';

  return (
    !!result.errorKind ||
    !result.series ||
    !Array.isArray(result.series.points) ||
    result.series.points.length === 0
  );
}

async function fetchSingleRateOnRuntime(
  dependency: RateFetchDependency,
  cfg: BwsConfig,
): Promise<RateFetchRuntimeResult> {
  'worklet';

  const asset = normalizeRateAssetRef(dependency.asset);
  const quoteCurrency = normalizeQuoteCurrency(dependency.quoteCurrency);
  const url = getFiatRateSeriesUrl(
    {baseUrl: String(cfg.baseUrl || '')},
    quoteCurrency,
    normalizeStoredInterval(dependency.storedInterval),
    {
      chain: asset.chain,
      tokenAddress: asset.tokenAddress,
    },
  );

  try {
    const nitroFetchClient = getPortfolioNitroFetchClientOnRuntime();
    const response: NitroFetchResponse = nitroFetchClient.requestSync({
      url,
      method: 'GET',
      headers: [
        {key: 'Accept', value: 'application/json'},
        {key: 'Cache-Control', value: 'no-store'},
      ],
      timeoutMs: DEFAULT_PORTFOLIO_NITRO_FETCH_TIMEOUT_MS,
      followRedirects: true,
    });

    const rawText = typeof response.bodyString === 'string' ? response.bodyString : '';
    if (!response.ok) {
      return {
        dependency,
        errorKind: response.status === 429 ? 'rateLimit' : 'bws',
      };
    }

    const payload = rawText ? JSON.parse(rawText) : {};
    const series = extractSeries(payload, asset.coin);
    return series?.points?.length
      ? {dependency, series}
      : {dependency, errorKind: 'parse'};
  } catch (error: unknown) {
    return {dependency, errorKind: classifyFetchError(error)};
  }
}

async function fetchRateSeriesOnRuntime(
  dependencies: readonly RateFetchDependency[],
  cfg: BwsConfig,
): Promise<readonly RateFetchRuntimeResult[]> {
  'worklet';

  const out: RateFetchRuntimeResult[] = [];
  for (const dependency of dependencies) {
    out.push(await fetchSingleRateOnRuntime(dependency, cfg));
  }
  return out;
}

async function defaultRateFetchExecutor(
  dependencies: readonly RateFetchDependency[],
  cfg: BwsConfig,
): Promise<readonly RateFetchRuntimeResult[]> {
  return runOnPortfolioRuntimeAsync(
    getPortfolioRateFetchRuntime(),
    fetchRateSeriesOnRuntime,
    dependencies,
    cfg,
  );
}

export function setRateFetchExecutorForTesting(
  executor: RateFetchExecutor | undefined,
): void {
  rateFetchExecutorForTesting = executor;
}

export function clearRateFetchRetryStateForTesting(): void {
  retryByDependencyKey.clear();
  rateFetchExecutorForTesting = undefined;
}

export function getRateFetchRetryStatesForTesting(): readonly RateFetchRetryState[] {
  return Array.from(retryByDependencyKey.values());
}

export async function ensureFresh(args: EnsureFreshArgs): Promise<void> {
  const startEpoch =
    typeof args.startEpoch === 'number'
      ? args.startEpoch
      : getCurrentPortfolioWorkEpoch();
  const dependencies = buildEnsureFreshDependencies(args);
  const toFetch: RateFetchDependency[] = [];

  for (const dependency of dependencies) {
    if (shouldSkipForRetry(dependency, args.force)) {
      continue;
    }
    const key = dependencyKey(dependency);
    const existing = await readStoredSeries(key);
    if (!args.force && isFresh(existing, args.maxAgeMs)) {
      continue;
    }
    toFetch.push(dependency);
  }

  if (!toFetch.length) {
    return;
  }

  const executor = rateFetchExecutorForTesting ?? defaultRateFetchExecutor;
  let results: readonly RateFetchRuntimeResult[];
  try {
    results = await executor(toFetch, args.cfg ?? {});
  } catch (error: unknown) {
    const errorKind = classifyFetchError(error);
    const currentEpoch = getCurrentPortfolioWorkEpoch();
    if (startEpoch !== currentEpoch) {
      logPortfolioRuntimeError(error, {
        tag: 'staleWorkEpoch',
        reason: 'executorFailed',
        startEpoch,
        currentEpoch,
        runtimeKind: 'rateFetch',
      });
      return;
    }
    logPortfolioRuntimeError(error, {
      tag: 'ensureFresh',
      reason: 'executorFailed',
      runtimeKind: 'rateFetch',
    });
    for (const dependency of toFetch) {
      const key = dependencyKey(dependency);
      retryByDependencyKey.set(
        key,
        computeRetryState({
          dependency,
          previous: retryByDependencyKey.get(key),
          errorKind,
        }),
      );
    }
    return;
  }

  const currentEpoch = getCurrentPortfolioWorkEpoch();
  if (startEpoch !== currentEpoch) {
    logPortfolioRuntimeError(new Error('stale rate fetch discarded'), {
      tag: 'staleWorkEpoch',
      reason: results.some(isFailedRuntimeResult)
        ? 'runtimeResultFailed'
        : 'runtimeResultSucceeded',
      startEpoch,
      currentEpoch,
      runtimeKind: 'rateFetch',
    });
    return;
  }

  for (const result of results) {
    const key = dependencyKey(result.dependency);
    if (result.series?.points?.length) {
      retryByDependencyKey.delete(key);
      writePortfolioMmkvString({
        key,
        value: stringifyStoredFiatRateSeries(result.series),
        reason: 'rate',
      });
      continue;
    }

    retryByDependencyKey.set(
      key,
      computeRetryState({
        dependency: result.dependency,
        previous: retryByDependencyKey.get(key),
        errorKind: result.errorKind ?? 'unknown',
      }),
    );
  }
}
