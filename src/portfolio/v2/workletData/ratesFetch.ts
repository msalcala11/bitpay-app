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
  stringifyStoredFiatRateSeries,
} from '../../core/pnl/storedFiatRateSeries';
import {
  createPortfolioRateFetchDispatchContextOnRN,
  DEFAULT_PORTFOLIO_NITRO_FETCH_TIMEOUT_MS,
  getPortfolioNitroFetchClientOnRuntime,
  setPortfolioTxHistorySigningDispatchContextOnRuntime,
  type PortfolioTxHistorySigningDispatchContext,
} from '../../adapters/rn/txHistorySigning';
import {getPortfolioMmkvNativeStorageOnRN} from '../../adapters/rn/workletMmkvBridge';
import type {PortfolioWorkletKvConfig} from '../../runtime/worklet/portfolioWorkletKv';
import {
  PORTFOLIO_WORK_EPOCH_KEY,
  PORTFOLIO_RATE_FETCH_MAX_PARALLEL_TOKEN_REQUESTS,
  RATE_FETCH_RETRY_BASE_MS,
  RATE_FETCH_RETRY_MAX_MS,
} from '../constants';
import {
  createWorkletPortfolioKvConfig,
  getPortfolioKvStore,
  writePortfolioMmkvStringOnWorklet,
} from '../kvStore';
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
  readPortfolioV2RateSeriesByKey,
} from './ratesKv';
import {
  getPortfolioRateFetchRuntime,
  runOnPortfolioRuntimeAsync,
} from '../runtimes';
import {teardownPortfolioRuntimeGlobals} from '../../adapters/rn/workletRuntimeShared';

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

export type EnsureQuoteCurrencyFxBridgeArgs = Readonly<{
  quoteCurrency: string;
  intervals: readonly StoredRateInterval[];
  cfg?: BwsConfig;
  force?: boolean;
  maxAgeMs?: number;
  startEpoch?: number;
}>;

export type RateFetchRuntimeResult = Readonly<{
  dependency: RateFetchDependency;
  fetched?: boolean;
  persisted?: boolean;
  series?: FiatRateSeries;
  errorKind?: RateFetchErrorKind;
}>;

type RateFetchExecutor = (
  dependencies: readonly RateFetchDependency[],
  cfg: BwsConfig,
  startEpoch: number,
) => Promise<readonly RateFetchRuntimeResult[]>;

// Phase 2 keeps rate-fetch retry backoff in memory. App restart intentionally
// clears the backoff and may try each stale dependency once after launch.
const retryByDependencyKey = new Map<string, RateFetchRetryState>();
let rateFetchExecutorForTesting: RateFetchExecutor | undefined;
const inFlightByDependencyKey = new Map<
  string,
  {
    promise: Promise<void>;
    resolve: () => void;
    force: boolean;
    started: boolean;
  }
>();

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

function isNativeRateDependency(dependency: RateFetchDependency): boolean {
  'worklet';

  const asset = normalizeRateAssetRef(dependency.asset);
  return !!asset.coin && !asset.chain && !asset.tokenAddress;
}

function normalizeQuoteCurrency(quoteCurrency: string): string {
  'worklet';

  return String(quoteCurrency || CANONICAL_FIAT_QUOTE).toUpperCase();
}

function normalizeStoredInterval(
  interval: StoredRateInterval,
): StoredRateInterval {
  'worklet';

  return assertStoredFiatRateInterval(interval);
}

function nativeRateBatchKey(dependency: RateFetchDependency): string {
  'worklet';

  return `${normalizeQuoteCurrency(
    dependency.quoteCurrency,
  )}:${normalizeStoredInterval(dependency.storedInterval)}`;
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

export function buildEnsureQuoteCurrencyFxBridgeDependencies(
  args: EnsureQuoteCurrencyFxBridgeArgs,
): readonly RateFetchDependency[] {
  const targetQuoteCurrency = normalizeQuoteCurrency(args.quoteCurrency);
  if (targetQuoteCurrency === CANONICAL_FIAT_QUOTE) {
    return [];
  }

  return uniqueDependencies(
    Array.from(
      new Set((args.intervals || []).map(normalizeStoredInterval)),
    ).map(interval => ({
      quoteCurrency: targetQuoteCurrency,
      asset: {coin: FX_BRIDGE_COIN},
      storedInterval: interval,
    })),
  );
}

function isFresh(series: FiatRateSeries | null, maxAgeMs?: number): boolean {
  if (!hasUsableFetchedRateSeries(series) || !(series.fetchedOn > 0)) {
    return false;
  }
  if (typeof maxAgeMs !== 'number' || !Number.isFinite(maxAgeMs)) {
    return true;
  }
  return wallClockNowMs() - Number(series.fetchedOn) <= Math.max(0, maxAgeMs);
}

async function readStoredSeries(key: string): Promise<FiatRateSeries | null> {
  return readPortfolioV2RateSeriesByKey({
    store: getPortfolioKvStore(),
    key,
  });
}

function hasUsableFetchedRateSeries(
  series: FiatRateSeries | null | undefined,
): series is FiatRateSeries {
  'worklet';

  if (
    !series?.points?.length ||
    typeof series.fetchedOn !== 'number' ||
    !Number.isFinite(series.fetchedOn) ||
    series.fetchedOn <= 0
  ) {
    return false;
  }

  let previousTs = -Infinity;
  for (const point of series.points) {
    if (
      typeof point.ts !== 'number' ||
      !Number.isFinite(point.ts) ||
      point.ts <= previousTs ||
      typeof point.rate !== 'number' ||
      !Number.isFinite(point.rate) ||
      point.rate <= 0
    ) {
      return false;
    }
    previousTs = point.ts;
  }

  return true;
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

function getCurrentPortfolioWorkEpochOnWorklet(
  config: PortfolioWorkletKvConfig,
): number {
  'worklet';

  const raw = config.storage.getString(PORTFOLIO_WORK_EPOCH_KEY);
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

function shouldSkipForRetry(
  dependency: RateFetchDependency,
  force?: boolean,
): boolean {
  if (force) return false;
  const retry = retryByDependencyKey.get(dependencyKey(dependency));
  return !!retry && retry.nextRetryAtMs > wallClockNowMs();
}

function extractSeries(
  raw: FiatRateSeriesResponse | Record<string, unknown> | unknown,
  coin: string,
  allowDirectSeries = true,
): FiatRateSeries | null {
  'worklet';

  if (allowDirectSeries) {
    const directPoints = normalizeStoredFiatRateSeriesPoints(raw);
    if (directPoints.length) {
      const series = {fetchedOn: wallClockNowMs(), points: directPoints};
      return hasUsableFetchedRateSeries(series) ? series : null;
    }
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const candidate =
    record[coin] ?? record[coin.toLowerCase()] ?? record[coin.toUpperCase()];
  const points = normalizeStoredFiatRateSeriesPoints(
    (candidate as any)?.points ?? candidate,
  );
  if (points.length) {
    const fetchedOn = Number((candidate as any)?.fetchedOn);
    const series = {
      fetchedOn:
        Number.isFinite(fetchedOn) && fetchedOn > 0
          ? fetchedOn
          : wallClockNowMs(),
      points,
    };
    return hasUsableFetchedRateSeries(series) ? series : null;
  }

  const values = Object.values(record);
  if (allowDirectSeries && values.length === 1) {
    return extractSeries(values[0], coin, allowDirectSeries);
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
    result.fetched !== true &&
    result.persisted !== true &&
    (!!result.errorKind || !hasUsableFetchedRateSeries(result.series))
  );
}

function partitionRuntimeResults(args: {
  dependencies: readonly RateFetchDependency[];
  results: readonly RateFetchRuntimeResult[];
}): {
  acceptedResults: readonly RateFetchRuntimeResult[];
  missingKeys: readonly string[];
  mismatch: boolean;
} {
  const expectedByKey = new Map<string, RateFetchDependency>();
  for (const dependency of args.dependencies) {
    expectedByKey.set(dependencyKey(dependency), dependency);
  }

  const seen = new Set<string>();
  const acceptedResults: RateFetchRuntimeResult[] = [];
  let mismatch = args.results.length !== args.dependencies.length;

  for (const result of args.results) {
    const key = dependencyKey(result.dependency);
    if (!expectedByKey.has(key) || seen.has(key)) {
      mismatch = true;
      continue;
    }

    seen.add(key);
    acceptedResults.push(result);
  }

  const missingKeys: string[] = [];
  for (const key of expectedByKey.keys()) {
    if (!seen.has(key)) {
      missingKeys.push(key);
      mismatch = true;
    }
  }

  return {acceptedResults, missingKeys, mismatch};
}

function buildRateFetchUrlOnRuntime(
  dependency: RateFetchDependency,
  cfg: BwsConfig,
): string {
  'worklet';

  const asset = normalizeRateAssetRef(dependency.asset);
  return getFiatRateSeriesUrl(
    {baseUrl: String(cfg.baseUrl || '')},
    normalizeQuoteCurrency(dependency.quoteCurrency),
    normalizeStoredInterval(dependency.storedInterval),
    {
      chain: asset.chain,
      tokenAddress: asset.tokenAddress,
    },
  );
}

function requestRatePayloadOnRuntime(url: string): {
  payload?: unknown;
  errorKind?: RateFetchErrorKind;
} {
  'worklet';

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

    const rawText =
      typeof response.bodyString === 'string' ? response.bodyString : '';
    if (!response.ok) {
      return {errorKind: response.status === 429 ? 'rateLimit' : 'bws'};
    }

    return {payload: rawText ? JSON.parse(rawText) : {}};
  } catch (error: unknown) {
    return {errorKind: classifyFetchError(error)};
  }
}

async function fetchSingleRateOnRuntime(
  dependency: RateFetchDependency,
  cfg: BwsConfig,
): Promise<RateFetchRuntimeResult> {
  'worklet';

  const asset = normalizeRateAssetRef(dependency.asset);
  const response = requestRatePayloadOnRuntime(
    buildRateFetchUrlOnRuntime(dependency, cfg),
  );
  const errorKind = response.errorKind;
  if (errorKind) {
    return {dependency, errorKind};
  }

  const series = extractSeries(response.payload, asset.coin);
  return series?.points?.length
    ? {dependency, series}
    : {dependency, errorKind: 'parse'};
}

async function fetchNativeRateBatchOnRuntime(
  dependencies: readonly RateFetchDependency[],
  cfg: BwsConfig,
): Promise<readonly RateFetchRuntimeResult[]> {
  'worklet';

  const firstDependency = dependencies[0];
  if (!firstDependency) return [];

  const nativeUrl = getFiatRateSeriesUrl(
    {baseUrl: String(cfg.baseUrl || '')},
    normalizeQuoteCurrency(firstDependency.quoteCurrency),
    normalizeStoredInterval(firstDependency.storedInterval),
  );
  const response = requestRatePayloadOnRuntime(nativeUrl);
  const errorKind = response.errorKind;
  if (errorKind) {
    return dependencies.map(dependency => ({
      dependency,
      errorKind,
    }));
  }

  const allowDirectSeries = dependencies.length === 1;
  return dependencies.map(dependency => {
    const asset = normalizeRateAssetRef(dependency.asset);
    const series = extractSeries(
      response.payload,
      asset.coin,
      allowDirectSeries,
    );
    return series?.points?.length
      ? {dependency, series}
      : {dependency, errorKind: 'parse'};
  });
}

function buildRuntimeFetchBatches(
  dependencies: readonly RateFetchDependency[],
): readonly (readonly RateFetchDependency[])[] {
  'worklet';

  const batches: RateFetchDependency[][] = [];
  const nativeGroups = new Map<string, RateFetchDependency[]>();

  for (const dependency of dependencies) {
    if (!isNativeRateDependency(dependency)) {
      batches.push([dependency]);
      continue;
    }

    const key = nativeRateBatchKey(dependency);
    let group = nativeGroups.get(key);
    if (!group) {
      group = [];
      nativeGroups.set(key, group);
      batches.push(group);
    }
    group.push(dependency);
  }

  return batches;
}

async function fetchTokenBatchesWithLimitOnRuntime(
  batches: readonly (readonly RateFetchDependency[])[],
  cfg: BwsConfig,
): Promise<readonly RateFetchRuntimeResult[]> {
  'worklet';

  const out: RateFetchRuntimeResult[] = [];
  let nextBatchIndex = 0;
  const workerCount = Math.max(
    1,
    Math.min(PORTFOLIO_RATE_FETCH_MAX_PARALLEL_TOKEN_REQUESTS, batches.length),
  );

  await Promise.all(
    Array.from({length: workerCount}, async () => {
      while (nextBatchIndex < batches.length) {
        const batch = batches[nextBatchIndex++];
        const dependency = batch?.[0];
        if (!dependency) {
          continue;
        }
        out.push(await fetchSingleRateOnRuntime(dependency, cfg));
      }
    }),
  );

  return out;
}

function persistRuntimeFetchResultOnRuntime(
  result: RateFetchRuntimeResult,
  kvConfig?: PortfolioWorkletKvConfig,
  startEpoch?: number,
): RateFetchRuntimeResult {
  'worklet';

  if (!hasUsableFetchedRateSeries(result.series)) {
    return result;
  }

  if (
    kvConfig &&
    typeof startEpoch === 'number' &&
    getCurrentPortfolioWorkEpochOnWorklet(kvConfig) === startEpoch
  ) {
    writePortfolioMmkvStringOnWorklet(kvConfig, {
      key: dependencyKey(result.dependency),
      value: stringifyStoredFiatRateSeries(result.series),
      reason: 'rate',
    });
    return {
      dependency: result.dependency,
      fetched: true,
      persisted: true,
    };
  }

  return {dependency: result.dependency, fetched: true};
}

async function fetchRateSeriesOnRuntime(
  dependencies: readonly RateFetchDependency[],
  cfg: BwsConfig,
  dispatchContext?: PortfolioTxHistorySigningDispatchContext,
  kvConfig?: PortfolioWorkletKvConfig,
  startEpoch?: number,
): Promise<readonly RateFetchRuntimeResult[]> {
  'worklet';

  if (dispatchContext) {
    setPortfolioTxHistorySigningDispatchContextOnRuntime(dispatchContext);
  }

  try {
    const out: RateFetchRuntimeResult[] = [];
    const tokenBatches: (readonly RateFetchDependency[])[] = [];
    for (const batch of buildRuntimeFetchBatches(dependencies)) {
      const firstDependency = batch[0];
      if (!firstDependency) continue;

      if (!isNativeRateDependency(firstDependency)) {
        tokenBatches.push(batch);
        continue;
      }

      for (const result of await fetchNativeRateBatchOnRuntime(batch, cfg)) {
        out.push(
          persistRuntimeFetchResultOnRuntime(result, kvConfig, startEpoch),
        );
      }
    }

    for (const result of await fetchTokenBatchesWithLimitOnRuntime(
      tokenBatches,
      cfg,
    )) {
      out.push(
        persistRuntimeFetchResultOnRuntime(result, kvConfig, startEpoch),
      );
    }
    return out;
  } finally {
    teardownPortfolioRuntimeGlobals('rateFetch');
  }
}

async function defaultRateFetchExecutor(
  dependencies: readonly RateFetchDependency[],
  cfg: BwsConfig,
  startEpoch: number,
): Promise<readonly RateFetchRuntimeResult[]> {
  const dispatchContext = createPortfolioRateFetchDispatchContextOnRN({
    requestCount: buildRuntimeFetchBatches(dependencies).length,
  });
  const kvConfig = createWorkletPortfolioKvConfig(
    getPortfolioMmkvNativeStorageOnRN(),
  );
  return runOnPortfolioRuntimeAsync(
    getPortfolioRateFetchRuntime(),
    fetchRateSeriesOnRuntime,
    dependencies,
    cfg,
    dispatchContext,
    kvConfig,
    startEpoch,
  );
}

export function setRateFetchExecutorForTesting(
  executor: RateFetchExecutor | undefined,
): void {
  rateFetchExecutorForTesting = executor;
}

export function clearRateFetchRetryStateForTesting(): void {
  retryByDependencyKey.clear();
  inFlightByDependencyKey.clear();
  rateFetchExecutorForTesting = undefined;
}

export function getRateFetchRetryStatesForTesting(): readonly RateFetchRetryState[] {
  return Array.from(retryByDependencyKey.values());
}

async function executeRateFetchOperation(args: {
  dependencies: readonly RateFetchDependency[];
  cfg?: BwsConfig;
  startEpoch: number;
  entries: readonly {started: boolean}[];
}): Promise<void> {
  const executor = rateFetchExecutorForTesting ?? defaultRateFetchExecutor;
  let results: readonly RateFetchRuntimeResult[];
  try {
    for (const entry of args.entries) {
      entry.started = true;
    }
    results = await executor(
      args.dependencies,
      args.cfg ?? {},
      args.startEpoch,
    );
  } catch (error: unknown) {
    const errorKind = classifyFetchError(error);
    const currentEpoch = getCurrentPortfolioWorkEpoch();
    if (args.startEpoch !== currentEpoch) {
      logPortfolioRuntimeError(error, {
        tag: 'staleWorkEpoch',
        reason: 'executorFailed',
        startEpoch: args.startEpoch,
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
    for (const dependency of args.dependencies) {
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
  const partition = partitionRuntimeResults({
    dependencies: args.dependencies,
    results,
  });
  if (args.startEpoch !== currentEpoch) {
    const hasFailedResult =
      partition.mismatch ||
      partition.acceptedResults.some(isFailedRuntimeResult);
    logPortfolioRuntimeError(new Error('stale rate fetch discarded'), {
      tag: 'staleWorkEpoch',
      reason: hasFailedResult
        ? 'runtimeResultFailed'
        : 'runtimeResultSucceeded',
      startEpoch: args.startEpoch,
      currentEpoch,
      runtimeKind: 'rateFetch',
    });
    return;
  }

  for (const result of partition.acceptedResults) {
    const key = dependencyKey(result.dependency);
    if (result.persisted === true) {
      retryByDependencyKey.delete(key);
      continue;
    }

    if (hasUsableFetchedRateSeries(result.series)) {
      retryByDependencyKey.delete(key);
      // Synthetic unit-test executors can still return series directly. The
      // default executor persists in the rate-fetch runtime and returns only
      // status metadata so production response processing stays off JS.
      writePortfolioMmkvStringOnWorklet(
        createWorkletPortfolioKvConfig(getPortfolioMmkvNativeStorageOnRN()),
        {
          key,
          value: stringifyStoredFiatRateSeries(result.series),
          reason: 'rate',
        },
      );
      continue;
    }

    retryByDependencyKey.set(
      key,
      computeRetryState({
        dependency: result.dependency,
        previous: retryByDependencyKey.get(key),
        errorKind: result.errorKind ?? 'parse',
      }),
    );
  }

  if (partition.mismatch) {
    logPortfolioRuntimeError(
      new Error('rate fetch result dependency mismatch'),
      {
        tag: 'ensureFresh',
        reason: 'runtimeResultMismatch',
        runtimeKind: 'rateFetch',
      },
    );
    const dependencyByKey = new Map(
      args.dependencies.map(dependency => [
        dependencyKey(dependency),
        dependency,
      ]),
    );
    for (const key of partition.missingKeys) {
      const dependency = dependencyByKey.get(key);
      if (!dependency) continue;
      retryByDependencyKey.set(
        key,
        computeRetryState({
          dependency,
          previous: retryByDependencyKey.get(key),
          errorKind: 'unknown',
        }),
      );
    }
  }
}

async function ensureFreshDependencies(args: {
  dependencies: readonly RateFetchDependency[];
  cfg?: BwsConfig;
  force?: boolean;
  maxAgeMs?: number;
  startEpoch?: number;
}): Promise<void> {
  const startEpoch =
    typeof args.startEpoch === 'number'
      ? args.startEpoch
      : getCurrentPortfolioWorkEpoch();
  const reservations: Array<{
    dependency: RateFetchDependency;
    entry: {
      promise: Promise<void>;
      resolve: () => void;
      force: boolean;
      started: boolean;
    };
  }> = [];
  const waitFor: Promise<void>[] = [];

  for (const dependency of args.dependencies) {
    const key = dependencyKey(dependency);
    const inFlight = inFlightByDependencyKey.get(key);
    if (inFlight) {
      if (args.force && !inFlight.force) {
        inFlight.force = true;
        if (inFlight.started) {
          waitFor.push(
            inFlight.promise.then(() =>
              ensureFreshDependencies({
                dependencies: [dependency],
                cfg: args.cfg,
                force: true,
                maxAgeMs: args.maxAgeMs,
                startEpoch,
              }),
            ),
          );
          continue;
        }
      }
      waitFor.push(inFlight.promise);
      continue;
    }

    let resolveEntry: () => void = () => {};
    const entry = {
      promise: new Promise<void>(resolve => {
        resolveEntry = resolve;
      }),
      resolve: resolveEntry,
      force: args.force === true,
      started: false,
    };
    inFlightByDependencyKey.set(key, entry);

    if (shouldSkipForRetry(dependency, entry.force)) {
      if (inFlightByDependencyKey.get(key) === entry) {
        inFlightByDependencyKey.delete(key);
      }
      entry.resolve();
      continue;
    }
    const existing = await readStoredSeries(key);
    if (!entry.force && isFresh(existing, args.maxAgeMs)) {
      if (inFlightByDependencyKey.get(key) === entry) {
        inFlightByDependencyKey.delete(key);
      }
      entry.resolve();
      continue;
    }
    reservations.push({dependency, entry});
  }

  if (reservations.length) {
    const dependenciesToStart = reservations.map(
      reservation => reservation.dependency,
    );
    const entries = reservations.map(reservation => reservation.entry);
    const operation = Promise.resolve()
      .then(() =>
        executeRateFetchOperation({
          dependencies: dependenciesToStart,
          cfg: args.cfg,
          startEpoch,
          entries,
        }),
      )
      .finally(() => {
        for (const reservation of reservations) {
          const key = dependencyKey(reservation.dependency);
          if (inFlightByDependencyKey.get(key) === reservation.entry) {
            inFlightByDependencyKey.delete(key);
          }
          reservation.entry.resolve();
        }
      });
    for (const reservation of reservations) {
      reservation.entry.promise = operation;
    }
    waitFor.push(operation);
  }

  if (waitFor.length) {
    await Promise.all(waitFor);
  }
}

export async function ensureFresh(args: EnsureFreshArgs): Promise<void> {
  return ensureFreshDependencies({
    dependencies: buildEnsureFreshDependencies(args),
    cfg: args.cfg,
    force: args.force,
    maxAgeMs: args.maxAgeMs,
    startEpoch: args.startEpoch,
  });
}

export async function ensureQuoteCurrencyFxBridge(
  args: EnsureQuoteCurrencyFxBridgeArgs,
): Promise<void> {
  return ensureFreshDependencies({
    dependencies: buildEnsureQuoteCurrencyFxBridgeDependencies(args),
    cfg: args.cfg,
    force: args.force,
    maxAgeMs: args.maxAgeMs,
    startEpoch: args.startEpoch,
  });
}
